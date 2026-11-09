// ══════════════════════════════════════════════════════════════════════════
//  LE LIEN PENNYLANE DE CHAQUE FACTURE
// ══════════════════════════════════════════════════════════════════════════
//
// Ce qu'il fait : il demande à Pennylane, une fois, la liste des factures
// clients, et il en garde sur disque la correspondance « numéro de facture →
// lien ». La construction de la balance lit cet instantané et met le lien
// dans une colonne. La page publiée, elle, n'appelle jamais Pennylane :
// quelqu'un d'un autre espace comptable n'y aurait pas accès, et la page
// deviendrait inutilisable pour lui.
//
// POURQUOI UN SCRIPT À PART, ET PAS UN APPEL DANS construire.js.
// construire.js est synchrone de bout en bout — pas un await, pas une
// promesse, et le dépôt n'a pas de package.json, donc pas d'await au niveau
// racine. Y glisser un appel réseau obligerait à envelopper neuf cents lignes
// dans une fonction asynchrone. Le dépôt a déjà la bonne réponse, et il s'en
// sert trois fois : mandats.json, parametres.json, complements.json sont des
// INSTANTANÉS, produits hors chaîne, lus en try/catch. Celui-ci est le
// quatrième, et il préserve ce que le LISEZMOI défend : un arrêté se refait à
// l'identique à partir des fichiers posés, sans redemander quoi que ce soit.
//
// POURQUOI PAR TIERS. Le filtre par numéro de facture ne rend rien — constaté
// chez elle. Le filtre qui marche est celui de l'identifiant du tiers, et le
// grand livre le porte déjà, colonne « Identifiant du tiers ». On liste donc
// les factures d'un tiers, puis on retrouve la bonne par son numéro.
//
// Usage :
//   node pennylane.js              tout ce qui manque, en reprenant le cache
//   node pennylane.js --recomposer refait les liens depuis les identifiants
//                                  déjà relevés, sans un seul appel réseau
//   node pennylane.js --depuis-zero oublie le cache et recommence
//   node pennylane.js --limite 20  s'arrête après 20 tiers (pour éprouver)

// LE PROXY, AVANT TOUT LE RESTE.
// Le conteneur ne résout pas app.pennylane.com dans son DNS : c'est le proxy
// de l'environnement qui joint le service, et `fetch` de Node ne l'emprunte
// pas de lui-même. Node sait le faire, mais seulement si la variable est
// posée AVANT son démarrage — la poser ici, dans le script, arrive trop tard
// (éprouvé : getaddrinfo ENOTFOUND). On se relance donc une fois, avec elle.
// Sans ce détour, l'appel échoue en « hôte inconnu », ce qui ressemble à un
// réseau fermé alors qu'il est ouvert.
if (!process.env.NODE_USE_ENV_PROXY && (process.env.HTTPS_PROXY || process.env.https_proxy)) {
  const { spawnSync } = require('child_process');
  const r = spawnSync(process.execPath, process.argv.slice(1), {
    stdio: 'inherit',
    env: { ...process.env, NODE_USE_ENV_PROXY: '1', NODE_NO_WARNINGS: '1' },
  });
  process.exit(r.status == null ? 1 : r.status);
}

const fs = require('fs');
const path = require('path');
const { feuille, NOUV } = require('./socle.js');

const BASE = 'https://app.pennylane.com/api/external/v2';
const CACHE = 'depot-pennylane/urls.json';

// LE MODÈLE DU LIEN.
//
// L'API rend l'identifiant interne de la facture, mais AUCUNE adresse
// d'application : son seul champ d'adresse, public_file_url, est un PDF
// temporaire qui expire en une demi-heure. L'adresse doit donc être composée,
// et sa forme ne se trouve nulle part dans la documentation — elle vient de la
// barre d'adresse de Zehavit, le 09/11/2026, facture ouverte à l'écran :
//
//   …/companies/22066300/clients/customer_invoices?filter=…&invoice_id=34403524235264
//     &page=1&sort=-date,-id&subtab=all
//
// Deux choses qu'on n'aurait pas devinées : la section s'appelle
// « customer_invoices » et non « invoices », et la facture s'ouvre par un
// PARAMÈTRE invoice_id, pas par un segment de chemin. On ne garde que
// l'essentiel — l'identifiant, et subtab=all pour que la facture soit dans la
// liste quel que soit son état. Le filtre de dates de son adresse est l'état
// de SON écran, pas une nécessité : le laisser enfermerait les liens dans une
// fenêtre de douze mois.
//
// C'est le seul endroit à corriger si la forme change, et « --recomposer »
// refait alors les vingt-deux mille liens sans un seul appel réseau.
const MODELE = 'https://app.pennylane.com/companies/{societe}/clients/customer_invoices?invoice_id={id}&subtab=all';

// Cinq requêtes par seconde : c'est la limite que Pennylane annonce. On
// l'espace nous-mêmes au lieu d'attendre le 429, parce qu'un 429 coûte un
// aller-retour pour rien et que trois mille requêtes en font beaucoup.
const PAR_SECONDE = 5;
const REPRISES = 4;

const arg = n => process.argv.includes(n);
const valeur = n => { const i = process.argv.indexOf(n); return i < 0 ? null : process.argv[i + 1]; };

// ───────── le jeton ─────────
// Deux voies, et elles se valent. Si le jeton est posé en « network secret »
// sur l'environnement, le proxy réécrit l'en-tête lui-même et la valeur qu'on
// envoie ici n'est jamais lue : on met donc un marqueur, jamais un vrai jeton.
// S'il est posé en variable, on l'envoie.
const JETON = (process.env.PENNYLANE_TOKEN || '').trim();
const entetes = () => ({
  'Authorization': 'Bearer ' + (JETON || 'injecte-par-le-proxy'),
  'Accept': 'application/json',
});

// ───────── l'étrangleur ─────────
let dernierDepart = 0;
const souffler = ms => new Promise(r => setTimeout(r, ms));
async function cadencer() {
  const creneau = 1000 / PAR_SECONDE;
  const attente = dernierDepart + creneau - Date.now();
  if (attente > 0) await souffler(attente);
  dernierDepart = Date.now();
}

// ───────── un appel ─────────
// Reprise sur 429 et 503 seulement, en honorant retry-after quand il est là.
// 401 et 403 ne se reprennent pas : ils disent que le jeton est absent ou
// qu'il lui manque la portée, et réessayer quatre fois ne les guérit pas.
async function appeler(url) {
  let essai = 0;
  for (;;) {
    await cadencer();
    let res;
    try {
      res = await fetch(url, { headers: entetes() });
    } catch (e) {
      essai++;
      if (essai > REPRISES) throw new Error('réseau injoignable après ' + REPRISES + ' tentatives : ' + e.message);
      await souffler(Math.pow(2, essai) * 1000);
      continue;
    }
    if (res.status === 429 || res.status === 503) {
      essai++;
      if (essai > REPRISES) throw new Error('trop de demandes (' + res.status + ') après ' + REPRISES + ' tentatives');
      const dit = Number(res.headers.get('retry-after'));
      await souffler(dit > 0 ? dit * 1000 : Math.pow(2, essai) * 1000);
      continue;
    }
    const texte = await res.text();
    let corps = null;
    try { corps = texte ? JSON.parse(texte) : null; } catch (e) { /* on rendra le texte */ }
    if (!res.ok) {
      const msg = (corps && (corps.message || corps.error)) || texte.slice(0, 200);
      const err = new Error('HTTP ' + res.status + ' · ' + msg);
      err.statut = res.status;
      throw err;
    }
    return corps;
  }
}

// ───────── la pagination par curseur ─────────
// Enveloppe { items, has_more, next_cursor }. Le garde-fou des pages vues
// évite la pagination qui tourne en rond — elle arrive, et sans lui le
// programme ne s'arrête jamais.
async function lister(chemin, params) {
  const sortie = [];
  let curseur = null, pages = 0;
  const vus = new Set();
  for (;;) {
    const u = new URL(BASE + chemin);
    for (const [k, v] of Object.entries(params || {})) u.searchParams.set(k, v);
    u.searchParams.set('limit', '100');
    if (curseur) u.searchParams.set('cursor', curseur);
    const r = await appeler(u.toString());
    const items = [r && r.items, r && r.data, r && r.results, r && r.records].find(Array.isArray) || [];
    sortie.push(...items);
    pages++;
    const suite = r && (r.next_cursor || (r.pagination && r.pagination.next_cursor));
    const reste = r && typeof r.has_more === 'boolean' ? r.has_more : !!suite;
    if (!reste || !suite || !items.length) break;
    if (vus.has(String(suite))) break;
    vus.add(String(suite));
    curseur = suite;
    if (pages >= 400) break;
  }
  return sortie;
}

// ───────── reconnaître le client d'une facture ─────────
// Le nom du champ n'est pas le même partout dans la documentation : on
// accepte les formes vues, et on rend la chaîne pour comparer sans surprise.
const clientDe = f => String(
  (f && f.customer_id) ??
  (f && f.customer && (f.customer.id ?? f.customer.source_id)) ??
  (f && f.client_id) ?? ''
).trim();

const numeroDe = f => String((f && (f.invoice_number ?? f.number ?? f.reference)) || '').trim();
const libelleDe = f => String((f && (f.label ?? f.title ?? f.description)) || '').trim();

// ───────── le modèle du lien ─────────
const lien = (societe, f) => {
  // Si l'API rend elle-même une adresse d'application, elle fait foi.
  for (const champ of ['app_url', 'web_url', 'url']) {
    const v = f && f[champ];
    if (typeof v === 'string' && /^https?:\/\//.test(v) && !/\/api\/external\//.test(v)) return v;
  }
  const id = f && (f.id ?? f.source_id);
  if (id == null || societe == null) return '';
  return MODELE.replace('{societe}', String(societe)).replace('{id}', String(id));
};

// ───────── poser un lien dans le cache ─────────
//
// DEUX FACTURES PEUVENT PORTER LE MÊME NUMÉRO. Vingt-deux numéros sont dans
// ce cas chez Liora, relevés contre l'API : presque toujours une facture
// vivante et une ou plusieurs ARCHIVÉES, l'archivée étant la version
// remplacée. La première version de ce code gardait simplement la dernière
// rencontrée dans la pagination — donc parfois l'archivée, et le lien menait
// à un document périmé sans que rien ne le dise.
//
// La règle, et elle ne devine rien :
//   · une archivée ne chasse jamais une vivante ;
//   · une vivante remplace une archivée ;
//   · deux vivantes, ou deux archivées, et on ne sait pas : le numéro est
//     marqué ambigu et la construction ne lui posera aucun lien.
//
// Rend 1 quand quelque chose a changé, 0 sinon — de quoi compter sans mentir.
function noterDans(c, f) {
  const num = numeroDe(f);
  const u = lien(c.societe, f);
  if (!num || !u) return 0;
  const archive = String((f && f.status) || '') === 'archived' || !!(f && f.archived_at);
  const vu = c.factures[num];
  if (vu) {
    if (vu.url === u) return 0;
    if (archive && !vu.archive) return 0;
    if (!(!archive && vu.archive)) { vu.ambigu = true; return 0; }
  }
  c.factures[num] = { id: f.id ?? null, tiers: clientDe(f), url: u,
                      libelle: libelleDe(f), archive };
  return 1;
}

// ───────── le cache ─────────
function lireCache() {
  try { return JSON.parse(fs.readFileSync(CACHE, 'utf8')); } catch (e) { return null; }
}
function ecrireCache(c) {
  fs.mkdirSync(path.dirname(CACHE), { recursive: true });
  fs.writeFileSync(CACHE, JSON.stringify(c), 'utf8');
}

// ───────── les tiers du grand livre ─────────
function tiersDuGrandLivre() {
  const gl = feuille(NOUV, 'Grand livre - Clients', 0);
  const ids = new Set();
  for (const r of gl.rows) {
    const v = String(r['Identifiant du tiers'] == null ? '' : r['Identifiant du tiers']).trim();
    if (v) ids.add(v);
  }
  return [...ids];
}

// ══════════════════════════════════════════════════════════════════════════

(async () => {
  const neuf = { quand: '', societe: null, methode: '', filtre: '', modele: MODELE,
                 tiersFaits: {}, factures: {}, champsVus: [] };
  let c = arg('--depuis-zero') ? neuf : (lireCache() || neuf);
  c.modele = MODELE;

  // ── LE PONT ZOHO → SELLSY → PENNYLANE ──
  //
  // Quatre mille numéros du grand livre n'existent pas dans Pennylane :
  // FA-550-, FA-771-, FA-AIF-, FA-POEI-, FA-TRAN-, FA-REG-, DV-, CN-. Ce sont
  // des numéros ZOHO, l'outil de facturation d'avant. On les croyait perdus.
  //
  // Mais l'export Sellsy porte les deux : sa colonne « Numéro » est le numéro
  // FACT-/AVR- que Pennylane connaît, et sa colonne « Numéro de facture Zoho »
  // est l'ancien. Une même ligne, donc une même facture : le pont est dans le
  // fichier, il n'y a rien à deviner.
  //
  // Éprouvé le 09/11/2026 : 1 205 numéros retrouvés, et les 1 205 ont un lien.
  // Le client concorde sur la totalité — les huit cas qui semblaient discorder
  // étaient un défaut du contrôle, qui écartait les noms de moins de six
  // lettres (AFDAS, INSEE, EDF, ADC). Sur FA-TRAN-0068, le libellé Pennylane
  // porte même le numéro Zoho en toutes lettres.
  //
  // Aucun appel réseau : c'est de la lecture de fichiers.
  if (arg('--alias')) {
    const { ctx } = require('./socle.js');
    const lire = f => { try {
      return ctx.Papa.parse(fs.readFileSync(f, 'utf8'), { header: true, skipEmptyLines: true }).data;
    } catch (e) { return []; } };
    const rows = lire('depot-sellsy/sellsy.csv').concat(lire('depot-sellsy/avoirs.csv'));

    // UN NUMÉRO ZOHO NE MÈNE PAS TOUJOURS À UNE SEULE FACTURE, et prendre la
    // première rencontrée dans l'ordre du fichier serait tirer au sort.
    // Deux cent quatre-vingt-cinq numéros sont dans ce cas, et ils touchaient
    // 226 lignes de la balance publiée.
    //
    //   · une facture et ses AVOIRS (123 cas) : le numéro Zoho que porte le
    //     grand livre désigne la FACTURE — l'avoir, lui, a son propre numéro
    //     dans le grand livre. On tranche donc, et ce n'est pas deviner.
    //   · plusieurs FACTURES (161 cas, refacturations) : on ne sait pas
    //     laquelle. On ne pose rien. Le numéro reste nu, ce qui se voit —
    //     un lien faux, lui, ne se voit pas.
    const parZoho = new Map();
    for (const r of rows) {
      const zoho = String(r['Numéro de facture Zoho'] || '').trim();
      const sellsy = String(r['Numéro'] || '').trim();
      if (!zoho || !sellsy) continue;
      if (!parZoho.has(zoho)) parZoho.set(zoho, new Set());
      parZoho.get(zoho).add(sellsy);
    }
    // LE PONT SE REFAIT ENTIER À CHAQUE FOIS. Les alias posés au passage
    // précédent sont retirés d'abord : sans cela, un alias devenu faux — parce
    // que l'export Sellsy a changé, ou parce que la règle ci-dessus s'est
    // affinée — resterait en place pour toujours, puisqu'on saute les numéros
    // déjà connus. Les liens rendus par l'API, eux, ne sont jamais touchés.
    let retires = 0;
    for (const k of Object.keys(c.factures))
      if (c.factures[k] && c.factures[k].via === 'sellsy') { delete c.factures[k]; retires++; }
    if (retires) console.log('  ' + retires + ' alias du passage précédent retirés avant de refaire le pont');

    const estAvoir = n => /^(AVR|AV)-/i.test(n);
    let pose = 0, deja = 0, sansLien = 0, tranches = 0, ecartes = 0;
    for (const [zoho, set] of parZoho) {
      if (c.factures[zoho]) { deja++; continue; }
      let sellsy;
      if (set.size === 1) sellsy = [...set][0];
      else {
        const factures = [...set].filter(n => !estAvoir(n));
        if (factures.length !== 1) { ecartes++; continue; }
        sellsy = factures[0]; tranches++;
      }
      const cible = c.factures[sellsy];
      if (!cible) { sansLien++; continue; }
      // On garde la trace du chemin : un lien posé par le pont n'est pas un
      // lien rendu par l'API, et la différence doit rester lisible.
      c.factures[zoho] = { ...cible, via: 'sellsy', numeroSellsy: sellsy };
      pose++;
    }
    c.quand = new Date().toISOString();
    ecrireCache(c);
    console.log('pont Zoho→Sellsy→Pennylane : ' + pose + ' alias posés · ' + deja +
                ' déjà connus de Pennylane · ' + sansLien + ' sans lien côté Pennylane');
    console.log('  dont ' + tranches + ' tranchés entre une facture et ses avoirs · ' +
                ecartes + ' écartés faute de savoir laquelle');
    console.log('total : ' + Object.keys(c.factures).length + ' numéros avec un lien');
    return;
  }

  // ── le mode hors ligne : refaire les liens sans toucher au réseau ──
  if (arg('--recomposer')) {
    let n = 0;
    for (const num of Object.keys(c.factures)) {
      const f = c.factures[num];
      const u = lien(c.societe, { id: f.id });
      if (u && u !== f.url) { f.url = u; n++; }
    }
    ecrireCache(c);
    console.log('liens refaits sans appel réseau : ' + n + ' sur ' + Object.keys(c.factures).length);
    return;
  }

  // ── qui sommes-nous ──
  if (c.societe == null) {
    const moi = await appeler(BASE + '/me');
    c.societe = moi && moi.company && (moi.company.id ?? moi.company.source_id);
    const qui = moi && moi.company && moi.company.name;
    if (c.societe == null) throw new Error('/me n’a pas rendu d’identifiant de société · ' + JSON.stringify(moi).slice(0, 300));
    console.log('société : ' + qui + ' (' + c.societe + ')');
  }

  // LE BALAYAGE COMPLET, QUAND ON LE DEMANDE.
  //
  // Lister les factures d'un tiers coûte un appel par tiers : 3 683 appels, un
  // quart d'heure. Lister TOUTES les factures coûte une page par centaine, soit
  // quelques centaines d'appels — la même matière, dix fois plus vite, et sans
  // dépendre du nom du paramètre de filtre. On s'en sert d'abord, et le mode
  // par tiers reste là pour compléter ce qui manquerait.
  //
  // IL VIENT AVANT LE DÉCOMPTE DES TIERS, et ce n'est pas de la mise en page.
  // Le relevé par tiers s'arrête sur « rien à faire » quand tous les tiers
  // sont marqués ; le balayage, placé après, serait devenu injoignable le jour
  // où ce marquage se remplit — et la tâche planifiée aurait tourné sans rien
  // relever, en annonçant qu'il n'y avait rien à faire.
  if (arg('--balayage')) {
    const avant = Object.keys(c.factures).length;
    let n = 0, lues = 0;
    const vus = new Set();
    let curseur = null;
    for (;;) {
      const u = new URL(BASE + '/customer_invoices');
      u.searchParams.set('limit', '100');
      if (curseur) u.searchParams.set('cursor', curseur);
      const r = await appeler(u.toString());
      const items = (r && r.items) || [];
      lues += items.length;
      for (const f of items) n += noterDans(c, f);
      const suite = r && r.next_cursor;
      const encore = r && typeof r.has_more === 'boolean' ? r.has_more : !!suite;
      if (!encore || !suite || !items.length || vus.has(String(suite))) break;
      vus.add(String(suite));
      curseur = suite;
      if (vus.size % 20 === 0) { ecrireCache(c); console.log('  ' + lues + ' factures lues · ' + n + ' liens'); }
    }
    c.quand = new Date().toISOString();
    c.methode = 'balayage complet';
    ecrireCache(c);
    console.log(lues + ' factures lues · ' + n + ' liens posés (' + avant + ' → ' +
                Object.keys(c.factures).length + ') · déposé dans ' + CACHE);
    return;
  }

  const tiers = tiersDuGrandLivre();
  const reste = tiers.filter(t => !c.tiersFaits[t]);
  console.log(tiers.length + ' tiers dans le grand livre · ' + reste.length + ' à relever');
  if (!reste.length) { console.log('rien à faire.'); return; }

  // ── ÉPROUVER LE FILTRE AVANT DE LANCER TROIS MILLE REQUÊTES ──
  // La documentation nomme ce paramètre « filter » ici et « filters » là. Un
  // mauvais nom ne rend pas d'erreur : il rend la liste NON filtrée, donc
  // toutes les factures de la société, et on croirait avoir réussi. On vérifie
  // donc que les factures rendues portent bien le client demandé.
  // (Éprouvé le 09/11/2026 : c'est « filter », au singulier. « filters » est
  // ignoré en silence et rend la liste entière.)
  if (!c.filtre) {
    const sonde = reste[0];
    const clause = JSON.stringify([{ field: 'customer_id', operator: 'eq', value: sonde }]);
    for (const nom of ['filter', 'filters']) {
      try {
        const u = new URL(BASE + '/customer_invoices');
        u.searchParams.set(nom, clause);
        u.searchParams.set('limit', '100');
        const r = await appeler(u.toString());
        const items = (r && r.items) || [];
        if (!items.length) { console.log('  « ' + nom + ' » : aucune facture rendue'); continue; }
        const bons = items.filter(f => clientDe(f) === sonde).length;
        console.log('  « ' + nom + ' » : ' + items.length + ' factures, dont ' + bons + ' du tiers demandé');
        if (bons === items.length) { c.filtre = nom; break; }
      } catch (e) {
        console.log('  « ' + nom + ' » : ' + e.message);
        if (e.statut === 401 || e.statut === 403) throw e;
      }
    }
    if (!c.filtre) {
      // Aucun filtre ne mord : on prend tout, en une seule passe. C'est même
      // plus court — cent soixante-dix pages au lieu de trois mille appels.
      c.filtre = '(aucun)';
      c.methode = 'balayage complet';
      console.log('aucun filtre ne mord : balayage complet de toutes les factures clients.');
    } else {
      c.methode = 'par tiers';
      console.log('filtre retenu : ' + c.filtre);
    }
    ecrireCache(c);
  }

  const noter = f => noterDans(c, f);

  let n = 0, fait = 0;
  const limite = Number(valeur('--limite') || 0);

  if (c.methode === 'balayage complet') {
    const toutes = await lister('/customer_invoices', {});
    for (const f of toutes) n += noter(f);
    for (const t of tiers) c.tiersFaits[t] = new Date().toISOString();
    ecrireCache(c);
    console.log(toutes.length + ' factures lues · ' + n + ' liens posés');
  } else {
    const debut = Date.now();
    for (const t of reste) {
      if (limite && fait >= limite) break;
      const clause = JSON.stringify([{ field: 'customer_id', operator: 'eq', value: t }]);
      let factures = [];
      try {
        factures = await lister('/customer_invoices', { [c.filtre]: clause });
      } catch (e) {
        console.log('  tiers ' + t + ' : ' + e.message);
        if (e.statut === 401 || e.statut === 403) { ecrireCache(c); throw e; }
        continue;
      }
      for (const f of factures) n += noter(f);
      c.tiersFaits[t] = new Date().toISOString();
      fait++;
      if (fait % 50 === 0) {
        ecrireCache(c);
        const parSec = fait / ((Date.now() - debut) / 1000);
        const restant = Math.round((reste.length - fait) / Math.max(parSec, 0.01) / 60);
        console.log('  ' + fait + ' / ' + reste.length + ' tiers · ' + n + ' liens · ~' + restant + ' min');
      }
    }
  }

  c.quand = new Date().toISOString();
  // Les champs vus : de quoi savoir, plus tard, ce que l'API rend vraiment
  // sans avoir à la rappeler.
  ecrireCache(c);
  console.log('\n' + Object.keys(c.factures).length + ' factures avec un lien · ' +
              Object.keys(c.tiersFaits).length + ' tiers relevés · déposé dans ' + CACHE);
})().catch(e => { console.error('\nARRÊT · ' + e.message); process.exit(1); });
