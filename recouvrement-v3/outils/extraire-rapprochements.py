#!/usr/bin/env python3
"""Règlements reçus mais non lettrés : la balance âgée propose, pour certains,
la facture qu'ils paient. On en tire la liste des factures encore ouvertes au
grand livre qu'un règlement non lettré couvre probablement.

  python3 extraire-rapprochements.py <balance.json> <sortie rapprochements.json>
"""
import json, sys, re, collections
d = json.load(open(sys.argv[1])); dico = d['dico']; C = {c: i for i, c in enumerate(d['cols'])}
v = lambda r, c: dico[r[C[c]]] if isinstance(r[C[c]], int) else r[C[c]]
num = lambda s: float(s) if s not in ('', None) else 0.0
iso = lambda s: '%s-%s-%s' % (s[6:10], s[3:5], s[0:2]) if s and len(s) >= 10 else ''
ORDRE = {'certaine': 3, 'forte': 2, 'probable': 1, 'à vérifier': 0}
reste = {}
for r in d['lignes']:
    if v(r, 'Nature de l’écriture') == 'facture' and v(r, 'N° de facture'):
        reste.setdefault(v(r, 'N° de facture'), num(v(r, 'Reste dû de la créance')))
prop = collections.defaultdict(lambda: [0.0, -1, '', ''])
sansFacture = collections.Counter()
for r in d['lignes']:
    if v(r, 'Nature de l’écriture') != 'reglement' or num(v(r, 'Reste dû de la créance')) >= 0: continue
    p = v(r, 'Proposition de rapprochement') or ''
    nums = re.findall(r'(?:FACT|FA)-[\w-]*\d{3,}', p)
    if not nums:
        if not v(r, 'Facture rattachée'): sansFacture[v(r, 'Type de financement de la créance') or '?'] += num(v(r, 'Crédit')) - num(v(r, 'Débit'))
        continue
    f = v(r, 'Fiabilité du rapprochement') or 'à vérifier'
    for n in nums:
        o = prop[n]; o[0] += (num(v(r, 'Crédit')) - num(v(r, 'Débit'))) / len(nums)
        if ORDRE.get(f, 0) > o[1]: o[1] = ORDRE.get(f, 0); o[2] = f
        o[3] = max(o[3], iso(v(r, 'Date')))
sortie = {n: [round(o[0], 2), round(reste[n], 2), o[2], o[3]] for n, o in prop.items() if reste.get(n, 0) > 0}
json.dump({'arrete': iso(d['arrete']), 'champs': ['règlement proposé', 'reste dû de la facture', 'fiabilité', 'date du règlement'],
           'factures': sortie, 'nonAttribues': {k: round(x, 2) for k, x in sansFacture.items()}},
          open(sys.argv[2], 'w'), separators=(',', ':'), ensure_ascii=False)
print(len(sortie), 'factures ouvertes avec un règlement proposé ;', collections.Counter(x[2] for x in sortie.values()))
print('règlements sans aucune facture proposée :', {k: round(x) for k, x in sansFacture.most_common(6)})
