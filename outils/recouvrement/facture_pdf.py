"""Lecture des dates portées par une facture PDF.

Le tableau de suivi ne renseigne pas toujours l'échéance ; la facture, elle,
la porte toujours. Comme les factures sont déjà téléchargées depuis Monday,
autant y lire la date plutôt que de laisser la tranche d'ancienneté vide.

Deux précautions gouvernent tout ce module :

1. **Une date n'est retenue que si elle est étiquetée.** Une facture porte
   plusieurs dates — émission, échéance, période de formation, date
   d'impression — et prendre la première venue reviendrait à tirer au sort.
   Chaque date est cherchée derrière son intitulé, et l'intitulé retenu est
   rapporté avec elle.
2. **L'origine de la date est toujours dite.** Une échéance lue dans un PDF
   n'a pas le même statut qu'une échéance saisie au tableau : le
   récapitulatif indique laquelle des deux a servi.

L'extraction passe par `pypdf` quand il est installé, et retombe sinon sur un
lecteur minimal suffisant pour une facture produite par un logiciel de
facturation. Une facture scannée, elle, ne rend aucun texte : c'est dit, pas
deviné.
"""

from __future__ import annotations

import re
import unicodedata
import zlib
from datetime import datetime
from pathlib import Path

# 12/03/2026, 12-03-2026, 12.03.26
DATE_CHIFFREE = re.compile(r"\b(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2,4})\b")

MOIS = {
    "janvier": 1, "fevrier": 2, "mars": 3, "avril": 4, "mai": 5, "juin": 6,
    "juillet": 7, "aout": 8, "septembre": 9, "octobre": 10, "novembre": 11,
    "decembre": 12,
}
DATE_EN_LETTRES = re.compile(
    r"\b(\d{1,2})\s+(" + "|".join(MOIS) + r")\s+(\d{4})\b"
)

# Intitulés cherchés, par ordre de préférence. L'échéance prime : c'est elle
# qui date le retard. À défaut, la date d'émission sert de repli, et le fait
# est signalé — un retard compté depuis l'émission est plus long qu'il ne l'est
# réellement, du délai de paiement accordé.
INTITULES = (
    ("echeance", (
        "date d echeance", "date echeance", "echeance le", "echeance",
        "date limite de paiement", "a regler avant le", "a regler avant",
        "payable avant le", "payable avant", "date de reglement",
    )),
    ("emission", (
        "date de facture", "date d emission", "date d edition", "facture du",
        "emise le", "date de la facture", "date",
    )),
)

# Au-delà, l'intitulé et la date n'ont plus de rapport l'un avec l'autre.
PORTEE_INTITULE = 60


def _aplatir(texte: str) -> str:
    """Minuscules sans accents, **sans changer la longueur du texte**.

    Deux contraintes tirent dans des sens opposés : il faut retrouver
    « date d'échéance » écrit de n'importe quelle façon, et lire « 11/04/2025 »
    juste après. Une mise à plat qui écrase la ponctuation détruirait les
    barres obliques de la date ; une qui retire les accents en changeant la
    longueur décalerait tout ce qui suit. D'où ce remplacement caractère par
    caractère, où les séparateurs de date sont les seuls signes conservés.
    """
    sortie = []
    for caractere in texte or "":
        decompose = unicodedata.normalize("NFKD", caractere)
        base = "".join(
            lettre for lettre in decompose if not unicodedata.combining(lettre)
        )
        sortie.append(base.lower() if len(base) == 1 else caractere.lower())
    return re.sub(r"[^a-z0-9/.\-]", " ", "".join(sortie))


def _texte_via_pypdf(chemin: Path) -> str:
    try:
        from pypdf import PdfReader  # noqa: PLC0415
    except ImportError:
        return ""
    try:
        lecteur = PdfReader(str(chemin))
        return "\n".join(page.extract_text() or "" for page in lecteur.pages)
    except Exception:  # noqa: BLE001 - un PDF réel est parfois mal formé
        return ""


def _chaines_du_flux(flux: bytes) -> list[str]:
    """Les chaînes littérales d'un flux de contenu PDF, dans l'ordre."""
    morceaux: list[str] = []
    position, taille = 0, len(flux)

    while position < taille:
        if flux[position:position + 1] != b"(":
            position += 1
            continue

        position += 1
        profondeur, contenu = 1, bytearray()
        while position < taille and profondeur:
            octet = flux[position]
            if octet == 0x5C:  # antislash
                suivant = flux[position + 1:position + 2]
                if suivant.isdigit():
                    octal = flux[position + 1:position + 4]
                    contenu.append(int(octal, 8) & 0xFF)
                    position += 1 + len(octal)
                    continue
                contenu += {b"n": b"\n", b"r": b"\r", b"t": b"\t"}.get(suivant, suivant)
                position += 2
                continue
            if octet == 0x28:
                profondeur += 1
            elif octet == 0x29:
                profondeur -= 1
                if not profondeur:
                    position += 1
                    break
            contenu.append(octet)
            position += 1

        morceaux.append(contenu.decode("latin-1", errors="replace"))

    return morceaux


def _texte_minimal(chemin: Path) -> str:
    """Extraction sans dépendance, suffisante pour une facture générée.

    On décompresse chaque flux et on relève ses chaînes littérales. Une
    facture scannée n'en contient aucune, et une police à encodage propre rend
    du charabia : dans les deux cas aucune date ne sera reconnue, ce qui est
    le comportement voulu — mieux vaut pas de date qu'une date inventée.
    """
    try:
        donnees = chemin.read_bytes()
    except OSError:
        return ""

    morceaux: list[str] = []
    for trouve in re.finditer(rb"stream\r?\n", donnees):
        debut = trouve.end()
        fin = donnees.find(b"endstream", debut)
        if fin == -1:
            continue
        brut = donnees[debut:fin]
        try:
            brut = zlib.decompress(brut)
        except zlib.error:
            pass  # flux non compressé, ou compression non gérée
        if b"(" not in brut:
            continue
        morceaux += _chaines_du_flux(brut)

    return " ".join(morceaux)


def texte_du_pdf(chemin: Path) -> str:
    return _texte_via_pypdf(chemin) or _texte_minimal(chemin)


def _date_lue(correspondance) -> str:
    """Vers JJ/MM/AAAA, ou chaîne vide si la date n'existe pas au calendrier."""
    groupes = correspondance.groups()
    if groupes[1] in MOIS:
        jour, mois, annee = int(groupes[0]), MOIS[groupes[1]], int(groupes[2])
    else:
        jour, mois, annee = (int(valeur) for valeur in groupes)
        if annee < 100:
            annee += 2000
    try:
        return datetime(annee, mois, jour).strftime("%d/%m/%Y")
    except ValueError:
        # 31/02, ou un jour et un mois inversés à l'anglaise : on n'essaie pas
        # de rattraper, une date de facture fausse vaut moins que pas de date.
        return ""


def _premiere_date(fragment: str) -> str:
    """La date qui suit immédiatement l'intitulé, et elle seule.

    Si cette première date n'existe pas au calendrier, on renonce plutôt que
    d'aller chercher la suivante : celle-ci appartiendrait déjà à un autre
    intitulé, et on daterait l'échéance avec la date d'émission.
    """
    candidates = [
        correspondance
        for motif in (DATE_EN_LETTRES, DATE_CHIFFREE)
        for correspondance in [motif.search(fragment)]
        if correspondance
    ]
    if not candidates:
        return ""
    return _date_lue(min(candidates, key=lambda c: c.start()))


def dates_de_facture(texte: str) -> dict:
    """Échéance et date d'émission portées par le texte d'une facture.

    Chaque date est cherchée derrière son intitulé, jamais isolément.
    """
    plat = _aplatir(texte)
    # Les positions se correspondent : la mise à plat conserve la longueur
    # d'origine sur les caractères ASCII, et les accents sont retirés sans
    # décaler ce qui suit dans le fragment examiné.
    resultat = {"echeance": "", "emission": "", "intitule": ""}

    for champ, intitules in INTITULES:
        for intitule in intitules:
            depart = 0
            while True:
                position = plat.find(intitule, depart)
                if position == -1:
                    break
                fragment = plat[
                    position + len(intitule):
                    position + len(intitule) + PORTEE_INTITULE
                ]
                date = _premiere_date(fragment)
                if date:
                    resultat[champ] = date
                    if champ == "echeance" and not resultat["intitule"]:
                        resultat["intitule"] = intitule
                    break
                depart = position + len(intitule)
            if resultat[champ]:
                break

    return resultat


def echeance_de_la_facture(chemin: Path) -> tuple[str, str]:
    """(date, origine) lues dans une facture PDF.

    L'origine dit ce qui a été trouvé — échéance ou date d'émission — pour que
    le récapitulatif n'affiche jamais une date sans dire ce qu'elle est.
    """
    texte = texte_du_pdf(chemin)
    if not texte.strip():
        return "", "illisible"

    dates = dates_de_facture(texte)
    if dates["echeance"]:
        return dates["echeance"], "échéance lue sur la facture"
    if dates["emission"]:
        return dates["emission"], "date d'émission de la facture, à défaut d'échéance"
    return "", "aucune date étiquetée"
