// ══════════════════════════════════════════════════════════════════════
//  SELLSY ET PENNYLANE, ÉPROUVÉS SANS SELLSY NI PENNYLANE
// ══════════════════════════════════════════════════════════════════════
//
// Les deux services ne sont pas joignables depuis ici, et ce code n'a donc
// jamais parlé à l'un d'eux. Ce qu'on PEUT éprouver, c'est tout le reste —
// et c'est la plus grande part : l'authentification est envoyée comme il
// faut, la pagination suit son curseur jusqu'au bout, les réponses sont
// mises à plat, les lignes entrent par la même porte qu'un fichier déposé,
// et le grand livre qui en sort donne une balance.
//
// Le faux service répond ce que la documentation décrit — enveloppe,
// curseur, noms de champs. Si le vrai service répond autre chose, c'est
// le bouton « Tester » qui le dira, chez elle, en nommant les colonnes.
//
//   node recouvrement/artefact/essai-connecteurs.js
//
const path = require('path'), fs = require('fs'), http = require('http');
const { chromium } = require('/opt/node-tools/node_modules/playwright');

const PAQUET = path.join(__dirname, 'paquet');
const PORT = 8797;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
                '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.woff2': 'font/woff2' };
const ok = (t, c) => { console.log((c ? '  OK  ' : 'ÉCHEC ') + t); if (!c) process.exitCode = 1; };

const serveur = http.createServer((q, r) => {
  const p = path.join(PAQUET, decodeURIComponent(q.url.split('?')[0]));
  if (!p.startsWith(PAQUET) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { r.writeHead(404); r.end(); return; }
  r.writeHead(200, { 'Content-Type': TYPES[path.extname(p)] || 'application/octet-stream' });
  fs.createReadStream(p).pipe(r);
});

// Le faux service, posé dans la page avant tout le reste.
const FAUX = `
window.__appels = [];
(function () {
  const vrai = window.fetch;
  // Deux pages de grand livre, deux pages de factures. Les noms de champs
  // sont ceux que la documentation décrit, imbriqués comme une API le fait.
  const ligneGL = (i, page) => ({
    id: 'l' + page + '-' + i,
    date: '2026-10-' + String(10 + (i % 10)).padStart(2, '0'),
    label: 'FACT-2026-' + (1000 + page * 10 + i) + ' — formation CPF',
    debit: i % 3 === 0 ? 0 : 1200 + i,
    credit: i % 3 === 0 ? 600 : 0,
    lettering: i % 2 === 0 ? 'AB' + i : null,
    journal: { code: 'VE', label: 'Ventes' },
    ledger_account: { number: '4110CLI0' + (100 + (i % 7)), label: 'Client ' + (i % 7) },
    third_party: { id: 'T-' + (i % 7), name: 'Client Essai ' + (i % 7) },
    invoice_number: 'FACT-2026-' + (1000 + page * 10 + i),
    due_date: '2026-11-' + String(10 + (i % 10)).padStart(2, '0'),
    currency: 'EUR',
  });
  const facture = (i, page) => ({
    id: page * 100 + i,
    number: 'FACT-2026-' + (1000 + page * 10 + i),
    subject: 'Formation',
    created: '2026-09-' + String(1 + (i % 28)).padStart(2, '0'),
    due_date: '2026-10-' + String(1 + (i % 28)).padStart(2, '0'),
    status: i % 2 ? 'paid' : 'due',
    amounts: { total_excluding_tax: '1000.00', total_including_tax: '1200.00', due: i % 2 ? '0.00' : '1200.00' },
    related: [{ type: 'individual', id: 50 + (i % 7), name: 'Client Essai ' + (i % 7) }],
  });

  window.fetch = async function (url, opts) {
    const u = String(url);
    window.__appels.push({ url: u, methode: (opts && opts.method) || 'GET',
                           entetes: Object.assign({}, (opts && opts.headers) || {}) });

    // L'échange des identifiants Sellsy contre un jeton.
    if (/access-tokens/.test(u)) {
      const corps = JSON.parse((opts && opts.body) || '{}');
      if (corps.grant_type !== 'client_credentials' || !corps.client_id || !corps.client_secret)
        return new Response(JSON.stringify({ error: 'invalid_request' }), { status: 400 });
      return new Response(JSON.stringify({ access_token: 'JETON-SELLSY', expires_in: 3600 }),
        { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    // Pennylane : curseur, enveloppe { items, has_more, next_cursor }.
    if (/ledger_entry_lines/.test(u)) {
      if (!/Bearer /.test(((opts && opts.headers) || {})['Authorization'] || ''))
        return new Response(JSON.stringify({ message: 'unauthorized' }), { status: 401 });
      const limite = Number((u.match(/limit=(\\d+)/) || [])[1] || 20);
      const curseur = (u.match(/cursor=([^&]+)/) || [])[1] || null;
      if (limite === 1) return new Response(JSON.stringify(
        { items: [ligneGL(1, 1)], has_more: true, next_cursor: 'c2' }), { status: 200 });
      const page = curseur === 'c2' ? 2 : 1;
      const items = Array.from({ length: page === 1 ? 100 : 37 }, (_, i) => ligneGL(i + 1, page));
      return new Response(JSON.stringify(
        { items, has_more: page === 1, next_cursor: page === 1 ? 'c2' : null }), { status: 200 });
    }

    // Sellsy : décalage, enveloppe { data, pagination }.
    if (/\\/invoices/.test(u)) {
      if (((opts && opts.headers) || {})['Authorization'] !== 'Bearer JETON-SELLSY')
        return new Response(JSON.stringify({ message: 'forbidden' }), { status: 403 });
      const limite = Number((u.match(/limit=(\\d+)/) || [])[1] || 20);
      const off = (u.match(/offset=([^&]+)/) || [])[1] || null;
      if (limite === 1) return new Response(JSON.stringify(
        { data: [facture(1, 1)], pagination: { limit: 1, count: 1, total: 137, offset: 'o2' } }), { status: 200 });
      const page = off === 'o2' ? 2 : 1;
      const data = Array.from({ length: page === 1 ? 100 : 37 }, (_, i) => facture(i + 1, page));
      return new Response(JSON.stringify({ data, pagination:
        { limit: 100, count: data.length, total: 137, offset: page === 1 ? 'o2' : null } }), { status: 200 });
    }
    return vrai.apply(this, arguments);
  };
})();
`;

(async () => {
  await new Promise(x => serveur.listen(PORT, '127.0.0.1', x));
  const nav = await chromium.launch();
  const page = await nav.newPage({ viewport: { width: 1440, height: 900 } });
  const soucis = [];
  page.on('pageerror', e => soucis.push('erreur : ' + (e && e.message || e)));
  page.on('console', m => { if (m.type() === 'error') soucis.push('console : ' + m.text()); });
  await page.addInitScript(FAUX);

  console.log('=== Sellsy et Pennylane, contre un service simulé ===');
  await page.goto('http://127.0.0.1:' + PORT + '/essai.html', { waitUntil: 'networkidle' });
  await page.waitForFunction(() => !!window.__recouvrement, null, { timeout: 60000 });
  await page.click('#btn-demo');
  await page.waitForSelector('.nav-tab[data-tab="donnees"]', { state: 'visible', timeout: 60000 });
  await page.click('.nav-tab[data-tab="donnees"]');
  await page.waitForSelector('#carte-api', { timeout: 30000 });
  ok('la carte des deux services est là', true);

  const lire = async sel => (await page.textContent(sel) || '').trim();
  const journal = async () => (await page.textContent('#api-journal') || '');

  // ── 1. Pennylane : tester ──
  await page.fill('#pl-jeton', 'JETON-PENNYLANE');
  await page.click('#btn-pl-tester');
  await page.waitForFunction(() => !/en cours/.test(
    (document.querySelector('#pl-etat') || {}).textContent || 'en cours'), null, { timeout: 60000 });
  const etatPL = await lire('#pl-etat');
  console.log('  Pennylane · ' + etatPL.slice(0, 150));
  ok('le test Pennylane aboutit', /Connexion établie/.test(etatPL));
  {
    const j = await journal();
    const m = (j.match(/reconnu : (.*)/) || [])[1] || '';
    const q = (j.match(/MANQUE : (.*)/) || [])[1] || '';
    console.log('     reconnu : ' + m);
    if (q) console.log('     manque  : ' + q);
    ok('il dit ce qu’il a reconnu', m.length > 0);
    ok('le compte, la date, le libellé, le débit et le crédit sont reconnus',
       ['compte client', 'date de l’écriture', 'libellé de ligne', 'débit', 'crédit']
         .every(x => m.includes(x)));
  }
  {
    const appels = await page.evaluate(() => window.__appels);
    const a = appels.find(x => /ledger_entry_lines/.test(x.url));
    ok('le jeton part en « Bearer »', /^Bearer JETON-PENNYLANE$/.test(a.entetes['Authorization']));
    ok('une seule ligne est demandée pour le test', /limit=1(&|$)/.test(a.url));
  }

  // ── 2. Pennylane : charger ──
  await page.click('#btn-pl-charger');
  await page.waitForFunction(() => {
    const t = (document.querySelector('#pl-etat') || {}).textContent || '';
    return /intégrées|n’a rendu|Impossible|refusé|répondu/.test(t);
  }, null, { timeout: 300000 });
  const chargePL = await lire('#pl-etat');
  console.log('  Pennylane · ' + chargePL.slice(0, 150));
  ok('les deux pages sont lues et intégrées — 137 lignes', /137 lignes intégrées/.test(chargePL));
  {
    const appels = await page.evaluate(() =>
      window.__appels.filter(a => /ledger_entry_lines/.test(a.url) && !/limit=1(&|$)/.test(a.url)));
    ok('la pagination a suivi le curseur', appels.length === 2 && /cursor=c2/.test(appels[1].url));
  }
  {
    const gl = await page.evaluate(() => {
      const s = window.__recouvrement;
      return { lignes: (s.glLignes || []).length, creances: (s.glCreances || []).length,
               fichier: (s.glLecture || {}).fichier || '' };
    });
    console.log('     grand livre : ' + gl.lignes + ' écritures · ' + gl.creances + ' créances · « ' + gl.fichier + ' »');
    ok('le grand livre est entré par la porte des fichiers', /Pennylane \(API\)/.test(gl.fichier));
    ok('les écritures sont là', gl.lignes === 137);
    ok('et elles produisent des créances', gl.creances > 0);
  }

  // ── 3. Sellsy ──
  await page.fill('#sy-id', 'ID-ESSAI');
  await page.fill('#sy-secret', 'SECRET-ESSAI');
  await page.click('#btn-sy-tester');
  await page.waitForFunction(() => !/en cours/.test(
    (document.querySelector('#sy-etat') || {}).textContent || 'en cours'), null, { timeout: 60000 });
  const etatSY = await lire('#sy-etat');
  console.log('  Sellsy · ' + etatSY.slice(0, 150));
  ok('le test Sellsy aboutit', /Connexion établie/.test(etatSY));
  {
    const appels = await page.evaluate(() => window.__appels);
    const jet = appels.find(a => /access-tokens/.test(a.url));
    ok('les identifiants sont échangés contre un jeton', !!jet && jet.methode === 'POST');
    const inv = appels.find(a => /\/invoices/.test(a.url));
    ok('le jeton obtenu sert aux appels suivants',
       inv && inv.entetes['Authorization'] === 'Bearer JETON-SELLSY');
  }

  await page.click('#btn-sy-charger');
  await page.waitForFunction(() => {
    const t = (document.querySelector('#sy-etat') || {}).textContent || '';
    return /intégrées|n’a rendu|Impossible|refusé|répondu/.test(t);
  }, null, { timeout: 300000 });
  const chargeSY = await lire('#sy-etat');
  console.log('  Sellsy · ' + chargeSY.slice(0, 150));
  ok('les 137 factures sont lues', /137 factures/.test(chargeSY));

  // ── 4. Un jeton refusé se dit, et ne casse rien ──
  await page.fill('#pl-jeton', '');
  await page.click('#btn-pl-tester');
  await page.waitForTimeout(600);
  ok('un jeton vide est refusé avant l’appel', /Collez d’abord/.test(await lire('#pl-etat')));

  ok('aucune erreur de page', soucis.length === 0);
  for (const s of [...new Set(soucis)].slice(0, 6)) console.log('     ' + s);

  await nav.close();
})().catch(e => { console.error(e); process.exitCode = 1; })
  .finally(() => { serveur.close(); serveur.closeAllConnections && serveur.closeAllConnections();
                   setTimeout(() => process.exit(process.exitCode || 0), 400).unref(); });
