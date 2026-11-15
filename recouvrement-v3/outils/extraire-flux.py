#!/usr/bin/env python3
"""Toutes les factures et tous les règlements du grand livre, mois par mois, pour ouvrir les vignettes
« Total facturé » et « DSO » de l'onglet Pilotage sur n'importe quelle période.

  python3 extraire-flux.py <sortie flux.json> <balance.json> [<premier mois AAAA-MM>]
"""
import json, sys
d = json.load(open(sys.argv[2])); dico = d['dico']; C = {c: i for i, c in enumerate(d['cols'])}
v = lambda r, c: dico[r[C[c]]] if isinstance(r[C[c]], int) else r[C[c]]
def num(s):
    try: return float(s)
    except Exception: return 0.0
iso = lambda s: '%s-%s-%s' % (s[6:10], s[3:5], s[0:2]) if s and len(s) >= 10 else ''
depuis = sys.argv[3] if len(sys.argv) > 3 else '2024-07'
L = []
for r in d['lignes']:
    if str(v(r, 'Journal') or '').lower().startswith('an'): continue
    dt = iso(v(r, 'Date'))
    if dt[:7] < depuis: continue
    fin = v(r, 'Type de financement de la créance') or '(à compléter)'
    nat = v(r, 'Nature de l’écriture')
    if nat == 'facture': L.append([fin, 'f', dt, v(r, 'N° de facture') or '', v(r, 'Tiers') or '', round(num(v(r, 'Débit')), 2)])
    elif nat == 'reglement': L.append([fin, 'r', dt, v(r, 'Facture rattachée') or '', v(r, 'Tiers') or '', round(num(v(r, 'Crédit')) - num(v(r, 'Débit')), 2)])
json.dump({'depuis': depuis, 'arrete': iso(d['arrete']), 'champs': ['financeur', 'f facture / r règlement', 'date', 'facture', 'tiers', 'montant'], 'lignes': L},
          open(sys.argv[1], 'w'), separators=(',', ':'), ensure_ascii=False)
print('flux depuis', depuis, ':', len(L), 'lignes')
