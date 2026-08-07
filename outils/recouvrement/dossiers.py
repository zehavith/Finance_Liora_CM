"""Lecture du fichier des dossiers et construction des requêtes Gmail."""

from __future__ import annotations

import csv
import re
import unicodedata
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

# Gmail rejette les requêtes trop longues ; on prévient bien avant la limite.
LONGUEUR_MAX_REQUETE = 1800

SEPARATEURS_MULTIVALEUR = re.compile(r"[|,]")

FORMATS_DATE = ("%d/%m/%Y", "%Y-%m-%d", "%d-%m-%Y", "%d/%m/%y")

# Noms de colonnes acceptés (après normalisation : minuscules, sans accent).
ALIAS_COLONNES = {
    "reference": {"reference", "ref", "dossier", "n dossier", "numero dossier", "id"},
    "nom": {"nom", "apprenante", "apprenant", "nom apprenante", "nom apprenant",
            "nom prenom", "stagiaire"},
    "email": {"email", "mail", "adresse", "adresse mail", "adresse email",
              "email apprenante", "mail apprenante", "e-mail"},
    "facture": {"facture", "factures", "num facture", "numero facture",
                "n facture", "no facture", "reference facture"},
    "date_debut": {"date debut", "debut", "depuis", "date de debut"},
    "date_fin": {"date fin", "fin", "jusqu a", "jusqua", "date de fin"},
}


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


def lire_dossiers(chemin: Path) -> list[Dossier]:
    if not chemin.exists():
        raise ErreurDossiers(f"Fichier des dossiers introuvable : {chemin}")

    texte = chemin.read_text(encoding="utf-8-sig")
    if not texte.strip():
        raise ErreurDossiers(f"Fichier des dossiers vide : {chemin}")

    premiere_ligne = texte.splitlines()[0]
    delimiteur = ";" if premiere_ligne.count(";") >= premiere_ligne.count(",") else ","

    lecteur = csv.DictReader(texte.splitlines(), delimiter=delimiteur)
    if not lecteur.fieldnames:
        raise ErreurDossiers(f"Aucun en-tête de colonne dans {chemin}")

    # Correspondance en-tête du fichier -> champ interne.
    correspondance: dict[str, str] = {}
    for entete in lecteur.fieldnames:
        normalise = _normaliser_entete(entete)
        for champ, alias in ALIAS_COLONNES.items():
            if normalise in alias:
                correspondance[entete] = champ
                break

    champs_trouves = set(correspondance.values())
    if not ({"email", "facture"} & champs_trouves):
        raise ErreurDossiers(
            f"{chemin} : il faut au minimum une colonne « email » ou « facture ».\n"
            f"Colonnes lues : {', '.join(lecteur.fieldnames)}"
        )

    dossiers: list[Dossier] = []
    references_vues: set[str] = set()

    for numero, rangee in enumerate(lecteur, start=2):
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
            raise ErreurDossiers(
                f"{chemin}, ligne {numero} : ni adresse mail ni numéro de facture."
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

    if not dossiers:
        raise ErreurDossiers(f"Aucun dossier exploitable dans {chemin}")

    return dossiers
