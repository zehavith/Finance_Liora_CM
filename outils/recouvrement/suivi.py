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

# Étapes de la procédure, dans l'ordre où un dossier les traverse.
#
# Les cinq étapes en cours forment une rampe ordinale d'une seule teinte
# (bleu, du plus soutenu au plus clair) : la couleur dit l'avancement, pas
# l'identité. Validée pour le fond sombre de l'application — teinte unique,
# clarté monotone, écarts visibles, extrémité sombre au-dessus de 2:1.
#
# Les issues portent les couleurs d'état réservées, vert et rouge. Ces deux-là
# sont indistinguables en vision deutan (ΔE 4,1) : l'icône et le libellé les
# accompagnent systématiquement, la couleur ne porte jamais seule le sens.
STATUTS = [
    {"cle": "non-transmis", "libelle": "Non transmis",
     "couleur": "#184f95", "icone": "", "famille": "cours"},
    {"cle": "transmission-en-cours",
     "libelle": "En cours de transmission au service contentieux",
     "couleur": "#256abf", "icone": "", "famille": "cours"},
    {"cle": "transmis-contentieux",
     "libelle": "Transmis au service contentieux — dossier complet",
     "couleur": "#3987e5", "icone": "", "famille": "cours"},
    {"cle": "avocats", "libelle": "Transmis aux avocats",
     "couleur": "#6da7ec", "icone": "", "famille": "cours"},
    {"cle": "tribunal-en-cours", "libelle": "Procédure via tribunaux en cours",
     "couleur": "#b7d3f6", "icone": "", "famille": "cours"},
    {"cle": "cloture-recouvrement", "libelle": "Clôturé via recouvrement",
     "couleur": "#0ca30c", "icone": "✓", "famille": "gagne"},
    {"cle": "tribunal-gagne",
     "libelle": "Procédure via tribunaux clôturée — montant reçu",
     "couleur": "#0ca30c", "icone": "⚖", "famille": "gagne"},
    {"cle": "tribunal-perdu",
     "libelle": "Procédure via tribunaux clôturée — montant perdu",
     "couleur": "#d03b3b", "icone": "✕", "famille": "perdu"},
]

# Les états de la première version de l'outil, pour ne pas perdre le suivi
# déjà saisi lors de la mise à jour.
ANCIENS_STATUTS = {
    "transmis": "transmis-contentieux",
    "avocat": "avocats",
    "tribunal": "tribunal-en-cours",
    "gagne": "cloture-recouvrement",
    "perdu": "tribunal-perdu",
}

CLES_STATUTS = {statut["cle"] for statut in STATUTS}
STATUT_INITIAL = "non-transmis"
ORDRE_STATUTS = {statut["cle"]: rang for rang, statut in enumerate(STATUTS)}
FAMILLES = {statut["cle"]: statut["famille"] for statut in STATUTS}
CLOTURES = {cle for cle, famille in FAMILLES.items() if famille != "cours"}
GAGNES = {cle for cle, famille in FAMILLES.items() if famille == "gagne"}
PERDUS = {cle for cle, famille in FAMILLES.items() if famille == "perdu"}


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
    if not isinstance(donnees, dict):
        return {}
    return {reference: _migrer(entree) for reference, entree in donnees.items()}


def _migrer(entree) -> dict:
    """Reprend une entrée écrite par la version précédente de l'outil.

    Les étapes ont été renommées et détaillées ; sans cette reprise, un suivi
    déjà saisi retomberait silencieusement à « non transmis ».
    """
    if not isinstance(entree, dict):
        return {}
    entree = dict(entree)
    statut = entree.get("statut")
    if statut in ANCIENS_STATUTS:
        entree["statut"] = ANCIENS_STATUTS[statut]
    for etape in entree.get("historique") or []:
        if isinstance(etape, dict) and etape.get("statut") in ANCIENS_STATUTS:
            etape["statut"] = ANCIENS_STATUTS[etape["statut"]]
    return entree


def _date_courte(valeur: str) -> str:
    """Normalise une date saisie à la main vers JJ/MM/AAAA."""
    valeur = (valeur or "").strip()
    if not valeur:
        return ""
    for format_ in ("%d/%m/%Y", "%Y-%m-%d", "%d-%m-%Y", "%d/%m/%y"):
        try:
            return datetime.strptime(valeur[:10], format_).strftime("%d/%m/%Y")
        except ValueError:
            continue
    raise ValueError(f"Date incomprise : « {valeur} ». Attendu : JJ/MM/AAAA.")


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
    date_etape: str | None = None,
) -> dict:
    if statut is not None and statut not in CLES_STATUTS:
        raise ValueError(f"Statut inconnu : {statut}")

    entree = dict(donnees.get(reference) or {})
    historique = [dict(e) for e in (entree.get("historique") or [])]

    if statut is not None and statut != entree.get("statut"):
        # Chaque changement d'étape est daté au moment où il est saisi. La date
        # reste modifiable ensuite : une étape se saisit souvent après coup.
        historique.append({
            "statut": statut,
            "date": _date_courte(date_etape) if date_etape
            else datetime.now().strftime("%d/%m/%Y"),
        })
        entree["historique"] = historique
    if statut is not None:
        entree["statut"] = statut
    if frais is not None:
        entree["frais"] = _nombre(frais)
    if note is not None:
        entree["note"] = note.strip()
    entree["maj"] = horodatage or datetime.now().strftime("%d/%m/%Y %H:%M")

    donnees[reference] = entree
    return entree


def dater_etape(
    donnees: dict[str, dict], reference: str, rang: int, date: str
) -> dict:
    """Corrige la date d'une étape déjà enregistrée, ou la supprime si vide.

    Une étape se saisit souvent des jours après s'être produite : sans cette
    correction, la durée de procédure serait fausse de toute la latence de
    saisie.
    """
    entree = dict(donnees.get(reference) or {})
    historique = [dict(e) for e in (entree.get("historique") or [])]
    if not 0 <= rang < len(historique):
        raise ValueError("Étape inconnue.")

    if date.strip():
        historique[rang]["date"] = _date_courte(date)
    else:
        historique.pop(rang)

    historique.sort(key=lambda etape: _date_lisible(etape.get("date")) or datetime.min)
    entree["historique"] = historique
    entree["maj"] = datetime.now().strftime("%d/%m/%Y %H:%M")
    donnees[reference] = entree
    return entree


def _date_lisible(valeur) -> datetime | None:
    try:
        return datetime.strptime(str(valeur or "")[:10], "%d/%m/%Y")
    except ValueError:
        return None


def parcours_dossier(entree: dict) -> dict:
    """Dates clés d'un dossier : entrée au contentieux, clôture, durée.

    Le contentieux commence dès la mise en transmission : c'est ce jour-là que
    le dossier quitte le recouvrement amiable, et c'est de là que se compte la
    durée d'une procédure.
    """
    historique = [
        etape for etape in (entree.get("historique") or [])
        if isinstance(etape, dict) and _date_lisible(etape.get("date"))
    ]
    historique.sort(key=lambda etape: _date_lisible(etape["date"]))

    debut = cloture = None
    issue = ""
    for etape in historique:
        cle = etape.get("statut")
        if cle in CLOTURES:
            cloture = _date_lisible(etape["date"])
            issue = cle
        elif cle != STATUT_INITIAL and debut is None:
            debut = _date_lisible(etape["date"])

    duree = (cloture - debut).days if (debut and cloture) else None
    return {
        "etapes": historique,
        "debut": debut.strftime("%d/%m/%Y") if debut else "",
        "cloture": cloture.strftime("%d/%m/%Y") if cloture else "",
        "issue": issue,
        "duree_jours": duree,
    }


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
                # Le parcours saisi dans l'application. Les dates relevées dans
                # Monday figurent à part, au récapitulatif : celles-ci sont
                # celles du service, et lui seul les corrige.
                **parcours_dossier(etat),
                "date_contentieux_monday": (
                    rangee.get("date_contentieux") or "").strip(),
                "date_cloture_monday": (rangee.get("date_cloture") or "").strip(),
            }
        )

    return dossiers


def courbe_par_mois(dossiers: list[dict], mois_max: int = 24) -> dict:
    """Répartition du portefeuille par étape, mois après mois.

    À la fin de chaque mois, où en était chaque dossier ? C'est la lecture qui
    répond à « où en sommes-nous globalement » : un simple décompte des étapes
    atteintes montrerait une progression même là où tout stagne.

    Un dossier n'apparaît qu'à partir du mois de sa première étape datée : le
    faire figurer avant reviendrait à inventer un portefeuille qui n'existait
    pas encore.
    """
    parcours = []
    for dossier in dossiers:
        etapes = [
            (_date_lisible(etape["date"]), etape.get("statut"))
            for etape in dossier.get("etapes") or []
            if _date_lisible(etape.get("date"))
        ]
        if etapes:
            parcours.append(sorted(etapes))

    if not parcours:
        return {"mois": [], "series": []}

    premier = min(etapes[0][0] for etapes in parcours)
    dernier = datetime.now()

    mois: list[str] = []
    curseur = datetime(premier.year, premier.month, 1)
    while curseur <= dernier and len(mois) < mois_max:
        mois.append(curseur.strftime("%m/%Y"))
        curseur = (
            datetime(curseur.year + 1, 1, 1)
            if curseur.month == 12
            else datetime(curseur.year, curseur.month + 1, 1)
        )
    # Au-delà du plafond, on garde les mois les plus récents : c'est la
    # situation actuelle qui intéresse, pas le début de l'historique.
    mois = mois[-mois_max:]

    # Les deux clôtures favorables — amiable et judiciaire — sont réunies en
    # une seule bande : elles portent la même couleur d'état, et deux bandes
    # vertes voisines se liraient comme une seule. Le détail reste au tableau
    # des dossiers et dans les tuiles, où l'icône et le libellé les séparent.
    bandes = [
        {"cle": statut["cle"], "libelle": statut["libelle"],
         "couleur": statut["couleur"], "icone": statut["icone"],
         "famille": statut["famille"]}
        for statut in STATUTS if statut["famille"] == "cours"
    ] + [
        {"cle": "gagne", "libelle": "Clôturé — montant récupéré",
         "couleur": "#0ca30c", "icone": "✓", "famille": "gagne"},
        {"cle": "perdu", "libelle": "Clôturé — montant perdu",
         "couleur": "#d03b3b", "icone": "✕", "famille": "perdu"},
    ]
    vers_bande = {
        statut["cle"]: (
            statut["cle"] if statut["famille"] == "cours" else statut["famille"]
        )
        for statut in STATUTS
    }

    comptes = {bande["cle"]: [0] * len(mois) for bande in bandes}
    for rang, libelle in enumerate(mois):
        mois_courant, annee = libelle.split("/")
        fin = datetime(int(annee), int(mois_courant), 1)
        fin = (
            datetime(fin.year + 1, 1, 1)
            if fin.month == 12
            else datetime(fin.year, fin.month + 1, 1)
        )
        for etapes in parcours:
            atteintes = [cle for date, cle in etapes if date < fin]
            if atteintes:
                comptes[vers_bande.get(atteintes[-1], atteintes[-1])][rang] += 1

    return {
        "mois": mois,
        "series": [
            dict(bande, valeurs=comptes[bande["cle"]])
            for bande in bandes
            if any(comptes[bande["cle"]])
        ],
    }


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
    gagnes = [d for d in dossiers if d["statut"] in GAGNES]
    perdus = [d for d in dossiers if d["statut"] in PERDUS]
    clotures = gagnes + perdus
    durees = [d["duree_jours"] for d in dossiers if d.get("duree_jours") is not None]

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
        "nb_sans_tribunal": sum(
            1 for d in dossiers if d["statut"] == "cloture-recouvrement"
        ),
        "nb_au_tribunal": sum(1 for d in dossiers if d["statut"] == "tribunal-gagne"),
        # Médiane plutôt que moyenne : un dossier resté deux ans en attente
        # d'audience tirerait la moyenne au point de la rendre inutilisable.
        "duree_mediane": (
            sorted(durees)[len(durees) // 2] if durees else None
        ),
        "courbe": courbe_par_mois(dossiers),
        "sans_mise_en_demeure": sum(
            1 for d in dossiers if d["statut"] == "non-transmis"
            and d["mise_en_demeure"] in ("non", "")
        ),
    }
