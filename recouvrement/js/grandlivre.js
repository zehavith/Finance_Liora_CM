/* ==========================================================
   Liora — Suivi Recouvrement
   grandlivre.js — Lecture d'un grand livre client lettré

     1. Reconnaissance des colonnes comptables
     2. Regroupement par lettrage (compte + lettre)
     3. Ce que chaque groupe dit de la facture : soldée,
        soldée par avoir, partiellement réglée, ouverte
     4. Lecture simple, pour un fichier « numéro + date »

   Un grand livre ne porte pas une ligne par facture mais une
   ligne par écriture : la facture au débit, le règlement au
   crédit, l'avoir au crédit lui aussi. Le règlement bancaire
   ne nomme jamais la facture — c'est la lettre de lettrage,
   au sein d'un même compte client, qui les rattache.

   Lire ce fichier ligne à ligne comme une liste de factures
   réglées revenait à déclarer encaissée toute facture qui y
   apparaît, y compris celles qui n'ont jamais été payées.
   ========================================================== */

(function (global) {
    'use strict';

    const R = global.LioraRules;
    const I = global.LioraIngest;

    // ──────────────────────────────────────────────
    //  1. Colonnes
    // ──────────────────────────────────────────────

    /**
     * Libellés des exports comptables courants (Pennylane, Sage, Cegid).
     *
     * L'ordre compte : le premier alias trouvé gagne, du plus explicite au plus
     * général. « Date » seul arrive en dernier — un grand livre porte plusieurs
     * dates, et celle de l'écriture n'est pas celle de l'échéance.
     */
    const COLONNES = {
        compte:       ['n de compte', 'numero de compte', 'compte', 'compte general', 'compte tiers'],
        libelleCompte:['libelle de compte', 'intitule du compte', 'libelle compte'],
        lettrage:     ['let', 'lettrage', 'lettre', 'code lettrage', 'let ', 'rapprochement'],
        journal:      ['journal', 'code journal', 'jrnl'],
        date:         ['date d ecriture', 'date ecriture', 'date de piece', 'date piece', 'date'],
        numero:       ['n de facture', 'numero de facture', 'numero facture', 'n facture',
                       'n de piece', 'numero de piece', 'piece', 'reference'],
        libelle:      ['libelle de piece', 'libelle piece', 'libelle de ligne', 'libelle', 'intitule'],
        debit:        ['debit', 'montant debit', 'debit eur'],
        credit:       ['credit', 'montant credit', 'credit eur'],
        solde:        ['solde', 'solde progressif'],
        tiers:        ['tiers', 'nom du tiers', 'client', 'raison sociale'],
        dateEcheance: ['date d echeance', 'date echeance', 'echeance'],
    };

    function trouver(entetes, alias) {
        const normalises = entetes.map(h => ({ h, n: R.norm(h) }));
        for (const cible of alias.map(a => R.norm(a))) {
            const exact = normalises.find(x => x.n === cible);
            if (exact) return exact.h;
        }
        for (const cible of alias.map(a => R.norm(a))) {
            const partiel = normalises.find(x => x.n.includes(cible));
            if (partiel) return partiel.h;
        }
        return null;
    }

    function detecterColonnes(entetes) {
        const mapping = {}, pris = new Set();
        for (const [champ, alias] of Object.entries(COLONNES)) {
            const libres = entetes.filter(h => !pris.has(h));
            const col = trouver(libres, alias);
            if (col) { mapping[champ] = col; pris.add(col); }
        }
        return mapping;
    }

    /**
     * Le fichier est-il un grand livre comptable, ou une simple liste de
     * factures réglées ?
     *
     * Le lettrage et les colonnes débit/crédit font la différence : sans eux,
     * il n'y a rien à regrouper et la lecture simple suffit.
     */
    function estComptable(mapping) {
        return !!(mapping.lettrage && (mapping.debit || mapping.credit));
    }

    // ──────────────────────────────────────────────
    //  2. Nature d'une écriture
    // ──────────────────────────────────────────────

    const EST_FACTURE = /^(fact|fct|fa)[-_ ]?/i;
    const EST_AVOIR = /^(avr|av|avo)[-_ ]?/i;

    /** La lettre de lettrage, débarrassée des flèches d'état de Pennylane. */
    function lettreDe(valeur) {
        const s = String(valeur == null ? '' : valeur).replace(/[^A-Za-z0-9]/g, '').trim();
        return s ? s.toUpperCase() : '';
    }

    function nombre(valeur) {
        const v = I.parseMontant(valeur);
        return v == null ? 0 : v;
    }

    // ──────────────────────────────────────────────
    //  3. Lecture comptable
    // ──────────────────────────────────────────────

    const TOLERANCE = 0.01;   // euros — un solde nul à un centime près l'est

    /**
     * Regroupe les écritures par lettrage et en déduit le sort de chaque
     * facture.
     *
     * Un groupe de lettrage, c'est un compte client et une lettre : la facture
     * et ce qui l'a soldée. Le groupe est soldé quand ses débits égalent ses
     * crédits — la définition comptable, valable que le fichier contienne ou
     * non les écritures non lettrées.
     *
     * Trois issues, qui n'ont pas le même sens en recouvrement :
     * — soldée par un règlement : l'argent est rentré ;
     * — soldée par un avoir : la créance a été annulée, rien n'est rentré,
     *   et il n'y a plus rien à relancer ;
     * — partiellement réglée : le groupe ne se solde pas, il reste dû.
     */
    function lireComptable(rows, mapping) {
        const col = (r, champ) => (mapping[champ] ? r[mapping[champ]] : '');

        const groupes = new Map();
        let ignorees = 0;
        for (const r of rows) {
            const lettre = lettreDe(col(r, 'lettrage'));
            const compte = String(col(r, 'compte') || '').trim();
            const debit = nombre(col(r, 'debit'));
            const credit = nombre(col(r, 'credit'));
            const numero = String(col(r, 'numero') || '').trim();
            const date = R.parseDate(col(r, 'date'));

            // Sans lettrage, l'écriture n'est rattachée à rien : elle ne peut ni
            // solder une facture ni en désigner une. Elle est comptée pour que
            // le total du fichier reste vérifiable.
            if (!lettre || !compte) { ignorees++; continue; }

            const cle = compte + '|' + lettre;
            let g = groupes.get(cle);
            if (!g) {
                g = { cle, compte, lettre, tiers: '', debit: 0, credit: 0,
                      factures: [], avoirs: [], reglements: [] };
                groupes.set(cle, g);
            }
            if (!g.tiers) g.tiers = String(col(r, 'tiers') || col(r, 'libelleCompte') || '').trim();
            g.debit += debit;
            g.credit += credit;

            const ligne = {
                numero, date, debit, credit,
                journal: String(col(r, 'journal') || '').trim(),
                libelle: String(col(r, 'libelle') || '').trim(),
                dateEcheance: R.parseDate(col(r, 'dateEcheance')),
            };

            // Une facture est un débit portant un numéro de facture ; un avoir
            // un crédit portant un numéro d'avoir. Tout autre crédit est un
            // règlement — le virement bancaire ne nomme jamais la facture.
            if (debit > 0 && EST_FACTURE.test(numero)) g.factures.push(ligne);
            else if (credit > 0 && EST_AVOIR.test(numero)) g.avoirs.push(ligne);
            else if (credit > 0) g.reglements.push(ligne);
        }

        const derniere = lignes => lignes.reduce(
            (max, l) => (l.date && (!max || l.date > max)) ? l.date : max, null);

        const resultats = [];
        for (const g of groupes.values()) {
            const solde = g.debit - g.credit;
            g.soldee = Math.abs(solde) < TOLERANCE;
            g.reste = g.soldee ? 0 : solde;
            g.creditReglements = g.reglements.reduce((s, l) => s + l.credit, 0);
            g.creditAvoirs = g.avoirs.reduce((s, l) => s + l.credit, 0);
            g.dateReglement = derniere(g.reglements);
            g.dateAvoir = derniere(g.avoirs);
            // Soldée sans qu'aucun règlement n'y contribue : c'est un avoir qui
            // a fait disparaître la créance. L'argent n'est pas rentré.
            g.parAvoir = g.soldee && g.creditReglements < TOLERANCE && g.creditAvoirs > 0;

            for (const f of g.factures) {
                resultats.push({
                    numero: f.numero,
                    cle: I.factureKey(f.numero),
                    compte: g.compte,
                    lettre: g.lettre,
                    tiers: g.tiers,
                    montant: f.debit,
                    dateFacture: f.date,
                    dateEcheance: f.dateEcheance,
                    soldee: g.soldee,
                    parAvoir: g.parAvoir,
                    // Sur un groupe à facture unique, le montant réglé est
                    // exact. À plusieurs, il n'est pas attribuable : mieux vaut
                    // ne rien dire que répartir au hasard.
                    montantRegle: g.factures.length === 1
                        ? Math.min(g.creditReglements, f.debit) : null,
                    datePaiement: g.parAvoir ? null : g.dateReglement,
                    dateAvoir: g.parAvoir ? g.dateAvoir : null,
                    resteGroupe: g.reste,
                    nbFacturesGroupe: g.factures.length,
                    avoirs: g.avoirs.map(a => a.numero).filter(Boolean),
                });
            }
        }

        return { lignes: resultats, groupes: [...groupes.values()], ignorees, comptable: true };
    }

    // ──────────────────────────────────────────────
    //  4. Lecture simple
    // ──────────────────────────────────────────────

    /**
     * Fichier « une ligne par facture réglée » : un numéro, une date.
     *
     * Conservée pour les extraits pointés à la main, qui n'ont ni lettrage ni
     * colonnes débit/crédit.
     */
    function lireSimple(rows, entetes) {
        const cols = entetes.map(h => ({ id: h, title: h }));
        const map = I.autoMapColumns(cols);
        const colNum = map.numero, colDate = map.datePaiement || map.dateFacture, colMt = map.montant;
        if (!colNum || !colDate) {
            return { lignes: [], groupes: [], ignorees: rows.length, comptable: false,
                     erreur: 'Colonnes « numéro de facture » et « date de règlement » introuvables.' };
        }
        const lignes = [];
        for (const r of rows) {
            const numero = String(r[colNum] || '').trim();
            const cle = I.factureKey(numero);
            if (!cle) continue;
            lignes.push({
                numero, cle,
                datePaiement: R.parseDate(r[colDate]),
                montantRegle: colMt ? I.parseMontant(r[colMt]) : null,
                // Un fichier de règlements pointés ne liste que des factures
                // soldées : c'est sa raison d'être.
                soldee: true, parAvoir: false, montant: null,
                dateFacture: null, dateEcheance: null, avoirs: [],
            });
        }
        return { lignes, groupes: [], ignorees: rows.length - lignes.length, comptable: false };
    }

    /**
     * Lit un grand livre, comptable ou simple.
     *
     * @param {Array<Object>} rows  lignes telles que lues du CSV / XLSX
     */
    function lire(rows) {
        if (!rows || !rows.length) {
            return { lignes: [], groupes: [], ignorees: 0, comptable: false, mapping: {}, entetes: [] };
        }
        const entetes = Object.keys(rows[0]);
        const mapping = detecterColonnes(entetes);
        const res = estComptable(mapping) ? lireComptable(rows, mapping) : lireSimple(rows, entetes);
        return { ...res, mapping, entetes, nbLignes: rows.length,
                 stats: statistiques(res, rows.length) };
    }

    function statistiques(res, nbLignes) {
        const l = res.lignes;
        const soldees = l.filter(x => x.soldee);
        return {
            nbLignes,
            nbFactures: l.length,
            nbSoldees: soldees.length,
            nbSoldeesParReglement: soldees.filter(x => !x.parAvoir).length,
            nbSoldeesParAvoir: soldees.filter(x => x.parAvoir).length,
            nbOuvertes: l.length - soldees.length,
            eurosOuverts: l.filter(x => !x.soldee)
                .reduce((s, x) => s + (x.resteGroupe > 0 ? x.resteGroupe : 0), 0),
            nbGroupes: res.groupes.length,
            nbSansDate: soldees.filter(x => !x.parAvoir && !x.datePaiement).length,
            ignorees: res.ignorees,
            comptable: !!res.comptable,
        };
    }

    global.LioraGrandLivre = {
        COLONNES, TOLERANCE, EST_FACTURE, EST_AVOIR,
        detecterColonnes, estComptable, lettreDe, lire, lireComptable, lireSimple,
    };
})(window);
