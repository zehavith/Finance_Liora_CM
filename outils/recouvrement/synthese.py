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


def analyser(lignes: list[LigneIndex], textes: dict[int, str], doublons: int = 0) -> Synthese:
    """Construit la synthèse à partir de l'index et du texte de chaque pièce."""
    synthese = Synthese(nb_pieces=len(lignes), doublons_ecartes=doublons)

    for ligne in lignes:
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
        f"Le dossier réunit {synthese.nb_pieces} pièce(s), "
        f"du {synthese.premier:%d/%m/%Y} au {synthese.dernier:%d/%m/%Y} "
        f"(soit {synthese.duree_jours} jours), dont {synthese.nb_envoyes} "
        f"message(s) émis par Liora et {synthese.nb_recus} reçu(s)."
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
            f"{len(relances)} relance(s) ont été adressées à l'apprenante "
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
            "Aucune mise en demeure n'apparaît dans les échanges extraits — "
            "à vérifier avant transmission au contentieux."
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
                f"{len(posterieures)} relance(s) sont restées sans réponse depuis "
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
@page { size: A4; margin: 16mm 14mm; }
body { font-family: Helvetica, Arial, sans-serif; font-size: 10pt; color: #111; }
h1 { font-size: 15pt; margin: 0 0 2px 0; }
h2 { font-size: 11.5pt; margin: 18px 0 6px 0; border-bottom: 1px solid #999;
     padding-bottom: 3px; }
.sous-titre { color: #555; font-size: 9pt; margin-bottom: 14px; }
table { width: 100%; border-collapse: collapse; margin-bottom: 6px; }
td, th { padding: 3px 5px; font-size: 8.5pt; text-align: left; vertical-align: top;
         border-bottom: 1px solid #ddd; }
th { background: #eee; font-size: 8.5pt; }
.identite td.cle { width: 130px; color: #444; font-weight: bold; border-bottom: none; }
.identite td { border-bottom: none; }
.chiffres td { text-align: center; border: 1px solid #ccc; }
.chiffres .valeur { font-size: 14pt; font-weight: bold; }
.chiffres .libelle { font-size: 7.5pt; color: #555; }
ul.constats { margin: 4px 0 0 0; padding-left: 16px; }
ul.constats li { margin-bottom: 5px; font-size: 9.5pt; }
.piece-num { color: #555; white-space: nowrap; }
.avertissement { margin-top: 20px; border: 1px solid #999; padding: 8px;
                 font-size: 8pt; color: #444; }
"""


FORMATS_DATE_TABLEAU = ("%d/%m/%Y", "%Y-%m-%d", "%d-%m-%Y", "%Y/%m/%d", "%d/%m/%y")


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
            f"{len(relances)} relance(s) ont été adressées au débiteur, du "
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
            phrase += f" ; les {len(posterieures)} relance(s) suivantes sont restées sans réponse"
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


CATEGORIES_PIECES = (
    ("Contrat / convention", ("convention", "contrat", "cgv", "devis", "bon de commande")),
    ("Facture / avoir", ("facture", "fact-", "fact_", "avoir", "invoice")),
    ("Mise en demeure / relance", ("demeure", "relance", "recommande", "lrar")),
    ("Échéancier", ("echeancier", "echelonn")),
)


def classer_pieces_jointes(lignes: list[LigneIndex]) -> list[tuple[str, list[str]]]:
    """Regroupe les pièces jointes par nature, d'après leur nom de fichier."""
    groupes: dict[str, list[str]] = {}
    for ligne in lignes:
        for nom in (ligne.pieces_jointes or "").split(" | "):
            nom = nom.strip()
            if not nom:
                continue
            plat = aplatir(nom)
            categorie = "Autre document"
            for libelle, motifs in CATEGORIES_PIECES:
                if any(motif in plat for motif in motifs):
                    categorie = libelle
                    break
            groupes.setdefault(categorie, []).append(f"{nom} (pièce n° {ligne.piece_n})")

    ordre = [libelle for libelle, _ in CATEGORIES_PIECES] + ["Autre document"]
    return [(libelle, groupes[libelle]) for libelle in ordre if libelle in groupes]


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
) -> str:
    constats = rediger_constats(synthese, date_export)
    contexte = rediger_contexte(dossier, synthese, date_export)
    echanges = resumer_echanges(dossier, synthese, date_export)
    pieces = classer_pieces_jointes(lignes)

    trajet = parcours(dossier)

    identite = [
        ("Débiteur", dossier.nom or "—"),
        ("Adresse(s) mail", " | ".join(dossier.emails) or "—"),
        ("Facture(s)", " | ".join(dossier.factures) or "—"),
        ("Boîtes interrogées", ", ".join(boites)),
        ("Date d'extraction", date_export.strftime("%d/%m/%Y à %H:%M")),
    ]
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
            f" {synthese.doublons_ecartes} message(s) présents dans plusieurs "
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

    if dossier.commentaire:
        bloc_contexte += (
            '<div class="interne"><b>Note interne du tableau de suivi</b> — '
            "reproduite telle quelle, à relire avant transmission :<br />"
            f"« {html.escape(dossier.commentaire)} »</div>"
        )

    if pieces:
        bloc_pieces = "".join(
            f"<p class='groupe'>{html.escape(libelle)}</p><ul class='constats'>"
            + "".join(f"<li>{html.escape(nom)}</li>" for nom in noms)
            + "</ul>"
            for libelle, noms in pieces
        )
        bloc_pieces += (
            "<p class='chemin'>Les fichiers correspondants se trouvent dans le "
            "sous-répertoire <b>pieces-jointes</b> du dossier, rangés par pièce.</p>"
        )

    telecharges = list(documents_monday or [])
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
    else:
        bloc_pieces = (
            "<p>Aucune pièce jointe dans les échanges extraits. Le contrat signé "
            "et les factures devront être joints depuis une autre source.</p>"
        )

    return f"""<!DOCTYPE html>
<html lang="fr"><head><meta charset="utf-8" />
<title>Dossier de recouvrement — {html.escape(dossier.reference)}</title>
<style>{FEUILLE_DE_STYLE}</style></head>
<body>
<h1>Dossier de recouvrement — {html.escape(dossier.reference)}</h1>
<div class="sous-titre">{html.escape(dossier.nom or 'Débiteur non renseigné')}</div>

{bandeau_montant}
<table class="identite">{rangees_identite}</table>
{f'<p class="chemin">{html.escape(note_vue)}</p>' if note_vue else ''}

<h2>1. Contexte</h2>
{bloc_contexte}

<h2>2. Contrat signé et factures</h2>
{bloc_pieces}

<h2>3. Preuve des actions engagées</h2>
<table class="chiffres"><tr>{rangees_chiffres}</tr></table>

{_bloc_repartition(dossier, lignes, vues if vues is not None else {"factures"})}

<h3>Constats</h3>
<ul class="constats">
{''.join(f'<li>{html.escape(constat)}</li>' for constat in constats)}
</ul>

<h3>Événements repérés</h3>
{bloc_evenements}

<h3>Chronologie complète des échanges</h3>
<table>
<tr><th>Pièce</th><th>Date</th><th>Sens</th><th>Objet</th><th></th></tr>
{''.join(_rangee_chronologie(ligne) for ligne in lignes)}
</table>

<div class="avertissement">
<b>Portée de ce document.</b> Les montants, dates de formation, statuts et
notes de la partie 1 sont recopiés du tableau de suivi. Les parties 2 et 3
sont établies à partir des seuls messages extraits des boîtes citées
ci-dessus, sans autre source. Les événements sont repérés par correspondance
de formulations dans l'objet et le corps des messages : la liste peut être
incomplète, et un message rédigé autrement peut ne pas avoir été reconnu. La
nature des pièces jointes est déduite de leur nom de fichier. Chaque constat
renvoie à un numéro de pièce, à vérifier dans le message d'origine avant toute
utilisation. Ce document ne constitue pas une analyse juridique et doit être
relu avant transmission.{note_doublons}
</div>
</body></html>
"""
