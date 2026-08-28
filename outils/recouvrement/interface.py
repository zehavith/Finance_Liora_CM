#!/usr/bin/env python3
"""Interface graphique locale de l'outil d'export.

Lance un petit serveur sur la machine, ouvre le navigateur dessus, et permet
de déposer le fichier des dossiers puis de suivre l'export à l'écran — sans
ligne de commande.

    python interface.py

Pourquoi un serveur local plutôt qu'une simple page HTML : un navigateur seul
ne peut ni s'authentifier auprès de Gmail ni écrire des fichiers sur le
disque. La page n'est qu'un panneau de commande ; tout le travail reste ici,
sur le poste. Rien n'est exposé au réseau : l'écoute se fait uniquement sur
127.0.0.1, et chaque appel doit porter un jeton tiré au hasard au démarrage,
que seule la page servie connaît.
"""

from __future__ import annotations

import base64
import csv
import html
import os
import json
import secrets
import subprocess
import sys
import threading
import time
import webbrowser
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import export_mails  # noqa: E402
from gmail_api import ErreurGmail  # noqa: E402
from dossiers import ErreurDossiers  # noqa: E402
from rendu import moteur_pdf_disponible  # noqa: E402
import suivi as module_suivi  # noqa: E402

RACINE = Path(__file__).resolve().parent
# Affiché dans l'en-tête. Au téléphone, savoir quelle version tourne vaut
# mieux que deviner d'après la présence d'un champ à l'écran.
VERSION = "45"
PREFERENCES = RACINE / "interface-preferences.json"
# Le suivi vit à côté de l'outil, pas dans l'export : refaire un export
# ne doit pas effacer l'état d'avancement des dossiers.
SUIVI = RACINE / "suivi-dossiers.json"
# Secret au même titre que les identifiants Gmail : fichier dédié,
# jamais renvoyé à la page, jamais mêlé aux préférences.
JETON_MONDAY = RACINE / "monday-token.txt"
# Liora s'appelait DataScientest : les relances les plus anciennes partent
# encore de ce domaine, et sans lui elles passeraient pour des messages reçus.
DOMAINES_PAR_DEFAUT = "datascientest.com"
# Les deux tableaux de recouvrement qualifient le passage au contentieux dans
# la même colonne, mais avec deux libellés distincts : celui des entreprises
# « fait passer », celui des financements personnels « transmet ». Les deux
# sont proposés d'emblée, la comparaison retenant l'un ou l'autre.
# Le groupe fait foi : une facture passe au contentieux quand on la range
# dans « 1.2.5 Service contentieux » ou « 2.1.6. Facture en Contentieux ».
# La colonne d'étape, elle, garde son étiquette longtemps après — sur les
# tableaux de Liora elle ramenait cinquante-trois lignes là où les groupes en
# comptent une poignée. Elle reste disponible, vide par défaut.
FILTRE_COLONNE_PAR_DEFAUT = ""
FILTRE_VALEUR_PAR_DEFAUT = ""
# Ces valeurs ont été proposées par défaut dans les versions précédentes.
# Retrouvées telles quelles, elles n'ont jamais été choisies : elles sont
# retirées une fois, au profit du groupe. Une valeur modifiée est respectée.
ANCIENS_FILTRES = {
    "filtre_colonne": {"Etape process recouvrement"},
    "filtre_valeur": {
        "Dossier à faire passer en contentieux,"
        "Dossier à transmettre au service contentieux",
    },
}
# Ces deux tableaux sont le travail courant du service : ils se cochent seuls
# au premier listage, pour que « Lister mes tableaux » suffise à être prêt.
# Le repérage se fait sur le numéro, qui ne bouge pas, plutôt que sur le nom
# complet, qu'un renommage ferait glisser. Une fois le choix enregistré, il
# fait foi : décocher l'un des deux tient, et rien n'est recoché de force.
CHANTIERS_PAR_DEFAUT = ("1.2.", "2.1.")
# Une facture est aussi qualifiée en la glissant dans un groupe : « 1.2.5
# Service contentieux » côté entreprises, « 2.1.6. Facture en Contentieux »
# côté financement personnel. Le mot commun suffit à désigner les deux.
GROUPES_PAR_DEFAUT = "contentieux"
# Cases de l'onglet Export mémorisées d'une session à l'autre, avec leur
# valeur au tout premier lancement. La simulation est cochée au départ : on
# ne lance pas un premier export réel sans avoir compté ce qu'il ramènera.
CASES_MEMORISEES = {
    "simulation": True,
    "ignorer": True,
    "regrouper": True,
    "sousdossiers": True,
    "sousdossiersadresse": False,
    "decouvrir": True,
    "souselements": False,
    "sansnav": False,
    "reprendre": False,
    "majdossiers": False,
}
EXTENSIONS_ACCEPTEES = {".xlsx", ".xlsm", ".csv"}
TAILLE_MAX_FICHIER = 25 * 1024 * 1024


def sortie_par_defaut() -> Path:
    """Hors de OneDrive : l'export contient des données personnelles, et la
    synchronisation d'un dossier volumineux provoque des erreurs d'écriture."""
    if sys.platform == "win32":
        return Path.home() / "recouvrement-export"
    return Path.cwd() / "export"


def lire_preferences() -> dict:
    if not PREFERENCES.exists():
        return {}
    try:
        valeurs = json.loads(PREFERENCES.read_text(encoding="utf-8"))
    except (ValueError, OSError):
        return {}
    return _migrer_preferences(valeurs) if isinstance(valeurs, dict) else {}


def _migrer_preferences(valeurs: dict) -> dict:
    """Retire les filtres proposés par les versions précédentes.

    Ils avaient été mis là par défaut, jamais choisis. Le groupe désigne
    désormais les dossiers au contentieux, et la colonne d'étape ramenait
    par-dessus tout ce qui en porte encore l'étiquette. Une valeur que
    l'utilisateur a modifiée n'est pas touchée, et la migration n'a lieu
    qu'une fois.
    """
    modifie = None
    # Retrouver l'adresse depuis le numéro de facture était une option ; elle
    # est devenue le comportement normal. Une case laissée décochée l'avait
    # été par défaut, pas par choix : on l'active une fois.
    if not valeurs.get("decouverte_activee"):
        options = dict(valeurs.get("options") or {})
        if not options.get("decouvrir"):
            options["decouvrir"] = True
            modifie = dict(valeurs)
            modifie["options"] = options
        modifie = modifie or dict(valeurs)
        modifie["decouverte_activee"] = True
        ecrire_preferences(modifie)
        valeurs = modifie

    if valeurs.get("filtres_migres"):
        return valeurs
    if not any(
        valeurs.get(cle, "").strip() in anciennes
        for cle, anciennes in ANCIENS_FILTRES.items()
    ):
        return valeurs

    modifie = dict(valeurs)
    for cle, anciennes in ANCIENS_FILTRES.items():
        if modifie.get(cle, "").strip() in anciennes:
            modifie[cle] = ""
    modifie["filtres_migres"] = True
    modifie.setdefault("groupes", GROUPES_PAR_DEFAUT)
    ecrire_preferences(modifie)
    return modifie


def ecrire_preferences(valeurs: dict) -> None:
    try:
        PREFERENCES.write_text(
            json.dumps(valeurs, ensure_ascii=False, indent=2), encoding="utf-8"
        )
    except OSError:
        pass


def memoriser_preferences(nouvelles: dict) -> None:
    """Met à jour les préférences sans effacer les autres clés."""
    valeurs = lire_preferences()
    valeurs.update(nouvelles)
    ecrire_preferences(valeurs)


def dernier_import(preferences: dict | None = None) -> dict | None:
    """Le fichier déposé au dernier export, s'il est toujours là.

    Un fichier supprimé à la main entre deux sessions ne doit pas laisser un
    rappel qui promet un lancement impossible.
    """
    memoire = (preferences or lire_preferences()).get("import")
    if not isinstance(memoire, dict) or not memoire.get("fichier"):
        return None
    chemin = RACINE / Path(str(memoire["fichier"])).name
    if not chemin.exists():
        return None
    return {
        "nom": memoire.get("nom") or chemin.name,
        "date": memoire.get("date") or "",
        "taille": chemin.stat().st_size,
    }


def cases_memorisees(preferences: dict | None = None) -> dict:
    """État des cases à cocher, complété par les valeurs de premier lancement."""
    enregistrees = (preferences or lire_preferences()).get("options")
    valeurs = dict(CASES_MEMORISEES)
    if isinstance(enregistrees, dict):
        for cle in valeurs:
            if cle in enregistrees:
                valeurs[cle] = bool(enregistrees[cle])
    return valeurs


def _attribut(valeur) -> str:
    return html.escape(str(valeur or ""), quote=True)


def _cases_json(preferences: dict) -> str:
    return json.dumps(cases_memorisees(preferences))


def _dernier_import_json(preferences: dict) -> str:
    memoire = dernier_import(preferences)
    # `<` échappé : le nom vient du poste de l'utilisateur et atterrit dans
    # une balise <script>.
    return json.dumps(memoire, ensure_ascii=False).replace("<", "\\u003c")


class Execution:
    """État d'un export : ses lignes de journal et son issue.

    Un seul export à la fois — la sortie standard et les jetons d'accès sont
    des ressources uniques, et deux exports concurrents écriraient dans le
    même répertoire.
    """

    def __init__(self):
        self._verrou = threading.Lock()
        self.lignes: list[str] = []
        self.en_cours = False
        self.termine = False
        self.code: int | None = None
        self.erreur: str | None = None
        self.sortie: str = ""

    def ajouter(self, message: str) -> None:
        with self._verrou:
            self.lignes.append(message)

    def etat(self, depuis: int) -> dict:
        with self._verrou:
            return {
                "lignes": self.lignes[depuis:],
                "total": len(self.lignes),
                "en_cours": self.en_cours,
                "termine": self.termine,
                "code": self.code,
                "erreur": self.erreur,
                "sortie": self.sortie,
            }

    def lancer(self, arguments: list[str], sortie: str) -> None:
        with self._verrou:
            if self.en_cours:
                raise RuntimeError("Un export est déjà en cours.")
            self.lignes = []
            self.en_cours = True
            self.termine = False
            self.code = None
            self.erreur = None
            self.sortie = sortie

        def travail() -> None:
            try:
                options = export_mails.analyser_arguments(arguments)
                code = export_mails.executer(options, relais=self.ajouter)
            except (ErreurDossiers, ErreurGmail) as exc:
                self.ajouter(f"Erreur : {exc}")
                code, message = 2, str(exc)
            except SystemExit as exc:  # argparse en cas d'argument invalide
                self.ajouter(f"Erreur d'argument : {exc}")
                code, message = 2, str(exc)
            except Exception as exc:  # noqa: BLE001 - remonté tel quel à l'écran
                self.ajouter(f"Erreur inattendue : {exc}")
                code, message = 3, str(exc)
            else:
                message = None

            with self._verrou:
                self.en_cours = False
                self.termine = True
                self.code = code
                self.erreur = message

        threading.Thread(target=travail, daemon=True).start()


EXECUTION = Execution()
JETON = secrets.token_urlsafe(24)

# Lancée depuis le raccourci, l'application n'a plus de fenêtre à fermer :
# sans cette veille, chaque ouverture laisserait un processus caché de plus.
# Le délai est confortable — un rechargement de page ou une pause dans la
# navigation ne doit pas couper l'outil sous les pieds.
DELAI_INACTIVITE = 180.0
_dernier_contact = time.monotonic()


def signaler_activite() -> None:
    global _dernier_contact  # noqa: PLW0603
    _dernier_contact = time.monotonic()


def _veiller(serveur) -> None:
    """Arrête le serveur quand plus aucune page ne l'interroge.

    Un export en cours l'emporte toujours : fermer l'onglet ne doit pas
    interrompre un traitement de vingt minutes, il se termine et le serveur
    s'arrête ensuite.
    """
    while True:
        time.sleep(15)
        if EXECUTION.en_cours:
            signaler_activite()
            continue
        if time.monotonic() - _dernier_contact > DELAI_INACTIVITE:
            threading.Thread(target=serveur.shutdown, daemon=True).start()
            return


def construire_arguments(demande: dict, chemin_dossiers: Path) -> tuple[list[str], str]:
    sortie = (demande.get("sortie") or "").strip() or str(sortie_par_defaut())
    arguments = ["--dossiers", str(chemin_dossiers), "--sortie", sortie]

    boites = (demande.get("boites") or "").strip()
    if boites:
        arguments += ["--boites", boites]
    if demande.get("simulation"):
        arguments.append("--simulation")
    if demande.get("ignorer_lignes_incompletes"):
        arguments.append("--ignorer-lignes-incompletes")
    if demande.get("sans_navigateur"):
        arguments.append("--sans-navigateur")
    if demande.get("sans_regroupement"):
        arguments.append("--sans-regroupement")
    if demande.get("sans_sous_dossiers"):
        arguments.append("--sans-sous-dossiers")
    if demande.get("sous_dossiers_par_adresse"):
        arguments.append("--sous-dossiers-par-adresse")
    if not demande.get("decouvrir_adresses", True):
        arguments.append("--sans-decouverte-adresses")
    if demande.get("sous_elements"):
        arguments.append("--avec-sous-elements")

    domaines = (demande.get("domaines") or "").strip()
    if domaines:
        arguments += ["--domaines-internes", domaines]

    tableau = (demande.get("tableau") or "").strip()
    if tableau:
        arguments += ["--tableau-monday", tableau]

    groupes = (demande.get("groupes") or "").strip()
    if groupes:
        arguments += ["--groupes-monday", groupes]

    regles = (demande.get("regimes_echeance") or "").strip()
    if regles:
        arguments += ["--regles-echeance", regles]

    colonne = (demande.get("filtre_colonne") or "").strip()
    valeur = (demande.get("filtre_valeur") or "").strip()
    if colonne and valeur:
        arguments += ["--filtre-colonne", colonne, "--filtre-valeur", valeur]
    if demande.get("sans_spam"):
        arguments.append("--sans-spam")
    if demande.get("reprendre"):
        arguments.append("--reprendre")
    if demande.get("mettre_a_jour"):
        arguments.append("--mettre-a-jour")
    if demande.get("sans_synthese"):
        arguments.append("--sans-synthese")

    seulement = (demande.get("seulement") or "").strip()
    if seulement:
        arguments += ["--seulement", seulement]

    return arguments, sortie


class Gestionnaire(BaseHTTPRequestHandler):
    server_version = "ExportRecouvrement/1.0"

    def log_message(self, format, *args):  # noqa: A002 - signature imposée
        return  # Le journal HTTP n'apporte rien et brouille la console.

    # -- utilitaires -----------------------------------------------------
    def _repondre(self, code: int, corps: bytes, type_mime: str) -> None:
        self.send_response(code)
        self.send_header("Content-Type", type_mime)
        self.send_header("Content-Length", str(len(corps)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(corps)

    def _json(self, code: int, valeur: dict) -> None:
        self._repondre(
            code, json.dumps(valeur, ensure_ascii=False).encode("utf-8"),
            "application/json; charset=utf-8",
        )

    def _jeton_valide(self) -> bool:
        signaler_activite()
        """Une autre page ouverte dans le navigateur pourrait tenter d'appeler
        ce serveur ; sans le jeton, elle n'obtient rien."""
        return secrets.compare_digest(self.headers.get("X-Jeton", ""), JETON)

    def _corps_json(self) -> dict:
        longueur = int(self.headers.get("Content-Length") or 0)
        if longueur <= 0 or longueur > TAILLE_MAX_FICHIER + 4096:
            raise ValueError("Requête vide ou trop volumineuse.")
        return json.loads(self.rfile.read(longueur).decode("utf-8"))

    # -- routes ----------------------------------------------------------
    def do_GET(self) -> None:  # noqa: N802 - signature imposée
        chemin = self.path.split("?")[0]

        if chemin == "/":
            page = PAGE.replace("__JETON__", JETON)
            page = page.replace("__MOTEUR_PDF__", moteur_pdf_disponible())
            page = page.replace("__VERSION__", VERSION)
            preferences = lire_preferences()
            page = page.replace(
                "__ETAT_MONDAY__",
                "déjà enregistré — laissez vide pour le conserver"
                if JETON_MONDAY.exists()
                else "collez le jeton ici (facultatif)",
            )
            # Sans jeton, « Lister mes tableaux » ne peut qu'échouer. Le dire
            # à l'ouverture épargne un clic qui a tout l'air d'un bouton mort.
            page = page.replace(
                "__INVITE_TABLEAUX__",
                "Cliquez sur « Lister mes tableaux »."
                if JETON_MONDAY.exists()
                else "Le jeton Monday n'est pas encore enregistré : "
                     "renseignez-le en section 2 ci-dessous, puis cliquez sur "
                     "« Lister mes tableaux ».",
            )
            # Ces valeurs atterrissent dans des attributs HTML : elles
            # viennent du poste, mais un guillemet suffirait à casser la page.
            page = page.replace(
                "__BOITES__", _attribut(preferences.get("boites", ""))
            ).replace(
                "__SORTIE__",
                _attribut(preferences.get("sortie", str(sortie_par_defaut()))),
            )
            # Le fichier importé reste sur le disque, mais un navigateur ne
            # peut pas repeupler un champ de fichier : sans ce rappel, rouvrir
            # l'application donne l'impression que l'import s'est perdu.
            page = page.replace("__IMPORT__", _dernier_import_json(preferences))
            page = page.replace(
                "__DOMAINES__",
                _attribut(preferences.get("domaines", DOMAINES_PAR_DEFAUT)),
            ).replace(
                "__SEULEMENT__", _attribut(preferences.get("seulement", ""))
            ).replace(
                "__FILTRE_COLONNE__",
                _attribut(preferences.get("filtre_colonne", FILTRE_COLONNE_PAR_DEFAUT)),
            ).replace(
                "__FILTRE_VALEUR__",
                _attribut(preferences.get("filtre_valeur", FILTRE_VALEUR_PAR_DEFAUT)),
            ).replace(
                "__GROUPES__",
                _attribut(preferences.get("groupes", GROUPES_PAR_DEFAUT)),
            ).replace(
                # Objet JSON inséré tel quel dans le script : `<` échappé,
                # le nom d'un tableau n'a rien à faire dans une balise.
                "__REGIMES__",
                json.dumps(preferences.get("regimes_echeance") or {},
                           ensure_ascii=False).replace("<", "\\u003c"),
            ).replace(
                "__TABLEAU__", _attribut(preferences.get("tableau", ""))
            ).replace(
                "__CHANTIERS__",
                json.dumps(CHANTIERS_PAR_DEFAUT, ensure_ascii=False),
            ).replace(
                "__CHANTIERS_PROPOSES__",
                "true" if preferences.get("chantiers_proposes") else "false",
            ).replace("__OPTIONS__", _cases_json(preferences))
            self._repondre(200, page.encode("utf-8"), "text/html; charset=utf-8")
            return

        if chemin == "/api/vivant":
            # Battement de cœur de la page : c'est lui qui distingue une
            # application encore ouverte d'un onglet refermé.
            if not self._jeton_valide():
                self._json(403, {"erreur": "Jeton invalide."})
                return
            self._json(200, {"vivant": True})
            return

        if chemin == "/api/dossiers":
            if not self._jeton_valide():
                self._json(403, {"erreur": "Jeton invalide."})
                return
            racine = Path(lire_preferences().get("sortie") or sortie_par_defaut())
            dossiers = module_suivi.inventaire(racine, SUIVI)
            self._json(200, {
                "dossiers": dossiers,
                "agregats": module_suivi.agreger(dossiers),
                "statuts": module_suivi.STATUTS,
                "sortie": str(racine),
            })
            return

        if chemin == "/api/journal":
            if not self._jeton_valide():
                self._json(403, {"erreur": "Jeton invalide."})
                return
            depuis = 0
            if "?" in self.path:
                for morceau in self.path.split("?", 1)[1].split("&"):
                    if morceau.startswith("depuis="):
                        depuis = int(morceau[7:] or 0)
            self._json(200, EXECUTION.etat(depuis))
            return

        self._json(404, {"erreur": "Inconnu."})

    def do_POST(self) -> None:  # noqa: N802 - signature imposée
        if not self._jeton_valide():
            self._json(403, {"erreur": "Jeton invalide."})
            return

        chemin = self.path.split("?")[0]
        try:
            if chemin == "/api/lancer":
                self._lancer(self._corps_json())
                return
            if chemin == "/api/ouvrir":
                self._ouvrir(self._corps_json())
                return
            if chemin == "/api/suivi":
                self._enregistrer_suivi(self._corps_json())
                return
            if chemin == "/api/reglages":
                self._enregistrer_reglages(self._corps_json())
                return
            if chemin == "/api/tableaux":
                self._lister_tableaux(self._corps_json())
                return
            if chemin == "/api/etape":
                self._dater_etape(self._corps_json())
                return
            if chemin == "/api/supprimer":
                self._supprimer_dossiers(self._corps_json())
                return
            if chemin == "/api/tout-effacer":
                self._tout_effacer(self._corps_json())
                return
        except ValueError as exc:
            self._json(400, {"erreur": str(exc)})
            return

        self._json(404, {"erreur": "Inconnu."})

    def _enregistrer_reglages(self, demande: dict) -> None:
        """Mémorise les champs et les cases de l'onglet Export.

        Appelé au fil de la saisie et à la fermeture de la page : rien n'est à
        refaire d'une session à l'autre, et une page fermée sans avoir lancé
        d'export ne perd pas ce qui vient d'être renseigné.
        """
        valeurs = {
            cle: str(demande.get(cle) or "").strip()
            for cle in ("boites", "sortie", "domaines", "seulement",
                        "filtre_colonne", "filtre_valeur", "tableau",
                        "groupes")
            if cle in demande
        }

        # Une fois les tableaux courants proposés, ils ne le sont plus jamais :
        # sans cette trace, décocher l'un des deux serait défait au listage
        # suivant.
        if demande.get("chantiers_proposes"):
            valeurs["chantiers_proposes"] = True
        # Une fois la page servie, les anciens filtres sont derrière nous :
        # ce que la page renvoie fait foi, y compris un champ vidé à la main.
        valeurs["filtres_migres"] = True

        regimes = demande.get("regimes_echeance")
        if isinstance(regimes, str) and regimes:
            valeurs["regimes_echeance"] = {
                cle.strip(): valeur.strip()
                for morceau in regimes.split(",") if "=" in morceau
                for cle, valeur in [morceau.split("=", 1)]
            }

        options = demande.get("options")
        if isinstance(options, dict):
            valeurs["options"] = {
                cle: bool(valeur)
                for cle, valeur in options.items()
                if cle in CASES_MEMORISEES
            }

        if valeurs:
            memoriser_preferences(valeurs)

        # Le jeton reste dans son propre fichier, jamais dans les préférences.
        jeton = str(demande.get("jeton_monday") or "").strip()
        if jeton:
            self._ecrire_jeton_monday(jeton)

        self._json(200, {"enregistre": True})

    @staticmethod
    def _ecrire_jeton_monday(jeton: str) -> None:
        try:
            JETON_MONDAY.write_text(jeton, encoding="utf-8")
            os.chmod(JETON_MONDAY, 0o600)
        except OSError:
            pass

    def _supprimer_dossiers(self, demande: dict) -> None:
        """Retire des dossiers de la liste, et de l'état de suivi.

        Les fichiers ne sont effacés que si la page le demande explicitement :
        c'est le seul geste de l'application qui ne se rattrape pas.
        """
        references = demande.get("references")
        if not isinstance(references, list) or not references:
            raise ValueError("Aucun dossier à supprimer.")

        preferences = lire_preferences()
        sortie = Path(preferences.get("sortie") or sortie_par_defaut())
        resultat = module_suivi.supprimer(
            sortie, SUIVI,
            [str(reference) for reference in references],
            avec_fichiers=bool(demande.get("fichiers")),
        )
        self._json(200, resultat)

    def _tout_effacer(self, demande: dict) -> None:
        """Remise à zéro, en trois degrés que la page demande séparément.

        La confirmation est portée dans la requête plutôt que déduite : une
        remise à zéro déclenchée par un appel malformé serait irrattrapable.
        """
        if demande.get("confirme") != "EFFACER":
            raise ValueError("Effacement non confirmé.")

        preferences = lire_preferences()
        sortie = Path(preferences.get("sortie") or sortie_par_defaut())
        resultat = module_suivi.tout_effacer(
            sortie, SUIVI,
            avec_fichiers=bool(demande.get("fichiers")),
            avec_suivi=bool(demande.get("suivi")),
        )
        self._json(200, resultat)

    def _lister_tableaux(self, demande: dict) -> None:
        """Les tableaux Monday accessibles, pour que le choix se fasse dans
        une liste plutôt qu'en recopiant un identifiant à la main."""
        import monday as module_monday  # noqa: PLC0415

        jeton = str(demande.get("jeton_monday") or "").strip()
        if jeton:
            self._ecrire_jeton_monday(jeton)
        else:
            jeton = module_monday.lire_jeton(JETON_MONDAY)

        if not jeton:
            self._json(400, {
                "erreur": (
                    "Renseignez d'abord le jeton Monday, en section 2, puis "
                    "recommencez."
                )
            })
            return

        try:
            tableaux = module_monday.lister_tableaux(jeton)
        except module_monday.ErreurMonday as exc:
            self._json(400, {"erreur": str(exc)})
            return

        self._json(200, {"tableaux": tableaux})

    def _depot_manuel(self, demande: dict) -> Path:
        """Recherche ponctuelle : les deux critères saisis à la main tiennent
        lieu de fichier des dossiers, sans rien préparer dans Monday."""
        email = (demande.get("email") or "").strip()
        facture = (demande.get("facture") or "").strip()
        nom = (demande.get("nom_dossier") or "").strip()

        if not email and not facture:
            raise ValueError(
                "Indiquez au moins une adresse mail ou un numéro de facture."
            )

        depot = RACINE / "dossiers-depose.csv"
        with depot.open("w", encoding="utf-8-sig", newline="") as fichier:
            redacteur = csv.writer(fichier, delimiter=";")
            redacteur.writerow(["reference", "nom", "email", "facture"])
            redacteur.writerow(["", nom, email, facture])
        return depot

    def _lancer(self, demande: dict) -> None:
        if demande.get("mode") == "monday":
            tableau = str(demande.get("tableau") or "").strip()
            if not tableau:
                self._json(400, {"erreur": "Choisissez un tableau Monday."})
                return
            # Le tableau est lu par l'API : le chemin de fichier n'est là que
            # pour satisfaire la ligne de commande, il n'est jamais ouvert.
            self._demarrer(demande, RACINE / "dossiers.csv", f"tableau Monday {tableau}")
            return

        if demande.get("mode") == "manuel":
            try:
                depot = self._depot_manuel(demande)
            except ValueError as exc:
                self._json(400, {"erreur": str(exc)})
                return
            self._demarrer(demande, depot, "saisie manuelle")
            return

        if demande.get("reutiliser"):
            memoire = lire_preferences().get("import") or {}
            depot = RACINE / Path(str(memoire.get("fichier") or "")).name
            if not memoire.get("fichier") or not depot.exists():
                self._json(400, {
                    "erreur": (
                        "Le fichier importé précédemment est introuvable. "
                        "Déposez-le à nouveau."
                    )
                })
                return
            self._demarrer(demande, depot, memoire.get("nom") or depot.name)
            return

        nom = Path((demande.get("nom") or "").strip()).name
        if not nom:
            self._json(400, {"erreur": "Aucun fichier reçu."})
            return
        if Path(nom).suffix.lower() not in EXTENSIONS_ACCEPTEES:
            self._json(
                400,
                {
                    "erreur": (
                        f"Format non pris en charge ({Path(nom).suffix or 'sans extension'}). "
                        "Attendu : .xlsx, .xlsm ou .csv."
                    )
                },
            )
            return

        try:
            contenu = base64.b64decode(demande.get("contenu") or "", validate=True)
        except (ValueError, TypeError):
            self._json(400, {"erreur": "Fichier illisible."})
            return
        if not contenu:
            self._json(400, {"erreur": "Fichier vide."})
            return
        if len(contenu) > TAILLE_MAX_FICHIER:
            self._json(400, {"erreur": "Fichier trop volumineux (25 Mo maximum)."})
            return

        # Le fichier déposé est conservé sous un nom fixe, à côté de l'outil :
        # on peut ainsi le rouvrir pour vérifier ce qui a réellement été lu.
        depot = RACINE / f"dossiers-depose{Path(nom).suffix.lower()}"
        depot.write_bytes(contenu)
        memoriser_preferences({
            "import": {
                "fichier": depot.name,
                "nom": nom,
                "date": datetime.now().strftime("%d/%m/%Y à %H:%M"),
            }
        })
        self._demarrer(demande, depot, nom)

    def _demarrer(self, demande: dict, depot: Path, origine: str) -> None:
        jeton = (demande.get("jeton_monday") or "").strip()
        if jeton:
            self._ecrire_jeton_monday(jeton)

        arguments, sortie = construire_arguments(demande, depot)
        try:
            EXECUTION.lancer(arguments, sortie)
        except RuntimeError as exc:
            self._json(409, {"erreur": str(exc)})
            return

        memoriser_preferences({
            "boites": demande.get("boites", ""),
            "sortie": sortie,
            "domaines": (demande.get("domaines") or "").strip(),
            "filtre_colonne": (demande.get("filtre_colonne") or "").strip(),
            "filtre_valeur": (demande.get("filtre_valeur") or "").strip(),
            "tableau": (demande.get("tableau") or "").strip(),
        })
        self._json(200, {"demarre": True, "fichier": origine, "sortie": sortie})

    def _enregistrer_suivi(self, demande: dict) -> None:
        reference = (demande.get("reference") or "").strip()
        if not reference:
            self._json(400, {"erreur": "Référence de dossier manquante."})
            return
        try:
            donnees = module_suivi.charger(SUIVI)
            entree = module_suivi.mettre_a_jour(
                donnees,
                reference,
                statut=demande.get("statut"),
                frais=demande.get("frais"),
                note=demande.get("note"),
                date_etape=demande.get("date_etape"),
            )
            module_suivi.enregistrer(SUIVI, donnees)
        except ValueError as exc:
            self._json(400, {"erreur": str(exc)})
            return
        except OSError as exc:
            self._json(500, {"erreur": f"Enregistrement impossible : {exc}"})
            return
        self._json(200, {"enregistre": True, "dossier": entree})

    def _dater_etape(self, demande: dict) -> None:
        """Corrige la date d'une étape, ou la retire si la date est vidée."""
        reference = (demande.get("reference") or "").strip()
        if not reference:
            self._json(400, {"erreur": "Référence de dossier manquante."})
            return
        try:
            rang = int(demande.get("rang"))
        except (TypeError, ValueError):
            self._json(400, {"erreur": "Étape inconnue."})
            return

        try:
            donnees = module_suivi.charger(SUIVI)
            entree = module_suivi.dater_etape(
                donnees, reference, rang, str(demande.get("date") or "")
            )
            module_suivi.enregistrer(SUIVI, donnees)
        except ValueError as exc:
            self._json(400, {"erreur": str(exc)})
            return
        except OSError as exc:
            self._json(500, {"erreur": f"Enregistrement impossible : {exc}"})
            return

        self._json(200, {
            "enregistre": True,
            "dossier": entree,
            "parcours": module_suivi.parcours_dossier(entree),
        })

    def _ouvrir(self, demande: dict) -> None:
        cible = Path((demande.get("chemin") or "").strip() or sortie_par_defaut())
        if not cible.exists():
            self._json(400, {"erreur": f"{cible} n'existe pas encore."})
            return
        try:
            if sys.platform == "win32":
                subprocess.Popen(["explorer", str(cible)])  # noqa: S603, S607
            elif sys.platform == "darwin":
                subprocess.Popen(["open", str(cible)])  # noqa: S603, S607
            else:
                subprocess.Popen(["xdg-open", str(cible)])  # noqa: S603, S607
        except OSError as exc:
            self._json(500, {"erreur": str(exc)})
            return
        self._json(200, {"ouvert": str(cible)})


PAGE = r"""<!DOCTYPE html>
<html lang="fr"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Export recouvrement</title>
<style>
:root{
  --accent:#F47458; --accent-fonce:#e05a40;
  --fond:#0b0e1a; --fond-2:#111631; --carte:rgba(17,22,49,.85);
  --champ:rgba(255,255,255,.04);
  --texte:#eef0f6; --texte-2:#8b92a5; --texte-3:#555d75;
  --bord:rgba(99,102,241,.18); --bord-actif:rgba(244,116,88,.55);
  --vert:#84cc16; --rouge:#ef4444; --jaune:#eab308;
}
*{box-sizing:border-box}
body{margin:0;background:var(--fond);color:var(--texte);
  font-family:Inter,-apple-system,Segoe UI,Roboto,sans-serif;font-size:14px;line-height:1.55}
header{background:var(--fond-2);border-bottom:1px solid var(--bord);padding:18px 28px;
  display:flex;align-items:center;gap:14px;flex-wrap:wrap}
.logo{font-size:20px;font-weight:800;color:var(--accent);letter-spacing:-.5px}
.titre{font-size:20px;font-weight:600}
.moteur{margin-left:auto;color:var(--texte-3);font-size:12px}
main{max-width:1000px;margin:0 auto;padding:28px}
h2{font-size:15px;margin:0 0 4px;font-weight:600}
.aide{color:var(--texte-2);font-size:12.5px;margin:0 0 14px}
section{background:var(--carte);border:1px solid var(--bord);border-radius:14px;
  padding:22px;margin-bottom:18px}
#zone{border:2px dashed var(--bord);border-radius:12px;padding:34px;text-align:center;
  cursor:pointer;transition:.15s;background:rgba(255,255,255,.015)}
#zone:hover,#zone.survol{border-color:var(--bord-actif);background:rgba(244,116,88,.06)}
#zone.rempli{border-style:solid;border-color:var(--vert)}
.fleche{font-size:26px;color:var(--texte-3)}
#nomFichier{font-weight:600;color:var(--vert)}
.grille{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:16px}
nav.principal{display:flex;gap:26px;padding:0 28px;background:var(--fond-2);
  border-bottom:1px solid var(--bord)}
nav.principal button{background:none;border:none;border-radius:0;color:var(--texte-2);
  font-size:14px;padding:13px 0;border-bottom:2px solid transparent}
nav.principal button.actif{color:var(--accent);border-bottom-color:var(--accent)}
.vue{display:none} .vue.actif{display:block}
.tuiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(165px,1fr));gap:14px;
  margin-bottom:20px}
.tuile{background:var(--carte);border:1px solid var(--bord);border-radius:12px;padding:16px}
.tuile .lib{font-size:11.5px;color:var(--texte-2);margin-bottom:7px;
  display:flex;align-items:center;gap:6px}
.tuile .val{font-size:23px;font-weight:700;letter-spacing:-.5px}
.tuile .sous{font-size:11px;color:var(--texte-3);margin-top:3px}
.pastille{width:9px;height:9px;border-radius:2px;flex-shrink:0}
table.donnees{width:100%;border-collapse:collapse;font-size:12.5px}
table.donnees th{text-align:left;font-weight:600;color:var(--texte-2);font-size:11px;
  text-transform:uppercase;letter-spacing:.4px;padding:9px 8px;
  border-bottom:1px solid var(--bord)}
table.donnees td{padding:9px 8px;border-bottom:1px solid rgba(99,102,241,.07);
  vertical-align:middle}
table.donnees tr:hover td{background:rgba(255,255,255,.02)}
table.donnees .num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
table.donnees th.etroite{width:26px}
.defilable{overflow-x:auto}
.barre-selection{display:flex;align-items:center;gap:13px;margin-bottom:13px}
.barre-selection span{font-size:12px;color:var(--texte-3)}
.secondaire.danger{border-color:rgba(239,68,68,.4);color:#ef6a6a}
.secondaire.danger:hover{border-color:#ef6a6a;background:rgba(239,68,68,.08)}
.etat{white-space:nowrap;font-size:12px}
.etat.oui{color:#5cc95c}
.etat.non{color:#ef6a6a}
.etat.inconnu{color:var(--texte-3)}
.solide{margin:17px 0}
.solide-titre{font-size:12.5px;color:var(--texte-2);margin-bottom:7px}
.solide-barre{display:flex;height:15px;border-radius:5px;overflow:hidden;
  background:var(--fond-2)}
.solide-barre span.oui{background:#0ca30c}
.solide-barre span.non{background:#d03b3b}
.solide-barre span.inconnu{background:#3a4157}
.solide-legende{display:flex;gap:19px;margin-top:7px;font-size:11.5px;
  color:var(--texte-3);flex-wrap:wrap}
.solide-legende b.oui{color:#5cc95c}
.solide-legende b.non{color:#ef6a6a}
.solide-legende b.inconnu{color:var(--texte-3)}
select,input.frais,input.note{background:var(--champ);border:1px solid var(--bord);
  border-radius:7px;padding:6px 8px;color:var(--texte);font-size:12.5px;font-family:inherit}
select{min-width:172px} input.frais{width:88px;text-align:right} input.note{width:100%}
select:focus,input.frais:focus,input.note:focus{outline:none;border-color:var(--bord-actif)}
.etat-pastille{display:inline-flex;align-items:center;gap:6px;white-space:nowrap}
.lien{color:var(--accent);cursor:pointer;text-decoration:none;font-size:12px}
.lien:hover{text-decoration:underline}
.lien.inactif{color:var(--texte-3);cursor:default;text-decoration:none}
.vide{color:var(--texte-2);padding:34px;text-align:center;font-size:13px}
.graphe{background:var(--carte);border:1px solid var(--bord);border-radius:12px;padding:20px}
.graphe h3{margin:0 0 3px;font-size:14px;font-weight:600}
.graphe .aide{margin-bottom:16px}
.barres{display:flex;flex-direction:column;gap:2px}
.rangee{display:grid;grid-template-columns:196px 1fr 178px;align-items:center;
  gap:12px;padding:5px 0}
.rangee:hover{background:rgba(255,255,255,.025);border-radius:6px}
.etiquette{font-size:12.5px;color:var(--texte-2);text-align:right}
.piste{height:14px;background:rgba(255,255,255,.04);border-radius:4px;overflow:hidden}
.remplissage{height:100%;border-radius:0 4px 4px 0;min-width:3px}
.valeur{font-size:12.5px;font-variant-numeric:tabular-nums;font-weight:600}
.valeur span{font-weight:400;color:var(--texte-2)}
.legende{display:flex;flex-wrap:wrap;gap:14px;margin-top:14px;font-size:11.5px;
  color:var(--texte-2)}
.legende span{display:inline-flex;align-items:center;gap:6px}
.onglets{display:flex;gap:8px;margin-bottom:16px;border-bottom:1px solid var(--bord)}
.onglet{background:none;border:none;border-bottom:2px solid transparent;border-radius:0;
  color:var(--texte-2);font-size:13.5px;padding:9px 4px;margin-right:14px}
.onglet.actif{color:var(--accent);border-bottom-color:var(--accent)}
.volet{display:none} .volet.actif{display:block}
.liste-tableaux{max-height:260px;overflow-y:auto;margin-top:10px;
  border:1px solid rgba(255,255,255,.12);border-radius:8px;padding:6px 10px}
.liste-tableaux .case{margin:2px 0}
.liste-tableaux .case i{display:block;font-size:11px;opacity:.6;font-style:normal}
.liste-tableaux .case{display:grid;grid-template-columns:auto 1fr auto;align-items:center;gap:8px}
.liste-tableaux select.regime{font-size:11.5px;padding:3px 6px}
.echec-liste{background:rgba(239,68,68,.1);border:1px solid rgba(239,68,68,.35);
  border-radius:8px;padding:11px 13px;font-size:13px}
.lancement #resume{font-size:14px;color:var(--texte);background:var(--fond-2);
  border:1px solid var(--bord);border-radius:9px;padding:11px 13px;margin:2px 0 15px}
details#avance{margin-top:22px}
details#avance > summary{cursor:pointer;list-style:none;font-size:13px;
  color:var(--texte-3);padding:11px 15px;border:1px dashed var(--bord);
  border-radius:10px;user-select:none}
details#avance > summary::-webkit-details-marker{display:none}
details#avance > summary::before{content:"▸ ";font-size:11px}
details#avance[open] > summary::before{content:"▾ "}
details#avance > summary:hover{color:var(--texte-2);border-color:var(--texte-3)}
.courbe svg{width:100%;height:auto;aspect-ratio:760/240;display:block;overflow:visible}
.courbe .grille{stroke:rgba(255,255,255,.10);stroke-width:1}
.courbe .axe{fill:var(--doux);font-size:10px}
.courbe .curseur{stroke:rgba(255,255,255,.35);stroke-width:1;pointer-events:none}
.legende{display:flex;flex-wrap:wrap;gap:6px 18px;margin-top:10px;font-size:12px}
.legende span{display:flex;align-items:center;gap:6px}
.legende i{width:11px;height:11px;border-radius:3px;display:inline-block}
.infobulle{position:absolute;pointer-events:none;background:#0b0e1a;
  border:1px solid rgba(255,255,255,.22);border-radius:8px;padding:8px 10px;
  font-size:12px;z-index:40;box-shadow:0 8px 24px rgba(0,0,0,.5);min-width:190px}
.infobulle b{display:block;margin-bottom:5px}
.infobulle div{display:flex;justify-content:space-between;gap:14px}
.detail{margin-top:14px;border-top:1px solid rgba(255,255,255,.12);padding-top:12px}
.detail table{width:100%;border-collapse:collapse}
table.donnees td:first-child b{white-space:nowrap}
table.donnees td:first-child{min-width:170px}
/* Au suivi, la premiere colonne est une case a cocher : la largeur reservee
   a la reference revient a la cellule qui la porte vraiment. */
#tableSuivi table.donnees td:first-child{min-width:0;width:26px;padding-right:0}
#tableSuivi table.donnees td.dossier{min-width:170px}
#tableSuivi table.donnees td.dossier b{white-space:nowrap}
/* Le libelle d'etape le plus long fait soixante caracteres : laisse libre, la
   liste deroulante poussait les dernieres colonnes hors de l'ecran. */
#tableSuivi select{max-width:186px}
#tableSuivi input.frais{width:48px}
#tableSuivi input.note{min-width:96px}
#tableSuivi table.donnees th,#tableSuivi table.donnees td{padding-left:6px;padding-right:6px}
table.donnees input.note{min-width:170px}
.detail td{padding:4px 6px;font-size:12.5px}
.detail input[type=text]{width:110px;padding:4px 6px;font-size:12.5px}
label{display:block;font-size:12px;color:var(--texte-2);margin-bottom:5px}
input[type=text]{width:100%;background:var(--champ);border:1px solid var(--bord);
  border-radius:9px;padding:10px 12px;color:var(--texte);font-size:13.5px;font-family:inherit}
input[type=text]:focus{outline:none;border-color:var(--bord-actif)}
.case{display:flex;gap:9px;align-items:flex-start;margin-bottom:11px;cursor:pointer}
.case input{margin:3px 0 0;accent-color:var(--accent);flex-shrink:0}
.case span b{display:block;font-size:13px;color:var(--texte)}
.case span i{font-style:normal;font-size:12px;color:var(--texte-3)}
.boutons{display:flex;gap:12px;flex-wrap:wrap;margin-top:6px}
button{font-family:inherit;font-size:14px;font-weight:600;border-radius:10px;
  padding:12px 22px;border:1px solid transparent;cursor:pointer;transition:.15s}
button:disabled{opacity:.45;cursor:not-allowed}
.principal{background:linear-gradient(135deg,var(--accent),var(--accent-fonce));color:#fff}
.principal:hover:not(:disabled){filter:brightness(1.08)}
.secondaire{background:transparent;border-color:var(--bord);color:var(--texte-2)}
.secondaire:hover:not(:disabled){border-color:var(--bord-actif);color:var(--texte)}
#journal{background:#05070f;border:1px solid var(--bord);border-radius:10px;padding:16px;
  font-family:Consolas,Menlo,monospace;font-size:12.5px;white-space:pre-wrap;
  word-break:break-word;max-height:440px;overflow-y:auto;margin-top:14px}
#journal a{color:var(--accent)}
.l-alerte{color:var(--jaune)} .l-erreur{color:var(--rouge)} .l-ok{color:var(--vert)}
.l-dossier{color:var(--texte);font-weight:600;margin-top:6px}
#etat{display:none;align-items:center;gap:11px;margin-top:16px;font-size:13px}
#etat.visible{display:flex}
.rond{width:15px;height:15px;border:2px solid var(--bord);border-top-color:var(--accent);
  border-radius:50%;animation:tourne .8s linear infinite}
@keyframes tourne{to{transform:rotate(360deg)}}
.bandeau{border-radius:10px;padding:13px 15px;font-size:13px;margin-top:16px;display:none}
.bandeau.visible{display:block}
.bandeau.reussi{background:rgba(132,204,22,.1);border:1px solid rgba(132,204,22,.35)}
.bandeau.rate{background:rgba(239,68,68,.1);border:1px solid rgba(239,68,68,.35)}
.note{font-size:12px;color:var(--texte-3);margin-top:14px;padding-top:14px;
  border-top:1px solid var(--bord)}
</style></head>
<body>
<header>
  <span class="logo">Liora</span>
  <span class="titre">Export recouvrement</span>
  <span class="moteur">Version __VERSION__ &nbsp;·&nbsp; Moteur PDF : __MOTEUR_PDF__</span>
</header>
<nav class="principal">
  <button class="actif" data-vue="vueBord">Tableau de bord</button>
  <button data-vue="vueSuivi">État des dossiers</button>
  <button data-vue="vueDocuments">Documents</button>
  <button data-vue="vueExport">Export</button>
</nav>
<main>

<div class="vue actif" id="vueBord">
  <div id="tuilesBord" class="tuiles"></div>
  <div class="graphe" id="courbeBord"></div>
  <div class="graphe" id="grapheBord"></div>
  <div class="graphe" id="anciennete"></div>
  <div class="graphe" id="dormants"></div>
  <div class="graphe" id="solidite"></div>
</div>

<div class="vue" id="vueSuivi">
  <section>
    <h2>État des dossiers</h2>
    <p class="aide">L'avancement et les frais sont enregistrés au fur et à mesure,
       à côté de l'outil. Refaire un export ne les efface pas.</p>
    <div id="tableSuivi"></div>
  </section>
</div>

<div class="vue" id="vueDocuments">
  <section>
    <h2>Documents produits</h2>
    <p class="aide">Un répertoire par dossier, dans <b id="cheminSortie">—</b>.
       Cliquez pour ouvrir la note de synthèse ou le répertoire complet.</p>
    <div id="tableDocuments"></div>
  </section>
</div>

<div class="vue" id="vueExport">
<section class="lancement">
  <h2>Lancer l'export</h2>
  <p class="aide" id="resume">—</p>
  <div class="boutons">
    <button class="secondaire" id="tester">Tester d'abord</button>
    <button class="principal" id="lancer" disabled>Lancer l'export</button>
    <button class="secondaire" id="ouvrir">Ouvrir les dossiers produits</button>
  </div>
  <p class="note"><b>Tester d'abord</b> compte ce qui sera traité sans rien
     écrire sur le disque. <b>Lancer l'export</b> constitue les dossiers.</p>
  <div id="etat"><div class="rond"></div><span id="texteEtat">Export en cours…</span></div>
  <div class="bandeau" id="bandeau"></div>
  <div id="journal" hidden></div>
</section>

<section>
  <h2>Où prendre les dossiers</h2>
  <div class="onglets">
    <button class="onglet actif" data-volet="voletFichier">Depuis un export Monday</button>
    <button class="onglet" data-volet="voletMonday">Depuis Monday, en direct</button>
    <button class="onglet" data-volet="voletManuel">Recherche ponctuelle</button>
  </div>

  <div class="volet actif" id="voletFichier">
    <p class="aide">Votre export Monday, tel quel. Formats acceptés : .xlsx, .xlsm, .csv</p>
    <div id="zone">
      <div class="fleche">&#8593;</div>
      <div id="texteZone">Glissez-déposez votre fichier, ou cliquez pour le choisir</div>
      <div id="nomFichier"></div>
    </div>
    <input type="file" id="fichier" accept=".xlsx,.xlsm,.csv" hidden />
  </div>

  <div class="volet" id="voletMonday">
    <p class="aide">L'outil lit le tableau directement dans Monday : plus
       d'export à refaire à chaque fois. Demande le jeton Monday (section 2).</p>
    <div class="grille">
      <div>
        <label for="chercheTableau">Chercher un tableau</label>
        <input type="text" id="chercheTableau" placeholder="recouvrement, financement…" />
      </div>
      <div>
        <label for="listerTableaux">&nbsp;</label>
        <button class="secondaire" id="listerTableaux">Lister mes tableaux</button>
      </div>
    </div>
    <div id="tableau" class="liste-tableaux">__INVITE_TABLEAUX__</div>
    <p class="note">Cochez-en plusieurs : les lignes de tous les tableaux
       cochés sont réunies en un seul lot, et le filtre ci-dessous s'y applique
       de la même façon.</p>
    <p class="note">Le jeton n'est jamais transmis à la page : il reste sur le
       poste, dans son propre fichier.</p>
  </div>

  <div class="volet" id="voletManuel">
    <p class="aide">Pour un dossier isolé, sans rien préparer dans Monday.
       Renseignez l'un des deux critères, ou les deux.</p>
    <div class="grille">
      <div>
        <label for="mEmail">Adresse(s) mail — séparées par des virgules</label>
        <input type="text" id="mEmail"
               placeholder="marie.dupont@exemple.fr,m.dupont@travail.fr" />
      </div>
      <div>
        <label for="mFacture">Numéro(s) de facture — séparés par des virgules</label>
        <input type="text" id="mFacture" placeholder="FACT-2405-00030,FACT-2405-00142" />
      </div>
      <div>
        <label for="mNom">Nom du dossier (facultatif)</label>
        <input type="text" id="mNom" placeholder="Marie Dupont" />
      </div>
    </div>
    <p class="note">Les deux critères se combinent par un OU : un message
       remonte s'il cite l'une des adresses <b>ou</b> l'un des numéros de
       facture. Renseigner les deux élargit la recherche, il ne la restreint
       pas.</p>
    <p class="note">Plusieurs valeurs dans un champ forment <b>un seul</b>
       dossier — celui du débiteur —, avec les sous-dossiers par facture et,
       si l'option est cochée, par adresse.</p>
  </div>
</section>

<div class="grille">
    <div>
      <label for="filtreColonne">Ne traiter qu'une étape du process (colonne)</label>
      <input type="text" id="filtreColonne" value="__FILTRE_COLONNE__"
             placeholder="Etape process recouvrement" />
    </div>
    <div>
      <label for="filtreValeur">Valeur attendue dans cette colonne</label>
      <input type="text" id="filtreValeur" value="__FILTRE_VALEUR__"
             placeholder="Dossier a faire passer en contentieux" />
    </div>
    <div>
      <label for="groupes">Ou situés dans un groupe dont le nom contient</label>
      <input type="text" id="groupes" value="__GROUPES__"
             placeholder="contentieux" />
    </div>
  </div>
  <p class="note">Laissez les trois vides pour traiter tout le tableau. La
     comparaison ignore accents, casse et emojis, et se fait par inclusion :
     « contentieux » retient « 🔴 Dossier à faire passer en contentieux ».</p>
  <p class="note">Une facture est souvent qualifiée en la glissant dans un
     groupe — « 1.2.5 Service contentieux », « 2.1.6. Facture en Contentieux » —
     sans que la colonne d'étape en dise rien. Un élément retenu par son groupe
     <b>ou</b> par sa colonne est traité ; retenu par les deux, il ne compte
     qu'une fois.</p>
  <p class="note"><b>Pour ne traiter que les groupes</b>, videz les deux champs
     de gauche et ne gardez que celui-ci. La colonne d'étape ramène aussi les
     factures qui portent l'étiquette sans être dans le groupe — c'est utile
     pour n'en manquer aucune, encombrant si le groupe fait déjà foi. Le
     journal indique ce que chaque source apporte.</p>
</section>

<details id="avance">
<summary>Boîtes mail et options — à ne toucher qu'en cas de besoin</summary>
<section>
  <h2>Les boîtes à interroger</h2>
  <p class="aide">Séparées par des virgules. Un échange présent dans plusieurs
     boîtes n'est retenu qu'une fois.</p>
  <div class="grille">
    <div>
      <label for="boites">Adresses</label>
      <input type="text" id="boites" value="__BOITES__"
             placeholder="billing@liora.io,recouvrement@liora.io" />
    </div>
    <div>
      <label for="sortie">Dossier de destination</label>
      <input type="text" id="sortie" value="__SORTIE__" />
    </div>
    <div>
      <label for="jetonMonday">Jeton Monday — pour télécharger factures et conventions</label>
      <input type="text" id="jetonMonday" placeholder="__ETAT_MONDAY__" />
    </div>
    <div>
      <label for="domaines">Vos autres domaines d\'envoi</label>
      <input type="text" id="domaines" value="__DOMAINES__"
             placeholder="datascientest.com" />
    </div>
  </div>
  <p class="note">Le jeton Monday est facultatif : sans lui, les factures et
     conventions du tableau sont seulement citées en lien dans la note, au lieu
     d'être téléchargées. Il s'obtient dans Monday, profil en haut à droite →
     Développeurs → Centre de développeurs, puis <b>Clé API</b> dans le menu
     de gauche.</p>
  <p class="note">La destination est volontairement hors de OneDrive : l'export
     contient les données personnelles des apprenantes, et la synchronisation
     d'un dossier volumineux provoque des erreurs d'écriture en cours de route.</p>
</section>

<section>
  <h2>Options</h2>
  <p class="aide">Les valeurs par défaut conviennent dans la plupart des cas.</p>
  <label class="case"><input type="checkbox" id="simulation" checked />
    <span><b>Simulation</b><i>Compte les mails trouvés sans rien écrire. À faire
    une première fois, toujours.</i></span></label>
  <label class="case"><input type="checkbox" id="ignorer" checked />
    <span><b>Ignorer les lignes sans adresse ni facture</b><i>Les lignes de total
    et de groupe des exports Monday. Elles sont listées à l'écran.</i></span></label>
  <label class="case"><input type="checkbox" id="regrouper" checked />
    <span><b>Regrouper les factures d'un même débiteur</b><i>Plusieurs factures
    partageant une adresse mail forment un seul dossier, avec la dette cumulée.
    Sinon elles produisent des répertoires au contenu identique.</i></span></label>
  <label class="case"><input type="checkbox" id="sousdossiers" checked />
    <span><b>Un sous-dossier par facture</b><i>Un débiteur qui doit plusieurs
    factures donne un dossier, qui mène lui-même à un sous-dossier complet par
    facture — transmissible seul, avec sa propre note de synthèse.</i></span></label>
  <label class="case"><input type="checkbox" id="sousdossiersadresse" />
    <span><b>Un sous-dossier par adresse mail</b><i>Même principe quand les
    échanges passent par plusieurs adresses. Le rattachement se fait sur les
    en-têtes du message, pas sur son corps. Les montants n'y sont pas répartis.</i></span></label>
  <label class="case"><input type="checkbox" id="decouvrir" checked />
    <span><b>Retrouver les adresses depuis le numéro de facture</b><i>Active par
    défaut, et à laisser ainsi : l'adresse manque souvent au tableau. Relève les
    adresses du débiteur dans les messages citant la facture, puis relance la
    recherche sur chacune — ce qui ramène les échanges ne citant aucun numéro.
    Les adresses internes et les robots sont écartés ; chaque adresse retenue
    est annoncée dans le journal.</i></span></label>
  <label class="case"><input type="checkbox" id="souselements" />
    <span><b>Traiter aussi les sous-éléments Monday</b><i>Quand une facture est
    rangée en sous-élément sous l'apprenante, chaque sous-élément devient une
    ligne à part. Il hérite des colonnes de son parent — nom, adresse mail,
    qualification — partout où il n'en porte pas lui-même. À laisser décoché si
    vos factures sont des éléments à part entière : sinon chaque dossier
    reviendrait deux fois.</i></span></label>
  <label class="case"><input type="checkbox" id="sansnav" />
    <span><b>Ne pas ouvrir le navigateur pour autoriser</b><i>Si une boîte est
    connectée dans une autre fenêtre : l'adresse s'affiche, à coller vous-même.</i></span></label>
  <label class="case"><input type="checkbox" id="majdossiers" />
    <span><b>Compléter les dossiers déjà exportés</b><i>Ne recrée pas un
    dossier déjà constitué : y ajoute seulement les messages nouveaux, à la
    suite. Les numéros de pièce déjà attribués ne changent pas, et rien n'est
    réimprimé.</i></span></label>
  <label class="case"><input type="checkbox" id="reprendre" />
    <span><b>Reprendre</b><i>Passe entièrement les dossiers déjà exportés,
    sans les regarder. Après une interruption.</i></span></label>
  <p class="note" id="dejaExporte" hidden></p>
  <div>
    <label for="seulement">Ne traiter que ces références (optionnel)</label>
    <input type="text" id="seulement" value="__SEULEMENT__"
           placeholder="FACT-2405-00030,FACT-2405-00142" />
  </div>
</section>

</details>
</div>

</main>
<script>
const JETON = "__JETON__";
const $ = (id) => document.getElementById(id);
const IMPORT_PRECEDENT = __IMPORT__;
const CASES = __OPTIONS__;
const TABLEAU_MEMORISE = "__TABLEAU__";
// Les cases cochées survivent au filtrage de la liste : chercher « personnel »
// après avoir coché « recouvrement » ne doit pas décocher ce dernier.
let TABLEAUX = [];
const TABLEAUX_COCHES = new Set(TABLEAU_MEMORISE.split(",").filter(Boolean));
const REGIMES_ECHEANCE = __REGIMES__;
const CHANTIERS = __CHANTIERS__;
let chantiersProposes = __CHANTIERS_PROPOSES__;
let fichierChoisi = null, position = 0, sondage = null, mode = "fichier";
// Le fichier importé est conservé à côté de l'outil, mais aucun navigateur
// ne peut repeupler un champ de fichier : on le rappelle, et on permet de
// relancer dessus sans le redéposer.
let reutiliserImport = Boolean(IMPORT_PRECEDENT);

async function api(chemin, corps) {
  const options = { headers: { "X-Jeton": JETON } };
  if (corps !== undefined) {
    options.method = "POST";
    options.headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(corps);
  }
  const reponse = await fetch(chemin, options);
  const donnees = await reponse.json().catch(() => ({}));
  if (!reponse.ok) throw new Error(donnees.erreur || "Erreur " + reponse.status);
  return donnees;
}

// -- bascule entre les deux modes
document.querySelectorAll(".onglet").forEach((onglet) => {
  onglet.addEventListener("click", () => {
    document.querySelectorAll(".onglet").forEach((o) => o.classList.remove("actif"));
    document.querySelectorAll(".volet").forEach((v) => v.classList.remove("actif"));
    onglet.classList.add("actif");
    $(onglet.dataset.volet).classList.add("actif");
    mode = { voletManuel: "manuel", voletMonday: "monday" }[onglet.dataset.volet]
      || "fichier";
    $("bandeau").className = "bandeau";
    majBouton();
  });
});

["mEmail", "mFacture"].forEach((id) =>
  $(id).addEventListener("input", majBouton));

// Ce qui va effectivement tourner, en une phrase. Les reglages sont replies :
// sans ce rappel, on lance sans savoir sur quoi.
function majResume(pret) {
  const bouts = [];
  if (mode === "monday") {
    const coches = Array.from(TABLEAUX_COCHES);
    const noms = coches
      .map((id) => (TABLEAUX.find((t) => t.id === id) || {}).nom)
      .filter(Boolean);
    bouts.push(noms.length ? noms.join(", ")
      : coches.length + (coches.length > 1 ? " tableaux Monday" : " tableau Monday"));
    const groupe = $("groupes").value.trim();
    const colonne = $("filtreValeur").value.trim();
    if (groupe) bouts.push("groupe « " + groupe + " »");
    if (colonne) bouts.push("étape « " + colonne.split(",")[0].trim() + " »"
      + (colonne.includes(",") ? " (et autres)" : ""));
    if (!groupe && !colonne) bouts.push("tout le tableau");
  } else if (mode === "manuel") {
    bouts.push("recherche ponctuelle");
  } else {
    bouts.push(fichierChoisi ? fichierChoisi.name
      : (reutiliserImport ? "le dernier fichier importé" : "aucun fichier"));
  }
  const boites = $("boites").value.trim();
  if (boites) bouts.push(boites);
  $("resume").textContent = pret
    ? bouts.join("  ·  ")
    : "Rien à traiter pour le moment — voyez les réglages ci-dessous.";
}

function majBouton() {
  let pret;
  if (mode === "manuel") {
    pret = Boolean($("mEmail").value.trim() || $("mFacture").value.trim());
  } else if (mode === "monday") {
    pret = Boolean(tableauxCoches());
  } else {
    pret = Boolean(fichierChoisi || reutiliserImport);
  }
  $("lancer").disabled = !pret;
  $("tester").disabled = !pret;
  majResume(pret);
}

// -- lecture directe du tableau Monday
$("listerTableaux").addEventListener("click", async () => {
  const bouton = $("listerTableaux");
  bouton.disabled = true;
  const ancien = bouton.textContent;
  bouton.textContent = "Interrogation de Monday…";
  try {
    $("tableau").textContent = "Interrogation de Monday…";
    const reponse = await api("/api/tableaux",
      { jeton_monday: $("jetonMonday").value });
    TABLEAUX = reponse.tableaux;
    const proposes = proposerChantiers();
    rendreTableaux();
    afficherBandeau(true, TABLEAUX.length + " tableau(x) trouvé(s)." +
      (proposes ? " Les " + proposes + " tableaux de recouvrement sont cochés." : ""));
  } catch (erreur) {
    // Le bandeau vit en section 4, hors de l'écran quand on clique ici : un
    // échec y resterait invisible, et le bouton passerait pour inerte. Le
    // motif s'écrit donc aussi sous le bouton, là où le regard se trouve.
    $("tableau").innerHTML = '<div class="echec-liste">' +
      echapper(erreur.message) + "</div>";
    afficherBandeau(false, erreur.message);
  } finally {
    bouton.disabled = false;
    bouton.textContent = ancien;
    majBouton();
  }
});
// Au tout premier listage, les tableaux du travail courant se cochent seuls :
// il n'y a plus qu'à lancer. Une seule fois — ensuite le choix enregistré
// fait foi, sans quoi un tableau écarté reviendrait à chaque listage.
function proposerChantiers() {
  if (chantiersProposes) return 0;
  // Le point final n'est pas garanti : « 2.1. Financement Personnel » et
  // « 2.1 Financement Personnel » désignent le même tableau, et exiger la
  // forme exacte ferait echouer la reconnaissance sans rien dire.
  const retenus = TABLEAUX.filter((tab) => {
    const nom = (tab.nom || "").trim();
    return CHANTIERS.some((prefixe) => {
      const nu = prefixe.replace(/\.$/, "");
      return nom.startsWith(prefixe) ||
        (nom.startsWith(nu) && !/[0-9.]/.test(nom.slice(nu.length, nu.length + 1)));
    });
  });
  retenus.forEach((tab) => TABLEAUX_COCHES.add(tab.id));
  chantiersProposes = true;
  enregistrerReglages();
  return retenus.length;
}

// Mêmes mots-clés que côté outil : les tableaux B2C financent la formation par
// l'apprenant, l'échéance y tombe au début de la formation.
function regimeDeduit(nom) {
  const plat = (nom || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  if (/(cpf)/.test(plat)) return "fin-formation-45";
  if (/(transition|region|aif|poei|agefiph|interco|allemagne|pole emploi|complexe)/.test(plat)) return "fin-formation-60";
  if (/(opco|b2b|alternance|etat)/.test(plat)) return "fin-formation-30";
  if (/(personnel|perso|particulier|b2c)/.test(plat)) return "debut-formation";
  if (/(entreprise|corporate|societe|adv|btc)/.test(plat)) return "facture30";
  return "facture30";
}

function rendreTableaux() {
  const cherche = $("chercheTableau").value.trim().toLowerCase();
  const liste = $("tableau");
  liste.innerHTML = "";

  const visibles = TABLEAUX.filter((tab) =>
    !cherche || (tab.nom + " " + (tab.espace || "")).toLowerCase().includes(cherche));

  if (!visibles.length) {
    liste.textContent = TABLEAUX.length
      ? "Aucun tableau ne correspond a cette recherche."
      : "Cliquez sur « Lister mes tableaux ».";
    return;
  }

  visibles.forEach((tab) => {
    const etiquette = document.createElement("label");
    etiquette.className = "case";
    const coche = document.createElement("input");
    coche.type = "checkbox";
    coche.value = tab.id;
    coche.checked = TABLEAUX_COCHES.has(tab.id);
    coche.addEventListener("change", () => {
      if (coche.checked) TABLEAUX_COCHES.add(tab.id);
      else TABLEAUX_COCHES.delete(tab.id);
      majBouton();
      enregistrerReglages();
    });
    const texte = document.createElement("span");
    texte.innerHTML = "<b>" + echapper(tab.nom) + "</b><i>" +
      (tab.espace ? echapper(tab.espace) + " · " : "") + "n° " + tab.id + "</i>";
    etiquette.appendChild(coche);
    etiquette.appendChild(texte);

    // L'échéance ne s'imprime pas sur la facture : elle se calcule, et pas de
    // la même façon selon le financement. Le choix est déduit du nom du
    // tableau, mais reste affiché et modifiable — un tableau renommé ne doit
    // pas changer les échéances en silence.
    const regime = document.createElement("select");
    regime.className = "regime";
    regime.innerHTML =
      '<option value="facture30">échéance = date de facture + 30 j</option>' +
      '<option value="debut-formation">échéance = début de formation</option>' +
      '<option value="fin-formation-30">échéance = fin de formation + 30 j</option>' +
      '<option value="fin-formation-45">échéance = fin de formation + 45 j</option>' +
      '<option value="fin-formation-60">échéance = fin de formation + 60 j</option>';
    regime.value = REGIMES_ECHEANCE[tab.id] || regimeDeduit(tab.nom);
    regime.addEventListener("change", () => {
      REGIMES_ECHEANCE[tab.id] = regime.value;
      enregistrerReglages();
    });
    etiquette.appendChild(regime);
    liste.appendChild(etiquette);
  });
}

$("chercheTableau").addEventListener("input", rendreTableaux);

function tableauxCoches() {
  return Array.from(TABLEAUX_COCHES).join(",");
}

function reglesEcheance() {
  return Object.entries(REGIMES_ECHEANCE).map(([id, r]) => id + "=" + r).join(",");
}

// Les cases reprennent l'état de la dernière session : ce qui a été décidé
// une fois n'a pas à être redécidé à chaque ouverture.
Object.keys(CASES).forEach((id) => { if ($(id)) $(id).checked = CASES[id]; });

if (TABLEAUX_COCHES.size) {
  const onglet = document.querySelector('.onglet[data-volet="voletMonday"]');
  if (onglet) onglet.click();
}
majBouton();

// Enregistrement automatique : à la saisie (différé) et à la fermeture de la
// page. Une page fermée sans avoir lancé d'export ne perd plus rien.
const CHAMPS_REGLAGES = ["boites", "sortie", "domaines", "seulement",
                         "filtreColonne", "filtreValeur", "groupes",
                         "jetonMonday"];
let minuterieReglages = null;

function reglages() {
  const options = {};
  Object.keys(CASES).forEach((id) => { if ($(id)) options[id] = $(id).checked; });
  return {
    boites: $("boites").value, sortie: $("sortie").value,
    domaines: $("domaines").value, seulement: $("seulement").value,
    filtre_colonne: $("filtreColonne").value,
    filtre_valeur: $("filtreValeur").value,
    groupes: $("groupes").value,
    tableau: tableauxCoches(),
    regimes_echeance: reglesEcheance(),
    chantiers_proposes: chantiersProposes,
    jeton_monday: $("jetonMonday").value, options: options,
  };
}

async function enregistrerReglages(fermeture) {
  try {
    await fetch("/api/reglages", {
      method: "POST", keepalive: Boolean(fermeture),
      headers: { "Content-Type": "application/json", "X-Jeton": JETON },
      body: JSON.stringify(reglages()),
    });
  } catch (erreur) { /* rien à signaler : la prochaine frappe réessaiera */ }
}

["groupes", "filtreValeur", "boites"].forEach((id) =>
  $(id) && $(id).addEventListener("input", majBouton));

CHAMPS_REGLAGES.forEach((id) => $(id) && $(id).addEventListener("input", () => {
  clearTimeout(minuterieReglages);
  minuterieReglages = setTimeout(enregistrerReglages, 600);
}));
Object.keys(CASES).forEach((id) => $(id) &&
  $(id).addEventListener("change", () => enregistrerReglages()));

// `pagehide` plutôt que `beforeunload` : c'est le seul événement que tous les
// navigateurs déclenchent lors d'une fermeture d'onglet.
window.addEventListener("pagehide", () => enregistrerReglages(true));

// Battement de cœur : tant que la page est ouverte, l'outil reste en vie.
// L'application n'ayant plus de fenêtre à fermer, c'est ce signal — et son
// silence — qui décide de son arrêt.
setInterval(() => {
  fetch("/api/vivant", { headers: { "X-Jeton": JETON } }).catch(() => {});
}, 20000);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") enregistrerReglages(true);
});

if (IMPORT_PRECEDENT) {
  $("zone").classList.add("rempli");
  $("texteZone").textContent = "Dernier fichier importé, prêt à relancer :";
  $("nomFichier").textContent = IMPORT_PRECEDENT.nom +
    "  (importé le " + IMPORT_PRECEDENT.date + ", " +
    Math.round(IMPORT_PRECEDENT.taille / 1024) + " Ko)" +
    " — déposez-en un autre pour le remplacer";
  majBouton();
}

// -- dépôt du fichier
const zone = $("zone");
zone.addEventListener("click", () => $("fichier").click());
["dragenter", "dragover"].forEach((e) =>
  zone.addEventListener(e, (ev) => { ev.preventDefault(); zone.classList.add("survol"); }));
["dragleave", "drop"].forEach((e) =>
  zone.addEventListener(e, () => zone.classList.remove("survol")));
zone.addEventListener("drop", (ev) => {
  ev.preventDefault();
  if (ev.dataTransfer.files.length) retenir(ev.dataTransfer.files[0]);
});
$("fichier").addEventListener("change", (ev) => {
  if (ev.target.files.length) retenir(ev.target.files[0]);
});

function retenir(fichier) {
  const extension = "." + fichier.name.split(".").pop().toLowerCase();
  if (![".xlsx", ".xlsm", ".csv"].includes(extension)) {
    afficherBandeau(false, "Format non pris en charge : " + extension +
      ". Attendu : .xlsx, .xlsm ou .csv.");
    return;
  }
  fichierChoisi = fichier;
  reutiliserImport = false;
  zone.classList.add("rempli");
  $("texteZone").textContent = "Fichier retenu :";
  $("nomFichier").textContent = fichier.name +
    "  (" + Math.round(fichier.size / 1024) + " Ko)";
  majBouton();
  $("bandeau").className = "bandeau";
}

// -- lancement
// Deux boutons plutôt qu'une case à cocher lue de travers : « Tester »
// n'écrit rien, « Lancer l'export » constitue les dossiers. La case de la
// section repliée suit le bouton employé, elle ne le contredit jamais.
let simulationDemandee = true;

$("tester").addEventListener("click", () => demarrer(true));
$("lancer").addEventListener("click", () => demarrer(false));

async function demarrer(simulation) {
  simulationDemandee = simulation;
  $("simulation").checked = simulation;
  if (mode === "monday" && !tableauxCoches()) return;
  if (mode === "fichier" && !fichierChoisi && !reutiliserImport) return;
  $("lancer").disabled = true;
  $("tester").disabled = true;
  $("bandeau").className = "bandeau";
  $("journal").hidden = false;
  $("journal").textContent = "";
  position = 0;

  const commun = {
      boites: $("boites").value,
      sortie: $("sortie").value,
      jeton_monday: $("jetonMonday").value,
      domaines: $("domaines").value,
      filtre_colonne: $("filtreColonne").value,
      filtre_valeur: $("filtreValeur").value,
      groupes: $("groupes").value,
      tableau: tableauxCoches(),
      regimes_echeance: reglesEcheance(),
      simulation: simulationDemandee,
      ignorer_lignes_incompletes: $("ignorer").checked,
      sans_regroupement: !$("regrouper").checked,
      sans_sous_dossiers: !$("sousdossiers").checked,
      sous_dossiers_par_adresse: $("sousdossiersadresse").checked,
      decouvrir_adresses: $("decouvrir").checked,
      sous_elements: $("souselements").checked,
      sans_navigateur: $("sansnav").checked,
      reprendre: $("reprendre").checked,
      mettre_a_jour: $("majdossiers").checked,
      seulement: $("seulement").value,
  };

  let charge;
  if (mode === "monday") {
    charge = Object.assign({ mode: "monday" }, commun);
  } else if (mode === "manuel") {
    charge = Object.assign({ mode: "manuel",
      email: $("mEmail").value, facture: $("mFacture").value,
      nom_dossier: $("mNom").value }, commun);
  } else if (!fichierChoisi) {
    // Relance sur le fichier déjà déposé : il n'a pas à repasser par le
    // navigateur, il est resté sur le disque à côté de l'outil.
    charge = Object.assign({ reutiliser: true }, commun);
  } else {
    try {
      charge = Object.assign({ nom: fichierChoisi.name,
        contenu: await new Promise((resoudre, rejeter) => {
          const lecteur = new FileReader();
          lecteur.onload = () => resoudre(lecteur.result.split(",")[1]);
          lecteur.onerror = () => rejeter(new Error("Lecture du fichier impossible."));
          lecteur.readAsDataURL(fichierChoisi);
        }) }, commun);
    } catch (erreur) {
      afficherBandeau(false, erreur.message);
      majBouton();
      return;
    }
  }

  try {
    await api("/api/lancer", charge);
  } catch (erreur) {
    afficherBandeau(false, erreur.message);
    majBouton();
    return;
  }

  $("texteEtat").textContent = $("simulation").checked
    ? "Simulation en cours…" : "Export en cours…";
  $("etat").classList.add("visible");
  sondage = setInterval(rafraichir, 700);
  rafraichir();
}

$("ouvrir").addEventListener("click", async () => {
  try { await api("/api/ouvrir", { chemin: $("sortie").value }); }
  catch (erreur) { afficherBandeau(false, erreur.message); }
});

// -- suivi
async function rafraichir() {
  let etat;
  try { etat = await api("/api/journal?depuis=" + position); }
  catch { return; }

  if (etat.lignes.length) {
    position = etat.total;
    const journal = $("journal");
    for (const ligne of etat.lignes) journal.appendChild(elementLigne(ligne));
    journal.scrollTop = journal.scrollHeight;
  }

  if (etat.termine) {
    clearInterval(sondage);
    $("etat").classList.remove("visible");
    majBouton();
    if (etat.code === 0) {
      afficherBandeau(true, simulationDemandee
        ? "Test terminé — rien n'a été écrit. Si les volumes vous conviennent, cliquez sur « Lancer l'export »."
        : "Export terminé. « Ouvrir les dossiers produits » ouvre le répertoire où ils sont rangés.");
    } else {
      afficherBandeau(false, etat.erreur || "Terminé avec des erreurs — voir le détail ci-dessus.");
    }
  }
}

function elementLigne(texte) {
  const div = document.createElement("div");
  let classe = "";
  if (texte.includes("Erreur") || texte.includes("✗")) classe = "l-erreur";
  else if (texte.includes("⚠")) classe = "l-alerte";
  else if (texte.startsWith("Terminé")) classe = "l-ok";
  else if (/^\[\d+\/\d+\]/.test(texte)) classe = "l-dossier";
  if (classe) div.className = classe;

  // Les adresses d'autorisation doivent être cliquables : c'est par elles que
  // passe l'accès à une boîte pas encore autorisée.
  const morceaux = texte.split(/(https?:\/\/\S+)/g);
  for (const morceau of morceaux) {
    if (/^https?:\/\//.test(morceau)) {
      const lien = document.createElement("a");
      lien.href = morceau; lien.target = "_blank"; lien.rel = "noreferrer";
      lien.textContent = morceau;
      div.appendChild(lien);
    } else if (morceau) {
      div.appendChild(document.createTextNode(morceau));
    }
  }
  if (!texte) div.appendChild(document.createTextNode(" "));
  return div;
}


// ============================================================
//  Onglets principaux
// ============================================================
document.querySelectorAll("nav.principal button").forEach((bouton) => {
  bouton.addEventListener("click", () => {
    document.querySelectorAll("nav.principal button").forEach((b) => b.classList.remove("actif"));
    document.querySelectorAll(".vue").forEach((v) => v.classList.remove("actif"));
    bouton.classList.add("actif");
    $(bouton.dataset.vue).classList.add("actif");
    if (bouton.dataset.vue !== "vueExport") chargerDossiers();
  });
});

// ============================================================
//  Suivi des dossiers
// ============================================================
let DOSSIERS = [], STATUTS = [], AGREGATS = null, COURBE = null, SERVEUR = null;

const euro = (v) => new Intl.NumberFormat("fr-FR",
  { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(v || 0);

async function chargerDossiers() {
  let donnees;
  try { donnees = await api("/api/dossiers"); }
  catch (erreur) { afficherBandeau(false, erreur.message); return; }

  DOSSIERS = donnees.dossiers;
  STATUTS = donnees.statuts;
  AGREGATS = donnees.agregats;
  COURBE = donnees.agregats ? donnees.agregats.courbe : null;
  SERVEUR = donnees.agregats || null;
  $("cheminSortie").textContent = donnees.sortie;
  rendreDocuments();
  rendreSuivi();
  rendreBord();
  rappelerExportExistant(donnees.sortie);
}

// Un export réel dure longtemps. Relancer sans « Reprendre » le referait
// entièrement : mieux vaut le dire avant, à côté de la case concernée.
function rappelerExportExistant(sortie) {
  const faits = DOSSIERS.filter((d) => d.a_index).length;
  const note = $("dejaExporte");
  if (!faits) { note.hidden = true; return; }

  note.hidden = false;
  note.innerHTML = "<b>" + faits + " dossier(s) sont déjà exportés</b> dans " +
    echapper(sortie) + ". Ils sont conservés : relancer sans cocher " +
    "<b>Reprendre</b> les referait tous depuis le début. Cochez " +
    "<b>Reprendre</b> pour ne traiter que ce qui manque.";
}

// Jours ecoules depuis l'echeance. Une echeance a venir n'est pas un retard,
// et une echeance absente n'en est pas un non plus : ni l'une ni l'autre ne
// doit s'afficher comme un zero, qui se lirait « a jour ».
function retard(jours) {
  if (jours === null || jours === undefined || jours <= 0) return "—";
  return jours + " j";
}

function majSelection() {
  const choisis = Array.from(document.querySelectorAll(".choix"))
    .filter((c) => c.checked);
  const bouton = $("supprimer");
  if (!bouton) return;
  bouton.disabled = choisis.length === 0;
  $("compteChoix").textContent = choisis.length
    ? choisis.length + " dossier(s) sélectionné(s)."
    : "Cochez les dossiers à retirer de la liste.";
}

async function supprimerChoisis() {
  const references = Array.from(document.querySelectorAll(".choix"))
    .filter((c) => c.checked).map((c) => c.dataset.ref);
  if (!references.length) return;

  const apercu = references.slice(0, 8).join(", ")
    + (references.length > 8 ? "…" : "");
  if (!confirm(references.length + " dossier(s) seront retirés de la liste :\n\n"
      + apercu + "\n\nLes fichiers déjà produits restent sur le disque.")) return;

  // Effacer les fichiers est demande a part : un dossier retire par erreur se
  // retrouve sur le disque, un repertoire supprime ne revient pas.
  const fichiers = confirm("Supprimer aussi les fichiers de ces dossiers "
    + "(mails, pièces jointes, note de synthèse) ?\n\n"
    + "Annuler = garder les fichiers, retirer seulement de la liste.");

  try {
    const reponse = await api("/api/supprimer",
      { references: references, fichiers: fichiers });
    afficherBandeau(true, reponse.retires + " dossier(s) retiré(s)"
      + (reponse.effaces ? ", " + reponse.effaces + " répertoire(s) supprimé(s)" : "")
      + ".");
    chargerDossiers();
  } catch (erreur) { afficherBandeau(false, erreur.message); }
}

// Trois choses de nature differente, demandees separement : la liste se
// reconstitue en relancant un export, les fichiers aussi mais l'export dure
// une heure, et le suivi saisi a la main ne se refait pas du tout.
async function toutEffacer() {
  const total = DOSSIERS.length;
  if (!total) { afficherBandeau(false, "Il n'y a rien à effacer."); return; }

  if (!confirm(`Retirer les ${total} dossiers de la liste ?\n\n`
      + "Elle se reconstitue en relançant un export.")) return;

  const fichiers = confirm(
    "Supprimer aussi les fichiers produits — mails, pièces jointes, notes de "
    + "synthèse ?\n\nIls se refont, mais l'export dure environ une heure.\n\n"
    + "Annuler = garder les fichiers sur le disque.");

  const suivi = confirm(
    "Effacer aussi votre suivi : étapes, dates de passage, frais engagés, "
    + "notes ?\n\n⚠ Celui-ci ne se refait pas — il n'existe nulle part "
    + "ailleurs, et aucun export ne le reconstituera.\n\n"
    + "Annuler = garder votre suivi (recommandé).");

  const recap = ["la liste"];
  if (fichiers) recap.push("les fichiers");
  if (suivi) recap.push("VOTRE SUIVI");
  if (!confirm("Dernière vérification.\n\nSeront effacés : "
      + recap.join(", ") + ".\n\nConfirmer ?")) return;

  try {
    const r = await api("/api/tout-effacer",
      { confirme: "EFFACER", fichiers: fichiers, suivi: suivi });
    afficherBandeau(true, `${r.retires} dossier(s) retiré(s)`
      + (r.effaces ? `, ${r.effaces} répertoire(s) supprimé(s)` : "")
      + (r.suivi_efface ? `, ${r.suivi_efface} suivi(s) effacé(s)` : "")
      + ".");
    chargerDossiers();
  } catch (erreur) { afficherBandeau(false, erreur.message); }
}

function messageVide() {
  return '<p class="vide">Aucun export trouvé dans le dossier de destination.' +
    "<br />Lancez un export depuis l'onglet « Export » — les dossiers produits " +
    "apparaîtront ici.</p>";
}

function pastilleStatut(cle) {
  const statut = STATUTS.find((s) => s.cle === cle) || STATUTS[0];
  return '<span class="etat-pastille"><span class="pastille" style="background:' +
    statut.couleur + '"></span>' + (statut.icone ? statut.icone + " " : "") +
    statut.libelle + "</span>";
}

// -- onglet Documents
// Trois etats, jamais deux : ce que le tableau ne dit pas ne doit pas
// s'afficher comme un « non ». Un pictogramme seul ne suffit pas — le libelle
// l'accompagne toujours, la couleur ne portant jamais l'information seule.
function etatOuiNon(valeur, oui, non) {
  if (valeur === true) return '<span class="etat oui">✓ ' + oui + "</span>";
  if (valeur === false) return '<span class="etat non">✕ ' + non + "</span>";
  return '<span class="etat inconnu">— non renseigné</span>';
}

function heuresSuivies(d) {
  const prevu = parseFloat(String(d.heures_theoriques || "").replace(",", "."));
  const fait = parseFloat(String(d.heures_log || "").replace(",", "."));
  if (!isNaN(fait) && prevu > 0) {
    return `${fait} / ${prevu} h<br /><span style="color:var(--texte-3)">`
      + Math.round(100 * fait / prevu) + " %</span>";
  }
  if (!isNaN(fait)) return fait + " h";
  if (prevu > 0) return "— / " + prevu + " h";
  return "—";
}

function rendreDocuments() {
  if (!DOSSIERS.length) { $("tableDocuments").innerHTML = messageVide(); return; }

  const lignes = DOSSIERS.map((d) => `
    <tr>
      <td><b>${echapper(d.reference)}</b></td>
      <td>${echapper(d.nom)}</td>
      <td class="num">${d.nb_mails}</td>
      <td class="num">${d.nb_pieces_jointes}</td>
      <td>${etatOuiNon(d.convention_signee, "signée", "non signée")}</td>
      <td>${etatOuiNon(d.diplome, "reçu", "non reçu")}</td>
      <td class="num">${heuresSuivies(d)}</td>
      <td>${d.premier_mail || "—"} → ${d.dernier_mail || "—"}</td>
      <td>${[
        d.sous_dossiers > 1
          ? `<a class="lien" data-ouvrir="${echapper(d.repertoire)}/factures">${d.sous_dossiers} factures</a>`
          : "",
        d.sous_dossiers_adresses > 1
          ? `<a class="lien" data-ouvrir="${echapper(d.repertoire)}/adresses">${d.sous_dossiers_adresses} adresses</a>`
          : "",
      ].filter(Boolean).join(" · ") || '<span class="lien inactif">aucun</span>'}</td>
      <td>${d.a_synthese
        ? `<a class="lien" data-ouvrir="${echapper(d.repertoire)}/synthese.pdf">Note de synthèse</a>`
        : '<span class="lien inactif">pas de note</span>'}</td>
      <td><a class="lien" data-ouvrir="${echapper(d.repertoire)}">Ouvrir le répertoire</a></td>
    </tr>`).join("");

  $("tableDocuments").innerHTML = `<table class="donnees">
    <tr><th>Référence</th><th>Débiteur</th><th>Mails</th><th>PJ</th>
        <th>Convention</th><th>Diplôme</th><th class="num">Heures</th>
        <th>Période</th><th>Sous-dossiers</th><th>Document</th><th></th></tr>
    ${lignes}</table>`;

  $("tableDocuments").querySelectorAll("[data-ouvrir]").forEach((lien) =>
    lien.addEventListener("click", async () => {
      try { await api("/api/ouvrir", { chemin: lien.dataset.ouvrir }); }
      catch (erreur) { afficherBandeau(false, erreur.message); }
    }));
}

// -- onglet État des dossiers
function rendreSuivi() {
  if (!DOSSIERS.length) { $("tableSuivi").innerHTML = messageVide(); return; }

  const options = (choisi) => STATUTS.map((s) =>
    `<option value="${s.cle}"${s.cle === choisi ? " selected" : ""}>` +
    `${s.icone ? s.icone + " " : ""}${echapper(s.libelle)}</option>`).join("");

  const lignes = DOSSIERS.map((d) => `
    <tr data-reference="${echapper(d.reference)}">
      <td><input type="checkbox" class="choix" data-ref="${echapper(d.reference)}" /></td>
      <td class="dossier"><b>${echapper(d.reference)}</b><br />
          <span style="color:var(--texte-3)">${echapper(d.nom)}</span></td>
      <td class="num">${euro(d.montant_du)}</td>
      <td class="num">${retard(d.anciennete_jours)}</td>
      <td><select data-champ="statut">${options(d.statut)}</select></td>
      <td class="num"><input class="frais" data-champ="frais" type="text"
          value="${d.frais ? d.frais : ""}" placeholder="0" /> €</td>
      <td><input class="note" data-champ="note" type="text"
          value="${echapper(d.note)}" placeholder="Référence avocat, audience…" /></td>
      <td class="num" style="font-size:12px">${d.duree_jours === null ||
          d.duree_jours === undefined ? "—" : d.duree_jours + " j"}</td>
      <td><a class="lien" data-detail="${echapper(d.reference)}">Parcours</a></td>
      <td style="color:var(--texte-3);font-size:11px">${echapper(d.maj)}</td>
    </tr>`).join("");

  $("tableSuivi").innerHTML = `
    <div class="barre-selection">
      <button class="secondaire" id="supprimer" disabled>Supprimer</button>
      <button class="secondaire danger" id="toutEffacer">Tout effacer…</button>
      <span id="compteChoix">Cochez les dossiers à retirer de la liste.</span>
    </div>
    <div class="defilable"><table class="donnees">
    <tr><th class="etroite"></th><th>Dossier</th><th class="num">Montant dû</th>
        <th class="num">Retard</th><th>État</th>
        <th class="num">Frais engagés</th><th>Note</th>
        <th class="num">Durée</th><th></th><th>Modifié</th></tr>
    ${lignes}</table></div><div id="detailDossier"></div>`;

  $("tableSuivi").querySelectorAll(".choix").forEach((coche) =>
    coche.addEventListener("change", majSelection));
  $("supprimer").addEventListener("click", supprimerChoisis);
  $("toutEffacer").addEventListener("click", toutEffacer);
  majSelection();

  $("tableSuivi").querySelectorAll("[data-detail]").forEach((lien) =>
    lien.addEventListener("click", () => rendreDetail(lien.dataset.detail)));

  $("tableSuivi").querySelectorAll("[data-champ]").forEach((champ) => {
    const evenement = champ.tagName === "SELECT" ? "change" : "change";
    champ.addEventListener(evenement, async () => {
      const reference = champ.closest("tr").dataset.reference;
      try {
        const reponse = await api("/api/suivi",
          { reference: reference, [champ.dataset.champ]: champ.value });
        const dossier = DOSSIERS.find((d) => d.reference === reference);
        if (dossier) {
          dossier.statut = reponse.dossier.statut || dossier.statut;
          dossier.frais = reponse.dossier.frais || 0;
          dossier.note = reponse.dossier.note || "";
          dossier.maj = reponse.dossier.maj || "";
        }
        champ.closest("tr").lastElementChild.textContent = reponse.dossier.maj || "";
        // Le changement d'étape vient d'être daté : la courbe et les durées se
        // recalculent sur le poste, on recharge plutôt que de les deviner ici.
        if (champ.dataset.champ === "statut") { chargerDossiers(); return; }
        rendreBord();
      } catch (erreur) { afficherBandeau(false, erreur.message); }
    });
  });
}

// -- onglet Tableau de bord

// -- courbe : où en est le portefeuille, mois après mois
//
// Aire empilée : à la fin de chaque mois, combien de dossiers à chaque étape.
// Un simple cumul des étapes atteintes montrerait une progression même là où
// tout stagne ; l'empilement montre le portefeuille tel qu'il est.
//
// Les cinq étapes en cours partagent une teinte, de la plus soutenue à la plus
// claire — la couleur dit l'avancement, pas l'identité. Les deux issues portent
// une couleur d'état et une icône : ce vert et ce rouge ne se distinguent pas
// en vision deutan, l'icône et le libellé portent seuls le sens.

// -- parcours d'un dossier : chaque étape, sa date, et la durée totale
//
// Les dates sont modifiables : une étape se saisit souvent quelques jours
// après s'être produite, et la durée de procédure serait fausse de toute la
// latence de saisie.
function rendreDetail(reference) {
  const dossier = DOSSIERS.find((d) => d.reference === reference);
  const zone = $("detailDossier");
  if (!dossier) { zone.innerHTML = ""; return; }

  const nom = (cle) => {
    const statut = STATUTS.find((s) => s.cle === cle);
    return statut ? (statut.icone ? statut.icone + " " : "") + statut.libelle : cle;
  };
  const couleur = (cle) => {
    const statut = STATUTS.find((s) => s.cle === cle);
    return statut ? statut.couleur : "var(--texte-3)";
  };

  const etapes = dossier.etapes || [];
  const rangees = etapes.length ? etapes.map((etape, rang) => `
    <tr>
      <td><input type="text" data-rang="${rang}" value="${echapper(etape.date)}"
           placeholder="JJ/MM/AAAA" /></td>
      <td><span class="pastille" style="background:${couleur(etape.statut)}"></span>
          ${echapper(nom(etape.statut))}</td>
    </tr>`).join("")
    : '<tr><td colspan="2" class="vide">Aucune étape enregistrée. Changez l\'état ' +
      "du dossier ci-dessus : le changement sera daté du jour.</td></tr>";

  const monday = [];
  if (dossier.date_contentieux_monday) {
    monday.push("passage au contentieux le " + echapper(dossier.date_contentieux_monday));
  }
  if (dossier.date_cloture_monday) {
    monday.push("clôture le " + echapper(dossier.date_cloture_monday));
  }

  zone.innerHTML = `
    <div class="detail">
      <h3>Parcours — ${echapper(dossier.reference)} · ${echapper(dossier.nom)}</h3>
      <p class="aide">
        ${dossier.debut ? "Entré au contentieux le <b>" + echapper(dossier.debut) + "</b>" : "Pas encore transmis"}${
          dossier.cloture ? ", clôturé le <b>" + echapper(dossier.cloture) + "</b>" : ""}${
          dossier.duree_jours !== null && dossier.duree_jours !== undefined
            ? " — <b>" + dossier.duree_jours + " jours</b> de procédure" : ""}.
      </p>
      <table>${rangees}</table>
      <p class="note">Corrigez une date en la modifiant ; videz-la pour retirer
         l'étape. ${monday.length
           ? "D'après le journal Monday : " + monday.join(", ") + "."
           : ""}</p>
      <div class="boutons"><button class="secondaire" id="fermerDetail">Fermer</button></div>
    </div>`;

  zone.querySelectorAll("input[data-rang]").forEach((champ) =>
    champ.addEventListener("change", async () => {
      try {
        await api("/api/etape", {
          reference: reference, rang: Number(champ.dataset.rang), date: champ.value,
        });
        await chargerDossiers();
        rendreDetail(reference);
      } catch (erreur) { afficherBandeau(false, erreur.message); }
    }));
  $("fermerDetail").addEventListener("click", () => { zone.innerHTML = ""; });
  zone.scrollIntoView({ behavior: "smooth", block: "nearest" });
}


// -- ancienneté des créances et dossiers en souffrance
function rendreAnciennete() {
  const a = AGREGATS;
  const tranches = (a && a.tranches_anciennete) || [];
  const total = tranches.reduce((somme, t) => somme + t.montant, 0);

  if (!total) {
    $("anciennete").innerHTML = "<h3>Ancienneté des créances</h3>" +
      '<p class="vide">Aucune échéance de facture n\'est renseignée dans le ' +
      "tableau de suivi : sans elle, l'ancienneté d'une créance ne peut pas " +
      "être calculée.</p>";
    return;
  }

  const maximum = Math.max(1, ...tranches.map((t) => t.montant));
  $("anciennete").innerHTML = `
    <h3>Montant encore dû, par ancienneté de la créance</h3>
    <p class="aide">Depuis l'échéance de la facture, sur les seuls dossiers non
       clôturés. Une créance déjà recouvrée n'a plus d'ancienneté.</p>
    <div class="barres">${tranches.map((t) => `
      <div class="rangee" title="${echapper(t.libelle)} — ${euro(t.montant)}, ${t.nombre} dossier(s)">
        <div class="etiquette">${echapper(t.libelle)}</div>
        <div class="piste">
          <div class="remplissage" style="width:${(100 * t.montant / maximum).toFixed(1)}%;
               background:${t.couleur}"></div>
        </div>
        <div class="valeur">${t.montant ? euro(t.montant) : "—"}<span> · ${t.nombre} dossier${t.nombre > 1 ? "s" : ""}</span></div>
      </div>`).join("")}</div>`;
}

// Ce qui rend un dossier defendable, avant meme de parler d'etape : une
// convention signee et des heures suivies etablissent que la prestation a ete
// fournie. Le non renseigne est compte a part, jamais avec les « non » — un
// tableau qui se tait ne dit pas que la convention manque.
function rendreSolidite() {
  const zone = $("solidite");
  if (!zone) return;
  const s = (AGREGATS || {}).solidite;
  if (!s || !s.nb_en_cours) {
    zone.innerHTML = "<h3>Solidité des dossiers</h3>"
      + '<p class="aide">Aucun dossier en cours.</p>';
    return;
  }

  const barre = (titre, r, oui, non) => {
    const total = r.oui + r.non + r.inconnu || 1;
    const part = (n) => (100 * n / total).toFixed(1) + "%";
    return `
      <div class="solide">
        <div class="solide-titre">${titre}</div>
        <div class="solide-barre">
          <span class="oui" style="width:${part(r.oui)}" title="${r.oui} ${oui}"></span>
          <span class="non" style="width:${part(r.non)}" title="${r.non} ${non}"></span>
          <span class="inconnu" style="width:${part(r.inconnu)}"
                title="${r.inconnu} non renseigné"></span>
        </div>
        <div class="solide-legende">
          <span><b class="oui">✓</b> ${r.oui} ${oui}</span>
          <span><b class="non">✕</b> ${r.non} ${non}${
            r.montant_non ? " · " + euro(r.montant_non) : ""}</span>
          <span><b class="inconnu">—</b> ${r.inconnu} non renseigné</span>
        </div>
      </div>`;
  };

  zone.innerHTML = `
    <h3>Solidité des dossiers en cours</h3>
    <p class="aide">Sur ${s.nb_en_cours} dossier(s) non clôturés. Une convention
       signée et des heures suivies établissent que la prestation a été fournie :
       c'est ce qu'on oppose à « je n'ai rien reçu ».</p>
    ${barre("Convention de formation", s.convention, "signée(s)", "non signée(s)")}
    ${barre("Diplôme", s.diplome, "délivré(s)", "non délivré(s)")}
    ${s.assiduite_mediane === null ? ""
      : `<p class="aide">Assiduité médiane : <b>${s.assiduite_mediane} %</b>
         du volume horaire prévu, sur ${s.nb_assiduite} dossier(s) renseigné(s).</p>`}`;
}

function rendreDormants() {
  const a = AGREGATS;
  const liste = (a && a.dormants) || [];
  const zone = $("dormants");

  if (!liste.length) {
    zone.innerHTML = "<h3>Dossiers en souffrance</h3>" +
      `<p class="vide">Aucun dossier transmis n'est resté plus de ${a.seuil_dormance} ` +
      "jours sans changement d'étape." +
      (a.nb_jamais_transmis ? ` ${a.nb_jamais_transmis} dossier(s) restent à transmettre.` : "") +
      "</p>";
    return;
  }

  // Liste plafonnée, mais jamais en silence : un tableau tronqué sans le dire
  // ferait croire que tout le reste va bien.
  const PLAFOND = 12;
  const montres = liste.slice(0, PLAFOND);
  const restants = liste.length - montres.length;

  zone.innerHTML = `
    <h3>Dossiers en souffrance — ${liste.length}</h3>
    <p class="aide">Transmis, non clôturés, et sans changement d'étape depuis plus
       de ${a.seuil_dormance} jours — du plus ancien au plus récent. Les dossiers
       jamais transmis n'y figurent pas : ils n'ont pas commencé.${
       restants ? ` Les ${PLAFOND} plus anciens sont listés ; ${restants} autre(s) suivent, à voir dans l'onglet « État des dossiers ».` : ""}</p>
    <table class="donnees">
      <tr><th>Dossier</th><th class="num">Montant dû</th><th>Étape</th>
          <th class="num">Sans mouvement</th></tr>
      ${montres.map((d) => `
        <tr>
          <td><b>${echapper(d.reference)}</b><br />
              <span style="color:var(--texte-3)">${echapper(d.nom)}</span></td>
          <td class="num">${euro(d.montant_du)}</td>
          <td>${pastilleStatut(d.statut)}</td>
          <td class="num">${d.jours_sans_mouvement} j</td>
        </tr>`).join("")}
    </table>`;
}

function rendreCourbe() {
  const zone = $("courbeBord");
  const courbe = (AGREGATS && AGREGATS.courbe) || { mois: [], series: [] };

  if (courbe.mois.length < 2 || !courbe.series.length) {
    zone.innerHTML = "<h3>Avancement du portefeuille</h3>" +
      '<p class="vide">La courbe apparaît dès que deux mois d\'étapes sont ' +
      "enregistrés. Renseignez l'étape de vos dossiers dans l'onglet " +
      "« État des dossiers » : chaque changement est daté.</p>";
    return;
  }

  const L = 760, H = 240, marge = { g: 34, d: 12, h: 12, b: 26 };
  const largeur = L - marge.g - marge.d, hauteur = H - marge.h - marge.b;
  const n = courbe.mois.length;
  const total = courbe.mois.map((_, i) =>
    courbe.series.reduce((somme, s) => somme + s.valeurs[i], 0));
  const plafond = Math.max(1, ...total);

  const x = (i) => marge.g + (n === 1 ? largeur / 2 : (largeur * i) / (n - 1));
  const y = (v) => marge.h + hauteur - (hauteur * v) / plafond;

  // Empilement du bas vers le haut, dans l'ordre des étapes.
  let bas = new Array(n).fill(0);
  const aires = courbe.series.map((serie) => {
    const haut = bas.map((v, i) => v + serie.valeurs[i]);
    // Le contour remonte par le haut puis redescend par le bas, en sens
    // inverse. Inverser une liste déjà indexée à l'envers la remettrait à
    // l'endroit, et le polygone se croiserait sur toute sa longueur.
    const chemin =
      haut.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("") +
      bas.slice().reverse()
         .map((v, k) => `L${x(n - 1 - k).toFixed(1)},${y(v).toFixed(1)}`).join("") + "Z";
    const ligne = haut.map((v, i) =>
      `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");
    bas = haut;
    return { serie, chemin, ligne };
  });

  const graduations = [0, 0.5, 1].map((part) => {
    const valeur = Math.round(plafond * part);
    return `<line class="grille" x1="${marge.g}" y1="${y(valeur)}" x2="${L - marge.d}" y2="${y(valeur)}" />` +
      `<text class="axe" x="${marge.g - 6}" y="${y(valeur) + 3}" text-anchor="end">${valeur}</text>`;
  }).join("");

  const pas = Math.max(1, Math.ceil(n / 8));
  const mois = courbe.mois.map((libelle, i) => i % pas === 0
    ? `<text class="axe" x="${x(i)}" y="${H - 8}" text-anchor="middle">${libelle}</text>` : "").join("");

  // Un trait de 2 px au sommet de chaque bande, sur le fond : la séparation
  // reste lisible quand deux bandes voisines ont la même couleur.
  const bandes = aires.map(({ serie, chemin, ligne }) => `
    <path d="${chemin}" fill="${serie.couleur}" fill-opacity="0.85" />
    <path d="${ligne}" fill="none" stroke="#0b0e1a" stroke-width="2" />`).join("");

  zone.innerHTML = `
    <h3>Avancement du portefeuille</h3>
    <p class="aide">Nombre de dossiers à chaque étape, à la fin de chaque mois.</p>
    <div class="courbe" style="position:relative">
      <svg viewBox="0 0 ${L} ${H}" id="svgCourbe">
        ${graduations}${bandes}${mois}
        <line class="curseur" id="curseurCourbe" y1="${marge.h}" y2="${marge.h + hauteur}" style="display:none" />
        <rect x="${marge.g}" y="${marge.h}" width="${largeur}" height="${hauteur}"
              fill="transparent" id="zoneCourbe" />
      </svg>
      <div class="infobulle" id="bulleCourbe" style="display:none"></div>
    </div>
    <div class="legende">${courbe.series.map((s) =>
      `<span><i style="background:${s.couleur}"></i>${s.icone ? s.icone + " " : ""}${echapper(s.libelle)}</span>`
    ).join("")}</div>`;

  const zoneSurvol = $("zoneCourbe"), bulle = $("bulleCourbe"), curseur = $("curseurCourbe");
  zoneSurvol.addEventListener("mousemove", (ev) => {
    const cadre = $("svgCourbe").getBoundingClientRect();
    const relatif = ((ev.clientX - cadre.left) / cadre.width) * L;
    const i = Math.max(0, Math.min(n - 1,
      Math.round(((relatif - marge.g) / largeur) * (n - 1))));

    curseur.setAttribute("x1", x(i));
    curseur.setAttribute("x2", x(i));
    curseur.style.display = "";

    bulle.innerHTML = "<b>" + courbe.mois[i] + " — " + total[i] + " dossier(s)</b>" +
      courbe.series.filter((s) => s.valeurs[i]).reverse().map((s) =>
        `<div><span><i style="background:${s.couleur};width:9px;height:9px;` +
        `border-radius:2px;display:inline-block;margin-right:6px"></i>` +
        `${s.icone ? s.icone + " " : ""}${echapper(s.libelle)}</span><b style="display:inline">` +
        `${s.valeurs[i]}</b></div>`).join("");
    bulle.style.display = "";
    const gauche = (x(i) / L) * cadre.width;
    bulle.style.left = Math.min(cadre.width - 210, Math.max(0, gauche + 12)) + "px";
    bulle.style.top = "8px";
  });
  zoneSurvol.addEventListener("mouseleave", () => {
    bulle.style.display = "none";
    curseur.style.display = "none";
  });
}

function rendreBord() {
  if (!DOSSIERS.length) {
    $("tuilesBord").innerHTML = "";
    $("grapheBord").innerHTML = messageVide();
    return;
  }
  const a = AGREGATS = recalculer();

  const tuiles = [
    ["Dossiers suivis", a.nb_dossiers, `dont ${a.nb_en_cours} en cours`, ""],
    ["Montant en contentieux", euro(a.montant_en_cours), "dossiers non clôturés", ""],
    ["Frais engagés", euro(a.frais_engages), "avocat, huissier, greffe", ""],
    ["Recouvré", euro(a.montant_gagne),
     `${a.nb_sans_tribunal} sans tribunal · ${a.nb_au_tribunal} au tribunal`,
     "#0ca30c", "✓"],
    ["Perdu", euro(a.montant_perdu), `${a.nb_perdus} dossier(s) perdu(s)`, "#d03b3b", "✕"],
    ["Taux de réussite", a.taux_reussite === null ? "—" : a.taux_reussite + " %",
     "sur les dossiers clôturés", ""],
    ["Durée médiane", a.duree_mediane === null ? "—" : a.duree_mediane + " j",
     "de la transmission à la clôture", ""],
    ["Coût du recouvrement", a.cout_par_euro === null ? "—" :
       a.cout_par_euro.toFixed(2).replace(".", ",") + " €",
     "de frais par euro déjà recouvré", ""],
    ["Dossiers en souffrance", a.dormants.length,
     `sans mouvement depuis plus de ${a.seuil_dormance} jours`,
     a.dormants.length ? "#fab219" : ""],
  ];

  $("tuilesBord").innerHTML = tuiles.map(([lib, val, sous, couleur, icone]) => `
    <div class="tuile">
      <div class="lib">${couleur ? `<span class="pastille" style="background:${couleur}"></span>` : ""}
        ${icone ? icone + " " : ""}${lib}</div>
      <div class="val">${val}</div>
      <div class="sous">${sous}</div>
    </div>`).join("");

  // La longueur encode le montant, pas le nombre : c'est l'enjeu financier
  // qui décide où porter l'effort, et c'est lui que l'œil doit comparer. Le
  // nombre de dossiers reste en étiquette, jamais encodé par la longueur.
  const maximum = Math.max(1, ...a.par_statut.map((s) => s.montant));
  const barres = a.par_statut.map((s) => `
    <div class="rangee" title="${echapper(s.libelle)} — ${euro(s.montant)}, ${s.nombre} dossier(s)${s.frais ? ", " + euro(s.frais) + " de frais engagés" : ""}">
      <div class="etiquette">${s.icone ? s.icone + " " : ""}${echapper(s.libelle)}</div>
      <div class="piste">
        <div class="remplissage" style="width:${(100 * s.montant / maximum).toFixed(1)}%;
             background:${s.couleur}"></div>
      </div>
      <div class="valeur">${s.montant ? euro(s.montant) : "—"}<span> · ${s.nombre} dossier${s.nombre > 1 ? "s" : ""}</span></div>
    </div>`).join("");

  rendreCourbe();
  rendreAnciennete();
  rendreDormants();
  rendreSolidite();

  $("grapheBord").innerHTML = `
    <h3>Montant en contentieux par étape</h3>
    <p class="aide">La longueur des barres représente le montant dû ; le nombre de
       dossiers est indiqué à côté. Les cinq étapes en cours partagent une même
       teinte, de la plus soutenue à la plus claire ; les trois issues portent une
       couleur d'état et une icône, la couleur seule ne les distinguant pas en
       vision deutéranope.</p>
    <div class="barres">${barres}</div>`;
}

function recalculer() {
  const par = STATUTS.map((s) => ({ ...s, nombre: 0, montant: 0, frais: 0 }));
  const index = Object.fromEntries(par.map((s, i) => [s.cle, i]));
  for (const d of DOSSIERS) {
    const case_ = par[index[d.statut] ?? 0];
    case_.nombre += 1; case_.montant += d.montant_du; case_.frais += d.frais || 0;
  }
  // La famille — en cours, gagné, perdu — vient du serveur avec les états :
  // la coder ici en dur ferait diverger les deux dès qu'une étape est ajoutée.
  const famille = Object.fromEntries(STATUTS.map((s) => [s.cle, s.famille]));
  const est = (d, f) => famille[d.statut] === f;
  const somme = (f) => DOSSIERS.filter(f).reduce((t, d) => t + d.montant_du, 0);
  const gagnes = DOSSIERS.filter((d) => est(d, "gagne"));
  const perdus = DOSSIERS.filter((d) => est(d, "perdu"));
  const durees = DOSSIERS.map((d) => d.duree_jours)
    .filter((v) => v !== null && v !== undefined).sort((a, b) => a - b);
  return {
    par_statut: par, nb_dossiers: DOSSIERS.length,
    nb_en_cours: DOSSIERS.filter((d) => est(d, "cours")).length,
    montant_en_cours: somme((d) => est(d, "cours")),
    frais_engages: DOSSIERS.reduce((t, d) => t + (d.frais || 0), 0),
    montant_gagne: somme((d) => est(d, "gagne")),
    montant_perdu: somme((d) => est(d, "perdu")),
    nb_gagnes: gagnes.length, nb_perdus: perdus.length,
    nb_sans_tribunal: DOSSIERS.filter((d) => d.statut === "cloture-recouvrement").length,
    nb_au_tribunal: DOSSIERS.filter((d) => d.statut === "tribunal-gagne").length,
    duree_mediane: durees.length ? durees[Math.floor(durees.length / 2)] : null,
    // La courbe se calcule sur le poste, une seule fois : la recalculer ici
    // dupliquerait l'empilement mois par mois, et les deux finiraient par
    // ne plus dire la même chose.
    courbe: COURBE,
    // Ancienneté, dossiers en souffrance et coût du recouvrement se calculent
    // sur le poste : les redériver ici les ferait diverger dès qu'une règle
    // change d'un côté seulement.
    tranches_anciennete: SERVEUR ? SERVEUR.tranches_anciennete : [],
    dormants: SERVEUR ? SERVEUR.dormants : [],
    seuil_dormance: SERVEUR ? SERVEUR.seuil_dormance : 60,
    nb_jamais_transmis: SERVEUR ? SERVEUR.nb_jamais_transmis : 0,
    cout_par_euro: SERVEUR ? SERVEUR.cout_par_euro : null,
    // Comme l'ancienneté : calculée sur le poste, et rafraîchie à chaque
    // changement d'étape puisque celui-ci recharge les dossiers.
    solidite: SERVEUR ? SERVEUR.solidite : null,
    taux_reussite: (gagnes.length + perdus.length)
      ? Math.round(100 * gagnes.length / (gagnes.length + perdus.length)) : null,
  };
}

function echapper(texte) {
  const div = document.createElement("div");
  div.textContent = texte == null ? "" : String(texte);
  return div.innerHTML;
}

chargerDossiers();

function afficherBandeau(reussi, message) {
  const bandeau = $("bandeau");
  bandeau.textContent = message;
  bandeau.className = "bandeau visible " + (reussi ? "reussi" : "rate");
}
</script>
</body></html>
"""


def demarrer(port: int = 0, ouvrir: bool = True, veille: bool = False) -> ThreadingHTTPServer:
    serveur = ThreadingHTTPServer(("127.0.0.1", port), Gestionnaire)
    adresse = f"http://127.0.0.1:{serveur.server_address[1]}/"

    print("Interface d'export recouvrement")
    print(f"  {adresse}")
    print("  Laissez cette fenêtre ouverte pendant l'utilisation.")
    print("  Ctrl+C pour arrêter.\n")

    if ouvrir:
        threading.Timer(0.4, lambda: webbrowser.open(adresse)).start()
    if veille:
        signaler_activite()
        threading.Thread(target=_veiller, args=(serveur,), daemon=True).start()
    return serveur


def main() -> int:
    serveur = demarrer(veille=True)
    try:
        serveur.serve_forever()
    except KeyboardInterrupt:
        print("\nInterface arrêtée.")
    finally:
        serveur.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
