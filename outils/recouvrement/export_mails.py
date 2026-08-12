#!/usr/bin/env python3
"""Export des mails d'un lot de dossiers de recouvrement depuis Gmail.

Pour chaque apprenante listée dans le fichier des dossiers, le script
recherche dans la boîte tous les messages liés à son adresse mail et/ou à
son numéro de facture, puis constitue un répertoire prêt à transmettre :

    export/
      2024-118_marie-dupont/
        index.csv                    chronologie des échanges
        mails/                       un .eml + un .pdf par message
        pieces-jointes/              pièces jointes extraites, par message
      _recapitulatif.csv             une ligne par dossier
      LISEZ-MOI.txt                  méthode d'extraction
      journal.log

Usage :
    python export_mails.py --dossiers dossiers.csv --sortie ./export
    python export_mails.py --dossiers dossiers.csv --simulation

Voir README.md pour la mise en place de l'accès Gmail.
"""

from __future__ import annotations

import argparse
import sys
from collections.abc import Callable
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from dossiers import Dossier, ErreurDossiers, lire_dossiers  # noqa: E402
import synthese as module_synthese  # noqa: E402
from gmail_api import ErreurGmail, SourcesGmail, ouvrir_sources  # noqa: E402
from indexation import (  # noqa: E402
    LigneIndex,
    ResumeDossier,
    ecrire_index_dossier,
    ecrire_recapitulatif,
)
from message import (  # noqa: E402
    FUSEAU_PAR_DEFAUT,
    MessageMail,
    definir_fuseau,
    maintenant,
)
from rendu import (  # noqa: E402
    chemin_relatif,
    construire_html_message,
    ecrire_eml,
    ecrire_pdf,
    ecrire_pieces_jointes,
    moteur_pdf_disponible,
    nom_de_base,
    verifier_environnement,
)

RACINE = Path(__file__).resolve().parent

# Au-delà, il ne s'agit probablement plus d'un lot contentieux mais de
# l'historique complet d'un tableau Monday exporté sans filtre.
SEUIL_VOLUME_INHABITUEL = 200


class Journal:
    """Sortie console + fichier, pour garder une trace de l'extraction.

    `relais` permet à un appelant — l'interface graphique — de recevoir les
    mêmes lignes au fil de l'eau, sans détourner la sortie standard.
    """

    def __init__(self, chemin: Path | None, relais: Callable[[str], None] | None = None):
        self._fichier = None
        self._relais = relais
        if chemin is not None:
            chemin.parent.mkdir(parents=True, exist_ok=True)
            self._fichier = chemin.open("a", encoding="utf-8")

    def __call__(self, message: str = "") -> None:
        print(message, flush=True)
        if self._relais is not None:
            self._relais(message)
        if self._fichier:
            horodatage = datetime.now().strftime("%H:%M:%S")
            self._fichier.write(f"{horodatage} {message}\n")
            self._fichier.flush()

    def fermer(self) -> None:
        if self._fichier:
            self._fichier.close()


def analyser_arguments(argv: list[str] | None = None) -> argparse.Namespace:
    analyseur = argparse.ArgumentParser(
        description="Export Gmail des dossiers de recouvrement (lecture seule).",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    analyseur.add_argument(
        "--dossiers",
        type=Path,
        default=RACINE / "dossiers.csv",
        help="Fichier CSV listant les dossiers (défaut : dossiers.csv).",
    )
    analyseur.add_argument(
        "--sortie",
        type=Path,
        default=Path("./export"),
        help="Répertoire de destination (défaut : ./export).",
    )
    analyseur.add_argument(
        "--credentials",
        type=Path,
        default=RACINE / "credentials.json",
        help="Identifiants OAuth « application de bureau » (défaut : credentials.json).",
    )
    analyseur.add_argument(
        "--token",
        type=Path,
        default=RACINE / "token.json",
        help="Jeton d'accès mémorisé après la première autorisation.",
    )
    analyseur.add_argument(
        "--compte-service",
        type=Path,
        default=None,
        help="Clé JSON d'un compte de service (pour lire une boîte partagée).",
    )
    analyseur.add_argument(
        "--boites",
        default=None,
        help=(
            "Adresses des boîtes à lire, séparées par des virgules "
            "(ex. billing@liora.io,recouvrement@liora.io). Les échanges présents "
            "dans plusieurs boîtes ne sont retenus qu'une fois. Sans cette "
            "option, la boîte du compte autorisé est utilisée."
        ),
    )
    analyseur.add_argument(
        "--sans-navigateur",
        action="store_true",
        help=(
            "N'ouvre pas le navigateur automatiquement : affiche l'adresse à "
            "coller vous-même. À utiliser quand la boîte visée est connectée "
            "dans une autre fenêtre ou un autre profil du navigateur."
        ),
    )
    analyseur.add_argument(
        "--sans-synthese",
        action="store_true",
        help="N'écrit pas la note de synthèse PDF de chaque dossier.",
    )
    analyseur.add_argument(
        "--simulation",
        action="store_true",
        help="Compte les messages trouvés par dossier sans rien télécharger.",
    )
    analyseur.add_argument(
        "--reprendre",
        action="store_true",
        help="Passe les dossiers déjà exportés (index.csv présent).",
    )
    analyseur.add_argument(
        "--seulement",
        default=None,
        help="Ne traiter que ces références, séparées par des virgules.",
    )
    analyseur.add_argument(
        "--max-mails",
        type=int,
        default=500,
        help="Plafond de messages par dossier (défaut : 500).",
    )
    analyseur.add_argument(
        "--sans-spam",
        action="store_true",
        help="Exclut spam et corbeille (inclus par défaut).",
    )
    analyseur.add_argument(
        "--ignorer-lignes-incompletes",
        action="store_true",
        help=(
            "Passe les lignes sans adresse ni facture au lieu de s'arrêter "
            "(lignes de groupe des exports Monday). Les lignes écartées sont "
            "listées à l'écran."
        ),
    )
    analyseur.add_argument(
        "--fuseau",
        default=FUSEAU_PAR_DEFAUT,
        help=(
            "Fuseau horaire d'affichage des dates, identique pour tous les "
            f"messages (défaut : {FUSEAU_PAR_DEFAUT})."
        ),
    )
    return analyseur.parse_args(argv)


def _sens_du_message(message: MessageMail, domaines: set[str]) -> str:
    """« envoyé » dès lors que l'expéditeur appartient au domaine des boîtes
    interrogées : un courrier parti de billing@ ou du compte d'un collègue
    reste un courrier émis par Liora, pas une réponse de l'apprenante."""
    expediteur = (message.expediteur or "").lower()
    if any(f"@{domaine}" in expediteur for domaine in domaines):
        return "envoyé"
    return "reçu"


def traiter_dossier(
    dossier: Dossier,
    sources: SourcesGmail,
    racine_sortie: Path,
    options: argparse.Namespace,
    journal: Journal,
) -> ResumeDossier:
    requete = dossier.requete_gmail()
    resume = ResumeDossier(
        reference=dossier.reference,
        nom=dossier.nom,
        emails=" | ".join(dossier.emails),
        factures=" | ".join(dossier.factures),
        requete=requete,
        repertoire=dossier.nom_repertoire,
    )

    repertoire = racine_sortie / dossier.nom_repertoire
    chemin_index = repertoire / "index.csv"

    if options.reprendre and chemin_index.exists():
        journal("    déjà exporté, ignoré (--reprendre)")
        resume.statut = "ignoré (déjà exporté)"
        return resume

    identifiants = sources.identifiants_dossier(
        requete,
        inclure_spam_corbeille=not options.sans_spam,
        plafond=options.max_mails,
    )
    resume.nb_mails = len(identifiants)

    if len(identifiants) >= options.max_mails:
        journal(
            f"    ⚠ plafond de {options.max_mails} messages atteint : "
            "le dossier est probablement incomplet (relancer avec --max-mails plus élevé)"
        )
        resume.statut = f"tronqué au plafond de {options.max_mails}"

    if options.simulation:
        # Le dédoublonnage suppose de télécharger les messages : en simulation,
        # le compte annoncé est un majorant quand plusieurs boîtes répondent.
        nuance = " avant dédoublonnage" if len(sources.clients) > 1 else ""
        journal(
            f"    {len(identifiants)} message(s) trouvé(s){nuance}"
            " — simulation, rien n'est écrit"
        )
        if resume.statut == "ok":
            resume.statut = "simulation"
        return resume

    if not identifiants:
        journal("    aucun message trouvé")
        repertoire.mkdir(parents=True, exist_ok=True)
        ecrire_index_dossier(chemin_index, [])
        resume.statut = "aucun message"
        return resume

    dossier_mails = repertoire / "mails"
    dossier_pj = repertoire / "pieces-jointes"
    date_export = maintenant()
    adresses_sources = ", ".join(sources.adresses)

    messages, doublons = sources.messages(identifiants)
    resume.nb_mails = len(messages)
    resume.doublons_ecartes = doublons

    textes_par_piece: dict[int, str] = {}
    lignes: list[LigneIndex] = []
    for numero, message in enumerate(messages, start=1):
        base = nom_de_base(message, numero)

        chemin_eml = ecrire_eml(message, dossier_mails, base)

        contenu_html = construire_html_message(
            message,
            numero,
            dossier.reference or dossier.nom,
            " / ".join(message.boites) or adresses_sources,
            date_export,
        )
        chemin_pdf = dossier_mails / f"{base}.pdf"
        pdf_ok, _moteur = ecrire_pdf(contenu_html, chemin_pdf)
        if not pdf_ok:
            resume.pdf_en_echec += 1

        pieces_ecrites = ecrire_pieces_jointes(message, dossier_pj, base)
        resume.nb_pieces_jointes += len(pieces_ecrites)

        sens = _sens_du_message(message, sources.domaines)
        if sens == "envoyé":
            resume.nb_envoyes += 1
        else:
            resume.nb_recus += 1
        resume.dates.append(message.date)
        textes_par_piece[numero] = message.corps_texte or message.corps_html or ""

        lignes.append(
            LigneIndex(
                piece_n=numero,
                date=message.date,
                sens=sens,
                expediteur=message.expediteur,
                destinataires=message.destinataires,
                copie=message.copie,
                objet=message.objet,
                nb_pieces_jointes=len(message.pieces_jointes),
                pieces_jointes=" | ".join(pj.nom for pj in message.pieces_jointes),
                critere=dossier.criteres_trouves(message.texte_recherchable),
                boites=" | ".join(message.boites),
                fichier_pdf=chemin_relatif(
                    chemin_pdf if pdf_ok else chemin_pdf.with_suffix(".html"), repertoire
                ),
                fichier_eml=chemin_relatif(chemin_eml, repertoire),
                dossier_pieces_jointes=(
                    chemin_relatif(dossier_pj / base, repertoire) if pieces_ecrites else ""
                ),
                thread_id=message.thread_id,
                message_id=message.message_id,
            )
        )

    ecrire_index_dossier(chemin_index, lignes)

    analyse = module_synthese.analyser(lignes, textes_par_piece, doublons)
    _reporter_synthese(resume, analyse, date_export)

    if not options.sans_synthese:
        contenu = module_synthese.construire_html(
            reference=dossier.reference,
            nom=dossier.nom,
            emails=" | ".join(dossier.emails),
            factures=" | ".join(dossier.factures),
            boites=sources.adresses,
            lignes=lignes,
            synthese=analyse,
            date_export=date_export,
        )
        if not ecrire_pdf(contenu, repertoire / "synthese.pdf")[0]:
            resume.pdf_en_echec += 1

    detail = (
        f"    {resume.nb_mails} message(s) — {resume.nb_recus} reçu(s), "
        f"{resume.nb_envoyes} envoyé(s), {resume.nb_pieces_jointes} pièce(s) jointe(s)"
    )
    if doublons:
        detail += f", {doublons} doublon(s) inter-boîtes écarté(s)"
    if resume.pdf_en_echec:
        detail += f" — ⚠ {resume.pdf_en_echec} PDF non généré(s), HTML conservé"
    journal(detail)

    return resume


def _reporter_synthese(
    resume: ResumeDossier, analyse: module_synthese.Synthese, reference_temps: datetime
) -> None:
    """Recopie dans le récapitulatif global les faits qui permettent d'arbitrer
    entre 40 dossiers sans ouvrir chaque note."""
    demeure = analyse.dernier_evenement("Mise en demeure")
    resume.mise_en_demeure = f"{demeure.date:%d/%m/%Y}" if demeure else "non"

    contestation = analyse.premier_evenement("Contestation")
    resume.contestation = f"{contestation.date:%d/%m/%Y}" if contestation else "non"

    echeancier = analyse.premier_evenement("Échéancier évoqué")
    resume.echeancier = f"{echeancier.date:%d/%m/%Y}" if echeancier else "non"

    if analyse.derniere_reponse is not None:
        resume.derniere_reponse = f"{analyse.derniere_reponse:%d/%m/%Y}"
    else:
        resume.derniere_reponse = "aucune"

    silence = analyse.jours_depuis(analyse.dernier, reference_temps)
    resume.jours_sans_echange = "" if silence is None else str(silence)


def ecrire_note_methode(
    chemin: Path,
    adresse_boite: str,
    nb_dossiers: int,
    options: argparse.Namespace,
    fuseau: str,
) -> None:
    perimetre = "hors spam et corbeille" if options.sans_spam else "y compris spam et corbeille"
    chemin.write_text(
        f"""EXPORT DE MESSAGERIE — SERVICE RECOUVREMENT
============================================

Date de l'export : {datetime.now().strftime('%d/%m/%Y à %H:%M')}
Boîte(s) source  : {adresse_boite}
Dossiers traités : {nb_dossiers}
Périmètre        : {perimetre}
Heures indiquées : {fuseau}

CONTENU D'UN RÉPERTOIRE DE DOSSIER
----------------------------------
synthese.pdf      Note de synthèse : chiffres clés, constats, événements
                  repérés et chronologie. Établie automatiquement à partir
                  des seuls messages extraits ; chaque constat renvoie à un
                  numéro de pièce. À relire avant transmission.
index.csv         Chronologie des échanges : une ligne par message, numérotée
                  (pièce n° 1, 2, 3...) dans l'ordre chronologique. La colonne
                  « boites » indique de quelle boîte provient chaque message.
mails/            Pour chaque message, deux fichiers de même nom :
                    .eml  message d'origine complet, en-têtes techniques
                          inclus (horodatage serveur, chemin de remise).
                          C'est cette version qui fait foi.
                    .pdf  version lisible et imprimable du même message.
pieces-jointes/   Un sous-répertoire par message, contenant ses pièces
                  jointes telles que reçues (factures, conventions, etc.).

MÉTHODE DE RECHERCHE
--------------------
Chaque dossier est constitué à partir de deux critères, combinés par un OU :
  - l'adresse mail de l'apprenante, cherchée dans les en-têtes
    (expéditeur, destinataire, copie, copie cachée) et dans le corps ;
  - le numéro de facture, cherché dans l'objet, dans le corps et dans les
    noms de pièces jointes.
La colonne « critere » de index.csv indique, pour chaque message, lequel des
deux critères l'a fait remonter.
La requête exacte utilisée pour chaque dossier figure dans _recapitulatif.csv.

LIMITE CONNUE
-------------
Le contenu textuel des pièces jointes PDF n'est pas indexé par Gmail : un
message dont le numéro de facture n'apparaît QUE dans le PDF joint, et nulle
part dans le texte du message ni dans le nom du fichier, ne remonte pas via
le critère « facture ». Il remonte en revanche via l'adresse mail dès lors
que l'apprenante est en expéditeur, destinataire ou copie.

Les images distantes des messages n'ont volontairement pas été téléchargées
lors de la génération des PDF ; elles apparaissent en tant que mention
« non téléchargée ». Les images intégrées au message sont, elles, présentes.
""",
        encoding="utf-8",
    )


def executer(
    options: argparse.Namespace, relais: Callable[[str], None] | None = None
) -> int:
    verifier_environnement()
    fuseau_applique = definir_fuseau(options.fuseau)

    racine_sortie = options.sortie
    journal = Journal(
        None if options.simulation else racine_sortie / "journal.log", relais=relais
    )

    try:
        liste = lire_dossiers(
            options.dossiers,
            ignorer_lignes_incompletes=options.ignorer_lignes_incompletes,
            signaler=journal,
        )

        if options.seulement:
            voulues = {ref.strip().lower() for ref in options.seulement.split(",") if ref.strip()}
            liste = [d for d in liste if d.reference.lower() in voulues]
            if not liste:
                journal(f"Aucun dossier ne correspond à --seulement {options.seulement}")
                return 1

        journal(f"{len(liste)} dossier(s) à traiter depuis {options.dossiers}")

        if len(liste) > SEUIL_VOLUME_INHABITUEL:
            journal(
                f"⚠ {len(liste)} dossiers, c'est beaucoup pour un lot contentieux. "
                "Un tableau Monday exporté en entier contient tout l'historique, "
                "pas seulement les dossiers à transmettre. Filtrez le tableau "
                "avant l'export, ou restreignez avec --seulement."
            )

        sans_adresse = [dossier for dossier in liste if not dossier.emails]
        if sans_adresse:
            journal(
                f"⚠ {len(sans_adresse)} dossier(s) sans adresse mail : recherchés "
                "sur le seul numéro de facture. Rappel : Gmail n'indexe pas le "
                "texte des PDF joints, un numéro qui n'apparaît que dans la pièce "
                "jointe ne remontera pas."
            )

        boites = [
            adresse.strip()
            for adresse in (options.boites or "").split(",")
            if adresse.strip()
        ]
        sources = ouvrir_sources(
            boites=boites,
            fichier_credentials=options.credentials,
            fichier_token=options.token,
            fichier_compte_service=options.compte_service,
            signaler=journal,
            ouvrir_navigateur=not options.sans_navigateur,
        )
        adresse_boite = ", ".join(sources.adresses)
        journal(f"Boîte(s) interrogée(s) : {adresse_boite}")

        if not options.simulation:
            journal(f"Moteur PDF : {moteur_pdf_disponible()}")
            journal(f"Dates affichées en : {fuseau_applique}")
        journal("")

        resumes: list[ResumeDossier] = []
        echecs = 0

        for position, dossier in enumerate(liste, start=1):
            etiquette = dossier.nom or (dossier.emails[0] if dossier.emails else "")
            journal(f"[{position}/{len(liste)}] {dossier.reference} — {etiquette}")
            try:
                resumes.append(
                    traiter_dossier(dossier, sources, racine_sortie, options, journal)
                )
            except (ErreurGmail, OSError) as exc:
                echecs += 1
                journal(f"    ✗ échec : {exc}")
                resumes.append(
                    ResumeDossier(
                        reference=dossier.reference,
                        nom=dossier.nom,
                        emails=" | ".join(dossier.emails),
                        factures=" | ".join(dossier.factures),
                        requete=dossier.requete_gmail(),
                        repertoire=dossier.nom_repertoire,
                        statut=f"échec : {exc}",
                    )
                )

        journal("")
        if not options.simulation:
            ecrire_recapitulatif(racine_sortie / "_recapitulatif.csv", resumes)
            ecrire_note_methode(
                racine_sortie / "LISEZ-MOI.txt",
                adresse_boite,
                len(liste),
                options,
                fuseau_applique,
            )

        total_mails = sum(r.nb_mails for r in resumes)
        total_pj = sum(r.nb_pieces_jointes for r in resumes)
        vides = [r.reference for r in resumes if r.statut == "aucun message"]
        pdf_rates = sum(r.pdf_en_echec for r in resumes)

        journal(f"Terminé : {total_mails} message(s), {total_pj} pièce(s) jointe(s).")
        if vides:
            journal(f"⚠ Dossiers sans aucun message : {', '.join(vides)}")
        if pdf_rates:
            journal(
                f"⚠ {pdf_rates} PDF non généré(s) — page HTML conservée à la place. "
                "Installez Chrome/Edge ou xhtml2pdf, puis relancez avec --reprendre."
            )
        if echecs:
            journal(f"⚠ {echecs} dossier(s) en échec — voir _recapitulatif.csv.")
        if not options.simulation:
            journal(f"Résultat dans : {racine_sortie.resolve()}")

        return 1 if echecs else 0

    except (ErreurDossiers, ErreurGmail) as exc:
        journal(f"Erreur : {exc}")
        return 2
    except KeyboardInterrupt:
        journal("Interrompu. Relancez avec --reprendre pour continuer où vous en étiez.")
        return 130
    finally:
        journal.fermer()


def main() -> int:
    return executer(analyser_arguments())


if __name__ == "__main__":
    raise SystemExit(main())
