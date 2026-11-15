#!/usr/bin/env python3
"""Solde du compte 491 (dépréciation des comptes clients) lu dans Pennylane,
en lecture seule, à la date d'arrêté.

  PENNYLANE_TOKEN=… python3 extraire-provision.py <AAAA-MM-JJ> <sortie provision.json>
"""
import json, os, subprocess, sys, urllib.parse
BASE = 'https://app.pennylane.com/api/external/v2/'
def appel(chemin, **p):
    url = BASE + chemin + ('?' + urllib.parse.urlencode(p) if p else '')
    r = subprocess.run(['curl', '-sS', '-m', '90', '-g', url, '-H', 'Authorization: Bearer ' + os.environ['PENNYLANE_TOKEN'],
                        '-H', 'Accept: application/json'], capture_output=True, text=True, check=True)
    d = json.loads(r.stdout)
    if 'items' not in d: raise SystemExit('Pennylane : ' + r.stdout[:300])
    return d
def tout(chemin, **p):
    cur = None
    while True:
        q = dict(p, limit=100)
        if cur: q['cursor'] = cur
        d = appel(chemin, **q)
        for x in d['items']: yield x
        if not d.get('has_more'): return
        cur = d.get('next_cursor')

arrete, sortie = sys.argv[1], sys.argv[2]
comptes = [c for c in tout('ledger_accounts', filter=json.dumps([{'field': 'number', 'operator': 'start_with', 'value': '491'}]))
           if str(c.get('number', '')).startswith('491')]
detail, total, ecritures, JOURNAUX, PIECES = [], 0.0, [], {}, {}
def un(chemin):
    r = subprocess.run(['curl', '-sS', '-m', '90', BASE + chemin, '-H', 'Authorization: Bearer ' + os.environ['PENNYLANE_TOKEN'],
                        '-H', 'Accept: application/json'], capture_output=True, text=True, check=True)
    try: return json.loads(r.stdout)
    except ValueError: return {}
def journal(i):
    if i not in JOURNAUX: j = un('journals/%s' % i); JOURNAUX[i] = j.get('code') or j.get('label') or ''
    return JOURNAUX[i]
def piece(i):
    if i not in PIECES: PIECES[i] = (un('ledger_entries/%s' % i).get('label') or '')
    return PIECES[i]
for c in comptes:
    s, n = 0.0, 0
    for l in tout('ledger_entry_lines', filter=json.dumps([{'field': 'ledger_account_id', 'operator': 'eq', 'value': str(c['id'])},
                                                           {'field': 'date', 'operator': 'lteq', 'value': arrete}])):
        jr = journal((l.get('journal') or {}).get('id')) if l.get('journal') else ''
        # LES À-NOUVEAUX NE SE COMPTENT PAS : le journal AN reprend, à l'ouverture de chaque exercice, le solde des
        # exercices précédents. Les additionner aux écritures d'origine compterait la même provision plusieurs fois.
        an = jr.upper() == 'AN'
        if not an: s += float(l.get('credit') or 0) - float(l.get('debit') or 0)
        n += 1
        # le détail de chaque écriture : date, journal, libellé, débit, crédit
        ecritures.append([l.get('date'), c['number'], jr,
                          l.get('label') or piece((l.get('ledger_entry') or {}).get('id')), float(l.get('debit') or 0), float(l.get('credit') or 0), 1 if an else 0])
    detail.append({'compte': c['number'], 'libelle': c.get('label'), 'lignes': n, 'solde': round(s, 2)})
    total += s
    print('  %s %s : %d lignes, %.2f' % (c['number'], c.get('label'), n, s))
json.dump({'arrete': arrete, 'source': 'Pennylane — comptes 491, solde créditeur cumulé hors à-nouveaux', 'montant': round(total, 2) if comptes else None,
           'comptes': detail, 'ecritures': sorted(ecritures, key=lambda e: e[0] or '')}, open(sortie, 'w'), ensure_ascii=False)
print('provision comptabilisée :', round(total, 2) if comptes else 'aucun compte 491')
