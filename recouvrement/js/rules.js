/* ==========================================================
   Liora — Suivi Recouvrement
   rules.js — Référentiel métier
     · Règles de date d'échéance par type de financement
     · Normalisation des types de financement
     · Rôles des tableaux Monday (périmètre, statut recouvrement)
   ========================================================== */

(function (global) {
    'use strict';

    // ──────────────────────────────────────────────
    //  Utilitaires de normalisation de texte
    // ──────────────────────────────────────────────

    /** Minuscules, sans accents, sans ponctuation, espaces compactés. */
    function norm(s) {
        return String(s == null ? '' : s)
            .normalize('NFD').replace(/[̀-ͯ]/g, '')
            .toLowerCase()
            .replace(/[’']/g, ' ')
            .replace(/[^a-z0-9]+/g, ' ')
            .trim();
    }

    // ──────────────────────────────────────────────
    //  Règles de date d'échéance
    //  (référentiel « Règle date d'échéance » — feuille de calcul Liora)
    //
    //  base   : champ servant de point de départ
    //           'dateFacture' | 'dateFinFormation' | 'dateDebutFormation'
    //  jours  : nombre de jours ajoutés à la base
    //  fallback : base de repli si la base principale est absente
    //  altBase / altJours : variante documentée (ex. facture modifiée)
    // ──────────────────────────────────────────────

    const DEFAULT_ECHEANCE_RULES = [
        {
            key: 'BTC_ENTREPRISE',
            label: 'B2C-Entreprise / Corporate Alternance',
            base: 'dateFacture', jours: 30,
            fallback: 'dateDebutFormation', fallbackJours: 30,
            note: "Date de facture +30 jours (si facture modifiée : début de formation +30 jours)",
            perimetre: 'Corporate',
            // Monday écrit « B2C - Entreprise », le référentiel « BTC-Entreprise ».
            // Les deux graphies désignent la même chose : un particulier dont la
            // formation est facturée à une entreprise. Sans le libellé « b2c
            // entreprise », il était capté par « entreprise » et traité en B2B,
            // donc calculé sur la fin de formation au lieu de la date de facture.
            match: ['b2c entreprise', 'b2c ent', 'btc entreprise', 'btc ent',
                    'b2c corporate', 'btc corporate', 'corporate alternance'],
        },
        {
            key: 'B2B', label: 'B2B',
            base: 'dateFinFormation', jours: 30,
            fallback: 'dateFacture', fallbackJours: 30,
            note: 'Fin de formation +30 jours', perimetre: 'Corporate',
            match: ['b2b', 'btob', 'entreprise', 'corporate'],
        },
        {
            key: 'ALTERNANCE', label: 'Alternance',
            base: 'dateFinFormation', jours: 30,
            fallback: 'dateFacture', fallbackJours: 30,
            note: 'Fin de formation +30 jours', perimetre: 'Corporate',
            match: ['alternance', 'apprentissage', 'contrat pro'],
        },
        {
            key: 'TRANSITION', label: 'Transition pro',
            base: 'dateFinFormation', jours: 60,
            fallback: 'dateFacture', fallbackJours: 60,
            note: 'Fin de formation +60 jours', perimetre: 'B2C',
            match: ['transition pro', 'transitions pro', 'transition', 'ptp', 'projet de transition', 'atpro', 'associations transitions pro'],
        },
        {
            key: 'REGION', label: 'REGION',
            base: 'dateFinFormation', jours: 60,
            fallback: 'dateFacture', fallbackJours: 60,
            note: 'Fin de formation +60 jours', perimetre: 'B2C',
            match: ['region', 'conseil regional', 'regional'],
        },
        {
            key: 'AIF', label: 'AIF',
            base: 'dateFinFormation', jours: 60,
            fallback: 'dateFacture', fallbackJours: 60,
            note: 'Fin de formation +60 jours', perimetre: 'B2C',
            match: ['aif', 'aide individuelle a la formation', 'pole emploi aif', 'france travail aif'],
        },
        {
            key: 'POEI', label: 'POEI',
            base: 'dateFinFormation', jours: 60,
            fallback: 'dateFacture', fallbackJours: 60,
            note: 'Fin de formation +60 jours', perimetre: 'B2C',
            match: ['poei', 'poec', 'preparation operationnelle'],
        },
        {
            key: 'AGEFIPH', label: 'Agefiph',
            base: 'dateFinFormation', jours: 60,
            fallback: 'dateFacture', fallbackJours: 60,
            note: 'Fin de formation +60 jours', perimetre: 'B2C',
            match: ['agefiph', 'fiphfp'],
        },
        {
            key: 'ETAT', label: 'Etat',
            base: 'dateFinFormation', jours: 30,
            fallback: 'dateFacture', fallbackJours: 30,
            note: 'Fin de formation +30 jours', perimetre: 'Corporate',
            match: ['etat', 'public etat', 'ministere', 'prefecture'],
        },
        {
            key: 'INTERCO', label: 'Interco',
            base: 'dateFinFormation', jours: 60,
            fallback: 'dateFacture', fallbackJours: 60,
            note: 'Fin de formation +60 jours', perimetre: 'Corporate',
            match: ['interco', 'intercompany', 'inter co', 'intra groupe'],
        },
        {
            key: 'DST_ALLEMAGNE', label: 'Interne - DST Allemagne',
            base: 'dateFinFormation', jours: 60,
            fallback: 'dateFacture', fallbackJours: 60,
            note: 'Fin de formation +60 jours', perimetre: 'Corporate',
            match: ['dst allemagne', 'interne dst allemagne', 'dst', 'allemagne', 'germany', 'bu1 germany'],
        },
        {
            key: 'OPCO', label: 'OPCO',
            base: 'dateFinFormation', jours: 30,
            fallback: 'dateFacture', fallbackJours: 30,
            note: 'Fin de formation +30 jours — pas de recouvrement OPCO, suivi du retard uniquement',
            perimetre: 'Corporate', sansRecouvrement: true,
            match: ['opco', 'akto', 'atlas', 'uniformation', 'ocapiat', 'constructys', 'afdas', 'opcommerce', 'l opcommerce', 'opco ep', 'opco 2i', 'opco mobilites', 'opco sante'],
        },
        {
            key: 'BTC_PERSO', label: 'B2C-Perso / Perso-Alternance',
            base: 'dateFinFormation', jours: 0,
            fallback: 'dateDebutFormation', fallbackJours: 0,
            note: 'Début de formation / fin de formation (aucun délai supplémentaire)',
            perimetre: 'B2C',
            match: ['b2c perso', 'btc perso', 'perso alternance', 'financement personnel',
                    'perso', 'personnel', 'fonds propres', 'auto financement', 'autofinancement'],
        },
        {
            key: 'CPF', label: 'CPF',
            base: 'dateFinFormation', jours: 45,
            fallback: 'dateFacture', fallbackJours: 45,
            note: 'Fin de formation +45 jours', perimetre: 'B2C',
            match: ['cpf', 'compte personnel de formation', 'edof', 'caisse des depots', 'cdc'],
        },
    ];

    /** Règle appliquée quand le type de financement est inconnu. */
    const DEFAULT_FALLBACK_RULE = {
        key: 'INCONNU', label: 'Non renseigné',
        base: 'dateFacture', jours: 30,
        fallback: 'dateFinFormation', fallbackJours: 30,
        note: 'Type de financement non identifié — règle par défaut : date de facture +30 jours',
        perimetre: 'Inconnu', match: [],
    };

    // ──────────────────────────────────────────────
    //  Rôles des tableaux Monday
    //
    //  role : 'payees' | 'tampon' | 'adv' | 'recouvrement' | 'opco'
    //         | 'b2c' | 'technique' | 'ignore'
    //  Le rôle pilote :
    //    · le périmètre (Corporate / B2C)
    //    · l'inclusion dans les compteurs de retard (chips « Source »)
    //    · le financement par défaut quand la colonne est vide
    // ──────────────────────────────────────────────

    const BOARD_ROLE_PATTERNS = [
        { role: 'payees',       perimetre: 'Tous',      source: 'payees',        financementDefaut: null,          match: ['all factures payees', 'factures payees', '0 1 all', 'factures paye'] },
        { role: 'technique',    perimetre: 'Tous',      source: 'technique',     financementDefaut: null,          match: ['technique', 'zone kairos', 'rib recus', 'transactions technique', 'dossier aif en cours'] },
        { role: 'opco',         perimetre: 'Corporate', source: 'opco',          financementDefaut: 'OPCO',        match: ['entreprise opco', 'opco et plateforme', ' opco'] },
        { role: 'recouvrement', perimetre: 'Corporate', source: 'recouvrement',  financementDefaut: null,          match: ['recouvrement'] },
        { role: 'adv',          perimetre: 'Corporate', source: 'adv',           financementDefaut: null,          match: ['entreprise adv', ' adv'] },
        { role: 'tampon',       perimetre: 'Corporate', source: 'adv',           financementDefaut: null,          match: ['tampon'] },
        { role: 'b2c',          perimetre: 'B2C',       source: 'b2c',           financementDefaut: 'CPF',         match: ['financement cpf', 'cpf'] },
        { role: 'b2c',          perimetre: 'B2C',       source: 'b2c',           financementDefaut: 'BTC_PERSO',   match: ['financement personnel', 'personnel'] },
        { role: 'b2c',          perimetre: 'B2C',       source: 'b2c',           financementDefaut: 'AIF',         match: ['pole emploi', 'aif poei', 'aif  poei', 'france travail'] },
        { role: 'b2c',          perimetre: 'B2C',       source: 'b2c',           financementDefaut: null,          match: ['financement complexe', 'region transition agefiph'] },
        { role: 'b2c',          perimetre: 'B2C',       source: 'b2c',           financementDefaut: null,          match: ['b2c'] },
        { role: 'adv',          perimetre: 'Corporate', source: 'adv',           financementDefaut: null,          match: ['corporate', 'entreprise'] },
        { role: 'b2c',          perimetre: 'B2C',       source: 'b2c',           financementDefaut: 'DST_ALLEMAGNE', match: ['bu1 germany', 'germany planning'] },
    ];

    const ROLE_LABELS = {
        payees:       'Factures payées (toutes origines)',
        tampon:       'Tampon (transit ADV ↔ Recouvrement)',
        adv:          'ADV Corporate',
        recouvrement: 'Recouvrement Corporate',
        opco:         'OPCO (sans recouvrement)',
        b2c:          'B2C',
        technique:    'Technique (exclu des analyses)',
        ignore:       'Ignoré',
    };

    /**
     * Groupes à écarter des analyses.
     *
     * Un tableau opérationnel peut contenir des groupes de service — archives,
     * zones techniques, corbeilles — qui gonflent les volumes sans rien devoir.
     * Le tableau ADV, par exemple, héberge « 1.1.9. Technique - Archive » avec
     * plusieurs milliers de lignes closes.
     */
    const GROUPES_EXCLUS = [
        'technique', 'archive', 'archives', 'archivee', 'archivees',
        'corbeille', 'poubelle', 'obsolete', 'a supprimer', 'ne pas utiliser',
        'test', 'brouillon', 'doublon',
    ];

    /** Le libellé de ce groupe le désigne-t-il comme groupe de service ? */
    function estGroupeTechnique(nom) {
        const n = ' ' + norm(nom) + ' ';
        return GROUPES_EXCLUS.some(m => n.includes(' ' + m + ' ') || n.includes(m + ' '));
    }

    /**
     * Devine le périmètre à partir d'un libellé de groupe ou de tableau.
     *
     * Le tableau des factures payées mélange tous les périmètres : ses factures
     * ne peuvent pas rester étiquetées « Tous », qui n'est pas un périmètre mais
     * une absence de réponse. Le groupe d'origine, conservé au moment du
     * règlement, permet le plus souvent de trancher.
     */
    function perimetreDepuisTexte(txt) {
        const n = ' ' + norm(txt) + ' ';
        if (!n.trim()) return null;
        if (/cpf|aif|poei|agefiph|transition|region|perso|personnel|apprenant|kairos|b2c/.test(n)) return 'B2C';
        if (/adv|recouv|opco|tampon|entreprise|corporate|b2b|interco|etat|alternance/.test(n)) return 'Corporate';
        return null;
    }

    /** Sources de retard, utilisées pour les chips de filtrage du dashboard. */
    const SOURCES = [
        { key: 'recouvrement', label: 'Recouvrement',  hint: 'Tableau 1.2 — recouvrement Corporate' },
        { key: 'adv',          label: 'ADV / Tampon',  hint: 'Tableaux 1.0 et 1.1 — retard côté ADV' },
        { key: 'opco',         label: 'OPCO',          hint: 'Tableau 1.3 — pas de recouvrement, suivi du retard' },
        { key: 'b2c',          label: 'B2C',           hint: 'Tableaux 2.x — pas de tableau recouvrement dédié' },
    ];

    /** Déduit le rôle d'un tableau à partir de son nom Monday. */
    function detectBoardRole(boardName) {
        const n = ' ' + norm(boardName) + ' ';
        for (const pat of BOARD_ROLE_PATTERNS) {
            for (const m of pat.match) {
                if (n.includes(' ' + m.trim() + ' ') || n.includes(m)) {
                    return { role: pat.role, perimetre: pat.perimetre, source: pat.source, financementDefaut: pat.financementDefaut };
                }
            }
        }
        return { role: 'ignore', perimetre: 'Inconnu', source: null, financementDefaut: null };
    }

    /**
     * Identifie le type de financement à partir d'un libellé libre.
     * Retourne la clé de règle (ex. 'CPF') ou null.
     */
    function detectFinancement(raw, rules) {
        const list = rules || DEFAULT_ECHEANCE_RULES;
        const n = norm(raw);
        if (!n) return null;

        let best = null, bestLen = 0;
        for (const rule of list) {
            for (const m of (rule.match || [])) {
                const mn = norm(m);
                if (!mn) continue;
                // mot entier de préférence, sinon inclusion
                const isWord = new RegExp('(^| )' + mn.replace(/ /g, ' ') + '( |$)').test(n);
                if ((isWord || n.includes(mn)) && mn.length > bestLen) {
                    best = rule.key; bestLen = mn.length;
                }
            }
        }
        return best;
    }

    /** Retourne la règle d'échéance correspondant à une clé de financement. */
    function getRule(key, rules) {
        const list = rules || DEFAULT_ECHEANCE_RULES;
        return list.find(r => r.key === key) || DEFAULT_FALLBACK_RULE;
    }

    // ──────────────────────────────────────────────
    //  Dates
    // ──────────────────────────────────────────────

    const MS_DAY = 86400000;

    /** Date « nue » (minuit local), tolérante aux formats FR / ISO / série Excel. */
    function parseDate(value) {
        if (value == null || value === '') return null;
        if (value instanceof Date) return isNaN(value.getTime()) ? null : stripTime(value);

        const s = String(value).trim();
        if (!s || /^(n\/?a|—|-|null|undefined)$/i.test(s)) return null;

        let m = s.match(/^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2,4})/);
        if (m) {
            let y = +m[3]; if (y < 100) y += y < 70 ? 2000 : 1900;
            return validate(new Date(y, +m[2] - 1, +m[1]));
        }
        m = s.match(/^(\d{4})[/.\-](\d{1,2})[/.\-](\d{1,2})/);
        if (m) return validate(new Date(+m[1], +m[2] - 1, +m[3]));

        if (/^\d+(\.\d+)?$/.test(s)) {
            const num = parseFloat(s);
            // Série Excel plausible : 1990-01-01 → 2100-01-01
            if (num > 32800 && num < 73100) return validate(new Date(Math.round((num - 25569) * MS_DAY)));
            return null;
        }
        const d = new Date(s);
        return validate(d);

        function validate(d) {
            if (!d || isNaN(d.getTime())) return null;
            const y = d.getFullYear();
            if (y < 1990 || y > 2100) return null;
            return stripTime(d);
        }
    }

    function stripTime(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
    function addDays(d, n) { return d ? new Date(d.getFullYear(), d.getMonth(), d.getDate() + n) : null; }
    function diffDays(a, b) { return (a && b) ? Math.round((stripTime(a) - stripTime(b)) / MS_DAY) : null; }
    function monthKey(d) { return d ? d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') : null; }

    /**
     * Calcule la date d'échéance d'une facture selon la règle de son financement.
     * Retourne { date, origine, regle, baseUtilisee } — origine ∈ 'Monday' | 'Règle' | null.
     *
     * @param {object} inv    facture normalisée
     * @param {object} opts   { rules, prefereEcheanceMonday }
     */
    function computeEcheance(inv, opts) {
        const o = opts || {};
        const rule = getRule(inv.financement, o.rules);

        if (o.prefereEcheanceMonday !== false && inv.dateEcheanceSource) {
            return { date: inv.dateEcheanceSource, origine: 'Monday', regle: rule, baseUtilisee: 'colonne Monday' };
        }

        const bases = [
            { champ: rule.base, jours: rule.jours },
            { champ: rule.fallback, jours: rule.fallbackJours != null ? rule.fallbackJours : rule.jours },
        ];
        for (const b of bases) {
            if (!b.champ) continue;
            const src = inv[b.champ];
            if (src) return { date: addDays(src, b.jours || 0), origine: 'Règle', regle: rule, baseUtilisee: b.champ };
        }
        if (inv.dateEcheanceSource) {
            return { date: inv.dateEcheanceSource, origine: 'Monday', regle: rule, baseUtilisee: 'colonne Monday' };
        }
        return { date: null, origine: null, regle: rule, baseUtilisee: null };
    }

    // ──────────────────────────────────────────────
    //  Tranches de balance âgée
    // ──────────────────────────────────────────────

    const AGING_BUCKETS = [
        { key: 'nonEchu',  label: 'Non échu',     min: -1e9, max: 0,    couleur: '#3b82f6' },
        { key: 'j1_30',    label: '1 → 30 j',     min: 1,    max: 30,   couleur: '#84cc16' },
        { key: 'j31_60',   label: '31 → 60 j',    min: 31,   max: 60,   couleur: '#f59e0b' },
        { key: 'j61_90',   label: '61 → 90 j',    min: 61,   max: 90,   couleur: '#f97316' },
        { key: 'j91_180',  label: '91 → 180 j',   min: 91,   max: 180,  couleur: '#F47458' },
        { key: 'j180p',    label: '> 180 j',      min: 181,  max: 1e9,  couleur: '#ef4444' },
    ];

    function bucketFor(retardJours) {
        if (retardJours == null) return null;
        return AGING_BUCKETS.find(b => retardJours >= b.min && retardJours <= b.max) || null;
    }

    global.LioraRules = {
        norm, parseDate, stripTime, addDays, diffDays, monthKey,
        DEFAULT_ECHEANCE_RULES, DEFAULT_FALLBACK_RULE,
        BOARD_ROLE_PATTERNS, ROLE_LABELS, SOURCES,
        detectBoardRole, detectFinancement, getRule, computeEcheance,
        GROUPES_EXCLUS, estGroupeTechnique, perimetreDepuisTexte,
        AGING_BUCKETS, bucketFor, MS_DAY,
    };
})(window);
