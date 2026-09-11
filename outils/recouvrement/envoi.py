"""Rendre un dossier transmissible par courriel.

Un dossier constitué est un répertoire : une note, des messages, leurs pièces
jointes, les documents du tableau. Cela se consulte très bien sur un disque,
mais ne s'attache pas à un mail — et c'est pourtant ainsi qu'on le transmet
au service contentieux ou à un avocat.

Deux formes, produites côte à côte :

- **un PDF unique**, dans l'ordre où l'on présente un dossier : la note de
  synthèse d'abord, les pièces qui établissent la créance ensuite, puis les
  échanges dans l'ordre de leurs numéros de pièce. C'est ce qui s'ouvre
  partout, se paginé, s'imprime et s'annote ;
- **une archive zip**, qui porte tout, y compris ce qu'un PDF ne peut pas
  contenir : les messages d'origine au format `.eml`, les tableurs, les
  images. C'est la forme complète, celle qu'on garde.

Le PDF demande `pypdf`. Sans lui, l'archive est produite seule et on le dit :
un dossier transmissible vaut mieux qu'un échec au motif qu'il manque une
bibliothèque.
"""

from __future__ import annotations

import hashlib
import urllib.parse
import zipfile
from pathlib import Path

from indexation import LigneIndex

# Ce que l'archive ne reprend pas. « mails-hors-dossier » porte ce que la
# règle de rétention a écarté : le transmettre reviendrait à joindre au
# dossier les échanges d'autres personnes, ce qu'on a justement retiré.
# « pour-envoi » est le résultat lui-même : s'y inclure ferait grossir
# l'archive à chaque préparation.
EXCLUS = ("mails-hors-dossier", "pour-envoi")

DOSSIER_ENVOI = "pour-envoi"


def _lisible(octets: int) -> str:
    """« 4,2 Mo » — la taille est la première question quand on attache."""
    if octets >= 1024 * 1024:
        return f"{octets / (1024 * 1024):.1f} Mo".replace(".", ",")
    return f"{max(1, round(octets / 1024))} Ko"


def _a_exclure(chemin: Path, racine: Path) -> bool:
    try:
        parts = chemin.relative_to(racine).parts
    except ValueError:
        return True
    return bool(parts) and parts[0] in EXCLUS


def ecrire_archive(repertoire: Path, cible: Path) -> tuple[int, int]:
    """Le dossier entier dans un seul fichier. Renvoie (fichiers, octets)."""
    cible.parent.mkdir(parents=True, exist_ok=True)
    provisoire = cible.with_name(cible.name + ".en-cours")
    fichiers = 0
    with zipfile.ZipFile(provisoire, "w", zipfile.ZIP_DEFLATED) as archive:
        for chemin in sorted(repertoire.rglob("*")):
            if not chemin.is_file() or _a_exclure(chemin, repertoire):
                continue
            # Le nom du dossier ouvre l'archive : décompressée, elle ne
            # déverse pas trente fichiers dans le répertoire courant.
            interne = Path(repertoire.name) / chemin.relative_to(repertoire)
            archive.write(chemin, str(interne))
            fichiers += 1
    provisoire.replace(cible)
    return fichiers, cible.stat().st_size


def messages_sans_pdf(repertoire: Path, lignes: list[LigneIndex]) -> list[int]:
    """Les pièces dont le PDF manque, et qui ne peuvent donc pas être réunies.

    Sans moteur PDF sur le poste, un message est conservé en page HTML : il
    est bien au dossier, et dans l'archive, mais un PDF unique ne peut pas le
    porter. Le taire ferait transmettre un dossier amputé sans le savoir.
    """
    manquants = []
    for ligne in sorted(lignes, key=lambda l: l.piece_n):
        chemin = repertoire / (ligne.fichier_pdf or "")
        if not ligne.fichier_pdf or chemin.suffix.lower() != ".pdf" \
                or not chemin.is_file():
            manquants.append(ligne.piece_n)
    return manquants


def pieces_hors_pdf(repertoire: Path) -> list[str]:
    """Les pièces clés qu'un PDF ne peut pas porter : images, tableurs, Word.

    Une feuille d'émargement photographiée, un relevé en tableur : la pièce
    est au dossier et dans l'archive, mais elle ne peut pas entrer dans le PDF
    unique. Le taire ferait transmettre un dossier amputé sans le savoir.
    """
    cles = repertoire / "pieces-cles"
    if not cles.is_dir():
        return []
    return sorted(
        chemin.name
        for chemin in cles.rglob("*")
        if chemin.is_file() and chemin.suffix.lower() != ".pdf"
    )


def _empreinte(chemin: Path) -> tuple[int, str] | None:
    """Taille et empreinte du contenu, pour ne pas joindre deux fois la même pièce.

    Les pièces clés sont des *copies* : le même document y figure sous un autre
    chemin que l'original. Comparer les chemins ne les rapprocherait pas, et
    la convention partirait en double.
    """
    try:
        contenu = chemin.read_bytes()
    except OSError:
        return None
    return len(contenu), hashlib.sha1(contenu).hexdigest()  # noqa: S324


def pdfs_du_dossier(repertoire: Path, lignes: list[LigneIndex]) -> list[Path]:
    """Les PDF à réunir, dans l'ordre où l'on présente un dossier.

    La note de synthèse ouvre : c'est elle qui dit de quoi il retourne. Les
    pièces qui établissent la créance suivent — convention, facture,
    émargement, relevé, diplôme, progress report —, puis les échanges dans
    l'ordre de leurs numéros de pièce, ceux-là mêmes que la note cite.

    **Et enfin tout le reste.** Une pièce jointe que le classement ne reconnaît
    pas — un devis non signé, un bon de commande, un relevé d'heures, un
    échange scanné — n'en est pas moins au dossier. Elle ne figurait nulle part
    dans le PDF transmis : ni parmi les pièces clés, qui ne retiennent que six
    natures, ni parmi les messages, qui n'ont chacun que leur propre page. Le
    dossier partait amputé, et rien ne le disait.
    """
    ordre: list[Path] = []
    vus: set[tuple[int, str]] = set()

    def ajouter(chemin: Path) -> None:
        if not chemin.is_file() or chemin.suffix.lower() != ".pdf":
            return
        empreinte = _empreinte(chemin)
        if empreinte is None or empreinte in vus:
            return
        vus.add(empreinte)
        ordre.append(chemin)

    ajouter(repertoire / "synthese.pdf")

    cles = repertoire / "pieces-cles"
    if cles.is_dir():
        for sous in sorted(cles.iterdir()):
            if sous.is_dir():
                for fichier in sorted(sous.iterdir()):
                    ajouter(fichier)

    for ligne in sorted(lignes, key=lambda l: l.piece_n):
        if ligne.fichier_pdf:
            ajouter(repertoire / ligne.fichier_pdf)

    # Le reste du dossier, dans l'ordre du disque : ce que ni le classement
    # ni les numéros de pièce n'ont ramassé. Ce qui n'est pas un PDF ne peut
    # pas y entrer — c'est l'archive qui le porte, et « preparer » le dit.
    for chemin in sorted(repertoire.rglob("*.[pP][dD][fF]")):
        if not _a_exclure(chemin, repertoire):
            ajouter(chemin)

    return ordre


def ecrire_pdf_unique(
    repertoire: Path, lignes: list[LigneIndex], cible: Path
) -> tuple[int, int, str]:
    """Réunit les PDF du dossier en un seul. Renvoie (pièces, octets, motif).

    Un motif non vide dit pourquoi il n'y a pas de PDF — c'est une absence à
    expliquer, jamais une erreur à taire.
    """
    # Pas seulement ImportError : une installation abîmée de pypdf échoue à
    # l'import par une erreur d'un tout autre genre. L'archive, elle, est
    # déjà prête — et c'est elle qui compte le plus.
    try:
        from pypdf import PdfWriter  # noqa: PLC0415
    except Exception as exc:  # noqa: BLE001
        return 0, 0, (
            "la réunion en un seul PDF demande la bibliothèque « pypdf », "
            f"qui n'a pas pu être chargée ({type(exc).__name__}) — "
            "l'archive zip, elle, est prête"
        )

    sources = pdfs_du_dossier(repertoire, lignes)
    if not sources:
        return 0, 0, "aucun PDF au dossier : rien à réunir"

    redacteur = PdfWriter()
    reunis, refuses = 0, []
    for source in sources:
        try:
            redacteur.append(str(source))
        except Exception:  # noqa: BLE001 - un PDF abîmé n'arrête pas le reste
            refuses.append(source.name)
            continue
        reunis += 1

    if not reunis:
        return 0, 0, "aucun des PDF du dossier n'a pu être lu"

    cible.parent.mkdir(parents=True, exist_ok=True)
    provisoire = cible.with_name(cible.name + ".en-cours")
    try:
        with provisoire.open("wb") as fichier:
            redacteur.write(fichier)
        provisoire.replace(cible)
    except OSError as exc:
        return 0, 0, f"écriture impossible : {exc}"
    finally:
        redacteur.close()

    motif = ""
    if refuses:
        motif = (f"{len(refuses)} PDF illisible(s), laissé(s) de côté : "
                 + ", ".join(refuses[:3]) + ("…" if len(refuses) > 3 else ""))
    return reunis, cible.stat().st_size, motif


def corps_du_message(dossier: dict) -> tuple[str, str]:
    """L'objet et le texte du brouillon, tirés de ce que le dossier établit.

    Rien qui ne soit déjà dans la note : le message annonce ce qu'il porte,
    il ne plaide pas à sa place.
    """
    reference = (dossier.get("reference") or "").strip()
    nom = (dossier.get("nom") or "").strip()

    # « Transmission du dossier de SAS EDEN - FACT-2405-00409 » : le nom
    # d'abord, parce que c'est par lui qu'on retrouve un dossier dans une
    # boîte, le numéro ensuite, parce que c'est lui qui l'identifie. Le nom
    # est celui du débiteur — la personne, ou l'entreprise qui paie.
    from synthese import _de  # noqa: PLC0415

    objet = "Transmission du dossier"
    if nom:
        objet += " " + _de(nom)
    if reference:
        objet += f" - {reference}"

    montant = dossier.get("montant_du")
    lignes = [
        "Bonjour,",
        "",
        f"Vous trouverez ci-joint le dossier {reference}"
        + (f" concernant {nom}" if nom else "") + ".",
        "",
    ]
    if montant:
        lignes.append(
            f"Montant réclamé : {montant:,.2f} €".replace(",", " ").replace(".", ",")
            + (f" — échéance du {dossier['date_echeance']}"
               if dossier.get("date_echeance") else "")
            + "."
        )
    if dossier.get("nb_mails"):
        lignes.append(
            f"Le dossier réunit {dossier['nb_mails']} message(s) et "
            f"{dossier.get('nb_pieces_jointes') or 0} pièce(s) jointe(s)."
        )
    lignes += [
        "",
        "La note de synthèse ouvre le document : elle résume la situation, "
        "les pièces et les échanges, chaque constat renvoyant à un numéro de "
        "pièce.",
        "",
        "Bien cordialement,",
    ]
    return objet, "\n".join(lignes)


# Ce qu'un brouillon écrit d'un seul tenant peut porter. Au-delà, l'envoi
# reprend en plusieurs morceaux, ce qui demande un autre appel — et de toute
# façon, une messagerie d'entreprise refuse en général au-delà de 25 Mo.
PIECE_MAX = 24 * 1024 * 1024

# Ce qu'un message entier peut peser. Gmail refuse au-delà d'environ
# vingt-cinq mégaoctets de pièces jointes, et le codage en base64 en ajoute un
# tiers : la limite se juge sur le total, pas pièce par pièce.
MESSAGE_MAX = 24 * 1024 * 1024


def pieces_du_brouillon(pret: dict, racine: Path) -> tuple[list[Path], str]:
    """Ce qu'on attache : le PDF *et* l'archive, et non l'un ou l'autre.

    Le brouillon n'attachait que le PDF dès qu'il existait. Or un PDF ne peut
    pas porter une feuille d'émargement photographiée, un relevé en tableur,
    ni les messages d'origine au format `.eml` : le dossier partait amputé de
    tout cela, et rien ne le disait. L'archive, elle, porte tout — c'est la
    forme complète, celle qu'on garde.

    Renvoie (pièces, motif). Un motif non vide dit ce qui n'a pas pu être
    joint : au-delà de la limite d'un message, le PDF passe d'abord, parce
    que c'est lui qu'on relit.
    """
    voulues = [nom for nom in (pret.get("pdf"), pret.get("archive")) if nom]
    gardees: list[Path] = []
    ecartees: list[str] = []
    total = 0

    for nom in voulues:
        chemin = racine / nom
        try:
            poids = chemin.stat().st_size
        except OSError:
            continue
        if poids > PIECE_MAX or total + poids > MESSAGE_MAX:
            ecartees.append(f"{nom} ({_lisible(poids)})")
            continue
        gardees.append(chemin)
        total += poids

    motif = ""
    if ecartees:
        motif = ("trop lourd pour un message, à joindre à la main depuis le "
                 "répertoire : " + ", ".join(ecartees))
    return gardees, motif


def brouillon_gmail(
    service, expediteur: str, destinataire: str, objet: str, corps: str,
    pieces: list[Path],
) -> tuple[str, str]:
    """Écrit un brouillon dans la boîte, pièce jointe comprise.

    Un brouillon, jamais un envoi : l'application n'appelle pas `send`. Le
    brouillon attend dans Gmail, il se relit, il s'envoie d'un clic qui
    appartient à celle qui le signe.

    Renvoie (identifiant du brouillon, motif). Un motif non vide dit ce qui
    n'a pas pu être fait.
    """
    import base64  # noqa: PLC0415
    import mimetypes  # noqa: PLC0415
    from email.message import EmailMessage  # noqa: PLC0415

    message = EmailMessage()
    if destinataire:
        message["To"] = destinataire
    if expediteur:
        message["From"] = expediteur
    message["Subject"] = objet
    message.set_content(corps)

    trop_lourdes = []
    for piece in pieces:
        try:
            octets = piece.read_bytes()
        except OSError as exc:
            return "", f"pièce jointe illisible : {exc}"
        if len(octets) > PIECE_MAX:
            trop_lourdes.append(f"{piece.name} ({_lisible(len(octets))})")
            continue
        type_devine, _ = mimetypes.guess_type(piece.name)
        principal, _, secondaire = (type_devine or "application/octet-stream").partition("/")
        message.add_attachment(
            octets, maintype=principal, subtype=secondaire or "octet-stream",
            filename=piece.name,
        )

    brut = base64.urlsafe_b64encode(message.as_bytes()).decode("ascii")
    try:
        cree = service.users().drafts().create(
            userId="me", body={"message": {"raw": brut}}
        ).execute()
    except Exception as exc:  # noqa: BLE001 - quota, réseau, autorisation
        return "", f"Gmail a refusé le brouillon : {exc}"

    motif = ""
    if trop_lourdes:
        motif = (
            "pièce(s) trop lourde(s) pour un brouillon, à joindre à la main : "
            + ", ".join(trop_lourdes)
        )
    return str(cree.get("id") or ""), motif


def lien_gmail(
    expediteur: str, destinataire: str, objet: str, corps: str
) -> str:
    """L'adresse d'une fenêtre de rédaction Gmail, déjà remplie.

    `authuser` désigne le compte qui écrit : plusieurs comptes Google sont
    souvent connectés dans le même navigateur, et sans cette précision la
    fenêtre s'ouvre sur le dernier utilisé — pas forcément le bon.

    La pièce jointe, elle, ne se passe pas par l'adresse : aucun paramètre ne
    le permet, et prétendre le contraire ferait envoyer un dossier vide. Elle
    reste à glisser, et l'application ouvre le répertoire pour cela.
    """
    parametres = {
        "view": "cm",
        "fs": "1",
        "to": destinataire or "",
        "su": objet or "",
        "body": corps or "",
    }
    if expediteur:
        parametres["authuser"] = expediteur
    return "https://mail.google.com/mail/?" + urllib.parse.urlencode(parametres)


def _compte_outlook(outlook, adresse: str):
    """Le compte Outlook portant cette adresse, s'il y en a un."""
    voulu = (adresse or "").strip().lower()
    if not voulu:
        return None
    try:
        comptes = outlook.Session.Accounts
    except Exception:  # noqa: BLE001
        return None
    for rang in range(1, comptes.Count + 1):
        compte = comptes.Item(rang)
        if str(getattr(compte, "SmtpAddress", "") or "").lower() == voulu:
            return compte
    return None


def _envoyer_depuis(message, compte) -> None:
    """Fixe le compte expéditeur du brouillon.

    L'affectation directe suffit sur les versions récentes ; sur les autres,
    il faut passer par l'identifiant de la propriété. Les deux sont tentées
    plutôt qu'une seule : une boîte partagée ouverte à côté de la sienne, et
    le courrier partirait de la mauvaise adresse.
    """
    try:
        message.SendUsingAccount = compte
        return
    except Exception:  # noqa: BLE001
        pass
    # 64209 est l'identifiant de « SendUsingAccount » dans le modèle objet
    # d'Outlook ; l'affectation par nom échoue sur certaines versions.
    message._oleobj_.Invoke(*(64209, 0, 8, 0, compte))  # noqa: SLF001


def brouillon_outlook(
    destinataire: str, objet: str, corps: str, pieces: list[Path],
    expediteur: str = "",
) -> tuple[bool, str]:
    """Ouvre un brouillon Outlook avec le dossier attaché. N'envoie rien.

    Envoyer un courriel à un tiers est un geste qui appartient à la personne
    qui le signe : le brouillon s'ouvre, elle le relit, elle l'envoie. Rien
    ne part de l'application.

    Ne fonctionne que sous Windows, avec Outlook installé et `pywin32`. Le
    dire est la moitié du travail : ailleurs, on se rabat sur le brouillon
    de la messagerie par défaut, et l'on annonce que la pièce jointe reste à
    glisser.
    """
    try:
        import win32com.client  # noqa: PLC0415
    except Exception as exc:  # noqa: BLE001 - absent, ou Windows sans Outlook
        return False, (
            "Outlook n'a pas pu être piloté depuis l'application "
            f"({type(exc).__name__})"
        )
    avertissement = ""
    try:
        outlook = win32com.client.Dispatch("Outlook.Application")
        message = outlook.CreateItem(0)  # 0 = olMailItem
        if destinataire:
            message.To = destinataire
        message.Subject = objet
        message.Body = corps
        for piece in pieces:
            message.Attachments.Add(str(piece))

        # Plusieurs boîtes sont souvent ouvertes côte à côte — la sienne, une
        # boîte de service, une boîte partagée. Sans consigne, Outlook prend
        # celle par défaut, et le courrier part de la mauvaise adresse sans
        # que rien ne le signale avant l'envoi.
        if expediteur:
            compte = _compte_outlook(outlook, expediteur)
            if compte is None:
                avertissement = (
                    f"le compte {expediteur} n'est pas ouvert dans Outlook : "
                    "le brouillon partira du compte par défaut — vérifiez le "
                    "champ « De » avant d'envoyer"
                )
            else:
                _envoyer_depuis(message, compte)

        message.Display()  # affiche le brouillon, ne l'envoie pas
    except Exception as exc:  # noqa: BLE001
        return False, f"Outlook a refusé la demande : {exc}"
    return True, avertissement


def preparer(
    repertoire: Path, reference: str, lignes: list[LigneIndex], sortie: Path
) -> dict:
    """Prépare les deux formes, et dit ce qu'elles pèsent.

    Le poids est la première question quand on attache : une messagerie
    d'entreprise refuse en général au-delà de vingt-cinq mégaoctets, et
    l'apprendre après l'envoi fait perdre un aller-retour.
    """
    destination = sortie / DOSSIER_ENVOI
    base = repertoire.name

    fichiers, poids_zip = ecrire_archive(repertoire, destination / f"{base}.zip")
    pieces, poids_pdf, motif = ecrire_pdf_unique(
        repertoire, lignes, destination / f"{base}.pdf"
    )

    absents = messages_sans_pdf(repertoire, lignes) if pieces else []
    if absents:
        manque = (f"{len(absents)} message(s) hors du PDF, faute d'en avoir un "
                  f"(pièce{'s' if len(absents) > 1 else ''} n° "
                  + ", ".join(str(n) for n in absents[:5])
                  + ("…" if len(absents) > 5 else "")
                  + ") — ils sont dans l'archive")
        motif = f"{motif} ; {manque}" if motif else manque

    # Ce qu'un PDF ne peut pas porter : une feuille d'émargement en photo, un
    # relevé en tableur. C'est dans l'archive, et il faut le savoir avant de
    # transmettre — pas après.
    autres = pieces_hors_pdf(repertoire) if pieces else []
    if autres:
        dit = (f"{len(autres)} pièce(s) clé(s) hors du PDF, n'étant pas des "
               "PDF (" + ", ".join(autres[:3])
               + ("…" if len(autres) > 3 else "") + ") — dans l'archive")
        motif = f"{motif} ; {dit}" if motif else dit

    return {
        "reference": reference,
        "repertoire": str(destination),
        "archive": f"{base}.zip",
        "fichiers": fichiers,
        "poids_archive": _lisible(poids_zip),
        "octets_archive": poids_zip,
        "pdf": f"{base}.pdf" if pieces else "",
        "pieces_pdf": pieces,
        "poids_pdf": _lisible(poids_pdf) if pieces else "",
        "octets_pdf": poids_pdf,
        "sans_pdf": len(absents),
        "hors_pdf": len(autres),
        "motif": motif,
    }


# --------------------------------------------------------------------------
# La liste des dossiers à trancher
# --------------------------------------------------------------------------

# Un dossier « possible abandon » attend une décision. Un petit montant aussi :
# en dessous de ce seuil, les frais de recouvrement approchent la créance, et
# la question « poursuit-on ? » se pose d'elle-même. Les deux listes se
# travaillent ensemble, et se tranchent en réunion.
SEUIL_PETIT_MONTANT = 3000.0

COLONNES_A_TRANCHER = [
    "reference",
    "nom",
    "adresse_postale",
    "adresse_a_completer",
    "emails",
    "telephone",
    "montant_du",
    "date_echeance",
    "jours_de_retard",
    "etat",
    "financement",
    # Ce que le service a établi ou saisi, et qui décide en réunion. La
    # convention et le diplôme disent si le dossier est défendable ; les frais,
    # ce qu'on a déjà engagé dessus ; la note et le contexte, pourquoi il en
    # est là — « Perdu / Ne répond pas au téléphone » ne se retrouve nulle
    # part ailleurs, et exporter la liste sans lui obligeait à rouvrir
    # l'application dossier par dossier.
    "convention",
    "diplome",
    "frais",
    "duree_jours",
    "note",
    "contexte",
    "motif",
]

ENTETES_A_TRANCHER = {
    "reference": "Référence",
    "nom": "Nom du débiteur",
    "adresse_postale": "Adresse postale",
    "adresse_a_completer": "Adresse à compléter",
    "emails": "Adresse(s) mail",
    "telephone": "Téléphone",
    "montant_du": "Montant dû",
    "date_echeance": "Échéance",
    "jours_de_retard": "Jours de retard",
    "etat": "État du dossier",
    "financement": "Financement",
    "convention": "Convention signée",
    "diplome": "Diplôme",
    "frais": "Frais engagés",
    "duree_jours": "Durée (jours)",
    "note": "Note",
    "contexte": "Contexte",
    "motif": "Pourquoi ce dossier est dans la liste",
}

# « non renseigné » et « non » ne disent pas la même chose : un tableau qui se
# tait n'affirme pas que la convention manque, et les confondre ferait
# renoncer à un dossier défendable.
def _oui_non(valeur) -> str:
    if valeur is True:
        return "oui"
    if valeur is False:
        return "non"
    return "non renseigné"


def _euros(valeur) -> str:
    montant = valeur or 0
    return f"{montant:.2f}".replace(".", ",") if montant else ""


def rangee_de_dossier(dossier: dict, motif: str = "") -> dict[str, str]:
    """Une ligne de tableau, la même pour tous les exports.

    Les deux exports construisaient leur ligne chacun de leur côté, et ils
    avaient déjà divergé : l'un lisait « retard », un champ qui n'existe pas,
    et sa colonne « Jours de retard » sortait vide.
    """
    return {
        "reference": dossier.get("reference") or "",
        "nom": dossier.get("nom") or "",
        "adresse_postale": dossier.get("adresse_postale") or "",
        # Dit franchement : une adresse tronquée ne s'utilise pas telle
        # quelle, et l'apprendre après l'envoi coûte un courrier.
        "adresse_a_completer": (
            "" if dossier.get("adresse_complete", True) else "à compléter"),
        "emails": dossier.get("emails") or "",
        "telephone": dossier.get("telephone") or "",
        "montant_du": _euros(dossier.get("montant_du")),
        "date_echeance": dossier.get("date_echeance") or "",
        "jours_de_retard": str(dossier.get("anciennete_jours") or ""),
        "etat": dossier.get("statut_libelle") or dossier.get("statut") or "",
        "financement": {
            "entreprise": "Entreprise",
            "personnel": "Financement personnel",
        }.get(dossier.get("financement") or "", ""),
        "convention": _oui_non(dossier.get("convention_signee")),
        "diplome": _oui_non(dossier.get("diplome")),
        "frais": _euros(dossier.get("frais")),
        "duree_jours": ("" if dossier.get("duree_jours") is None
                        else str(dossier.get("duree_jours"))),
        "note": dossier.get("note") or "",
        "contexte": dossier.get("contexte") or "",
        "motif": motif,
    }


# Les deux raisons d'être dans la liste, nommées : elles se demandent
# séparément. « Tous les dossiers de moins de 3 000 € » est une question à
# soi seule — on la pose pour décider d'un lot de relances téléphoniques —,
# et la mêler aux possibles abandons oblige à retrier le tableau à la main.
RAISON_ABANDON = "abandon-possible"
RAISON_PETIT_MONTANT = "petit-montant"
RAISONS = (RAISON_ABANDON, RAISON_PETIT_MONTANT)

# Le nom du fichier dit ce qu'il porte : retrouvé dans un répertoire six mois
# plus tard, « liste.csv » ne dit rien.
FICHIERS_A_TRANCHER = {
    (RAISON_ABANDON,): "dossiers-possible-abandon.csv",
    (RAISON_PETIT_MONTANT,): "dossiers-petits-montants.csv",
    RAISONS: "dossiers-a-trancher.csv",
}


def _raisons(demandees) -> tuple[str, ...]:
    """Les raisons retenues, dans leur ordre canonique. Vide vaut toutes."""
    if not demandees:
        return RAISONS
    voulues = {str(r).strip() for r in demandees}
    gardees = tuple(r for r in RAISONS if r in voulues)
    return gardees or RAISONS


def fichier_a_trancher(raisons=None) -> str:
    """Le nom du fichier qui porte ces raisons-là."""
    return FICHIERS_A_TRANCHER[_raisons(raisons)]


def a_trancher(dossier: dict, seuil: float = SEUIL_PETIT_MONTANT,
               raisons=None) -> str:
    """Pourquoi ce dossier demande une décision, ou une chaîne vide.

    Deux raisons, cumulables : l'étape dit « possible abandon », ou le
    montant est trop faible pour justifier des frais. Un dossier déjà clos
    n'est pas à trancher — la décision a été prise.

    « raisons » restreint la question : passer le seul petit montant donne
    tous les dossiers sous le seuil, et rien d'autre.
    """
    if dossier.get("clos"):
        return ""
    gardees = _raisons(raisons)
    motifs = []
    if (RAISON_ABANDON in gardees
            and dossier.get("statut") == "abandon-possible"):
        motifs.append("possible abandon de la créance")
    montant = dossier.get("montant_du") or 0
    if (RAISON_PETIT_MONTANT in gardees
            and dossier.get("montant_renseigne", True) and 0 < montant < seuil):
        montant_lisible = f"{montant:,.2f}".replace(",", " ").replace(".", ",")
        motifs.append(f"montant inférieur à {seuil:.0f} € ({montant_lisible} €)")
    return " ; ".join(motifs)


def liste_a_trancher(
    dossiers: list[dict], seuil: float = SEUIL_PETIT_MONTANT, raisons=None
) -> list[dict[str, str]]:
    """Les dossiers qui demandent une décision, prêts pour un tableur."""
    rangees = []
    for dossier in dossiers:
        motif = a_trancher(dossier, seuil, raisons)
        if not motif:
            continue
        rangees.append(rangee_de_dossier(dossier, motif))
    # Le plus lourd d'abord : c'est par là qu'on commence une réunion.
    rangees.sort(key=lambda r: -_montant_trie(r["montant_du"]))
    return rangees


def _montant_trie(texte: str) -> float:
    try:
        return float((texte or "0").replace(" ", "").replace(",", "."))
    except ValueError:
        return 0.0


def ecrire_liste(cible: Path, dossiers: list[dict], motif: str = "") -> tuple[int, Path]:
    """Écrit un tableau des dossiers donnés, tels quels.

    Mêmes colonnes que la liste à trancher — et la même construction, pour
    qu'elles ne puissent plus diverger : ce sont celles dont on a besoin pour
    agir, quel que soit le tableau qu'on exporte.
    """
    from indexation import _ecrire_csv  # noqa: PLC0415

    rangees = [rangee_de_dossier(dossier, motif) for dossier in dossiers]
    rangees.sort(key=lambda r: -_montant_trie(r["montant_du"]))
    _ecrire_csv(
        cible,
        [ENTETES_A_TRANCHER[cle] for cle in COLONNES_A_TRANCHER],
        [{ENTETES_A_TRANCHER[cle]: rangee[cle] for cle in COLONNES_A_TRANCHER}
         for rangee in rangees],
    )
    return len(rangees), cible


def ecrire_liste_a_trancher(
    cible: Path, dossiers: list[dict], seuil: float = SEUIL_PETIT_MONTANT,
    raisons=None,
) -> tuple[int, Path]:
    """Écrit la liste dans un CSV qu'Excel ouvre par double-clic."""
    from indexation import _ecrire_csv  # noqa: PLC0415

    rangees = liste_a_trancher(dossiers, seuil, raisons)
    _ecrire_csv(
        cible,
        [ENTETES_A_TRANCHER[cle] for cle in COLONNES_A_TRANCHER],
        [{ENTETES_A_TRANCHER[cle]: rangee[cle] for cle in COLONNES_A_TRANCHER}
         for rangee in rangees],
    )
    return len(rangees), cible
