/* ============================
   Liora Scoring Entreprises
   Moteur de score — Risque / Solvabilité
   v1.0.0

   Module PUR : aucune dépendance au DOM ni au réseau.
   Entrée  : une fiche entreprise normalisée (voir api.js → normalise())
   Sortie  : un score 0-100 (100 = risque le plus faible), un grade A-E,
             le détail par pilier, les drapeaux rouges et les points forts.

   Utilisable dans le navigateur (window.LioraScoring) et dans Node
   (module.exports) afin de pouvoir tester le moteur hors navigateur.
   ============================ */

(function (root, factory) {
    'use strict';
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.LioraScoring = api;
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    /* ──────────────────────────────────────────────────────────────
       1. Pondérations par défaut (somme = 100)
       ────────────────────────────────────────────────────────────── */

    const DEFAULT_WEIGHTS = {
        perennite: 20,   // ancienneté de l'entreprise
        taille: 15,      // effectifs, catégorie, établissements
        finances: 30,    // CA, résultat net, tendance
        transparence: 15,// publication des comptes, conventions, labels
        juridique: 10,   // forme juridique / responsabilité
        secteur: 10      // risque sectoriel (NAF)
    };

    const PILLAR_LABELS = {
        perennite: 'Pérennité',
        taille: 'Taille & structure',
        finances: 'Santé financière',
        transparence: 'Transparence',
        juridique: 'Forme juridique',
        secteur: 'Secteur d’activité'
    };

    /* ──────────────────────────────────────────────────────────────
       2. Tables de référence
       ────────────────────────────────────────────────────────────── */

    // Tranches d'effectif salarié INSEE → [libellé, effectif médian, note /100]
    const EFFECTIF = {
        'NN': ['Non renseigné', null, null],
        '00': ['0 salarié', 0, 35],
        '01': ['1 à 2 salariés', 2, 45],
        '02': ['3 à 5 salariés', 4, 55],
        '03': ['6 à 9 salariés', 8, 62],
        '11': ['10 à 19 salariés', 15, 70],
        '12': ['20 à 49 salariés', 35, 78],
        '21': ['50 à 99 salariés', 75, 85],
        '22': ['100 à 199 salariés', 150, 90],
        '31': ['200 à 249 salariés', 225, 92],
        '32': ['250 à 499 salariés', 375, 94],
        '41': ['500 à 999 salariés', 750, 96],
        '42': ['1 000 à 1 999 salariés', 1500, 98],
        '51': ['2 000 à 4 999 salariés', 3500, 99],
        '52': ['5 000 à 9 999 salariés', 7500, 100],
        '53': ['10 000 salariés et plus', 15000, 100]
    };

    // Catégorie d'entreprise INSEE
    const CATEGORIE = {
        'PME': ['PME', 0],
        'ETI': ['ETI', 6],
        'GE': ['Grande entreprise', 10]
    };

    // Sections NAF → [libellé, note de risque sectoriel /100]
    // Note basse = secteur à sinistralité élevée (défaillances d'entreprises).
    const SECTION_NAF = {
        'A': ['Agriculture, sylviculture et pêche', 58],
        'B': ['Industries extractives', 70],
        'C': ['Industrie manufacturière', 66],
        'D': ['Production et distribution d’électricité, gaz', 82],
        'E': ['Eau, assainissement, gestion des déchets', 80],
        'F': ['Construction', 42],
        'G': ['Commerce, réparation d’automobiles', 52],
        'H': ['Transports et entreposage', 50],
        'I': ['Hébergement et restauration', 38],
        'J': ['Information et communication', 68],
        'K': ['Activités financières et d’assurance', 78],
        'L': ['Activités immobilières', 64],
        'M': ['Activités spécialisées, scientifiques et techniques', 72],
        'N': ['Activités de services administratifs et de soutien', 60],
        'O': ['Administration publique', 95],
        'P': ['Enseignement', 76],
        'Q': ['Santé humaine et action sociale', 82],
        'R': ['Arts, spectacles et activités récréatives', 48],
        'S': ['Autres activités de services', 56],
        'T': ['Activités des ménages en tant qu’employeurs', 60],
        'U': ['Activités extra-territoriales', 80]
    };

    // Catégories juridiques INSEE — cas précis d'abord, puis repli sur le 1er chiffre
    const NATURE_JURIDIQUE = {
        '1000': ['Entrepreneur individuel', 38],
        '5202': ['Société en nom collectif', 58],
        '5306': ['Société en commandite simple', 60],
        '5385': ['Société en commandite par actions', 78],
        '5410': ['SARL nationale', 78],
        '5415': ['SARL d’économie mixte', 80],
        '5426': ['SARL immobilière', 72],
        '5442': ['SARL d’attribution', 72],
        '5451': ['SARL coopérative de construction', 72],
        '5498': ['SARL unipersonnelle (EURL)', 70],
        '5499': ['Société à responsabilité limitée (SARL)', 78],
        '5505': ['SA à participation ouvrière', 88],
        '5510': ['SA nationale', 92],
        '5515': ['SA d’économie mixte', 90],
        '5599': ['Société anonyme (SA)', 90],
        '5710': ['Société par actions simplifiée (SAS)', 82],
        '5720': ['Société par actions simplifiée unipersonnelle (SASU)', 74],
        '5785': ['Société d’exercice libéral par actions simplifiée', 80],
        '5800': ['Société européenne', 90],
        '6540': ['Société civile immobilière (SCI)', 62],
        '6901': ['Autre personne de droit privé inscrite au registre', 60],
        '9220': ['Association déclarée', 58]
    };

    // Repli par 1er chiffre de la catégorie juridique
    const NATURE_JURIDIQUE_FAMILLE = {
        '1': ['Entrepreneur individuel', 38],
        '2': ['Groupement sans personnalité morale', 40],
        '3': ['Personne morale de droit étranger', 50],
        '4': ['Personne morale de droit public', 88],
        '5': ['Société commerciale', 80],
        '6': ['Autre personne morale de droit privé', 64],
        '7': ['Personne morale de droit public administratif', 96],
        '8': ['Organisme privé spécialisé', 74],
        '9': ['Groupement de droit privé (association…)', 58]
    };

    /* ──────────────────────────────────────────────────────────────
       3. Utilitaires
       ────────────────────────────────────────────────────────────── */

    function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

    function num(v) {
        if (v === null || v === undefined || v === '') return null;
        const n = typeof v === 'number' ? v : parseFloat(String(v).replace(',', '.'));
        return Number.isFinite(n) ? n : null;
    }

    /** Interpolation linéaire sur une table de paliers [[seuil, note], …] croissante. */
    function interpolate(value, table) {
        if (value === null || value === undefined) return null;
        if (value <= table[0][0]) return table[0][1];
        const last = table[table.length - 1];
        if (value >= last[0]) return last[1];
        for (let i = 0; i < table.length - 1; i++) {
            const [x1, y1] = table[i], [x2, y2] = table[i + 1];
            if (value >= x1 && value <= x2) {
                const ratio = (value - x1) / (x2 - x1);
                return y1 + ratio * (y2 - y1);
            }
        }
        return last[1];
    }

    /** Âge en années (décimales) entre une date ISO et aujourd'hui. */
    function ageEnAnnees(dateISO, now) {
        if (!dateISO) return null;
        const d = new Date(dateISO);
        if (isNaN(d.getTime())) return null;
        const ref = now ? new Date(now) : new Date();
        const ans = (ref.getTime() - d.getTime()) / (365.25 * 24 * 3600 * 1000);
        return ans < 0 ? null : ans;
    }

    /* ──────────────────────────────────────────────────────────────
       4. Piliers
       ────────────────────────────────────────────────────────────── */

    /** Pilier 1 — Pérennité : plus l'entreprise est ancienne, plus elle est solide. */
    function scorePerennite(c, ctx) {
        const age = ageEnAnnees(c.dateCreation, ctx.now);
        if (age === null) {
            return { note: 45, confiance: 0, details: ['Date de création inconnue'] };
        }
        const note = interpolate(age, [
            [0, 20], [1, 40], [2, 55], [3, 65], [5, 76], [10, 88], [20, 96], [40, 100]
        ]);
        const details = [`Créée il y a ${age.toFixed(1)} an${age >= 2 ? 's' : ''}`];

        // Une entreprise de moins de 3 ans est statistiquement la plus exposée.
        if (age < 3) details.push('Zone de risque : les défaillances se concentrent sur les 3 premières années');

        return { note, confiance: 1, details };
    }

    /** Pilier 2 — Taille & structure : effectifs, catégorie INSEE, réseau d'établissements. */
    function scoreTaille(c) {
        const details = [];
        let note = null, confiance = 0;

        const eff = EFFECTIF[c.trancheEffectif];
        if (eff && eff[2] !== null) {
            note = eff[2];
            confiance = 1;
            details.push(`Effectif : ${eff[0]}${c.anneeEffectif ? ' (' + c.anneeEffectif + ')' : ''}`);
        } else {
            note = 45;
            details.push('Effectif salarié non renseigné');
        }

        const cat = CATEGORIE[c.categorieEntreprise];
        if (cat) {
            note += cat[1];
            if (cat[1] > 0) details.push(`Catégorie INSEE : ${cat[0]} (+${cat[1]})`);
            else details.push(`Catégorie INSEE : ${cat[0]}`);
        }

        // Un réseau d'établissements ouverts traduit une implantation établie.
        const ouverts = num(c.etablissementsOuverts);
        if (ouverts !== null && ouverts > 1) {
            const bonus = clamp(Math.log10(ouverts) * 6, 0, 8);
            note += bonus;
            details.push(`${ouverts} établissements ouverts (+${bonus.toFixed(1)})`);
        }

        // Beaucoup d'établissements fermés par rapport aux ouverts = contraction du réseau.
        const total = num(c.etablissementsTotal);
        if (total !== null && ouverts !== null && total >= 4) {
            const partFermes = (total - ouverts) / total;
            if (partFermes > 0.5) {
                note -= 8;
                details.push(`${Math.round(partFermes * 100)} % des établissements sont fermés (-8)`);
            }
        }

        return { note: clamp(note, 0, 100), confiance, details };
    }

    /**
     * Pilier 3 — Santé financière.
     * L'API expose les comptes déposés (CA, résultat net) par exercice.
     * Trois axes : rentabilité (marge nette), tendance du CA, fraîcheur des comptes.
     */
    function scoreFinances(c, ctx) {
        const details = [];
        const ex = (c.exercices || []).slice().sort((a, b) => a.annee - b.annee);

        if (!ex.length) {
            return {
                note: 42,
                confiance: 0,
                details: ['Aucun compte annuel disponible (comptes non déposés ou confidentiels)']
            };
        }

        const dernier = ex[ex.length - 1];
        const ca = num(dernier.ca);
        const rn = num(dernier.resultatNet);
        let note = 50, confiance = 0.4;

        // — Rentabilité : marge nette
        if (ca !== null && ca > 0 && rn !== null) {
            const marge = rn / ca;
            note = interpolate(marge * 100, [
                [-20, 5], [-10, 18], [-5, 30], [0, 48], [2, 60], [5, 74], [10, 87], [20, 96], [30, 100]
            ]);
            confiance = 1;
            details.push(`Marge nette ${dernier.annee} : ${(marge * 100).toFixed(1)} % (RN ${fmtEuro(rn)} / CA ${fmtEuro(ca)})`);
        } else if (rn !== null) {
            note = rn >= 0 ? 62 : 28;
            confiance = 0.6;
            details.push(`Résultat net ${dernier.annee} : ${fmtEuro(rn)} (CA non publié)`);
        } else if (ca !== null) {
            confiance = 0.4;
            details.push(`Chiffre d’affaires ${dernier.annee} : ${fmtEuro(ca)} (résultat non publié)`);
        }

        // — Tendance du chiffre d'affaires sur les exercices disponibles
        const avecCA = ex.filter(e => num(e.ca) !== null && num(e.ca) > 0);
        if (avecCA.length >= 2) {
            const a = num(avecCA[avecCA.length - 2].ca);
            const b = num(avecCA[avecCA.length - 1].ca);
            const evol = (b - a) / a;
            const ajust = clamp(evol * 45, -18, 12);
            note += ajust;
            const signe = evol >= 0 ? '+' : '';
            details.push(
                `Évolution du CA ${avecCA[avecCA.length - 2].annee} → ${avecCA[avecCA.length - 1].annee} : ` +
                `${signe}${(evol * 100).toFixed(1)} % (${ajust >= 0 ? '+' : ''}${ajust.toFixed(1)})`
            );
        }

        // — Deux exercices déficitaires consécutifs : signal fort
        const avecRN = ex.filter(e => num(e.resultatNet) !== null);
        if (avecRN.length >= 2) {
            const d1 = num(avecRN[avecRN.length - 1].resultatNet);
            const d2 = num(avecRN[avecRN.length - 2].resultatNet);
            if (d1 < 0 && d2 < 0) {
                note -= 12;
                details.push('Deux exercices déficitaires consécutifs (-12)');
            }
        }

        // — Fraîcheur : des comptes anciens valent moins qu'un exercice récent
        const anneeRef = ctx.now ? new Date(ctx.now).getFullYear() : new Date().getFullYear();
        const retard = anneeRef - dernier.annee;
        if (retard >= 3) {
            note -= 10;
            confiance *= 0.6;
            details.push(`Dernier exercice publié : ${dernier.annee}, soit ${retard} ans de retard (-10)`);
        } else if (retard === 2) {
            note -= 4;
            confiance *= 0.85;
            details.push(`Dernier exercice publié : ${dernier.annee} (-4)`);
        } else {
            details.push(`Dernier exercice publié : ${dernier.annee}`);
        }

        return { note: clamp(note, 0, 100), confiance: clamp(confiance, 0, 1), details };
    }

    /**
     * Pilier 4 — Transparence & conformité.
     * Une entreprise qui publie ses comptes, déclare sa convention collective et
     * détient des labels vérifiables est plus lisible, donc moins risquée à créditer.
     */
    function scoreTransparence(c) {
        const details = [];
        let note = 50;

        if ((c.exercices || []).length >= 3) { note += 22; details.push('Comptes publiés sur 3 exercices ou plus (+22)'); }
        else if ((c.exercices || []).length === 2) { note += 16; details.push('Comptes publiés sur 2 exercices (+16)'); }
        else if ((c.exercices || []).length === 1) { note += 9; details.push('Comptes publiés sur 1 exercice (+9)'); }
        else { note -= 14; details.push('Aucun compte annuel publié (-14)'); }

        if (c.statutDiffusion === 'P') {
            note -= 18;
            details.push('Entreprise non diffusible : informations volontairement masquées (-18)');
        }

        if (c.conventionCollective) { note += 6; details.push('Convention collective renseignée (+6)'); }
        if ((c.dirigeants || []).length > 0) { note += 5; details.push(`${c.dirigeants.length} dirigeant(s) identifié(s) (+5)`); }
        else { note -= 5; details.push('Aucun dirigeant identifié (-5)'); }

        const labels = c.labels || {};
        const bonusLabels = [
            ['estServicePublic', 'Service public', 10],
            ['estRge', 'Certification RGE', 5],
            ['estQualiopi', 'Certification Qualiopi', 5],
            ['estEss', 'Économie sociale et solidaire', 3],
            ['estSocieteMission', 'Société à mission', 3],
            ['estBio', 'Certification bio', 2],
            ['estOrganismeFormation', 'Organisme de formation déclaré', 2]
        ];
        let cumulLabels = 0;
        bonusLabels.forEach(([cle, libelle, pts]) => {
            if (labels[cle]) {
                const p = Math.min(pts, 12 - cumulLabels); // plafond global des labels
                if (p > 0) { note += p; cumulLabels += p; details.push(`${libelle} (+${p})`); }
            }
        });

        return { note: clamp(note, 0, 100), confiance: 1, details };
    }

    /** Pilier 5 — Forme juridique : capital, responsabilité et obligations comptables. */
    function scoreJuridique(c) {
        const code = String(c.natureJuridique || '').trim();
        let entry = NATURE_JURIDIQUE[code];
        if (!entry && code) entry = NATURE_JURIDIQUE_FAMILLE[code.charAt(0)];

        if (!entry) {
            return { note: 60, confiance: 0, details: ['Forme juridique inconnue'] };
        }
        const details = [`${entry[0]} (code ${code})`];
        if (entry[1] < 50) details.push('Responsabilité personnelle du dirigeant : patrimoine peu protégé');
        return { note: entry[1], confiance: 1, details };
    }

    /** Pilier 6 — Secteur d'activité : sinistralité observée par section NAF. */
    function scoreSecteur(c) {
        const section = c.sectionNaf || sectionDepuisNaf(c.activitePrincipale);
        const entry = section ? SECTION_NAF[section] : null;
        if (!entry) {
            return { note: 62, confiance: 0, details: ['Secteur d’activité non identifié'] };
        }
        const details = [`Section ${section} — ${entry[0]}`];
        if (c.activitePrincipale) details.push(`Code NAF ${c.activitePrincipale}${c.libelleActivite ? ' — ' + c.libelleActivite : ''}`);
        if (entry[1] < 50) details.push('Secteur à sinistralité élevée');
        return { note: entry[1], confiance: 1, details };
    }

    /** Déduit la section NAF (A-U) à partir de la division du code APE (ex. "43.99C" → F). */
    function sectionDepuisNaf(naf) {
        if (!naf) return null;
        const division = parseInt(String(naf).replace(/\D/g, '').slice(0, 2), 10);
        if (!Number.isFinite(division)) return null;
        const bornes = [
            [1, 3, 'A'], [5, 9, 'B'], [10, 33, 'C'], [35, 35, 'D'], [36, 39, 'E'],
            [41, 43, 'F'], [45, 47, 'G'], [49, 53, 'H'], [55, 56, 'I'], [58, 63, 'J'],
            [64, 66, 'K'], [68, 68, 'L'], [69, 75, 'M'], [77, 82, 'N'], [84, 84, 'O'],
            [85, 85, 'P'], [86, 88, 'Q'], [90, 93, 'R'], [94, 96, 'S'], [97, 98, 'T'],
            [99, 99, 'U']
        ];
        for (const [min, max, section] of bornes) {
            if (division >= min && division <= max) return section;
        }
        return null;
    }

    /* ──────────────────────────────────────────────────────────────
       5. Règles éliminatoires — cessation & procédures collectives
       ────────────────────────────────────────────────────────────── */

    /**
     * Analyse les annonces BODACC pour déterminer l'état procédural courant.
     * Renvoie { type, plafond, libelle, date } ou null si rien de bloquant.
     */
    function analyseProcedures(procedures, ctx) {
        if (!Array.isArray(procedures) || !procedures.length) return null;

        const now = ctx.now ? new Date(ctx.now) : new Date();
        const tri = procedures
            .filter(p => p && p.date)
            .sort((a, b) => new Date(b.date) - new Date(a.date));
        if (!tri.length) return null;

        const derniere = tri[0];
        const texte = String(derniere.libelle || '').toLowerCase();
        const ageMois = (now - new Date(derniere.date)) / (30.44 * 24 * 3600 * 1000);

        // Ordre de test important : du plus grave au plus favorable.
        if (/liquidation/.test(texte)) {
            return { type: 'liquidation', plafond: 5, libelle: 'Liquidation judiciaire', date: derniere.date, gravite: 'critique' };
        }
        if (/insuffisance d.actif|cl[oô]ture pour insuffisance/.test(texte)) {
            return { type: 'cloture-insuffisance', plafond: 8, libelle: 'Clôture pour insuffisance d’actif', date: derniere.date, gravite: 'critique' };
        }
        if (/redressement/.test(texte) && /plan|arr[eê]tant|homolog/.test(texte)) {
            return { type: 'plan-redressement', plafond: 42, libelle: 'Plan de redressement arrêté', date: derniere.date, gravite: 'eleve' };
        }
        if (/redressement/.test(texte)) {
            return { type: 'redressement', plafond: 20, libelle: 'Redressement judiciaire', date: derniere.date, gravite: 'critique' };
        }
        if (/sauvegarde/.test(texte) && /plan|arr[eê]tant|homolog/.test(texte)) {
            return { type: 'plan-sauvegarde', plafond: 50, libelle: 'Plan de sauvegarde arrêté', date: derniere.date, gravite: 'eleve' };
        }
        if (/sauvegarde/.test(texte)) {
            return { type: 'sauvegarde', plafond: 35, libelle: 'Procédure de sauvegarde', date: derniere.date, gravite: 'eleve' };
        }
        if (/cessation des paiements/.test(texte)) {
            return { type: 'cessation-paiements', plafond: 15, libelle: 'État de cessation des paiements', date: derniere.date, gravite: 'critique' };
        }
        // Clôture / fin de procédure : l'entreprise est sortie de procédure.
        if (/cl[oô]ture/.test(texte)) {
            if (ageMois > 36) return null; // sortie ancienne, on ne pénalise plus
            return { type: 'sortie-procedure', plafond: 62, libelle: 'Sortie de procédure collective récente', date: derniere.date, gravite: 'modere' };
        }
        return { type: 'procedure', plafond: 45, libelle: derniere.libelle || 'Procédure collective', date: derniere.date, gravite: 'eleve' };
    }

    /* ──────────────────────────────────────────────────────────────
       6. Grade, libellés et encours indicatif
       ────────────────────────────────────────────────────────────── */

    const GRADES = [
        { min: 80, grade: 'A', risque: 'Très faible', couleur: 'green' },
        { min: 65, grade: 'B', risque: 'Faible', couleur: 'lime' },
        { min: 50, grade: 'C', risque: 'Modéré', couleur: 'amber' },
        { min: 35, grade: 'D', risque: 'Élevé', couleur: 'orange' },
        { min: 0, grade: 'E', risque: 'Très élevé', couleur: 'red' }
    ];

    function gradeDepuisScore(score) {
        return GRADES.find(g => score >= g.min) || GRADES[GRADES.length - 1];
    }

    /**
     * Plafond d'encours indicatif : un mois de chiffre d'affaires pondéré par le grade.
     * Purement indicatif — ne remplace pas une décision de crédit.
     */
    function encoursIndicatif(score, exercices) {
        const ex = (exercices || []).filter(e => num(e.ca) !== null && num(e.ca) > 0);
        if (!ex.length) return null;
        const ca = num(ex[ex.length - 1].ca);
        const coef = score >= 80 ? 1.0
            : score >= 65 ? 0.6
                : score >= 50 ? 0.3
                    : score >= 35 ? 0.1
                        : 0;
        if (coef === 0) return { montant: 0, base: ca, coef };
        // Arrondi à la centaine d'euros la plus proche pour un affichage lisible.
        const montant = Math.round((ca / 12) * coef / 100) * 100;
        return { montant, base: ca, coef };
    }

    function fmtEuro(v) {
        const n = num(v);
        if (n === null) return '—';
        const abs = Math.abs(n);
        if (abs >= 1e9) return (n / 1e9).toFixed(2).replace('.', ',') + ' Md€';
        if (abs >= 1e6) return (n / 1e6).toFixed(2).replace('.', ',') + ' M€';
        if (abs >= 1e3) return Math.round(n / 1e3).toLocaleString('fr-FR') + ' k€';
        return Math.round(n).toLocaleString('fr-FR') + ' €';
    }

    /* ──────────────────────────────────────────────────────────────
       7. Fonction principale
       ────────────────────────────────────────────────────────────── */

    /**
     * Calcule le score de risque d'une entreprise.
     * @param {object} c        Fiche normalisée (api.js → normalise)
     * @param {object} options  { weights, now }
     */
    function scorer(c, options) {
        options = options || {};
        const ctx = { now: options.now || null };
        const weights = Object.assign({}, DEFAULT_WEIGHTS, options.weights || {});

        const piliers = {
            perennite: scorePerennite(c, ctx),
            taille: scoreTaille(c),
            finances: scoreFinances(c, ctx),
            transparence: scoreTransparence(c),
            juridique: scoreJuridique(c),
            secteur: scoreSecteur(c)
        };

        // Moyenne pondérée (les poids sont renormalisés pour tolérer toute somme).
        let sommePoids = 0, cumul = 0;
        Object.keys(piliers).forEach(cle => {
            const p = weights[cle] || 0;
            sommePoids += p;
            cumul += piliers[cle].note * p;
        });
        let score = sommePoids > 0 ? cumul / sommePoids : 50;

        const drapeaux = [];
        const forces = [];

        // — Règles éliminatoires
        let plafond = 100;
        const procedure = analyseProcedures(c.procedures, ctx);

        if (c.etatAdministratif === 'C') {
            plafond = Math.min(plafond, 5);
            drapeaux.push({
                gravite: 'critique',
                titre: 'Entreprise cessée',
                detail: 'L’établissement est administrativement fermé au répertoire SIRENE. Aucun encours ne devrait être accordé.'
            });
        }

        if (procedure) {
            plafond = Math.min(plafond, procedure.plafond);
            drapeaux.push({
                gravite: procedure.gravite,
                titre: procedure.libelle,
                detail: `Annonce BODACC du ${formatDate(procedure.date)}.`
            });
        }

        const scoreBrut = score;
        if (plafond < score) score = plafond;
        score = clamp(Math.round(score), 0, 100);

        // — Drapeaux rouges complémentaires
        const age = ageEnAnnees(c.dateCreation, ctx.now);
        if (age !== null && age < 2) {
            drapeaux.push({
                gravite: 'modere',
                titre: 'Entreprise récente',
                detail: `Créée il y a ${age.toFixed(1)} an${age >= 2 ? 's' : ''} : absence d’historique de paiement et taux de défaillance élevé.`
            });
        }
        if (!(c.exercices || []).length) {
            drapeaux.push({
                gravite: 'modere',
                titre: 'Comptes non publiés',
                detail: 'Aucun bilan disponible : la solvabilité ne peut pas être vérifiée sur pièces.'
            });
        }
        if (c.statutDiffusion === 'P') {
            drapeaux.push({
                gravite: 'modere',
                titre: 'Entreprise non diffusible',
                detail: 'L’entreprise a demandé le masquage de ses informations au répertoire SIRENE.'
            });
        }
        const exTri = (c.exercices || []).slice().sort((a, b) => a.annee - b.annee);
        const dernier = exTri[exTri.length - 1];
        if (dernier && num(dernier.resultatNet) !== null && num(dernier.resultatNet) < 0) {
            drapeaux.push({
                gravite: 'eleve',
                titre: `Résultat net déficitaire (${dernier.annee})`,
                detail: `Perte de ${fmtEuro(Math.abs(num(dernier.resultatNet)))} sur le dernier exercice publié.`
            });
        }
        // Baisse du CA : on teste le dernier exercice, mais aussi la tendance cumulée —
        // trois reculs de 10 % d'affilée ne déclenchent aucune alerte annuelle alors que
        // l'entreprise a perdu plus d'un quart de son activité.
        const exCA = exTri.filter(e => num(e.ca) !== null && num(e.ca) > 0);
        if (exCA.length >= 2) {
            const precedent = num(exCA[exCA.length - 2].ca);
            const dernierCA = num(exCA[exCA.length - 1].ca);
            const evolAnnuelle = (dernierCA - precedent) / precedent;

            const premier = num(exCA[0].ca);
            const evolCumulee = (dernierCA - premier) / premier;

            if (evolAnnuelle < -0.20) {
                drapeaux.push({
                    gravite: 'eleve',
                    titre: 'Chiffre d’affaires en forte baisse',
                    detail: `Recul de ${Math.round(Math.abs(evolAnnuelle) * 100)} % entre ${exCA[exCA.length - 2].annee} et ${exCA[exCA.length - 1].annee}.`
                });
            } else if (exCA.length >= 3 && evolCumulee < -0.20) {
                drapeaux.push({
                    gravite: 'eleve',
                    titre: 'Chiffre d’affaires en baisse continue',
                    detail: `Recul cumulé de ${Math.round(Math.abs(evolCumulee) * 100)} % entre ${exCA[0].annee} et ${exCA[exCA.length - 1].annee}.`
                });
            }
        }
        const anneeRef = ctx.now ? new Date(ctx.now).getFullYear() : new Date().getFullYear();
        if (dernier && anneeRef - dernier.annee >= 3) {
            drapeaux.push({
                gravite: 'modere',
                titre: 'Comptes obsolètes',
                detail: `Le dernier exercice publié remonte à ${dernier.annee}.`
            });
        }

        // — Points forts
        if (age !== null && age >= 10) forces.push(`Entreprise établie depuis ${Math.floor(age)} ans`);
        if (dernier && num(dernier.resultatNet) !== null && num(dernier.resultatNet) > 0) {
            forces.push(`Résultat net positif en ${dernier.annee} (${fmtEuro(num(dernier.resultatNet))})`);
        }
        if (exTri.length >= 3) forces.push('Comptes annuels publiés sur au moins 3 exercices');
        if (CATEGORIE[c.categorieEntreprise] && c.categorieEntreprise !== 'PME') {
            forces.push(`Catégorie ${CATEGORIE[c.categorieEntreprise][0]}`);
        }
        if ((c.labels || {}).estServicePublic) forces.push('Entité de service public');
        if (piliers.finances.note >= 75 && piliers.finances.confiance >= 0.8) forces.push('Rentabilité solide sur le dernier exercice');
        if (c.etablissementsOuverts > 5) forces.push(`Réseau de ${c.etablissementsOuverts} établissements ouverts`);

        // — Indice de confiance : part des piliers réellement documentés
        let confPoids = 0, confCumul = 0;
        Object.keys(piliers).forEach(cle => {
            const p = weights[cle] || 0;
            confPoids += p;
            confCumul += (piliers[cle].confiance || 0) * p;
        });
        const confiance = confPoids > 0 ? Math.round((confCumul / confPoids) * 100) : 0;

        const g = gradeDepuisScore(score);

        return {
            score,
            scoreBrut: Math.round(scoreBrut),
            plafonne: plafond < scoreBrut,
            grade: g.grade,
            risque: g.risque,
            couleur: g.couleur,
            confiance,
            piliers: Object.keys(piliers).map(cle => ({
                cle,
                libelle: PILLAR_LABELS[cle],
                note: Math.round(piliers[cle].note),
                poids: weights[cle] || 0,
                confiance: piliers[cle].confiance,
                details: piliers[cle].details
            })),
            drapeaux,
            forces,
            procedure,
            encours: encoursIndicatif(score, c.exercices),
            calculeLe: (ctx.now ? new Date(ctx.now) : new Date()).toISOString()
        };
    }

    function formatDate(iso) {
        if (!iso) return '—';
        const d = new Date(iso);
        if (isNaN(d.getTime())) return String(iso);
        return d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' });
    }

    return {
        scorer,
        DEFAULT_WEIGHTS,
        PILLAR_LABELS,
        EFFECTIF,
        SECTION_NAF,
        NATURE_JURIDIQUE,
        NATURE_JURIDIQUE_FAMILLE,
        GRADES,
        gradeDepuisScore,
        sectionDepuisNaf,
        analyseProcedures,
        fmtEuro,
        formatDate,
        ageEnAnnees
    };
});
