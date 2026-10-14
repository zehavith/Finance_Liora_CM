# L'export GoCardless est un tableur imprimé en PDF : chaque « block » de
# poppler est une COLONNE, chaque « line » une cellule. On reconstruit le
# tableau par les positions, sans rien interpréter du contenu.
import sys, re, html, collections
src, dest = sys.argv[1], sys.argv[2]
RE_PAGE = re.compile(r'<page width="([\d.]+)" height="([\d.]+)">')
RE_WORD = re.compile(r'<word xMin="([\d.-]+)" yMin="([\d.-]+)" xMax="([\d.-]+)" yMax="([\d.-]+)">(.*?)</word>')
texte = open(src, encoding='utf-8', errors='replace').read()
pages = texte.split('<page ')
lignes = []
for ip, p in enumerate(pages[1:], 1):
    mots = [(float(a), float(b), html.unescape(t)) for a, b, c, d, t in RE_WORD.findall(p)]
    if not mots: continue
    par_y = collections.defaultdict(list)
    for x, y, t in mots:
        par_y[round(y, 1)].append((x, t))
    # fusionner les y très proches (une même rangée n'est pas parfaitement alignée)
    ys = sorted(par_y)
    groupes, cour = [], [ys[0]]
    for y in ys[1:]:
        if y - cour[-1] <= 1.2: cour.append(y)
        else: groupes.append(cour); cour = [y]
    groupes.append(cour)
    for g in groupes:
        cells = []
        for y in g: cells += par_y[y]
        cells.sort()
        lignes.append((ip, g[0], cells))
with open(dest, 'w', encoding='utf-8') as f:
    for page, y, cells in lignes:
        f.write('%d\t%.1f\t%s\n' % (page, y, '\t'.join('%d~%s' % (round(x), t) for x, t in cells)))
print(len(lignes), 'rangées')
