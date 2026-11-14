#!/usr/bin/env python3
"""Met en forme les exports EDOF des paiements CPF (Mon Compte Formation).

  python3 extraire-edof.py <sortie edof.json> <export1.csv> [<export2.csv> …]
  python3 extraire-edof.py <sortie edof.json> <edof.json déjà publié> <nouvel export.csv>

Un fichier .json donné en entrée est l'edof.json déjà publié avec la page : il
contient tout ce qui a été reçu jusque-là, il n'est donc pas nécessaire de
redonner les anciens exports CSV pour en ajouter un nouveau.

Pour le CPF, c'est EDOF qui fait foi : une facture « Versé » est payée, à la
date de règlement EDOF. Les exports se cumulent : en redonner un plus récent
complète les précédents, la ligne la plus récente d'une facture l'emporte.
"""
import csv, json, sys, collections
factures, avances, periodes = {}, {}, []
for chemin in sys.argv[2:]:
    if chemin.endswith('.json'):
        ancien = json.load(open(chemin))
        for cible, source in ((factures, ancien.get('factures', {})), (avances, ancien.get('avances', {}))):
            for cle, ligne in source.items():
                if cle not in cible or ligne[4] >= cible[cle][4]: cible[cle] = ligne
        periodes += ancien.get('periodes', [])
        continue
    rows = list(csv.DictReader(open(chemin, encoding='utf-8-sig'), delimiter=';'))
    if rows: periodes.append([min(r['DATE_EMISSION_FACTURE'] for r in rows), max(r['DATE_EMISSION_FACTURE'] for r in rows), len(rows)])
    for r in rows:
        ligne = [round(float(r['MONTANT_REGLEMENT'] or 0), 2), r['DATE_REGLEMENT'], r['STATUT_REGLEMENT'], r['NUMERO_DOSSIER'],
                 r['DATE_EMISSION_FACTURE'], r['DOSSIER EN CONTROLE O/N'] == 'O']
        cible = avances if r['TYPE FACTURE'] == 'AVANCE' else factures
        cle = r['NUMERO_DOSSIER'] if r['TYPE FACTURE'] == 'AVANCE' else r['NUMERO_FACTURE'].strip()
        if cle not in cible or ligne[4] >= cible[cle][4]: cible[cle] = ligne
json.dump({'source': 'Exports EDOF des paiements CPF', 'periodes': sorted(periodes),
           'champs': ['montant du règlement', 'date du règlement', 'statut', 'numéro de dossier', 'date d’émission', 'dossier en contrôle'],
           'factures': factures, 'avances': avances}, open(sys.argv[1], 'w'), separators=(',', ':'), ensure_ascii=False)
print(len(factures), 'factures,', len(avances), 'avances ;', collections.Counter(v[2] for v in factures.values()), periodes)
