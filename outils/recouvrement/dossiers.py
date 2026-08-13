"""Lecture du fichier des dossiers et construction des requêtes Gmail."""

from __future__ import annotations

import csv
import re
import unicodedata
from collections.abc import Callable
from dataclasses import dataclass, field, replace
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

    # Colonnes de contexte : elles n'entrent jamais dans la recherche Gmail,
    # elles alimentent la note de synthèse. Les intitulés diffèrent d'un
    # tableau à l'autre — « Total TTC » côté entreprise, « Total Facture »
    # côté particuliers — d'où ces listes un peu longues.
    "montant_du": [
        "reste a devoir ttc", "reste a payer d apres le grand livre",
        "reste a payer", "restant a payer", "reste du", "solde du", "montant du",
    ],
    "montant_total": [
        "total ttc", "total facture", "montant total", "montant facture",
        "total ht", "montant",
    ],
    "date_echeance": [
        "date d echeance facture", "date echeance facture",
        "date echeance calculee negociee", "date echeance", "echeance",
    ],
    "formation_debut": ["debut de formation", "debut de service", "date de debut de formation"],
    "formation_fin": ["fin de formation", "fin de service", "date de fin de formation"],
    "statut": [
        "statut creance", "statut paiement", "categorie de retard",
        "qualification recouvrement", "qualification generale", "statut initiale",
        "categorie de dette", "statut",
    ],
    "commentaire": [
        "commentaire recouvrement", "commentaire general", "commentaire post echeance",
        "commentaire pre echance", "commentaire pre echeance", "commentaire",
    ],
    # Documents stockés dans Monday plutôt que joints aux messages : on n'en
    # retient que l'adresse, pour la citer dans la note. Les télécharger
    # supposerait une authentification Monday, et un document tiré du tableau
    # ne prouve de toute façon pas qu'il a été transmis au débiteur.
    # Uniquement des intitulés sans ambiguïté : « facture » ou « document »
    # tout court désignent ailleurs le numéro de facture, et les rattacher ici
    # ferait perdre le critère de recherche le plus important.
    "liens": [
        "facture pdf", "lien facture", "fichier facture",
        "convention de formation", "convention signee", "convention",
        "contrat de formation", "contrat signe", "contrat",
    ],
}

# Champs alimentés par plusieurs colonnes à la fois : un dossier peut porter
# une adresse de contact et une adresse de prélèvement distinctes.
CHAMPS_MULTICOLONNES = {"email", "facture", "statut", "commentaire", "liens"}

# Intitulés qui ne disent rien de leur contenu. Chez Monday, la première
# colonne s'appelle « Name » et porte selon les tableaux le nom du débiteur ou
# le numéro de facture : on tranche sur les valeurs, pas sur l'intitulé.
INTITULES_AMBIGUS = {"name", "item", "element", "titre"}

# « FACT-2405-02142 », « 2024-118 », « INV0093 » : au moins trois chiffres
# d'affilée, et pas une suite de mots comme le serait un nom de personne.
REFERENCE_PROBABLE = re.compile(r"\d{3,}")

_MOTIFS_REFERENCE: dict[str, re.Pattern] = {}


def _motif_reference(valeur: str) -> re.Pattern:
    """Motif de reconnaissance d'un numéro de facture dans un texte.

    Bornes volontaires : sans elles, une facture « 118 » serait « reconnue »
    dans « 1180 », dans un numéro de téléphone ou dans le montant d'une autre
    facture, et les échanges finiraient rangés sous la mauvaise.
    """
    motif = _MOTIFS_REFERENCE.get(valeur)
    if motif is None:
        motif = re.compile(
            rf"(?<![0-9a-z]){re.escape(valeur.strip().lower())}(?![0-9a-z])"
        )
        _MOTIFS_REFERENCE[valeur] = motif
    return motif


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

    # Contexte repris du tableau de suivi, pour la note de synthèse. Ces
    # valeurs n'interviennent jamais dans la recherche des messages.
    montant_du: str = ""
    montant_total: str = ""
    date_echeance: str = ""
    formation_debut: str = ""
    formation_fin: str = ""
    statut: str = ""
    commentaire: str = ""
    liens: list[str] = field(default_factory=list)

    # Lignes d'origine du tableau, quand plusieurs factures d'un même débiteur
    # ont été réunies. Chacune garde son montant, son échéance et ses propres
    # documents : c'est ce qui permet de produire un sous-dossier par facture.
    composants: list["Dossier"] = field(default_factory=list)

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

    def requete_adresse(self, adresse: str) -> str:
        """Requête limitée à une seule adresse, bornée comme le dossier.

        Sert à sonder puis à verser au dossier les échanges d'une adresse
        découverte à partir du numéro de facture.
        """
        termes = [
            f"from:{adresse}", f"to:{adresse}", f"cc:{adresse}",
            f"bcc:{adresse}", f'"{adresse}"',
        ]
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

    def factures_citees(self, texte_message: str) -> list[str]:
        """Numéros de facture réellement nommés dans le message.

        Sert à ranger l'échange sous la facture qu'il concerne. Un message qui
        n'en cite aucune — une relance qui ne nomme rien, une réponse de
        l'apprenante — concerne le débiteur en général, et vaut donc pour
        toutes ses factures.
        """
        return [
            facture
            for facture in self.factures
            if _motif_reference(facture).search(texte_message)
        ]

    def repartition_par_facture(self) -> list["Dossier"]:
        """Sous-dossiers à produire, un par facture en retard.

        Vide quand le débiteur ne porte qu'une facture : découper un dossier
        en un seul sous-dossier n'ajouterait qu'un niveau de répertoire.
        """
        if len(self.factures) < 2:
            return []

        if self.composants:
            # Une ligne du tableau par facture : chaque sous-dossier conserve
            # le montant, l'échéance et les documents de sa propre ligne.
            retenus = [
                composant for composant in self.composants if composant.factures
            ]
            if retenus:
                return retenus

        # Plusieurs numéros portés par une seule ligne : le montant du tableau
        # vaut pour l'ensemble, on ne peut pas le répartir. Il est donc laissé
        # à la ligne d'origine et retiré des sous-dossiers, pour ne pas laisser
        # croire que chaque facture porte la totalité de la dette.
        return [
            replace(
                self,
                factures=[facture],
                emails=list(self.emails),
                liens=list(self.liens),
                composants=[],
                montant_du="",
                montant_total="",
            )
            for facture in self.factures
        ]

    def adresses_citees(self, entetes: str) -> list[str]:
        """Adresses du dossier qui figurent parmi les parties du message.

        Sur les en-têtes seuls — expéditeur, destinataires, copies — et non
        sur le corps : une adresse recopiée dans une citation ne fait pas de
        son titulaire une partie à l'échange.
        """
        plat = (entetes or "").lower()
        return [adresse for adresse in self.emails if adresse.lower() in plat]

    def repartition_par_adresse(self) -> list["Dossier"]:
        """Sous-dossiers à produire, un par adresse mail utilisée."""
        if len(self.emails) < 2:
            return []

        # Les montants restent ceux du débiteur : contrairement aux factures,
        # une adresse ne porte pas une part de la dette, c'est la même dette
        # vue par un autre canal d'échange.
        return [
            replace(
                self,
                emails=[adresse],
                factures=list(self.factures),
                liens=list(self.liens),
                composants=[],
            )
            for adresse in self.emails
        ]


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


def _fusionner(groupe: list[Dossier]) -> Dossier:
    """Réunit en un seul dossier plusieurs factures d'un même débiteur."""
    tries = sorted(groupe, key=lambda dossier: dossier.reference)
    principal = tries[0]

    def _union(extraire) -> list[str]:
        resultat, vues = [], set()
        for dossier in tries:
            for valeur in extraire(dossier):
                if valeur and valeur.lower() not in vues:
                    vues.add(valeur.lower())
                    resultat.append(valeur)
        return resultat

    def _cumul(champ: str) -> str:
        total = sum(_montant(getattr(dossier, champ)) for dossier in tries)
        return f"{total:.2f}".rstrip("0").rstrip(".") if total else ""

    def _extremum(champ: str, prendre_min: bool) -> str:
        valeurs = [getattr(dossier, champ) for dossier in tries if getattr(dossier, champ)]
        if not valeurs:
            return ""
        dates = [(_date_comparable(valeur), valeur) for valeur in valeurs]
        dates.sort(key=lambda paire: (paire[0] is None, paire[0]))
        return dates[0][1] if prendre_min else dates[-1][1]

    return Dossier(
        reference=principal.reference,
        nom=principal.nom or next((d.nom for d in tries if d.nom), ""),
        emails=_union(lambda d: d.emails),
        factures=_union(lambda d: d.factures),
        date_debut=min((d.date_debut for d in tries if d.date_debut), default=""),
        date_fin=max((d.date_fin for d in tries if d.date_fin), default=""),
        ligne=principal.ligne,
        # Les montants s'additionnent : c'est la dette totale du débiteur qui
        # part au contentieux, pas celle d'une facture prise isolément.
        montant_du=_cumul("montant_du"),
        montant_total=_cumul("montant_total"),
        # La plus ancienne échéance : c'est elle qui datera le retard.
        date_echeance=_extremum("date_echeance", prendre_min=True),
        formation_debut=_extremum("formation_debut", prendre_min=True),
        formation_fin=_extremum("formation_fin", prendre_min=False),
        statut=" · ".join(_union(lambda d: d.statut.split(" · "))),
        commentaire=" · ".join(_union(lambda d: d.commentaire.split(" · "))),
        liens=_union(lambda d: d.liens),
        # Les lignes d'origine sont conservées : le dossier du débiteur mène
        # ensuite à un sous-dossier par facture, chacun avec son propre montant.
        composants=tries,
    )


def _montant(valeur: str) -> float:
    texte = str(valeur or "").strip().replace("€", "").replace(" ", "").replace(",", ".")
    try:
        return float(texte)
    except ValueError:
        return 0.0


def _date_comparable(valeur: str):
    for format_ in FORMATS_DATE + ("%Y/%m/%d",):
        try:
            return datetime.strptime(valeur.strip()[:10], format_)
        except ValueError:
            continue
    return None


def regrouper_par_debiteur(
    dossiers: list[Dossier], signaler: Callable[[str], None] | None = None
) -> list[Dossier]:
    """Réunit les dossiers qui partagent une adresse mail.

    Un même débiteur porte souvent plusieurs factures. Traités séparément, ils
    produisent autant de répertoires au contenu identique — la recherche se
    faisant sur l'adresse, elle ramène les mêmes messages à chaque fois. Les
    regrouper donne un dossier unique, avec toutes les factures et la dette
    cumulée.

    Le regroupement se fait sur l'adresse, jamais sur le nom : deux
    homonymes sont deux débiteurs, alors qu'une adresse partagée désigne bien
    la même personne.
    """
    groupe_de: dict[str, int] = {}
    groupes: list[list[Dossier]] = []

    for dossier in dossiers:
        indices = {
            groupe_de[adresse.lower()]
            for adresse in dossier.emails
            if adresse.lower() in groupe_de
        }

        if not indices:
            groupes.append([dossier])
            cible = len(groupes) - 1
        else:
            cible = min(indices)
            groupes[cible].append(dossier)
            for autre in indices - {cible}:
                groupes[cible].extend(groupes[autre])
                groupes[autre] = []

        for adresse in dossier.emails:
            groupe_de[adresse.lower()] = cible
        for adresse, indice in groupe_de.items():
            if indice in indices:
                groupe_de[adresse] = cible

    resultat: list[Dossier] = []
    fusions: list[str] = []

    for groupe in groupes:
        if not groupe:
            continue
        if len(groupe) == 1:
            resultat.append(groupe[0])
            continue
        fusionne = _fusionner(groupe)
        resultat.append(fusionne)
        fusions.append(
            f"{fusionne.nom or fusionne.reference} : "
            f"{len(groupe)} factures réunies "
            f"({', '.join(sorted(d.reference for d in groupe))})"
        )

    if fusions and signaler:
        signaler(
            f"{len(fusions)} débiteur(s) portant plusieurs factures ont été "
            f"regroupés en un dossier unique :"
        )
        for ligne in fusions:
            signaler(f"    {ligne}")

    return resultat


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

        # Une ligne n'est un dossier que si elle désigne quelqu'un : sans
        # critère de recherche NI identité, c'est une ligne de total ou de
        # séparation de groupe — les totaux de Monday remplissent les colonnes
        # de montants et de dates, ce qui ne suffit pas à en faire un dossier.
        a_critere = bool(valeurs["email"] or valeurs["facture"])
        a_identite = bool(valeurs["reference"] or valeurs["nom"])

        if not a_critere and not a_identite:
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
            montant_du=_premier("montant_du"),
            montant_total=_premier("montant_total"),
            date_echeance=_premier("date_echeance"),
            formation_debut=_premier("formation_debut"),
            formation_fin=_premier("formation_fin"),
            statut=" · ".join(valeurs["statut"]),
            commentaire=" · ".join(valeurs["commentaire"]),
            liens=[v for v in valeurs["liens"] if v.lower().startswith("http")],
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
