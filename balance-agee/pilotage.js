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

const fs = require('fs'), path = require('path'), os = require('os'), vm = require('vm');
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
// OPCO SUIT LA NATURE DE SA CRÉANCE, 04/11/2026 : « opco si c un B2B tu met ds
// B2B, si c un B2C entreprise tu met ds B2C, si c alternance tu met en
// alternance ».
//
// La règle a trois branches ; les données n'en remplissent qu'une. Mesuré sur
// l'arrêté au 30/10/2026 : les 76 créances OPCO — 129 643,54 € — tiennent sur
// SEIZE comptes, et ces seize comptes ne portent, à part elles, que de
// l'OPCO - Alternance : 1 183 créances, et rien d'autre. Aucune n'est B2B,
// aucune n'est B2C-Entreprise ; leur type de client est uniformément Étatique.
//
// OPCO rejoint donc Alternance, qui est ce que sa troisième branche dicte pour
// chacune des créances qui existent aujourd'hui. Si une créance OPCO B2B ou
// B2C-Entreprise apparaît, rien dans le grand livre ne la distinguera : il
// faudra dire QUELLE COLONNE porte cette nature-là.
//
// « à rattacher » disparaît de la table, mais pas de la page : uniteDe() y
// range encore tout type de financement qu'aucune unité ne réclame, et il se
// lit alors dans le filtre. Un oubli doit se voir.
const UNITES = {
  'Alternance': ['Corporate - Alternance', 'OPCO - Alternance', 'Perso-Alternance',
                 'Alternance', 'OPCO'],
  'Allemagne': ['Interne - DST Allemagne', 'Interco'],
  'B2B': ['B2B'],
  'B2C': ['Financement personnel', 'CPF', 'AIF', 'Region', 'Transition Pro',
          'B2C-Entreprise', 'ETAT', 'Agefiph'],
  'POEI': ['POEI'],
};

const lire = f => JSON.parse(fs.readFileSync(f, 'utf8'));
const ar = x => Math.round(x * 100) / 100;
const num = x => { const n = Number(String(x == null ? '' : x).replace(/\s/g, '').replace(',', '.')); return isNaN(n) ? 0 : n; };
const mois = d => { const s = String(d || ''); return s.length >= 10 ? s.slice(6, 10) + '-' + s.slice(3, 5) : ''; };
const jour = d => { const s = String(d || ''); if (s.length < 10) return null;
  return new Date(+s.slice(6, 10), +s.slice(3, 5) - 1, +s.slice(0, 2)); };
const isoDe = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0')
  + '-' + String(d.getDate()).padStart(2, '0');
const finDeMois = (a, m) => isoDe(new Date(a, m + 1, 0));

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
  // LA LIGNE TOTAL N'EST PAS UN FINANCEMENT. Les deux ventilations publiées
  // par la balance la portent en dernière ligne : l'additionner avec les
  // autres double l'encours — 28,3 M€ au lieu de 14,1 M€, mesuré le 04/11.
  const sansTotal = l => (l || []).filter(r => r.cat !== 'TOTAL');
  return {
    date,
    parFinancement: sansTotal(bal.synthese),
    parTypeClient: sansTotal(bal.syntheseCat),
    total: { total: t.total, echu: t.echu, nonEchu: t.nonEchu, crediteur: t.crediteur,
             nb: t.nb, buckets: t.buckets || [] },
    cohortes: [...coh].map(([c, o]) => { const [fin, m] = c.split('\u0001');
      return { fin, m, f: ar(o.f), r: ar(o.r), n: o.n }; })
      .sort((a, b) => a.m < b.m ? -1 : a.m > b.m ? 1 : (a.fin < b.fin ? -1 : 1)),
  };
}

// ───────── LA PROVISION COMPTABILISÉE, SI ELLE EST DÉPOSÉE ─────────
//
// « je prends le montant comptablement provisionné », 03/11/2026. Il n'est pas
// dans le grand livre clients : celui-ci ne porte que les comptes 411, et
// aucun 491. Elle dépose donc, à part, le grand livre COMPLET — cinquième case
// du bloc de dépôt — et ce fichier n'est lu QUE d'ici, et QUE pour les comptes
// de dépréciation des créances clients.
//
// S'IL N'EST PAS LÀ, ON NE DEVINE PAS. La vignette dira « à compléter » : sa
// règle du 15/10/2026, « il faut mettre à completer ».
const GL_COMPLET = path.join(ICI, 'depot-provision', 'grand-livre-complet.xlsx');
// Le 491 est la dépréciation des comptes de clients. On ne prend que lui :
// le 68174 et le 78174 sont la dotation et la reprise de l'exercice, pas le
// stock, et les additionner au solde les compterait deux fois.
const COMPTE_PROVISION = /^491/;

// UN RELEVÉ DÉPOSÉ À LA MAIN, QUAND PENNYLANE NE REND QU'UN PDF, 04/11/2026.
// Elle a transmis le grand livre des comptes 49 en PDF : le lecteur de
// classeur ne sait pas l'ouvrir. Un petit fichier porte donc les soldes
// relevés, avec leur date et leur provenance, et le même filtre s'y applique —
// seuls les comptes 491 comptent, de sorte que « 4951 COMPTES DU GROUPE »
// reste dehors, comme il doit l'être : l'intragroupe se provisionne à 0 %.
const RELEVE_PROVISION = path.join(ICI, 'depot-provision', 'provision-comptabilisee.json');

function provisionRelevee() {
  if (!fs.existsSync(RELEVE_PROVISION)) return null;
  let r;
  try { r = JSON.parse(fs.readFileSync(RELEVE_PROVISION, 'utf8')); }
  catch (e) { return { montant: null, motif: 'le relevé de provision est illisible' }; }
  const lignes = (r && r.lignes) || [];
  const garde = lignes.filter(l => COMPTE_PROVISION.test(String(l.compte || '').trim()));
  if (!garde.length) return { montant: null,
    motif: 'le relevé de provision ne porte aucun compte 491' };
  const solde = garde.reduce((s, l) => s + (num(l.credit) - num(l.debit)), 0);
  return { montant: ar(solde), lignes: garde.length,
    comptes: garde.map(l => String(l.compte).trim()).sort(),
    feuille: 'relevé déposé', au: r.au || '', source: r.source || '', motif: '' };
}

function provisionComptabilisee(jusquA) {
  if (!fs.existsSync(GL_COMPLET)) {
    const r = provisionRelevee();
    if (r) return r;
    return { montant: null, motif: 'le grand livre complet n’est pas déposé' };
  }
  let X;
  try {
    const ctx = { self: {}, window: {}, console, Buffer, process, TextDecoder, TextEncoder,
                  Date, Math, JSON, setTimeout, clearTimeout };
    ctx.self = ctx; ctx.window = ctx; ctx.globalThis = ctx; ctx.global = ctx;
    vm.createContext(ctx);
    vm.runInContext(fs.readFileSync(path.join(ICI, '..', 'vendor', 'xlsx.full.min.js'), 'utf8'), ctx);
    X = ctx.XLSX;
  } catch (e) { return { montant: null, motif: 'la bibliothèque de lecture n’a pas pu être chargée' }; }

  let wb;
  try {
    wb = X.read(new Uint8Array(fs.readFileSync(GL_COMPLET)),
      { type: 'array', raw: true, cellDates: false, cellStyles: false, cellFormula: false });
  } catch (e) { return { montant: null, motif: 'le classeur n’a pas pu être ouvert' }; }

  // LA FEUILLE SE RECONNAÎT À SES COLONNES, PAS À SON NOM. Un export Pennylane
  // change d'intitulé d'un mois à l'autre ; ses colonnes, non.
  const norm = x => String(x == null ? '' : x).replace(/[\r\n]+/g, ' ').trim().toLowerCase();
  const num = x => { const n = Number(String(x == null ? '' : x).replace(/\s/g, '').replace(',', '.'));
    return isNaN(n) ? 0 : n; };
  const limite = jusquA ? jour(jusquA) : null;
  for (const nom of wb.SheetNames) {
    const m = X.utils.sheet_to_json(wb.Sheets[nom], { header: 1, defval: '', raw: true, blankrows: false });
    for (let t = 0; t < Math.min(12, m.length); t++) {
      const e = (m[t] || []).map(norm);
      const iC = e.findIndex(x => /^(n°\s*)?(de\s*)?compte|num[ée]ro de compte/.test(x));
      const iD = e.findIndex(x => /^d[ée]bit$/.test(x));
      const iR = e.findIndex(x => /^cr[ée]dit$/.test(x));
      if (iC < 0 || iD < 0 || iR < 0) continue;
      const iDate = e.findIndex(x => /^date$/.test(x));
      let solde = 0, lignes = 0, comptes = new Set();
      for (let k = t + 1; k < m.length; k++) {
        const r = m[k] || [];
        const c = String(r[iC] == null ? '' : r[iC]).trim();
        if (!COMPTE_PROVISION.test(c)) continue;
        if (limite && iDate >= 0) { const d = jour(r[iDate]); if (d && d > limite) continue; }
        // Un compte de dépréciation est créditeur : le stock est crédit − débit.
        solde += num(r[iR]) - num(r[iD]);
        lignes++; comptes.add(c);
      }
      if (!lignes) return { montant: null,
        motif: 'le grand livre complet est déposé, mais ne porte aucun compte 491' };
      return { montant: ar(solde), lignes, comptes: [...comptes].sort(),
        feuille: nom, motif: '' };
    }
  }
  return { montant: null, motif: 'aucune feuille du classeur ne ressemble à un grand livre' };
}

// ───────── les flux, le délai de règlement, les vintages ─────────
// DES PALIERS ASSEZ FINS POUR LIRE UN CROISEMENT, 04/11/2026 : « on doit pv
// voir 80% de mon encours et payé av X j ». Six paliers donnaient une courbe
// qui sautait de 90 à 120 jours : le jour cherché tombait dans le trou. Ils ne
// coûtent qu'un compteur de plus chacun.
const PALIERS = [15, 30, 45, 60, 75, 90, 120, 150, 180, 240, 300, 360, 540, 720];
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
//
// ET EN ISO COMME LES DOUZE AUTRES. La balance date son arrêté en français —
// « 30/10/2026 » — et le poser tel quel dans une liste de dates ISO rendait la
// dernière incomparable aux précédentes : tout filtre de période la perdait.
const ARRETE = isoDe(dArrete);
dates[dates.length - 1] = ARRETE;

console.log('relevé du pilotage — ' + NB_MOIS + ' arrêtés, du ' + dates[0] + ' au ' + dates[dates.length - 1]);
// LE CUBE D'UN ARRÊTÉ SE GARDE. Chacun coûte quatre minutes de calcul pour
// quelques dizaines de kilo-octets : les refaire à chaque relevé — ou après la
// moindre interruption — serait une demi-heure perdue à chaque fois. Le cache
// est daté par l'arrêté : un nouveau grand livre change les arrêtés passés
// (une facture soldée depuis redevient due), donc il est vidé dès que la
// balance du jour change de date.
const CACHE = path.join(ICI, 'art', 'pilotage-cubes');
fs.mkdirSync(CACHE, { recursive: true });
{
  const marque = path.join(CACHE, 'arrete.txt');
  const vu = fs.existsSync(marque) ? fs.readFileSync(marque, 'utf8').trim() : '';
  if (vu !== ARRETE) {
    for (const f of fs.readdirSync(CACHE)) fs.rmSync(path.join(CACHE, f), { force: true });
    fs.writeFileSync(marque, ARRETE);
    if (vu) console.log('  (le grand livre a changé : les cubes gardés sont effacés)');
  }
}
const cubes = [];
for (const d of dates) {
  const garde = path.join(CACHE, d + '.json');
  if (fs.existsSync(garde)) {
    const c = lire(garde); cubes.push(c);
    console.log('  ' + d + ' — cube déjà calculé   encours '
      + Math.round((c.total || {}).total || 0).toLocaleString('fr-FR') + ' €');
    continue;
  }
  const deja = path.join(ICI, 'art', 'arretes', 'balance-' + d + '.json');
  let b;
  if (d === ARRETE) { b = bal; process.stdout.write('  ' + d + ' — la balance du jour'); }
  else if (fs.existsSync(deja)) { b = lire(deja); process.stdout.write('  ' + d + ' — arrêté déjà construit'); }
  else { process.stdout.write('  ' + d + ' — construction…'); b = arreterAilleurs(d); }
  const c = cube(b, d);
  fs.writeFileSync(garde, JSON.stringify(c));
  cubes.push(c);
  console.log('   encours ' + Math.round(c.total.total || 0).toLocaleString('fr-FR')
    + ' € · ' + (c.total.nb || 0) + ' créances');
}

const f = flux(bal);
const prov = provisionComptabilisee(bal.arrete);
const tm = f.dso.reduce((a, r) => a + r.mt, 0), tj = f.dso.reduce((a, r) => a + r.mj, 0);

const releve = {
  arrete: ARRETE,
  arreteFR: bal.arrete,
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
    // Ce que le barème produit vit dans la balance. Ici on ne porte que le
    // montant COMPTABLEMENT provisionné, lu dans le grand livre complet quand
    // il est déposé — et null sinon, pour que la vignette dise « à compléter »
    // plutôt qu'un chiffre faux.
    comptabilisee: prov.montant,
    provisionLue: prov.montant === null ? null
      : { lignes: prov.lignes, comptes: prov.comptes, feuille: prov.feuille,
          au: prov.au || '', source: prov.source || '' },
    provisionMotif: prov.motif || '',
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
  + '\n  vintages  : ' + f.vintage.length + ' cohortes × financement'
  + '\n  provision : ' + (prov.montant === null
      ? 'à compléter — ' + prov.motif
      : Math.round(prov.montant).toLocaleString('fr-FR') + ' € · ' + prov.lignes
        + ' écritures sur ' + prov.comptes.length + ' compte(s) '
        + prov.comptes.join(', ') + ' · feuille « ' + prov.feuille + ' »'));
