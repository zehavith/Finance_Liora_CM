"""L'adresse postale du débiteur, lue là où elle se trouve.

C'est l'adresse à laquelle part une mise en demeure, et sans laquelle un
dossier ne se transmet pas à un huissier. Trois sources, dans cet ordre :

1. **le tableau de suivi** — c'est le service qui la tient, et ce qu'il tient
   fait foi ;
2. **la convention de formation** — signée par le débiteur, elle porte son
   adresse au moment de l'engagement ;
3. **la facture** — à défaut, l'adresse de facturation.

Lire une adresse dans un PDF est une déduction, jamais une certitude : la
note dit donc d'où elle vient, et une adresse déduite se distingue d'une
adresse saisie. Mieux vaut pas d'adresse qu'une fausse adresse — on
n'assigne pas à une adresse devinée.
"""

from __future__ import annotations

import re
from pathlib import Path

# Un code postal français suivi d'une commune : c'est le seul repère sûr dans
# une page de texte. Sans lui, aucune ligne n'est retenue — « 12 rue des
# Lilas » tout seul ne prouve rien, et se trouve dans n'importe quel modèle.
MOTIF_CODE_POSTAL = re.compile(
    r"\b(?P<cp>(?:0[1-9]|[1-8]\d|9[0-8])\d{3})\s+(?P<ville>[A-ZÀ-ÖØ-Þ][\w'\- À-ÿ]{1,40})"
)

# Les lignes qui ouvrent une adresse : numéro et voie, ou mention de boîte.
MOTIF_VOIE = re.compile(
    r"^\s*(?:\d{1,4}\s*(?:bis|ter|quater)?\s*[,.]?\s*)?"
    r"(?:rue|avenue|av\.|boulevard|bd|impasse|allée|allee|chemin|route|place|"
    r"quai|cours|square|résidence|residence|lieu[- ]dit|zone|za|zi|zac|"
    r"immeuble|bâtiment|batiment|appartement|apt|bp|cs)\b",
    re.IGNORECASE,
)

# Ce qui n'est jamais l'adresse du débiteur : la nôtre. Une facture porte
# d'abord l'émetteur, et retenir la première adresse venue ferait mettre en
# demeure Liora elle-même.
MOTS_MAISON = ("liora", "datascientest", "inseec", "omnes")

# Au-delà, ce n'est plus une adresse mais un paragraphe.
LIGNES_MAX = 5


def _propre(ligne: str) -> str:
    return " ".join((ligne or "").replace("\xa0", " ").split())


def est_complete(texte: str) -> bool:
    """Une adresse complète porte une voie *et* un code postal avec sa commune.

    « 75001 PARIS » n'est pas une adresse : on n'y présente pas un huissier.
    « 12 rue des Lilas » non plus. L'une et l'autre valent d'être écrites —
    elles font gagner l'essentiel du travail de recherche — mais elles se
    complètent avant de servir, et la note doit le dire.
    """
    propre = _propre(texte)
    return bool(MOTIF_CODE_POSTAL.search(propre)) and bool(
        MOTIF_VOIE.match(propre) or any(
            MOTIF_VOIE.match(morceau.strip())
            for morceau in propre.split(",")
        )
    )


def adresse_partielle_dans_le_texte(texte: str, nom: str = "") -> str:
    """Ce qu'on trouve de l'adresse quand elle n'est pas complète.

    Une voie sans code postal, un code postal sans voie : c'est un début, et
    un début vaut mieux que rien. Le service complète en deux minutes ce
    qu'il mettrait une heure à retrouver.
    """
    lignes = [_propre(ligne) for ligne in (texte or "").splitlines()]
    lignes = [ligne for ligne in lignes if ligne]
    if not lignes:
        return ""

    mots_nom = [mot for mot in _propre(nom).lower().split() if len(mot) > 2]

    def _maison(rang: int) -> bool:
        environ = " ".join(lignes[max(0, rang - 2):rang + 1]).lower()
        return any(mot in environ for mot in MOTS_MAISON)

    # Une voie d'abord : c'est le plus utile des deux morceaux.
    for depart in (True, False):
        for rang, ligne in enumerate(lignes):
            if _maison(rang):
                continue
            voisinage = " ".join(lignes[max(0, rang - 3):rang + 1]).lower()
            if depart and mots_nom and not all(m in voisinage for m in mots_nom):
                continue
            if MOTIF_VOIE.match(ligne):
                return ligne
            trouve = MOTIF_CODE_POSTAL.search(ligne)
            if trouve:
                return ligne[trouve.start():].strip(" ,;")
    return ""


def adresse_dans_le_texte(texte: str, nom: str = "") -> str:
    """L'adresse la plus plausible d'un texte de PDF, ou une chaîne vide.

    On part du code postal — le seul repère sûr — et l'on remonte les lignes
    qui le précèdent tant qu'elles ressemblent à une adresse. Le nom du
    débiteur, quand on le connaît, départage deux adresses présentes sur la
    même page : celle qui suit son nom est la sienne.
    """
    lignes = [_propre(ligne) for ligne in (texte or "").splitlines()]
    lignes = [ligne for ligne in lignes if ligne]
    if not lignes:
        return ""

    plat_nom = _propre(nom).lower()
    mots_nom = [mot for mot in plat_nom.split() if len(mot) > 2]

    candidates: list[tuple[int, str]] = []
    for rang, ligne in enumerate(lignes):
        trouve = MOTIF_CODE_POSTAL.search(ligne)
        if not trouve:
            continue

        # Les lignes qui précèdent, tant qu'elles tiennent de l'adresse.
        morceaux = [ligne[trouve.start():].strip(" ,;")]
        depart = rang
        for precedente in range(rang - 1, max(-1, rang - LIGNES_MAX), -1):
            avant = lignes[precedente]
            if MOTIF_VOIE.match(avant) or (len(avant) < 60 and "@" not in avant
                                           and not avant.endswith(":")):
                morceaux.insert(0, avant)
                depart = precedente
                if MOTIF_VOIE.match(avant):
                    break
            else:
                break

        # Notre propre adresse ne se met pas en demeure. Le contrôle porte
        # sur les lignes d'origine, et non sur le bloc retenu : « DataScienTest
        # SAS, 6 rue Georges Bizet, 75116 Paris » tient sur une seule ligne,
        # dont on n'aurait gardé que la fin — sans le nom qui la trahit.
        environ = " ".join(lignes[max(0, depart - 2):rang + 1]).lower()
        if any(mot in environ for mot in MOTS_MAISON):
            continue

        bloc = ", ".join(morceaux)

        # Une adresse qui suit le nom du débiteur l'emporte : sur une
        # facture, l'émetteur est en haut et le client en dessous.
        voisinage = " ".join(lignes[max(0, depart - 3):rang + 1]).lower()
        proche_du_nom = bool(mots_nom) and all(m in voisinage for m in mots_nom)
        candidates.append((0 if proche_du_nom else 1, bloc))

    if not candidates:
        return ""
    candidates.sort(key=lambda paire: paire[0])
    return candidates[0][1]


def adresse_dans_un_pdf(chemin: Path, nom: str = "") -> str:
    """L'adresse lue dans un PDF, sans jamais lever d'exception."""
    try:
        from facture_pdf import texte_du_pdf  # noqa: PLC0415

        return adresse_dans_le_texte(texte_du_pdf(chemin), nom)
    except Exception:  # noqa: BLE001 - un PDF illisible n'est pas une panne
        return ""


def _pdfs_ranges(repertoire: Path, sous_dossier: str) -> list[Path]:
    cible = repertoire / "pieces-cles" / sous_dossier
    if not cible.is_dir():
        return []
    return sorted(chemin for chemin in cible.iterdir()
                  if chemin.suffix.lower() == ".pdf")


def _pieces_a_lire(repertoire: Path) -> list[tuple[Path, str]]:
    """Les pièces où chercher une adresse, dans l'ordre : convention, facture."""
    pieces: list[tuple[Path, str]] = []
    for sous_dossier, source in (("1-convention-devis-signe", "convention"),
                                 ("2-facture", "facture")):
        pieces += [(chemin, source)
                   for chemin in _pdfs_ranges(repertoire, sous_dossier)]

    # À défaut de pièces clés — un dossier d'avant leur mise en place —, les
    # documents du tableau, où la convention et la facture atterrissent.
    monday = repertoire / "documents-monday"
    if monday.is_dir():
        for chemin in sorted(monday.glob("*.pdf")):
            plat = chemin.name.lower()
            source = ("convention" if "convention" in plat or "contrat" in plat
                      else "facture" if "fact" in plat else "")
            if source:
                pieces.append((chemin, source))
    return pieces


def trouver(repertoire: Path, dossier) -> tuple[str, str, bool]:
    """L'adresse du débiteur, sa source, et si elle est complète.

    Renvoie (adresse, source, complète) où la source vaut « tableau »,
    « convention » ou « facture ».

    Une adresse incomplète est rendue quand même : une voie sans code postal
    fait gagner l'essentiel du travail, et le service la complète en deux
    minutes. C'est de la taire qui coûterait — encore faut-il qu'elle soit
    annoncée comme incomplète, et jamais présentée comme utilisable telle
    quelle.
    """
    du_tableau = _propre(getattr(dossier, "adresse_postale", "") or "")
    if du_tableau and est_complete(du_tableau):
        return du_tableau, "tableau", True

    nom = getattr(dossier, "nom", "") or ""
    pieces = _pieces_a_lire(repertoire)

    # Toutes les sources sont éprouvées avant de se contenter d'un morceau :
    # une adresse entière sur la facture vaut mieux qu'une voie sans code
    # postal au tableau. On ne se rabat qu'après avoir cherché partout.
    for chemin, source in pieces:
        lue = adresse_dans_un_pdf(chemin, nom)
        if lue and est_complete(lue):
            return lue, source, True

    # Rien de complet nulle part. Ce qu'on a, alors, dans l'ordre des
    # sources — le tableau d'abord, puisque c'est le service qui le tient.
    if du_tableau:
        return du_tableau, "tableau", False

    for chemin, source in pieces:
        lue = adresse_dans_un_pdf(chemin, nom)
        if lue:
            return lue, source, False

    for chemin, source in pieces:
        try:
            from facture_pdf import texte_du_pdf  # noqa: PLC0415

            partielle = adresse_partielle_dans_le_texte(texte_du_pdf(chemin), nom)
        except Exception:  # noqa: BLE001
            partielle = ""
        if partielle:
            return partielle, source, False

    return "", "", False
