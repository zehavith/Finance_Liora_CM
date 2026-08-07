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

# Noms de colonnes acceptés (après normalisation : minuscules, sans accent).
# « name » et « item » couvrent la première colonne des exports Monday.
ALIAS_COLONNES = {
    "reference": {"reference", "ref", "dossier", "n dossier", "numero dossier", "id",
                  "numero de dossier", "ref dossier"},
    "nom": {"nom", "apprenante", "apprenant", "nom apprenante", "nom apprenant",
            "nom prenom", "prenom nom", "stagiaire", "name", "item", "element",
            "nom de l apprenante", "titre"},
    "email": {"email", "mail", "adresse", "adresse mail", "adresse email",
              "email apprenante", "mail apprenante", "e mail", "courriel",
              "email de l apprenante", "adresse e mail"},
    "facture": {"facture", "factures", "num facture", "numero facture",
                "n facture", "no facture", "reference facture", "numero de facture",
                "n de facture", "invoice", "facture n"},
    "date_debut": {"date debut", "debut", "depuis", "date de debut"},
    "date_fin": {"date fin", "fin", "jusqu a", "jusqua", "date de fin"},
}

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


def _decouper(valeur: str) -> list[str]:
    if not valeur:
        return []
    return [morceau.strip() for morceau in SEPARATEURS_MULTIVALEUR.split(valeur) if morceau.strip()]


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


def _champ_reconnu(entete: str) -> str | None:
    normalise = _normaliser_entete(entete)
    for champ, alias in ALIAS_COLONNES.items():
        if normalise in alias:
            return champ
    return None


def _trouver_entete(lignes: list[str]) -> tuple[int, str, dict[str, str]]:
    """Localise la ligne d'en-tête et le séparateur.

    Un export Monday ou Excel ne commence pas forcément par les intitulés de
    colonnes : on sonde les premières lignes et on retient celle qui expose le
    plus de colonnes exploitables.
    """
    meilleur: tuple[int, int, str, dict[str, str]] | None = None

    for index, ligne in enumerate(lignes[:LIGNES_SONDEES]):
        if not ligne.strip():
            continue
        for delimiteur in DELIMITEURS:
            try:
                entetes = next(csv.reader([ligne], delimiter=delimiteur))
            except (csv.Error, StopIteration):
                continue

            correspondance = {}
            for entete in entetes:
                champ = _champ_reconnu(entete)
                # Première colonne reconnue gagnante en cas de doublon.
                if champ and champ not in correspondance.values():
                    correspondance[entete] = champ

            score = len(correspondance)
            if {"email", "facture"} & set(correspondance.values()):
                score += 10  # Une ligne sans critère de recherche n'est pas l'en-tête.

            if score > 0 and (meilleur is None or score > meilleur[1]):
                meilleur = (index, score, delimiteur, correspondance)

    if meilleur is None:
        return -1, ";", {}
    return meilleur[0], meilleur[2], meilleur[3]


def lire_dossiers(
    chemin: Path,
    ignorer_lignes_incompletes: bool = False,
    signaler: Callable[[str], None] | None = None,
) -> list[Dossier]:
    if not chemin.exists():
        raise ErreurDossiers(f"Fichier des dossiers introuvable : {chemin}")

    texte = chemin.read_text(encoding="utf-8-sig")
    if not texte.strip():
        raise ErreurDossiers(f"Fichier des dossiers vide : {chemin}")

    lignes = texte.splitlines()
    index_entete, delimiteur, correspondance = _trouver_entete(lignes)

    if not ({"email", "facture"} & set(correspondance.values())):
        apercu = lignes[index_entete] if index_entete >= 0 else lignes[0]
        raise ErreurDossiers(
            f"{chemin} : il faut au minimum une colonne « email » ou « facture ».\n"
            f"Ligne d'en-tête lue : {apercu[:200]}\n"
            "Renommez la colonne concernée en « email » ou « facture »."
        )

    lecteur = csv.DictReader(lignes[index_entete:], delimiter=delimiteur)

    dossiers: list[Dossier] = []
    ignorees: list[int] = []
    references_vues: set[str] = set()

    for rangee in lecteur:
        # `line_num` compte les lignes physiques réellement lues, y compris
        # celles que le lecteur CSV saute : c'est le seul numéro qui renvoie
        # l'utilisateur sur la bonne ligne de son tableur.
        numero = index_entete + lecteur.line_num
        valeurs = {champ: "" for champ in ALIAS_COLONNES}
        for entete, valeur in rangee.items():
            champ = correspondance.get(entete)
            if champ:
                valeurs[champ] = (valeur or "").strip()

        if not any(valeurs.values()):
            continue

        dossier = Dossier(
            reference=valeurs["reference"],
            nom=valeurs["nom"],
            emails=_decouper(valeurs["email"]),
            factures=_decouper(valeurs["facture"]),
            date_debut=_normaliser_date(valeurs["date_debut"]),
            date_fin=_normaliser_date(valeurs["date_fin"]),
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
                f"(contenu : « {(valeurs['reference'] or valeurs['nom'])[:60]} »).\n"
                "Corrigez la ligne, ou relancez avec --ignorer-lignes-incompletes "
                "pour passer ce type de ligne."
            )

        if not dossier.reference:
            dossier.reference = f"D{len(dossiers) + 1:03d}"

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

    if ignorees and signaler:
        # Jamais silencieux : les lignes écartées sont nommées une par une.
        signaler(
            f"⚠ {len(ignorees)} ligne(s) sans adresse ni facture ignorée(s) : "
            f"ligne(s) {', '.join(str(numero) for numero in ignorees)}"
        )

    if not dossiers:
        raise ErreurDossiers(f"Aucun dossier exploitable dans {chemin}")

    return dossiers
