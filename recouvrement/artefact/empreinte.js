#!/usr/bin/env node
/**
 * L'EMPREINTE DE CE QUI SERA PUBLIÉ — POUR NE PUBLIER QUE CE QUI A CHANGÉ.
 *
 * Le relevé tourne toutes les heures ; le portefeuille, lui, ne bouge pas
 * toutes les heures. Publier quand même crée une version de plus dans
 * l'historique de l'artefact, qui ne dit rien de nouveau.
 *
 * ELLE COUVRE LE PAQUET ENTIER, ET NON LES SEULES DONNÉES. La première
 * version ne comparait que les neuf fichiers Monday : une correction de règle
 * ou d'affichage ne déclenchait donc aucune publication, et il fallait y
 * penser à la main. Trois corrections ont dû être publiées ainsi le 27/10.
 * On résume maintenant tout ce qui part : la page, le code, les feuilles, les
 * données. Ce qui change part ; ce qui ne change pas ne part pas.
 *
 * UNE SEULE CHOSE EST ÉCARTÉE DU CALCUL : l'heure du relevé, dans le
 * manifeste. Elle change à chaque passage par construction, et la retenir
 * ferait repartir une publication toutes les heures — exactement ce qu'on
 * cherche à éviter. La DATE d'arrêté, elle, compte : elle s'affiche sur la
 * page, et un jour nouveau mérite d'être publié.
 *
 *   node empreinte.js            écrit l'empreinte courante
 *   node empreinte.js --pose     l'inscrit dans .empreinte (après publication)
 *   node empreinte.js --verifie  compare : code 0 si quelque chose a changé,
 *                                code 9 si rien n'a bougé (rien à faire)
 *
 * À LANCER APRÈS construire.js : c'est le paquet construit qu'elle résume.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PAQUET = path.join(__dirname, 'paquet');
const LISTE = path.join(PAQUET, 'A-PUBLIER.txt');
// LA MARQUE VIT HORS DU PAQUET.
//
// Elle était posée dans paquet/.empreinte — que construire.js efface d'un
// rmSync au début de chaque construction. Comme la tâche du matin construit
// AVANT de comparer, la marque n'existait jamais au moment de la lecture :
// --verifie répondait « première publication » à chaque passage, et la
// comparaison, écrite pour ne republier que ce qui change, ne comparait rien.
// À côté des scripts, elle survit à la construction.
const MARQUE = path.join(__dirname, '.empreinte');

/** Les fichiers publiés, tels que la construction vient de les énumérer. */
function aPublier() {
    if (!fs.existsSync(LISTE)) return null;
    const lignes = fs.readFileSync(LISTE, 'utf8').split('\n');
    const noms = [];
    for (const l of lignes) {
        const t = l.trim();
        // La liste est indentée sous « Les N fichiers à publier avec elle : ».
        if (!t || !/^\s{2,}\S/.test(l)) continue;
        if (/^(Capacités|Ne JAMAIS publier)/.test(t)) continue;
        if (t.endsWith(',') || t.startsWith('A-PUBLIER') || t.startsWith('essai.html')) continue;
        noms.push(t);
    }
    return noms.length ? noms : null;
}

function empreinte() {
    const noms = aPublier();
    if (!noms) return null;
    const h = crypto.createHash('sha256');
    for (const nom of ['index.html', ...noms].sort()) {
        const p = path.join(PAQUET, nom);
        if (!fs.existsSync(p)) return null;     // paquet incomplet : on ne tranche pas
        h.update(nom, 'utf8');
        if (nom === 'donnees/du-jour.json') {
            // L'heure du relevé change à chaque passage : elle ne dit rien du
            // contenu. Tout le reste du manifeste compte.
            try {
                const m = JSON.parse(fs.readFileSync(p, 'utf8'));
                delete m.arreteA;
                h.update(JSON.stringify(m), 'utf8');
                continue;
            } catch { /* illisible : on le prend tel quel */ }
        }
        h.update(fs.readFileSync(p));
    }
    return h.digest('hex');
}

const e = empreinte();
const args = process.argv.slice(2);

if (!e) {
    // Sans paquet lisible, on ne décide rien : la chaîne suit son cours et ses
    // propres garde-fous tranchent.
    console.error('empreinte : paquet absent ou incomplet — lancez construire.js d’abord');
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
        ? 'le paquet a changé · ' + avant.slice(0, 12) + ' → ' + e.slice(0, 12)
        : 'aucune empreinte précédente · première publication');
    process.exit(0);
}

console.log(e);
