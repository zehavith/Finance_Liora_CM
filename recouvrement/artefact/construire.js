// ══════════════════════════════════════════════════════════════════════
//  LE PAQUET PUBLIABLE DE « SUIVI RECOUVREMENT »
// ══════════════════════════════════════════════════════════════════════
//
// L'application vit dans recouvrement/ et continue d'y tourner : on la lance
// en double-cliquant son raccourci, elle lit les fichiers du poste, elle
// appelle Monday. Rien de tout cela ne change.
//
// Ce script en fabrique une SECONDE sortie : le paquet qu'on publie comme
// artefact. Un artefact est une page servie par claude.ai, dans un cadre qui
// refuse certaines choses que l'application fait en local — déclencher un
// téléchargement, ouvrir la boîte d'impression, appeler un hôte qui n'est pas
// sur sa liste. Le paquet est donc l'application, moins ce que le cadre
// refuse, plus ce qu'il offre à la place.
//
// La règle de ce fichier : il NE RÉÉCRIT PAS l'application. Il la recopie, et
// il applique une liste courte de substitutions, chacune nommée et chacune
// vérifiée — si le texte visé n'apparaît pas exactement une fois, la
// construction s'arrête au lieu de produire un paquet silencieusement faux.
// Toute correction qui vaut aussi en local est faite dans la source, pas ici.
//
//   node recouvrement/artefact/construire.js
//
const fs = require('fs');
const path = require('path');

const ICI = __dirname;
const APP = path.resolve(ICI, '..');
const RACINE = path.resolve(APP, '..');
const DIST = path.join(ICI, 'paquet');

const lire = f => fs.readFileSync(f, 'utf8');
const octets = f => fs.readFileSync(f);

// Une substitution nommée, qui doit porter. Le compte exact est la seule
// protection contre un paquet qui part avec un correctif qui n'a rien
// corrigé : un refactor de l'application déplacerait le texte visé sans
// prévenir, et le paquet publierait du code cassé.
function remplacer(texte, liste, fichier) {
  for (const [avant, apres, nom] of liste) {
    const n = texte.split(avant).length - 1;
    if (n !== 1) {
      throw new Error('construction interrompue · ' + fichier + ' · « ' + nom
        + ' » : ' + n + ' occurrence(s) au lieu d’une.\n'
        + 'Le texte visé a bougé. Reprendre la substitution avant de publier.');
    }
    texte = texte.replace(avant, apres);
    console.log('  ' + fichier.padEnd(22) + nom);
  }
  return texte;
}

// ── le paquet, vide ──
fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(path.join(DIST, 'js'), { recursive: true });
fs.mkdirSync(path.join(DIST, 'vendor'), { recursive: true });

// ══════════════════════════════════════════════
//  1. Ce qui se recopie tel quel
// ══════════════════════════════════════════════
//
// LES DEUX FEUILLES DE STYLE, ET POURQUOI ELLES NE FUSIONNENT PAS.
//
// styles.css à la racine du dépôt porte le système : les jetons de couleur,
// le reset, la barre de navigation, et le @font-face d'Inter. recouvrement/
// styles.css porte les écrans. La seconde n'a aucun jeton résolu sans la
// première, et les deux portent le même nom de fichier.
//
// La feuille racine est donc publiée à la racine du paquet, sous son nom, et
// celle du recouvrement à côté sous un autre nom. La racine n'est pas un
// détail : le src d'un @font-face se résout contre l'URL DE LA FEUILLE, pas
// contre celle de la page. Inter est à vendor/inter-latin.woff2 ; publier la
// feuille racine ailleurs qu'à la racine casserait la police en silence.
const COPIES = [
  [path.join(RACINE, 'styles.css'), 'styles.css'],
  [path.join(APP, 'styles.css'), 'recouvrement.css'],
  [path.join(RACINE, 'Liora_Logo_Orange_alpha.png'), 'Liora_Logo_Orange_alpha.png'],
  ...['chart.umd.min.js', 'chartjs-chart-treemap.min.js', 'papaparse.min.js',
      'inter-latin.woff2']
    .map(f => [path.join(RACINE, 'vendor', f), 'vendor/' + f]),
  ...['rules.js', 'ingest.js', 'metrics.js', 'prelevements.js', 'grandlivre.js',
      'sellsy.js', 'zoho.js', 'ui.js', 'api.js']
    .map(f => [path.join(APP, 'js', f), 'js/' + f]),
];
console.log('recopiés tels quels :');
let poids = 0;
for (const [src, dest] of COPIES) {
  const b = octets(src);
  fs.writeFileSync(path.join(DIST, dest), b);
  poids += b.length;
  console.log('  ' + dest.padEnd(34) + (b.length / 1024).toFixed(0).padStart(5) + ' Ko');
}

// ══════════════════════════════════════════════
//  1 bis. SheetJS, dont les tables de pages de code portent des octets bruts
// ══════════════════════════════════════════════
//
// La publication refuse un fichier texte qui contient un caractère
// d'échappement. SheetJS en porte 806 — tous à l'intérieur de chaînes, dans
// les tables de pages de code qu'il garde pour lire les vieux classeurs :
//
//     cptable[437] = function () { var e = "\0\x01\x02…"
//
// Il échappe déjà une partie de ces caractères (\0, \b, \t, \n, \x0B, \f,
// \r) et laisse les autres bruts. On écrit les autres de la même façon.
// C'est la même chaîne, dite autrement.
//
// « La même chaîne » ne se décrète pas : les deux versions sont chargées
// ici, et on leur fait écrire le MÊME classeur, avec les mêmes dates, dans
// les deux sens. Si les octets produits diffèrent d'un seul bit, la
// construction s'arrête.
{
  const SRC = path.join(RACINE, 'vendor', 'xlsx.full.min.js');
  const brut = fs.readFileSync(SRC, 'utf8');
  // Deux sortes de caractères que la publication refuse dans un fichier
  // texte, et qui sont ici des DONNÉES, pas des accidents :
  //   — les caractères de contrôle, entrées basses des tables ;
  //   — le caractère de remplacement U+FFFD, 51 671 fois : c'est l'entrée
  //     légitime des cases qu'une page de code ne définit pas.
  // Les deux s'écrivent en échappement sans rien changer à la chaîne.
  const CONTROLES = /[\x00-\x08\x0b\x0c\x0e-\x1f]/g;
  const REMPLACEMENT = /\uFFFD/g;
  const combien = (brut.match(CONTROLES) || []).length;
  const combienR = (brut.match(REMPLACEMENT) || []).length;
  const propre = brut
    .replace(CONTROLES, c => '\\x' + c.charCodeAt(0).toString(16).padStart(2, '0'))
    .replace(REMPLACEMENT, '\\ufffd');

  // Les deux versions écrivent le même classeur ?
  const vm = require('vm');
  const charger = source => {
    const ctx = { console, Buffer, TextDecoder, TextEncoder, Date, Math, JSON };
    ctx.self = ctx; ctx.window = ctx; ctx.globalThis = ctx; ctx.global = ctx;
    vm.createContext(ctx);
    vm.runInContext(source, ctx);
    return ctx.XLSX;
  };
  const epreuve = X => {
    // Des cellules qui passent par les tables : accents, cyrillique, un signe
    // monétaire, et une date fixe pour que deux écritures soient comparables.
    const wb = X.utils.book_new();
    X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet([
      ['Échéance', 'Montant', 'Client'],
      ['février 2026', 1234.56, 'Société Générale — Ωμέγα — Привет'],
      ['août 2027', -89.1, '€ ¥ £ ß æ œ ÿ'],
    ]), 'Épreuve');
    wb.Props = { CreatedDate: new Date(Date.UTC(2020, 0, 1)) };
    return Buffer.from(X.write(wb, { type: 'array', bookType: 'xlsx',
      Props: { CreatedDate: new Date(Date.UTC(2020, 0, 1)) } }));
  };
  const a = epreuve(charger(brut)), b = epreuve(charger(propre));
  if (!a.equals(b)) {
    throw new Error('construction interrompue · SheetJS échappé n’écrit pas le même '
      + 'classeur que l’original (' + a.length + ' octets contre ' + b.length + ').');
  }
  fs.writeFileSync(path.join(DIST, 'vendor/xlsx.full.min.js'), propre, 'utf8');
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\uFFFD]/.test(propre))
    throw new Error('construction interrompue · SheetJS porte encore un caractère refusé');
  console.log('SheetJS · ' + combien + ' caractères de contrôle et '
    + combienR.toLocaleString('fr-FR') + ' caractères de remplacement écrits en '
    + 'échappements · les deux versions produisent le même classeur, au bit près ('
    + a.length.toLocaleString('fr-FR') + ' octets)');
}

// ══════════════════════════════════════════════
//  2. Ce qui change, fichier par fichier
// ══════════════════════════════════════════════
console.log('substitutions :');

// ── js/store.js ──
// Rien : la remise en ordre de l'ouverture du magasin vaut aussi en local et
// a été faite dans la source.
fs.writeFileSync(path.join(DIST, 'js/store.js'), lire(path.join(APP, 'js/store.js')));

// ── js/monday.js ──
// L'API Monday est injoignable depuis un artefact : la liste des hôtes que la
// page a le droit d'appeler ne la contient pas, et l'appel échoue sans qu'on
// puisse le distinguer d'une panne de réseau. Le message d'erreur, lui, parle
// de connexion Internet et de jeton — il enverrait vérifier un jeton qui n'est
// pas en cause. Il dit maintenant ce qui se passe vraiment.
fs.writeFileSync(path.join(DIST, 'js/monday.js'), remplacer(
  lire(path.join(APP, 'js/monday.js')),
  [[
    `                        : "Impossible de joindre l'API Monday. Vérifiez la connexion Internet "
                          + "et le jeton. Détail : " + netErr.message`,
    `                        : "Cette page publiée ne peut pas appeler l'API Monday : seuls "
                          + "quelques hôtes lui sont ouverts, et api.monday.com n'en fait "
                          + "pas partie. Ce n'est ni votre connexion ni votre jeton. "
                          + "Importez les exports Excel / CSV de vos tableaux, ou ouvrez "
                          + "l'application sur votre poste pour la connexion directe."`,
    'le diagnostic dit la vérité du cadre',
  ]], 'js/monday.js'));

// ── app.js ──
const PATCHS_APP = [
  // LE BOUTON « EXPORTER PDF » SE RETIRE PAR LE CODE, PAS PAR LE DOCUMENT.
  //
  // window.print() ne fait rien dans un artefact : le clic serait sans effet
  // et sans message. Le bouton doit donc disparaître — mais le retirer du
  // document casserait l'application entière, parce que cette ligne attache
  // son écouteur sans vérifier que l'élément existe. On garde l'élément et
  // on le masque : [hidden] est déjà display:none dans le cadre.
  [`        $('#btn-export-pdf').addEventListener('click', () => window.print());`,
   `        // Le cadre d'un artefact n'ouvre pas la boîte d'impression : le bouton
        // est retiré plutôt que laissé sans effet.
        { const b = $('#btn-export-pdf'); if (b) b.hidden = true; }`,
   'le bouton d’impression est retiré'],

  // LA VÉRIFICATION DE VERSION N'A PLUS D'OBJET.
  //
  // Elle retélécharge le document à chaque ouverture pour comparer un numéro
  // de version, et propose de recharger. Publier sert déjà la nouvelle
  // version à tout le monde. La fonction devient une coquille — son appel
  // reste valide, et rien ne part sur le réseau.
  // LA DÉMONSTRATION NE NOMME PLUS PERSONNE.
  //
  // Dans un artefact vierge — et il l'est pour tout nouveau lecteur — la
  // démonstration est le seul chemin qui mène à un tableau de bord. Elle
  // affichait des créances et des retards de paiement au nom d'entreprises
  // réelles et de quatre personnes réelles, sur une page dont l'adresse se
  // partage. Les retards sont inventés ; les noms ne l'étaient pas. Ils le
  // sont maintenant, et la forme est conservée — raisons sociales longues
  // mêlées à des noms de personnes, puisque les tableaux groupent par client.
  //
  // En local, la démonstration garde ses vrais noms : ils servent à
  // reconnaître ses propres tableaux.
  [`        const clients = ['ALLIANZ I.A.R.D.', 'SOCIETE GENERALE', 'MFP MICHELIN', 'AEROPORTS DE PARIS', 'SUEZ INTERNATIONAL',
            'CREDIT AGRICOLE CORPORATE', 'ARTHUR HUNT CONSULTING', 'MISSIONEO', 'ANTARGAZ', 'UNISERV Sarl',
            'CABINET LACOMBLEZ', 'Marie Dupont', 'Karim Benali', 'Sophie Legrand', 'Thomas Moreau', 'Inès Rossi'];`,
   `        const clients = ['ASSURANCES MERIDIO', 'BANQUE CASTELAN', 'MFP VALBREUSE', 'AEROPORTS DE LOIRE', 'HYDRIA INTERNATIONAL',
            'CREDIT MUTUALISTE DU NORD', 'BERTRAND HUNT CONSEIL', 'MISSIONEA', 'ARTIGAZ', 'UNIVERSERV Sarl',
            'CABINET LACOMBE-ROY', 'Marie Dupont', 'Karim Benali', 'Sophie Legrand', 'Thomas Moreau', 'Inès Rossi'];`,
   'la démonstration ne nomme plus d’entreprise réelle'],

  [`                    proprietaire: pick(['Cédric Ngan', 'David Mamou', 'Zehavit Tordjman', 'M. Cédric Nelhomme']),`,
   `                    proprietaire: pick(['C. N.', 'D. M.', 'Z. T.', 'L. R.']),`,
   'la démonstration ne nomme plus personne'],

  [`    async function verifierPageAJour() {`,
   `    async function verifierPageAJour() {
        // Republier un artefact sert la nouvelle version à tous : il n'y a
        // pas de page périmée à détecter, et rien à retélécharger.
        return;`,
   'la vérification de version se tait'],
];
fs.writeFileSync(path.join(DIST, 'app.js'),
  remplacer(lire(path.join(APP, 'app.js')), PATCHS_APP, 'app.js'));

// ══════════════════════════════════════════════
//  3. Ce que le cadre offre à la place : l'enregistrement des classeurs
// ══════════════════════════════════════════════
fs.writeFileSync(path.join(DIST, 'artefact.js'), lire(path.join(ICI, 'artefact.js')));

// ══════════════════════════════════════════════
//  4. La page
// ══════════════════════════════════════════════
//
// Le document publié n'a pas de squelette : la publication l'enveloppe
// elle-même dans <!doctype html><html><head>…</head><body>. On ne garde donc
// que le contenu du corps, et on remonte en tête ce qui doit y être — le
// titre, les feuilles de style, et le petit bloc de rattrapage.
const SOURCE = lire(path.join(APP, 'index.html'));
const debut = SOURCE.indexOf('<body>');
const fin = SOURCE.lastIndexOf('</body>');
if (debut < 0 || fin < 0) throw new Error('index.html : corps introuvable');
let corps = SOURCE.slice(debut + '<body>'.length, fin);

corps = remplacer(corps, [
  // Le lien vers l'application sœur n'existe pas dans le paquet.
  [`            <a class="btn btn-ghost" href="../index.html" title="Ouvrir l'application Suivi Cash">Suivi Cash ↗</a>\n`,
   ``, 'le lien vers Suivi Cash est retiré'],

  // L'ACCUEIL S'OUVRE SUR LE CHEMIN QUI MARCHE.
  //
  // La première carte proposait de coller un jeton Monday — la seule action
  // impossible ici. Elle est masquée par le bloc de rattrapage ; son code
  // reste en place, car l'application y attache des écouteurs sans vérifier
  // que les éléments existent. Il ne reste donc qu'à renuméroter la carte
  // d'import et à dire ce qu'elle est.
  [`                        <span class="connect-badge">2</span>
                        <h3>Ou importer des exports</h3>`,
   `                        <span class="connect-badge">1</span>
                        <h3>Importer vos exports</h3>`,
   'la carte d’import devient la première'],

  [`                        Sans jeton API, déposez les exports Excel / CSV de vos tableaux Monday
                        (un fichier par tableau). Le rôle du tableau est déduit du nom du fichier.`,
   `                        Déposez les exports Excel / CSV de vos tableaux Monday, un fichier par
                        tableau, puis votre grand livre et vos exports de facturation. Le rôle de
                        chaque tableau est déduit du nom du fichier. Tout reste dans ce navigateur :
                        vos fichiers ne sont ni envoyés ni publiés.`,
   'la carte d’import dit ce qu’elle fait'],

  // LE CHARGEUR N'ANNONCE PLUS UNE CONNEXION QUI N'EXISTE PAS.
  //
  // Ce texte est écrit en dur sous le voile de chargement, et il s'affiche
  // jusqu'à ce que le code l'écrase. Ici, le seul chemin qui ouvre ce voile
  // est le dépôt de fichiers : la première chose que lisait la personne qui
  // dépose son grand livre était le nom de la seule connexion impossible.
  [`<p class="loader-sub" id="loader-status">Connexion à Monday</p>`,
   `<p class="loader-sub" id="loader-status">Lecture de vos fichiers</p>`,
   'le chargeur parle des fichiers'],

  // LA CARTE « CONNEXION MONDAY » DE L'ONGLET DONNÉES, EN ENTIER.
  //
  // Masquer ses commandes une à une laissait debout son titre, son bouton
  // « Connecter » et la phrase qui promet que le jeton « n'est transmis qu'à
  // api.monday.com ». L'attribut est posé sur la carte : rien ne quitte le
  // document, donc les écouteurs que l'application attache sans vérifier
  // continuent de trouver leurs éléments.
  [`            <div class="chart-card chart-wide settings-card">
                <div class="chart-header"><h3>Connexion Monday</h3></div>`,
   `            <div class="chart-card chart-wide settings-card" hidden>
                <div class="chart-header"><h3>Connexion Monday</h3></div>`,
   'la carte de connexion est retirée de l’onglet Données'],

  // L'ACCUEIL DIT CE QUE CETTE PAGE EST.
  //
  // Elle s'ouvre vide à chaque fois, pour chacun : tout vit dans le stockage
  // du navigateur qui l'ouvre. L'application locale n'avait jamais eu besoin
  // de l'écrire. Et la démonstration devient le bouton franc, puisque c'est
  // le seul chemin qui montre quelque chose sans rien déposer.
  [`            <div class="welcome-actions">
                <button class="btn btn-ghost" id="btn-open-saved" hidden>Reprendre les données enregistrées</button>
                <button class="btn btn-ghost" id="btn-demo">Voir une démonstration</button>
            </div>`,
   `            <p class="connect-desc" style="text-align:center;max-width:620px;margin-inline:auto">
                Cette page s'ouvre vide : vos fichiers restent dans ce navigateur, ne sont
                jamais envoyés, et ne suivent pas d'un appareil à l'autre. Déposez-les une
                fois, ils seront retrouvés à la prochaine ouverture sur le même navigateur.
            </p>
            <p class="connect-desc" style="text-align:center;max-width:620px;margin-inline:auto">
                <strong>Pour brancher Monday directement, sans aucun export :</strong> ouvrez
                l'application sur votre poste &mdash; &laquo;&nbsp;Lancer Suivi Recouvrement&nbsp;&raquo;
                &mdash; puis, sur cet écran, la carte &laquo;&nbsp;Connexion Monday&nbsp;&raquo;. Le jeton
                se prend dans Monday&nbsp;: avatar &rarr; <em>Développeurs</em> &rarr;
                <em>Mes jetons d'accès</em>. Une page publiée comme celle-ci n'a pas le droit
                d'appeler api.monday.com&nbsp;; c'est pourquoi le champ n'y figure pas.
            </p>
            <div class="welcome-actions">
                <button class="btn btn-ghost" id="btn-open-saved" hidden>Reprendre les données enregistrées</button>
                <button class="btn btn-primary" id="btn-demo">Voir une démonstration</button>
            </div>`,
   'l’accueil dit ce que cette page conserve'],

  [`                Connectez vos tableaux Monday, l'application calcule les échéances selon vos règles de
                financement, identifie les factures en retard et mesure le taux de recouvrement par mois
                et par type de financement.`,
   `                Déposez vos exports : l'application calcule les échéances selon vos règles de
                financement, identifie les factures en retard, confronte la balance âgée du grand
                livre à votre portefeuille et mesure le taux de recouvrement par mois et par type
                de financement.`,
   'le texte d’accueil part de l’import'],
], 'index.html');

// Les chemins. Un chemin publié est relatif et ne remonte jamais au-dessus de
// la racine du paquet : ../vendor/ et ../Liora_Logo… n'y résoudraient rien.
// Et les chaînes de version ?v=… n'ont plus d'objet — republier suffit.
const AVANT_CHEMINS = corps;
corps = corps
  .replace(/\.\.\/vendor\//g, 'vendor/')
  .replace(/\.\.\/Liora_Logo_Orange_alpha\.png/g, 'Liora_Logo_Orange_alpha.png')
  // Le numéro de version se lit dans app.js, il ne s'écrit pas ici : une
  // copie dans ce script devenait fausse à chaque publication, et la
  // substitution suivante échouait sans qu'on sache pourquoi.
  .replace(/\?v=[0-9]+\.[0-9]+\.[0-9]+/g, '');
if (corps === AVANT_CHEMINS) throw new Error('index.html : aucun chemin réécrit, vérifier les motifs');
if (/\.\.\//.test(corps)) {
  const reste = corps.match(/[^\s"']*\.\.\/[^\s"']*/g) || [];
  throw new Error('index.html : chemins qui sortent du paquet · ' + [...new Set(reste)].join(' · '));
}

// Le shim d'enregistrement se charge après SheetJS, qu'il enveloppe, et avant
// app.js, qui s'en sert.
corps = remplacer(corps, [
  [`<script src="app.js"></script>`,
   `<script src="artefact.js"></script>\n<script src="app.js"></script>`,
   'le canal d’enregistrement entre dans la page'],
], 'index.html');

// LES BIBLIOTHÈQUES VIVAIENT DANS LA TÊTE DU DOCUMENT.
//
// L'aplatissement ne garde que le corps — et les quatre bibliothèques, comme
// les deux feuilles de style, étaient dans le <head>. Sans elles, XLSX, Chart
// et Papa n'existent pas et l'application s'arrête au premier appel. Elles
// reviennent donc en tête du fichier publié, dans le même ordre : le greffon
// de treemap s'enregistre auprès de Chart.js et ne peut pas le précéder.
const BIBLIOS = ['chart.umd.min.js', 'chartjs-chart-treemap.min.js',
                 'papaparse.min.js', 'xlsx.full.min.js']
  .map(f => '<script src="vendor/' + f + '"></' + 'script>').join('\n');

const TETE = `<title>Suivi recouvrement</title>
<link rel="stylesheet" href="styles.css">
<link rel="stylesheet" href="recouvrement.css">
${BIBLIOS}
<style>
/* ── RATTRAPAGES DU CADRE ──
   Trois réglages que le cadre d'un artefact impose et que l'application
   n'avait pas de raison de prévoir. Ils ne vivent que dans le paquet publié :
   en local, rien de tout cela ne s'applique. */

/* L'application est sombre ; le cadre annonce une page claire. Sans cette
   ligne, les contrôles dessinés par le navigateur — champs de date, listes
   déroulantes, barres de défilement — sortent en clair sur du presque noir. */
:root { color-scheme: dark; }

/* La connexion par jeton Monday ne peut pas aboutir ici. Les deux blocs qui
   la proposent sont masqués ; leur code reste en place, et les gardes de
   l'application sur un jeton vide font le reste. */
.connect-grid > .connect-card:first-child { display: none; }
.connect-grid { grid-template-columns: minmax(0, 1fr); max-width: 620px; margin-inline: auto; }
#settings-token, #btn-settings-token-visible, #btn-settings-forget,
#btn-boards-refresh, #btn-boards-load,
/* Les deux boutons « actualiser depuis Monday » : il n'y a rien à rappeler
   ici, et le second est le bouton le plus visible de la balance âgée. Les
   dépôts de fichiers de l'onglet Données restent le chemin d'actualisation. */
#btn-refresh, #btn-aging-refresh { display: none; }

/* Deux grilles à plancher fixe débordaient à la largeur d'un téléphone. */
@media (max-width: 900px) {
  .charts-grid-4 { grid-template-columns: minmax(0, 1fr); }
}
/* La barre de qualification demande 502 px avec sa carte. Elle ne déborde
   donc qu'en dessous, pas à 900 px où l'on perdait deux colonnes pour rien.
   Et quand elle se replie, elle reste élastique plutôt que de descendre
   sous son propre plancher. */
@media (max-width: 560px) {
  .qualif-ligne { grid-template-columns: minmax(0, 1.6fr) minmax(40px, 1fr) 74px; gap: 6px; }
  .qualif-ligne > :nth-child(4), .qualif-ligne > :nth-child(5) { display: none; }
}
</style>
`;

const PAGE = TETE + corps;

// CHAQUE FICHIER PUBLIÉ DOIT ÊTRE APPELÉ PAR LA PAGE.
//
// Le <head> du document source portait les quatre bibliothèques et les deux
// feuilles de style ; l'aplatissement les avait emportées sans bruit, et la
// page partait sans SheetJS. Ce contrôle refuse une page qui oublie un de ses
// fichiers — ou qui en appelle un qui n'a pas été copié.
{
  const appeles = new Set();
  for (const m of PAGE.matchAll(/(?:src|href)="([^"]+)"/g)) {
    const u = m[1];
    if (!/^(https?:|data:|#|mailto:)/.test(u)) appeles.add(u);
  }
  const copies = new Set(COPIES.map(c => c[1])
    .concat(['js/store.js', 'js/monday.js', 'app.js', 'artefact.js',
             'vendor/xlsx.full.min.js']));
  const oublies = [...copies].filter(f => !appeles.has(f) && !/\.woff2$|\.png$/.test(f));
  const fantomes = [...appeles].filter(u => !copies.has(u));
  if (oublies.length) throw new Error('la page n’appelle pas : ' + oublies.join(' · '));
  if (fantomes.length) throw new Error('la page appelle ce qui n’est pas copié : ' + fantomes.join(' · '));
  console.log('contrôle · la page appelle ses ' + appeles.size + ' fichiers, et rien d’autre');
}

fs.writeFileSync(path.join(DIST, 'index.html'), PAGE);

// ══════════════════════════════════════════════
//  5. La page, telle que le cadre la servira
// ══════════════════════════════════════════════
//
// La page publiée n'a pas de squelette : c'est la publication qui l'enveloppe.
// Pour l'éprouver ici, il faut donc refaire cette enveloppe à l'identique —
// le même reset, le même viewport — sinon l'essai mesure un document que
// personne ne verra. On y ajoute un faux canal « downloads », qui retient ce
// qu'on lui demande d'enregistrer au lieu de l'enregistrer : c'est la seule
// façon de vérifier qu'un classeur sort bien par la bonne porte.
//
// Ce fichier ne part PAS dans l'artefact : la publication nomme ses fichiers
// un par un, et celui-ci n'y figure pas.
const ENVELOPPE = `<!doctype html><html><head><meta charset=utf8>`
  + `<meta name=viewport content="width=device-width,initial-scale=1,viewport-fit=cover">`
  + `<style>:root{color-scheme:light;padding-top:env(safe-area-inset-top,0px);`
  + `padding-bottom:env(safe-area-inset-bottom,0px)}body{margin:0;font:14px system-ui,sans-serif}`
  + `img{max-width:100%}[hidden]{display:none!important}</style></head><body>`
  + `<script>
// Le faux cadre. claude.use() ne rend QUE ce que le vrai rend : la capacité
// demandée, ou null. save() retient l'appel pour que l'essai le relise.
window.__enregistres = [];
window.claude = { use: function (nom) {
  if (nom !== 'downloads') return Promise.resolve(null);
  return Promise.resolve({ save: function (d) {
    window.__enregistres.push({ filename: d.filename,
      estBlob: d.data instanceof Blob, taille: d.data && d.data.size });
    return Promise.resolve({ status: 'saved' });
  } });
} };
<\/script>`
  + PAGE + `</body></html>`;
// Il vit DANS le paquet, parce que la page y cherche ses fichiers par des
// chemins relatifs — mais il n'est pas dans la liste des fichiers publiés.
fs.writeFileSync(path.join(DIST, 'essai.html'), ENVELOPPE);

// ══════════════════════════════════════════════
//  6. Le compte rendu
// ══════════════════════════════════════════════
// ══════════════════════════════════════════════
//  LES DONNÉES DU JOUR
// ══════════════════════════════════════════════
//
// La tâche programmée du matin dépose ici les exports Monday de la journée.
// S'ils sont là, ils partent avec la page, qui s'ouvre déjà remplie. S'ils n'y
// sont pas, la construction ne s'arrête pas et ne se tait pas non plus : la
// page retombe sur son écran d'accueil, qui reste son comportement normal.
//
// Ces fichiers ne vont jamais au dépôt — .gitignore les écarte. Ils portent le
// portefeuille réel, et leur place est dans l'artefact privé, pas dans l'historique.
{
  const SOURCE = path.join(__dirname, 'donnees-du-jour');
  const MANIFESTE = path.join(SOURCE, 'du-jour.json');
  if (fs.existsSync(MANIFESTE)) {
    const cible = path.join(DIST, 'donnees');
    fs.mkdirSync(cible, { recursive: true });
    const m = JSON.parse(fs.readFileSync(MANIFESTE, 'utf8'));
    const annonces = Array.isArray(m.fichiers) ? m.fichiers : [];
    let n = 0, octets = 0;
    const absents = [];
    for (const f of annonces.concat(['du-jour.json'])) {
      const src = path.join(SOURCE, f);
      if (!fs.existsSync(src)) { absents.push(f); continue; }
      fs.copyFileSync(src, path.join(cible, f));
      octets += fs.statSync(src).size;
      n++;
    }
    // Un manifeste qui annonce un fichier absent produirait une page qui
    // s'ouvre sur un portefeuille incomplet sans le dire. On refuse.
    if (absents.length) {
      throw new Error('donn\u00e9es du jour : le manifeste annonce des fichiers absents \u2014 ' + absents.join(', '));
    }
    // Le drapeau qui autorise la page à aller les chercher. Sans lui elle ne
    // demande rien : l'application locale n'a pas de données déposées, et une
    // requête sans réponse la laissait pendue.
    const page = path.join(DIST, 'index.html');
    let html = fs.readFileSync(page, 'utf8');
    const marque = '<script>window.LIORA_DONNEES_DU_JOUR = true;</script>';
    if (html.indexOf(marque) === -1) {
      const cible = '<script src="app.js';
      const i = html.indexOf(cible);
      if (i === -1) throw new Error('donn\u00e9es du jour : impossible de poser le drapeau, app.js introuvable dans la page');
      html = html.slice(0, i) + marque + '\n    ' + html.slice(i);
      fs.writeFileSync(page, html);
    }

    console.log('donn\u00e9es du jour \u00b7 ' + n + ' fichiers \u00b7 ' + Math.round(octets / 1024)
      + ' Ko \u00b7 arr\u00eat\u00e9 au ' + (m.arreteLe || '?') + (m.arreteA ? ' \u00e0 ' + m.arreteA : ''));
  } else {
    console.log('donn\u00e9es du jour \u00b7 aucune \u00b7 la page s\u2019ouvrira sur son accueil');
  }
}

const tous = [];
(function parcourir(d, prefixe) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name), nom = prefixe + e.name;
    if (e.isDirectory()) parcourir(p, nom + '/');
    else tous.push([nom, fs.statSync(p).size]);
  }
})(DIST, '');
tous.sort((a, b) => b[1] - a[1]);

// LA LISTE DE CE QUI SE PUBLIE, ÉCRITE PLUTÔT QUE RETENUE.
//
// La publication nomme ses fichiers un par un. Deux erreurs sont possibles :
// en oublier un — la page part alors sans un de ses modules, et rien ne le
// dit bruyamment — ou publier essai.html, qui porte un faux window.claude et
// un squelette complet, et deviendrait une seconde page incohérente servie à
// la même adresse. La liste est donc écrite ici, à chaque construction.
{
  const aPublier = tous.map(f => f[0]).filter(n => n !== 'index.html' && n !== 'essai.html');
  fs.writeFileSync(path.join(DIST, 'A-PUBLIER.txt'),
    'La page : index.html\n'
    + 'Les ' + aPublier.length + ' fichiers à publier avec elle :\n'
    + aPublier.sort().map(n => '  ' + n).join('\n')
    + '\n\nCapacités : downloads (les classeurs Excel passent par là).\n'
    + 'Ne JAMAIS publier : essai.html (faux canal, squelette complet),\n'
    + '                   A-PUBLIER.txt (ce fichier).\n');
  console.log('à publier · ' + aPublier.length + ' fichiers avec la page · liste dans A-PUBLIER.txt');
}
const total = tous.reduce((s, f) => s + f[1], 0);
console.log('\npaquet · ' + tous.length + ' fichiers · '
  + (total / 1024 / 1024).toFixed(2) + ' Mo');
console.log('  page : ' + (PAGE.length / 1024).toFixed(0) + ' Ko'
  + (PAGE.length > 16 * 1024 * 1024 ? '  ← AU-DELÀ DE LA LIMITE' : ''));
for (const [n, t] of tous.slice(0, 6))
  console.log('  ' + n.padEnd(34) + (t / 1024).toFixed(0).padStart(5) + ' Ko');
console.log('\n' + DIST);
