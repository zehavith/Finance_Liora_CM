// ═══════════ LE RELEVÉ DU PILOTAGE ═══════════
//
// L'onglet « Pilotage » du suivi recouvrement prend ses chiffres dans la
// COMPTABILITÉ. Or le paquet publié de cette application ne porte que les
// tableaux Monday : le grand livre n'y entre pas, et l'API Pennylane est hors
// d'atteinte depuis un artefact. Ce programme fabrique donc, à côté de la
// balance âgée, un relevé précalculé — art/pilotage.json — que la construction
// du suivi recouvrement recopie dans son paquet.
//
// CE QU'IL CONTIENT, ET D'OÙ ÇA VIENT :
//   · l'encours de treize fins de mois, VENTILÉ PAR TYPE DE FINANCEMENT ET PAR
//     TRANCHE. Chaque point est un VRAI ARRÊTÉ : construire.js --arrete refait
//     le lettrage, le rapprochement, l'imputation au prorata et l'ancienneté à
//     la date demandée. Un arrêté déjà construit dans art/arretes est repris
//     tel quel ; les autres sont construits dans un dossier à part, et le gros
//     fichier est effacé sitôt son cube extrait — treize balances pèsent
//     180 Mo pour quelques centaines de kilo-octets utiles.
//   · les flux du mois — facturé, encaissé, avoirs — lus une fois sur la
//     balance du jour, qui porte toutes les écritures.
//   · le délai de règlement et les vintages, mesurés facture par facture.
//
// AUCUN ARRÊTÉ N'EST DÉPOSÉ DANS art/arretes : la liste des dates offertes
// dans la balance âgée cliente ne doit pas changer sans qu'elle le demande.
//
//   cd balance-agee && node pilotage.js
//
// Compter trois à quatre minutes par arrêté manquant.

const fs = require('fs'), path = require('path'), os = require('os');
const { execFileSync } = require('child_process');

const ICI = __dirname;
const SORTIE = path.join(ICI, 'art', 'pilotage.json');
const NB_MOIS = 13;

// ── LE RATTACHEMENT D'UN TYPE DE FINANCEMENT À SON ÉQUIPE COMMERCIALE ──
//
// Sa règle du 03/11/2026, mot pour mot : « ETAT c du B2C, Perso-Alternance
// c de l'alternance, Interco met dans allemagne pour l'instant et Agefiph
// ds B2C ». Pour OPCO elle a répondu « ça dépend si il est classé en B2B ou
// B2C entreprise » — or le grand livre facture l'OPCO lui-même (AKTO, Opco 2i,
// AFDAS…), porte « Étatique » sur ses 525 créances, et ne dit nulle part si
// l'entreprise derrière est B2B ou B2C-Entreprise. Tant qu'elle ne tranche
// pas, OPCO reste donc À RATTACHER — visible, et jamais fondu dans une équipe.
// Sa règle du 14/10 : « si tu n'es pas sûr ne classe pas ».
const UNITES = {
  'Alternance': ['Corporate - Alternance', 'OPCO - Alternance', 'Perso-Alternance', 'Alternance'],
  'Allemagne': ['Interne - DST Allemagne', 'Interco'],
  'B2B': ['B2B'],
  'B2C': ['Financement personnel', 'CPF', 'AIF', 'Region', 'Transition Pro',
          'B2C-Entreprise', 'ETAT', 'Agefiph'],
  'POEI': ['POEI'],
  'à rattacher': ['OPCO'],
};

const lire = f => JSON.parse(fs.readFileSync(f, 'utf8'));
const ar = x => Math.round(x * 100) / 100;
const num = x => { const n = Number(String(x == null ? '' : x).replace(/\s/g, '').replace(',', '.')); return isNaN(n) ? 0 : n; };
const mois = d => { const s = String(d || ''); return s.length >= 10 ? s.slice(6, 10) + '-' + s.slice(3, 5) : ''; };
const jour = d => { const s = String(d || ''); if (s.length < 10) return null;
  return new Date(+s.slice(6, 10), +s.slice(3, 5) - 1, +s.slice(0, 2)); };
const finDeMois = (a, m) => { const d = new Date(a, m + 1, 0);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0')
    + '-' + String(d.getDate()).padStart(2, '0'); };

// ───────── le cube d'un arrêté ─────────
function cube(bal, date) {
  const V = (l, i) => { const x = l[i]; return typeof x === 'number' ? bal.dico[x] : x; };
  const col = n => bal.cols.indexOf(n);
  const iCle = col('Clé de la créance'), iNat = col('Nature de l’écriture'),
        iRd = col('Reste dû de la créance'), iDeb = col('Débit'),
        iDf = col('Date de facture (facturation)') >= 0
            ? col('Date de facture (facturation)') : col('Date'),
        iD = col('Date'),
        iFin = col('Type de financement de la créance') >= 0
             ? col('Type de financement de la créance') : col('Type de financement');
  // LA COHORTE EST CELLE DE LA FACTURE, et la créance ne se compte qu'une fois :
  // le détail répète son reste dû sur chacune de ses écritures.
  const coh = new Map(), vues = new Set();
  for (const l of bal.lignes) {
    if (String(V(l, iNat)) !== 'facture') continue;
    const k = V(l, iCle); if (!k || vues.has(k)) continue; vues.add(k);
    const m = mois(V(l, iDf)) || mois(V(l, iD)); if (!m) continue;
    const fin = String(V(l, iFin) || '(à compléter)');
    const c = fin + '\u0001' + m;
    const o = coh.get(c) || { f: 0, r: 0, n: 0 };
    o.f += num(V(l, iDeb)); o.r += num(V(l, iRd)); o.n++;
    coh.set(c, o);
  }
  const t = (bal.syntheseCat || []).find(r => r.cat === 'TOTAL') || {};
  return {
    date,
    parFinancement: bal.synthese || [],
    parTypeClient: (bal.syntheseCat || []).filter(r => r.cat !== 'TOTAL'),
    total: { total: t.total, echu: t.echu, nonEchu: t.nonEchu, crediteur: t.crediteur,
             nb: t.nb, buckets: t.buckets || [] },
    cohortes: [...coh].map(([c, o]) => { const [fin, m] = c.split('\u0001');
      return { fin, m, f: ar(o.f), r: ar(o.r), n: o.n }; })
      .sort((a, b) => a.m < b.m ? -1 : a.m > b.m ? 1 : (a.fin < b.fin ? -1 : 1)),
  };
}

// ───────── les flux, le délai de règlement, les vintages ─────────
const PALIERS = [30, 60, 90, 120, 180, 360];
function flux(bal) {
  const V = (l, i) => { const x = l[i]; return typeof x === 'number' ? bal.dico[x] : x; };
  const col = n => bal.cols.indexOf(n);
  const iDate = col('Date'), iNat = col('Nature de l’écriture'), iJrn = col('Journal'),
        iDeb = col('Débit'), iCre = col('Crédit'), iFac = col('N° de facture'),
        iFR = col('Facture rattachée'), iDf = col('Date de facture (facturation)'),
        iFin = col('Type de financement de la créance') >= 0
             ? col('Type de financement de la créance') : col('Type de financement');
  const AN = /^an/i;
  // La date d'émission de chaque facture : la plus ancienne qu'on lui connaisse.
  const dateFacture = new Map();
  for (const l of bal.lignes) {
    if (String(V(l, iNat)) !== 'facture') continue;
    const n = String(V(l, iFac) || '').trim(); if (!n) continue;
    const d = jour(V(l, iDf)) || jour(V(l, iDate)); if (!d) continue;
    const v = dateFacture.get(n); if (!v || d < v) dateFacture.set(n, d);
  }
  const F = new Map(), DSO = new Map(), VINT = new Map();
  let sansFacture = 0, mSansFacture = 0, sansDate = 0, mSansDate = 0;
  const pose = (M, k, vide) => { let o = M.get(k); if (!o) { o = vide(); M.set(k, o); } return o; };
  for (const l of bal.lignes) {
    // LES REPORTS À NOUVEAU NE SONT NI UNE FACTURATION NI UN ENCAISSEMENT.
    // Une facture reprise au 01/07 n'est pas facturée en juillet, et un
    // règlement repris porte la date de la reprise : son délai serait faux.
    if (AN.test(String(V(l, iJrn) || ''))) continue;
    const nat = String(V(l, iNat) || '');
    const m = mois(V(l, iDate)); if (!m) continue;
    const fin = String(V(l, iFin) || '(à compléter)');
    const k = m + '\u0001' + fin;
    const o = pose(F, k, () => ({ fac: 0, enc: 0, avo: 0, nFac: 0, nEnc: 0 }));
    if (nat === 'facture') {
      o.fac += num(V(l, iDeb)); o.nFac++;
      const c = pose(VINT, (mois(V(l, iDf)) || m) + '\u0001' + fin,
        () => ({ fac: 0, nFac: 0, p: PALIERS.map(() => 0) }));
      c.fac += num(V(l, iDeb)); c.nFac++;
    }
    if (nat === 'avoir') o.avo += num(V(l, iCre)) - num(V(l, iDeb));
    if (nat !== 'reglement') continue;
    const montant = num(V(l, iCre)) - num(V(l, iDeb));
    o.enc += montant; o.nEnc++;
    const nf = String(V(l, iFR) || '').trim();
    if (!nf) { sansFacture++; mSansFacture += montant; continue; }
    const df = dateFacture.get(nf);
    const dr = jour(V(l, iDate));
    if (!df || !dr) { sansDate++; mSansDate += montant; continue; }
    const j = Math.round((dr - df) / 86400000);
    const d = pose(DSO, k, () => ({ mt: 0, mj: 0, n: 0 }));
    d.mt += montant; d.mj += montant * j; d.n++;
    const coh = df.getFullYear() + '-' + String(df.getMonth() + 1).padStart(2, '0');
    const c = VINT.get(coh + '\u0001' + fin);
    if (c) PALIERS.forEach((p, i) => { if (j <= p) c.p[i] += montant; });
  }
  const plat = (M, f) => [...M].map(([k, o]) => { const [m, fin] = k.split('\u0001');
    return Object.assign({ m, fin }, f(o)); })
    .sort((a, b) => a.m < b.m ? -1 : a.m > b.m ? 1 : (a.fin < b.fin ? -1 : 1));
  return {
    flux: plat(F, o => ({ fac: ar(o.fac), enc: ar(o.enc), avo: ar(o.avo), nFac: o.nFac, nEnc: o.nEnc })),
    dso: plat(DSO, o => ({ mt: ar(o.mt), mj: ar(o.mj), n: o.n })),
    vintage: plat(VINT, o => ({ fac: ar(o.fac), nFac: o.nFac, p: o.p.map(ar) })),
    ecartes: { sansFacture, montantSansFacture: ar(mSansFacture),
               sansDate, montantSansDate: ar(mSansDate) },
  };
}

// ───────── construire un arrêté dans un dossier à part ─────────
function arreterAilleurs(date) {
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'pilotage-'));
  try {
    for (const d of ['depot-ancienne', 'depot-nouvelle', 'depot-sellsy', 'depot-ech'])
      fs.symlinkSync(path.join(ICI, d), path.join(T, d));
    for (const f of ['Reference-septembre.xlsx', 'complements.json', 'mandats.json',
                     'parametres.json', 'principale.json'])
      if (fs.existsSync(path.join(ICI, f))) fs.symlinkSync(path.join(ICI, f), path.join(T, f));
    execFileSync(process.execPath, [path.join(ICI, 'construire.js'), '--arrete', date],
      { cwd: T, stdio: ['ignore', 'ignore', 'ignore'], maxBuffer: 1 << 28 });
    const f = path.join(T, 'art', 'balance.json');
    if (!fs.existsSync(f)) throw new Error('aucune balance produite');
    return lire(f);
  } finally { fs.rmSync(T, { recursive: true, force: true }); }
}

// ───────── le relevé ─────────
const bal = lire(path.join(ICI, 'art', 'balance.json'));
const dArrete = jour(bal.arrete) || new Date();
const dates = [];
for (let k = NB_MOIS - 1; k >= 0; k--) {
  const d = new Date(dArrete.getFullYear(), dArrete.getMonth() - k, 1);
  dates.push(finDeMois(d.getFullYear(), d.getMonth()));
}
// Le dernier point est la balance du jour, pas la fin du mois en cours : c'est
// elle qui est publiée, et les deux doivent se recoller au centime.
dates[dates.length - 1] = bal.arrete;

console.log('relevé du pilotage — ' + NB_MOIS + ' arrêtés, du ' + dates[0] + ' au ' + dates[dates.length - 1]);
const cubes = [];
for (const d of dates) {
  const deja = path.join(ICI, 'art', 'arretes', 'balance-' + d + '.json');
  let b;
  if (d === bal.arrete) { b = bal; process.stdout.write('  ' + d + ' — la balance du jour'); }
  else if (fs.existsSync(deja)) { b = lire(deja); process.stdout.write('  ' + d + ' — arrêté déjà construit'); }
  else { process.stdout.write('  ' + d + ' — construction…'); b = arreterAilleurs(d); }
  const c = cube(b, d);
  cubes.push(c);
  console.log('   encours ' + Math.round(c.total.total || 0).toLocaleString('fr-FR')
    + ' € · ' + (c.total.nb || 0) + ' créances');
}

const f = flux(bal);
const tm = f.dso.reduce((a, r) => a + r.mt, 0), tj = f.dso.reduce((a, r) => a + r.mj, 0);

const releve = {
  arrete: bal.arrete,
  // PAS D'HORODATAGE. Le relevé est recopié dans le paquet du suivi
  // recouvrement, dont l'empreinte décide s'il y a lieu de republier : une
  // heure de génération y changerait à chaque passage et ferait republier une
  // page identique. La date d'arrêté date le relevé, et elle suffit.
  source: 'Grand livre Pennylane — le même que la balance âgée clients',
  tranches: bal.tranches || [],
  paliers: PALIERS,
  unites: UNITES,
  dates,
  // L'encours de chaque arrêté, par type de financement et par tranche.
  encours: cubes.map(c => ({ d: c.date, total: c.total,
    parFinancement: c.parFinancement, parTypeClient: c.parTypeClient })),
  cohortes: cubes.map(c => ({ d: c.date, lignes: c.cohortes })),
  flux: f.flux, dso: f.dso, vintage: f.vintage, ecartes: f.ecartes,
  provision: {
    fenetres: (bal.provision || {}).fenetres || [],
    taux: (bal.provision || {}).taux || {},
    // Ce que le barème produit. Le montant COMPTABLEMENT provisionné, lui,
    // n'est pas dans ce grand livre : il ne porte que les comptes 411, et
    // aucun 491. Tant qu'il n'est pas déposé, la vignette dit « à compléter »
    // plutôt qu'un chiffre faux.
    comptabilisee: null,
  },
};
fs.mkdirSync(path.dirname(SORTIE), { recursive: true });
fs.writeFileSync(SORTIE, JSON.stringify(releve));
const ko = (fs.statSync(SORTIE).size / 1024).toFixed(0);
console.log('\nart/pilotage.json : ' + ko + ' ko'
  + '\n  flux      : ' + f.flux.length + ' couples mois × financement'
  + '\n  délai     : ' + f.dso.reduce((a, r) => a + r.n, 0) + ' règlements · '
    + Math.round(tm).toLocaleString('fr-FR') + ' € · ' + (tm ? Math.round(tj / tm) : 0) + ' jours en moyenne pondérée'
  + '\n  écartés   : ' + f.ecartes.sansFacture + ' sans facture rattachée ('
    + Math.round(f.ecartes.montantSansFacture).toLocaleString('fr-FR') + ' €) · '
    + f.ecartes.sansDate + ' dont la facture n’a pas de date connue ('
    + Math.round(f.ecartes.montantSansDate).toLocaleString('fr-FR') + ' €)'
  + '\n  vintages  : ' + f.vintage.length + ' cohortes × financement');
