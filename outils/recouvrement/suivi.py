"""Suivi des dossiers après export : état d'avancement et frais engagés.

L'export produit les pièces ; le suivi dit où en est chaque dossier et ce
qu'il a coûté. Les deux sont séparés à dessein : réexporter un dossier ne doit
pas effacer son état, et l'état se conserve même si l'export est refait
ailleurs. La correspondance se fait sur la référence du dossier.
"""

from __future__ import annotations

import csv
import shutil
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

# Tranches d'ancienneté de la créance, comptées depuis l'échéance de la facture.
#
# Rampe orange, et non bleue : les étapes du process occupent déjà une rampe
# bleue, et deux échelles de la même teinte sur un même écran se confondraient.
# Validée pour le fond sombre — teinte unique, clarté monotone, écarts visibles.
# Du plus sombre au plus clair : c'est la créance la plus ancienne qui doit
# ressortir, c'est elle qui coûte le plus cher à laisser courir.
TRANCHES_ANCIENNETE = [
    {"cle": "0-90", "libelle": "Moins de 3 mois", "min": 0, "max": 90,
     "couleur": "#8f3d10"},
    {"cle": "91-180", "libelle": "3 à 6 mois", "min": 91, "max": 180,
     "couleur": "#bb4f14"},
    {"cle": "181-365", "libelle": "6 mois à 1 an", "min": 181, "max": 365,
     "couleur": "#e0621f"},
    {"cle": "365-730", "libelle": "1 à 2 ans", "min": 366, "max": 730,
     "couleur": "#f08a56"},
    {"cle": "730+", "libelle": "Plus de 2 ans", "min": 731, "max": 10 ** 6,
     "couleur": "#f9bc9c"},
]

# Au-delà, un dossier transmis qui n'a pas bougé mérite qu'on aille voir.
# Deux mois : le temps qu'un avocat accuse réception et engage la procédure.
SEUIL_DORMANCE = 60


def _nombre(valeur) -> float:
    """Lit un montant tel qu'il sort d'un tableur : « 1 280,50 », « 680 », 42.0."""
    if isinstance(valeur, (int, float)):
        return float(valeur)
    # Toutes les espaces, pas seulement l'ordinaire et l'insécable : Monday
    # sépare les milliers par une insécable *fine*, et ne retirer que les deux
    # premières ramenait ces montants-là à zéro.
    texte = "".join(
        caractere for caractere in str(valeur or "") if not caractere.isspace()
    ).replace("€", "").replace(",", ".")
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
    convention: str | None = None,
    diplome: str | None = None,
    echeance: str | None = None,
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

    # Ce que le tableau ne dit pas, le service le sait souvent. Ces trois
    # valeurs se saisissent donc à la main, et l'emportent ensuite sur ce que
    # l'export a lu : une chaîne vide efface la saisie et rend la main au
    # tableau, elle ne vaut pas « non ».
    for champ, valeur in (("convention", convention), ("diplome", diplome)):
        if valeur is not None:
            texte = str(valeur).strip()
            if texte:
                entree[champ] = texte
            else:
                entree.pop(champ, None)
    if echeance is not None:
        texte = _date_courte(echeance)
        if texte:
            entree["echeance"] = texte
        else:
            entree.pop("echeance", None)
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


def _jours_depuis(valeur, reference: datetime | None = None) -> int | None:
    date = _date_lisible(valeur)
    if date is None:
        return None
    return ((reference or datetime.now()) - date).days


def tranche_anciennete(jours: int | None) -> dict | None:
    if jours is None or jours < 0:
        return None
    for tranche in TRANCHES_ANCIENNETE:
        if tranche["min"] <= jours <= tranche["max"]:
            return tranche
    return TRANCHES_ANCIENNETE[-1]


def _oui_non(valeur) -> bool | None:
    """Vrai, faux, ou rien du tout. La lecture est celle de la note de
    synthèse, pour que les deux ne se contredisent jamais."""
    import synthese as module_synthese  # noqa: PLC0415 - import tardif, cycle

    return module_synthese._oui_non(valeur)


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
                # Exécution de la formation, telle que le tableau la connaît.
                # Trois états, jamais deux : ce que le tableau ne dit pas ne
                # doit pas se lire comme un « non ».
                # La saisie du service l'emporte sur ce que l'export a lu :
                # le tableau se tait souvent, le service sait.
                "convention_signee": _oui_non(
                    etat.get("convention") or rangee.get("convention_signee")),
                "diplome": _oui_non(etat.get("diplome") or rangee.get("diplome")),
                "convention_saisie": bool(etat.get("convention")),
                "diplome_saisi": bool(etat.get("diplome")),
                "heures_theoriques": (rangee.get("heures_theoriques") or "").strip(),
                "heures_log": (rangee.get("heures_log") or "").strip(),
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
                "date_echeance": (
                    etat.get("echeance") or rangee.get("date_echeance") or ""
                ).strip(),
                "echeance_saisie": bool(etat.get("echeance")),
                "anciennete_jours": _jours_depuis(
                    etat.get("echeance") or rangee.get("date_echeance")),
                # Jours écoulés depuis le dernier changement d'étape. None quand
                # le dossier n'a jamais bougé : ce n'est pas un dossier qui
                # dort, c'est un dossier qui n'est pas encore parti.
                "jours_sans_mouvement": _jours_depuis(
                    (etat.get("historique") or [{}])[-1].get("date")
                    if etat.get("historique") else None
                ),
                "date_contentieux_monday": (
                    rangee.get("date_contentieux") or "").strip(),
                "date_cloture_monday": (rangee.get("date_cloture") or "").strip(),
            }
        )

    return dossiers


def supprimer(
    racine_sortie: Path,
    chemin_suivi: Path,
    references: list[str],
    avec_fichiers: bool = False,
) -> dict:
    """Retire des dossiers de la liste, et de l'état de suivi.

    Les fichiers produits ne sont effacés que si on le demande : un dossier
    retiré de la liste par erreur se retrouve sur le disque, un répertoire
    supprimé ne revient pas. La suppression est refusée hors du répertoire
    d'export — un chemin venu d'un fichier n'a pas à pouvoir désigner
    n'importe où.
    """
    voulues = {reference.strip() for reference in references if reference.strip()}
    if not voulues:
        return {"retires": 0, "effaces": 0}

    recapitulatif = racine_sortie / "_recapitulatif.csv"
    retires: list[dict] = []
    if recapitulatif.exists():
        rangees = _lire_recapitulatif(recapitulatif)
        gardees = []
        for rangee in rangees:
            if (rangee.get("reference") or "").strip() in voulues:
                retires.append(rangee)
            else:
                gardees.append(rangee)
        if retires:
            entetes = list(rangees[0].keys())
            with recapitulatif.open("w", encoding="utf-8-sig", newline="") as fichier:
                redacteur = csv.DictWriter(fichier, entetes, delimiter=";")
                redacteur.writeheader()
                redacteur.writerows(gardees)

    suivi = charger(chemin_suivi)
    oublies = [reference for reference in voulues if reference in suivi]
    for reference in oublies:
        del suivi[reference]
    if oublies:
        enregistrer(chemin_suivi, suivi)

    effaces = 0
    if avec_fichiers:
        racine = racine_sortie.resolve()
        for rangee in retires:
            nom = (rangee.get("repertoire") or "").strip()
            if not nom:
                continue
            chemin = (racine_sortie / nom).resolve()
            # Le nom vient d'un fichier : il ne doit désigner qu'un
            # sous-répertoire de l'export, jamais l'export lui-même.
            if chemin == racine or racine not in chemin.parents:
                continue
            if chemin.is_dir():
                shutil.rmtree(chemin, ignore_errors=True)
                effaces += 1

    return {"retires": len(retires), "effaces": effaces,
            "oublies": len(oublies)}


def tranches_anciennete(dossiers: list[dict]) -> list[dict]:
    """Montant encore dû, par ancienneté de la créance.

    Sur les seuls dossiers non clôturés : une créance recouvrée n'a plus
    d'ancienneté, et la compter gonflerait les tranches les plus vieilles de
    tout ce qui a justement été réglé.
    """
    par_cle = {
        tranche["cle"]: dict(tranche, montant=0.0, nombre=0)
        for tranche in TRANCHES_ANCIENNETE
    }
    sans_echeance = {"montant": 0.0, "nombre": 0}

    for dossier in dossiers:
        if dossier["statut"] in CLOTURES:
            continue
        tranche = tranche_anciennete(dossier.get("anciennete_jours"))
        cible = par_cle[tranche["cle"]] if tranche else sans_echeance
        cible["montant"] += dossier["montant_du"]
        cible["nombre"] += 1

    resultat = [par_cle[tranche["cle"]] for tranche in TRANCHES_ANCIENNETE]
    if sans_echeance["nombre"]:
        # Jamais fondu dans une tranche : une échéance absente du tableau ne
        # doit pas passer pour une créance récente.
        resultat.append({
            "cle": "inconnue", "libelle": "Échéance non renseignée",
            "couleur": "#5a6070", **sans_echeance,
        })
    return resultat


def dormants(dossiers: list[dict], seuil: int = SEUIL_DORMANCE) -> list[dict]:
    """Dossiers transmis qui n'ont pas bougé depuis plus de `seuil` jours.

    Les dossiers jamais transmis en sont exclus : ils ne dorment pas, ils
    n'ont pas encore commencé — et les mêler ferait perdre de vue les vrais
    dossiers en souffrance.
    """
    retenus = [
        dossier
        for dossier in dossiers
        if dossier["statut"] not in CLOTURES
        and dossier["statut"] != STATUT_INITIAL
        and (dossier.get("jours_sans_mouvement") or 0) > seuil
    ]
    retenus.sort(key=lambda d: -(d.get("jours_sans_mouvement") or 0))
    return retenus


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


def tout_effacer(
    racine_sortie: Path,
    chemin_suivi: Path,
    avec_fichiers: bool = False,
    avec_suivi: bool = False,
) -> dict:
    """Remet l'application à zéro, en trois degrés séparés.

    Trois choses de nature différente, qu'on n'efface pas d'un même geste :

    - la **liste** des dossiers, toujours retirée. Elle se reconstitue en
      relançant un export ;
    - les **fichiers** produits — mails, pièces jointes, notes. Ils se
      refont aussi, mais l'export dure une heure ;
    - le **suivi** saisi à la main — étapes, dates, frais, notes. Celui-là
      ne se refait pas : il n'existe nulle part ailleurs.

    Chaque degré se demande à part, et le suivi n'est jamais emporté par
    l'effacement des fichiers.
    """
    references = [
        (rangee.get("reference") or "").strip()
        for rangee in _lire_recapitulatif(racine_sortie / "_recapitulatif.csv")
    ] if (racine_sortie / "_recapitulatif.csv").exists() else []

    resultat = supprimer(
        racine_sortie, chemin_suivi, references,
        avec_fichiers=avec_fichiers,
    ) if references else {"retires": 0, "effaces": 0, "oublies": 0}

    # Le récapitulatif vidé de ses lignes n'a plus lieu d'être.
    recapitulatif = racine_sortie / "_recapitulatif.csv"
    if recapitulatif.exists():
        recapitulatif.unlink()

    resultat["suivi_efface"] = 0
    if avec_suivi:
        restant = charger(chemin_suivi)
        resultat["suivi_efface"] = len(restant)
        enregistrer(chemin_suivi, {})

    return resultat


def _mediane(valeurs: list[float]) -> float:
    tries = sorted(valeurs)
    milieu = len(tries) // 2
    if len(tries) % 2:
        return tries[milieu]
    return (tries[milieu - 1] + tries[milieu]) / 2


def solidite(dossiers: list[dict]) -> dict:
    """Ce qui rend un dossier défendable, compté sur les dossiers en cours.

    Une convention signée et des heures suivies établissent que la prestation
    a été fournie. Un dossier auquel il manque la convention n'est pas
    forcément perdu, mais il ne part pas au tribunal dans le même état — d'où
    ce décompte, séparé de tout le reste.

    Le non renseigné est compté à part, jamais avec les « non » : le tableau
    qui se tait ne dit pas que la convention manque.
    """
    en_cours = [d for d in dossiers if d["statut"] not in CLOTURES]

    def repartir(champ: str) -> dict:
        return {
            "oui": sum(1 for d in en_cours if d.get(champ) is True),
            "non": sum(1 for d in en_cours if d.get(champ) is False),
            "inconnu": sum(1 for d in en_cours if d.get(champ) is None),
            "montant_non": sum(
                d["montant_du"] for d in en_cours if d.get(champ) is False
            ),
        }

    assidus = []
    for dossier in en_cours:
        prevu = _nombre(dossier.get("heures_theoriques"))
        fait = _nombre(dossier.get("heures_log"))
        if prevu > 0 and dossier.get("heures_log"):
            assidus.append(100 * fait / prevu)

    return {
        "nb_en_cours": len(en_cours),
        "convention": repartir("convention_signee"),
        "diplome": repartir("diplome"),
        # Vraie médiane : sur un nombre pair de dossiers, la moyenne des deux
        # valeurs centrales. Prendre la seconde ferait dire « 100 % » à un
        # portefeuille moitié à 50, moitié à 100.
        "assiduite_mediane": round(_mediane(assidus)) if assidus else None,
        "nb_assiduite": len(assidus),
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
        "solidite": solidite(dossiers),
        "nb_gagnes": len(gagnes),
        "nb_perdus": len(perdus),
        # Sur les seuls dossiers clos : un taux calculé sur l'ensemble ferait
        # passer pour des échecs les dossiers simplement encore en cours.
        "taux_reussite": (
            round(100 * len(gagnes) / len(clotures)) if clotures else None
        ),
        # Ce que coûte un euro recouvré. Les frais portent sur l'ensemble du
        # portefeuille, les montants récupérés sur les seuls dossiers clos :
        # le rapport dit ce que le recouvrement a coûté à ce jour, il ne
        # prédit pas ce que coûtera un dossier encore ouvert.
        "cout_par_euro": (
            round(
                sum(d["frais"] for d in dossiers)
                / sum(d["montant_du"] for d in gagnes), 3
            )
            if sum(d["montant_du"] for d in gagnes) else None
        ),
        "tranches_anciennete": tranches_anciennete(dossiers),
        "dormants": dormants(dossiers),
        "seuil_dormance": SEUIL_DORMANCE,
        "nb_jamais_transmis": sum(
            1 for d in dossiers if d["statut"] == STATUT_INITIAL
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
            1 for d in dossiers if d["statut"] == STATUT_INITIAL
            and d.get("mise_en_demeure", "") in ("non", "")
        ),
    }
