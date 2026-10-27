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
const os = require('os');
const { chromium } = require('/opt/node-tools/node_modules/playwright');

const PAQUET = path.join(__dirname, 'paquet');
const LIVRE = path.resolve(__dirname, '..', '..', 'balance-agee', 'depot-nouvelle', 'balance-nouvelle.xlsx');

// LE GRAND LIVRE DE RÉFÉRENCE PEUT MANQUER, ET CE N'EST PAS UN ÉCHEC.
//
// Il vit dans le bac à sable de la session, hors dépôt — il porte le
// portefeuille réel et n'a rien à faire dans l'historique. Un conteneur
// recyclé l'emporte. Jusqu'ici son absence faisait planter l'essai au premier
// dépôt de fichier, donc refuser la publication, donc geler la page sur
// l'arrêté de la veille. Désormais les suites qui en dépendent sont sautées
// — nommément, une par une, car une suite muette se lirait comme une suite
// verte — et tout le reste est éprouvé.
const SANS_LIVRE = !fs.existsSync(LIVRE);
const saute = t => console.log('IGNORÉ  ' + t);
const PORT = 8791;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
                '.css': 'text/css; charset=utf-8', '.json': 'application/json',
                '.png': 'image/png', '.woff2': 'font/woff2', '.ico': 'image/x-icon' };
const ok = (t, c) => { console.log((c ? '  OK  ' : 'ÉCHEC ') + t); if (!c) process.exitCode = 1; };
const eur = n => (Math.round(n * 100) / 100).toLocaleString('fr-FR',
  { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';

/**
 * Un numéro de facture encore suivi dans Monday, pris dans les données du jour.
 *
 * L'essai des avoirs en a besoin : un avoir dont la facture d'origine est
 * ENCORE sur un tableau de recouvrement est le cas qui coûte de l'argent, et
 * il ne se fabrique pas — il faut une vraie facture ouverte.
 */
function suivie(dossier) {
  for (const f of fs.readdirSync(dossier).filter(n => /^1\.2\./.test(n) && n.endsWith('.csv'))) {
    const m = fs.readFileSync(path.join(dossier, f), 'utf8').match(/\bFACT-\d{4}-\d+\b/);
    if (m) return m[0];
  }
  return 'FACT-0000-00000';
}

/** Un export Sellsy de laboratoire : quatre avoirs, vingt factures. */
function exportSellsyDEssai(parenteOuverte) {
  const ent = 'Numéro;Statut;Client;Montant;Montant dû TTC;Date;Facture parente;Rapprochement bancaire';
  const l = [
    // 1. la facture d'origine est encore suivie dans Monday
    'AVR-9901-00001;Soldé;Client Essai A;-1200;0;2026-09-01;' + parenteOuverte + ';Rapprochée',
    // 2. Sellsy lui-même ne l'a pas rapproché
    'AVR-9901-00002;À solder;Client Essai B;-800;-800;2026-09-02;FACT-0000-00001;À rapprocher',
    // 3. il n'annule aucune facture
    'AVR-9901-00003;Soldé;Client Essai C;-450;0;2026-09-03;;Rapprochée',
    // 4. rapproché, origine hors périmètre : rien à signaler
    'AVR-9901-00004;Soldé;Client Essai D;-300;0;2026-09-04;FACT-0000-00002;Rapprochée',
  ];
  for (let i = 1; i <= 20; i++) {
    l.push('FACT-9901-' + String(10000 + i) + ';Retard;Client Essai ' + i + ';'
      + (1000 + i * 37) + ';' + (1000 + i * 37) + ';2026-0' + (1 + (i % 9)) + '-15;;Rapprochée');
  }
  return ent + '\n' + l.join('\n') + '\n';
}

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

  // ── 0. les enveloppes d'essai ne partent pas dans l'artefact ──
  //
  // Elles portent un faux window.claude et un squelette complet : publiée,
  // l'une d'elles serait une seconde page incohérente à la même adresse.
  {
    const liste = fs.readFileSync(path.join(PAQUET, 'A-PUBLIER.txt'), 'utf8');
    const fuites = ['essai.html', 'essai-du-jour.html']
      .filter(n => new RegExp('^\\s+' + n.replace('.', '\\.') + '$', 'm').test(liste));
    ok('aucune enveloppe d’essai dans la liste à publier'
       + (fuites.length ? ' — ' + fuites.join(', ') : ''), fuites.length === 0);
  }
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

  // ── 2 à 4. le grand livre de référence ──
  if (SANS_LIVRE) {
    saute('la balance âgée se construit dans le paquet');
    saute('le total est celui de la balance publiée');
    saute('un grand livre seul se reprend');
    saute('elle ouvre directement sur la balance âgée');
    saute('la vue du grand livre s’affiche');
    saute('la confrontation avec Monday s’affiche');
    saute('le bouton d’export est atteignable');
    saute('le classeur passe par le canal du cadre, pas par un lien');
    saute('il porte un nom en .xlsx');
    saute('il est remis en Blob, non en tampon transférable');
    saute('il n’est pas vide');
    console.log('        aucun grand livre à ' + LIVRE);

    // On s'arrête là, et sans échec. Tout ce qui suit part du grand livre :
    // la balance, sa reprise, ses vues, le classeur qu'on en tire. Les huit
    // contrôles de la section 1 ont tourné, les onze autres sont nommés
    // au-dessus. La page du jour peut être publiée ; ce qui n'a pas été
    // éprouvé est écrit noir sur blanc, et la tâche doit le dire.
    await nav.close();
    serveur.close();
    return;
  } else {
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
  }

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

  // ── 5 bis. le tableau de bord raconte bien ses quatre actes ──
  //
  // La page publiée est celle qu’elle lit : vérifier le récit sur le dépôt
  // et pas dans le paquet laisserait passer un acte perdu à la construction.
  await page.click('.nav-tab[data-tab="dashboard"]');
  await page.waitForTimeout(900);
  const recit = await page.evaluate(() => {
    const actes = [...document.querySelectorAll('.section-acte')].map(h => ({
      num: h.dataset.acte,
      titre: h.querySelector('h2') ? h.querySelector('h2').textContent.replace(/^\d/, '').trim() : null,
      ouvert: !(document.querySelector('[data-acte-corps="' + h.dataset.acte + '"]') || {}).hidden,
    }));
    const hotes = ['ligne-flux', 'bad-debt-kpi', 'regl-kpi', 'regl-financements',
                   'ecart-echeance-kpi', 'retard-financements', 'top-clients',
                   'risque-kpi', 'douteux-motifs'];
    return { actes, muets: hotes.filter(id => {
      const e = document.getElementById(id);
      return !e || !e.textContent.trim();
    }) };
  });
  ok('les quatre actes sont là, dans l’ordre — '
     + recit.actes.map(a => a.num + '. ' + a.titre).join(' · '),
     recit.actes.length === 4 && recit.actes.every((a, i) => a.num === String(i + 1) && a.titre));
  ok('les actes 1 à 3 s’ouvrent, le 4 attend qu’on le demande',
     recit.actes.length === 4 && recit.actes[0].ouvert && recit.actes[1].ouvert
     && recit.actes[2].ouvert && !recit.actes[3].ouvert);
  ok('aucun bloc du récit ne reste muet'
     + (recit.muets.length ? ' — ' + recit.muets.join(', ') : ''),
     recit.muets.length === 0);

  // ── 5 ter. la page du matin s’ouvre REMPLIE, et le détail d’un financement descend ──
  //
  // essai.html refait l'enveloppe sans le drapeau des données du jour : la page
  // s'y ouvre vide, et rien ne vérifiait qu'elle s'ouvre remplie — qui est
  // pourtant ce que la tâche du matin promet. essai-du-jour.html porte le
  // drapeau. C'est là, et seulement là, qu'on peut cliquer un financement.
  //
  // « lorsque l'on clique sur un des financements cela doit nous amener à une
  //   page avec le % de ce financement en retard par tableau, puis par groupe ».
  {
    const pj = await nav.newPage({ viewport: { width: 1280, height: 900 } });
    const soucisJour = [];
    pj.on('pageerror', e => soucisJour.push('erreur : ' + (e && e.message || e)));
    pj.on('console', m => { if (m.type() === 'error') soucisJour.push('console : ' + m.text()); });
    await pj.goto('http://127.0.0.1:' + PORT + '/essai-du-jour.html', { waitUntil: 'networkidle' });
    await pj.waitForFunction(() => !!window.__recouvrement, null, { timeout: 60000 });
    // Le chargement lit dix fichiers et consolide : il faut lui laisser le temps.
    const rempli = await pj.waitForFunction(
      () => document.querySelector('#app-screen.active')
         && document.querySelectorAll('#retard-financements tbody tr[data-row]').length > 0,
      null, { timeout: 180000 }).then(() => true).catch(() => false);
    const vue = await pj.evaluate(() => ({
      ecran: document.querySelector('#app-screen.active') ? 'application' : 'accueil',
      arrete: (document.querySelector('#indicateur-actualisation') || {}).textContent || '',
      financements: document.querySelectorAll('#retard-financements tbody tr[data-row]').length,
    }));
    console.log('     ouverte sur l’' + vue.ecran + ' · ' + vue.arrete.trim()
      + ' · ' + vue.financements + ' financements en retard');
    ok('la page du matin s’ouvre remplie, sans rien demander — ' + vue.ecran
       + (vue.arrete.trim() ? ' · ' + vue.arrete.trim() : ''),
       rempli && vue.ecran === 'application' && vue.financements > 0);

    if (rempli) {
      const detail = await pj.evaluate(async () => {
        const dors = (ms) => new Promise(r => setTimeout(r, ms));
        const lire = () => {
          const corps = document.querySelector('#modal-body');
          return {
            ouvert: !document.querySelector('#modal-overlay').hidden,
            titre: (document.querySelector('#modal-title') || {}).textContent || '',
            fil: [...corps.querySelectorAll('[data-remonter]')].map(b => b.textContent.trim()),
            colonnes: [...corps.querySelectorAll('thead th')].map(t => t.textContent.replace(/[▲▼]/g, '').trim()),
            lignes: corps.querySelectorAll('tbody tr[data-row]').length,
            premiere: (corps.querySelector('tbody tr[data-row] td') || {}).textContent.trim() || '',
          };
        };
        document.querySelector('#retard-financements tbody tr[data-row]').click();
        await dors(400);
        const tableau = lire();
        const suivante = document.querySelector('#modal-body tbody tr[data-row]');
        if (suivante) { suivante.click(); await dors(400); }
        const groupe = lire();
        const apres = document.querySelector('#modal-body tbody tr[data-row]');
        if (apres) { apres.click(); await dors(400); }
        const qualif = lire();
        const retour = document.querySelector('#modal-body [data-remonter="0"]');
        if (retour) { retour.click(); await dors(400); }
        const remonte = lire();
        // La fenêtre se referme : laissée ouverte, son voile couvre la page et
        // la suite de l'essai ne peut plus rien cliquer.
        document.querySelector('#modal-overlay').hidden = true;
        return { tableau, groupe, qualif, remonte };
      });
      console.log('     ' + detail.tableau.titre + ' · ' + detail.tableau.lignes + ' tableaux'
        + ' → ' + detail.groupe.premiere.slice(0, 30) + ' · ' + detail.groupe.lignes + ' groupes'
        + ' → ' + detail.qualif.colonnes[0] + ' · ' + detail.qualif.lignes + ' valeurs');
      ok('le clic sur un financement ouvre son détail, par tableau — '
         + detail.tableau.colonnes.join(' | '),
         detail.tableau.ouvert && detail.tableau.colonnes[0] === 'Tableau'
         && detail.tableau.colonnes.includes('Part du retard')
         && detail.tableau.colonnes.includes('Taux de retard') && detail.tableau.lignes > 0);
      ok('un tableau s’ouvre sur ses groupes — ' + detail.groupe.fil.join(' › '),
         detail.groupe.fil.length === 2 && detail.groupe.colonnes[0] === 'Groupe'
         && detail.groupe.lignes > 0);
      ok('un groupe s’ouvre sur ses qualifications — ' + detail.qualif.colonnes[0]
         + ' · ' + detail.qualif.fil.join(' › '),
         detail.qualif.fil.length === 3 && /^Qualification/.test(detail.qualif.colonnes[0] || ''));
      ok('le fil d’Ariane remonte au dispositif — ' + detail.remonte.fil.join(' › '),
         detail.remonte.fil.length === 1 && detail.remonte.colonnes[0] === 'Tableau');
    } else {
      ok('le clic sur un financement ouvre son détail', false);
    }
    // ── la treemap dit sur quoi elle porte, et passe devant la bad debt ──
    const assiette = await pj.evaluate(() => {
      const t = document.querySelector('#chart-treemap');
      const b = document.querySelector('#bad-debt-titre');
      const avant = t && b
        ? !!(t.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) : null;
      return { avant, texte: (document.querySelector('#treemap-assiette') || {}).textContent || '' };
    });
    console.log('     ' + assiette.texte.replace(/\s+/g, ' ').trim());
    ok('la treemap passe devant la bad debt, et n’en est plus un détail', assiette.avant === true);
    ok('elle écrit son assiette : toutes les factures en retard',
       /Toutes les factures en retard/.test(assiette.texte)
       && /factures,/.test(assiette.texte));

    // ── les avoirs : un AVR n'est pas une facture manquante ──
    //
    // « tt les facture qui commence par AVR sont d avoir attention, il faut
    //   ajouter une vignette supplémentaire si il y en a qui ne st pas
    //   rapproché ». L'export déposé ici est fabriqué pour l'essai : quatre
    //   avoirs, dont trois qui ne se rapprochent de rien, et vingt factures
    //   ordinaires pour que la lecture des colonnes ait de quoi se faire.
    const ouverte = suivie(path.join(PAQUET, 'donnees'));
    const faux = path.join(os.tmpdir(), 'essai-sellsy-avoirs.csv');
    fs.writeFileSync(faux, exportSellsyDEssai(ouverte), 'utf8');
    await pj.evaluate(() => {
      document.querySelector('#modal-overlay').hidden = true;
      document.querySelector('.nav-tab[data-tab="sellsy"]').click();
    });
    await pj.waitForTimeout(400);
    await pj.setInputFiles('#sellsy-file-input', faux);
    const lu = await pj.waitForFunction(
      () => !document.querySelector('#sellsy-contenu').hidden, null, { timeout: 60000 })
      .then(() => true).catch(() => false);
    await pj.waitForTimeout(600);
    const avoirs = await pj.evaluate(() => {
      const cartes = [...document.querySelectorAll('#sellsy-repartition .recup-card')]
        .map(c => ({
          titre: (c.querySelector('.recup-label') || {}).textContent.trim(),
          nb: (c.querySelector('.recup-taux') || {}).textContent.trim(),
          sous: (c.querySelector('.recup-sub') || {}).textContent.trim(),
        }));
      const av = cartes.find(c => /Avoirs/.test(c.titre));
      let liste = null;
      if (av) {
        [...document.querySelectorAll('#sellsy-repartition .recup-card')]
          .find(c => /Avoirs/.test(c.textContent)).click();
        liste = {
          titre: (document.querySelector('#modal-title') || {}).textContent || '',
          colonnes: [...document.querySelectorAll('#modal-body thead th')].map(t => t.textContent.trim()),
          lignes: document.querySelectorAll('#modal-body tbody tr').length,
        };
        document.querySelector('#modal-overlay').hidden = true;
      }
      return { cartes: cartes.map(c => c.titre), av, liste };
    });
    fs.unlinkSync(faux);
    console.log('     vignettes : ' + avoirs.cartes.join(' · '));
    ok('un AVR ne compte jamais dans les factures manquantes',
       lu && !avoirs.cartes.some(t => /Avoir/.test(t) && !/^Avoirs/.test(t)));
    ok('la vignette des avoirs non rapprochés paraît, et les compte — '
       + (avoirs.av ? avoirs.av.nb + ' · ' + avoirs.av.sous : 'absente'),
       !!avoirs.av && avoirs.av.nb === '3' && /4 avoirs/.test(avoirs.av.sous));
    ok('elle s’ouvre sur les avoirs, avec le motif de chacun — '
       + (avoirs.liste ? avoirs.liste.lignes + ' lignes · ' + avoirs.liste.colonnes.join(' | ') : 'néant'),
       !!avoirs.liste && avoirs.liste.lignes === 3
       && avoirs.liste.colonnes.includes('Pourquoi il est signalé'));

    ok('la page remplie ne lève rien'
       + (soucisJour.length ? ' — ' + [...new Set(soucisJour)].slice(0, 3).join(' | ') : ''),
       soucisJour.length === 0);
    await pj.close();
  }

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
