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
import shutil
import subprocess
import sys
import threading
import time
import webbrowser
from collections.abc import Iterable
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import export_mails  # noqa: E402
from gmail_api import ErreurGmail  # noqa: E402
from dossiers import ErreurDossiers  # noqa: E402
from rendu import moteur_pdf_disponible  # noqa: E402
import indexation as module_indexation  # noqa: E402
import suivi as module_suivi  # noqa: E402
import synthese as module_synthese  # noqa: E402

RACINE = Path(__file__).resolve().parent
# Affiché dans l'en-tête. Au téléphone, savoir quelle version tourne vaut
# mieux que deviner d'après la présence d'un champ à l'écran. Tenu dans son
# propre module : chaque note de synthèse en est marquée, et l'application
# repère ainsi celles qu'une version antérieure a écrites.
from version import VERSION  # noqa: E402, PLC0415
PREFERENCES = RACINE / "interface-preferences.json"
# Le suivi vit à côté de l'outil, pas dans l'export : refaire un export
# ne doit pas effacer l'état d'avancement des dossiers.
SUIVI = RACINE / "suivi-dossiers.json"
# Les fichiers de suivi tenus a part — convention, diplome, heures, mais
# aussi les exports de facturation qui portent les adresses et les numeros
# d'un outil precedent. Deposes une fois, reappliques apres chaque export.
# Plusieurs coexistent : la facturation de Liora est repartie sur deux
# outils, et n'en retenir qu'un laissait la moitie des dossiers sans adresse.
COMPLEMENTS = RACINE / "complements-suivi"
# Le suivi du service, livré avec l'application : les étapes, les adresses et
# les échéances du tableau tenu à la main, extraites une fois pour toutes. Il
# évite d'avoir à déposer un fichier pour retrouver ce qui est déjà connu, et
# se comporte comme un fichier déposé — les saisies faites ici l'emportent
# toujours sur lui.
SUIVI_INITIAL = RACINE / "suivi-initial.csv"
# L'emplacement de la version precedente, qui n'en gardait qu'un seul.
COMPLEMENT = RACINE / "complement-suivi"
# Fiches publiques des debiteurs entreprises, conservees pour ne pas
# reinterroger le service de l'Etat a chaque ouverture.
ANNUAIRE = RACINE / "annuaire-entreprises.json"
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
        # Un export dure une heure. Lance par erreur, il fallait le laisser
        # aller au bout ou fermer la fenetre : l'arret se demande, le dossier
        # en cours va a son terme, et le recapitulatif est ecrit pour ce qui a
        # ete fait.
        self._arret = threading.Event()
        self.lignes: list[str] = []
        self.en_cours = False
        self.termine = False
        self.code: int | None = None
        self.erreur: str | None = None
        self.sortie: str = ""

    def demander_arret(self) -> bool:
        """Demande l'arret. Vrai si un export tournait pour l'entendre."""
        with self._verrou:
            if not self.en_cours:
                return False
            self._arret.set()
            return True

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
                "arret_demande": self._arret.is_set(),
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
            self._arret.clear()

        def travail() -> None:
            try:
                options = export_mails.analyser_arguments(arguments)
                code = export_mails.executer(
                    options, relais=self.ajouter, arret=self._arret.is_set)
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
                for complement in (complements_memorises() if code == 0 else []):
                    try:
                        bilan = appliquer_complement(complement)
                    except Exception as exc:  # noqa: BLE001 - jamais bloquant
                        self.ajouter(
                            f"⚠ {complement.name} non appliqué : {exc}")
                    else:
                        self.ajouter(
                            f"{complement.name} appliqué : {bilan['valeurs']} "
                            f"valeur(s) sur {bilan['dossiers']} dossier(s)."
                            + (f" Dont {bilan['adresses']} adresse(s) mail."
                               if bilan.get("adresses") else "")
                            + (f" {bilan['etapes']} étape(s) reprise(s) du "
                               "tableau." if bilan.get("etapes") else "")
                            + (f" {bilan['sans_correspondance']} ligne(s) sans "
                               "dossier correspondant."
                               if bilan["sans_correspondance"] else "")
                        )

                if code == 0:
                    self._consulter_annuaire()

            with self._verrou:
                self.en_cours = False
                self.termine = True
                self.code = code
                self.erreur = message

        threading.Thread(target=travail, daemon=True).start()

    def _consulter_annuaire(self) -> None:
        """L'annuaire public, interrogé pour les dossiers qui viennent d'être
        créés. Jamais bloquant : une créance ne dépend pas d'un service tiers,
        et un annuaire injoignable ne doit pas faire échouer un export."""
        try:
            bilan = completer_annuaire()
        except Exception as exc:  # noqa: BLE001 - jamais bloquant
            self.ajouter(f"⚠ annuaire des entreprises non consulté : {exc}")
            return
        if bilan["trouvees"] or bilan["sans_fiche"]:
            self.ajouter(
                f"Annuaire des entreprises : {bilan['trouvees']} fiche(s) "
                f"trouvée(s), {bilan['sans_fiche']} sans correspondance."
            )
        if bilan["echecs"]:
            self.ajouter(
                f"⚠ annuaire des entreprises : {bilan['echecs']} échec(s) — "
                f"{bilan['motif']}"
            )


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


# Refaire les notes etait un geste a soi : on corrigeait une echeance, la note
# gardait l'ancienne, et rien ne le disait tant qu'on ne l'ouvrait pas. Elles
# se refont desormais d'elles-memes, en arriere-plan.
#
# En arriere-plan et non dans la reponse : reecrire cinquante notes prend une
# demi-minute, et la page attendrait sans rien afficher. Un seul rafraichissement
# a la fois, et jamais pendant un export — les deux ecriraient dans les memes
# repertoires.
_VERROU_NOTES = threading.Lock()
NOTES_EN_COURS: set[str] = set()

# Les notes qu'on n'a pas pu réécrire, et pourquoi. Sans ce relevé, une note
# qu'un lecteur PDF tient ouverte reste en retard, la page la remet en
# chantier à chaque affichage, et le bandeau « mise à jour en cours » ne
# s'éteint jamais sans qu'on sache ce qui bloque.
NOTES_EN_ECHEC: dict[str, str] = {}


def rafraichir_notes(references: list[str]) -> None:
    """Refait les notes indiquees, une a une, sans bloquer la page."""
    if not references or EXECUTION.en_cours:
        return

    def travail() -> None:
        if not _VERROU_NOTES.acquire(blocking=False):
            return
        try:
            sortie = Path(lire_preferences().get("sortie") or sortie_par_defaut())
            suivi = module_suivi.charger(SUIVI)
            copie = (lire_preferences().get("copie_vers") or "").strip()
            destination = Path(copie) if copie else None
            voulues = set(references)
            for dossier in module_suivi.inventaire(sortie, SUIVI):
                reference = dossier["reference"]
                if reference not in voulues or EXECUTION.en_cours:
                    continue
                repertoire = sortie / dossier["repertoire"]
                if not repertoire.is_dir():
                    continue
                try:
                    refaite, motif = _refaire_synthese(repertoire, dossier, suivi)
                    recopier_note(repertoire, sortie, destination)
                except Exception as exc:  # noqa: BLE001 - jamais bloquant
                    NOTES_EN_ECHEC[reference] = str(exc)
                    continue
                if refaite:
                    NOTES_EN_ECHEC.pop(reference, None)
                else:
                    NOTES_EN_ECHEC[reference] = motif or "cause inconnue"
        finally:
            NOTES_EN_COURS.difference_update(references)
            _VERROU_NOTES.release()

    NOTES_EN_COURS.update(references)
    threading.Thread(target=travail, daemon=True).start()


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


# Un nom de fichier vient de la page : il ne doit pas pouvoir désigner un
# emplacement hors du répertoire prévu.
def _nom_sur_disque(nom: str, extension: str) -> str:
    base = Path(nom or "fichier").stem[:60]
    propre = "".join(c if c.isalnum() or c in " -_." else "-" for c in base)
    return (propre.strip(" .-") or "fichier") + extension


def complements_memorises() -> list[Path]:
    """Les fichiers de suivi déposés, dans l'ordre où ils ont été retenus.

    Plusieurs coexistent : Zoho porte les numéros d'origine, Sellsy les
    adresses, et un dossier n'est complet qu'avec les deux. Redéposer un
    fichier du même nom le remplace, ce qui est la façon de le mettre à jour.
    """
    _migrer_complement_unique()
    # Le suivi livré avec l'application vient en premier : ce que la personne
    # a déposé elle-même est plus récent, et doit donc s'appliquer après.
    livre = [SUIVI_INITIAL] if suivi_livre_actif() else []
    if not COMPLEMENTS.is_dir():
        return livre
    retenus = (lire_preferences().get("complements") or [])
    fichiers = {chemin.name: chemin for chemin in COMPLEMENTS.iterdir()
                if chemin.is_file()}
    ordonnes = [fichiers.pop(nom) for nom in retenus if nom in fichiers]
    return livre + ordonnes + sorted(fichiers.values())


def suivi_livre_actif() -> bool:
    """Dit si le suivi livré avec l'application doit encore être appliqué.

    Ce fichier fait partie de l'installation : on ne l'efface jamais, sans
    quoi une simple remise à zéro le ferait disparaître pour de bon et il
    faudrait réinstaller l'outil pour le retrouver. Y renoncer est donc une
    préférence, pas une suppression — et redéposer un fichier n'a rien à voir
    avec lui.
    """
    if not SUIVI_INITIAL.exists():
        return False
    return not lire_preferences().get("suivi_livre_ecarte")


def _migrer_complement_unique() -> None:
    """Reprend le fichier retenu par la version précédente."""
    nom = (lire_preferences().get("complement") or "").strip()
    if not nom:
        return
    ancien = RACINE / nom
    memoriser_preferences({"complement": ""})
    if not ancien.exists():
        return
    COMPLEMENTS.mkdir(parents=True, exist_ok=True)
    destination = COMPLEMENTS / ancien.name
    try:
        ancien.replace(destination)
    except OSError:
        return
    retenus = list(lire_preferences().get("complements") or [])
    if destination.name not in retenus:
        memoriser_preferences({"complements": [*retenus, destination.name]})


def complement_memorise() -> Path | None:
    """Le premier fichier de suivi *déposé*, s'il y en a un.

    Le suivi livré avec l'application n'en est pas : il n'a pas été choisi,
    et l'annoncer comme « fichier retenu » laisserait croire qu'un dépôt a eu
    lieu.
    """
    deposes = [c for c in complements_memorises() if c != SUIVI_INITIAL]
    return deposes[0] if deposes else None


def appliquer_complement(chemin: Path) -> dict:
    """Reprend d'un fichier de suivi ce qui manque aux dossiers exportés.

    Un seul onglet est retenu : celui dont les colonnes sont le mieux
    reconnues. Verser dans l'application tout ce qu'un classeur comptable
    contient — grand livre, avoirs, alternance — y ferait entrer des milliers
    de lignes sans rapport avec les dossiers en contentieux. Les autres
    onglets sont nommés dans le bilan, pour qu'un mauvais choix se voie.
    """
    from dossiers import ErreurDossiers, charger_onglets  # noqa: PLC0415

    sortie = Path(lire_preferences().get("sortie") or sortie_par_defaut())
    onglets = charger_onglets(chemin)
    if not onglets:
        raise ErreurDossiers(
            f"Aucun onglet exploitable dans {chemin.name} : il faut au minimum "
            "une colonne « numéro de facture » ou « email »."
        )

    dernier_echec = ""
    for rang, (titre, grille) in enumerate(onglets):
        try:
            bilan = module_suivi.completer_depuis_grille(
                grille, module_suivi.inventaire(sortie, SUIVI), SUIVI
            )
        except ErreurDossiers as exc:
            # Un onglet illisible ne condamne pas le fichier : on passe au
            # suivant, et l'échec n'est rendu que si aucun ne se laisse lire.
            dernier_echec = str(exc)
            continue

        bilan["onglet"] = titre
        bilan["ecartes"] = [autre for autre, _ in onglets if autre != titre]
        del rang
        return bilan

    raise ErreurDossiers(dernier_echec or f"{chemin.name} illisible.")


def appliquer_complements_si_besoin() -> dict:
    """Réapplique les fichiers de suivi retenus, quand ils ont changé.

    Un fichier déposé une fois vaut pour toujours : chaque fois qu'on en
    dépose une version fraîche au même endroit — ou qu'on met à jour celui
    qui est retenu — l'application le reprend d'elle-même, sans qu'il faille
    repasser par « Compléter depuis un fichier ».

    La date de dernière application est mémorisée par fichier : sans elle,
    chaque ouverture de la page relirait un classeur de trente mille lignes.
    """
    preferences = lire_preferences()
    vus = dict(preferences.get("complements_appliques") or {})
    # Les factures que le fichier connaît et que l'export ne porte pas, tenues
    # par fichier : elles ne sont recalculées qu'au réexamen de celui-ci, et
    # les perdre entre deux ouvertures de la page laisserait la question
    # « pourquoi je ne retrouve pas ce dossier » sans réponse.
    absents = dict(preferences.get("absents_suivi") or {})
    bilan = {"fichiers": 0, "dossiers": 0, "adresses": 0, "etapes": 0}

    for fichier in complements_memorises():
        try:
            etat = fichier.stat()
        except OSError:
            continue
        # Le récapitulatif entre dans l'empreinte : un export qui ajoute des
        # dossiers doit leur appliquer ce que le fichier sait déjà, sans quoi
        # seuls les dossiers présents au premier passage en profiteraient.
        try:
            recap = (Path(preferences.get("sortie") or sortie_par_defaut())
                     / "_recapitulatif.csv").stat().st_mtime_ns
        except OSError:
            recap = 0
        empreinte = f"{etat.st_mtime_ns}-{etat.st_size}-{recap}"
        if vus.get(fichier.name) == empreinte:
            continue
        try:
            part = appliquer_complement(fichier)
        except Exception:  # noqa: BLE001 - jamais bloquant pour l'affichage
            # Un fichier devenu illisible ne doit pas empêcher la liste de
            # s'afficher. Il sera signalé au prochain dépôt manuel.
            vus[fichier.name] = empreinte
            continue
        vus[fichier.name] = empreinte
        absents[fichier.name] = list(part.get("absents") or [])
        bilan["fichiers"] += 1
        for cle in ("dossiers", "adresses", "etapes"):
            bilan[cle] += part.get(cle, 0)

    # Un fichier oublié ne doit plus peser sur la page.
    absents = {nom: refs for nom, refs in absents.items() if nom in vus}
    if (vus != (preferences.get("complements_appliques") or {})
            or absents != (preferences.get("absents_suivi") or {})):
        memoriser_preferences({"complements_appliques": vus,
                               "absents_suivi": absents})
    bilan["absents"] = absents
    return bilan


def _lancer_rafraichissement(dossiers: list[dict]) -> set[str]:
    """Remet a jour les notes en retard, et dit lesquelles sont en chantier."""
    en_retard = [d["reference"] for d in dossiers if d.get("note_perimee")]
    rafraichir_notes(en_retard)
    return set(NOTES_EN_COURS)


def _etat_sauvegardes() -> dict:
    """Ce que le suivi contient, et ce que la dernière copie contenait.

    Un suivi qui rétrécit brutalement est la signature d'un accident. Le dire
    au moment où cela se voit, avec de quoi revenir en arrière, vaut mieux que
    de le découvrir trois semaines plus tard.
    """
    copies = module_suivi.sauvegardes(SUIVI)
    actuel = len(module_suivi.charger(SUIVI))
    precedent = 0
    if copies:
        try:
            donnees = json.loads(copies[0].read_text(encoding="utf-8"))
            precedent = len(donnees) if isinstance(donnees, dict) else 0
        except (OSError, ValueError):
            precedent = 0
    return {
        "copies": [c.name for c in copies[:12]],
        "dossiers_suivis": actuel,
        "dossiers_sauvegardes": precedent,
        # Le seuil est franc : on ne signale pas une suppression volontaire
        # d'un dossier ou deux, mais un effondrement.
        "perte": precedent >= 5 and actuel < precedent // 2,
    }


def absents_du_suivi() -> list[str]:
    """Les factures que les fichiers de suivi connaissent, sans dossier.

    L'application ne sait que ce que l'export lui a apporté. Une facture que
    le tableau porte et que l'export n'a pas ramenée n'existe nulle part dans
    la page — ni dans la liste, ni dans la recherche — et rien ne disait
    pourquoi. Les nommer permet de savoir qu'il faut les inclure au prochain
    export, plutôt que de croire l'application en défaut.
    """
    listes = (lire_preferences().get("absents_suivi") or {}).values()
    vues, ordonnees = set(), []
    for references in listes:
        for reference in references:
            texte = str(reference).strip()
            if texte and texte not in vues:
                vues.add(texte)
                ordonnees.append(texte)
    return ordonnees


FICHIERS_NOTE = ("synthese.pdf", "synthese.html", "synthese.version")


def recopier_note(repertoire: Path, sortie: Path, destination: Path | None) -> int:
    """Reporte la note refaite dans la copie de l'export, si elle existe.

    L'export est recopié vers un second emplacement — un SharePoint, le plus
    souvent — au moment où il se termine. Refaire une note ne touchait que
    l'original : on ouvrait la copie, on y retrouvait mot pour mot la note
    d'avant, et rien n'expliquait pourquoi la correction demandée semblait
    n'avoir servi à rien.

    Un PDF que la réécriture a retiré — faute de moteur, ou parce qu'il était
    ouvert ailleurs — est retiré de la copie aussi : l'y laisser rendrait
    l'ancienne note plus visible que la nouvelle.
    """
    if destination is None:
        return 0
    copies = 0
    for nom in FICHIERS_NOTE:
        origine = repertoire / nom
        arrivee = destination / repertoire.relative_to(sortie) / nom
        try:
            if not origine.exists():
                arrivee.unlink(missing_ok=True)
                continue
            arrivee.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(export_mails._chemin_long(origine),
                         export_mails._chemin_long(arrivee))
            copies += 1
        except OSError:
            # Une copie impossible ne remet pas la note en cause : elle est
            # écrite, et c'est l'original qui fait foi.
            continue
    return copies


ECARTES = "mails-hors-dossier"


def reclasser_index(repertoire: Path, emails: Iterable[str] = ()) -> int:
    """Réapplique aux messages déjà au dossier la règle du jour.

    Les dossiers constitués avant elle portent des messages qui ne concernent
    pas le débiteur : un fil de comptabilité adressé à trente apprenants, où
    notre numéro figure par hasard. Le filtrage se fait à l'export, et refaire
    une note ne les enlève pas — elle est réécrite depuis le même index.

    La règle est celle de l'export, mot pour mot : on garde le message qui cite
    la facture, celui qui porte une adresse du tableau, et la suite du fil
    venue de l'adresse qui en parle. Le reste sort du dossier — un dossier
    transmis au contentieux n'a pas à porter les échanges d'autres personnes.

    Sortir n'est pas détruire : les pièces écartées sont déplacées dans
    « mails-hors-dossier », à côté, où elles restent consultables.

    Renvoie le nombre de messages retirés du dossier.
    """
    index = repertoire / "index.csv"
    if not index.exists():
        return 0
    try:
        rangees = list(csv.DictReader(
            index.read_text(encoding="utf-8-sig").splitlines(), delimiter=";"))
    except OSError:
        return 0
    if not rangees:
        return 0

    preferences = lire_preferences()
    maison = {
        domaine.strip().lower().lstrip("@")
        for domaine in (preferences.get("domaines") or "").split(",")
        if domaine.strip()
    } | {
        adresse.split("@")[-1].strip().lower()
        for adresse in (preferences.get("boites") or "").split(",")
        if "@" in adresse
    }
    du_tableau = {a.strip().lower() for a in emails if a and a.strip()}

    def adresses(rangee: dict) -> set[str]:
        entetes = " ".join([rangee.get("expediteur") or "",
                            rangee.get("destinataires") or "",
                            rangee.get("copie") or ""])
        return {a.lower() for a in export_mails.MOTIF_ADRESSE.findall(entetes)}

    def exterieures(rangee: dict) -> set[str]:
        return {a for a in adresses(rangee)
                if a.rsplit("@", 1)[-1] not in maison}

    def cite(rangee: dict) -> bool:
        return bool((rangee.get("factures_concernees") or "").strip())

    # Fait foi, par fil, toute adresse extérieure figurant dans un message qui
    # cite notre facture : le débiteur écrit souvent d'une autre boîte que
    # celle du tableau, et c'est bien de notre créance qu'il parle.
    par_fil: dict[str, set[str]] = {}
    for rangee in rangees:
        fil = (rangee.get("thread_id") or "").strip()
        if fil and cite(rangee):
            par_fil.setdefault(fil, set()).update(exterieures(rangee))
    diffusions = export_mails.fils_de_diffusion(par_fil)

    if not par_fil and not du_tableau:
        # Rien pour trancher : on ne retire rien plutôt que de vider un dossier.
        return 0

    def a_garder(rangee: dict) -> bool:
        # Une pièce versée à la main est au dossier parce qu'on l'y a mise.
        if (rangee.get("critere") or "").strip().startswith(("déposé", "depose")):
            return True
        fil = (rangee.get("thread_id") or "").strip()
        presentes = adresses(rangee)
        if du_tableau & presentes:
            return True
        if fil in diffusions:
            return False
        if cite(rangee):
            return True
        attendues = par_fil.get(fil)
        return bool(attendues and attendues & presentes)

    gardees = [rangee for rangee in rangees if a_garder(rangee)]
    if len(gardees) == len(rangees):
        return 0

    # L'index d'abord, les fichiers ensuite. Dans l'autre ordre, un index.csv
    # ouvert dans Excel faisait échouer l'écriture après que les pièces
    # avaient été déplacées : le dossier gardait alors un index qui renvoyait
    # à des fichiers partis ailleurs. Si l'écriture échoue, rien n'a bougé.
    module_indexation._ecrire_csv(
        index, module_indexation.COLONNES_INDEX,
        [{cle: r.get(cle, "") for cle in module_indexation.COLONNES_INDEX}
         for r in gardees])

    for rangee in rangees:
        if a_garder(rangee):
            continue
        _ecarter_pieces(repertoire, rangee)

    return len(rangees) - len(gardees)


def accorder_recapitulatif(repertoire: Path, reference: str) -> None:
    """Remet le récapitulatif d'accord avec l'index du dossier.

    Le nombre de mails, les dates du premier et du dernier, les pièces
    jointes : la liste des dossiers les lit dans le récapitulatif. Après un
    reclassement, elle annonçait cinquante-huit messages là où le dossier n'en
    porte plus que huit.

    Jamais bloquant : un récapitulatif ouvert dans Excel ne se remplace pas,
    et ce n'est pas une raison pour refuser de refaire une note.
    """
    chemin = repertoire.parent / "_recapitulatif.csv"
    rangees = module_indexation.lire_recapitulatif(chemin)
    if not rangees:
        return
    try:
        lignes = list(csv.DictReader(
            (repertoire / "index.csv").read_text(encoding="utf-8-sig").splitlines(),
            delimiter=";"))
    except OSError:
        return

    dates = []
    for ligne in lignes:
        try:
            dates.append(datetime.strptime(ligne.get("date") or "", "%d/%m/%Y"))
        except ValueError:
            continue
    comptes = {
        "nb_mails": str(len(lignes)),
        "nb_recus": str(sum(1 for l in lignes if (l.get("sens") or "") == "reçu")),
        "nb_envoyes": str(sum(1 for l in lignes if (l.get("sens") or "") == "envoyé")),
        "nb_pieces_jointes": str(sum(
            int(_entier(l.get("nb_pieces_jointes"))) for l in lignes)),
        "premier_mail": min(dates).strftime("%d/%m/%Y") if dates else "",
        "dernier_mail": max(dates).strftime("%d/%m/%Y") if dates else "",
    }

    touchee = False
    for rangee in rangees:
        if (rangee.get("reference") or "").strip() == reference:
            rangee.update(comptes)
            touchee = True
    if not touchee:
        return
    try:
        module_indexation._ecrire_csv(
            chemin, module_indexation.COLONNES_RECAP,
            [{cle: r.get(cle, "") for cle in module_indexation.COLONNES_RECAP}
             for r in rangees])
    except OSError:
        return


def _entier(valeur) -> int:
    try:
        return int(str(valeur or "0").strip() or 0)
    except ValueError:
        return 0


def _ecarter_pieces(repertoire: Path, rangee: dict) -> None:
    """Déplace les fichiers d'un message hors du dossier, sans rien détruire.

    Un fichier ouvert dans un lecteur PDF ne se déplace pas sous Windows :
    l'échec est sans conséquence, la rangée quitte l'index de toute façon.
    """
    for cle in ("fichier_pdf", "fichier_eml", "dossier_pieces_jointes"):
        relatif = (rangee.get(cle) or "").strip()
        if not relatif:
            continue
        source = repertoire / relatif
        if not source.exists():
            continue
        destination = repertoire / ECARTES / relatif
        try:
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(source), str(destination))
        except OSError:
            continue


def _refaire_synthese(repertoire: Path, dossier: dict, suivi: dict) -> tuple[bool, str]:
    """Réécrit la note de synthèse d'un dossier déjà exporté.

    Les pièces et leur texte sont relus dans l'index et les `.eml` conservés :
    aucun message n'est retéléchargé, et la note reste identique à celle de
    l'export — augmentée des pièces versées depuis.

    Un échec n'est jamais bloquant : la pièce est rangée dans le dossier de
    toute façon, et une note non refaite se refait au prochain export.
    """
    index = repertoire / "index.csv"
    if not index.exists():
        return False, "index du dossier introuvable"

    # Avant de reecrire la note : les messages qui ne concernent pas le
    # debiteur sortent du dossier. Sans cela, refaire la note d'un dossier
    # constitue avant la regle la reecrivait a l'identique.
    #
    # Les adresses relevees dans les messages eux-memes sont hors du compte :
    # une adresse trouvee dans un fil de diffusion y figure par construction,
    # et s'en servir pour juger ce fil legitime reviendrait a se donner raison
    # tout seul. Seules celles du tableau font foi ici.
    decouvertes = {
        adresse.strip()
        for adresse in (dossier.get("adresses_decouvertes") or "").split(" | ")
        if adresse.strip()
    }
    retires = reclasser_index(repertoire, [
        adresse for adresse in (dossier.get("emails") or "").split(" | ")
        if adresse.strip() and adresse.strip() not in decouvertes
    ])
    if retires:
        accorder_recapitulatif(repertoire, dossier["reference"])

    try:
        from dossiers import Dossier  # noqa: PLC0415

        lignes, textes, _bases, _cles = export_mails.relire_dossier(repertoire, index)

        # Les pièces qui font le dossier — convention ou devis signé, facture,
        # émargement, relevé bancaire, diplôme — sont réunies à part. Ici
        # aussi : un dossier exporté avant cette version doit pouvoir les
        # obtenir sans qu'on refasse une heure d'export.
        export_mails.rassembler_pieces_cles(repertoire, lignes)

        entree = suivi.get(dossier["reference"]) or {}
        contenu = module_synthese.construire_html(
            dossier=Dossier(
                reference=dossier["reference"],
                nom=dossier.get("nom") or "",
                emails=[e for e in (dossier.get("emails") or "").split(" | ") if e],
                factures=[f for f in (dossier.get("factures") or "").split(" | ") if f],
                montant_du=str(dossier.get("montant_du") or ""),
                montant_total=str(dossier.get("montant_total") or ""),
                date_echeance=entree.get("echeance")
                or dossier.get("date_echeance") or "",
                # Refaire la note ne doit pas l'amputer : sans ces valeurs,
                # verser une pièce faisait disparaître l'exécution de la
                # formation et le contexte saisi de la note refaite.
                formation_debut=str(dossier.get("formation_debut") or ""),
                formation_fin=str(dossier.get("formation_fin") or ""),
                statut=str(dossier.get("statut_tableau") or ""),
                commentaire=str(dossier.get("commentaire") or ""),
                convention_signee=entree.get("convention")
                or str(dossier.get("convention_signee") or ""),
                diplome=entree.get("diplome") or str(dossier.get("diplome") or ""),
                heures_theoriques=str(dossier.get("heures_theoriques") or ""),
                heures_log=str(dossier.get("heures_log") or ""),
                contexte=entree.get("contexte") or "",
            ),
            boites=[b for b in (lire_preferences().get("boites") or "").split(",") if b],
            lignes=lignes,
            synthese=module_synthese.analyser(lignes, textes),
            # La date d'extraction est celle de l'export, pas celle du jour :
            # refaire la note ne relit aucun message, et la dater d'aujourd'hui
            # affirmait une fraîcheur qu'elle n'a pas. L'index est écrit au
            # moment de l'export : sa date est la bonne.
            date_export=datetime.fromtimestamp(
                index.stat().st_mtime).astimezone(),
            date_note=datetime.now().astimezone(),
            textes=textes,
            pieces_ajoutees=entree.get("pieces") or [],
            vues=set(),
        )
    except Exception as exc:  # noqa: BLE001 - jamais bloquant
        return False, str(exc)

    from rendu import ecrire_synthese  # noqa: PLC0415

    reussi, motif = ecrire_synthese(contenu, repertoire / "synthese.pdf")
    return bool(reussi), "" if reussi else str(motif)


def completer_annuaire(tout_refaire: bool = False) -> dict:
    """Complète les fiches publiques des débiteurs entreprises.

    Seulement celles qui manquent : le service est gratuit et ouvert, ce
    n'est pas une raison pour le solliciter deux fois pour la même société.
    Un débiteur déjà interrogé sans résultat est mémorisé comme tel — sans
    quoi il serait redemandé à chaque ouverture.
    """
    import entreprises as module_entreprises  # noqa: PLC0415

    sortie = Path(lire_preferences().get("sortie") or sortie_par_defaut())
    dossiers = module_suivi.inventaire(sortie, SUIVI)
    connues = module_entreprises.charger_annuaire(ANNUAIRE)

    trouvees, sans_fiche, echecs = 0, 0, 0
    motif_echec = ""
    for dossier in dossiers:
        reference = dossier["reference"]
        if reference in connues and not tout_refaire:
            continue
        try:
            fiche = module_entreprises.chercher(dossier.get("nom") or "")
        except module_entreprises.ErreurAnnuaire as exc:
            echecs += 1
            motif_echec = motif_echec or str(exc)
            # Le service est peut-être injoignable : insister sur cinquante
            # dossiers ne ferait qu'allonger l'attente pour rien.
            if echecs >= 3:
                break
            continue
        connues[reference] = fiche
        if fiche:
            trouvees += 1
        else:
            sans_fiche += 1

    if trouvees or sans_fiche:
        module_entreprises.enregistrer_annuaire(ANNUAIRE, connues)
    return {"trouvees": trouvees, "sans_fiche": sans_fiche,
            "echecs": echecs, "motif": motif_echec}


def construire_arguments(demande: dict, chemin_dossiers: Path) -> tuple[list[str], str]:
    sortie = (demande.get("sortie") or "").strip() or str(sortie_par_defaut())
    arguments = ["--dossiers", str(chemin_dossiers), "--sortie", sortie]

    boites = (demande.get("boites") or "").strip()
    if boites:
        arguments += ["--boites", boites]
    copie = (demande.get("copie_vers") or "").strip()
    if copie:
        arguments += ["--copier-vers", copie]
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

    # Le tableau Monday n'est passé qu'en mode Monday. La page envoie toujours
    # tout ce qu'elle a sous la main : une recherche ponctuelle emportait donc
    # le tableau coché la veille, et l'export repartait lire Monday au lieu de
    # chercher la seule facture demandée — sans qu'on puisse l'arrêter.
    if str(demande.get("mode") or "") == "monday":
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
            page = page.replace(
                "__NATURES_PIECES__",
                json.dumps(list(module_suivi.NATURES_PIECES), ensure_ascii=False)
                .replace("<", "\\u003c"),
            )
            # Déposé une fois, réappliqué ensuite : le dire évite de le
            # redéposer à chaque export « au cas où ».
            retenus = complements_memorises()
            page = page.replace(
                "__COMPLEMENTS_RETENUS__",
                json.dumps([c.name for c in retenus], ensure_ascii=False)
                .replace("<", "\\u003c"),
            )
            page = page.replace(
                "__COMPLEMENT__",
                _attribut(
                    "Fichiers retenus, réappliqués après chaque export : "
                    + ", ".join(c.name for c in retenus)
                    + ". Déposez-en d'autres : ils s'ajoutent. Un fichier du "
                      "même nom remplace le précédent."
                    if retenus
                    else "Convention, diplôme, heures, adresses de "
                         "facturation : déposé une fois, réappliqué après "
                         "chaque export. Plusieurs fichiers s'ajoutent."
                ),
            )
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
            ).replace(
                "__COPIE_VERS__", _attribut(preferences.get("copie_vers", ""))
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
            import entreprises as module_entreprises  # noqa: PLC0415

            # Le fichier de suivi retenu s'applique tout seul dès qu'il a
            # changé : redéposer le même fichier à chaque mise à jour était
            # une corvée, et l'oublier laissait la liste en retard sur ce que
            # le service sait déjà.
            appliquer_complements_si_besoin()
            dossiers = module_suivi.inventaire(racine, SUIVI)
            annuaire = module_entreprises.charger_annuaire(ANNUAIRE)
            # La fiche publique voyage avec le dossier : la page en a besoin
            # pour la ligne du débiteur comme pour le tableau des formes.
            for dossier in dossiers:
                fiche = annuaire.get(dossier["reference"])
                dossier["fiche_entreprise"] = fiche
                dossier["risque"] = module_entreprises.evaluer(dossier, fiche)
            self._json(200, {
                "dossiers": dossiers,
                "agregats": module_suivi.agreger(dossiers),
                "entreprises": module_entreprises.repartition(dossiers, annuaire),
                "annuaire_connu": bool(annuaire),
                # Les debiteurs que l'annuaire n'a jamais ete interroge sur.
                # Un debiteur interroge sans resultat est memorise comme tel :
                # il ne figure pas ici, et n'est donc pas redemande.
                "annuaire_manquants": sum(
                    1 for d in dossiers if d["reference"] not in annuaire
                ),
                "statuts": module_suivi.STATUTS,
                # Celles qu'un fichier de suivi applique apres coup, ou une
                # mise a jour de l'outil, ont laissees en retard.
                "notes_en_cours": sorted(_lancer_rafraichissement(dossiers)),
                # Une note qu'on n'arrive pas à réécrire est remise en
                # chantier à chaque affichage : sans le dire, le bandeau
                # tourne indéfiniment sans que rien n'avance.
                "notes_en_echec": [
                    {"reference": reference, "motif": motif}
                    for reference, motif in sorted(NOTES_EN_ECHEC.items())
                ],
                "sauvegardes": _etat_sauvegardes(),
                "absents_suivi": absents_du_suivi(),
                "a_refaire": list(lire_preferences().get("dossiers_a_refaire") or []),
                "sortie": str(racine),
            })
            return

        if chemin == "/api/vivant":
            # La page bat la mesure tant qu'elle est ouverte. Sans cela,
            # l'outil se fermait au bout de trois minutes de lecture — car
            # lire n'envoie aucune requête — et tout clic suivant echouait
            # sans que rien n'ait ete ferme ni casse.
            if not self._jeton_valide():
                self._json(403, {"erreur": "Jeton invalide."})
                return
            self._json(200, {"vivant": True, "version": VERSION})
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
            if chemin == "/api/completer":
                self._completer_depuis_fichier(self._corps_json())
                return
            if chemin == "/api/oublier-complements":
                self._oublier_complements()
                return
            if chemin == "/api/annuaire":
                self._interroger_annuaire(self._corps_json())
                return
            if chemin == "/api/piece":
                self._verser_piece(self._corps_json())
                return
            if chemin == "/api/refaire-notes":
                self._refaire_notes(self._corps_json())
                return
            if chemin == "/api/restaurer-suivi":
                self._restaurer_suivi(self._corps_json())
                return
            if chemin == "/api/messages":
                self._messages_du_dossier(self._corps_json())
                return
            if chemin == "/api/retrouver":
                self._retrouver_dossiers()
                return
            if chemin == "/api/arreter":
                entendu = EXECUTION.demander_arret()
                self._json(200, {"arrete": entendu})
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
            for cle in ("boites", "sortie", "copie_vers", "domaines",
                        "seulement", "filtre_colonne", "filtre_valeur",
                        "tableau", "groupes")
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

    def _completer_depuis_fichier(self, demande: dict) -> None:
        """Complète les dossiers déjà exportés avec un fichier de suivi.

        Rien n'est réexporté : seules les colonnes que le tableau Monday ne
        porte pas — convention, diplôme, heures, échéance — sont reprises et
        rattachées par numéro de facture.
        """
        nom = (demande.get("nom") or "").strip()
        contenu = demande.get("contenu") or ""
        extension = Path(nom).suffix.lower()
        if extension not in {".csv", ".xlsx", ".xlsm", ".xltx", ".tsv", ".txt"}:
            raise ValueError(
                f"Format non pris en charge : {extension or 'inconnu'}. "
                "Déposez un fichier Excel ou CSV."
            )

        # Le fichier est conservé à côté de l'outil, et réappliqué tout seul
        # après chaque export : il n'y a aucune raison de le redéposer à
        # chaque fois. Le redéposer reste le moyen de le mettre à jour.
        #
        # Plusieurs fichiers coexistent, sous leur propre nom : la facturation
        # est répartie sur deux outils, et n'en retenir qu'un laissait la
        # moitié des dossiers sans adresse. Un fichier du même nom écrase le
        # précédent — c'est ainsi qu'on met le sien à jour.
        _migrer_complement_unique()
        COMPLEMENTS.mkdir(parents=True, exist_ok=True)
        depot = COMPLEMENTS / _nom_sur_disque(nom, extension)
        existait = depot.exists()
        sauvegarde = depot.read_bytes() if existait else b""
        try:
            depot.write_bytes(base64.b64decode(contenu))
        except (ValueError, OSError) as exc:
            raise ValueError(f"Fichier illisible : {exc}") from exc

        try:
            resultat = appliquer_complement(depot)
        except ErreurDossiers as exc:
            # Un fichier refusé ne doit pas emporter celui qu'il remplaçait.
            if existait:
                depot.write_bytes(sauvegarde)
            else:
                depot.unlink(missing_ok=True)
            raise ValueError(str(exc)) from exc

        retenus = [n for n in (lire_preferences().get("complements") or [])
                   if n != depot.name]
        memoriser_preferences({"complements": [*retenus, depot.name]})

        # Le fichier vient d'être appliqué : on note son empreinte pour que la
        # page ne le relise pas aussitôt. Il le sera de nouveau, tout seul, à
        # la première version différente déposée au même nom.
        vus = dict(lire_preferences().get("complements_appliques") or {})
        etat = depot.stat()
        vus[depot.name] = f"{etat.st_mtime_ns}-{etat.st_size}"
        memoriser_preferences({"complements_appliques": vus})

        resultat["memorise"] = nom
        resultat["retenus"] = [c.name for c in complements_memorises()]
        self._json(200, resultat)

    def _messages_du_dossier(self, demande: dict) -> None:
        """Les messages d'un dossier, et pourquoi chacun s'y trouve.

        La question « quels mails ont été récupérés, et de quel droit » ne
        trouvait sa réponse que dans index.csv, qu'il fallait ouvrir dans
        Excel. Or c'est la première chose qu'on veut savoir d'un dossier
        qu'on s'apprête à transmettre.
        """
        reference = str((demande or {}).get("reference") or "").strip()
        sortie = Path(lire_preferences().get("sortie") or sortie_par_defaut())
        dossiers = {d["reference"]: d for d in module_suivi.inventaire(sortie, SUIVI)}
        if reference not in dossiers:
            self._json(404, {"erreur": f"Dossier inconnu : {reference}"})
            return

        index = sortie / dossiers[reference]["repertoire"] / "index.csv"
        if not index.exists():
            self._json(200, {"messages": [], "sans_index": True})
            return

        messages = []
        for rangee in csv.DictReader(
                index.read_text(encoding="utf-8-sig").splitlines(), delimiter=";"):
            critere = (rangee.get("critere") or "").strip()
            messages.append({
                "piece": rangee.get("piece_n") or "",
                "date": rangee.get("date") or "",
                "sens": rangee.get("sens") or "",
                "de": rangee.get("expediteur") or "",
                "a": rangee.get("destinataires") or "",
                "objet": rangee.get("objet") or "",
                "pj": rangee.get("pieces_jointes") or "",
                "critere": critere,
                # Ce qui est mis a part n'etablit pas la creance : la note le
                # range en annexe, et la liste doit le dire aussi.
                "ecarte": critere.startswith(
                    ("autre facture", "diffusion", "hors debiteur")),
                "fichier": rangee.get("fichier_pdf") or rangee.get("fichier_eml") or "",
            })
        self._json(200, {"messages": messages,
                         "repertoire": str(sortie / dossiers[reference]["repertoire"])})

    def _restaurer_suivi(self, demande: dict) -> None:
        """Remet en place une copie datée du suivi."""
        nom = str((demande or {}).get("nom") or "").strip()
        if not nom:
            copies = module_suivi.sauvegardes(SUIVI)
            if not copies:
                raise ValueError("Aucune sauvegarde disponible.")
            nom = copies[0].name
        try:
            repris = module_suivi.restaurer(SUIVI, nom)
        except (ValueError, OSError) as exc:
            self._json(400, {"erreur": str(exc)})
            return
        self._json(200, {"restaures": repris, "sauvegarde": nom})

    def _retrouver_dossiers(self) -> None:
        """Remet à la liste les dossiers présents sur le disque.

        Rien n'est retéléchargé et rien n'est écrasé : on relit les
        répertoires déjà constitués, et l'on rend à la liste ceux qu'elle ne
        porte plus.
        """
        sortie = Path(lire_preferences().get("sortie") or sortie_par_defaut())
        lignes: list[str] = []
        try:
            nombre = export_mails.retrouver_dossiers(sortie, lignes.append)
        except OSError as exc:
            self._json(400, {"erreur": f"Lecture impossible de {sortie} : {exc}"})
            return
        self._json(200, {"retrouves": nombre, "lignes": lignes,
                         "sortie": str(sortie)})

    def _refaire_notes(self, demande: dict | None = None) -> None:
        """Réécrit les notes de synthèse, sans retourner sur Gmail.

        Les pièces et leur texte sont relus dans l'index et les `.eml`
        conservés : aucun message n'est retéléchargé. C'est ce qui permet de
        profiter d'une note refondue sans refaire l'export, qui prend une
        heure là où ceci prend quelques secondes.

        Ce qui a été trouvé dans Gmail ne change pas pour autant : pour cela,
        il faut bien relancer un export.

        Sans références, toutes les notes sont refaites. Avec, ces
        dossiers-là seulement : sur deux cents dossiers dont trois viennent
        de changer, refaire les deux cents pour trois est une attente
        qu'aucune raison ne justifie.
        """
        voulues = {
            str(reference).strip()
            for reference in ((demande or {}).get("references") or [])
            if str(reference).strip()
        }
        preferences = lire_preferences()
        sortie = Path(preferences.get("sortie") or sortie_par_defaut())
        copie = (preferences.get("copie_vers") or "").strip()
        destination = Path(copie) if copie else None
        suivi = module_suivi.charger(SUIVI)
        refaites, echecs, motifs, recopiees = 0, 0, [], 0
        inconnues = sorted(voulues - {
            d["reference"] for d in module_suivi.inventaire(sortie, SUIVI)
        })

        for dossier in module_suivi.inventaire(sortie, SUIVI):
            if voulues and dossier["reference"] not in voulues:
                continue
            repertoire = sortie / dossier["repertoire"]
            if not repertoire.is_dir():
                continue
            reussi, motif = _refaire_synthese(repertoire, dossier, suivi)
            if reussi:
                refaites += 1
                recopiees += bool(recopier_note(repertoire, sortie, destination))
                continue
            # Sans moteur PDF, la note est refaite en HTML : c'est un succès
            # partiel, pas un échec. Seul ce qui empêche d'écrire la note en
            # est un.
            if (repertoire / "synthese.html").exists():
                refaites += 1
                recopiees += bool(recopier_note(repertoire, sortie, destination))
            else:
                echecs += 1
                if len(motifs) < 3:
                    motifs.append(f"{dossier['reference']} : {motif}")

        self._json(200, {"refaites": refaites, "echecs": echecs,
                         "motifs": motifs, "choisies": len(voulues),
                         "inconnues": inconnues[:8], "recopiees": recopiees,
                         "copie_vers": str(destination) if destination else ""})

    def _oublier_complements(self) -> None:
        """Retire les fichiers de suivi retenus.

        Un fichier déposé était réappliqué après chaque export sans qu'aucun
        moyen ne permette d'y renoncer : le déposer engageait pour de bon.
        Ce que le fichier a déjà écrit dans le suivi reste — l'échéance et
        l'adresse d'un dossier sont à lui maintenant — mais plus rien n'est
        relu, et rien de nouveau n'en viendra.
        """
        oublies = []
        for fichier in complements_memorises():
            if fichier == SUIVI_INITIAL:
                # Le suivi livré n'a pas été déposé : il appartient à
                # l'installation. On cesse de le relire, on ne l'efface pas.
                oublies.append(fichier.name)
                continue
            try:
                fichier.unlink()
            except OSError:
                continue
            oublies.append(fichier.name)
        memoriser_preferences({"complements": [], "complement": "",
                               "complements_appliques": {},
                               "suivi_livre_ecarte": True})
        self._json(200, {"oublies": oublies, "retenus": []})

    def _verser_piece(self, demande: dict) -> None:
        """Range une pièce dans le dossier, et refait sa note de synthèse.

        Le fichier est écrit sous le répertoire du dossier, jamais ailleurs :
        le nom vient de la page, et un nom de fichier n'a pas à pouvoir
        désigner un chemin.
        """
        reference = (demande.get("reference") or "").strip()
        nature = (demande.get("nature") or "").strip()
        nom = Path((demande.get("nom") or "").strip()).name
        if not reference or not nom:
            raise ValueError("Dossier ou fichier manquant.")

        sortie = Path(lire_preferences().get("sortie") or sortie_par_defaut())
        dossiers = {d["reference"]: d for d in module_suivi.inventaire(sortie, SUIVI)}
        if reference not in dossiers:
            raise ValueError(f"Dossier inconnu : {reference}")

        repertoire = Path(dossiers[reference]["repertoire"])
        cible = (repertoire / "pieces-ajoutees" / nom).resolve()
        racine = repertoire.resolve()
        if racine not in cible.parents:
            raise ValueError("Nom de fichier refusé.")

        try:
            octets = base64.b64decode(demande.get("contenu") or "")
        except ValueError as exc:
            raise ValueError(f"Fichier illisible : {exc}") from exc

        # Un message téléchargé n'est pas une pièce versée : il rejoint les
        # échanges du dossier, avec son numéro de pièce, son PDF et ses
        # pièces jointes. C'est ce qui le rend citable au même titre.
        if Path(nom).suffix.lower() == ".eml":
            versee = self._verser_message(reference, repertoire,
                                          dossiers[reference], octets)
        else:
            cible = (repertoire / "pieces-ajoutees" / nom).resolve()
            if repertoire.resolve() not in cible.parents:
                raise ValueError("Nom de fichier refusé.")
            cible.parent.mkdir(parents=True, exist_ok=True)
            try:
                cible.write_bytes(octets)
            except OSError as exc:
                raise ValueError(f"Écriture impossible : {exc}") from exc

            donnees = module_suivi.charger(SUIVI)
            module_suivi.ajouter_piece(donnees, reference, nature, nom)
            module_suivi.enregistrer(SUIVI, donnees)
            versee = {
                "piece": None,
                "repond": {"convention": "Convention", "diplome": "Diplôme"}.get(
                    module_suivi.NATURES_QUI_REPONDENT.get(nature, ""), ""
                ),
            }

        refaite, motif = _refaire_synthese(repertoire, dossiers[reference],
                                           module_suivi.charger(SUIVI))
        self._json(200, {"fichier": nom, "nature": nature,
                         "synthese_refaite": refaite, "motif": motif,
                         **versee})

    def _verser_message(self, reference: str, repertoire: Path,
                        dossier: dict, octets: bytes) -> dict:
        from dossiers import Dossier  # noqa: PLC0415

        domaines = {
            d.strip().lower()
            for d in (lire_preferences().get("domaines") or "").split(",")
            if d.strip()
        }
        domaines |= {
            b.split("@")[-1].strip().lower()
            for b in (lire_preferences().get("boites") or "").split(",")
            if "@" in b
        }
        try:
            ligne = export_mails.verser_message(
                repertoire,
                octets,
                Dossier(
                    reference=reference,
                    nom=dossier.get("nom") or "",
                    emails=[e for e in (dossier.get("emails") or "").split(" | ") if e],
                    factures=[f for f in (dossier.get("factures") or "").split(" | ") if f],
                ),
                domaines,
            )
        except ErreurDossiers as exc:
            raise ValueError(str(exc)) from exc
        except Exception as exc:  # noqa: BLE001 - remonté tel quel à l'écran
            raise ValueError(f"Message illisible : {exc}") from exc
        return {"piece": ligne.piece_n, "sens": ligne.sens,
                "objet": ligne.objet}

    def _interroger_annuaire(self, demande: dict) -> None:
        self._json(200, completer_annuaire(
            tout_refaire=bool(demande.get("tout_refaire"))))

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
            "copie_vers": (demande.get("copie_vers") or "").strip(),
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
                convention=demande.get("convention"),
                contexte=demande.get("contexte"),
                diplome=demande.get("diplome"),
                echeance=demande.get("echeance"),
            )
            module_suivi.enregistrer(SUIVI, donnees)
        except ValueError as exc:
            self._json(400, {"erreur": str(exc)})
            return
        except OSError as exc:
            self._json(500, {"erreur": f"Enregistrement impossible : {exc}"})
            return
        # Ce qui vient d'etre saisi entre dans la note : echeance, convention,
        # diplome, contexte, note interne. La refaire tout de suite evite
        # d'ouvrir demain une note qui dit le contraire de l'ecran.
        rafraichir_notes([reference])
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
<title>Export contentieux</title>
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
/* La case « tout selectionner » vit dans l'en-tete, ou tout le reste est en
   petites capitales grises : sans cela elle passait pour un ornement. */
table.donnees th.etroite input[type=checkbox]{cursor:pointer;vertical-align:middle}
/* L'en-tete est un bouton, mais il doit rester un en-tete a l'oeil : meme
   graisse, meme casse, meme couleur. Seul le survol dit qu'on peut cliquer. */
table.donnees th button.tri{background:none;border:0;padding:0;margin:0;
  font:inherit;color:inherit;text-transform:inherit;letter-spacing:inherit;
  cursor:pointer;display:inline-flex;align-items:center;gap:3px}
table.donnees th button.tri:hover{color:var(--texte)}
table.donnees th button.tri:focus-visible{outline:2px solid var(--accent);
  outline-offset:2px;border-radius:3px}
/* La colonne triee est la seule eclairee : sans cela, la fleche seule se
   perd dans quatorze en-tetes de meme couleur. */
table.donnees th.triee button.tri{color:var(--texte)}
table.donnees th.triee .sens{color:var(--accent);font-size:12px}
/* Rien ne dit qu'un en-tete se clique tant qu'on n'a pas essaye. La double
   fleche apparait au survol, sur les seules colonnes non triees. */
table.donnees th:not(.triee) button.tri:hover .sens::after{content:"\2195";
  font-size:11px;opacity:.45}
/* Une note ecrite avant le dernier changement : ni une erreur ni un echec,
   un retard qu'un bouton rattrape. Ambre, comme ce qui attend une decision. */
.perimee{color:#c9862a;font-size:11px;white-space:nowrap}
p.aide.echecs{color:#e0736b;border-left:2px solid #e0736b;padding-left:10px;
  margin:10px 0 13px;line-height:1.5}
p.aide.perimees{color:#c9862a;border-left:2px solid #c9862a;padding-left:10px;
  margin:0 0 13px}
/* Repliee par defaut : c'est une reponse a une question qu'on ne se pose pas
   tous les jours, et deroulee elle prendrait la place du tableau. */
p.aide.a-refaire{margin-top:16px;color:#e8a0a0;border-left:2px solid #d03b3b;
  padding-left:10px;line-height:1.7}
table.donnees tr.ecarte td{opacity:.55;font-style:italic}
#messagesDossier{margin-top:14px}
p.aide.rattrapage{margin-top:16px}
p.aide.rattrapage button{margin-left:4px}
details.absents{margin-top:10px;border:1px solid var(--bord);border-radius:8px;
  padding:10px 13px;background:rgba(255,255,255,.02)}
details.absents summary{cursor:pointer;font-size:12px;color:var(--texte-2)}
details.absents summary:hover{color:var(--texte)}
details.absents ul{margin:8px 0 0;padding-left:20px;font-size:12px;
  color:var(--texte-2);columns:3;column-gap:22px}
details.absents li{break-inside:avoid}
.defilable{overflow-x:auto}
.barre-selection{display:flex;flex-wrap:wrap;align-items:center;gap:13px;
  margin-bottom:13px}
.barre-selection span{font-size:12px;color:var(--texte-3)}
.depot-complement{border:1px solid var(--bord);border-radius:9px;padding:9px 14px;
  font-size:13px;color:var(--texte-2);cursor:pointer;white-space:nowrap}
.depot-complement:hover{border-color:var(--texte-3);color:var(--texte)}
.depot-complement input{display:none}
#tableDocuments select.nature{font-size:11px;padding:3px 5px;max-width:135px}
.depot-piece{display:inline-block;margin-left:5px;font-size:11.5px;
  color:var(--accent);cursor:pointer;white-space:nowrap}
.depot-piece:hover{text-decoration:underline}
.depot-piece input{display:none}
.versees{margin-top:5px;font-size:11px;color:var(--texte-3)}
.versees span{display:block}
.recherche-dossiers{display:flex;align-items:center;gap:11px;margin-bottom:13px}
/* Plus specifique que la regle generale des champs, qui suit et prendrait
   sinon toute la largeur. */
.recherche-dossiers input[type=search]{width:370px;max-width:100%}
/* Le libelle d'etat le plus long fait soixante caracteres : laisse libre, la
   liste deroulante repoussait le compte et le bouton hors de l'ecran. */
.recherche-dossiers select{max-width:270px}
.compte-recherche{font-size:12px;color:var(--texte-3);white-space:nowrap}
.retenu{font-size:11.5px;color:var(--texte-3);max-width:230px}
.lien-oubli{font-size:11.5px;color:var(--accent);cursor:pointer;white-space:nowrap}
.lien-oubli:hover{text-decoration:underline}
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
ul.cessees{margin:9px 0 0;padding-left:19px;font-size:12px;color:var(--texte-2)}
ul.cessees li{margin-bottom:5px}
ul.cessees a{margin-left:7px}
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
/* Meme chose aux documents : depuis que la premiere colonne porte la case a
   cocher des notes a refaire, la reference n'heritait plus de la largeur ni
   du « nowrap » reserves a la premiere cellule. « FACT-2405-00409 » se
   coupait donc sur trois lignes, a chaque tiret. */
#tableDocuments table.donnees td:first-child{min-width:0;width:26px;
  padding-right:0}
#tableDocuments table.donnees td.reference{min-width:150px}
#tableDocuments table.donnees td.reference b{white-space:nowrap}
/* Le libelle d'etape le plus long fait soixante caracteres : laisse libre, la
   liste deroulante poussait les dernieres colonnes hors de l'ecran. */
#tableSuivi select{max-width:186px}
#tableSuivi input.frais{width:48px}
#tableSuivi input.note{min-width:96px}
#tableSuivi input.contexte{min-width:190px}
/* « 14/07/2024 » a 13,5 px et 12 px de marge interne de chaque cote : en
   dessous de 112 px, l'annee est coupee sans que rien ne le signale. */
#tableSuivi input.echeance{width:112px;text-align:center;padding-left:6px;
  padding-right:6px}
#tableSuivi table.donnees th,#tableSuivi table.donnees td{padding-left:6px;padding-right:6px}
table.donnees input.note{min-width:170px}
.detail td{padding:4px 6px;font-size:12.5px}
.detail input[type=text]{width:110px;padding:4px 6px;font-size:12.5px}
label{display:block;font-size:12px;color:var(--texte-2);margin-bottom:5px}
input[type=text],input[type=search]{width:100%;background:var(--champ);
  border:1px solid var(--bord);
  border-radius:9px;padding:10px 12px;color:var(--texte);font-size:13.5px;font-family:inherit}
input[type=text]:focus,input[type=search]:focus{outline:none;border-color:var(--bord-actif)}
/* La croix d'effacement du navigateur est noire sur fond sombre : on la
   rend a la couleur du texte plutot que de la laisser invisible. */
input[type=search]::-webkit-search-cancel-button{
  -webkit-appearance:none;height:13px;width:13px;cursor:pointer;
  background:var(--texte-3);
  -webkit-mask:url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><path d='M3 3l10 10M13 3L3 13' stroke='black' stroke-width='2.4' fill='none'/></svg>") center/contain no-repeat}
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
/* Barre de deconnexion : une page qui ne joint plus l'outil ne peut rien
   faire, et chaque clic echoue en silence. Elle doit le dire en haut, en
   permanence, et non par un petit encart rouge au milieu d'une section. */
/* Un selecteur d'identifiant l'emporte sur le [hidden] du navigateur : sans
   cette ligne, la barre restait affichee en permanence, y compris quand
   l'outil repondait parfaitement. */
#deconnecte[hidden]{display:none}
#deconnecte{background:#5b1a1a;color:#ffe9e9;padding:13px 20px;font-size:13px;
  line-height:1.6;display:flex;flex-wrap:wrap;align-items:center;gap:13px;
  position:sticky;top:0;z-index:50}
#deconnecte button{margin-left:auto}
#etat{display:none;align-items:center;gap:11px;margin-top:16px;font-size:13px}
#etat.visible{display:flex}
.rond{width:15px;height:15px;border:2px solid var(--bord);border-top-color:var(--accent);
  border-radius:50%;animation:tourne .8s linear infinite}
@keyframes tourne{to{transform:rotate(360deg)}}
.bandeau{border-radius:10px;padding:13px 15px;font-size:13px;margin-top:16px;display:none}
.bandeau.visible{display:block}
.bandeau.reussi{background:rgba(132,204,22,.1);border:1px solid rgba(132,204,22,.35)}
.bandeau.rate{background:rgba(239,68,68,.1);border:1px solid rgba(239,68,68,.35)}
.bandeau.attente{background:rgba(99,102,241,.1);border:1px solid rgba(99,102,241,.35);
  margin:0 0 18px}
.note{font-size:12px;color:var(--texte-3);margin-top:14px;padding-top:14px;
  border-top:1px solid var(--bord)}
</style></head>
<body>
<div id="deconnecte" hidden>
  <span><b>L'application ne répond plus.</b> Aucun bouton de cette page ne peut
  fonctionner tant qu'elle ne joint pas l'outil. Rouvrez l'outil avec
  <b>Lancer.bat</b>, puis rechargez cette page.</span>
  <button class="secondaire" id="recharger">Recharger la page</button>
</div>
<header>
  <span class="logo">Liora</span>
  <span class="titre">Export contentieux</span>
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
  <div class="bandeau visible attente" id="exportEnCours" hidden></div>
  <div id="tuilesBord" class="tuiles"></div>
  <div class="graphe" id="courbeBord"></div>
  <div class="graphe" id="grapheBord"></div>
  <div class="graphe" id="anciennete"></div>
  <div class="graphe" id="dormants"></div>
  <div class="graphe" id="solidite"></div>
  <div class="graphe" id="entreprises"></div>
</div>

<div class="vue" id="vueSuivi">
  <section>
    <h2>État des dossiers</h2>
    <p class="aide">L'avancement et les frais sont enregistrés au fur et à mesure,
       à côté de l'outil. Refaire un export ne les efface pas.</p>
    <div class="recherche-dossiers">
      <input type="search" id="chercheSuivi" autocomplete="off"
             placeholder="Facture, adresse mail, nom…" />
      <select id="filtreEtatSuivi" title="N'afficher que les dossiers dans cet état.">
        <option value="">Tous les états</option>
      </select>
      <span class="compte-recherche" id="compteSuivi"></span>
    </div>
    <div id="tableSuivi"></div>
  </section>
</div>

<div class="vue" id="vueDocuments">
  <section>
    <h2>Documents produits</h2>
    <p class="aide">Un répertoire par dossier, dans <b id="cheminSortie">—</b>.
       Cliquez pour ouvrir la note de synthèse ou le répertoire complet.</p>
    <div class="recherche-dossiers">
      <input type="search" id="chercheDocuments" autocomplete="off"
             placeholder="Facture, adresse mail, nom…" />
      <select id="filtreEtatDocuments" title="N'afficher que les dossiers dans cet état.">
        <option value="">Tous les états</option>
      </select>
      <span class="compte-recherche" id="compteDocuments"></span>
      <button class="secondaire" id="refaireNotes"
              title="Réécrit les notes à partir des messages déjà au dossier, sans retourner sur Gmail. Quelques secondes.">Refaire les notes</button>
    </div>
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
  <p class="note" id="noteLancement"><b>Tester d'abord</b> compte ce qui sera
     traité sans rien écrire sur le disque. <b>Lancer l'export</b> constitue
     les dossiers.</p>
  <div id="etat"><div class="rond"></div><span id="texteEtat">Export en cours…</span>
    <button class="secondaire danger" id="arreter"
            title="Le dossier en cours va à son terme, puis l'export s'arrête. Ce qui est déjà constitué reste sur le disque, et « Reprendre » repartira d'ici.">Arrêter</button></div>
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
      <label for="copieVers">Copier les dossiers vers (SharePoint, OneDrive) —
        facultatif</label>
      <input type="text" id="copieVers" value="__COPIE_VERS__"
             placeholder="C:\Users\vous\INSEEC\Site - Documents partages\..." />
      <p class="note">La copie a lieu <b>à la fin</b> de l'export, jamais
         pendant : la synchronisation ne dispute alors aucun fichier à
         l'export. Indiquez le chemin local du dossier synchronisé, pas
         l'adresse https:// du site.</p>
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

// La barre reste tant qu'aucune requete n'aboutit : une page morte n'a
// aucun moyen de le decouvrir toute seule, et l'on clique dans le vide.
function signalerDeconnexion(perdue) {
  const barre = $("deconnecte");
  if (barre) barre.hidden = !perdue;
}

async function api(chemin, corps) {
  const options = { headers: { "X-Jeton": JETON } };
  if (corps !== undefined) {
    options.method = "POST";
    options.headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(corps);
  }
  // « Failed to fetch » est le message du navigateur quand il n'a pas pu
  // joindre l'outil. En anglais, sans sujet ni remede, il fait croire a une
  // panne de l'export alors qu'il ne dit qu'une chose : la page a parle dans
  // le vide. Presque toujours parce que la fenetre noire a ete fermee, ou
  // parce que la page est restee ouverte depuis une version precedente.
  let reponse;
  try {
    reponse = await fetch(chemin, options);
  } catch (erreur) {
    signalerDeconnexion(true);
    throw new Error(
      "L'application ne répond pas. La fenêtre noire de l'outil est-elle "
      + "toujours ouverte ? Si vous venez d'installer une nouvelle version, "
      + "cette page date de la précédente : fermez-la et rouvrez l'outil "
      + "avec Lancer.bat. Un export en cours, lui, continue de son côté."
    );
  }
  signalerDeconnexion(false);
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
  // Le bouton disait « Lancer l'export » quel que soit l'onglet. Sur une
  // recherche ponctuelle, on cherchait donc un bouton « lancer la recherche »
  // qui n'existait pas, a cote de celui qui l'aurait lancee.
  $("lancer").textContent = mode === "manuel"
    ? "Lancer la recherche" : "Lancer l'export";
  $("noteLancement").innerHTML = mode === "manuel"
    ? "<b>Tester d'abord</b> compte les messages trouvés sans rien écrire sur "
      + "le disque. <b>Lancer la recherche</b> constitue le dossier de cette "
      + "facture."
    : "<b>Tester d'abord</b> compte ce qui sera traité sans rien écrire sur "
      + "le disque. <b>Lancer l'export</b> constitue les dossiers.";
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
["chercheSuivi", "chercheDocuments"].forEach((id) => {
  if ($(id)) $(id).addEventListener("input", chercherDossiers);
});
["filtreEtatSuivi", "filtreEtatDocuments"].forEach((id) => {
  if ($(id)) $(id).addEventListener("change", choisirEtat);
});

// Les dossiers dont on veut refaire la note. Sur deux cents dossiers dont
// trois viennent de changer, refaire les deux cents pour trois est une
// attente qu'aucune raison ne justifie.
//
// Sélection propre à cet onglet : les cases de « État des dossiers »
// commandent une suppression, et un même geste ne doit pas pouvoir
// déclencher l'une pour l'autre.
const CHOIX_NOTES = new Set();

// -- tout sélectionner
//
// Cocher deux cents dossiers un par un pour refaire deux cents notes n'est
// pas un geste, c'est une punition. La case d'en-tête coche ce que le tableau
// montre : filtrée sur « possible abandon », elle ne coche que ceux-là.
function brancherToutChoisir(table, apres) {
  const maitresse = table.querySelector(".tout-choisir");
  if (!maitresse) return;
  const cases = () => Array.from(
    table.querySelectorAll("." + maitresse.dataset.cible));

  maitresse.addEventListener("change", () => {
    cases().forEach((coche) => { coche.checked = maitresse.checked; });
    apres();
    majCaseMaitresse(table);
  });
  cases().forEach((coche) =>
    coche.addEventListener("change", () => majCaseMaitresse(table)));
  majCaseMaitresse(table);
}

// Ni cochée ni vide quand une partie seulement l'est : l'état intermédiaire
// dit « certains », là où une case vide dirait « aucun » et tromperait.
function majCaseMaitresse(table) {
  const maitresse = table.querySelector(".tout-choisir");
  if (!maitresse) return;
  const cases = Array.from(table.querySelectorAll("." + maitresse.dataset.cible));
  const coches = cases.filter((c) => c.checked).length;
  maitresse.checked = cases.length > 0 && coches === cases.length;
  maitresse.indeterminate = coches > 0 && coches < cases.length;
  maitresse.disabled = cases.length === 0;
}

function majChoixNotes() {
  const cases = Array.from(document.querySelectorAll(".choix-note"));
  CHOIX_NOTES.clear();
  cases.filter((c) => c.checked).forEach((c) => CHOIX_NOTES.add(c.dataset.ref));
  const bouton = $("refaireNotes");
  if (!bouton) return;
  bouton.textContent = CHOIX_NOTES.size
    ? `Refaire ${CHOIX_NOTES.size} note(s)` : "Refaire les notes";
  bouton.title = CHOIX_NOTES.size
    ? "Réécrit les notes des dossiers cochés, à partir des messages déjà au "
      + "dossier. Sans retourner sur Gmail."
    : "Réécrit toutes les notes à partir des messages déjà au dossier, sans "
      + "retourner sur Gmail. Cochez des dossiers pour n'en refaire que "
      + "certains.";
}

async function refaireNotes() {
  if (!DOSSIERS.length) {
    afficherBandeau(false, "Aucun dossier : lancez d'abord un export.");
    return;
  }
  const choisis = Array.from(CHOIX_NOTES);
  const bouton = $("refaireNotes");
  bouton.disabled = true;
  const avant = bouton.textContent;
  bouton.textContent = "Notes en cours…";
  try {
    const r = await api("/api/refaire-notes", { references: choisis });
    afficherBandeau(r.echecs === 0,
      `${r.refaites} note(s) refaite(s) à partir des messages déjà au dossier`
      + (choisis.length ? `, sur les ${choisis.length} dossier(s) cochés.` : ".")
      + (r.echecs
         ? ` ${r.echecs} en échec : ${(r.motifs || []).join(" ; ")}.`
         : "")
      // La copie était laissée en l'état : on ouvrait le SharePoint et on y
      // retrouvait la note d'avant, sans que rien ne l'explique.
      + (r.recopiees ? ` ${r.recopiees} reportée(s) dans ${r.copie_vers}.` : "")
      + " Les messages, eux, ne changent qu'en relançant un export.");
    // Le travail demandé est fait : garder les cases cochées ferait refaire
    // les mêmes au clic suivant, en croyant en refaire d'autres.
    CHOIX_NOTES.clear();
    chargerDossiers();

  } catch (erreur) { afficherBandeau(false, erreur.message); }
  finally { bouton.disabled = false; bouton.textContent = avant; }
}

if ($("refaireNotes")) $("refaireNotes").addEventListener("click", refaireNotes);

function tableauxCoches() {
  return Array.from(TABLEAUX_COCHES).join(",");
}

function reglesEcheance() {
  return Object.entries(REGIMES_ECHEANCE).map(([id, r]) => id + "=" + r).join(",");
}

// Les cases reprennent l'état de la dernière session : ce qui a été décidé
// une fois n'a pas à être redécidé à chaque ouverture.
Object.keys(CASES).forEach((id) => { if ($(id)) $(id).checked = CASES[id]; });

reprendreSuiviEnCours();

if (TABLEAUX_COCHES.size) {
  const onglet = document.querySelector('.onglet[data-volet="voletMonday"]');
  if (onglet) onglet.click();
}
majBouton();

// Enregistrement automatique : à la saisie (différé) et à la fermeture de la
// page. Une page fermée sans avoir lancé d'export ne perd plus rien.
const CHAMPS_REGLAGES = ["boites", "sortie", "copieVers", "domaines",
                         "seulement", "filtreColonne", "filtreValeur",
                         "groupes", "jetonMonday"];
let minuterieReglages = null;

function reglages() {
  const options = {};
  Object.keys(CASES).forEach((id) => { if ($(id)) options[id] = $(id).checked; });
  return {
    boites: $("boites").value, sortie: $("sortie").value,
    copie_vers: $("copieVers").value,
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

  suivreExport(simulation);
}

function suivreExport(simulation) {
  $("texteEtat").textContent = simulation
    ? "Test en cours…" : "Export en cours…";
  $("arreter").disabled = false;
  $("arreter").textContent = "Arrêter";
  $("etat").classList.add("visible");
  $("lancer").disabled = true;
  $("tester").disabled = true;
  $("journal").hidden = false;
  clearInterval(sondage);
  sondage = setInterval(rafraichir, 700);
  rafraichir();
}

// Un export tourne dans l'outil, pas dans la page : recharger celle-ci — ou
// la laisser mettre en veille par le navigateur — ne l'interrompt pas. Sans
// ce rattrapage, l'ecran restait muet et l'export passait pour arrete.
async function reprendreSuiviEnCours() {
  let etat;
  try { etat = await api("/api/journal?depuis=0"); }
  catch { return; }
  EXPORT_EN_COURS = Boolean(etat.en_cours);
  majBandeauExport();
  if (!etat.en_cours) return;

  position = 0;
  simulationDemandee = etat.lignes.some((l) => l.includes("simulation"));
  suivreExport(simulationDemandee);
  afficherBandeau(true, "Un export est en cours : la page a repris son suivi.");
}

// Un export dure une heure. Lance par erreur — sur le mauvais tableau, ou en
// repartant lire Monday quand on ne voulait qu'une facture — il fallait le
// laisser aller au bout ou fermer la fenetre, ce qui laissait le travail a
// moitie fait sans que rien le dise.
$("arreter").addEventListener("click", async () => {
  if (!confirm("Arrêter l'export en cours ?\n\n"
      + "Le dossier en cours de traitement va à son terme, puis l'export "
      + "s'arrête. Les dossiers déjà constitués restent sur le disque, avec "
      + "leur récapitulatif.\n\nLa case « Reprendre » repartira d'ici.")) return;
  $("arreter").disabled = true;
  $("arreter").textContent = "Arrêt demandé…";
  try { await api("/api/arreter", {}); }
  catch (erreur) {
    afficherBandeau(false, erreur.message);
    $("arreter").disabled = false;
    $("arreter").textContent = "Arrêter";
  }
});

$("recharger").addEventListener("click", () => location.reload());

$("ouvrir").addEventListener("click", async () => {
  try { await api("/api/ouvrir", { chemin: $("sortie").value }); }
  catch (erreur) { afficherBandeau(false, erreur.message); }
});

// -- suivi
async function rafraichir() {
  let etat;
  try { etat = await api("/api/journal?depuis=" + position); }
  catch { return; }

  EXPORT_EN_COURS = Boolean(etat.en_cours);
  majBandeauExport();

  if (etat.arret_demande && !$("arreter").disabled) {
    // L'arret a pu etre demande depuis un autre onglet, ou avant que la page
    // ne reprenne son suivi : l'ecran doit le dire quand meme.
    $("arreter").disabled = true;
    $("arreter").textContent = "Arrêt demandé…";
  }

  if (etat.lignes.length) {
    position = etat.total;
    const journal = $("journal");
    for (const ligne of etat.lignes) journal.appendChild(elementLigne(ligne));
    // Un export d'une heure ecrit des milliers de lignes : les garder toutes
    // dans la page finit par la rendre poussive, et c'est alors l'export qui
    // parait s'etre arrete. Le journal complet reste dans journal.log.
    while (journal.childElementCount > LIGNES_A_L_ECRAN) {
      journal.removeChild(journal.firstElementChild);
    }
    journal.scrollTop = journal.scrollHeight;
  }

  if (etat.termine) {
    clearInterval(sondage);
    EXPORT_EN_COURS = false;
    chargerDossiers();
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
const LIGNES_A_L_ECRAN = 600;
const NATURES_PIECES = __NATURES_PIECES__;
let ENTREPRISES = null, ANNUAIRE_CONNU = false, ANNUAIRE_MANQUANTS = 0;
// Les notes qu'on n'a pas pu reecrire, et pourquoi. Elles restent en retard,
// donc remises en chantier a chaque affichage : sans le dire, le bandeau
// « mise a jour en cours » tourne sans que rien n'avance.
let NOTES_EN_ECHEC = [];
// Les factures que le tableau de suivi connait et que l'export n'a pas
// ramenees. Elles n'existent nulle part dans la page — ni dans la liste,
// ni dans la recherche — et rien ne disait pourquoi.
let ABSENTS_SUIVI = [];
// Les dossiers reunis sur une reference parasite : leurs pieces melangent
// des echanges sans rapport, et aucune correction d'affichage n'y changera
// rien. Il faut les refaire.
let A_REFAIRE = [];
// L'etat des copies datees du suivi. Un suivi qui retrecit brutalement est la
// signature d'un accident : il faut le dire quand cela se voit, avec de quoi
// revenir en arriere.
let SAUVEGARDES = null;
// Une seule tentative par ouverture : si le service est injoignable, insister
// a chaque rechargement de la liste ne le rendrait pas joignable.
let annuaireTente = false;
// Un export en cours reecrit la liste depuis le debut : le compte repart de
// zero et remonte. Sans le dire, cela se lit comme des dossiers qui
// disparaissent.
let EXPORT_EN_COURS = false;

const euro = (v) => new Intl.NumberFormat("fr-FR",
  { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(v || 0);

// « 0 € » se lit comme une dette soldee. Un montant que personne n'a renseigne
// — un dossier retrouve sur le disque, une ligne du tableau sans colonne de
// montant — n'est pas zero : il est inconnu, et l'ecrire zero ment sur la
// seule valeur qui decide d'aller ou non au contentieux.
function montantDu(dossier) {
  if (dossier.montant_renseigne === false && !dossier.montant_du) {
    return '<span class="etat inconnu" title="Montant non renseigné : il '
      + 'vient du tableau, et ce dossier n\'en a pas encore reçu.">—</span>';
  }
  return euro(dossier.montant_du);
}

async function chargerDossiers() {
  let donnees;
  try { donnees = await api("/api/dossiers"); }
  catch (erreur) { afficherBandeau(false, erreur.message); return; }

  DOSSIERS = donnees.dossiers;
  STATUTS = donnees.statuts;
  AGREGATS = donnees.agregats;
  COURBE = donnees.agregats ? donnees.agregats.courbe : null;
  SERVEUR = donnees.agregats || null;
  // La repartition par forme juridique vient de l'annuaire, pas des
  // agregats : elle a son propre porteur, sans quoi elle disparaitrait au
  // premier recalcul cote page.
  ENTREPRISES = donnees.entreprises || null;
  ANNUAIRE_CONNU = Boolean(donnees.annuaire_connu);
  ANNUAIRE_MANQUANTS = donnees.annuaire_manquants || 0;
  ABSENTS_SUIVI = donnees.absents_suivi || [];
  A_REFAIRE = donnees.a_refaire || [];
  NOTES_EN_ECHEC = donnees.notes_en_echec || [];
  SAUVEGARDES = donnees.sauvegardes || null;
  $("cheminSortie").textContent = donnees.sortie;
  remplirFiltresEtat();
  rendreDocuments();
  rendreSuivi();
  rendreBord();
  consulterAnnuaireSiBesoin();
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

// Trois etats et non deux : « non renseigne » n'est pas « non ». Vider la
// saisie rend la main au tableau, elle ne repond pas a la place du service.
function troisEtats(valeur) {
  const choix = [["", "— non renseigné"], ["oui", "✓ oui"], ["non", "✕ non"]];
  const courant = valeur === true ? "oui" : valeur === false ? "non" : "";
  return choix.map(([cle, libelle]) =>
    `<option value="${cle}"${cle === courant ? " selected" : ""}>${libelle}</option>`
  ).join("");
}

// Les cases cochées survivent au réaffichage. Trier par montant pour repérer
// les gros dossiers puis en cocher quelques-uns est le geste même : les
// perdre au clic suivant obligerait à tout reprendre.
const CHOISIS = new Set();

function majSelection() {
  const choisis = Array.from(document.querySelectorAll(".choix"))
    .filter((c) => c.checked);
  CHOISIS.clear();
  choisis.forEach((coche) => CHOISIS.add(coche.dataset.ref));
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
// Le tableau Monday ne porte pas tout : la convention, le diplome et les
// heures vivent souvent dans un fichier de suivi tenu a part. Les reprendre
// vaut mieux que de les ressaisir cinquante fois.
const COMPLEMENTS_RETENUS = __COMPLEMENTS_RETENUS__;

function majOubliComplements(retenus) {
  const lien = $("oublierComplements");
  if (!lien) return;
  lien.hidden = !(retenus && retenus.length);
  lien.textContent = retenus && retenus.length > 1
    ? `oublier ces ${retenus.length} fichiers` : "oublier ce fichier";
}

async function oublierComplements() {
  const retenus = $("oublierComplements").dataset.noms || "";
  if (!confirm(
      "Ces fichiers ne seront plus relus après les exports :\n\n"
      + retenus.split("|").join("\n")
      + "\n\nCe qu'ils ont déjà renseigné dans les dossiers reste en place.")) {
    return;
  }
  try {
    const r = await api("/api/oublier-complements", {});
    majOubliComplements([]);
    $("etatComplement").textContent = "";
    afficherBandeau(true, r.oublies.length
      ? `${r.oublies.length} fichier(s) oublié(s) : ${r.oublies.join(", ")}.`
      : "Il n'y avait aucun fichier retenu.");
  } catch (erreur) { afficherBandeau(false, erreur.message); }
}

async function completerDepuisFichier(evenement) {
  const fichier = evenement.target.files[0];
  if (!fichier) return;
  evenement.target.value = "";

  try {
    const contenu = await new Promise((resoudre, rejeter) => {
      const lecteur = new FileReader();
      lecteur.onload = () => resoudre(lecteur.result.split(",")[1]);
      lecteur.onerror = () => rejeter(new Error("Fichier illisible."));
      lecteur.readAsDataURL(fichier);
    });
    const r = await api("/api/completer", { nom: fichier.name, contenu: contenu });
    if (r.memorise) {
      const retenus = r.retenus || [r.memorise];
      $("etatComplement").textContent = retenus.length > 1
        ? retenus.length + " fichiers retenus : " + retenus.join(", ")
          + " — tous réappliqués après chaque export."
        : "Fichier retenu : " + r.memorise
          + " — réappliqué après chaque export.";
      $("oublierComplements").dataset.noms = retenus.join("|");
      majOubliComplements(retenus);
    }
    afficherBandeau(
      r.dossiers > 0,
      `${r.lignes} ligne(s) lue(s) : ${r.valeurs} valeur(s) reprise(s) sur `
      + `${r.dossiers} dossier(s).`
      + (r.adresses
         ? ` Dont ${r.adresses} adresse(s) mail, qui serviront au prochain `
           + `export.`
         : "")
      + (r.etapes
         ? ` ${r.etapes} dossier(s) ont repris l'étape inscrite au tableau `
           + `(les étapes déjà saisies ici sont conservées).`
         : "")
      + ((r.ecartes || []).length
         ? ` Onglet utilisé : « ${r.onglet} ». Non lus : `
           + `${r.ecartes.join(", ")}.`
         : "")
      + (r.sans_correspondance
         ? ` ${r.sans_correspondance} ligne(s) sans dossier correspondant`
           + ((r.exemples || []).length
              ? ` (${r.exemples.join(", ")}…).` : ".")
         : "")
      + (r.dossiers ? "" : " Vérifiez que les numéros de facture concordent."));
    chargerDossiers();
  } catch (erreur) { afficherBandeau(false, erreur.message); }
}

// Le recapitulatif etait remplace par les seuls dossiers de la derniere
// passe : une recherche ponctuelle effacait de la liste les cinquante-deux
// autres. Ils etaient toujours sur le disque, complets, avec leurs pieces
// versees — mais plus rien ne se voyait, ce qui revient au meme.
async function restaurerSuivi() {
  if (!confirm("Remettre en place la copie précédente de votre suivi ?\n\n"
      + "Étapes, frais, notes, contextes et pièces versées y reviennent. "
      + "L'état actuel est lui aussi sauvegardé avant : ce geste se défait.")) {
    return;
  }
  const bouton = $("restaurerSuivi");
  bouton.disabled = true;
  try {
    const r = await api("/api/restaurer-suivi", {});
    afficherBandeau(true,
      `${r.restaures} dossier(s) restaurés depuis ${r.sauvegarde}.`);
    chargerDossiers();
  } catch (erreur) {
    afficherBandeau(false, erreur.message);
    bouton.disabled = false;
  }
}

async function retrouverDossiers(evenement) {
  const bouton = (evenement && evenement.currentTarget) || $("retrouver");
  bouton.disabled = true;
  const avant = bouton.textContent;
  bouton.textContent = "Lecture du disque…";
  try {
    const r = await api("/api/retrouver", {});
    // Ce qui a ete vu, pas seulement ce qui a ete fait : « aucun dossier
    // retrouve » laisse croire a une panne, alors que la reponse est souvent
    // qu'il n'y a qu'un repertoire la ou l'on en attendait cinquante.
    const vu = (r.lignes || []).join(" ");
    afficherBandeau(true, (r.retrouves
      ? `${r.retrouves} dossier(s) remis à la liste. Leurs messages et leurs `
        + "pièces versées sont intacts ; la raison sociale et le montant "
        + "reviendront au prochain export. "
      : "Aucun dossier à retrouver : la liste porte déjà tout ce qui est sur "
        + "le disque. ") + vu);
    chargerDossiers();
  } catch (erreur) { afficherBandeau(false, erreur.message); }
  finally { bouton.disabled = false; bouton.textContent = avant; }
}

async function toutEffacer() {
  const total = DOSSIERS.length;
  if (!total) { afficherBandeau(false, "Il n'y a rien à effacer."); return; }

  if (!confirm(`Retirer les ${total} dossiers de la liste ?\n\n`
      + (RECHERCHE.trim()
         ? `⚠ Une recherche est en cours (« ${RECHERCHE.trim()} ») : elle `
           + "n'y change rien. Ce sont bien les "
           + total + " dossiers qui seront retirés, pas seulement ceux "
           + "affichés.\n\n"
         : "")
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

// Une recherche unique pour les deux onglets : trouver un dossier dans
// « État des dossiers » puis passer aux « Documents » sans le reperdre est le
// geste courant, et deux filtres indépendants obligeraient à le retaper.
let RECHERCHE = "";

// Un numéro se cite de dix façons — « FACT-2405-00409 », « FACT2405 00409 »,
// « fact 2405 00409 ». La recherche ne doit pas échouer sur un tiret.
function reduire(valeur) {
  return String(valeur || "").toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function reduireNumero(valeur) {
  return reduire(valeur).replace(/[^a-z0-9]/g, "");
}

function correspond(dossier, terme) {
  const champs = [dossier.reference, dossier.nom, dossier.emails,
                  dossier.factures, dossier.references, dossier.adresses,
                  dossier.note].join(" ");
  if (reduire(champs).includes(reduire(terme))) return true;
  // Le terme peut être un numéro écrit autrement que dans le tableau.
  const numero = reduireNumero(terme);
  return numero.length >= 3 && reduireNumero(champs).includes(numero);
}

function dossiersFiltres() {
  let liste = DOSSIERS;
  // L'état d'abord : « montre-moi les possibles abandons » est une question
  // à part entière, qu'aucun mot-clé ne pose — le libellé n'est écrit nulle
  // part dans les champs sur lesquels porte la recherche.
  if (ETAT_CHOISI) {
    liste = liste.filter((d) => (d.statut || "non-transmis") === ETAT_CHOISI);
  }
  const terme = RECHERCHE.trim();
  if (!terme) return liste;
  // Plusieurs mots : tous doivent correspondre, pour affiner plutôt
  // qu'élargir. « eden 00409 » ne ramène que ce dossier-là.
  const mots = terme.split(/\s+/).filter(Boolean);
  return liste.filter((d) => mots.every((mot) => correspond(d, mot)));
}

function majCompteRecherche(visibles) {
  const filtre = Boolean(RECHERCHE.trim() || ETAT_CHOISI);
  const texte = !filtre
    ? (DOSSIERS.length ? `${DOSSIERS.length} dossier(s).` : "")
    : `${visibles} dossier(s) sur ${DOSSIERS.length}.`;
  ["compteSuivi", "compteDocuments"].forEach((id) => {
    if ($(id)) $(id).textContent = texte;
  });
}

// -- filtre par état
//
// Partagé entre les deux onglets, comme la recherche : isoler les possibles
// abandons dans « État des dossiers » puis passer aux « Documents » sans le
// reperdre est le geste courant.
let ETAT_CHOISI = "";

function remplirFiltresEtat() {
  // Chaque état porte le nombre de dossiers qu'il compte : voir « Possible
  // abandon (7) » avant de cliquer évite de filtrer pour rien, et donne le
  // décompte sans changer d'onglet. Un état sans dossier n'est pas proposé.
  const comptes = new Map();
  DOSSIERS.forEach((d) => {
    const cle = d.statut || "non-transmis";
    comptes.set(cle, (comptes.get(cle) || 0) + 1);
  });
  const options = ['<option value="">Tous les états</option>']
    .concat(STATUTS.filter((s) => comptes.get(s.cle))
      .map((s) => `<option value="${echapper(s.cle)}"`
        + (s.cle === ETAT_CHOISI ? " selected" : "") + ">"
        + echapper(s.libelle) + ` (${comptes.get(s.cle)})</option>`));
  // Un état choisi puis vidé de ses dossiers doit rester proposé, sans quoi
  // la liste paraîtrait vide sans qu'on voie pourquoi.
  if (ETAT_CHOISI && !comptes.get(ETAT_CHOISI)) {
    const perdu = STATUTS.find((s) => s.cle === ETAT_CHOISI);
    if (perdu) {
      options.push(`<option value="${echapper(perdu.cle)}" selected>`
        + echapper(perdu.libelle) + " (0)</option>");
    }
  }
  ["filtreEtatSuivi", "filtreEtatDocuments"].forEach((id) => {
    if ($(id)) $(id).innerHTML = options.join("");
  });
}

function choisirEtat(evenement) {
  ETAT_CHOISI = evenement.target.value;
  ["filtreEtatSuivi", "filtreEtatDocuments"].forEach((id) => {
    if ($(id) && $(id) !== evenement.target) $(id).value = ETAT_CHOISI;
  });
  rendreSuivi();
  rendreDocuments();
}

function messageAucuneCorrespondance() {
  return '<p class="vide">Aucun dossier ne correspond à « '
    + echapper(RECHERCHE.trim())
    + ' ».<br />La recherche porte sur le numéro de facture, l\'adresse mail, '
    + "le nom du débiteur et la note.</p>";
}

function chercherDossiers(evenement) {
  RECHERCHE = evenement.target.value;
  // Les deux champs disent la même chose : le filtre est commun.
  ["chercheSuivi", "chercheDocuments"].forEach((id) => {
    if ($(id) && $(id) !== evenement.target) $(id).value = RECHERCHE;
  });
  rendreSuivi();
  rendreDocuments();
}

// -- tri par colonne
//
// Les dossiers arrivaient dans l'ordre de l'export, qui ne répond à aucune
// question. « Qui doit le plus », « à qui manque-t-il une convention »,
// « lesquels traînent depuis le plus longtemps » se lisaient en parcourant
// la liste entière à l'œil. Chaque en-tête devient un bouton.
//
// L'état est tenu par tableau et non partagé comme la recherche : les
// colonnes ne sont pas les mêmes des deux côtés, et trier les documents par
// période n'a pas d'équivalent dans l'état des dossiers.
const TRI = { suivi: { colonne: "", sens: 1 },
              documents: { colonne: "", sens: 1 } };

// Une valeur absente descend en bas dans les deux sens. Une échéance vide
// n'est ni la plus proche ni la plus lointaine, et la voir coiffer le
// tableau au premier clic ferait douter du tri tout entier.
const VIDE = Symbol("vide");

function valeurTexte(valeur) {
  return reduire(valeur).trim() || VIDE;
}

function valeurNombre(valeur) {
  if (valeur === null || valeur === undefined || valeur === "") return VIDE;
  const nombre = Number(valeur);
  return isNaN(nombre) ? VIDE : nombre;
}

// « 21/05/2024 », « 21/05/2024 09:30 » ou la forme ISO du récapitulatif :
// comparées comme des nombres, une date mal rangée ne pouvant se rattraper.
function valeurDate(valeur) {
  const texte = String(valeur || "").trim();
  const fr = texte.match(/^(\d{2})\/(\d{2})\/(\d{4})(?:\D+(\d{2}):(\d{2}))?/);
  if (fr) return Number(fr[3] + fr[2] + fr[1] + (fr[4] || "00") + (fr[5] || "00"));
  const iso = texte.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return Number(iso[1] + iso[2] + iso[3] + "0000");
  return VIDE;
}

// Oui / non / non renseigné. L'ordre suit la question qu'on se pose en
// cliquant — « à qui manque-t-il une convention ? ». Le manque vient donc
// en premier, et le non-renseigné entre les deux : il reste à vérifier.
function valeurTroisEtats(valeur) {
  if (valeur === false) return 0;
  if (valeur === true) return 2;
  return 1;
}

// Les états suivent l'ordre du parcours, pas l'alphabet : « transmis »
// avant « au tribunal » avant « clôturé » dit quelque chose, « abandon,
// clôturé, transmis » ne dit rien.
function valeurEtat(cle) {
  const rang = STATUTS.findIndex((s) => s.cle === cle);
  return rang < 0 ? STATUTS.length : rang;
}

// La case d'en-tête coche ce que le tableau montre — pas les deux cents
// dossiers du portefeuille. Filtrer sur « possible abandon » puis tout
// cocher est le geste : elle ne doit pas ramener le reste avec elle.
function caseToutChoisir(cible) {
  return '<input type="checkbox" class="tout-choisir" data-cible="' + cible
    + '" title="Cocher ou décocher tous les dossiers affichés" />';
}

const COLONNES_SUIVI = [
  { titre: "", classe: "etroite", entete: caseToutChoisir("choix") },
  { titre: "Dossier", cle: "dossier", valeur: (d) => valeurTexte(d.reference) },
  { titre: "Montant dû", classe: "num", cle: "montant", sens: -1,
    valeur: (d) => valeurNombre(d.montant_du) },
  { titre: "Échéance", classe: "num", cle: "echeance",
    valeur: (d) => valeurDate(d.date_echeance) },
  { titre: "Retard", classe: "num", cle: "retard", sens: -1,
    valeur: (d) => valeurNombre(d.anciennete_jours) },
  { titre: "Convention", cle: "convention",
    valeur: (d) => valeurTroisEtats(d.convention_signee) },
  { titre: "Diplôme", cle: "diplome",
    valeur: (d) => valeurTroisEtats(d.diplome) },
  { titre: "État", cle: "etat", valeur: (d) => valeurEtat(d.statut) },
  { titre: "Frais engagés", classe: "num", cle: "frais", sens: -1,
    valeur: (d) => valeurNombre(d.frais) },
  { titre: "Note", cle: "note", valeur: (d) => valeurTexte(d.note) },
  { titre: "Contexte", cle: "contexte", valeur: (d) => valeurTexte(d.contexte) },
  { titre: "Durée", classe: "num", cle: "duree", sens: -1,
    valeur: (d) => valeurNombre(d.duree_jours) },
  { titre: "" },
  { titre: "Modifié", cle: "maj", sens: -1, valeur: (d) => valeurDate(d.maj) },
];

const COLONNES_DOCUMENTS = [
  { titre: "", classe: "etroite", entete: caseToutChoisir("choix-note") },
  { titre: "Référence", cle: "reference", valeur: (d) => valeurTexte(d.reference) },
  { titre: "Débiteur", cle: "debiteur", valeur: (d) => valeurTexte(d.nom) },
  { titre: "Mails", cle: "mails", sens: -1, valeur: (d) => valeurNombre(d.nb_mails) },
  { titre: "PJ", cle: "pj", sens: -1,
    valeur: (d) => valeurNombre(d.nb_pieces_jointes) },
  { titre: "Convention", cle: "convention",
    valeur: (d) => valeurTroisEtats(d.convention_signee) },
  { titre: "Diplôme", cle: "diplome", valeur: (d) => valeurTroisEtats(d.diplome) },
  { titre: "Relevé bancaire", cle: "releve",
    valeur: (d) => valeurTroisEtats(aPiece(d, "Relevé comptable")) },
  { titre: "Heures", classe: "num", cle: "heures", sens: -1,
    valeur: (d) => valeurNombre(
      String(d.heures_log || "").replace(",", ".")) },
  { titre: "Période", cle: "periode", sens: -1,
    valeur: (d) => valeurDate(d.dernier_mail) },
  { titre: "Sous-dossiers", cle: "sous", sens: -1,
    valeur: (d) => valeurNombre(d.sous_dossiers) },
  // Une note de synthèse est là ou elle ne l'est pas : trier dessus met en
  // haut les dossiers pour lesquels il n'y a rien à transmettre.
  { titre: "Document", cle: "document", valeur: (d) => (d.a_synthese ? 1 : 0) },
  { titre: "Pièces versées", cle: "pieces", sens: -1,
    valeur: (d) => valeurNombre((d.pieces || []).length) },
  { titre: "" },
];

function entetesTriables(colonnes, table) {
  const etat = TRI[table];
  return "<tr>" + colonnes.map((colonne) => {
    const classes = [colonne.classe, etat.colonne === colonne.cle ? "triee" : ""]
      .filter(Boolean).join(" ");
    const ouvre = `<th${classes ? ` class="${classes}"` : ""}>`;
    // Une colonne sans clé ne se trie pas — c'est celle des cases à cocher.
    // Elle peut porter un en-tête à elle : la case « tout sélectionner ».
    if (!colonne.cle) {
      return ouvre + (colonne.entete || echapper(colonne.titre)) + "</th>";
    }
    const sens = etat.colonne === colonne.cle
      ? (etat.sens > 0 ? " ↑" : " ↓") : "";
    return ouvre
      + `<button type="button" class="tri" data-table="${table}"`
      + ` data-tri="${colonne.cle}" title="Trier par `
      + `${echapper(colonne.titre.toLowerCase())} — recliquer inverse l'ordre">`
      + `${echapper(colonne.titre)}<span class="sens">${sens}</span>`
      + "</button></th>";
  }).join("") + "</tr>";
}

function trier(liste, colonnes, table) {
  const etat = TRI[table];
  const colonne = colonnes.find((c) => c.cle === etat.colonne);
  if (!colonne) return liste;
  // Copie : DOSSIERS garde l'ordre de l'export, qui est aussi celui du
  // récapitulatif. Le tri est une façon de regarder, pas de réécrire.
  return liste.slice().sort((a, b) => {
    const ga = colonne.valeur(a), gb = colonne.valeur(b);
    if (ga === VIDE || gb === VIDE) {
      return ga === gb ? 0 : (ga === VIDE ? 1 : -1);
    }
    if (ga === gb) return 0;
    return (ga > gb ? 1 : -1) * etat.sens;
  });
}

function basculerTri(evenement) {
  const bouton = evenement.currentTarget;
  const table = bouton.dataset.table;
  const colonnes = table === "suivi" ? COLONNES_SUIVI : COLONNES_DOCUMENTS;
  const colonne = colonnes.find((c) => c.cle === bouton.dataset.tri);
  const etat = TRI[table];
  if (etat.colonne === bouton.dataset.tri) {
    etat.sens = -etat.sens;
  } else {
    // Le premier clic prend le sens utile : les gros montants et les longs
    // retards en haut, les noms de A à Z, les échéances de la plus ancienne
    // à la plus récente. Personne ne cherche le plus petit impayé d'abord.
    etat.colonne = bouton.dataset.tri;
    etat.sens = colonne && colonne.sens ? colonne.sens : 1;
  }
  if (table === "suivi") rendreSuivi(); else rendreDocuments();
}

function brancherTri(zone) {
  zone.querySelectorAll("button.tri").forEach((bouton) =>
    bouton.addEventListener("click", basculerTri));
}

function messageVide() {
  // Pendant un export, « aucun export trouvé » est faux et inquietant : la
  // liste se reconstitue, elle n'est pas absente.
  if (EXPORT_EN_COURS) {
    return '<p class="vide">L\'export est en cours : les dossiers '
      + "apparaîtront ici au fur et à mesure.</p>";
  }
  return '<p class="vide">Aucun export trouvé dans le dossier de destination.' +
    "<br />Lancez un export depuis l'onglet « Export » — les dossiers produits " +
    "apparaîtront ici.</p>";
}

// Le rattrapage n'est propose que la ou son bouton est branche — l'onglet
// « Etat des dossiers ». Ailleurs, il s'affichait sans rien faire au clic.
function messageVideAvecRattrapage() {
  if (EXPORT_EN_COURS) return messageVide();
  return messageVide()
    + '<p class="vide">Si des dossiers ont déjà été constitués sur le disque, '
    + "ils se récupèrent sans refaire d'export : "
    + '<button class="secondaire" data-retrouver="1">Retrouver les dossiers '
    + 'du disque</button></p>';
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

// Le relevé comptable est une pièce versée à la main, pas une colonne du
// tableau Monday : son état se lit dans les pièces du dossier. Il se présente
// comme la convention et le diplôme — c'est la même question posée au
// dossier : la pièce est-elle là ?
function aPiece(dossier, nature) {
  return (dossier.pieces || []).some((p) => p.nature === nature);
}

function etatPiece(dossier, nature, present, absent) {
  const versee = (dossier.pieces || []).find((p) => p.nature === nature);
  if (!versee) return '<span class="etat non">✕ ' + absent + "</span>";
  return '<span class="etat oui" title="' + echapper(versee.fichier) + '">✓ '
    + present + "</span>";
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

// Le releve comptable, la convention, la facture : ce que le service verse
// lui-meme au dossier. Ces pieces etablissent la creance ; elles ne prouvent
// pas la transmission au debiteur, et la note le dit.
function piecesVersees(d) {
  const pieces = d.pieces || [];
  const liste = pieces.length
    ? `<div class="versees">${pieces.map((p) =>
        `<span title="${echapper(p.nature)} — ajoutée le ${echapper(p.ajoute_le || "")}">`
        + `${echapper(p.fichier)}</span>`).join("")}</div>`
    : "";
  return `
    <select class="nature" data-ref="${echapper(d.reference)}">
      ${NATURES_PIECES.map((n) =>
        `<option value="${echapper(n)}">${echapper(n)}</option>`).join("")}
    </select>
    <label class="depot-piece" title="Une pièce (PDF, image…) ou un message téléchargé (.eml)">Ajouter…
      <input type="file" class="fichier-piece" data-ref="${echapper(d.reference)}"
             accept=".pdf,.eml,.png,.jpg,.jpeg,.csv,.xlsx,.docx,.txt" />
    </label>${liste}`;
}

async function verserPiece(evenement) {
  const champ = evenement.target;
  const fichier = champ.files[0];
  if (!fichier) return;
  const reference = champ.dataset.ref;
  champ.value = "";

  const nature = document.querySelector(
    `select.nature[data-ref="${CSS.escape(reference)}"]`).value;

  try {
    const contenu = await new Promise((resoudre, rejeter) => {
      const lecteur = new FileReader();
      lecteur.onload = () => resoudre(lecteur.result.split(",")[1]);
      lecteur.onerror = () => rejeter(new Error("Fichier illisible."));
      lecteur.readAsDataURL(fichier);
    });
    const r = await api("/api/piece", {
      reference: reference, nature: nature,
      nom: fichier.name, contenu: contenu,
    });
    afficherBandeau(true, (r.piece
        ? `Message ajouté au dossier ${reference} en pièce n° ${r.piece}`
          + ` (${r.sens}).`
        : `${r.nature} versée au dossier ${reference}.`
          + (r.repond ? ` La colonne ${r.repond} passe à « oui ».` : ""))
      + (r.synthese_refaite
         ? " La note de synthèse a été refaite."
         : ` La note a été refaite, mais pas au format PDF : ${r.motif}.`));
    chargerDossiers();
  } catch (erreur) { afficherBandeau(false, erreur.message); }
}

function rendreDocuments() {
  if (!DOSSIERS.length) {
    $("tableDocuments").innerHTML = messageVide();
    majCompteRecherche(0);
    return;
  }
  const retenus = dossiersFiltres();
  majCompteRecherche(retenus.length);
  if (!retenus.length) {
    $("tableDocuments").innerHTML = messageAucuneCorrespondance();
    return;
  }

  const lignes = trier(retenus, COLONNES_DOCUMENTS, "documents").map((d) => `
    <tr>
      <td><input type="checkbox" class="choix-note"
          data-ref="${echapper(d.reference)}"
          ${CHOIX_NOTES.has(d.reference) ? "checked" : ""}
          title="Refaire la note de ce dossier seulement." /></td>
      <td class="reference"><b>${echapper(d.reference)}</b></td>
      <td>${echapper(d.nom)}</td>
      <td class="num">${d.nb_mails}</td>
      <td class="num">${d.nb_pieces_jointes}</td>
      <td>${etatOuiNon(d.convention_signee, "signée", "non signée")}</td>
      <td>${etatOuiNon(d.diplome, "reçu", "non reçu")}</td>
      <td>${etatPiece(d, "Relevé comptable", "versé", "absent")}</td>
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
        ? `<a class="lien" data-ouvrir="${echapper(d.repertoire)}/`
          + `${echapper(d.fichier_synthese || "synthese.pdf")}">Note de synthèse</a>`
          + (d.note_perimee
             ? `<br /><span class="perimee" title="Le suivi de ce dossier a `
               + `changé le ${echapper(d.maj)}, après que la note a été `
               + `écrite. « Refaire les notes » la remet à jour sans `
               + `retourner sur Gmail.">↻ à refaire</span>` : "")
        : '<span class="lien inactif">pas de note</span>'}</td>
      <td>${piecesVersees(d)}</td>
      <td><a class="lien" data-ouvrir="${echapper(d.repertoire)}">Ouvrir le répertoire</a></td>
    </tr>`).join("");

  // Le cas courant : un fichier de suivi appliqué après coup renseigne d'un
  // coup l'échéance et le contexte de cent cinquante dossiers, dont les
  // notes datent de l'export. Rien ne le disait, et la note ouverte paraissait
  // simplement fausse.
  const perimees = DOSSIERS.filter((d) => d.note_perimee).length;
  // Elles se refont d'elles-memes : la page l'annonce au lieu d'offrir un
  // bouton pour le demander.
  // Pendant un export, la remise a jour est volontairement suspendue : deux
  // ecritures dans les memes repertoires se marcheraient dessus. Annoncer
  // « en cours » serait promettre ce qui n'a pas lieu.
  const avertissement = perimees ? `
    <p class="aide perimees">↻ ${perimees} note(s) de synthèse ${EXPORT_EN_COURS
      ? "seront mises à jour à la fin de l'export en cours"
      : "sont en cours de mise à jour"} — échéance, convention, contexte ou
       étape ont changé depuis qu'elles ont été écrites. Cela se fait tout
       seul, à partir des messages déjà au dossier, sans retourner sur
       Gmail.</p>`
    : "";

  // Une note qu'on n'arrive pas à réécrire est remise en chantier à chaque
  // affichage : sans le dire, le bandeau ci-dessus tourne indéfiniment sans
  // que rien n'avance, et l'on croit l'outil occupé alors qu'il est bloqué.
  const echecs = NOTES_EN_ECHEC.length ? `
    <p class="aide echecs">⚠ ${NOTES_EN_ECHEC.length} note(s) n'ont pas pu
       être réécrites : ${echapper(NOTES_EN_ECHEC[0].motif)}${
      NOTES_EN_ECHEC.length > 1 ? " (et autres)" : ""} — ${
      echapper(NOTES_EN_ECHEC.slice(0, 6).map((n) => n.reference).join(", "))}${
      NOTES_EN_ECHEC.length > 6 ? "…" : ""}.<br />
       La cause la plus fréquente est un PDF ouvert dans un lecteur : fermez-le,
       la remise à jour repartira seule.</p>`
    : "";

  $("tableDocuments").innerHTML = avertissement + echecs
    + `<div class="defilable"><table class="donnees">
    ${entetesTriables(COLONNES_DOCUMENTS, "documents")}
    ${lignes}</table></div>`;

  brancherTri($("tableDocuments"));
  $("tableDocuments").querySelectorAll(".choix-note").forEach((coche) =>
    coche.addEventListener("change", majChoixNotes));
  brancherToutChoisir($("tableDocuments"), majChoixNotes);
  majChoixNotes();

  $("tableDocuments").querySelectorAll(".fichier-piece").forEach((champ) =>
    champ.addEventListener("change", verserPiece));

  $("tableDocuments").querySelectorAll("[data-ouvrir]").forEach((lien) =>
    lien.addEventListener("click", async () => {
      try { await api("/api/ouvrir", { chemin: lien.dataset.ouvrir }); }
      catch (erreur) { afficherBandeau(false, erreur.message); }
    }));
}

// Le suivi est la seule chose de l'application qui n'existe nulle part
// ailleurs : ni Monday ni Gmail ne le reconstitueraient. Chaque ecriture en
// garde l'etat precedent ; si l'actuel s'effondre, on le dit ici.
function blocSauvegarde() {
  if (!SAUVEGARDES || !SAUVEGARDES.perte) return "";
  return `
    <p class="aide a-refaire"><b>Votre suivi est passé de
       ${SAUVEGARDES.dossiers_sauvegardes} à ${SAUVEGARDES.dossiers_suivis}
       dossier(s).</b> Si ce n'est pas voulu, la copie précédente est
       conservée et peut être remise en place — étapes, frais, notes,
       contextes et pièces versées.
       <button class="secondaire" id="restaurerSuivi">Restaurer
       ${SAUVEGARDES.dossiers_sauvegardes} dossier(s)</button></p>`;
}

// Une « reference » venue de la plomberie des messages — « goog_97526804 »,
// « groups/13606280 » — entrait dans la requete Gmail. Or celle-la figure dans
// presque tous les messages Gmail : le dossier ramassait des conversations
// entieres sans rapport, avec les echanges d'autres apprenants. Le critere est
// corrige, mais les dossiers deja constitues avec lui sont faux.
function blocARefaire() {
  const vus = new Set(DOSSIERS.map((d) => d.reference));
  const concernes = A_REFAIRE.filter((r) => vus.has(r));
  if (!concernes.length) return "";
  return `
    <p class="aide a-refaire"><b>${concernes.length} dossier(s) ont été
       constitués sur un critère de recherche faux</b> — une chaîne technique
       prise pour un numéro de facture, qui ramenait des conversations sans
       rapport. Le critère est corrigé ; ces dossiers-là, eux, sont à refaire :
       cochez-les ci-dessous, <b>Supprimer</b>, puis relancez l'export
       <b>sans</b> « Reprendre ». Refaire les notes ne suffira pas — ce sont
       les messages eux-mêmes qui sont en trop.
       <br />${concernes.map(echapper).join(" · ")}</p>`;
}

// Le tableau de suivi porte des factures que l'export n'a pas ramenées. Elles
// n'existent nulle part dans la page — ni dans la liste, ni dans la recherche
// — et rien ne disait pourquoi : on cherchait un dossier qu'on savait avoir,
// on ne le trouvait pas, et l'application paraissait en défaut alors qu'elle
// n'en avait simplement jamais entendu parler.
function blocAbsentsDuSuivi() {
  // Recoupé avec la liste plutôt que cru sur parole : un export plus récent a
  // pu ramener depuis un dossier que le fichier disait absent.
  const connus = new Set(DOSSIERS.map((d) => reduireNumero(d.reference)));
  DOSSIERS.forEach((d) => (d.factures || "").split("|")
    .forEach((f) => connus.add(reduireNumero(f))));
  const manquants = ABSENTS_SUIVI
    .filter((r) => !connus.has(reduireNumero(r)));
  if (!manquants.length) return "";

  const PLAFOND = 40;
  const listes = manquants.slice(0, PLAFOND)
    .map((r) => `<li>${echapper(r)}</li>`).join("");
  // Hors du bloc repliable, et non dedans : un bouton range sous un titre
  // qu'il faut d'abord deplier est un bouton qu'on ne trouve pas.
  return `
    <p class="aide rattrapage">Des dossiers déjà constitués sur le disque ne
       figurent plus dans la liste ? Ils se récupèrent sans refaire d'export :
       <button class="secondaire" data-retrouver="1">Retrouver les dossiers du
       disque</button></p>
    <details class="absents">
      <summary>${manquants.length} facture(s) de votre tableau de suivi
        ne sont dans aucun dossier exporté</summary>
      <p class="aide">L'application ne connaît que ce que l'export lui a
         apporté : ces factures-là n'ont jamais été ramenées, et c'est
         pourquoi la recherche ne les trouve pas. Pour les faire entrer,
         relancez un export en les incluant — depuis Monday, ou depuis un
         export où elles figurent.</p>
      <ul>${listes}</ul>
      ${manquants.length > PLAFOND
        ? `<p class="aide">et ${manquants.length - PLAFOND} autre(s).</p>` : ""}
    </details>`;
}

// -- onglet État des dossiers
function rendreSuivi() {
  // La barre est rendue même sans aucun dossier. Elle disparaissait avec la
  // liste, or c'est précisément quand la liste est vide ou fausse qu'on
  // cherche « Tout effacer » et « Compléter depuis un fichier » : les seuls
  // boutons qui remettent l'application d'aplomb s'en allaient avec le
  // problème qu'ils servent à régler.
  const retenus = DOSSIERS.length ? dossiersFiltres() : [];
  majCompteRecherche(retenus.length);

  const options = (choisi) => STATUTS.map((s) =>
    `<option value="${s.cle}"${s.cle === choisi ? " selected" : ""}>` +
    `${s.icone ? s.icone + " " : ""}${echapper(s.libelle)}</option>`).join("");

  const lignes = trier(retenus, COLONNES_SUIVI, "suivi").map((d) => `
    <tr data-reference="${echapper(d.reference)}">
      <td><input type="checkbox" class="choix" data-ref="${echapper(d.reference)}"
          ${CHOISIS.has(d.reference) ? "checked" : ""} /></td>
      <td class="dossier"><b>${echapper(d.reference)}</b><br />
          <span style="color:var(--texte-3)">${echapper(d.nom)}</span></td>
      <td class="num">${montantDu(d)}</td>
      <td class="num"><input class="echeance" data-champ="echeance" type="text"
          value="${echapper(d.date_echeance || "")}" placeholder="JJ/MM/AAAA"
          title="Échéance de la facture. Saisie ici, elle l'emporte sur le tableau." /></td>
      <td class="num">${retard(d.anciennete_jours)}</td>
      <td><select data-champ="convention">${troisEtats(d.convention_signee)}</select></td>
      <td><select data-champ="diplome">${troisEtats(d.diplome)}</select></td>
      <td><select data-champ="statut">${options(d.statut)}</select></td>
      <td class="num"><input class="frais" data-champ="frais" type="text"
          value="${d.frais ? d.frais : ""}" placeholder="0" /> €</td>
      <td><input class="note" data-champ="note" type="text"
          value="${echapper(d.note)}" placeholder="Référence avocat, audience…" /></td>
      <td><input class="contexte" data-champ="contexte" type="text"
          value="${echapper(d.contexte || "")}"
          title="Ce que l'outil ne peut pas savoir : appels sans réponse, chèque de caution encaissé puis rejeté, arrangement verbal non tenu. Repris tel quel au point 2 de la note."
          placeholder="Ne répond pas au téléphone, chèque rejeté…" /></td>
      <td class="num" style="font-size:12px">${d.duree_jours === null ||
          d.duree_jours === undefined ? "—" : d.duree_jours + " j"}</td>
      <td><a class="lien" data-detail="${echapper(d.reference)}">Parcours</a></td>
      <td style="color:var(--texte-3);font-size:11px">${echapper(d.maj)}</td>
    </tr>`).join("");

  $("tableSuivi").innerHTML = `
    <div class="barre-selection">
      <button class="secondaire" id="supprimer" disabled>Supprimer</button>
      <label class="depot-complement" title="__COMPLEMENT__">Compléter depuis un fichier
        <input type="file" id="complement" accept=".csv,.tsv,.txt,.xlsx,.xlsm,.xltx" />
      </label>
      <span id="etatComplement" class="retenu">__COMPLEMENT__</span>
      <a id="oublierComplements" class="lien-oubli" hidden
         title="Les fichiers cessent d'être relus. Ce qu'ils ont déjà renseigné reste dans les dossiers.">oublier</a>
      <button class="secondaire" id="retrouver"
              title="Relit les répertoires déjà sur le disque et rend à la liste ceux qui n'y figurent plus. Rien n'est retéléchargé, rien n'est écrasé.">Retrouver les dossiers du disque</button>
      <button class="secondaire danger" id="toutEffacer"${
        DOSSIERS.length ? "" : " disabled"}>Tout effacer…</button>
      <span id="compteChoix">Cochez les dossiers à retirer de la liste.</span>
    </div>
    ${DOSSIERS.length
      ? (retenus.length ? "" : messageAucuneCorrespondance())
      : messageVideAvecRattrapage()}
    ${blocSauvegarde()}
    ${blocARefaire()}
    ${blocAbsentsDuSuivi()}
    <div class="defilable"${retenus.length ? "" : " hidden"}><table class="donnees">
    ${entetesTriables(COLONNES_SUIVI, "suivi")}
    ${lignes}</table></div><div id="detailDossier"></div>`;

  brancherTri($("tableSuivi"));

  $("tableSuivi").querySelectorAll(".choix").forEach((coche) =>
    coche.addEventListener("change", majSelection));
  brancherToutChoisir($("tableSuivi"), majSelection);
  $("supprimer").addEventListener("click", supprimerChoisis);
  $("toutEffacer").addEventListener("click", toutEffacer);
  // Le bouton figure a plusieurs endroits — la barre, le bloc des factures
  // absentes, le message de liste vide — parce qu'on le cherche la ou le
  // probleme se voit, pas la ou il a ete range.
  $("tableSuivi").querySelectorAll("#retrouver, [data-retrouver]")
    .forEach((bouton) => bouton.addEventListener("click", retrouverDossiers));
  $("complement").addEventListener("change", completerDepuisFichier);
  $("oublierComplements").dataset.noms = COMPLEMENTS_RETENUS.join("|");
  majOubliComplements(COMPLEMENTS_RETENUS);
  $("oublierComplements").addEventListener("click", oublierComplements);
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
        // Ces quatre-là changent des valeurs calculees sur le poste — les
        // durees, le retard, la solidite du portefeuille. On recharge plutot
        // que de les rederiver ici, ou les deux finiraient par diverger.
        if (["statut", "convention", "diplome", "echeance"].includes(
            champ.dataset.champ)) { chargerDossiers(); return; }
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
// « Quels mails ont ete recuperes, et de quel droit ? » ne trouvait sa reponse
// que dans index.csv, qu'il fallait ouvrir dans Excel. C'est pourtant la
// premiere chose qu'on veut savoir d'un dossier qu'on va transmettre.
//
// Le critere y est ecrit en abrege — « adresse+facture » — parce qu'il sert
// d'abord a l'outil. Ici on l'ecrit en francais.
function raisonLisible(critere) {
  const brut = String(critere || "").trim();
  if (!brut) return "sans critère noté";
  if (brut.startsWith("autre facture")) {
    return "mis à part : ne parle que d'une autre facture ("
      + echapper(brut.split(":").slice(1).join(":").trim()) + ")";
  }
  if (brut.startsWith("diffusion")) {
    return "mis à part : "
      + echapper(brut.split(":").slice(1).join(":").trim());
  }
  if (brut.startsWith("hors debiteur")) {
    return "mis à part : votre débiteur n'apparaît nulle part dans ce "
      + "message — il ne concerne pas son dossier";
  }
  if (brut === "déposé à la main") return "versé à la main dans le dossier";
  const morceaux = [];
  if (brut.includes("adresse")) morceaux.push("l'adresse du débiteur");
  if (brut.includes("facture")) morceaux.push("le numéro de facture");
  if (brut.includes("nom")) morceaux.push("le nom de l'apprenant");
  if (brut.includes("piece") || brut.includes("filename")) {
    morceaux.push("le nom d'une pièce jointe");
  }
  if (!morceaux.length) return echapper(brut);
  return "retrouvé par " + morceaux.join(" et ");
}

async function voirMessages(reference) {
  const zone = $("messagesDossier");
  zone.innerHTML = '<p class="aide">Lecture du dossier…</p>';
  let reponse;
  try { reponse = await api("/api/messages", { reference: reference }); }
  catch (erreur) { zone.innerHTML = ""; afficherBandeau(false, erreur.message); return; }

  const messages = reponse.messages || [];
  if (!messages.length) {
    zone.innerHTML = '<p class="vide">Aucun message dans ce dossier'
      + (reponse.sans_index ? " : il n'a pas encore été constitué." : ".") + "</p>";
    return;
  }
  const retenus = messages.filter((m) => !m.ecarte).length;
  zone.innerHTML = `
    <p class="aide"><b>${messages.length} message(s)</b> — ${retenus} qui
       établissent la créance, ${messages.length - retenus} mis à part.
       Chaque ligne dit pourquoi le message a été retrouvé.</p>
    <div class="defilable"><table class="donnees">
      <tr><th class="num">Pièce</th><th class="num">Date</th><th>Sens</th>
          <th>De</th><th>Objet</th><th>Pourquoi</th><th>PJ</th></tr>
      ${messages.map((m) => `
        <tr${m.ecarte ? ' class="ecarte"' : ""}>
          <td class="num">n° ${echapper(m.piece)}</td>
          <td class="num">${echapper(m.date)}</td>
          <td>${echapper(m.sens)}</td>
          <td>${echapper(m.de)}</td>
          <td>${echapper(m.objet)}</td>
          <td>${raisonLisible(m.critere)}</td>
          <td>${echapper(m.pj)}</td>
        </tr>`).join("")}
    </table></div>`;
}

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
      <div class="boutons">
        <button class="secondaire" id="voirMessages">Voir les mails récupérés</button>
        <button class="secondaire" id="fermerDetail">Fermer</button>
      </div>
      <div id="messagesDossier"></div>
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
  $("voirMessages").addEventListener("click", () => voirMessages(reference));
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
function majBandeauExport() {
  const zone = $("exportEnCours");
  if (!zone) return;
  zone.hidden = !EXPORT_EN_COURS;
  if (EXPORT_EN_COURS) {
    zone.textContent = "Un export est en cours : la liste se reconstitue "
      + "dossier par dossier, et les chiffres ci-dessous montent au fur et à "
      + "mesure. Ils ne seront complets qu'à la fin.";
  }
}

// Ce que l'annuaire public de l'Etat dit des debiteurs. Ce n'est pas une note
// de solvabilite — les comptes n'y sont pas — mais une societe radiee ne
// paiera pas, et cela se sait avant d'engager des frais d'avocat.
function rendreEntreprises() {
  const zone = $("entreprises");
  if (!zone) return;
  const e = ENTREPRISES;

  if (!e || !e.nb_debiteurs) {
    zone.innerHTML = "<h3>Débiteurs entreprises</h3>"
      + '<p class="aide">Aucun dossier en cours.</p>';
    return;
  }

  const rangees = e.formes.map((f) => `
    <tr>
      <td><b>${echapper(f.forme)}</b></td>
      <td class="num">${f.nombre}</td>
      <td class="num">${euro(f.montant)}</td>
      <td class="num">${f.cessees ? '<span class="etat non">✕ ' + f.cessees
        + "</span>" : '<span class="etat inconnu">—</span>'}</td>
    </tr>`).join("");

  const alerte = e.cessees.length ? `
    <p class="aide" style="margin-top:15px"><b class="etat non">
      ✕ ${e.cessees.length} société(s) ayant cessé leur activité</b> —
      ${euro(e.montant_cesse)} en jeu. Radiées ou fermées d'après l'annuaire
      public : il n'y a plus d'entreprise en face pour payer, et un
      recouvrement y est compromis. À vérifier avant d'engager des frais.</p>
    <ul class="cessees">${e.cessees.map((c) => `
      <li>${echapper(c.reference)} · ${echapper(c.nom)} · ${euro(c.montant)}
        ${c.fiche ? `<a class="lien" href="${echapper(c.fiche)}"
          target="_blank" rel="noopener">fiche publique</a>` : ""}</li>`).join("")}
    </ul>` : "";

  zone.innerHTML = `
    <h3>Débiteurs entreprises, par forme juridique</h3>
    <p class="aide">D'après l'annuaire public des entreprises
       (annuaire-entreprises.data.gouv.fr), sur ${e.nb_debiteurs} dossier(s)
       en cours. ${e.sans_fiche} sans fiche trouvée — débiteur particulier,
       ou raison sociale différente de celle du tableau.</p>
    <div class="defilable"><table class="donnees">
      <tr><th>Forme</th><th class="num">Dossiers</th>
          <th class="num">Montant dû</th>
          <th class="num" title="Sociétés dont l'annuaire public dit qu'elles
ont cessé leur activité : radiées ou fermées. Il n'y a plus d'entreprise en
face pour payer, et engager des frais sur ces dossiers est rarement utile."
              >dont fermées</th></tr>
      ${rangees}</table></div>
    ${alerte}
    <div class="boutons" style="margin-top:16px">
      <button class="secondaire" id="majAnnuaire">
        ${ANNUAIRE_CONNU
          ? "Actualiser depuis l'annuaire" : "Interroger l'annuaire public"}</button>
    </div>
    <p class="note">Consultation automatique : à l'ouverture pour les
       débiteurs encore inconnus, et à la fin de chaque export. Le bouton ne
       sert qu'à reprendre la main si le service était injoignable.</p>
    <p class="note">Seule la raison sociale du débiteur part en requête, vers
       le service ouvert de l'État. Les fiches sont conservées sur ce poste,
       et une société déjà interrogée ne l'est pas deux fois.</p>`;

  $("majAnnuaire").addEventListener("click", interrogerAnnuaire);
}

// Les debiteurs arrives depuis la derniere consultation recoivent leur fiche
// sans qu'on la demande. Ceux deja interroges sans resultat sont memorises
// comme tels : ils ne reviennent pas ici a chaque ouverture.
async function consulterAnnuaireSiBesoin() {
  if (annuaireTente || !ANNUAIRE_MANQUANTS) return;
  annuaireTente = true;
  try {
    const r = await api("/api/annuaire", {});
    if (r.trouvees || r.sans_fiche) chargerDossiers();
  } catch { /* hors ligne : le bouton reste, il réessaiera */ }
}

async function interrogerAnnuaire() {
  const bouton = $("majAnnuaire");
  bouton.disabled = true;
  const ancien = bouton.textContent;
  bouton.textContent = "Interrogation de l'annuaire…";
  try {
    const r = await api("/api/annuaire", {});
    afficherBandeau(r.echecs === 0,
      `${r.trouvees} fiche(s) trouvée(s), ${r.sans_fiche} sans correspondance.`
      + (r.echecs ? ` ${r.echecs} échec(s) : ${r.motif}` : ""));
    chargerDossiers();
  } catch (erreur) {
    afficherBandeau(false, erreur.message);
  } finally {
    bouton.disabled = false;
    bouton.textContent = ancien;
  }
}

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
          <td class="num">${montantDu(d)}</td>
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
  majBandeauExport();
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
    // Un dossier a moitie paye n'est pas un dossier perdu, et « Recouvre » ne
    // compte que les dossiers clos : sans cette tuile, le portefeuille parait
    // plus mauvais qu'il n'est.
    ["Déjà encaissé", euro(a.montant_recu),
     `${a.nb_partiellement_regles} dossier(s) ont reçu un paiement partiel`, ""],
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
    // La part, pas seulement le nombre : cinq dossiers sur cinquante-trois
    // et cinq sur huit n'appellent pas la même décision.
    ["Possible abandon",
     a.part_abandon_possible === null ? "—" : a.part_abandon_possible + " %",
     `${a.nb_abandon_possible} dossier(s) · ${euro(a.montant_abandon_possible)} `
     + "à trancher",
     a.nb_abandon_possible ? "#c9862a" : "", a.nb_abandon_possible ? "?" : ""],
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
  rendreEntreprises();

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
  const suspens = DOSSIERS.filter((d) => est(d, "suspens"));
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
    montant_recu: DOSSIERS.reduce((t, d) => t + (d.montant_recu || 0), 0),
    nb_partiellement_regles: DOSSIERS.filter((d) => (d.montant_recu || 0) > 0).length,
    nb_abandon_possible: suspens.length,
    montant_abandon_possible: somme((d) => est(d, "suspens")),
    // Sur tout le portefeuille : un possible abandon n'est pas une issue,
    // c'est une décision qui reste à prendre sur un dossier encore ouvert.
    part_abandon_possible: DOSSIERS.length
      ? Math.round(100 * suspens.length / DOSSIERS.length) : null,
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

// Tant que cette page est ouverte, l'outil doit rester ouvert. Il se fermait
// au bout de trois minutes sans requete — or lire un tableau n'en envoie
// aucune : on lisait le tableau de bord, l'outil se fermait derriere, et le
// clic suivant echouait sans que rien n'ait ete ferme ni casse. Battre la
// mesure regle les deux : l'outil reste en vie, et une page morte le sait en
// moins d'une minute au lieu de l'apprendre au premier clic.
setInterval(async () => {
  try { await api("/api/vivant"); }
  catch (erreur) { void erreur; }
}, 45000);

function afficherBandeau(reussi, message) {
  const bandeau = $("bandeau");
  bandeau.textContent = message;
  bandeau.className = "bandeau visible " + (reussi ? "reussi" : "rate");
}
</script>
</body></html>
"""


def demarrer(port: int = 0, ouvrir: bool = True, veille: bool = False) -> ThreadingHTTPServer:
    # Une « référence » venue de la plomberie des messages entrait dans la
    # requête Gmail, et « goog_97526804 » figure dans presque tous les
    # messages Gmail : le dossier ramassait alors des conversations entières
    # sans rapport. On les retire du suivi au démarrage, et l'on retient les
    # dossiers touchés — leurs pièces ont été réunies sur un critère faux.
    # Les doublons ecrits par « Retrouver les dossiers du disque » quand il
    # prenait le nom du repertoire pour une reference : le meme dossier
    # figurait deux fois, une fois sous son numero et une fois sous son
    # repertoire. Une liste qui montre deux fois le meme dossier ne se lit
    # plus, et aucun export ne les enlevait.
    try:
        sortie = Path(lire_preferences().get("sortie") or sortie_par_defaut())
        doublons = export_mails.nettoyer_recapitulatif(sortie, print)
        if doublons:
            print(f"  {len(doublons)} doublon(s) retire(s) de la liste.")
    except OSError:
        pass

    try:
        pollues = module_suivi.purger_references_parasites(SUIVI)
    except OSError:
        pollues = []
    if pollues:
        memoriser_preferences({"dossiers_a_refaire": pollues})
        print(f"  {len(pollues)} dossier(s) constitué(s) sur une référence "
              "parasite : à refaire sans « Reprendre ».")

    serveur = ThreadingHTTPServer(("127.0.0.1", port), Gestionnaire)
    adresse = f"http://127.0.0.1:{serveur.server_address[1]}/"

    print("Interface d'export contentieux")
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
