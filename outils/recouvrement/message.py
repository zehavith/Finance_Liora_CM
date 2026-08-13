"""Lecture d'un message Gmail brut (RFC 822) vers une structure exploitable.

On récupère les messages au format `raw` : un seul appel API par message
donne à la fois le .eml à archiver, les en-têtes, le corps et les pièces
jointes. Tout le décodage se fait ensuite en local avec la librairie
standard `email`.
"""

from __future__ import annotations

import email
import email.utils
import hashlib
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from email import policy
from email.message import EmailMessage
from urllib.parse import unquote
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

# Références « cid: » dans le corps HTML (attribut src, mais aussi url() CSS).
REFERENCES_CID = re.compile(r"cid:([^\"'\s>)]+)", re.IGNORECASE)

# Au-delà de cette taille, une image inline n'est pas intégrée au PDF
# (elle reste disponible dans le .eml et dans les pièces jointes).
TAILLE_MAX_IMAGE_INLINE = 2 * 1024 * 1024

# Toutes les dates affichées sont ramenées à un fuseau unique, sinon la
# chronologie d'un dossier mélange les heures selon le client de messagerie
# de chaque expéditeur.
FUSEAU_PAR_DEFAUT = "Europe/Paris"
_fuseau_affichage: ZoneInfo | None = None


def definir_fuseau(nom: str) -> str:
    """Fixe le fuseau d'affichage. Retourne le nom réellement appliqué."""
    global _fuseau_affichage  # noqa: PLW0603
    try:
        _fuseau_affichage = ZoneInfo(nom)
        return nom
    except (ZoneInfoNotFoundError, ValueError, KeyError):
        # Base de fuseaux absente (fréquent sous Windows sans le paquet
        # `tzdata`) : on retombe sur l'heure locale du poste.
        _fuseau_affichage = None
        return "heure locale du poste"


def _vers_fuseau_affichage(date: datetime) -> datetime:
    if _fuseau_affichage is not None:
        return date.astimezone(_fuseau_affichage)
    return date.astimezone()


def maintenant() -> datetime:
    """Instant présent dans le fuseau d'affichage.

    Toujours « aware » : les dates des messages le sont, et les soustraire à
    un `datetime.now()` naïf lèverait une exception en plein export.
    """
    if _fuseau_affichage is not None:
        return datetime.now(tz=_fuseau_affichage)
    return datetime.now().astimezone()


definir_fuseau(FUSEAU_PAR_DEFAUT)


@dataclass
class PieceJointe:
    nom: str
    type_mime: str
    contenu: bytes

    @property
    def taille(self) -> int:
        return len(self.contenu)


@dataclass
class MessageMail:
    """Un message Gmail décodé."""

    id: str
    thread_id: str
    date: datetime
    expediteur: str
    destinataires: str
    copie: str
    copie_cachee: str
    objet: str
    message_id: str
    corps_html: str | None
    corps_texte: str | None
    pieces_jointes: list[PieceJointe] = field(default_factory=list)
    images_inline: dict[str, PieceJointe] = field(default_factory=dict)
    brut: bytes = b""
    libelles: list[str] = field(default_factory=list)
    # Boîtes où ce message a été trouvé : un même échange figure souvent dans
    # billing@ et recouvrement@ à la fois (l'une en copie de l'autre).
    boites: list[str] = field(default_factory=list)

    @property
    def cle_dedoublonnage(self) -> str:
        """Le Message-ID est stable d'une boîte à l'autre, contrairement à
        l'identifiant Gmail qui est propre à chaque boîte."""
        if self.message_id:
            return self.message_id.lower()
        return hashlib.sha256(self.brut).hexdigest()

    @property
    def parties(self) -> str:
        """Adresses des seules parties à l'échange, en-têtes uniquement.

        Sert à ranger le message sous l'adresse concernée. Le corps en est
        exclu à dessein : une adresse citée dans un message transféré ne fait
        pas de son titulaire un destinataire.
        """
        return " ".join(
            [self.expediteur, self.destinataires, self.copie, self.copie_cachee]
        ).lower()

    @property
    def texte_recherchable(self) -> str:
        """Concaténation utilisée pour savoir quel critère a fait remonter
        le message (adresse mail, numéro de facture, nom de pièce jointe)."""
        morceaux = [
            self.expediteur,
            self.destinataires,
            self.copie,
            self.copie_cachee,
            self.objet,
            self.corps_texte or "",
            self.corps_html or "",
            " ".join(pj.nom for pj in self.pieces_jointes),
        ]
        return "\n".join(morceaux).lower()


def _entete(msg: EmailMessage, nom: str) -> str:
    valeur = msg.get(nom)
    if valeur is None:
        return ""
    return str(valeur).replace("\r", " ").replace("\n", " ").strip()


def _date_du_message(msg: EmailMessage, internal_date_ms: str | int | None) -> datetime:
    """Date de l'en-tête `Date:`, avec repli sur l'horodatage serveur Gmail.

    L'en-tête `Date:` est posé par le client émetteur et peut être absent ou
    farfelu ; `internalDate` est l'horodatage de réception côté Google, plus
    fiable pour une chronologie de relances.
    """
    brut = msg.get("Date")
    if brut:
        try:
            date = email.utils.parsedate_to_datetime(str(brut))
            if date is not None:
                if date.tzinfo is None:
                    date = date.replace(tzinfo=timezone.utc)
                return _vers_fuseau_affichage(date)
        except (TypeError, ValueError):
            pass

    if internal_date_ms:
        try:
            recue = datetime.fromtimestamp(int(internal_date_ms) / 1000, tz=timezone.utc)
            return _vers_fuseau_affichage(recue)
        except (TypeError, ValueError, OSError):
            pass

    return _vers_fuseau_affichage(datetime.fromtimestamp(0, tz=timezone.utc))


def _extraire_corps(msg: EmailMessage) -> tuple[str | None, str | None]:
    corps_html = None
    corps_texte = None

    try:
        partie_html = msg.get_body(preferencelist=("html",))
        if partie_html is not None:
            corps_html = partie_html.get_content()
    except (LookupError, ValueError, KeyError):
        corps_html = None

    try:
        partie_texte = msg.get_body(preferencelist=("plain",))
        if partie_texte is not None:
            corps_texte = partie_texte.get_content()
    except (LookupError, ValueError, KeyError):
        corps_texte = None

    # Message non multipart et sans corps identifié : on prend la charge utile.
    if corps_html is None and corps_texte is None and not msg.is_multipart():
        try:
            contenu = msg.get_content()
            if isinstance(contenu, str):
                if msg.get_content_type() == "text/html":
                    corps_html = contenu
                else:
                    corps_texte = contenu
        except (LookupError, ValueError, KeyError):
            pass

    return corps_html, corps_texte


def _nom_de_partie(partie: EmailMessage, index: int) -> str:
    nom = partie.get_filename()
    if nom:
        return str(nom).replace("\r", " ").replace("\n", " ").strip()

    sous_type = (partie.get_content_subtype() or "bin").split("+")[0]
    return f"piece_jointe_{index:02d}.{sous_type}"


def _contenu_binaire(partie: EmailMessage) -> bytes | None:
    try:
        contenu = partie.get_content()
    except (LookupError, ValueError, KeyError):
        contenu = partie.get_payload(decode=True)

    if isinstance(contenu, str):
        contenu = contenu.encode("utf-8", errors="replace")
    return contenu if isinstance(contenu, bytes) else None


def _normaliser_cid(valeur: str) -> str:
    return unquote(str(valeur or "")).strip().strip("<>").lower()


def cids_references(corps_html: str | None) -> set[str]:
    """Identifiants des images réellement affichées dans le corps du message.

    C'est le seul critère fiable pour distinguer un logo de signature d'une
    vraie pièce jointe : `Content-Disposition` vaut « attachment » chez
    certains clients de messagerie même pour une image affichée en ligne.
    """
    if not corps_html:
        return set()
    return {_normaliser_cid(cid) for cid in REFERENCES_CID.findall(corps_html)}


def _extraire_pieces(
    msg: EmailMessage, cids_attendus: set[str]
) -> tuple[list[PieceJointe], dict[str, PieceJointe]]:
    pieces: list[PieceJointe] = []
    inline: dict[str, PieceJointe] = {}
    parties_inline: set[int] = set()

    # Les images intégrées peuvent être imbriquées plusieurs niveaux plus bas
    # (multipart/mixed > multipart/alternative > multipart/related), là où
    # `iter_attachments` ne descend pas : on parcourt l'arbre complet.
    for partie in msg.walk():
        if partie.get_content_maintype() != "image":
            continue
        cid = _normaliser_cid(partie.get("Content-ID"))
        if not cid or cid not in cids_attendus:
            continue

        parties_inline.add(id(partie))
        contenu = _contenu_binaire(partie)
        if contenu is None or len(contenu) > TAILLE_MAX_IMAGE_INLINE:
            continue
        inline[cid] = PieceJointe(
            nom=_nom_de_partie(partie, len(inline) + 1),
            type_mime=partie.get_content_type(),
            contenu=contenu,
        )

    for index, partie in enumerate(msg.iter_attachments(), start=1):
        if id(partie) in parties_inline:
            continue
        contenu = _contenu_binaire(partie)
        if contenu is None:
            continue
        pieces.append(
            PieceJointe(
                nom=_nom_de_partie(partie, index),
                type_mime=partie.get_content_type(),
                contenu=contenu,
            )
        )

    return pieces, inline


def lire_message(donnees_api: dict, brut: bytes) -> MessageMail:
    """Construit un `MessageMail` à partir de la réponse `messages.get`
    (format `raw`) et du contenu RFC 822 décodé."""
    msg = email.message_from_bytes(brut, policy=policy.default)

    corps_html, corps_texte = _extraire_corps(msg)
    pieces, inline = _extraire_pieces(msg, cids_references(corps_html))

    return MessageMail(
        id=donnees_api.get("id", ""),
        thread_id=donnees_api.get("threadId", ""),
        date=_date_du_message(msg, donnees_api.get("internalDate")),
        expediteur=_entete(msg, "From"),
        destinataires=_entete(msg, "To"),
        copie=_entete(msg, "Cc"),
        copie_cachee=_entete(msg, "Bcc"),
        objet=_entete(msg, "Subject") or "(sans objet)",
        message_id=_entete(msg, "Message-ID"),
        corps_html=corps_html,
        corps_texte=corps_texte,
        pieces_jointes=pieces,
        images_inline=inline,
        brut=brut,
        libelles=list(donnees_api.get("labelIds", [])),
    )
