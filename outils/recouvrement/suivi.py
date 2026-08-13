"""Suivi des dossiers après export : état d'avancement et frais engagés.

L'export produit les pièces ; le suivi dit où en est chaque dossier et ce
qu'il a coûté. Les deux sont séparés à dessein : réexporter un dossier ne doit
pas effacer son état, et l'état se conserve même si l'export est refait
ailleurs. La correspondance se fait sur la référence du dossier.
"""

from __future__ import annotations

import csv
import json
from datetime import datetime
from pathlib import Path

# Étapes de la procédure, dans l'ordre.
#
# Les quatre étapes en cours forment une rampe ordinale d'une seule teinte
# (bleu, du plus soutenu au plus clair) : la couleur dit l'avancement, pas
# l'identité. Les deux issues portent les couleurs d'état réservées, vert et
# rouge — indistinguables en vision deutan, d'où l'icône qui les accompagne
# systématiquement. La couleur ne porte jamais seule le sens.
STATUTS = [
    {"cle": "non-transmis", "libelle": "Non transmis", "couleur": "#2a78d6", "icone": ""},
    {"cle": "transmis", "libelle": "Transmis", "couleur": "#5598e7", "icone": ""},
    {"cle": "avocat", "libelle": "En cours chez l'avocat", "couleur": "#86b6ef", "icone": ""},
    {"cle": "tribunal", "libelle": "Passage au tribunal", "couleur": "#b7d3f6", "icone": ""},
    {"cle": "gagne", "libelle": "Clôturé — gagné", "couleur": "#0ca30c", "icone": "✓"},
    {"cle": "perdu", "libelle": "Clôturé — perdu", "couleur": "#d03b3b", "icone": "✕"},
]

CLES_STATUTS = {statut["cle"] for statut in STATUTS}
STATUT_INITIAL = "non-transmis"
CLOTURES = {"gagne", "perdu"}


def _nombre(valeur) -> float:
    """Lit un montant tel qu'il sort d'un tableur : « 1 280,50 », « 680 », 42.0."""
    if isinstance(valeur, (int, float)):
        return float(valeur)
    texte = str(valeur or "").strip().replace("€", "").replace(" ", "").replace(" ", "")
    texte = texte.replace(",", ".")
    if not texte:
        return 0.0
    try:
        return float(texte)
    except ValueError:
        return 0.0


def charger(chemin: Path) -> dict[str, dict]:
    if not chemin.exists():
        return {}
    try:
        donnees = json.loads(chemin.read_text(encoding="utf-8"))
    except (ValueError, OSError):
        return {}
    return donnees if isinstance(donnees, dict) else {}


def enregistrer(chemin: Path, donnees: dict[str, dict]) -> None:
    chemin.parent.mkdir(parents=True, exist_ok=True)
    chemin.write_text(
        json.dumps(donnees, ensure_ascii=False, indent=2, sort_keys=True),
        encoding="utf-8",
    )


def mettre_a_jour(
    donnees: dict[str, dict],
    reference: str,
    statut: str | None = None,
    frais: str | None = None,
    note: str | None = None,
    horodatage: str | None = None,
) -> dict:
    if statut is not None and statut not in CLES_STATUTS:
        raise ValueError(f"Statut inconnu : {statut}")

    entree = dict(donnees.get(reference) or {})
    if statut is not None:
        entree["statut"] = statut
    if frais is not None:
        entree["frais"] = _nombre(frais)
    if note is not None:
        entree["note"] = note.strip()
    entree["maj"] = horodatage or datetime.now().strftime("%d/%m/%Y %H:%M")

    donnees[reference] = entree
    return entree


def _lire_recapitulatif(chemin: Path) -> list[dict]:
    texte = chemin.read_text(encoding="utf-8-sig")
    return list(csv.DictReader(texte.splitlines(), delimiter=";"))


def inventaire(racine_sortie: Path, chemin_suivi: Path) -> list[dict]:
    """Croise ce que l'export a produit avec l'état de suivi de chaque dossier.

    Un dossier absent du suivi est simplement « non transmis » : le fichier de
    suivi n'a pas besoin d'être alimenté à l'avance.
    """
    recapitulatif = racine_sortie / "_recapitulatif.csv"
    if not recapitulatif.exists():
        return []

    suivi = charger(chemin_suivi)
    dossiers: list[dict] = []

    for rangee in _lire_recapitulatif(recapitulatif):
        reference = (rangee.get("reference") or "").strip()
        if not reference:
            continue

        repertoire = racine_sortie / (rangee.get("repertoire") or "")
        etat = suivi.get(reference) or {}
        statut = etat.get("statut") or STATUT_INITIAL
        if statut not in CLES_STATUTS:
            statut = STATUT_INITIAL

        dossiers.append(
            {
                "reference": reference,
                "nom": (rangee.get("nom") or "").strip(),
                "emails": (rangee.get("emails") or "").strip(),
                "factures": (rangee.get("factures") or "").strip(),
                "montant_du": _nombre(rangee.get("montant_du")),
                "montant_total": _nombre(rangee.get("montant_total")),
                "nb_mails": int(_nombre(rangee.get("nb_mails"))),
                "nb_pieces_jointes": int(_nombre(rangee.get("nb_pieces_jointes"))),
                "premier_mail": (rangee.get("premier_mail") or "").strip(),
                "dernier_mail": (rangee.get("dernier_mail") or "").strip(),
                "mise_en_demeure": (rangee.get("mise_en_demeure") or "").strip(),
                "contestation": (rangee.get("contestation") or "").strip(),
                "jours_sans_echange": (rangee.get("jours_sans_echange") or "").strip(),
                "statut_export": (rangee.get("statut") or "").strip(),
                # Un débiteur portant plusieurs factures a un sous-dossier par
                # facture ; l'état de suivi reste porté par le dossier entier,
                # puisque c'est lui qui part au contentieux.
                "sous_dossiers": int(_nombre(rangee.get("sous_dossiers_factures"))),
                "sous_dossiers_adresses": int(
                    _nombre(rangee.get("sous_dossiers_adresses"))
                ),
                "repertoire": str(repertoire),
                "a_synthese": (repertoire / "synthese.pdf").exists(),
                "a_index": (repertoire / "index.csv").exists(),
                # État de suivi
                "statut": statut,
                "frais": _nombre(etat.get("frais")),
                "note": etat.get("note") or "",
                "maj": etat.get("maj") or "",
            }
        )

    return dossiers


def agreger(dossiers: list[dict]) -> dict:
    """Chiffres du tableau de bord."""
    par_statut = {
        statut["cle"]: {
            "libelle": statut["libelle"],
            "couleur": statut["couleur"],
            "icone": statut["icone"],
            "nombre": 0,
            "montant": 0.0,
            "frais": 0.0,
        }
        for statut in STATUTS
    }

    for dossier in dossiers:
        case = par_statut[dossier["statut"]]
        case["nombre"] += 1
        case["montant"] += dossier["montant_du"]
        case["frais"] += dossier["frais"]

    en_cours = [d for d in dossiers if d["statut"] not in CLOTURES]
    gagnes = [d for d in dossiers if d["statut"] == "gagne"]
    perdus = [d for d in dossiers if d["statut"] == "perdu"]
    clotures = gagnes + perdus

    return {
        "par_statut": [dict(cle=cle, **valeurs) for cle, valeurs in par_statut.items()],
        "nb_dossiers": len(dossiers),
        "nb_en_cours": len(en_cours),
        "montant_en_cours": sum(d["montant_du"] for d in en_cours),
        "montant_total": sum(d["montant_du"] for d in dossiers),
        "frais_engages": sum(d["frais"] for d in dossiers),
        "montant_gagne": sum(d["montant_du"] for d in gagnes),
        "montant_perdu": sum(d["montant_du"] for d in perdus),
        "nb_gagnes": len(gagnes),
        "nb_perdus": len(perdus),
        # Sur les seuls dossiers clos : un taux calculé sur l'ensemble ferait
        # passer pour des échecs les dossiers simplement encore en cours.
        "taux_reussite": (
            round(100 * len(gagnes) / len(clotures)) if clotures else None
        ),
        "sans_mise_en_demeure": sum(
            1 for d in dossiers if d["statut"] == "non-transmis"
            and d["mise_en_demeure"] in ("non", "")
        ),
    }
