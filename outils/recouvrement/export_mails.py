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
import shutil
import sys
from collections.abc import Callable
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from dossiers import (  # noqa: E402
    SEPARATEURS_MULTIVALEUR,
    Dossier,
    ErreurDossiers,
    dossiers_depuis_grille,
    filtrer_par_colonne,
    lire_dossiers,
    regrouper_par_debiteur,
    rendre_repertoires_uniques,
)
import monday as module_monday  # noqa: E402
from decouverte import adresses_candidates  # noqa: E402
import facture_pdf as module_facture  # noqa: E402
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
    fuseau_actuel,
    lire_message,
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
        "--mettre-a-jour",
        action="store_true",
        help=(
            "Complète les dossiers déjà exportés au lieu de les refaire : les "
            "messages déjà présents sont reconnus à leur Message-ID et "
            "conservés tels quels, seuls les nouveaux sont ajoutés à la suite. "
            "Les numéros de pièce déjà attribués ne changent pas."
        ),
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
        "--jeton-monday",
        type=Path,
        default=RACINE / "monday-token.txt",
        help=(
            "Fichier contenant le jeton d'accès Monday, pour télécharger les "
            "factures et conventions référencées dans le tableau. Sans lui, "
            "les documents sont seulement cités en lien dans la note."
        ),
    )
    analyseur.add_argument(
        "--tableau-monday",
        default=None,
        help=(
            "Identifiants des tableaux Monday à lire directement, séparés par "
            "des virgules, au lieu d'un fichier déposé. Les lignes de tous les "
            "tableaux sont réunies en un seul lot. Demande le jeton Monday."
        ),
    )
    analyseur.add_argument(
        "--groupes-monday",
        default="",
        help=(
            "Mots cherchés dans l'intitulé des groupes Monday, séparés par des "
            "virgules. Les éléments de tout groupe correspondant sont traités, "
            "quelle que soit leur colonne d'étape : une facture est souvent "
            "qualifiée en la glissant dans le groupe « Service contentieux »."
        ),
    )
    analyseur.add_argument(
        "--avec-sous-elements",
        action="store_true",
        help=(
            "Traiter aussi les sous-éléments des tableaux Monday, chacun comme "
            "une ligne à part. Un sous-élément hérite des colonnes de son "
            "parent partout où il n'en porte pas : utile quand une facture est "
            "un sous-élément de l'apprenante."
        ),
    )
    analyseur.add_argument(
        "--colonne-etapes",
        default="",
        help=(
            "Colonne dont l'historique des changements est relevé dans Monday, "
            "pour dater le passage au contentieux et la clôture. Par défaut, "
            "celle de --filtre-colonne."
        ),
    )
    analyseur.add_argument(
        "--filtre-colonne",
        default="",
        help=(
            "Intitulé d'une colonne du tableau sur laquelle filtrer les lignes "
            "(ex. « Etape process recouvrement »)."
        ),
    )
    analyseur.add_argument(
        "--filtre-valeur",
        default="",
        help=(
            "Valeur attendue dans cette colonne ; plusieurs valeurs séparées "
            "par des virgules. La comparaison ignore accents et casse, et se "
            "fait par inclusion : « contentieux » retient « 🔴 Dossier à faire "
            "passer en contentieux »."
        ),
    )
    analyseur.add_argument(
        "--regle-echeance",
        default="auto",
        choices=("auto", *module_facture.REGLES),
        help=(
            "Règle de calcul de l'échéance, la même pour tout le lot. "
            "« auto » la déduit du nom du tableau. Règles : "
            + " ; ".join(
                f"{cle} = {regle['libelle']} ({regle['pour']})"
                for cle, regle in module_facture.REGLES.items()
            )
        ),
    )
    analyseur.add_argument(
        "--regles-echeance",
        default="",
        help=(
            "Règle par tableau, séparées par des virgules : "
            "« 101=facture30,202=debut-formation ». Prime sur --regle-echeance."
        ),
    )
    analyseur.add_argument(
        "--delai-paiement",
        type=int,
        default=None,
        help=(
            "Force le délai en jours, quelle que soit la règle retenue. Sans "
            "cette option, chaque règle applique le sien."
        ),
    )
    analyseur.add_argument(
        "--sans-echeance-facture",
        action="store_true",
        help=(
            "Ne cherche pas l'échéance dans la facture PDF quand le tableau ne "
            "la renseigne pas."
        ),
    )
    analyseur.add_argument(
        "--sans-regroupement",
        action="store_true",
        help=(
            "Traite chaque facture comme un dossier distinct. Par défaut, les "
            "factures partageant une adresse mail sont réunies en un dossier "
            "unique — sans quoi elles produisent des répertoires identiques."
        ),
    )
    analyseur.add_argument(
        "--sans-sous-dossiers",
        action="store_true",
        help=(
            "N'ouvre pas un sous-dossier par facture. Par défaut, un débiteur "
            "portant plusieurs factures en retard donne un dossier qui mène à "
            "un sous-dossier complet par facture, dans « factures/ »."
        ),
    )
    analyseur.add_argument(
        "--sans-decouverte-adresses",
        dest="decouvrir_adresses",
        action="store_false",
        default=True,
        help=(
            "Désactive la recherche des adresses depuis le numéro de facture. "
            "Par défaut, les adresses du débiteur relevées dans les messages "
            "citant le numéro servent à relancer la recherche : l'adresse "
            "manque souvent au tableau, et la chercher n'est pas facultatif. "
            "Les adresses internes et les robots sont écartés, ainsi que toute "
            "adresse ramenant plus de --max-mails messages. Chaque adresse "
            "retenue est annoncée."
        ),
    )
    analyseur.add_argument(
        "--max-adresses-decouvertes",
        type=int,
        default=5,
        help="Nombre d'adresses sondées par dossier (défaut : 5).",
    )
    analyseur.add_argument(
        "--domaines-internes",
        default="",
        help=(
            "Domaines à ne jamais retenir comme adresse de débiteur, séparés "
            "par des virgules. Ceux des boîtes interrogées le sont déjà."
        ),
    )
    analyseur.add_argument(
        "--sous-dossiers-par-adresse",
        action="store_true",
        help=(
            "Ouvre en plus un sous-dossier par adresse mail, dans « adresses/ », "
            "quand les échanges d'un débiteur passent par plusieurs adresses."
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


def domaines_maison(sources: SourcesGmail, options: argparse.Namespace) -> set[str]:
    """Les domaines qui sont les nôtres : boîtes interrogées et domaines déclarés.

    Les boîtes seules ne suffisent pas. Une relance envoyée sous une ancienne
    marque — datascientest.com pour Liora — part d'un autre domaine, et serait
    comptée comme un message *reçu* : le dossier conclurait alors à l'absence
    de toute relance, et prendrait nos propres courriers pour des réponses du
    débiteur.
    """
    return set(sources.domaines) | {
        domaine.strip().lower().lstrip("@")
        for domaine in (options.domaines_internes or "").split(",")
        if domaine.strip()
    }


def _sens_du_message(message: MessageMail, domaines: set[str]) -> str:
    """« envoyé » dès lors que l'expéditeur appartient à l'un de nos domaines :
    un courrier parti de billing@ ou du compte d'un collègue reste un courrier
    émis par Liora, pas une réponse de l'apprenante."""
    expediteur = (message.expediteur or "").lower()
    if any(f"@{domaine}" in expediteur for domaine in domaines):
        return "envoyé"
    return "reçu"


# Reconnue mais vide sur toutes les lignes : l'intitule a ete trouve, la
# valeur non. C'est le symptome d'une colonne miroir ou d'une formule, dont
# l'API ne rend rien sans qu'on le lui demande — et il n'y a aucune raison de
# le decouvrir dossier par dossier, une heure plus tard.
CHAMPS_SURVEILLES = (
    ("nom", "nom du debiteur"),
    ("emails", "adresse mail"),
    ("montant_du", "montant du"),
)


def _signaler_colonnes_vides(lignes: list[Dossier], journal: Journal) -> None:
    if not lignes:
        return

    muettes = [
        libelle for champ, libelle in CHAMPS_SURVEILLES
        if not any(getattr(dossier, champ, None) for dossier in lignes)
    ]
    if muettes:
        journal(
            f"    ⚠ colonne(s) reconnue(s) mais vide(s) sur les "
            f"{len(lignes)} lignes : {', '.join(muettes)}. Colonne miroir ou "
            "formule côté Monday, ou colonne réellement vide."
        )


def traiter_dossier(
    dossier: Dossier,
    sources: SourcesGmail,
    racine_sortie: Path,
    options: argparse.Namespace,
    journal: Journal,
) -> ResumeDossier:
    requete = dossier.requete_gmail()
    # Tronquée : depuis qu'elle essaie toutes les écritures du numéro, elle
    # fait deux mille caractères et noie le reste du journal. Elle figure en
    # entier au récapitulatif, colonne « requete_gmail ».
    apercu = requete if len(requete) <= 220 else requete[:217] + "…"
    journal(f"    requête : {apercu}")
    resume = ResumeDossier(
        reference=dossier.reference,
        nom=dossier.nom,
        emails=" | ".join(dossier.emails),
        factures=" | ".join(dossier.factures),
        requete=requete,
        repertoire=dossier.nom_repertoire,
        montant_du=dossier.montant_du,
        montant_total=dossier.montant_total,
        date_echeance=dossier.date_echeance,
        convention_signee=dossier.convention_signee,
        diplome=dossier.diplome,
        heures_theoriques=dossier.heures_theoriques,
        heures_log=dossier.heures_log,
    )

    trajet = module_synthese.parcours(dossier)
    if trajet["contentieux"]:
        resume.date_contentieux = f"{trajet['contentieux']:%d/%m/%Y}"
    if trajet["cloture"]:
        resume.date_cloture = f"{trajet['cloture']:%d/%m/%Y}"
        resume.issue_process = trajet["issue"].split("— ")[-1]
    if trajet["duree_jours"] is not None:
        resume.jours_de_procedure = str(trajet["duree_jours"])

    repertoire = racine_sortie / dossier.nom_repertoire
    chemin_index = repertoire / "index.csv"

    if options.reprendre and chemin_index.exists():
        journal("    déjà exporté, ignoré (--reprendre)")
        resume.statut = "ignoré (déjà exporté)"
        return resume

    # Mise à jour : le dossier existant est relu, jamais refait. Ce qui y
    # figure garde son numéro de pièce et ses fichiers ; seuls les messages
    # inconnus sont ajoutés à la suite.
    existantes: list[LigneIndex] = []
    textes_existants: dict[int, str] = {}
    bases_existantes: dict[int, str] = {}
    cles_existantes: set[str] = set()
    if options.mettre_a_jour and chemin_index.exists():
        try:
            existantes, textes_existants, bases_existantes, cles_existantes = (
                relire_dossier(repertoire, chemin_index)
            )
        except OSError as exc:
            journal(f"    ⚠ index existant illisible ({exc}) — dossier refait")

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
        if existantes:
            # Recherche muette sur un dossier déjà constitué : la boîte a pu
            # être purgée, ou la requête modifiée. Réécrire un index vide
            # effacerait un dossier complet — on n'y touche pas.
            journal(
                f"    aucun message trouvé, mais {len(existantes)} pièce(s) "
                "déjà au dossier : il est conservé tel quel"
            )
            _reporter_pieces(resume, existantes)
            resume.statut = "à jour"
            return resume
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

    if options.decouvrir_adresses and dossier.factures:
        trouvees, supplementaires = _decouvrir_adresses(
            dossier, messages, sources, options, journal
        )
        if trouvees:
            deja_vus = {(id(client), cle) for client, cle in identifiants}
            neufs = [
                paire
                for paire in supplementaires
                if (id(paire[0]), paire[1]) not in deja_vus
            ]
            nouveaux, _ = sources.messages(neufs)
            messages, doubles_entre_passes = _fusionner_messages(messages, nouveaux)
            doublons += doubles_entre_passes

            # Les adresses découvertes deviennent des adresses du dossier :
            # elles doivent apparaître dans la note, dans l'index et, si la
            # vue par adresse est demandée, y ouvrir leur sous-dossier.
            dossier.emails += trouvees
            resume.emails = " | ".join(dossier.emails)
            resume.adresses_decouvertes = " | ".join(trouvees)
            resume.requete = dossier.requete_gmail()

    resume.doublons_ecartes = doublons

    if cles_existantes:
        inconnus = [
            message
            for message in messages
            if message.cle_dedoublonnage not in cles_existantes
        ]
        deja = len(messages) - len(inconnus)
        if not inconnus:
            journal(
                f"    à jour — {len(existantes)} pièce(s) au dossier, "
                "aucun message nouveau"
            )
            _reporter_pieces(resume, existantes)
            resume.statut = "à jour"
            return resume
        journal(
            f"    {len(inconnus)} message(s) nouveau(x) ajouté(s) — "
            f"{deja} déjà au dossier, conservé(s) tel(s) quel(s)"
        )
        messages = inconnus

    # Les nouvelles pièces prennent la suite : renuméroter l'existant
    # invaliderait les « pièce n° 7 » déjà cités dans une note transmise.
    depart = max((ligne.piece_n for ligne in existantes), default=0) + 1

    textes_par_piece: dict[int, str] = dict(textes_existants)
    bases_par_piece: dict[int, str] = dict(bases_existantes)
    lignes: list[LigneIndex] = []
    for numero, message in enumerate(messages, start=depart):
        base = nom_de_base(message, numero)
        bases_par_piece[numero] = base

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

        sens = _sens_du_message(message, domaines_maison(sources, options))
        textes_par_piece[numero] = message.corps_texte or message.corps_html or ""

        recherchable = message.texte_recherchable
        parties = message.parties
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
                critere=dossier.criteres_trouves(recherchable),
                factures_concernees=" | ".join(dossier.factures_citees(recherchable)),
                adresses_concernees=" | ".join(dossier.adresses_citees(parties)),
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

    # Chronologie complète, existant compris. Les numéros de pièce ne suivent
    # plus forcément les dates après une mise à jour : c'est assumé, un dossier
    # contentieux numérote ses pièces dans l'ordre où elles sont versées.
    lignes = sorted(existantes + lignes, key=lambda ligne: (ligne.date, ligne.piece_n))
    _reporter_pieces(resume, lignes)

    documents_monday = _documents_monday(dossier, repertoire, options, journal)

    # L'échéance du tableau prime toujours : elle est saisie par le service,
    # le calcul n'est qu'un repli quand la colonne est restée vide.
    if dossier.date_echeance:
        resume.source_echeance = "tableau de suivi"
    elif not options.sans_echeance_facture:
        cle = regle_du_dossier(dossier, options)
        regle = module_facture.REGLES[cle]
        jours = regle["delai"] if options.delai_paiement is None else options.delai_paiement

        # Les dates de formation figurent au tableau : inutile d'ouvrir la
        # facture pour les y relire, et une colonne saisie vaut mieux qu'un PDF
        # analysé.
        au_tableau = {
            "debut_formation": dossier.formation_debut,
            "fin_formation": dossier.formation_fin,
        }.get(regle["base"], "")

        if au_tableau:
            date, origine = module_facture.echeance_selon_regle(
                {regle["base"]: au_tableau}, cle, jours
            )
            origine = f"{origine} (tableau)"
        else:
            date, origine = _echeance_depuis_facture(
                dossier, repertoire, journal, cle, jours
            )

        if date:
            dossier.date_echeance = date
            resume.date_echeance = date
            resume.source_echeance = origine

    ecrire_index_dossier(chemin_index, lignes)

    analyse = module_synthese.analyser(lignes, textes_par_piece, doublons)
    _reporter_synthese(resume, analyse, date_export)

    vues = []
    if not options.sans_sous_dossiers:
        vues.append("factures")
    if options.sous_dossiers_par_adresse:
        vues.append("adresses")

    if not options.sans_synthese:
        contenu = module_synthese.construire_html(
            dossier=dossier,
            boites=sources.adresses,
            lignes=lignes,
            synthese=analyse,
            date_export=date_export,
            documents_monday=documents_monday,
            # La note cite les réponses du débiteur telles qu'il les a
            # écrites : il lui faut donc le texte des pièces, pas seulement
            # leur index.
            textes=textes_par_piece,
            # La note annonce les sous-dossiers réellement écrits, et eux
            # seuls : elle est le seul document lu, et un chemin qu'elle cite
            # doit exister.
            vues=set(vues),
        )
        if not ecrire_pdf(contenu, repertoire / "synthese.pdf")[0]:
            resume.pdf_en_echec += 1

    for vue in vues:
        nombre = _ecrire_sous_dossiers(
            dossier=dossier,
            repertoire=repertoire,
            lignes=lignes,
            textes_par_piece=textes_par_piece,
            bases_par_piece=bases_par_piece,
            boites=sources.adresses,
            date_export=date_export,
            options=options,
            journal=journal,
            resume=resume,
            vue=vue,
        )
        if vue == "factures":
            resume.sous_dossiers_factures = nombre
        else:
            resume.sous_dossiers_adresses = nombre

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


def relire_dossier(
    repertoire: Path, chemin_index: Path
) -> tuple[list[LigneIndex], dict[int, str], dict[int, str], set[str]]:
    """Relit un dossier déjà exporté, pour le compléter sans le refaire.

    Les pièces sont reconstituées depuis `index.csv`, et leur texte relu dans
    les `.eml` conservés — ce sont eux qui alimentent la détection des
    événements de la note de synthèse. Aucun message n'est retéléchargé pour
    cela, et aucun PDF n'est régénéré.
    """
    import csv as module_csv  # noqa: PLC0415

    lignes: list[LigneIndex] = []
    textes: dict[int, str] = {}
    bases: dict[int, str] = {}
    cles: set[str] = set()
    fuseau = fuseau_actuel()

    texte = chemin_index.read_text(encoding="utf-8-sig")
    for rangee in module_csv.DictReader(texte.splitlines(), delimiter=";"):
        try:
            numero = int(rangee.get("piece_n") or 0)
            date = datetime.strptime(
                f"{rangee.get('date', '')} {rangee.get('heure', '') or '00:00'}",
                "%d/%m/%Y %H:%M",
            ).replace(tzinfo=fuseau)
        except ValueError:
            continue

        fichier_eml = (rangee.get("fichier_eml") or "").strip()
        base = Path(fichier_eml).stem
        if base:
            bases[numero] = base

        chemin = repertoire / fichier_eml if fichier_eml else None
        if chemin is not None and chemin.exists():
            try:
                relu = lire_message({}, chemin.read_bytes())
            except Exception:  # noqa: BLE001 - un .eml abîmé ne doit rien bloquer
                relu = None
            if relu is not None:
                textes[numero] = relu.corps_texte or relu.corps_html or ""

        identifiant = (rangee.get("message_id") or "").strip()
        if identifiant:
            cles.add(identifiant.lower())

        lignes.append(
            LigneIndex(
                piece_n=numero,
                date=date,
                sens=rangee.get("sens") or "reçu",
                expediteur=rangee.get("expediteur") or "",
                destinataires=rangee.get("destinataires") or "",
                copie=rangee.get("copie") or "",
                objet=rangee.get("objet") or "",
                nb_pieces_jointes=int(rangee.get("nb_pieces_jointes") or 0),
                pieces_jointes=rangee.get("pieces_jointes") or "",
                critere=rangee.get("critere") or "",
                factures_concernees=rangee.get("factures_concernees") or "",
                adresses_concernees=rangee.get("adresses_concernees") or "",
                boites=rangee.get("boites") or "",
                fichier_pdf=rangee.get("fichier_pdf") or "",
                fichier_eml=fichier_eml,
                dossier_pieces_jointes=rangee.get("dossier_pieces_jointes") or "",
                thread_id=rangee.get("thread_id") or "",
                message_id=identifiant,
            )
        )

    return lignes, textes, bases, cles


def _reporter_pieces(resume: ResumeDossier, lignes: list[LigneIndex]) -> None:
    """Recompte le résumé sur l'ensemble des pièces du dossier.

    Après une mise à jour, compter les seuls messages téléchargés cette fois
    ferait dire au récapitulatif qu'un dossier de vingt pièces n'en compte que
    deux.
    """
    resume.nb_mails = len(lignes)
    resume.nb_envoyes = sum(1 for ligne in lignes if ligne.sens == "envoyé")
    resume.nb_recus = len(lignes) - resume.nb_envoyes
    resume.nb_pieces_jointes = sum(ligne.nb_pieces_jointes for ligne in lignes)
    resume.dates = [ligne.date for ligne in lignes]


def _fusionner_messages(existants, nouveaux) -> tuple[list, int]:
    """Ajoute des messages à un lot déjà constitué, sans doublon.

    `SourcesGmail.messages` dédoublonne à l'intérieur d'un appel ; ici on
    dédoublonne entre deux passes de recherche, sur la même clé de
    Message-ID.
    """
    par_cle = {message.cle_dedoublonnage: message for message in existants}
    doublons = 0

    for message in nouveaux:
        cle = message.cle_dedoublonnage
        existant = par_cle.get(cle)
        if existant is None:
            par_cle[cle] = message
            continue
        doublons += 1
        for boite in message.boites:
            if boite not in existant.boites:
                existant.boites.append(boite)

    return sorted(par_cle.values(), key=lambda message: message.date), doublons


def _decouvrir_adresses(
    dossier: Dossier,
    messages: list,
    sources: SourcesGmail,
    options: argparse.Namespace,
    journal: Journal,
) -> tuple[list[str], list]:
    """Adresses du débiteur déduites des messages citant son numéro de facture.

    Retourne les adresses retenues et les identifiants de leurs messages. Le
    sondage sert de garde-fou : une adresse qui ramène à elle seule plus que
    le plafond du dossier est une adresse interne ou partagée, pas celle d'un
    débiteur, et elle est écartée à voix haute.
    """
    citant_facture = [
        message
        for message in messages
        if dossier.factures_citees(message.texte_recherchable)
    ]
    if not citant_facture:
        journal(
            "    aucun message ne cite le numéro de facture : "
            "pas de découverte d'adresse possible"
        )
        return [], []

    candidates = adresses_candidates(
        citant_facture, domaines_maison(sources, options), dossier.emails
    )
    if not candidates:
        return [], []

    retenues: list[str] = []
    identifiants: list = []

    for adresse, occurrences in candidates[: options.max_adresses_decouvertes]:
        trouves = sources.identifiants_dossier(
            dossier.requete_adresse(adresse),
            inclure_spam_corbeille=not options.sans_spam,
            plafond=options.max_mails + 1,
        )
        if len(trouves) > options.max_mails:
            journal(
                f"    ⚠ adresse écartée : {adresse} ramène plus de "
                f"{options.max_mails} messages — adresse interne ou partagée, "
                "et non celle du débiteur"
            )
            continue

        retenues.append(adresse)
        identifiants += trouves
        journal(
            f"    adresse découverte : {adresse} "
            f"(en en-tête de {occurrences} message(s) citant la facture, "
            f"{len(trouves)} message(s) au total)"
        )

    ecartees = len(candidates) - len(candidates[: options.max_adresses_decouvertes])
    if ecartees:
        journal(
            f"    ⚠ {ecartees} autre(s) adresse(s) candidate(s) non sondée(s) : "
            f"plafond de {options.max_adresses_decouvertes} atteint "
            "(--max-adresses-decouvertes pour l'élever)"
        )

    return retenues, identifiants


def _attacher_historique(
    dossiers: list[Dossier],
    tableau: str,
    jeton: str,
    colonne: str,
    journal: Journal,
) -> None:
    """Rattache à chaque ligne son historique de changements d'étape.

    Un échec n'interrompt rien : l'historique enrichit la note, il ne la
    conditionne pas. Un journal Monday tronqué par l'abonnement, ou une
    colonne renommée, ne doivent pas faire perdre l'export des messages.
    """
    try:
        historique = module_monday.historique_colonne(tableau, jeton, colonne)
    except module_monday.ErreurMonday as exc:
        journal(f"    ⚠ historique des étapes indisponible : {exc}")
        return

    if not historique:
        journal(
            f"    aucun changement d'étape relevé sur « {colonne} » — Monday ne "
            "conserve son journal d'activité que sur une durée limitée"
        )
        return

    rattaches = 0
    for dossier in dossiers:
        element = dossier.colonnes.get("monday id", "")
        changements = historique.get(element)
        if changements:
            dossier.etapes = list(changements)
            rattaches += 1

    journal(f"    historique des étapes relevé pour {rattaches} ligne(s)")


def _copier_piece(repertoire: Path, cible: Path, base: str) -> None:
    """Recopie une pièce — message et pièces jointes — dans un sous-dossier.

    Chaque sous-dossier de facture doit pouvoir partir seul chez l'avocat :
    un renvoi vers le répertoire parent ne survivrait ni à une copie sur clé,
    ni à un envoi par archive.
    """
    for suffixe in (".pdf", ".html", ".eml"):
        origine = repertoire / "mails" / f"{base}{suffixe}"
        if origine.exists():
            destination = cible / "mails" / origine.name
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(origine, destination)

    pieces_jointes = repertoire / "pieces-jointes" / base
    if pieces_jointes.is_dir():
        shutil.copytree(
            pieces_jointes, cible / "pieces-jointes" / base, dirs_exist_ok=True
        )


def _ecrire_sous_dossiers(
    dossier: Dossier,
    repertoire: Path,
    lignes: list[LigneIndex],
    textes_par_piece: dict[int, str],
    bases_par_piece: dict[int, str],
    boites: list[str],
    date_export: datetime,
    options: argparse.Namespace,
    journal: Journal,
    resume: ResumeDossier,
    vue: str,
) -> int:
    """Une vue autonome du dossier, découpée par facture ou par adresse.

    Le dossier du débiteur reste l'ensemble ; chaque sous-dossier en est une
    vue autonome, limitée à ce qui concerne une facture — ou une adresse. Les
    numéros de pièce ne sont pas renumérotés : « pièce n° 7 » désigne le même
    message dans le dossier et dans tous ses sous-dossiers.
    """
    if vue == "factures":
        sous_dossiers = dossier.repartition_par_facture()
        repartir = module_synthese.repartition_par_facture
        libelle_vue = "facture"
        note_vue = (
            "Vue par facture : ce sous-dossier ne retient que les échanges "
            "concernant cette facture, plus ceux qui n'en nomment aucune. Le "
            "dossier complet du débiteur se trouve dans le répertoire parent."
        )
    else:
        sous_dossiers = dossier.repartition_par_adresse()
        repartir = module_synthese.repartition_par_adresse
        libelle_vue = "adresse"
        note_vue = (
            "Vue par adresse mail : ce sous-dossier ne retient que les échanges "
            "où cette adresse figure en en-tête, plus ceux où aucune adresse du "
            "dossier n'apparaît. Le montant affiché est celui de la dette entière "
            "du débiteur : il n'est pas réparti entre les adresses. Le dossier "
            "complet se trouve dans le répertoire parent."
        )

    if not sous_dossiers:
        return 0

    racine = repertoire / vue
    for sous_dossier, (designation, nom, pieces) in zip(
        sous_dossiers, repartir(sous_dossiers, lignes)
    ):
        cible = racine / nom
        cible.mkdir(parents=True, exist_ok=True)

        for ligne in pieces:
            base = bases_par_piece.get(ligne.piece_n)
            if base:
                _copier_piece(repertoire, cible, base)

        ecrire_index_dossier(cible / "index.csv", pieces)

        journal(
            f"    {libelle_vue} {designation or nom} → sous-dossier "
            f"« {vue}/{nom} », {len(pieces)} pièce(s)"
        )

        documents = _documents_monday(sous_dossier, cible, options, journal)

        if not options.sans_synthese:
            analyse = module_synthese.analyser(
                pieces,
                {
                    ligne.piece_n: textes_par_piece.get(ligne.piece_n, "")
                    for ligne in pieces
                },
            )
            contenu = module_synthese.construire_html(
                dossier=sous_dossier,
                boites=boites,
                lignes=pieces,
                synthese=analyse,
                date_export=date_export,
                documents_monday=documents,
                rattachement=f"{dossier.reference} — {dossier.nom}".strip(" —"),
                note_vue=note_vue,
                textes={
                    ligne.piece_n: textes_par_piece.get(ligne.piece_n, "")
                    for ligne in pieces
                },
                # Un sous-dossier ne se redécoupe pas : il annoncerait des
                # répertoires qui n'existent pas à son niveau.
                vues=set(),
            )
            if not ecrire_pdf(contenu, cible / "synthese.pdf")[0]:
                resume.pdf_en_echec += 1

    return len(sous_dossiers)


def regle_du_dossier(dossier: Dossier, options: argparse.Namespace) -> str:
    """Règle d'échéance applicable à ce dossier.

    Un choix explicite pour son tableau l'emporte ; à défaut, la règle
    générale ; et si elle vaut « auto », le nom du tableau tranche.
    """
    # Décidée au moment de la lecture du tableau : c'est là qu'on sait de quel
    # tableau vient la ligne, et donc quel financement s'applique.
    deja = dossier.colonnes.get("regle echeance")
    if deja:
        return module_facture.normaliser_regle(deja)

    regles = {
        cle.strip(): valeur.strip()
        for morceau in (options.regles_echeance or "").split(",")
        if "=" in morceau
        for cle, valeur in [morceau.split("=", 1)]
    }
    nom = dossier.colonnes.get("monday tableau") or dossier.origine_tableau
    if nom and nom in regles:
        return module_facture.normaliser_regle(regles[nom])

    if options.regle_echeance != "auto":
        return module_facture.normaliser_regle(options.regle_echeance)
    return module_facture.regle_deduite(nom)


def _echeance_depuis_facture(
    dossier: Dossier, repertoire: Path, journal: Journal,
    regle: str = module_facture.REGLE_PAR_DEFAUT,
    delai: int | None = None,
) -> tuple[str, str]:
    """Cherche l'échéance dans la facture PDF téléchargée depuis Monday.

    Le tableau ne renseigne pas toujours l'échéance ; la facture, elle, la
    porte. Sans elle, l'ancienneté de la créance reste vide, et c'est la
    lecture la plus utile du tableau de bord qui manque.

    Les fichiers dont le nom évoque une facture sont essayés d'abord : une
    convention de formation porte elle aussi des dates, et y lire une échéance
    de paiement n'aurait aucun sens.
    """
    racine = repertoire / "documents-monday"
    if not racine.is_dir():
        return "", ""

    pdfs = sorted(racine.glob("*.pdf"))
    if not pdfs:
        return "", ""

    def _priorite(chemin: Path) -> tuple[int, str]:
        nom = chemin.name.lower()
        if "convention" in nom or "contrat" in nom:
            return (2, nom)
        if "fact" in nom or any(f.lower() in nom for f in dossier.factures):
            return (0, nom)
        return (1, nom)

    for chemin in sorted(pdfs, key=_priorite):
        if _priorite(chemin)[0] == 2:
            continue  # une convention ne porte pas d'échéance de paiement
        date, origine = module_facture.echeance_de_la_facture(chemin, regle, delai)
        if date:
            journal(f"    échéance lue dans {chemin.name} : {date} ({origine})")
            return date, origine
        journal(f"    échéance non trouvée dans {chemin.name} — {origine}")

    return "", ""


def _documents_monday(
    dossier: Dossier,
    repertoire: Path,
    options: argparse.Namespace,
    journal: Journal,
) -> list[str]:
    """Récupère les factures et conventions déposées dans Monday.

    Rangées à part des pièces extraites des messages : elles attestent de leur
    existence, pas de leur transmission au débiteur.
    """
    if not dossier.liens:
        return []

    jeton = module_monday.lire_jeton(options.jeton_monday)
    if not jeton:
        journal(
            f"    {len(dossier.liens)} document(s) Monday référencés mais non "
            "téléchargés — aucun jeton Monday configuré"
        )
        return []

    ecrits, echecs = module_monday.recuperer_documents(
        dossier.liens, jeton, repertoire / "documents-monday"
    )
    if ecrits:
        journal(f"    {len(ecrits)} document(s) Monday téléchargé(s)")
    for echec in echecs:
        journal(f"    ⚠ document Monday non récupéré — {echec}")
    return ecrits


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
factures/         Présent uniquement quand le débiteur porte plusieurs
                  factures en retard. Un sous-répertoire par facture, chacun
                  complet et transmissible seul : sa note de synthèse, sa
                  chronologie, ses messages et ses pièces jointes.
                    - un échange qui nomme une facture précise n'est versé
                      qu'au sous-dossier de cette facture ;
                    - un échange qui n'en nomme aucune — relance générale,
                      réponse de l'apprenante — est versé à tous, car il vaut
                      pour l'ensemble de la dette.
                  Les numéros de pièce ne sont pas renumérotés : « pièce n° 7 »
                  désigne le même message dans le dossier et dans chacun de
                  ses sous-dossiers. La colonne « factures_concernees » de
                  index.csv indique, pour chaque message, ce qui a été retenu.
adresses/         Même principe, sur option, quand les échanges d'un débiteur
                  passent par plusieurs adresses mail : un sous-répertoire par
                  adresse, avec les échanges où elle figure en en-tête, plus
                  ceux où aucune adresse du dossier n'apparaît. Le
                  rattachement se fait sur les en-têtes (expéditeur,
                  destinataires, copies) et non sur le corps du message : une
                  adresse recopiée dans une citation ne fait pas de son
                  titulaire une partie à l'échange. Les montants n'y sont pas
                  répartis — une adresse ne porte pas une part de la dette.

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

Sur option, une seconde passe complète la première : les adresses des parties
sont relevées dans les messages qui citent le numéro de facture, puis la
recherche est relancée sur chacune. Elle retrouve ainsi les échanges qui ne
nomment aucun numéro — la plupart des réponses de l'apprenante — même si
l'adresse ne figurait nulle part au tableau de suivi. Les adresses des
domaines internes et les comptes automatiques sont écartés, et toute adresse
ramenant à elle seule plus de messages que le plafond du dossier l'est aussi :
c'est une boîte interne ou partagée, pas celle d'un débiteur. Les adresses
retenues sont annoncées à l'écran et reportées en colonne
« adresses_decouvertes » de _recapitulatif.csv, à vérifier avant transmission.

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
        if options.tableau_monday:
            jeton = module_monday.lire_jeton(options.jeton_monday)
            if not jeton:
                raise ErreurDossiers(
                    "Lire le tableau directement dans Monday demande le jeton "
                    "d'accès Monday. Renseignez-le, ou déposez un export du "
                    "tableau."
                )
            identifiants = [
                morceau.strip()
                for morceau in str(options.tableau_monday).split(",")
                if morceau.strip()
            ]
            regles_par_tableau = {
                cle.strip(): valeur.strip()
                for morceau in (options.regles_echeance or "").split(",")
                if "=" in morceau
                for cle, valeur in [morceau.split("=", 1)]
            }
            liste = []
            for identifiant in identifiants:
                journal(f"Lecture du tableau Monday {identifiant}…")
                try:
                    grille = module_monday.lire_tableau(
                        identifiant, jeton,
                        avec_sous_elements=options.avec_sous_elements,
                        # Le même filtre qu'en local, mais appliqué chez
                        # Monday : sur un tableau de plusieurs milliers de
                        # lignes, tout rapatrier pour en garder dix coûte des
                        # minutes. Le tri local reste derrière, en sécurité.
                        filtre=(
                            (options.filtre_colonne,
                             SEPARATEURS_MULTIVALEUR.split(options.filtre_valeur))
                            if options.filtre_colonne and options.filtre_valeur
                            else None
                        ),
                        groupes=SEPARATEURS_MULTIVALEUR.split(
                            options.groupes_monday or ""
                        ),
                        signaler=journal,
                    )
                except module_monday.ErreurMonday as exc:
                    raise ErreurDossiers(str(exc)) from exc
                lignes_tableau = dossiers_depuis_grille(
                    grille,
                    f"tableau Monday {identifiant}",
                    ignorer_lignes_incompletes=options.ignorer_lignes_incompletes,
                    signaler=journal,
                )
                # La règle d'échéance se décide par tableau : elle dépend du
                # mode de financement, et un même lot peut réunir les deux.
                nom_tableau = (
                    lignes_tableau[0].colonnes.get("monday tableau", "")
                    if lignes_tableau else ""
                )
                cle = module_facture.normaliser_regle(
                    regles_par_tableau.get(identifiant)
                    or (options.regle_echeance
                        if options.regle_echeance != "auto" else ""),
                    module_facture.regle_deduite(nom_tableau),
                )
                for ligne_dossier in lignes_tableau:
                    ligne_dossier.colonnes["regle echeance"] = cle

                _signaler_colonnes_vides(lignes_tableau, journal)

                journal(
                    f"    {len(lignes_tableau)} ligne(s) exploitable(s) — "
                    f"échéance : {module_facture.REGLES[cle]['libelle']}"
                )

                colonne_etapes = (
                    options.colonne_etapes or options.filtre_colonne or ""
                ).strip()
                if colonne_etapes:
                    _attacher_historique(
                        lignes_tableau, identifiant, jeton, colonne_etapes, journal
                    )

                liste += lignes_tableau

            # Chaque tableau numérote ses lignes pour lui seul : réunis, deux
            # d'entre eux peuvent porter la même référence.
            if len(identifiants) > 1:
                rendre_repertoires_uniques(liste, signaler=journal)

            origine = (
                f"{len(identifiants)} tableau(x) Monday"
                if len(identifiants) > 1
                else f"tableau Monday {options.tableau_monday}"
            )
        else:
            origine = str(options.dossiers)
            liste = lire_dossiers(
                options.dossiers,
                ignorer_lignes_incompletes=options.ignorer_lignes_incompletes,
                signaler=journal,
            )

        if options.filtre_colonne and options.filtre_valeur:
            liste = filtrer_par_colonne(
                liste, options.filtre_colonne, options.filtre_valeur,
                signaler=journal, groupes=options.groupes_monday,
            )

        if options.seulement:
            voulues = {ref.strip().lower() for ref in options.seulement.split(",") if ref.strip()}
            liste = [d for d in liste if d.reference.lower() in voulues]
            if not liste:
                journal(f"Aucun dossier ne correspond à --seulement {options.seulement}")
                return 1

        journal(f"{len(liste)} dossier(s) à traiter depuis {origine}")

        if not options.sans_regroupement:
            liste = regrouper_par_debiteur(liste, signaler=journal)

        if len(liste) > SEUIL_VOLUME_INHABITUEL:
            journal(
                f"⚠ {len(liste)} dossiers, c'est beaucoup pour un lot contentieux. "
                "Un tableau Monday exporté en entier contient tout l'historique, "
                "pas seulement les dossiers à transmettre. Filtrez le tableau "
                "avant l'export, ou restreignez avec --seulement."
            )

        if options.reprendre and options.mettre_a_jour:
            journal(
                "⚠ « Reprendre » et « Compléter » sont demandés ensemble : "
                "reprendre passe les dossiers déjà exportés, donc rien ne sera "
                "complété. Décochez « Reprendre » pour compléter."
            )

        sans_adresse = [dossier for dossier in liste if not dossier.emails]
        if sans_adresse:
            journal(
                f"⚠ {len(sans_adresse)} dossier(s) sans adresse mail : recherchés "
                "sur le seul numéro de facture. Rappel : Gmail n'indexe pas le "
                "texte des PDF joints, un numéro qui n'apparaît que dans la pièce "
                "jointe ne remontera pas."
            )
            # Un décompte qui ne dit pas de qui il parle ne se vérifie pas :
            # « 20 dossiers sans adresse » alors qu'on en compte six à l'écran
            # reste sans explication tant que les références ne sont pas là.
            journal("    " + ", ".join(
                dossier.reference or dossier.nom or "(sans référence)"
                for dossier in sans_adresse[:40]
            ) + (" …" if len(sans_adresse) > 40 else ""))
            if not options.decouvrir_adresses:
                journal(
                    "    la recherche des adresses depuis le numéro de facture "
                    "est désactivée. Réactivée, elle relève l'adresse du débiteur "
                    "dans les messages trouvés et relance la recherche dessus."
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

        if not options.simulation:
            # Écrite avant le premier dossier : la note de méthode fait partie
            # du dossier remis, et un export interrompu doit la comporter.
            ecrire_note_methode(
                racine_sortie / "LISEZ-MOI.txt",
                adresse_boite,
                len(liste),
                options,
                fuseau_applique,
            )

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

            # Réécrit à chaque dossier, et non à la fin : un export interrompu
            # — veille du poste, fenêtre fermée, coupure réseau — laissait
            # jusqu'ici les dossiers sur le disque sans récapitulatif, donc un
            # tableau de bord vide alors que le travail était fait.
            if not options.simulation:
                try:
                    ecrire_recapitulatif(
                        racine_sortie / "_recapitulatif.csv", resumes
                    )
                except OSError as exc:
                    journal(f"    ⚠ récapitulatif non mis à jour : {exc}")

        journal("")
        if not options.simulation:
            ecrire_recapitulatif(racine_sortie / "_recapitulatif.csv", resumes)

        total_mails = sum(r.nb_mails for r in resumes)
        total_pj = sum(r.nb_pieces_jointes for r in resumes)
        vides = [r.reference for r in resumes if r.statut == "aucun message"]
        pdf_rates = sum(r.pdf_en_echec for r in resumes)

        journal(f"Terminé : {total_mails} message(s), {total_pj} pièce(s) jointe(s).")

        total_sous = sum(r.sous_dossiers_factures for r in resumes)
        if total_sous:
            multi = sum(1 for r in resumes if r.sous_dossiers_factures)
            journal(
                f"{multi} débiteur(s) portant plusieurs factures ont donné "
                f"{total_sous} sous-dossier(s), un par facture, dans « factures/ »."
            )

        total_adresses = sum(r.sous_dossiers_adresses for r in resumes)
        if total_adresses:
            multi = sum(1 for r in resumes if r.sous_dossiers_adresses)
            journal(
                f"{multi} débiteur(s) joignables à plusieurs adresses ont donné "
                f"{total_adresses} sous-dossier(s), un par adresse, dans « adresses/ »."
            )
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
    except Exception as exc:  # noqa: BLE001 - le journal doit dire pourquoi
        # Sans cette branche, une panne imprévue laissait journal.log s'arrêter
        # en plein milieu, sans un mot : impossible de distinguer un plantage
        # d'une fenêtre fermée. La trace complète part dans le fichier, seule
        # source consultable une fois l'application refermée.
        import traceback  # noqa: PLC0415

        journal(f"Erreur inattendue : {exc.__class__.__name__} : {exc}")
        for ligne in traceback.format_exc().splitlines():
            journal(f"    {ligne}")
        journal("Relancez avec --reprendre pour continuer où vous en étiez.")
        return 3
    finally:
        journal.fermer()


def main() -> int:
    return executer(analyser_arguments())


if __name__ == "__main__":
    raise SystemExit(main())
