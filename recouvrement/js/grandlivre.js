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
        // Le libellé de ligne porte souvent le numéro de facture que la colonne
        // dédiée laisse vide : sur un extrait réel, il en révèle 5 862 de plus
        // que les 3 756 déjà nommées, soit deux fois et demie plus.
        libelleLigne: ['libelle de ligne', 'libelle ligne', 'detail', 'libelle ecriture'],
        // L'identifiant du tiers est plus stable que le numéro de compte pour
        // reconnaître un client d'un extrait à l'autre.
        identifiantTiers: ['identifiant du tiers', 'id tiers', 'identifiant tiers', 'code tiers'],
        // Un extrait déjà qualifié porte sa propre réponse : la sous-catégorie
        // est le financement, plus fine que le type de client — « B2C » couvre
        // aussi bien BTC-Perso que CPF, Transition Pro, AIF ou Agefiph.
        sousCategorie: ['sous categorie de type de client', 'sous categorie type de client',
                        'sous categorie', 'sous type de facture', 'sous type'],
        typeClient:   ['type de client', 'type client', 'typologie client'],
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

    // Le journal où sont passées les factures de vente. Une écriture au débit
    // qui en vient est une facture, même si son numéro a dû être lu au libellé.
    const JOURNAL_VENTE = /^(vt|ve|vte|vent)/i;

    // Les mêmes préfixes que MOTIFS_NUMERO : « FCAT-2312-00417 » n'était
    // reconnu nulle part, l'écriture était perdue, et sa créance se retrouvait
    // sans numéro, sans montant et sans date — donc vieillie en « Non échu ».
    const EST_FACTURE = /^(fact|fcat|fct|fa)[-_ ]?/i;
    const EST_AVOIR = /^(avr|av|avo)[-_ ]?/i;

    /**
     * Formes de numéro réellement émises chez Liora.
     *
     * Les motifs sont bornés — quatre chiffres d'année-mois, puis le rang — pour
     * ne pas happer ce qui suit : sans bornes, un libellé de virement collait
     * l'identifiant de la transaction au numéro et le rendait inutilisable.
     */
    const MOTIFS_NUMERO = [
        /\bFACT[-_ ]?\d{4}[-_ ]?\d{4,6}\b/ig,               // FACT-2407-04923
        /\bFCT(?:[-_][A-Z]{2,8}){1,3}[-_]\d{4}[-_]\d{1,6}\b/ig, // FCT-FILIZ-DST-2025-276
        /\bAVR[-_ ]?\d{4}[-_ ]?\d{4,6}\b/ig,                // AVR-2512-02297
        /\bFCAT[-_ ]?\d{4}[-_ ]?\d{4,6}\b/ig,
        /\bFA[-_ ]?\d{3,4}[-_ ]?\d{3,6}\b/ig,               // FA-880-0097
    ];

    /**
     * Retrouve un numéro de facture dans un texte libre.
     *
     * Le règlement bancaire ne remplit pas la colonne « N° de facture », mais
     * son libellé cite très souvent la facture qu'il paie — « /RNF ALMA … 
     * FACT-2504-09118 ». Sans cette lecture, deux écritures sur trois restaient
     * anonymes et ne pouvaient ni solder une facture ni être classées.
     *
     * @param {string} txt
     * @param {Set<string>} [connus]  clés des numéros existants. Fournies, un
     *   candidat reconnu l'emporte sur un candidat seulement plausible.
     */
    function candidatsNumero(txt) {
        const s = String(txt == null ? '' : txt).toUpperCase();
        if (!s) return [];
        const trouves = [];
        for (const re of MOTIFS_NUMERO) {
            re.lastIndex = 0;
            let m;
            while ((m = re.exec(s)) !== null) trouves.push({ pos: m.index, val: m[0].trim() });
        }
        // Dans l'ordre du texte, et non dans l'ordre des motifs : « AVOIR
        // AVR-2512-02297 ANNULATION FACT-2504-09118 » nomme d'abord l'avoir,
        // et c'est l'avoir qui est l'identité de cette écriture.
        trouves.sort((a, b) => a.pos - b.pos);
        const vus = new Set();
        return trouves.filter(t => (vus.has(t.val) ? false : vus.add(t.val))).map(t => t.val);
    }

    function numeroDepuisTexte(txt, connus, prefere) {
        const candidats = candidatsNumero(txt);
        if (!candidats.length) return '';
        // Une préférence explicite passe avant tout : sur une écriture au
        // crédit, un numéro d'avoir dit ce qu'est la ligne, alors que le numéro
        // de facture ne dit que ce qu'elle vise.
        if (prefere) { const p = candidats.find(prefere); if (p) return p; }
        if (connus && connus.size) {
            for (const c of candidats) if (connus.has(I.factureKey(c))) return c;
        }
        return candidats[0];
    }

    /**
     * La lettre de lettrage, débarrassée des flèches d'état de Pennylane.
     *
     * La casse est conservée : Pennylane émet aussi bien « a » que « A », et ce
     * sont deux codes différents. Les confondre fusionnerait deux lettrages
     * sans rapport, dont les débits et crédits s'équilibreraient par accident.
     */
    function lettreDe(valeur) {
        return String(valeur == null ? '' : valeur).replace(/[^A-Za-z0-9]/g, '').trim();
    }

    /**
     * Clé du pool non lettré d'un compte.
     *
     * Une écriture sans lettre n'est rattachée à aucune facture en particulier,
     * mais elle pèse bel et bien sur le compte : c'est même toute la matière
     * d'un extrait « non lettré », où les créances vivantes n'ont par
     * définition pas encore été rapprochées. Les écarter, comme le faisait la
     * première version, revenait à ne rien trouver dans le fichier fait pour
     * les montrer. Elles sont donc regroupées par compte — le solde non lettré
     * du client, au sens comptable.
     */
    const POOL_NON_LETTRE = '(non lettré)';

    /**
     * Valeur en texte, sans notation scientifique.
     *
     * Un identifiant lu en nombre — numéro de compte, identifiant de tiers —
     * doit garder tous ses chiffres. String() d'un entier le fait ; le format
     * d'affichage de la cellule, non.
     */
    function texteBrut(v) {
        if (v == null) return '';
        if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(v);
        return String(v).trim();
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
    function lireComptable(rows, mapping, opts) {
        const o = opts || {};
        const connus = o.numerosConnus;
        const col = (r, champ) => (mapping[champ] ? r[mapping[champ]] : '');

        const sansColonneNumero = !mapping.numero;
        const groupes = new Map();
        let ignorees = 0, numerosExtraits = 0;
        for (const r of rows) {
            const lettre = lettreDe(col(r, 'lettrage'));
            // Un numéro de compte lu en nombre doit revenir en texte sans
            // notation scientifique : String(4110600400000) le fait, mais pas
            // le format d'affichage de la cellule.
            const compte = texteBrut(col(r, 'compte'));
            const debit = nombre(col(r, 'debit'));
            const credit = nombre(col(r, 'credit'));
            const date = R.parseDate(col(r, 'date'));

            // Le numéro porté par sa colonne d'abord ; à défaut, celui que cite
            // le libellé — c'est ainsi que se rattache un règlement bancaire.
            let numero = texteBrut(col(r, 'numero'));
            let numeroExtrait = false;
            if (!numero) {
                // Au crédit, l'avoir cité l'emporte sur la facture citée :
                // « AVOIR AVR-… ANNULATION FACT-… » est un avoir, pas un
                // règlement de la facture qu'il annule.
                const prefere = (credit > 0 && !debit) ? (c => EST_AVOIR.test(c)) : null;
                numero = numeroDepuisTexte(col(r, 'libelleLigne'), connus, prefere)
                    || numeroDepuisTexte(col(r, 'libelle'), connus, prefere);
                if (numero) { numeroExtrait = true; numerosExtraits++; }
            }

            // Qualification déjà portée par le fichier : la sous-catégorie est
            // le financement, le type de client ne l'est qu'à défaut.
            const qualif = String(col(r, 'sousCategorie') || '').trim()
                || String(col(r, 'typeClient') || '').trim();

            // Sans compte, l'écriture n'appartient à personne : rien à en tirer.
            // Sans lettre, en revanche, elle rejoint le pool non lettré de son
            // compte — c'est là que vivent les créances non encore rapprochées.
            if (!compte) { ignorees++; continue; }
            const groupe = lettre || POOL_NON_LETTRE;

            const cle = compte + '|' + groupe;
            let g = groupes.get(cle);
            if (!g) {
                g = { cle, compte, lettre: groupe, nonLettre: !lettre,
                      tiers: '', debit: 0, credit: 0,
                      factures: [], avoirs: [], reglements: [], autres: [] };
                groupes.set(cle, g);
            }
            if (!g.tiers) g.tiers = String(col(r, 'tiers') || col(r, 'libelleCompte') || '').trim();
            if (!g.identifiantTiers) g.identifiantTiers = texteBrut(col(r, 'identifiantTiers'));
            if (!g.qualif && qualif) g.qualif = qualif;
            g.debit += debit;
            g.credit += credit;

            const journal = String(col(r, 'journal') || '').trim();
            const ligne = {
                numero, numeroExtrait, qualif, date, debit, credit, journal,
                libelle: String(col(r, 'libelle') || '').trim(),
                dateEcheance: R.parseDate(col(r, 'dateEcheance')),
            };

            // Une facture est un débit portant un numéro de facture ; un avoir
            // un crédit portant un numéro d'avoir. Tout autre crédit est un
            // règlement — le virement bancaire ne nomme jamais la facture.
            //
            // Encore faut-il que le numéro soit celui de l'écriture. Un débit
            // dont le numéro n'a été que deviné dans un libellé — rejet de
            // prélèvement, contre-passation, pénalité — cite la facture sans
            // en être une : la prendre pour telle créerait une seconde facture
            // au même numéro et couperait en deux le reste dû de la vraie.
            // Deux exceptions : le journal de ventes, où seules des factures
            // sont passées, et le fichier sans colonne de numéro, où tout
            // numéro vient forcément du libellé.
            const facture = EST_FACTURE.test(numero) && (!numeroExtrait
                || sansColonneNumero || JOURNAL_VENTE.test(journal));
            if (debit > 0 && facture) g.factures.push(ligne);
            else if (credit > 0 && EST_AVOIR.test(numero)) g.avoirs.push(ligne);
            else if (credit > 0) g.reglements.push(ligne);
            else if (debit > 0) g.autres.push(ligne);
        }

        const derniere = lignes => lignes.reduce(
            (max, l) => (l.date && (!max || l.date > max)) ? l.date : max, null);

        const resultats = [];
        for (const g of groupes.values()) {
            const solde = g.debit - g.credit;
            // Un pool non lettré n'est pas un lettrage : ses écritures ne se
            // répondent pas deux à deux. Que son solde tombe à zéro ne prouve
            // rien — un acompte sans rapport suffit — et déclarer soldée une
            // créance vivante est exactement l'erreur que ce module existe pour
            // éviter. Le pool sert au solde du compte, pas au lettrage.
            g.soldee = !g.nonLettre && Math.abs(solde) < TOLERANCE;
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
                    numeroExtrait: f.numeroExtrait,
                    qualif: f.qualif || g.qualif || '',
                    cle: I.factureKey(f.numero),
                    identifiantTiers: g.identifiantTiers || '',
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
                    // Ce qu'un avoir a effacé sur cette facture : sur un groupe
                    // à facture unique, c'est exact ; à plusieurs, ce n'est pas
                    // attribuable et mieux vaut ne rien dire.
                    montantAvoir: g.factures.length === 1
                        ? Math.min(g.creditAvoirs, f.debit) : null,
                    datePaiement: g.parAvoir ? null : g.dateReglement,
                    dateAvoir: g.parAvoir ? g.dateAvoir : null,
                    resteGroupe: g.reste,
                    nbFacturesGroupe: g.factures.length,
                    avoirs: g.avoirs.map(a => a.numero).filter(Boolean),
                });
            }
        }

        return { lignes: resultats, groupes: [...groupes.values()], ignorees,
                 numerosExtraits, comptable: true };
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
    function lire(rows, opts) {
        if (!rows || !rows.length) {
            return { lignes: [], groupes: [], ignorees: 0, comptable: false, mapping: {}, entetes: [] };
        }
        const entetes = Object.keys(rows[0]);
        const mapping = detecterColonnes(entetes);
        const res = estComptable(mapping)
            ? lireComptable(rows, mapping, opts) : lireSimple(rows, entetes);
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
            // Le reste d'un groupe appartient au groupe, pas à chacune de ses
            // factures : le sommer par facture le comptait autant de fois qu'il
            // y en avait, et affichait des milliards sur un extrait réel.
            eurosOuverts: (res.groupes || []).reduce(
                (s, g) => s + (g.soldee ? 0 : Math.max(0, g.debit - g.credit)), 0),
            nbGroupes: res.groupes.length,
            nbSansDate: soldees.filter(x => !x.parAvoir && !x.datePaiement).length,
            ignorees: res.ignorees,
            numerosExtraits: res.numerosExtraits || 0,
            comptable: !!res.comptable,
        };
    }

    // ──────────────────────────────────────────────
    //  5. Balance âgée comptable
    // ──────────────────────────────────────────────

    /**
     * Ce qui reste dû d'après le grand livre.
     *
     * Une facture est ouverte quand son groupe de lettrage ne se solde pas —
     * ou qu'elle n'est pas lettrée du tout, ce qui est le cas d'un extrait
     * « non lettré » où figurent précisément les créances vivantes. Le reste
     * dû est alors le solde du groupe.
     *
     * Les écritures sans numéro de facture ne disparaissent pas pour autant :
     * un acompte encaissé d'avance, un écart de règlement, tout crédit non
     * rattaché pèse sur le solde du compte. Ils sont regroupés sous le compte
     * client, sans numéro — sinon le total comptable ne se retrouve pas.
     */
    function creancesOuvertes(lu) {
        const ouvertes = [];
        for (const g of lu.groupes) {
            if (g.soldee) continue;
            const reste = g.debit - g.credit;
            if (Math.abs(reste) < TOLERANCE) continue;

            if (g.factures.length) {
                // Le solde se répartit sur les factures du groupe au prorata de
                // leur montant : à facture unique c'est exact, à plusieurs
                // c'est la seule répartition qui conserve le total.
                const total = g.factures.reduce((s, f) => s + f.debit, 0) || 1;
                for (const f of g.factures) {
                    ouvertes.push({
                        numero: f.numero, cle: I.factureKey(f.numero),
                        qualif: f.qualif || g.qualif || '',
                        identifiantTiers: g.identifiantTiers || '',
                        compte: g.compte, tiers: g.tiers, lettre: g.lettre,
                        montant: f.debit,
                        resteDu: reste * (f.debit / total),
                        dateFacture: f.date,
                        dateEcheance: f.dateEcheance || null,
                        libelle: f.libelle || '',
                        journal: f.journal || '',
                        sansNumero: false,
                    });
                }
            } else {
                ouvertes.push({
                    numero: '', cle: null,
                    qualif: g.qualif || '',
                    identifiantTiers: g.identifiantTiers || '',
                    compte: g.compte, tiers: g.tiers, lettre: g.lettre,
                    montant: null, resteDu: reste,
                    // Ce sont les débits qui créent la dette : leur date fait
                    // l'ancienneté. À défaut seulement, le dernier mouvement.
                    dateFacture: derniereDate(g.autres.length ? g.autres
                        : g.reglements.concat(g.avoirs)),
                    dateEcheance: null,
                    libelle: libelleRepresentatif(g),
                    journal: '',
                    sansNumero: true,
                });
            }
        }
        return ouvertes;
    }

    // Un groupe sans facture n'a pas de libellé unique : on retient celui de
    // l'écriture la plus récente, c'est lui qui décrit l'opération en cours.
    function libelleRepresentatif(g) {
        const lignes = g.reglements.concat(g.avoirs, g.factures)
            .filter(l => l.libelle);
        if (!lignes.length) return '';
        return lignes.reduce(
            (max, l) => (l.date && (!max.date || l.date > max.date)) ? l : max, lignes[0]).libelle;
    }

    function derniereDate(lignes) {
        return lignes.reduce((max, l) => (l.date && (!max || l.date > max)) ? l.date : max, null);
    }

    /**
     * Attribue un type de financement à une créance du grand livre.
     *
     * Le grand livre ne connaît pas les dispositifs : il ne porte qu'un compte
     * et un numéro. La classification se fait donc par recoupement, du plus sûr
     * au moins sûr, et **ce qui n'est pas sûr n'est pas deviné** — il part dans
     * « À classer », où il se voit et se corrige, plutôt que de fausser
     * silencieusement une catégorie.
     *
     * @param {Object} sources
     *   - factures : les factures Monday (financement établi par les règles)
     *   - sellsy   : lignes de l'export Sellsy (Type de client)
     *   - rules    : règles d'échéance, pour la reconnaissance des libellés
     */
    function indexerClassification(sources) {
        const o = sources || {};
        const parCle = new Map();       // numéro de facture Monday → financement
        const parSellsy = new Map();    // numéro de facture Sellsy → financement
        const parCompte = new Map();    // compte client → { fin: nb }
        const parTiers = new Map();     // identifiant du tiers → { fin: nb }

        const compter = (carte, cle, fin) => {
            if (!cle || !fin) return;
            let m = carte.get(cle);
            if (!m) { m = new Map(); carte.set(cle, m); }
            m.set(fin, (m.get(fin) || 0) + 1);
        };
        const noter = (compte, fin, tiers) => {
            compter(parCompte, compte, fin);
            compter(parTiers, tiers, fin);
        };

        // 1. Monday : le financement y est établi par les règles métier.
        for (const f of (o.factures || [])) {
            if (f.cle && f.financement && f.financement !== 'CORPORATE') parCle.set(f.cle, f.financement);
        }
        // 2. Sellsy : « Type de client » nomme le dispositif pour toutes les
        //    factures émises, y compris celles que Monday ne suit pas.
        //    Elle vient après le référentiel qualifié, qui est du travail
        //    validé à la main : Sellsy décrit un client, le référentiel tranche
        //    une facture.
        for (const l of (o.sellsy || [])) {
            if (!l.cle || parCle.has(l.cle)) continue;
            const fin = R.detectFinancement(l.typeClient, o.rules);
            if (fin) parSellsy.set(l.cle, fin);
        }
        return { parCle, parSellsy, parCompte, parTiers, noter };
    }

    /**
     * Classe les créances, puis propage par compte client.
     *
     * Un compte client dont toutes les factures connues relèvent du même
     * dispositif désigne ce dispositif pour ses factures inconnues : c'est la
     * classification que porte l'historique du grand livre. Un compte partagé
     * entre plusieurs dispositifs ne tranche rien — ses inconnues restent à
     * classer.
     */
    function classer(ouvertes, sources) {
        const o = sources || {};
        const idx = indexerClassification(o);
        const ref = o.referentiel || {};

        // La qualification que porte le fichier courant n'est pas une
        // référence : sur l'extrait de septembre, elle venait d'une ancienne
        // balance collée à côté, et ne valait donc que pour la période
        // précédente. Elle est retenue — elle a le mérite d'exister — mais
        // derrière les sources qui font foi, et son origine est nommée pour
        // qu'elle se vérifie.
        // Ce que porte le fichier courant, et ce que portaient les fichiers
        // précédents, sont de même nature : lus, non vérifiés.
        const propre = c => (c.qualif ? R.detectFinancement(c.qualif, o.rules) : null)
            || entree(c, 'fichier');
        // Le référentiel, lui, ne fait foi que pour ce qui y a été validé à la
        // main : c'est le travail déjà fait qui se réutilise. Ce qu'un fichier
        // y a seulement déposé reste marqué comme tel et passe bien plus bas —
        // une colonne de qualification collée d'un ancien tableau n'est pas une
        // référence, elle est une piste.
        const entree = (c, source) => {
            const v = c.cle ? ref[c.cle] : null;
            if (!v) return null;
            // Format historique : une simple chaîne, qui valait pour du validé.
            const src = typeof v === 'string' ? 'valide' : (v.source || 'valide');
            const fin = typeof v === 'string' ? v : v.fin;
            return src === source ? (fin || null) : null;
        };
        const duReferentiel = c => entree(c, 'valide');
        // Les règles écrites à la main passent juste après ce qui est établi
        // facture par facture : elles sont délibérées, mais un rapprochement
        // nominatif reste plus précis qu'un motif.
        const desRegles = c => {
            const hit = financementParRegles(c, o.regles);
            return hit ? hit : null;
        };

        // Apprentissage : ce que chaque compte et chaque tiers contiennent de
        // déjà classé, quelle qu'en soit la source.
        for (const c of ouvertes) {
            const parRegle = desRegles(c);
            const fin = (c.cle ? idx.parCle.get(c.cle) : null) || duReferentiel(c)
                || (parRegle && parRegle.financement)
                || (c.cle ? idx.parSellsy.get(c.cle) : null) || propre(c);
            if (fin) idx.noter(c.compte, fin, c.identifiantTiers);
        }
        for (const l of (o.historique || [])) {
            const fin = l.cle ? idx.parCle.get(l.cle) : null;
            if (fin) idx.noter(l.compte, fin, l.identifiantTiers);
        }

        // Une clé ne tranche que si elle ne connaît qu'un seul financement :
        // un compte partagé entre deux dispositifs ne prouve rien.
        const unique = (carte, cle) => {
            const m = cle ? carte.get(cle) : null;
            return (m && m.size === 1) ? [...m.keys()][0] : null;
        };

        return ouvertes.map(c => {
            const direct = c.cle ? idx.parCle.get(c.cle) : null;
            if (direct) return { ...c, financement: direct, origineClassement: 'Facture' };
            const refFin = duReferentiel(c);
            if (refFin) return { ...c, financement: refFin, origineClassement: 'Référentiel qualifié' };
            const parRegle = desRegles(c);
            if (parRegle) return { ...c, financement: parRegle.financement,
                origineClassement: 'Règle : ' + etiquetteRegle(parRegle.regle) };
            const sellsy = c.cle ? idx.parSellsy.get(c.cle) : null;
            if (sellsy) return { ...c, financement: sellsy, origineClassement: 'Type de client (facturation)' };
            const fichier = propre(c);
            if (fichier) return { ...c, financement: fichier, origineClassement: 'Héritée du fichier (à vérifier)' };
            const tiers = unique(idx.parTiers, c.identifiantTiers);
            if (tiers) return { ...c, financement: tiers, origineClassement: 'Identifiant du tiers' };
            const compte = unique(idx.parCompte, c.compte);
            if (compte) return { ...c, financement: compte, origineClassement: 'Compte client' };
            return { ...c, financement: null, origineClassement: null };
        });
    }

    const A_CLASSER = '__A_CLASSER__';

    // ──────────────────────────────────────────────
    //  Règles de classement écrites à la main
    // ──────────────────────────────────────────────

    /**
     * Champs sur lesquels une règle peut porter.
     *
     * Le libellé est le plus riche — c'est là que figurent « ALMA », « CPF »,
     * le nom du dossier — mais aussi le plus bruyant ; le compte et
     * l'identifiant du tiers sont sûrs mais ne valent que pour un client.
     */
    const CHAMPS_REGLE = [
        { cle: 'tiers',   label: 'Nom du client',        valeur: c => c.tiers },
        { cle: 'compte',  label: 'N° de compte',         valeur: c => c.compte },
        { cle: 'idTiers', label: 'Identifiant du tiers', valeur: c => c.identifiantTiers },
        { cle: 'numero',  label: 'N° de facture',        valeur: c => c.numero },
        { cle: 'libelle', label: 'Libellé de l’écriture', valeur: c => c.libelle },
    ];

    const OPERATEURS = [
        { cle: 'contient',   label: 'contient',       test: (v, m) => v.includes(m) },
        { cle: 'commence',   label: 'commence par',   test: (v, m) => v.startsWith(m) },
        { cle: 'finit',      label: 'finit par',      test: (v, m) => v.endsWith(m) },
        { cle: 'egal',       label: 'est exactement', test: (v, m) => v === m },
    ];

    /**
     * Une règle s'applique-t-elle à cette créance ?
     *
     * La comparaison passe par la normalisation maison : sans accents, sans
     * ponctuation, en minuscules. « Clients - Alma » trouve « alma », et une
     * règle écrite en majuscules marche aussi.
     */
    function regleCorrespond(regle, creance) {
        const champ = CHAMPS_REGLE.find(c => c.cle === regle.champ);
        const op = OPERATEURS.find(o => o.cle === regle.operateur);
        if (!champ || !op || !regle.valeur) return false;
        const v = R.norm(champ.valeur(creance) || '');
        const m = R.norm(regle.valeur);
        return !!v && !!m && op.test(v, m);
    }

    /**
     * Le financement qu'imposent les règles écrites, s'il y en a un.
     *
     * L'ordre de la liste fait la priorité : la première règle qui correspond
     * l'emporte, comme dans un jeu de règles de classement bancaire. Une règle
     * plus précise se place donc au-dessus.
     */
    function financementParRegles(creance, regles) {
        for (const r of (regles || [])) {
            if (r.actif === false) continue;
            if (regleCorrespond(r, creance)) return { financement: r.financement, regle: r };
        }
        return null;
    }

    /** Combien de créances chaque règle toucherait, pour l'écrire en connaissance de cause. */
    function porteeDesRegles(creances, regles) {
        return (regles || []).map(r => {
            const touchees = (creances || []).filter(c => regleCorrespond(r, c));
            return { regle: r, nb: touchees.length, euros: touchees.reduce((s, c) => s + (c.resteDu || 0), 0) };
        });
    }


    /**
     * Balance âgée comptable : le reste dû ventilé par financement et par
     * ancienneté, dans la présentation du tableau de trésorerie.
     *
     * L'ancienneté se compte sur la date d'échéance quand le grand livre la
     * porte, à défaut sur la date de facture — une créance sans aucune des deux
     * ne peut pas être vieillie et rejoint « Non échu », faute de mieux, mais
     * elle est comptée à part.
     */
    function balanceAgee(creances, dateRef, rules, niveau) {
        const ref = dateRef || R.stripTime(new Date());
        const parCategorie = niveau === 'categorie';
        const lignes = new Map();
        let sansDate = 0;

        for (const c of creances) {
            // Deux lectures du même reste dû : par financement — le détail —
            // ou par catégorie de client, le niveau du tableau de trésorerie.
            const cle = !c.financement ? A_CLASSER
                : parCategorie ? R.categorieDe(c.financement, rules) : c.financement;
            let l = lignes.get(cle);
            if (!l) {
                l = { financement: parCategorie ? null : c.financement, cle,
                      label: !c.financement ? 'À classer'
                          : parCategorie ? cle : R.getRule(c.financement, rules).label,
                      total: 0, echu: 0, nonEchu: 0, nb: 0, crediteur: 0, nbCrediteur: 0,
                      buckets: {}, creances: [] };
                for (const b of R.AGING_BUCKETS) l.buckets[b.key] = 0;
                lignes.set(cle, l);
            }
            const base = c.dateEcheance || c.dateFacture;
            if (!base) sansDate++;
            const retard = base ? R.diffDays(ref, base) : 0;
            const bucket = R.bucketFor(retard) || R.AGING_BUCKETS[0];

            l.nb++;
            l.total += c.resteDu;
            // Un solde créditeur — acompte, trop-perçu, avoir non imputé — n'est
            // pas une créance vieillie : c'est de l'argent déjà reçu. Le ranger
            // dans la tranche d'ancienneté de sa facture l'y soustrairait et
            // effacerait des arriérés bien réels. Il compte dans le total, qui
            // reste le solde du compte, mais à part dans les tranches.
            if (c.resteDu < 0) {
                l.crediteur += c.resteDu;
                l.nbCrediteur++;
                l.creances.push({ ...c, retardJours: retard, bucket: 'crediteur' });
                continue;
            }
            l.buckets[bucket.key] += c.resteDu;
            if (retard > 0) l.echu += c.resteDu; else l.nonEchu += c.resteDu;
            l.creances.push({ ...c, retardJours: retard, bucket: bucket.key });
        }

        const rows = [...lignes.values()].sort((a, b) => {
            // « À classer » ferme la marche : c'est un reste, pas une catégorie.
            if (a.cle === A_CLASSER) return 1;
            if (b.cle === A_CLASSER) return -1;
            return b.total - a.total;
        });

        const total = { label: 'TOTAL', cle: '__TOTAL__', total: 0, echu: 0, nonEchu: 0, nb: 0,
                        crediteur: 0, nbCrediteur: 0, buckets: {} };
        for (const b of R.AGING_BUCKETS) total.buckets[b.key] = 0;
        for (const r of rows) {
            total.total += r.total; total.echu += r.echu; total.nonEchu += r.nonEchu; total.nb += r.nb;
            total.crediteur += r.crediteur; total.nbCrediteur += r.nbCrediteur;
            for (const b of R.AGING_BUCKETS) total.buckets[b.key] += r.buckets[b.key];
        }

        return { rows, total, sansDate, dateRef: ref,
                 nbAClasser: (lignes.get(A_CLASSER) || { nb: 0 }).nb,
                 eurosAClasser: (lignes.get(A_CLASSER) || { total: 0 }).total };
    }

    /**
     * Confronte la balance âgée Monday et la balance âgée comptable.
     *
     * Les deux ne peuvent pas coïncider exactement — Monday suit un circuit,
     * la comptabilité tient un compte — mais l'écart par financement dit où
     * regarder : un dispositif très au-dessus côté comptable signale des
     * factures absentes du circuit, l'inverse des règlements non lettrés.
     */
    function comparer(balanceGL, agingMonday, rules) {
        const parFin = new Map();
        const ligne = (cle, label) => {
            let l = parFin.get(cle);
            if (!l) { l = { cle, label, monday: 0, grandLivre: 0, nbMonday: 0, nbGL: 0 }; parFin.set(cle, l); }
            return l;
        };
        for (const r of balanceGL.rows) ligne(r.cle, r.label).grandLivre += r.total,
            ligne(r.cle, r.label).nbGL += r.nb;
        for (const m of agingMonday) {
            const cle = m.cle || m.key || m.financement;
            const l = ligne(cle, m.label || R.getRule(cle, rules).label);
            l.monday += m.total || 0;
            l.nbMonday += m.nb || 0;
        }
        const rows = [...parFin.values()].map(l => ({
            ...l, ecart: l.grandLivre - l.monday,
            ecartRelatif: l.monday ? (l.grandLivre - l.monday) / l.monday * 100 : null,
        })).sort((a, b) => Math.abs(b.ecart) - Math.abs(a.ecart));

        const total = rows.reduce((t, r) => ({
            monday: t.monday + r.monday, grandLivre: t.grandLivre + r.grandLivre,
            nbMonday: t.nbMonday + r.nbMonday, nbGL: t.nbGL + r.nbGL,
        }), { monday: 0, grandLivre: 0, nbMonday: 0, nbGL: 0 });
        total.ecart = total.grandLivre - total.monday;
        total.ecartRelatif = total.monday ? total.ecart / total.monday * 100 : null;
        return { rows, total };
    }

    /**
     * Dictionnaire des qualifications portées par un extrait.
     *
     * Une fois qu'un mois a été qualifié à la main, ce travail ne doit plus
     * être refait : les correspondances numéro → financement sont conservées et
     * resservent aux extraits suivants, où les mêmes factures reviennent.
     *
     * @returns {Object} clé de facture → clé de financement
     */
    function referentielDepuis(lignes, rules) {
        const ref = {};
        for (const l of (lignes || [])) {
            if (!l.cle || !l.qualif) continue;
            const fin = R.detectFinancement(l.qualif, rules);
            // Marquée « fichier » : c'est une qualification lue, pas validée.
            // Promue « valide » seulement quand elle est confirmée à la main
            // depuis « Les créances à classer ».
            if (fin) ref[l.cle] = { fin, source: 'fichier' };
        }
        return ref;
    }

    /** Le financement porté par une entrée de référentiel, quel qu'en soit le format. */
    function financementDuReferentiel(v) {
        if (!v) return null;
        return typeof v === 'string' ? v : (v.fin || null);
    }

    /** Une règle en une ligne lisible : « Nom du client contient alma ». */
    function etiquetteRegle(r) {
        const champ = CHAMPS_REGLE.find(c => c.cle === r.champ);
        const op = OPERATEURS.find(o => o.cle === r.operateur);
        return `${(champ || {}).label || r.champ} ${(op || {}).label || r.operateur} « ${r.valeur} »`;
    }

    global.LioraGrandLivre = {
        referentielDepuis, financementDuReferentiel, CHAMPS_REGLE, OPERATEURS,
        regleCorrespond, financementParRegles, porteeDesRegles, etiquetteRegle,
        A_CLASSER, POOL_NON_LETTRE, MOTIFS_NUMERO, numeroDepuisTexte,
        creancesOuvertes, classer, balanceAgee, comparer,
        COLONNES, TOLERANCE, EST_FACTURE, EST_AVOIR,
        detecterColonnes, estComptable, lettreDe, lire, lireComptable, lireSimple,
    };
})(window);
