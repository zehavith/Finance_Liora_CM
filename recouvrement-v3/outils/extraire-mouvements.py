#!/usr/bin/env python3
"""Journal des déplacements de factures entre groupes Monday, en lecture seule.

  MONDAY_TOKEN=… python3 extraire-mouvements.py <sortie mouvements.json> [<depuis AAAA-MM-JJ>]

Chaque déplacement garde sa date : la page compte ensuite les entrées et les
sorties de chaque étape du circuit entre deux dates choisies à l'écran.
"""
import json, os, subprocess, sys, datetime
TABLEAUX = ['1818713092', '1817877566', '1840539926', '5099882263', '1909949610', '1912012437', '1912012068', '1912012597']
def monday(q):
    r = subprocess.run(['curl', '-sS', '-m', '120', '-X', 'POST', 'https://api.monday.com/v2', '-H', 'Authorization: ' + os.environ['MONDAY_TOKEN'],
                        '-H', 'Content-Type: application/json', '-H', 'API-Version: 2024-10', '-d', json.dumps({'query': q})], capture_output=True, text=True, check=True)
    d = json.loads(r.stdout)
    if d.get('errors'): raise SystemExit('Monday : ' + json.dumps(d['errors'])[:300])
    return d['data']
depuis = sys.argv[2] if len(sys.argv) > 2 else (datetime.date.today() - datetime.timedelta(days=200)).isoformat()
au = datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
titres, idx, lignes = [], {}, []
def t(x):
    x = x or ''
    if x not in idx: idx[x] = len(titres); titres.append(x)
    return idx[x]
CODES = {'move_pulse_from_group': 0, 'move_pulse_into_board': 1, 'move_pulse_from_board': 2}
PAGE = 5000
def tranches(debut, fin, jours=31):
    d = datetime.date.fromisoformat(debut)
    f = datetime.date.fromisoformat(fin)
    while d <= f:
        e = min(f, d + datetime.timedelta(days=jours - 1)); yield d.isoformat(), e.isoformat(); d = e + datetime.timedelta(days=1)
for b in TABLEAUX:
    n, nom, lus = 0, '', 0
    # Le journal ne se filtre pas par type d'événement : il est lu mois par mois, page par page, et trié ici.
    for de, a in tranches(depuis, au[:10]):
        page = 1
        while True:
            d = monday('query { boards(ids: [%s]) { name activity_logs(from: "%sT00:00:00Z", to: "%sT23:59:59Z", limit: %d, page: %d) { event data created_at } } }'
                       % (b, de, a, PAGE, page))
            bd = d['boards'][0]; nom = bd['name']; logs = bd['activity_logs'] or []
            lus += len(logs)
            for ev in logs:
                if ev['event'] not in CODES: continue
                try: x = json.loads(ev['data'])
                except Exception: continue
                if x.get('is_undo_action'): continue
                jour = datetime.datetime.fromtimestamp(int(ev['created_at']) / 1e7, datetime.timezone.utc).strftime('%Y-%m-%d')
                lignes.append([jour, CODES[ev['event']], t((x.get('source_group') or {}).get('title')), t((x.get('dest_group') or {}).get('title')),
                               t((x.get('dest_board') or {}).get('name')), x.get('pulse_id') or 0])
                n += 1
            if len(logs) < PAGE: break
            page += 1
    print('  %s : %d déplacements (%d événements lus)' % (nom, n, lus))
lignes.sort()
# Le journal ne donne que l'identifiant Monday de l'élément : on va chercher son nom, qui est le numéro de facture.
ids = sorted({str(l[5]) for l in lignes if l[5]})
noms = {}
for i in range(0, len(ids), 100):
    lot = ids[i:i + 100]
    d = monday('query { items(ids: [%s], limit: 100) { id name } }' % ', '.join(lot))
    for it in d.get('items') or []: noms[str(it['id'])] = it['name']
print('  numéros de facture retrouvés : %d sur %d éléments' % (len(noms), len(ids)))
json.dump({'releve': datetime.datetime.now().isoformat(timespec='minutes'), 'depuis': depuis, 'titres': titres,
           'champs': ['jour', 'type (0 changement de groupe, 1 arrivée sur le tableau, 2 départ du tableau)', 'groupe de départ', 'groupe d’arrivée', 'tableau d’arrivée', 'facture (identifiant Monday)'],
           'noms': noms, 'lignes': lignes}, open(sys.argv[1], 'w'), separators=(',', ':'), ensure_ascii=False)
print(len(lignes), 'déplacements du', lignes[0][0] if lignes else '-', 'au', lignes[-1][0] if lignes else '-')
