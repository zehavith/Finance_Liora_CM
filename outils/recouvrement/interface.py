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
import os
import json
import secrets
import subprocess
import sys
import threading
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import export_mails  # noqa: E402
from gmail_api import ErreurGmail  # noqa: E402
from dossiers import ErreurDossiers  # noqa: E402
from rendu import moteur_pdf_disponible  # noqa: E402
import suivi as module_suivi  # noqa: E402

RACINE = Path(__file__).resolve().parent
PREFERENCES = RACINE / "interface-preferences.json"
# Le suivi vit à côté de l'outil, pas dans l'export : refaire un export
# ne doit pas effacer l'état d'avancement des dossiers.
SUIVI = RACINE / "suivi-dossiers.json"
# Secret au même titre que les identifiants Gmail : fichier dédié,
# jamais renvoyé à la page, jamais mêlé aux préférences.
JETON_MONDAY = RACINE / "monday-token.txt"
EXTENSIONS_ACCEPTEES = {".xlsx", ".xlsm", ".csv"}
TAILLE_MAX_FICHIER = 25 * 1024 * 1024


def sortie_par_defaut() -> Path:
    """Hors de OneDrive : l'export contient des données personnelles, et la
    synchronisation d'un dossier volumineux provoque des erreurs d'écriture."""
    if sys.platform == "win32":
        return Path.home() / "recouvrement-export"
    return Path.cwd() / "export"


def lire_preferences() -> dict:
    if PREFERENCES.exists():
        try:
            return json.loads(PREFERENCES.read_text(encoding="utf-8"))
        except (ValueError, OSError):
            return {}
    return {}


def ecrire_preferences(valeurs: dict) -> None:
    try:
        PREFERENCES.write_text(
            json.dumps(valeurs, ensure_ascii=False, indent=2), encoding="utf-8"
        )
    except OSError:
        pass


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
    if demande.get("sans_spam"):
        arguments.append("--sans-spam")
    if demande.get("reprendre"):
        arguments.append("--reprendre")
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
            preferences = lire_preferences()
            page = page.replace(
                "__ETAT_MONDAY__",
                "déjà enregistré — laissez vide pour le conserver"
                if JETON_MONDAY.exists()
                else "collez le jeton ici (facultatif)",
            )
            page = page.replace(
                "__BOITES__", preferences.get("boites", "")
            ).replace(
                "__SORTIE__", preferences.get("sortie", str(sortie_par_defaut()))
            )
            self._repondre(200, page.encode("utf-8"), "text/html; charset=utf-8")
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
        except ValueError as exc:
            self._json(400, {"erreur": str(exc)})
            return

        self._json(404, {"erreur": "Inconnu."})

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
        if demande.get("mode") == "manuel":
            try:
                depot = self._depot_manuel(demande)
            except ValueError as exc:
                self._json(400, {"erreur": str(exc)})
                return
            self._demarrer(demande, depot, "saisie manuelle")
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
        self._demarrer(demande, depot, nom)

    def _demarrer(self, demande: dict, depot: Path, origine: str) -> None:
        jeton = (demande.get("jeton_monday") or "").strip()
        if jeton:
            try:
                JETON_MONDAY.write_text(jeton, encoding="utf-8")
                os.chmod(JETON_MONDAY, 0o600)
            except OSError:
                pass

        arguments, sortie = construire_arguments(demande, depot)
        try:
            EXECUTION.lancer(arguments, sortie)
        except RuntimeError as exc:
            self._json(409, {"erreur": str(exc)})
            return

        ecrire_preferences({"boites": demande.get("boites", ""), "sortie": sortie})
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
            )
            module_suivi.enregistrer(SUIVI, donnees)
        except ValueError as exc:
            self._json(400, {"erreur": str(exc)})
            return
        except OSError as exc:
            self._json(500, {"erreur": f"Enregistrement impossible : {exc}"})
            return
        self._json(200, {"enregistre": True, "dossier": entree})

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
  <span class="moteur">Moteur PDF : __MOTEUR_PDF__</span>
</header>
<nav class="principal">
  <button class="actif" data-vue="vueExport">Export</button>
  <button data-vue="vueDocuments">Documents</button>
  <button data-vue="vueSuivi">État des dossiers</button>
  <button data-vue="vueBord">Tableau de bord</button>
</nav>
<main>

<div class="vue actif" id="vueExport">
<section>
  <h2>1. Les dossiers à traiter</h2>
  <div class="onglets">
    <button class="onglet actif" data-volet="voletFichier">Depuis un export Monday</button>
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

  <div class="volet" id="voletManuel">
    <p class="aide">Pour un dossier isolé, sans rien préparer dans Monday.
       Renseignez l'un des deux critères, ou les deux.</p>
    <div class="grille">
      <div>
        <label for="mEmail">Adresse mail</label>
        <input type="text" id="mEmail" placeholder="marie.dupont@exemple.fr" />
      </div>
      <div>
        <label for="mFacture">Numéro de facture</label>
        <input type="text" id="mFacture" placeholder="FACT-2405-00030" />
      </div>
      <div>
        <label for="mNom">Nom du dossier (facultatif)</label>
        <input type="text" id="mNom" placeholder="Marie Dupont" />
      </div>
    </div>
    <p class="note">Les deux critères se combinent par un OU : un message
       remonte s'il cite l'adresse <b>ou</b> le numéro de facture. Renseigner
       les deux élargit la recherche, il ne la restreint pas.</p>
  </div>
</section>

<section>
  <h2>2. Les boîtes à interroger</h2>
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
  </div>
  <p class="note">La destination est volontairement hors de OneDrive : l'export
     contient les données personnelles des apprenantes, et la synchronisation
     d'un dossier volumineux provoque des erreurs d'écriture en cours de route.</p>
</section>

<section>
  <h2>3. Options</h2>
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
  <label class="case"><input type="checkbox" id="sansnav" />
    <span><b>Ne pas ouvrir le navigateur pour autoriser</b><i>Si une boîte est
    connectée dans une autre fenêtre : l'adresse s'affiche, à coller vous-même.</i></span></label>
  <label class="case"><input type="checkbox" id="reprendre" />
    <span><b>Reprendre</b><i>Passe les dossiers déjà exportés. Après une
    interruption.</i></span></label>
  <div>
    <label for="seulement">Ne traiter que ces références (optionnel)</label>
    <input type="text" id="seulement" placeholder="FACT-2405-00030,FACT-2405-00142" />
  </div>
</section>

<section>
  <h2>4. Lancer</h2>
  <div class="boutons">
    <button class="principal" id="lancer" disabled>Lancer</button>
    <button class="secondaire" id="ouvrir">Ouvrir le dossier de destination</button>
  </div>
  <div id="etat"><div class="rond"></div><span id="texteEtat">Export en cours…</span></div>
  <div class="bandeau" id="bandeau"></div>
  <div id="journal" hidden></div>
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

<div class="vue" id="vueSuivi">
  <section>
    <h2>État des dossiers</h2>
    <p class="aide">L'avancement et les frais sont enregistrés au fur et à mesure,
       à côté de l'outil. Refaire un export ne les efface pas.</p>
    <div id="tableSuivi"></div>
  </section>
</div>

<div class="vue" id="vueBord">
  <div id="tuilesBord" class="tuiles"></div>
  <div class="graphe" id="grapheBord"></div>
</div>

</main>
<script>
const JETON = "__JETON__";
const $ = (id) => document.getElementById(id);
let fichierChoisi = null, position = 0, sondage = null, mode = "fichier";

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
    mode = onglet.dataset.volet === "voletManuel" ? "manuel" : "fichier";
    $("bandeau").className = "bandeau";
    majBouton();
  });
});

["mEmail", "mFacture"].forEach((id) =>
  $(id).addEventListener("input", majBouton));

function majBouton() {
  $("lancer").disabled = mode === "manuel"
    ? !($("mEmail").value.trim() || $("mFacture").value.trim())
    : !fichierChoisi;
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
  zone.classList.add("rempli");
  $("texteZone").textContent = "Fichier retenu :";
  $("nomFichier").textContent = fichier.name +
    "  (" + Math.round(fichier.size / 1024) + " Ko)";
  majBouton();
  $("bandeau").className = "bandeau";
}

// -- lancement
$("lancer").addEventListener("click", async () => {
  if (!fichierChoisi) return;
  $("lancer").disabled = true;
  $("bandeau").className = "bandeau";
  $("journal").hidden = false;
  $("journal").textContent = "";
  position = 0;

  const commun = {
      boites: $("boites").value,
      sortie: $("sortie").value,
      jeton_monday: $("jetonMonday").value,
      simulation: $("simulation").checked,
      ignorer_lignes_incompletes: $("ignorer").checked,
      sans_regroupement: !$("regrouper").checked,
      sans_navigateur: $("sansnav").checked,
      reprendre: $("reprendre").checked,
      seulement: $("seulement").value,
  };

  let charge;
  if (mode === "manuel") {
    charge = Object.assign({ mode: "manuel",
      email: $("mEmail").value, facture: $("mFacture").value,
      nom_dossier: $("mNom").value }, commun);
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
});

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
      afficherBandeau(true, $("simulation").checked
        ? "Simulation terminée. Vérifiez les volumes ci-dessus, puis décochez « Simulation » pour lancer l'export réel."
        : "Export terminé. Le bouton « Ouvrir le dossier de destination » vous y emmène.");
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
let DOSSIERS = [], STATUTS = [], AGREGATS = null;

const euro = (v) => new Intl.NumberFormat("fr-FR",
  { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(v || 0);

async function chargerDossiers() {
  let donnees;
  try { donnees = await api("/api/dossiers"); }
  catch (erreur) { afficherBandeau(false, erreur.message); return; }

  DOSSIERS = donnees.dossiers;
  STATUTS = donnees.statuts;
  AGREGATS = donnees.agregats;
  $("cheminSortie").textContent = donnees.sortie;
  rendreDocuments();
  rendreSuivi();
  rendreBord();
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
function rendreDocuments() {
  if (!DOSSIERS.length) { $("tableDocuments").innerHTML = messageVide(); return; }

  const lignes = DOSSIERS.map((d) => `
    <tr>
      <td><b>${echapper(d.reference)}</b></td>
      <td>${echapper(d.nom)}</td>
      <td class="num">${d.nb_mails}</td>
      <td class="num">${d.nb_pieces_jointes}</td>
      <td>${d.premier_mail || "—"} → ${d.dernier_mail || "—"}</td>
      <td>${d.a_synthese
        ? `<a class="lien" data-ouvrir="${echapper(d.repertoire)}/synthese.pdf">Note de synthèse</a>`
        : '<span class="lien inactif">pas de note</span>'}</td>
      <td><a class="lien" data-ouvrir="${echapper(d.repertoire)}">Ouvrir le répertoire</a></td>
    </tr>`).join("");

  $("tableDocuments").innerHTML = `<table class="donnees">
    <tr><th>Référence</th><th>Débiteur</th><th>Mails</th><th>PJ</th>
        <th>Période</th><th>Document</th><th></th></tr>${lignes}</table>`;

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
      <td><b>${echapper(d.reference)}</b><br />
          <span style="color:var(--texte-3)">${echapper(d.nom)}</span></td>
      <td class="num">${euro(d.montant_du)}</td>
      <td><select data-champ="statut">${options(d.statut)}</select></td>
      <td class="num"><input class="frais" data-champ="frais" type="text"
          value="${d.frais ? d.frais : ""}" placeholder="0" /> €</td>
      <td><input class="note" data-champ="note" type="text"
          value="${echapper(d.note)}" placeholder="Référence avocat, audience…" /></td>
      <td style="color:var(--texte-3);font-size:11px">${echapper(d.maj)}</td>
    </tr>`).join("");

  $("tableSuivi").innerHTML = `<table class="donnees">
    <tr><th>Dossier</th><th class="num">Montant dû</th><th>État</th>
        <th class="num">Frais engagés</th><th>Note</th><th>Modifié</th></tr>
    ${lignes}</table>`;

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
        rendreBord();
      } catch (erreur) { afficherBandeau(false, erreur.message); }
    });
  });
}

// -- onglet Tableau de bord
function rendreBord() {
  if (!DOSSIERS.length) {
    $("tuilesBord").innerHTML = "";
    $("grapheBord").innerHTML = messageVide();
    return;
  }
  const a = AGREGATS = recalculer();

  const tuiles = [
    ["Dossiers suivis", a.nb_dossiers, `dont ${a.nb_en_cours} en cours`, ""],
    ["Montant en recouvrement", euro(a.montant_en_cours), "dossiers non clôturés", ""],
    ["Frais engagés", euro(a.frais_engages), "avocat, huissier, greffe", ""],
    ["Recouvré", euro(a.montant_gagne), `${a.nb_gagnes} dossier(s) gagné(s)`, "#0ca30c", "✓"],
    ["Perdu", euro(a.montant_perdu), `${a.nb_perdus} dossier(s) perdu(s)`, "#d03b3b", "✕"],
    ["Taux de réussite", a.taux_reussite === null ? "—" : a.taux_reussite + " %",
     "sur les dossiers clôturés", ""],
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

  $("grapheBord").innerHTML = `
    <h3>Montant en recouvrement par étape</h3>
    <p class="aide">La longueur des barres représente le montant dû ; le nombre de
       dossiers est indiqué à côté. Les quatre étapes en cours partagent une même
       teinte, de la plus soutenue à la plus claire ; les deux issues portent une
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
  const clos = ["gagne", "perdu"];
  const somme = (f) => DOSSIERS.filter(f).reduce((t, d) => t + d.montant_du, 0);
  const gagnes = DOSSIERS.filter((d) => d.statut === "gagne");
  const perdus = DOSSIERS.filter((d) => d.statut === "perdu");
  return {
    par_statut: par, nb_dossiers: DOSSIERS.length,
    nb_en_cours: DOSSIERS.filter((d) => !clos.includes(d.statut)).length,
    montant_en_cours: somme((d) => !clos.includes(d.statut)),
    frais_engages: DOSSIERS.reduce((t, d) => t + (d.frais || 0), 0),
    montant_gagne: somme((d) => d.statut === "gagne"),
    montant_perdu: somme((d) => d.statut === "perdu"),
    nb_gagnes: gagnes.length, nb_perdus: perdus.length,
    taux_reussite: (gagnes.length + perdus.length)
      ? Math.round(100 * gagnes.length / (gagnes.length + perdus.length)) : null,
  };
}

function echapper(texte) {
  const div = document.createElement("div");
  div.textContent = texte == null ? "" : String(texte);
  return div.innerHTML;
}

function afficherBandeau(reussi, message) {
  const bandeau = $("bandeau");
  bandeau.textContent = message;
  bandeau.className = "bandeau visible " + (reussi ? "reussi" : "rate");
}
</script>
</body></html>
"""


def demarrer(port: int = 0, ouvrir: bool = True) -> ThreadingHTTPServer:
    serveur = ThreadingHTTPServer(("127.0.0.1", port), Gestionnaire)
    adresse = f"http://127.0.0.1:{serveur.server_address[1]}/"

    print("Interface d'export recouvrement")
    print(f"  {adresse}")
    print("  Laissez cette fenêtre ouverte pendant l'utilisation.")
    print("  Ctrl+C pour arrêter.\n")

    if ouvrir:
        threading.Timer(0.4, lambda: webbrowser.open(adresse)).start()
    return serveur


def main() -> int:
    serveur = demarrer()
    try:
        serveur.serve_forever()
    except KeyboardInterrupt:
        print("\nInterface arrêtée.")
    finally:
        serveur.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
