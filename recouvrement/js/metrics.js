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
            if (f.masquerTechnique !== false && x.role === 'technique') return false;
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

        const encoursRetard = sum(enRetard, x => x.encours);
        const encoursTotal = sum(factures.filter(x => !x.paye), x => x.encours);

        // Assiette du taux : factures dont l'échéance est connue et dépassée
        const assiette = factures.filter(x => x.dateEcheance && x.etat !== 'Non échue');
        const assietteEuros = sum(assiette, x => x.montant);
        const retardCohorte = assiette.filter(x => x.etat === 'En retard' || x.etat === 'Payée en retard');

        return {
            total, totalEuros,
            nbEnRetard: enRetard.length,
            eurosEnRetard: encoursRetard,
            nbNonEchues: nonEchues.length,
            eurosNonEchues: sum(nonEchues, x => x.encours),
            nbPayees: payees.length,
            eurosPayees: sum(payees, x => x.montant),
            nbPayeesRetard: payeesRetard.length,
            eurosPayeesRetard: sum(payeesRetard, x => x.montant),
            nbSansEcheance: sansEcheance.length,
            eurosSansEcheance: sum(sansEcheance, x => x.montant),
            encoursTotal,

            // Taux « à date » : part de l'encours actuellement en retard
            tauxNb: pct(enRetard.length, total),
            tauxEuros: pct(encoursRetard, totalEuros),

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
            retardMoyenPondere: moyennePonderee(enRetard, x => x.retardJours, x => x.encours),
            retardMoyenPaiement: moyenne(payeesRetard.map(x => x.retardJours)),
            delaiPaiementMoyen: moyenne(payees.map(x => x.delaiPaiement).filter(d => d != null && d >= 0)),

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
                case 'En retard':      m.nbEnRetard++;    m.eurEnRetard += f.encours || eur; m.retards.push(f.retardJours); break;
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
            return {
                ...g,
                nbTotal: g.items.length,
                eurTotal,
                nbEnRetard: enRetard.length,
                eurEnRetard: sum(enRetard, x => x.encours),
                nbPayeeRetard: payeeRetard.length,
                nbAssiette: assiette.length,
                eurAssiette,
                tauxNb: pct(enRetard.length, g.items.length),
                tauxEur: pct(sum(enRetard, x => x.encours), eurTotal),
                tauxCohorteNb: pct(enRetard.length + payeeRetard.length, assiette.length),
                tauxCohorteEur: pct(sum(enRetard, x => x.montant) + sum(payeeRetard, x => x.montant), eurAssiette),
                retardMoyen: moyenne(enRetard.map(x => x.retardJours)),
                retardMoyenPondere: moyennePonderee(enRetard, x => x.retardJours, x => x.encours),
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
            if (f.etat === 'En retard') { c.nbRetard++; c.eurRetard += f.encours || 0; }
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
    //  Balance âgée
    // ──────────────────────────────────────────────

    function balanceAgee(factures) {
        const nonPayees = factures.filter(x => !x.paye && x.dateEcheance);
        return R.AGING_BUCKETS.map(b => {
            const items = nonPayees.filter(x => x.bucket && x.bucket.key === b.key);
            return {
                ...b,
                nb: items.length,
                euros: sum(items, x => x.encours),
                partNb: pct(items.length, nonPayees.length),
                partEuros: pct(sum(items, x => x.encours), sum(nonPayees, x => x.encours)),
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
            if (b) { row[b.key] += f.encours || 0; row[b.key + '_nb']++; }
            row.total += f.encours || 0;
            row.nb++;
        }
        return [...map.values()].sort((a, b) => b.total - a.total);
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
            g.nb++; g.euros += f.encours || 0;
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
            if (f.etat === 'En retard') { g.nbRetard++; g.eurRetard += f.encours || 0; g.retards.push(f.retardJours); }
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
            if (f.etat === 'En retard') { g.nbRetard++; g.eurRetard += f.encours || 0; g.retards.push(f.retardJours); }
        }
        return [...map.values()]
            .map(g => ({ ...g, tauxNb: pct(g.nbRetard, g.nb), retardMoyen: moyenne(g.retards) }))
            .sort((a, b) => b.eurRetard - a.eurRetard);
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
        filtrer, sourceDe, vueEnsemble, parMois, parFinancement, croiseMoisFinancement,
        balanceAgee, balanceAgeeParDimension, topClients, parTableau, parGroupe,
        qualite, scoreQualite, comparaisonMensuelle,
    };
})(window);
