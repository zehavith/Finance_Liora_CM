// ══════════════════════════════════════════════════════════════════════════
//  REPOSER LA COLONNE « LIEN PENNYLANE » SUR UN FICHIER DÉJÀ CONSTRUIT
// ══════════════════════════════════════════════════════════════════════════
//
//   node cac/reposer-liens.js <fichier.json> [...]
//
// POURQUOI CE SCRIPT EXISTE. Les six arrêtés mensuels coûtent quatre minutes
// chacun à reconstruire. Or la colonne du lien n'est le fruit d'aucun calcul :
// c'est un report de l'instantané, numéro de facture → adresse, et aucune
// autre colonne n'en dépend. Quand la règle du report change — ce qui est
// arrivé le 09/11/2026, le pont Zoho tranchant au hasard entre une facture et
// son avoir — il n'y a donc rien à recalculer : il y a une colonne à reposer.
//
// Le fichier est réécrit en place, et SEULE cette colonne bouge. Les montants,
// les dates, les tranches, le lettrage ne sont pas touchés : le script ne sait
// même pas les lire.
//
// Il ne touche pas non plus à `genereISO` : le fichier reste daté de sa
// construction, qui est la vérité. L'empreinte de cac/page.js ne verra donc
// pas de changement — c'est voulu, puisqu'on repose la même colonne des deux
// côtés plutôt que de retransformer.

const fs = require('fs');
const path = require('path');

const CACHE = path.resolve(__dirname, '..', 'depot-pennylane', 'urls.json');

// La même règle que construire.js, au caractère près — si elles divergent,
// les arrêtés et la balance du jour ne diront plus la même chose.
let LIENS = {};
try { LIENS = (JSON.parse(fs.readFileSync(CACHE, 'utf8')) || {}).factures || {}; } catch (e) {}
const normNum = s => String(s).toUpperCase().replace(/[^A-Z0-9]/g, '');
const LIENS_NORM = new Map(); const ambigus = new Set();
for (const k of Object.keys(LIENS)) {
  const n = normNum(k), v = LIENS[k];
  const vu = LIENS_NORM.get(n);
  if (vu && vu.url !== v.url) { ambigus.add(n); continue; }
  LIENS_NORM.set(n, v);
}
for (const n of ambigus) LIENS_NORM.delete(n);
const lienDe = num => { if (!num) return '';
  const f = LIENS[num] || LIENS_NORM.get(normNum(num)); return (f && f.url) || ''; };

const fichiers = process.argv.slice(2);
if (!fichiers.length) { console.error('usage : node cac/reposer-liens.js <fichier.json> [...]'); process.exit(1); }
console.log(Object.keys(LIENS).length + ' numéros dans l’instantané'
  + (ambigus.size ? ' · ' + ambigus.size + ' clé(s) ambiguë(s) écartée(s)' : ''));

for (const f of fichiers) {
  const d = JSON.parse(fs.readFileSync(f, 'utf8'));
  const iFact = (d.cols || []).indexOf('N° de facture');
  const iLien = (d.cols || []).indexOf('Lien Pennylane');
  if (iFact < 0 || iLien < 0) {
    console.log('  ' + path.basename(f) + ' : colonne absente — laissé tel quel');
    continue;
  }
  // Un index de dictionnaire par valeur, en reprenant celui du fichier.
  const index = new Map();
  d.dico.forEach((v, i) => { if (!index.has(v)) index.set(v, i); });
  const idx = v => { let i = index.get(v);
    if (i === undefined) { i = d.dico.length; d.dico.push(v); index.set(v, i); } return i; };

  let poses = 0, retires = 0, changes = 0, inchanges = 0;
  for (const l of d.lignes) {
    const num = String(d.dico[l[iFact]] ?? '');
    const avant = String(d.dico[l[iLien]] ?? '');
    const apres = lienDe(num);
    if (apres === avant) { inchanges++; continue; }
    l[iLien] = idx(apres);
    if (!avant) poses++; else if (!apres) retires++; else changes++;
  }
  fs.writeFileSync(f, JSON.stringify(d), 'utf8');
  console.log('  ' + path.basename(f).padEnd(26) + poses + ' posé(s) · ' + changes
    + ' corrigé(s) · ' + retires + ' retiré(s) · ' + inchanges + ' inchangé(s)');
}
