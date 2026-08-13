"""Découverte des adresses d'un débiteur à partir de son numéro de facture.

Le principe : chercher d'abord sur le numéro de facture, lire les adresses des
parties dans les messages qui le citent, puis relancer la recherche sur ces
adresses. On retrouve ainsi les échanges qui ne nomment aucun numéro — la
plupart des réponses de l'apprenante — sans les avoir saisis nulle part.

Tout le risque est dans le filtrage. Une relance porte en en-tête l'adresse du
débiteur, mais aussi celles de Liora : relancer la recherche sur
`recouvrement@liora.io` ramènerait la boîte entière. D'où trois garde-fous,
appliqués dans cet ordre :

1. les adresses des domaines internes sont écartées — au minimum ceux des
   boîtes interrogées, plus ceux que l'on ajoute explicitement ;
2. les adresses de robots (noreply, mailer-daemon…) sont écartées ;
3. ce qui subsiste est *sondé* : une adresse qui ramène à elle seule plus de
   messages que le plafond du dossier est presque sûrement une adresse
   interne ou partagée, et elle est écartée avec un message à l'écran.

Aucune adresse n'est retenue en silence : chacune est annoncée, comptée, et
reportée au récapitulatif.
"""

from __future__ import annotations

import re
from collections import Counter

ADRESSE = re.compile(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+")

# Expéditeurs techniques : ils figurent en en-tête sans être partie à
# l'échange. « support » et « contact » n'y sont volontairement pas : sur un
# dossier entreprise, c'est souvent par là que le débiteur répond.
COMPTES_AUTOMATIQUES = {
    "noreply", "no-reply", "donotreply", "do-not-reply",
    "nepasrepondre", "ne-pas-repondre",
    "mailer-daemon", "mailerdaemon", "postmaster", "bounce", "bounces",
    "notification", "notifications", "notify", "newsletter",
    "calendar-notification", "drive-shares-dm-noreply",
}

# Fournisseurs dont les adresses de service traînent dans les en-têtes de
# messages transférés sans désigner personne.
DOMAINES_TECHNIQUES = {
    "google.com", "docs.google.com", "resource.calendar.google.com",
    "bounces.google.com", "sendgrid.net", "mailgun.org", "amazonses.com",
}


def _domaine(adresse: str) -> str:
    return adresse.rsplit("@", 1)[-1].lower()


def _compte(adresse: str) -> str:
    return adresse.split("@", 1)[0].lower()


def adresses_candidates(
    messages,
    domaines_internes: set[str],
    deja_connues: list[str],
) -> list[tuple[str, int]]:
    """Adresses externes trouvées en en-tête, de la plus fréquente à la moins.

    Sur les seuls en-têtes — expéditeur, destinataires, copies. Une adresse
    citée dans le corps d'un message transféré ne désigne pas une partie à
    l'échange, et la retenir ferait chercher n'importe qui.
    """
    connues = {adresse.lower() for adresse in deja_connues}
    internes = {domaine.lower() for domaine in domaines_internes}

    compte: Counter = Counter()
    for message in messages:
        # `set` par message : une adresse à la fois en destinataire et en
        # copie ne doit pas peser double.
        for adresse in set(ADRESSE.findall(message.parties)):
            adresse = adresse.lower().strip(".")
            if adresse in connues:
                continue
            if _domaine(adresse) in internes or _domaine(adresse) in DOMAINES_TECHNIQUES:
                continue
            if _compte(adresse) in COMPTES_AUTOMATIQUES:
                continue
            compte[adresse] += 1

    return sorted(compte.items(), key=lambda paire: (-paire[1], paire[0]))
