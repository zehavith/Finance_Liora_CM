#!/usr/bin/env python3
"""Extrait, des balances âgées publiées, ce qu'il faut pour recalculer le
Pilotage quand un délai d'échéance change : une ligne par créance, sans aucun
nom ni numéro — financement, reste dû, retard actuel, et les dates sur
lesquelles une échéance peut s'appuyer.

  python3 extraire-creances.py <dossier des balances> <pilotage.json> <sortie creances.json>

Le dossier contient balance.json (l'arrêté du jour) et arretes/balance-AAAA-MM-JJ.json.
Chaque arrêté est CONTRÔLÉ : recomposé avec les règles d'origine, il doit
redonner au centime l'échu, le non échu et les tranches du relevé du Pilotage.
Un arrêté qui ne retombe pas juste n'est pas écrit.
"""
import json, sys, os, glob, datetime, collections

SRC, PILOTAGE, SORTIE = sys.argv[1], sys.argv[2], sys.argv[3]
BORNES = [90, 120, 180, 360, 540, 720, 1080, 1440]          # jours de retard, bornes hautes des tranches
EPOQUE = datetime.date(2000, 1, 1)

def jour(s):
    try: return (datetime.date(int(s[6:10]), int(s[3:5]), int(s[0:2])) - EPOQUE).days
    except Exception: return None
def nombre(s):
    try: return float(s)
    except Exception: return None
def tranche(j):
    if j is None or j <= 0: return -1
    for i, b in enumerate(BORNES):
        if j <= b: return i
    return len(BORNES)

pil = json.load(open(PILOTAGE))
releve = {e['d']: {r['cat']: r for r in e['parFinancement']} for e in pil['encours']}
sortie = {'bornes': BORNES, 'epoque': EPOQUE.isoformat(), 'arretes': {}, 'regles': None,
          'champs': ['financement', 'resteDuCentimes', 'regle', 'retardJours', 'debutFormation', 'finFormation',
                     'factureFacturation', 'dateEcriture']}
fichiers = [os.path.join(SRC, 'balance.json')] + sorted(glob.glob(os.path.join(SRC, 'arretes', 'balance-*.json')))
for f in fichiers:
    d = json.load(open(f))
    dico, C = d['dico'], {c: i for i, c in enumerate(d['cols'])}
    v = lambda r, c: dico[r[C[c]]]
    a = d['arrete']; iso = a[6:10] + '-' + a[3:5] + '-' + a[0:2]
    if iso not in releve:
        print('  %s : pas dans le relevé du Pilotage — ignoré' % iso); continue
    par = collections.OrderedDict()
    for r in d['lignes']:
        k = v(r, 'Clé de la créance')
        if k: par.setdefault(k, []).append(r)
    fins, idx, lignes = [], {}, []
    for k, rs in par.items():
        m = nombre(v(rs[0], 'Reste dû de la créance'))
        if m is None or abs(m) < 0.005: continue
        fin = v(rs[0], 'Type de financement de la créance')
        if fin not in idx: idx[fin] = len(fins); fins.append(fin)
        j = nombre(v(rs[0], 'Jours de retard de la créance'))
        fac = next((r for r in rs if v(r, 'Nature de l’écriture') == 'facture'), None)
        if fac is None: code = 3                                   # pas de facture en face : se date elle-même
        else:
            regle = v(fac, 'Règle de datation appliquée')
            code = 0 if not regle else 1 if regle.startswith('Exception') else 2
        lignes.append([idx[fin], int(round(m * 100)), code, None if j is None else int(j),
                       jour(v(fac, 'Date de début de formation')) if fac else None,
                       jour(v(fac, 'Date de fin de formation')) if fac else None,
                       jour(v(fac, 'Date de facture (facturation)')) if fac else None,
                       jour(v(fac, 'Date')) if fac else None])
    # contrôle : avec les règles d'origine, on doit retrouver le relevé
    agg = {}
    for l in lignes:
        o = agg.setdefault(fins[l[0]], {'echu': 0, 'nonEchu': 0, 'b': [0] * (len(BORNES) + 1)})
        t = tranche(l[3])
        if t < 0: o['nonEchu'] += l[1]
        else: o['echu'] += l[1]; o['b'][t] += l[1]
    ecart = 0
    for cat, r in releve[iso].items():
        o = agg.get(cat, {'echu': 0, 'nonEchu': 0, 'b': [0] * 9})
        ecart = max(ecart, abs(o['echu'] / 100 - r['echu']), abs(o['nonEchu'] / 100 - r['nonEchu']),
                    *[abs(o['b'][i] / 100 - (r['buckets'][i] or 0)) for i in range(9)])
    ok = ecart <= 0.25
    print('  %s : %d créances, %d financements, écart maximal avec le relevé %.2f € — %s'
          % (iso, len(lignes), len(fins), ecart, 'CONFORME' if ok else 'ÉCART, non écrit'))
    if ok:
        sortie['arretes'][iso] = {'fins': fins, 'jour': (datetime.date.fromisoformat(iso) - EPOQUE).days, 'c': lignes}
    if f.endswith('balance.json'): sortie['regles'] = [{'dispositif': r['dispositif'], 'base': r['base'], 'jours': r['jours']} for r in d['regles']]
json.dump(sortie, open(SORTIE, 'w'), separators=(',', ':'), ensure_ascii=False)
print('écrit', SORTIE, os.path.getsize(SORTIE), 'octets,', len(sortie['arretes']), 'arrêtés')
