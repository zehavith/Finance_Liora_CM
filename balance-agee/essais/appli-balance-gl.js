// ── LA BALANCE ÂGÉE DU GRAND LIVRE, LUE DANS L'APPLICATION ELLE-MÊME ──
//
// Les cas « cas*.js » font tourner le moteur hors du navigateur. Celui-ci fait
// autre chose : il ouvre réellement « Suivi recouvrement », y dépose le grand
// livre, et relève les chiffres que l'application affiche. C'est le seul moyen
// de vérifier que sa suite d'appels — et pas seulement le moteur qu'elle
// partage avec la page publiée — tombe sur la même balance.
//
//   node essais/appli-balance-gl.js
//
// Il sert le dépôt sur un port local, pilote un Chromium, et n'écrit rien.
const path = require('path');
const fs = require('fs');
const http = require('http');
const { chromium } = require('/opt/node-tools/node_modules/playwright');

const DEPOT = path.resolve(__dirname, '..', '..');
const LIVRE = path.resolve(__dirname, '..', 'depot-nouvelle', 'balance-nouvelle.xlsx');
const PORT = 8781;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
                '.css': 'text/css; charset=utf-8', '.json': 'application/json',
                '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };
const ok = (t, c) => { console.log((c ? '  OK  ' : 'ÉCHEC ') + t); if (!c) process.exitCode = 1; };
const eur = n => (Math.round(n * 100) / 100).toLocaleString('fr-FR',
  { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';

const serveur = http.createServer((req, res) => {
  const p = path.join(DEPOT, decodeURIComponent(req.url.split('?')[0]));
  if (!p.startsWith(DEPOT) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) {
    res.writeHead(404); res.end(); return;
  }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(p)] || 'application/octet-stream' });
  fs.createReadStream(p).pipe(res);
});

(async () => {
  await new Promise(r => serveur.listen(PORT, '127.0.0.1', r));
  const nav = await chromium.launch();
  const page = await nav.newPage();
  const soucis = [];
  page.on('pageerror', e => soucis.push(String(e && e.message || e)));
  page.on('console', m => { if (m.type() === 'error') soucis.push(m.text()); });

  console.log('=== la balance âgée du grand livre, dans l’application ===');
  await page.goto('http://127.0.0.1:' + PORT + '/recouvrement/index.html',
    { waitUntil: 'networkidle' });
  await page.waitForFunction(() => !!window.__recouvrement, null, { timeout: 60000 });

  // Le dépôt du grand livre : l'entrée est cachée dans l'onglet Données, mais
  // c'est bien elle que la zone de dépôt actionne.
  await page.setInputFiles('#gl-file-input', LIVRE);
  await page.waitForFunction(
    () => { const s = window.__recouvrement; return !!(s && s.glBalance && s.glBalance.rows); },
    null, { timeout: 300000 });

  const vu = await page.evaluate(() => {
    const s = window.__recouvrement, b = s.glBalance;
    return {
      ecritures: (s.glLignes || []).length,
      creances: (s.glCreances || []).length,
      // `total` est un agrégat, pas un nombre : la somme est dans son
      // propre champ, avec l'échu et le non échu à côté.
      total: b.total.total, echu: b.total.echu, nonEchu: b.total.nonEchu,
      // Le jour, pas l'instant : toISOString() sur un minuit local recule
      // d'une journée dès qu'on est à l'est de Greenwich.
      arrete: b.dateRef ? new Date(b.dateRef).toLocaleDateString('fr-CA') : null,
      prorata: s.glProrata ? {
        lignes: s.glProrata.lignes, comptes: s.glProrata.comptes,
        lignesChangees: s.glProrata.lignesChangees, euros: s.glProrata.euros,
        creances: s.glProrata.creances, creancesChangees: s.glProrata.creancesChangees,
        eurosCreances: s.glProrata.eurosCreances,
        montant: s.glProrata.montant, montantChangees: s.glProrata.montantChangees,
      } : null,
      rows: b.rows.map(r => ({ cle: r.cle, label: r.label, total: r.total, nb: r.nb })),
    };
  });

  console.log('  écritures : ' + vu.ecritures.toLocaleString('fr-FR')
    + ' · créances : ' + vu.creances.toLocaleString('fr-FR')
    + ' · arrêté au ' + vu.arrete);
  console.log('  total : ' + eur(vu.total) + ' · échu ' + eur(vu.echu)
    + ' · non échu ' + eur(vu.nonEchu));

  ok('l’application a construit sa balance âgée', vu.rows.length > 0);
  ok('la répartition au prorata a bien tourné', !!vu.prorata);
  if (vu.prorata) {
    const p = vu.prorata;
    console.log('  réparties au prorata : ' + p.lignes + ' écritures sur ' + p.comptes
      + ' clients mixtes, dont ' + p.lignesChangees + ' changent (' + eur(p.euros) + ')');
    console.log('  … et ' + p.creances + ' soldes de compte, dont ' + p.creancesChangees
      + ' changent (' + eur(p.eurosCreances) + ')');
    console.log('  … règle France Travail : ' + p.montant + ' lignes et soldes, '
      + p.montantChangees + ' changements');
    ok('elle a déplacé des soldes de compte', p.creancesChangees > 0);
  }
  console.log('  ventilation par dispositif :');
  for (const r of vu.rows)
    console.log('     ' + String(r.label || r.cle).padEnd(34)
      + String(r.nb).padStart(6) + '   ' + eur(r.total).padStart(16));

  // ── LA MÊME BALANCE APRÈS RECHARGEMENT ──
  //
  // Le premier calcul part du fichier : les dates y sont des objets Date, qui
  // n'ont traversé aucun stockage. Le second part de l'instantané enregistré,
  // relu au démarrage. C'est ce trajet-là qui reculait toutes les dates d'un
  // jour ; l'essai ne le voit qu'en rechargeant la page.
  console.log('');
  console.log('  — rechargement de la page, sur l’instantané enregistré —');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__recouvrement, null, { timeout: 60000 });
  // L'application ne rejoue pas ses données toute seule : elle propose de les
  // reprendre. C'est ce bouton qui relance la chaîne complète depuis
  // l'instantané enregistré — donc exactement le trajet qu'on veut éprouver.
  await page.waitForSelector('#btn-open-saved:not([hidden])', { timeout: 60000 });
  await page.click('#btn-open-saved');
  try {
    await page.waitForFunction(
      () => { const s = window.__recouvrement; return !!(s && s.glBalance && s.glBalance.rows.length); },
      null, { timeout: 180000 });
  } catch (e) {
    const etat = await page.evaluate(() => {
      const s = window.__recouvrement || {};
      return { ouvertes: (s.glOuvertes || []).length, lignes: (s.glLignes || []).length,
               toutes: (s.glToutes || []).length, balance: !!s.glBalance };
    });
    console.log('  … la balance ne revient pas après rechargement : ' + JSON.stringify(etat));
    throw e;
  }
  const relu = await page.evaluate(() => {
    const b = window.__recouvrement.glBalance;
    return { total: b.total.total, echu: b.total.echu, nonEchu: b.total.nonEchu,
             creances: (window.__recouvrement.glCreances || []).length,
             rows: b.rows.map(r => [r.cle, Math.round((r.total || 0) * 100)]) };
  });
  console.log('  total : ' + eur(relu.total) + ' · échu ' + eur(relu.echu)
    + ' · non échu ' + eur(relu.nonEchu));
  ok('le total survit au rechargement', Math.abs(relu.total - vu.total) < 0.01);
  ok('l’échu et le non échu aussi — aucune date n’a bougé',
     Math.abs(relu.echu - vu.echu) < 0.01 && Math.abs(relu.nonEchu - vu.nonEchu) < 0.01);
  {
    const a = new Map(vu.rows.map(r => [r.cle, Math.round((r.total || 0) * 100)]));
    const z = new Map(relu.rows);
    let bouge = 0;
    for (const k of new Set([...a.keys(), ...z.keys()]))
      if ((a.get(k) || 0) !== (z.get(k) || 0)) bouge++;
    ok('la ventilation par dispositif est identique (' + bouge + ' ligne(s) différente(s))',
       bouge === 0);
  }

  ok('aucune erreur de page', soucis.length === 0);
  for (const s of soucis.slice(0, 5)) console.log('     ' + s);

  await nav.close();
  serveur.close();
})().catch(e => { console.error(e); process.exitCode = 1; serveur.close(); });
