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
    function filtrer(factures, f) {
        const champMois = f.baseMois === 'facture' ? 'moisFacture'
            : f.baseMois === 'paiement' ? 'moisPaiement' : 'moisEcheance';
        const q = R.norm(f.recherche || '');

        return factures.filter(x => {
            // Écarte les tableaux techniques ET les groupes de service
            // (archives, corbeilles) hébergés dans un tableau opérationnel.
            if (f.masquerTechnique !== false && (x.role === 'technique' || x.groupeTechnique)) return false;
            if (x.role === 'ignore') return false;

            if (f.perimetre && f.perimetre !== 'Tous' && x.perimetre !== f.perimetre) return false;

            // Source : les factures issues du tableau « payées » sont rattachées
            // à leur source d'origine si elle est connue, sinon toujours retenues.
            if (f.sources && f.sources.size) {
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
        if (/recouv|relance|mise en demeure|contentieux|huissier/.test(g)) return 'recouvrement';
        return 'hors';
    }

    // ──────────────────────────────────────────────
    //  Vue d'ensemble
    // ──────────────────────────────────────────────

    function vueEnsemble(factures) {
        const total = factures.length;
        const totalEuros = sum(factures, x => x.montant);

        const enRetard = factures.filter(x => x.etat === 'En retard');
        const nonEchues = factures.filter(x => x.etat === 'Non échue');
        const payees = factures.filter(x => x.paye);
        const payeesRetard = factures.filter(x => x.etat === 'Payée en retard');
        const echues = factures.filter(x => x.retardJours != null && x.retardJours > 0 || (x.dateEcheance && x.etat !== 'Non échue'));
        const sansEcheance = factures.filter(x => x.etat === 'Échéance inconnue');

        // Le montant de la facture, et non son encours : c'est le chiffre que
        // l'on retrouve dans Monday, donc le seul qui se vérifie d'un coup d'œil.
        const montantRetard = sum(enRetard, x => x.montant);
        const resteAEncaisser = sum(factures.filter(x => !x.paye), x => x.montant);

        // Assiette du taux : factures dont l'échéance est connue et dépassée
        const assiette = factures.filter(x => x.dateEcheance && x.etat !== 'Non échue');
        const assietteEuros = sum(assiette, x => x.montant);
        const retardCohorte = assiette.filter(x => x.etat === 'En retard' || x.etat === 'Payée en retard');

        // ── Récupération : ce qui rentre sans passer par le recouvrement ──
        // Assiette = factures arrivées à échéance. Les trois postes
        // (réglé à temps · réglé en retard · encore dû) totalisent 100 %.
        const regleATemps = assiette.filter(x => x.etat === 'Payée');
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

            // ── Répartition du portefeuille entier ──
            // Base : toutes les factures, échues ou non. C'est la lecture
            // trésorerie : ce qui est rentré, ce qui est bloqué, ce qui arrive.
            tauxPortefeuilleRegleATemps: pct(sum(regleATemps, x => x.montant), totalEuros),
            tauxPortefeuilleRegleRetard: pct(sum(payeesRetard, x => x.montant), totalEuros),
            tauxPortefeuilleEnRetard: pct(sum(enRetard, x => x.montant), totalEuros),
            tauxPortefeuilleNonEchu: pct(sum(nonEchues, x => x.montant), totalEuros),
            tauxPortefeuilleSansEcheance: pct(sum(sansEcheance, x => x.montant), totalEuros),
            eurosNonEchuesFacture: sum(nonEchues, x => x.montant),

            // Réglé sans jamais être en retard
            nbRegleATemps: regleATemps.length,
            eurosRegleATemps: sum(regleATemps, x => x.montant),
            tauxRegleATempsNb: pct(regleATemps.length, assiette.length),
            tauxRegleATempsEuros: pct(sum(regleATemps, x => x.montant), assietteEuros),

            // Réglé après l'échéance : récupéré, mais au prix d'un retard
            tauxRegleRetardNb: pct(payeesRetard.length, assiette.length),
            tauxRegleRetardEuros: pct(sum(payeesRetard, x => x.montant), assietteEuros),

            // Encore à recouvrer
            tauxResteNb: pct(enRetard.length, assiette.length),
            tauxResteEuros: pct(sum(enRetard, x => x.montant), assietteEuros),

            // Lecture « process » : d'où venait la facture quand elle a été réglée
            nbPayeesHorsRecouvrement: parOrigine.hors.length,
            eurosPayeesHorsRecouvrement: sum(parOrigine.hors, x => x.montant),
            nbPayeesViaRecouvrement: parOrigine.recouvrement.length,
            eurosPayeesViaRecouvrement: sum(parOrigine.recouvrement, x => x.montant),
            nbOrigineInconnue: parOrigine.inconnu.length,
            tauxHorsRecouvrementNb: pct(parOrigine.hors.length, origineConnue),
            tauxHorsRecouvrementEuros: pct(
                sum(parOrigine.hors, x => x.montant),
                sum(parOrigine.hors, x => x.montant) + sum(parOrigine.recouvrement, x => x.montant)),

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

    function parFinancement(factures, rules) {
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
            const assiette = g.items.filter(x => x.dateEcheance && x.etat !== 'Non échue');
            const eurTotal = sum(g.items, x => x.montant);
            const eurAssiette = sum(assiette, x => x.montant);
            const regleATemps = assiette.filter(x => x.etat === 'Payée');
            const nonEchues = g.items.filter(x => x.etat === 'Non échue');
            const payees = g.items.filter(x => x.paye);
            const sansEcheance = g.items.filter(x => x.etat === 'Échéance inconnue');
            return {
                ...g,
                nbNonEchues: nonEchues.length,
                eurNonEchues: sum(nonEchues, x => x.montant),
                nbPayees: payees.length,
                eurPayees: sum(payees, x => x.montant),
                nbSansEcheance: sansEcheance.length,
                eurSansEcheance: sum(sansEcheance, x => x.montant),
                nbRegleATemps: regleATemps.length,
                eurRegleATemps: sum(regleATemps, x => x.montant),
                tauxRegleATempsNb: pct(regleATemps.length, assiette.length),
                tauxRegleATempsEur: pct(sum(regleATemps, x => x.montant), eurAssiette),
                nbTotal: g.items.length,
                eurTotal,
                nbEnRetard: enRetard.length,
                eurEnRetard: sum(enRetard, x => x.montant),
                nbPayeeRetard: payeeRetard.length,
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

    /** Croisement mois × financement — taux en nb et en €. */
    function croiseMoisFinancement(factures, baseMois, rules) {
        const champ = baseMois === 'facture' ? 'moisFacture'
            : baseMois === 'paiement' ? 'moisPaiement' : 'moisEcheance';
        const mois = [...new Set(factures.map(f => f[champ]).filter(Boolean))].sort();
        const fins = [...new Set(factures.map(f => f.financement || 'INCONNU'))];

        const cell = {};
        for (const f of factures) {
            const mk = f[champ]; if (!mk) continue;
            const fin = f.financement || 'INCONNU';
            const k = mk + '|' + fin;
            const c = cell[k] || (cell[k] = { nbTotal: 0, eurTotal: 0, nbRetard: 0, eurRetard: 0, nbAssiette: 0, eurAssiette: 0 });
            c.nbTotal++; c.eurTotal += f.montant || 0;
            if (f.dateEcheance && f.etat !== 'Non échue') { c.nbAssiette++; c.eurAssiette += f.montant || 0; }
            if (f.etat === 'En retard') { c.nbRetard++; c.eurRetard += f.montant || 0; }
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

    function balanceAgee(factures) {
        const nonPayees = factures.filter(x => !x.paye && x.dateEcheance);
        return R.AGING_BUCKETS.map(b => {
            const items = nonPayees.filter(x => x.bucket && x.bucket.key === b.key);
            return {
                ...b,
                nb: items.length,
                euros: sum(items, x => x.montant),
                partNb: pct(items.length, nonPayees.length),
                partEuros: pct(sum(items, x => x.montant), sum(nonPayees, x => x.montant)),
            };
        });
    }

    /** Balance âgée croisée avec une dimension (financement, tableau, propriétaire…). */
    function balanceAgeeParDimension(factures, dimFn, labelFn) {
        const nonPayees = factures.filter(x => !x.paye && x.dateEcheance);
        const map = new Map();
        for (const f of nonPayees) {
            const k = dimFn(f) || '—';
            let row = map.get(k);
            if (!row) {
                row = { key: k, label: labelFn ? labelFn(k, f) : k, total: 0, nb: 0 };
                for (const b of R.AGING_BUCKETS) { row[b.key] = 0; row[b.key + '_nb'] = 0; }
                map.set(k, row);
            }
            const b = f.bucket;
            if (b) { row[b.key] += f.montant || 0; row[b.key + '_nb']++; }
            row.total += f.montant || 0;
            row.nb++;
        }
        return [...map.values()].sort((a, b) => b.total - a.total);
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

        return mois.map(mk => {
            const fin = finDeMois(mk);

            const entrees = factures.filter(f =>
                f.dateEcheance && f.moisEcheance === mk &&
                (!f.datePaiementEffective || f.datePaiementEffective > f.dateEcheance));

            const sorties = factures.filter(f =>
                f.datePaiementEffective && R.monthKey(f.datePaiementEffective) === mk &&
                f.dateEcheance && f.datePaiementEffective > f.dateEcheance);

            // Impayé à la fin du mois : échue au plus tard ce jour-là, et pas
            // encore réglée à cette date.
            const stock = factures.filter(f =>
                f.dateEcheance && f.dateEcheance <= fin &&
                (!f.datePaiementEffective || f.datePaiementEffective > fin));

            return {
                mois: mk,
                nbEntrees: entrees.length,
                eurEntrees: sum(entrees, f => f.montant),
                nbSorties: sorties.length,
                eurSorties: sum(sorties, f => f.montant),
                nbStock: stock.length,
                eurStock: sum(stock, f => f.montant),
                retardMoyenStock: moyenne(stock.map(f => R.diffDays(fin, f.dateEcheance))),
                retardMedianStock: mediane(stock.map(f => R.diffDays(fin, f.dateEcheance))),
                // Écart signé entre règlement et échéance sur les factures
                // encaissées dans le mois : négatif = payé en avance.
                retardMoyenReglement: moyenne(factures
                    .filter(f => f.datePaiementEffective && f.dateEcheance
                        && R.monthKey(f.datePaiementEffective) === mk)
                    .map(f => R.diffDays(f.datePaiementEffective, f.dateEcheance))),
                variation: sum(entrees, f => f.montant) - sum(sorties, f => f.montant),
            };
        });
    }

    /** Nombre de jours d'un mois 'YYYY-MM'. */
    function joursDuMois(mk) { return finDeMois(mk).getDate(); }

    /**
     * DSO — délai moyen de règlement client, en jours, mois par mois.
     *
     * Deux méthodes, volontairement affichées ensemble :
     *  · simple    : encours de fin de mois ÷ chiffre d'affaires du mois,
     *                ramené au nombre de jours du mois. Lisible, mais très
     *                sensible à la saisonnalité de la facturation.
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

            // Méthode simple
            const dsoSimple = caMois > 0 ? (soldeFin / caMois) * joursDuMois(mk) : null;

            // Méthode count-back : on remonte les mois jusqu'à épuiser l'encours
            let reste = soldeFin, jours = 0, k = idx, epuise = false;
            while (k >= 0) {
                const m = mois[k], c = ca[m] || 0, nj = joursDuMois(m);
                if (c <= 0) { k--; continue; }
                if (reste > c) { jours += nj; reste -= c; k--; }
                else { jours += (reste / c) * nj; epuise = true; break; }
            }
            // Encours non épuisé : plus ancien que l'historique disponible
            const dsoCountBack = soldeFin > 0 ? (epuise ? jours : null) : 0;

            return {
                mois: mk,
                ca: caMois,
                encours: soldeFin,
                nbEncours: encours.length,
                dsoSimple,
                dsoCountBack,
                tronque: soldeFin > 0 && !epuise,
            };
        });
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

    function parTableau(factures) {
        const map = new Map();
        for (const f of factures) {
            const k = f.board || '—';
            let g = map.get(k);
            if (!g) { g = { board: k, role: f.role, nb: 0, euros: 0, nbRetard: 0, eurRetard: 0, retards: [] }; map.set(k, g); }
            g.nb++; g.euros += f.montant || 0;
            if (f.etat === 'En retard') { g.nbRetard++; g.eurRetard += f.montant || 0; g.retards.push(f.retardJours); }
        }
        return [...map.values()]
            .map(g => ({ ...g, tauxNb: pct(g.nbRetard, g.nb), retardMoyen: moyenne(g.retards) }))
            .sort((a, b) => b.eurRetard - a.eurRetard);
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

    /** Répartition d'une colonne de qualification, valeur par valeur. */
    function repartitionQualification(factures, nomColonne) {
        const concernees = factures.filter(f => f.qualifs && f.qualifs[nomColonne]);
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
            lignes,
            totalNb,
            totalEur,
            nonQualifiees: factures.length - totalNb,
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
        const push = (code, titre, gravite, items, conseil) => {
            if (items.length) anomalies.push({ code, titre, gravite, nb: items.length, euros: sum(items, x => x.montant), items, conseil });
        };

        push('ECHEANCE', "Échéance impossible à calculer", 'haute',
            factures.filter(f => !f.dateEcheance),
            "Renseigner la date de facture ou la date de fin de formation sur Monday.");

        push('FINANCEMENT', "Type de financement non identifié", 'haute',
            factures.filter(f => !f.financement),
            "La règle d'échéance par défaut (facture +30 j) est appliquée — compléter la colonne « Type de financement ».");

        push('MONTANT', "Montant absent ou nul", 'haute',
            factures.filter(f => f.montant == null || f.montant === 0),
            "Sans montant, la facture ne pèse pas dans les indicateurs en euros.");

        push('PAIE_SANS_DATE', "Payée sans date de paiement", 'moyenne',
            factures.filter(f => f.paye && !f.datePaiementEffective),
            "Le retard au paiement n'est pas mesurable. Importer le grand livre pointé permet de combler ces dates.");

        push('PAIE_ESTIMEE', "Date de paiement estimée (contrôle paiement)", 'basse',
            factures.filter(f => f.paye && f.paiementEstime && f.datePaiementEffective),
            "La date de contrôle paiement sert de repli ; elle est postérieure au règlement réel, le retard est donc majoré.");

        push('DOUBLON', "Facture présente sur plusieurs tableaux", 'moyenne',
            factures.filter(f => f.doublon && !f.presenceRoles.includes('payees')),
            "Une facture ne devrait être active que sur un seul tableau opérationnel (Tampon → ADV → Recouvrement).");

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
            "Ces factures portent une date de paiement, une date de contrôle, un statut « payée » ou "
            + "un reste dû nul sur leur tableau opérationnel, mais n'apparaissent pas dans le tableau "
            + "des factures payées. Elles restent comptées comme dues, seul ce tableau faisant "
            + "règlement. Si elles sont bel et bien encaissées, il manque leur ligne dans le 0.1.");

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
    function comparaisonMensuelle(rowsMois, moisRef) {
        let rows = rowsMois.filter(m => m.assietteNb > 0);
        if (moisRef) rows = rows.filter(m => m.mois <= moisRef);
        if (rows.length < 2) return null;
        const cur = rows[rows.length - 1], prev = rows[rows.length - 2];
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

    global.LioraMetrics = {
        sum, pct, moyenne, moyennePonderee, mediane,
        filtrer, sourceDe, origineRecouvrement, vueEnsemble, parMois, parFinancement, croiseMoisFinancement,
        agreger, repartitionMontants, fluxRecouvrement, parDimension, finDeMois,
        dsoParMois, histogrammeRetards, TRANCHES_RETARD, joursDuMois,
        balanceAgee, balanceAgeeParDimension, topClients, parTableau, parGroupe,
        qualite, scoreQualite, comparaisonMensuelle,
        inventaireQualifications, repartitionQualification, creancesDouteuses,
    };
})(window);
