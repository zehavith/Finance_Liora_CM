"""Écriture des index CSV : un par dossier, plus un récapitulatif global.

Encodage UTF-8 avec BOM et séparateur « ; » : Excel en configuration
française ouvre le fichier correctement par double-clic, sans assistant
d'importation.
"""

from __future__ import annotations

import csv
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

COLONNES_INDEX = [
    "piece_n",
    "date",
    "heure",
    "sens",
    "expediteur",
    "destinataires",
    "copie",
    "objet",
    "nb_pieces_jointes",
    "pieces_jointes",
    "critere",
    # Facture(s) nommée(s) dans le message : c'est ce qui range l'échange dans
    # le sous-dossier de la facture concernée. Vide = concerne tout le dossier.
    "factures_concernees",
    # Adresse(s) du dossier parmi les parties au message. Vide = message
    # rattaché au dossier sans que le débiteur figure dans les en-têtes.
    "adresses_concernees",
    "boites",
    "fichier_pdf",
    "fichier_eml",
    "dossier_pieces_jointes",
    "thread_id",
    "message_id",
]

COLONNES_RECAP = [
    "reference",
    "nom",
    "emails",
    "factures",
    "nb_mails",
    "nb_recus",
    "nb_envoyes",
    "premier_mail",
    "dernier_mail",
    "nb_pieces_jointes",
    "montant_du",
    "montant_total",
    # Colonnes de tri pour arbitrer sur l'ensemble des dossiers d'un coup d'œil.
    "mise_en_demeure",
    "contestation",
    "echeancier",
    "derniere_reponse",
    "jours_sans_echange",
    "doublons_ecartes",
    "sous_dossiers_factures",
    "sous_dossiers_adresses",
    "adresses_decouvertes",
    "date_contentieux",
    "date_cloture",
    "issue_process",
    "jours_de_procedure",
    "pdf_en_echec",
    "statut",
    "repertoire",
    "requete_gmail",
]


@dataclass
class LigneIndex:
    piece_n: int
    date: datetime
    sens: str
    expediteur: str
    destinataires: str
    copie: str
    objet: str
    nb_pieces_jointes: int
    pieces_jointes: str
    critere: str
    boites: str
    fichier_pdf: str
    fichier_eml: str
    dossier_pieces_jointes: str
    thread_id: str
    message_id: str
    factures_concernees: str = ""
    adresses_concernees: str = ""

    def en_rangee(self) -> dict[str, str]:
        return {
            "piece_n": str(self.piece_n),
            "date": self.date.strftime("%d/%m/%Y"),
            "heure": self.date.strftime("%H:%M"),
            "sens": self.sens,
            "expediteur": self.expediteur,
            "destinataires": self.destinataires,
            "copie": self.copie,
            "objet": self.objet,
            "nb_pieces_jointes": str(self.nb_pieces_jointes),
            "pieces_jointes": self.pieces_jointes,
            "critere": self.critere,
            "factures_concernees": self.factures_concernees,
            "adresses_concernees": self.adresses_concernees,
            "boites": self.boites,
            "fichier_pdf": self.fichier_pdf,
            "fichier_eml": self.fichier_eml,
            "dossier_pieces_jointes": self.dossier_pieces_jointes,
            "thread_id": self.thread_id,
            "message_id": self.message_id,
        }


@dataclass
class ResumeDossier:
    reference: str
    nom: str
    emails: str
    factures: str
    requete: str
    repertoire: str
    statut: str = "ok"
    nb_mails: int = 0
    nb_recus: int = 0
    nb_envoyes: int = 0
    nb_pieces_jointes: int = 0
    pdf_en_echec: int = 0
    dates: list[datetime] = field(default_factory=list)
    montant_du: str = ""
    montant_total: str = ""
    mise_en_demeure: str = ""
    contestation: str = ""
    echeancier: str = ""
    derniere_reponse: str = ""
    jours_sans_echange: str = ""
    doublons_ecartes: int = 0
    sous_dossiers_factures: int = 0
    sous_dossiers_adresses: int = 0
    adresses_decouvertes: str = ""
    date_contentieux: str = ""
    date_cloture: str = ""
    issue_process: str = ""
    jours_de_procedure: str = ""

    def en_rangee(self) -> dict[str, str]:
        return {
            "reference": self.reference,
            "nom": self.nom,
            "emails": self.emails,
            "factures": self.factures,
            "nb_mails": str(self.nb_mails),
            "nb_recus": str(self.nb_recus),
            "nb_envoyes": str(self.nb_envoyes),
            "premier_mail": min(self.dates).strftime("%d/%m/%Y") if self.dates else "",
            "dernier_mail": max(self.dates).strftime("%d/%m/%Y") if self.dates else "",
            "nb_pieces_jointes": str(self.nb_pieces_jointes),
            "montant_du": self.montant_du,
            "montant_total": self.montant_total,
            "mise_en_demeure": self.mise_en_demeure,
            "contestation": self.contestation,
            "echeancier": self.echeancier,
            "derniere_reponse": self.derniere_reponse,
            "jours_sans_echange": self.jours_sans_echange,
            "doublons_ecartes": str(self.doublons_ecartes),
            "sous_dossiers_factures": str(self.sous_dossiers_factures),
            "sous_dossiers_adresses": str(self.sous_dossiers_adresses),
            "adresses_decouvertes": self.adresses_decouvertes,
            "date_contentieux": self.date_contentieux,
            "date_cloture": self.date_cloture,
            "issue_process": self.issue_process,
            "jours_de_procedure": self.jours_de_procedure,
            "pdf_en_echec": str(self.pdf_en_echec),
            "statut": self.statut,
            "repertoire": self.repertoire,
            "requete_gmail": self.requete,
        }


def _ecrire_csv(chemin: Path, colonnes: list[str], rangees: list[dict[str, str]]) -> None:
    chemin.parent.mkdir(parents=True, exist_ok=True)
    with chemin.open("w", encoding="utf-8-sig", newline="") as fichier:
        redacteur = csv.DictWriter(fichier, fieldnames=colonnes, delimiter=";")
        redacteur.writeheader()
        redacteur.writerows(rangees)


def ecrire_index_dossier(chemin: Path, lignes: list[LigneIndex]) -> None:
    _ecrire_csv(chemin, COLONNES_INDEX, [ligne.en_rangee() for ligne in lignes])


def ecrire_recapitulatif(chemin: Path, resumes: list[ResumeDossier]) -> None:
    _ecrire_csv(chemin, COLONNES_RECAP, [resume.en_rangee() for resume in resumes])
