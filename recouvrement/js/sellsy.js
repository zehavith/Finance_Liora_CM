/* ==========================================================
   Liora — Suivi Recouvrement
   sellsy.js — Contrôle d'exhaustivité : Sellsy ↔ Monday

     1. Lecture d'un export de factures Sellsy
     2. Normalisation du statut Sellsy
     3. Rapprochement sur le numéro de facture
     4. Ce qui manque dans Monday, ce qui y est en trop,
        et les écarts sur les factures communes

   Sellsy est le logiciel de facturation : c'est lui qui fait
   foi sur l'existence d'une facture et sur son montant. Monday
   est le tableau de suivi : il fait foi sur l'avancement du
   recouvrement. Une facture émise dans Sellsy et absente de
   Monday n'est suivie par personne — c'est précisément ce que
   ce contrôle sert à trouver.
   ========================================================== */

(function (global) {
    'use strict';

    const R = global.LioraRules;
    const I = global.LioraIngest;

    // ──────────────────────────────────────────────
    //  1. Statuts Sellsy
    // ──────────────────────────────────────────────

    /**
     * Les statuts Sellsy, ramenés à ce qui décide du contrôle.
     *
     * L'ordre compte : « partiellement payée » contient « payée », et
     * « non payée » aussi. Les cas particuliers passent donc devant.
     *
     * `attendueDansMonday` dit si l'absence de la facture dans Monday est un
     * problème. Un brouillon n'est pas une facture émise, et un avoir n'est pas
     * une créance : ni l'un ni l'autre n'a vocation à être suivi en
     * recouvrement, et les compter comme manquants noierait les vraies.
     */
    const STATUTS = [
        { key: 'brouillon', label: 'Brouillon',            attendueDansMonday: false, paye: false, match: /brouillon|draft|projet|devis|en cours de redaction/ },
        { key: 'annulee',   label: 'Annulée',              attendueDansMonday: false, paye: false, match: /annul|cancel|abandonn/ },
        { key: 'avoir',     label: 'Avoir',                attendueDansMonday: false, paye: false, match: /avoir|credit note|note de credit|remboursement/ },
        // « À régler » et « Retard » sont les libellés de Sellsy pour une facture
        // qui reste due. Sans eux, « à régler » tombait sur le motif « payée »
        // — il contient « régl » — et 769 impayées étaient comptées encaissées.
        { key: 'impayee',   label: 'Impayée',              attendueDansMonday: true,  paye: false, match: /non pay|impay|pas pay|a payer|a regl|reste a|non regl|unpaid|overdue|due|retard|late|echu|a encaisser/ },
        { key: 'partielle', label: 'Partiellement payée',  attendueDansMonday: true,  paye: false, match: /partiel|partial|acompte|advance/ },
        { key: 'payee',     label: 'Payée',                attendueDansMonday: true,  paye: true,  match: /pay|regl|encaiss|sold|lettr|settled/ },
        { key: 'envoyee',   label: 'Envoyée / en attente', attendueDansMonday: true,  paye: false, match: /envoy|emise|emis|sent|attente|pending|ouverte|open|valid/ },
    ];

    const STATUT_INCONNU = {
        key: 'inconnu', label: 'Statut inconnu', attendueDansMonday: true, paye: false,
    };

    /**
     * UN NUMÉRO QUI COMMENCE PAR AVR EST UN AVOIR.
     *
     * « tt les facture qui commence par AVR sont d avoir attention », 27/10/2026.
     *
     * Le statut ne suffisait pas à les reconnaître : l'export des avoirs porte
     * « Soldé », « À solder », « Partiel » — aucun ne contient le mot avoir, et
     * « à solder » tombait même sur le motif des payées. Les 3 512 avoirs
     * entraient donc dans le contrôle comme des factures ordinaires, et leur
     * absence de Monday se comptait comme un trou de suivi.
     *
     * Un avoir n'est pas une créance — c'est la règle de cette application
     * depuis le premier jour. Il ne compte ni dans les factures attendues, ni
     * dans les manquantes, ni dans le taux de couverture. Il a sa propre
     * vignette, plus bas.
     */
    const PREFIXE_AVOIR = /^\s*avr/i;
    const STATUT_AVOIR = STATUTS.find(x => x.key === 'avoir');

    function estAvoir(numero) {
        return PREFIXE_AVOIR.test(String(numero || ''));
    }

    /**
     * Statut Sellsy normalisé, à défaut déduit du reste dû.
     *
     * Beaucoup d'exports ne portent pas de colonne « statut » mais un reste dû :
     * à zéro, la facture est soldée. C'est une information suffisante pour le
     * contrôle, et la perdre reviendrait à classer tout l'export en inconnu.
     */
    function normaliserStatut(brut, resteDu, montant) {
        const s = R.norm(brut);
        if (s) {
            for (const st of STATUTS) if (st.match.test(s)) return st;
        }
        if (resteDu != null) {
            if (Math.abs(resteDu) < 0.01) return STATUTS.find(x => x.key === 'payee');
            if (montant != null && resteDu < montant - 0.01) return STATUTS.find(x => x.key === 'partielle');
            return STATUTS.find(x => x.key === 'impayee');
        }
        return STATUT_INCONNU;
    }

    // ──────────────────────────────────────────────
    //  2. Lecture de l'export
    // ──────────────────────────────────────────────

    /**
     * Libellés propres à Sellsy, essayés avant le mapping générique.
     *
     * Un export Sellsy nomme sa colonne de numéro « Numéro » ou « Référence »
     * tout court : aucun alias générique ne l'attrape, et sans le numéro il n'y
     * a pas de rapprochement possible.
     */
    // ── QUAND LA FACTURATION ARRIVE PAR L'API, ELLE PARLE ANGLAIS ──
    //
    // Un export Sellsy porte des en-têtes français ; la même facture demandée
    // à son API porte des champs anglais, mis à plat par js/api.js — un client
    // rattaché devient « related.1.name ». Les alias anglais ci-dessous ne
    // sont consultés que si aucun nom français n'a été trouvé, donc ils ne
    // changent rien aux imports de fichiers.
    //
    // Ils sont écrits d'après la documentation, sans avoir pu être confrontés
    // au service. Le bouton « Tester » de l'onglet Données rend la liste
    // exacte des champs et dit lesquels il a su rapprocher : c'est cette
    // liste qui permettra de remplacer ces suppositions.
    const ALIAS_SELLSY = {
        numero:     ['numero', 'num', 'reference', 'ref', 'numero de document', 'document', 'piece',
                     'number', 'invoice number', 'decimal number'],
        client:     ['nom du client', 'client', 'tiers', 'societe', 'nom du tiers', 'raison sociale',
                     'related 1 name', 'client name', 'customer name', 'company name',
                     'individual name', 'contact name', 'third party name'],
        // L'e-mail joint la facturation aux prélèvements : c'est la clé du
        // classeur de trésorerie pour retrouver le mandat GoCardless d'un
        // client, et elle ne souffre pas des variantes d'orthographe d'un nom.
        email:      ['email client', 'e mail client', 'email', 'e mail', 'courriel'],
        montant:    ['montant ttc', 'total ttc', 'ttc', 'montant', 'total',
                     'amounts total including tax', 'total including tax', 'total incl tax'],
        montantHT:  ['montant ht', 'total ht', 'ht',
                     'amounts total excluding tax', 'total excluding tax', 'total excl tax'],
        resteDu:    ['montant du ttc', 'montant du', 'restant du', 'reste du', 'reste a payer', 'solde du', 'solde',
                     'amounts due', 'amount due', 'remaining amount', 'balance due'],
        // Le reste à charge après acompte : sur un dossier CPF, l'apprenant
        // verse souvent une part à l'inscription et la Caisse des Dépôts ne
        // règle que ce qui reste. C'est cette colonne qui le porte.
        montantRAC: ['montant rac', 'montant r a c', 'rac', 'reste a charge', 'montant reste a charge'],
        dateFacture: ['date', 'date de facture', 'date facture', 'date d emission',
                      'created', 'issue date', 'invoice date'],
        dateEcheanceSource: ['date d echeance', 'echeance', 'date limite de paiement',
                             'due date', 'payment deadline'],
        // Sellsy nomme les dates de formation « début » et « fin de service ».
        // Ce sont elles que les règles d'échéance attendent : les récupérer vaut
        // mieux que de recopier l'échéance calculée par Sellsy.
        // Zoho nomme les mêmes colonnes « Debut / Fin formation ».
        dateDebutFormation: ['debut de service', 'date de debut de service', 'debut service',
                             'debut formation', 'date de debut de formation'],
        dateFinFormation: ['fin de service', 'date de fin de service', 'fin service',
                           'fin formation', 'date de fin de formation'],
        // La correspondance Sellsy ↔ Zoho, portée par l'un ou l'autre export.
        // Les factures « FA-… » ne sont plus émises, mais elles vivent encore au
        // grand livre : c'est par ce numéro qu'on retrouve leurs dates.
        //
        // Le champ est la « seconde clé » de la facture, pas un numéro Zoho au
        // sens strict : dans l'export Sellsy il porte le numéro Zoho, dans
        // l'export Zoho il porte la facture Sellsy correspondante. Dans les
        // deux cas il désigne la même facture sous l'autre numéro, et c'est
        // par là que les dates, l'e-mail et le statut se rejoignent.
        numeroZoho: ['numero de facture zoho', 'facture zoho', 'numero zoho',
                     'facture sellsy correspondante', 'numero de facture sellsy'],
        statut:     ['statut', 'status', 'etat', 'etat du paiement', 'statut de paiement',
                     'payment status', 'step'],
    };

    /** Le libellé de colonne est-il exactement l'un des alias ? */
    function trouverColonneExacte(entetes, alias) {
        for (const cible of alias.map(a => R.norm(a))) {
            const exact = entetes.find(h => R.norm(h) === cible);
            if (exact) return exact;
        }
        return null;
    }

    /** À défaut d'exact, le libellé contient-il l'un des alias ? */
    function trouverColonnePartielle(entetes, alias) {
        for (const cible of alias.map(a => R.norm(a))) {
            const partiel = entetes.find(h => R.norm(h).includes(cible));
            if (partiel) return partiel;
        }
        return null;
    }

    /** Part des valeurs réellement renseignées dans une colonne. */
    function tauxRempli(valeurs) {
        if (!valeurs.length) return 0;
        return valeurs.filter(v => v != null && String(v).trim()).length / valeurs.length;
    }

    /**
     * Transforme les lignes brutes de l'export en factures Sellsy exploitables.
     *
     * @param {Array<Object>} rows  lignes telles que lues du CSV / XLSX
     * @returns {{lignes:Array, mapping:Object, entetes:Array<string>,
     *            ignorees:number}}
     */
    function lireExport(rows) {
        if (!rows || !rows.length) return { lignes: [], mapping: {}, entetes: [], ignorees: 0 };
        const entetes = Object.keys(rows[0]);

        const valeurs = id => rows.slice(0, 200).map(r => r[id]);
        const mapping = {}, pris = new Set();
        const retenir = (champ, col) => {
            if (!col || mapping[champ] || pris.has(col)) return;
            if (!I.verifierValeurs(champ, valeurs(col)).ok) return;
            // Une colonne presque vide ne peut pas servir de clé : l'export
            // porte « Numéro » et « Numéro de facture Zoho », et la seconde,
            // vide, emportait le rapprochement en ne rapprochant rien.
            if (champ === 'numero' && tauxRempli(valeurs(col)) < 0.5) return;
            mapping[champ] = col;
            pris.add(col);
        };

        // Les libellés exacts de Sellsy d'abord : « Numéro », « Statut »,
        // « Montant » sont sans ambiguïté, là où un score approché va chercher
        // « Numéro de facture Zoho » ou « Montant dû TTC ».
        for (const [champ, alias] of Object.entries(ALIAS_SELLSY))
            retenir(champ, trouverColonneExacte(entetes.filter(h => !pris.has(h)), alias));

        // Puis le mapping générique, qui connaît les libellés longs des autres
        // outils, pour les champs encore vides.
        const libres = entetes.filter(h => !pris.has(h)).map(h => ({ id: h, title: h }));
        const generique = I.autoMapColumns(libres, valeurs).mapping;
        for (const [champ, col] of Object.entries(generique)) retenir(champ, col);

        // Et en dernier recours l'inclusion : « Montant dû TTC » pour le reste dû.
        for (const [champ, alias] of Object.entries(ALIAS_SELLSY))
            retenir(champ, trouverColonnePartielle(entetes.filter(h => !pris.has(h)), alias));

        // ── Le champ personnalisé qui dit l'alternance ──
        //
        // Sellsy laisse ajouter des champs à une facture, et c'est là que vit
        // le type de contrat : « Alternance », « Contrat de
        // professionnalisation », « Apprentissage ». Le champ porte le nom que
        // vous lui avez donné — l'application ne peut pas le deviner — alors
        // elle regarde ce que contiennent les colonnes qu'elle n'a pas su
        // placer, et retient celle qui parle d'alternance.
        //
        // Une colonne n'est retenue que si elle le dit sans jamais dire autre
        // chose : au moins une valeur qui parle d'alternance, et aucune valeur
        // qui soit une date, un montant ou un numéro. Sinon un libellé de
        // formation contenant le mot suffirait à tout basculer.
        const MOTIF_ALTERNANCE = /alternan|apprenti|professionnalisation|contrat pro|\bproa\b/i;
        const colonneAlternance = (() => {
            // « Type de facture » d'abord, nommément : c'est là que vit
            // l'alternance dans votre export, et cette colonne peut très bien
            // avoir déjà été retenue pour un autre champ — l'heuristique qui
            // suit ne regarde que les colonnes libres et ne la verrait pas.
            const nomme = entetes.find(h => {
                const n = R.norm(h);
                return n === 'type de facture' || n === 'type facture'
                    || n === 'type de contrat' || n === 'type contrat'
                    || n === 'type de dispositif';
            });
            if (nomme) {
                const vals = rows.map(r => String(r[nomme] == null ? '' : r[nomme]).trim()).filter(Boolean);
                if (vals.some(v => MOTIF_ALTERNANCE.test(v))) return nomme;
            }
            const libres = entetes.filter(h => !pris.has(h));
            let meilleure = null, meilleurNb = 0;
            for (const col of libres) {
                const vals = rows.map(r => String(r[col] == null ? '' : r[col]).trim()).filter(Boolean);
                if (vals.length < 5) continue;
                const nb = vals.filter(v => MOTIF_ALTERNANCE.test(v)).length;
                if (!nb) continue;
                // Une colonne de dates ou de montants ne décrit pas un contrat.
                const chiffres = vals.filter(v => /^[\d\s.,\/-]+$/.test(v)).length;
                if (chiffres > vals.length * 0.2) continue;
                // Et un champ de contrat ne prend que quelques valeurs.
                if (new Set(vals).size > 40) continue;
                if (nb > meilleurNb) { meilleurNb = nb; meilleure = col; }
            }
            return meilleure;
        })();
        if (colonneAlternance) mapping.alternance = colonneAlternance;

        // Toutes les autres colonnes que l'application n'a pas su placer sont
        // conservées telles quelles. Ce sont vos champs personnalisés : ils ne
        // servent peut-être à rien à l'application, mais ils décrivent la
        // facture, et les perdre à l'import interdirait de s'en servir plus
        // tard — pour classer, pour retrouver un dossier, pour comprendre une
        // ligne. Ils ressortent dans les exports, sous leur nom d'origine.
        const colonnesLibres = entetes.filter(h => !pris.has(h) && h !== colonneAlternance);

        // Un champ personnalisé peut aussi nommer le dispositif de financement
        // — « CPF », « OPCO », « Transition Pro ». Celui qui le fait pour au
        // moins la moitié des factures renseignées est retenu comme tel.
        const colonneFinancement = (() => {
            let meilleure = null, meilleurTaux = 0;
            for (const col of colonnesLibres) {
                const vals = rows.map(r => String(r[col] == null ? '' : r[col]).trim()).filter(Boolean);
                if (vals.length < 20 || new Set(vals).size > 40) continue;
                const nb = vals.filter(v => R.detectFinancement(v)).length;
                const taux = nb / vals.length;
                if (taux >= 0.5 && taux > meilleurTaux) { meilleurTaux = taux; meilleure = col; }
            }
            return meilleure;
        })();
        if (colonneFinancement) mapping.financementPersonnalise = colonneFinancement;

        const lignes = [];
        let ignorees = 0;
        for (const r of rows) {
            const numero = mapping.numero ? String(r[mapping.numero] || '').trim() : '';
            const cle = I.factureKey(numero);
            if (!cle) { ignorees++; continue; }
            // Seconde clé : le numéro Zoho de la même facture, quand l'export le
            // porte. Une créance du grand livre nommée « FA-… » se rapproche
            // alors de sa ligne Sellsy, avec ses dates et son type de client.
            const numeroZoho = mapping.numeroZoho ? String(r[mapping.numeroZoho] || '').trim() : '';
            const cleZoho = numeroZoho ? I.factureKey(numeroZoho) : null;

            const montant = mapping.montant ? I.parseMontant(r[mapping.montant]) : null;
            const resteDu = mapping.resteDu ? I.parseMontant(r[mapping.resteDu]) : null;
            const statut = estAvoir(numero)
                ? STATUT_AVOIR
                : normaliserStatut(mapping.statut ? r[mapping.statut] : '', resteDu, montant);

            lignes.push({
                cle, numero, cleZoho, numeroZoho,
                // Le contrat en alternance, tel que votre champ personnalisé
                // le nomme. Vide quand l'export ne porte pas la colonne — et
                // rien ne change alors, l'alternance se lit au numéro Filiz.
                // Le « Type de client » le dit aussi, et il ne pouvait pas être
                // entendu : l'heuristique ne regarde que les colonnes qu'aucun
                // champ n'a prises, et celle-là est prise. Sur votre export,
                // 531 factures portent « Alternance » dans cette colonne, et
                // toutes les 531 ont leurs dates de service — elles étaient
                // pourtant traitées comme des factures ordinaires.
                alternance: [
                    colonneAlternance ? r[colonneAlternance] : '',
                    mapping.typeClient ? r[mapping.typeClient] : '',
                    colonneFinancement ? r[colonneFinancement] : '',
                ].some(v => MOTIF_ALTERNANCE.test(String(v || ''))),
                alternanceTexte: [
                    colonneAlternance ? r[colonneAlternance] : '',
                    mapping.typeClient ? r[mapping.typeClient] : '',
                ].map(v => String(v || '').trim())
                 .find(v => MOTIF_ALTERNANCE.test(v)) || '',
                // Le dispositif nommé par un champ personnalisé, s'il y en a un.
                financementPersonnalise: colonneFinancement
                    ? String(r[colonneFinancement] || '').trim() : '',
                // Et tous vos autres champs, sous leur nom.
                champs: colonnesLibres.reduce((o, c) => {
                    const v = String(r[c] == null ? '' : r[c]).trim();
                    if (v) o[c] = v;
                    return o;
                }, {}),
                email: mapping.email ? String(r[mapping.email] || '').trim().toLowerCase() : '',
                client: mapping.client ? String(r[mapping.client] || '').trim() : '',
                montant,
                montantHT: mapping.montantHT ? I.parseMontant(r[mapping.montantHT]) : null,
                montantRAC: mapping.montantRAC ? I.parseMontant(r[mapping.montantRAC]) : null,
                resteDu,
                dateFacture: mapping.dateFacture ? R.parseDate(r[mapping.dateFacture]) : null,
                dateEcheance: mapping.dateEcheanceSource ? R.parseDate(r[mapping.dateEcheanceSource]) : null,
                dateDebutService: mapping.dateDebutFormation ? R.parseDate(r[mapping.dateDebutFormation]) : null,
                dateFinService: mapping.dateFinFormation ? R.parseDate(r[mapping.dateFinFormation]) : null,
                // Le garde-fou porte sur les deux champs : le reste dû sort du
                // même export et prend les mêmes valeurs absurdes, et il est
                // sommé ailleurs sans passer par le montant.
                montantAberrant: montantAberrant(montant) || montantAberrant(resteDu),
                // « Type de client » nomme le dispositif de financement : c'est
                // la seule source qui le porte pour toutes les factures émises,
                // et elle sert à classer les créances du grand livre.
                typeClient: mapping.typeClient ? String(r[mapping.typeClient] || '').trim() : '',
                statutBrut: mapping.statut ? String(r[mapping.statut] || '').trim() : '',
                statut: statut.key,
                statutLabel: statut.label,
                avoir: statut.key === 'avoir',
                paye: statut.paye,
                attendue: statut.attendueDansMonday,
            });
        }

        // Un même numéro peut sortir deux fois de l'export (ligne par article,
        // acompte et solde) : le contrôle porte sur la facture, pas sur la ligne.
        const parCle = new Map();
        for (const l of lignes) {
            const prec = parCle.get(l.cle);
            if (!prec) { parCle.set(l.cle, { ...l, lignesExport: 1 }); continue; }
            prec.lignesExport++;
            if (prec.montant == null) prec.montant = l.montant;
            if (prec.montantRAC == null) prec.montantRAC = l.montantRAC;
            if (!prec.dateFacture) prec.dateFacture = l.dateFacture;
            if (!prec.typeClient) prec.typeClient = l.typeClient;
            if (!prec.dateDebutService) prec.dateDebutService = l.dateDebutService;
            if (!prec.dateFinService) prec.dateFinService = l.dateFinService;
            if (!prec.alternance && l.alternance) {
                prec.alternance = true; prec.alternanceTexte = l.alternanceTexte;
            }
            if (!prec.financementPersonnalise) prec.financementPersonnalise = l.financementPersonnalise;
            for (const [k, v] of Object.entries(l.champs || {})) {
                if (!prec.champs[k]) prec.champs[k] = v;
            }
        }

        return { lignes: [...parCle.values()], mapping, entetes, ignorees };
    }

    // ──────────────────────────────────────────────
    //  3. Rapprochement
    // ──────────────────────────────────────────────

    const ECART_MONTANT_TOLERE = 1;   // euros — arrondis de TVA

    /**
     * Au-delà de ce montant, la valeur n'est pas une facture de formation mais
     * une anomalie de la source.
     *
     * L'export réel en contient : deux factures à −421 046 417 789 € et une à
     * +381 091 361 414 €. Additionnées, elles affichaient un total facturé de
     * −460 milliards d'euros et rendaient toute lecture impossible. Le montant
     * est donc écarté des sommes — la facture, elle, reste comptée et signalée :
     * c'est à la comptabilité de la corriger dans Sellsy, pas à cet outil de la
     * cacher.
     */
    const MONTANT_ABERRANT = 10000000;

    function montantAberrant(montant) {
        return montant != null && Math.abs(montant) > MONTANT_ABERRANT;
    }

    /** Montant utilisable dans une somme : null si la source est aberrante. */
    function montantSommable(l) {
        return l.montantAberrant ? null : l.montant;
    }

    /** Reste dû utilisable dans une somme, à défaut le montant. */
    function resteDuSommable(l) {
        if (l.montantAberrant) return null;
        return l.resteDu != null ? l.resteDu : (l.paye ? 0 : l.montant);
    }

    /** Une colonne de l'export, cherchée sur son nom, accents et casse ignorés. */
    function champ(l, ...noms) {
        const c = l.champs || {};
        const cibles = noms.map(R.norm);
        for (const k of Object.keys(c)) {
            if (cibles.indexOf(R.norm(k)) !== -1) return String(c[k] == null ? '' : c[k]).trim();
        }
        return '';
    }

    /**
     * UN AVOIR QUI N'EST RAPPROCHÉ DE RIEN.
     *
     * « il faut ajouter une vignette supplémentaire si il y en a qui ne st pas
     *   rapproché », 27/10/2026.
     *
     * Trois cas, du plus coûteux au plus bénin :
     *
     *   · LA FACTURE D'ORIGINE EST ENCORE SUIVIE DANS MONDAY. L'avoir existe,
     *     il est passé en banque, et la facture qu'il annule est toujours sur
     *     un tableau de recouvrement : on relance une facture déjà créditée.
     *     C'est le seul des trois qui fait perdre du temps et de la crédibilité.
     *   · LE RAPPROCHEMENT BANCAIRE EST EN ATTENTE. Sellsy lui-même dit « à
     *     rapprocher » ou « partiellement rapprochée » : le mouvement n'est pas
     *     soldé côté banque.
     *   · AUCUNE FACTURE D'ORIGINE. L'avoir ne désigne aucune facture : il n'y
     *     a rien à annuler, ou la référence manque.
     *
     * Un avoir dont la facture d'origine est réglée, ou simplement absente du
     * périmètre Monday, N'EST PAS signalé : Monday ne suit que ce qui est en
     * recouvrement, et faire une anomalie de chaque avoir hors périmètre
     * noierait les trois cas ci-dessus sous deux mille lignes sans objet.
     */
    const MOTIF_AVOIR_ORIGINE = 'facture d\u2019origine encore suivie dans Monday';
    const MOTIF_AVOIR_BANQUE = 'rapprochement bancaire en attente';
    const MOTIF_AVOIR_SANS_ORIGINE = 'aucune facture d\u2019origine';

    function avoirNonRapproche(l, indexMonday) {
        const parente = champ(l, 'facture parente', 'facture d origine',
                              'numero de facture d origine', 'parent invoice');
        const cleParente = parente ? I.factureKey(parente) : null;
        const origine = cleParente && indexMonday ? indexMonday.get(cleParente) : null;
        if (origine && !origine.paye) return MOTIF_AVOIR_ORIGINE;
        const banque = champ(l, 'rapprochement bancaire', 'rapprochement');
        if (banque && R.norm(banque) !== 'rapprochee') return MOTIF_AVOIR_BANQUE;
        if (!parente) return MOTIF_AVOIR_SANS_ORIGINE;
        return null;
    }

    /**
     * Confronte l'export Sellsy aux factures Monday.
     *
     * @param {Array} lignes    sorties de lireExport()
     * @param {Array} factures  factures Monday consolidées
     * @returns {Object} le résultat complet du contrôle
     */
    function rapprocher(lignes, factures) {
        const indexMonday = new Map();
        for (const f of factures) {
            if (!f.cle) continue;
            if (!indexMonday.has(f.cle)) indexMonday.set(f.cle, f);
        }
        const clesSellsy = new Set(lignes.map(l => l.cle));

        const absentes = [], rapprochees = [], horsPerimetre = [];
        for (const l of lignes) {
            const f = indexMonday.get(l.cle);
            if (!f) {
                (l.attendue ? absentes : horsPerimetre).push(l);
                continue;
            }
            // Écart de montant : Sellsy fait foi, c'est le logiciel de
            // facturation. Un écart signale une saisie Monday à corriger.
            const ecartMontant = (l.montant != null && !l.montantAberrant && f.montant != null
                && Math.abs(l.montant - f.montant) > ECART_MONTANT_TOLERE)
                ? f.montant - l.montant : null;
            // Écart de statut : Sellsy encaissé et Monday encore en cours, c'est
            // une relance envoyée pour rien. L'inverse est un règlement pointé
            // dans Monday que la comptabilité n'a pas vu.
            let ecartStatut = null;
            if (l.statut === 'payee' && !f.paye) ecartStatut = 'payee_sellsy_seulement';
            else if (l.statut === 'impayee' && f.paye) ecartStatut = 'payee_monday_seulement';

            rapprochees.push({ sellsy: l, facture: f, ecartMontant, ecartStatut });
        }

        // Dans Monday sans exister dans Sellsy : numéro mal saisi, ligne de test,
        // ou facture d'un autre outil. À ne signaler que si l'export couvre la
        // période — d'où la borne calculée plus bas.
        const bornes = bornesExport(lignes);
        const surnumeraires = [];
        for (const f of factures) {
            if (!f.cle || clesSellsy.has(f.cle)) continue;
            if (bornes.min && f.dateFacture && f.dateFacture < bornes.min) continue;
            if (bornes.max && f.dateFacture && f.dateFacture > bornes.max) continue;
            surnumeraires.push(f);
        }

        // Une facture Monday sans numéro exploitable ne peut être rapprochée de
        // rien : elle n'est ni retrouvée ni surnuméraire. Le dire évite de lire
        // le contrôle comme exhaustif alors qu'il ne l'est pas.
        const sansNumero = factures.filter(f => !f.cle);

        // Les avoirs, à part. Ils ne sont pas des créances et ne comptent dans
        // aucun des chiffres ci-dessus ; seuls ceux qui ne se rapprochent de
        // rien ont quelque chose à dire.
        const avoirs = lignes.filter(l => l.avoir);
        const avoirsNonRapproches = [];
        for (const l of avoirs) {
            const motif = avoirNonRapproche(l, indexMonday);
            if (motif) avoirsNonRapproches.push({ ...l, motifAvoir: motif });
        }

        return {
            absentes, horsPerimetre, rapprochees, surnumeraires, sansNumero, bornes,
            avoirs, avoirsNonRapproches,
            stats: statistiques({ lignes, absentes, horsPerimetre, rapprochees, surnumeraires,
                                  sansNumero, avoirs, avoirsNonRapproches }),
        };
    }

    /** Période couverte par l'export, pour ne juger Monday que dessus. */
    function bornesExport(lignes) {
        const dates = lignes.map(l => l.dateFacture).filter(Boolean).sort((a, b) => a - b);
        if (!dates.length) return { min: null, max: null };
        return { min: dates[0], max: dates[dates.length - 1] };
    }

    function somme(arr, f) {
        return arr.reduce((s, x) => s + (f(x) || 0), 0);
    }

    function statistiques(o) {
        const attendues = o.lignes.filter(l => l.attendue);
        const absentes = o.absentes;
        return {
            nbSellsy: o.lignes.length,
            nbAttendues: attendues.length,
            eurosAttendues: somme(attendues, montantSommable),
            nbAbsentes: absentes.length,
            eurosAbsentes: somme(absentes, montantSommable),
            eurosAbsentesDues: somme(absentes.filter(l => !l.paye), resteDuSommable),
            nbAbsentesImpayees: absentes.filter(l => !l.paye).length,
            nbAbsentesPayees: absentes.filter(l => l.paye).length,
            nbHorsPerimetre: o.horsPerimetre.length,
            nbRapprochees: o.rapprochees.length,
            nbSurnumeraires: o.surnumeraires.length,
            nbMondaySansNumero: o.sansNumero.length,
            nbAvoirs: (o.avoirs || []).length,
            nbAvoirsNonRapproches: (o.avoirsNonRapproches || []).length,
            // Un avoir porte un montant négatif : sa valeur absolue est ce
            // qu'il pèse, et c'est ce qui se lit sur la vignette.
            eurosAvoirsNonRapproches: somme(o.avoirsNonRapproches || [],
                l => Math.abs(montantSommable(l) || 0)),
            nbMontantAberrant: o.lignes.filter(l => l.montantAberrant).length,
            numerosMontantAberrant: o.lignes.filter(l => l.montantAberrant).map(l => l.numero),
            eurosSurnumeraires: somme(o.surnumeraires, f => f.montant),
            nbEcartMontant: o.rapprochees.filter(r => r.ecartMontant != null).length,
            eurosEcartMontant: somme(o.rapprochees.filter(r => r.ecartMontant != null), r => r.ecartMontant),
            nbPayeeSellsySeulement: o.rapprochees.filter(r => r.ecartStatut === 'payee_sellsy_seulement').length,
            nbPayeeMondaySeulement: o.rapprochees.filter(r => r.ecartStatut === 'payee_monday_seulement').length,
            // En pourcent, comme partout ailleurs dans l'application : U.pourcent
            // met en forme, il ne convertit pas.
            tauxCouverture: attendues.length
                ? (attendues.length - absentes.length) / attendues.length * 100 : null,
        };
    }

    // ──────────────────────────────────────────────
    //  4. Lectures des factures manquantes
    // ──────────────────────────────────────────────

    /** Les manquantes par statut Sellsy — dit lesquelles sont à relancer. */
    /**
     * UNE ABSENCE QUI N'EN EST PAS UNE.
     *
     * « j'aimerais ici une vignette supplémentaire qui reprend les factures
     * absente - justifié, dedans il y a tt les factures à 0 et 1€, et ces 2
     * clients », 27/10/2026.
     *
     * Deux cas, et deux seulement :
     *   · la facture ne porte rien — 0 € ou 1 € : une pièce de service, un
     *     avoir technique, un essai. Il n'y a rien à aller chercher.
     *   · le client ne passe pas par le circuit Monday : DST Germany et
     *     Datascientest Spain sont facturés ailleurs. Leur absence est la
     *     règle, pas l'incident.
     *
     * Ces factures QUITTENT les autres vignettes. Les laisser dans « impayée »
     * ferait compter comme travail de relance ce que personne n'ira relancer,
     * et le seul chiffre qui compte sur cet écran — ce qui manque VRAIMENT à
     * Monday — resterait noyé.
     *
     * Le seuil est à un euro inclus : il couvre les 0,00 €, le 0,50 € isolé et
     * les 1,00 €. Les noms de clients se comparent sans accent ni casse.
     */
    const CLIENTS_HORS_CIRCUIT = ['dst germany', 'datascientest spain'];

    function absenceJustifiee(l) {
        const m = montantSommable(l);
        if (m != null && Math.abs(m) <= 1) return 'montant nul ou symbolique';
        const c = R.norm(l.client || l.clientNom || '');
        if (c && CLIENTS_HORS_CIRCUIT.some(x => c.indexOf(x) !== -1)) return 'client hors du circuit Monday';
        return null;
    }

    function absentesParStatut(absentes) {
        const m = new Map();
        const pose = (key, label, l) => {
            if (!m.has(key)) m.set(key, { key, label, nb: 0, euros: 0, resteDu: 0, motifs: new Map() });
            const e = m.get(key);
            e.nb++;
            e.euros += montantSommable(l) || 0;
            e.resteDu += resteDuSommable(l) || 0;
            return e;
        };
        for (const l of absentes) {
            const motif = absenceJustifiee(l);
            if (motif) {
                const e = pose('justifiee', 'Justifié', l);
                e.motifs.set(motif, (e.motifs.get(motif) || 0) + 1);
                continue;
            }
            pose(l.statut, l.statutLabel, l);
        }
        // Les justifiées en dernier : c'est la pile dont il n'y a rien à faire,
        // et elle est la plus grosse. En tête, elle écraserait les trois autres.
        const out = [...m.values()];
        return out.filter(x => x.key !== 'justifiee').sort((a, b) => b.nb - a.nb)
            .concat(out.filter(x => x.key === 'justifiee'));
    }

    /**
     * Les manquantes par mois de facture.
     *
     * Une absence concentrée sur quelques mois est une rupture d'import à une
     * date donnée ; une absence étalée est une fuite permanente du circuit. Les
     * deux ne se corrigent pas de la même façon.
     */
    function absentesParMois(absentes, toutes) {
        const m = new Map();
        const touche = (mk, champ) => {
            if (!mk) return;
            if (!m.has(mk)) m.set(mk, { mois: mk, absentes: 0, total: 0, euros: 0 });
            m.get(mk)[champ]++;
        };
        for (const l of toutes) if (l.attendue) touche(R.monthKey(l.dateFacture), 'total');
        for (const l of absentes) {
            const mk = R.monthKey(l.dateFacture);
            touche(mk, 'absentes');
            if (mk && m.has(mk)) m.get(mk).euros += montantSommable(l) || 0;
        }
        return [...m.values()].sort((a, b) => a.mois.localeCompare(b.mois))
            .map(x => ({ ...x, part: x.total ? x.absentes / x.total * 100 : null }));
    }

    /** Les avoirs non rapprochés, par motif — ce que contient la vignette. */
    function avoirsParMotif(avoirs) {
        const m = new Map();
        for (const l of avoirs || []) {
            const k = l.motifAvoir || 'motif inconnu';
            if (!m.has(k)) m.set(k, { motif: k, nb: 0, euros: 0, items: [] });
            const e2 = m.get(k);
            e2.nb++; e2.euros += Math.abs(montantSommable(l) || 0); e2.items.push(l);
        }
        return [...m.values()].sort((a, b) => b.nb - a.nb);
    }

    /** Les manquantes par client — dit si le trou est concentré sur un compte. */
    function absentesParClient(absentes, limite) {
        const m = new Map();
        for (const l of absentes) {
            const c = l.client || '(client non renseigné)';
            if (!m.has(c)) m.set(c, { client: c, nb: 0, euros: 0 });
            const e = m.get(c);
            e.nb++; e.euros += montantSommable(l) || 0;
        }
        return [...m.values()].sort((a, b) => b.euros - a.euros || b.nb - a.nb).slice(0, limite || 20);
    }

    global.LioraSellsy = {
        STATUTS, STATUT_INCONNU, ALIAS_SELLSY, ECART_MONTANT_TOLERE, MONTANT_ABERRANT,
        montantAberrant, montantSommable, resteDuSommable,
        normaliserStatut, lireExport, rapprocher,
        absentesParStatut, absentesParMois, absentesParClient, absenceJustifiee,
        estAvoir, avoirNonRapproche, avoirsParMotif,
    };
})(window);
