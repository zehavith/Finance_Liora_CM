#!/usr/bin/env python3
"""Tire de la balance âgée publiée ce que le grand livre dit de chaque facture :
soldée par un règlement (et à quelle date), annulée par un avoir, ou encore
ouverte — plus son montant comptabilisé et sa date de pièce.

  python3 extraire-reglements.py <balance.json> <sortie reglements.json>

Une ligne par numéro de facture, sans nom de client. La page s'en sert comme
d'un grand livre lettré : la date de règlement du grand livre passe avant celle
de Monday, et un montant absent de Monday est repris de la comptabilité.
"""
import json, sys, collections, datetime

d = json.load(open(sys.argv[1]))
dico, C = d['dico'], {c: i for i, c in enumerate(d['cols'])}
v = lambda r, c: dico[r[C[c]]]
def nombre(s):
    try: return float(s)
    except Exception: return None
def iso(s):
    try: return datetime.date(int(s[6:10]), int(s[3:5]), int(s[0:2])).isoformat()
    except Exception: return ''

par = collections.OrderedDict()
for r in d['lignes']:
    k = v(r, 'Clé de la créance')
    if k: par.setdefault(k, []).append(r)

# Un règlement lettré avec une facture n'est pas toujours rangé sous la même
# créance : on le retrouve alors par le compte et la lettre de lettrage.
parLettre = collections.defaultdict(lambda: {'reglement': [], 'avoir': []})
for r in d['lignes']:
    nat, let = v(r, 'Nature de l’écriture'), v(r, 'Let.')
    if let and nat in ('reglement', 'avoir') and iso(v(r, 'Date')):
        parLettre[(v(r, 'N° de compte'), let)][nat].append(iso(v(r, 'Date')))

sortie, stats = {}, collections.Counter()
for k, rs in par.items():
    factures = [r for r in rs if v(r, 'Nature de l’écriture') == 'facture' and v(r, 'N° de facture')]
    if not factures: continue
    reste = nombre(v(rs[0], 'Reste dû de la créance'))
    regl = sorted(iso(v(r, 'Date')) for r in rs if v(r, 'Nature de l’écriture') == 'reglement')
    avoirs = sorted(iso(v(r, 'Date')) for r in rs if v(r, 'Nature de l’écriture') == 'avoir')
    soldee = reste is not None and abs(reste) < 0.005
    # Soldée par un règlement dès qu'un règlement y a contribué ; par avoir
    # quand seuls des avoirs l'ont éteinte : rien n'est alors rentré.
    for f in factures:
        num = v(f, 'N° de facture')
        rg, av = regl, avoirs
        if soldee and not rg and not av and v(f, 'Let.'):
            l = parLettre.get((v(f, 'N° de compte'), v(f, 'Let.')))
            if l: rg, av = sorted(l['reglement']), sorted(l['avoir'])
        # Soldée et lettrée sans que l'écriture en face soit retrouvée : elle
        # est réglée, mais sa date n'est pas connue — on ne l'invente pas.
        etat = 'o' if not soldee else 'r' if rg else 'a' if av else ('r' if v(f, 'Let.') else 'o')
        m = nombre(v(f, 'Débit')) or 0
        sortie[num] = [etat, ((rg[-1] if rg else '') if etat == 'r' else av[-1] if etat == 'a' else ''),
                       round(m, 2), iso(v(f, 'Date')), 0 if soldee else round(reste or 0, 2)]
        stats[etat] += 1
a = d['arrete']
json.dump({'arrete': a[6:10] + '-' + a[3:5] + '-' + a[0:2], 'source': d.get('source', ''),
           'champs': ['etat (r réglée, a annulée par avoir, o ouverte)', 'date du règlement ou de l’avoir',
                      'montant de la facture', 'date de la pièce', 'reste dû de la créance'],
           'factures': sortie}, open(sys.argv[2], 'w'), separators=(',', ':'), ensure_ascii=False)
print(len(sortie), 'factures', dict(stats))
