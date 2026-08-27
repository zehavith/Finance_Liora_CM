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
import urllib.error
import urllib.request
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
        detail = "jeton refusé" if exc.code in (401, 403) else f"HTTP {exc.code}"
        raise ErreurMonday(f"Monday a refusé la requête ({detail}).") from exc
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


def lister_tableaux(jeton: str, limite: int = 50) -> list[dict]:
    """Les tableaux accessibles avec ce jeton : identifiant et nom."""
    donnees = _appeler_api(
        f"query {{ boards (limit: {int(limite)}, order_by: used_at) "
        "{ id name } }",
        jeton,
    )
    return [
        {"id": str(tableau["id"]), "nom": tableau.get("name") or str(tableau["id"])}
        for tableau in (donnees.get("boards") or [])
        if tableau.get("id")
    ]


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


def lire_tableau(identifiant: str, jeton: str, par_page: int = 100) -> list[tuple[int, list[str]]]:
    """Le contenu d'un tableau Monday, sous la forme d'une grille.

    Même forme qu'un export Excel lu depuis le disque — ligne d'en-tête puis
    lignes de données — pour que la suite du traitement ne fasse aucune
    différence entre un tableau lu en direct et un fichier déposé à la main.

    La pagination est suivie jusqu'au bout : un tableau de recouvrement
    dépasse largement une page, et s'arrêter à la première produirait
    silencieusement un lot incomplet.
    """
    entetes: list[str] = []
    lignes: list[list[str]] = []
    curseur: str | None = None

    while True:
        page = (
            f'items_page (limit: {int(par_page)}, cursor: "{curseur}")'
            if curseur
            else f"items_page (limit: {int(par_page)})"
        )
        donnees = _appeler_api(
            f"query {{ boards (ids: [{int(identifiant)}]) {{ "
            f"{page} {{ cursor items {{ name column_values {{ "
            "column { title } text value } } } } } }",
            jeton,
        )

        tableaux = donnees.get("boards") or []
        if not tableaux:
            raise ErreurMonday(
                f"Tableau {identifiant} introuvable, ou inaccessible avec ce jeton."
            )

        contenu = tableaux[0].get("items_page") or {}
        for element in contenu.get("items") or []:
            colonnes = element.get("column_values") or []
            if not entetes:
                entetes = ["Name"] + [
                    ((colonne.get("column") or {}).get("title") or "").strip()
                    for colonne in colonnes
                ]
            lignes.append(
                [element.get("name") or ""]
                + [_valeur_colonne(colonne) for colonne in colonnes]
            )

        curseur = contenu.get("cursor")
        if not curseur:
            break

    if not entetes:
        raise ErreurMonday(f"Le tableau {identifiant} ne contient aucun élément.")

    grille = [(1, entetes)]
    grille += [(numero, ligne) for numero, ligne in enumerate(lignes, start=2)]
    return grille


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
