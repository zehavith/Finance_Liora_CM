#!/usr/bin/env python3
"""Détail ligne à ligne pour l'onglet Pilotage : ce qui se cache derrière un
montant du « mois en bref » ou du tableau « Encours par financeur et par
ancienneté ».

  python3 extraire-lignes.py <sortie lignes.json> <balance.json> [<balance d'un arrêté>…]

- flux : factures et règlements du dernier mois complet (première balance) ;
- creances-<date>.json : pour chaque balance, les créances encore dues à son
  arrêté, dans un fichier à part lu à la demande.
"""
import json, os, sys, datetime, collections
def charge(p):
    d = json.load(open(p)); dico = d['dico']; C = {c: i for i, c in enumerate(d['cols'])}
    return d, (lambda r, c: dico[r[C[c]]] if isinstance(r[C[c]], int) else r[C[c]])
def num(s):
    try: return float(s)
    except Exception: return 0.0
iso = lambda s: '%s-%s-%s' % (s[6:10], s[3:5], s[0:2]) if s and len(s) >= 10 else ''
sortie = {'flux': None, 'creances': {}}
for i, p in enumerate(sys.argv[2:]):
    d, v = charge(p)
    arrete = iso(d['arrete'])
    fin = lambda r: v(r, 'Type de financement de la créance') or '(à compléter)'
    if i == 0:
        a = datetime.date.fromisoformat(arrete).replace(day=1) - datetime.timedelta(days=1)
        M = a.strftime('%Y-%m'); L = []
        for r in d['lignes']:
            if str(v(r, 'Journal') or '').lower().startswith('an'): continue
            dt = iso(v(r, 'Date'))
            if dt[:7] != M: continue
            nat = v(r, 'Nature de l’écriture')
            if nat == 'facture': L.append([fin(r), 'f', dt, v(r, 'N° de facture') or '', v(r, 'Tiers') or '', round(num(v(r, 'Débit')), 2)])
            elif nat == 'reglement': L.append([fin(r), 'r', dt, v(r, 'Facture rattachée') or '', v(r, 'Tiers') or '', round(num(v(r, 'Crédit')) - num(v(r, 'Débit')), 2)])
        sortie['flux'] = {'mois': M, 'champs': ['financeur', 'f facture / r règlement', 'date', 'facture', 'tiers', 'montant'], 'lignes': L}
        print('flux', M, len(L), round(sum(x[5] for x in L if x[1] == 'f')), round(sum(x[5] for x in L if x[1] == 'r')))
    vues, L = {}, []
    for r in d['lignes']:
        k = v(r, 'Clé de la créance')
        if not k: continue
        if k not in vues: vues[k] = r
        if v(r, 'Nature de l’écriture') == 'facture' and v(r, 'N° de facture') and v(vues[k], 'Nature de l’écriture') != 'facture': vues[k] = r
    tot = collections.Counter()
    for k, r in vues.items():
        reste = round(num(v(r, 'Reste dû de la créance')), 2)
        if reste == 0: continue   # les créditeurs comptent : le relevé les déduit, tranche par tranche
        tr = v(r, 'Tranche de la créance') or ''
        L.append([fin(r), v(r, 'N° de facture') or k, v(r, 'Tiers') or '', reste, tr, int(num(v(r, 'Jours de retard de la créance'))),
                  iso(v(r, 'Date de facture (facturation)') or v(r, 'Date'))])
        tot[tr] += reste
    json.dump(L, open(os.path.join(os.path.dirname(sys.argv[1]), 'creances-%s.json' % arrete), 'w'), separators=(',', ':'), ensure_ascii=False)
    sortie['creances'][arrete] = len(L)
    print(arrete, len(L), round(sum(tot.values())), {k: round(x) for k, x in tot.items()})
sortie['champsCreances'] = ['financeur', 'facture', 'tiers', 'reste dû', 'tranche', 'jours de retard', 'date de facture']
json.dump(sortie, open(sys.argv[1], 'w'), separators=(',', ':'), ensure_ascii=False)
