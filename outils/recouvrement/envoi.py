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


def pdfs_du_dossier(repertoire: Path, lignes: list[LigneIndex]) -> list[Path]:
    """Les PDF à réunir, dans l'ordre où l'on présente un dossier.

    La note de synthèse ouvre : c'est elle qui dit de quoi il retourne. Les
    pièces qui établissent la créance suivent — convention, facture,
    émargement, relevé, diplôme, progress report —, puis les échanges dans
    l'ordre de leurs numéros de pièce, ceux-là mêmes que la note cite.
    """
    ordre: list[Path] = []
    vus: set[Path] = set()

    def ajouter(chemin: Path) -> None:
        resolu = chemin.resolve()
        if chemin.is_file() and chemin.suffix.lower() == ".pdf" and resolu not in vus:
            vus.add(resolu)
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
        "motif": motif,
    }
