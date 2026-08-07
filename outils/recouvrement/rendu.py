"""Mise en forme et écriture des pièces d'un dossier : .eml, PDF, pièces jointes.

Le rendu PDF passe par une page HTML autonome, volontairement « hors ligne » :
- les images distantes ne sont jamais téléchargées (un pixel de traçage dans
  un mail de relance ne doit pas signaler à l'expéditeur qu'on ouvre le
  dossier au moment de le constituer) ;
- les images intégrées au message (cid:) sont, elles, incorporées au PDF ;
- scripts et contenus actifs sont retirés.
"""

from __future__ import annotations

import base64
import html
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unicodedata
from datetime import datetime
from pathlib import Path
from urllib.parse import unquote

from message import MessageMail, PieceJointe

# Balises entièrement supprimées (contenu compris).
BALISES_INTERDITES = {"script", "iframe", "object", "embed", "applet", "noscript"}

# Balises dont on jette l'ouverture mais pas le contenu textuel.
BALISES_IGNOREES = {"link", "base", "meta", "form", "input", "button", "select", "textarea"}

BALISES_ORPHELINES = {
    "area", "br", "col", "embed", "hr", "img", "input",
    "link", "meta", "param", "source", "track", "wbr",
}

SCHEMAS_DISTANTS = re.compile(r"^\s*(https?:|//)", re.IGNORECASE)
URL_DANS_CSS = re.compile(r"url\(\s*['\"]?\s*(https?:|//)[^)]*\)", re.IGNORECASE)

TAILLE_MAX_NOM = 60


def slug(texte: str, longueur: int = TAILLE_MAX_NOM) -> str:
    """Nom de fichier sûr : sans accent, sans caractère interdit, court.

    Les chemins Windows plafonnent à 260 caractères par défaut ; avec 40
    dossiers imbriqués, mieux vaut des noms courts.
    """
    texte = unicodedata.normalize("NFKD", texte or "")
    texte = texte.encode("ascii", "ignore").decode("ascii")
    texte = re.sub(r"[^A-Za-z0-9]+", "-", texte).strip("-").lower()
    if not texte:
        texte = "sans-titre"
    return texte[:longueur].strip("-") or "sans-titre"


def _adresse_courte(entete: str) -> str:
    """« Marie Dupont <marie@x.fr> » -> « marie »."""
    correspondance = re.search(r"[\w.+-]+@[\w-]+", entete or "")
    if correspondance:
        return correspondance.group(0).split("@")[0]
    return slug(entete, 20)


# --------------------------------------------------------------------------
# Nettoyage du HTML du message
# --------------------------------------------------------------------------

from html.parser import HTMLParser  # noqa: E402


class _NettoyeurHTML(HTMLParser):
    """Réécrit le HTML d'un mail en retirant tout ce qui déclenche du réseau
    ou du code, et en incorporant les images cid: sous forme de data URI."""

    def __init__(self, images_inline: dict[str, PieceJointe]):
        super().__init__(convert_charrefs=False)
        self.images_inline = images_inline
        self.morceaux: list[str] = []
        self._profondeur_interdite = 0
        self._dans_style = False

    # -- balises ---------------------------------------------------------
    def handle_starttag(self, tag, attrs):
        if self._profondeur_interdite:
            return
        if tag in BALISES_INTERDITES:
            self._profondeur_interdite = 1
            return
        if tag in BALISES_IGNOREES:
            return
        if tag == "style":
            self._dans_style = True
            self.morceaux.append("<style>")
            return
        if tag == "img":
            self.morceaux.append(self._rendre_image(attrs))
            return

        attributs = self._nettoyer_attributs(tag, attrs)
        fermeture = " />" if tag in BALISES_ORPHELINES else ">"
        self.morceaux.append(f"<{tag}{attributs}{fermeture}")

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)

    def handle_endtag(self, tag):
        if tag in BALISES_INTERDITES:
            self._profondeur_interdite = 0
            return
        if self._profondeur_interdite or tag in BALISES_IGNOREES:
            return
        if tag == "style":
            self._dans_style = False
            self.morceaux.append("</style>")
            return
        if tag in BALISES_ORPHELINES:
            return
        self.morceaux.append(f"</{tag}>")

    # -- contenu ---------------------------------------------------------
    def handle_data(self, data):
        if self._profondeur_interdite:
            return
        if self._dans_style:
            self.morceaux.append(URL_DANS_CSS.sub("none", data))
            return
        self.morceaux.append(html.escape(data, quote=False))

    def handle_entityref(self, name):
        if not self._profondeur_interdite:
            self.morceaux.append(f"&{name};")

    def handle_charref(self, name):
        if not self._profondeur_interdite:
            self.morceaux.append(f"&#{name};")

    def handle_comment(self, data):
        return

    # -- helpers ---------------------------------------------------------
    def _rendre_image(self, attrs) -> str:
        source = ""
        alt = ""
        for nom, valeur in attrs:
            nom = (nom or "").lower()
            if nom == "src":
                source = valeur or ""
            elif nom == "alt":
                alt = valeur or ""

        if source.lower().startswith("cid:"):
            cid = unquote(source[4:]).strip().strip("<>").lower()
            piece = self.images_inline.get(cid)
            if piece is not None:
                donnees = base64.b64encode(piece.contenu).decode("ascii")
                return (
                    f'<img src="data:{piece.type_mime};base64,{donnees}" '
                    f'alt="{html.escape(alt, quote=True)}" class="img-inline" />'
                )
            return '<span class="img-absente">[image intégrée illisible]</span>'

        if source.startswith("data:"):
            return f'<img src="{html.escape(source, quote=True)}" class="img-inline" />'

        if SCHEMAS_DISTANTS.match(source):
            legende = html.escape(alt or "image distante", quote=False)
            return f'<span class="img-absente">[{legende} — non téléchargée]</span>'

        return ""

    def _nettoyer_attributs(self, tag: str, attrs) -> str:
        sortie = []
        for nom, valeur in attrs:
            nom = (nom or "").lower()
            valeur = valeur or ""

            if nom.startswith("on") or nom in {"srcset", "background", "formaction"}:
                continue
            if nom == "style":
                valeur = URL_DANS_CSS.sub("none", valeur)
            if nom == "href":
                if valeur.lower().replace(" ", "").startswith(("javascript:", "vbscript:", "data:")):
                    continue
            if nom == "src" and tag != "img":
                continue

            sortie.append(f' {nom}="{html.escape(valeur, quote=True)}"')
        return "".join(sortie)


def nettoyer_html(source: str, images_inline: dict[str, PieceJointe]) -> str:
    nettoyeur = _NettoyeurHTML(images_inline)
    try:
        nettoyeur.feed(source)
        nettoyeur.close()
    except Exception:  # noqa: BLE001 - HTML de mail réel, parfois cassé
        return f'<pre class="corps-texte">{html.escape(source)}</pre>'
    return "".join(nettoyeur.morceaux)


# --------------------------------------------------------------------------
# Page HTML d'une pièce
# --------------------------------------------------------------------------

FEUILLE_DE_STYLE = """
@page { size: A4; margin: 14mm 12mm; }
body { font-family: Helvetica, Arial, sans-serif; font-size: 10pt; color: #111; }
.entete { border: 1px solid #888; padding: 8px; margin-bottom: 14px; }
.entete table { width: 100%; border-collapse: collapse; }
.entete td { padding: 2px 4px; vertical-align: top; font-size: 9pt; }
.entete td.cle { width: 110px; color: #444; font-weight: bold; }
.piece { font-size: 11pt; font-weight: bold; margin-bottom: 6px; }
.objet { font-size: 11pt; font-weight: bold; margin: 10px 0; }
.corps { font-size: 10pt; }
.corps img, .img-inline { max-width: 100%; }
.corps table { max-width: 100%; }
.corps-texte { white-space: pre-wrap; word-wrap: break-word; font-family: Helvetica, Arial, sans-serif; }
.img-absente { color: #777; font-style: italic; font-size: 8pt; }
.pied { margin-top: 18px; border-top: 1px solid #bbb; padding-top: 6px;
        color: #555; font-size: 7.5pt; }
"""


def taille_lisible(octets: int) -> str:
    if octets < 1024:
        return f"{octets} o"
    if octets < 1024 * 1024:
        return f"{octets / 1024:.0f} Ko"
    return f"{octets / (1024 * 1024):.1f} Mo"


def construire_html_message(
    message: MessageMail,
    numero_piece: int,
    reference_dossier: str,
    boite: str,
    date_export: datetime,
) -> str:
    if message.corps_html:
        corps = nettoyer_html(message.corps_html, message.images_inline)
    elif message.corps_texte:
        corps = f'<pre class="corps-texte">{html.escape(message.corps_texte)}</pre>'
    else:
        corps = '<p class="img-absente">[message sans corps textuel]</p>'

    if message.pieces_jointes:
        liste = ", ".join(
            f"{html.escape(pj.nom)} ({taille_lisible(pj.taille)})"
            for pj in message.pieces_jointes
        )
    else:
        liste = "aucune"

    lignes = [
        ("De", message.expediteur),
        ("À", message.destinataires),
    ]
    if message.copie:
        lignes.append(("Copie", message.copie))
    lignes += [
        ("Date", message.date.strftime("%d/%m/%Y %H:%M:%S (%z)")),
        ("Pièces jointes", liste),
        ("Message-ID", message.message_id),
    ]

    rangees = "".join(
        f'<tr><td class="cle">{html.escape(cle)}</td>'
        f"<td>{html.escape(str(valeur))}</td></tr>"
        for cle, valeur in lignes
    )

    return f"""<!DOCTYPE html>
<html lang="fr"><head><meta charset="utf-8" />
<title>{html.escape(reference_dossier)} - piece {numero_piece}</title>
<style>{FEUILLE_DE_STYLE}</style></head>
<body>
<div class="entete">
  <div class="piece">Dossier {html.escape(reference_dossier)} &mdash; pièce n° {numero_piece}</div>
  <table>{rangees}</table>
</div>
<div class="objet">Objet : {html.escape(message.objet)}</div>
<div class="corps">{corps}</div>
<div class="pied">
  Export réalisé le {date_export.strftime('%d/%m/%Y à %H:%M')} depuis la boîte
  {html.escape(boite)}. Message conservé au format .eml (en-têtes techniques
  complets) sous le même nom de fichier. Les images distantes n'ont pas été
  téléchargées.
</div>
</body></html>
"""


# --------------------------------------------------------------------------
# Conversion PDF
# --------------------------------------------------------------------------

_NOMS_CHROME = [
    "chromium", "chromium-browser", "google-chrome", "google-chrome-stable",
    "chrome", "msedge", "microsoft-edge",
]

_CHEMINS_CHROME = [
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
]


def _trouver_chrome() -> str | None:
    depuis_env = os.environ.get("CHROME_BIN")
    if depuis_env and Path(depuis_env).exists():
        return depuis_env
    for nom in _NOMS_CHROME:
        chemin = shutil.which(nom)
        if chemin:
            return chemin
    for chemin in _CHEMINS_CHROME:
        if Path(chemin).exists():
            return chemin
    return None


def _pdf_via_chrome(chemin_html: Path, chemin_pdf: Path) -> bool:
    binaire = _trouver_chrome()
    if not binaire:
        return False

    with tempfile.TemporaryDirectory(prefix="recouvrement-chrome-") as profil:
        commande = [
            binaire,
            "--headless=new",
            "--disable-gpu",
            "--no-sandbox",
            "--disable-dev-shm-usage",
            f"--user-data-dir={profil}",
            "--no-pdf-header-footer",
            "--virtual-time-budget=3000",
            f"--print-to-pdf={chemin_pdf}",
            chemin_html.resolve().as_uri(),
        ]
        try:
            resultat = subprocess.run(
                commande, capture_output=True, timeout=120, check=False
            )
        except (OSError, subprocess.TimeoutExpired):
            return False

    if chemin_pdf.exists() and chemin_pdf.stat().st_size > 0:
        return True
    return resultat.returncode == 0 and chemin_pdf.exists()


def _pdf_via_weasyprint(contenu_html: str, chemin_pdf: Path) -> bool:
    try:
        from weasyprint import HTML  # noqa: PLC0415
    except Exception:  # noqa: BLE001 - dépendances système souvent absentes
        return False
    try:
        HTML(string=contenu_html).write_pdf(str(chemin_pdf))
    except Exception:  # noqa: BLE001
        return False
    return chemin_pdf.exists()


def _pdf_via_xhtml2pdf(contenu_html: str, chemin_pdf: Path) -> bool:
    try:
        from xhtml2pdf import pisa  # noqa: PLC0415
    except ImportError:
        return False
    try:
        with chemin_pdf.open("wb") as sortie:
            statut = pisa.CreatePDF(
                contenu_html, dest=sortie, encoding="utf-8", link_callback=lambda *_: None
            )
    except Exception:  # noqa: BLE001
        return False
    if statut.err:
        chemin_pdf.unlink(missing_ok=True)
        return False
    return chemin_pdf.exists()


_MOTEUR_RETENU: str | None = None

# `<img src="data:...">` produits par l'incorporation des images cid:.
IMAGE_INCORPOREE = re.compile(r"<img[^>]*src=\"data:[^\"]*\"[^>]*/?>", re.IGNORECASE)


def retirer_images_integrees(contenu_html: str) -> str:
    """Retire les images incorporées d'une page qui refuse de s'imprimer.

    Une seule image abîmée dans un message suffit à faire échouer un moteur
    PDF. Mieux vaut la pièce sans son logo de signature que pas de pièce."""
    return IMAGE_INCORPOREE.sub(
        '<span class="img-absente">[image intégrée illisible]</span>', contenu_html
    )


def _essayer_moteurs(contenu_html: str, chemin_html: Path, chemin_pdf: Path) -> str | None:
    """Essaie chaque moteur, en commençant par celui qui a déjà fonctionné."""
    global _MOTEUR_RETENU  # noqa: PLW0603

    moteurs = [
        ("chrome", lambda: _pdf_via_chrome(chemin_html, chemin_pdf)),
        ("weasyprint", lambda: _pdf_via_weasyprint(contenu_html, chemin_pdf)),
        ("xhtml2pdf", lambda: _pdf_via_xhtml2pdf(contenu_html, chemin_pdf)),
    ]
    moteurs.sort(key=lambda moteur: moteur[0] != _MOTEUR_RETENU)

    for nom, tentative in moteurs:
        if tentative():
            _MOTEUR_RETENU = nom
            return nom
        chemin_pdf.unlink(missing_ok=True)
    return None


def moteur_pdf_disponible() -> str:
    if _trouver_chrome():
        return f"Chrome/Edge ({_trouver_chrome()})"
    try:
        import weasyprint  # noqa: F401, PLC0415

        return "WeasyPrint"
    except Exception:  # noqa: BLE001
        pass
    try:
        import xhtml2pdf  # noqa: F401, PLC0415

        return "xhtml2pdf"
    except ImportError:
        pass
    return "aucun (les pièces seront conservées en HTML)"


def ecrire_pdf(contenu_html: str, chemin_pdf: Path) -> tuple[bool, str]:
    """Écrit le PDF. En cas d'échec de tous les moteurs, conserve le HTML
    à côté et le signale — une pièce n'est jamais perdue silencieusement."""
    chemin_pdf.parent.mkdir(parents=True, exist_ok=True)
    chemin_html_temp = chemin_pdf.with_suffix(".html")
    chemin_html_temp.write_text(contenu_html, encoding="utf-8")

    moteur = _essayer_moteurs(contenu_html, chemin_html_temp, chemin_pdf)
    if moteur:
        chemin_html_temp.unlink(missing_ok=True)
        return True, moteur

    # Deuxième tentative sans les images incorporées, souvent seules en cause.
    degrade = retirer_images_integrees(contenu_html)
    if degrade != contenu_html:
        chemin_html_temp.write_text(degrade, encoding="utf-8")
        moteur = _essayer_moteurs(degrade, chemin_html_temp, chemin_pdf)
        if moteur:
            chemin_html_temp.unlink(missing_ok=True)
            return True, f"{moteur} sans images intégrées"

    # Dernier recours : on garde la page HTML, imprimable manuellement.
    chemin_html_temp.write_text(contenu_html, encoding="utf-8")
    return False, "html"


# --------------------------------------------------------------------------
# Écriture des fichiers d'une pièce
# --------------------------------------------------------------------------


def nom_de_base(message: MessageMail, numero_piece: int) -> str:
    return "{:03d}_{}_{}_{}".format(
        numero_piece,
        message.date.strftime("%Y-%m-%d_%H%M"),
        slug(_adresse_courte(message.expediteur), 20),
        slug(message.objet, 45),
    )


def ecrire_eml(message: MessageMail, dossier: Path, base: str) -> Path:
    dossier.mkdir(parents=True, exist_ok=True)
    chemin = dossier / f"{base}.eml"
    chemin.write_bytes(message.brut)
    return chemin


def ecrire_pieces_jointes(message: MessageMail, dossier_racine: Path, base: str) -> list[Path]:
    if not message.pieces_jointes:
        return []

    dossier = dossier_racine / base
    dossier.mkdir(parents=True, exist_ok=True)

    ecrits: list[Path] = []
    noms_utilises: set[str] = set()

    for index, piece in enumerate(message.pieces_jointes, start=1):
        suffixe = Path(piece.nom).suffix.lower()[:10]
        radical = slug(Path(piece.nom).stem, 45)
        nom = f"{radical}{suffixe}" if suffixe else radical

        if nom in noms_utilises:
            nom = f"{radical}_{index:02d}{suffixe}"
        noms_utilises.add(nom)

        chemin = dossier / nom
        chemin.write_bytes(piece.contenu)
        ecrits.append(chemin)

    return ecrits


def chemin_relatif(chemin: Path, racine: Path) -> str:
    try:
        return str(chemin.relative_to(racine)).replace(os.sep, "/")
    except ValueError:
        return str(chemin)


def verifier_environnement() -> None:
    if sys.version_info < (3, 9):
        raise SystemExit("Python 3.9 ou plus récent est requis.")
