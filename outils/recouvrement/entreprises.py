"""Fiche d'identité des débiteurs entreprises, depuis l'annuaire public.

L'API `recherche-entreprises.api.gouv.fr` est le service ouvert de l'État qui
sert l'Annuaire des Entreprises (annuaire-entreprises.data.gouv.fr). Elle est
gratuite, sans compte ni clé, et rend les données publiques du répertoire
Sirene : forme juridique, date de création, effectif, et surtout **l'état
administratif** — une société radiée ne paiera pas, et c'est la première chose
à savoir avant d'engager des frais d'avocat.

Ce module ne calcule pas une solvabilité : ces données ne la donnent pas. Il
range les débiteurs par ce que l'annuaire en dit, et signale les situations
qui changent la conduite d'un dossier. Le score qui en sort est un ordre de
priorité, à relire — jamais une décision.

Rien n'est envoyé : seule la raison sociale du débiteur part en requête, et
le résultat est conservé sur le poste pour ne pas réinterroger le service à
chaque ouverture.
"""

from __future__ import annotations

import json
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime
from pathlib import Path

API = "https://recherche-entreprises.api.gouv.fr/search"
FICHE_PUBLIQUE = "https://annuaire-entreprises.data.gouv.fr/entreprise/"
DELAI = 15


class ErreurAnnuaire(RuntimeError):
    pass


# Catégories juridiques de l'INSEE, regroupées par ce qui compte au
# recouvrement : de qui peut-on obtenir paiement, et sur quel patrimoine.
# Le code complet est à quatre chiffres ; les familles se lisent sur les deux
# premiers, à quelques exceptions près qui méritent leur propre ligne.
FORMES_EXACTES = {
    "1000": "Entrepreneur individuel",
    "5710": "SAS",
    "5720": "SASU",
    "5499": "SARL",
    "5498": "SARL",
    "5410": "SARL",
    "6540": "SCI",
    "5385": "Société en commandite",
}
FAMILLES = (
    ("54", "SARL"),
    ("57", "SAS"),
    ("55", "SA"),
    ("52", "SNC"),
    ("53", "Société en commandite"),
    ("58", "Société européenne"),
    ("65", "Société civile"),
    ("92", "Association"),
    ("73", "Établissement public"),
    ("41", "Autre personne morale"),
    ("10", "Entrepreneur individuel"),
)

# Une société radiée ne paiera pas : c'est le seul état qui change vraiment la
# conduite d'un dossier, et l'annuaire ne connaît que ces deux-là.
ETATS = {"A": "en activité", "C": "cessée"}


def forme_lisible(code: str) -> str:
    """« 5710 » devient « SAS ». Un code inconnu est rendu tel quel."""
    brut = str(code or "").strip()
    if not brut:
        return ""
    if brut in FORMES_EXACTES:
        return FORMES_EXACTES[brut]
    for prefixe, libelle in FAMILLES:
        if brut.startswith(prefixe):
            return libelle
    return f"Forme {brut}"


def _aplatir(texte: str) -> str:
    decompose = unicodedata.normalize("NFKD", str(texte or "").strip().lower())
    sans_accent = "".join(c for c in decompose if not unicodedata.combining(c))
    return " ".join(sans_accent.split())


# Un débiteur particulier n'a pas de fiche au répertoire des entreprises : lui
# en chercher une ramènerait la première société au nom approchant, ce qui est
# pire que rien. Deux mots capitalisés sans forme juridique ni mention
# commerciale : on s'abstient.
MENTIONS_SOCIETE = (
    "sarl", "sas", "sasu", "sa ", "eurl", "sci", "snc", "scop", "sarlu",
    "societe", "ste ", "entreprise", "groupe", "holding", "association",
    "cabinet", "agence", "atelier", "compagnie", "consulting", "conseil",
    "services", "solutions", "france", "international", "&", "etablissements",
)


def ressemble_a_une_societe(nom: str) -> bool:
    """Le nom porte-t-il une mention commerciale explicite ?

    Sert à nuancer, pas à filtrer : « JAADI PERFORM » est une société sans
    qu'aucune mention ne le dise, et l'écarter d'office priverait la moitié
    des dossiers de leur fiche. Une correspondance retenue sans mention est
    donc signalée comme à vérifier, et la fiche publique est toujours citée
    en lien — c'est elle qui tranche, pas cette fonction.
    """
    plat = _aplatir(nom)
    if not plat:
        return False
    if any(mention in f" {plat} " for mention in MENTIONS_SOCIETE):
        return True
    # Un nom tout en majuscules qui n'est pas un simple « Prénom Nom ».
    mots = plat.split()
    return len(mots) == 1 and len(plat) > 3


def _appeler(nom: str) -> dict:
    parametres = urllib.parse.urlencode(
        {"q": nom, "per_page": 1, "page": 1, "minimal": "false"}
    )
    demande = urllib.request.Request(
        f"{API}?{parametres}",
        headers={"Accept": "application/json", "User-Agent": "liora-contentieux"},
    )
    try:
        with urllib.request.urlopen(demande, timeout=DELAI) as reponse:  # noqa: S310
            return json.loads(reponse.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        raise ErreurAnnuaire(
            f"L'annuaire des entreprises a refusé la requête (HTTP {exc.code})."
        ) from exc
    except (urllib.error.URLError, TimeoutError, ValueError) as exc:
        raise ErreurAnnuaire(f"Annuaire injoignable : {exc}") from exc


def chercher(nom: str) -> dict | None:
    """La fiche publique du débiteur, ou rien s'il n'en a pas.

    Rien plutôt qu'une approximation : le premier résultat n'est retenu que
    si son nom correspond réellement à celui du débiteur. L'annuaire répond
    toujours quelque chose, et prendre sa première réponse au hasard
    attribuerait à un dossier la situation d'une société sans rapport.
    """
    if len(_aplatir(nom)) < 3:
        return None

    donnees = _appeler(nom)
    resultats = donnees.get("results") or []
    if not resultats:
        return None

    fiche = resultats[0]
    trouve = _aplatir(fiche.get("nom_complet") or fiche.get("nom_raison_sociale"))
    voulu = _aplatir(nom)
    if trouve != voulu and voulu not in trouve and trouve not in voulu:
        return None

    siren = str(fiche.get("siren") or "")
    return {
        "siren": siren,
        "nom": fiche.get("nom_complet") or fiche.get("nom_raison_sociale") or nom,
        "forme": forme_lisible(fiche.get("nature_juridique")),
        "forme_code": str(fiche.get("nature_juridique") or ""),
        "etat": ETATS.get(str(fiche.get("etat_administratif") or ""), "inconnu"),
        "date_creation": fiche.get("date_creation") or "",
        "effectif": str(fiche.get("tranche_effectif_salarie") or ""),
        "categorie": fiche.get("categorie_entreprise") or "",
        "ville": ((fiche.get("siege") or {}).get("libelle_commune") or ""),
        "fiche": f"{FICHE_PUBLIQUE}{siren}" if siren else "",
        # Un nom sans mention commerciale peut désigner une personne : la
        # correspondance est alors plausible, pas certaine, et doit se
        # vérifier d'un clic plutôt que se croire.
        "a_verifier": not ressemble_a_une_societe(nom) or trouve != voulu,
        "consulte_le": datetime.now().strftime("%d/%m/%Y"),
    }


def charger_annuaire(chemin: Path) -> dict[str, dict]:
    if not chemin.exists():
        return {}
    try:
        donnees = json.loads(chemin.read_text(encoding="utf-8"))
    except (ValueError, OSError):
        return {}
    return donnees if isinstance(donnees, dict) else {}


def enregistrer_annuaire(chemin: Path, donnees: dict[str, dict]) -> None:
    try:
        chemin.write_text(
            json.dumps(donnees, ensure_ascii=False, indent=2, sort_keys=True),
            encoding="utf-8",
        )
    except OSError:
        pass


# Ce que l'annuaire permet de dire, et rien de plus. Ce n'est pas une note de
# solvabilité : les comptes ne sont pas ici. C'est un ordre de priorité, fondé
# sur ce qui rend un recouvrement plus ou moins probable.
POINTS = {
    "cessee": 60,
    "jeune": 15,
    "sans_salarie": 10,
    "creance_ancienne": 15,
    "sans_fiche": 10,
    "montant_eleve": 10,
}
SEUIL_JEUNE_ANNEES = 3
SEUIL_CREANCE_JOURS = 365
SEUIL_MONTANT = 10_000


def evaluer(dossier: dict, fiche: dict | None) -> dict:
    """Le risque que ce dossier ne se recouvre pas, et ce qui le motive.

    Chaque point compté est nommé : un score qu'on ne peut pas justifier
    devant un supérieur ne sert à rien, et celui-ci se relit ligne à ligne.
    """
    motifs: list[str] = []
    score = 0

    if fiche is None:
        score += POINTS["sans_fiche"]
        motifs.append("aucune fiche au répertoire des entreprises")
    else:
        if fiche.get("etat") == "cessée":
            score += POINTS["cessee"]
            motifs.append("société cessée au répertoire — recouvrement compromis")

        creation = _annee(fiche.get("date_creation"))
        if creation and datetime.now().year - creation < SEUIL_JEUNE_ANNEES:
            score += POINTS["jeune"]
            motifs.append(f"société créée en {creation}, peu d'antériorité")

        if fiche.get("effectif") in {"NN", "00", ""}:
            score += POINTS["sans_salarie"]
            motifs.append("aucun salarié déclaré")

    anciennete = dossier.get("anciennete_jours")
    if anciennete and anciennete > SEUIL_CREANCE_JOURS:
        score += POINTS["creance_ancienne"]
        motifs.append(f"créance échue depuis {anciennete} jours")

    if (dossier.get("montant_du") or 0) >= SEUIL_MONTANT:
        score += POINTS["montant_eleve"]
        motifs.append("montant élevé : l'enjeu justifie une procédure")

    return {"score": min(score, 100), "motifs": motifs}


def _annee(valeur: str) -> int | None:
    texte = str(valeur or "")[:4]
    return int(texte) if texte.isdigit() else None


def repartition(dossiers: list[dict], annuaire: dict[str, dict]) -> dict:
    """Les débiteurs en contentieux, rangés par forme juridique.

    Les dossiers clôturés sont exclus : ils ne sont plus à recouvrer, et les
    compter fausserait la lecture de ce qui reste à faire.
    """
    en_cours = [d for d in dossiers if not d.get("clos")]

    par_forme: dict[str, dict] = {}
    cessees: list[dict] = []
    sans_fiche = 0

    for dossier in en_cours:
        fiche = annuaire.get(dossier["reference"]) or None
        forme = (fiche or {}).get("forme") or "Non identifiée"
        if fiche is None:
            sans_fiche += 1

        case = par_forme.setdefault(
            forme, {"forme": forme, "nombre": 0, "montant": 0.0, "cessees": 0}
        )
        case["nombre"] += 1
        case["montant"] += dossier.get("montant_du") or 0.0

        if fiche and fiche.get("etat") == "cessée":
            case["cessees"] += 1
            cessees.append({
                "reference": dossier["reference"],
                "nom": dossier.get("nom") or "",
                "montant": dossier.get("montant_du") or 0.0,
                "siren": fiche.get("siren", ""),
                "fiche": fiche.get("fiche", ""),
            })

    formes = sorted(par_forme.values(), key=lambda c: -c["montant"])
    return {
        "formes": formes,
        "nb_debiteurs": len(en_cours),
        "sans_fiche": sans_fiche,
        "cessees": sorted(cessees, key=lambda c: -c["montant"]),
        "montant_cesse": sum(c["montant"] for c in cessees),
    }
