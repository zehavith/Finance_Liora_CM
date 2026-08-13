/* ============================
   Tests du moteur de scoring — exécution : node scoring/test/test-scoring.js

   Le moteur (scoring.js) et la normalisation (api.js) sont des modules purs :
   ils se testent hors navigateur, sans DOM ni réseau.
   ============================ */

'use strict';

const S = require('../scoring.js');
const A = require('../api.js');

let reussis = 0, echecs = 0;
const AUJOURDHUI = '2026-06-15T00:00:00.000Z';

function test(nom, fn) {
    try {
        fn();
        reussis++;
        console.log('  \x1b[32m✓\x1b[0m ' + nom);
    } catch (e) {
        echecs++;
        console.log('  \x1b[31m✗\x1b[0m ' + nom + '\n      ' + e.message);
    }
}

function assert(condition, message) {
    if (!condition) throw new Error(message || 'assertion échouée');
}

function assertEgal(actuel, attendu, message) {
    if (actuel !== attendu) {
        throw new Error((message || 'valeur inattendue') + ` — attendu ${attendu}, obtenu ${actuel}`);
    }
}

function assertEntre(valeur, min, max, message) {
    if (!(valeur >= min && valeur <= max)) {
        throw new Error((message || 'hors bornes') + ` — ${valeur} n'est pas dans [${min}, ${max}]`);
    }
}

/* ── Fiches de test ── */

function fiche(surcharge) {
    return Object.assign({
        siren: '552032534',
        nom: 'ENTREPRISE TEST',
        dateCreation: '2005-03-01',
        etatAdministratif: 'A',
        natureJuridique: '5710',
        activitePrincipale: '62.01Z',
        sectionNaf: 'J',
        trancheEffectif: '22',
        categorieEntreprise: 'PME',
        statutDiffusion: 'O',
        etablissementsTotal: 3,
        etablissementsOuverts: 3,
        siege: { commune: 'PARIS', codePostal: '75009' },
        dirigeants: [{ nom: 'Jean Dupont', qualite: 'Président' }],
        exercices: [
            { annee: 2023, ca: 4000000, resultatNet: 260000 },
            { annee: 2024, ca: 4600000, resultatNet: 340000 },
            { annee: 2025, ca: 5100000, resultatNet: 410000 }
        ],
        conventionCollective: true,
        labels: {},
        procedures: [],
        proceduresStatut: 'ok'
    }, surcharge || {});
}

const opts = { now: AUJOURDHUI };

/* ══════════════════════════════════════════════════════════ */

console.log('\n\x1b[1mMoteur de score — cas nominaux\x1b[0m');

test('une PME rentable, ancienne et transparente obtient un grade A ou B', () => {
    const r = S.scorer(fiche(), opts);
    assertEntre(r.score, 65, 100, 'score');
    assert(['A', 'B'].includes(r.grade), 'grade attendu A ou B, obtenu ' + r.grade);
    assert(r.drapeaux.length === 0, 'aucun drapeau attendu, obtenu : ' + r.drapeaux.map(d => d.titre).join(', '));
    assert(r.forces.length > 0, 'des points forts sont attendus');
});

test('le score reste dans [0, 100] et la confiance dans [0, 100]', () => {
    const r = S.scorer(fiche(), opts);
    assertEntre(r.score, 0, 100, 'score');
    assertEntre(r.confiance, 0, 100, 'confiance');
});

test('les six piliers sont renvoyés avec leur poids', () => {
    const r = S.scorer(fiche(), opts);
    assertEgal(r.piliers.length, 6, 'nombre de piliers');
    const cles = r.piliers.map(p => p.cle).sort().join(',');
    assertEgal(cles, 'finances,juridique,perennite,secteur,taille,transparence', 'clés des piliers');
    r.piliers.forEach(p => assertEntre(p.note, 0, 100, 'note du pilier ' + p.cle));
});

console.log('\n\x1b[1mRègles éliminatoires\x1b[0m');

test('une entreprise cessée est plafonnée à 5 et classée E', () => {
    const r = S.scorer(fiche({ etatAdministratif: 'C' }), opts);
    assert(r.score <= 5, 'score attendu ≤ 5, obtenu ' + r.score);
    assertEgal(r.grade, 'E', 'grade');
    assert(r.plafonne, 'le score doit être marqué comme plafonné');
    assert(r.drapeaux.some(d => d.titre === 'Entreprise cessée'), 'drapeau « Entreprise cessée » attendu');
});

test('une liquidation judiciaire plafonne le score à 5', () => {
    const r = S.scorer(fiche({
        procedures: [{ date: '2026-02-10', libelle: 'Jugement d’ouverture d’une procédure de liquidation judiciaire' }]
    }), opts);
    assert(r.score <= 5, 'score attendu ≤ 5, obtenu ' + r.score);
    assertEgal(r.procedure.type, 'liquidation', 'type de procédure');
});

test('un redressement judiciaire plafonne le score à 20', () => {
    const r = S.scorer(fiche({
        procedures: [{ date: '2026-01-05', libelle: 'Jugement d’ouverture d’une procédure de redressement judiciaire' }]
    }), opts);
    assert(r.score <= 20, 'score attendu ≤ 20, obtenu ' + r.score);
    assertEgal(r.procedure.type, 'redressement', 'type de procédure');
});

test('un plan de redressement arrêté est moins pénalisant qu’une ouverture', () => {
    const ouverture = S.scorer(fiche({
        procedures: [{ date: '2026-01-05', libelle: 'Jugement d’ouverture d’une procédure de redressement judiciaire' }]
    }), opts);
    const plan = S.scorer(fiche({
        procedures: [{ date: '2026-01-05', libelle: 'Jugement arrêtant le plan de redressement' }]
    }), opts);
    assert(plan.score > ouverture.score, `plan (${plan.score}) doit dépasser ouverture (${ouverture.score})`);
});

test('une sortie de procédure de plus de trois ans ne plafonne plus', () => {
    const r = S.scorer(fiche({
        procedures: [{ date: '2020-01-05', libelle: 'Jugement de clôture de la procédure' }]
    }), opts);
    assertEgal(r.procedure, null, 'aucune procédure bloquante attendue');
    assert(!r.plafonne, 'le score ne doit pas être plafonné');
});

test('seule la procédure la plus récente est retenue', () => {
    const r = S.scorer(fiche({
        procedures: [
            { date: '2024-01-05', libelle: 'Jugement d’ouverture d’une procédure de redressement judiciaire' },
            { date: '2025-11-20', libelle: 'Jugement arrêtant le plan de redressement' }
        ]
    }), opts);
    assertEgal(r.procedure.type, 'plan-redressement', 'la dernière annonce doit primer');
});

console.log('\n\x1b[1mSanté financière\x1b[0m');

test('des pertes récurrentes dégradent fortement le score', () => {
    const sain = S.scorer(fiche(), opts);
    const deficitaire = S.scorer(fiche({
        exercices: [
            { annee: 2023, ca: 4000000, resultatNet: -150000 },
            { annee: 2024, ca: 3600000, resultatNet: -320000 },
            { annee: 2025, ca: 3100000, resultatNet: -480000 }
        ]
    }), opts);
    assert(deficitaire.score < sain.score - 15,
        `écart insuffisant : sain ${sain.score}, déficitaire ${deficitaire.score}`);
    assert(deficitaire.drapeaux.some(d => /déficitaire/i.test(d.titre)), 'drapeau de déficit attendu');
    assert(deficitaire.drapeaux.some(d => /baisse/i.test(d.titre)), 'drapeau de baisse du CA attendu');
});

test('une érosion continue du CA est détectée même sans chute annuelle de 20 %', () => {
    // -10 % par an sur trois ans : aucune transition ne franchit -20 %,
    // mais l'activité a reculé de plus d'un quart sur la période.
    const r = S.scorer(fiche({
        exercices: [
            { annee: 2023, ca: 5000000, resultatNet: 90000 },
            { annee: 2024, ca: 4500000, resultatNet: 70000 },
            { annee: 2025, ca: 3650000, resultatNet: 40000 }
        ]
    }), opts);
    assert(r.drapeaux.some(d => d.titre === 'Chiffre d’affaires en baisse continue'),
        'drapeau de baisse continue attendu, obtenu : ' + r.drapeaux.map(d => d.titre).join(', '));
});

test('une seule chute annuelle marquée ne déclenche pas le doublon « baisse continue »', () => {
    const r = S.scorer(fiche({
        exercices: [
            { annee: 2023, ca: 4000000, resultatNet: 200000 },
            { annee: 2024, ca: 4200000, resultatNet: 210000 },
            { annee: 2025, ca: 3100000, resultatNet: 60000 }
        ]
    }), opts);
    const baisses = r.drapeaux.filter(d => /baisse/i.test(d.titre));
    assertEgal(baisses.length, 1, 'un seul drapeau de baisse attendu');
    assertEgal(baisses[0].titre, 'Chiffre d’affaires en forte baisse', 'libellé du drapeau');
});

test('l’absence de comptes publiés baisse la confiance et lève un drapeau', () => {
    const avec = S.scorer(fiche(), opts);
    const sans = S.scorer(fiche({ exercices: [] }), opts);
    assert(sans.confiance < avec.confiance, 'la confiance doit baisser sans comptes');
    assert(sans.drapeaux.some(d => d.titre === 'Comptes non publiés'), 'drapeau « Comptes non publiés » attendu');
    assertEgal(sans.encours, null, 'aucun encours calculable sans chiffre d’affaires');
});

test('des comptes anciens lèvent un drapeau d’obsolescence', () => {
    const r = S.scorer(fiche({
        exercices: [{ annee: 2021, ca: 4000000, resultatNet: 250000 }]
    }), opts);
    assert(r.drapeaux.some(d => d.titre === 'Comptes obsolètes'), 'drapeau « Comptes obsolètes » attendu');
});

test('la croissance du chiffre d’affaires améliore le score', () => {
    const stable = S.scorer(fiche({
        exercices: [
            { annee: 2024, ca: 5000000, resultatNet: 300000 },
            { annee: 2025, ca: 5000000, resultatNet: 300000 }
        ]
    }), opts);
    const croissance = S.scorer(fiche({
        exercices: [
            { annee: 2024, ca: 5000000, resultatNet: 300000 },
            { annee: 2025, ca: 6500000, resultatNet: 300000 }
        ]
    }), opts);
    assert(croissance.score > stable.score, `croissance ${croissance.score} devrait dépasser stable ${stable.score}`);
});

console.log('\n\x1b[1mPérennité, forme juridique, secteur\x1b[0m');

test('une entreprise créée il y a moins de deux ans lève un drapeau', () => {
    const r = S.scorer(fiche({ dateCreation: '2025-09-01' }), opts);
    assert(r.drapeaux.some(d => d.titre === 'Entreprise récente'), 'drapeau « Entreprise récente » attendu');
});

test('une entreprise ancienne score mieux qu’une entreprise récente, toutes choses égales', () => {
    const jeune = S.scorer(fiche({ dateCreation: '2025-01-01' }), opts);
    const ancienne = S.scorer(fiche({ dateCreation: '1995-01-01' }), opts);
    assert(ancienne.score > jeune.score, `ancienne ${ancienne.score} devrait dépasser jeune ${jeune.score}`);
});

test('une entreprise individuelle est jugée plus risquée qu’une SAS', () => {
    const ei = S.scorer(fiche({ natureJuridique: '1000' }), opts);
    const sas = S.scorer(fiche({ natureJuridique: '5710' }), opts);
    assert(ei.score < sas.score, `EI ${ei.score} devrait être sous SAS ${sas.score}`);
});

test('un secteur sinistré pèse sur le score', () => {
    const resto = S.scorer(fiche({ sectionNaf: 'I', activitePrincipale: '56.10A' }), opts);
    const info = S.scorer(fiche({ sectionNaf: 'J', activitePrincipale: '62.01Z' }), opts);
    assert(resto.score < info.score, `restauration ${resto.score} devrait être sous informatique ${info.score}`);
});

test('la section NAF est déduite du code APE quand elle est absente', () => {
    assertEgal(S.sectionDepuisNaf('43.99C'), 'F', 'construction');
    assertEgal(S.sectionDepuisNaf('56.10A'), 'I', 'restauration');
    assertEgal(S.sectionDepuisNaf('62.01Z'), 'J', 'informatique');
    assertEgal(S.sectionDepuisNaf('01.11Z'), 'A', 'agriculture');
    assertEgal(S.sectionDepuisNaf(''), null, 'code vide');
});

console.log('\n\x1b[1mTransparence\x1b[0m');

test('une entreprise non diffusible est pénalisée', () => {
    const publique = S.scorer(fiche(), opts);
    const masquee = S.scorer(fiche({ statutDiffusion: 'P' }), opts);
    assert(masquee.score < publique.score, 'le masquage doit dégrader le score');
    assert(masquee.drapeaux.some(d => d.titre === 'Entreprise non diffusible'), 'drapeau attendu');
});

test('les labels de confiance sont plafonnés dans leur effet', () => {
    const sans = S.scorer(fiche(), opts);
    const tousLabels = S.scorer(fiche({
        labels: {
            estRge: true, estQualiopi: true, estEss: true, estBio: true,
            estSocieteMission: true, estOrganismeFormation: true
        }
    }), opts);
    assert(tousLabels.score >= sans.score, 'les labels ne doivent pas dégrader le score');
    const pilier = tousLabels.piliers.find(p => p.cle === 'transparence');
    assertEntre(pilier.note, 0, 100, 'note de transparence plafonnée');
});

console.log('\n\x1b[1mPondérations et encours\x1b[0m');

test('des pondérations personnalisées modifient le score', () => {
    const defaut = S.scorer(fiche({ sectionNaf: 'I' }), opts);
    const secteurDominant = S.scorer(fiche({ sectionNaf: 'I' }),
        { now: AUJOURDHUI, weights: { perennite: 0, taille: 0, finances: 0, transparence: 0, juridique: 0, secteur: 100 } });
    assert(secteurDominant.score !== defaut.score, 'le score doit varier avec les pondérations');
    assertEgal(secteurDominant.score, 38, 'avec 100 % sur le secteur, le score vaut la note du secteur I');
});

test('une somme de poids différente de 100 est renormalisée', () => {
    const cent = S.scorer(fiche(), { now: AUJOURDHUI, weights: S.DEFAULT_WEIGHTS });
    const double = S.scorer(fiche(), {
        now: AUJOURDHUI,
        weights: Object.keys(S.DEFAULT_WEIGHTS).reduce((a, c) => (a[c] = S.DEFAULT_WEIGHTS[c] * 2, a), {})
    });
    assertEgal(double.score, cent.score, 'doubler tous les poids ne doit rien changer');
});

test('l’encours indicatif suit le grade', () => {
    const bon = S.scorer(fiche(), opts);
    assert(bon.encours && bon.encours.montant > 0, 'un encours est attendu pour un bon score');
    const mauvais = S.scorer(fiche({ etatAdministratif: 'C' }), opts);
    assertEgal(mauvais.encours.montant, 0, 'aucun encours pour une entreprise cessée');
});

console.log('\n\x1b[1mNormalisation des réponses de l’API\x1b[0m');

test('normalise() lit une réponse complète de l’API Recherche d’Entreprises', () => {
    const brut = {
        siren: '552032534',
        nom_complet: 'DANONE',
        nom_raison_sociale: 'DANONE',
        date_creation: '1900-01-01',
        etat_administratif: 'A',
        nature_juridique: '5710',
        activite_principale: '70.10Z',
        section_activite_principale: 'M',
        tranche_effectif_salarie: '42',
        annee_tranche_effectif_salarie: '2023',
        categorie_entreprise: 'GE',
        statut_diffusion: 'O',
        nombre_etablissements: 12,
        nombre_etablissements_ouverts: 9,
        siege: {
            siret: '55203253400646',
            adresse: '17 BOULEVARD HAUSSMANN',
            code_postal: '75009',
            libelle_commune: 'PARIS 9',
            etat_administratif: 'A'
        },
        dirigeants: [
            { nom: 'FABER', prenoms: 'Emmanuel', qualite: 'Président', annee_de_naissance: '1964', type_dirigeant: 'personne physique' }
        ],
        finances: {
            '2023': { ca: 27000000000, resultat_net: 900000000 },
            '2024': { ca: 27600000000, resultat_net: 1000000000 }
        },
        complements: {
            convention_collective_renseignee: true,
            est_ess: false,
            est_rge: true
        }
    };
    const f = A.normalise(brut);
    assertEgal(f.siren, '552032534', 'siren');
    assertEgal(f.nom, 'DANONE', 'nom');
    assertEgal(f.siege.commune, 'PARIS 9', 'commune du siège');
    assertEgal(f.exercices.length, 2, 'nombre d’exercices');
    assertEgal(f.exercices[0].annee, 2023, 'les exercices sont triés du plus ancien au plus récent');
    assertEgal(f.exercices[1].ca, 27600000000, 'CA du dernier exercice');
    assertEgal(f.dirigeants[0].nom, 'Emmanuel FABER', 'nom du dirigeant reconstitué');
    assertEgal(f.conventionCollective, true, 'convention collective');
    assertEgal(f.labels.estRge, true, 'label RGE');
    assertEgal(f.trancheEffectif, '42', 'tranche d’effectif');
});

test('normalise() tolère une réponse minimale sans planter', () => {
    const f = A.normalise({ siren: '123456789' });
    assertEgal(f.siren, '123456789', 'siren');
    assertEgal(f.exercices.length, 0, 'aucun exercice');
    assertEgal(f.dirigeants.length, 0, 'aucun dirigeant');
    assertEgal(f.siege.commune, null, 'commune inconnue');
    const r = S.scorer(f, opts);
    assertEntre(r.score, 0, 100, 'le scoring reste possible sur une fiche minimale');
});

test('normalise() reprend le bilan de « complements » à défaut de « finances »', () => {
    const f = A.normalise({
        siren: '123456789',
        complements: { bilan_financier: { annee: 2024, ca: 800000, resultat_net: 42000 } }
    });
    assertEgal(f.exercices.length, 1, 'un exercice reconstitué');
    assertEgal(f.exercices[0].ca, 800000, 'CA du bilan');
});

test('normalise() renvoie null sur une entrée invalide', () => {
    assertEgal(A.normalise(null), null, 'null');
    assertEgal(A.normalise('texte'), null, 'chaîne');
});

test('parseJugement() accepte l’objet comme la chaîne JSON', () => {
    const a = A.parseJugement('{"famille":"Jugement d\'ouverture","nature":"redressement judiciaire"}');
    assertEgal(a.nature, 'redressement judiciaire', 'depuis une chaîne JSON');
    const b = A.parseJugement({ famille: 'Jugement de clôture', nature: 'insuffisance d’actif' });
    assertEgal(b.famille, 'Jugement de clôture', 'depuis un objet');
    const c = A.parseJugement('texte libre non JSON');
    assertEgal(c.nature, 'texte libre non JSON', 'repli sur le texte brut');
});

console.log('\n\x1b[1mValidation des identifiants\x1b[0m');

test('sirenValide() applique la clé de Luhn', () => {
    assertEgal(A.sirenValide('552032534'), true, 'SIREN valide');
    assertEgal(A.sirenValide('552 032 534'), true, 'SIREN valide avec espaces');
    assertEgal(A.sirenValide('552032535'), false, 'clé de contrôle fausse');
    assertEgal(A.sirenValide('12345'), false, 'longueur incorrecte');
    assertEgal(A.sirenValide(''), false, 'chaîne vide');
});

test('extraireSiren() accepte SIREN, SIRET et texte formaté', () => {
    assertEgal(A.extraireSiren('552032534'), '552032534', 'SIREN brut');
    assertEgal(A.extraireSiren('55203253400646'), '552032534', 'SIRET → SIREN');
    assertEgal(A.extraireSiren('552 032 534'), '552032534', 'SIREN avec espaces');
    assertEgal(A.extraireSiren('SIREN: 552-032-534'), '552032534', 'SIREN dans du texte');
    assertEgal(A.extraireSiren('abc'), null, 'texte sans chiffres');
    assertEgal(A.extraireSiren('1234567'), null, 'longueur invalide');
});

/* ══════════════════════════════════════════════════════════ */

console.log(`\n\x1b[1mRésultat :\x1b[0m ${reussis} test(s) réussi(s), ${echecs} en échec\n`);
process.exit(echecs === 0 ? 0 : 1);
