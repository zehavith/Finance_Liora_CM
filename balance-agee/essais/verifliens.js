// Le N° de facture mène-t-il vraiment à Pennylane, et le clic ouvre-t-il la
// fiche en même temps ?
//
// Trois pannes possibles, toutes silencieuses, et c'est pourquoi on les
// éprouve dans un vrai navigateur plutôt que de les relire :
//   · le clic remonte à la ligne, dessiner() réécrit l'innerHTML, et l'ancre
//     est détruite au milieu de sa propre navigation — le symptôme n'est pas
//     « la fiche s'ouvre en trop » mais « le lien ne marche pas » ;
//   · un preventDefault de trop tuerait le lien sans rien dire ;
//   · une facture sans lien deviendrait <a href="">, qui recharge la page.
//
//   node essais/verifliens.js
//
// Il lui faut un depot-pennylane/urls.json et une construction faite avec.

const { chromium } = require(process.env.PLAYWRIGHT || '/opt/node-tools/node_modules/playwright');
const fs = require('fs');
const D = require('path').resolve(__dirname, '..');

let dur = 0;
const ok = (quoi, bon, dit) => {
  console.log((bon ? '  OK  ' : '  ÉCHEC  ') + quoi + (dit ? ' — ' + dit : ''));
  if (!bon) dur++;
};

(async () => {
  const cache = JSON.parse(fs.readFileSync(D + '/depot-pennylane/urls.json', 'utf8'));
  const numeros = Object.keys(cache.factures || {});
  if (!numeros.length) { console.log('aucun lien dans le cache : rien à éprouver.'); process.exit(1); }

  const b = await chromium.launch();
  const ctx = await b.newContext();
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', e => errs.push('PAGE: ' + e.message.slice(0, 200)));
  p.on('console', m => { if (m.type() === 'error') errs.push('CONS: ' + m.text().slice(0, 200)); });

  // Pennylane n'est pas joignable depuis le navigateur, et on n'a pas besoin
  // qu'il le soit : on veut seulement l'adresse demandée.
  await ctx.route('**://app.pennylane.com/**', r => r.abort());

  await p.goto('file://' + D + '/Balance-agee-Liora.html', { waitUntil: 'load' });
  await p.waitForTimeout(5000);

  const num = numeros[0];
  const attendue = cache.factures[num].url;
  await p.fill('#q', num);
  await p.waitForTimeout(1500);

  // ── 1. l'ancre est là, et elle pointe où il faut ──
  const a = await p.evaluate(() => {
    const el = document.querySelector('#cale .lig .lien-fact');
    return el ? { href: el.getAttribute('href'), cible: el.getAttribute('target'),
                  rel: el.getAttribute('rel'), texte: el.textContent.trim() } : null;
  });
  ok('le numéro de facture est une ancre', !!a, a ? a.texte : 'aucune .lien-fact dans le tableau');
  if (a) {
    ok('elle pointe sur la facture', a.href === attendue, a.href);
    ok('elle s’ouvre dans un autre onglet', a.cible === '_blank', 'target=' + a.cible);
    ok('elle ne laisse pas la page atteindre window.opener', /noopener/.test(a.rel || ''), 'rel=' + a.rel);
    ok('elle porte le numéro, et rien d’autre', a.texte === num, a.texte);
  }

  // ── 2. le clic ouvre Pennylane, et N'OUVRE PAS la fiche ──
  const ficheAvant = await p.evaluate(() => (document.getElementById('fiche') || {}).innerHTML || '');
  const attenteOnglet = ctx.waitForEvent('page', { timeout: 8000 }).catch(() => null);
  await p.click('#cale .lig .lien-fact');
  const onglet = await attenteOnglet;
  ok('le clic demande bien Pennylane', !!onglet && onglet.url().startsWith(attendue.slice(0, 40)),
     onglet ? onglet.url().slice(0, 90) : 'aucun onglet ouvert');
  if (onglet) await onglet.close().catch(() => {});
  await p.waitForTimeout(600);
  const ficheApres = await p.evaluate(() => (document.getElementById('fiche') || {}).innerHTML || '');
  ok('la fiche ne s’ouvre pas en même temps', ficheApres === ficheAvant,
     ficheApres === ficheAvant ? 'inchangée' : 'la fiche a changé — le stopPropagation ne tient pas');

  // ── 3. le clic AILLEURS sur la ligne ouvre toujours la fiche ──
  await p.click('#cale .lig > div:nth-child(3)');
  await p.waitForTimeout(800);
  const ficheOuverte = await p.evaluate(() => (document.getElementById('fiche') || {}).innerHTML || '');
  ok('un clic ailleurs sur la ligne ouvre toujours la fiche',
     ficheOuverte !== ficheAvant && ficheOuverte.length > 0);

  // ── 4. une facture SANS lien reste un numéro nu ──
  await p.fill('#q', '');
  await p.waitForTimeout(1500);
  const nus = await p.evaluate(nums => {
    const out = { avecLien: 0, sansLien: 0, href_vide: 0 };
    for (const lig of document.querySelectorAll('#cale .lig')) {
      const c = lig.children[0]; if (!c) continue;
      const a = c.querySelector('a');
      if (a) { out.avecLien++; if (!a.getAttribute('href')) out.href_vide++; }
      else if (c.textContent.trim() && c.textContent.trim() !== '·') out.sansLien++;
    }
    return out;
  }, numeros);
  ok('aucune ancre vide (href="")', nus.href_vide === 0, JSON.stringify(nus));
  ok('les factures sans lien restent des numéros nus', nus.sansLien > 0, JSON.stringify(nus));

  ok('aucune erreur de page', errs.length === 0, errs.join(' · ') || 'aucune');

  await b.close();
  console.log(dur ? '\n' + dur + ' ÉCHEC(S)' : '\ntout est vert');
  process.exit(dur ? 1 : 0);
})();
