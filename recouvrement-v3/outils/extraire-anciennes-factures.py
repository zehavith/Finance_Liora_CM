#!/usr/bin/env python3
"""Relève dans Monday, en lecture seule, les factures qui en remplacent une
autre : la colonne « Ancienne facture … » dit quel était le numéro d'origine.

  MONDAY_TOKEN=… python3 extraire-anciennes-factures.py <sortie anciennes-factures.json>

La page s'en sert pour calculer l'échéance d'une facture refaite sur la date
de la facture d'origine : refaire une facture ne repousse pas ce qui est dû.
"""
import json, os, subprocess, sys, datetime

COLONNES = [  # tableau, colonnes « ancienne facture »
    ('1818713092', ['text_mkxc39zb']),                     # 1.0. Tampon — « Ancienne facture 1 ayant été modifiée »
    ('1842356810', ['text_mkxcsbh3', 'text_mkxh20xj']),    # 0.1. Factures payées — « Ancienne facture avant modification 1 / 2 »
    ('5099882263', ['text_mm6am1td']),                     # 1.3. OPCO — « Numero de facture d'origine »
]
def monday(q):
    r = subprocess.run(['curl', '-sS', '-m', '90', '-X', 'POST', 'https://api.monday.com/v2',
                        '-H', 'Authorization: ' + os.environ['MONDAY_TOKEN'], '-H', 'Content-Type: application/json',
                        '-H', 'API-Version: 2024-10', '-d', json.dumps({'query': q})], capture_output=True, text=True, check=True)
    d = json.loads(r.stdout)
    if d.get('errors'): raise SystemExit('Monday : ' + json.dumps(d['errors'])[:300])
    return d['data']

sortie = {}
for tableau, cols in COLONNES:
    for col in cols:
        ids = json.dumps([col])
        d = monday('query { boards(ids: [%s]) { name items_page(limit: 500, query_params: {rules: [{column_id: "%s", '
                   'compare_value: [""], operator: is_not_empty}]}) { cursor items { name column_values(ids: %s) { text } } } } }'
                   % (tableau, col, ids))
        b = d['boards'][0]; page = b['items_page']; n = 0
        while True:
            for it in page['items']:
                anc = (it['column_values'][0]['text'] or '').strip()
                if anc and anc != it['name']:
                    sortie.setdefault(it['name'], [])
                    if anc not in sortie[it['name']]: sortie[it['name']].append(anc); n += 1
            if not page.get('cursor'): break
            page = monday('query { next_items_page(cursor: %s, limit: 500) { cursor items { name column_values(ids: %s) { text } } } }'
                          % (json.dumps(page['cursor']), ids))['next_items_page']
        print('  %s · %s : %d' % (b['name'], col, n))
# 1.2. Recouvrement : la colonne est un miroir du tableau Tampon, qu'on ne peut
# pas filtrer — tout le tableau est lu, seule la colonne miroir est demandée.
MIROIRS = [('1817877566', 'lookup_mkxcw7f9'), ('1840539926', 'lookup_mkxcw7f9')]
for tableau, col in MIROIRS:
    try:
        d = monday('query { boards(ids: [%s]) { name columns(ids: ["%s"]) { id } items_page(limit: 500) { cursor items { name '
                   'column_values(ids: ["%s"]) { ... on MirrorValue { display_value } text } } } } }' % (tableau, col, col))
    except SystemExit as e:
        print('  ', tableau, e); continue
    b = d['boards'][0]
    if not b['columns']: continue
    page = b['items_page']; n = 0
    while True:
        for it in page['items']:
            cv = it['column_values'][0] if it['column_values'] else {}
            anc = (cv.get('display_value') or cv.get('text') or '').strip()
            if anc and anc != it['name']:
                sortie.setdefault(it['name'], [])
                if anc not in sortie[it['name']]: sortie[it['name']].append(anc); n += 1
        if not page.get('cursor'): break
        page = monday('query { next_items_page(cursor: %s, limit: 500) { cursor items { name column_values(ids: ["%s"]) '
                      '{ ... on MirrorValue { display_value } text } } } }' % (json.dumps(page['cursor']), col))['next_items_page']
    print('  %s · %s : %d' % (b['name'], col, n))
# Ne garder que de vrais numéros de facture : la colonne sert parfois de
# commentaire (« 0 », un numéro de dossier, une phrase).
import re
propre = {}
for neuve, anciens in sortie.items():
    nums = []
    for a in anciens:
        for n in re.findall(r'\b(?:FACT|FA)-?\d{2,4}-\d{3,6}\b', a.upper()):
            if n != neuve.upper() and n not in nums: nums.append(n)
    if nums: propre[neuve] = nums
sortie = propre
json.dump({'releve': datetime.datetime.now().isoformat(timespec='minutes'),
           'source': 'Monday — colonnes « Ancienne facture » des tableaux Tampon, Factures payées et OPCO',
           'factures': sortie}, open(sys.argv[1], 'w'), separators=(',', ':'), ensure_ascii=False)
print(len(sortie), 'factures refaites')
