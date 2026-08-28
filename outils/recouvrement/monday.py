"""Téléchargement des documents stockés dans Monday (factures, conventions).

Les colonnes « fichier » d'un export Monday contiennent des adresses du type

    https://<compte>.monday.com/protected_static/<compte>/resources/<asset>/<nom>.pdf

qui ne sont pas librement accessibles : les ouvrir sans être authentifié
renvoie vers la page de connexion. Le chemin documenté consiste à demander à
l'API l'adresse temporaire signée de chaque ressource, puis à la télécharger —
c'est ce que fait ce module, en repérant l'identifiant de ressource dans
l'adresse figurant à l'export.

Un jeton d'accès personnel Monday est nécessaire. Il se crée depuis Monday :
avatar en haut à droite → Développeurs → Mes jetons d'accès.

Rappel de portée : un document tiré du tableau atteste de son existence, pas
de sa transmission au débiteur. Ces fichiers sont donc rangés à part des
pièces extraites des messages, qui seules établissent l'envoi.
"""

from __future__ import annotations

import json
import re
import unicodedata
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

API = "https://api.monday.com/v2"
VERSION_API = "2024-01"
DELAI = 30

# .../resources/144307098/FACT-2405-00030.pdf
IDENTIFIANT_RESSOURCE = re.compile(r"/resources/(\d+)/", re.IGNORECASE)

# Les adresses signées renvoyées par l'API expirent : inutile de les conserver.
TAILLE_MAX = 40 * 1024 * 1024


class ErreurMonday(RuntimeError):
    pass


def identifiant(url: str) -> str | None:
    """Identifiant de la ressource contenu dans une adresse Monday."""
    trouve = IDENTIFIANT_RESSOURCE.search(url or "")
    return trouve.group(1) if trouve else None


def nom_de_fichier(url: str, defaut: str = "document.pdf") -> str:
    morceau = (url or "").rstrip("/").split("/")[-1].split("?")[0]
    return morceau or defaut


def lire_jeton(chemin: Path) -> str:
    """Le jeton vit dans son propre fichier, jamais dans les préférences :
    c'est un secret, au même titre que les identifiants Gmail."""
    if not chemin.exists():
        return ""
    return chemin.read_text(encoding="utf-8").strip()


def _motif_http(exc: urllib.error.HTTPError) -> str:
    """Le motif que Monday place dans le corps d'une réponse en erreur.

    Le corps n'est lisible qu'une fois, et son format varie : `errors`,
    `error_message`, parfois du texte brut. Rien de tout cela ne doit faire
    échouer la lecture du motif — on cherche à expliquer une erreur, pas à en
    provoquer une seconde.
    """
    try:
        brut = exc.read().decode("utf-8", "replace").strip()
    except Exception:  # noqa: BLE001 - un motif absent n'est pas une panne
        return ""
    if not brut:
        return ""

    try:
        charge = json.loads(brut)
    except ValueError:
        return brut[:300]

    if isinstance(charge, dict):
        erreurs = charge.get("errors")
        if isinstance(erreurs, list) and erreurs:
            messages = [
                (e.get("message") if isinstance(e, dict) else str(e)) or ""
                for e in erreurs
            ]
            return "; ".join(m for m in messages if m)[:300]
        for cle in ("error_message", "message", "error"):
            if charge.get(cle):
                return str(charge[cle])[:300]
    return brut[:300]


def _appeler_api(requete: str, jeton: str) -> dict:
    corps = json.dumps({"query": requete}).encode("utf-8")
    demande = urllib.request.Request(
        API,
        data=corps,
        headers={
            "Authorization": jeton,
            "Content-Type": "application/json",
            "API-Version": VERSION_API,
        },
    )
    try:
        with urllib.request.urlopen(demande, timeout=DELAI) as reponse:  # noqa: S310
            charge = json.loads(reponse.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        # Monday explique le refus dans le corps de la réponse, pas dans le
        # code : un 400 nu ne dit ni quelle colonne pose problème, ni que le
        # budget de complexité est épuisé. Sans ce détail, il n'y a rien à
        # diagnostiquer.
        detail = "jeton refusé" if exc.code in (401, 403) else f"HTTP {exc.code}"
        motif = _motif_http(exc)
        raise ErreurMonday(
            f"Monday a refusé la requête ({detail})." + (f" {motif}" if motif else "")
        ) from exc
    except (urllib.error.URLError, TimeoutError, ValueError) as exc:
        raise ErreurMonday(f"Monday injoignable : {exc}") from exc

    if charge.get("errors"):
        messages = "; ".join(
            erreur.get("message", "?") for erreur in charge["errors"]
        )
        raise ErreurMonday(f"Monday a répondu par une erreur : {messages}")
    return charge.get("data") or {}


def adresses_signees(identifiants: list[str], jeton: str) -> dict[str, dict]:
    """Adresses temporaires, librement téléchargeables, des ressources."""
    if not identifiants:
        return {}

    liste = ", ".join(identifiants)
    donnees = _appeler_api(
        f"query {{ assets (ids: [{liste}]) {{ id name public_url }} }}", jeton
    )

    resultat = {}
    for ressource in donnees.get("assets") or []:
        if ressource.get("public_url"):
            resultat[str(ressource["id"])] = {
                "url": ressource["public_url"],
                "nom": ressource.get("name") or "",
            }
    return resultat


# Un compte Monday d'entreprise porte facilement plusieurs dizaines de
# tableaux. La liste est paginée, et le plafond n'existe que pour ne pas
# boucler indéfiniment si l'API se mettait à répondre toujours la même page.
TABLEAUX_PAR_PAGE = 100
PLAFOND_TABLEAUX = 1000


# En dessous, la lecture d'un gros tableau demanderait trop d'allers-retours.
MINIMUM_PAR_PAGE = 5

# Monday formule le dépassement de plusieurs façons selon la version d'API.
BUDGET_EPUISE = ("complexity", "complexité", "budget", "depth limit", "too large")


def _budget_epuise(exc: Exception) -> bool:
    """Le refus tient-il à la taille de la requête, et non à son contenu ?"""
    texte = str(exc).lower()
    return any(marqueur in texte for marqueur in BUDGET_EPUISE)


FILTRE_REFUSE = ("query_params", "rules", "compare_value", "operator", "column_id")


def _filtre_refuse(exc: Exception) -> bool:
    """Le refus porte-t-il sur le filtre transmis à Monday ?"""
    texte = str(exc).lower()
    return any(marqueur in texte for marqueur in FILTRE_REFUSE)


def _colonne_par_titre(identifiant: str, jeton: str, titre: str) -> str:
    """L'identifiant technique d'une colonne, depuis son intitulé.

    Le filtre de l'API ne connaît que « status_1 », jamais « Etape process
    recouvrement ». La comparaison ignore accents et casse, comme le filtre
    local : les deux doivent désigner la même colonne, sans quoi le tri
    côté Monday et le tri local ne diraient pas la même chose.
    """
    voulu = _sans_accent(titre)
    try:
        colonnes = colonnes_du_tableau(identifiant, jeton)
    except ErreurMonday:
        return ""
    for colonne_id, intitule in colonnes.items():
        if _sans_accent(intitule) == voulu:
            return colonne_id
    return ""


def _sans_accent(texte: str) -> str:
    decompose = unicodedata.normalize("NFKD", texte or "")
    return "".join(
        c for c in decompose if not unicodedata.combining(c)
    ).strip().lower()


def _est_sous_elements(tableau: dict) -> bool:
    """Le tableau technique que Monday crée pour les sous-éléments.

    Le champ `type` tranche quand l'API le renvoie. Le nom sert de repli : une
    version d'API qui l'omettrait laisserait sinon repasser ces tableaux, et
    l'intitulé « Sous-éléments de … » est imposé par Monday, non saisi.
    """
    if str(tableau.get("type") or "").lower() == "sub_items_board":
        return True
    nom = (tableau.get("name") or "").strip().lower()
    return nom.startswith("sous-éléments de ") or nom.startswith("subitems of ")


def lister_tableaux(jeton: str) -> list[dict]:
    """Tous les tableaux accessibles avec ce jeton, du premier au dernier.

    La pagination est suivie jusqu'au bout : s'arrêter à la première page
    masquerait des tableaux sans le dire, et l'utilisateur chercherait en vain
    celui qu'il vient d'ouvrir dans Monday.
    """
    trouves: list[dict] = []
    vus: set[str] = set()
    page = 1

    while len(trouves) < PLAFOND_TABLEAUX:
        donnees = _appeler_api(
            f"query {{ boards (limit: {TABLEAUX_PAR_PAGE}, page: {page}, "
            "state: active, order_by: used_at) "
            "{ id name type workspace { name } } }",
            jeton,
        )
        lot = donnees.get("boards") or []
        nouveaux = 0
        for tableau in lot:
            identifiant = str(tableau.get("id") or "")
            if not identifiant or identifiant in vus:
                continue
            vus.add(identifiant)
            nouveaux += 1
            # Monday crée en coulisses un tableau par colonne de sous-éléments.
            # Personne ne l'ouvre jamais : le proposer double la liste de
            # doublons apparents, dont il faut deviner qu'ils ne servent à
            # rien. Comptés comme vus pour ne pas relancer la pagination.
            if _est_sous_elements(tableau):
                continue
            espace = (tableau.get("workspace") or {}).get("name") or ""
            trouves.append({
                "id": identifiant,
                "nom": tableau.get("name") or identifiant,
                "espace": espace,
            })

        # On s'arrête sur une page incomplète, mais aussi sur une page qui
        # n'apporte rien de neuf : une API qui renverrait indéfiniment le même
        # lot ferait tourner cette boucle sans fin, le plafond portant sur le
        # nombre de tableaux retenus et non sur celui des pages demandées.
        if len(lot) < TABLEAUX_PAR_PAGE or nouveaux == 0:
            break
        page += 1

    # Les tableaux sont numérotés dans Monday (« 1.2. Entreprise -
    # Recouvrement ») : l'ordre alphabétique est donc leur ordre naturel, et
    # bien plus utile que l'ordre de dernière consultation.
    trouves.sort(key=lambda tableau: (tableau["espace"].lower(), tableau["nom"].lower()))
    return trouves


def _valeur_colonne(colonne: dict) -> str:
    """Le texte d'une cellule, quel que soit son type.

    `text` couvre les colonnes simples ; pour un fichier, il est vide et
    l'adresse ne se trouve que dans la valeur brute. Sans ce repli, les
    colonnes « Facture PDF » et « Convention Signée » reviendraient vides et
    les documents ne seraient jamais téléchargés.
    """
    texte = (colonne.get("text") or "").strip()
    if texte:
        return texte

    brut = colonne.get("value")
    if not brut:
        return ""
    try:
        charge = json.loads(brut)
    except ValueError:
        return ""

    fichiers = charge.get("files") if isinstance(charge, dict) else None
    if isinstance(fichiers, list):
        adresses = [
            fichier.get("public_url") or fichier.get("url") or ""
            for fichier in fichiers
            if isinstance(fichier, dict)
        ]
        return ", ".join(adresse for adresse in adresses if adresse)
    return ""


def _ligne_element(element: dict, nom_tableau: str) -> dict[str, str]:
    """Un élément Monday, sous forme de colonnes nommées.

    « Monday ID » n'est reconnu comme aucun champ : il voyage avec la ligne
    sans rien perturber, et c'est lui qui relie ensuite le dossier à son
    historique d'étapes.
    """
    ligne = {
        "Name": element.get("name") or "",
        "Monday ID": str(element.get("id") or ""),
        "Monday tableau": nom_tableau,
    }
    for colonne in element.get("column_values") or []:
        titre = ((colonne.get("column") or {}).get("title") or "").strip()
        if titre:
            ligne[titre] = _valeur_colonne(colonne)
    return ligne


def _regles_filtre(colonne_id: str, valeurs: list[str]) -> str:
    """Le filtre, écrit dans la langue de l'API Monday.

    `contains_text` plutôt qu'une comparaison stricte : une étiquette de statut
    se lit « 🔴 Dossier à faire passer en contentieux », emoji compris, et
    exiger l'égalité ne ramènerait rien. Plusieurs valeurs sont reliées par
    « ou », comme le fait le filtre local.
    """
    regles = ", ".join(
        f'{{column_id: "{colonne_id}", '
        f'compare_value: "{_echapper_graphql(valeur)}", operator: contains_text}}'
        for valeur in valeurs
    )
    return f"query_params: {{rules: [{regles}], operator: or}}"


def _echapper_graphql(texte: str) -> str:
    return (texte or "").replace("\\", "\\\\").replace('"', '\\"')


def lire_tableau(
    identifiant: str,
    jeton: str,
    par_page: int = 100,
    avec_sous_elements: bool = False,
    filtre: tuple[str, list[str]] | None = None,
) -> list[tuple[int, list[str]]]:
    """Le contenu d'un tableau Monday, sous la forme d'une grille.

    Même forme qu'un export Excel lu depuis le disque — ligne d'en-tête puis
    lignes de données — pour que la suite du traitement ne fasse aucune
    différence entre un tableau lu en direct et un fichier déposé à la main.

    La pagination est suivie jusqu'au bout : un tableau de recouvrement
    dépasse largement une page, et s'arrêter à la première produirait
    silencieusement un lot incomplet.

    Avec `avec_sous_elements`, chaque sous-élément donne une ligne de plus,
    qui hérite des colonnes de son parent partout où elle n'a rien à dire :
    une facture rangée en sous-élément porte son numéro et son montant, mais
    c'est l'élément parent qui porte le nom et l'adresse de l'apprenante.
    """
    entetes: list[str] = []
    lignes: list[dict[str, str]] = []
    curseur: str | None = None
    sous = (
        " subitems { id name column_values { column { title } text value } }"
        if avec_sous_elements
        else ""
    )

    # Filtrer chez Monday plutôt qu'ici : sur un tableau de plusieurs milliers
    # de lignes dont une poignée sont au contentieux, tout rapatrier pour en
    # écarter 99 % coûte des minutes d'attente — et fait dépasser le budget de
    # complexité de l'API. Le filtre local reste en place derrière, il n'est
    # plus qu'une sécurité.
    regles = ""
    if filtre:
        titre, valeurs = filtre
        valeurs = [v.strip() for v in valeurs if v and v.strip()]
        if titre.strip() and valeurs:
            colonne_id = _colonne_par_titre(identifiant, jeton, titre)
            if colonne_id:
                regles = _regles_filtre(colonne_id, valeurs)

    while True:
        arguments = [f"limit: {int(par_page)}"]
        if curseur:
            # Un curseur porte déjà le filtre de la requête qui l'a produit :
            # le répéter est refusé par l'API.
            arguments.append(f'cursor: "{curseur}"')
        elif regles:
            arguments.append(regles)
        page = f"items_page ({', '.join(arguments)})"
        try:
            donnees = _appeler_api(
                f"query {{ boards (ids: [{int(identifiant)}]) {{ name "
                f"{page} {{ cursor items {{ id name column_values {{ "
                f"column {{ title }} text value }}{sous} }} }} }} }}",
                jeton,
            )
        except ErreurMonday as exc:
            # Un tableau large épuise le budget de complexité de l'API : la
            # même requête, demandée par plus petits paquets, passe. Un curseur
            # reste valable après un changement de taille de page, la lecture
            # reprend donc où elle s'était arrêtée.
            # Le filtre côté Monday est un gain de temps, pas une nécessité :
            # si l'API le refuse, on relit sans lui et le filtre local fait le
            # tri. Un tableau lu lentement vaut mieux qu'un tableau non lu.
            if regles and _filtre_refuse(exc):
                regles = ""
                continue
            if not _budget_epuise(exc) or par_page <= MINIMUM_PAR_PAGE:
                raise
            par_page = max(MINIMUM_PAR_PAGE, int(par_page) // 4)
            continue

        tableaux = donnees.get("boards") or []
        if not tableaux:
            raise ErreurMonday(
                f"Tableau {identifiant} introuvable, ou inaccessible avec ce jeton."
            )

        nom_tableau = (tableaux[0].get("name") or "").strip()
        contenu = tableaux[0].get("items_page") or {}
        for element in contenu.get("items") or []:
            ligne = _ligne_element(element, nom_tableau)
            lignes.append(ligne)
            for sous_element in (element.get("subitems") or []) if avec_sous_elements else []:
                # Le parent d'abord, le sous-élément par-dessus : ce que le
                # sous-élément renseigne l'emporte, le reste est hérité. Une
                # valeur vide n'écrase rien — elle n'apprend rien.
                fille = dict(ligne)
                fille["Monday parent"] = ligne["Monday ID"]
                for cle, valeur in _ligne_element(sous_element, nom_tableau).items():
                    if valeur or cle not in fille:
                        fille[cle] = valeur
                lignes.append(fille)

        curseur = contenu.get("cursor")
        if not curseur:
            break

    # Union ordonnée des colonnes : un sous-élément n'a pas les mêmes que son
    # parent, et une colonne vue seulement à la centième ligne doit exister
    # dans l'en-tête, sinon sa valeur serait perdue sans un mot.
    for ligne in lignes:
        for cle in ligne:
            if cle not in entetes:
                entetes.append(cle)

    if not entetes:
        raise ErreurMonday(f"Le tableau {identifiant} ne contient aucun élément.")

    grille = [(1, entetes)]
    grille += [
        (numero, [ligne.get(cle, "") for cle in entetes])
        for numero, ligne in enumerate(lignes, start=2)
    ]
    return grille


def _horodatage(valeur) -> datetime | None:
    """Date d'une entrée de journal Monday.

    `created_at` y est un entier de dix-sept chiffres : des microsecondes
    multipliées par dix. Le lire comme des secondes daterait tous les
    changements d'étape de l'an 500 millions.
    """
    texte = str(valeur or "").strip().strip('"')
    if not texte:
        return None

    if texte.isdigit():
        nombre = int(texte)
        # 10^17 pour 2023 en dix-millionièmes de seconde, 10^10 en secondes.
        for diviseur in (10_000_000, 1_000_000, 1_000, 1):
            secondes = nombre / diviseur
            if 946_684_800 < secondes < 4_102_444_800:  # 2000 -> 2100
                return datetime.fromtimestamp(secondes, tz=timezone.utc)
        return None

    try:
        return datetime.fromisoformat(texte.replace("Z", "+00:00"))
    except ValueError:
        return None


def _etiquette(valeur) -> str:
    """Le libellé lisible d'une valeur de colonne « statut »."""
    if isinstance(valeur, str):
        try:
            valeur = json.loads(valeur)
        except ValueError:
            return valeur.strip()
    if isinstance(valeur, dict):
        etiquette = valeur.get("label")
        if isinstance(etiquette, dict):
            return str(etiquette.get("text") or "").strip()
        if isinstance(etiquette, str):
            return etiquette.strip()
        return str(valeur.get("text") or "").strip()
    return ""


def colonnes_du_tableau(identifiant: str, jeton: str) -> dict[str, str]:
    """Identifiant technique -> intitulé, pour chaque colonne du tableau.

    Le journal d'activité ne cite que l'identifiant technique de la colonne
    (« status_1 ») : sans cette table, impossible de savoir laquelle porte
    l'étape du process.
    """
    donnees = _appeler_api(
        f"query {{ boards (ids: [{int(identifiant)}]) {{ columns {{ id title }} }} }}",
        jeton,
    )
    tableaux = donnees.get("boards") or []
    if not tableaux:
        return {}
    return {
        str(colonne.get("id")): (colonne.get("title") or "").strip()
        for colonne in (tableaux[0].get("columns") or [])
        if colonne.get("id")
    }


def historique_colonne(
    identifiant: str,
    jeton: str,
    titre_colonne: str,
    depuis: datetime | None = None,
    pages_max: int = 20,
) -> dict[str, list[dict]]:
    """Changements d'étape, ligne par ligne : quand, de quoi, vers quoi.

    Retourne, pour chaque élément du tableau, la liste de ses changements
    triés du plus ancien au plus récent.

    Attention à la portée : Monday ne conserve le journal d'activité que sur
    une période limitée selon l'abonnement. Un historique vide ne veut donc
    pas dire qu'il ne s'est rien passé, mais que rien n'en est resté — c'est
    dit dans la note plutôt que passé sous silence.
    """
    if not titre_colonne.strip():
        return {}

    intitules = colonnes_du_tableau(identifiant, jeton)
    vise = titre_colonne.strip().lower()
    concernees = {
        cle for cle, titre in intitules.items() if titre.strip().lower() == vise
    }
    if not concernees:
        return {}

    borne = ""
    if depuis is not None:
        borne = f', from: "{depuis.date().isoformat()}"'

    historique: dict[str, list[dict]] = {}
    vus: set[str] = set()

    for page in range(1, pages_max + 1):
        donnees = _appeler_api(
            f"query {{ boards (ids: [{int(identifiant)}]) {{ activity_logs "
            f"(limit: 500, page: {page}{borne}) "
            "{ id event data created_at } } }",
            jeton,
        )
        tableaux = donnees.get("boards") or []
        if not tableaux:
            break
        entrees = tableaux[0].get("activity_logs") or []

        nouvelles = 0
        for entree in entrees:
            cle = str(entree.get("id") or "")
            if cle and cle in vus:
                continue
            if cle:
                vus.add(cle)
            nouvelles += 1

            if entree.get("event") != "update_column_value":
                continue
            try:
                charge = json.loads(entree.get("data") or "{}")
            except ValueError:
                continue
            if str(charge.get("column_id")) not in concernees:
                continue

            element = str(charge.get("pulse_id") or "")
            vers = _etiquette(charge.get("value"))
            if not element or not vers:
                continue

            historique.setdefault(element, []).append({
                "date": _horodatage(entree.get("created_at")),
                "de": _etiquette(charge.get("previous_value")),
                "vers": vers,
            })

        if len(entrees) < 500 or nouvelles == 0:
            break

    for changements in historique.values():
        changements.sort(key=lambda c: c["date"] or datetime.min.replace(tzinfo=timezone.utc))
    return historique


def telecharger(url: str, destination: Path) -> int:
    destination.parent.mkdir(parents=True, exist_ok=True)
    try:
        with urllib.request.urlopen(url, timeout=DELAI) as reponse:  # noqa: S310
            contenu = reponse.read(TAILLE_MAX + 1)
    except (urllib.error.URLError, TimeoutError) as exc:
        raise ErreurMonday(f"Téléchargement impossible : {exc}") from exc

    if len(contenu) > TAILLE_MAX:
        raise ErreurMonday("Document trop volumineux (plus de 40 Mo).")
    if not contenu:
        raise ErreurMonday("Document vide.")

    destination.write_bytes(contenu)
    return len(contenu)


def recuperer_documents(
    liens: list[str], jeton: str, repertoire: Path
) -> tuple[list[str], list[str]]:
    """Télécharge les documents Monday d'un dossier.

    Retourne les noms écrits et les échecs. Un échec n'interrompt jamais
    l'export : il vaut mieux un dossier complet des échanges avec une facture
    manquante, signalée, qu'un export interrompu.
    """
    identifiants, sans_identifiant = [], []
    for lien in liens:
        trouve = identifiant(lien)
        if trouve:
            identifiants.append(trouve)
        else:
            sans_identifiant.append(f"{lien} (identifiant de ressource introuvable)")

    if not identifiants:
        return [], sans_identifiant

    try:
        adresses = adresses_signees(identifiants, jeton)
    except ErreurMonday as exc:
        return [], sans_identifiant + [str(exc)]

    ecrits, echecs = [], list(sans_identifiant)
    noms_utilises: set[str] = set()

    for lien in liens:
        cle = identifiant(lien)
        if cle is None:
            continue
        ressource = adresses.get(cle)
        if ressource is None:
            echecs.append(f"ressource {cle} inaccessible (droits ou suppression)")
            continue

        nom = ressource["nom"] or nom_de_fichier(lien)
        if nom in noms_utilises:
            nom = f"{cle}_{nom}"
        noms_utilises.add(nom)

        try:
            telecharger(ressource["url"], repertoire / nom)
        except ErreurMonday as exc:
            echecs.append(f"{nom} : {exc}")
        else:
            ecrits.append(nom)

    return ecrits, echecs
