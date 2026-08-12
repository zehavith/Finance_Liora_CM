"""Lecture du fichier des dossiers et construction des requêtes Gmail."""

from __future__ import annotations

import csv
import re
import unicodedata
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

# Gmail rejette les requêtes trop longues ; on prévient bien avant la limite.
LONGUEUR_MAX_REQUETE = 1800

SEPARATEURS_MULTIVALEUR = re.compile(r"[|,]")

FORMATS_DATE = ("%d/%m/%Y", "%Y-%m-%d", "%d-%m-%Y", "%d/%m/%y")

# Intitulés de colonnes acceptés, après normalisation (minuscules, sans accent,
# ponctuation réduite à des espaces).
#
# L'ordre vaut priorité : le plus spécifique d'abord. Un export Monday réel
# comporte à la fois « Name » (qui contient le numéro de facture) et
# « Nom & Prénom de l'apprenant » ; c'est le second qui doit l'emporter.
#
# Prudence sur les intitulés génériques : « adresse » seul désigne l'adresse
# postale dans les exports de facturation, jamais l'adresse mail. Le rattacher
# à `email` ferait chercher « 9 rue du Grenier-Saint-Lazare » dans Gmail.
ALIAS_COLONNES = {
    "reference": [
        "reference dossier", "ref dossier", "numero de dossier", "numero dossier",
        "n dossier", "reference", "dossier", "ref",
    ],
    "nom": [
        # Le débiteur d'abord : sur un tableau entreprise, c'est la société
        # poursuivie qui doit nommer le répertoire.
        "entreprise", "societe",
        # Puis la personne, nommée explicitement. « Raison sociale » vient
        # après : sur les tableaux de particuliers, cette colonne recopie le
        # nom de l'apprenante quand elle est remplie, et reste vide sinon.
        "nom prenom de l apprenant", "nom prenom de l apprenante",
        "nom prenom apprenant", "nom prenom apprenante",
        "nom et prenom de l apprenant", "nom de l apprenante", "nom de l apprenant",
        "nom apprenante", "nom apprenant", "apprenante", "apprenant", "stagiaire",
        "raison sociale", "raison social",
        "nom prenom", "prenom nom", "nom",
        "name", "item", "element", "titre",
    ],
    "email": [
        "email de l apprenante", "email apprenante", "mail apprenante",
        "adresse mail", "adresse email", "adresse e mail",
        "e mail gcard", "email gcard", "mail gcard",
        "e mail", "email", "mail", "courriel",
        "email 2", "e mail 2", "email 3", "e mail 3", "email 4", "e mail 4",
        "autre email", "email perso", "email contact", "mail contact",
    ],
    "facture": [
        "reference facture", "numero de facture", "numero facture", "n de facture",
        "n facture", "no facture", "num facture", "facture n",
        "facture", "factures", "invoice",
    ],
    "date_debut": ["date de debut", "date debut", "debut", "depuis"],
    "date_fin": ["date de fin", "date fin", "fin", "jusqu a", "jusqua"],
}

# Champs alimentés par plusieurs colonnes à la fois : un dossier peut porter
# une adresse de contact et une adresse de prélèvement distinctes.
CHAMPS_MULTICOLONNES = {"email", "facture"}

# Intitulés qui ne disent rien de leur contenu. Chez Monday, la première
# colonne s'appelle « Name » et porte selon les tableaux le nom du débiteur ou
# le numéro de facture : on tranche sur les valeurs, pas sur l'intitulé.
INTITULES_AMBIGUS = {"name", "item", "element", "titre"}

# « FACT-2405-02142 », « 2024-118 », « INV0093 » : au moins trois chiffres
# d'affilée, et pas une suite de mots comme le serait un nom de personne.
REFERENCE_PROBABLE = re.compile(r"\d{3,}")


def _ressemble_a_une_reference(valeurs: list[str]) -> bool:
    echantillon = [valeur for valeur in valeurs if valeur.strip()][:30]
    if not echantillon:
        return False
    reperes = sum(
        1
        for valeur in echantillon
        if REFERENCE_PROBABLE.search(valeur) and len(valeur.split()) <= 2
    )
    return reperes >= 0.7 * len(echantillon)

# Séparateurs testés lors de la détection de la ligne d'en-tête.
DELIMITEURS = (";", ",", "\t")

# Un export Monday commence par le nom du tableau et une ligne vide avant les
# véritables en-têtes ; on cherche donc l'en-tête un peu plus bas si besoin.
LIGNES_SONDEES = 15


class ErreurDossiers(RuntimeError):
    pass


def _normaliser_entete(nom: str) -> str:
    nom = unicodedata.normalize("NFKD", nom or "")
    nom = nom.encode("ascii", "ignore").decode("ascii").lower().strip()
    return re.sub(r"[^a-z0-9]+", " ", nom).strip()


def _normaliser_date(valeur: str) -> str:
    """Vers le format attendu par Gmail (AAAA/MM/JJ)."""
    valeur = (valeur or "").strip()
    if not valeur:
        return ""
    for format_ in FORMATS_DATE:
        try:
            return datetime.strptime(valeur, format_).strftime("%Y/%m/%d")
        except ValueError:
            continue
    raise ErreurDossiers(
        f"Date incomprise : « {valeur} ». Formats acceptés : JJ/MM/AAAA ou AAAA-MM-JJ."
    )


def _decouper(valeurs: list[str]) -> list[str]:
    """Aplatit plusieurs colonnes et leurs valeurs multiples en une liste.

    Les doublons sont retirés : la même adresse figure souvent à la fois en
    contact et en adresse de prélèvement, et la répéter allongerait la requête
    Gmail sans rien apporter.
    """
    resultat: list[str] = []
    vues: set[str] = set()
    for valeur in valeurs:
        for morceau in SEPARATEURS_MULTIVALEUR.split(valeur or ""):
            morceau = morceau.strip()
            if morceau and morceau.lower() not in vues:
                vues.add(morceau.lower())
                resultat.append(morceau)
    return resultat


@dataclass
class Dossier:
    reference: str
    nom: str
    emails: list[str] = field(default_factory=list)
    factures: list[str] = field(default_factory=list)
    date_debut: str = ""
    date_fin: str = ""
    ligne: int = 0

    @property
    def nom_repertoire(self) -> str:
        from rendu import slug  # noqa: PLC0415 - évite une dépendance circulaire

        morceaux = [slug(self.reference, 20)] if self.reference else []
        morceaux.append(slug(self.nom or (self.emails[0] if self.emails else "dossier"), 40))
        return "_".join(m for m in morceaux if m)

    def requete_gmail(self) -> str:
        """Assemble la requête Gmail : adresse mail (en-têtes ET corps) OU
        numéro de facture (corps ET nom de pièce jointe)."""
        termes: list[str] = []

        for adresse in self.emails:
            termes += [
                f"from:{adresse}",
                f"to:{adresse}",
                f"cc:{adresse}",
                f"bcc:{adresse}",
                f'"{adresse}"',
            ]

        for facture in self.factures:
            termes.append(f'"{facture}"')
            termes.append(f"filename:{facture}")

        if not termes:
            raise ErreurDossiers(
                f"Dossier « {self.reference or self.nom} » (ligne {self.ligne}) : "
                "ni adresse mail ni numéro de facture."
            )

        requete = "(" + " OR ".join(termes) + ")"

        if self.date_debut:
            requete += f" after:{self.date_debut}"
        if self.date_fin:
            requete += f" before:{self.date_fin}"

        return requete

    def criteres_trouves(self, texte_message: str) -> str:
        """Quel critère explique la présence de ce message dans le dossier."""
        trouves = []
        if any(adresse.lower() in texte_message for adresse in self.emails):
            trouves.append("adresse")
        if any(facture.lower() in texte_message for facture in self.factures):
            trouves.append("facture")
        return "+".join(trouves) if trouves else "indirect"


def _candidats(entete: str) -> list[tuple[str, int]]:
    """Champs auxquels un intitulé peut correspondre, avec leur spécificité
    (rang le plus bas = alias le plus précis)."""
    normalise = _normaliser_entete(entete)
    trouves = []
    for champ, alias in ALIAS_COLONNES.items():
        if normalise in alias:
            trouves.append((champ, alias.index(normalise)))
    return trouves


def _associer_colonnes(
    entetes: list[str], echantillons: list[list[str]] | None = None
) -> dict[int, str]:
    """Associe chaque colonne à un champ, index de colonne -> champ.

    Résolution par spécificité : une colonne n'est jamais rattachée à deux
    champs, et un champ à colonne unique retient le meilleur candidat. Les
    champs multicolonnes absorbent toutes les colonnes qui leur restent.

    Les intitulés ambigus sont tranchés sur leurs valeurs : une colonne
    « Name » remplie de « FACT-2405-02142 » est un numéro de facture, la même
    remplie de « Marie Dupont » est un nom.
    """
    propositions = []
    for position, entete in enumerate(entetes):
        candidats = _candidats(entete)

        if _normaliser_entete(entete) in INTITULES_AMBIGUS and echantillons:
            valeurs = echantillons[position] if position < len(echantillons) else []
            if _ressemble_a_une_reference(valeurs):
                # Rang volontairement médiocre : une colonne explicitement
                # nommée « N° Facture » doit garder la priorité.
                candidats = [("facture", 900)]

        propositions += [(rang, position, position, champ) for champ, rang in candidats]

    propositions.sort()

    par_colonne: dict[int, str] = {}
    champs_pris: set[str] = set()

    for _rang, _ordre, position, champ in propositions:
        if position in par_colonne:
            continue
        if champ not in CHAMPS_MULTICOLONNES and champ in champs_pris:
            continue
        par_colonne[position] = champ
        champs_pris.add(champ)

    return par_colonne


def _score_entete(association: dict[int, str]) -> int:
    if not association:
        return 0
    champs = set(association.values())
    score = len(champs)
    # Une ligne dépourvue de critère de recherche n'est pas la ligne d'en-tête.
    if {"email", "facture"} & champs:
        score += 10
    return score


def _trouver_entete(grille: list[tuple[int, list[str]]]) -> tuple[int, dict[int, str]]:
    """Localise la ligne d'en-tête dans les premières lignes du tableau.

    Un export Monday commence par le nom du tableau puis celui du groupe : les
    intitulés de colonnes n'arrivent qu'en troisième ligne.
    """
    meilleur: tuple[int, int, dict[int, str]] | None = None

    for position, (_numero, cellules) in enumerate(grille[:LIGNES_SONDEES]):
        if not any(cellule.strip() for cellule in cellules):
            continue

        # Les lignes suivantes servent d'échantillon pour trancher les
        # intitulés ambigus sur leur contenu.
        suivantes = [rangee for _numero, rangee in grille[position + 1: position + 31]]
        echantillons = [
            [rangee[colonne] for rangee in suivantes if colonne < len(rangee)]
            for colonne in range(len(cellules))
        ]

        association = _associer_colonnes(cellules, echantillons)
        score = _score_entete(association)
        if score > 0 and (meilleur is None or score > meilleur[1]):
            meilleur = (position, score, association)

    if meilleur is None:
        return -1, {}
    return meilleur[0], meilleur[2]


def _liste(numeros: list[int]) -> str:
    return ", ".join(str(numero) for numero in numeros)


def _texte_cellule(valeur) -> str:
    """Rend une cellule Excel sous forme de texte exploitable."""
    if valeur is None:
        return ""
    if isinstance(valeur, datetime):
        return valeur.strftime("%d/%m/%Y")
    if isinstance(valeur, float) and valeur.is_integer():
        return str(int(valeur))
    return str(valeur).strip()


def _grille_xlsx(chemin: Path) -> list[tuple[int, list[str]]]:
    try:
        import openpyxl  # noqa: PLC0415
    except ImportError as exc:
        raise ErreurDossiers(
            "La lecture des fichiers Excel demande openpyxl. Lancez :\n"
            "    pip install -r requirements.txt\n"
            "Vous pouvez sinon enregistrer le tableau au format CSV."
        ) from exc

    try:
        classeur = openpyxl.load_workbook(chemin, data_only=True, read_only=True)
    except Exception as exc:  # noqa: BLE001 - openpyxl lève des types variés
        raise ErreurDossiers(f"Fichier Excel illisible ({chemin}) : {exc}") from exc

    # Un classeur peut comporter plusieurs onglets : on retient celui dont
    # l'en-tête expose le plus de colonnes exploitables.
    meilleure: list[tuple[int, list[str]]] = []
    meilleur_score = -1
    for feuille in classeur.worksheets:
        grille = [
            (numero, [_texte_cellule(cellule) for cellule in rangee])
            for numero, rangee in enumerate(feuille.iter_rows(values_only=True), start=1)
        ]
        _index, association = _trouver_entete(grille)
        score = _score_entete(association)
        if score > meilleur_score:
            meilleur_score, meilleure = score, grille

    classeur.close()
    return meilleure


def _grille_csv(chemin: Path) -> list[tuple[int, list[str]]]:
    texte = chemin.read_text(encoding="utf-8-sig")
    if not texte.strip():
        raise ErreurDossiers(f"Fichier des dossiers vide : {chemin}")

    meilleure: list[tuple[int, list[str]]] = []
    meilleur_score = -1

    for delimiteur in DELIMITEURS:
        try:
            lecteur = csv.reader(texte.splitlines(), delimiter=delimiteur)
            # `line_num` suit les lignes physiques, y compris celles que le
            # lecteur saute : c'est le seul numéro qui renvoie l'utilisateur
            # sur la bonne ligne de son tableur.
            grille = [
                (lecteur.line_num, [cellule.strip() for cellule in rangee])
                for rangee in lecteur
            ]
        except csv.Error:
            continue

        _index, association = _trouver_entete(grille)
        score = _score_entete(association)
        if score > meilleur_score:
            meilleur_score, meilleure = score, grille

    return meilleure


def charger_grille(chemin: Path) -> list[tuple[int, list[str]]]:
    if not chemin.exists():
        raise ErreurDossiers(f"Fichier des dossiers introuvable : {chemin}")
    if chemin.suffix.lower() in {".xlsx", ".xlsm", ".xltx"}:
        return _grille_xlsx(chemin)
    return _grille_csv(chemin)


def lire_dossiers(
    chemin: Path,
    ignorer_lignes_incompletes: bool = False,
    signaler: Callable[[str], None] | None = None,
) -> list[Dossier]:
    grille = charger_grille(chemin)
    if not grille:
        raise ErreurDossiers(f"Fichier des dossiers vide : {chemin}")

    index_entete, association = _trouver_entete(grille)

    if not ({"email", "facture"} & set(association.values())):
        apercu = ", ".join(grille[max(index_entete, 0)][1][:12])
        raise ErreurDossiers(
            f"{chemin} : il faut au minimum une colonne « email » ou « facture ».\n"
            f"Ligne d'en-tête lue : {apercu[:200]}\n"
            "Renommez la colonne concernée en « email » ou « facture »."
        )

    if signaler:
        colonnes = grille[index_entete][1]
        detail = ", ".join(
            f"« {colonnes[position]} » → {champ}"
            for position, champ in sorted(association.items())
        )
        signaler(f"Colonnes reconnues : {detail}")

    dossiers: list[Dossier] = []
    ignorees: list[int] = []
    hors_sujet: list[int] = []
    references_vues: set[str] = set()

    for numero, cellules in grille[index_entete + 1:]:
        valeurs: dict[str, list[str]] = {champ: [] for champ in ALIAS_COLONNES}
        # Parcours par position : les valeurs suivent l'ordre des colonnes du
        # tableau, et non l'ordre de résolution des intitulés.
        for position, champ in sorted(association.items()):
            if position < len(cellules) and cellules[position].strip():
                valeurs[champ].append(cellules[position].strip())

        if not any(valeurs.values()):
            # Aucune colonne exploitable. Si d'autres cellules sont remplies,
            # c'est une ligne de total ou de séparation de groupe ajoutée par
            # Monday : on la signale au lieu de l'escamoter.
            if any(cellule.strip() for cellule in cellules):
                hors_sujet.append(numero)
            continue

        def _premier(champ: str) -> str:
            return valeurs[champ][0] if valeurs[champ] else ""

        dossier = Dossier(
            reference=_premier("reference"),
            nom=_premier("nom"),
            emails=_decouper(valeurs["email"]),
            factures=_decouper(valeurs["facture"]),
            date_debut=_normaliser_date(_premier("date_debut")),
            date_fin=_normaliser_date(_premier("date_fin")),
            ligne=numero,
        )

        if not dossier.emails and not dossier.factures:
            # Ligne de groupe ou de sous-total d'un export Monday, ou vraie
            # ligne incomplète : par défaut on s'arrête plutôt que de produire
            # un dossier manquant qui passerait inaperçu.
            if ignorer_lignes_incompletes:
                ignorees.append(numero)
                continue
            raise ErreurDossiers(
                f"{chemin}, ligne {numero} : ni adresse mail ni numéro de facture "
                f"(contenu : « {(dossier.reference or dossier.nom)[:60]} »).\n"
                "Corrigez la ligne, ou relancez avec --ignorer-lignes-incompletes "
                "pour passer ce type de ligne."
            )

        if not dossier.reference:
            # À défaut de colonne dédiée, le numéro de facture est l'identifiant
            # naturel d'un dossier de recouvrement, et donne des répertoires
            # bien plus parlants qu'un D001.
            dossier.reference = (
                dossier.factures[0] if dossier.factures else f"D{len(dossiers) + 1:03d}"
            )

        # Deux dossiers de même référence écriraient dans le même répertoire.
        if dossier.nom_repertoire in references_vues:
            dossier.reference = f"{dossier.reference}-{numero}"
        references_vues.add(dossier.nom_repertoire)

        requete = dossier.requete_gmail()
        if len(requete) > LONGUEUR_MAX_REQUETE:
            raise ErreurDossiers(
                f"{chemin}, ligne {numero} : requête trop longue "
                f"({len(requete)} caractères). Répartissez les adresses ou "
                "numéros de facture sur plusieurs lignes."
            )

        dossiers.append(dossier)

    # Jamais silencieux : les lignes écartées sont nommées une par une.
    if hors_sujet and signaler:
        signaler(
            f"{len(hors_sujet)} ligne(s) sans aucune colonne exploitable écartée(s) "
            f"— lignes de total ou de groupe : {_liste(hors_sujet)}"
        )
    if ignorees and signaler:
        signaler(
            f"⚠ {len(ignorees)} ligne(s) sans adresse ni facture ignorée(s) : "
            f"ligne(s) {_liste(ignorees)}"
        )

    if not dossiers:
        raise ErreurDossiers(f"Aucun dossier exploitable dans {chemin}")

    return dossiers
