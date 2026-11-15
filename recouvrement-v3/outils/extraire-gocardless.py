#!/usr/bin/env python3
"""Relevé GoCardless, en lecture seule : prélèvements, clients, mandats,
abonnements et virements, mis au format des exports du tableau de bord pour
que l'onglet Prélèvements les lise tels quels.

  GOCARDLESS_TOKEN=… python3 extraire-gocardless.py <sortie gocardless.json>

Rien n'est écrit dans GoCardless. Des clients, seuls le nom, le prénom, la
société et le courriel sont gardés (c'est la clé de rapprochement de l'onglet).
"""
import json, os, subprocess, sys, datetime, urllib.parse
BASE = 'https://api.gocardless.com/'
def appel(chemin, **p):
    url = BASE + chemin + ('?' + urllib.parse.urlencode(p) if p else '')
    r = subprocess.run(['curl', '-sS', '-m', '120', url, '-H', 'Authorization: Bearer ' + os.environ['GOCARDLESS_TOKEN'],
                        '-H', 'GoCardless-Version: 2015-07-06', '-H', 'Accept: application/json'], capture_output=True, text=True, check=True)
    d = json.loads(r.stdout)
    if 'error' in d: raise SystemExit('GoCardless : ' + str(d['error'].get('message'))[:200])
    return d
def tout(ressource):
    apres, n = None, 0
    while True:
        p = {'limit': 500}
        if apres: p['after'] = apres
        d = appel(ressource, **p)
        for x in d[ressource]: yield x
        n += len(d[ressource])
        apres = ((d.get('meta') or {}).get('cursors') or {}).get('after')
        if not apres or not d[ressource]: return
euros = lambda c: None if c is None else round(int(c) / 100, 2)
L = lambda x, k: (x.get('links') or {}).get(k, '')

mandats = [{'id': m['id'], 'created_at': m.get('created_at', ''), 'status': m.get('status', ''), 'scheme': m.get('scheme', ''),
            'reference': m.get('reference', ''), 'links.customer': L(m, 'customer')} for m in tout('mandates')]
clientDuMandat = {m['id']: m['links.customer'] for m in mandats}
print('mandats', len(mandats))
clients = [{'id': c['id'], 'created_at': c.get('created_at', ''), 'email': c.get('email') or '', 'given_name': c.get('given_name') or '',
            'family_name': c.get('family_name') or '', 'company_name': c.get('company_name') or ''} for c in tout('customers')]
print('clients', len(clients))
abonnements = [{'id': a['id'], 'created_at': a.get('created_at', ''), 'amount': euros(a.get('amount')), 'status': a.get('status', ''), 'name': a.get('name') or '',
                'start_date': a.get('start_date') or '', 'end_date': a.get('end_date') or '', 'interval': a.get('interval') or '', 'interval_unit': a.get('interval_unit') or '',
                'count': a.get('count') or '', 'links.mandate': L(a, 'mandate'), 'links.customer': clientDuMandat.get(L(a, 'mandate'), '')} for a in tout('subscriptions')]
print('abonnements', len(abonnements))
paiements = [{'id': p['id'], 'created_at': p.get('created_at', ''), 'charge_date': p.get('charge_date') or '', 'amount': euros(p.get('amount')), 'status': p.get('status', ''),
              'description': p.get('description') or '', 'reference': p.get('reference') or '', 'amount_refunded': euros(p.get('amount_refunded')),
              'links.mandate': L(p, 'mandate'), 'links.customer': clientDuMandat.get(L(p, 'mandate'), ''), 'links.subscription': L(p, 'subscription'), 'links.payout': L(p, 'payout')}
             for p in tout('payments')]
print('paiements', len(paiements))
versements = [{'id': v['id'], 'created_at': v.get('created_at', ''), 'arrival_date': v.get('arrival_date') or '', 'amount': euros(v.get('amount')),
               'transaction_fee_debit': euros(v.get('deducted_fees')), 'currency': v.get('currency', 'EUR'), 'status': v.get('status', ''), 'reference': v.get('reference') or '',
               'links.creditor': L(v, 'creditor'), 'links.creditor_bank_account': L(v, 'creditor_bank_account')} for v in tout('payouts')]
print('versements', len(versements))

def compact(rows):
    if not rows: return {'colonnes': [], 'lignes': []}
    cols = list(rows[0].keys())
    return {'colonnes': cols, 'lignes': [[r[c] for c in cols] for r in rows]}
json.dump({'releve': datetime.datetime.now().isoformat(timespec='minutes'), 'source': 'GoCardless — lecture directe, en lecture seule',
           'paiements': compact(paiements), 'clients': compact(clients), 'mandats': compact(mandats), 'abonnements': compact(abonnements), 'versements': compact(versements)},
          open(sys.argv[1], 'w'), separators=(',', ':'), ensure_ascii=False)
print('écrit :', sys.argv[1])
