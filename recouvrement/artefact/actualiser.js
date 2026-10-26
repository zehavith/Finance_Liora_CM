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
//  Relire seulement ce qui a changé
//
//  Sur 18\u202f628 lignes, 55 changent en vingt-quatre heures — 0,3\u202f%. Relire tout
//  chaque matin, c'est deux cents fois le travail nécessaire, quarante-cinq
//  requêtes paginées et un quart d'heure ; relever ce qui a bougé prend quinze
//  secondes.
//
//  MAIS UNE MISE À JOUR INCRÉMENTALE MENT FACILEMENT, et une balance qui ment
//  sans le dire est pire qu'une balance lente. Trois protections, validées :
//
//   0. UNE FACTURE QUI CHANGE DE TABLEAU est le cas qui rend le contrôle des
//      nombres indispensable. Qu'elle passe de «\u202f1.2. Recouvrement\u202f» à
//      «\u202f0.1. Factures payées\u202f», et le tableau d'arrivée la voit comme
//      modifiée — elle entre. Mais le tableau de départ, lui, ne voit RIEN :
//      elle n'y a pas changé, elle en est partie. Sans le contrôle des
//      nombres, elle figurerait dans les deux copies à la fois, en
//      recouvrement ET payée. Vérifié : les deux tableaux concernés sont relus
//      en entier, les sept autres restent en incrémental.
//   1. Les suppressions ne se voient pas. Une facture effacée dans Monday ne
//      «\u202fchange\u202f» pas, elle disparaît : aucun filtre sur la date de
//      modification ne la rattrapera. On compare donc le nombre de lignes
//      annoncé par Monday à celui du dernier relevé. S'il a baissé, ou s'il a
//      monté sans que les lignes nouvelles l'expliquent, ce tableau est relu
//      EN ENTIER.
//   2. On récupère les modifiées SANS filtrer les groupes. Une facture déplacée
//      vers «\u202fTechnique - Archive\u202f» a bien changé, mais un relevé qui écarte
//      ces groupes à la source ne la verrait plus : elle resterait dans la
//      copie pour toujours. On prend tout, et l'on tranche ensuite.
//   3. Relecture complète le lundi, quoi qu'il arrive. Le filet contre ce que
//      les deux premières n'attrapent pas : une colonne renommée, un groupe
//      créé, une dérive silencieuse.
// ──────────────────────────────────────────────

/** Relit un fichier déjà écrit : titre du tableau, en-tête, et lignes par groupe. */
function lireCsvMonday(chemin) {
    if (!fs.existsSync(chemin)) return null;
    const txt = fs.readFileSync(chemin, 'utf8').replace(/^\uFEFF/, '');
    const m = [];
    let champ = '', ligne = [], q = false;
    for (let i = 0; i < txt.length; i++) {
        const c = txt[i];
        if (q) {
            if (c === '"') { if (txt[i + 1] === '"') { champ += '"'; i++; } else q = false; }
            else champ += c;
        } else if (c === '"') q = true;
        else if (c === ',') { ligne.push(champ); champ = ''; }
        else if (c === '\n') { ligne.push(champ); m.push(ligne); ligne = []; champ = ''; }
        else if (c !== '\r') champ += c;
    }
    if (champ || ligne.length) { ligne.push(champ); m.push(ligne); }
    if (m.length < 3) return null;

    const remplies = l => l.filter(c => String(c).trim()).length;
    const tableau = String(m[0][0] || '').trim();
    let entete = null, groupe = '';
    const parGroupe = new Map();
    for (let i = 1; i < m.length; i++) {
        const l = m[i];
        if (!remplies(l)) continue;
        const tete = String(l[0] || '').trim().toLowerCase();
        if (tete === 'name' || tete === 'nom') { entete = l.map(c => String(c).trim()); continue; }
        if (remplies(l) === 1 && String(l[0] || '').trim()) { groupe = String(l[0]).trim(); continue; }
        if (!entete) continue;
        if (!parGroupe.has(groupe)) parGroupe.set(groupe, []);
        parGroupe.get(groupe).push(l);
    }
    if (!entete) return null;
    return { tableau, entete, parGroupe };
}

/** Écrit un fichier à partir de lignes déjà aplaties, à la forme d'un export Monday. */
function ecrireCsvBrut(chemin, tableau, entete, parGroupe) {
    const out = [[tableau]];
    let premier = true, solitaires = 0;
    for (const [groupe, lignes] of parGroupe) {
        if (!lignes.length) continue;
        out.push([groupe]);
        if (premier) { out.push(entete); premier = false; }
        for (const l of lignes) {
            if (l.filter(c => String(c).trim()).length === 1) solitaires++;
            out.push(l);
        }
    }
    if (premier) return { solitaires, groupes: 0, lignes: 0 };
    fs.writeFileSync(chemin, '\uFEFF' + out.map(l => l.map(cellule).join(',')).join('\n') + '\n', 'utf8');
    let n = 0;
    for (const lignes of parGroupe.values()) n += lignes.length;
    return { solitaires, groupes: [...parGroupe.values()].filter(v => v.length).length, lignes: n };
}

/** Les éléments d'un tableau modifiés depuis N jours — TOUS groupes confondus. */
async function modifiesDepuis(bid, cols, jours) {
    const Q = `query ($ids:[ID!], $limit:Int!, $cols:[String!]) { boards (ids:$ids) {
        items_page (limit:$limit, query_params: {rules: [{column_id: "__last_updated__",
            compare_value: ["DAYS", ${Math.max(1, jours)}], operator: within_the_last}]})
        { cursor items { ${ELEMENT} } } } }`;
    const p = (await gql(Q, { ids: [bid], limit: PAGE, cols })).boards[0].items_page;
    const items = [...p.items];
    let cur = p.cursor, tours = 0;
    while (cur && tours < 200) {
        tours++;
        const q = (await gql(Q_SUITE, { cursor: cur, limit: PAGE, cols })).next_items_page;
        if (!q) break;
        items.push(...q.items);
        cur = q.cursor;
    }
    if (cur) throw new Error('relev\u00e9 des modifi\u00e9es inachev\u00e9 sur ' + bid);
    return items;
}

/** Tous les noms d'un tableau, avec leur groupe. Deux colonnes : c'est rapide. */
async function nomsDuTableau(bid) {
    const Q1 = "query ($ids:[ID!], $l:Int!) { boards (ids:$ids) { items_page (limit:$l) { cursor items { name group { title } } } } }";
    const Q2 = "query ($c:String!, $l:Int!) { next_items_page (cursor:$c, limit:$l) { cursor items { name group { title } } } }";
    const p = (await gql(Q1, { ids: [bid], l: 500 })).boards[0].items_page;
    const items = [...p.items];
    let cur = p.cursor, tours = 0;
    while (cur && tours < 200) {
        tours++;
        const q = (await gql(Q2, { c: cur, l: 500 })).next_items_page;
        if (!q) break;
        items.push(...q.items);
        cur = q.cursor;
    }
    if (cur) throw new Error('relev\u00e9 des noms inachev\u00e9 sur ' + bid);
    return items.map(it => [it.name || '', (it.group && it.group.title) || '']);
}

/**
 * LA RÉCONCILIATION PAR LES NUMÉROS, ET NON PAR LES TOTAUX.
 *
 * Le contrôle précédent comparait le nombre de lignes annoncé par Monday à
 * celui du dernier relèvement. Il laissait passer le cas le plus courant :
 * ADV et Recouvrement ont perdu sept factures parties en payées et en ont
 * gagné autant le même jour. Leur total n'a pas bougé, le contrôle n'a rien
 * vu, et les sept parties seraient restées dans la copie — comptées en
 * recouvrement alors qu'elles sont payées.
 *
 * On relève donc la LISTE des numéros, pas leur nombre. Deux colonnes par
 * ligne, c'est rapide : une minute pour les dix-huit mille, contre un quart
 * d'heure pour l'export entier. La liste dit tout : ce qui a disparu, ce qui
 * est arrivé, ce qui a changé de groupe.
 *
 * Et ce qu'elle ne sait pas reconstituer — une facture présente dans Monday,
 * absente de la copie, et trop ancienne pour figurer parmi les modifiées —
 * déclenche une relecture complète de ce tableau. Mieux vaut un quart d'heure
 * qu'une ligne manquante.
 */
async function incrementerTableau(bid, app, etatPrec, jours) {
    const { R, I } = app;
    const meta = (await gql(Q_META, { ids: [bid] })).boards[0];
    if (!meta) throw new Error('tableau ' + bid + ' introuvable');

    const nom = nomDeFichier(meta.name);
    const chemin = path.join(SORTIE, nom);
    const base = lireCsvMonday(chemin);
    if (!base) return { nom, meta, raison: 'pas de copie pr\u00e9c\u00e9dente', complet: true };

    const colonnes = meta.columns.map(c => ({ id: c.id, title: c.title, type: c.type }));
    const mapping = I.autoMapColumns(colonnes, null) || {};
    const gardees = [...new Set(Object.values(mapping))].filter(c => c && c !== 'name');
    const titreDe = new Map(colonnes.map(c => [c.id, c.title]));
    // Le fichier remplace les retours \u00e0 la ligne par des espaces en \u00e9crivant\u00a0:
    // le titre Monday \u00ab\u00a0Montant d\u00fb \u23ce TTC\u00a0\u00bb y devient \u00ab\u00a0Montant d\u00fb  TTC\u00a0\u00bb.
    // Compar\u00e9 au titre brut, il ne co\u00efncidait jamais, et \u00ab\u00a00.1. Factures
    // pay\u00e9es\u00a0\u00bb comme \u00ab\u00a01.0. Tampon\u00a0\u00bb se relisaient en entier \u00e0 chaque heure
    // \u2014 sept mille deux cent soixante et une lignes pour rien. On compare
    // donc les deux c\u00f4t\u00e9s pass\u00e9s par la m\u00eame moulinette.
    const sansRetour = s => String(s == null ? '' : s).replace(/\r?\n/g, ' ').trim();
    const enteteAttendue = ['Name', ...gardees.map(c => titreDe.get(c) || c)].map(sansRetour);
    const enteteCopie = base.entete.map(sansRetour);

    if (enteteAttendue.join('\u0001') !== enteteCopie.join('\u0001')) {
        // Dire LAQUELLE. Un refus muet envoie corriger \u00e0 l'aveugle\u00a0: deux
        // tableaux se sont relus en entier chaque heure sans que personne
        // sache quelle colonne avait boug\u00e9.
        let ecart = '';
        const n = Math.max(enteteAttendue.length, enteteCopie.length);
        for (let i = 0; i < n; i++) {
            if (enteteAttendue[i] === enteteCopie[i]) continue;
            const avant = enteteCopie[i] === undefined ? '\u2014' : enteteCopie[i];
            const apres = enteteAttendue[i] === undefined ? '\u2014' : enteteAttendue[i];
            ecart = ' (colonne ' + (i + 1) + ' sur ' + n + '\u00a0: \u00ab\u00a0' + avant + '\u00a0\u00bb devient \u00ab\u00a0' + apres + '\u00a0\u00bb)';
            break;
        }
        return { nom, meta, raison: 'les colonnes ont chang\u00e9' + ecart, complet: true };
    }

    // 1. Ce que Monday contient vraiment, hors groupes techniques.
    //
    //    UN NUM\u00c9RO PEUT FIGURER DEUX FOIS. Deux factures distinctes portent
    //    parfois le m\u00eame nom d'\u00e9l\u00e9ment, et ce n'est pas parce que c'est le
    //    m\u00eame num\u00e9ro que c'est la m\u00eame facture. Une table index\u00e9e par le
    //    num\u00e9ro seul en garde une et perd l'autre, sans rien dire : le 2.4
    //    est pass\u00e9 ainsi de 358 lignes \u00e0 353, et le contr\u00f4le final, qui
    //    comptait la m\u00eame table, n'y voyait rien. On garde donc pour chaque
    //    num\u00e9ro la LISTE de ses groupes, et l'on compte les lignes, pas les
    //    num\u00e9ros.
    const tousLesNoms = await nomsDuTableau(bid);
    const estTech = t => R.estGroupeTechnique(t);
    const retenus = [];
    for (const [n, g] of tousLesNoms) {
        const c = String(n || '').trim();
        if (!c || estTech(g)) continue;
        retenus.push([c, g]);
    }
    const chezMonday = new Map();
    for (const [n, g] of retenus) {
        if (!chezMonday.has(n)) chezMonday.set(n, []);
        chezMonday.get(n).push(g);
    }

    // 2. Ce que la copie contient, compt\u00e9 de la m\u00eame fa\u00e7on.
    const chezNous = new Map();
    for (const [g, l] of base.parGroupe) for (const ligne of l) {
        const c = String(ligne[0] || '').trim();
        if (!c) continue;
        if (!chezNous.has(c)) chezNous.set(c, []);
        chezNous.get(c).push(g);
    }

    // 3. Ce qui a chang\u00e9 de valeur sans forc\u00e9ment changer de place. Les
    //    groupes techniques sont \u00e9cart\u00e9s ici aussi : une facture partie s'y
    //    ranger doit sortir de la copie, pas y revenir.
    const items = await modifiesDepuis(bid, gardees, jours);
    const parNom = new Map();
    for (const it of items) {
        const c = String(it.name || '').trim();
        const g = (it.group && it.group.title) || '(sans groupe)';
        if (!c || estTech(g)) continue;
        if (!parNom.has(c)) parNom.set(c, []);
        parNom.get(c).push(it);
    }

    // 4. Les num\u00e9ros \u00e0 refaire : disparus, arriv\u00e9s, d\u00e9plac\u00e9s, ou modifi\u00e9s.
    const memeRangement = (a, b) => {
        if (a.length !== b.length) return false;
        const x = [...a].sort(), y = [...b].sort();
        return x.every((v, i) => v === y[i]);
    };
    const aRefaire = [];
    for (const n of new Set([...chezMonday.keys(), ...chezNous.keys()])) {
        if (memeRangement(chezMonday.get(n) || [], chezNous.get(n) || []) && !parNom.has(n)) continue;
        aRefaire.push(n);
    }

    // Un num\u00e9ro \u00e0 reposer dont on n'a pas TOUTES les occurrences : on ne
    // l'invente pas, et l'on ne choisit pas laquelle garder.
    const incomplets = aRefaire.filter(n =>
        (parNom.get(n) || []).length < (chezMonday.get(n) || []).length);
    if (incomplets.length) {
        return { nom, meta, complet: true,
                 raison: incomplets.length + ' facture(s) pr\u00e9sente(s) chez Monday et absente(s) du relev\u00e9 des modifi\u00e9es, dont ' + incomplets[0] };
    }

    const refaire = new Set(aRefaire);
    for (const [g, l] of base.parGroupe) {
        base.parGroupe.set(g, l.filter(x => !refaire.has(String(x[0] || '').trim())));
    }
    let posees = 0;
    for (const n of aRefaire) {
        for (const it of (parNom.get(n) || [])) {
            const g = (it.group && it.group.title) || '(sans groupe)';
            const par = new Map((it.column_values || []).map(cv => [cv.id, valeur(cv)]));
            if (!base.parGroupe.has(g)) base.parGroupe.set(g, []);
            base.parGroupe.get(g).push([it.name || n, ...gardees.map(c => par.get(c) || '')]);
            posees++;
        }
    }
    let retirees = 0;
    for (const n of aRefaire) {
        const ici = (chezNous.get(n) || []).length, la = (chezMonday.get(n) || []).length;
        if (ici > la) retirees += ici - la;
    }

    const ecrit = ecrireCsvBrut(chemin, base.tableau, base.entete, base.parGroupe);

    // Dernier contr\u00f4le, gratuit\u00a0: la copie doit maintenant compter exactement
    // autant de LIGNES que Monday en porte hors groupes techniques, doublons
    // compris. Compar\u00e9 \u00e0 un nombre de num\u00e9ros distincts, ce contr\u00f4le se
    // mentait \u00e0 lui-m\u00eame.
    if (ecrit.lignes !== retenus.length) {
        return { nom, meta, complet: true,
                 raison: 'apr\u00e8s mise \u00e0 jour, ' + ecrit.lignes + ' lignes pour ' + retenus.length + ' attendues' };
    }

    return { nom, meta, complet: false, modifiees: items.length,
             retirees, posees,
             retenues: ecrit.lignes, solitaires: ecrit.solitaires };
}

// ──────────────────────────────────────────────
//  Marche
// ──────────────────────────────────────────────
const ARGS = process.argv.slice(2);
const VEUT_INCREMENT = ARGS.includes('--incrementiel');
const FORCE_COMPLET = ARGS.includes('--complet');

/**
 * LA DATE ET L'HEURE DE PARIS, ET NON CELLES DU SERVEUR.
 *
 * Le conteneur vit \u00e0 l'heure UTC. Un rel\u00e8vement fait \u00e0 14\u202fh\u202f27 \u00e0 Paris
 * s'inscrivait \u00ab\u00a013h27\u00a0\u00bb, et l'arr\u00eat\u00e9 affich\u00e9 sur la page retardait d'une
 * heure l'hiver, de deux l'\u00e9t\u00e9. Une balance dat\u00e9e d'une heure qui n'est pas
 * la sienne n'est pas auditable. Et pass\u00e9 minuit \u00e0 Paris, c'est la date
 * elle-m\u00eame qui se trompait de jour.
 */
const ICI = 'Europe/Paris';

function aParis(d) {
    const p = new Intl.DateTimeFormat('fr-FR', {
        timeZone: ICI, year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(d);
    const v = {};
    for (const x of p) v[x.type] = x.value;
    return v;
}

function aujourdhui() {
    const v = aParis(new Date());
    return v.year + '-' + v.month + '-' + v.day;
}

/**
 * L'heure de l'arrêté : celle du relevé, et non un horaire écrit d'avance.
 *
 * Elle disait 10h00 en dur, du temps où l'actualisation n'avait lieu qu'une
 * fois par matin. Dès lors qu'elle tourne dans la journée, un arrêté qui
 * annonce dix heures à seize heures est un arrêté qui ment.
 */
function maintenant() {
    const v = aParis(new Date());
    return (v.hour === '24' ? '00' : v.hour) + 'h' + v.minute;
}

function ecrireManifeste(bilan, mode) {
    const manifeste = {
        arreteLe: aujourdhui(),
        arreteA: maintenant(),
        source: 'Monday \u2014 api.monday.com, groupes techniques \u00e9cart\u00e9s'
            + (mode === 'incrementiel' ? ', relev\u00e9 des modifications' : ''),
        fichiers: bilan.map(b => b.fichier).sort(),
        // Ce que le prochain rel\u00e8vement incr\u00e9mental compare pour d\u00e9tecter une
        // suppression : sans ces deux nombres par tableau, une facture effac\u00e9e
        // dans Monday resterait dans la copie sans que rien ne le dise.
        tableaux: bilan.map(b => ({ fichier: b.fichier, totalMonday: b.annonceMonday, retenues: b.retenues })),
    };
    fs.writeFileSync(path.join(SORTIE, 'du-jour.json'),
        JSON.stringify(manifeste, null, 1) + '\n', 'utf8');
}

function lireManifeste() {
    const f = path.join(SORTIE, 'du-jour.json');
    if (!fs.existsSync(f)) return null;
    try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; }
}

/** Relecture compl\u00e8te : les neuf tableaux, d'un bout \u00e0 l'autre. */
async function tourComplet(app, seulement) {
    const liste = seulement && seulement.length ? seulement : TABLEAUX;
    const bilan = [], alertes = [];
    for (const bid of liste) {
        const r = await sortirTableau(bid, app);
        const nom = nomDeFichier(r.meta.name);
        const ecrit = ecrireCsv(path.join(SORTIE, nom), r);
        if (r.manquants.length) {
            alertes.push(r.meta.name + ' : champ(s) essentiel(s) non reconnu(s) \u2014 ' + r.manquants.join(', '));
        }
        if (ecrit.solitaires) {
            alertes.push(r.meta.name + ' : ' + ecrit.solitaires + ' ligne(s) \u00e0 une seule cellule remplie');
        }
        if (r.lignes.length === 0) {
            alertes.push(r.meta.name + ' : revenu VIDE \u2014 neuf tableaux de cr\u00e9ances ne se vident pas dans la nuit');
        }
        bilan.push({ tableau: r.meta.name, fichier: nom, annonceMonday: r.meta.items_count,
                     retenues: r.lignes.length, groupesEcartes: r.tech.map(g => g.title) });
        console.log('  complet  ' + String(r.lignes.length).padStart(6) + ' / ' + String(r.meta.items_count).padEnd(6)
            + ' ' + r.meta.name + (r.tech.length ? '   (\u2212' + r.tech.length + ' groupe(s) technique(s))' : ''));
    }
    return { bilan, alertes };
}

async function main() {
    if (!JETON) {
        console.error('MONDAY_TOKEN est vide. Rien n\u2019a \u00e9t\u00e9 lu, rien n\u2019a \u00e9t\u00e9 \u00e9crit.');
        console.error('Le jeton se r\u00e8gle dans les variables de l\u2019environnement cloud.');
        process.exit(2);
    }

    const app = chargerApplication();
    fs.mkdirSync(SORTIE, { recursive: true });

    const prec = lireManifeste();
    // Le jour de la relecture compl\u00e8te : lundi par d\u00e9faut, r\u00e9glable par
    // ACTUALISATION_JOUR_COMPLET (0 dimanche \u2026 6 samedi), et -1 pour n'en avoir
    // aucun \u2014 ce que l'on ne fait qu'en essai.
    const JOUR_COMPLET = process.env.ACTUALISATION_JOUR_COMPLET == null
        ? 1 : Number(process.env.ACTUALISATION_JOUR_COMPLET);
    // UNE SEULE FOIS DANS LA JOURNÉE, pas à chaque heure.
    //
    // Tant que l'actualisation n'avait lieu qu'une fois par matin, « on est
    // lundi » suffisait. Dès qu'elle tourne toutes les heures, cela
    // relancerait un quart d'heure de relecture complète à chaque passage du
    // lundi. Elle n'a donc lieu que si le dernier arrêté n'est pas déjà
    // d'aujourd'hui.
    const jourDeRelecture = JOUR_COMPLET >= 0
        && new Date().getDay() === JOUR_COMPLET
        && !(prec && prec.arreteLe === aujourdhui());

    // Le lundi, relecture compl\u00e8te quoi qu'il arrive : le filet contre une
    // colonne renomm\u00e9e, un groupe cr\u00e9\u00e9, une d\u00e9rive que rien d'autre n'attrape.
    let mode = 'complet';
    if (VEUT_INCREMENT && !FORCE_COMPLET) {
        if (!prec || !prec.arreteLe) {
            console.log('Aucun relev\u00e9 pr\u00e9c\u00e9dent exploitable \u2192 relecture compl\u00e8te.');
        } else if (jourDeRelecture) {
            console.log('Jour de relecture compl\u00e8te \u2192 on relit tout, comme convenu.');
        } else {
            mode = 'incrementiel';
        }
    }
    console.log('Mode : ' + mode + (prec && prec.arreteLe ? '   (dernier arr\u00eat\u00e9 : ' + prec.arreteLe + ')' : ''));

    let bilan = [], alertes = [];

    if (mode === 'complet') {
        ({ bilan, alertes } = await tourComplet(app));
    } else {
        // Depuis quand ? Le dernier arr\u00eat\u00e9, plus un jour de marge : mieux vaut
        // relire deux fois une ligne que la manquer une fois.
        let jours = 2;
        if (prec.arreteLe) {
            const d = new Date(prec.arreteLe + 'T00:00:00Z');
            if (!isNaN(d.getTime())) {
                jours = Math.max(1, Math.ceil((Date.now() - d.getTime()) / 86400000)) + 1;
            }
        }
        console.log('Relev\u00e9 des lignes modifi\u00e9es depuis ' + jours + ' jour(s).');

        const aRelire = [];
        for (const bid of TABLEAUX) {
            const r = await incrementerTableau(bid, app, null, jours);
            if (r.complet) {
                console.log('  \u2192 relecture compl\u00e8te de ' + r.meta.name + ' : ' + r.raison);
                aRelire.push(bid);
                continue;
            }
            if (r.solitaires) {
                alertes.push(r.meta.name + ' : ' + r.solitaires + ' ligne(s) \u00e0 une seule cellule remplie');
            }
            if (r.retenues === 0) {
                alertes.push(r.meta.name + ' : revenu VIDE apr\u00e8s mise \u00e0 jour');
            }
            bilan.push({ tableau: r.meta.name, fichier: r.nom, annonceMonday: r.meta.items_count,
                         retenues: r.retenues, groupesEcartes: [] });
            console.log('  r\u00e9concili\u00e9 ' + String(r.retenues).padStart(6) + ' lignes  \u00b7 '
                + String(r.posees).padStart(3) + ' pos\u00e9e(s), ' + String(r.retirees).padStart(3)
                + ' retir\u00e9e(s), sur ' + r.modifiees + ' modifi\u00e9e(s) lue(s)   ' + r.meta.name);
        }

        if (aRelire.length) {
            console.log('\n' + aRelire.length + ' tableau(x) \u00e0 relire en entier.');
            const sup = await tourComplet(app, aRelire);
            bilan = bilan.concat(sup.bilan);
            alertes = alertes.concat(sup.alertes);
        }
    }

    if (bilan.length !== TABLEAUX.length) {
        alertes.push('seulement ' + bilan.length + ' tableau(x) sur ' + TABLEAUX.length + ' ont abouti');
    }

    if (alertes.length) {
        console.error('\nACTUALISATION REFUS\u00c9E \u2014 ne republiez pas :');
        for (const a of alertes) console.error('  \u00b7 ' + a);
        process.exit(1);
    }

    ecrireManifeste(bilan, mode);
    const total = bilan.reduce((s, b) => s + b.retenues, 0);
    console.log('\n' + total + ' lignes \u00b7 ' + bilan.length + ' tableaux \u00b7 arr\u00eat\u00e9 au ' + aujourdhui()
        + ' \u00b7 mode ' + mode);
    console.log('D\u00e9pos\u00e9 dans ' + SORTIE);
}

main().catch(e => {
    console.error('\nACTUALISATION INTERROMPUE : ' + e.message);
    console.error('Rien n\u2019a \u00e9t\u00e9 republi\u00e9. La page garde les chiffres de la veille.');
    process.exit(1);
});
