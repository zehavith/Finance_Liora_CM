// ══════════════════════════════════════════════════════════════════════
//  LE PAQUET, ÉPROUVÉ SOUS L'ENVELOPPE DU CADRE
// ══════════════════════════════════════════════════════════════════════
//
// Publier d'abord et regarder ensuite coûte une republication à chaque
// surprise. Cet essai sert le paquet tel quel, l'ouvre dans un navigateur
// sous la MÊME enveloppe que la publication pose — même reset, même viewport,
// un faux canal d'enregistrement — et vérifie ce qui doit l'être :
//
//   · la page s'ouvre sans une seule erreur ;
//   · l'accueil propose l'import, et plus le jeton Monday ;
//   · le grand livre d'octobre y entre et donne les mêmes chiffres qu'ailleurs ;
//   · un classeur sort bien par la porte du cadre, en .xlsx et en Blob ;
//   · rien ne déborde à la largeur d'un téléphone.
//
//   node recouvrement/artefact/essayer.js
//
const path = require('path');
const fs = require('fs');
const http = require('http');
const { chromium } = require('/opt/node-tools/node_modules/playwright');

const PAQUET = path.join(__dirname, 'paquet');
const LIVRE = path.resolve(__dirname, '..', '..', 'balance-agee', 'depot-nouvelle', 'balance-nouvelle.xlsx');
const PORT = 8791;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
                '.css': 'text/css; charset=utf-8', '.json': 'application/json',
                '.png': 'image/png', '.woff2': 'font/woff2', '.ico': 'image/x-icon' };
const ok = (t, c) => { console.log((c ? '  OK  ' : 'ÉCHEC ') + t); if (!c) process.exitCode = 1; };
const eur = n => (Math.round(n * 100) / 100).toLocaleString('fr-FR',
  { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';

const serveur = http.createServer((q, r) => {
  const p = path.join(PAQUET, decodeURIComponent(q.url.split('?')[0]));
  if (!p.startsWith(PAQUET) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) {
    r.writeHead(404); r.end(); return;
  }
  r.writeHead(200, { 'Content-Type': TYPES[path.extname(p)] || 'application/octet-stream' });
  fs.createReadStream(p).pipe(r);
});

(async () => {
  await new Promise(x => serveur.listen(PORT, '127.0.0.1', x));
  const nav = await chromium.launch();
  const page = await nav.newPage({ viewport: { width: 1280, height: 900 } });
  const soucis = [];
  page.on('pageerror', e => soucis.push('erreur : ' + (e && e.message || e)));
  page.on('console', m => { if (m.type() === 'error') soucis.push('console : ' + m.text()); });
  page.on('requestfailed', q => soucis.push('ressource : ' + q.url().split('/').pop()));

  console.log('=== le paquet « Suivi recouvrement », sous l’enveloppe du cadre ===');
  await page.goto('http://127.0.0.1:' + PORT + '/essai.html', { waitUntil: 'networkidle' });
  await page.waitForFunction(() => !!window.__recouvrement, null, { timeout: 60000 });

  // ── 1. la page tient debout ──
  const vu = await page.evaluate(() => ({
    titre: document.title,
    biblios: ['XLSX', 'Chart', 'Papa', 'LioraStore', 'LioraRules', 'LioraGrandLivre',
              'LioraIngest', 'LioraMetrics', 'LioraUI', 'LioraZoho', 'LioraSellsy',
              'LioraPrelevements', 'LioraMonday'].filter(n => !window[n]),
    police: getComputedStyle(document.body).fontFamily,
    taille: getComputedStyle(document.body).fontSize,
    schema: getComputedStyle(document.documentElement).colorScheme,
    fond: getComputedStyle(document.body).backgroundColor,
    accueil: !!document.querySelector('#welcome-screen.active'),
    cartes: [...document.querySelectorAll('.connect-grid > .connect-card')]
      .map(c => ({ visible: getComputedStyle(c).display !== 'none',
                   badge: (c.querySelector('.connect-badge') || {}).textContent,
                   titre: (c.querySelector('h3') || {}).textContent })),
    shim: typeof XLSX.writeFile === 'function',
  }));
  console.log('  titre : ' + vu.titre);
  ok('toutes les bibliothèques sont chargées', vu.biblios.length === 0);
  if (vu.biblios.length) console.log('     manquantes : ' + vu.biblios.join(', '));
  ok('la police Inter est résolue — ' + vu.police.split(',')[0], /Inter/.test(vu.police));
  ok('le texte a sa taille — ' + vu.taille, vu.taille === '16px');
  ok('les contrôles natifs suivent le thème sombre — ' + vu.schema, vu.schema === 'dark');
  ok('le corps pose son fond — ' + vu.fond, vu.fond !== 'rgba(0, 0, 0, 0)' && vu.fond !== 'transparent');
  ok('l’écran d’accueil est là', vu.accueil);
  ok('la carte « jeton Monday » est masquée', vu.cartes[0] && !vu.cartes[0].visible);
  ok('l’import est la première étape — « ' + (vu.cartes[1] || {}).titre + ' »',
     !!(vu.cartes[1] && vu.cartes[1].visible && vu.cartes[1].badge === '1'));

  // ── 2. le grand livre entre et donne ses chiffres ──
  await page.setInputFiles('#gl-file-input', LIVRE);
  await page.waitForFunction(
    () => { const s = window.__recouvrement; return !!(s && s.glBalance && s.glBalance.rows.length); },
    null, { timeout: 300000 });
  const bal = await page.evaluate(() => {
    const b = window.__recouvrement.glBalance;
    return { total: b.total.total, echu: b.total.echu, nonEchu: b.total.nonEchu,
             creances: (window.__recouvrement.glCreances || []).length,
             lignes: b.rows.length,
             arrete: b.dateRef ? new Date(b.dateRef).toLocaleDateString('fr-CA') : null };
  });
  console.log('  balance : ' + eur(bal.total) + ' · échu ' + eur(bal.echu)
    + ' · non échu ' + eur(bal.nonEchu) + ' · arrêté au ' + bal.arrete);
  ok('la balance âgée se construit dans le paquet — ' + bal.lignes + ' dispositifs', bal.lignes > 0);
  ok('le total est celui de la balance publiée',
     Math.abs(bal.total - 14268635.41) < 0.01);

  // ── 3. l'application s'ouvre sur sa balance ──
  //
  // Le dépôt se fait depuis l'écran d'accueil, où la barre d'onglets n'existe
  // pas encore. Le chemin qui mène à l'écran de travail est celui qu'une
  // utilisatrice emprunte : rouvrir la page et reprendre les données
  // enregistrées. Il éprouve au passage que ce bouton apparaît quand seul un
  // grand livre a été déposé — ce qu'il ne faisait pas.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__recouvrement, null, { timeout: 60000 });
  await page.waitForSelector('#btn-open-saved:not([hidden])', { timeout: 60000 });
  const repris = await page.textContent('#btn-open-saved');
  ok('un grand livre seul se reprend — « ' + repris.trim() + ' »',
     /créances comptables/.test(repris));
  await page.click('#btn-open-saved');
  await page.waitForFunction(
    () => { const s = window.__recouvrement; return !!(s && s.glBalance && s.glBalance.rows.length); },
    null, { timeout: 300000 });
  ok('elle ouvre directement sur la balance âgée',
     await page.isVisible('.nav-tab[data-tab="aging"].active'));

  // La balance âgée a quatre vues ; celle du grand livre n'est pas celle
  // d'ouverture. C'est aussi par là que passe la confrontation avec Monday.
  await page.click('#seg-aging-source .seg-btn[data-source="gl"]');
  await page.waitForSelector('#aging-gl:not([hidden])', { timeout: 30000 });
  const vueGL = await page.evaluate(() => ({
    titre: (document.querySelector('#aging-gl-titre') || {}).textContent,
    lignes: document.querySelectorAll('#aging-gl-contenu tbody tr').length,
  }));
  ok('la vue du grand livre s’affiche — ' + vueGL.lignes + ' lignes', vueGL.lignes > 0);

  await page.click('#seg-aging-source .seg-btn[data-source="comparaison"]');
  await page.waitForSelector('#aging-comparaison:not([hidden])', { timeout: 30000 });
  ok('la confrontation avec Monday s’affiche',
     await page.isVisible('#aging-cmp-table'));
  await page.click('#seg-aging-source .seg-btn[data-source="gl"]');
  await page.waitForSelector('#aging-gl:not([hidden])', { timeout: 30000 });

  // ── 4. un classeur sort par la porte du cadre ──
  await page.waitForSelector('#btn-gl-aclasser-export', { timeout: 30000 });

  // CE QUI RECOUVRE LE BOUTON.
  //
  // Le premier essai a buté ici : le navigateur amenait le bouton à l'écran
  // et le clic n'arrivait jamais, parce que la barre de navigation et celle
  // des filtres sont collantes et se superposent à ce qui passe dessous. La
  // mesure est faite explicitement — un bouton qu'on ne peut pas atteindre
  // est un bouton qui n'existe pas.
  const recouvert = await page.evaluate(async () => {
    const b = document.querySelector('#btn-gl-aclasser-export');
    // « instant », et une image d'attente : la feuille pose
    // scroll-behavior: smooth, et mesurer avant la fin du défilement donnait
    // un point hors de l'écran — donc « recouvert par rien », ce qui ne
    // voulait rien dire.
    b.scrollIntoView({ block: 'center', behavior: 'instant' });
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const r = b.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    if (x < 0 || y < 0 || x > innerWidth || y > innerHeight)
      return 'hors de l’écran (' + Math.round(x) + ', ' + Math.round(y) + ')';
    const dessus = document.elementFromPoint(x, y);
    return (dessus === b || b.contains(dessus)) ? null
      : ((dessus && (dessus.id || dessus.className || dessus.tagName)) || 'rien');
  });
  ok('le bouton d’export est atteignable' + (recouvert ? ' — recouvert par ' + recouvert : ''),
     recouvert === null);

  // Le clic part du document : on éprouve l'export, pas la souris.
  await page.evaluate(() => document.querySelector('#btn-gl-aclasser-export').click());
  await page.waitForFunction(() => (window.__enregistres || []).length > 0, null, { timeout: 420000 });
  const sortis = await page.evaluate(() => window.__enregistres);
  const f = sortis[0];
  console.log('  enregistré : ' + f.filename + ' · ' + (f.taille / 1024).toFixed(0) + ' Ko');
  ok('le classeur passe par le canal du cadre, pas par un lien', sortis.length === 1);
  ok('il porte un nom en .xlsx', /\.xlsx$/.test(f.filename || ''));
  ok('il est remis en Blob, non en tampon transférable', f.estBlob === true);
  ok('il n’est pas vide — ' + (f.taille / 1024).toFixed(0) + ' Ko', f.taille > 5000);

  // ── 5. ce qui ne peut pas marcher ici ne se propose pas ──
  const neutres = await page.evaluate(() => {
    const etat = {};
    etat['btn-export-pdf'] = document.querySelector('#btn-export-pdf').hidden ? 'retiré' : 'VISIBLE';
    for (const id of ['btn-refresh', 'btn-aging-refresh', 'btn-boards-refresh',
                      'btn-boards-load', 'btn-settings-connect', 'settings-token']) {
      const e = document.querySelector('#' + id);
      etat[id] = !e ? 'absent'
        : (e.offsetParent === null || getComputedStyle(e).display === 'none') ? 'masqué' : 'VISIBLE';
    }
    return etat;
  });
  const visibles = Object.entries(neutres).filter(([, v]) => v === 'VISIBLE').map(([k]) => k);
  ok('aucune commande Monday ne reste proposée' + (visibles.length ? ' — ' + visibles.join(', ') : ''),
     visibles.length === 0);

  // ── 6. la largeur d’un téléphone, onglet par onglet ──
  await page.setViewportSize({ width: 400, height: 900 });
  const ONGLETS = ['dashboard', 'aging', 'factures', 'donnees'];
  let deborde = [];
  for (const o of ONGLETS) {
    await page.click('.nav-tab[data-tab="' + o + '"]');
    await page.waitForTimeout(500);
    // CE QUI COMPTE EST CE QUE LA PERSONNE PEUT FAIRE, PAS CE QUE LE
    // DOCUMENT MESURE. scrollWidth compte un contenu qui dépasse même quand
    // la page refuse de le montrer — et la feuille pose overflow-x: hidden
    // sur le corps. On essaie donc de défiler pour de bon : si la page ne
    // bouge pas, elle ne défile pas, quel que soit le chiffre.
    const l = await page.evaluate(() => {
      window.scrollTo(9999, 0);
      const bouge = Math.round(window.scrollX);
      window.scrollTo(0, 0);
      return { corps: document.documentElement.scrollWidth, vue: window.innerWidth, bouge };
    });
    console.log('     ' + o.padEnd(12) + l.corps + ' px de contenu pour ' + l.vue
      + ' · défilement latéral ' + l.bouge + ' px');
    if (l.bouge > 0) deborde.push(o + ' (défile de ' + l.bouge + ' px)');
  }
  ok('le corps ne défile de côté sur aucun onglet à 400 px'
     + (deborde.length ? ' — ' + deborde.join(', ') : ''), deborde.length === 0);

  ok('aucune erreur, aucune ressource manquante', soucis.length === 0);
  for (const s of [...new Set(soucis)].slice(0, 8)) console.log('     ' + s);

  await nav.close();
  serveur.close();
})().catch(async e => {
  // Un essai qui échoue doit rendre le port et fermer le navigateur, sinon
  // le suivant ne peut pas démarrer — et c'est le suivant qui dit si le
  // correctif a porté.
  console.error(e);
  process.exitCode = 1;
}).finally(() => {
  serveur.close();
  serveur.closeAllConnections && serveur.closeAllConnections();
  setTimeout(() => process.exit(process.exitCode || 0), 500).unref();
});
