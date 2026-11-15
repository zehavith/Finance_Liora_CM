#!/usr/bin/env python3
"""Repère, dans la balance âgée, les factures dont le tiers est un OPCO, et
dit lequel. La page s'en sert pour ranger ces factures en « OPCO ».

  python3 extraire-opco.py <balance.json> <sortie opco.json>
"""
import json, re, sys, collections
OPCO = [('ATLAS', r'\bATLAS\b'), ('OPCO 2i', r'\bOPCO ?2I\b'), ('AFDAS', r'\bAFDAS\b'), ('AKTO', r'\bAKTO\b'), ('Constructys', r'\bCONSTRUCTYS\b'),
        ('OCAPIAT', r'\bOCAPIAT\b'), ('L’Opcommerce', r'\bOPCOMMERCE\b|\bOPCO COMMERCE\b'), ('Uniformation', r'\bUNIFORMATION\b'),
        ('OPCO EP', r'\bOPCO ?EP\b|ENTREPRISES DE PROXIMIT'), ('OPCO Mobilités', r'\bOPCO MOBILIT'), ('OPCO Santé', r'\bOPCO SANT'), ('OPCO (non précisé)', r'\bOPCO\b')]
def opco(texte):
    t = str(texte or '').upper()
    for nom, motif in OPCO:
        if re.search(motif, t): return nom
    return ''
d = json.load(open(sys.argv[1])); dico = d['dico']; C = {c: i for i, c in enumerate(d['cols'])}
v = lambda r, c: dico[r[C[c]]] if isinstance(r[C[c]], int) else r[C[c]]
sortie, compte = {}, collections.Counter()
for r in d['lignes']:
    n = v(r, 'N° de facture') or v(r, 'Facture rattachée')
    if not n or n in sortie: continue
    o = opco(v(r, 'Tiers')) or opco(v(r, 'Libellé de compte'))
    if o: sortie[n] = o; compte[o] += 1
json.dump({'source': 'Balance âgée — tiers de la facture', 'arrete': d.get('arrete'), 'factures': sortie}, open(sys.argv[2], 'w'), separators=(',', ':'), ensure_ascii=False)
print(len(sortie), 'factures OPCO ;', dict(compte.most_common()))
