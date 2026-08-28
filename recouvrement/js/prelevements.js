/* ==========================================================
   Liora — Suivi Recouvrement
   prelevements.js — Analyse des prélèvements GoCardless

     1. Reconnaissance des exports (payments, customers,
        mandates, subscriptions) à leur en-tête
     2. Reconstitution de l'apprenant et de son échéancier
     3. Statistiques d'incident : survie, rang de rupture,
        rattrapage, montant à risque
   ========================================================== */

(function (global) {
    'use strict';

    const R = global.LioraRules;
    const I = global.LioraIngest;

    // ──────────────────────────────────────────────
    //  Statuts GoCardless
    // ──────────────────────────────────────────────

    const STATUTS = {
        // Encaissé
        confirmed: 'succes', paid_out: 'succes',
        // Incident : le prélèvement a été rejeté
        failed: 'echec', charged_back: 'echec',
        // Encore en vol
        pending_submission: 'en_cours', pending_customer_approval: 'en_cours', submitted: 'en_cours',
        // Retiré avant présentation — ce n'est pas un rejet bancaire
        cancelled: 'annule', customer_approval_denied: 'annule',
    };

    function classerStatut(s) {
        return STATUTS[String(s || '').trim().toLowerCase()] || 'inconnu';
    }

    const LIBELLE_STATUT = {
        succes: 'Encaissé', echec: 'Rejeté', en_cours: 'En cours',
        annule: 'Annulé', inconnu: 'Statut inconnu',
    };

    // ──────────────────────────────────────────────
    //  1. Reconnaissance des fichiers
    // ──────────────────────────────────────────────

    /**
     * Devine la nature d'un export GoCardless à partir de ses colonnes.
     * @returns {'paiements'|'clients'|'mandats'|'abonnements'|null}
     */
    function detecterType(headers) {
        const h = new Set(headers.map(x => R.norm(x).replace(/ /g, '_')));
        const a = (...noms) => noms.some(n => h.has(n));

        if (a('charge_date', 'date_de_prelevement')) return 'paiements';
        if (a('interval_unit', 'intervalle') || (a('start_date') && a('count'))) return 'abonnements';
        if (a('given_name', 'family_name', 'prenom', 'nom_de_famille')) return 'clients';
        if (a('scheme') && a('links_customer')) return 'mandats';
        // Repli : un export de paiements sans charge_date reste reconnaissable
        if (a('links_mandate') && a('amount') && a('status')) return 'paiements';
        if (a('email') && a('id')) return 'clients';
        return null;
    }

    /**
     * Accès tolérant à une colonne, quels que soient accents, casse et
     * séparateurs. Les valeurs sont nettoyées : un identifiant qui traîne un
     * retour chariot ne se rapproche de rien.
     */
    function champ(row, ...noms) {
        const propre = v => (v == null ? '' : String(v).trim());

        for (const n of noms) {
            if (row[n] !== undefined) { const v = propre(row[n]); if (v) return v; }
        }
        const index = {};
        for (const k of Object.keys(row)) index[R.norm(k).replace(/ /g, '_')] = row[k];
        for (const n of noms) {
            const k = R.norm(n).replace(/ /g, '_');
            if (index[k] !== undefined) { const v = propre(index[k]); if (v) return v; }
        }
        return '';
    }

    // ──────────────────────────────────────────────
    //  2. Normalisation
    // ──────────────────────────────────────────────

    function normaliserPaiements(rows) {
        return rows.map(r => {
            const statutBrut = champ(r, 'status', 'statut');
            return {
                id: champ(r, 'id'),
                clientId: champ(r, 'links.customer', 'customer_id', 'links_customer'),
                mandatId: champ(r, 'links.mandate', 'mandate_id', 'links_mandate'),
                abonnementId: champ(r, 'links.subscription', 'subscription_id', 'links_subscription'),
                montantBrut: I.parseMontant(champ(r, 'amount', 'montant')),
                montant: I.parseMontant(champ(r, 'amount', 'montant')),
                dateEcheance: R.parseDate(champ(r, 'charge_date', 'date_de_prelevement')) ||
                              R.parseDate(champ(r, 'created_at')),
                dateCreation: R.parseDate(champ(r, 'created_at')),
                statutBrut,
                statut: classerStatut(statutBrut),
                motifEchec: champ(r, 'failure_reason', 'reason', 'motif', 'failure_description'),
                reference: champ(r, 'reference', 'description'),
            };
        }).filter(p => p.id || p.montantBrut != null);
    }

    function normaliserClients(rows) {
        return rows.map(r => {
            const prenom = champ(r, 'given_name', 'prenom', 'first_name');
            const nom = champ(r, 'family_name', 'nom', 'last_name');
            const email = String(champ(r, 'email', 'e_mail', 'courriel')).trim().toLowerCase();
            return {
                id: champ(r, 'id'),
                email,
                prenom, nom,
                societe: champ(r, 'company_name', 'societe'),
                nomComplet: [prenom, nom].filter(Boolean).join(' ').trim()
                    || champ(r, 'company_name') || '',
                dateCreation: R.parseDate(champ(r, 'created_at')),
            };
        }).filter(c => c.id);
    }

    function normaliserMandats(rows) {
        return rows.map(r => ({
            id: champ(r, 'id'),
            clientId: champ(r, 'links.customer', 'customer_id', 'links_customer'),
            statut: champ(r, 'status'),
            dateCreation: R.parseDate(champ(r, 'created_at')),
        })).filter(m => m.id);
    }

    function normaliserAbonnements(rows) {
        return rows.map(r => ({
            id: champ(r, 'id'),
            mandatId: champ(r, 'links.mandate', 'mandate_id', 'links_mandate'),
            clientId: champ(r, 'links.customer', 'customer_id', 'links_customer'),
            montant: I.parseMontant(champ(r, 'amount', 'montant')),
            statut: champ(r, 'status'),
            nom: champ(r, 'name', 'nom'),
            nbEcheances: parseInt(champ(r, 'count', 'nb_echeances'), 10) || null,
            periodicite: [champ(r, 'interval'), champ(r, 'interval_unit')].filter(Boolean).join(' '),
            dateDebut: R.parseDate(champ(r, 'start_date')),
            dateFin: R.parseDate(champ(r, 'end_date')),
        })).filter(a => a.id);
    }

    /**
     * GoCardless exprime les montants tantôt en euros, tantôt dans la plus
     * petite unité monétaire selon la source. L'export payouts du tableau de
     * bord est en euros (« 839.82 »), mais l'API renvoie des centimes.
     *
     * On ne devine que le cas franchement suspect : des montants tous entiers
     * et anormalement élevés pour une échéance de formation. Le résultat est
     * affiché à l'utilisatrice plutôt qu'appliqué en silence.
     *
     * @returns {{unite:'euros'|'centimes', mediane:number, sur:boolean}}
     */
    function detecterUniteMontant(paiements) {
        const m = paiements.map(p => p.montantBrut).filter(v => v != null && isFinite(v) && v > 0);
        if (!m.length) return { unite: 'euros', mediane: 0, sur: true };

        const tousEntiers = m.every(v => Number.isInteger(v));
        const tri = m.slice().sort((a, b) => a - b);
        const med = tri[Math.floor(tri.length / 2)];

        // Une échéance de formation dépasse rarement 5 000 € ; au-delà, et si
        // aucun montant ne porte de décimale, la lecture en centimes s'impose.
        if (tousEntiers && med >= 5000) return { unite: 'centimes', mediane: med, sur: false };
        return { unite: 'euros', mediane: med, sur: true };
    }

    /** Applique l'unité retenue aux montants des prélèvements. */
    function appliquerUnite(paiements, unite) {
        const diviseur = unite === 'centimes' ? 100 : 1;
        for (const p of paiements) {
            p.montant = p.montantBrut == null ? null : p.montantBrut / diviseur;
        }
        return paiements;
    }

    // ──────────────────────────────────────────────
    //  3. Identité de l'apprenant
    //
    //  L'e-mail fait foi. À défaut, prénom + nom normalisés — au risque
    //  de confondre deux homonymes, ce que la qualité de données signale.
    // ──────────────────────────────────────────────

    function cleApprenant(client) {
        if (!client) return null;
        if (client.email) return 'mail:' + client.email;
        const n = R.norm(client.nomComplet);
        if (n) return 'nom:' + n;
        return 'id:' + client.id;
    }

    /**
     * Rassemble paiements, clients, mandats et abonnements en une liste
     * d'apprenants, chacun portant son échéancier trié.
     */
    function construireApprenants(sources) {
        const paiements = sources.paiements || [];
        const clients = sources.clients || [];
        const mandats = sources.mandats || [];
        const abonnements = sources.abonnements || [];

        const clientParId = new Map(clients.map(c => [c.id, c]));
        const mandatParId = new Map(mandats.map(m => [m.id, m]));
        const abonnementParId = new Map(abonnements.map(a => [a.id, a]));

        /** Remonte du paiement au client, directement ou via mandat / abonnement. */
        function clientDuPaiement(p) {
            if (p.clientId && clientParId.has(p.clientId)) return clientParId.get(p.clientId);
            if (p.mandatId) {
                const m = mandatParId.get(p.mandatId);
                if (m && clientParId.has(m.clientId)) return clientParId.get(m.clientId);
            }
            if (p.abonnementId) {
                const a = abonnementParId.get(p.abonnementId);
                if (a) {
                    if (a.clientId && clientParId.has(a.clientId)) return clientParId.get(a.clientId);
                    if (a.mandatId) {
                        const m = mandatParId.get(a.mandatId);
                        if (m && clientParId.has(m.clientId)) return clientParId.get(m.clientId);
                    }
                }
            }
            // Sans référentiel client, le mandat sert de repli d'identité
            if (p.clientId) return { id: p.clientId, email: '', nomComplet: '', prenom: '', nom: '' };
            if (p.mandatId) return { id: 'mandat:' + p.mandatId, email: '', nomComplet: '', prenom: '', nom: '' };
            return null;
        }

        const groupes = new Map();
        let orphelins = 0;

        for (const p of paiements) {
            const c = clientDuPaiement(p);
            if (!c) { orphelins++; continue; }
            const cle = cleApprenant(c);
            let g = groupes.get(cle);
            if (!g) {
                g = { cle, clients: new Map(), paiements: [], abonnements: new Set() };
                groupes.set(cle, g);
            }
            g.clients.set(c.id, c);
            g.paiements.push(p);
            if (p.abonnementId) g.abonnements.add(p.abonnementId);
        }

        const apprenants = [...groupes.values()].map(g => {
            const c = [...g.clients.values()][0];
            const echeancier = g.paiements
                .filter(p => p.dateEcheance)
                .sort((a, b) => a.dateEcheance - b.dateEcheance);

            return analyserApprenant({
                cle: g.cle,
                clientIds: [...g.clients.keys()],
                email: c.email || '',
                nom: c.nomComplet || c.societe || '(sans nom)',
                dateCreation: c.dateCreation || null,
                abonnementIds: [...g.abonnements],
                abonnements: [...g.abonnements].map(id => abonnementParId.get(id)).filter(Boolean),
                echeancier,
                identifieParNom: !c.email && !!c.nomComplet,
                sansIdentite: !c.email && !c.nomComplet,
            });
        });

        apprenants.sort((a, b) => b.montantEchoue - a.montantEchoue);
        return { apprenants, orphelins };
    }

    /** Décrit le parcours de paiement d'un apprenant. */
    function analyserApprenant(a) {
        const e = a.echeancier;
        const succes = e.filter(p => p.statut === 'succes');
        const echecs = e.filter(p => p.statut === 'echec');
        const annules = e.filter(p => p.statut === 'annule');
        const enCours = e.filter(p => p.statut === 'en_cours');

        const premier = e[0] || null;
        const dernier = e[e.length - 1] || null;
        const premierEchec = echecs[0] || null;

        // Rang du prélèvement qui casse : position dans l'échéancier, hors annulés
        const presentes = e.filter(p => p.statut !== 'annule');
        const rangPremierEchec = premierEchec ? presentes.indexOf(premierEchec) + 1 : null;

        // Y a-t-il eu un encaissement après le premier incident ?
        const rattrape = premierEchec
            ? succes.some(p => p.dateEcheance > premierEchec.dateEcheance)
            : null;

        // Un incident sur les trois derniers prélèvements présentés
        const troisDerniers = presentes.slice(-3);
        const enDifficulte = troisDerniers.some(p => p.statut === 'echec');

        let etat;
        if (!echecs.length) etat = enCours.length || succes.length ? 'Sans incident' : 'Aucun prélèvement abouti';
        else if (enDifficulte) etat = 'En difficulté';
        else if (rattrape) etat = 'Incident rattrapé';
        else etat = 'Incident non rattrapé';

        const delaiPremierEchec = (premierEchec && premier)
            ? R.diffDays(premierEchec.dateEcheance, premier.dateEcheance) : null;

        return {
            ...a,
            nbPrelevements: e.length,
            nbPresentes: presentes.length,
            nbSucces: succes.length,
            nbEchecs: echecs.length,
            nbAnnules: annules.length,
            nbEnCours: enCours.length,
            montantTotal: e.reduce((s, p) => s + (p.montant || 0), 0),
            montantEncaisse: succes.reduce((s, p) => s + (p.montant || 0), 0),
            montantEchoue: echecs.reduce((s, p) => s + (p.montant || 0), 0),
            montantEnCours: enCours.reduce((s, p) => s + (p.montant || 0), 0),
            tauxEchec: presentes.length ? (echecs.length / presentes.length) * 100 : 0,
            datePremier: premier ? premier.dateEcheance : null,
            dateDernier: dernier ? dernier.dateEcheance : null,
            datePremierEchec: premierEchec ? premierEchec.dateEcheance : null,
            delaiPremierEchec,
            moisPremierEchec: delaiPremierEchec == null ? null : delaiPremierEchec / 30.44,
            rangPremierEchec,
            rattrape,
            enDifficulte,
            etat,
            dureeObservee: (premier && dernier) ? R.diffDays(dernier.dateEcheance, premier.dateEcheance) : 0,
            motifs: [...new Set(echecs.map(p => p.motifEchec).filter(Boolean))],
        };
    }

    // ──────────────────────────────────────────────
    //  4. Statistiques
    // ──────────────────────────────────────────────

    const moyenne = v => { const x = v.filter(n => n != null && isFinite(n)); return x.length ? x.reduce((a, b) => a + b, 0) / x.length : null; };
    const mediane = v => {
        const x = v.filter(n => n != null && isFinite(n)).sort((a, b) => a - b);
        if (!x.length) return null;
        const m = Math.floor(x.length / 2);
        return x.length % 2 ? x[m] : (x[m - 1] + x[m]) / 2;
    };

    function statistiques(apprenants, paiements) {
        const avecEchec = apprenants.filter(a => a.nbEchecs > 0);
        const sansIncident = apprenants.filter(a => a.nbEchecs === 0);
        const presentes = paiements.filter(p => p.statut !== 'annule');
        const echecs = paiements.filter(p => p.statut === 'echec');

        return {
            nbApprenants: apprenants.length,
            nbAbonnements: new Set(apprenants.flatMap(a => a.abonnementIds)).size,
            nbSansIncident: sansIncident.length,
            partSansIncident: apprenants.length ? (sansIncident.length / apprenants.length) * 100 : 0,
            eurSansIncident: sansIncident.reduce((s, a) => s + a.montantEncaisse, 0),

            nbAvecIncident: avecEchec.length,
            nbEnDifficulte: apprenants.filter(a => a.enDifficulte).length,
            // « Rattrapé » veut dire que l'apprenant est reparti durablement :
            // aucun rejet sur ses trois derniers prélèvements présentés. Un
            // simple encaissement après l'incident ne suffit pas à le dire.
            nbRattrapes: avecEchec.filter(a => a.etat === 'Incident rattrapé').length,
            partRattrapes: avecEchec.length
                ? (avecEchec.filter(a => a.etat === 'Incident rattrapé').length / avecEchec.length) * 100 : 0,

            nbPrelevements: paiements.length,
            nbPresentes: presentes.length,
            nbEchecsPrelevements: echecs.length,
            tauxEchecPrelevements: presentes.length ? (echecs.length / presentes.length) * 100 : 0,
            montantEchoue: echecs.reduce((s, p) => s + (p.montant || 0), 0),
            montantEncaisse: paiements.filter(p => p.statut === 'succes').reduce((s, p) => s + (p.montant || 0), 0),
            montantARisque: apprenants.filter(a => a.enDifficulte)
                .reduce((s, a) => s + a.montantEchoue + a.montantEnCours, 0),

            delaiMoyenPremierEchec: moyenne(avecEchec.map(a => a.delaiPremierEchec)),
            delaiMedianPremierEchec: mediane(avecEchec.map(a => a.delaiPremierEchec)),
            rangMoyenPremierEchec: moyenne(avecEchec.map(a => a.rangPremierEchec)),
            rangMedianPremierEchec: mediane(avecEchec.map(a => a.rangPremierEchec)),
        };
    }

    /**
     * Courbe de survie sans incident, estimateur de Kaplan-Meier.
     *
     * Chaque apprenant contribue une durée : jusqu'à son premier rejet
     * (événement), ou jusqu'à son dernier prélèvement connu (censuré — il
     * n'a pas encore eu d'incident, mais on ne l'observe pas plus loin).
     * Ignorer la censure surestimerait la casse, puisque les apprenants
     * récents n'ont pas encore eu le temps de tomber.
     */
    function survie(apprenants, maxMois) {
        const bornes = maxMois || 24;
        const sujets = apprenants
            .filter(a => a.datePremier)
            .map(a => ({
                mois: a.nbEchecs
                    ? (a.delaiPremierEchec || 0) / 30.44
                    : (a.dureeObservee || 0) / 30.44,
                evenement: a.nbEchecs > 0,
            }));

        const points = [];
        let s = 1;
        for (let m = 0; m <= bornes; m++) {
            const aRisque = sujets.filter(x => x.mois >= m).length;
            const evenements = sujets.filter(x => x.evenement && x.mois >= m && x.mois < m + 1).length;
            if (aRisque > 0 && evenements > 0) s *= (1 - evenements / aRisque);
            points.push({
                mois: m,
                survie: s * 100,
                aRisque,
                evenements,
            });
            if (aRisque === 0) break;
        }
        return points;
    }

    /** Distribution du rang de prélèvement où survient le premier rejet. */
    function distributionRang(apprenants, maxRang) {
        const borne = maxRang || 12;
        const avecEchec = apprenants.filter(a => a.rangPremierEchec);
        const tranches = [];
        for (let r = 1; r <= borne; r++) {
            const items = avecEchec.filter(a => a.rangPremierEchec === r);
            tranches.push({ rang: String(r), nb: items.length, euros: items.reduce((s, a) => s + a.montantEchoue, 0) });
        }
        const au_dela = avecEchec.filter(a => a.rangPremierEchec > borne);
        tranches.push({ rang: '> ' + borne, nb: au_dela.length, euros: au_dela.reduce((s, a) => s + a.montantEchoue, 0) });
        return tranches;
    }

    /** Taux d'échec mois par mois, sur la date d'échéance du prélèvement. */
    function echecsParMois(paiements) {
        const map = new Map();
        for (const p of paiements) {
            if (!p.dateEcheance || p.statut === 'annule') continue;
            const mk = R.monthKey(p.dateEcheance);
            let m = map.get(mk);
            if (!m) { m = { mois: mk, nb: 0, nbEchecs: 0, euros: 0, eurEchecs: 0 }; map.set(mk, m); }
            m.nb++; m.euros += p.montant || 0;
            if (p.statut === 'echec') { m.nbEchecs++; m.eurEchecs += p.montant || 0; }
        }
        return [...map.values()]
            .sort((a, b) => a.mois.localeCompare(b.mois))
            .map(m => ({ ...m, taux: m.nb ? (m.nbEchecs / m.nb) * 100 : 0,
                          tauxEur: m.euros ? (m.eurEchecs / m.euros) * 100 : 0 }));
    }

    /** Motifs de rejet, quand l'export les fournit. */
    function motifsEchec(paiements) {
        const map = new Map();
        for (const p of paiements) {
            if (p.statut !== 'echec') continue;
            const k = p.motifEchec || 'Motif non renseigné';
            let g = map.get(k);
            if (!g) { g = { motif: k, nb: 0, euros: 0 }; map.set(k, g); }
            g.nb++; g.euros += p.montant || 0;
        }
        return [...map.values()].sort((a, b) => b.nb - a.nb);
    }

    /** Limites de lecture à signaler avant d'exploiter les chiffres. */
    function qualite(apprenants, orphelins) {
        const anomalies = [];
        const push = (titre, gravite, nb, conseil) => { if (nb) anomalies.push({ titre, gravite, nb, conseil }); };

        push("Apprenants identifiés par nom, sans e-mail", 'moyenne',
            apprenants.filter(a => a.identifieParNom).length,
            "Deux homonymes seraient comptés comme une seule personne. Ajouter l'e-mail dans GoCardless lève le doute.");

        push("Apprenants sans e-mail ni nom", 'haute',
            apprenants.filter(a => a.sansIdentite).length,
            "Regroupés sur l'identifiant GoCardless : une même personne inscrite deux fois compte double.");

        push("Prélèvements sans client rattachable", 'haute', orphelins,
            "Importer l'export Customers, et si besoin Mandates, permet de les relier.");

        push("Prélèvements sans date d'échéance", 'moyenne',
            apprenants.reduce((s, a) => s + (a.nbPrelevements - a.echeancier.length), 0),
            "Ils sont exclus des délais et des courbes de survie.");

        // Deux apprenants distincts portant le même nom : e-mails différents,
        // ou véritable homonymie — dans les deux cas, à vérifier.
        const parNom = new Map();
        for (const a of apprenants) {
            const n = R.norm(a.nom);
            if (!n || n === R.norm('(sans nom)')) continue;
            parNom.set(n, (parNom.get(n) || 0) + 1);
        }
        push("Noms portés par plusieurs apprenants", 'basse',
            [...parNom.values()].filter(n => n > 1).length,
            "Même personne avec deux adresses, ou véritables homonymes : l'e-mail tranche.");

        const ordre = { haute: 0, moyenne: 1, basse: 2 };
        anomalies.sort((a, b) => ordre[a.gravite] - ordre[b.gravite] || b.nb - a.nb);
        return anomalies;
    }

    global.LioraPrelevements = {
        STATUTS, LIBELLE_STATUT, classerStatut, detecterType, champ,
        normaliserPaiements, normaliserClients, normaliserMandats, normaliserAbonnements,
        cleApprenant, construireApprenants, analyserApprenant,
        detecterUniteMontant, appliquerUnite,
        statistiques, survie, distributionRang, echecsParMois, motifsEchec, qualite,
        moyenne, mediane,
    };
})(window);
