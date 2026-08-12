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
