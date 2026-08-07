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

# Événements repérés dans l'objet et le corps des messages. Le premier motif
# rencontré suffit ; les motifs sont comparés sur un texte mis à plat
# (minuscules, sans accent).
EVENEMENTS = [
    ("Mise en demeure", [
        "mise en demeure", "mettons en demeure", "mettre en demeure",
        "derniere relance avant", "avant poursuites",
    ]),
    ("Transmission au contentieux", [
        "transmis au contentieux", "service contentieux", "huissier",
        "commissaire de justice", "injonction de payer", "notre avocat",
        "procedure judiciaire", "recouvrement judiciaire",
    ]),
    ("Contestation", [
        "je conteste", "nous contestons", "contestation", "desaccord",
        "je refuse de payer", "erreur de facturation", "montant abusif",
        "je n ai jamais", "ne correspond pas",
    ]),
    # Libellé neutre : le même échéancier est tantôt demandé par l'apprenante,
    # tantôt accordé par Liora. La colonne « sens » tranche.
    # Pas de « mensualite » seul : « la première mensualité reste impayée » est
    # une relance, pas une demande d'étalement.
    ("Échéancier évoqué", [
        "echeancier", "echelonner", "echelonne", "etaler le paiement",
        "en plusieurs fois", "plusieurs mensualites", "delai de paiement",
        "delai supplementaire",
    ]),
    ("Annonce de paiement", [
        "virement effectue", "j ai regle", "j ai paye", "paiement effectue",
        "reglement effectue", "virement realise", "vous trouverez le reglement",
    ]),
    ("Difficultés financières invoquées", [
        "difficulte financiere", "difficultes financieres", "situation financiere difficile",
        "sans emploi", "au chomage", "perte d emploi", "je ne peux pas payer",
    ]),
    ("Relance", [
        "relance", "rappel", "reste impayee", "reste impaye", "demeure impayee",
        "toujours pas recu", "sans reponse de votre part", "non regle",
    ]),
    ("Envoi de facture", [
        "ci-joint la facture", "veuillez trouver la facture", "vous trouverez ci-joint",
        "votre facture", "facture correspondant",
    ]),
]

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

        for libelle, motifs in EVENEMENTS:
            if any(motif in texte for motif in motifs):
                synthese.evenements.append(
                    Evenement(ligne.piece_n, ligne.date, libelle, ligne.sens)
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


def _rangee_chronologie(ligne: LigneIndex) -> str:
    pieces = f"{ligne.nb_pieces_jointes} PJ" if ligne.nb_pieces_jointes else ""
    return (
        f"<tr><td>{ligne.piece_n}</td>"
        f"<td>{ligne.date:%d/%m/%Y}</td>"
        f"<td>{html.escape(ligne.sens)}</td>"
        f"<td>{html.escape(ligne.objet[:90])}</td>"
        f"<td>{pieces}</td></tr>"
    )


def construire_html(
    reference: str,
    nom: str,
    emails: str,
    factures: str,
    boites: list[str],
    lignes: list[LigneIndex],
    synthese: Synthese,
    date_export: datetime,
) -> str:
    constats = rediger_constats(synthese, date_export)

    identite = [
        ("Apprenante", nom or "—"),
        ("Adresse(s) mail", emails or "—"),
        ("Facture(s)", factures or "—"),
        ("Boîtes interrogées", ", ".join(boites)),
        ("Date d'extraction", date_export.strftime("%d/%m/%Y à %H:%M")),
    ]
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

    return f"""<!DOCTYPE html>
<html lang="fr"><head><meta charset="utf-8" />
<title>Note de synthèse — dossier {html.escape(reference)}</title>
<style>{FEUILLE_DE_STYLE}</style></head>
<body>
<h1>Note de synthèse — dossier {html.escape(reference)}</h1>
<div class="sous-titre">Échanges de messagerie constitutifs du dossier de recouvrement</div>

<table class="identite">{rangees_identite}</table>

<h2>Chiffres clés</h2>
<table class="chiffres"><tr>{rangees_chiffres}</tr></table>

<h2>Constats</h2>
<ul class="constats">
{''.join(f'<li>{html.escape(constat)}</li>' for constat in constats)}
</ul>

<h2>Événements repérés</h2>
{bloc_evenements}

<h2>Chronologie complète</h2>
<table>
<tr><th>Pièce</th><th>Date</th><th>Sens</th><th>Objet</th><th></th></tr>
{''.join(_rangee_chronologie(ligne) for ligne in lignes)}
</table>

<div class="avertissement">
<b>Portée de cette note.</b> Elle est établie automatiquement à partir des
seuls messages extraits des boîtes citées ci-dessus, sans autre source.
Les événements sont repérés par correspondance de formulations dans l'objet et
le corps des messages : la liste peut être incomplète, et un message rédigé
autrement peut ne pas avoir été reconnu. Chaque constat renvoie à un numéro de
pièce, à vérifier dans le message d'origine avant toute utilisation.
Cette note ne constitue pas une analyse juridique et doit être relue avant
transmission.{note_doublons}
</div>
</body></html>
"""
