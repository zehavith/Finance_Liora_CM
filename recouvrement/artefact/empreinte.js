#!/usr/bin/env node
/**
 * L'EMPREINTE DES DONNÉES DU JOUR — POUR NE PUBLIER QUE CE QUI A CHANGÉ.
 *
 * Le relevé tourne toutes les heures ; le portefeuille, lui, ne bouge pas
 * toutes les heures. Publier quand même crée une version de plus dans
 * l'historique de l'artefact, qui ne dit rien de nouveau. Quatorze par jour,
 * dont la plupart identiques à la précédente.
 *
 * On résume donc les neuf fichiers en une empreinte. Si elle n'a pas changé
 * depuis la dernière publication, il n'y a rien à reconstruire, rien à
 * éprouver et rien à publier : la page en ligne est déjà juste.
 *
 * Le manifeste est exclu du calcul À DESSEIN : il porte l'heure du relevé,
 * qui change à chaque passage. Ce qu'on compare, c'est le portefeuille, pas
 * l'heure à laquelle on l'a regardé.
 *
 *   node empreinte.js          écrit l'empreinte courante sur la sortie
 *   node empreinte.js --pose   l'inscrit dans .empreinte (après publication)
 *   node empreinte.js --verifie  compare, et sort en 0 si elle a changé,
 *                                en 9 si elle est identique (rien à faire)
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DOSSIER = path.join(__dirname, 'donnees-du-jour');
const MARQUE = path.join(DOSSIER, '.empreinte');

function empreinte() {
    const manifeste = path.join(DOSSIER, 'du-jour.json');
    if (!fs.existsSync(manifeste)) return null;
    const m = JSON.parse(fs.readFileSync(manifeste, 'utf8'));
    const fichiers = (Array.isArray(m.fichiers) ? m.fichiers : []).slice().sort();
    if (!fichiers.length) return null;
    const h = crypto.createHash('sha256');
    for (const f of fichiers) {
        const p = path.join(DOSSIER, f);
        if (!fs.existsSync(p)) return null;          // manifeste incomplet : on ne tranche pas
        h.update(f, 'utf8');
        h.update(fs.readFileSync(p));
    }
    return h.digest('hex');
}

const e = empreinte();
const args = process.argv.slice(2);

if (!e) {
    // Sans données lisibles, on ne décide rien : la chaîne suit son cours
    // normal et ses propres garde-fous tranchent.
    console.error('empreinte : données du jour illisibles ou incomplètes');
    process.exit(0);
}

if (args.includes('--pose')) {
    fs.writeFileSync(MARQUE, e + '\n', 'utf8');
    console.log('empreinte posée · ' + e.slice(0, 12));
    process.exit(0);
}

if (args.includes('--verifie')) {
    const avant = fs.existsSync(MARQUE) ? fs.readFileSync(MARQUE, 'utf8').trim() : null;
    if (avant === e) {
        console.log('rien n’a changé depuis la dernière publication · ' + e.slice(0, 12));
        process.exit(9);
    }
    console.log(avant
        ? 'le portefeuille a changé · ' + avant.slice(0, 12) + ' → ' + e.slice(0, 12)
        : 'aucune empreinte précédente · première publication');
    process.exit(0);
}

console.log(e);
