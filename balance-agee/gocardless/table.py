# Les colonnes de l'export, repérées par leur bande de positions horizontales.
import sys, re, json, collections
src, dest = sys.argv[1], sys.argv[2]
BANDES = [
  ('id',        45,  78), ('cree',      78,  99), ('prelevement', 99, 118),
  ('montant',  118, 137), ('libelle',  137, 250), ('devise',     250, 269),
  ('statut',   269, 287), ('rembourse',287, 306), ('reference',  306, 347),
  ('frais',    347, 366), ('verse',    366, 385), ('fraisappli', 385, 403),
  ('reglement',403, 422), ('mandat',   422, 441), ('creancier',  441, 460),
  ('client',   460, 478), ('versement',478, 497), ('abonnement', 497, 516),
  ('clientid', 516, 535), ('clientcree',535,599), ('prenom',     599, 635),
  ('nom',      635, 654), ('actifs',   654, 689), ('taxe',       689, 708),
  ('meta',     708, 726), ('facture',  726, 820),
]
out = []
for ligne in open(src, encoding='utf-8'):
    bouts = ligne.rstrip('\n').split('\t')
    if len(bouts) < 10: continue
    cells = []
    for b in bouts[2:]:
        x, _, t = b.partition('~')
        try: cells.append((int(x), t))
        except ValueError: pass
    if not cells: continue
    r = collections.defaultdict(list)
    for x, t in cells:
        for nom, a, z in BANDES:
            if a <= x < z: r[nom].append(t); break
    d = {k: ' '.join(v) for k, v in r.items()}
    if not re.match(r'^(PM|PY)[0-9A-Z]{8,}$', d.get('id','').split(' ')[0] or ''): continue
    out.append(d)
json.dump(out, open(dest,'w',encoding='utf-8'), ensure_ascii=False, indent=0)
print(len(out), 'prélèvements')
