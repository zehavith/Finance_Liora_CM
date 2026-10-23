// ── LA BALANCE DU GRAND LIVRE DE L'APPLICATION CONTRE LA RÉFÉRENCE ──
//
// « Pour la partie balance âgée du grand livre j'aimerais que tu actualises
// avec toutes les améliorations que l'on a dans l'artefact » — et, plus
// précisément, « je n'ai pas besoin de la fonctionnalité d'export en général,
// j'ai juste besoin pour la comparaison balance âgée grand livre et Monday ».
//
// Donc une seule question : la balance du grand livre de l'application
// donne-t-elle LES MÊMES CHIFFRES que la page publiée ? Ce cas fait tourner,
// sur le MÊME grand livre, la suite d'appels de la référence et celle de
// recalculerBalanceGL(), et chiffre chaque écart un par un.
//
// Ce qui ne peut pas être mesuré ici est dit comme tel : les tableaux Monday
// ne vivent que dans le navigateur.
const path = require('path'), fs = require('fs');
const { ctx, X, ANC, NOUV, feuille } = require(path.resolve(__dirname, '..', 'socle.js'));
const GL = ctx.LioraGrandLivre, R = ctx.LioraRules, I = ctx.LioraIngest, SE = ctx.LioraSellsy;
const RG = R.DEFAULT_ECHEANCE_RULES;
const D = path.resolve(__dirname, '..');
const ok = (t, c) => { console.log((c ? '  OK   ' : ' ÉCHEC ') + t); if (!c) process.exitCode = 1; };
const eur = n => Math.round(n).toLocaleString('fr-FR') + ' €';
const nb = n => n.toLocaleString('fr-FR');
const titre = t => console.log('\n── ' + t + ' ' + '─'.repeat(Math.max(0, 66 - t.length)));

const nouv = feuille(path.resolve(D, NOUV), 'Grand livre - Clients', 0);

// ───────── la date d'arrêté, comme la référence la calcule ─────────
const REF = (() => {
  let d = null;
  for (const r of nouv.rows) { const v = R.parseDate(r['Date']); if (v && (!d || v > d)) d = v; }
  const jour = new Date(); jour.setHours(0, 0, 0, 0);
  return (!d || d > jour) ? jour : d;
})();
const JOUR = (() => { const j = new Date(); j.setHours(0, 0, 0, 0); return j; })();

// ───────── la table de réparation, comme construire.js la construit ─────────
const csv = f => ctx.Papa.parse(fs.readFileSync(path.resolve(D, f), 'utf8'),
  { header: true, skipEmptyLines: true, delimiter: ';' }).data;
const zo = feuille(path.resolve(D, ANC), 'BdD Zoho - Toutes les factures ', 0);
const sellsy = (SE.lireExport(csv('depot-sellsy/sellsy.csv')).lignes || [])
  .concat(SE.lireExport(csv('depot-sellsy/avoirs.csv')).lignes || [])
  .concat(SE.lireExport(zo.rows).lignes || []);
const fi = { rows: feuille(path.resolve(D, 'depot-ech/echeances.xlsx'), 'Échéances', 0).rows
  .concat(feuille(path.resolve(D, ANC), 'BdD Filiz - Facture Alternance', 0).rows) };
const numerosDeLaCellule = v => String(v == null ? '' : v).split(/[;,\n\r\/]+/)
  .map(s => s.trim()).filter(Boolean);
const CONNUS = new Map();
{ const pose = n => { const k = I.factureKey(n); if (k && !CONNUS.has(k)) CONNUS.set(k, String(n).trim()); };
  for (const l of sellsy) pose(l.numero);
  for (const r of feuille(path.resolve(D, ANC), 'BdD Zoho -Avoir Zoho', 0).rows) pose(r['Facture d’avoir#']);
  for (const r of fi.rows) for (const n of numerosDeLaCellule(r['NUMERO FACTURE'])) pose(n); }
const REPARATIONS = new Map();
{ const vus = new Map();
  for (const r of nouv.rows) {
    const n = String(r['N° de facture'] || '').trim()
      || GL.numeroDepuisTexte(String(r['Libellé de ligne'] || ''))
      || GL.numeroDepuisTexte(String(r['Libellé de pièce'] || ''));
    if (!n) continue; const k = I.factureKey(n); if (k && !vus.has(k)) vus.set(k, n); }
  for (const [k] of vus) {
    if (CONNUS.has(k)) continue;
    const cands = new Set();
    for (const v of [k.replace(/^FCAT(?=\d)/, 'FACT'), k.replace(/^FACT(?=[A-Z]{2,8}\d)/, 'FCT')])
      if (v !== k && CONNUS.has(v)) cands.add(v);
    cands.delete(k);
    if (cands.size === 1) REPARATIONS.set(k, CONNUS.get([...cands][0])); } }

const OPT = () => ({ rules: RG, sellsy: [], factures: [], mandats: [],
                     referentiel: {}, regles: [], appris: {} });

// La suite d'appels, paramétrée par les écarts qu'on veut mesurer.
function suite({ reparations = true, prorata = true, date = REF, niveau = 'financement' } = {}) {
  const lu = GL.lire(nouv.rows, reparations ? { reparations: REPARATIONS } : {});
  const classees = GL.classer(GL.creancesOuvertes(lu), OPT());
  const soldees = GL.classer(GL.facturesToutes(lu)
    .filter(c => c.statut && c.statut !== 'Ouverte' && c.statut !== 'Partiellement réglée'), OPT());
  const plat = GL.ecrituresAPlat(lu);
  const ecr = GL.classerEcritures(plat, classees, soldees, { sellsy: [], rules: RG, factures: [] });
  let bilan = null;
  if (prorata) bilan = GL.repartirAuProrata(ecr.lignes || ecr, classees, { rules: RG });
  return { lu, classees, bilan, balance: GL.balanceAgee(classees, date, RG, niveau) };
}

const somme = b => b.rows.reduce((s, r) => s + (r.total || 0), 0);
const sommeNb = (b, champ) => b.rows.reduce((s, r) => s + (r[champ] || 0), 0);
const parCle = b => new Map(b.rows.map(r => [r.cle, r.total || 0]));
const tranches = b => { const t = {};
  for (const r of b.rows) for (const k of Object.keys(r.buckets || {})) t[k] = (t[k] || 0) + r.buckets[k];
  return t; };

console.log('grand livre : ' + nb(nouv.rows.length) + ' lignes · arrêté au '
  + REF.toLocaleDateString('fr-FR') + ' · jour de l’essai ' + JOUR.toLocaleDateString('fr-FR'));
console.log('numéros abîmés réparables : ' + REPARATIONS.size);

const REFERENCE = suite();

// ═══════════ 0. la référence est bien reproduite ═══════════
titre('0 · la référence');
const pub = require(path.resolve(D, 'art', 'balance.json'));
const tot = pub.synthese.find(r => r.cat === 'TOTAL');
ok('total de la balance publiée retrouvé — ' + eur(somme(REFERENCE.balance))
   + ' contre ' + eur(tot.total), Math.abs(somme(REFERENCE.balance) - tot.total) < 1);
ok('créances (factures) retrouvées — ' + nb(sommeNb(REFERENCE.balance, 'nbFactures'))
   + ' contre ' + nb(tot.nb), sommeNb(REFERENCE.balance, 'nbFactures') === tot.nb);
console.log('       lignes de balance : ' + nb(sommeNb(REFERENCE.balance, 'nb'))
  + ' au total (dont ' + nb(sommeNb(REFERENCE.balance, 'nbAvoirs')) + ' avoirs et '
  + nb(sommeNb(REFERENCE.balance, 'nbSansFacture')) + ' sans facture)');

// ═══════════ 1. la date d'arrêté ═══════════
titre('1 · la date d’arrêté : le jour courant au lieu du grand livre');
const base = REFERENCE.balance;
for (const j of [1, 7, 14, 30]) {
  const d = new Date(REF); d.setDate(d.getDate() + j);
  const b = GL.balanceAgee(REFERENCE.classees, d, RG, 'financement');
  const a = tranches(base), z = tranches(b);
  let bouge = 0; for (const k of Object.keys(a)) bouge += Math.abs((z[k] || 0) - a[k]);
  const echuA = base.rows.reduce((s, r) => s + r.echu, 0);
  const echuZ = b.rows.reduce((s, r) => s + r.echu, 0);
  console.log('   +' + String(j).padStart(2) + ' jour(s) : ' + eur(bouge / 2).padStart(14)
    + ' changent de tranche · ' + eur(echuZ - echuA).padStart(14) + ' basculent dans l’échu');
}
ok('le total ne bouge pas avec la date, seule la ventilation bouge', (() => {
  const d = new Date(REF); d.setDate(d.getDate() + 30);
  return Math.abs(somme(GL.balanceAgee(REFERENCE.classees, d, RG, 'financement')) - somme(base)) < 0.01;
})());
const retardJour = Math.round((JOUR - REF) / 86400000);
ok('l’application mesure aujourd’hui l’ancienneté avec ' + retardJour
   + ' jour(s) de trop sur ce fichier', true);

// ═══════════ 2. l'aller-retour toISOString → R.parseDate ═══════════
titre('2 · la sérialisation des dates recule d’un jour');
console.log('   fuseau de l’essai : ' + (process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone));
let testees = 0, reculees = 0;
for (const c of REFERENCE.classees) {
  for (const champ of ['dateFacture', 'dateEcheance']) {
    const d = c[champ]; if (!(d instanceof Date)) continue;
    const relu = R.parseDate(d.toISOString());
    testees++; if (!relu || R.stripTime(relu).getTime() !== R.stripTime(d).getTime()) reculees++;
  }
}
console.log('   dates de créance passées par toISOString() puis R.parseDate() : ' + nb(testees));
ok(reculees === 0
   ? 'aucune date décalée (ce fuseau ne révèle pas le défaut — relancer en TZ=Europe/Paris)'
   : nb(reculees) + ' dates sur ' + nb(testees) + ' reculent d’un jour', true);
if (reculees) ok('TOUTES les dates sérialisées reculent, pas seulement quelques-unes',
  reculees === testees);

// ═══════════ 3. la table de réparation des numéros abîmés ═══════════
titre('3 · GL.lire sans la table de réparation');
const sansRep = suite({ reparations: false });
console.log('   total        : ' + eur(somme(sansRep.balance)) + ' contre ' + eur(somme(base)));
console.log('   créances     : ' + nb(sommeNb(sansRep.balance, 'nbFactures')) + ' contre '
  + nb(sommeNb(base, 'nbFactures')));
console.log('   lignes       : ' + nb(sommeNb(sansRep.balance, 'nb')) + ' contre '
  + nb(sommeNb(base, 'nb')));
{
  const a = parCle(base), z = parCle(sansRep.balance);
  let bouge = 0;
  for (const k of new Set([...a.keys(), ...z.keys()])) bouge += Math.abs((z.get(k) || 0) - (a.get(k) || 0));
  console.log('   ventilation  : ' + eur(bouge / 2) + ' déplacés entre dispositifs');
  ok('la réparation des numéros change le découpage en créances',
     sommeNb(sansRep.balance, 'nb') !== sommeNb(base, 'nb')
     || Math.abs(somme(sansRep.balance) - somme(base)) > 0.01 || bouge > 0.01);
}

// ═══════════ 4. la répartition au prorata ═══════════
titre('4 · GL.repartirAuProrata jamais appelée dans l’application');
const sansPro = suite({ prorata: false });
ok('le total est inchangé — ' + eur(somme(sansPro.balance)),
   Math.abs(somme(sansPro.balance) - somme(base)) < 0.01);
{
  const a = parCle(sansPro.balance), z = parCle(base);
  const l = [];
  for (const k of new Set([...a.keys(), ...z.keys()])) {
    const d = (z.get(k) || 0) - (a.get(k) || 0);
    if (Math.abs(d) >= 0.01) l.push([k, d]);
  }
  l.sort((x, y) => Math.abs(y[1]) - Math.abs(x[1]));
  const deplace = l.reduce((s, x) => s + Math.max(0, x[1]), 0);
  ok('la ventilation par dispositif change — ' + l.length + ' lignes, ' + eur(deplace) + ' déplacés',
     l.length > 0);
  for (const [k, d] of l)
    console.log('       ' + String(R.getRule(k, RG).label || k).padEnd(32)
      + (d > 0 ? '+' : '') + eur(d));
  const b = REFERENCE.bilan;
  console.log('   ce que la répartition tranche : ' + b.creances + ' soldes de compte, dont '
    + b.creancesChangees + ' changent (' + eur(b.eurosCreances) + ')');
  console.log('   règle France Travail : ' + b.montant + ' lignes et soldes, '
    + b.montantChangees + ' changements');
  const t = tranches(base), u = tranches(sansPro.balance);
  let bt = 0; for (const k of Object.keys(t)) bt += Math.abs((u[k] || 0) - t[k]);
  console.log('   effet sur les tranches : ' + eur(bt / 2)
    + ' (le prorata change la LIGNE, pas l’ancienneté)');
}

// ═══════════ 5. le compteur de créances ═══════════
titre('5 · « Nb » du grand livre : nb (toutes lignes) au lieu de nbFactures');
console.log('   nb         = ' + nb(sommeNb(base, 'nb')) + '  (factures + avoirs + lignes sans facture)');
console.log('   nbFactures = ' + nb(sommeNb(base, 'nbFactures')) + '  ← ce que la référence publie');
ok('l’écart de comptage est de ' + nb(sommeNb(base, 'nb') - sommeNb(base, 'nbFactures'))
   + ' créances, soit ×' + (sommeNb(base, 'nb') / sommeNb(base, 'nbFactures')).toFixed(2),
   sommeNb(base, 'nb') > sommeNb(base, 'nbFactures'));

// ═══════════ 6. le niveau « catégorie » ═══════════
titre('6 · niveau « catégorie » : plus aucune clé n’a ses deux côtés');
const parCat = suite({ niveau: 'categorie' }).balance;
const clesFin = new Set(base.rows.map(r => r.cle));
const clesCat = new Set(parCat.rows.map(r => r.cle));
// Seul '__A_CLASSER__' est commun aux deux niveaux, et il n'a de toute façon
// aucun vis-à-vis Monday : aucune clé de DISPOSITIF ne survit au changement.
const communes = [...clesCat].filter(k => clesFin.has(k) && k !== '__A_CLASSER__');
console.log('   clés par financement : ' + [...clesFin].slice(0, 6).join(', ') + ' …');
console.log('   clés par catégorie   : ' + [...clesCat].join(', '));
ok('aucune clé de dispositif ne survit : ' + communes.length + ' sur ' + clesCat.size
   + ' (Monday reste clé par dispositif)', communes.length === 0);
console.log('   → chaque ligne de la comparaison afficherait un écart de ±100 %');

// ═══════════ 7. ce que Monday peut écraser dans le classement comptable ═══════════
titre('7 · factures: state.factures — le rang « Facture » est pris par Monday');
// Dans la cascade, idx.parCle (alimenté par o.factures, grandlivre.js:2092) est
// consulté au rang « Facture ». Tout ce qui est classé APRÈS ce rang est donc
// écrasable par le dispositif que Monday porte sur la même clé.
const APRES_FACTURE = new Set(['Règle', 'Ancien grand livre (n° de facture)',
  'Ancien grand livre (identifiant du tiers)', 'Ancien grand livre (compte client)',
  'Libellé du compte', 'Réglée par GoCardless ou Stripe', 'Type de client (facturation)',
  'Type de client (même client chez Sellsy)', 'Héritée du fichier (à vérifier)',
  'Identifiant du tiers', 'Compte client', 'Même client, classé ailleurs',
  'Numéro de devis (B2C - Entreprise par défaut)']);
const rang = o => String(o || '').startsWith('Règle :') ? 'Règle' : String(o || '');
{
  const cnt = new Map(); let exposees = 0, eurosExp = 0, avecCle = 0, eurosCle = 0;
  for (const c of REFERENCE.classees) {
    const o = rang(c.origineClassement);
    const e = cnt.get(o) || { n: 0, e: 0 }; e.n++; e.e += c.resteDu || 0; cnt.set(o, e);
    if (APRES_FACTURE.has(o)) {
      exposees++; eurosExp += c.resteDu || 0;
      if (c.cle) { avecCle++; eurosCle += c.resteDu || 0; }
    }
  }
  console.log('   classement des créances de la référence, par rang :');
  for (const [o, e] of [...cnt.entries()].sort((a, b) => b[1].n - a[1].n))
    console.log('       ' + String(o || '(aucun)').padEnd(46) + String(nb(e.n)).padStart(6)
      + '  ' + eur(e.e).padStart(14) + (APRES_FACTURE.has(o) ? '   ← écrasable par Monday' : ''));
  console.log('   créances classées sous le rang « Facture » : ' + nb(exposees)
    + ' · ' + eur(eurosExp));
  console.log('   … dont porteuses d’une clé que Monday peut connaître : ' + nb(avecCle)
    + ' · ' + eur(eurosCle));
  ok('la surface que Monday peut dicter au grand livre est de ' + nb(avecCle)
     + ' créances', avecCle >= 0);
}

// ═══════════ 8. historique: state.grandLivre ═══════════
titre('8 · historique: state.grandLivre, absent de la référence');
// La boucle grandlivre.js:2421-2424 ne note un compte que si idx.parCle connaît
// la clé de la ligne — et parCle n'est alimenté QUE par o.factures (2092).
// Sans financement Monday, « historique » ne peut rien faire : la preuve.
{
  const avecHist = GL.balanceAgee(
    GL.classer(GL.creancesOuvertes(REFERENCE.lu),
      { ...OPT(), historique: REFERENCE.lu.lignes }), REF, RG, 'financement');
  ok('sans financement Monday, « historique » ne change rien — ' + eur(somme(avecHist)),
     Math.abs(somme(avecHist) - somme(suite({ prorata: false }).balance)) < 0.01);
  console.log('   → « historique » n’agit QUE si factures: state.factures porte des');
  console.log('     financements : corriger l’écart 2 désamorce aussi celui-ci.');
}

// ═══════════ le verdict ═══════════
titre('verdict');
console.log('Référence  : ' + eur(somme(base)) + ' · ' + nb(sommeNb(base, 'nbFactures'))
  + ' créances · arrêté au ' + REF.toLocaleDateString('fr-FR'));
console.log('Tranches   : ' + R.AGING_BUCKETS.map(b =>
  b.label + ' ' + eur(tranches(base)[b.key] || 0)).join(' · '));
