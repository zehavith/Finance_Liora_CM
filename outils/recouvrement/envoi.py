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

Le brouillon, lui, ne joint **qu'un seul fichier** : le PDF. Un destinataire
qui reçoit « dossier.zip » doit le décompresser avant de voir quoi que ce
soit, et six pièces jointes se recollent à la main. Les pièces du dossier sont
presque toujours des PDF — la convention, la facture, la feuille d'émargement
en sont —, et elles y entrent directement. Une pièce reçue en **image**, un
document scanné au fil d'un échange, devient une page. Ne partent à côté que
les pièces qu'aucun PDF ne peut absorber : un tableur, un document Word.
L'archive ne sert que de recours, quand le poste n'a pas de moteur PDF.

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


def messages_sans_pdf(repertoire: Path, lignes: list[LigneIndex],
                      absorbes: set | None = None) -> list[int]:
    """Les messages que le PDF unique ne porte pas. Rarement aucun, parfois.

    Sans moteur PDF au moment de l'export, un message est conservé en page
    HTML. Si le poste a un moteur aujourd'hui, cette page devient une page du
    PDF et le message y est : « absorbes » le dit. Sinon il reste au dossier
    et dans l'archive, mais hors du PDF — et le taire ferait transmettre un
    dossier amputé sans le savoir.
    """
    manquants = []
    for ligne in sorted(lignes, key=lambda l: l.piece_n):
        chemin = repertoire / (ligne.fichier_pdf or "")
        if ligne.fichier_pdf and chemin.suffix.lower() == ".pdf" \
                and chemin.is_file():
            continue
        # Repris depuis sa page HTML : il est dans le PDF, et le signaler
        # absent enverrait chercher un manque qui n'existe plus.
        if absorbes and chemin.is_file() and _empreinte(chemin) in absorbes:
            continue
        manquants.append(ligne.piece_n)
    return manquants


def pieces_hors_pdf(repertoire: Path) -> list[str]:
    """Les pièces clés qu'un PDF ne peut vraiment pas porter.

    Les images en deviennent des pages ; un tableur ou un document Word, non
    — il faudrait une suite bureautique, qui n'est pas toujours là. Ces
    pièces-là voyagent donc à côté, et le taire ferait transmettre un dossier
    amputé sans le savoir.
    """
    cles = repertoire / "pieces-cles"
    if not cles.is_dir():
        return []
    return sorted(
        chemin.name
        for chemin in cles.rglob("*")
        if chemin.is_file()
        and chemin.suffix.lower() not in (".pdf", *IMAGES)
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


# Ce qu'un PDF peut absorber : une image devient une page. Un tableur ou un
# document Word, non — il faudrait une suite bureautique, qui n'est pas
# toujours là, et dont la mise en page varierait d'un poste à l'autre.
IMAGES = (".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".tif", ".tiff")

DOSSIER_CONVERTIES = "pieces-converties"

# Chaque conversion lance le moteur PDF. Au-delà, ce ne sont plus des pièces
# choisies mais un dossier d'images, et faire attendre cinq minutes devant un
# brouillon qui ne vient pas est pire que deux fichiers joints.
CONVERSIONS_MAX = 12

# Sous cette taille, une image jointe à un message n'est pas un document :
# c'est un logo de signature. Les logos référencés dans le corps du message
# ne sont pas écrits comme pièces jointes — ils sont intégrés au rendu —,
# mais certaines signatures en attachent un sans le référencer. Un document
# scanné et envoyé en image pèse dix à cent fois cela.
TAILLE_IMAGE_DOCUMENT = 40 * 1024


def image_en_pdf(source: Path, cible: Path) -> bool:
    """Une image devient une page de PDF, pour que le dossier tienne en un seul.

    Les pièces du dossier sont presque toujours des PDF — la convention, la
    facture, la feuille d'émargement en sont — et entrent dans le PDF unique
    telles quelles. Reste le cas d'un document **scanné et envoyé en image**
    au fil d'un échange : pièce du dossier comme une autre, mais qui
    voyageait à part, et il fallait deux fichiers là où l'on en voulait un.

    Passe par le moteur PDF déjà utilisé pour les messages : rien à installer
    de plus. L'image est intégrée à la page, jamais liée — un chemin ne
    survivrait pas au rendu.
    """
    import base64  # noqa: PLC0415
    import mimetypes  # noqa: PLC0415

    try:
        octets = source.read_bytes()
    except OSError:
        return False

    type_devine, _ = mimetypes.guess_type(source.name)
    if not (type_devine or "").startswith("image/"):
        return False

    donnees = base64.b64encode(octets).decode("ascii")
    html = (
        "<!doctype html><html lang=\"fr\"><head><meta charset=\"utf-8\" />"
        "<style>@page{margin:14mm}body{margin:0;font:12px system-ui,sans-serif}"
        "h1{font-size:13px;font-weight:600;margin:0 0 10px}"
        "img{max-width:100%;max-height:230mm;display:block}</style></head><body>"
        f"<h1>{_echapper(source.name)}</h1>"
        f"<img src=\"data:{type_devine};base64,{donnees}\" alt=\"\" />"
        "</body></html>"
    )

    from rendu import ecrire_pdf  # noqa: PLC0415

    cible.parent.mkdir(parents=True, exist_ok=True)
    try:
        reussi, _motif = ecrire_pdf(html, cible)
    except Exception:  # noqa: BLE001 - un moteur absent n'est pas une panne
        return False
    return bool(reussi) and cible.exists() and cible.stat().st_size > 0


def _echapper(texte: str) -> str:
    import html as module_html  # noqa: PLC0415

    return module_html.escape(str(texte or ""))


def pdfs_du_dossier(repertoire: Path, lignes: list[LigneIndex],
                    convertir=None, absorbes: set | None = None,
                    page_en_pdf=None) -> list[Path]:
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
    converties = 0

    def ajouter(chemin: Path, convertible: bool = False) -> None:
        nonlocal converties
        if not chemin.is_file():
            return
        suffixe = chemin.suffix.lower()
        est_image = suffixe in IMAGES
        if suffixe != ".pdf" and not (convertible and convertir and est_image):
            return
        # L'empreinte porte sur l'original : une image déjà convertie ne doit
        # pas l'être une seconde fois sous un autre chemin.
        empreinte = _empreinte(chemin)
        if empreinte is None or empreinte in vus:
            return
        vus.add(empreinte)
        if suffixe == ".pdf":
            ordre.append(chemin)
            if absorbes is not None:
                absorbes.add(empreinte)
            return
        if converties >= CONVERSIONS_MAX:
            return
        converti = convertir(chemin)
        converties += 1
        if converti is not None:
            ordre.append(converti)
            # L'original est dans le PDF, sous une autre forme : le joindre
            # en plus l'enverrait deux fois.
            if absorbes is not None:
                absorbes.add(empreinte)

    ajouter(repertoire / "synthese.pdf")

    # Les pièces clés, et elles seules, valent d'être converties : ce sont
    # des documents choisis, une feuille d'émargement, un diplôme scanné.
    # Une image trouvée n'importe où dans le dossier, c'est d'abord un logo
    # de signature de courriel — il y en a un par message. Les convertir
    # toutes lançait le moteur PDF vingt fois pour un dossier de vingt
    # messages : la préparation n'aboutissait plus, et le brouillon partait
    # sans rien.
    for nom_cle in ("pieces-cles", "documents-monday", "pieces-ajoutees"):
        racine_cle = repertoire / nom_cle
        if not racine_cle.is_dir():
            continue
        for chemin in sorted(racine_cle.rglob("*")):
            ajouter(chemin, convertible=True)

    for ligne in sorted(lignes, key=lambda l: l.piece_n):
        if not ligne.fichier_pdf:
            continue
        rendu_message = repertoire / ligne.fichier_pdf
        if rendu_message.suffix.lower() == ".pdf" and rendu_message.is_file():
            ajouter(rendu_message)
            continue
        # Sans moteur PDF au moment de l'export, le message a été conservé en
        # page HTML : le dossier est complet sur le disque, mais le PDF unique
        # ne pouvait pas le porter — il ne réunissait alors que la note de
        # synthèse, et le dossier transmis paraissait vide de ses échanges.
        # Le poste a un moteur aujourd'hui : la page devient une page du PDF,
        # et l'export d'hier est réparé sans qu'on le refasse.
        if page_en_pdf is None:
            continue
        page = rendu_message if rendu_message.is_file() else None
        if page is None or page.suffix.lower() not in (".html", ".htm"):
            page = next((repertoire / (ligne.fichier_pdf[:-4] + suffixe)
                         for suffixe in (".html", ".htm")
                         if (repertoire / (ligne.fichier_pdf[:-4] + suffixe)).is_file()),
                        None)
        if page is None:
            continue
        converti = page_en_pdf(page)
        if converti is not None:
            ordre.append(converti)
            if absorbes is not None:
                empreinte = _empreinte(page)
                if empreinte is not None:
                    absorbes.add(empreinte)

    # Le reste du dossier, dans l'ordre du disque : ce que ni le classement
    # ni les numéros de pièce n'ont ramassé. Une image y est convertie si
    # elle pèse le poids d'un document — un document scanné et envoyé en
    # image — et laissée telle quelle si c'est un logo de signature. Ce qui
    # n'est pas absorbé est joint à côté : rien n'est perdu.
    for chemin in sorted(repertoire.rglob("*")):
        if _a_exclure(chemin, repertoire) or not chemin.is_file():
            continue
        document = (chemin.suffix.lower() in IMAGES
                    and chemin.stat().st_size >= TAILLE_IMAGE_DOCUMENT)
        ajouter(chemin, convertible=document)

    return ordre


def ecrire_pdf_unique(
    repertoire: Path, lignes: list[LigneIndex], cible: Path,
    absorbes: set | None = None, reunies: list | None = None,
) -> tuple[int, int, str]:
    """Réunit les PDF du dossier en un seul. Renvoie (pièces, octets, motif).

    Un motif non vide dit pourquoi il n'y a pas de PDF — c'est une absence à
    expliquer, jamais une erreur à taire.
    """
    # Pas seulement ImportError : une installation abîmée de pypdf échoue à
    # l'import par une erreur d'un tout autre genre. L'archive, elle, est
    # déjà prête — et c'est elle qui compte le plus.
    # BaseException et non Exception : la panique d'une extension native
    # compilée n'est pas une exception ordinaire, et passait au travers.
    try:
        from pypdf import PdfWriter  # noqa: PLC0415
    except BaseException as exc:  # noqa: BLE001 - y compris une panique native
        return 0, 0, (
            "la réunion en un seul PDF demande la bibliothèque « pypdf », "
            f"qui n'a pas pu être chargée ({type(exc).__name__}) — "
            "l'archive zip, elle, est prête"
        )

    # Les images deviennent des pages : un document scanné et envoyé en
    # image est une pièce du dossier, et le dossier doit tenir en un seul
    # fichier. Les conversions vivent dans « pour-envoi », donc hors de
    # l'archive et hors du balayage des documents.
    atelier = cible.parent / DOSSIER_CONVERTIES

    def convertir(source: Path) -> Path | None:
        vers = atelier / (source.stem + ".pdf")
        if vers.exists() and vers.stat().st_mtime >= source.stat().st_mtime:
            return vers
        return vers if image_en_pdf(source, vers) else None

    def convertir_page(source: Path) -> Path | None:
        vers = atelier / (source.stem + ".pdf")
        if vers.exists() and vers.stat().st_mtime >= source.stat().st_mtime:
            return vers
        from rendu import pdf_depuis_page  # noqa: PLC0415

        return vers if pdf_depuis_page(source, vers) else None

    sources = pdfs_du_dossier(repertoire, lignes, convertir, absorbes,
                              convertir_page)
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
        # Non seulement combien, mais lesquelles : « le PDF ne contient que
        # la synthèse » ne se vérifie pas avec un nombre qu'on ne voit nulle
        # part. L'application doit pouvoir dire ce qu'elle a réuni.
        if reunies is not None:
            reunies.append(source.name)

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
        "Le PDF réunit l'ensemble du dossier, en un seul fichier : la note de "
        "synthèse ouvre — elle résume la situation, les pièces et les "
        "échanges, chaque constat renvoyant à un numéro de pièce —, puis "
        "viennent les pièces et les échanges eux-mêmes.",
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


# Ce qui n'a pas à partir comme document séparé : les rendus de messages, que
# le PDF unique porte déjà page à page, et les messages d'origine, qui sont
# une preuve d'authenticité et non une pièce qu'on lit. Les joindre ferait
# vingt-deux fichiers de plus dans le mail, pour rien.
SUFFIXES_HORS_DOCUMENTS = (".eml", ".html", ".htm", ".json", ".version",
                           ".log", ".en-cours")

# La plomberie du dossier, qui ne se transmet pas. Écartée par son nom et non
# par son extension : un relevé d'heures en CSV est un document, lui.
#
# « synthese.version » est parti en pièce jointe à un responsable : c'est le
# fichier qui dit quelle version de l'outil a écrit la note, un octet de
# plomberie interne. Ce qui n'est pas un document du dossier n'a rien à faire
# dans un mail de transmission.
NOMS_HORS_DOCUMENTS = ("index.csv", "_recapitulatif.csv", "journal.log",
                       "synthese.version", "synthese.html", "synthese.pdf")


def documents_du_dossier(repertoire: Path, lignes: list[LigneIndex]) -> list[Path]:
    """Les documents du dossier, un par un, dans l'ordre où on les présente.

    Un destinataire à qui l'on envoie une archive doit la décompresser avant
    de voir quoi que ce soit. Les pièces clés d'abord — convention, facture,
    émargement, relevé, diplôme, progression —, parce qu'elles portent un nom
    qui se reconnaît dans une liste de pièces jointes ; les autres pièces
    jointes des messages ensuite.

    Une pièce et sa copie ne font qu'un : les pièces clés sont des copies, et
    c'est le contenu qui les rapproche, non le chemin.
    """
    ordre: list[Path] = []
    vus: set[tuple[int, str]] = set()

    def ajouter(chemin: Path) -> None:
        if not chemin.is_file():
            return
        if chemin.suffix.lower() in SUFFIXES_HORS_DOCUMENTS:
            return
        if chemin.name in NOMS_HORS_DOCUMENTS:
            return
        empreinte = _empreinte(chemin)
        if empreinte is None or empreinte in vus:
            return
        vus.add(empreinte)
        ordre.append(chemin)

    # Les rendus de messages sont dans le PDF unique : les joindre en plus
    # ferait vingt-deux fichiers pour rien.
    rendus = {
        (repertoire / ligne.fichier_pdf).resolve()
        for ligne in lignes if ligne.fichier_pdf
    }

    cles = repertoire / "pieces-cles"
    if cles.is_dir():
        for sous in sorted(cles.iterdir()):
            if sous.is_dir():
                for fichier in sorted(sous.iterdir()):
                    ajouter(fichier)

    for nom_annexe in ("documents-monday", "pieces-ajoutees"):
        annexe = repertoire / nom_annexe
        if annexe.is_dir():
            for fichier in sorted(annexe.iterdir()):
                ajouter(fichier)

    for ligne in sorted(lignes, key=lambda l: l.piece_n):
        sous = (ligne.dossier_pieces_jointes or "").strip()
        if not sous:
            continue
        repertoire_piece = repertoire / sous
        if repertoire_piece.is_dir():
            for fichier in sorted(repertoire_piece.iterdir()):
                if fichier.resolve() not in rendus:
                    ajouter(fichier)

    # Et tout le reste du dossier : une pièce jointe rangée ailleurs que là où
    # l'index l'annonce — ou un index qu'on n'a pas pu relire — ne doit pas
    # faire partir un dossier amputé. La note de synthèse est déjà la première
    # page du PDF ; l'y rejoindre en pièce séparée ne servirait à rien.
    synthese = (repertoire / "synthese.pdf").resolve()
    for fichier in sorted(repertoire.rglob("*")):
        if _a_exclure(fichier, repertoire):
            continue
        resolu = fichier.resolve()
        if resolu in rendus or resolu == synthese:
            continue
        ajouter(fichier)

    return ordre


# Là où vivent les pièces qu'on a choisies : le classement par nature, les
# documents du tableau, ce que le service a versé à la main.
DOSSIERS_CHOISIS = ("pieces-cles", "documents-monday", "pieces-ajoutees")


def _est_piece_choisie(chemin: Path) -> bool:
    return any(nom in chemin.parts for nom in DOSSIERS_CHOISIS)


def pieces_du_brouillon(
    pret: dict, racine: Path, documents: list[Path] | None = None,
) -> tuple[list[Path], str]:
    """Ce qu'on attache : **un seul fichier**, autant que faire se peut.

    Le PDF unique porte le dossier entier — la note, les pièces, les
    échanges, et jusqu'aux documents reçus en image, devenus des pages. Un
    destinataire n'a alors rien à décompresser ni à recoller : il ouvre, il
    lit, il classe.

    Ne partent à côté que les pièces qu'aucun PDF ne peut absorber : un
    tableur, un document Word. Elles sont nommées.

    Sans PDF unique — moteur absent du poste —, c'est l'archive qui part : un
    dossier en un fichier vaut mieux qu'un dossier qui ne part pas, et l'on
    dit qu'elle est à décompresser.

    Renvoie (pièces, motif). Un motif non vide dit ce qui n'a pas pu être
    joint, et d'où le glisser à la main.
    """
    def poids_de(chemin: Path) -> int | None:
        try:
            return chemin.stat().st_size
        except OSError:
            return None

    pdf = racine / pret["pdf"] if pret.get("pdf") else None
    if pdf is not None and (poids_de(pdf) or 0) > PIECE_MAX:
        pdf = None

    archive = racine / pret["archive"] if pret.get("archive") else None

    # Sans PDF unique, l'archive fait le dossier. Le dire : elle se
    # décompresse, et c'est justement ce qu'on voulait éviter.
    if pdf is None:
        if archive is not None and (poids_de(archive) or 0) <= PIECE_MAX:
            return [archive], (
                "le PDF unique n'a pas pu être produit : c'est l'archive qui "
                "part, à décompresser"
            )
        return [], "ni PDF ni archive : rien n'a pu être préparé"

    gardees = [pdf]
    total = poids_de(pdf) or 0
    ecartes: list[str] = []
    vignettes: list[str] = []

    absorbes = pret.get("absorbes")
    for document in documents or []:
        # Un document n'est écarté que s'il est **réellement** dans le PDF —
        # son empreinte le dit. S'en remettre à l'extension perdait une
        # facture scannée jointe à un message : image, donc supposée absorbée,
        # alors que seules les pièces clés le sont.
        if absorbes is not None:
            if _empreinte(document) in absorbes:
                continue
        elif document.suffix.lower() == ".pdf":
            continue
        poids = poids_de(document)
        # Une image minuscule attachée à un message est un logo de signature,
        # pas une pièce : vingt messages en portent vingt, et les joindre
        # noierait le dossier. Elle reste au répertoire et dans l'archive, et
        # l'écran la compte — rien n'est perdu en silence.
        #
        # Une pièce **choisie** ne subit jamais ce sort, si petite soit-elle :
        # une pièce clé que le moteur PDF n'a pas su convertir est jointe
        # telle quelle. C'est un document, pas un ornement.
        if (document.suffix.lower() in IMAGES
                and not _est_piece_choisie(document)
                and (poids or 0) < TAILLE_IMAGE_DOCUMENT):
            vignettes.append(document.name)
            continue
        if poids is None:
            continue
        if poids > PIECE_MAX or total + poids > MESSAGE_MAX:
            ecartes.append(document.name)
            continue
        gardees.append(document)
        total += poids

    morceaux = []
    if ecartes:
        morceaux.append(
            "trop lourd pour un message, à joindre à la main depuis le "
            "répertoire : " + ", ".join(ecartes[:5])
            + ("…" if len(ecartes) > 5 else ""))
    if vignettes:
        morceaux.append(
            f"{len(vignettes)} petite(s) image(s) non jointe(s), des logos de "
            "signature selon toute vraisemblance — elles restent au "
            "répertoire et dans l'archive")
    return gardees, " ; ".join(morceaux)


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
        # Une pièce illisible — un PDF ouvert dans Acrobat, un fichier
        # verrouillé — faisait renoncer au brouillon entier : la fenêtre de
        # rédaction s'ouvrait vide, et le dossier ne partait pas. Elle est
        # maintenant écartée seule, et nommée.
        try:
            octets = piece.read_bytes()
        except OSError as exc:
            trop_lourdes.append(f"{piece.name} (illisible : {exc.strerror or exc})")
            continue
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

    # Un brouillon sans le dossier n'est pas un brouillon. Il est écrit tout
    # de même — le texte et le destinataire sont déjà du travail fait —, mais
    # l'absence se dit en premier : le croire complet ferait transmettre un
    # dossier vide.
    jointes = sum(1 for part in message.walk() if part.get_filename())
    motif = ""
    if trop_lourdes and not jointes:
        motif = (
            "aucune pièce n'a pu être jointe, trop lourde(s) ou illisible(s) "
            "pour un brouillon — à joindre à la main : "
            + ", ".join(trop_lourdes)
        )
    elif trop_lourdes:
        motif = (
            "pièce(s) trop lourde(s) pour un brouillon, à joindre à la main : "
            + ", ".join(trop_lourdes)
        )
    elif pieces and not jointes:
        motif = "aucune pièce n'a pu être jointe à ce brouillon"
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
    absorbes: set = set()
    reunies: list[str] = []
    pieces, poids_pdf, motif = ecrire_pdf_unique(
        repertoire, lignes, destination / f"{base}.pdf", absorbes, reunies
    )

    absents = messages_sans_pdf(repertoire, lignes, absorbes) if pieces else []
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
        dit = (f"{len(autres)} pièce(s) clé(s) ne sont pas dans le PDF, "
               "n'étant pas des PDF (" + ", ".join(autres[:3])
               + ("…" if len(autres) > 3 else "")
               + ") — elles sont jointes à part")
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
        # Les empreintes des documents que le PDF a absorbés. Ce qui n'y
        # figure pas est joint à côté : c'est ainsi qu'on tient la promesse
        # « tout le dossier part », sans rien envoyer deux fois.
        "absorbes": absorbes,
        # Ce que le PDF réunit, nommément : la note, les pièces, les
        # échanges. Sans cette liste, « il n'y a que la synthèse » ne peut ni
        # se confirmer ni se démentir depuis l'application.
        "pieces_noms": reunies,
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
