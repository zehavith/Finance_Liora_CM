/* ==========================================================
   Liora — Suivi Recouvrement
   metrics.js — Calculs d'indicateurs

   Vocabulaire :
     · Échue        : la date d'échéance est passée à la date d'arrêté
     · En retard    : échue et non réglée  → « en recouvrement »
     · Payée en retard : réglée après l'échéance
     · Encours      : montant restant dû
   ========================================================== */

(function (global) {
    'use strict';

    const R = global.LioraRules;

    const sum = (arr, fn) => arr.reduce((a, x) => a + (fn(x) || 0), 0);
    const pct = (a, b) => (b > 0 ? (a / b) * 100 : 0);

    function moyenne(values) {
        const v = values.filter(x => x != null && isFinite(x));
        return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
    }

    function moyennePonderee(items, valFn, poidsFn) {
        let num = 0, den = 0;
        for (const it of items) {
            const v = valFn(it), p = poidsFn(it);
            if (v == null || !isFinite(v) || p == null || !isFinite(p) || p <= 0) continue;
            num += v * p; den += p;
        }
        return den > 0 ? num / den : null;
    }

    function mediane(values) {
        const v = values.filter(x => x != null && isFinite(x)).sort((a, b) => a - b);
        if (!v.length) return null;
        const m = Math.floor(v.length / 2);
        return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
    }

    // ──────────────────────────────────────────────
    //  Filtrage
    // ──────────────────────────────────────────────

    /**
     * @param {Array} factures
     * @param {Object} f  {
     *    mois: Set|null,          // clés YYYY-MM retenues (null = toutes)
     *    baseMois: 'echeance'|'facture'|'paiement',
     *    perimetre: 'Tous'|'Corporate'|'B2C',
     *    sources: Set,            // 'recouvrement','adv','opco','b2c'
     *    financements: Set|null,
     *    etats: Set|null,
     *    boards: Set|null,
     *    bucket: string|null,
     *    client: string|null,
     *    recherche: string,
     *    masquerTechnique: bool,
     *  }
     */
    const ETAT_AVOIR = 'Annulée par avoir';

    function filtrer(factures, f) {
        const champMois = f.baseMois === 'facture' ? 'moisFacture'
            : f.baseMois === 'paiement' ? 'moisPaiement' : 'moisEcheance';
        const q = R.norm(f.recherche || '');

        return factures.filter(x => {
            // Écarte les tableaux techniques ET les groupes de service
            // (archives, corbeilles) hébergés dans un tableau opérationnel.
            if (f.masquerTechnique !== false && (x.role === 'technique' || x.groupeTechnique)) return false;
            if (x.role === 'ignore') return false;

            // Annulée par avoir : la créance a disparu sans qu'un euro rentre.
            // Elle a quitté le portefeuille — elle n'est ni à encaisser, ni à
            // relancer, ni encaissée — et l'y laisser fausse tout : l'encours,
            // les taux, la balance âgée, et des tuiles qui ne totalisent plus
            // cent pour cent. Elle reste consultable en la demandant par son
            // état, et le tableau de bord en donne le compte.
            // Le choix vous revient : « inclureAvoirs » les remet dans tous les
            // écrans, pour lire le portefeuille tel qu'il a été facturé plutôt
            // que tel qu'il reste à encaisser.
            if (x.etat === ETAT_AVOIR && !f.inclureAvoirs
                && !(f.etats && f.etats.has(ETAT_AVOIR))) return false;

            if (f.perimetre && f.perimetre !== 'Tous' && x.perimetre !== f.perimetre) return false;

            // Ne montrer que les créances qu'on ne sait pas dater : c'est la
            // ligne « Date d'échéance manquante » de la balance âgée.
            if (f.sansEcheance && x.dateEcheance) return false;

            // Source : les factures issues du tableau « payées » sont rattachées
            // à leur source d'origine si elle est connue, sinon toujours retenues.
            //
            // Les factures que Sellsy connaît et que Monday ignore n'ont, elles,
            // aucune source de circuit : elles ne sont passées par aucun
            // tableau. Les soumettre à ce filtre les faisait disparaître de
            // tous les écrans alors qu'on venait de demander leur inclusion.
            // C'est leur propre bouton qui les commande, et lui seul.
            if (f.sources && f.sources.size && !x.venueDeSellsy) {
                const src = sourceDe(x);
                if (src && !f.sources.has(src)) return false;
            }

            if (f.financements && f.financements.size && !f.financements.has(x.financement || 'INCONNU')) return false;
            if (f.etats && f.etats.size && !f.etats.has(x.etat)) return false;
            if (f.boards && f.boards.size && !f.boards.has(x.board)) return false;
            if (f.bucket && (!x.bucket || x.bucket.key !== f.bucket)) return false;
            if (f.client && x.client !== f.client) return false;
            if (f.etapes && f.etapes.size && !f.etapes.has(x.etape)) return false;
            if (f.qualif && (!x.qualifs || x.qualifs[f.qualif.nom] !== f.qualif.valeur)) return false;

            // Tranche de retard (histogramme)
            if (f.retardMin != null || f.retardMax != null) {
                if (x.retardJours == null) return false;
                if (f.retardMin != null && x.retardJours < f.retardMin) return false;
                if (f.retardMax != null && x.retardJours > f.retardMax) return false;
            }

            if (f.mois) {
                const mk = x[champMois];
                if (!mk || !f.mois.has(mk)) return false;
            }

            if (q) {
                const hay = R.norm([x.numero, x.client, x.board, x.groupe, x.proprietaire, x.financementBrut].join(' '));
                if (!hay.includes(q)) return false;
            }
            return true;
        });
    }

    /** Source de retard d'une facture (chips du dashboard). */
    function sourceDe(x) {
        if (x.source && x.source !== 'payees' && x.source !== 'technique') return x.source;
        // Facture connue seulement via le tableau des payées : on déduit du groupe d'origine
        const g = R.norm(x.groupeOrigine || x.groupePaiement || x.groupe || '');
        if (!g) return null;
        // « Factures payées avant import + Entre process ADV et recouvrement »
        // nomme les deux étapes : ces factures relèvent de l'ADV, le
        // recouvrement n'y figure que comme borne du parcours.
        if (/avant import|entre process/.test(g)) return 'adv';
        if (g.includes('recouv')) return 'recouvrement';
        if (g.includes('opco')) return 'opco';
        if (g.includes('adv') || g.includes('tampon')) return 'adv';
        if (/cpf|aif|poei|perso|region|transition|agefiph|b2c/.test(g)) return 'b2c';
        return null;
    }

    /**
     * Une facture réglée est-elle passée par le recouvrement ?
     *
     * Deux lectures, volontairement distinctes :
     *  · par la date   — réglée avant l'échéance, elle n'a jamais été en retard
     *  · par le process — le tableau des factures payées conserve le groupe
     *    d'où venait la facture au moment du règlement : s'il mentionne le
     *    recouvrement, elle y est passée, quelle que soit la date.
     *
     * @returns {'recouvrement'|'hors'|'inconnu'}
     */
    function origineRecouvrement(f) {
        if (!f.paye) return 'inconnu';
        if (f.presenceRoles && f.presenceRoles.includes('recouvrement')) return 'recouvrement';

        const g = R.norm([f.groupeOrigine, f.groupePaiement, f.groupe].filter(Boolean).join(' '));
        if (!g) return 'inconnu';
        // Même garde-fou que sourceDe() : « Factures payées avant import +
        // Entre process ADV et recouvrement » nomme les deux étapes sans que
        // la facture soit passée par le recouvrement — le mot n'y est qu'une
        // borne du parcours. Sans ce test, tout ce groupe créditait le
        // recouvrement de règlements antérieurs au circuit lui-même.
        if (/avant import|entre process/.test(g)) return 'hors';
        // « 0.1.5. Factures payées B2C » : le groupe vient de la vue BTC, et
        // ce qu'il contient a bien été relancé. Mais le nom du groupe ne dit
        // pas la date : une facture réglée avant son échéance n'est jamais
        // passée par le recouvrement, quel que soit le tableau où elle finit.
        if (/factures payees b2c|vue btc/.test(g)) {
            return f.etat === 'Payée en retard' ? 'recouvrement' : 'hors';
        }
        if (/recouv|relance|mise en demeure|contentieux|huissier/.test(g)) return 'recouvrement';
        return 'hors';
    }

    // ──────────────────────────────────────────────
    //  Vue d'ensemble
    // ──────────────────────────────────────────────

    function vueEnsemble(factures, dateRef) {
        const ref = dateRef || R.stripTime(new Date());
        const total = factures.length;
        const totalEuros = sum(factures, x => x.montant);

        const enRetard = factures.filter(x => x.etat === 'En retard');
        // 180 jours : borne haute de la tranche « 4 à 6 mois » de la balance
        // âgée, dont la suivante commence à 181. Le recouvrement est exact.
        const vieux = enRetard.filter(x => x.retardJours > 180);
        const vieuxQualifies = vieux.filter(x => x.etape === 'CONTENTIEUX' || x.etape === 'PERTE');
        // L'écart à l'échéance ne se mesure que là où une date de règlement
        // existe : sur une facture réglée, retardJours vaut l'écart entre le
        // règlement et l'échéance, et il est signé — négatif quand l'argent
        // est arrivé en avance. C'est la seule mesure qui réponde à « avant
        // ou après l'échéance », et le filtre porte sur retardJours et non
        // sur dateEcheance, sinon l'effectif annoncé serait plus large que
        // celui réellement mesuré.
        const reglees = factures.filter(x => x.paye && x.retardJours != null);
        const nonEchues = factures.filter(x => x.etat === 'Non échue');
        const payees = factures.filter(x => x.paye);
        const payeesRetard = factures.filter(x => x.etat === 'Payée en retard');
        const echues = factures.filter(x => x.retardJours != null && x.retardJours > 0 || (x.dateEcheance && x.etat !== 'Non échue'));
        const sansEcheance = factures.filter(x => x.etat === 'Échéance inconnue');

        // Le montant de la facture, et non son encours : c'est le chiffre que
        // l'on retrouve dans Monday, donc le seul qui se vérifie d'un coup d'œil.
        const montantRetard = sum(enRetard, x => x.montant);
        const resteAEncaisser = sum(factures.filter(x => !x.paye), x => x.montant);

        // Assiette du taux de cohorte : les factures qui ont eu l'occasion
        // d'être en retard, c'est-à-dire dont l'échéance est passée à la date
        // d'arrêté.
        //
        // Elle se lisait sur l'état, pas sur les dates. Or une facture réglée
        // d'avance porte l'état « Payée », jamais « Non échue » : les 1 013
        // factures de ce cas — 5,7 M€, la formation se paie au démarrage et
        // l'échéance tombe des mois plus tard — entraient au dénominateur sans
        // avoir jamais pu être en retard. Le taux de cohorte en ressortait
        // dilué de treize points.
        const assiette = factures.filter(x => x.dateEcheance && x.dateEcheance <= ref);
        const assietteEuros = sum(assiette, x => x.montant);
        const retardCohorte = assiette.filter(x => x.etat === 'En retard' || x.etat === 'Payée en retard');

        // ── Récupération : ce qui rentre sans passer par le recouvrement ──
        // Assiette = factures arrivées à échéance. Les trois postes
        // (réglé à temps · réglé en retard · encore dû) totalisent 100 %.
        const regleATemps = assiette.filter(x => x.etat === 'Payée');
        // Deux lectures, deux assiettes, et il ne faut pas les confondre.
        //
        // Les quatre tuiles « Où en est le portefeuille » découpent le
        // portefeuille entier — réglé à temps, réglé en retard, encore dû, non
        // échu — et doivent totaliser 100 %. Une facture réglée d'avance y est
        // bien « réglée avant l'échéance ». Elle compte donc ici, sur le total,
        // là où le taux de cohorte ci-dessus l'écarte faute d'échéance passée.
        const regleATempsPortefeuille = factures.filter(x => x.etat === 'Payée');
        // Ce qui est rentré sur une facture : la part réglée quand un avoir en
        // a effacé une partie, son montant sinon.
        const encaisse = x => (x.montantEncaisse != null ? x.montantEncaisse : x.montant);
        const parOrigine = { recouvrement: [], hors: [], inconnu: [] };
        for (const x of payees) parOrigine[origineRecouvrement(x)].push(x);
        const origineConnue = parOrigine.recouvrement.length + parOrigine.hors.length;

        return {
            total, totalEuros,
            nbEnRetard: enRetard.length,
            eurosEnRetard: sum(enRetard, x => x.montant),
            nbNonEchues: nonEchues.length,
            eurosNonEchues: sum(nonEchues, x => x.montant),
            nbPayees: payees.length,
            eurosPayees: sum(payees, x => x.montant),
            nbPayeesRetard: payeesRetard.length,
            eurosPayeesRetard: sum(payeesRetard, x => x.montant),
            nbSansEcheance: sansEcheance.length,
            eurosSansEcheance: sum(sansEcheance, x => x.montant),
            encoursTotal: resteAEncaisser,

            // Taux « à date » : part de l'encours actuellement en retard
            tauxNb: pct(enRetard.length, total),
            tauxEuros: pct(montantRetard, totalEuros),

            // Taux « cohorte » : sur les factures arrivées à échéance,
            // part de celles qui ont été payées en retard ou restent impayées
            tauxCohorteNb: pct(retardCohorte.length, assiette.length),
            tauxCohorteEuros: pct(sum(retardCohorte, x => x.montant), assietteEuros),
            assietteNb: assiette.length,
            assietteEuros,

            // Retards
            retardMoyen: moyenne(enRetard.map(x => x.retardJours)),
            retardMedian: mediane(enRetard.map(x => x.retardJours)),
            retardMax: enRetard.length ? Math.max(...enRetard.map(x => x.retardJours)) : null,
            retardMoyenPondere: moyennePonderee(enRetard, x => x.retardJours, x => x.montant),
            retardMoyenPaiement: moyenne(payeesRetard.map(x => x.retardJours)),
            delaiPaiementMoyen: moyenne(payees.map(x => x.delaiPaiement).filter(d => d != null && d >= 0)),
            // Même population que la moyenne ci-dessus, au filtre près : sans
            // cela, la médiane et la moyenne ne porteraient pas sur le même
            // ensemble et leur écart ne dirait plus rien.
            delaiPaiementMedian: mediane(payees.map(x => x.delaiPaiement).filter(d => d != null && d >= 0)),

            // Ce qui attend depuis plus de six mois, et ce qui en est déjà
            // parti en procédure.
            nbEnRetardVieux: vieux.length,
            eurosEnRetardVieux: sum(vieux, x => x.montant),
            tauxEnRetardVieux: pct(sum(vieux, x => x.montant), montantRetard),
            nbEnRetardVieuxQualifie: vieuxQualifies.length,
            eurosEnRetardVieuxQualifie: sum(vieuxQualifies, x => x.montant),

            // L'écart à l'échéance sur ce qui est rentré, avec son effectif :
            // une médiane sans son dénominateur ne se vérifie pas.
            ecartEcheanceMedian: mediane(reglees.map(x => x.retardJours)),
            ecartEcheanceMoyen: moyenne(reglees.map(x => x.retardJours)),
            nbEcartMesurable: reglees.length,

            // ── Répartition du portefeuille entier ──
            // Base : toutes les factures, échues ou non. C'est la lecture
            // trésorerie : ce qui est rentré, ce qui est bloqué, ce qui arrive.
            tauxPortefeuilleRegleATemps: pct(sum(regleATempsPortefeuille, x => x.montant), totalEuros),
            tauxPortefeuilleRegleRetard: pct(sum(payeesRetard, x => x.montant), totalEuros),
            tauxPortefeuilleEnRetard: pct(sum(enRetard, x => x.montant), totalEuros),
            tauxPortefeuilleNonEchu: pct(sum(nonEchues, x => x.montant), totalEuros),
            tauxPortefeuilleSansEcheance: pct(sum(sansEcheance, x => x.montant), totalEuros),
            eurosNonEchuesFacture: sum(nonEchues, x => x.montant),

            // Réglé sans jamais être en retard
            // La tuile du portefeuille compte toutes les factures réglées à
            // temps ; les deux taux qui suivent sont des taux de cohorte et se
            // lisent sur l'assiette échue.
            nbRegleATemps: regleATempsPortefeuille.length,
            eurosRegleATemps: sum(regleATempsPortefeuille, x => x.montant),
            tauxRegleATempsNb: pct(regleATemps.length, assiette.length),
            tauxRegleATempsEuros: pct(sum(regleATemps, x => x.montant), assietteEuros),

            // Réglé après l'échéance : récupéré, mais au prix d'un retard
            tauxRegleRetardNb: pct(payeesRetard.length, assiette.length),
            tauxRegleRetardEuros: pct(sum(payeesRetard, x => x.montant), assietteEuros),

            // Encore à recouvrer
            tauxResteNb: pct(enRetard.length, assiette.length),
            tauxResteEuros: pct(sum(enRetard, x => x.montant), assietteEuros),

            // Lecture « process » : d'où venait la facture quand elle a été
            // réglée. Ces montants-là disent ce qui est RENTRÉ : ils passent
            // donc par l'encaissé, et non par le montant de la facture, sans
            // quoi la part qu'un avoir a effacée serait comptée comme de
            // l'argent récupéré.
            nbPayeesHorsRecouvrement: parOrigine.hors.length,
            eurosPayeesHorsRecouvrement: sum(parOrigine.hors, encaisse),
            nbPayeesViaRecouvrement: parOrigine.recouvrement.length,
            eurosPayeesViaRecouvrement: sum(parOrigine.recouvrement, encaisse),
            nbOrigineInconnue: parOrigine.inconnu.length,
            tauxHorsRecouvrementNb: pct(parOrigine.hors.length, origineConnue),
            tauxHorsRecouvrementEuros: pct(
                sum(parOrigine.hors, encaisse),
                sum(parOrigine.hors, encaisse) + sum(parOrigine.recouvrement, encaisse)),

            // DSO simplifié : encours / CA moyen journalier de la période
            dso: null,
            echues: echues.length,
        };
    }

    // ──────────────────────────────────────────────
    //  Séries mensuelles
    // ──────────────────────────────────────────────

    /**
     * Décompose chaque mois en 4 cohortes exclusives :
     *   payeeATemps · payeeRetard · enRetard · nonEchue
     * et calcule le taux de recouvrement (nb et €).
     */
    function parMois(factures, baseMois) {
        const champ = baseMois === 'facture' ? 'moisFacture'
            : baseMois === 'paiement' ? 'moisPaiement' : 'moisEcheance';

        const map = new Map();
        for (const f of factures) {
            const mk = f[champ];
            if (!mk) continue;
            let m = map.get(mk);
            if (!m) {
                m = {
                    mois: mk,
                    nbTotal: 0, eurTotal: 0,
                    nbPayeeATemps: 0, eurPayeeATemps: 0,
                    nbPayeeRetard: 0, eurPayeeRetard: 0,
                    nbEnRetard: 0, eurEnRetard: 0,
                    nbNonEchue: 0, eurNonEchue: 0,
                    nbSansEcheance: 0, eurSansEcheance: 0,
                    retards: [],
                };
                map.set(mk, m);
            }
            const eur = f.montant || 0;
            m.nbTotal++; m.eurTotal += eur;

            switch (f.etat) {
                case 'Payée':          m.nbPayeeATemps++; m.eurPayeeATemps += eur; break;
                case 'Payée en retard': m.nbPayeeRetard++; m.eurPayeeRetard += eur; m.retards.push(f.retardJours); break;
                case 'En retard':      m.nbEnRetard++;    m.eurEnRetard += f.montant || eur; m.retards.push(f.retardJours); break;
                case 'Non échue':      m.nbNonEchue++;    m.eurNonEchue += eur; break;
                default:               m.nbSansEcheance++; m.eurSansEcheance += eur;
            }
        }

        const rows = [...map.values()].sort((a, b) => a.mois.localeCompare(b.mois));
        for (const m of rows) {
            const assietteNb = m.nbTotal - m.nbNonEchue - m.nbSansEcheance;
            const assietteEur = m.eurTotal - m.eurNonEchue - m.eurSansEcheance;
            m.assietteNb = assietteNb;
            m.assietteEur = assietteEur;
            m.tauxNb = pct(m.nbEnRetard + m.nbPayeeRetard, assietteNb);
            m.tauxEur = pct(m.eurEnRetard + m.eurPayeeRetard, assietteEur);
            m.tauxImpayeNb = pct(m.nbEnRetard, assietteNb);
            m.tauxImpayeEur = pct(m.eurEnRetard, assietteEur);
            m.retardMoyen = moyenne(m.retards);
        }
        return rows;
    }

    // ──────────────────────────────────────────────
    //  Par type de financement
    // ──────────────────────────────────────────────

    function parFinancement(factures, rules, dateRef) {
        const ref = dateRef || R.stripTime(new Date());
        const map = new Map();
        for (const f of factures) {
            const key = f.financement || 'INCONNU';
            let g = map.get(key);
            if (!g) {
                const rule = R.getRule(key, rules);
                g = {
                    key, label: rule.label, note: rule.note,
                    perimetre: rule.perimetre, sansRecouvrement: !!rule.sansRecouvrement,
                    items: [],
                };
                map.set(key, g);
            }
            g.items.push(f);
        }

        const rows = [...map.values()].map(g => {
            const enRetard = g.items.filter(x => x.etat === 'En retard');
            const payeeRetard = g.items.filter(x => x.etat === 'Payée en retard');
            // Même assiette que le tableau de bord : les factures qui ont eu
            // l'occasion d'être en retard, donc dont l'échéance est passée.
            const assiette = g.items.filter(x => x.dateEcheance && x.dateEcheance <= ref);
            const eurTotal = sum(g.items, x => x.montant);
            const eurAssiette = sum(assiette, x => x.montant);
            const regleATemps = assiette.filter(x => x.etat === 'Payée');
            const nonEchues = g.items.filter(x => x.etat === 'Non échue');
            const payees = g.items.filter(x => x.paye);
            // Une facture réglée dont l'échéance n'est pas calculable porte
            // l'état « Échéance inconnue » tout en étant réglée : la compter
            // dans les deux colonnes faisait un total supérieur au nombre de
            // factures de la ligne. Les quatre colonnes doivent s'exclure,
            // sinon elles ne se vérifient pas. Le règlement prime.
            const sansEcheance = g.items.filter(x => x.etat === 'Échéance inconnue' && !x.paye);
            const sansEcheanceReglees = g.items.filter(x => x.etat === 'Échéance inconnue' && x.paye);
            return {
                ...g,
                nbNonEchues: nonEchues.length,
                eurNonEchues: sum(nonEchues, x => x.montant),
                nbPayees: payees.length,
                eurPayees: sum(payees, x => x.montant),
                nbSansEcheance: sansEcheance.length,
                eurSansEcheance: sum(sansEcheance, x => x.montant),
                nbSansEcheanceReglees: sansEcheanceReglees.length,
                // Factures sans montant exploitable : un « % en retard » calculé
                // en euros y vaut zéro quel que soit le nombre de retards, ce
                // qui ne se comprend pas sans le dire.
                nbSansMontant: g.items.filter(x => !x.montant).length,
                nbRegleATemps: regleATemps.length,
                eurRegleATemps: sum(regleATemps, x => x.montant),
                tauxRegleATempsNb: pct(regleATemps.length, assiette.length),
                tauxRegleATempsEur: pct(sum(regleATemps, x => x.montant), eurAssiette),
                nbTotal: g.items.length,
                eurTotal,
                nbEnRetard: enRetard.length,
                eurEnRetard: sum(enRetard, x => x.montant),
                nbPayeeRetard: payeeRetard.length,
                // Le dénominateur du taux de rentrée en euros est exactement
                // le numérateur du taux de bascule tauxCohorteEur : les deux
                // barres sont cohérentes par construction.
                eurPayeeRetard: sum(payeeRetard, x => x.montant),
                eurSansEcheanceReglees: sum(sansEcheanceReglees, x => x.montant),
                nbAssiette: assiette.length,
                eurAssiette,
                tauxNb: pct(enRetard.length, g.items.length),
                tauxEur: pct(sum(enRetard, x => x.montant), eurTotal),
                tauxCohorteNb: pct(enRetard.length + payeeRetard.length, assiette.length),
                tauxCohorteEur: pct(sum(enRetard, x => x.montant) + sum(payeeRetard, x => x.montant), eurAssiette),
                retardMoyen: moyenne(enRetard.map(x => x.retardJours)),
                retardMoyenPondere: moyennePonderee(enRetard, x => x.retardJours, x => x.montant),
                retardMoyenPaiement: moyenne(payeeRetard.map(x => x.retardJours)),
            };
        });
        rows.sort((a, b) => b.eurEnRetard - a.eurEnRetard);
        return rows;
    }

    /**
     * Le cœur de l'acte II : quand les clients payent, avant ou après
     * l'échéance, par type de financement.
     *
     * Quatre lots qui s'excluent et se totalisent, et c'est le point entier de
     * cette fonction. La colonne « avant » se définit sur retardJours <= 0 et
     * NON sur l'état « Payée » : cet état est posé par défaut quand la date de
     * règlement manque, si bien qu'une partition à deux termes range dans
     * « avant l'échéance » des factures dont rien n'atteste qu'elles y soient.
     * C'est une catégorie tampon déguisée, et les deux derniers lots — réglées
     * sans échéance calculable, réglées sans date de règlement connue — sont
     * là pour qu'elle n'existe pas.
     *
     * Contrôle : la somme des nbTotal vaut le nombre de payées du tableau de
     * bord et celle des eurTotal vaut l'encaissé, les deux étant sommés sur le
     * montant de la facture comme ici.
     *
     * Nommage : surtout pas nbSansEcheance, qui dans parFinancement désigne
     * les NON réglées.
     */
    function reglementsParEcheance(factures, rules) {
        const map = new Map();
        for (const f of factures.filter(x => x.paye)) {
            const cle = f.financement || 'INCONNU';
            let g = map.get(cle);
            if (!g) {
                const r = R.getRule(cle, rules);
                // `terme` est la règle de délai du dispositif, telle qu'elle
                // est écrite : c'est la seule référence qui existe, et c'est
                // elle qui tranche entre relancer plus tôt et renégocier.
                g = { cle, label: r.label, terme: r.note, items: [] };
                map.set(cle, g);
            }
            g.items.push(f);
        }
        return [...map.values()].map(g => {
            const avant = g.items.filter(x => x.retardJours != null && x.retardJours <= 0);
            const apres = g.items.filter(x => x.etat === 'Payée en retard');
            const sansEch = g.items.filter(x => !x.dateEcheance);
            const sansDate = g.items.filter(x => x.dateEcheance && !x.datePaiementEffective);
            const ecarts = g.items.filter(x => x.retardJours != null).map(x => x.retardJours);
            const eurAvant = sum(avant, x => x.montant), eurApres = sum(apres, x => x.montant);
            return Object.assign({}, g, {
                nbAvant: avant.length, eurAvant,
                nbApres: apres.length, eurApres,
                nbSansEcheanceReglees: sansEch.length,
                eurSansEcheanceReglees: sum(sansEch, x => x.montant),
                nbSansDateReglement: sansDate.length,
                eurSansDateReglement: sum(sansDate, x => x.montant),
                nbTotal: g.items.length, eurTotal: sum(g.items, x => x.montant),
                partApresEur: pct(eurApres, eurAvant + eurApres),
                // L'effectif s'affiche à côté de la médiane : sans lui, elle
                // porterait sur une population plus étroite que le nombre de
                // la ligne, et le tableau cesserait d'être auditable.
                ecartMedian: mediane(ecarts), ecartMoyen: moyenne(ecarts), nbEcarts: ecarts.length,
                avant, apres, sansEch, sansDate,
            });
        }).sort((a, b) => b.eurApres - a.eurApres);
    }

    /**
     * La part mensuelle de l'encaissement arrivée après l'échéance.
     *
     * Une part, et non un volume : la carte de flux de l'acte I donne déjà les
     * volumes, et c'est la pente qui se lit ici. La couverture — ce qui est
     * datable face à l'encaissé entier — s'affiche sous la courbe, faute de
     * quoi le graphique contredirait en silence la barre de l'acte II.
     */
    function partApresParMois(factures) {
        const payees = factures.filter(f => f.paye);
        const map = new Map();
        for (const f of payees) {
            if (!f.moisPaiement) continue;        // pas de date de règlement, pas de point
            let g = map.get(f.moisPaiement);
            if (!g) { g = { mois: f.moisPaiement, avant: [], apres: [] }; map.set(f.moisPaiement, g); }
            if (f.etat === 'Payée en retard') g.apres.push(f);
            else if (f.retardJours != null && f.retardJours <= 0) g.avant.push(f);
        }
        const rows = [...map.values()].sort((a, b) => a.mois < b.mois ? -1 : 1).map(g => {
            const eurAvant = sum(g.avant, x => x.montant), eurApres = sum(g.apres, x => x.montant);
            return {
                mois: g.mois, items: g.avant.concat(g.apres),
                itemsAvant: g.avant, itemsApres: g.apres,
                nbAvant: g.avant.length, nbApres: g.apres.length,
                eurAvant, eurApres, partApres: pct(eurApres, eurAvant + eurApres),
            };
        });
        return {
            rows,
            eurDatables: sum(rows, r => r.eurAvant + r.eurApres),
            eurTotal: sum(payees, x => x.montant),
        };
    }

    /** Croisement mois × financement — taux en nb et en €. */
    function croiseMoisFinancement(factures, baseMois, rules, dateRef) {
        const champ = baseMois === 'facture' ? 'moisFacture'
            : baseMois === 'paiement' ? 'moisPaiement' : 'moisEcheance';
        // La carte thermique et la courbe montrent la même chose : elles
        // doivent la compter pareil. Deux écarts les séparaient.
        //
        // · La maturité se jugeait sur l'état — une facture réglée d'avance
        //   porte « Payée », pas « Non échue », et entrait dans l'assiette d'un
        //   mois à venir, qui ressortait à 0 %. Elle se juge sur les dates.
        // · Le retard ne comptait que « En retard », laissant de côté « Payée
        //   en retard » : une créance récupérée disparaissait du taux, et la
        //   case s'éclaircissait à mesure que le recouvrement travaillait.
        const ref = dateRef || R.stripTime(new Date());
        const limite = R.monthKey(ref);
        const mois = [...new Set(factures.map(f => f[champ]).filter(Boolean))]
            .sort().filter(m => m <= limite);
        const fins = [...new Set(factures.map(f => f.financement || 'INCONNU'))];

        const cell = {};
        for (const f of factures) {
            const mk = f[champ]; if (!mk || mk > limite) continue;
            const fin = f.financement || 'INCONNU';
            const k = mk + '|' + fin;
            const c = cell[k] || (cell[k] = { nbTotal: 0, eurTotal: 0, nbRetard: 0, eurRetard: 0, nbAssiette: 0, eurAssiette: 0 });
            c.nbTotal++; c.eurTotal += f.montant || 0;
            if (f.dateEcheance && f.dateEcheance <= ref) { c.nbAssiette++; c.eurAssiette += f.montant || 0; }
            if (f.etat === 'En retard' || f.etat === 'Payée en retard') {
                c.nbRetard++; c.eurRetard += f.montant || 0;
            }
        }

        fins.sort((a, b) => {
            const ea = sum(mois.map(m => cell[m + '|' + a]).filter(Boolean), c => c.eurRetard);
            const eb = sum(mois.map(m => cell[m + '|' + b]).filter(Boolean), c => c.eurRetard);
            return eb - ea;
        });

        return {
            mois, fins,
            labels: Object.fromEntries(fins.map(k => [k, R.getRule(k, rules).label])),
            cell: (m, f) => cell[m + '|' + f] || null,
        };
    }

    /**
     * Évolution du taux de recouvrement, une série par type de financement.
     *
     * Le croisement mois × financement existe déjà sous forme de carte
     * thermique, mais une grille de couleurs dit mal si une catégorie se
     * dégrade ou s'assainit : c'est une variation, elle se lit sur une courbe.
     *
     * Le taux est celui de la cohorte échue — sur les factures arrivées à
     * échéance dans le mois, la part payée en retard ou encore impayée. C'est le
     * seul comparable d'un mois à l'autre : un taux « à date » ferait chuter
     * mécaniquement les mois récents, dont les factures n'ont pas encore eu le
     * temps d'être en retard.
     *
     * @param {Array} factures
     * @param {string} baseMois
     * @param {Array} rules
     * @param {number} [minAssiette] taille minimale de cohorte pour qu'un point
     *        soit tracé — trois factures ne font pas un taux
     * @returns {{mois:Array, series:Array}}
     */
    function evolutionParFinancement(factures, baseMois, rules, minAssiette, dateRef) {
        const seuil = minAssiette == null ? 5 : minAssiette;
        // La maturité d'une cohorte se juge sur les dates, pas sur les états :
        // une facture réglée d'avance porte l'état « Payée », pas « Non échue »,
        // et passait donc pour exigible. Un mois à venir se retrouvait tracé à
        // 0 % sur ses seules factures payées d'avance — la chute finale de la
        // courbe, qui se lisait comme un redressement.
        const ref = dateRef || R.stripTime(new Date());
        const champ = baseMois === 'facture' ? 'moisFacture'
            : baseMois === 'paiement' ? 'moisPaiement' : 'moisEcheance';

        // Une cohorte encore largement non échue ne se mesure pas.
        //
        // Les derniers mois de la courbe tombaient à 0 % : leurs factures ne
        // sont pas en retard parce qu'elles ne sont pas encore exigibles. Le
        // taux était calculé sur la poignée déjà échue — souvent réglée à
        // l'heure — et se lisait comme un redressement. On compte donc aussi
        // les non échues, pour savoir si le mois est mûr.
        const COMPLETUDE = 0.8;
        const parFin = new Map();
        const moisVus = new Set();
        for (const f of factures) {
            const mk = f[champ];
            if (!mk || !f.dateEcheance) continue;
            const cle = f.financement || 'INCONNU';
            let g = parFin.get(cle);
            if (!g) { g = { cle, mois: new Map() }; parFin.set(cle, g); }
            let c = g.mois.get(mk);
            if (!c) { c = { nb: 0, eur: 0, nbRetard: 0, eurRetard: 0, nbTotal: 0 }; g.mois.set(mk, c); }
            c.nbTotal++;
            // Assiette : les factures dont l'échéance est passée à la date
            // d'arrêté, qu'elles soient réglées ou non.
            if (f.dateEcheance > ref) continue;
            moisVus.add(mk);
            c.nb++; c.eur += f.montant || 0;
            if (f.etat === 'En retard' || f.etat === 'Payée en retard') {
                c.nbRetard++; c.eurRetard += f.montant || 0;
            }
        }
        const mure = c => c && c.nbTotal > 0 && c.nb / c.nbTotal >= COMPLETUDE;

        const mois = [...moisVus].sort();
        const series = [...parFin.values()].map(g => ({
            cle: g.cle,
            label: R.getRule(g.cle, rules).label,
            nbTotal: sum([...g.mois.values()], c => c.nb),
            eurRetard: sum([...g.mois.values()], c => c.eurRetard),
            // Un point par mois, null là où la cohorte est trop petite : la
            // courbe s'interrompt au lieu de sauter de 0 à 100 %.
            pointsNb: mois.map(m => {
                const c = g.mois.get(m);
                return mure(c) && c.nb >= seuil ? pct(c.nbRetard, c.nb) : null;
            }),
            pointsEur: mois.map(m => {
                const c = g.mois.get(m);
                return mure(c) && c.nb >= seuil && c.eur > 0 ? pct(c.eurRetard, c.eur) : null;
            }),
            cohortes: mois.map(m => (g.mois.get(m) || { nb: 0 }).nb),
            // La part déjà exigible de chaque mois : c'est elle qui décide si
            // le point est traçable, et elle se dit dans l'infobulle.
            maturites: mois.map(m => {
                const c = g.mois.get(m);
                return c && c.nbTotal ? Math.round(c.nb / c.nbTotal * 100) : null;
            }),
        })).filter(s => s.pointsNb.some(v => v != null))
           .sort((a, b) => b.eurRetard - a.eurRetard);

        // Les derniers mois où plus aucune série n'a de point traçable : ce
        // sont les cohortes encore en cours. Les garder laissait la courbe
        // plonger dans le vide et se lire comme une amélioration.
        let dernier = mois.length - 1;
        while (dernier >= 0 && !series.some(s2 => s2.pointsNb[dernier] != null)) dernier--;
        const coupes = mois.length - 1 - dernier;
        if (coupes > 0) {
            mois.length = dernier + 1;
            for (const s2 of series) {
                s2.pointsNb.length = mois.length;
                s2.pointsEur.length = mois.length;
                s2.cohortes.length = mois.length;
                s2.maturites.length = mois.length;
            }
        }

        return { mois, series, moisEnCours: coupes };
    }

    /**
     * Analyse des factures réglées, selon qu'elles soient passées ou non par le
     * recouvrement.
     *
     * Deux populations qu'il faut savoir comparer : celles qui ont demandé une
     * relance, et celles qui sont rentrées seules. La première dit ce que le
     * travail de recouvrement rapporte, la seconde ce qui rentre sans effort.
     *
     * @param {Array} factures
     * @param {'recouvrement'|'hors'} origine
     * @param {Array} rules
     */
    function reglementsParOrigine(factures, origine, rules) {
        const payees = factures.filter(f => f.paye);
        const lot = payees.filter(f => origineRecouvrement(f) === origine);
        const inconnu = payees.filter(f => origineRecouvrement(f) === 'inconnu');

        // Répartition par financement, les plus gros montants d'abord.
        const parFin = new Map();
        for (const f of lot) {
            const k = f.financement || 'INCONNU';
            let g = parFin.get(k);
            if (!g) { g = { cle: k, label: R.getRule(k, rules).label, items: [] }; parFin.set(k, g); }
            g.items.push(f);
        }
        const financements = [...parFin.values()].map(g => ({
            cle: g.cle, label: g.label,
            nb: g.items.length,
            euros: sum(g.items, x => x.montant),
            retardMoyen: moyenne(g.items.map(x => x.retardJours)),
        })).sort((a, b) => b.euros - a.euros);

        // Ce qui rentre chaque mois, au mois de l'encaissement.
        const parMois = new Map();
        for (const f of lot) {
            const mk = f.moisPaiement;
            if (!mk) continue;
            let g = parMois.get(mk);
            if (!g) { g = { mois: mk, nb: 0, euros: 0, retards: [] }; parMois.set(mk, g); }
            g.nb++; g.euros += f.montant || 0;
            if (f.retardJours != null) g.retards.push(f.retardJours);
        }
        const mois = [...parMois.values()]
            .map(g => ({ mois: g.mois, nb: g.nb, euros: g.euros, retardMoyen: moyenne(g.retards) }))
            .sort((a, b) => a.mois.localeCompare(b.mois));

        const enRetard = lot.filter(f => f.etat === 'Payée en retard');
        return {
            origine,
            // Les factures elles-mêmes : un chiffre qu'on ne peut pas ouvrir ne
            // se vérifie pas, et celui des « payées avant échéance » demande à
            // l'être — il a l'air de contredire le passage en recouvrement.
            factures: lot,
            nb: lot.length,
            euros: sum(lot, x => x.montant),
            // Part des règlements dont l'origine est connue : les factures sans
            // groupe d'origine ne peuvent être attribuées ni à l'un ni à l'autre.
            partNb: pct(lot.length, payees.length - inconnu.length),
            partEuros: pct(sum(lot, x => x.montant),
                sum(payees.filter(f => origineRecouvrement(f) !== 'inconnu'), x => x.montant)),
            // Le dénominateur, nommé : un pourcentage sans son total ne se
            // vérifie pas, et « part des règlements » ne disait pas part de quoi.
            nbBase: payees.length - inconnu.length,
            eurosBase: sum(payees.filter(f => origineRecouvrement(f) !== 'inconnu'), x => x.montant),
            nbEnRetard: enRetard.length,
            eurosEnRetard: sum(enRetard, x => x.montant),
            retardMoyen: moyenne(enRetard.map(x => x.retardJours)),
            delaiMoyen: moyenne(lot.map(x => x.delaiPaiement).filter(d => d != null && d >= 0)),
            nbOrigineInconnue: inconnu.length,
            financements,
            mois,
        };
    }

    // ──────────────────────────────────────────────
    //  Répartition des montants
    //
    //  Montant total = hors recouvrement + en recouvrement, à l'euro près.
    //    · en recouvrement  : échu et impayé
    //    · hors recouvrement : réglé, non échu, ou échéance non calculable
    //  Les montants sont ceux des factures (et non l'encours), afin que les
    //  colonnes s'additionnent ; l'encours restant dû est fourni à part.
    // ──────────────────────────────────────────────

    function agreger(items) {
        const enRec = items.filter(x => x.etat === 'En retard');
        const regle = items.filter(x => x.paye);
        const nonEchu = items.filter(x => x.etat === 'Non échue');
        const sansEch = items.filter(x => x.etat === 'Échéance inconnue');

        const total = sum(items, x => x.montant);
        const eurEnRec = sum(enRec, x => x.montant);

        return {
            nb: items.length,
            total,
            eurRegle: sum(regle, x => x.montant),
            nbRegle: regle.length,
            eurNonEchu: sum(nonEchu, x => x.montant),
            nbNonEchu: nonEchu.length,
            eurSansEcheance: sum(sansEch, x => x.montant),
            nbSansEcheance: sansEch.length,
            eurEnRecouvrement: eurEnRec,
            nbEnRecouvrement: enRec.length,
            eurHorsRecouvrement: total - eurEnRec,
            nbHorsRecouvrement: items.length - enRec.length,
            encoursEnRecouvrement: sum(enRec, x => x.montant),
            tauxEur: pct(eurEnRec, total),
            tauxNb: pct(enRec.length, items.length),
            retardMoyen: moyenne(enRec.map(x => x.retardJours)),
        };
    }

    /**
     * Construit l'arbre de répartition selon une pile de dimensions.
     * @param {Array} factures
     * @param {Array<{key,fn,labelFn}>} dims  du plus général au plus fin
     * @param {string} cheminParent  identifiant du nœud parent
     */
    function repartitionMontants(factures, dims, cheminParent) {
        if (!dims.length) return [];
        const [dim, ...reste] = dims;

        const groupes = new Map();
        for (const f of factures) {
            const cle = dim.fn(f) || '—';
            let g = groupes.get(cle);
            if (!g) { g = []; groupes.set(cle, g); }
            g.push(f);
        }

        const noeuds = [...groupes.entries()].map(([cle, items]) => {
            const chemin = (cheminParent ? cheminParent + '›' : '') + dim.key + ':' + cle;
            return {
                chemin,
                dimension: dim.key,
                cle,
                label: dim.labelFn ? dim.labelFn(cle, items[0]) : cle,
                items,
                ...agreger(items),
                enfants: repartitionMontants(items, reste, chemin),
            };
        });

        noeuds.sort((a, b) => b.eurEnRecouvrement - a.eurEnRecouvrement || b.total - a.total);
        return noeuds;
    }

    // ──────────────────────────────────────────────
    //  Balance âgée
    // ──────────────────────────────────────────────

    /**
     * La clé des créances dont l'échéance est inconnue.
     *
     * Elles étaient purement écartées de la balance âgée : leur montant
     * n'apparaissait nulle part, et une facture qu'on ne sait pas dater
     * disparaissait au lieu d'appeler du travail. Elles ont désormais leur
     * ligne, et leur montant est rangé en non échu — faute de savoir depuis
     * quand elles sont dues, on ne peut pas les déclarer en retard.
     */
    const ECHEANCE_MANQUANTE = '__ECHEANCE_MANQUANTE__';
    const LABEL_ECHEANCE_MANQUANTE = 'Date d’échéance manquante — à qualifier';

    function balanceAgee(factures) {
        const nonPayees = factures.filter(x => !x.paye);
        return R.AGING_BUCKETS.map(b => {
            // Sans échéance, pas d'ancienneté : la créance est comptée en non
            // échu, la seule tranche qui n'affirme rien sur son retard.
            const items = nonPayees.filter(x => x.bucket
                ? x.bucket.key === b.key
                : b.key === 'nonEchu');
            return {
                ...b,
                // Les factures de la tranche : un montant qu'on ne peut pas
                // ouvrir ne se vérifie pas, et « 288 157 € sur 62 factures »
                // appelle immédiatement « lesquelles ».
                items,
                nb: items.length,
                euros: sum(items, x => x.montant),
                partNb: pct(items.length, nonPayees.length),
                partEuros: pct(sum(items, x => x.montant), sum(nonPayees, x => x.montant)),
            };
        });
    }

    /** Balance âgée croisée avec une dimension (financement, tableau, propriétaire…). */
    /**
     * La balance âgée du portefeuille, rangée par la dimension de votre choix.
     *
     * Deux réglages, parce que cette vue sert aussi à CONFRONTER le
     * portefeuille à la comptabilité, et qu'une confrontation n'a de sens
     * qu'entre deux grandeurs de même nature :
     *
     *   `montant`           — ce qui s'additionne. Par défaut le montant de la
     *                         facture, qui est ce que l'écran « Balance âgée »
     *                         montre. Pour la confrontation, c'est l'encours
     *                         qu'il faut : la comptabilité, en face, additionne
     *                         des restes dus, et une facture à moitié réglée
     *                         pesait donc son montant entier d'un côté et son
     *                         solde de l'autre.
     *   `isolerSansEcheance` — sortir ou non les factures sans date d'échéance
     *                         sur une ligne à part. L'écran les isole, parce
     *                         qu'elles sont à qualifier. La comptabilité, elle,
     *                         laisse ses créances non datées dans leur
     *                         dispositif : les isoler d'un seul côté vidait
     *                         chaque dispositif de ses factures non datées et
     *                         creusait un écart qui n'existe pas.
     */
    function balanceAgeeParDimension(factures, dimFn, labelFn, reglages) {
        const o = reglages || {};
        const montantDe = o.montant || (f => f.montant);
        const isoler = o.isolerSansEcheance !== false;
        const nonPayees = factures.filter(x => !x.paye);
        const map = new Map();
        for (const f of nonPayees) {
            // Une créance sans échéance ne relève d'aucun dispositif tant
            // qu'on ne l'a pas datée : elle a sa propre ligne, qui dit ce
            // qu'il y a à faire.
            const sansEcheance = isoler && !f.dateEcheance;
            const k = sansEcheance ? ECHEANCE_MANQUANTE : (dimFn(f) || '—');
            let row = map.get(k);
            if (!row) {
                row = { key: k,
                        label: sansEcheance ? LABEL_ECHEANCE_MANQUANTE : (labelFn ? labelFn(k, f) : k),
                        sansEcheance, total: 0, nb: 0, echu: 0, echuNb: 0,
                        // Les factures de chaque case : une case qu'on ne peut
                        // pas ouvrir ne se vérifie pas.
                        items: [], itemsParTranche: {} };
                for (const b of R.AGING_BUCKETS) { row[b.key] = 0; row[b.key + '_nb'] = 0; }
                map.set(k, row);
            }
            row.items.push(f);
            const b = (sansEcheance || !f.dateEcheance) ? { key: 'nonEchu' } : f.bucket;
            if (b) {
                row[b.key] += montantDe(f) || 0; row[b.key + '_nb']++;
                (row.itemsParTranche[b.key] || (row.itemsParTranche[b.key] = [])).push(f);
            }
            // Ce qui est échu et toujours dû : tout sauf la tranche « non
            // échu ». C'est le montant en retard, celui sur lequel il y a
            // quelque chose à faire.
            if (f.etat === 'En retard') { row.echu += montantDe(f) || 0; row.echuNb++; }
            row.total += montantDe(f) || 0;
            row.nb++;
        }
        // La ligne des échéances manquantes ferme la marche : c'est un reste à
        // qualifier, pas un dispositif.
        return [...map.values()].sort((a, b) =>
            (a.sansEcheance ? 1 : 0) - (b.sansEcheance ? 1 : 0) || b.total - a.total);
    }

    // ──────────────────────────────────────────────
    //  Flux de recouvrement
    //
    //  Pour chaque mois :
    //    · entrées — factures devenues échues sans être réglées
    //    · sorties — factures en retard encaissées dans le mois
    //    · stock   — encours en retard constaté à la fin du mois
    //  Le stock est recalculé à chaque fin de mois plutôt que cumulé, pour
    //  rester juste même quand une facture entre et sort le même mois.
    // ──────────────────────────────────────────────

    function finDeMois(mk) {
        const [y, m] = mk.split('-').map(Number);
        return new Date(y, m, 0);   // jour 0 du mois suivant = dernier jour de mk
    }

    function fluxRecouvrement(factures, moisList, dateRef) {
        const limite = dateRef ? R.monthKey(dateRef) : null;
        const mois = moisList.filter(m => !limite || m <= limite);

        // Le mois en cours s'arrête à la date d'arrêté, et non à son dernier
        // jour calendaire. Sans cette borne, le stock de fin de série est
        // calculé à une date future : il compte des factures qui ne sont pas
        // encore échues, et la courbe montre une aggravation qui n'est que du
        // calendrier.
        const borne = dateRef ? R.stripTime(dateRef) : R.stripTime(new Date());

        return mois.map(mk => {
            const brut = finDeMois(mk);
            const fin = brut > borne ? borne : brut;

            // Une date d'encaissement ne suffit pas à faire un règlement : une
            // date saisie sur un tableau opérationnel, sans ligne dans le
            // tableau des payées, laisse la facture due partout ailleurs. Le
            // flux repose donc sur la même définition que le reste — f.paye —
            // sans quoi il déclarait recouvré ce que les autres écrans
            // comptaient encore à recouvrer.
            const regle = f => f.paye === true && !!f.datePaiementEffective;

            const entrees = factures.filter(f =>
                f.dateEcheance && f.moisEcheance === mk &&
                (!regle(f) || f.datePaiementEffective > f.dateEcheance));

            const sorties = factures.filter(f =>
                regle(f) && R.monthKey(f.datePaiementEffective) === mk &&
                f.dateEcheance && f.datePaiementEffective > f.dateEcheance);

            // Impayé à la fin du mois : échue au plus tard ce jour-là, et pas
            // encore réglée à cette date.
            const stock = factures.filter(f =>
                f.dateEcheance && f.dateEcheance <= fin &&
                (!regle(f) || f.datePaiementEffective > fin));

            // 180 jours est la borne haute de la tranche « 4 à 6 mois » de la
            // balance âgée, dont la suivante commence à 181 : la part ancienne
            // de ce stock et la tranche « 6 à 12 mois » sont le même trait.
            const stockVieux = stock.filter(f => R.diffDays(fin, f.dateEcheance) > 180);

            return {
                mois: mk,
                // Les trois lots étaient construits puis jetés : sans eux
                // aucun compteur du flux ne s'ouvre sur ses factures.
                fin, entrees, sorties, stock,
                nbEntrees: entrees.length,
                eurEntrees: sum(entrees, f => f.montant),
                nbSorties: sorties.length,
                eurSorties: sum(sorties, f => f.montant),
                nbStock: stock.length,
                eurStock: sum(stock, f => f.montant),
                nbStockVieux: stockVieux.length,
                eurStockVieux: sum(stockVieux, f => f.montant),
                retardMoyenStock: moyenne(stock.map(f => R.diffDays(fin, f.dateEcheance))),
                retardMedianStock: mediane(stock.map(f => R.diffDays(fin, f.dateEcheance))),
                // Écart signé entre règlement et échéance sur les factures
                // encaissées dans le mois : négatif = payé en avance.
                retardMoyenReglement: moyenne(factures
                    .filter(f => regle(f) && f.dateEcheance
                        && R.monthKey(f.datePaiementEffective) === mk)
                    .map(f => R.diffDays(f.datePaiementEffective, f.dateEcheance))),
                variation: sum(entrees, f => f.montant) - sum(sorties, f => f.montant),
            };
        });
    }

    /**
     * Le tas de bad debt, mois par mois : grossit-il, ou se résorbe-t-il ?
     *
     * Reprend mot pour mot la fin de mois, le prédicat de règlement et le
     * filtre de stock de fluxRecouvrement : les deux courbes doivent parler de
     * la même chose.
     *
     * Le dernier point et la tuile « Créances de plus de 12 mois » ne tombent
     * pas sur le même chiffre, et c'est attendu : le point recule dans le
     * temps, donc il se lit sur la date de règlement ; la tuile se lit sur
     * l'état d'aujourd'hui. L'écart est exactement l'ensemble des factures
     * marquées payées sans date de règlement — la population que compte déjà
     * la note d'historique incomplet.
     */
    function badDebtParMois(factures, moisList, seuilJours, dateRef) {
        const S = (seuilJours == null ? 360 : seuilJours);
        const borne = dateRef ? R.stripTime(dateRef) : R.stripTime(new Date());
        const limite = R.monthKey(borne);
        const regle = f => f.paye === true && !!f.datePaiementEffective;
        return moisList.filter(m => m <= limite).map(mk => {
            const brut = finDeMois(mk);
            const fin = brut > borne ? borne : brut;   // le mois courant s'arrête à l'arrêté
            const stock = factures.filter(f =>
                f.dateEcheance && f.dateEcheance <= fin &&
                (!regle(f) || f.datePaiementEffective > fin));
            const bad = stock.filter(f => R.diffDays(fin, f.dateEcheance) > S);
            return {
                mois: mk, fin, items: bad,
                nb: bad.length,
                euros: sum(bad, f => f.montant || 0),
                eurStock: sum(stock, f => f.montant || 0),
                nbStock: stock.length,
            };
        });
    }

    /** Nombre de jours d'un mois 'YYYY-MM'. */
    function joursDuMois(mk) { return finDeMois(mk).getDate(); }

    /**
     * DSO — délai moyen de règlement client, en jours, mois par mois.
     *
     * Deux méthodes, volontairement affichées ensemble :
     *  · simple    : encours de fin de mois ÷ chiffre d'affaires des trois
     *                derniers mois, ramené à leur nombre de jours. Le mois
     *                seul donnait des valeurs absurdes — un mois presque sans
     *                facturation faisait grimper la courbe à quatorze mille
     *                jours, ce qui ne mesure pas un délai mais la faiblesse du
     *                dénominateur. Trois mois lissent la saisonnalité sans
     *                changer la définition.
     *  · count-back : on épuise l'encours de fin de mois contre le chiffre
     *                d'affaires des mois précédents, en comptant les jours.
     *                C'est la méthode retenue en credit management, plus
     *                stable quand la facturation est irrégulière.
     *
     * L'encours retenu est l'ensemble des factures émises et non réglées à la
     * date considérée — y compris les non échues, comme le veut la définition.
     */
    function dsoParMois(factures, moisList, dateRef) {
        const limite = dateRef ? R.monthKey(dateRef) : null;
        const mois = [...new Set([
            ...moisList,
            ...factures.map(f => f.moisFacture).filter(Boolean),
        ])].sort().filter(m => !limite || m <= limite);

        // Chiffre d'affaires facturé par mois
        const ca = {};
        for (const f of factures) {
            if (!f.moisFacture || f.montant == null) continue;
            ca[f.moisFacture] = (ca[f.moisFacture] || 0) + f.montant;
        }

        return mois.map((mk, idx) => {
            const fin = finDeMois(mk);
            const encours = factures.filter(f =>
                f.dateFacture && f.dateFacture <= fin && f.montant != null &&
                (!f.datePaiementEffective || f.datePaiementEffective > fin));
            const soldeFin = sum(encours, f => f.montant);
            const caMois = ca[mk] || 0;

            // Méthode simple, sur une fenêtre glissante de trois mois : le
            // dénominateur d'un seul mois est trop étroit pour porter un
            // ratio — une facturation faible y produit un DSO de plusieurs
            // milliers de jours, qui n'a aucun sens.
            let caFenetre = 0, joursFenetre = 0;
            for (let j = Math.max(0, idx - 2); j <= idx; j++) {
                caFenetre += ca[mois[j]] || 0;
                joursFenetre += joursDuMois(mois[j]);
            }
            // Un encours qui dépasse plusieurs années de facturation ne dit
            // plus rien du délai de règlement : le point est laissé vide.
            const dsoSimpleBrut = caFenetre > 0 ? (soldeFin / caFenetre) * joursFenetre : null;
            // Le mois en cours n'a pas fini de facturer : son chiffre d'affaires
            // partiel gonfle le ratio d'un tiers ou plus. Le point est laissé
            // vide plutôt que faux — le count-back, lui, reste calculable.
            const moisEnCours = limite === mk && dateRef && dateRef < fin;
            const dsoSimple = (dsoSimpleBrut != null && dsoSimpleBrut <= 1095 && !moisEnCours)
                ? dsoSimpleBrut : null;

            // Méthode count-back : on remonte les mois jusqu'à épuiser l'encours
            let reste = soldeFin, jours = 0, k = idx, epuise = false;
            while (k >= 0) {
                const m = mois[k], c = ca[m] || 0, nj = joursDuMois(m);
                if (c <= 0) { k--; continue; }
                if (reste > c) { jours += nj; reste -= c; k--; }
                else { jours += (reste / c) * nj; epuise = true; break; }
            }

            // Un DSO qui consomme presque tout l'historique disponible ne mesure
            // plus le délai de règlement : il mesure la longueur de l'historique.
            // Les premiers mois d'un chargement en donnaient une illustration
            // parfaite — une droite montant de zéro à mille jours, chaque mois
            // ajoutant exactement sa propre durée. Ces points ne sont pas
            // affichés : mieux vaut un trou dans la courbe qu'un chiffre qui
            // n'en est pas un.
            let historiqueJours = 0;
            for (let j = 0; j <= idx; j++) historiqueJours += joursDuMois(mois[j]);
            const fiable = epuise && jours < historiqueJours * 0.9;
            const dsoCountBack = soldeFin > 0 ? (fiable ? jours : null) : 0;

            return {
                mois: mk,
                ca: caMois,
                encours: soldeFin,
                nbEncours: encours.length,
                dsoSimple,
                dsoCountBack,
                tronque: soldeFin > 0 && !fiable,
                historiqueCourt: soldeFin > 0 && epuise && !fiable,
            };
        });
    }

    /**
     * Pourquoi une facture n'a-t-elle pas d'échéance calculable ?
     *
     * Le nombre seul n'est pas actionnable : il peut désigner une colonne non
     * reconnue, une date vide dans Monday, ou une règle qui réclame une date de
     * formation que la facture ne porte pas. Chacune de ces causes se corrige
     * autrement, d'où ce classement.
     *
     * @returns {Array} { cause, conseil, nb, euros, items }, la plus fréquente
     *                  en tête
     */
    function causesSansEcheance(factures) {
        const groupes = new Map();
        const ajouter = (cause, conseil, f) => {
            let g = groupes.get(cause);
            if (!g) { g = { cause, conseil, items: [] }; groupes.set(cause, g); }
            g.items.push(f);
        };

        for (const f of factures) {
            if (f.dateEcheance) continue;
            const aFacture = !!f.dateFacture;
            const aDebut = !!f.dateDebutFormation;
            const aFin = !!f.dateFinFormation;

            if (!aFacture && !aDebut && !aFin) {
                ajouter('Aucune date exploitable',
                    'Ni date de facture, ni date de début ou de fin de formation. Vérifier que ces '
                    + "colonnes sont bien associées pour ce tableau — l'écran « Correspondance des "
                    + 'colonnes » indique la part de lignes réellement renseignée — puis compléter '
                    + 'les dates manquantes dans Monday.', f);
            } else if (!f.financement) {
                ajouter('Type de financement non identifié',
                    'Sans financement, aucune règle ne dit sur quelle date compter. Renseigner '
                    + '« Type de financement » ou « Type de client », ou ranger la facture dans un '
                    + 'groupe qui nomme son financement.', f);
            } else {
                const regle = R.getRule(f.financement);
                const attendues = [regle.base, regle.fallback].filter(Boolean);
                const libelle = {
                    dateFacture: 'la date de facture',
                    dateDebutFormation: 'la date de début de formation',
                    dateFinFormation: 'la date de fin de formation',
                };
                ajouter(`${regle.label} — ${attendues.map(c => libelle[c] || c).join(' ou ')} manquante`,
                    `La règle « ${regle.note} » ne peut pas s'appliquer : cette facture porte `
                    + (aFacture ? 'une date de facture' : 'aucune des dates attendues')
                    + ', mais pas la date sur laquelle la règle compte. Compléter cette date dans '
                    + 'Monday, ou corriger le type de financement si la règle appliquée n\'est pas la bonne.',
                    f);
            }
        }

        return [...groupes.values()]
            .map(g => ({ ...g, nb: g.items.length, euros: sum(g.items, x => x.montant) }))
            .sort((a, b) => b.nb - a.nb);
    }

    /** Tranches de l'histogramme de répartition des retards. */
    const TRANCHES_RETARD = [
        { label: '1 → 15 j',    min: 1,   max: 15 },
        { label: '16 → 30 j',   min: 16,  max: 30 },
        { label: '31 → 45 j',   min: 31,  max: 45 },
        { label: '46 → 60 j',   min: 46,  max: 60 },
        { label: '61 → 90 j',   min: 61,  max: 90 },
        { label: '91 → 120 j',  min: 91,  max: 120 },
        { label: '121 → 180 j', min: 121, max: 180 },
        { label: '181 → 365 j', min: 181, max: 365 },
        { label: '> 365 j',     min: 366, max: Infinity },
    ];

    /**
     * Distribution des retards, séparant ce qui est encore dû de ce qui a
     * fini par rentrer : la forme des deux courbes dit si les créances
     * anciennes finissent par être recouvrées ou s'enkystent.
     */
    function histogrammeRetards(factures) {
        const impayees = factures.filter(f => f.etat === 'En retard' && f.retardJours > 0);
        const payeesRetard = factures.filter(f => f.etat === 'Payée en retard' && f.retardJours > 0);

        const dans = (arr, t) => arr.filter(f => f.retardJours >= t.min && f.retardJours <= t.max);

        return TRANCHES_RETARD.map(t => {
            const i = dans(impayees, t), p = dans(payeesRetard, t);
            return {
                ...t,
                nbImpayees: i.length,
                eurImpayees: sum(i, f => f.montant),
                nbPayees: p.length,
                eurPayees: sum(p, f => f.montant),
            };
        });
    }

    /** Agrégat simple d'une dimension, pour treemap et graphiques de répartition. */
    function parDimension(factures, fn, labelFn, valeurFn) {
        const map = new Map();
        for (const f of factures) {
            const k = fn(f) || '—';
            let g = map.get(k);
            if (!g) { g = { cle: k, label: labelFn ? labelFn(k, f) : k, nb: 0, valeur: 0, retards: [] }; map.set(k, g); }
            g.nb++;
            g.valeur += (valeurFn ? valeurFn(f) : f.montant) || 0;
            if (f.retardJours != null) g.retards.push(f.retardJours);
        }
        return [...map.values()]
            .map(g => ({ ...g, retardMoyen: moyenne(g.retards) }))
            .filter(g => g.valeur > 0)
            .sort((a, b) => b.valeur - a.valeur);
    }

    // ──────────────────────────────────────────────
    //  Classements
    // ──────────────────────────────────────────────

    function topClients(factures, n) {
        const map = new Map();
        for (const f of factures.filter(x => x.etat === 'En retard')) {
            const k = f.client || '—';
            let g = map.get(k);
            if (!g) { g = { client: k, nb: 0, euros: 0, retards: [], plusVieille: null, financements: new Set() }; map.set(k, g); }
            g.nb++; g.euros += f.montant || 0;
            g.retards.push(f.retardJours);
            if (f.financement) g.financements.add(f.financement);
            if (g.plusVieille == null || f.retardJours > g.plusVieille) g.plusVieille = f.retardJours;
        }
        return [...map.values()]
            .map(g => ({ ...g, retardMoyen: moyenne(g.retards), financements: [...g.financements] }))
            .sort((a, b) => b.euros - a.euros)
            .slice(0, n || 15);
    }

    /**
     * Le retard par tableau, dans ses deux temps.
     *
     * « En retard » ne désigne que ce qui est encore dû. Une facture réglée
     * après son échéance n'y figure plus — et le tableau des factures payées
     * ressortait donc à zéro, comme s'il n'avait jamais rien eu en retard.
     * C'est faux au sens qui compte : ces factures ONT été payées en retard,
     * et c'est la matière même de la statistique de recouvrement.
     *
     * Les deux sont donc comptés séparément et ne se confondent pas : l'un
     * est un encours à récupérer, l'autre un délai déjà subi.
     */
    function parTableau(factures) {
        const map = new Map();
        for (const f of factures) {
            const k = f.board || '—';
            let g = map.get(k);
            if (!g) {
                g = { board: k, role: f.role, nb: 0, euros: 0, nbRetard: 0, eurRetard: 0, retards: [],
                      nbPayeRetard: 0, eurPayeRetard: 0, retardsPayes: [] };
                map.set(k, g);
            }
            g.nb++; g.euros += f.montant || 0;
            if (f.etat === 'En retard') { g.nbRetard++; g.eurRetard += f.montant || 0; g.retards.push(f.retardJours); }
            else if (f.etat === 'Payée en retard') {
                g.nbPayeRetard++; g.eurPayeRetard += f.montant || 0; g.retardsPayes.push(f.retardJours);
            }
        }
        return [...map.values()]
            .map(g => ({ ...g,
                tauxNb: pct(g.nbRetard, g.nb),
                retardMoyen: moyenne(g.retards),
                // Tout ce qui a connu du retard, payé ou non : c'est le taux
                // qui dit si un tableau tient ses échéances.
                nbTouche: g.nbRetard + g.nbPayeRetard,
                tauxTouche: pct(g.nbRetard + g.nbPayeRetard, g.nb),
                retardMoyenPaye: moyenne(g.retardsPayes),
            }))
            .sort((a, b) => (b.eurRetard + b.eurPayeRetard) - (a.eurRetard + a.eurPayeRetard));
    }

    function parGroupe(factures) {
        const map = new Map();
        for (const f of factures) {
            const k = (f.groupe || f.groupeOrigine || '—') + ' — ' + (f.board || '');
            let g = map.get(k);
            if (!g) { g = { cle: k, groupe: f.groupe || f.groupeOrigine || '—', board: f.board, nb: 0, euros: 0, nbRetard: 0, eurRetard: 0, retards: [] }; map.set(k, g); }
            g.nb++; g.euros += f.montant || 0;
            if (f.etat === 'En retard') { g.nbRetard++; g.eurRetard += f.montant || 0; g.retards.push(f.retardJours); }
        }
        return [...map.values()]
            .map(g => ({ ...g, tauxNb: pct(g.nbRetard, g.nb), retardMoyen: moyenne(g.retards) }))
            .sort((a, b) => b.eurRetard - a.eurRetard);
    }

    // ──────────────────────────────────────────────
    //  Qualifications métier
    //
    //  Les colonnes à choix des tableaux Monday portent le vocabulaire du
    //  métier — problématique pré-échéance, qualification recouvrement, type
    //  de paiement. Elles diffèrent d'un tableau à l'autre : on les inventorie
    //  plutôt que de les coder en dur.
    // ──────────────────────────────────────────────

    /** Colonnes de qualification présentes, avec le tableau qui les porte. */
    /**
     * Une colonne relève-t-elle de la qualification métier ?
     *
     * Toute colonne à choix non affectée à un champ canonique était retenue, ce
     * qui ramenait des statuts d'avancement, des types de paiement et des
     * colonnes de suivi au milieu des qualifications proprement dites. Seules
     * comptent ici les colonnes qui portent un jugement sur la facture :
     * qualification, problématique, motif, litige.
     */
    const MOTS_QUALIF = /qualif|problematique|motif|litige|contentieux|douteus|anomalie|blocage/;
    function estColonneQualification(nom) {
        return MOTS_QUALIF.test(R.norm(nom || ''));
    }

    /**
     * Inventaire des qualifications regroupé par tableau.
     *
     * La même colonne n'a pas le même sens d'un tableau à l'autre — la
     * qualification du 1.2 parle de recouvrement, celle du 1.1 de problèmes
     * avant échéance. Les mélanger dans une seule liste efface justement la
     * distinction que l'on cherche à lire.
     *
     * @param {Array} factures
     * @param {boolean} toutes  inclure les colonnes à choix qui ne sont pas des
     *                          qualifications au sens strict
     * @returns {Array} un objet par tableau : { board, colonnes: [{nom, nb, nbValeurs}] }
     */
    function qualificationsParTableau(factures, toutes) {
        const boards = new Map();
        for (const f of factures) {
            for (const nom of Object.keys(f.qualifs || {})) {
                if (!toutes && !estColonneQualification(nom)) continue;
                // Une facture vue sur plusieurs tableaux porte les colonnes des
                // deux : elle est rattachée à son tableau opérationnel, celui
                // où la qualification a été saisie.
                const board = f.boardOperationnel || f.board || '—';
                let b = boards.get(board);
                if (!b) { b = { board, colonnes: new Map(), nb: 0 }; boards.set(board, b); }
                let c = b.colonnes.get(nom);
                if (!c) { c = { nom, nb: 0, valeurs: new Set() }; b.colonnes.set(nom, c); }
                c.nb++;
                c.valeurs.add(f.qualifs[nom]);
            }
        }
        return [...boards.values()].map(b => ({
            board: b.board,
            colonnes: [...b.colonnes.values()]
                .map(c => ({ nom: c.nom, nb: c.nb, nbValeurs: c.valeurs.size }))
                .sort((x, y) => y.nb - x.nb),
        })).sort((a, b) => b.colonnes.reduce((n, c) => n + c.nb, 0)
                          - a.colonnes.reduce((n, c) => n + c.nb, 0));
    }

    function inventaireQualifications(factures) {
        const map = new Map();
        for (const f of factures) {
            for (const nom of Object.keys(f.qualifs || {})) {
                let q = map.get(nom);
                if (!q) { q = { nom, nb: 0, tableaux: new Set(), valeurs: new Set() }; map.set(nom, q); }
                q.nb++;
                q.tableaux.add(f.board);
                q.valeurs.add(f.qualifs[nom]);
            }
        }
        return [...map.values()]
            .map(q => ({ ...q, tableaux: [...q.tableaux], nbValeurs: q.valeurs.size }))
            .sort((a, b) => b.nb - a.nb);
    }

    /**
     * Répartition d'une colonne de qualification, valeur par valeur.
     *
     * @param {Array} factures
     * @param {string} nomColonne
     * @param {string} [board]  restreindre au tableau où la colonne est saisie
     */
    function repartitionQualification(factures, nomColonne, board) {
        const concernees = factures.filter(f => f.qualifs && f.qualifs[nomColonne]
            && (!board || (f.boardOperationnel || f.board) === board));
        const map = new Map();

        for (const f of concernees) {
            const v = f.qualifs[nomColonne];
            let g = map.get(v);
            if (!g) { g = { valeur: v, items: [] }; map.set(v, g); }
            g.items.push(f);
        }

        const totalNb = concernees.length;
        const totalEur = sum(concernees, f => f.montant);

        const lignes = [...map.values()].map(g => {
            const enRetard = g.items.filter(x => x.etat === 'En retard');
            return {
                valeur: g.valeur,
                nb: g.items.length,
                euros: sum(g.items, x => x.montant),
                partNb: pct(g.items.length, totalNb),
                partEur: pct(sum(g.items, x => x.montant), totalEur),
                nbEnRetard: enRetard.length,
                eurEnRetard: sum(enRetard, x => x.montant),
                retardMoyen: moyenne(enRetard.map(x => x.retardJours)),
                items: g.items,
            };
        }).sort((a, b) => b.nb - a.nb);

        return {
            nom: nomColonne,
            board: board || null,
            lignes,
            totalNb,
            totalEur,
            nonQualifiees: factures.length - totalNb,
        };
    }

    /**
     * La bad debt : ce qui est échu depuis plus d'un an et toujours pas rentré.
     *
     * Le seuil n'est pas un chiffre rond posé au hasard. La balance âgée range
     * ses tranches par pas de trente jours : « 6 à 12 mois » s'arrête à
     * 12 × 30 = 360 jours et « 12 à 18 mois » commence à 361. Le seuil et la
     * frontière « plus de douze mois » de la balance âgée sont donc le même
     * trait, au jour près, et les deux écrans se recoupent exactement.
     *
     * L'état « En retard » implique déjà trois choses : la facture n'est pas
     * réglée, son échéance existe, et elle est passée. Une créance annulée par
     * avoir porte retardJours nul et ne peut pas entrer ici.
     */
    function badDebt(factures, seuilJours) {
        const S = (seuilJours == null ? 360 : seuilJours);
        const items = factures.filter(f => f.etat === 'En retard' && f.retardJours > S);
        const dejaQualifiees = items.filter(f => f.etape === 'CONTENTIEUX' || f.etape === 'PERTE');
        return {
            seuil: S, items,
            nb: items.length,
            // Deux grandeurs, et il ne faut pas les diviser l'une par l'autre :
            // `euros` est le montant facturé, comparable à l'encours total du
            // portefeuille ; `resteDuBD` est ce qui reste réellement dû, donc
            // la base d'une provision. Rapporter le second au premier
            // mélangerait un reste dû à un montant facturé.
            euros: sum(items, f => f.montant || 0),
            resteDuBD: sum(items, f => f.encours || 0),
            nbQualifiees: dejaQualifiees.length,
            eurQualifiees: sum(dejaQualifiees, f => f.montant || 0),
            itemsQualifiees: dejaQualifiees,
        };
    }

    /**
     * Ce qui finit quand même par rentrer au-delà du seuil.
     *
     * Les impayées comptées ici sont exactement celles de badDebt : les deux
     * tuiles restent cohérentes par construction. Le taux est donné en euros
     * et en nombre, parce qu'un taux en euros sans son pendant en nombre ne se
     * vérifie pas — une seule grosse facture récupérée le ferait mentir.
     *
     * Réserve : l'histogramme des tranches de retard borne sa dernière tranche
     * à 366 jours là où ce seuil est à 361. Les deux écrans diffèrent donc sur
     * les factures dont le retard tombe entre 361 et 365 jours.
     */
    function recuperationAuDela(factures, seuilJours) {
        const S = (seuilJours == null ? 360 : seuilJours);
        const recuperees = factures.filter(f => f.etat === 'Payée en retard' && f.retardJours > S);
        const impayees = factures.filter(f => f.etat === 'En retard' && f.retardJours > S);
        const eurRec = sum(recuperees, f => f.montant || 0);
        const eurImp = sum(impayees, f => f.montant || 0);
        return {
            seuil: S, recuperees, impayees,
            nbRec: recuperees.length, nbImp: impayees.length,
            eurRec, eurImp,
            taux: pct(eurRec, eurRec + eurImp),
            tauxNb: pct(recuperees.length, recuperees.length + impayees.length),
        };
    }

    /**
     * Créances douteuses : contentieux et pertes, au sens des groupes Monday.
     * Ce sont les créances dont le recouvrement ordinaire a échoué.
     */
    function creancesDouteuses(factures) {
        const items = factures.filter(f => f.etape === 'CONTENTIEUX' || f.etape === 'PERTE');
        const contentieux = items.filter(f => f.etape === 'CONTENTIEUX');
        const perte = items.filter(f => f.etape === 'PERTE');
        return {
            nb: items.length,
            euros: sum(items, f => f.montant),
            encours: sum(items.filter(f => !f.paye), f => f.montant),
            nbContentieux: contentieux.length,
            eurContentieux: sum(contentieux, f => f.montant),
            nbPerte: perte.length,
            eurPerte: sum(perte, f => f.montant),
            partNb: pct(items.length, factures.length),
            partEur: pct(sum(items, f => f.montant), sum(factures, f => f.montant)),
            items,
        };
    }

    // ──────────────────────────────────────────────
    //  Qualité de données
    // ──────────────────────────────────────────────

    function qualite(factures) {
        const anomalies = [];
        /** Quels signaux ont parlé, et combien de fois — du plus fréquent au moins. */
        function repartitionSignaux(items) {
            const par = new Map();
            for (const f of items) {
                const m = f.motifSignalPaiement || 'Signal non nommé';
                par.set(m, (par.get(m) || 0) + 1);
            }
            if (!par.size) return '';
            return 'Ce qui les signale : '
                + [...par.entries()].sort((a, b) => b[1] - a[1])
                    .map(([m, n]) => `${m} — ${n}`).join(' · ') + '.';
        }

        const push = (code, titre, gravite, items, conseil) => {
            if (items.length) anomalies.push({ code, titre, gravite, nb: items.length, euros: sum(items, x => x.montant), items, conseil });
        };

        // Le détail par cause accompagne le nombre : une colonne non reconnue,
        // une date vide et une règle qui réclame une date absente donnent le
        // même chiffre et appellent trois gestes différents.
        const sansEch = factures.filter(f => !f.dateEcheance);
        push('ECHEANCE', "Échéance impossible à calculer", 'haute', sansEch,
            "Ces factures sortent de tous les taux — ni en retard, ni non échues. "
            + causesSansEcheance(sansEch)
                .map(c => `${c.cause} : ${Math.round(c.nb)}`).join(' · '));

        push('FINANCEMENT', "Type de financement non identifié", 'haute',
            factures.filter(f => !f.financement),
            "La règle d'échéance par défaut (facture +30 j) est appliquée — compléter la colonne « Type de financement ».");

        // Ces factures ne sont connues que par leur groupe dans le tableau des
        // factures payées, lequel nomme une étape du circuit corporate et non
        // un financement. Le périmètre est donc sûr, le financement non.
        push('FINANCEMENT_CORPORATE', "Financement corporate à préciser", 'moyenne',
            factures.filter(f => f.financement === 'CORPORATE'),
            "Réglées avant l'entrée dans le circuit, ou rangées dans un groupe qui nomme "
            + "l'étape plutôt que le financement. Le périmètre corporate est certain ; "
            + "la règle appliquée est la règle corporate par défaut, facture +30 jours. "
            + "Renseigner « Type de client » sur ces factures les répartirait entre "
            + "B2B et B2C-Entreprise.");

        // Une facture posée sur le tableau de recouvrement dont l'échéance n'est
        // pas passée n'est pas en retard : les deux notions sont indépendantes.
        // C'est soit une facture arrivée trop tôt sur le tableau, soit une règle
        // d'échéance qui ne dit pas la même chose que l'ADV — dans les deux cas,
        // quelque chose à trancher, pas un chiffre à ignorer.
        push('RECOUV_NON_ECHUE', "Sur le tableau recouvrement, mais pas encore échue", 'moyenne',
            factures.filter(f => f.etat === 'Non échue'
                && ((f.presenceRoles || [f.role]).includes('recouvrement'))),
            "Le tableau dit « à recouvrer », l'échéance calculée dit « pas encore due ». "
            + "Soit la facture est arrivée sur le tableau avant son terme, soit la règle de "
            + "financement appliquée n'est pas la bonne — la fiche de chaque facture indique "
            + "sur quelle date son échéance a été calculée.");

        // Le grand livre est la comptabilité : quand il contredit Monday, ce
        // n'est pas lui qu'il faut corriger. Les deux cas sont signalés sans
        // être appliqués — l'extrait ne couvre qu'un exercice, et une facture
        // soldée avant sa première date y figure en à-nouveau.
        push('GL_OUVERTE', "Réglée dans Monday, ouverte au grand livre", 'haute',
            factures.filter(f => f.grandLivreOuverte && f.paye && f.motifPaye
                === 'Présente dans le tableau des factures payées'),
            "Monday les donne encaissées, la comptabilité ne les a pas soldées. Soit le "
            + "règlement n'est pas lettré, soit il n'a jamais eu lieu. À vérifier avant de "
            + "les sortir du portefeuille.");

        push('GL_AVOIR', "Annulées par avoir", 'moyenne',
            factures.filter(f => f.soldeeParAvoir),
            "Soldées au grand livre par un avoir, non par un règlement : la créance a été "
            + "annulée, rien n'est rentré. Elles sortent du portefeuille sans compter dans ce "
            + "que le recouvrement a récupéré — les compter encaissées gonflerait le taux.");

        push('MONTANT', "Montant absent ou nul", 'haute',
            factures.filter(f => f.montant == null || f.montant === 0),
            "Sans montant, la facture ne pèse pas dans les indicateurs en euros.");

        push('PAIE_SANS_DATE', "Payée sans date de paiement", 'moyenne',
            factures.filter(f => f.paye && !f.datePaiementEffective),
            "Le retard au paiement n'est pas mesurable. Importer le grand livre pointé permet de combler ces dates.");

        push('PAIE_ESTIMEE', "Date de paiement estimée (contrôle paiement)", 'basse',
            factures.filter(f => f.paye && f.paiementEstime && f.datePaiementEffective),
            "La date de contrôle paiement sert de repli ; elle est postérieure au règlement réel, le retard est donc majoré.");

        // Seuls les doublons entre tableaux opérationnels sont anormaux : une
        // facture vue sur son tableau et sur celui des factures payées, ou
        // rangée dans un groupe d'archive, relève du fonctionnement normal.
        push('DOUBLON', "Facture présente sur deux tableaux opérationnels", 'moyenne',
            factures.filter(f => f.doublonOperationnel),
            "Dans le circuit Tampon → ADV → Recouvrement, une facture se déplace : elle ne devrait "
            + "être active que sur un seul tableau. Supprimer dans Monday l'exemplaire resté sur le "
            + "tableau quitté. Les indicateurs ne sont pas faussés — l'application n'en compte qu'une.");

        push('DOUBLON_PAYEES', "Facture saisie deux fois dans les factures payées", 'moyenne',
            factures.filter(f => f.doublonPayees),
            "Une facture n'a qu'un règlement. Deux lignes dans « 0.1. ALL - Factures payées » — "
            + "le plus souvent dans deux groupes différents — surévaluent le nombre de factures "
            + "réglées par groupe et rendent ambiguë l'origine retenue pour la facture. "
            + "Supprimer le doublon dans Monday ; les indicateurs, eux, n'en comptent qu'une.");

        push('SANS_NUMERO', "Numéro de facture absent", 'moyenne',
            factures.filter(f => !f.cle),
            "Le rapprochement avec le tableau « Factures payées » est impossible sans numéro.");

        push('PAIE_AVANT_FACTURE', "Paiement antérieur à la facture", 'moyenne',
            factures.filter(f => f.delaiPaiement != null && f.delaiPaiement < 0),
            "Vérifier les dates : un règlement daté avant l'émission fausse les délais moyens.");

        push('A_RAPPROCHER', "Règlements en attente de rapprochement comptable", 'basse',
            factures.filter(f => f.enAttenteRapprochement),
            "Factures des groupes de comptabilité — Pennylane non pointé, paiement non remonté sur "
            + "Sellsy, en traitement comptabilité. Elles sont comptées comme encaissées et sortent du "
            + "recouvrement, mais sans date de règlement : elles ne pèsent donc pas dans les délais de "
            + "paiement. Importer le grand livre lettré leur donne leur vraie date.");

        push('SIGNAL_PAIEMENT_ORPHELIN', "Signes de règlement hors du tableau des factures payées", 'moyenne',
            factures.filter(f => f.signalPaiementHorsTableau),
            "Ces factures portent un signe de règlement sur leur tableau opérationnel, mais "
            + "n'apparaissent pas dans le tableau des factures payées. Elles restent comptées comme "
            + "dues, seul ce tableau et le lettrage du grand livre faisant règlement. Si elles sont "
            + "bel et bien encaissées, il manque leur ligne dans le 0.1. "
            // Dire quel signal a parlé : sans cela, la liste ne se vérifie pas
            // et une colonne mal associée reste introuvable.
            + repartitionSignaux(factures.filter(f => f.signalPaiementHorsTableau)));

        push('ECHEANCE_DIVERGENTE', "Échéance Monday très éloignée de l'échéance calculée", 'haute',
            factures.filter(f => f.dateEcheance && f.dateEcheanceSource
                && Math.abs(R.diffDays(f.dateEcheanceSource, f.dateEcheance)) > 60),
            "Plus de 60 jours d'écart entre la date saisie dans Monday et celle qu'imposent les règles. "
            + "Le plus souvent, la colonne d'échéance reconnue n'est pas la bonne : vérifiez la "
            + "correspondance des colonnes dans l'onglet Données.");

        push('RETARD_EXTREME', "Retard supérieur à 1 an", 'haute',
            factures.filter(f => f.etat === 'En retard' && f.retardJours > 365),
            "Créances anciennes : passage en contentieux ou en perte à arbitrer.");

        push('ADV_ECHU', "Échue mais encore côté ADV / Tampon", 'moyenne',
            factures.filter(f => f.etat === 'En retard' && (f.role === 'adv' || f.role === 'tampon')),
            "Ces factures devraient être basculées en recouvrement une fois l'ADV complet.");

        const ordre = { haute: 0, moyenne: 1, basse: 2 };
        anomalies.sort((a, b) => ordre[a.gravite] - ordre[b.gravite] || b.nb - a.nb);
        return anomalies;
    }

    /** Score global de qualité (0-100). */
    function scoreQualite(factures, anomalies) {
        if (!factures.length) return 100;
        const poids = { haute: 1, moyenne: 0.5, basse: 0.15 };
        let penalite = 0;
        for (const a of anomalies) penalite += (a.nb / factures.length) * (poids[a.gravite] || 0.3);
        return Math.max(0, Math.round(100 - penalite * 100));
    }

    /**
     * Comparaison entre les deux derniers mois exploitables.
     * Les mois postérieurs à la date d'arrêté ne contiennent que des factures
     * non échues : les inclure comparerait deux mois vides.
     */
    /**
     * Confronte le dernier mois à un mois de référence.
     *
     * Deux comparaisons ont un sens et ne disent pas la même chose : le mois
     * précédent montre le mouvement récent, le même mois de l'année d'avant
     * neutralise la saisonnalité — un août se compare mal à un juillet, il se
     * compare bien à l'août précédent.
     *
     * @param {string} [base] 'precedent' (défaut) ou 'annee'
     */
    function comparaisonMensuelle(rowsMois, moisRef, base, dateRef) {
        let rows = rowsMois.filter(m => m.assietteNb > 0);
        if (moisRef) {
            // Même règle que la comparaison par catégorie : un mois d'arrêté
            // qui n'est pas terminé ne se compare pas à un mois entier.
            const limite = moisComplet(moisRef, dateRef) ? moisRef : moisAvant(moisRef);
            rows = rows.filter(m => m.mois <= limite);
        }
        if (rows.length < 2) return null;
        const cur = rows[rows.length - 1];
        let prev;
        if (base === 'annee') {
            const [a, m] = cur.mois.split('-');
            const cible = (Number(a) - 1) + '-' + m;
            prev = rows.find(x => x.mois === cible);
            // Sans le mois de l'an dernier, mieux vaut le dire que comparer à
            // n'importe quoi : la bascule le signalera.
            if (!prev) return { indisponible: true, mois: cur.mois, moisCible: cible };
        } else {
            prev = rows[rows.length - 2];
        }
        const delta = (a, b) => ({ cur: a, prev: b, ecart: a - b, ecartPct: b !== 0 ? ((a - b) / Math.abs(b)) * 100 : null });
        return {
            mois: cur.mois, moisPrec: prev.mois,
            nbEnRetard: delta(cur.nbEnRetard, prev.nbEnRetard),
            eurEnRetard: delta(cur.eurEnRetard, prev.eurEnRetard),
            tauxNb: delta(cur.tauxNb, prev.tauxNb),
            tauxEur: delta(cur.tauxEur, prev.tauxEur),
            retardMoyen: delta(cur.retardMoyen || 0, prev.retardMoyen || 0),
        };
    }

    /**
     * Le mois qui vient de s'écouler, catégorie par catégorie, comparé au
     * précédent.
     *
     * La comparaison mensuelle existante est globale : elle dit que le retard
     * moyen a bougé, pas où. Or les questions qui se posent en réunion sont
     * toujours catégorielles — combien de factures sont tombées en recouvrement
     * ce mois-ci et dans quel dispositif, quelle part est rentrée à l'heure,
     * de combien le retard a bougé.
     *
     * La cohorte d'un mois, ce sont les factures dont l'échéance y tombe. On ne
     * retient que les mois dont l'échéance est passée : une cohorte en cours
     * n'a pas de taux.
     *
     * @param {Array}  factures
     * @param {string} moisRef  mois d'arrêté (AAAA-MM)
     * @param {string} base     'precedent' | 'annee'
     * @returns {{mois, moisPrec, lignes:Array, total:Object}|null}
     */
    /** Le mois « AAAA-MM » est-il terminé à la date d'arrêté ? */
    function moisComplet(mk, dateRef) {
        const ref = dateRef || R.stripTime(new Date());
        return R.stripTime(finDeMois(mk)) <= ref;
    }

    /** Le mois qui précède « AAAA-MM ». */
    function moisAvant(mk) {
        const [a, m] = mk.split('-').map(Number);
        return m === 1 ? (a - 1) + '-12' : a + '-' + String(m - 1).padStart(2, '0');
    }

    function comparaisonParCategorie(factures, moisRef, base, rules, dateRef) {
        const ref = dateRef || R.stripTime(new Date());
        // Le mois d'arrêté n'est comparable que s'il est terminé. Arrêté au 14,
        // sa cohorte n'a que quatorze jours d'échéances face à un mois entier :
        // « réglé à l'heure » y bondit, le retard moyen s'effondre, et la
        // variation ne mesure que la moitié manquante.
        const moisArrete = moisRef || R.monthKey(ref);
        const limite = moisComplet(moisArrete, ref) ? moisArrete : moisAvant(moisArrete);
        const echues = factures.filter(f => f.dateEcheance && f.dateEcheance <= ref && f.moisEcheance);
        const mois = [...new Set(echues.map(f => f.moisEcheance))].sort().filter(m => m <= limite);
        if (mois.length < 2) return null;

        const cur = mois[mois.length - 1];
        let prec;
        if (base === 'annee') {
            const [a, m] = cur.split('-');
            prec = (Number(a) - 1) + '-' + m;
            if (!mois.includes(prec)) return { indisponible: true, mois: cur, moisCible: prec };
        } else {
            prec = mois[mois.length - 2];
        }

        // Les indicateurs d'une cohorte : ce qui est tombé en retard, ce qui
        // est rentré à l'heure, de combien on a dérapé, et en combien de temps
        // l'argent est rentré.
        const mesurer = items => {
            const enRetard = items.filter(x => x.etat === 'En retard' || x.etat === 'Payée en retard');
            const aTemps = items.filter(x => x.etat === 'Payée');
            const regles = items.filter(x => x.paye && x.delaiPaiement != null && x.delaiPaiement >= 0);
            return {
                nb: items.length,
                euros: sum(items, x => x.montant),
                nbRecouv: enRetard.length,
                eurRecouv: sum(enRetard, x => x.montant),
                tauxATemps: pct(aTemps.length, items.length),
                retardMoyen: moyenne(enRetard.map(x => x.retardJours).filter(v => v != null)),
                delaiReglement: moyenne(regles.map(x => x.delaiPaiement)),
                items,
            };
        };

        const parCat = new Map();
        for (const f of echues) {
            if (f.moisEcheance !== cur && f.moisEcheance !== prec) continue;
            const cat = f.financement ? R.categorieDe(f.financement, rules) : 'À qualifier';
            let g = parCat.get(cat);
            if (!g) { g = { cat, cur: [], prec: [] }; parCat.set(cat, g); }
            (f.moisEcheance === cur ? g.cur : g.prec).push(f);
        }

        const ecart = (a, b) => (a == null || b == null) ? null : a - b;
        const lignes = [...parCat.values()].map(g => {
            const c = mesurer(g.cur), p = mesurer(g.prec);
            return {
                categorie: g.cat, cur: c, prec: p,
                dNbRecouv: c.nbRecouv - p.nbRecouv,
                dEurRecouv: c.eurRecouv - p.eurRecouv,
                dTauxATemps: ecart(c.tauxATemps, p.tauxATemps),
                dRetardMoyen: ecart(c.retardMoyen, p.retardMoyen),
                dDelai: ecart(c.delaiReglement, p.delaiReglement),
            };
        }).filter(l => l.cur.nb > 0 || l.prec.nb > 0)
          .sort((a, b) => b.cur.eurRecouv - a.cur.eurRecouv);

        const tousCur = lignes.flatMap(l => l.cur.items);
        const tousPrec = lignes.flatMap(l => l.prec.items);
        const tc = mesurer(tousCur), tp = mesurer(tousPrec);
        return {
            mois: cur, moisPrec: prec, lignes,
            total: {
                categorie: 'Toutes catégories', cur: tc, prec: tp,
                dNbRecouv: tc.nbRecouv - tp.nbRecouv,
                dEurRecouv: tc.eurRecouv - tp.eurRecouv,
                dTauxATemps: ecart(tc.tauxATemps, tp.tauxATemps),
                dRetardMoyen: ecart(tc.retardMoyen, tp.retardMoyen),
                dDelai: ecart(tc.delaiReglement, tp.delaiReglement),
            },
        };
    }

    // ──────────────────────────────────────────────
    //  Acte IV — ce qui change l'ordre des appels
    // ──────────────────────────────────────────────

    /**
     * Les clients qui payaient il y a trois mois et ne payent plus.
     *
     * Deux fenêtres de trois mois d'échéance, prises bout à bout à partir du
     * dernier mois complet. Un client n'est retenu que s'il a au moins
     * `minFactures` factures dans CHACUNE des deux : sans cela, deux factures
     * d'un côté contre une de l'autre produiraient un décrochage de cinquante
     * points qui ne dit rien.
     *
     * Le taux à temps est la définition exacte employée par la comparaison par
     * catégorie. Les factures sans client sont écartées : les ranger sous un
     * tiret agrégerait des clients différents en un faux client.
     */
    function clientsQuiChangent(factures, dateRef, minFactures, seuilPoints) {
        const ref = dateRef || R.stripTime(new Date());
        const minF = minFactures || 3;
        const seuil = seuilPoints == null ? -15 : seuilPoints;
        const moisArrete = R.monthKey(ref);
        const m0 = moisComplet(moisArrete, ref) ? moisArrete : moisAvant(moisArrete);
        const recents = [m0, moisAvant(m0), moisAvant(moisAvant(m0))];
        const p0 = moisAvant(recents[2]);
        const precedents = [p0, moisAvant(p0), moisAvant(moisAvant(p0))];
        const SR = new Set(recents), SP = new Set(precedents);
        const par = new Map();
        for (const f of factures) {
            if (!f.client || !f.dateEcheance || f.dateEcheance > ref || !f.moisEcheance) continue;
            const ou = SR.has(f.moisEcheance) ? 'rec' : SP.has(f.moisEcheance) ? 'pre' : null;
            if (!ou) continue;
            let g = par.get(f.client);
            if (!g) { g = { client: f.client, rec: [], pre: [] }; par.set(f.client, g); }
            g[ou].push(f);
        }
        const tauxATemps = W => pct(W.filter(x => x.etat === 'Payée').length, W.length);
        const retardMoyen = W => moyenne(W.filter(x => x.etat === 'En retard' || x.etat === 'Payée en retard')
            .map(x => x.retardJours).filter(v => v != null));
        const ecart = (a, b) => (a == null || b == null) ? null : a - b;
        const lignes = [...par.values()]
            .filter(g => g.rec.length >= minF && g.pre.length >= minF)
            .map(g => ({
                client: g.client,
                nbRecent: g.rec.length, nbPrecedent: g.pre.length,
                tauxRecent: tauxATemps(g.rec), tauxPrecedent: tauxATemps(g.pre),
                dTauxATemps: tauxATemps(g.rec) - tauxATemps(g.pre),
                dRetardMoyen: ecart(retardMoyen(g.rec), retardMoyen(g.pre)),
                eurEnJeu: sum(g.rec.filter(x => x.etat === 'En retard'), x => x.montant),
                financements: [...new Set(g.rec.concat(g.pre).map(x => x.financement).filter(Boolean))],
                itemsRecent: g.rec, itemsPrecedent: g.pre, items: g.rec.concat(g.pre),
            }));
        return {
            moisRecents: recents.slice().reverse(), moisPrecedents: precedents.slice().reverse(),
            // Le nombre de clients suivis s'affiche sur la carte : sans lui, un
            // tableau vide se lit comme une mesure cassée au lieu de
            // « aucun décrochage ».
            nbSuivis: lignes.length,
            degrades: lignes.filter(l => l.dTauxATemps <= seuil).sort((a, b) => b.eurEnJeu - a.eurEnJeu),
            nbRedresses: lignes.filter(l => l.dTauxATemps >= -seuil).length,
        };
    }

    /**
     * Ce qui tombe à échéance dans les trente jours chez un client qui doit
     * déjà : les seules factures non échues qu'on relance.
     *
     * Les trente jours sont une fenêtre de lecture, pas une date posée sur une
     * facture : aucune échéance n'est inventée. L'état « Non échue » implique
     * déjà une échéance présente et un retard négatif ou nul, si bien que la
     * seule borne utile est la borne haute.
     */
    function echeancesARisque(factures, dateRef, jours) {
        const ref = dateRef || R.stripTime(new Date());
        const n = jours || 30;
        const borne = R.addDays(ref, n);
        const enDefaut = factures.filter(f => f.etat === 'En retard' && f.client);
        const clientsEnDefaut = new Set(enDefaut.map(f => f.client));
        const aVenir = factures.filter(f => f.etat === 'Non échue' && f.dateEcheance && f.dateEcheance <= borne);
        const aRisque = aVenir.filter(f => f.client && clientsEnDefaut.has(f.client));
        const clientsARisque = new Set(aRisque.map(f => f.client));
        const dejaDus = enDefaut.filter(f => clientsARisque.has(f.client));
        return {
            jours: n, borne, items: aRisque, itemsAVenir: aVenir,
            nb: aRisque.length, euros: sum(aRisque, f => f.montant),
            nbAVenir: aVenir.length, eurosAVenir: sum(aVenir, f => f.montant),
            part: pct(sum(aRisque, f => f.montant), sum(aVenir, f => f.montant)),
            nbClients: clientsARisque.size,
            itemsDejaDus: dejaDus, eurosDejaDus: sum(dejaDus, f => f.montant),
        };
    }

    /**
     * Du retard qui n'en est peut-être pas un : non pas une créance
     * compromise, mais une donnée incertaine — et celle-là se corrige dans
     * Monday, pas en justice.
     *
     * Le troisième motif ne peut pas s'annoncer comme « l'échéance vient de la
     * règle par défaut, facture + 30 jours » : la règle de repli porte une
     * base nulle et un nombre de jours nul, et le calcul d'échéance refuse
     * d'inventer une date. Une facture que les règles ne savent pas dater n'a
     * plus d'échéance du tout et sort en « Échéance inconnue », jamais en
     * « En retard ».
     */
    function retardDouteux(factures) {
        const enRetard = factures.filter(f => f.etat === 'En retard');
        const base = sum(enRetard, f => f.montant);
        const motifs = [
            {
                code: 'SIGNAL',
                label: "Un règlement est signalé sur le tableau opérationnel, sans ligne dans le 0.1",
                geste: "Retrouver le règlement",
                items: enRetard.filter(f => f.signalPaiementHorsTableau),
            },
            {
                code: 'ECHEANCE',
                label: "L'échéance saisie dans Monday et l'échéance calculée divergent de plus de 60 jours",
                geste: "Trancher l'échéance",
                items: enRetard.filter(f => f.dateEcheance && f.dateEcheanceSource
                    && Math.abs(R.diffDays(f.dateEcheanceSource, f.dateEcheance)) > 60),
            },
            {
                code: 'FINANCEMENT',
                label: "Dispositif non renseigné — l'échéance ne sort d'aucune règle de délai : "
                    + "elle vient du grand livre, de la dernière date du libellé, ou de Sellsy",
                geste: "Renseigner le type de financement",
                items: enRetard.filter(f => !f.financement),
            },
        ].map(m => Object.assign({}, m, { nb: m.items.length, euros: sum(m.items, f => f.montant) }));
        // Une facture peut porter deux motifs : le total la compte une fois.
        const vues = new Set(); const items = [];
        for (const m of motifs) for (const f of m.items) { if (vues.has(f)) continue; vues.add(f); items.push(f); }
        return {
            motifs, items, nb: items.length, base,
            euros: sum(items, f => f.montant),
            part: pct(sum(items, f => f.montant), base),
        };
    }

    global.LioraMetrics = {
        sum, pct, moyenne, moyennePonderee, mediane,
        filtrer, sourceDe, origineRecouvrement, vueEnsemble, parMois, parFinancement, croiseMoisFinancement,
        evolutionParFinancement, reglementsParOrigine,
        agreger, repartitionMontants, fluxRecouvrement, parDimension, finDeMois,
        dsoParMois, histogrammeRetards, TRANCHES_RETARD, joursDuMois,
        balanceAgee, balanceAgeeParDimension, ECHEANCE_MANQUANTE, LABEL_ECHEANCE_MANQUANTE, causesSansEcheance, topClients, parTableau, parGroupe,
        qualite, scoreQualite, comparaisonMensuelle, comparaisonParCategorie,
        inventaireQualifications, repartitionQualification,
        qualificationsParTableau, estColonneQualification, creancesDouteuses,
        badDebt, recuperationAuDela, badDebtParMois,
        reglementsParEcheance, partApresParMois,
        clientsQuiChangent, echeancesARisque, retardDouteux,
        moisComplet, moisAvant,
    };
})(window);
