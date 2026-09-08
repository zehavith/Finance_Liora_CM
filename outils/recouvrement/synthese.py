"""Note de synthèse d'un dossier : chronologie, événements, constats.

Le contenu est **entièrement déduit des messages extraits**, jamais rédigé
librement : chaque constat renvoie à un numéro de pièce vérifiable dans
`index.csv`. C'est une contrainte volontaire — une note destinée à un dossier
contentieux ne peut pas comporter d'affirmation invérifiable, et rien n'est
envoyé à un service tiers pour la produire.
"""

from __future__ import annotations

import html
import re
import unicodedata
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

from indexation import LigneIndex

# Formulations qui annulent une occurrence de « contestation » : nos propres
# courriers de relance en sont pleins — « en cas de contestation, merci de
# nous écrire sous huit jours » — et les compter reviendrait à faire dire à
# une mise en demeure que le débiteur a contesté.
SANS_PORTEE = (
    "en cas de", "en l absence de", "a defaut de", "faute de", "sauf",
    "toute", "pour toute", "aucune", "sans", "si vous", "en cas d",
)


@dataclass(frozen=True)
class Motif:
    """Un événement à repérer, et les conditions pour le retenir."""

    libelle: str
    motifs: tuple[str, ...]
    # Un événement dont le libellé désigne un auteur ne doit être retenu que
    # dans ce sens : une mise en demeure est adressée par Liora, une
    # contestation vient du débiteur. Vide = les deux sens conviennent.
    sens: str = ""
    annulateurs: tuple[str, ...] = ()


# Événements repérés dans l'objet et le corps des messages. Les motifs sont
# comparés sur un texte mis à plat (minuscules, sans accent).
EVENEMENTS = [
    Motif("Mise en demeure", (
        "mise en demeure", "mettons en demeure", "mettre en demeure",
        "derniere relance avant", "avant poursuites",
    ), sens="envoyé"),
    Motif("Transmission au contentieux", (
        "transmis au contentieux", "service contentieux", "huissier",
        "commissaire de justice", "injonction de payer", "notre avocat",
        "procedure judiciaire", "recouvrement judiciaire",
    ), sens="envoyé"),
    # Uniquement sur un message reçu, et jamais sur la mention de principe
    # qui figure dans nos propres relances.
    Motif("Contestation", (
        "je conteste", "nous contestons", "je contesterai", "contestation",
        "desaccord", "pas d accord", "je refuse de payer", "erreur de facturation",
        "montant abusif", "je n ai jamais", "ne correspond pas",
    ), sens="reçu", annulateurs=SANS_PORTEE),
    # Libellé neutre : le même échéancier est tantôt demandé par l'apprenante,
    # tantôt accordé par Liora. La colonne « sens » tranche.
    # Pas de « mensualite » seul : « la première mensualité reste impayée » est
    # une relance, pas une demande d'étalement.
    Motif("Échéancier évoqué", (
        "echeancier", "echelonner", "echelonne", "etaler le paiement",
        "en plusieurs fois", "plusieurs mensualites", "delai de paiement",
        "delai supplementaire",
    )),
    Motif("Annonce de paiement", (
        "virement effectue", "j ai regle", "j ai paye", "paiement effectue",
        "reglement effectue", "virement realise", "vous trouverez le reglement",
    ), sens="reçu"),
    Motif("Difficultés financières invoquées", (
        "difficulte financiere", "difficultes financieres", "situation financiere difficile",
        "sans emploi", "au chomage", "perte d emploi", "je ne peux pas payer",
    ), sens="reçu"),
    # Un paiement revenu impayé n'est pas un défaut de paiement ordinaire :
    # le débiteur a donné un moyen de paiement qui n'a pas été honoré. Devant
    # un juge, c'est le fait le plus parlant du dossier.
    Motif("Rejet de paiement", (
        "cheque rejete", "cheque impaye", "cheque sans provision",
        "prelevement rejete", "prelevement impaye", "prelevement refuse",
        "paiement rejete", "paiement refuse", "paiement non abouti",
        "virement rejete", "rejet de prelevement", "rejet bancaire",
        "provision insuffisante", "sans provision", "opposition au cheque",
        "compte non approvisionne", "impaye bancaire", "carte refusee",
        "echeance rejetee", "echeance impayee",
    )),
    Motif("Relance", (
        "relance", "rappel", "reste impayee", "reste impaye", "demeure impayee",
        "toujours pas recu", "sans reponse de votre part", "non regle",
    ), sens="envoyé"),
    Motif("Envoi de facture", (
        "ci-joint la facture", "veuillez trouver la facture", "vous trouverez ci-joint",
        "votre facture", "facture correspondant",
    ), sens="envoyé"),
]


def mentionne(texte: str, motifs, annulateurs=()) -> bool:
    """Le texte porte-t-il l'un de ces motifs, hors formulation de principe ?

    Chaque occurrence est examinée avec ce qui la précède : « en cas de
    contestation » n'est pas une contestation, « je conteste » en est une.
    """
    for motif in motifs:
        depart = 0
        while True:
            position = texte.find(motif, depart)
            if position == -1:
                break
            avant = texte[max(0, position - 40):position]
            if not any(annulateur in avant for annulateur in annulateurs):
                return True
            depart = position + len(motif)
    return False

# Un accusé de remise automatique n'est pas un échange avec l'apprenante.
MOTIFS_AUTOMATIQUES = [
    "delivery status notification", "mail delivery", "undeliverable",
    "absence du bureau", "out of office", "reponse automatique", "message automatique",
]


def aplatir(texte: str) -> str:
    texte = unicodedata.normalize("NFKD", texte or "")
    texte = texte.encode("ascii", "ignore").decode("ascii").lower()
    return re.sub(r"\s+", " ", texte)


@dataclass
class Evenement:
    piece: int
    date: datetime
    libelle: str
    sens: str


@dataclass
class Synthese:
    """Faits établis à partir des seules pièces du dossier."""

    nb_pieces: int = 0
    nb_envoyes: int = 0
    nb_recus: int = 0
    nb_pieces_jointes: int = 0
    premier: datetime | None = None
    dernier: datetime | None = None
    derniere_reponse: datetime | None = None
    piece_derniere_reponse: int | None = None
    evenements: list[Evenement] = field(default_factory=list)
    doublons_ecartes: int = 0
    # Messages venus du même débiteur mais nommant d'autres factures : au
    # dossier, mais hors des comptes qui établissent cette créance-ci.
    autres_factures: list = field(default_factory=list)

    def evenements_de(self, libelle: str) -> list[Evenement]:
        return [ev for ev in self.evenements if ev.libelle == libelle]

    def premier_evenement(self, libelle: str) -> Evenement | None:
        trouves = self.evenements_de(libelle)
        return trouves[0] if trouves else None

    def dernier_evenement(self, libelle: str) -> Evenement | None:
        trouves = self.evenements_de(libelle)
        return trouves[-1] if trouves else None

    @property
    def duree_jours(self) -> int:
        if not self.premier or not self.dernier:
            return 0
        return (self.dernier - self.premier).days

    def jours_depuis(self, date: datetime | None, reference: datetime) -> int | None:
        if date is None:
            return None
        return (reference - date).days


def concerne_une_autre_facture(ligne: LigneIndex) -> bool:
    """Le message a-t-il été rattaché à une autre facture du même débiteur ?

    Chercher par adresse ramène tout ce qui vient du débiteur. Un message qui
    ne nomme que d'autres factures ne prouve rien de cette créance-ci :
    le compter parmi les relances ferait état d'une diligence qui portait
    sur autre chose.
    """
    return (ligne.critere or "").startswith("autre facture")


def analyser(lignes: list[LigneIndex], textes: dict[int, str], doublons: int = 0) -> Synthese:
    """Construit la synthèse à partir de l'index et du texte de chaque pièce.

    Les messages rattachés à une autre facture du même débiteur en sont
    écartés : ils restent au dossier, consultables, mais ne comptent pas
    parmi ce qui établit cette créance-ci.
    """
    retenues = [l for l in lignes if not concerne_une_autre_facture(l)]
    synthese = Synthese(nb_pieces=len(retenues), doublons_ecartes=doublons)
    synthese.autres_factures = [l for l in lignes if concerne_une_autre_facture(l)]

    for ligne in retenues:
        synthese.nb_pieces_jointes += ligne.nb_pieces_jointes
        if synthese.premier is None or ligne.date < synthese.premier:
            synthese.premier = ligne.date
        if synthese.dernier is None or ligne.date > synthese.dernier:
            synthese.dernier = ligne.date

        texte = aplatir(f"{ligne.objet}\n{textes.get(ligne.piece_n, '')}")
        automatique = any(motif in texte for motif in MOTIFS_AUTOMATIQUES)

        if ligne.sens == "envoyé":
            synthese.nb_envoyes += 1
        else:
            synthese.nb_recus += 1
            # Une notification automatique n'est pas une réponse de l'apprenante.
            if not automatique and (
                synthese.derniere_reponse is None or ligne.date > synthese.derniere_reponse
            ):
                synthese.derniere_reponse = ligne.date
                synthese.piece_derniere_reponse = ligne.piece_n

        if automatique:
            continue

        for repere in EVENEMENTS:
            if repere.sens and ligne.sens != repere.sens:
                continue
            if mentionne(texte, repere.motifs, repere.annulateurs):
                synthese.evenements.append(
                    Evenement(ligne.piece_n, ligne.date, repere.libelle, ligne.sens)
                )

    synthese.evenements.sort(key=lambda ev: (ev.date, ev.piece))
    return synthese


def rediger_constats(synthese: Synthese, reference_temps: datetime) -> list[str]:
    """Constats factuels, chacun rattaché à une pièce ou à un décompte."""
    constats: list[str] = []

    if synthese.nb_pieces == 0:
        return ["Aucun message n'a été retrouvé pour ce dossier."]

    constats.append(
        f"Le dossier réunit {_accorder(synthese.nb_pieces, 'pièce')}, "
        f"du {synthese.premier:%d/%m/%Y} au {synthese.dernier:%d/%m/%Y} "
        f"(soit {synthese.duree_jours} jours), dont {synthese.nb_envoyes} "
        f"message{'s' if synthese.nb_envoyes > 1 else ''} émis par Liora et "
        f"{synthese.nb_recus} reçu{'s' if synthese.nb_recus > 1 else ''}."
    )

    # Un dossier de recouvrement sans un seul message sortant n'existe pas :
    # c'est le sens des messages qui est mal établi, et tous les constats
    # ci-dessous en dépendent. Le dire ici plutôt que de laisser lire une note
    # qui conclurait à l'absence de relance.
    if synthese.nb_envoyes == 0 and synthese.nb_recus > 0:
        constats.append(
            "⚠ Aucun message émis par Liora n'a été reconnu. Les relances "
            "partent probablement d'un domaine non déclaré à l'outil (une "
            "ancienne marque, un prestataire d'envoi). Les constats qui "
            "suivent reposent sur le sens des messages : ils sont à reprendre "
            "après avoir renseigné ce domaine."
        )

    facture = synthese.premier_evenement("Envoi de facture")
    if facture:
        constats.append(
            f"La facture a été adressée à l'apprenante le {facture.date:%d/%m/%Y} "
            f"(pièce n° {facture.piece})."
        )

    relances = [ev for ev in synthese.evenements_de("Relance") if ev.sens == "envoyé"]
    if relances:
        pieces = ", ".join(f"n° {ev.piece}" for ev in relances)
        constats.append(
            f"{_accorder(len(relances), 'relance')} "
            f"{'ont' if len(relances) > 1 else 'a'} été adressée"
            f"{'s' if len(relances) > 1 else ''} à l'apprenante "
            f"(pièces {pieces}), la dernière le {relances[-1].date:%d/%m/%Y}."
        )
    else:
        constats.append("Aucune relance n'a été identifiée dans les échanges extraits.")

    demeure = synthese.dernier_evenement("Mise en demeure")
    if demeure:
        constats.append(
            f"Une mise en demeure a été adressée le {demeure.date:%d/%m/%Y} "
            f"(pièce n° {demeure.piece})."
        )
    else:
        constats.append(
            "Aucune mise en demeure n'apparaît dans les échanges extraits."
        )

    if synthese.derniere_reponse is not None:
        jours = synthese.jours_depuis(synthese.derniere_reponse, reference_temps)
        constats.append(
            f"La dernière réponse de l'apprenante date du "
            f"{synthese.derniere_reponse:%d/%m/%Y} (pièce n° "
            f"{synthese.piece_derniere_reponse}), soit il y a {jours} jours."
        )
        posterieures = [
            ev for ev in relances if ev.date > synthese.derniere_reponse
        ]
        if posterieures:
            constats.append(
                f"{_accorder(len(posterieures), 'relance')} "
                f"{'sont restées' if len(posterieures) > 1 else 'est restée'} "
                "sans réponse depuis "
                "cette date."
            )
    else:
        constats.append(
            "Aucune réponse de l'apprenante ne figure dans les échanges extraits."
        )

    echeancier = synthese.premier_evenement("Échéancier évoqué")
    if echeancier:
        constats.append(
            f"Un échéancier ou un délai de paiement a été évoqué le "
            f"{echeancier.date:%d/%m/%Y} (pièce n° {echeancier.piece})."
        )

    paiement = synthese.dernier_evenement("Annonce de paiement")
    if paiement:
        constats.append(
            f"Un paiement a été annoncé le {paiement.date:%d/%m/%Y} "
            f"(pièce n° {paiement.piece}) — à rapprocher des encaissements réels."
        )

    contestation = synthese.premier_evenement("Contestation")
    if contestation:
        constats.append(
            f"Le montant ou la prestation a fait l'objet d'une contestation le "
            f"{contestation.date:%d/%m/%Y} (pièce n° {contestation.piece})."
        )
    else:
        constats.append(
            "Aucune contestation du montant ou de la prestation n'apparaît dans "
            "les échanges extraits."
        )

    if synthese.dernier is not None:
        silence = synthese.jours_depuis(synthese.dernier, reference_temps)
        constats.append(
            f"Aucun échange n'est enregistré depuis {silence} jours "
            f"(dernier message le {synthese.dernier:%d/%m/%Y})."
        )

    return constats


FEUILLE_DE_STYLE = """
/* Un dossier contentieux se lit sur papier, devant quelqu'un. D'où le
   caractère à empattements, les filets fins plutôt que les aplats gris, et
   les intitulés de section en petites capitales : ce sont les codes du
   document juridique, et ils font la différence entre une pièce qu'on dépose
   et un rapport qu'on a manifestement laissé produire par un outil.
   Le style reste volontairement sobre : deux moteurs PDF le rendent, et
   xhtml2pdf n'accepte qu'un sous-ensemble restreint de CSS. */
@page { size: A4; margin: 18mm 16mm 16mm 16mm; }

body { font-family: Georgia, "Times New Roman", Times, serif;
       font-size: 10.5pt; line-height: 1.45; color: #1a1a1a; }

h1 { font-size: 16pt; font-weight: normal; letter-spacing: 0.3pt;
     margin: 0 0 3px 0; }
.sous-titre { font-size: 11pt; color: #333; margin: 0 0 3px 0; }
.entete { border-bottom: 2px solid #1a1a1a; padding-bottom: 8px;
          margin-bottom: 14px; }

h2 { font-size: 9.5pt; font-weight: bold; text-transform: uppercase;
     letter-spacing: 1.1pt; color: #1a1a1a; margin: 22px 0 8px 0;
     border-bottom: 1px solid #1a1a1a; padding-bottom: 4px; }
h3 { font-size: 10pt; font-weight: bold; margin: 16px 0 6px 0; color: #1a1a1a; }

p.groupe { font-size: 9pt; font-weight: bold; text-transform: uppercase;
           letter-spacing: 0.6pt; color: #444; margin: 13px 0 4px 0; }

table { width: 100%; border-collapse: collapse; margin: 6px 0 4px 0; }
td, th { padding: 4px 6px; font-size: 9pt; text-align: left;
         vertical-align: top; border-bottom: 1px solid #ccc; }
th { font-size: 8pt; text-transform: uppercase; letter-spacing: 0.5pt;
     color: #333; border-bottom: 1px solid #1a1a1a; font-weight: bold; }

.identite td { border-bottom: 1px solid #e6e6e6; font-size: 9.5pt; }
.identite td.cle { width: 150px; color: #444; }

/* Le montant en litige se lit avant tout le reste : c'est lui qui décide
   si le dossier vaut une procédure. */
.montant { border: 1px solid #1a1a1a; padding: 9px 12px; margin: 0 0 14px 0; }
.montant span { font-size: 8.5pt; text-transform: uppercase;
                letter-spacing: 0.8pt; color: #444; }
.montant b { display: block; font-size: 17pt; font-weight: normal;
             margin-top: 2px; }
.montant.manquant b { font-size: 10.5pt; font-style: italic; color: #666; }

.chiffres td { text-align: center; border: none;
               border-right: 1px solid #ccc; }
.chiffres .valeur { font-size: 15pt; }
.chiffres .libelle { font-size: 7.5pt; text-transform: uppercase;
                     letter-spacing: 0.5pt; color: #555; }

ul.constats { margin: 4px 0 0 0; padding-left: 15px; }
ul.constats li { margin-bottom: 6px; font-size: 10pt; }

.piece-num { color: #444; white-space: nowrap; font-size: 8.5pt; }
.chemin { font-size: 8.5pt; color: #555; font-style: italic; margin: 5px 0; }

/* Reproduite telle quelle : le liseré la distingue de ce que la note
   établit elle-même. */
.interne { border-left: 3px solid #999; padding: 7px 11px; margin: 12px 0;
           font-size: 9.5pt; color: #333; }

blockquote.propos { margin: 5px 0 9px 14px; padding-left: 11px;
                    border-left: 2px solid #bbb; font-size: 9.5pt;
                    color: #333; font-style: italic; }

.avertissement { margin-top: 22px; border-top: 1px solid #1a1a1a;
                 padding-top: 8px; font-size: 8pt; color: #444;
                 line-height: 1.4; }

/* Le résumé se lit avant tout le reste : un corps un peu plus grand, un
   interligne aéré, et rien qui distraie. */
.resume { font-size: 10.5pt; line-height: 1.55; margin: 4px 0 16px;
          padding-left: 19px; }
.resume li { margin: 0 0 9px; padding-left: 3px; }
.resume li b { font-variant: small-caps; letter-spacing: 0.2px; }

/* Un échange se lit comme une réplique : l'en-tête discret, le propos en
   retrait. Le liséré tient la colonne sur toute la conversation. */
.echange { margin: 0 0 10px 2px; }
.entete-echange { font-size: 8.5pt; color: #555; margin: 0 0 2px;
                  letter-spacing: 0.2px; }
.echange blockquote.propos { margin-top: 2px; }

/* L'annexe commence sur une nouvelle page à l'impression : le corps de la
   note se transmet seul, et le détail des échanges suit sans s'y mêler. */
.annexe { margin-top: 30px; border-top: 2px solid #1a1a1a; padding-top: 14px; }
@media print { .annexe { page-break-before: always; } }
"""


FORMATS_DATE_TABLEAU = ("%d/%m/%Y", "%Y-%m-%d", "%d-%m-%Y", "%Y/%m/%d", "%d/%m/%y")


def _recit_contexte(
    dossier,
    synthese: Synthese,
    reference_temps: datetime,
    lignes: list[LigneIndex] | None = None,
) -> str:
    """Ce qui s'est passé, raconté d'un trait.

    Un dossier se transmet avec un paragraphe qui se lit, pas avec une liste
    de faits juxtaposés : celui qui le reçoit doit comprendre l'affaire en
    trois phrases. Chaque affirmation vient d'un fait établi ailleurs dans la
    note — et ce que l'outil ignore, il ne l'invente pas : le service le
    complète lui-même dans le champ « Contexte » de l'application.
    """
    maintenant = reference_temps.replace(tzinfo=None)
    phrases: list[str] = []

    # 1. L'exécution de la prestation. C'est ce qu'on oppose d'abord à
    #    « je n'ai rien reçu », donc ce par quoi le récit commence.
    convention = _oui_non(dossier.convention_signee)
    diplome = _oui_non(dossier.diplome)
    theoriques = _heures(dossier.heures_theoriques)
    suivies = _heures(dossier.heures_log)

    faits_execution: list[str] = []
    if dossier.formation_debut and dossier.formation_fin:
        faits_execution.append(
            f"a suivi la formation du {dossier.formation_debut} "
            f"au {dossier.formation_fin}"
        )
    elif dossier.formation_fin:
        faits_execution.append(f"a terminé sa formation le {dossier.formation_fin}")
    elif convention is True or diplome is True or suivies:
        faits_execution.append("a suivi la formation")

    if diplome is True:
        faits_execution.append("a reçu son diplôme")
    elif diplome is False:
        faits_execution.append("n'a pas obtenu son diplôme")

    # Sur une facture d'entreprise, celui qui suit la formation et celui qui
    # doit payer sont deux personnes différentes. Écrire « L'apprenant n'a pas
    # payé » désigne alors la mauvaise partie — et devant un tribunal, c'est
    # l'employeur qui est assigné, pas le stagiaire.
    corpo = _debiteur_est_une_entreprise(dossier)
    # Le tableau ne dit rien de la convention, mais une pièce du dossier peut
    # l'établir : un devis signé au nom de l'apprenant vaut engagement.
    piece_engagement = ""
    if convention is not True:
        piece_engagement = convention_dans_les_pieces(
            lignes or [], dossier.apprenant_forme()
            if hasattr(dossier, "apprenant_forme") else "")

    if faits_execution:
        sujet = "L'apprenant" if not corpo else "La formation a été suivie"
        if corpo:
            phrases.append(
                "La formation a été suivie" + _suite_corpo(faits_execution) + "."
            )
        else:
            phrases.append(sujet + " " + _enumerer(faits_execution) + ".")
    elif convention is True:
        phrases.append("La convention de formation a été signée par le débiteur.")

    # Les heures font leur propre phrase : les glisser dans l'énumération
    # ci-dessus y introduisait des virgules, et l'ensemble ne se lisait plus.
    # La feuille d'émargement établit la présence effective, séance par séance
    # et signature à l'appui : c'est la pièce la plus forte du dossier sur
    # l'exécution, et sa place est ici, avec les faits qu'elle prouve.
    emargement = _emargement_du_dossier(lignes or [])
    if emargement:
        phrases.append(
            "La feuille d'émargement " + _de(emargement["apprenant"])
            + f", du {emargement['debut']} au {emargement['fin']}, "
            "figure au dossier."
        )

    qui = "L'apprenant s'est" if corpo else "Il s'est"
    if suivies and theoriques:
        part = round(100 * suivies / theoriques)
        phrases.append(
            f"{qui} connecté {_nombre_heures(suivies)} sur les "
            f"{_nombre_heures(theoriques)} prévues, soit {part} % du volume "
            "horaire."
        )
    elif suivies:
        phrases.append(f"{qui} connecté {_nombre_heures(suivies)}.")

    # 2. Le défaut de paiement, et ce qui a été tenté.
    du = montant_lisible(dossier.montant_du) or montant_lisible(dossier.montant_total)
    echeance = _date_tableau(dossier.date_echeance)
    relances = synthese.evenements_de("Relance")
    demeures = synthese.evenements_de("Mise en demeure")

    if corpo:
        defaut = f"{dossier.nom.strip()} n'a pas payé" if dossier.nom.strip() \
            else "Le débiteur n'a pas payé"
    else:
        defaut = "Il n'a pas payé" if faits_execution else "Le débiteur n'a pas payé"
    if du and echeance is not None:
        defaut += f" les {du} dus depuis le {echeance:%d/%m/%Y}"
    elif du:
        defaut += f" les {du} dus"
    if len(relances) > 1:
        defaut += (
            f", malgré {_accorder(len(relances), 'relance')} entre le "
            f"{relances[0].date:%d/%m/%Y} et le {relances[-1].date:%d/%m/%Y}"
        )
    elif relances:
        defaut += f", malgré une relance le {relances[0].date:%d/%m/%Y}"
    phrases.append(defaut + ".")

    # 3. Le paiement revenu impayé : le fait le plus parlant du dossier.
    rejets = synthese.evenements_de("Rejet de paiement")
    if len(rejets) == 1:
        phrases.append(
            f"Un paiement a été rejeté le {rejets[0].date:%d/%m/%Y} "
            f"(pièce n° {rejets[0].piece}), et le reste à charge n'a pas été "
            "régularisé depuis."
        )
    elif rejets:
        dates = ", ".join(f"{ev.date:%d/%m/%Y}" for ev in rejets[:4])
        phrases.append(
            f"{len(rejets)} paiements ont été rejetés ({dates}), et le reste "
            "à charge n'a pas été régularisé depuis."
        )

    # 4. Son attitude : ce qu'il a répondu, promis, ou pas.
    promesses = synthese.evenements_de("Annonce de paiement")
    contestations = synthese.evenements_de("Contestation")
    sujet_payeur = "Le débiteur" if corpo else "Il"
    if promesses:
        phrases.append(
            f"{sujet_payeur} a annoncé un règlement le "
            f"{promesses[-1].date:%d/%m/%Y} "
            "(pièce n° " + str(promesses[-1].piece) + "), qui n'est jamais parvenu."
        )
    if contestations:
        # Affirmer qu'aucun justificatif n'a été produit alors que le message
        # en portait un serait faux, et c'est le genre d'erreur qui se paie à
        # l'audience. On regarde donc si la pièce contestée était jointe.
        appuyee = any(
            ligne.piece_n == contestations[0].piece and ligne.nb_pieces_jointes
            for ligne in (lignes or [])
        )
        phrases.append(
            f"{sujet_payeur} conteste le montant depuis le "
            f"{contestations[0].date:%d/%m/%Y} "
            f"(pièce n° {contestations[0].piece})"
            + (", pièce à l'appui." if appuyee
               else ", sans avoir produit de justificatif.")
        )
    if synthese.derniere_reponse is None and synthese.nb_pieces:
        phrases.append(f"{sujet_payeur} n'a répondu à aucun de nos messages.")
    elif synthese.derniere_reponse is not None:
        silence = (maintenant - synthese.derniere_reponse.replace(tzinfo=None)).days
        if silence > 30 and not contestations and not promesses:
            phrases.append(
                "Sa dernière réponse remonte au "
                f"{synthese.derniere_reponse:%d/%m/%Y}, il y a {silence} jours."
            )

    # 5. Où en est le dossier aujourd'hui.
    if demeures:
        depuis = (maintenant - demeures[-1].date.replace(tzinfo=None)).days
        phrases.append(
            f"Une mise en demeure lui a été adressée le "
            f"{demeures[-1].date:%d/%m/%Y}"
            + (f", restée sans effet depuis {depuis} jours." if depuis > 0 else ".")
        )

    if piece_engagement:
        phrases.append(
            f"L'engagement est établi par une pièce du dossier : "
            f"« {piece_engagement} »."
        )



    # Ce que le service sait et que l'outil ne peut pas savoir : appels
    # téléphoniques, chèque de caution, encaissements. Saisi dans
    # l'application, repris ici tel quel.
    saisi = (getattr(dossier, "contexte", "") or "").strip()
    if saisi:
        phrases.append(saisi if saisi.endswith((".", "!", "?")) else saisi + ".")

    return " ".join(phrases)


def _accorder(combien: int, singulier: str, pluriel: str = "") -> str:
    """« 2 relances », « une relance » — jamais « 1 relance(s) ».

    Le « (s) » d'un texte engendré se voit à la première lecture, et la note
    se transmet à un avocat. Le compte est connu : l'accord se fait.
    """
    if combien == 1:
        return f"une {singulier}" if singulier[0] not in "aeiouéèh" else f"une {singulier}"
    return f"{combien} {pluriel or singulier + 's'}"


def _debiteur_est_une_entreprise(dossier) -> bool:
    """Le débiteur est-il une société plutôt que l'apprenant lui-même ?

    Sur une facture d'entreprise, celui qui suit la formation et celui qui
    doit payer sont deux personnes différentes : écrire « L'apprenant n'a pas
    payé » désigne alors la mauvaise partie, et c'est l'employeur qui sera
    assigné. La forme juridique dans la raison sociale tranche ; à défaut, on
    considère qu'il s'agit d'un particulier, qui est le cas courant.
    """
    import entreprises as module_entreprises  # noqa: PLC0415 - cycle

    nom = (getattr(dossier, "nom", "") or "").strip()
    if not nom:
        return False
    return module_entreprises.ressemble_a_une_societe(nom)


def _suite_corpo(faits: list[str]) -> str:
    """« La formation a été suivie du … au …, et le diplôme délivré. »

    Les faits sont écrits pour un sujet « L'apprenant » ; sur un dossier
    d'entreprise, la phrase change de sujet et ils doivent suivre.
    """
    reecrits = []
    for fait in faits:
        if fait.startswith("a suivi la formation du "):
            reecrits.append(fait[len("a suivi la formation"):].strip())
        elif fait.startswith("a terminé sa formation le "):
            reecrits.append("et achevée le " + fait.split("le ", 1)[1])
        elif fait == "a reçu son diplôme":
            reecrits.append("et le diplôme délivré")
        elif fait == "n'a pas obtenu son diplôme":
            reecrits.append("mais le diplôme n'a pas été délivré")
        elif fait == "a suivi la formation":
            continue
        else:
            reecrits.append(fait)
    return (" " + " ".join(reecrits)) if reecrits else ""


def _emargement_du_dossier(lignes: list[LigneIndex]) -> dict | None:
    """La feuille d'émargement du dossier, s'il en porte une."""
    for ligne in lignes:
        for nom in (ligne.pieces_jointes or "").split(" | "):
            trouve = lire_emargement(nom.strip())
            if trouve is not None:
                return trouve
    return None


def _de(nom: str) -> str:
    """« de Marie », « d'Anas » — l'élision, que l'oreille attend."""
    propre = (nom or "").strip()
    if not propre:
        return ""
    premiere = aplatir(propre)[:1]
    return ("d'" if premiere in "aeiouy" else "de ") + propre


def _enumerer(elements: list[str]) -> str:
    """« a, b et c » — une énumération qui se lit, pas une liste."""
    if not elements:
        return ""
    if len(elements) == 1:
        return elements[0]
    return ", ".join(elements[:-1]) + " et " + elements[-1]


def _nombre_heures(valeur: float) -> str:
    entier = int(valeur)
    return f"{entier} h" if valeur == entier else f"{valeur:.1f} h".replace(".", ",")


# Le résumé reprend les quatre points sous lesquels un dossier se transmet au
# service contentieux. Les intitulés sont ceux du service, et l'ordre aussi :
# la note doit pouvoir être lue par quelqu'un qui attend ce format-là.
def resumer_situation(
    dossier,
    synthese: Synthese,
    reference_temps: datetime,
    pieces_ajoutees: list[dict] | None = None,
    lignes: list[LigneIndex] | None = None,
) -> list[tuple[str, str]]:
    """Les quatre points du résumé, chacun sous son intitulé."""
    maintenant = reference_temps.replace(tzinfo=None)

    # 1. Montant.
    du = montant_lisible(dossier.montant_du)
    total = montant_lisible(dossier.montant_total)
    # Ce que le débiteur a déjà réglé. Le taire fait réclamer une somme que le
    # tableau sait partiellement payée — et c'est la première chose qu'un
    # débiteur oppose. Mieux vaut que la note le dise avant lui.
    recu = montant_lisible(getattr(dossier, "montant_recu", ""))
    if du and total and du != total:
        montant = f"{du} restant dus sur {total} facturés"
        if recu:
            montant += f", {recu} déjà réglés"
    elif du or total:
        montant = du or total
        if recu:
            montant += f" — {recu} déjà réglés"
    else:
        montant = "non renseigné au tableau de suivi"

    echeance = _date_tableau(dossier.date_echeance)
    if echeance is not None:
        retard = (maintenant - echeance).days
        montant += (
            f" — échus le {echeance:%d/%m/%Y}, soit {retard} jours de retard"
            if retard > 0 else f" — à échéance du {echeance:%d/%m/%Y}"
        )

    # 2. Contexte.
    contexte = _recit_contexte(dossier, synthese, reference_temps, lignes)

    # 3. Contrat signé et factures.
    versees = [p for p in (pieces_ajoutees or []) if p.get("fichier")]
    # Des documents, pas des envois : la même facture jointe à sept relances
    # est une pièce au dossier, pas sept. C'est le décompte qu'attend celui
    # qui vérifie ce que le dossier contient.
    extraites = sum(len(noms)
                    for _libelle, noms in classer_pieces_jointes(lignes or []))
    detail = []
    if extraites:
        detail.append(f"{_accorder(extraites, 'pièce')} "
                      + ("extraites" if extraites > 1 else "extraite")
                      + " des échanges")
    if versees:
        detail.append(f"{_accorder(len(versees), 'pièce')} "
                      + ("versées" if len(versees) > 1 else "versée")
                      + " au dossier")
    if detail:
        contrat = "voir pièces jointes — " + _enumerer(detail)
    else:
        contrat = (
            "aucune pièce au dossier. Le contrat signé et la facture sont à "
            "joindre avant transmission"
        )

    # 4. Preuve des actions engagées.
    actions: list[str] = []
    relances = synthese.evenements_de("Relance")
    if relances:
        actions.append(_accorder(len(relances), "relance"))
    for libelle, singulier, pluriel in (
        ("Mise en demeure", "mise en demeure", "mises en demeure"),
        ("Transmission au contentieux", "transmission au contentieux",
         "transmissions au contentieux"),
    ):
        combien = len(synthese.evenements_de(libelle))
        if combien:
            actions.append(_accorder(combien, singulier, pluriel))
    preuve = "voir pièces jointes"
    if actions:
        preuve += " — " + _enumerer(actions)
    if synthese.nb_envoyes:
        preuve += (
            f", sur {synthese.nb_envoyes} message"
            + ("s adressés" if synthese.nb_envoyes > 1 else " adressé")
            + " au débiteur"
        )
    rejets = synthese.evenements_de("Rejet de paiement")
    if rejets:
        preuve += (
            f". Paiements refusés, détaillés en annexe : "
            + ", ".join(f"le {ev.date:%d/%m/%Y} (pièce n° {ev.piece})" for ev in rejets)
        )
    elif not synthese.nb_pieces:
        preuve = (
            "aucun message retrouvé dans les boîtes interrogées : la relance "
            "n'est pas établie par ce dossier"
        )

    return [
        ("Montant", montant),
        ("Contexte", contexte),
        ("Contrat signé et factures", contrat),
        ("Preuve des actions engagées", preuve),
    ]


def montant_lisible(valeur: str) -> str:
    """« 2700 » → « 2 700,00 € ». Rendu tel quel si ce n'est pas un nombre."""
    brut = (valeur or "").strip().replace("€", "").replace(" ", "").replace(",", ".")
    if not brut:
        return ""
    try:
        nombre = float(brut)
    except ValueError:
        return valeur.strip()
    entier, decimales = f"{nombre:,.2f}".split(".")
    return f"{entier.replace(',', ' ')},{decimales} €"


def _date_tableau(valeur: str) -> datetime | None:
    valeur = (valeur or "").strip()[:10]
    for format_ in FORMATS_DATE_TABLEAU:
        try:
            return datetime.strptime(valeur, format_)
        except ValueError:
            continue
    return None


def _bloc_parcours(dossier) -> str:
    """Le parcours du dossier dans Monday, étape par étape et daté."""
    resume = parcours(dossier)
    if not resume["etapes"]:
        return ""

    rangees = "".join(
        "<tr>"
        f"<td>{etape['date']:%d/%m/%Y}</td>"
        f"<td>{html.escape(etape.get('de') or '—')}</td>"
        f"<td>{html.escape(etape.get('vers') or '')}</td>"
        "</tr>"
        for etape in resume["etapes"]
    )

    entete = "<p class='groupe'>Parcours du dossier</p>"
    if resume["contentieux"]:
        entete += (
            "<p>Passé au contentieux le <b>"
            f"{resume['contentieux']:%d/%m/%Y}</b>"
        )
        if resume["cloture"]:
            entete += (
                f", clôturé le <b>{resume['cloture']:%d/%m/%Y}</b> "
                f"({html.escape(resume['issue'].split('— ')[-1])})"
            )
            if resume["duree_jours"] is not None:
                entete += f", soit {resume['duree_jours']} jours de procédure"
        entete += ".</p>"

    return (
        entete
        + "<table><tr><th>Date</th><th>Étape précédente</th>"
        f"<th>Nouvelle étape</th></tr>{rangees}</table>"
        "<p class='chemin'>Dates relevées dans le journal d'activité de Monday. "
        "Ce journal n'est conservé que sur une durée limitée : les étapes les "
        "plus anciennes peuvent en être absentes.</p>"
    )


def rediger_contexte(dossier, synthese: Synthese, reference_temps: datetime) -> list[str]:
    """Situation du dossier, telle qu'elle ressort du tableau de suivi.

    Ces éléments ne viennent pas des messages : ils sont recopiés du tableau,
    seule source des montants et des dates de formation.
    """
    lignes: list[str] = []

    if dossier.formation_debut or dossier.formation_fin:
        debut = dossier.formation_debut or "?"
        fin = dossier.formation_fin or "?"
        lignes.append(f"Formation suivie du {debut} au {fin}.")

    total = montant_lisible(dossier.montant_total)
    du = montant_lisible(dossier.montant_du)
    if total and du and total != du:
        lignes.append(
            f"Facture de {total}, dont {du} restent dus à ce jour "
            "— c'est le montant en contentieux."
        )
    elif du:
        lignes.append(f"Montant en contentieux : {du}, aucun règlement enregistré.")
    elif total:
        lignes.append(f"Montant facturé : {total}.")

    echeance = _date_tableau(dossier.date_echeance)
    if echeance is not None:
        retard = (reference_temps.replace(tzinfo=None) - echeance).days
        if retard > 0:
            lignes.append(
                f"Facture échue le {echeance:%d/%m/%Y}, soit {retard} jours de retard."
            )
        else:
            lignes.append(f"Échéance de la facture : {echeance:%d/%m/%Y}.")
    elif dossier.date_echeance:
        lignes.append(f"Échéance de la facture : {dossier.date_echeance}.")

    if dossier.statut:
        lignes.append(f"Statut au tableau de suivi : {dossier.statut}.")

    return lignes


# « oui », « signée », « reçu », « 1 », « x » : un tableau tenu à la main ne
# répond jamais deux fois de la même façon. Ce qui n'est ni l'un ni l'autre
# reste inconnu, et un inconnu ne s'affiche pas comme un « non » — devant un
# tribunal, ce n'est pas la même chose.
OUI = {"oui", "o", "yes", "y", "1", "x", "vrai", "true", "signe", "signee",
       "recu", "recue", "obtenu", "obtenue", "fait", "faite", "ok"}
NON = {"non", "n", "no", "0", "faux", "false", "pas signe", "pas signee",
       "non signe", "non signee", "pas recu", "non recu", "aucun", "neant"}


# Une note de tableau s'écrit par ajouts successifs : chaque intervention
# colle sa phrase à la précédente, souvent sans séparateur. Le résultat est
# illisible dans un document qui part chez un avocat. On le remet au propre
# sans rien réécrire : découpage, majuscules, ponctuation. Aucun mot n'est
# changé, aucun n'est retiré — la note reste opposable telle qu'elle a été
# tenue.
OUVERTURES = (
    "relance faite", "relance mail", "relance", "en attente", "dit que",
    "devis", "pas de", "doit etre", "doit être", "piece d identite",
    "pièce d'identité", "a relancer", "à relancer", "vu avec", "appel",
    "mail envoye", "mail envoyé", "sans reponse", "sans réponse",
    "demande de", "reçu", "recu", "signe", "signé", "non signe", "non signé",
)


def mettre_au_propre(note: str) -> list[str]:
    """Une note de tableau, rendue lisible : une ligne par intervention."""
    texte = " ".join(str(note or "").split())
    if not texte:
        return []

    # Les entrées d'une même note sont séparées par des tirets, des
    # points-virgules ou des retours à la ligne déjà aplatis.
    morceaux = re.split(r"\s*[-–—;•]\s+|\s+[-–—]\s*", texte)

    # Deux entrées collées sans séparateur : « …par l'apprenantrelance faite ».
    # On ne coupe que devant une formule qui ouvre visiblement une entrée, et
    # seulement si ce qui précède est un mot collé — jamais au milieu d'un mot
    # ordinaire.
    decoupes: list[str] = []
    for morceau in morceaux:
        reste = morceau.strip()
        while reste:
            coupe = _premiere_ouverture(reste)
            if coupe is None:
                decoupes.append(reste)
                break
            decoupes.append(reste[:coupe].strip())
            reste = reste[coupe:].strip()

    propres: list[str] = []
    for entree in decoupes:
        entree = entree.strip(" .,;:")
        if not entree:
            continue
        entree = entree[0].upper() + entree[1:]
        propres.append(entree + ".")
    return propres


def _premiere_ouverture(texte: str) -> int | None:
    """Position d'une entrée collée à la précédente, s'il y en a une."""
    plat = aplatir(texte)
    for ouverture in OUVERTURES:
        depart = 0
        while True:
            position = plat.find(aplatir(ouverture), depart)
            if position <= 0:
                break
            avant = plat[position - 1]
            # Collée à un mot, pas précédée d'une espace ni d'un séparateur.
            if avant.isalpha() and position < len(plat) - 3:
                return position
            depart = position + 1
    return None


def _oui_non(valeur: str) -> bool | None:
    """Vrai, faux, ou rien du tout — jamais faux par défaut."""
    plat = _aplatir(valeur)
    if not plat:
        return None
    if plat in OUI:
        return True
    if plat in NON:
        return False
    # « convention signée le 12/03 » vaut oui ; « non signée » vaut non, et se
    # teste en premier pour ne pas être lu comme le « signé » qu'il contient.
    if any(marqueur in plat for marqueur in ("non ", "pas ", "sans ")):
        return False
    if any(marqueur in plat for marqueur in ("signe", "recu", "obtenu", "oui")):
        return True
    return None


def _aplatir(valeur: str) -> str:
    decompose = unicodedata.normalize("NFKD", str(valeur or "").strip().lower())
    return "".join(c for c in decompose if not unicodedata.combining(c))


def _heures(valeur: str) -> float | None:
    plat = "".join(c for c in str(valeur or "") if not c.isspace()).replace(",", ".")
    plat = plat.replace("h", "").replace("H", "")
    try:
        return float(plat)
    except ValueError:
        return None


def rediger_execution(dossier) -> list[str]:
    """Ce que le tableau de suivi sait de l'exécution de la formation.

    Devant un tribunal, une convention signée et des heures effectivement
    suivies établissent que la prestation a été fournie : c'est la première
    chose qu'on oppose à « je n'ai rien reçu ». Ce que le tableau ne dit pas
    est signalé comme tel, jamais présumé.
    """
    lignes: list[str] = []

    convention = _oui_non(getattr(dossier, "convention_signee", ""))
    if convention is True:
        lignes.append("Convention de formation signée par le débiteur.")
    elif convention is False:
        lignes.append(
            "Convention de formation non signée au tableau de suivi — "
            "à vérifier impérativement avant transmission."
        )

    diplome = _oui_non(getattr(dossier, "diplome", ""))
    if diplome is True:
        lignes.append("Diplôme délivré au terme de la formation.")
    elif diplome is False:
        lignes.append("Diplôme non délivré.")

    theoriques = _heures(getattr(dossier, "heures_theoriques", ""))
    suivies = _heures(getattr(dossier, "heures_log", ""))
    if theoriques and suivies is not None:
        part = round(100 * suivies / theoriques)
        lignes.append(
            f"Heures de connexion relevées : {suivies:g} h sur {theoriques:g} h "
            f"prévues, soit {part} % du volume horaire."
        )
    elif suivies is not None:
        lignes.append(f"Heures de connexion relevées : {suivies:g} h.")
    elif theoriques:
        lignes.append(
            f"Volume horaire prévu : {theoriques:g} h ; "
            "les heures suivies ne sont pas renseignées."
        )

    return lignes


# En dessous, ce n'est pas une conversation mais un message isolé : le
# résumer n'apprendrait rien de plus que la chronologie.
MINIMUM_PAR_FIL = 2


def _bloc_avec_titre(titre: str, contenu: str) -> str:
    """Un titre qui n'annoncerait rien vaut mieux tu."""
    return f"<h3>{html.escape(titre)}</h3>\n{contenu}" if contenu else ""


def _bloc_conversations(lignes_index: list[LigneIndex],
                        textes: dict[int, str]) -> str:
    """Les échanges, conversation par conversation, dans leur suite.

    Une relance et sa réponse forment un fil : les lire séparément oblige à
    reconstituer de tête qui a répondu à quoi. Chaque message est donc rendu
    à sa place dans sa conversation, avec ce qui y a été dit — cité, jamais
    reformulé.

    Toutes les conversations figurent, y compris celles d'un seul message :
    l'annexe remplace la chronologie, elle ne doit rien laisser de côté.
    """
    fils: dict[str, list[LigneIndex]] = {}
    for ligne in lignes_index:
        if concerne_une_autre_facture(ligne):
            continue
        cle = (ligne.thread_id or "").strip() or f"seul-{ligne.piece_n}"
        fils.setdefault(cle, []).append(ligne)

    suivis = [sorted(pieces, key=lambda p: p.date) for pieces in fils.values()]
    if not suivis:
        return ""

    suivis.sort(key=lambda pieces: pieces[0].date)
    blocs = []
    for pieces in suivis:
        premier, dernier = pieces[0], pieces[-1]
        recus = [p for p in pieces if p.sens == "reçu"]
        envoyes = [p for p in pieces if p.sens == "envoyé"]
        jours = (dernier.date - premier.date).days

        if len(pieces) == 1:
            detail = (
                f"Message unique du {premier.date:%d/%m/%Y}, "
                f"pièce n° {premier.piece_n}."
            )
        else:
            detail = (
                f"{len(pieces)} messages du {premier.date:%d/%m/%Y} au "
                f"{dernier.date:%d/%m/%Y}"
                + (f", soit {jours} jours" if jours else "")
                + f" — {len(envoyes)} émis par Liora, {len(recus)} "
                + ("reçus" if len(recus) > 1 else "reçu") + ". "
                f"Pièces n° {premier.piece_n} à n° {dernier.piece_n}."
            )

        echanges = []
        for piece in pieces:
            auteur = piece.expediteur or "—"
            entete = (
                f"pièce n° {piece.piece_n} · {piece.date:%d/%m/%Y} · "
                f"{piece.sens} · {auteur}"
                + (f" · {piece.nb_pieces_jointes} PJ"
                   if piece.nb_pieces_jointes else "")
            )
            extrait = _extrait_lisible(textes.get(piece.piece_n, ""))
            corps = (
                f'<blockquote class="propos">« {html.escape(extrait)} »</blockquote>'
                if extrait
                else '<p class="chemin">Message sans texte exploitable — '
                     "voir le fichier d'origine.</p>"
            )
            echanges.append(
                f'<div class="echange"><p class="entete-echange">'
                f"{html.escape(entete)}</p>{corps}</div>"
            )

        blocs.append(
            f"<p class='groupe'>{html.escape(premier.objet or '(sans objet)')}</p>"
            f"<p>{html.escape(detail)}</p>" + "".join(echanges)
        )

    return (
        f"<p>{_accorder(len(suivis), 'conversation')} "
        + ("figurent" if len(suivis) > 1 else "figure")
        + " au dossier, dans l'ordre où elles se sont tenues.</p>"
        + "".join(blocs)
    )


def _bloc_autres_factures(lignes_index: list[LigneIndex]) -> str:
    """Les messages du débiteur qui nomment d'autres factures que la nôtre.

    Chercher par adresse les ramène forcément. Les fondre au dossier ferait
    citer devant un juge une pièce qui parle d'une autre créance ; les
    supprimer ferait perdre ce qu'on a vu passer. Ils sont donc là, à part,
    avec le numéro qui les rattache ailleurs.
    """
    ecartes = [l for l in lignes_index if concerne_une_autre_facture(l)]
    if not ecartes:
        return ""

    rangees = "".join(
        "<tr>"
        f'<td class="piece-num">n° {ligne.piece_n}</td>'
        f"<td>{ligne.date:%d/%m/%Y}</td>"
        f"<td>{html.escape(ligne.expediteur)}</td>"
        f"<td>{html.escape(ligne.objet or '(sans objet)')}</td>"
        f"<td>{html.escape((ligne.critere or '').split(': ', 1)[-1])}</td>"
        "</tr>"
        for ligne in ecartes
    )
    return (
        f"<p>{_accorder(len(ecartes), 'message')} du même débiteur "
        + ("nomment" if len(ecartes) > 1 else "nomme")
        + " d'autres factures que celle de ce dossier. "
        + ("Ils sont" if len(ecartes) > 1 else "Il est")
        + " conservé" + ("s" if len(ecartes) > 1 else "")
        + " dans le répertoire, mais ne comptent pas parmi les pièces qui "
        "établissent cette créance.</p>"
        "<table><tr><th>Pièce</th><th>Date</th><th>De</th><th>Objet</th>"
        f"<th>Facture citée</th></tr>{rangees}</table>"
    )


def _bloc_reponses(lignes_index: list[LigneIndex], textes: dict[int, str]) -> str:
    """Les réponses du débiteur, une par une, datées et citées.

    Le décompte des relances ne dit pas ce que le débiteur a répondu, ni
    quand. Or c'est cela qu'on oppose à « je n'ai jamais eu connaissance de
    cette facture » : une réponse de sa main, à une date, sur une pièce
    numérotée. Chaque extrait est cité tel quel — jamais reformulé, sans quoi
    il ne prouverait plus rien.
    """
    recues = [ligne for ligne in lignes_index
              if ligne.sens == "reçu" and not concerne_une_autre_facture(ligne)]
    if not recues:
        return (
            "<p>Aucune réponse du débiteur ne figure dans les échanges "
            "extraits. Les relances sont restées sans retour.</p>"
        )

    rangees = []
    for ligne in recues:
        rangees.append(
            "<tr>"
            f'<td class="piece-num">n° {ligne.piece_n}</td>'
            f"<td>{ligne.date:%d/%m/%Y}</td>"
            f"<td>{html.escape(ligne.expediteur)}</td>"
            f"<td>{html.escape(ligne.objet or '(sans objet)')}</td>"
            "</tr>"
        )

    # Le propos lui-même est cité plus haut, à sa place dans la conversation :
    # le répéter ici ferait lire deux fois la même chose. Ce tableau sert à
    # retrouver d'un coup d'œil ce qui vient du débiteur, dans un dossier qui
    # peut compter quarante messages.
    return (
        f"<p>{_accorder(len(recues), 'réponse')} du débiteur "
        + ("figurent" if len(recues) > 1 else "figure")
        + " au dossier, citées plus haut dans leur conversation.</p>"
        "<table><tr><th>Pièce</th><th>Date</th><th>De</th>"
        f"<th>Objet</th></tr>{''.join(rangees)}</table>"
    )


# Assez pour situer le propos, pas assez pour remplacer la lecture de la pièce.
LONGUEUR_EXTRAIT = 320


def _texte_depuis_html(brut: str) -> str:
    """Le texte d'un message qui n'existe qu'en HTML.

    Beaucoup de messages n'ont aucune version texte : les citer sans les
    dépouiller ferait figurer « <meta http-equiv="content-type" » dans la
    note, à la place de ce que le débiteur a écrit.
    """
    texte = re.sub(r"(?is)<(script|style|head)\b.*?</\1>", " ", brut)
    # L'historique du fil est cité dans un blockquote : il s'arrête là.
    texte = re.split(r"(?i)<blockquote", texte)[0]
    texte = re.sub(r"(?i)<(br|/div|/p|/tr|/li)\s*/?>", "\n", texte)
    texte = re.sub(r"(?s)<[^>]+>", " ", texte)
    return html.unescape(texte)


# Un message sans balise n'a pas à passer par le dépouillement : « 5 < 10 »
# n'est pas du HTML, et le traiter comme tel effacerait la moitié de la phrase.
BALISE_HTML = re.compile(r"(?is)<(html|body|div|p|br|table|span|meta)\b")


def _extrait_lisible(texte: str) -> str:
    """Les premières phrases utiles d'un message, citations et signature ôtées.

    Un message de réponse commence souvent par l'historique cité du fil : le
    reprendre ferait citer nos propres relances comme si le débiteur les avait
    écrites.
    """
    brut = texte or ""
    if BALISE_HTML.search(brut):
        brut = _texte_depuis_html(brut)

    utiles: list[str] = []
    for ligne in brut.splitlines():
        propre = ligne.strip()
        if not propre or propre.startswith(">"):
            continue
        plat = _aplatir(propre)
        if plat.startswith(("le ", "de :", "a :", "envoye :", "objet :",
                            "--", "__", "cordialement", "bien a vous",
                            "bonne journee", "bonne reception")):
            continue
        if "a ecrit :" in plat or "wrote:" in plat:
            break
        utiles.append(propre)
        if sum(len(m) for m in utiles) >= LONGUEUR_EXTRAIT:
            break

    extrait = " ".join(utiles).strip()
    if len(extrait) > LONGUEUR_EXTRAIT:
        extrait = extrait[:LONGUEUR_EXTRAIT].rsplit(" ", 1)[0] + "…"
    return extrait


def resumer_echanges(dossier, synthese: Synthese, reference_temps: datetime) -> list[str]:
    """Ce que les échanges établissent du comportement du débiteur.

    C'est la partie du contexte qui vient des messages et non du tableau : les
    relances restées sans réponse, l'échéancier sollicité, le paiement annoncé
    puis non honoré, l'absence de contestation.
    """
    if not synthese.nb_pieces:
        return ["Aucun échange n'a été retrouvé pour ce dossier."]

    lignes: list[str] = []

    relances = [ev for ev in synthese.evenements_de("Relance") if ev.sens == "envoyé"]
    if relances:
        lignes.append(
            f"{_accorder(len(relances), 'relance')} "
            + ("ont été adressées" if len(relances) > 1 else "a été adressée")
            + " au débiteur, du "
            f"{relances[0].date:%d/%m/%Y} au {relances[-1].date:%d/%m/%Y}."
        )

    if synthese.derniere_reponse is None:
        lignes.append("Le débiteur n'a jamais répondu à ces sollicitations.")
    else:
        posterieures = [ev for ev in relances if ev.date > synthese.derniere_reponse]
        phrase = (
            f"Sa dernière réponse remonte au {synthese.derniere_reponse:%d/%m/%Y}"
        )
        if posterieures:
            phrase += (
                f" ; {_accorder(len(posterieures), 'relance')} "
                + ("suivantes sont restées" if len(posterieures) > 1
                   else "suivante est restée")
                + " sans réponse")
        lignes.append(phrase + ".")

    echeancier = synthese.premier_evenement("Échéancier évoqué")
    difficultes = synthese.premier_evenement("Difficultés financières invoquées")
    if echeancier and difficultes:
        lignes.append(
            f"Un étalement du paiement a été évoqué le {echeancier.date:%d/%m/%Y}, "
            "le débiteur invoquant des difficultés financières."
        )
    elif echeancier:
        lignes.append(
            f"Un étalement du paiement a été évoqué le {echeancier.date:%d/%m/%Y}."
        )
    elif difficultes:
        lignes.append(
            f"Le débiteur a invoqué des difficultés financières le "
            f"{difficultes.date:%d/%m/%Y}."
        )

    paiement = synthese.dernier_evenement("Annonce de paiement")
    if paiement:
        # Le rapprochement n'est possible que parce que le solde vient du
        # tableau : les messages seuls ne diraient pas s'il a été honoré.
        reste = montant_lisible(dossier.montant_du)
        if reste:
            lignes.append(
                f"Un paiement a été annoncé le {paiement.date:%d/%m/%Y}, alors que "
                f"{reste} restent portés au solde du tableau de suivi."
            )
        else:
            lignes.append(
                f"Un paiement a été annoncé le {paiement.date:%d/%m/%Y} — "
                "à rapprocher des encaissements réels."
            )

    demeure = synthese.dernier_evenement("Mise en demeure")
    if demeure:
        lignes.append(f"Une mise en demeure a été adressée le {demeure.date:%d/%m/%Y}.")

    if synthese.premier_evenement("Contestation") is None:
        lignes.append(
            "À aucun moment le montant ou la prestation n'ont été contestés dans "
            "les échanges."
        )

    if synthese.dernier is not None:
        silence = synthese.jours_depuis(synthese.dernier, reference_temps)
        lignes.append(f"Plus aucun échange depuis {silence} jours.")

    return lignes


# Étapes du process de recouvrement reconnues dans l'historique Monday.
# Repérées sur le libellé mis à plat : « 🔴 Dossier à faire passer en
# contentieux » et « Dossier à transmettre au service contentieux » désignent
# le même passage, sous deux tableaux différents.
ETAPES_MARQUANTES = (
    ("Passage au contentieux", ("contentieux",)),
    ("Clôture — montant récupéré", ("termine montant recup", "termine montant recupere")),
    ("Clôture — montant perdu", ("termine montant perdu",)),
)


def qualifier_etape(libelle: str) -> str:
    """Le nom d'étape marquante correspondant à un libellé Monday, s'il y en a."""
    plat = aplatir(libelle)
    if "termine" in plat and ("recup" in plat or "recouvr" in plat):
        return "Clôture — montant récupéré"
    if "termine" in plat and "perdu" in plat:
        return "Clôture — montant perdu"
    if "contentieux" in plat:
        return "Passage au contentieux"
    return ""


def parcours(dossier) -> dict:
    """Dates clés du parcours, telles que le journal Monday les établit."""
    etapes = [e for e in getattr(dossier, "etapes", []) if e.get("date")]
    resume = {
        "etapes": etapes,
        "contentieux": None,
        "cloture": None,
        "issue": "",
        "duree_jours": None,
    }
    if not etapes:
        return resume

    for etape in etapes:
        qualification = qualifier_etape(etape.get("vers", ""))
        if qualification == "Passage au contentieux" and resume["contentieux"] is None:
            resume["contentieux"] = etape["date"]
        elif qualification.startswith("Clôture"):
            resume["cloture"] = etape["date"]
            resume["issue"] = qualification

    if resume["contentieux"] and resume["cloture"]:
        resume["duree_jours"] = (resume["cloture"] - resume["contentieux"]).days
    return resume


# Une feuille d'émargement ne porte le mot nulle part : elle est nommée du
# nom de l'apprenant suivi des deux dates de la formation, et d'un
# identifiant. C'est sa forme qui la désigne, pas un mot-clé.
#   Anas_AIT_BELAID_02_09_2024_31_12_2025_880ceucmlwnozdz_1.pdf
#
# La pièce vaut son pesant : elle établit la présence effective, séance par
# séance, signature à l'appui — bien davantage que des heures de connexion.
MOTIF_EMARGEMENT = re.compile(
    r"^(?P<qui>.+?)_(?P<d1>\d{2})_(?P<m1>\d{2})_(?P<a1>\d{4})"
    r"_(?P<d2>\d{2})_(?P<m2>\d{2})_(?P<a2>\d{4})(?:_|\.)",
    re.IGNORECASE,
)


def lire_emargement(nom: str) -> dict | None:
    """L'apprenant et la période que porte le nom d'une feuille d'émargement."""
    trouve = MOTIF_EMARGEMENT.match((nom or "").strip())
    if trouve is None:
        return None
    return {
        "apprenant": " ".join(trouve.group("qui").replace("_", " ").split()),
        "debut": f"{trouve['d1']}/{trouve['m1']}/{trouve['a1']}",
        "fin": f"{trouve['d2']}/{trouve['m2']}/{trouve['a2']}",
        "fichier": nom,
    }


# Les heures écrites dans une feuille d'émargement.
#
# Rien n'est déduit ni additionné : on ne retient qu'un nombre que le document
# énonce lui-même sous une étiquette explicite. Devant un tribunal, des heures
# de présence établissent que la formation a été délivrée — et une heure
# inventée par une addition maladroite ferait plus de tort que la colonne vide
# qu'elle remplace.
ETIQUETTES_HEURES = (
    r"nombre\s+(?:total\s+)?d[e']\s*heures?(?:\s+de\s+\w+)?",
    r"total\s+(?:des\s+)?heures?",
    r"heures?\s+de\s+pr[ée]sence",
    r"heures?\s+effectu[ée]es?",
    r"heures?\s+r[ée]alis[ée]es?",
    r"dur[ée]e\s+(?:totale|de\s+la\s+formation)",
    r"volume\s+horaire(?:\s+(?:total|r[ée]alis[ée]))?",
)

# « 42 », « 42h », « 42 h 30 », « 42,5 » — jamais un pourcentage ni une date.
MOTIF_HEURES = re.compile(
    r"(?P<heures>\d{1,4}(?:[.,]\d{1,2})?)\s*(?:h(?:eures?)?\b\s*(?P<minutes>[0-5]?\d)?|\b)",
    re.IGNORECASE,
)


def heures_de_l_emargement(chemin: Path) -> str:
    """Les heures que la feuille d'émargement énonce, ou rien.

    Rien de deviné : sans étiquette explicite, la fonction ne renvoie rien et
    la colonne reste vide. C'est le seul comportement acceptable pour une
    valeur qui peut être opposée à un débiteur.
    """
    import facture_pdf as module_facture  # noqa: PLC0415 - import tardif

    try:
        texte = module_facture.texte_du_pdf(Path(chemin))
    except (OSError, ValueError):
        return ""
    if not texte:
        return ""

    plat = " ".join(texte.split())
    for etiquette in ETIQUETTES_HEURES:
        for trouve in re.finditer(etiquette + r"\s*:?\s*", plat, re.IGNORECASE):
            suite = plat[trouve.end():trouve.end() + 24]
            nombre = MOTIF_HEURES.match(suite)
            if nombre is None:
                continue
            heures = nombre.group("heures").replace(",", ".")
            try:
                valeur = float(heures)
            except ValueError:
                continue
            # Une formation de plus de mille heures ou de zéro heure n'est pas
            # une lecture, c'est un faux positif — un identifiant, une année.
            if not 0 < valeur <= 1000:
                continue
            minutes = nombre.group("minutes")
            if minutes and int(minutes):
                valeur += int(minutes) / 60
            return f"{valeur:g}"
    return ""


CATEGORIES_PIECES = (
    ("Contrat / convention", ("convention", "contrat", "cgv", "devis", "bon de commande")),
    ("Facture / avoir", ("facture", "fact-", "fact_", "avoir", "invoice")),
    ("Mise en demeure / relance", ("demeure", "relance", "recommande", "lrar")),
    ("Échéancier", ("echeancier", "echelonn")),
)


# Un devis signé au nom de l'apprenant vaut engagement : c'est la pièce qu'on
# oppose à « je n'ai jamais rien signé ». Le service le sait et le compte comme
# une convention ; l'outil doit le voir aussi, sans quoi la note annonce
# « aucune convention » alors que la preuve est au dossier.
MOTS_ENGAGEMENT = ("convention", "contrat", "devis", "bon de commande",
                   "bon pour accord", "signe", "signee", "signature")


def convention_dans_les_pieces(lignes: list[LigneIndex], apprenant: str = "") -> str:
    """Le nom d'une pièce qui établit l'engagement, s'il y en a une.

    Le nom du fichier suffit : il n'est pas ouvert. Un « devis signé » nommé
    ainsi est une pièce du dossier ; ce qu'il contient reste à vérifier avant
    transmission, et la note le dit.
    """
    plat_apprenant = aplatir(apprenant) if apprenant else ""
    mots_apprenant = [m for m in plat_apprenant.split() if len(m) > 2]

    for ligne in lignes:
        for nom in (ligne.pieces_jointes or "").split(" | "):
            nom = nom.strip()
            if not nom:
                continue
            plat = aplatir(nom)
            if not any(mot in plat for mot in MOTS_ENGAGEMENT):
                continue
            # Le nom de l'apprenant dans le fichier lève le doute : « devis
            # signé Benallaoua » désigne ce dossier-ci et pas un autre. À
            # défaut, une pièce nommée « convention » ou « contrat » suffit ;
            # un simple « devis » sans nom, non — un devis non signé ne
            # prouve aucun engagement.
            if mots_apprenant and all(mot in plat for mot in mots_apprenant):
                return nom
            if any(mot in plat for mot in ("convention", "contrat")):
                return nom
            if "sign" in plat and any(
                    mot in plat for mot in ("devis", "bon de commande")):
                return nom
    return ""


def classer_pieces_jointes(lignes: list[LigneIndex]) -> list[tuple[str, list[str]]]:
    """Regroupe les pièces jointes par nature, d'après leur nom de fichier.

    Un document est cité une fois, avec les pièces où il figure. La même
    facture jointe à sept relances donnait sept lignes identiques : la liste
    ne disait plus quels documents composent le dossier, seulement combien de
    fois ils ont été envoyés — ce qui se lit déjà dans la chronologie.
    """
    # {catégorie: {clé du fichier: (nom affiché, [numéros de pièce])}}
    groupes: dict[str, dict[str, tuple[str, list[int]]]] = {}
    for ligne in lignes:
        for nom in (ligne.pieces_jointes or "").split(" | "):
            nom = nom.strip()
            if not nom:
                continue
            plat = aplatir(nom)
            if lire_emargement(nom) is not None:
                categorie = "Feuille d'émargement"
            else:
                categorie = "Autre document"
                for libelle, motifs in CATEGORIES_PIECES:
                    if any(motif in plat for motif in motifs):
                        categorie = libelle
                        break
            documents = groupes.setdefault(categorie, {})
            _affiche, numeros = documents.setdefault(plat, (nom, []))
            if ligne.piece_n not in numeros:
                numeros.append(ligne.piece_n)

    ordre = ([libelle for libelle, _ in CATEGORIES_PIECES]
             + ["Feuille d'émargement", "Autre document"])
    return [
        (libelle, [
            f"{nom} ({_pieces_citees(numeros)})"
            for nom, numeros in groupes[libelle].values()
        ])
        for libelle in ordre if libelle in groupes
    ]


def _pieces_citees(numeros: list[int]) -> str:
    """« pièce n° 3 », « pièces n° 1, 2 et 9 » — jamais « pièce n° 1, 2 »."""
    numeros = sorted(numeros)
    if len(numeros) == 1:
        return f"pièce n° {numeros[0]}"
    liste = ", ".join(str(numero) for numero in numeros[:-1])
    return f"pièces n° {liste} et {numeros[-1]}"


def _valeurs_de_ligne(valeur: str | None) -> set[str]:
    return {
        morceau.strip().lower()
        for morceau in (valeur or "").split(" | ")
        if morceau.strip()
    }


def factures_de_ligne(ligne: LigneIndex) -> set[str]:
    return _valeurs_de_ligne(ligne.factures_concernees)


def adresses_de_ligne(ligne: LigneIndex) -> set[str]:
    return _valeurs_de_ligne(ligne.adresses_concernees)


def _pieces_retenues(
    voulues: list[str], lignes: list[LigneIndex], extraire
) -> list[LigneIndex]:
    """Pièces à verser à un sous-dossier.

    Deux ensembles s'y retrouvent : les échanges qui désignent explicitement
    la facture (ou l'adresse) du sous-dossier, et ceux qui n'en désignent
    aucune. Une relance qui ne cite aucun numéro vaut pour toutes les factures
    du débiteur, et un message où aucune de ses adresses n'apparaît en en-tête
    le concerne quand même — l'écarter viderait chaque sous-dossier de
    l'essentiel de sa preuve. Seuls sont exclus les échanges qui ne relèvent
    que d'une autre facture, ou que d'une autre adresse.
    """
    cibles = {valeur.strip().lower() for valeur in voulues if valeur.strip()}
    retenues = []
    for ligne in lignes:
        designees = extraire(ligne)
        if not designees or designees & cibles:
            retenues.append(ligne)
    return retenues


def pieces_de_facture(factures: list[str], lignes: list[LigneIndex]) -> list[LigneIndex]:
    return _pieces_retenues(factures, lignes, factures_de_ligne)


def pieces_de_adresse(adresses: list[str], lignes: list[LigneIndex]) -> list[LigneIndex]:
    return _pieces_retenues(adresses, lignes, adresses_de_ligne)


def _repartir(
    sous_dossiers, lignes: list[LigneIndex], designer, selectionner
) -> list[tuple[str, str, list[LigneIndex]]]:
    """(libellé, nom de répertoire, pièces) pour chaque sous-dossier.

    Les noms de répertoire sont rendus uniques : deux lignes du tableau
    peuvent porter le même numéro de facture, et elles écriraient au même
    endroit.
    """
    from rendu import slug  # noqa: PLC0415 - évite une dépendance circulaire

    resultat: list[tuple[str, str, list[LigneIndex]]] = []
    noms_utilises: set[str] = set()

    for position, sous_dossier in enumerate(sous_dossiers, start=1):
        libelle, valeurs = designer(sous_dossier)
        nom = slug(libelle or f"vue-{position}", 40)
        if nom in noms_utilises:
            nom = f"{nom}-{position:02d}"
        noms_utilises.add(nom)
        resultat.append((libelle, nom, selectionner(valeurs, lignes)))
    return resultat


def repartition_par_facture(
    sous_dossiers, lignes: list[LigneIndex]
) -> list[tuple[str, str, list[LigneIndex]]]:
    return _repartir(
        sous_dossiers,
        lignes,
        lambda sous: (
            sous.factures[0] if sous.factures else sous.reference, sous.factures
        ),
        pieces_de_facture,
    )


def repartition_par_adresse(
    sous_dossiers, lignes: list[LigneIndex]
) -> list[tuple[str, str, list[LigneIndex]]]:
    return _repartir(
        sous_dossiers,
        lignes,
        lambda sous: (sous.emails[0] if sous.emails else sous.reference, sous.emails),
        pieces_de_adresse,
    )


def _rangee_chronologie(ligne: LigneIndex) -> str:
    pieces = f"{ligne.nb_pieces_jointes} PJ" if ligne.nb_pieces_jointes else ""
    return (
        f"<tr><td>{ligne.piece_n}</td>"
        f"<td>{ligne.date:%d/%m/%Y}</td>"
        f"<td>{html.escape(ligne.sens)}</td>"
        f"<td>{html.escape(ligne.objet[:90])}</td>"
        f"<td>{pieces}</td></tr>"
    )


def _bloc_repartition(dossier, lignes: list[LigneIndex], vues: set[str]) -> str:
    """Tableaux des sous-dossiers produits, avec leur volume d'échanges."""
    blocs = ""

    repartir = getattr(dossier, "repartition_par_facture", None)
    par_facture = repartir() if "factures" in vues and callable(repartir) else []
    if par_facture:
        rangees = []
        for numero, nom, pieces in repartition_par_facture(par_facture, lignes):
            sous = next(
                (s for s in par_facture if s.factures and s.factures[0] == numero), None
            )
            designees = sum(
                1 for ligne in pieces if numero.lower() in factures_de_ligne(ligne)
            )
            rangees.append(
                f"<tr><td>{html.escape(numero or '—')}</td>"
                f"<td>{html.escape(montant_lisible(getattr(sous, 'montant_du', '') or '') or '—')}</td>"
                f"<td>{len(pieces)} dont {designees} la nommant</td>"
                f"<td>{_periode(pieces)}</td>"
                f"<td>factures/{html.escape(nom)}</td></tr>"
            )
        blocs += (
            "<h3>Répartition par facture</h3>"
            f"<p>Ce débiteur porte {len(par_facture)} factures en retard. Le présent "
            "dossier les réunit, et le sous-répertoire <b>factures</b> en donne un "
            "sous-dossier complet par facture, transmissible seul : chacun contient "
            "sa propre note de synthèse, sa chronologie, les messages et les pièces "
            "jointes correspondants.</p>"
            "<table><tr><th>Facture</th><th>Reste dû</th><th>Échanges versés</th>"
            f"<th>Période</th><th>Sous-dossier</th></tr>{''.join(rangees)}</table>"
            "<p class='chemin'>Un échange qui ne nomme aucune facture — relance "
            "générale, réponse de l'apprenante — est versé à <b>tous</b> les "
            "sous-dossiers : il vaut pour l'ensemble de la dette. Un échange qui "
            "nomme une facture précise n'est versé qu'à celle-ci. Les numéros de "
            "pièce restent ceux du présent dossier, d'un sous-dossier à l'autre.</p>"
        )

    repartir = getattr(dossier, "repartition_par_adresse", None)
    par_adresse = repartir() if "adresses" in vues and callable(repartir) else []
    if par_adresse:
        rangees = []
        for adresse, nom, pieces in repartition_par_adresse(par_adresse, lignes):
            designees = sum(
                1 for ligne in pieces if adresse.lower() in adresses_de_ligne(ligne)
            )
            rangees.append(
                f"<tr><td>{html.escape(adresse or '—')}</td>"
                f"<td>{len(pieces)} dont {designees} l'ayant en en-tête</td>"
                f"<td>{_periode(pieces)}</td>"
                f"<td>adresses/{html.escape(nom)}</td></tr>"
            )
        blocs += (
            "<h3>Répartition par adresse mail</h3>"
            f"<p>Les échanges se répartissent sur {len(par_adresse)} adresses. Le "
            "sous-répertoire <b>adresses</b> en donne une vue par adresse, chacune "
            "complète et transmissible seule. Les montants n'y sont pas répartis : "
            "une adresse ne porte pas une part de la dette, c'est la même dette vue "
            "par un autre canal d'échange.</p>"
            "<table><tr><th>Adresse</th><th>Échanges versés</th><th>Période</th>"
            f"<th>Sous-dossier</th></tr>{''.join(rangees)}</table>"
            "<p class='chemin'>Le rattachement se fait sur les en-têtes du message "
            "— expéditeur, destinataires, copies — et non sur son corps : une "
            "adresse recopiée dans une citation ne fait pas de son titulaire une "
            "partie à l'échange. Un message où aucune adresse du dossier n'apparaît "
            "en en-tête est versé à toutes les vues.</p>"
        )

    return blocs


def _periode(pieces: list[LigneIndex]) -> str:
    dates = [ligne.date for ligne in pieces]
    if not dates:
        return "aucun échange"
    return f"{min(dates):%d/%m/%Y} → {max(dates):%d/%m/%Y}"


def construire_html(
    dossier,
    boites: list[str],
    lignes: list[LigneIndex],
    synthese: Synthese,
    date_export: datetime,
    documents_monday: list[str] | None = None,
    rattachement: str = "",
    note_vue: str = "",
    vues: set[str] | None = None,
    textes: dict[int, str] | None = None,
    pieces_ajoutees: list[dict] | None = None,
    date_note: datetime | None = None,
) -> str:
    constats = rediger_constats(synthese, date_export)
    contexte = rediger_contexte(dossier, synthese, date_export)
    echanges = resumer_echanges(dossier, synthese, date_export)
    situation = resumer_situation(
        dossier, synthese, date_export, pieces_ajoutees, lignes)
    pieces = classer_pieces_jointes(lignes)

    trajet = parcours(dossier)

    identite = [
        ("Débiteur", dossier.nom or "—"),
        ("Adresses mail" if len(dossier.emails) > 1 else "Adresse mail",
         " | ".join(dossier.emails) or "—"),
        ("Factures" if len(dossier.factures) > 1 else "Facture",
         " | ".join(dossier.factures) or "—"),
        ("Boîtes interrogées", ", ".join(boites)),
        ("Date d'extraction", date_export.strftime("%d/%m/%Y à %H:%M")),
    ]
    # Une note refaite portait la date du jour comme date d'extraction, ce qui
    # était faux — aucun message n'avait été relu — et surtout indiscernable :
    # rien ne disait si le fichier ouvert était celui d'avant ou celui d'après.
    # Deux dates, chacune la sienne.
    if date_note is not None:
        identite.append(
            ("Note rédigée le", date_note.strftime("%d/%m/%Y à %H:%M")))
    if trajet["contentieux"]:
        identite.insert(
            3, ("Passé au contentieux le", f"{trajet['contentieux']:%d/%m/%Y}")
        )
    if trajet["cloture"]:
        identite.insert(
            4,
            (
                "Clôturé le",
                f"{trajet['cloture']:%d/%m/%Y} — {trajet['issue'].split('— ')[-1]}",
            ),
        )
    if rattachement:
        identite.insert(
            3, ("Rattaché au dossier", rattachement)
        )
    rangees_identite = "".join(
        f'<tr><td class="cle">{html.escape(cle)}</td><td>{html.escape(str(valeur))}</td></tr>'
        for cle, valeur in identite
    )

    chiffres = [
        (synthese.nb_pieces, "pièces"),
        (synthese.nb_envoyes, "émis par Liora"),
        (synthese.nb_recus, "reçus"),
        (synthese.nb_pieces_jointes, "pièces jointes"),
        (synthese.duree_jours, "jours couverts"),
    ]
    rangees_chiffres = "".join(
        f'<td><div class="valeur">{valeur}</div>'
        f'<div class="libelle">{html.escape(libelle)}</div></td>'
        for valeur, libelle in chiffres
    )

    if synthese.evenements:
        rangees_evenements = "".join(
            f"<tr><td>{ev.date:%d/%m/%Y}</td><td>{html.escape(ev.libelle)}</td>"
            f"<td>{html.escape(ev.sens)}</td>"
            f'<td class="piece-num">pièce n° {ev.piece}</td></tr>'
            for ev in synthese.evenements
        )
        bloc_evenements = (
            "<table><tr><th>Date</th><th>Événement</th><th>Sens</th>"
            f"<th>Référence</th></tr>{rangees_evenements}</table>"
        )
    else:
        bloc_evenements = (
            "<p>Aucun événement caractéristique n'a été repéré automatiquement "
            "dans les échanges. La chronologie complète reste à consulter "
            "ci-dessous.</p>"
        )

    note_doublons = ""
    if synthese.doublons_ecartes:
        note_doublons = (
            f" {synthese.doublons_ecartes} message"
            f"{'s présents' if synthese.doublons_ecartes > 1 else ' présent'} "
            "dans plusieurs "
            "boîtes n'ont été retenus qu'une fois."
        )

    montant = montant_lisible(dossier.montant_du) or montant_lisible(dossier.montant_total)
    bandeau_montant = (
        f'<div class="montant"><span>Montant en contentieux</span>'
        f"<b>{html.escape(montant)}</b></div>"
        if montant
        else '<div class="montant manquant"><span>Montant en contentieux</span>'
        "<b>non renseigné au tableau de suivi</b></div>"
    )

    if contexte:
        bloc_contexte = (
            '<p class="groupe">Situation au tableau de suivi</p><ul class="constats">'
            + "".join(f"<li>{html.escape(ligne)}</li>" for ligne in contexte)
            + "</ul>"
        )
    else:
        bloc_contexte = (
            "<p>Le tableau de suivi ne renseigne ni montant, ni dates, ni statut "
            "pour ce dossier. À compléter avant transmission.</p>"
        )

    bloc_contexte += (
        '<p class="groupe">Ce que montrent les échanges</p><ul class="constats">'
        + "".join(f"<li>{html.escape(ligne)}</li>" for ligne in echanges)
        + "</ul>"
    )

    execution = rediger_execution(dossier)
    if execution:
        bloc_contexte += (
            '<p class="groupe">Exécution de la formation</p><ul class="constats">'
            + "".join(f"<li>{html.escape(ligne)}</li>" for ligne in execution)
            + "</ul>"
        )

    bloc_contexte += _bloc_parcours(dossier)

    entrees_note = mettre_au_propre(dossier.commentaire)
    if entrees_note:
        bloc_contexte += (
            '<div class="interne"><b>Note interne du tableau de suivi</b> — '
            "reprise sans qu'aucun mot en soit changé, à relire avant "
            "transmission :"
            "<ul class='constats'>"
            + "".join(f"<li>{html.escape(entree)}</li>" for entree in entrees_note)
            + "</ul></div>"
        )

    # Trois sources indépendantes, cumulables : les pièces extraites des
    # messages, les documents téléchargés depuis Monday, et à défaut les liens
    # vers ceux qui n'ont pas pu l'être. Chacune s'ajoute — aucune ne remplace
    # les autres.
    bloc_pieces = ""

    if pieces:
        bloc_pieces += "".join(
            f"<p class='groupe'>{html.escape(libelle)}</p><ul class='constats'>"
            + "".join(f"<li>{html.escape(nom)}</li>" for nom in noms)
            + "</ul>"
            for libelle, noms in pieces
        )
        bloc_pieces += (
            "<p class='chemin'>Les fichiers correspondants se trouvent dans le "
            "sous-répertoire <b>pieces-jointes</b> du dossier, rangés par pièce.</p>"
        )

    # Le même fichier téléchargé depuis Monday et déjà extrait d'un message
    # ne se cite pas deux fois : c'est un seul document. On garde la version
    # extraite des échanges, qui est la plus forte des deux — elle établit
    # que la pièce a été transmise au débiteur, pas seulement qu'elle existe.
    deja_extraites = {
        aplatir(nom.rsplit(" (", 1)[0])
        for _libelle, noms in pieces for nom in noms
    }
    telecharges = [
        nom for nom in (documents_monday or [])
        if aplatir(nom) not in deja_extraites
    ]
    liens = [lien for lien in getattr(dossier, "liens", []) if lien]

    if telecharges:
        bloc_pieces += (
            "<p class='groupe'>Documents issus du tableau de suivi</p>"
            "<ul class='constats'>"
            + "".join(f"<li>{html.escape(nom)}</li>" for nom in telecharges)
            + "</ul><p class='chemin'>Ces fichiers ont été téléchargés depuis Monday "
            "et rangés dans le sous-répertoire <b>documents-monday</b>. Ils sont "
            "tenus à l'écart des pièces ci-dessus : un document produit depuis le "
            "tableau atteste de son existence, tandis qu'une pièce extraite d'un "
            "message établit qu'elle a bien été transmise au débiteur.</p>"
        )
    elif liens:
        bloc_pieces += (
            "<p class='groupe'>Documents référencés dans le tableau de suivi</p>"
            "<ul class='constats'>"
            + "".join(f"<li>{html.escape(lien)}</li>" for lien in liens)
            + "</ul><p class='chemin'>Ces documents sont stockés dans Monday et n'ont "
            "pas été téléchargés. Rappel : un document produit depuis le tableau "
            "atteste de son existence, pas de sa transmission au débiteur.</p>"
        )

    # Ce que le service verse lui-même au dossier : relevé comptable,
    # convention signée, facture. Elles sont rangées sous leur nature, comme
    # les pièces extraites des messages, et sans mention de leur provenance :
    # la note est un document qui se transmet, et le service n'a pas à y
    # commenter sa propre façon de constituer le dossier.
    ajoutees = [p for p in (pieces_ajoutees or []) if p.get("fichier")]
    if ajoutees:
        par_nature: dict[str, list[str]] = {}
        for piece in ajoutees:
            nature = (piece.get("nature") or "Pièce versée").strip()
            par_nature.setdefault(nature, []).append(piece.get("fichier", ""))
        bloc_pieces += "".join(
            f"<p class='groupe'>{html.escape(nature)}</p><ul class='constats'>"
            + "".join(f"<li>{html.escape(nom)}</li>" for nom in noms)
            + "</ul>"
            for nature, noms in par_nature.items()
        )

    if not bloc_pieces:
        bloc_pieces = (
            "<p>Aucune pièce jointe dans les échanges extraits. Le contrat signé "
            "et les factures devront être joints depuis une autre source.</p>"
        )

    return f"""<!DOCTYPE html>
<html lang="fr"><head><meta charset="utf-8" />
<title>Dossier de recouvrement — {html.escape(dossier.reference)}</title>
<style>{FEUILLE_DE_STYLE}</style></head>
<body>
<div class="entete">
<h1>Dossier de recouvrement</h1>
<div class="sous-titre">{html.escape(dossier.nom or 'Débiteur non renseigné')}
 &nbsp;·&nbsp; {html.escape(dossier.reference)}</div>
</div>

{bandeau_montant}
<table class="identite">{rangees_identite}</table>
{f'<p class="chemin">{html.escape(note_vue)}</p>' if note_vue else ''}

<h2>1. Résumé de la situation</h2>
<ol class="resume">
{''.join(f'<li><b>{html.escape(titre)}</b> : {html.escape(corps)}</li>'
         for titre, corps in situation)}
</ol>

<h2>2. Détail du dossier</h2>
{bloc_contexte}

<h2>3. Contrat signé et factures</h2>
{bloc_pieces}

<h2>4. Preuve des actions engagées</h2>
<table class="chiffres"><tr>{rangees_chiffres}</tr></table>

{_bloc_repartition(dossier, lignes, vues if vues is not None else {"factures"})}

<h3>Constats</h3>
<ul class="constats">
{''.join(f'<li>{html.escape(constat)}</li>' for constat in constats)}
</ul>

<h3>Événements repérés</h3>
{bloc_evenements}

<div class="avertissement">
<b>Portée de ce document.</b> Le résumé de la partie 1 ne fait que reprendre ce
qu'établissent les parties suivantes ; il ne s'y ajoute rien. Les montants,
dates de formation, statuts et notes de la partie 2 sont recopiés du tableau
de suivi. Les parties 3 et 4, ainsi que l'annexe, sont établies à partir des
seuls messages extraits des boîtes citées ci-dessus, sans autre
source.{note_doublons}
</div>

<div class="annexe">
<h2>Annexe — Conversations</h2>
<p class="chemin">Les échanges sont reportés ici pour ne pas alourdir la note.
Chaque numéro de pièce renvoie au message d'origine, conservé dans le dossier.</p>

{_bloc_avec_titre("A. Suite des échanges",
                  _bloc_conversations(lignes, textes or {}))}

<h3>B. Réponses du débiteur</h3>
{_bloc_reponses(lignes, textes or {})}

{_bloc_avec_titre("C. Messages écartés — autres factures du même débiteur",
                  _bloc_autres_factures(lignes))}
</div>
</body></html>
"""
