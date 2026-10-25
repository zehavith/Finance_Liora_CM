#!/usr/bin/env node
/* ==========================================================
   Liora — Suivi Recouvrement
   actualiser.js — sort les créances de Monday, pour la page

   Usage :  MONDAY_TOKEN=... node recouvrement/artefact/actualiser.js

   Écrit un CSV par tableau dans artefact/donnees-du-jour/, plus le
   manifeste du-jour.json. La construction les emporte ensuite avec la page.

   POURQUOI UN PROGRAMME, ET NON UNE SUITE D'APPELS.
   La première version passait par le bac à sable du connecteur Monday, coupé
   à soixante secondes : les neuf tableaux demandaient six appels enchaînés,
   des curseurs passés de l'un à l'autre, et autant d'occasions de s'arrêter
   au milieu. Ici rien ne coupe : le programme lit tout, vérifie tout, et
   n'écrit qu'une fois sûr de lui.

   CE PROGRAMME NE FAIT QUE LIRE. Aucune mutation GraphQL n'y figure, et il
   n'en construit jamais : il envoie des « query », jamais des « mutation ».
   Le jeton porte les droits de son auteur — c'est le code qui garantit la
   lecture seule, pas le jeton.
   ========================================================== */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const API = 'https://api.monday.com/v2';
const RACINE = path.resolve(__dirname, '..');
const SORTIE = path.join(__dirname, 'donnees-du-jour');
const PAGE = 250;

// ──────────────────────────────────────────────
//  Les neuf tableaux retenus
//
//  Le classement vient de Zehavit, confirmé sur son arborescence Monday du
//  25/10/2026 : série 1 = Corporate, série 2 = B2C, rang 9 = technique.
//  Tout tableau absent de cette liste est hors du portefeuille — les 1.9. et
//  2.9. techniques, « 2.5. Recouvrement B2C » qui ne porte que des lignes
//  d'essai, et tout ce qui vit hors des dossiers « 1. Corporate » et
//  « 2. B2C ».
// ──────────────────────────────────────────────
const TABLEAUX = [
    '1842356810', // 0.1. ALL - Factures payées
    '1818713092', // 1.0. Entreprise - Tampon
    '1817877566', // 1.1. Entreprise - ADV
    '1840539926', // 1.2. Entreprise - Recouvrement
    '5099882263', // 1.3. Entreprise - OPCO
    '1909949610', // 2.1. Financement Personnel
    '1912012437', // 2.2. Financement CPF
    '1912012068', // 2.3. Financement pôle emploi : AIF / POEI
    '1912012597', // 2.4. Financement complexe : REGION / TRANSITION / AGEFIPH
];

// ──────────────────────────────────────────────
//  Le code de l'application fait foi
//
//  Les colonnes à sortir et les groupes à écarter ne sont pas décidés ici :
//  ils sont demandés aux mêmes fonctions que celles qui liront le fichier.
//  Deux listes séparées finiraient par diverger, et l'écart ne se verrait
//  que sur une balance fausse.
// ──────────────────────────────────────────────
function chargerApplication() {
    const ctx = { window: {}, console };
    vm.createContext(ctx);
    for (const f of ['rules.js', 'ingest.js']) {
        vm.runInContext(fs.readFileSync(path.join(RACINE, 'js', f), 'utf8'), ctx, { filename: f });
    }
    const R = ctx.window.LioraRules, I = ctx.window.LioraIngest;
    if (!R || !I || !I.autoMapColumns || !R.estGroupeTechnique) {
        throw new Error('les modules de l’application ne se sont pas chargés');
    }
    return { R, I };
}

// ──────────────────────────────────────────────
//  Requêtes
// ──────────────────────────────────────────────
const JETON = process.env.MONDAY_TOKEN || '';

async function gql(query, variables, essai) {
    const n = essai || 0;
    let rep;
    try {
        rep = await fetch(API, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': JETON,
                'API-Version': '2024-10',
            },
            body: JSON.stringify({ query, variables: variables || {} }),
        });
    } catch (e) {
        if (n >= 4) throw new Error('api.monday.com injoignable : ' + e.message);
        await pause(1000 * Math.pow(2, n));
        return gql(query, variables, n + 1);
    }

    if (rep.status === 401 || rep.status === 403) {
        throw new Error('jeton Monday refusé (' + rep.status + ') — vérifiez MONDAY_TOKEN');
    }
    // La limite de débit n'est pas une panne : on attend et on recommence.
    if (rep.status === 429 || rep.status === 503) {
        if (n >= 5) throw new Error('limite de débit Monday après plusieurs tentatives');
        await pause(1000 * Math.pow(2, n + 1));
        return gql(query, variables, n + 1);
    }

    const corps = await rep.json();
    // Monday répond 200 avec un tableau « errors » : le code HTTP ne dit rien.
    if (corps.errors) {
        const m = JSON.stringify(corps.errors).slice(0, 400);
        if (/complexity|rate|minute/i.test(m) && n < 5) {
            await pause(1000 * Math.pow(2, n + 1));
            return gql(query, variables, n + 1);
        }
        throw new Error('Monday : ' + m);
    }
    return corps.data;
}

const pause = ms => new Promise(r => setTimeout(r, ms));

const VALEURS = `column_values (ids: $cols) { id text value
    ... on MirrorValue { display_value }
    ... on BoardRelationValue { display_value }
    ... on DependencyValue { display_value }
    ... on FormulaValue { display_value } }`;
const ELEMENT = `name group { id title } ${VALEURS}`;

const Q_META = `query ($ids:[ID!]) { boards (ids:$ids) {
    id name items_count columns { id title type } groups { id title } } }`;
const Q_SUITE = `query ($cursor:String!, $limit:Int!, $cols:[String!]) {
    next_items_page (cursor:$cursor, limit:$limit) { cursor items { ${ELEMENT} } } }`;

/**
 * La valeur exploitable d'une colonne : display_value pour les miroirs et les
 * formules, sinon text, sinon ce que porte la valeur brute.
 *
 * C'est la cascade de columnValue() dans js/monday.js, et elle n'est pas
 * optionnelle : « 1.1. ADV » et « 1.2. Recouvrement » ne sont presque que des
 * miroirs. Sans display_value, ils sortent entièrement vides.
 */
function valeur(cv) {
    if (!cv) return '';
    const d = cv.display_value;
    if (d != null && String(d).trim() !== '') return String(d).trim();
    const t = cv.text;
    if (t != null && String(t).trim() !== '') return String(t).trim();
    if (cv.value) {
        try {
            const v = JSON.parse(cv.value);
            if (v == null) return '';
            if (typeof v === 'string' || typeof v === 'number') return String(v);
            if (v.date) return v.time ? v.date + ' ' + v.time : v.date;
            if (v.text != null) return String(v.text);
            if (v.label != null) return String(v.label);
        } catch { /* valeur brute illisible : rien à en tirer */ }
    }
    return '';
}

/**
 * Un nom de fichier sans accent.
 *
 * Un nom accentué est perdu en silence au dépôt : le fichier n'arrive jamais
 * à l'import, sans erreur ni message. « Factures payées.csv » et « pôle
 * emploi » manquaient ainsi à l'appel, et avec eux 7 249 factures. Le rôle se
 * déduit du titre du tableau écrit DANS le fichier, pas de son nom : rien
 * n'est perdu à le translittérer.
 */
function nomDeFichier(titre) {
    return String(titre || '')
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .replace(/[^A-Za-z0-9 ._-]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim() + '.csv';
}

function cellule(v) {
    const s = String(v == null ? '' : v).replace(/\r?\n/g, ' ');
    return /[",]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

// ──────────────────────────────────────────────
//  Un tableau
// ──────────────────────────────────────────────
async function sortirTableau(bid, app) {
    const { R, I } = app;
    const meta = (await gql(Q_META, { ids: [bid] })).boards[0];
    if (!meta) throw new Error('tableau ' + bid + ' introuvable');

    const colonnes = meta.columns.map(c => ({ id: c.id, title: c.title, type: c.type }));
    const mapping = I.autoMapColumns(colonnes, null) || {};
    // « name » n'est pas une colonne : c'est le pseudo-champ vide de Monday, et
    // il porte le même alias que « Nom ». Demandé, il écrase le numéro de facture.
    const gardees = [...new Set(Object.values(mapping))].filter(c => c && c !== 'name');
    const champs = Object.keys(mapping).sort();

    const ESSENTIELS = ['numero', 'client', 'montant', 'dateFacture', 'dateEcheanceSource'];
    const manquants = ESSENTIELS.filter(c => !champs.includes(c));

    const tech = meta.groups.filter(g => R.estGroupeTechnique(g.title));
    const vivants = meta.groups.filter(g => !R.estGroupeTechnique(g.title));

    // compare_value n'accepte pas de variable de liste : les groupes retenus
    // s'écrivent dans la requête elle-même.
    const litteral = JSON.stringify(vivants.map(g => g.id));
    const Q_PREMIER = `query ($ids:[ID!], $limit:Int!, $cols:[String!]) { boards (ids:$ids) {
        items_page (limit:$limit, query_params: {rules: [{column_id: "group",
            compare_value: ${litteral}, operator: any_of}]})
        { cursor items { ${ELEMENT} } } } }`;

    const titreDe = new Map(colonnes.map(c => [c.id, c.title]));
    const lignes = [];
    let p = (await gql(Q_PREMIER, { ids: [bid], limit: PAGE, cols: gardees })).boards[0].items_page;
    lignes.push(...p.items);
    let curseur = p.cursor, tours = 0;
    while (curseur && tours < 400) {
        tours++;
        const q = (await gql(Q_SUITE, { cursor: curseur, limit: PAGE, cols: gardees })).next_items_page;
        if (!q) break;
        lignes.push(...q.items);
        curseur = q.cursor;
    }
    if (curseur) throw new Error(meta.name + ' : pagination inachevée après ' + tours + ' pages');

    return { meta, gardees, titreDe, champs, manquants, tech, lignes };
}

/**
 * Le fichier prend la forme d'un export Monday, et non celle d'un CSV plat.
 *
 * L'application a été écrite pour cette forme, et elle en tire DEUX choses
 * distinctes : le titre du groupe où la facture est rangée, et la colonne
 * « Groupe » du tableau, qui porte l'origine. Sur « 0.1. ALL - Factures
 * payées » les deux existent et ne disent pas la même chose. Un CSV plat avec
 * une colonne « Groupe » ajoutée les confond, et des factures payées passent
 * pour des factures en tampon.
 */
function ecrireCsv(chemin, r) {
    const entete = ['Name', ...r.gardees.map(c => r.titreDe.get(c) || c)];
    const parGroupe = new Map();
    for (const it of r.lignes) {
        const g = (it.group && it.group.title) || '(sans groupe)';
        if (!parGroupe.has(g)) parGroupe.set(g, []);
        parGroupe.get(g).push(it);
    }

    const out = [[r.meta.name]];
    let premier = true, solitaires = 0;
    for (const [groupe, items] of parGroupe) {
        out.push([groupe]);
        if (premier) { out.push(entete); premier = false; }
        for (const it of items) {
            const par = new Map((it.column_values || []).map(cv => [cv.id, valeur(cv)]));
            const ligne = [it.name || '', ...r.gardees.map(c => par.get(c) || '')];
            // Une ligne à une seule cellule remplie passerait pour un titre de
            // groupe et effacerait le groupe courant.
            if (ligne.filter(c => String(c).trim()).length === 1) solitaires++;
            out.push(ligne);
        }
    }
    fs.writeFileSync(chemin, '﻿' + out.map(l => l.map(cellule).join(',')).join('\n') + '\n', 'utf8');
    return { solitaires, groupes: parGroupe.size };
}

// ──────────────────────────────────────────────
//  Marche
// ──────────────────────────────────────────────
async function main() {
    if (!JETON) {
        console.error('MONDAY_TOKEN est vide. Rien n’a été lu, rien n’a été écrit.');
        console.error('Le jeton se règle dans les variables de l’environnement cloud.');
        process.exit(2);
    }

    const app = chargerApplication();
    fs.mkdirSync(SORTIE, { recursive: true });

    const bilan = [], alertes = [];
    for (const bid of TABLEAUX) {
        const r = await sortirTableau(bid, app);
        const attendu = r.meta.items_count;
        const nom = nomDeFichier(r.meta.name);
        const ecrit = ecrireCsv(path.join(SORTIE, nom), r);

        if (r.manquants.length) {
            alertes.push(r.meta.name + ' : champ(s) essentiel(s) non reconnu(s) — ' + r.manquants.join(', '));
        }
        if (ecrit.solitaires) {
            alertes.push(r.meta.name + ' : ' + ecrit.solitaires + ' ligne(s) à une seule cellule remplie');
        }

        bilan.push({
            tableau: r.meta.name, fichier: nom,
            annonceMonday: attendu, retenues: r.lignes.length,
            groupesEcartes: r.tech.map(g => g.title),
            groupes: ecrit.groupes, colonnes: r.gardees.length, champs: r.champs.length,
        });
        console.log(String(r.lignes.length).padStart(6) + ' / ' + String(attendu).padEnd(6)
            + ' ' + r.meta.name
            + (r.tech.length ? '   (−' + r.tech.length + ' groupe(s) technique(s))' : ''));
    }

    // Un tableau vide n'est jamais normal : neuf tableaux de créances ne se
    // vident pas dans la nuit. Mieux vaut ne rien republier.
    const vides = bilan.filter(b => b.retenues === 0);
    if (vides.length) alertes.push('tableau(x) revenu(s) vide(s) : ' + vides.map(v => v.tableau).join(', '));

    if (alertes.length) {
        console.error('\nACTUALISATION REFUSÉE — ne republiez pas :');
        for (const a of alertes) console.error('  · ' + a);
        process.exit(1);
    }

    const d = new Date();
    const jour = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0')
        + '-' + String(d.getDate()).padStart(2, '0');
    const manifeste = {
        arreteLe: jour,
        arreteA: '10h00',
        source: 'Monday — api.monday.com, groupes techniques écartés',
        fichiers: bilan.map(b => b.fichier).sort(),
    };
    fs.writeFileSync(path.join(SORTIE, 'du-jour.json'),
        JSON.stringify(manifeste, null, 1) + '\n', 'utf8');

    const total = bilan.reduce((s, b) => s + b.retenues, 0);
    console.log('\n' + total + ' lignes · ' + bilan.length + ' tableaux · arrêté au ' + jour);
    console.log('Déposé dans ' + SORTIE);
}

main().catch(e => {
    console.error('\nACTUALISATION INTERROMPUE : ' + e.message);
    console.error('Rien n’a été republié. La page garde les chiffres de la veille.');
    process.exit(1);
});
