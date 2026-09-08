"""Écriture des index CSV : un par dossier, plus un récapitulatif global.

Encodage UTF-8 avec BOM et séparateur « ; » : Excel en configuration
française ouvre le fichier correctement par double-clic, sans assistant
d'importation.
"""

from __future__ import annotations

import csv
import os
import time
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
    "montant_recu",
    "montant_prorata",
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
    "date_echeance",
    "source_echeance",
    # Ce que le suivi sait de l'execution de la formation : devant un
    # tribunal, une convention signee et des heures suivies etablissent que la
    # prestation a bien ete fournie.
    "convention_signee",
    "diplome",
    "heures_theoriques",
    "heures_log",
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
    montant_recu: str = ""
    montant_prorata: str = ""
    mise_en_demeure: str = ""
    contestation: str = ""
    echeancier: str = ""
    derniere_reponse: str = ""
    jours_sans_echange: str = ""
    doublons_ecartes: int = 0
    sous_dossiers_factures: int = 0
    sous_dossiers_adresses: int = 0
    adresses_decouvertes: str = ""
    date_echeance: str = ""
    source_echeance: str = ""
    convention_signee: str = ""
    diplome: str = ""
    heures_theoriques: str = ""
    heures_log: str = ""
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
            "convention_signee": self.convention_signee,
            "diplome": self.diplome,
            "heures_theoriques": self.heures_theoriques,
            "heures_log": self.heures_log,
            "premier_mail": min(self.dates).strftime("%d/%m/%Y") if self.dates else "",
            "dernier_mail": max(self.dates).strftime("%d/%m/%Y") if self.dates else "",
            "nb_pieces_jointes": str(self.nb_pieces_jointes),
            "montant_du": self.montant_du,
            "montant_total": self.montant_total,
            "montant_recu": self.montant_recu,
            "montant_prorata": self.montant_prorata,
            "mise_en_demeure": self.mise_en_demeure,
            "contestation": self.contestation,
            "echeancier": self.echeancier,
            "derniere_reponse": self.derniere_reponse,
            "jours_sans_echange": self.jours_sans_echange,
            "doublons_ecartes": str(self.doublons_ecartes),
            "sous_dossiers_factures": str(self.sous_dossiers_factures),
            "sous_dossiers_adresses": str(self.sous_dossiers_adresses),
            "adresses_decouvertes": self.adresses_decouvertes,
            "date_echeance": self.date_echeance,
            "source_echeance": self.source_echeance,
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
    """Écriture atomique : un fichier temporaire, puis un remplacement.

    Le récapitulatif est réécrit en entier après chaque dossier, et
    l'application le relit pendant ce temps pour son tableau de bord. Écrit en
    place, il est vu tronqué une fraction de seconde — et le compte des
    dossiers passait d'une dizaine à une quarantaine d'un rafraîchissement à
    l'autre. `os.replace` est atomique, y compris sous Windows.
    """
    chemin.parent.mkdir(parents=True, exist_ok=True)
    provisoire = chemin.with_name(chemin.name + ".en-cours")
    with provisoire.open("w", encoding="utf-8-sig", newline="") as fichier:
        redacteur = csv.DictWriter(fichier, fieldnames=colonnes, delimiter=";")
        redacteur.writeheader()
        redacteur.writerows(rangees)
        fichier.flush()
        os.fsync(fichier.fileno())
    # Sous Windows, un fichier qui vient d'être écrit est souvent tenu une
    # fraction de seconde par l'antivirus ou l'indexeur de recherche : le
    # remplacement échoue alors qu'aucune fenêtre n'est ouverte. Trois
    # tentatives espacées suffisent à passer outre, et ne coûtent rien quand
    # tout va bien. Un fichier réellement ouvert dans Excel, lui, ne se
    # libérera pas : l'attente reste courte.
    dernier: OSError | None = None
    for attente in (0.0, 0.3, 0.9):
        if attente:
            time.sleep(attente)
        try:
            os.replace(provisoire, chemin)
            return
        except OSError as exc:
            dernier = exc

    # « Accès refusé » sur le remplacement, sans dire par qui. Le message brut
    # faisait chercher un problème de droits là où il suffit de fermer une
    # fenêtre. Le fichier écrit reste à côté, sous son nom provisoire : rien
    # de ce qui a été trouvé n'est perdu.
    raise OSError(
        f"{chemin.name} n'a pas pu être remplacé : {dernier}. "
        "Ce fichier est très probablement ouvert dans Excel ou un autre "
        f"programme — fermez-le. Ce qui vient d'être écrit est conservé "
        f"dans {provisoire.name}, à côté."
    ) from dernier


def ecrire_index_dossier(chemin: Path, lignes: list[LigneIndex]) -> None:
    _ecrire_csv(chemin, COLONNES_INDEX, [ligne.en_rangee() for ligne in lignes])


def lire_recapitulatif(chemin: Path) -> list[dict[str, str]]:
    """Les rangées déjà écrites, ou rien si le fichier n'existe pas encore."""
    try:
        texte = chemin.read_text(encoding="utf-8-sig")
    except OSError:
        return []
    return [dict(rangee)
            for rangee in csv.DictReader(texte.splitlines(), delimiter=";")
            if (rangee.get("reference") or "").strip()]


def ecrire_recapitulatif(chemin: Path, resumes: list[ResumeDossier]) -> None:
    """Écrit le récapitulatif, en gardant les dossiers qu'il portait déjà.

    Le fichier était remplacé par les seuls dossiers de la passe en cours.
    Une recherche ponctuelle — un dossier — effaçait donc de la liste les
    cinquante-deux autres, qui restaient pourtant sur le disque, complets,
    avec leurs pièces versées. Rien n'était perdu, mais plus rien ne se
    voyait, ce qui revient au même quand on cherche un dossier.

    Un dossier retraité remplace sa rangée : c'est la passe en cours qui dit
    la vérité sur lui. Les autres sont reconduits tels quels.
    """
    # Réduites aux colonnes du jour : un récapitulatif écrit par une version
    # antérieure peut en porter d'autres, et le réécrire tel quel échouerait.
    rangees = {
        rangee["reference"]: {cle: rangee.get(cle, "") for cle in COLONNES_RECAP}
        for rangee in lire_recapitulatif(chemin)
    }
    for resume in resumes:
        rangees[resume.reference] = resume.en_rangee()
    _ecrire_csv(chemin, COLONNES_RECAP, list(rangees.values()))
