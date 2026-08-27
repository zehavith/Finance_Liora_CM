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
from datetime import datetime, timedelta
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

# Intitulés cherchés, par champ et par ordre de préférence.
#
# Aucun intitulé générique — pas de « date » tout court : une facture Liora
# porte « Dates de service : 06/06/2022 - 13/06/2022 », et un intitulé trop
# large y lirait le début de la prestation en croyant lire la facture.
INTITULES = (
    ("facture", (
        "en date du", "date de facture", "date de la facture", "facture du",
        "date d emission", "date d edition", "emise le",
    )),
    ("debut_formation", (
        "debut de formation", "date de debut de formation", "debut de service",
        "dates de service", "date de debut",
    )),
    ("fin_formation", (
        "fin de formation", "date de fin de formation", "fin de service",
        "date de fin",
    )),
    # Une échéance parfois imprimée sur la facture. Elle ne fait pas foi chez
    # Liora — l'échéance se calcule — mais elle sert de dernier recours quand
    # ni la date de facture ni le début de formation ne sont lisibles.
    ("limite_imprimee", (
        "date limite de reglement", "date limite de paiement",
        "date d echeance", "date echeance", "a regler avant le",
        "payable avant le", "echeance le",
    )),
)

# Règles d'échéance en vigueur chez Liora. Aucune ne figure sur la facture :
# celle-ci porte « À réception de facture » quel que soit le financement.
#
# Elles se ramènent toutes à une date de départ et un délai, ce qui évite
# d'avoir une règle par type de financement — quinze types, cinq règles.
REGLES = {
    "facture30": {
        "libelle": "date de facture + 30 j",
        "base": "facture", "delai": 30,
        "pour": "BTC-Entreprise, Corporate Alternance",
    },
    "debut-formation": {
        "libelle": "début de formation",
        "base": "debut_formation", "delai": 0,
        "pour": "financement personnel, BTC-Perso, Perso-Alternance",
    },
    "fin-formation-30": {
        "libelle": "fin de formation + 30 j",
        "base": "fin_formation", "delai": 30,
        "pour": "B2B, Alternance, État, OPCO",
    },
    "fin-formation-45": {
        "libelle": "fin de formation + 45 j",
        "base": "fin_formation", "delai": 45,
        "pour": "CPF",
    },
    "fin-formation-60": {
        "libelle": "fin de formation + 60 j",
        "base": "fin_formation", "delai": 60,
        "pour": "Transition pro, Région, AIF, POEI, Agefiph, Interco, DST Allemagne",
    },
}
REGLE_PAR_DEFAUT = "facture30"

# Anciens noms, conservés le temps que les préférences déjà enregistrées
# soient relues au moins une fois.
ANCIENNES_REGLES = {"formation": "debut-formation"}

# Noms lisibles des dates de départ, pour dire d'où vient une échéance.
BASES = {
    "facture": "date de facture",
    "debut_formation": "début de formation",
    "fin_formation": "fin de formation",
}

# Au-delà, l'intitulé et la date n'ont plus de rapport l'un avec l'autre.
PORTEE_INTITULE = 60


# Mots-clés du nom du tableau, du plus précis au plus général. L'ordre compte :
# « 1.3. Entreprise - OPCO » porte les deux mentions, et c'est OPCO qui donne
# la règle. Le choix déduit reste affiché et modifiable — un tableau renommé ne
# doit pas changer les échéances en silence.
DEDUCTION = (
    ("fin-formation-45", ("cpf",)),
    ("fin-formation-60", ("transition", "region", "aif", "poei", "agefiph",
                          "interco", "allemagne", "pole emploi", "complexe")),
    ("fin-formation-30", ("opco", "b2b", "alternance", "etat")),
    ("debut-formation", ("personnel", "perso", "particulier", "b2c")),
    ("facture30", ("entreprise", "corporate", "societe", "adv", "btc")),
)


def regle_deduite(nom_tableau: str, defaut: str = REGLE_PAR_DEFAUT) -> str:
    """Règle d'échéance déduite du nom du tableau, à défaut d'un choix explicite."""
    plat = _aplatir(nom_tableau)
    for cle, mots in DEDUCTION:
        if any(mot in plat for mot in mots):
            return cle
    return defaut


def normaliser_regle(cle: str, defaut: str = REGLE_PAR_DEFAUT) -> str:
    cle = (cle or "").strip()
    cle = ANCIENNES_REGLES.get(cle, cle)
    return cle if cle in REGLES else defaut


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
    """Dates portées par une facture : émission, début de formation, limite.

    Chaque date est cherchée derrière son intitulé, jamais isolément.
    """
    plat = _aplatir(texte)
    # Les positions se correspondent : la mise à plat conserve la longueur
    # d'origine, et les accents sont retirés sans décaler ce qui suit.
    resultat = {champ: "" for champ, _ in INTITULES}

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
                    break
                depart = position + len(intitule)
            if resultat[champ]:
                break

    return resultat


def _ajouter_jours(date: str, jours: int) -> str:
    try:
        lue = datetime.strptime(date, "%d/%m/%Y")
    except ValueError:
        return ""
    return (lue + timedelta(days=jours)).strftime("%d/%m/%Y")


def echeance_selon_regle(
    dates: dict, cle: str = REGLE_PAR_DEFAUT, delai: int | None = None
) -> tuple[str, str]:
    """Échéance calculée selon la règle voulue, et son mode d'obtention.

    Chez Liora l'échéance ne s'imprime jamais sur la facture : elle se compte
    depuis la date de facture, le début ou la fin de la formation, selon le
    financement. La facture porte « À réception de facture » dans tous les cas
    — s'y fier daterait tous les retards du même jour.

    Le mode d'obtention est toujours retourné : une échéance calculée et une
    échéance imprimée n'ont pas le même statut, et le récapitulatif le dit.
    """
    regle = REGLES[normaliser_regle(cle)]
    jours = regle["delai"] if delai is None else delai

    depart = dates.get(regle["base"])
    if depart:
        calculee = _ajouter_jours(depart, jours) if jours else depart
        if calculee:
            libelle = BASES[regle["base"]]
            if jours:
                return calculee, f"{libelle} ({depart}) + {jours} jours"
            return calculee, libelle

    # Replis, dans l'ordre où ils restent défendables. Chacun est nommé : une
    # échéance obtenue autrement que par la règle doit pouvoir être repérée.
    if dates.get("limite_imprimee"):
        return dates["limite_imprimee"], "date limite imprimée sur la facture"

    for base in ("fin_formation", "debut_formation", "facture"):
        if base == regle["base"] or not dates.get(base):
            continue
        calculee = _ajouter_jours(dates[base], jours) if jours else dates[base]
        if calculee:
            return calculee, (
                f"{BASES[regle['base']]} absent — {BASES[base]} "
                f"({dates[base]})" + (f" + {jours} jours" if jours else "")
            )
    return "", "aucune date étiquetée"


def echeance_de_la_facture(
    chemin: Path, cle: str = REGLE_PAR_DEFAUT, delai: int | None = None
) -> tuple[str, str]:
    """(date, origine) calculées à partir d'une facture PDF."""
    texte = texte_du_pdf(chemin)
    if not texte.strip():
        return "", "illisible"
    return echeance_selon_regle(dates_de_facture(texte), cle, delai)
