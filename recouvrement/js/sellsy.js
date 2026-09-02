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
    const ALIAS_SELLSY = {
        numero:     ['numero', 'num', 'reference', 'ref', 'numero de document', 'document', 'piece'],
        client:     ['client', 'tiers', 'societe', 'nom du tiers', 'raison sociale'],
        montant:    ['montant ttc', 'total ttc', 'ttc', 'montant', 'total'],
        montantHT:  ['montant ht', 'total ht', 'ht'],
        resteDu:    ['montant du ttc', 'montant du', 'restant du', 'reste du', 'reste a payer', 'solde du', 'solde'],
        dateFacture: ['date', 'date de facture', 'date facture', 'date d emission'],
        dateEcheanceSource: ['date d echeance', 'echeance', 'date limite de paiement'],
        // Sellsy nomme les dates de formation « début » et « fin de service ».
        // Ce sont elles que les règles d'échéance attendent : les récupérer vaut
        // mieux que de recopier l'échéance calculée par Sellsy.
        dateDebutFormation: ['debut de service', 'date de debut de service', 'debut service'],
        dateFinFormation: ['fin de service', 'date de fin de service', 'fin service'],
        statut:     ['statut', 'status', 'etat', 'etat du paiement', 'statut de paiement'],
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

        const lignes = [];
        let ignorees = 0;
        for (const r of rows) {
            const numero = mapping.numero ? String(r[mapping.numero] || '').trim() : '';
            const cle = I.factureKey(numero);
            if (!cle) { ignorees++; continue; }

            const montant = mapping.montant ? I.parseMontant(r[mapping.montant]) : null;
            const resteDu = mapping.resteDu ? I.parseMontant(r[mapping.resteDu]) : null;
            const statut = normaliserStatut(mapping.statut ? r[mapping.statut] : '', resteDu, montant);

            lignes.push({
                cle, numero,
                client: mapping.client ? String(r[mapping.client] || '').trim() : '',
                montant,
                montantHT: mapping.montantHT ? I.parseMontant(r[mapping.montantHT]) : null,
                resteDu,
                dateFacture: mapping.dateFacture ? R.parseDate(r[mapping.dateFacture]) : null,
                dateEcheance: mapping.dateEcheanceSource ? R.parseDate(r[mapping.dateEcheanceSource]) : null,
                dateDebutService: mapping.dateDebutFormation ? R.parseDate(r[mapping.dateDebutFormation]) : null,
                dateFinService: mapping.dateFinFormation ? R.parseDate(r[mapping.dateFinFormation]) : null,
                montantAberrant: montantAberrant(montant),
                statutBrut: mapping.statut ? String(r[mapping.statut] || '').trim() : '',
                statut: statut.key,
                statutLabel: statut.label,
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
            if (!prec.dateFacture) prec.dateFacture = l.dateFacture;
            if (!prec.dateDebutService) prec.dateDebutService = l.dateDebutService;
            if (!prec.dateFinService) prec.dateFinService = l.dateFinService;
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

        return {
            absentes, horsPerimetre, rapprochees, surnumeraires, sansNumero, bornes,
            stats: statistiques({ lignes, absentes, horsPerimetre, rapprochees, surnumeraires, sansNumero }),
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
            eurosAbsentesDues: somme(absentes.filter(l => !l.paye),
                l => l.resteDu != null ? l.resteDu : montantSommable(l)),
            nbAbsentesImpayees: absentes.filter(l => !l.paye).length,
            nbAbsentesPayees: absentes.filter(l => l.paye).length,
            nbHorsPerimetre: o.horsPerimetre.length,
            nbRapprochees: o.rapprochees.length,
            nbSurnumeraires: o.surnumeraires.length,
            nbMondaySansNumero: o.sansNumero.length,
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
    function absentesParStatut(absentes) {
        const m = new Map();
        for (const l of absentes) {
            if (!m.has(l.statut)) m.set(l.statut, { key: l.statut, label: l.statutLabel, nb: 0, euros: 0, resteDu: 0 });
            const e = m.get(l.statut);
            e.nb++;
            e.euros += montantSommable(l) || 0;
            e.resteDu += (l.resteDu != null ? l.resteDu : (l.paye ? 0 : montantSommable(l))) || 0;
        }
        return [...m.values()].sort((a, b) => b.nb - a.nb);
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
        montantAberrant, montantSommable,
        normaliserStatut, lireExport, rapprocher,
        absentesParStatut, absentesParMois, absentesParClient,
    };
})(window);
