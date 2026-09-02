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
            label: 'B2C-Entreprise',
            base: 'dateFacture', jours: 30,
            fallback: 'dateDebutFormation', fallbackJours: 30,
            plafondDebutFormation: true,
            // Le classeur de trésorerie compte autrement pour la balance âgée
            // comptable : fin de formation + 60. Les deux suivis ne mesurent
            // pas la même chose — l'un le travail de relance, l'autre le solde
            // du compte — et gardent donc chacun sa règle.
            gl: { base: 'dateFinFormation', jours: 60 },
            note: "Date de facture +30 jours, sans dépasser début de formation +30 jours"
                + " — au grand livre : fin de formation +60 jours",
            categorie: 'B2C - Entreprise', perimetre: 'Corporate',
            // Monday écrit « B2C - Entreprise », le référentiel « BTC-Entreprise ».
            // Les deux graphies désignent la même chose : un particulier dont la
            // formation est facturée à une entreprise. Sans le libellé « b2c
            // entreprise », il était capté par « entreprise » et traité en B2B,
            // donc calculé sur la fin de formation au lieu de la date de facture.
            match: ['b2c entreprise', 'b2c ent', 'btc entreprise', 'btc ent',
                    'b2c corporate', 'btc corporate'],
        },
        {
            // Corporate - Alternance : une alternance facturée à l'entreprise.
            // L'échéance suit celle du B2C-Entreprise — c'est la même
            // facturation — mais le type de client est « Alternance », comme
            // dans le classeur de trésorerie.
            key: 'CORPORATE_ALTERNANCE', label: 'Corporate - Alternance',
            base: 'dateFacture', jours: 30,
            fallback: 'dateDebutFormation', fallbackJours: 30,
            plafondDebutFormation: true,
            gl: { base: 'dateFacture', jours: 30 },
            note: 'Date de facture +30 jours',
            categorie: 'Alternance', perimetre: 'Corporate',
            match: ['corporate alternance', 'corporate-alternance'],
        },
        {
            // Repli corporate. Le tableau des factures payées range ses lignes
            // dans des groupes qui nomment tantôt un financement (Opco, CPF,
            // AIF…), tantôt une étape du circuit corporate — « Factures Payées
            // ADV », « Factures payées avant import + Entre process ADV et
            // recouvrement ». Ces dernières ne disent pas le financement, mais
            // elles disent le périmètre : les laisser en « Non renseigné »
            // faisait perdre cette information, la seule disponible pour une
            // facture réglée avant la mise en place du circuit.
            key: 'CORPORATE', label: 'Corporate — financement à préciser',
            base: 'dateFacture', jours: 30,
            fallback: 'dateFinFormation', fallbackJours: 30,
            note: 'Date de facture +30 jours',
            categorie: 'B2C - Entreprise', perimetre: 'Corporate',
            match: ['avant import', 'entre process', 'factures payees adv', 'payees adv', 'adv'],
        },
        {
            key: 'B2B', label: 'B2B',
            base: 'dateFinFormation', jours: 30,
            fallback: 'dateFacture', fallbackJours: 30,
            gl: { base: 'dateFinFormation', jours: 60 },
            note: 'Fin de formation +30 jours — au grand livre : +60 jours',
            categorie: 'B2B', perimetre: 'Corporate',
            match: ['b2b', 'btob', 'entreprise', 'corporate'],
        },
        {
            key: 'ALTERNANCE', label: 'Alternance',
            base: 'dateFinFormation', jours: 30,
            fallback: 'dateFacture', fallbackJours: 30,
            note: 'Fin de formation +30 jours', categorie: 'Alternance', perimetre: 'Corporate',
            match: ['alternance', 'apprentissage', 'contrat pro'],
        },
        {
            key: 'TRANSITION', label: 'Transition Pro',
            base: 'dateFinFormation', jours: 60,
            fallback: 'dateFacture', fallbackJours: 60,
            note: 'Fin de formation +60 jours', categorie: 'B2C', perimetre: 'B2C',
            match: ['transition pro', 'transitions pro', 'transition', 'ptp', 'projet de transition', 'atpro', 'associations transitions pro'],
        },
        {
            key: 'REGION', label: 'Region',
            base: 'dateFinFormation', jours: 60,
            fallback: 'dateFacture', fallbackJours: 60,
            note: 'Fin de formation +60 jours', categorie: 'B2C', perimetre: 'B2C',
            match: ['region', 'conseil regional', 'regional'],
        },
        {
            // L'AIF est une aide de France Travail : son type de client est
            // POEI, comme la POEI elle-même. C'est la lecture du classeur de
            // trésorerie, pas celle du dispositif.
            key: 'AIF', label: 'AIF',
            base: 'dateFinFormation', jours: 60,
            fallback: 'dateFacture', fallbackJours: 60,
            note: 'Fin de formation +60 jours', categorie: 'POEI', perimetre: 'B2C',
            match: ['aif', 'aide individuelle a la formation', 'pole emploi aif', 'france travail aif'],
        },
        {
            key: 'POEI', label: 'POEI',
            base: 'dateFinFormation', jours: 60,
            fallback: 'dateFacture', fallbackJours: 60,
            note: 'Fin de formation +60 jours', categorie: 'POEI', perimetre: 'B2C',
            match: ['poei', 'poec', 'preparation operationnelle'],
        },
        {
            key: 'AGEFIPH', label: 'Agefiph',
            base: 'dateFinFormation', jours: 60,
            fallback: 'dateFacture', fallbackJours: 60,
            note: 'Fin de formation +60 jours', categorie: 'B2C', perimetre: 'B2C',
            match: ['agefiph', 'fiphfp'],
        },
        {
            key: 'ETAT', label: 'ETAT',
            base: 'dateFinFormation', jours: 30,
            fallback: 'dateFacture', fallbackJours: 30,
            note: 'Fin de formation +30 jours',
            categorie: 'B2C - Entreprise', typesPossibles: ['B2C - Entreprise', 'B2B'],
            perimetre: 'Corporate',
            match: ['etat', 'public etat', 'ministere', 'prefecture'],
        },
        {
            // « Interne », « Interne - UE » : le vocabulaire de Zoho pour les
            // refacturations entre entités du groupe. La correspondance la plus
            // longue l'emportant, « Interne - DST Allemagne » reste capté par
            // sa règle propre.
            key: 'INTERCO', label: 'Interco',
            base: 'dateFinFormation', jours: 60,
            fallback: 'dateFacture', fallbackJours: 60,
            note: 'Fin de formation +60 jours', categorie: 'Interco', perimetre: 'Corporate',
            match: ['interco', 'intercompany', 'inter co', 'intra groupe', 'interne', 'interne ue', 'intra groupe', 'inter societe'],
        },
        {
            key: 'DST_ALLEMAGNE', label: 'Interne - DST Allemagne',
            base: 'dateFinFormation', jours: 60,
            fallback: 'dateFacture', fallbackJours: 60,
            note: 'Fin de formation +60 jours', categorie: 'Interco', perimetre: 'Corporate',
            match: ['dst allemagne', 'interne dst allemagne', 'dst', 'allemagne', 'germany', 'bu1 germany'],
        },
        {
            key: 'OPCO', label: 'OPCO',
            base: 'dateFinFormation', jours: 30,
            fallback: 'dateFacture', fallbackJours: 30,
            note: 'Fin de formation +30 jours — pas de recouvrement OPCO, suivi du retard uniquement',
            categorie: 'B2C - Entreprise', typesPossibles: ['B2C - Entreprise', 'B2B'],
            perimetre: 'Corporate', sansRecouvrement: true,
            match: ['opco', 'akto', 'atlas', 'uniformation', 'ocapiat', 'constructys', 'afdas', 'opcommerce', 'l opcommerce', 'opco ep', 'opco 2i', 'opco mobilites', 'opco sante'],
        },
        {
            // Un OPCO qui finance une alternance : même payeur, autre dispositif.
            key: 'OPCO_ALTERNANCE', label: 'OPCO - Alternance',
            base: 'dateFinFormation', jours: 30,
            fallback: 'dateFacture', fallbackJours: 30,
            note: 'Fin de formation +30 jours — pas de recouvrement OPCO, suivi du retard uniquement',
            categorie: 'Alternance', perimetre: 'Corporate', sansRecouvrement: true,
            match: ['opco alternance', 'opco-alternance'],
        },
        {
            key: 'BTC_PERSO', label: 'B2C-Perso',
            base: 'dateDebutFormation', jours: 0,
            fallback: 'dateFinFormation', fallbackJours: 0,
            note: 'Début de formation (aucun délai supplémentaire)',
            categorie: 'B2C', perimetre: 'B2C',
            // « B2C » employé seul — le groupe « Factures payées B2C » du tableau
            // 0.1, à côté de groupes CPF, AIF, POEI, REGION — désigne le
            // financement personnel : les financements publics ont chacun le
            // leur. « B2C - Entreprise » reste capté par sa règle propre, dont
            // le libellé de correspondance est plus long et l'emporte.
            match: ['b2c perso', 'btc perso', 'financement personnel',
                    'perso', 'personnel', 'fonds propres', 'auto financement', 'autofinancement',
                    'b2c', 'btc'],
        },
        {
            // Perso-Alternance : une alternance que l'apprenant paie lui-même.
            // Elle ne se devine pas — elle ne vaut que là où elle a été posée
            // à la main dans l'ancien grand livre.
            key: 'PERSO_ALTERNANCE', label: 'Perso-Alternance',
            base: 'dateDebutFormation', jours: 0,
            fallback: 'dateFinFormation', fallbackJours: 0,
            note: 'Début de formation (aucun délai supplémentaire)',
            categorie: 'Alternance', perimetre: 'B2C',
            match: ['perso alternance', 'perso-alternance'],
        },
        {
            key: 'CPF', label: 'CPF',
            base: 'dateFinFormation', jours: 60,
            fallback: 'dateFacture', fallbackJours: 60,
            note: 'Fin de formation +60 jours', categorie: 'B2C', perimetre: 'B2C',
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
        // Monday crée un tableau « Sous-éléments de … » pour chaque tableau
        // utilisant des sous-éléments. Ses lignes ne sont pas des factures.
        { role: 'ignore',       perimetre: 'Inconnu',   source: null,            financementDefaut: null,          match: ['sous elements de', 'sous element de', 'subitems of', 'subelements of'] },
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

    /**
     * Étape du traitement, lue dans le libellé du groupe Monday.
     *
     * Le rôle du tableau ne suffit pas : « recouvrement » est chez Liora un
     * groupe autant qu'un tableau. Le CPF a son groupe « Factures CPF
     * recouvrement », le Financement Personnel ses groupes « Recouvrement -
     * En cours de traitement » et « Facture en Contentieux ». S'en tenir au
     * tableau revenait à ne compter que le seul 1.2.
     *
     * L'ordre compte : le premier motif rencontré gagne, du plus spécifique au
     * plus général.
     */
    const ETAPES = [
        { key: 'PAYEE',        label: 'Réglée',             match: ['payee', 'payees', 'paye'] },
        { key: 'CONTENTIEUX',  label: 'Contentieux',        match: ['contentieux', 'huissier', 'judiciaire'] },
        { key: 'PERTE',        label: 'Perdu / partiel',    match: ['perdu', 'partiellement', 'perte', 'irrecouvrable'] },
        { key: 'ANNULER',      label: 'À annuler',          match: ['a annuler', 'annuler', 'annulation', 'avoir'] },
        { key: 'RECOUVREMENT', label: 'Recouvrement',       match: ['recouvrement', 'relance', 'mise en demeure', 'a relancer', 'retraiter'] },
        // Placé avant COMPTA et ADV pour que « Entre process ADV et
        // recouvrement » ne soit pas capté par le mot « recouvrement » qui le
        // termine : ces factures relèvent de l'ADV.
        { key: 'ADV_TRANSIT',  label: 'ADV — entre process', match: ['avant import', 'entre process'] },
        { key: 'COMPTA',       label: 'Comptabilité',       match: ['comptabilit', 'pennylane', 'non pointe', 'non remonte', 'sellsy'] },
        { key: 'PAIEMENT',     label: 'Paiement prévu',     match: ['paiement prevu', 'paiement attendu', 'echeancier'] },
        { key: 'DEPOT',        label: 'Dépôt / déposée',    match: ['a deposer', 'deposee', 'depose', 'depot'] },
        { key: 'ADV',          label: 'ADV à traiter',      match: ['non conforme', 'incomplete', 'incomplet', 'a qualifier',
                                                                   'a reclasser', 'action a faire', 'action fin de formation',
                                                                   'a traiter', 'tampon'] },
        { key: 'EN_COURS',     label: 'En cours',           match: ['en cours', 'en traitement'] },
    ];

    /**
     * @returns {{key:string,label:string}} étape déduite du libellé du groupe.
     *
     * La négation est vérifiée avant tout : le groupe « Factures non payées :
     * Perte / Contentieux » contient le mot « payées » et ressortait donc comme
     * réglé, alors qu'il dit exactement l'inverse.
     */
    function etapeDepuisGroupe(nom) {
        const n = ' ' + norm(nom) + ' ';
        const nie = /non pay|impay|pas pay|non regl|a payer/.test(n);
        for (const e of ETAPES) {
            if (nie && e.key === 'PAYEE') continue;
            if (e.match.some(m => n.includes(m))) return { key: e.key, label: e.label };
        }
        return { key: 'AUTRE', label: 'Non qualifié' };
    }

    /** Sources de retard, utilisées pour les chips de filtrage du dashboard. */
    const SOURCES = [
        // « Recouvrement » seul laissait croire à un circuit unique : le tableau
        // 1.2 ne suit que les entreprises, le B2C n'a pas d'équivalent.
        { key: 'recouvrement', label: 'Recouvrement Corporate', hint: 'Tableau 1.2 — recouvrement Corporate' },
        { key: 'adv',          label: 'ADV / Tampon',  hint: 'Tableaux 1.0 et 1.1 — retard côté ADV' },
        { key: 'opco',         label: 'OPCO',          hint: 'Tableau 1.3 — pas de recouvrement, suivi du retard' },
        { key: 'b2c',          label: 'B2C',           hint: 'Tableaux 2.x — pas de tableau recouvrement dédié' },
    ];

    /**
     * Catégorie de client d'un financement — le niveau au-dessus.
     *
     * C'est le « Type de client » de la facturation : B2C recouvre B2C-Perso,
     * CPF, Transition Pro, AIF, Region et Agefiph. La balance de trésorerie se
     * lit aux deux niveaux, et l'un ne remplace pas l'autre.
     */
    function categorieDe(financement, rules) {
        const r = getRule(financement, rules);
        return r.categorie || r.perimetre || 'Non catégorisé';
    }

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

        // Le grand livre et le suivi recouvrement ne mesurent pas la même
        // chose : l'un le solde du compte, l'autre le travail de relance. Les
        // délais diffèrent donc sur certains dispositifs, et c'est le classeur
        // de trésorerie qui fait foi côté comptable.
        const gl = o.grandLivre === true;

        // ── Les deux cas qui passent avant la règle du dispositif ──
        // Ils ne valent que pour la balance âgée comptable : c'est la règle du
        // classeur de trésorerie, pas celle du suivi de relance.
        //
        // Une facture émise APRÈS la fin de la formation n'est pas une facture
        // d'avance : c'est une régularisation, et le délai court depuis son
        // émission. Sans cela, une formation terminée en 2024 refacturée en
        // 2026 ressortait échue depuis deux ans le jour de son émission.
        if (gl && inv.dateFacture && inv.dateFinFormation && inv.dateFacture > inv.dateFinFormation) {
            return { date: addDays(inv.dateFacture, 60), origine: 'Règle', regle: rule,
                     baseUtilisee: 'dateFacture', motif: 'Facture postérieure à la fin de formation' };
        }
        // Un mandat de prélèvement change la mécanique : l'argent est appelé,
        // il n'y a pas de délai de paiement à accorder. L'échéance est la fin
        // de la formation, sans rien ajouter.
        if (gl && inv.mandatGocardless && inv.dateFinFormation) {
            return { date: stripTime(inv.dateFinFormation), origine: 'Règle', regle: rule,
                     baseUtilisee: 'dateFinFormation', motif: 'Mandat de prélèvement en place' };
        }

        // La base de la règle d'abord. Puis, s'il y en a une, l'échéance que
        // porte le grand livre : c'est ce que fait le classeur de trésorerie,
        // et elle vaut mieux qu'un repli calculé sur la date de facture, qui
        // ne dit rien du dispositif. Le repli de la règle ne sert qu'aux
        // factures Monday, où aucune échéance comptable n'existe.
        const principale = (gl && rule.gl) ? rule.gl : rule;
        const bases = [
            { champ: principale.base, jours: principale.jours },
            { comptable: true },
            { champ: rule.fallback, jours: rule.fallbackJours != null ? rule.fallbackJours : rule.jours },
        ];
        for (const b of bases) {
            if (b.comptable) {
                if (!inv.dateEcheanceComptable) continue;
                return { date: inv.dateEcheanceComptable, origine: 'Grand livre', regle: rule,
                         baseUtilisee: 'dateEcheanceComptable' };
            }
            if (!b.champ) continue;
            const src = inv[b.champ];
            if (!src) continue;
            let date = addDays(src, b.jours || 0);
            let base = b.champ;

            // Garde-fou du suivi de relance : une facture corrigée est réémise,
            // sa date devient récente, et son échéance repart à zéro alors que
            // la créance traîne depuis des mois. Le début de formation, lui, ne
            // bouge pas : il plafonne l'échéance, et ne peut que l'avancer.
            // Au grand livre, c'est la règle « facture postérieure à la fin de
            // formation » qui traite le même biais, autrement.
            if (!gl && rule.plafondDebutFormation && base === 'dateFacture' && inv.dateDebutFormation) {
                const plafond = addDays(inv.dateDebutFormation, b.jours || 0);
                if (plafond < date) { date = plafond; base = 'dateDebutFormation'; }
            }
            return { date, origine: 'Règle', regle: rule, baseUtilisee: base };
        }
        if (inv.dateEcheanceSource) {
            return { date: inv.dateEcheanceSource, origine: 'Monday', regle: rule, baseUtilisee: 'colonne Monday' };
        }
        // Faute de date de formation, l'échéance que porte le grand livre : elle
        // vaut mieux qu'aucune échéance du tout, et c'est ce que fait le
        // classeur de trésorerie.
        if (inv.dateEcheanceComptable) {
            return { date: inv.dateEcheanceComptable, origine: 'Grand livre', regle: rule,
                     baseUtilisee: 'dateEcheanceComptable' };
        }
        return { date: null, origine: null, regle: rule, baseUtilisee: null };
    }

    // ──────────────────────────────────────────────
    //  Tranches de balance âgée
    // ──────────────────────────────────────────────

    /**
     * Tranches d'antériorité de la balance âgée.
     *
     * Reprises telles quelles du tableau de balance âgée déjà utilisé chez
     * Liora, en mois plutôt qu'en jours : l'ancienneté des créances s'y compte
     * en années, et des tranches de trente jours n'y montraient rien. Les
     * bornes sont exprimées en jours pour rester comparables au retard calculé,
     * un mois valant trente jours.
     */
    const M = 30;
    const AGING_BUCKETS = [
        { key: 'nonEchu',  label: 'Non échu',      min: -1e9,    max: 0,        couleur: '#3b82f6' },
        { key: 'm0_3',     label: '0 à 3 mois',    min: 1,       max: 3 * M,    couleur: '#84cc16' },
        { key: 'm3_4',     label: '3 à 4 mois',    min: 3 * M + 1,  max: 4 * M, couleur: '#a3c714' },
        { key: 'm4_6',     label: '4 à 6 mois',    min: 4 * M + 1,  max: 6 * M, couleur: '#eab308' },
        { key: 'm6_12',    label: '6 à 12 mois',   min: 6 * M + 1,  max: 12 * M, couleur: '#f59e0b' },
        { key: 'm12_18',   label: '12 à 18 mois',  min: 12 * M + 1, max: 18 * M, couleur: '#f97316' },
        { key: 'm18_24',   label: '18 à 24 mois',  min: 18 * M + 1, max: 24 * M, couleur: '#F47458' },
        { key: 'm24_36',   label: '24 à 36 mois',  min: 24 * M + 1, max: 36 * M, couleur: '#ef4444' },
        { key: 'm36_48',   label: '36 à 48 mois',  min: 36 * M + 1, max: 48 * M, couleur: '#dc2626' },
        { key: 'm48p',     label: '> 48 mois',     min: 48 * M + 1, max: 1e9,   couleur: '#991b1b' },
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
        ETAPES, etapeDepuisGroupe,
        AGING_BUCKETS, bucketFor, MS_DAY, categorieDe,
    };
})(window);
