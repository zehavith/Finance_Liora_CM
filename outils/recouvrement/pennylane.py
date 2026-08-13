"""Lecture d'un export Pennylane des comptes clients : qui a payé quoi.

Le tableau Monday dit ce qu'il **reste à devoir** ; la comptabilité dit ce qui
a été **réellement encaissé**, facture par facture, avec la date de chaque
règlement. Pour un dossier contentieux, la seconde est la pièce qui compte :
c'est elle qui établit le montant réclamé et qui date le premier impayé.

L'export attendu est le grand livre auxiliaire des comptes 411 (Pennylane :
Révision → Grand livre, filtré sur les comptes clients), ou tout export de
factures et règlements comportant un montant par ligne. Les intitulés de
colonnes varient d'un export à l'autre : ils sont reconnus automatiquement, et
la correspondance retenue est affichée à l'écran plutôt que devinée en silence.

Aucune connexion n'est ouverte : le fichier est lu sur le poste, comme le reste
de l'outil.
"""

from __future__ import annotations

import html
import re
import unicodedata
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

from dossiers import charger_grille

# Intitulés acceptés, après normalisation (minuscules, sans accent, ponctuation
# réduite à des espaces). L'ordre à l'intérieur d'une liste vaut priorité.
#
# L'ordre des champs compte lui aussi : le plus spécifique retient sa colonne
# en premier, sans quoi « date d'échéance » serait happée par « date ».
ALIAS_COLONNES = {
    "echeance": [
        "date d echeance", "date echeance", "echeance", "date limite de paiement",
    ],
    "compte": [
        "numero de compte auxiliaire", "compte auxiliaire", "code auxiliaire",
        "numero de compte", "n de compte", "n compte", "no compte",
        "compte client", "code client", "numero client", "auxiliaire", "compte",
    ],
    "nom": [
        "libelle du compte", "intitule du compte", "nom du compte",
        "nom prenom de l apprenant", "nom et prenom de l apprenant",
        "nom de l apprenant", "nom de l apprenante", "apprenant", "apprenante",
        "nom du client", "raison sociale", "client", "tiers", "nom",
    ],
    "prenom": ["prenom de l apprenant", "prenom"],
    "piece": [
        "numero de facture", "n de facture", "n facture", "numero facture",
        "numero de piece", "n piece", "numero de document", "numero de la piece",
        "reference facture", "piece", "facture", "reference", "document",
    ],
    "date": [
        "date de facture", "date facture", "date d ecriture", "date ecriture",
        "date de la piece", "date piece", "date d operation", "date operation",
        "date comptable", "date",
    ],
    "libelle": [
        "libelle de l ecriture", "libelle ecriture", "libelle",
        "designation", "description", "objet", "intitule",
    ],
    "debit": ["montant debit", "total debit", "debit"],
    "credit": ["montant credit", "total credit", "montant regle", "debit credit", "credit"],
    "montant": [
        "montant ttc", "montant total", "total ttc", "montant de l ecriture", "montant",
    ],
    "lettrage": ["code lettrage", "lettrage", "rapprochement", "lettre"],
    "journal": ["code journal", "journal"],
}

# Intitulés qui ressemblent à un compte client sans en être un. Le compte
# **général** vaut 411000 pour tout le monde : le retenir réunirait tous les
# apprenants sur un seul et même compte, et le relevé n'aurait plus aucun sens.
INTITULES_ECARTES = {
    "compte general", "compte collectif", "compte centralisateur",
    "numero de compte general", "compte de contrepartie", "contrepartie",
}

FORMATS_DATE = ("%d/%m/%Y", "%Y-%m-%d", "%d-%m-%Y", "%d/%m/%y", "%Y/%m/%d")

# Un écart de quelques centimes vient des arrondis de TVA, pas d'un impayé.
TOLERANCE = 0.01


class ErreurPennylane(RuntimeError):
    pass


# --------------------------------------------------------------------------
# Lecture des valeurs
# --------------------------------------------------------------------------


def normaliser(texte: str) -> str:
    texte = unicodedata.normalize("NFKD", str(texte or ""))
    texte = texte.encode("ascii", "ignore").decode("ascii").lower()
    return re.sub(r"[^a-z0-9]+", " ", texte).strip()


def identifiant(texte: str) -> str:
    """Forme comparable d'un numéro de compte ou de facture.

    « FA-2026-0101 », « fa 2026 0101 » et « FA20260101 » désignent la même
    facture : la ponctuation d'un numéro varie d'un export à l'autre, et
    l'apprenante ne la recopie pas toujours à l'identique.
    """
    return normaliser(texte).replace(" ", "")


def montant(valeur) -> float:
    """Lit un montant tel qu'il sort d'un export comptable.

    Trois écritures cohabitent dans les exports réels : « 1 234,56 » (français),
    « 1,234.56 » (anglais) et « (1 234,56) » ou « 1 234,56- » pour les négatifs.
    Le séparateur décimal est le dernier des deux rencontrés — c'est le seul
    critère qui tranche sans se tromper entre les deux conventions.
    """
    if isinstance(valeur, (int, float)):
        return float(valeur)

    texte = str(valeur or "").strip()
    if not texte:
        return 0.0

    negatif = False
    if texte.startswith("(") and texte.endswith(")"):
        negatif, texte = True, texte[1:-1]

    texte = re.sub(r"[\s  ]", "", texte).replace("€", "").replace("EUR", "")
    if texte.endswith("-"):
        negatif, texte = True, texte[:-1]
    if texte.startswith("-"):
        negatif, texte = True, texte[1:]
    if not any(caractere.isdigit() for caractere in texte):
        return 0.0

    virgule, point = texte.rfind(","), texte.rfind(".")
    if virgule > -1 and point > -1:
        texte = texte.replace(".", "").replace(",", ".") if virgule > point \
            else texte.replace(",", "")
    elif virgule > -1:
        # « 1,234 » : séparateur de milliers si trois chiffres suivent et qu'un
        # groupe précède, décimale sinon.
        texte = texte.replace(",", "") if re.fullmatch(r"\d{1,3}(,\d{3})+", texte) \
            else texte.replace(",", ".")

    texte = re.sub(r"[^0-9.]", "", texte)
    try:
        resultat = float(texte)
    except ValueError:
        return 0.0
    return -resultat if negatif else resultat


def date_valeur(valeur) -> datetime | None:
    """Date d'une cellule, qu'elle soit déjà une date ou du texte."""
    if isinstance(valeur, datetime):
        return valeur
    texte = str(valeur or "").strip()
    if not texte:
        return None
    for format_ in FORMATS_DATE:
        try:
            return datetime.strptime(texte[:10], format_)
        except ValueError:
            continue
    return None


def _date_lisible(valeur: datetime | None) -> str:
    return valeur.strftime("%d/%m/%Y") if valeur else "—"


def euros(valeur: float) -> str:
    """« 1 234,56 € », avec l'espace insécable attendu en français."""
    return f"{valeur:,.2f}".replace(",", " ").replace(".", ",").replace(" ", " ") + " €"


# --------------------------------------------------------------------------
# Reconnaissance des colonnes
# --------------------------------------------------------------------------


def associer_colonnes(entetes: list[str]) -> dict[str, int]:
    """Associe chaque champ à une colonne, champ -> index de colonne.

    Résolution par spécificité : une colonne ne sert qu'à un champ, et un
    champ retient son alias le plus précis. Les intitulés écartés ne sont
    jamais retenus, quel que soit le champ.
    """
    normalises = [normaliser(entete) for entete in entetes]

    propositions: list[tuple[int, int, int, str]] = []
    for position, entete in enumerate(normalises):
        if not entete or entete in INTITULES_ECARTES:
            continue
        for ordre_champ, (champ, alias) in enumerate(ALIAS_COLONNES.items()):
            if entete in alias:
                propositions.append((alias.index(entete), ordre_champ, position, champ))

    propositions.sort()

    par_champ: dict[str, int] = {}
    colonnes_prises: set[int] = set()
    for _rang, _ordre, position, champ in propositions:
        if champ in par_champ or position in colonnes_prises:
            continue
        par_champ[champ] = position
        colonnes_prises.add(position)
    return par_champ


def _score(association: dict[str, int]) -> int:
    """Qualité d'une ligne d'en-tête : sans montant, ce n'en est pas une."""
    if not association:
        return 0
    score = len(association)
    if {"debit", "credit"} <= association.keys():
        score += 10
    elif "montant" in association:
        score += 6
    if {"compte", "nom"} & association.keys():
        score += 4
    return score


def _trouver_entete(grille: list[tuple[int, list[str]]]) -> tuple[int, dict[str, int]]:
    """Localise la ligne d'en-tête : un export Pennylane commence par un titre
    et la période, les intitulés n'arrivent qu'ensuite."""
    meilleur: tuple[int, int, dict[str, int]] | None = None
    for position, (_numero, cellules) in enumerate(grille[:20]):
        if not any(str(cellule).strip() for cellule in cellules):
            continue
        association = associer_colonnes([str(cellule) for cellule in cellules])
        score = _score(association)
        if score > 0 and (meilleur is None or score > meilleur[1]):
            meilleur = (position, score, association)
    return (meilleur[0], meilleur[2]) if meilleur else (-1, {})


def _score_feuille(grille: list[tuple[int, list[str]]]) -> int:
    return _score(_trouver_entete(grille)[1])


# --------------------------------------------------------------------------
# Écritures, factures, comptes
# --------------------------------------------------------------------------


@dataclass
class Ecriture:
    date: datetime | None
    echeance: datetime | None
    piece: str
    libelle: str
    lettrage: str
    journal: str
    debit: float
    credit: float


@dataclass
class Facture:
    """Une écriture de débit, et ce qui a été affecté dessus."""

    ecriture: Ecriture
    regle: float = 0.0

    @property
    def numero(self) -> str:
        return self.ecriture.piece

    @property
    def total(self) -> float:
        return self.ecriture.debit

    @property
    def reste(self) -> float:
        return round(self.total - self.regle, 2)

    @property
    def statut(self) -> str:
        if self.reste <= TOLERANCE:
            return "Payée"
        return "Partielle" if self.regle > TOLERANCE else "Impayée"

    def retard(self, reference: datetime) -> int:
        """Jours écoulés depuis l'échéance, si elle est dépassée et impayée."""
        echeance = self.ecriture.echeance
        if not echeance or self.reste <= TOLERANCE or echeance >= reference:
            return 0
        return (reference - echeance).days


@dataclass
class CompteClient:
    numero: str
    nom: str
    ecritures: list[Ecriture] = field(default_factory=list)
    factures: list[Facture] = field(default_factory=list)
    reglements: list[Ecriture] = field(default_factory=list)

    @property
    def libelle(self) -> str:
        return self.nom or self.numero or "(compte sans nom)"

    @property
    def total_facture(self) -> float:
        return round(sum(ecriture.debit for ecriture in self.ecritures), 2)

    @property
    def total_regle(self) -> float:
        return round(sum(ecriture.credit for ecriture in self.ecritures), 2)

    @property
    def solde(self) -> float:
        return round(self.total_facture - self.total_regle, 2)

    def impaye_echu(self, reference: datetime) -> float:
        return round(
            sum(f.reste for f in self.factures if f.retard(reference) > 0), 2
        )

    def numeros_de_facture(self) -> list[str]:
        return [f.numero for f in self.factures if f.numero]

    def resume(self, reference: datetime | None = None) -> dict:
        """Forme transmise à l'interface. Les montants restent numériques :
        c'est la page qui les met en forme, avec la même fonction partout."""
        reference = reference or datetime.now()
        return {
            "numero": self.numero,
            "nom": self.nom,
            "libelle": self.libelle,
            "total_facture": self.total_facture,
            "total_regle": self.total_regle,
            "solde": self.solde,
            "impaye_echu": self.impaye_echu(reference),
            "nb_factures": len(self.factures),
            "nb_impayees": sum(1 for f in self.factures if f.reste > TOLERANCE),
            "factures": [
                {
                    "numero": f.numero,
                    "date": _date_lisible(f.ecriture.date),
                    "echeance": _date_lisible(f.ecriture.echeance),
                    "libelle": f.ecriture.libelle,
                    "total": f.total,
                    "regle": f.regle,
                    "reste": f.reste,
                    "statut": f.statut,
                    "retard": f.retard(reference),
                }
                for f in self.factures
            ],
            "reglements": [
                {
                    "date": _date_lisible(ecriture.date),
                    "piece": ecriture.piece,
                    "libelle": ecriture.libelle,
                    "journal": ecriture.journal,
                    "montant": ecriture.credit,
                }
                for ecriture in self.reglements
            ],
        }


def _affecter(factures: list[Facture], reglements: list[Ecriture]) -> None:
    """Rattache les règlements aux factures.

    Par le **lettrage** quand il figure dans l'export : c'est l'affectation
    retenue par la comptabilité, la seule qui fasse foi. À défaut, les factures
    les plus anciennes sont soldées en premier — l'imputation par défaut du
    droit des obligations, et celle que retient un juge à défaut de mention
    contraire. La note de relevé énonce la règle appliquée, pour qu'un montant
    puisse toujours être refait à la main.
    """

    def consommer(cibles: list[Facture], disponible: float) -> float:
        for facture in cibles:
            if disponible <= TOLERANCE:
                break
            manquant = facture.reste
            if manquant <= TOLERANCE:
                continue
            verse = min(manquant, disponible)
            facture.regle = round(facture.regle + verse, 2)
            disponible = round(disponible - verse, 2)
        return disponible

    groupes: dict[str, list[Ecriture]] = {}
    for ecriture in reglements:
        code = identifiant(ecriture.lettrage)
        if code:
            groupes.setdefault(code, []).append(ecriture)

    lettres: set[int] = set()
    for code, verses in groupes.items():
        cibles = [f for f in factures if identifiant(f.ecriture.lettrage) == code]
        if not cibles:
            # Un lettrage sans facture en face dans l'export : le règlement
            # reste à affecter avec les autres plutôt que d'être perdu.
            continue
        lettres.update(id(ecriture) for ecriture in verses)
        consommer(cibles, round(sum(ecriture.credit for ecriture in verses), 2))

    reste = round(
        sum(e.credit for e in reglements if id(e) not in lettres), 2
    )
    consommer(factures, reste)


@dataclass
class Comptes:
    """L'ensemble des comptes clients lus dans un export."""

    comptes: list[CompteClient] = field(default_factory=list)
    fichier: str = ""
    colonnes: str = ""
    nb_lignes: int = 0
    lu_le: str = ""

    def chercher(self, requete: str, limite: int = 40) -> list[CompteClient]:
        """Recherche par nom et prénom, numéro de compte ou numéro de facture.

        Les mots du nom sont comparés sans ordre imposé : le tableau écrit
        « DUPONT Marie », l'apprenante signe « Marie Dupont », et la personne
        qui cherche tape l'un ou l'autre.
        """
        texte = normaliser(requete)
        if not texte:
            return []
        recherche = identifiant(requete)
        mots = texte.split()

        trouves: list[tuple[int, float, CompteClient]] = []
        for compte in self.comptes:
            note = 0
            numero = identifiant(compte.numero)
            if recherche and numero:
                if numero == recherche:
                    note = max(note, 100)
                elif len(recherche) >= 3 and recherche in numero:
                    note = max(note, 70)

            if len(recherche) >= 3:
                for facture in compte.numeros_de_facture():
                    reference = identifiant(facture)
                    if reference == recherche:
                        note = max(note, 95)
                        break
                    if recherche in reference:
                        note = max(note, 65)

            mots_du_nom = normaliser(compte.libelle).split()
            if mots and all(
                any(mot_nom.startswith(mot) for mot_nom in mots_du_nom) for mot in mots
            ):
                note = max(note, 90 if normaliser(compte.libelle).startswith(texte) else 80)
            elif len(texte) >= 3 and texte in normaliser(compte.libelle):
                note = max(note, 60)

            if note:
                trouves.append((note, abs(compte.solde), compte))

        trouves.sort(key=lambda element: (-element[0], -element[1]))
        return [compte for _note, _solde, compte in trouves[:limite]]

    def par_numero(self, numero: str) -> CompteClient | None:
        recherche = identifiant(numero)
        for compte in self.comptes:
            if identifiant(compte.numero) == recherche and recherche:
                return compte
            if identifiant(compte.libelle) == recherche:
                return compte
        return None

    def par_facture(self, facture: str) -> CompteClient | None:
        recherche = identifiant(facture)
        if not recherche:
            return None
        for compte in self.comptes:
            if any(identifiant(numero) == recherche for numero in compte.numeros_de_facture()):
                return compte
        return None

    def resume(self) -> dict:
        return {
            "fichier": self.fichier,
            "colonnes": self.colonnes,
            "nb_comptes": len(self.comptes),
            "nb_lignes": self.nb_lignes,
            "lu_le": self.lu_le,
            "solde_total": round(sum(compte.solde for compte in self.comptes), 2),
        }


def lire_comptes(chemin: Path, inverser_sens: bool = False) -> Comptes:
    """Lit un export Pennylane et reconstitue le compte de chaque apprenant."""
    if not chemin.exists():
        raise ErreurPennylane(f"Export Pennylane introuvable : {chemin}")

    grille = charger_grille(chemin, score_feuille=_score_feuille)
    if not grille:
        raise ErreurPennylane(f"Export Pennylane vide : {chemin}")

    index_entete, association = _trouver_entete(grille)
    if index_entete < 0 or not association:
        raise ErreurPennylane(
            f"{chemin.name} : aucune ligne d'en-tête reconnue.\n"
            "Attendu un export comportant au minimum une colonne de montant "
            "(« Débit » et « Crédit », ou « Montant ») et une colonne de compte "
            "ou de nom de client."
        )

    if not ({"debit", "credit"} & association.keys() or "montant" in association):
        raise ErreurPennylane(
            f"{chemin.name} : aucune colonne de montant reconnue "
            "(« Débit » / « Crédit », ou « Montant »)."
        )
    if not ({"compte", "nom"} & association.keys()):
        raise ErreurPennylane(
            f"{chemin.name} : ni numéro de compte ni nom de client reconnus. "
            "Un relevé ne peut pas être rattaché à un apprenant sans l'un des deux."
        )

    entetes = grille[index_entete][1]
    colonnes = ", ".join(
        f"« {entetes[position]} » → {champ}"
        for champ, position in sorted(association.items(), key=lambda paire: paire[1])
    )

    par_compte: dict[str, CompteClient] = {}
    nb_lignes = 0

    for _numero, cellules in grille[index_entete + 1:]:
        def valeur(champ: str):
            position = association.get(champ)
            if position is None or position >= len(cellules):
                return ""
            return cellules[position]

        compte_brut = str(valeur("compte") or "").strip()
        nom = str(valeur("nom") or "").strip()
        prenom = str(valeur("prenom") or "").strip()
        if prenom:
            nom = f"{nom} {prenom}".strip()

        if {"debit", "credit"} & association.keys():
            debit = abs(montant(valeur("debit")))
            credit = abs(montant(valeur("credit")))
        else:
            valeur_signee = montant(valeur("montant"))
            debit = max(valeur_signee, 0.0)
            credit = max(-valeur_signee, 0.0)

        if inverser_sens:
            debit, credit = credit, debit
        if debit <= TOLERANCE and credit <= TOLERANCE:
            # Ligne de total, ligne vide, ou en-tête de groupe : sans montant,
            # elle n'apporte rien au relevé.
            continue

        cle = identifiant(compte_brut) or normaliser(nom)
        if not cle:
            continue

        ecriture = Ecriture(
            date=date_valeur(valeur("date")),
            echeance=date_valeur(valeur("echeance")),
            piece=str(valeur("piece") or "").strip(),
            libelle=str(valeur("libelle") or "").strip(),
            lettrage=str(valeur("lettrage") or "").strip(),
            journal=str(valeur("journal") or "").strip(),
            debit=round(debit, 2),
            credit=round(credit, 2),
        )

        compte = par_compte.get(cle)
        if compte is None:
            compte = par_compte[cle] = CompteClient(numero=compte_brut, nom=nom)
        if not compte.numero and compte_brut:
            compte.numero = compte_brut
        if not compte.nom and nom:
            compte.nom = nom
        compte.ecritures.append(ecriture)
        nb_lignes += 1

    if not par_compte:
        raise ErreurPennylane(
            f"{chemin.name} : aucune écriture exploitable. Vérifiez que l'export "
            "porte bien sur les comptes clients (411) et comporte des montants."
        )

    for compte in par_compte.values():
        # Les écritures sans date sont rejetées à la fin : elles ne peuvent
        # servir ni à dater un retard ni à ouvrir la chronologie.
        compte.ecritures.sort(key=lambda e: (e.date is None, e.date or datetime.min))
        compte.factures = [Facture(ecriture=e) for e in compte.ecritures if e.debit > TOLERANCE]
        compte.reglements = [e for e in compte.ecritures if e.credit > TOLERANCE]
        _affecter(compte.factures, compte.reglements)

    comptes = sorted(
        par_compte.values(), key=lambda compte: (-compte.solde, compte.libelle)
    )
    return Comptes(
        comptes=comptes,
        fichier=chemin.name,
        colonnes=colonnes,
        nb_lignes=nb_lignes,
        lu_le=datetime.now().strftime("%d/%m/%Y %H:%M"),
    )


# --------------------------------------------------------------------------
# Relevé de compte, à joindre au dossier
# --------------------------------------------------------------------------

FEUILLE_DE_STYLE = """
@page { size: A4; margin: 14mm 12mm; }
body { font-family: Helvetica, Arial, sans-serif; font-size: 10pt; color: #111; }
.bandeau { border-bottom: 2px solid #F47458; padding-bottom: 8px; margin-bottom: 16px; }
.bandeau .marque { font-size: 15pt; font-weight: bold; color: #F47458; }
.bandeau .document { float: right; font-size: 11pt; font-weight: bold; padding-top: 4px; }
h1 { font-size: 15pt; margin: 0 0 2px; }
.sous-titre { color: #555; font-size: 9pt; margin-bottom: 16px; }
.chiffres { width: 100%; border-collapse: collapse; margin-bottom: 18px; }
.chiffres td { border: 1px solid #ccc; padding: 8px 10px; width: 25%; }
.chiffres .cle { display: block; color: #555; font-size: 8pt; margin-bottom: 3px; }
.chiffres .valeur { font-size: 13pt; font-weight: bold; }
h2 { font-size: 11pt; margin: 18px 0 6px; }
table.pieces { width: 100%; border-collapse: collapse; font-size: 8.5pt; }
table.pieces th { background: #f0f0f4; border: 1px solid #ccc; padding: 5px 6px;
                  text-align: left; font-size: 7.5pt; text-transform: uppercase; }
table.pieces td { border: 1px solid #ddd; padding: 5px 6px; }
table.pieces td.num { text-align: right; white-space: nowrap; }
.du { color: #b91c1c; font-weight: bold; }
.solde { color: #15803d; }
.retard { color: #b45309; }
.vide { color: #777; font-style: italic; }
.pied { margin-top: 20px; border-top: 1px solid #bbb; padding-top: 7px;
        color: #555; font-size: 7.5pt; line-height: 1.5; }
"""


def construire_html_releve(
    compte: CompteClient,
    source: str,
    date_edition: datetime | None = None,
) -> str:
    """Relevé du compte d'un apprenant, mis en page pour être joint au dossier.

    Les chiffres ne sont pas commentés : le relevé énonce ce que dit la
    comptabilité, la note de synthèse en tire les conséquences.
    """
    date_edition = date_edition or datetime.now()
    resume = compte.resume(date_edition)

    def rangee_facture(facture: dict) -> str:
        retard = (
            f'<span class="retard"> (+{facture["retard"]} j)</span>'
            if facture["retard"] else ""
        )
        return (
            "<tr>"
            f'<td>{html.escape(facture["date"])}</td>'
            f'<td>{html.escape(facture["numero"] or "—")}</td>'
            f'<td>{html.escape(facture["libelle"] or "—")}</td>'
            f'<td>{html.escape(facture["echeance"])}</td>'
            f'<td class="num">{euros(facture["total"])}</td>'
            f'<td class="num">{euros(facture["regle"])}</td>'
            f'<td class="num">{euros(facture["reste"])}</td>'
            f'<td>{html.escape(facture["statut"])}{retard}</td>'
            "</tr>"
        )

    def rangee_reglement(reglement: dict) -> str:
        return (
            "<tr>"
            f'<td>{html.escape(reglement["date"])}</td>'
            f'<td>{html.escape(reglement["piece"] or "—")}</td>'
            f'<td>{html.escape(reglement["libelle"] or "—")}</td>'
            f'<td>{html.escape(reglement["journal"] or "—")}</td>'
            f'<td class="num">{euros(reglement["montant"])}</td>'
            "</tr>"
        )

    factures = "".join(rangee_facture(facture) for facture in resume["factures"])
    reglements = "".join(rangee_reglement(reglement) for reglement in resume["reglements"])

    bloc_factures = (
        '<table class="pieces"><tr><th>Date</th><th>N° de facture</th><th>Libellé</th>'
        "<th>Échéance</th><th>Montant</th><th>Réglé</th><th>Reste dû</th><th>Statut</th></tr>"
        f"{factures}</table>"
        if factures
        else '<p class="vide">Aucune facture sur ce compte.</p>'
    )
    bloc_reglements = (
        '<table class="pieces"><tr><th>Date</th><th>Référence</th><th>Libellé</th>'
        "<th>Journal</th><th>Montant</th></tr>"
        f"{reglements}</table>"
        if reglements
        else '<p class="vide">Aucun règlement enregistré sur ce compte.</p>'
    )

    return f"""<!DOCTYPE html>
<html lang="fr"><head><meta charset="utf-8" />
<title>Relevé de compte — {html.escape(compte.libelle)}</title>
<style>{FEUILLE_DE_STYLE}</style></head>
<body>
<div class="bandeau">
  <span class="marque">Liora</span>
  <span class="document">Relevé de compte client</span>
</div>

<h1>{html.escape(compte.libelle)}</h1>
<div class="sous-titre">
  {f"Compte {html.escape(compte.numero)} &mdash; " if compte.numero else ""}
  {len(compte.ecritures)} écriture(s) &mdash;
  édité le {date_edition.strftime('%d/%m/%Y')}
</div>

<table class="chiffres"><tr>
  <td><span class="cle">Total facturé</span>
      <span class="valeur">{euros(resume['total_facture'])}</span></td>
  <td><span class="cle">Total réglé</span>
      <span class="valeur solde">{euros(resume['total_regle'])}</span></td>
  <td><span class="cle">Reste dû</span>
      <span class="valeur du">{euros(resume['solde'])}</span></td>
  <td><span class="cle">Dont échu</span>
      <span class="valeur retard">{euros(resume['impaye_echu'])}</span></td>
</tr></table>

<h2>Factures</h2>
{bloc_factures}

<h2>Règlements</h2>
{bloc_reglements}

<div class="pied">
  Relevé établi le {date_edition.strftime('%d/%m/%Y à %H:%M')} à partir de
  l'export comptable {html.escape(source)}, sans retouche des montants.
  Les règlements sont rattachés aux factures par le lettrage comptable
  lorsqu'il figure dans l'export ; à défaut, les factures les plus anciennes
  sont soldées en premier. Cette imputation par défaut peut différer de celle
  retenue en comptabilité : le total facturé, le total réglé et le reste dû,
  eux, n'en dépendent pas.
</div>
</body></html>
"""
