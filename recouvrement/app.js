/* ==========================================================
   Liora — Suivi Recouvrement
   app.js — Orchestration : état, chargement, filtres, rendu

   v2.4.0 — 2 septembre 2026
   ========================================================== */

(function () {
    'use strict';

    // Version de l'application, affichée dans la barre supérieure et dans
    // l'onglet Données. Elle figure ainsi sur toute capture d'écran, ce qui
    // évite d'avoir à deviner quelle version tourne quand un chiffre surprend.
    const VERSION = '2.4.0';
    const VERSION_DATE = '2 septembre 2026';

    const R = window.LioraRules;
    const PR = window.LioraPrelevements;
    const S = window.LioraStore;
    const M = window.LioraMonday;
    const I = window.LioraIngest;
    const X = window.LioraMetrics;
    const U = window.LioraUI;
    const { $, $$ } = U;

    // ══════════════════════════════════════════════
    //  État
    // ══════════════════════════════════════════════

    const state = {
        factures: [],          // factures consolidées + enrichies
        brutes: [],            // factures avant consolidation (pour ré-enrichir)
        boards: [],            // [{ id, name, role, perimetre, source, financementDefaut, actif, itemsCount, columns, mapping }]
        rules: R.DEFAULT_ECHEANCE_RULES.map(r => ({ ...r })),
        // Financements corrigés à la main, par numéro de facture : { cle: 'B2B' }
        financementsManuels: {},
        grandLivre: [],
        imports: [],

        // Prélèvements GoCardless
        gcl: { paiements: [], clients: [], mandats: [], abonnements: [], fichiers: [], unite: null },
        derniereActualisation: null,
        chargementEnCours: false,
        apprenants: [],
        gclOrphelins: 0,
        token: '',
        compte: null,

        options: {
            prefereEcheanceMonday: false,   // les règles font foi
            masquerTechnique: true,
            payeesHorsPortefeuille: false,
            actualisationAuto: 30,        // minutes, 0 = désactivée
            actualiserAuDemarrage: true,
        },

        filtres: {
            mois: null,                    // Set|null
            baseMois: 'echeance',
            perimetre: 'Tous',
            sources: new Set(['recouvrement', 'adv', 'opco', 'b2c']),
            financements: null,
            etats: null,
            boards: null,
            bucket: null,
            client: null,
            etapes: null,
            qualif: null,
            recherche: '',
            retardMin: null,
            retardMax: null,
            dateRef: R.stripTime(new Date()),
        },

        ui: {
            uniteMois: 'euros',
            uniteHeat: 'euros',
            uniteRecup: 'euros',
            repartitionDims: 'perimetre,financement',
            fluxUnite: 'euros',
            treemapDim: 'financement',
            dsoMethode: 'countback',
            histoUnite: 'euros',
            repartitionOuverts: new Set(),
            agingDim: 'financement',
            page: 1,
            pageSize: 50,
            tri: { key: 'retardJours', sens: 'desc' },
            triFin: { key: 'eurEnRetard', sens: 'desc' },
            mappingBoardId: null,
            onglet: 'dashboard',
            rangUnite: 'nb',
            prlvEtat: '',
            prlvRecherche: '',
            triPrlv: { key: 'montantEchoue', sens: 'desc' },
            evoCatUnite: 'nb',
            evoDetail: false,
            reglOrigine: 'recouvrement',
            finDetail: null,
            // Fenêtre des graphiques mensuels : l'historique remonte à 2021,
            // mais deux ans suffisent à lire une tendance sans écraser l'axe.
            fenetreMois: 24,
        },

        moisDispo: [],
    };

    window.__recouvrement = state;   // utile pour le débogage

    // ══════════════════════════════════════════════
    //  Démarrage
    // ══════════════════════════════════════════════

    async function boot() {
        U.initChartDefaults();
        $$('#brand-version').forEach(el => {
            el.textContent = 'v' + VERSION;
            el.title = 'Version ' + VERSION + ' — ' + VERSION_DATE;
        });

        // Le navigateur peut resservir un app.js d'une version antérieure : les
        // fichiers portent donc leur version dans leur adresse, et l'on vérifie
        // ici que la page et le script viennent bien de la même. Sans ce
        // contrôle, une mise à jour pouvait sembler installée sans l'être.
        const marque = (document.querySelector('script[src*="app.js"]') || {}).src || '';
        const versionPage = (marque.match(/[?&]v=([0-9.]+)/) || [])[1];
        if (versionPage && versionPage !== VERSION) {
            U.toast(`Cette page charge la version ${VERSION} alors qu'elle attend la ${versionPage} : `
                + 'votre navigateur ressert d\'anciens fichiers. Faites Ctrl + F5 pour forcer le rechargement.',
                'error', 15000);
        }
        brancherEvenements();

        const [token, boards, rules, options, imports, gl, factures, finManuels] = await Promise.all([
            S.get(S.KEYS.settings, {}).then(s => (s && s.token) || ''),
            S.get(S.KEYS.boards, []),
            S.get(S.KEYS.rules, null),
            S.get(S.KEYS.settings, {}),
            S.get(S.KEYS.imports, []),
            S.get(S.KEYS.grandLivre, []),
            S.get(S.KEYS.factures, []),
            S.get(S.KEYS.finManuels, {}),
        ]);
        state.financementsManuels = finManuels || {};

        state.token = token || '';
        state.boards = boards || [];
        state.imports = imports || [];
        state.grandLivre = gl || [];
        if (rules && rules.length) state.rules = rules;
        if (options && options.options) Object.assign(state.options, options.options);

        if (state.token) {
            $('#monday-token').value = state.token;
            $('#settings-token').value = state.token;
        }
        appliquerOptionsAuxCases();

        // L'aide reste activée d'une session à l'autre
        try {
            if (await S.get('rec_aide', false)) {
                document.body.classList.add('aide');
                $('#btn-aide').classList.add('actif');
            }
        } catch { /* ignore */ }

        avertirProtocoleFichier();

        try {
            const gcl = await S.get(S.KEYS.gocardless, null);
            if (gcl && gcl.paiements && gcl.paiements.length) {
                state.gcl.paiements = gcl.paiements.map(revivreGcl);
                state.gcl.clients = (gcl.clients || []).map(revivreGcl);
                state.gcl.mandats = (gcl.mandats || []).map(revivreGcl);
                state.gcl.abonnements = (gcl.abonnements || []).map(revivreGcl);
                state.gcl.fichiers = gcl.fichiers || [];
                recalculerPrelevements();
            }
        } catch (e) { console.warn('[Recouvrement] Rechargement GoCardless impossible', e); }

        const brutes = (factures || []).map(revivre);
        if (brutes.length) state.brutes = brutes;

        try {
            const iso = await S.get('rec_derniere_actualisation', null);
            if (iso) state.derniereActualisation = new Date(iso);
        } catch { /* ignore */ }

        proposerReprise();
        programmerActualisation();
        // Rafraîchit l'ancienneté affichée sans solliciter Monday
        setInterval(majIndicateurActualisation, 60000);
    }

    /**
     * Le bouton de reprise doit apparaître dès qu'une donnée est enregistrée,
     * factures ou prélèvements : n'avoir chargé que des exports GoCardless ne
     * doit pas laisser bloqué sur l'écran d'accueil.
     */
    function proposerReprise() {
        const btn = $('#btn-open-saved');
        if (!btn) return;
        const nbF = state.brutes.length;
        const nbA = state.apprenants.length;
        if (!nbF && !nbA) { btn.hidden = true; return; }

        const morceaux = [];
        if (nbF) morceaux.push(`${U.nombre(nbF)} factures`);
        if (nbA) morceaux.push(`${U.nombre(nbA)} apprenants`);
        btn.innerHTML = `Reprendre les données enregistrées (${morceaux.join(' · ')})`;
        btn.hidden = false;
    }

    /**
     * Ouverte en double-clic (file://), la page fonctionne entièrement — sauf
     * l'appel à l'API Monday, que le navigateur refuse depuis une origine
     * locale. On le dit avant que l'utilisatrice ne bute sur l'erreur.
     */
    function avertirProtocoleFichier() {
        if (location.protocol !== 'file:') return;
        const message = 'Page ouverte depuis un fichier : l\'import Excel / CSV '
            + 'fonctionne, mais la connexion à Monday sera refusée par le navigateur. '
            + 'Pour l\'activer, lancez « Lancer Suivi Recouvrement » '
            + '(.bat sous Windows, .command sur Mac) au lieu d\'ouvrir index.html.';
        [$('#monday-status'), $('#settings-monday-status')].forEach(el => {
            if (el) { el.className = 'connect-status pending'; el.textContent = message; }
        });
    }

    /** Les dates perdent leur type au passage par IndexedDB → reconstruction. */
    const CHAMPS_DATE = ['dateFacture', 'dateDebutFormation', 'dateFinFormation',
        'dateEcheanceSource', 'datePaiement', 'dateControlePaiement'];

    function revivre(f) {
        const o = { ...f };
        for (const c of CHAMPS_DATE) o[c] = o[c] ? R.parseDate(o[c]) : null;
        return o;
    }

    /** Les objets Date ne survivent pas toujours au clonage structuré → sérialisation ISO. */
    function serialiser(f) {
        const o = {};
        for (const k of Object.keys(f)) {
            const v = f[k];
            if (v instanceof Date) o[k] = isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10);
            else if (v instanceof Set) o[k] = [...v];
            else if (k === 'bucket' && v) o[k] = null;      // recalculé
            else o[k] = v;
        }
        return o;
    }

    // ══════════════════════════════════════════════
    //  Pipeline de calcul
    // ══════════════════════════════════════════════

    /** Consolide, enrichit et rafraîchit toute l'interface. */
    function recalculer(options) {
        const o = options || {};

        // Les lignes des tableaux de sous-éléments ne sont pas des factures.
        // Elles portent le nom du sous-élément en guise de numéro — « Subitem »
        // — et se rapprochaient donc entre elles, apparaissant comme un doublon
        // à sept exemplaires. Elles sont écartées avant toute consolidation,
        // même si un chargement antérieur les a laissées en cache.
        const ignorees = state.brutes.filter(f => f.role === 'ignore');
        state.nbLignesIgnorees = ignorees.length;
        const retenues = ignorees.length
            ? state.brutes.filter(f => f.role !== 'ignore')
            : state.brutes;

        let consolidees = I.consolider(retenues);
        state.glStats = state.grandLivre.length
            ? I.appliquerGrandLivre(consolidees, state.grandLivre)
            : null;

        I.enrichir(consolidees, {
            dateRef: state.filtres.dateRef,
            rules: state.rules,
            prefereEcheanceMonday: state.options.prefereEcheanceMonday,
            financementsManuels: state.financementsManuels,
        });

        if (state.options.payeesHorsPortefeuille) consolidees = consolidees.filter(f => !f.paye);

        state.factures = consolidees;
        majMoisDisponibles(o.conserverPeriode);
        rendreTout();
    }

    function majMoisDisponibles(conserver) {
        const champ = state.filtres.baseMois === 'facture' ? 'moisFacture'
            : state.filtres.baseMois === 'paiement' ? 'moisPaiement' : 'moisEcheance';
        state.moisDispo = [...new Set(state.factures.map(f => f[champ]).filter(Boolean))].sort();

        if (!conserver) state.filtres.mois = null;
        else if (state.filtres.mois) {
            // Retirer les mois qui n'existent plus
            const valides = new Set(state.moisDispo);
            state.filtres.mois = new Set([...state.filtres.mois].filter(m => valides.has(m)));
            if (state.filtres.mois.size === state.moisDispo.length) state.filtres.mois = null;
        }
        rendreBoutonsMois();
    }

    /** Factures après application de tous les filtres actifs. */
    function facturesFiltrees() {
        return X.filtrer(state.factures, {
            ...state.filtres,
            masquerTechnique: state.options.masquerTechnique,
        });
    }

    // ══════════════════════════════════════════════
    //  Barre de filtres
    // ══════════════════════════════════════════════

    function rendreBoutonsMois() {
        const c = $('#date-filter-months');
        if (!c) return;
        c.innerHTML = '';
        for (const mk of state.moisDispo) {
            const b = document.createElement('button');
            b.className = 'date-month-btn';
            b.dataset.month = mk;
            b.textContent = U.moisLabel(mk, true);
            if (!state.filtres.mois || state.filtres.mois.has(mk)) b.classList.add('active');
            b.addEventListener('click', () => basculerMois(mk));
            c.appendChild(b);
        }
        if (!state.moisDispo.length) {
            c.innerHTML = '<span class="fv-hint">Aucun mois exploitable — vérifiez les dates dans l\'onglet Data Quality.</span>';
        }
    }

    function basculerMois(mk) {
        const f = state.filtres;
        if (!f.mois) { f.mois = new Set(state.moisDispo); f.mois.delete(mk); }
        else if (f.mois.has(mk)) f.mois.delete(mk);
        else f.mois.add(mk);
        if (f.mois && f.mois.size === state.moisDispo.length) f.mois = null;
        state.ui.page = 1;
        rendreBoutonsMois();
        rendreTout();
    }

    /**
     * Puces de financement.
     *
     * Le filtre existait dans le moteur, atteignable seulement en cliquant une
     * ligne du tableau des catégories : il fallait deviner qu'il était là. Il
     * prend sa place dans la barre de filtres, avec les autres.
     */
    function rendreChipsFinancements() {
        const c = $('#chips-financements');
        if (!c) return;
        const sel = state.filtres.financements;

        // Les dispositifs réellement présents, les plus gros d'abord : une puce
        // pour un financement absent du portefeuille n'apprend rien.
        const compte = new Map();
        for (const f of state.factures) {
            if (f.role === 'technique' || f.groupeTechnique || f.role === 'ignore') continue;
            const k = f.financement || 'INCONNU';
            compte.set(k, (compte.get(k) || 0) + 1);
        }
        const cles = [...compte.keys()].sort((a2, b2) => compte.get(b2) - compte.get(a2));

        // Quatorze dispositifs feraient une barre de filtres plus haute que les
        // graphiques qu'elle surplombe : seuls les principaux sont montrés, les
        // autres à la demande — et ceux qui sont sélectionnés restent visibles.
        const MAX = 6;
        const tousVisibles = state.ui.finChipsTout
            || cles.length <= MAX + 1
            || (sel && sel.size && cles.slice(MAX).some(k => sel.has(k)));
        const montres = tousVisibles ? cles : cles.slice(0, MAX);

        c.innerHTML = '';
        for (const k of montres) {
            const regle = R.getRule(k, state.rules);
            const b = document.createElement('button');
            const actif = !sel || !sel.size || sel.has(k);
            b.className = 'chip chip-fin' + (actif ? ' active' : '');
            b.title = regle.note || regle.label;
            b.innerHTML = `${U.escapeHtml(regle.label)}<span class="chip-count">${U.nombre(compte.get(k))}</span>`;
            b.addEventListener('click', () => {
                // Partir de « tout » : le premier clic isole le dispositif
                // choisi, plutôt que de retirer une puce parmi quatorze.
                let set = state.filtres.financements;
                if (!set || !set.size) set = new Set([k]);
                else if (set.has(k)) { set.delete(k); if (!set.size) set = null; }
                else set.add(k);
                state.filtres.financements = set;
                state.ui.page = 1;
                rendreTout();
            });
            c.appendChild(b);
        }

        if (!tousVisibles || (state.ui.finChipsTout && cles.length > MAX)) {
            const plus = document.createElement('button');
            plus.className = 'chip chip-plus';
            plus.textContent = state.ui.finChipsTout
                ? '− réduire'
                : `+ ${U.nombre(cles.length - MAX)} autres`;
            plus.addEventListener('click', () => {
                state.ui.finChipsTout = !state.ui.finChipsTout;
                rendreChipsFinancements();
            });
            c.appendChild(plus);
        }
        if (sel && sel.size) {
            const raz = document.createElement('button');
            raz.className = 'chip chip-plus';
            raz.textContent = 'Tous';
            raz.addEventListener('click', () => {
                state.filtres.financements = null; state.ui.page = 1; rendreTout();
            });
            c.appendChild(raz);
        }
    }

    function rendreChipsSources() {
        const c = $('#chips-sources');
        if (!c) return;
        c.innerHTML = '';
        for (const s of R.SOURCES) {
            const b = document.createElement('button');
            b.className = 'chip' + (state.filtres.sources.has(s.key) ? ' active' : '');
            b.title = s.hint;
            b.textContent = s.label;
            const n = state.factures.filter(f => X.sourceDe(f) === s.key && f.etat === 'En retard').length;
            if (n) b.innerHTML += ` <span class="chip-count">${U.nombre(n)}</span>`;
            b.addEventListener('click', () => {
                const set = state.filtres.sources;
                if (set.has(s.key)) set.delete(s.key); else set.add(s.key);
                if (!set.size) { R.SOURCES.forEach(x => set.add(x.key)); }
                state.ui.page = 1;
                rendreTout();
            });
            c.appendChild(b);
        }
    }

    function rendreChipsEtats() {
        const c = $('#chips-etats');
        if (!c) return;
        const etats = ['En retard', 'Non échue', 'Payée en retard', 'Payée', 'Échéance inconnue'];
        c.innerHTML = '';
        for (const e of etats) {
            const b = document.createElement('button');
            const actif = !state.filtres.etats || state.filtres.etats.has(e);
            b.className = 'chip chip-etat ' + U.etatClass(e) + (actif ? ' active' : '');
            const n = state.factures.filter(f => f.etat === e).length;
            b.innerHTML = U.escapeHtml(e) + (n ? ` <span class="chip-count">${U.nombre(n)}</span>` : '');
            b.addEventListener('click', () => {
                let set = state.filtres.etats;
                if (!set) { set = new Set(etats); }
                if (set.has(e)) set.delete(e); else set.add(e);
                state.filtres.etats = set.size === etats.length || set.size === 0 ? null : set;
                state.ui.page = 1;
                rendreTout();
            });
            c.appendChild(b);
        }
    }

    function rendreFiltresActifs() {
        const c = $('#active-filters');
        if (!c) return;
        const f = state.filtres;
        const chips = [];
        const add = (label, onRemove) => chips.push({ label, onRemove });

        if (f.perimetre !== 'Tous') add('Périmètre : ' + f.perimetre, () => { f.perimetre = 'Tous'; majSegments(); });
        if (f.financements && f.financements.size)
            add('Financement : ' + [...f.financements].map(k => R.getRule(k, state.rules).label).join(', '), () => { f.financements = null; });
        if (f.bucket) add('Antériorité : ' + (R.AGING_BUCKETS.find(b => b.key === f.bucket) || {}).label, () => { f.bucket = null; });
        if (f.retardMin != null || f.retardMax != null) {
            const t = X.TRANCHES_RETARD.find(x => x.min === f.retardMin && x.max === f.retardMax);
            add('Retard : ' + (t ? t.label : `${f.retardMin ?? 0} → ${f.retardMax ?? '∞'} j`),
                () => { f.retardMin = null; f.retardMax = null; });
        }
        if (f.client) add('Client : ' + f.client, () => { f.client = null; });
        if (f.qualif) add(`${f.qualif.nom} : ${f.qualif.valeur}`, () => { f.qualif = null; });
        if (f.etapes && f.etapes.size) {
            const noms = [...f.etapes].map(k => (R.ETAPES.find(e => e.key === k) || {}).label || k);
            add('Étape : ' + noms.join(', '), () => { f.etapes = null; });
        }
        if (f.boards && f.boards.size) add('Tableau : ' + [...f.boards].join(', '), () => { f.boards = null; });
        if (f.etats && f.etats.size) add('État : ' + [...f.etats].join(', '), () => { f.etats = null; rendreChipsEtats(); });
        if (f.recherche) add('Recherche : ' + f.recherche, () => { f.recherche = ''; $('#search-input').value = ''; });
        if (f.mois) add(`Période : ${f.mois.size} mois sur ${state.moisDispo.length}`, () => { f.mois = null; rendreBoutonsMois(); });

        if (!chips.length) { c.classList.add('hidden'); c.innerHTML = ''; return; }
        c.classList.remove('hidden');
        c.innerHTML = chips.map((ch, i) =>
            `<span class="filter-chip">${U.escapeHtml(ch.label)}<button data-i="${i}" title="Retirer">×</button></span>`
        ).join('') + '<button class="btn btn-ghost btn-sm" id="clear-all-filters">Tout retirer</button>';

        $$('.filter-chip button', c).forEach(b => b.addEventListener('click', () => {
            chips[+b.dataset.i].onRemove();
            state.ui.page = 1;
            rendreTout();
        }));
        $('#clear-all-filters', c).addEventListener('click', reinitialiserFiltres);
    }

    function reinitialiserFiltres() {
        const f = state.filtres;
        f.mois = null; f.perimetre = 'Tous'; f.financements = null; f.etats = null;
        f.boards = null; f.bucket = null; f.client = null; f.recherche = '';
        f.retardMin = null; f.retardMax = null; f.etapes = null; f.qualif = null;
        f.sources = new Set(['recouvrement', 'adv', 'opco', 'b2c']);
        $('#search-input').value = '';
        state.ui.page = 1;
        majSegments();
        rendreBoutonsMois();
        rendreTout();
    }

    function majSegments() {
        $$('#seg-perimetre .seg-btn').forEach(b =>
            b.classList.toggle('active', b.dataset.perimetre === state.filtres.perimetre));
        $$('#seg-base-mois .seg-btn').forEach(b =>
            b.classList.toggle('active', b.dataset.base === state.filtres.baseMois));
    }

    function appliquerOptionsAuxCases() {
        $('#opt-prefere-monday').checked = state.options.prefereEcheanceMonday;
        $('#opt-masquer-technique').checked = state.options.masquerTechnique;
        $('#opt-payees-hors-portefeuille').checked = state.options.payeesHorsPortefeuille;
        $('#opt-actualisation-auto').value = String(state.options.actualisationAuto);
        $('#opt-actualiser-demarrage').checked = state.options.actualiserAuDemarrage;
    }

    // ══════════════════════════════════════════════
    //  Rendu global
    // ══════════════════════════════════════════════

    function rendreTout() {
        const data = facturesFiltrees();
        rendreChipsSources();
        rendreChipsFinancements();
        rendreChipsEtats();
        rendreFiltresActifs();
        majBadgesPeriode(data);

        switch (state.ui.onglet) {
            case 'dashboard':    rendreDashboard(data); break;
            case 'aging':        rendreAging(data); break;
            case 'financements': rendreFinancements(data); break;
            case 'factures':     rendreFactures(data); break;
            case 'prelevements': rendrePrelevements(); break;
            case 'quality':      rendreQualite(data); break;
            case 'donnees':      rendreDonnees(); break;
        }
    }

    function majBadgesPeriode(data) {
        const mois = state.filtres.mois ? [...state.filtres.mois].sort() : state.moisDispo;
        const txt = mois.length
            ? (mois.length === 1 ? U.moisLabel(mois[0]) : U.moisLabel(mois[0]) + ' → ' + U.moisLabel(mois[mois.length - 1]))
            : 'Aucune période';
        const compl = ` · ${U.nombre(data.length)} factures · arrêté au ${U.dateFR(state.filtres.dateRef)}`;
        ['#period-badge', '#aging-badge', '#fin-badge', '#factures-badge', '#quality-badge'].forEach(sel => {
            const el = $(sel); if (el) el.textContent = txt + compl;
        });
    }

    // ══════════════════════════════════════════════
    //  Onglet : Tableau de bord
    // ══════════════════════════════════════════════

    function rendreDashboard(data) {
        const v = X.vueEnsemble(data);

        // ── KPIs ──
        // Le sous-titre disait « X déjà réglés en retard » juste sous le montant
        // en retard, ce qui laissait croire que ce montant en faisait partie.
        // Il n'en fait pas partie : ce KPI ne compte que l'échu impayé.
        $('#kpi-euros-retard').textContent = U.euros(v.eurosEnRetard);
        $('#kpi-euros-retard-sub').textContent = 'échues et toujours impayées';

        $('#kpi-nb-retard').textContent = U.nombre(v.nbEnRetard);
        $('#kpi-nb-retard-sub').textContent = `sur ${U.nombre(v.total)} factures · ${U.pourcent(v.tauxNb)}`;

        // Un pourcentage sans son dénominateur ne veut rien dire : celui-ci se
        // calcule sur le total facturé, pas sur le reste à encaisser, et les
        // deux lectures donnent des chiffres très différents.
        $('#kpi-taux-euros').textContent = U.pourcent(v.tauxEuros);
        $('#kpi-taux-nb-sub').textContent =
            `${U.eurosCourt(v.eurosEnRetard)} sur ${U.eurosCourt(v.totalEuros)} facturés`;

        $('#kpi-total-euros').textContent = U.euros(v.totalEuros);
        $('#kpi-total-sub').textContent = `${U.nombre(v.total)} factures`;

        $('#kpi-encaisse').textContent = U.euros(v.eurosPayees);
        $('#kpi-encaisse-sub').textContent =
            `${U.nombre(v.nbPayees)} factures réglées · ${U.pourcent(X.pct(v.eurosPayees, v.totalEuros))} du facturé`;

        $('#kpi-encours').textContent = U.euros(v.encoursTotal);
        // La lecture trésorerie : de ce qu'il reste à rentrer, quelle part est
        // déjà en retard. C'est le pourcentage auquel on s'attend spontanément
        // en lisant « Reste à encaisser », et il n'est pas le même que le taux
        // de recouvrement, calculé lui sur le total facturé.
        $('#kpi-encours-sub').textContent =
            `${U.eurosCourt(v.eurosNonEchues)} pas encore échus · `
            + `${U.pourcent(X.pct(v.eurosEnRetard, v.encoursTotal))} déjà en retard`;

        $('#kpi-retard-moyen').textContent = U.jours(v.retardMoyen);
        $('#kpi-retard-moyen-sub').textContent = v.retardMedian != null
            ? `médiane ${U.jours(v.retardMedian)} · max ${U.jours(v.retardMax)}` : '';

        $('#kpi-retard-pondere').textContent = U.jours(v.retardMoyenPondere);

        $('#kpi-retard-paiement').textContent = U.jours(v.retardMoyenPaiement);
        $('#kpi-delai-paiement-sub').textContent = v.delaiPaiementMoyen != null
            ? `délai facture → règlement : ${U.jours(v.delaiPaiementMoyen)}` : '';

        rendreRecuperation(v);
        rendreNoteperimetre(data, v);

        rendreRepartition(data);

        // ── Graphique mensuel ──
        const rows = X.parMois(data, state.filtres.baseMois);
        rendreChartMois(rows);
        rendreComparaison(rows);

        rendreChartFlux(data);
        rendreChartRetardEvolution(data);
        rendreChartDSO(data);
        rendreChartHistoRetards(data);
        rendreTreemap(data);

        // ── Financement / balance âgée ──
        const fins = X.parFinancement(data, state.rules);
        rendreChartFinancement(fins);
        rendreChartAging(X.balanceAgee(data));

        // ── Heatmap mois × financement ──
        // Le détail de la courbe : replié tant qu'on ne l'a pas demandé.
        const detail = $('#evo-detail');
        if (detail) detail.hidden = !state.ui.evoDetail;
        if (state.ui.evoDetail) {
            rendreHeatmap(X.croiseMoisFinancement(data, state.filtres.baseMois, state.rules));
        }
        rendreChartEvoCategorie(data);
        rendreReglements(data);


        // ── Classements ──
        rendreTopClients(X.topClients(data, 12));
        rendreParTableau(X.parTableau(data));
    }

    /**
     * Répartition du portefeuille entier, factures échues et non échues
     * confondues : ce qui est rentré seul, ce qui est rentré après relance, ce
     * qui est bloqué, et ce qui reste à venir. Les tuiles totalisent 100 %.
     *
     * La quatrième tuile sert la lecture trésorerie : sans elle, on ne voyait
     * pas les encaissements attendus.
     *
     * La lecture « par le processus » — d'après le groupe Monday d'origine du
     * règlement — reste calculée et figure dans l'export Excel, mais n'est pas
     * affichée ici : sa base diffère et prêtait à confusion.
     */
    function rendreRecuperation(v) {
        const el = $('#recup-grid');
        if (!el) return;
        const eur = state.ui.uniteRecup === 'euros';
        const val = (e, n) => eur ? U.euros(e) : U.nombre(n);
        const pct = (a, b) => (b > 0 ? (a / b) * 100 : 0);

        const tuile = (o) => `
            <${o.etats ? 'button' : 'div'} class="recup-card${o.muted ? ' recup-muted' : ''}"
                ${o.etats ? `data-etats="${U.escapeHtml(o.etats.join('|'))}" title="Voir ces factures"` : ''}>
                <span class="recup-bar" style="background:${o.couleur}"></span>
                <span class="recup-taux">${U.pourcent(o.taux, 0)}</span>
                <span class="recup-label">${U.escapeHtml(o.label)}</span>
                <span class="recup-value">${o.valeur}</span>
                <span class="recup-sub">${U.escapeHtml(o.sub)}</span>
            </${o.etats ? 'button' : 'div'}>`;

        el.innerHTML = [
            tuile({
                couleur: U.couleurs.paye,
                taux: eur ? v.tauxPortefeuilleRegleATemps : pct(v.nbRegleATemps, v.total),
                etats: ['Payée'],
                label: "Réglé avant l'échéance",
                valeur: val(v.eurosRegleATemps, v.nbRegleATemps),
                sub: "rentré tout seul, sans jamais tomber en recouvrement",
            }),
            tuile({
                couleur: U.couleurs.payeRetard,
                taux: eur ? v.tauxPortefeuilleRegleRetard : pct(v.nbPayeesRetard, v.total),
                etats: ['Payée en retard'],
                label: 'Réglé en recouvrement',
                valeur: val(v.eurosPayeesRetard, v.nbPayeesRetard),
                sub: "tombé en recouvrement, puis finalement encaissé",
            }),
            tuile({
                couleur: U.couleurs.retard,
                taux: eur ? v.tauxPortefeuilleEnRetard : pct(v.nbEnRetard, v.total),
                etats: ['En retard'],
                label: 'Reste à recouvrer',
                valeur: val(v.eurosEnRetard, v.nbEnRetard),
                sub: 'en recouvrement à ce jour, toujours impayé',
            }),
            tuile({
                couleur: U.couleurs.nonEchue,
                taux: eur ? v.tauxPortefeuilleNonEchu : pct(v.nbNonEchues, v.total),
                etats: ['Non échue'],
                label: 'Pas encore échu',
                valeur: val(v.eurosNonEchuesFacture, v.nbNonEchues),
                sub: 'facturé, échéance à venir — encaissements attendus',
            }),
            v.nbSansEcheance ? tuile({
                couleur: U.couleurs.inconnu, muted: true,
                taux: eur ? v.tauxPortefeuilleSansEcheance : pct(v.nbSansEcheance, v.total),
                etats: ['Échéance inconnue'],
                label: 'Échéance inconnue',
                valeur: val(v.eurosSansEcheance, v.nbSansEcheance),
                sub: 'dates manquantes dans Monday — hors de tous les taux',
            }) : '',
        ].join('');

        $$('[data-etats]', el).forEach(b => b.addEventListener('click', () => {
            state.filtres.etats = new Set(b.dataset.etats.split('|'));
            state.ui.page = 1;
            ouvrirOnglet('factures');
        }));
    }

    /** Rappels métier contextuels (OPCO sans recouvrement, retards côté ADV). */
    function rendreNoteperimetre(data, v) {
        const el = $('#scope-note');
        if (!el) return;
        const notes = [];

        const advRetard = data.filter(f => f.etat === 'En retard' && (f.role === 'adv' || f.role === 'tampon'));
        if (advRetard.length) {
            notes.push({
                ton: 'warn',
                titre: `${U.nombre(advRetard.length)} factures en retard encore côté ADV / Tampon`,
                texte: `${U.euros(X.sum(advRetard, x => x.montant))} de factures. Elles dépassent l'échéance sans être passées en recouvrement.`,
                action: { label: 'Voir ces factures', fn: () => { state.filtres.sources = new Set(['adv']); state.filtres.etats = new Set(['En retard']); ouvrirOnglet('factures'); } },
            });
        }

        const opcoRetard = data.filter(f => f.etat === 'En retard' && (f.role === 'opco' || f.financement === 'OPCO'));
        if (opcoRetard.length) {
            notes.push({
                ton: 'info',
                titre: `${U.nombre(opcoRetard.length)} factures OPCO en retard`,
                texte: `${U.euros(X.sum(opcoRetard, x => x.montant))} de factures. Pas de recouvrement OPCO : suivi du retard uniquement — décochez « OPCO » pour les exclure des indicateurs.`,
                action: { label: 'Exclure les OPCO', fn: () => { state.filtres.sources.delete('opco'); rendreTout(); } },
            });
        }

        if (v.nbSansEcheance) {
            notes.push({
                ton: 'danger',
                titre: `${U.nombre(v.nbSansEcheance)} factures sans échéance calculable`,
                texte: `${U.euros(v.eurosSansEcheance)} exclus des taux de recouvrement, faute de date de facture ou de fin de formation.`,
                action: { label: 'Voir le détail', fn: () => ouvrirOnglet('quality') },
            });
        }

        if (!notes.length) { el.innerHTML = ''; el.classList.add('hidden'); return; }
        el.classList.remove('hidden');
        el.innerHTML = notes.map((n, i) => `
            <div class="note note-${n.ton}">
                <div class="note-body">
                    <strong>${U.escapeHtml(n.titre)}</strong>
                    <span>${U.escapeHtml(n.texte)}</span>
                </div>
                ${n.action ? `<button class="btn btn-ghost btn-sm" data-note="${i}">${U.escapeHtml(n.action.label)}</button>` : ''}
            </div>`).join('');
        $$('[data-note]', el).forEach(b => b.addEventListener('click', () => notes[+b.dataset.note].action.fn()));
    }

    // ── Répartition des montants (arbre dépliable) ──

    /** Dimensions disponibles pour l'arbre de répartition. */
    const DIMENSIONS = {
        perimetre:   { key: 'perimetre',   titre: 'Périmètre',   fn: f => f.perimetre || '—' },
        financement: { key: 'financement', titre: 'Financement', fn: f => f.financement || 'INCONNU',
                       labelFn: k => R.getRule(k, state.rules).label },
        board:       { key: 'board',       titre: 'Tableau',     fn: f => f.board || '—' },
        groupe:      { key: 'groupe',      titre: 'Groupe',      fn: f => f.groupe || f.groupeOrigine || '—' },
        mois:        { key: 'mois',        titre: 'Mois',        fn: f => f.moisEcheance || '—',
                       labelFn: k => (k === '—' ? 'Échéance inconnue' : U.moisLabel(k)) },
        client:      { key: 'client',      titre: 'Client',      fn: f => f.client || '—' },
        proprietaire:{ key: 'proprietaire', titre: 'Propriétaire', fn: f => f.proprietaire || '—' },
        etape:       { key: 'etape',       titre: 'Étape',       fn: f => f.etape || 'AUTRE',
                       labelFn: (k, f) => (f && f.etapeLabel) || k },
    };

    function rendreRepartition(data) {
        const el = $('#repartition-table');
        if (!el) return;

        const dims = state.ui.repartitionDims.split(',').map(k => DIMENSIONS[k]).filter(Boolean);
        const arbre = X.repartitionMontants(data, dims);
        const totalGeneral = X.agreger(data);

        // Aplatit l'arbre en lignes, en respectant les nœuds dépliés
        const lignes = [];
        (function parcourir(noeuds, niveau) {
            for (const n of noeuds) {
                const ouvert = state.ui.repartitionOuverts.has(n.chemin);
                lignes.push({ ...n, niveau, ouvert, feuille: !n.enfants.length });
                if (ouvert && n.enfants.length) parcourir(n.enfants, niveau + 1);
            }
        })(arbre, 0);

        const maxTotal = Math.max(1, ...arbre.map(n => n.total));

        const detailHors = n => `Réglé ${U.euros(n.eurRegle)} (${U.nombre(n.nbRegle)}) · `
            + `Non échu ${U.euros(n.eurNonEchu)} (${U.nombre(n.nbNonEchu)})`
            + (n.eurSansEcheance ? ` · Échéance inconnue ${U.euros(n.eurSansEcheance)} (${U.nombre(n.nbSansEcheance)})` : '');

        const cols = [
            {
                key: 'label', label: dims.map(d => d.titre).join(' › '), sortable: false,
                format: (v, r) => {
                    const fleche = r.feuille
                        ? '<span class="tree-spacer"></span>'
                        : `<button class="tree-toggle" data-chemin="${U.escapeHtml(r.chemin)}" title="${r.ouvert ? 'Replier' : 'Déplier'}">${r.ouvert ? '▾' : '▸'}</button>`;
                    return `<span class="tree-cell tree-n${r.niveau}">${fleche}`
                        + `<span class="tree-label" title="${U.escapeHtml(v)}">${U.escapeHtml(v)}</span></span>`;
                },
            },
            { key: 'nb', label: 'Factures', align: 'right', format: U.nombre },
            {
                key: 'total', label: 'Montant total', align: 'right',
                format: (v, r) => `${U.euros(v)} ${U.barre(v, maxTotal, 'rgba(99,102,241,0.5)')}`,
            },
            {
                key: 'eurHorsRecouvrement', label: 'Hors recouvrement', align: 'right',
                title: 'Réglé, non échu, ou échéance non calculable',
                format: (v, r) => `<span title="${U.escapeHtml(detailHors(r))}">${U.euros(v)}<span class="cell-mini">${U.nombre(r.nbHorsRecouvrement)} fact.</span></span>`,
            },
            {
                key: 'eurEnRecouvrement', label: 'En recouvrement', align: 'right',
                title: 'Factures échues et impayées',
                format: (v, r) => v
                    ? `<span class="cell-danger" title="Reste dû : ${U.euros(r.encoursEnRecouvrement)}">${U.euros(v)}<span class="cell-mini">${U.nombre(r.nbEnRecouvrement)} fact.</span></span>`
                    : '<span class="ag-zero">—</span>',
            },
            {
                key: 'tauxEur', label: '% en recouv.', align: 'right',
                format: (v, r) => `<span class="taux-cell">${U.pourcent(v, 1)}${U.barre(v, 100, U.couleurs.retard)}</span>`,
            },
            { key: 'retardMoyen', label: 'Retard moyen', align: 'right', format: U.jours },
        ];

        const total = {
            label: '<strong>Total général</strong>',
            nb: U.nombre(totalGeneral.nb),
            total: U.euros(totalGeneral.total),
            eurHorsRecouvrement: U.euros(totalGeneral.eurHorsRecouvrement),
            eurEnRecouvrement: U.euros(totalGeneral.eurEnRecouvrement),
            tauxEur: U.pourcent(totalGeneral.tauxEur, 1),
            retardMoyen: U.jours(totalGeneral.retardMoyen),
        };

        el.innerHTML = U.table(cols, lignes, {
            vide: 'Aucune facture sur ce périmètre.', total, onRowClick: true,
            rowClass: r => 'tree-row tree-row-n' + r.niveau,
        });

        // Le clic sur la flèche déplie ; le clic sur la ligne ouvre les factures.
        $$('.tree-toggle', el).forEach(btn => btn.addEventListener('click', ev => {
            ev.stopPropagation();
            const c = btn.dataset.chemin;
            const set = state.ui.repartitionOuverts;
            if (set.has(c)) set.delete(c); else set.add(c);
            rendreRepartition(facturesFiltrees());
        }));

        U.bindTable(el, lignes, { onRowClick: n => appliquerFiltreNoeud(n) });
    }

    /** Traduit un nœud de l'arbre en filtres, puis bascule sur les factures. */
    function appliquerFiltreNoeud(noeud) {
        const f = state.filtres;
        // Le chemin porte toutes les dimensions du nœud et de ses parents
        for (const segment of noeud.chemin.split('›')) {
            const i = segment.indexOf(':');
            const dim = segment.slice(0, i), cle = segment.slice(i + 1);
            switch (dim) {
                case 'perimetre':   f.perimetre = cle; break;
                case 'financement': f.financements = new Set([cle]); break;
                case 'board':       f.boards = new Set([cle]); break;
                case 'client':      f.client = cle; break;
                case 'mois':        if (cle !== '—') { f.mois = new Set([cle]); rendreBoutonsMois(); } break;
                case 'etape':       f.etapes = new Set([cle]); break;
                case 'groupe':      f.recherche = cle; $('#search-input').value = cle; break;
            }
        }
        majSegments();
        state.ui.page = 1;
        ouvrirOnglet('factures');
    }

    /**
     * Ne garder que la fin d'une série mensuelle.
     *
     * L'historique remonte à décembre 2021, mais les trois premières années ne
     * portent presque rien : cinquante-sept colonnes dont la moitié est vide
     * écrasent la période qui compte et rendent l'axe illisible. La fenêtre est
     * réglable au-dessus de chaque graphique, et « Tout » reste disponible.
     */
    function derniersMois(rows) {
        const n = state.ui.fenetreMois;
        if (!n || rows.length <= n) return rows;
        return rows.slice(rows.length - n);
    }

    /**
     * Actes repliables du tableau de bord.
     *
     * Le classement en quatre temps avait remis les blocs dans le bon ordre,
     * sans rien retirer : sept écrans de défilement, dont deux pour les
     * tendances de fond — la partie la moins consultée occupait la plus grande
     * place. Les deux derniers actes s'ouvrent donc à la demande, et le choix
     * est mémorisé. Rien n'est perdu, la page s'ouvre courte.
     */
    function brancherActes() {
        const etats = state.options.actesOuverts || (state.options.actesOuverts = {});
        $$('[data-acte-toggle]').forEach(btn => {
            const num = btn.dataset.acteToggle;
            const corps = $(`[data-acte-corps="${num}"]`);
            if (!corps) return;

            const appliquer = (ouvert) => {
                corps.hidden = !ouvert;
                btn.textContent = ouvert ? 'Replier' : 'Déplier';
                btn.setAttribute('aria-expanded', ouvert ? 'true' : 'false');
            };
            if (etats[num] != null) appliquer(!!etats[num]);

            btn.addEventListener('click', () => {
                const ouvert = corps.hidden;
                appliquer(ouvert);
                etats[num] = ouvert;
                sauverReglages();
                // Les graphiques d'un acte replié n'ont pas de taille : ils se
                // dessinent de travers si on ne les redessine pas à l'ouverture.
                if (ouvert) rendreTout();
            });
        });
    }

    /**
     * Redessiner après un clic sur un graphique.
     *
     * Chart.js poursuit son traitement d'événement après avoir appelé le
     * gestionnaire : détruire la toile dans la foulée le laisse travailler sur
     * un objet disparu (« Cannot read properties of undefined »). On lui rend
     * la main avant de reconstruire.
     */
    function rendreApresClic(action) {
        setTimeout(() => { if (action) action(); rendreTout(); }, 0);
    }

    /** Sélecteur de fenêtre, partagé par les graphiques mensuels. */
    function brancherFenetreMois() {
        $$('[data-fenetre]').forEach(b => {
            b.classList.toggle('active', String(state.ui.fenetreMois || '') === b.dataset.fenetre);
            b.addEventListener('click', () => {
                state.ui.fenetreMois = b.dataset.fenetre ? +b.dataset.fenetre : null;
                rendreTout();
            });
        });
    }

    function rendreChartMois(toutesLesLignes) {
        // Un seul axe : les deux courbes de pourcentage vivaient sur un second
        // axe à droite, dont l'alignement avec les barres était arbitraire. Le
        // taux se lit désormais sur la courbe dédiée par catégorie, et ce
        // graphique ne répond plus qu'à une question : que sont devenues les
        // factures échues de chaque mois ?
        const rows = derniersMois(toutesLesLignes);
        const eur = state.ui.uniteMois === 'euros';
        const labels = rows.map(r => U.moisLabel(r.mois, true));
        const fmt = eur ? U.eurosCourt : U.nombre;

        const jeu = (label, cle, couleur) => ({
            label, backgroundColor: couleur, borderRadius: 3, stack: 'a',
            data: rows.map(r => r[(eur ? 'eur' : 'nb') + cle]),
            yAxisID: 'y',
        });

        U.chart('chart-mois', {
            type: 'bar',
            data: {
                labels,
                datasets: [
                    jeu('Payée à temps', 'PayeeATemps', U.couleurs.paye),
                    jeu('Payée en retard', 'PayeeRetard', U.couleurs.payeRetard),
                    jeu('En retard (impayée)', 'EnRetard', U.couleurs.retard),
                    jeu('Non échue', 'NonEchue', U.couleurs.nonEchue),
                    jeu('Échéance inconnue', 'SansEcheance', U.couleurs.inconnu),
                ],
            },
            options: {
                interaction: { mode: 'index', intersect: false },
                scales: {
                    x: { stacked: true, grid: { display: false } },
                    y: { stacked: true, grid: U.grille, ticks: { callback: v => fmt(v) } },
                },
                plugins: {
                    tooltip: {
                        callbacks: {
                            label: ctx => `${ctx.dataset.label} : `
                                + (eur ? U.euros(ctx.parsed.y) : U.nombre(ctx.parsed.y) + ' factures'),
                            afterBody: items => {
                                const r = rows[items[0].dataIndex];
                                if (!r) return '';
                                return ['', `${U.pourcent(eur ? r.tauxEur : r.tauxNb)} en retard`,
                                    `Retard moyen : ${U.jours(r.retardMoyen)}`];
                            },
                        },
                    },
                },
                onClick: (evt, els) => {
                    if (!els.length) return;
                    const mk = rows[els[0].index].mois;
                    state.filtres.mois = new Set([mk]);
                    state.ui.page = 1;
                    rendreBoutonsMois();
                    rendreApresClic();
                },
            },
        });
    }

    /**
     * Flux mensuel : barres entrées / sorties de part et d'autre de zéro,
     * courbe du stock impayé à la fin de chaque mois. C'est le pendant du
     * « solde cumulé » de Suivi Cash : gagne-t-on ou perd-on du terrain ?
     */
    function rendreChartFlux(data) {
        const eur = state.ui.fluxUnite === 'euros';
        const toutes = X.fluxRecouvrement(data, state.moisDispo, state.filtres.dateRef);
        if (!toutes.length) { U.chart('chart-flux', videConfig('Aucun mois exploitable')); return; }
        // La courbe de stock vivait sur un second axe, à une échelle six fois
        // supérieure à celle des barres : l'alignement des deux était arbitraire
        // et suggérait des rapprochements que les chiffres ne disent pas. Le
        // stock se lit sur le KPI « Montant en retard » et dans la balance âgée ;
        // ce graphique ne répond plus qu'à une question : ce mois-ci, ai-je
        // gagné ou perdu du terrain ?
        const rows = derniersMois(toutes);

        const champ = (base) => eur ? 'eur' + base : 'nb' + base;
        const fmt = eur ? U.eurosCourt : U.nombre;

        U.chart('chart-flux', {
            type: 'bar',
            data: {
                labels: rows.map(r => U.moisLabel(r.mois, true)),
                datasets: [
                    {
                        label: 'Entrées en retard', order: 2,
                        data: rows.map(r => r[champ('Entrees')]),
                        backgroundColor: 'rgba(239, 68, 68, 0.75)', borderRadius: 3,
                    },
                    {
                        label: 'Sorties (encaissées)', order: 2,
                        data: rows.map(r => -r[champ('Sorties')]),
                        backgroundColor: 'rgba(132, 204, 22, 0.75)', borderRadius: 3,
                    },
                ],
            },
            options: {
                interaction: { mode: 'index', intersect: false },
                scales: {
                    x: { grid: { display: false } },
                    y: { grid: U.grille, ticks: { callback: v => fmt(Math.abs(v)) } },
                },
                plugins: {
                    tooltip: {
                        callbacks: {
                            label: ctx => `${ctx.dataset.label} : ${fmt(Math.abs(ctx.parsed.y))}`,
                            afterBody: items => {
                                const r = rows[items[0].dataIndex];
                                if (!r) return '';
                                const v = eur ? r.variation : r.nbEntrees - r.nbSorties;
                                return ['', v > 0
                                    ? `Le retard a augmenté de ${fmt(v)} ce mois-ci`
                                    : `Le retard a reculé de ${fmt(-v)} ce mois-ci`,
                                    `Montant en retard à fin de mois : ${fmt(r[champ('Stock')])}`];
                            },
                        },
                    },
                },
                onClick: (evt, els) => {
                    if (!els.length) return;
                    state.filtres.mois = new Set([rows[els[0].index].mois]);
                    state.ui.page = 1;
                    rendreBoutonsMois();
                    rendreApresClic();
                },
            },
        });
    }

    /**
     * Le retard des factures impayées, moyen et médian.
     *
     * Une troisième courbe, l'écart au règlement, y figurait : elle porte sur
     * une autre population — les factures encaissées dans le mois — et sautait
     * de vingt à quatre cents jours d'un mois à l'autre selon les quelques
     * vieilles créances soldées. Trois lectures sur un même axe pour deux
     * populations différentes, c'était la confusion assurée ; elle est retirée,
     * le KPI « Retard moyen au paiement » la donne déjà.
     */
    function rendreChartRetardEvolution(data) {
        const toutes = X.fluxRecouvrement(data, state.moisDispo, state.filtres.dateRef);
        if (!toutes.length) { U.chart('chart-retard-evolution', videConfig('Aucun mois exploitable')); return; }
        const rows = derniersMois(toutes);

        const ligne = (label, cle, couleur, dash) => ({
            label,
            data: rows.map(r => r[cle]),
            borderColor: couleur,
            backgroundColor: couleur,
            borderWidth: 2.5,
            borderDash: dash || [],
            tension: 0.3,
            pointRadius: 2,
            pointHoverRadius: 5,
            spanGaps: true,
        });

        U.chart('chart-retard-evolution', {
            type: 'line',
            data: {
                labels: rows.map(r => U.moisLabel(r.mois, true)),
                datasets: [
                    ligne('Retard moyen', 'retardMoyenStock', U.couleurs.retard),
                    ligne('Retard médian', 'retardMedianStock', U.couleurs.payeRetard, [5, 4]),
                ],
            },
            options: {
                interaction: { mode: 'index', intersect: false },
                scales: {
                    x: { grid: { display: false } },
                    y: { grid: U.grille, ticks: { callback: v => v + ' j' } },
                },
                plugins: {
                    tooltip: {
                        callbacks: {
                            label: ctx => `${ctx.dataset.label} : ${ctx.parsed.y == null ? '—' : U.jours(ctx.parsed.y)}`,
                            afterBody: items => {
                                const r = rows[items[0].dataIndex];
                                return r ? ['', `${U.nombre(r.nbStock)} factures impayées · ${U.eurosCourt(r.eurStock)}`] : '';
                            },
                        },
                    },
                },
                onClick: (evt, els) => {
                    if (!els.length) return;
                    state.filtres.mois = new Set([rows[els[0].index].mois]);
                    state.ui.page = 1;
                    rendreBoutonsMois();
                    rendreApresClic();
                },
            },
        });
    }

    function rendreChartDSO(data) {
        const toutes = X.dsoParMois(data, state.moisDispo, state.filtres.dateRef);
        if (!toutes.length) { U.chart('chart-dso', videConfig('Aucun mois exploitable')); return; }
        const rows = derniersMois(toutes);

        const methode = state.ui.dsoMethode;
        const courbes = [];
        if (methode !== 'simple') courbes.push({
            type: 'line', label: 'DSO count-back', yAxisID: 'y1', order: 0,
            data: rows.map(r => r.dsoCountBack),
            borderColor: U.couleurs.accent, backgroundColor: U.couleurs.accent,
            borderWidth: 2.5, tension: 0.3, pointRadius: 2, pointHoverRadius: 5, spanGaps: true,
        });
        if (methode !== 'countback') courbes.push({
            type: 'line', label: 'DSO simple', yAxisID: 'y1', order: 0,
            data: rows.map(r => r.dsoSimple),
            borderColor: U.couleurs.indigo, borderDash: [5, 4],
            borderWidth: 2, tension: 0.3, pointRadius: 0, spanGaps: true,
        });

        U.chart('chart-dso', {
            type: 'bar',
            data: {
                labels: rows.map(r => U.moisLabel(r.mois, true)),
                // Les barres en euros et la courbe en jours partageaient un
                // graphique à deux axes, dont l'alignement ne veut rien dire :
                // le reste à encaisser se lit dans la balance âgée. Ne subsiste
                // ici que ce que le DSO mesure — un nombre de jours.
                datasets: courbes.map(c => ({ ...c, yAxisID: 'y' })),
            },
            options: {
                interaction: { mode: 'index', intersect: false },
                scales: {
                    x: { grid: { display: false } },
                    y: {
                        grid: U.grille, beginAtZero: true,
                        ticks: { callback: v => v + ' j' },
                    },
                },
                plugins: {
                    tooltip: {
                        callbacks: {
                            label: ctx => `${ctx.dataset.label} : `
                                + (ctx.parsed.y == null ? 'non calculable' : U.jours(ctx.parsed.y)),
                            afterBody: items => {
                                const r = rows[items[0].dataIndex];
                                if (!r) return '';
                                const l = [`Reste à encaisser : ${U.euros(r.encours)}`,
                                    `CA facturé du mois : ${U.euros(r.ca)}`,
                                    `${U.nombre(r.nbEncours)} factures non réglées`];
                                if (r.tronque) l.push("⚠ encours plus ancien que l'historique chargé");
                                return ['', ...l];
                            },
                        },
                    },
                },
            },
        });
    }

    const treemapPalette = [
        '#1e2a5e', '#2a3a80', '#3b4fa0', '#4f62b8', '#6474cc', '#7c8ae0',
        '#F47458', '#f59e0b', '#84cc16', '#3b82f6', '#8b5cf6', '#06b6d4',
        '#ec4899', '#14b8a6', '#ef4444', '#f97316', '#6366f1', '#d946ef',
    ];

    function rendreTreemap(data) {
        const dim = DIMENSIONS[state.ui.treemapDim] || DIMENSIONS.financement;
        const enRetard = data.filter(f => f.etat === 'En retard');
        const groupes = X.parDimension(enRetard, dim.fn, dim.labelFn, f => f.montant).slice(0, 24);

        if (!groupes.length) { U.chart('chart-treemap', videConfig('Aucune facture en retard')); return; }

        const total = X.sum(groupes, g => g.valeur);
        const couleurs = {};
        groupes.forEach((g, i) => { couleurs[g.label] = treemapPalette[i % treemapPalette.length]; });

        const config = {
            type: 'treemap',
            data: {
                datasets: [{
                    tree: groupes.map(g => ({ label: g.label, value: g.valeur, nb: g.nb, retard: g.retardMoyen })),
                    key: 'value',
                    groups: ['label'],
                    backgroundColor: c => (c.raw && c.raw._data) ? (couleurs[c.raw._data.label] || '#6366f1') : 'transparent',
                    borderColor: '#0b0e1a',
                    borderWidth: 3,
                    spacing: 2,
                    labels: {
                        display: true, align: 'center', position: 'middle', overflow: 'fit',
                        color: '#ffffff', font: { size: 12, weight: '700', family: 'Inter' },
                        formatter: c => {
                            const d = c.raw && c.raw._data;
                            if (!d) return '';
                            const part = total > 0 ? (c.raw.v / total) * 100 : 0;
                            return [d.label, U.eurosCourt(c.raw.v), U.pourcent(part, 1)];
                        },
                    },
                }],
            },
            options: {
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        callbacks: {
                            title: items => (items[0] && items[0].raw._data && items[0].raw._data.label) || '',
                            label: item => {
                                const d = item.raw._data;
                                const part = total > 0 ? (item.raw.v / total) * 100 : 0;
                                return [`${U.euros(item.raw.v)} (${U.pourcent(part, 1)})`,
                                    `${U.nombre(d.nb)} factures · retard moyen ${U.jours(d.retard)}`];
                            },
                        },
                    },
                },
                onClick: (evt, els) => {
                    if (!els.length) return;
                    const ctx = els[0].element.$context;
                    const label = ctx && ctx.raw && ctx.raw._data && ctx.raw._data.label;
                    if (!label) return;
                    const g = groupes.find(x => x.label === label);
                    if (g) filtrerParDimension(state.ui.treemapDim, g.cle);
                },
            },
        };

        // Repli en barres horizontales si le plugin treemap n'est pas chargé.
        try {
            U.chart('chart-treemap', config);
        } catch (e) {
            console.warn('[Recouvrement] Treemap indisponible, repli en barres', e);
            U.chart('chart-treemap', {
                type: 'bar',
                data: {
                    labels: groupes.map(g => g.label),
                    datasets: [{
                        data: groupes.map(g => g.valeur),
                        backgroundColor: groupes.map((_, i) => treemapPalette[i % treemapPalette.length]),
                        borderRadius: 4,
                    }],
                },
                options: {
                    indexAxis: 'y',
                    scales: { x: { grid: U.grille, ticks: { callback: v => U.eurosCourt(v) } }, y: { grid: { display: false } } },
                    plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => U.euros(c.parsed.x) } } },
                },
            });
        }
    }

    /** Pose le filtre correspondant à une dimension puis rafraîchit. */

    /**
     * Les créances anciennes finissent-elles par rentrer ?
     *
     * Le graphique juxtaposait deux séries que rien ne rend comparables :
     * l'une porte sur des factures encore dues, dont le retard court toujours,
     * l'autre sur des factures réglées, dont le retard est définitif. Deux
     * hauteurs côte à côte, deux significations, aucune lecture possible.
     *
     * La question tient en une phrase — parmi les factures ayant atteint tel
     * niveau d'ancienneté, quelle part a fini par rentrer ? — donc en une seule
     * série : la composition de chaque tranche, ramenée à cent pour cent.
     */
    function rendreChartHistoRetards(data) {
        const eur = state.ui.histoUnite === 'euros';
        const rows = X.histogrammeRetards(data);
        const total = X.sum(rows, r => (eur ? r.eurImpayees + r.eurPayees : r.nbImpayees + r.nbPayees));
        if (!total) { U.chart('chart-histo-retards', videConfig('Aucun retard sur ce périmètre')); return; }

        const val = (r, quoi) => eur ? r['eur' + quoi] : r['nb' + quoi];
        const somme = r => val(r, 'Impayees') + val(r, 'Payees');
        const part = (r, quoi) => somme(r) ? (val(r, quoi) / somme(r)) * 100 : 0;

        U.chart('chart-histo-retards', {
            type: 'bar',
            data: {
                labels: rows.map(r => r.label),
                datasets: [
                    {
                        label: 'A fini par rentrer',
                        data: rows.map(r => part(r, 'Payees')),
                        backgroundColor: U.couleurs.paye, borderRadius: 3, stack: 'a',
                    },
                    {
                        label: 'Toujours dû',
                        data: rows.map(r => part(r, 'Impayees')),
                        backgroundColor: U.couleurs.retard, borderRadius: 3, stack: 'a',
                    },
                ],
            },
            options: {
                interaction: { mode: 'index', intersect: false },
                scales: {
                    x: { stacked: true, grid: { display: false },
                         title: { display: true, text: "Retard atteint par la facture" } },
                    y: { stacked: true, min: 0, max: 100, grid: U.grille,
                         ticks: { callback: v => v + ' %' } },
                },
                plugins: {
                    tooltip: {
                        callbacks: {
                            label: ctx => {
                                const r = rows[ctx.dataIndex];
                                const quoi = ctx.datasetIndex === 0 ? 'Payees' : 'Impayees';
                                return `${ctx.dataset.label} : ${U.pourcent(part(r, quoi), 0)}`
                                    + ` — ${eur ? U.euros(val(r, quoi)) : U.nombre(val(r, quoi)) + ' factures'}`;
                            },
                            afterBody: items => {
                                const r = rows[items[0].dataIndex];
                                if (!r) return '';
                                return ['',
                                    `${eur ? U.euros(somme(r)) : U.nombre(somme(r)) + ' factures'} ont atteint ce retard`,
                                    `soit ${U.pourcent((somme(r) / total) * 100, 0)} de l'ensemble des retards`,
                                    '', 'Cliquez pour ouvrir cette tranche'];
                            },
                        },
                    },
                },
                onClick: (evt, els) => {
                    if (!els.length) return;
                    const t = rows[els[0].index];
                    state.filtres.retardMin = t.min;
                    state.filtres.retardMax = t.max;
                    state.ui.page = 1;
                    rendreApresClic(() => ouvrirOnglet('factures'));
                },
            },
        });
    }

    /** Pose le filtre correspondant à une dimension puis rafraîchit. */
    function filtrerParDimension(dim, cle) {
        const f = state.filtres;
        switch (dim) {
            case 'financement': f.financements = new Set([cle]); break;
            case 'client':      f.client = cle; break;
            case 'board':       f.boards = new Set([cle]); break;
            case 'perimetre':   f.perimetre = cle; majSegments(); break;
            case 'etape':       f.etapes = new Set([cle]); break;
            case 'groupe':
            case 'proprietaire':
                f.recherche = cle; $('#search-input').value = cle; break;
            default: return;
        }
        state.ui.page = 1;
        rendreTout();
    }


    function rendreComparaison(rows) {
        const el = $('#month-compare-body');
        const cmp = X.comparaisonMensuelle(rows, R.monthKey(state.filtres.dateRef));
        if (!cmp) { el.innerHTML = '<p class="fv-hint">Deux mois au minimum sont nécessaires pour comparer.</p>'; $('#month-compare-title').textContent = ''; return; }

        $('#month-compare-title').textContent = `${U.moisLabel(cmp.mois)} vs ${U.moisLabel(cmp.moisPrec)}`;

        const ligne = (label, d, fmt, inverse) => {
            const hausse = d.ecart > 0;
            const bon = inverse ? !hausse : hausse;
            const cls = d.ecart === 0 ? 'neutre' : (bon ? 'bon' : 'mauvais');
            const fleche = d.ecart === 0 ? '=' : (hausse ? '▲' : '▼');
            return `<div class="cmp-row">
                <span class="cmp-label">${U.escapeHtml(label)}</span>
                <span class="cmp-prev">${fmt(d.prev)}</span>
                <span class="cmp-arrow cmp-${cls}">${fleche}</span>
                <span class="cmp-cur">${fmt(d.cur)}</span>
                <span class="cmp-delta cmp-${cls}">${d.ecartPct == null ? '—' : (d.ecartPct > 0 ? '+' : '') + U.pourcent(d.ecartPct, 0)}</span>
            </div>`;
        };

        el.innerHTML = `<div class="cmp-table">
            <div class="cmp-row cmp-head"><span>Indicateur</span><span>${U.moisLabel(cmp.moisPrec, true)}</span><span></span><span>${U.moisLabel(cmp.mois, true)}</span><span>Écart</span></div>
            ${ligne('Montant en retard', cmp.eurEnRetard, U.eurosCourt, true)}
            ${ligne('Factures en retard', cmp.nbEnRetard, U.nombre, true)}
            ${ligne('% en retard (€)', cmp.tauxEur, v => U.pourcent(v), true)}
            ${ligne('% en retard (nb)', cmp.tauxNb, v => U.pourcent(v), true)}
            ${ligne('Retard moyen', cmp.retardMoyen, U.jours, true)}
        </div>`;
    }

    function rendreChartFinancement(fins) {
        const top = fins.filter(f => f.eurEnRetard > 0).slice(0, 12);
        if (!top.length) { U.chart('chart-financement', videConfig('Aucune facture en retard')); return; }

        U.chart('chart-financement', {
            type: 'bar',
            data: {
                labels: top.map(f => f.label),
                datasets: [{
                    label: 'Montant en retard',
                    data: top.map(f => f.eurEnRetard),
                    backgroundColor: top.map((_, i) => U.palette[i % U.palette.length]),
                    borderRadius: 4,
                }],
            },
            options: {
                indexAxis: 'y',
                scales: {
                    x: { grid: U.grille, ticks: { callback: v => U.eurosCourt(v) } },
                    y: { grid: { display: false } },
                },
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        callbacks: {
                            label: ctx => U.euros(ctx.parsed.x),
                            afterLabel: ctx => {
                                const f = top[ctx.dataIndex];
                                return [`${U.nombre(f.nbEnRetard)} factures · ${U.pourcent(f.tauxEur)} du portefeuille`,
                                    `Retard moyen : ${U.jours(f.retardMoyen)}`];
                            },
                        },
                    },
                },
                onClick: (evt, els) => {
                    if (!els.length) return;
                    state.filtres.financements = new Set([top[els[0].index].key]);
                    state.ui.page = 1;
                    rendreApresClic();
                },
            },
        });
    }

    function rendreChartAging(buckets) {
        const actifs = buckets.filter(b => b.nb > 0);
        if (!actifs.length) { U.chart('chart-aging', videConfig('Aucun encours')); return; }

        U.chart('chart-aging', {
            type: 'doughnut',
            data: {
                labels: actifs.map(b => b.label),
                datasets: [{
                    data: actifs.map(b => b.euros),
                    backgroundColor: actifs.map(b => b.couleur),
                    borderColor: 'rgba(11,14,26,0.9)', borderWidth: 2,
                }],
            },
            options: {
                cutout: '60%',
                plugins: {
                    legend: { position: 'right' },
                    tooltip: {
                        callbacks: {
                            label: ctx => {
                                const b = actifs[ctx.dataIndex];
                                return `${U.euros(b.euros)} · ${U.nombre(b.nb)} factures · ${U.pourcent(b.partEuros)}`;
                            },
                        },
                    },
                },
                onClick: (evt, els) => {
                    if (!els.length) return;
                    state.filtres.bucket = actifs[els[0].index].key;
                    state.ui.page = 1;
                    rendreApresClic();
                },
            },
        });
    }

    function videConfig(message) {
        return {
            type: 'bar',
            data: { labels: [message], datasets: [{ data: [0], backgroundColor: 'transparent' }] },
            options: { plugins: { legend: { display: false }, tooltip: { enabled: false } }, scales: { x: { display: false }, y: { display: false } } },
        };
    }

    /** Heatmap mois × financement du taux de retard. */
    /**
     * Ce que le recouvrement fait rentrer — et ce qui rentre sans lui.
     *
     * Deux populations de factures réglées : celles qui ont demandé une relance
     * et celles qui sont rentrées seules. La bascule passe de l'une à l'autre,
     * sur la même mise en page, pour qu'elles se comparent d'un coup d'œil.
     */
    function rendreReglements(data) {
        const origine = state.ui.reglOrigine || 'recouvrement';
        const r = X.reglementsParOrigine(data, origine, state.rules);
        const viaRecouv = origine === 'recouvrement';

        const t = $('#regl-titre');
        if (t) t.textContent = viaRecouv
            ? 'Ce que le recouvrement fait rentrer'
            : 'Ce qui rentre sans relance';

        const h = $('#regl-hint');
        if (h) h.innerHTML = (viaRecouv
            ? "Factures réglées qui sont passées par le recouvrement — le tableau des factures payées "
              + "conserve le groupe d'où elles venaient. C'est le produit du travail de relance."
            : "Factures réglées qui ne sont jamais passées par le recouvrement : elles sont rentrées "
              + "d'elles-mêmes, avec ou sans retard.")
            + (r.nbOrigineInconnue
                ? ` <strong>${U.nombre(r.nbOrigineInconnue)} factures réglées ne peuvent être attribuées</strong>,
                    faute de groupe d'origine renseigné dans « 0.1. ALL - Factures payées » : elles sont
                    hors de ce décompte.`
                : '');

        $('#regl-kpi').innerHTML = [
            tuileDetail(U.nombre(r.nb), viaRecouv ? 'Factures récupérées' : 'Factures rentrées seules',
                U.euros(r.euros), viaRecouv ? U.couleurs.payeRetard : U.couleurs.paye),
            tuileDetail(U.pourcent(r.partEuros, 1), 'Part des règlements',
                `${U.pourcent(r.partNb, 1)} en nombre`, U.couleurs.indigo),
            tuileDetail(U.nombre(r.nbEnRetard), 'Dont payées en retard',
                U.euros(r.eurosEnRetard), U.couleurs.retard),
            tuileDetail(U.jours(r.retardMoyen), 'Retard moyen au paiement',
                r.delaiMoyen != null ? `délai facture → règlement : ${U.jours(r.delaiMoyen)}` : '—',
                U.couleurs.nonEchue),
        ].join('');

        // Ce qui rentre chaque mois
        const mois = derniersMois(r.mois);
        if (!mois.length) {
            U.chart('chart-regl-mois', videConfig('Aucun règlement daté sur ce périmètre'));
        } else {
            U.chart('chart-regl-mois', {
                type: 'bar',
                data: {
                    labels: mois.map(m => U.moisLabel(m.mois, true)),
                    datasets: [{
                        label: viaRecouv ? 'Encaissé après relance' : 'Encaissé sans relance',
                        data: mois.map(m => m.euros),
                        backgroundColor: viaRecouv ? U.couleurs.payeRetard : U.couleurs.paye,
                        borderRadius: 3,
                    }],
                },
                options: {
                    interaction: { mode: 'index', intersect: false },
                    scales: {
                        x: { grid: { display: false } },
                        y: { grid: U.grille, ticks: { callback: v => U.eurosCourt(v) } },
                    },
                    plugins: {
                        legend: { display: false },
                        tooltip: {
                            callbacks: {
                                label: ctx => `${U.euros(ctx.parsed.y)}`,
                                afterBody: items => {
                                    const m = mois[items[0].dataIndex];
                                    return ['', `${U.nombre(m.nb)} factures`,
                                        m.retardMoyen != null ? `retard moyen ${U.jours(m.retardMoyen)}` : ''];
                                },
                            },
                        },
                    },
                },
            });
        }

        const el = $('#regl-financements');
        el.innerHTML = U.table([
            { key: 'label', label: 'Type de financement' },
            { key: 'nb', label: 'Factures', align: 'right', format: U.nombre },
            { key: 'euros', label: 'Montant', align: 'right', format: v => U.euros(v) },
            // La moyenne porte sur toutes les factures réglées de la catégorie,
            // paiements en avance compris : un chiffre négatif est un règlement
            // avant échéance, ce que « retard » ne pouvait pas dire.
            { key: 'retardMoyen', label: 'Écart à l\'échéance', align: 'right',
              title: 'Négatif : payé avant échéance. Positif : payé en retard.',
              format: v => v == null ? '—'
                  : `<span class="${v > 0 ? 'cell-danger' : ''}">${v > 0 ? '+' : ''}${U.jours(v)}</span>` },
        ], r.financements, {
            vide: 'Aucune facture réglée dans cette catégorie.', onRowClick: true,
            total: { label: 'Total', nb: U.nombre(r.nb), euros: U.euros(r.euros) },
        });
        U.bindTable(el, r.financements, {
            onRowClick: f => {
                state.filtres.financements = new Set([f.cle]);
                state.ui.page = 1;
                ouvrirOnglet('factures');
            },
        });
    }

    /**
     * Variation du taux de recouvrement, une courbe par type de financement.
     *
     * La carte thermique dit l'état mois par mois ; elle dit mal le sens de la
     * pente. C'est pourtant la question — quelles catégories se dégradent ?
     */
    function rendreChartEvoCategorie(data) {
        const eur = state.ui.evoCatUnite === 'euros';
        const { mois, series } = X.evolutionParFinancement(data, state.filtres.baseMois, state.rules);

        if (!mois.length || !series.length) {
            U.chart('chart-evo-categorie', videConfig('Pas assez de factures échues pour tracer une évolution'));
            return;
        }

        // Trop de courbes ne se lisent plus : les catégories marginales sont
        // regroupées hors du graphique plutôt que de le saturer.
        const principales = series.slice(0, 8);

        U.chart('chart-evo-categorie', {
            type: 'line',
            data: {
                labels: mois.map(m => U.moisLabel(m, true)),
                datasets: principales.map((s2, i) => ({
                    label: s2.label,
                    data: eur ? s2.pointsEur : s2.pointsNb,
                    borderColor: U.palette[i % U.palette.length],
                    backgroundColor: U.palette[i % U.palette.length],
                    borderWidth: 2, tension: 0.3, spanGaps: false,
                    pointRadius: 2, pointHoverRadius: 5,
                })),
            },
            options: {
                interaction: { mode: 'index', intersect: false },
                scales: {
                    y: { grid: U.grille, min: 0, max: 100, ticks: { callback: v => v + ' %' } },
                    x: { grid: { display: false } },
                },
                plugins: {
                    legend: { position: 'bottom', labels: { boxWidth: 10, usePointStyle: true } },
                    tooltip: {
                        callbacks: {
                            label: ctx => {
                                const s2 = principales[ctx.datasetIndex];
                                if (ctx.parsed.y == null) return null;
                                return `${s2.label} : ${U.pourcent(ctx.parsed.y, 1)}`
                                    + ` (${U.nombre(s2.cohortes[ctx.dataIndex])} factures échues)`;
                            },
                            afterBody: () => ['', 'Cliquez pour ouvrir le détail mois par mois'],
                        },
                    },
                },
                // La carte thermique dit le détail que la courbe résume : elle
                // s'ouvre au clic, plutôt que d'occuper l'écran en permanence.
                onClick: () => rendreApresClic(() => { state.ui.evoDetail = !state.ui.evoDetail; }),
            },
        });
    }

    function rendreHeatmap(croise) {
        const el = $('#heatmap-mois-financement');
        const eur = state.ui.uniteHeat === 'euros';
        if (!croise.mois.length || !croise.fins.length) {
            el.innerHTML = '<p class="fv-hint">Pas assez de données pour le croisement.</p>';
            return;
        }

        const couleurCase = t => {
            if (t == null) return 'background:transparent;color:var(--text-muted)';
            const p = Math.max(0, Math.min(100, t)) / 100;
            const alpha = 0.12 + p * 0.78;
            return `background:rgba(239,68,68,${alpha.toFixed(2)});color:${p > 0.45 ? '#fff' : 'var(--text-primary)'}`;
        };

        let h = '<table class="heatmap"><thead><tr><th class="hm-corner">Financement</th>';
        for (const m of croise.mois) h += `<th>${U.escapeHtml(U.moisLabel(m, true))}</th>`;
        h += '<th class="hm-total">Total</th></tr></thead><tbody>';

        for (const fin of croise.fins) {
            let totNum = 0, totDen = 0;
            let cells = '';
            for (const m of croise.mois) {
                const c = croise.cell(m, fin);
                if (!c || (eur ? c.eurAssiette : c.nbAssiette) === 0) {
                    cells += '<td class="hm-empty">·</td>';
                    continue;
                }
                const num = eur ? c.eurRetard : c.nbRetard;
                const den = eur ? c.eurAssiette : c.nbAssiette;
                totNum += num; totDen += den;
                const t = den > 0 ? (num / den) * 100 : null;
                const detail = eur
                    ? `${U.eurosCourt(num)} en retard sur ${U.eurosCourt(den)} échus`
                    : `${c.nbRetard} en retard sur ${c.nbAssiette} échues`;
                cells += `<td style="${couleurCase(t)}" title="${U.escapeHtml(U.moisLabel(m) + ' — ' + croise.labels[fin] + ' : ' + detail)}"
                          data-mois="${m}" data-fin="${U.escapeHtml(fin)}" class="hm-cell">${t == null ? '·' : Math.round(t) + '%'}</td>`;
            }
            const tTot = totDen > 0 ? (totNum / totDen) * 100 : null;
            h += `<tr><th class="hm-row-label" data-fin="${U.escapeHtml(fin)}">${U.escapeHtml(croise.labels[fin] || fin)}</th>${cells}`
               + `<td class="hm-total" style="${couleurCase(tTot)}">${tTot == null ? '·' : Math.round(tTot) + '%'}</td></tr>`;
        }
        h += '</tbody></table>';
        el.innerHTML = h;

        $$('.hm-cell', el).forEach(td => td.addEventListener('click', () => {
            state.filtres.mois = new Set([td.dataset.mois]);
            state.filtres.financements = new Set([td.dataset.fin]);
            state.ui.page = 1;
            rendreBoutonsMois();
            rendreTout();
        }));
        $$('.hm-row-label', el).forEach(th => th.addEventListener('click', () => {
            state.filtres.financements = new Set([th.dataset.fin]);
            state.ui.page = 1;
            rendreTout();
        }));
    }

    function rendreTopClients(rows) {
        const el = $('#top-clients');
        const max = rows.length ? rows[0].euros : 0;
        const html = U.table([
            { key: 'client', label: 'Client' },
            { key: 'euros', label: 'Montant en retard', align: 'right', format: (v) => `${U.euros(v)} ${U.barre(v, max, U.couleurs.retard)}` },
            { key: 'nb', label: 'Nb', align: 'right', format: U.nombre },
            { key: 'retardMoyen', label: 'Retard moyen', align: 'right', format: U.jours },
            { key: 'plusVieille', label: 'Plus ancien', align: 'right', format: v => U.pastilleRetard(v) },
        ], rows, { vide: 'Aucune facture en retard sur ce périmètre.', onRowClick: true });
        el.innerHTML = html;
        U.bindTable(el, rows, { onRowClick: r => { state.filtres.client = r.client; state.ui.page = 1; rendreTout(); } });
    }

    function rendreParTableau(rows) {
        const el = $('#par-tableau');
        const max = rows.length ? Math.max(...rows.map(r => r.eurRetard)) : 0;
        el.innerHTML = U.table([
            { key: 'board', label: 'Tableau' },
            { key: 'role', label: 'Rôle', format: v => `<span class="pill pill-role">${U.escapeHtml(R.ROLE_LABELS[v] || v || '—')}</span>` },
            { key: 'eurRetard', label: 'En retard', align: 'right', format: v => `${U.eurosCourt(v)} ${U.barre(v, max, U.couleurs.retard)}` },
            { key: 'nbRetard', label: 'Nb', align: 'right', format: U.nombre },
            { key: 'tauxNb', label: '% nb', align: 'right', format: v => U.pourcent(v, 0) },
        ], rows, { vide: 'Aucun tableau chargé.', onRowClick: true });
        U.bindTable(el, rows, { onRowClick: r => { state.filtres.boards = new Set([r.board]); state.ui.page = 1; rendreTout(); } });
    }

    // ══════════════════════════════════════════════
    //  Onglet : Balance âgée
    // ══════════════════════════════════════════════

    function rendreAging(data) {
        const buckets = X.balanceAgee(data);
        const totalEuros = X.sum(buckets, b => b.euros);

        $('#bucket-cards').innerHTML = buckets.map(b => `
            <button class="bucket-card${state.filtres.bucket === b.key ? ' selected' : ''}" data-bucket="${b.key}">
                <span class="bucket-bar" style="background:${b.couleur}"></span>
                <span class="bucket-label">${U.escapeHtml(b.label)}</span>
                <span class="bucket-value">${U.euros(b.euros)}</span>
                <span class="bucket-sub">${U.nombre(b.nb)} factures · ${U.pourcent(b.partEuros, 0)}</span>
            </button>`).join('')
            + `<div class="bucket-card bucket-total">
                 <span class="bucket-label">Reste à encaisser</span>
                 <span class="bucket-value">${U.euros(totalEuros)}</span>
                 <span class="bucket-sub">${U.nombre(X.sum(buckets, b => b.nb))} factures non réglées</span>
               </div>`;

        $$('#bucket-cards [data-bucket]').forEach(b => b.addEventListener('click', () => {
            state.filtres.bucket = state.filtres.bucket === b.dataset.bucket ? null : b.dataset.bucket;
            state.ui.page = 1;
            rendreTout();
        }));

        rendreAgingTable(data);
        rendreAgingParMois(data);
    }

    function rendreAgingTable(data) {
        const dim = state.ui.agingDim;
        const dimFn = {
            financement: f => f.financement || 'INCONNU',
            board: f => f.board,
            client: f => f.client,
            proprietaire: f => f.proprietaire,
        }[dim];
        const labelFn = dim === 'financement' ? (k => R.getRule(k, state.rules).label) : (k => k);

        let rows = X.balanceAgeeParDimension(data, dimFn, labelFn);
        if (dim === 'client' || dim === 'proprietaire') rows = rows.slice(0, 40);

        const cols = [
            { key: 'label', label: dim === 'financement' ? 'Financement' : dim === 'board' ? 'Tableau' : dim === 'client' ? 'Client' : 'Propriétaire' },
            ...R.AGING_BUCKETS.map(b => ({
                key: b.key, label: b.label, align: 'right',
                format: (v, row) => v ? `<span class="ag-cell" title="${row[b.key + '_nb']} factures">${U.eurosCourt(v)}</span>` : '<span class="ag-zero">·</span>',
                cls: () => 'ag-col',
            })),
            { key: 'total', label: 'Total', align: 'right', format: U.euros, cls: () => 'ag-total' },
            { key: 'nb', label: 'Nb', align: 'right', format: U.nombre },
        ];

        const total = { label: 'Total général', total: U.euros(X.sum(rows, r => r.total)), nb: U.nombre(X.sum(rows, r => r.nb)) };
        for (const b of R.AGING_BUCKETS) total[b.key] = U.eurosCourt(X.sum(rows, r => r[b.key]));

        const el = $('#aging-table');
        el.innerHTML = U.table(cols, rows, { vide: 'Aucun encours non réglé.', total, onRowClick: true });
        U.bindTable(el, rows, {
            onRowClick: r => {
                if (dim === 'financement') state.filtres.financements = new Set([r.key]);
                else if (dim === 'board') state.filtres.boards = new Set([r.key]);
                else if (dim === 'client') state.filtres.client = r.key;
                state.ui.page = 1;
                ouvrirOnglet('factures');
            },
        });
    }

    function rendreAgingParMois(data) {
        const nonPayees = data.filter(f => !f.paye && f.dateEcheance);
        const mois = [...new Set(nonPayees.map(f => f.moisEcheance))].sort();
        if (!mois.length) { U.chart('chart-aging-mois', videConfig('Aucun encours')); return; }

        const datasets = R.AGING_BUCKETS.map(b => ({
            label: b.label,
            backgroundColor: b.couleur,
            borderRadius: 3,
            data: mois.map(m => X.sum(nonPayees.filter(f => f.moisEcheance === m && f.bucket && f.bucket.key === b.key), f => f.montant)),
        }));

        U.chart('chart-aging-mois', {
            type: 'bar',
            data: { labels: mois.map(m => U.moisLabel(m, true)), datasets },
            options: {
                interaction: { mode: 'index', intersect: false },
                scales: {
                    x: { stacked: true, grid: { display: false } },
                    y: { stacked: true, grid: U.grille, ticks: { callback: v => U.eurosCourt(v) } },
                },
                plugins: {
                    tooltip: { callbacks: { label: ctx => `${ctx.dataset.label} : ${U.euros(ctx.parsed.y)}` } },
                },
            },
        });
    }

    // ══════════════════════════════════════════════
    //  Onglet : Financements
    // ══════════════════════════════════════════════

    function rendreFinancements(data) {
        let rows = X.parFinancement(data, state.rules);
        const t = state.ui.triFin;
        rows.sort((a, b) => {
            const va = a[t.key], vb = b[t.key];
            const cmp = (typeof va === 'string')
                ? String(va).localeCompare(String(vb), 'fr')
                : ((va == null ? -Infinity : va) - (vb == null ? -Infinity : vb));
            return t.sens === 'asc' ? cmp : -cmp;
        });

        const maxEur = Math.max(1, ...rows.map(r => r.eurEnRetard));

        // Chaque colonne d'état porte le nombre de factures en gros et le
        // montant en dessous : c'est la question posée — combien, et pour quel
        // montant — et elle se lit sans passer par une info-bulle.
        const cellule = (nb, euros, danger) => nb
            ? `<span class="${danger ? 'cell-danger' : ''}">${U.nombre(nb)}<span class="cell-mini">${U.eurosCourt(euros)}</span></span>`
            : '<span class="ag-zero">—</span>';

        const cols = [
            { key: 'label', label: 'Type de financement', format: (v, r) => `${U.escapeHtml(v)}${r.sansRecouvrement ? ' <span class="pill pill-muted" title="Pas de recouvrement OPCO">hors recouvrement</span>' : ''}` },
            { key: 'nbTotal', label: 'Factures', align: 'right',
              format: (v, r) => `<strong>${U.nombre(v)}</strong><span class="cell-mini">${U.eurosCourt(r.eurTotal)}</span>` },
            { key: 'nbEnRetard', label: 'En retard', align: 'right',
              title: 'Échéance dépassée et facture non réglée',
              format: (v, r) => cellule(v, r.eurEnRetard, true) },
            { key: 'nbNonEchues', label: 'Pas encore échu', align: 'right',
              title: "Facturé, échéance à venir",
              format: (v, r) => cellule(v, r.eurNonEchues) },
            { key: 'nbPayees', label: 'Réglé', align: 'right',
              title: 'Factures réglées, y compris celles dont l\'échéance n\'est pas calculable',
              format: (v, r) => cellule(v, r.eurPayees) },
            { key: 'nbSansEcheance', label: 'Sans échéance', align: 'right',
              title: 'Non réglées et sans échéance calculable — ni en retard, ni à venir : elles sortent de tous les taux',
              format: (v, r) => cellule(v, r.eurSansEcheance) },
            // Le taux était calculé en euros alors que la colonne annonçait
            // « % en retard » à côté de colonnes en nombre : sur un financement
            // dont les montants sont absents, il tombait à 0 % en face de
            // centaines de factures en retard. Le nombre fait foi, les euros
            // sont donnés en dessous.
            { key: 'tauxNb', label: '% en retard', align: 'right',
              title: 'Part des factures en retard, en nombre — le pourcentage en euros est indiqué en dessous',
              format: (v, r) => `<span class="taux-cell">${U.pourcent(v, 1)}${U.barre(v, 100, U.couleurs.retard)}</span>`
                  + `<span class="cell-mini">${r.eurTotal ? U.pourcent(r.tauxEur, 1) + ' en €' : 'montants absents'}</span>` },
            { key: 'retardMoyen', label: 'Retard moyen', align: 'right', format: U.jours },
        ];

        const tot = (cle, cleEur) =>
            `<strong>${U.nombre(X.sum(rows, r => r[cle]))}</strong>`
            + `<span class="cell-mini">${U.eurosCourt(X.sum(rows, r => r[cleEur]))}</span>`;
        const total = {
            label: 'Total',
            nbTotal: tot('nbTotal', 'eurTotal'),
            nbEnRetard: tot('nbEnRetard', 'eurEnRetard'),
            nbNonEchues: tot('nbNonEchues', 'eurNonEchues'),
            nbPayees: tot('nbPayees', 'eurPayees'),
            nbSansEcheance: tot('nbSansEcheance', 'eurSansEcheance'),
        };

        // Les quatre états doivent redonner le nombre total de factures. Le
        // dire, et le vérifier à l'écran, évite d'avoir à refaire l'addition
        // à la main pour savoir si le tableau est juste.
        const ecart = X.sum(rows, r =>
            r.nbTotal - r.nbEnRetard - r.nbNonEchues - r.nbPayees - r.nbSansEcheance);
        const sansMontant = X.sum(rows, r => r.nbSansMontant);
        const note = $('#fin-coherence');
        if (note) {
            const bouts = [];
            bouts.push(ecart === 0
                ? '✓ En retard + Pas encore échu + Réglé + Sans échéance = nombre total de factures, sur chaque ligne.'
                : `⚠ Écart de ${U.nombre(Math.abs(ecart))} factures entre le total et la somme des états — signalez-le.`);
            if (sansMontant) bouts.push(`${U.nombre(sansMontant)} factures sans montant exploitable : elles comptent dans les nombres, pas dans les euros.`);
            note.innerHTML = bouts.join(' ');
            note.className = 'fv-hint' + (ecart === 0 ? '' : ' cell-danger');
        }

        const el = $('#fin-table');
        el.innerHTML = U.table(cols, rows, {
            vide: 'Aucune facture sur ce périmètre.', total, onRowClick: true,
            tri: t, onSort: k => { t.sens = (t.key === k && t.sens === 'desc') ? 'asc' : 'desc'; t.key = k; rendreTout(); },
        });
        U.bindTable(el, rows, {
            onSort: k => { t.sens = (t.key === k && t.sens === 'desc') ? 'asc' : 'desc'; t.key = k; rendreTout(); },
            onRowClick: r => {
                // Entrer dans une catégorie plutôt que sauter aux factures :
                // ses qualifications et ses prélèvements se lisent ici.
                state.ui.finDetail = state.ui.finDetail === r.key ? null : r.key;
                rendreTout();
                const el = $('#fin-detail');
                if (el && !el.hidden) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
            },
        });

        rendreDetailFinancement(data, rows);

        // Graphiques
        const top = X.parFinancement(data, state.rules).filter(r => r.nbTotal > 0).slice(0, 12);
        U.chart('chart-fin-taux', {
            type: 'bar',
            data: {
                labels: top.map(r => r.label),
                datasets: [
                    { label: "Aujourd'hui : encore en retard", data: top.map(r => r.tauxEur), backgroundColor: U.couleurs.retard, borderRadius: 4 },
                    { label: 'Au fil du temps : a fini en retard', data: top.map(r => r.tauxCohorteEur), backgroundColor: U.couleurs.payeRetard, borderRadius: 4 },
                ],
            },
            options: {
                scales: { x: { grid: { display: false }, ticks: { maxRotation: 45, minRotation: 30 } }, y: { grid: U.grille, ticks: { callback: v => v + ' %' } } },
                plugins: { tooltip: { callbacks: { label: ctx => `${ctx.dataset.label} : ${U.pourcent(ctx.parsed.y)}` } } },
            },
        });

        U.chart('chart-fin-retard', {
            type: 'bar',
            data: {
                labels: top.map(r => r.label),
                datasets: [
                    { label: 'Impayées : attendent depuis', data: top.map(r => r.retardMoyen || 0), backgroundColor: U.couleurs.indigo, borderRadius: 4 },
                    { label: 'Réglées : payées avec ce retard', data: top.map(r => r.retardMoyenPaiement || 0), backgroundColor: U.couleurs.paye, borderRadius: 4 },
                ],
            },
            options: {
                scales: { x: { grid: { display: false }, ticks: { maxRotation: 45, minRotation: 30 } }, y: { grid: U.grille, ticks: { callback: v => v + ' j' } } },
                plugins: { tooltip: { callbacks: { label: ctx => `${ctx.dataset.label} : ${U.jours(ctx.parsed.y)}` } } },
            },
        });

        rendreTableRegles();
    }

    function rendreTableRegles() {
        const baseLabel = { dateFacture: 'Date de facture', dateFinFormation: 'Fin de formation', dateDebutFormation: 'Début de formation' };
        const rows = state.rules.map(r => ({
            ...r,
            baseTxt: baseLabel[r.base] || r.base,
            reglePhrase: `${baseLabel[r.base] || r.base} ${r.jours >= 0 ? '+' : '−'} ${Math.abs(r.jours)} jours`,
            repliTxt: r.fallback ? `${baseLabel[r.fallback] || r.fallback} + ${r.fallbackJours != null ? r.fallbackJours : r.jours} j` : '—',
            nb: state.factures.filter(f => f.financement === r.key).length,
        }));

        const el = $('#rules-table');
        el.innerHTML = U.table([
            { key: 'label', label: 'Type de financement' },
            { key: 'reglePhrase', label: "Règle d'échéance" },
            { key: 'repliTxt', label: 'Repli si date absente' },
            { key: 'perimetre', label: 'Périmètre' },
            { key: 'nb', label: 'Factures', align: 'right', format: U.nombre },
            { key: 'note', label: 'Remarque', cls: () => 'cell-note' },
        ], rows, { vide: 'Aucune règle.' });
    }

    // ══════════════════════════════════════════════
    //  Onglet : Factures
    // ══════════════════════════════════════════════

    function rendreFactures(data) {
        const t = state.ui.tri;
        const rows = data.slice().sort((a, b) => {
            let va = a[t.key], vb = b[t.key];
            if (va instanceof Date) va = va.getTime();
            if (vb instanceof Date) vb = vb.getTime();
            let cmp;
            if (typeof va === 'string' || typeof vb === 'string') cmp = String(va || '').localeCompare(String(vb || ''), 'fr');
            else cmp = (va == null ? -Infinity : va) - (vb == null ? -Infinity : vb);
            return t.sens === 'asc' ? cmp : -cmp;
        });

        const pageSize = state.ui.pageSize;
        const nbPages = Math.max(1, Math.ceil(rows.length / pageSize));
        if (state.ui.page > nbPages) state.ui.page = nbPages;
        const debut = (state.ui.page - 1) * pageSize;
        const page = rows.slice(debut, debut + pageSize);

        // L'état et le retard viennent juste après le client : ce sont les deux
        // signaux que la responsable recouvrement lit en premier.
        const sel = state.ui.selection || (state.ui.selection = new Set());
        const cols = [
            // Case de sélection : elle sert à corriger le financement de
            // plusieurs factures d'un coup, sans les ouvrir une par une.
            { key: '__sel', label: '', align: 'center', width: '34px', sortable: false,
              format: (v, r) => `<input type="checkbox" class="fact-sel" data-cle="${U.escapeHtml(r.cleManuelle || '')}"${sel.has(r.cleManuelle) ? ' checked' : ''}>` },
            { key: 'numero', label: 'Facture', format: (v, r) => `<span class="mono">${U.escapeHtml(v || '—')}</span>${r.doublon ? ' <span class="pill pill-muted" title="Présente sur plusieurs tableaux : ' + U.escapeHtml(r.presenceTableaux.join(', ')) + '">×' + r.presenceTableaux.length + '</span>' : ''}` },
            { key: 'client', label: 'Client', format: (v) => `<span class="cell-clip cell-clip-lg" title="${U.escapeHtml(v)}">${U.escapeHtml(v)}</span>` },
            { key: 'etat', label: 'État', format: v => `<span class="pill ${U.etatClass(v)}">${U.escapeHtml(v)}</span>` },
            { key: 'retardJours', label: 'Retard', align: 'right', format: v => U.pastilleRetard(v) },
            { key: 'encours', label: 'Reste dû', align: 'right', format: v => v ? U.euros(v) : '—' },
            { key: 'montant', label: 'Montant', align: 'right', format: v => U.euros(v) },
            {
                key: 'financement', label: 'Financement',
                format: (v, r) => {
                    const l = R.getRule(v, state.rules).label;
                    const marque = r.financementManuel
                        ? ' <span class="pill pill-muted" title="Financement corrigé à la main">✔</span>' : '';
                    return `<span class="cell-clip" title="${U.escapeHtml(l)}">${U.escapeHtml(l)}</span>${marque}`;
                },
            },
            { key: 'dateFacture', label: 'Facture', align: 'center', format: U.dateFR },
            { key: 'dateEcheance', label: 'Échéance', align: 'center', format: (v, r) => `${U.dateFR(v)}${r.echeanceOrigine === 'Règle' ? `<span class="calc-flag" title="Calculée par la règle ${U.escapeHtml(r.regleLabel)}">ƒ</span>` : ''}` },
            {
                key: 'datePaiementEffective', label: 'Paiement', align: 'center',
                format: (v, r) => {
                    if (!v) return '—';
                    let marque = '';
                    if (r.paiementEstime) marque = '<span class="calc-flag" title="Date de contrôle paiement — le règlement réel est antérieur">≈</span>';
                    else if (r.dateVientDuGL) marque = '<span class="calc-flag calc-gl" title="Date issue du grand livre lettré">GL</span>';
                    return U.dateFR(v) + marque;
                },
            },
            { key: 'board', label: 'Tableau', format: (v, r) => `<span class="cell-clip cell-board" title="${U.escapeHtml((v || '') + (r.groupe ? ' — ' + r.groupe : ''))}">${U.escapeHtml(v || '—')}</span>` },
        ];

        const el = $('#factures-table');
        el.innerHTML = U.table(cols, page, {
            vide: 'Aucune facture ne correspond aux filtres.',
            tri: t, onSort: true, onRowClick: true,
            rowClass: r => U.etatClass(r.etat) + '-row',
        });
        U.bindTable(el, page, {
            onSort: k => { t.sens = (t.key === k && t.sens === 'desc') ? 'asc' : 'desc'; t.key = k; rendreTout(); },
            onRowClick: (f, ev) => {
                if (ev && ev.target && ev.target.classList.contains('fact-sel')) return;
                ouvrirFiche(f);
            },
        });

        $$('.fact-sel', el).forEach(c => c.addEventListener('click', (ev) => {
            ev.stopPropagation();
            const cle = c.dataset.cle;
            if (!cle) return;
            if (c.checked) sel.add(cle); else sel.delete(cle);
            rendreBarreSelection(rows);
        }));
        rendreBarreSelection(rows);

        // Pagination
        const p = $('#factures-pagination');
        const totalEuros = X.sum(rows, r => r.montant);
        const totalEncours = X.sum(rows, r => r.encours);
        p.innerHTML = `
            <div class="pagination-info">
                ${U.nombre(rows.length)} factures · ${U.euros(totalEuros)} facturés · ${U.euros(totalEncours)} restant dû
            </div>
            <div class="pagination-controls">
                <button class="btn btn-ghost btn-sm" data-page="1" ${state.ui.page === 1 ? 'disabled' : ''}>«</button>
                <button class="btn btn-ghost btn-sm" data-page="${state.ui.page - 1}" ${state.ui.page === 1 ? 'disabled' : ''}>‹</button>
                <span class="pagination-page">Page ${state.ui.page} / ${nbPages}</span>
                <button class="btn btn-ghost btn-sm" data-page="${state.ui.page + 1}" ${state.ui.page >= nbPages ? 'disabled' : ''}>›</button>
                <button class="btn btn-ghost btn-sm" data-page="${nbPages}" ${state.ui.page >= nbPages ? 'disabled' : ''}>»</button>
            </div>`;
        $$('[data-page]', p).forEach(b => b.addEventListener('click', () => {
            state.ui.page = Math.max(1, Math.min(nbPages, +b.dataset.page));
            rendreTout();
        }));
    }

    /**
     * Détail d'une catégorie de financement.
     *
     * L'onglet Qualifications présentait ces colonnes hors de tout contexte :
     * on y lisait la répartition des problématiques sans savoir de quelle
     * catégorie elles parlaient. Elles ont leur place ici, quand on entre dans
     * une catégorie — avec, pour le financement personnel, les prélèvements
     * GoCardless qui en sont le mode de paiement.
     */
    function rendreDetailFinancement(data, lignes) {
        const el = $('#fin-detail');
        if (!el) return;
        const cle = state.ui.finDetail;
        const ligne = cle && lignes.find(r => r.key === cle);
        if (!ligne) { el.hidden = true; el.innerHTML = ''; return; }

        const lot = data.filter(f => (f.financement || 'INCONNU') === cle);
        const regle = R.getRule(cle, state.rules);
        const douteuses = X.creancesDouteuses(lot);

        // ── Les qualifications de cette catégorie, tableau par tableau ──
        const parTableau = X.qualificationsParTableau(lot, false);
        const blocsQualif = parTableau.map(b => {
            const cartes = b.colonnes.map(c => {
                const r = X.repartitionQualification(lot, c.nom, b.board);
                const barres = r.lignes.slice(0, 8).map((l, i) => `
                    <button class="qualif-barre" data-qnom="${U.escapeHtml(c.nom)}" data-qval="${U.escapeHtml(l.valeur)}">
                        <span class="qualif-barre-tete">
                            <span class="cell-clip" title="${U.escapeHtml(l.valeur)}">${U.escapeHtml(l.valeur)}</span>
                            <strong>${U.nombre(l.nb)}</strong>
                        </span>
                        <span class="qualif-barre-piste">
                            <span class="qualif-barre-jauge" style="width:${Math.max(2, l.partNb)}%;background:${U.palette[i % U.palette.length]}"></span>
                        </span>
                        <span class="qualif-barre-pied">${U.pourcent(l.partNb, 1)} · ${U.euros(l.euros)}${l.nbEnRetard ? ` · ${U.nombre(l.nbEnRetard)} en retard` : ''}</span>
                    </button>`).join('');
                return `<h4 class="qualif-col-titre">${U.escapeHtml(c.nom)}
                            <span class="fv-hint">${U.nombre(r.totalNb)} factures renseignées</span>
                        </h4>
                        <div class="qualif-barres">${barres}</div>`;
            }).join('');
            return `<div class="detail-sous-bloc"><h3>${U.escapeHtml(b.board)}</h3>${cartes}</div>`;
        }).join('');

        // ── Prélèvements, quand la catégorie est payée par mandat ──
        const st = state.apprenants.length ? PR.statistiques(state.apprenants, state.gcl.paiements) : null;
        const parMandat = /perso|personnel/i.test(regle.label);
        const blocPrlv = (parMandat && st) ? `
            <div class="detail-sous-bloc">
                <h3>Prélèvements GoCardless</h3>
                <span class="fv-hint">
                    Le financement personnel se règle par mandat : voici comment ces prélèvements se passent.
                    Ces chiffres portent sur l'ensemble des mandats, non sur les seules factures de la catégorie.
                </span>
                <div class="recup-grid">
                    ${tuileDetail(U.pourcent(st.partSansIncident, 1), 'Apprenants sans incident',
                        `${U.nombre(st.nbSansIncident)} sur ${U.nombre(st.nbApprenants)}`, U.couleurs.paye)}
                    ${tuileDetail(U.pourcent(st.tauxEchecPrelevements, 1), 'Prélèvements rejetés',
                        `${U.nombre(st.nbEchecsPrelevements)} sur ${U.nombre(st.nbPresentes)} présentés`, U.couleurs.retard)}
                    ${tuileDetail(U.pourcent(st.partRattrapes, 1), 'Incidents rattrapés',
                        `${U.nombre(st.nbRattrapes)} sur ${U.nombre(st.nbAvecIncident)} apprenants touchés`, U.couleurs.payeRetard)}
                    ${tuileDetail(U.euros(st.montantARisque), 'Montant à risque',
                        `${U.nombre(st.nbEnDifficulte)} apprenants en difficulté`, U.couleurs.inconnu)}
                </div>
            </div>` : (parMandat ? `
            <div class="detail-sous-bloc">
                <h3>Prélèvements GoCardless</h3>
                <span class="fv-hint">Aucun export GoCardless chargé — l'onglet <em>Prélèvements</em> permet de les déposer.</span>
            </div>` : '');

        el.hidden = false;
        el.innerHTML = `
            <div class="charts-grid"><div class="chart-card chart-wide detail-categorie">
                <div class="chart-header">
                    <h3>${U.escapeHtml(ligne.label)}</h3>
                    <div class="chart-controls">
                        <button class="btn btn-ghost btn-sm" id="fin-detail-factures">Voir les factures</button>
                        <button class="btn btn-ghost btn-sm" id="fin-detail-fermer">Fermer</button>
                    </div>
                </div>
                <span class="fv-hint">Règle d'échéance : ${U.escapeHtml(regle.note || '—')}</span>
                <div class="recup-grid">
                    ${tuileDetail(U.nombre(ligne.nbTotal), 'Factures', U.euros(ligne.eurTotal), U.couleurs.indigo)}
                    ${tuileDetail(U.nombre(ligne.nbEnRetard), 'En retard', U.euros(ligne.eurEnRetard), U.couleurs.retard)}
                    ${tuileDetail(U.nombre(ligne.nbNonEchues), 'Pas encore échu', U.euros(ligne.eurNonEchues), U.couleurs.nonEchue)}
                    ${tuileDetail(U.jours(ligne.retardMoyen), 'Retard moyen', `${U.pourcent(ligne.tauxNb, 1)} des factures en retard`, U.couleurs.payeRetard)}
                    ${douteuses.nb
                        ? tuileDetail(U.nombre(douteuses.nb), 'Créances douteuses',
                            `${U.euros(douteuses.euros)} — contentieux et pertes`, U.couleurs.inconnu)
                        : ''}
                </div>
                ${blocsQualif || '<p class="fv-hint">Aucune colonne de qualification sur les tableaux de cette catégorie.</p>'}
                ${blocPrlv}
            </div></div>`;

        $('#fin-detail-fermer').addEventListener('click', () => {
            state.ui.finDetail = null; rendreTout();
        });
        $('#fin-detail-factures').addEventListener('click', () => {
            state.filtres.financements = new Set([cle]);
            state.ui.page = 1;
            ouvrirOnglet('factures');
        });
        $$('.qualif-barre', el).forEach(b => b.addEventListener('click', () => {
            state.filtres.financements = new Set([cle]);
            filtrerParQualification(b.dataset.qnom, b.dataset.qval);
        }));
    }

    const tuileDetail = (valeur, label, detail, couleur) => `
        <div class="recup-card">
            <span class="recup-bar" style="background:${couleur}"></span>
            <span class="recup-taux">${valeur}</span>
            <span class="recup-label">${U.escapeHtml(label)}</span>
            <span class="recup-value">${detail}</span>
        </div>`;

    /**
     * Barre d'action de la sélection.
     *
     * Corriger le financement facture par facture n'est pas tenable quand
     * plusieurs centaines sortent en « Corporate — financement à préciser » :
     * on en coche autant qu'on veut, on choisit une fois, et tout est appliqué.
     * La correction est retenue sur le numéro de facture et survit donc au
     * rechargement de Monday.
     */
    function rendreBarreSelection(rowsVisibles) {
        const el = $('#barre-selection');
        if (!el) return;
        const sel = state.ui.selection || new Set();
        if (!sel.size) { el.hidden = true; el.innerHTML = ''; return; }

        const options = state.rules
            .filter(r => r.key !== 'CORPORATE')
            .map(r => `<option value="${U.escapeHtml(r.key)}">${U.escapeHtml(r.label)}</option>`).join('');

        el.hidden = false;
        el.innerHTML = `
            <span class="sel-nb">${U.nombre(sel.size)} facture${sel.size > 1 ? 's' : ''} sélectionnée${sel.size > 1 ? 's' : ''}</span>
            <label class="sel-champ">Financement
                <select class="input input-sm" id="sel-financement">
                    <option value="">— choisir —</option>${options}
                </select>
            </label>
            <button class="btn btn-primary btn-sm" id="sel-appliquer">Appliquer</button>
            <button class="btn btn-ghost btn-sm" id="sel-retirer">Rendre au calcul automatique</button>
            <button class="btn btn-ghost btn-sm" id="sel-tout">Tout sélectionner (${U.nombre(rowsVisibles.length)})</button>
            <button class="btn btn-ghost btn-sm" id="sel-aucun">Désélectionner</button>`;

        $('#sel-appliquer').addEventListener('click', async () => {
            const v = $('#sel-financement').value;
            if (!v) { U.toast('Choisissez un type de financement.', 'error'); return; }
            for (const cle of sel) state.financementsManuels[cle] = v;
            await appliquerFinancementsManuels(sel.size, R.getRule(v, state.rules).label);
        });
        $('#sel-retirer').addEventListener('click', async () => {
            for (const cle of sel) delete state.financementsManuels[cle];
            await appliquerFinancementsManuels(sel.size, null);
        });
        $('#sel-tout').addEventListener('click', () => {
            rowsVisibles.forEach(r => { if (r.cleManuelle) sel.add(r.cleManuelle); });
            rendreTout();
        });
        $('#sel-aucun').addEventListener('click', () => { sel.clear(); rendreTout(); });
    }

    async function appliquerFinancementsManuels(nb, label) {
        await S.set(S.KEYS.finManuels, state.financementsManuels);
        state.ui.selection.clear();
        recalculer({ conserverPeriode: true });
        rendreTout();
        U.toast(label
            ? `${U.nombre(nb)} factures passées en « ${label} ».`
            : `${U.nombre(nb)} factures rendues au calcul automatique.`, 'success');
    }

    /** Fiche détaillée d'une facture, avec la traçabilité du calcul d'échéance. */
    function ouvrirFiche(f) {
        const baseLabel = { dateFacture: 'date de facture', dateFinFormation: 'fin de formation', dateDebutFormation: 'début de formation', 'colonne Monday': 'colonne Monday' };
        const ligne = (l, v) => `<div class="fiche-row"><span>${U.escapeHtml(l)}</span><strong>${v}</strong></div>`;

        const explication = f.echeanceOrigine === 'Monday'
            ? "Échéance lue directement dans Monday."
            : f.echeanceBase
                ? `Échéance calculée : ${baseLabel[f.echeanceBase] || f.echeanceBase} (${U.dateFR(f[f.echeanceBase])}) + ${R.getRule(f.financement, state.rules).jours} jours.`
                : "Échéance non calculable : ni date de facture ni date de fin de formation.";

        U.modal(`Facture ${f.numero || '—'}`, `
            <div class="fiche">
                <div class="fiche-head">
                    <span class="pill ${U.etatClass(f.etat)}">${U.escapeHtml(f.etat)}</span>
                    ${U.pastilleRetard(f.retardJours)}
                </div>
                <div class="fiche-grid">
                    ${ligne('Client', U.escapeHtml(f.client))}
                    ${ligne('Type de financement',
                        `<select class="input input-sm" id="fiche-financement">`
                        + `<option value="">— calcul automatique —</option>`
                        + state.rules.filter(r => r.key !== 'CORPORATE')
                            .map(r => `<option value="${U.escapeHtml(r.key)}"${f.financementManuel && r.key === f.financement ? ' selected' : ''}>${U.escapeHtml(r.label)}</option>`).join('')
                        + '</select>'
                        + (f.financementManuel ? '' : ` <span class="fv-hint">déduit : ${U.escapeHtml(R.getRule(f.financement, state.rules).label)}</span>`)
                        + (f.financementBrut ? ` <span class="fv-hint">(« ${U.escapeHtml(f.financementBrut)} »)</span>` : ''))}
                    ${ligne('Montant', U.euros(f.montant, true))}
                    ${(!f.paye && f.encours !== f.montant) ? ligne('Reste dû', U.euros(f.encours, true)) : ''}
                    ${ligne('Date de facture', U.dateFR(f.dateFacture))}
                    ${ligne('Début de formation', U.dateFR(f.dateDebutFormation))}
                    ${ligne('Fin de formation', U.dateFR(f.dateFinFormation))}
                    ${ligne('Échéance retenue', U.dateFR(f.dateEcheance) + ` <span class="fv-hint">(${f.echeanceOrigine || 'non calculée'})</span>`)}
                    ${ligne('Date de paiement', U.dateFR(f.datePaiement))}
                    ${ligne('Date contrôle paiement', U.dateFR(f.dateControlePaiement))}
                    ${f.origineDatePaiement ? ligne('Date retenue pour le retard', U.dateFR(f.datePaiementEffective) + ` <span class="fv-hint">(${U.escapeHtml(f.origineDatePaiement)})</span>`) : ''}
                    ${f.datePaiementMonday ? ligne('Date Monday remplacée', U.dateFR(f.datePaiementMonday)) : ''}
                    ${ligne('Tableau', U.escapeHtml(f.board || '—'))}
                    ${ligne('Groupe', U.escapeHtml(f.groupe || '—'))}
                    ${ligne('Étape', U.escapeHtml(f.etapeLabel || '—'))}
                    ${f.boardOperationnel ? ligne('Encore présente sur', U.escapeHtml(f.boardOperationnel + (f.groupeOperationnel ? ' › ' + f.groupeOperationnel : ''))) : ''}
                    ${ligne("Groupe d'origine (payées)", U.escapeHtml(f.groupeOrigine || '—'))}
                    ${ligne('Propriétaire', U.escapeHtml(f.proprietaire || '—'))}
                    ${ligne('Statut Monday', U.escapeHtml(f.statut || '—'))}
                    ${f.qualifRecouvrement ? ligne('Qualification recouvrement', U.escapeHtml(f.qualifRecouvrement)) : ''}
                    ${f.presenceTableaux && f.presenceTableaux.length > 1 ? ligne('Présente sur', U.escapeHtml(f.presenceTableaux.join(' · '))) : ''}
                </div>
                <div class="fiche-note">
                    <strong>Règle appliquée — ${U.escapeHtml(R.getRule(f.financement, state.rules).label)}</strong>
                    <p>${U.escapeHtml(R.getRule(f.financement, state.rules).note || '')}</p>
                    <p>${U.escapeHtml(explication)}</p>
                </div>
            </div>`, [{ label: 'Fermer', primary: true }]);

        // Le financement se corrige ici pour une facture isolée ; la sélection
        // multiple du tableau sert quand il y en a des centaines.
        const selFin = $('#fiche-financement');
        if (selFin) selFin.addEventListener('change', async () => {
            const cle = f.cleManuelle;
            if (!cle) { U.toast('Cette facture n\'a pas de numéro : la correction ne peut pas être retenue.', 'error'); return; }
            if (selFin.value) state.financementsManuels[cle] = selFin.value;
            else delete state.financementsManuels[cle];
            await S.set(S.KEYS.finManuels, state.financementsManuels);
            recalculer({ conserverPeriode: true });
            rendreTout();
            U.closeModal();
            U.toast(selFin.value
                ? `Facture ${f.numero || ''} passée en « ${R.getRule(selFin.value, state.rules).label} ».`
                : `Facture ${f.numero || ''} rendue au calcul automatique.`, 'success');
        });
    }

    // ══════════════════════════════════════════════
    //  Onglet : Qualifications métier
    // ══════════════════════════════════════════════




    /** Filtre sur une valeur de qualification, via la recherche plein texte. */
    function filtrerParQualification(nom, valeur) {
        state.filtres.qualif = { nom, valeur };
        state.ui.page = 1;
        ouvrirOnglet('factures');
    }

    // ══════════════════════════════════════════════
    //  Onglet : Prélèvements (GoCardless)
    // ══════════════════════════════════════════════

    /** Recalcule les apprenants à partir des exports chargés. */
    function recalculerPrelevements() {
        const g = state.gcl;
        if (!g.paiements.length) { state.apprenants = []; state.gclOrphelins = 0; return; }

        if (!g.unite) g.unite = PR.detecterUniteMontant(g.paiements);
        PR.appliquerUnite(g.paiements, g.unite.unite);

        const r = PR.construireApprenants(g);
        state.apprenants = r.apprenants;
        state.gclOrphelins = r.orphelins;
    }

    function rendrePrelevements() {
        const charge = state.apprenants.length > 0;
        $('#prlv-vide').hidden = charge;
        $('#prlv-contenu').hidden = !charge;
        if (!charge) { $('#prlv-badge').textContent = ''; return; }

        const st = PR.statistiques(state.apprenants, state.gcl.paiements);
        $('#prlv-badge').textContent =
            `${U.nombre(st.nbApprenants)} apprenants · ${U.nombre(st.nbPrelevements)} prélèvements`;

        rendreKpiPrelevements(st);
        rendreNotesPrelevements(st);
        rendreChartSurvie();
        rendreChartRang();
        rendreChartEchecsMois();
        rendreTableApprenants();
        rendreQualitePrelevements();
    }

    function rendreKpiPrelevements(st) {
        const tuile = (o) => `
            <div class="recup-card">
                <span class="recup-bar" style="background:${o.couleur}"></span>
                <span class="recup-taux">${o.valeur}</span>
                <span class="recup-label">${U.escapeHtml(o.label)}</span>
                <span class="recup-value">${o.detail}</span>
                <span class="recup-sub">${U.escapeHtml(o.sub)}</span>
            </div>`;

        $('#prlv-kpi').innerHTML = [
            tuile({
                couleur: U.couleurs.paye,
                valeur: U.pourcent(st.partSansIncident, 0),
                label: 'Abonnements sans incident',
                detail: `${U.nombre(st.nbSansIncident)} sur ${U.nombre(st.nbApprenants)} apprenants`,
                sub: 'aucun prélèvement rejeté',
            }),
            tuile({
                couleur: U.couleurs.retard,
                valeur: U.jours(st.delaiMedianPremierEchec),
                label: 'Avant le premier incident',
                detail: `moyenne ${U.jours(st.delaiMoyenPremierEchec)}`,
                sub: st.rangMedianPremierEchec
                    ? `soit le ${Math.round(st.rangMedianPremierEchec)}ᵉ prélèvement en médiane`
                    : 'délai médian depuis le premier prélèvement',
            }),
            tuile({
                couleur: U.couleurs.payeRetard,
                valeur: U.pourcent(st.tauxEchecPrelevements, 1),
                label: 'Taux de rejet',
                detail: `${U.nombre(st.nbEchecsPrelevements)} rejets sur ${U.nombre(st.nbPresentes)} présentés`,
                sub: `${U.euros(st.montantEchoue)} rejetés`,
            }),
            tuile({
                couleur: U.couleurs.indigo,
                valeur: U.pourcent(st.partRattrapes, 0),
                label: 'Incidents rattrapés',
                detail: `${U.nombre(st.nbRattrapes)} sur ${U.nombre(st.nbAvecIncident)} apprenants touchés`,
                sub: 'repartis sans rejet sur leurs 3 derniers prélèvements',
            }),
            tuile({
                couleur: '#f97316',
                valeur: U.eurosCourt(st.montantARisque),
                label: 'Montant à risque',
                detail: `${U.nombre(st.nbEnDifficulte)} apprenants en difficulté`,
                sub: 'rejets non rattrapés et prélèvements en cours',
            }),
        ].join('');
    }

    function rendreNotesPrelevements(st) {
        const el = $('#prlv-notes');
        const notes = [];
        const u = state.gcl.unite;

        if (u && !u.sur) notes.push({
            ton: 'warn',
            titre: 'Montants interprétés en centimes',
            texte: `Les montants sont tous entiers et la médiane atteint ${U.nombre(u.mediane)} : ils ont été divisés par 100. `
                + `Si c'était une erreur, les chiffres en euros sont cent fois trop petits.`,
        });

        if (!state.gcl.clients.length) notes.push({
            ton: 'danger',
            titre: "Export Customers absent",
            texte: "Les apprenants sont regroupés sur l'identifiant GoCardless, sans e-mail ni nom : "
                + "une même personne inscrite deux fois compte double.",
        });

        if (!state.gcl.abonnements.length) notes.push({
            ton: 'info',
            titre: "Export Subscriptions absent",
            texte: "Les abonnements sont déduits des prélèvements. Le nombre d'échéances prévues et "
                + "les dates de début officielles manquent.",
        });

        if (!notes.length) { el.innerHTML = ''; el.classList.add('hidden'); return; }
        el.classList.remove('hidden');
        el.innerHTML = notes.map(n => `
            <div class="note note-${n.ton}">
                <div class="note-body"><strong>${U.escapeHtml(n.titre)}</strong><span>${U.escapeHtml(n.texte)}</span></div>
            </div>`).join('');
    }

    function rendreChartSurvie() {
        const points = PR.survie(state.apprenants, 24);
        U.chart('chart-survie', {
            type: 'line',
            data: {
                labels: points.map(p => 'M+' + p.mois),
                datasets: [{
                    label: 'Apprenants sans aucun incident',
                    data: points.map(p => p.survie),
                    borderColor: U.couleurs.paye,
                    backgroundColor: 'rgba(132, 204, 22, 0.12)',
                    borderWidth: 2.5, tension: 0.25, fill: true,
                    pointRadius: 2, pointHoverRadius: 5,
                }],
            },
            options: {
                interaction: { mode: 'index', intersect: false },
                scales: {
                    x: { grid: { display: false }, title: { display: true, text: 'Mois depuis le premier prélèvement' } },
                    y: { grid: U.grille, min: 0, max: 100, ticks: { callback: v => v + ' %' } },
                },
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        callbacks: {
                            label: ctx => `${U.pourcent(ctx.parsed.y)} sans incident`,
                            afterBody: items => {
                                const p = points[items[0].dataIndex];
                                return p ? ['', `${U.nombre(p.aRisque)} apprenants encore observés`,
                                    p.evenements ? `${U.nombre(p.evenements)} premiers rejets ce mois-là` : 'aucun nouveau rejet'] : '';
                            },
                        },
                    },
                },
            },
        });
    }

    function rendreChartRang() {
        const eur = state.ui.rangUnite === 'euros';
        const rows = PR.distributionRang(state.apprenants, 12);
        U.chart('chart-rang', {
            type: 'bar',
            data: {
                labels: rows.map(r => r.rang),
                datasets: [{
                    data: rows.map(r => eur ? r.euros : r.nb),
                    backgroundColor: rows.map((_, i) => i < 3 ? U.couleurs.retard : U.couleurs.payeRetard),
                    borderRadius: 3,
                }],
            },
            options: {
                scales: {
                    x: { grid: { display: false }, title: { display: true, text: 'Rang du prélèvement rejeté' } },
                    y: { grid: U.grille, ticks: { callback: v => eur ? U.eurosCourt(v) : U.nombre(v) } },
                },
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        callbacks: {
                            label: ctx => {
                                const r = rows[ctx.dataIndex];
                                return eur ? U.euros(r.euros) : `${U.nombre(r.nb)} apprenants`;
                            },
                        },
                    },
                },
            },
        });
    }


    function rendreChartEchecsMois() {
        const rows = PR.echecsParMois(state.gcl.paiements);
        if (!rows.length) { U.chart('chart-echecs-mois', videConfig('Aucun prélèvement daté')); return; }
        U.chart('chart-echecs-mois', {
            type: 'bar',
            data: {
                labels: rows.map(r => U.moisLabel(r.mois, true)),
                datasets: [
                    {
                        label: 'Encaissés', order: 2, stack: 'a',
                        data: rows.map(r => r.nb - r.nbEchecs),
                        backgroundColor: U.couleurs.paye, borderRadius: 3,
                    },
                    {
                        label: 'Rejetés', order: 2, stack: 'a',
                        data: rows.map(r => r.nbEchecs),
                        backgroundColor: U.couleurs.retard, borderRadius: 3,
                    },
                    {
                        type: 'line', label: 'Taux de rejet', yAxisID: 'y1', order: 0,
                        data: rows.map(r => r.taux),
                        borderColor: U.couleurs.accent, borderWidth: 2.5,
                        tension: 0.3, pointRadius: 2, pointHoverRadius: 5,
                    },
                ],
            },
            options: {
                interaction: { mode: 'index', intersect: false },
                scales: {
                    x: { stacked: true, grid: { display: false } },
                    y: { stacked: true, grid: U.grille, ticks: { callback: v => U.nombre(v) } },
                    y1: { position: 'right', min: 0, grid: { display: false }, ticks: { callback: v => v + ' %' } },
                },
                plugins: {
                    tooltip: {
                        callbacks: {
                            label: ctx => ctx.dataset.yAxisID === 'y1'
                                ? `Taux de rejet : ${U.pourcent(ctx.parsed.y)}`
                                : `${ctx.dataset.label} : ${U.nombre(ctx.parsed.y)}`,
                            afterBody: items => {
                                const r = rows[items[0].dataIndex];
                                return r ? ['', `${U.euros(r.eurEchecs)} rejetés sur ${U.euros(r.euros)} présentés`] : '';
                            },
                        },
                    },
                },
            },
        });
    }

    function rendreTableApprenants() {
        const q = R.norm(state.ui.prlvRecherche);
        let rows = state.apprenants.filter(a => {
            if (state.ui.prlvEtat && a.etat !== state.ui.prlvEtat) return false;
            if (q && !R.norm(a.nom + ' ' + a.email).includes(q)) return false;
            return true;
        });

        const t = state.ui.triPrlv;
        rows = rows.slice().sort((a, b) => {
            const va = a[t.key], vb = b[t.key];
            const cmp = (typeof va === 'string' || typeof vb === 'string')
                ? String(va || '').localeCompare(String(vb || ''), 'fr')
                : ((va == null ? -Infinity : va) - (vb == null ? -Infinity : vb));
            return t.sens === 'asc' ? cmp : -cmp;
        }).slice(0, 300);

        const classeEtat = e => e === 'Sans incident' ? 'st-paye'
            : e === 'Incident rattrapé' ? 'st-paye-retard'
            : e === 'En difficulté' ? 'st-retard' : 'st-inconnu';

        const el = $('#prlv-table');
        el.innerHTML = U.table([
            { key: 'nom', label: 'Apprenant', format: (v, r) => `<span class="cell-clip cell-clip-lg" title="${U.escapeHtml(r.email || v)}">${U.escapeHtml(v)}</span>${r.identifieParNom ? ' <span class="pill pill-muted" title="Sans e-mail : identifié par son nom">?</span>' : ''}` },
            { key: 'etat', label: 'État', format: v => `<span class="pill ${classeEtat(v)}">${U.escapeHtml(v)}</span>` },
            { key: 'nbPresentes', label: 'Prélèvements', align: 'right', format: U.nombre },
            { key: 'nbEchecs', label: 'Rejets', align: 'right', format: (v) => v ? `<span class="cell-danger">${U.nombre(v)}</span>` : '—' },
            { key: 'tauxEchec', label: '% rejet', align: 'right', format: v => U.pourcent(v, 0) },
            { key: 'rangPremierEchec', label: '1er rejet au n°', align: 'right', format: v => v == null ? '—' : U.nombre(v) },
            { key: 'delaiPremierEchec', label: 'Après', align: 'right', format: v => v == null ? '—' : U.jours(v) },
            { key: 'montantEncaisse', label: 'Encaissé', align: 'right', format: v => U.euros(v) },
            { key: 'montantEchoue', label: 'Rejeté', align: 'right', format: v => v ? `<span class="cell-danger">${U.euros(v)}</span>` : '—' },
            { key: 'datePremier', label: 'Depuis', align: 'center', format: U.dateFR },
        ], rows, {
            vide: 'Aucun apprenant pour ce filtre.',
            tri: t, onSort: true, onRowClick: true,
        });
        U.bindTable(el, rows, {
            onSort: k => { t.sens = (t.key === k && t.sens === 'desc') ? 'asc' : 'desc'; t.key = k; rendrePrelevements(); },
            onRowClick: ouvrirFicheApprenant,
        });
    }

    /** Échéancier complet d'un apprenant, prélèvement par prélèvement. */
    function ouvrirFicheApprenant(a) {
        const lignes = a.echeancier.map(p => `
            <tr>
                <td>${U.dateFR(p.dateEcheance)}</td>
                <td class="ta-r">${U.euros(p.montant, true)}</td>
                <td><span class="pill ${p.statut === 'succes' ? 'st-paye' : p.statut === 'echec' ? 'st-retard' : 'st-non-echue'}">${U.escapeHtml(PR.LIBELLE_STATUT[p.statut])}</span></td>
                <td class="cell-note">${U.escapeHtml(p.motifEchec || '')}</td>
            </tr>`).join('');

        U.modal(a.nom + (a.email ? ` — ${a.email}` : ''), `
            <div class="fiche">
                <div class="fiche-head">
                    <span class="pill ${a.etat === 'Sans incident' ? 'st-paye' : a.etat === 'En difficulté' ? 'st-retard' : 'st-paye-retard'}">${U.escapeHtml(a.etat)}</span>
                    <span class="pill pill-muted">${U.nombre(a.nbPresentes)} prélèvements présentés</span>
                    ${a.nbEchecs ? `<span class="pill pill-danger">${U.nombre(a.nbEchecs)} rejets</span>` : ''}
                </div>
                <div class="fiche-grid">
                    <div class="fiche-row"><span>Encaissé</span><strong>${U.euros(a.montantEncaisse, true)}</strong></div>
                    <div class="fiche-row"><span>Rejeté</span><strong>${U.euros(a.montantEchoue, true)}</strong></div>
                    <div class="fiche-row"><span>Premier prélèvement</span><strong>${U.dateFR(a.datePremier)}</strong></div>
                    <div class="fiche-row"><span>Dernier prélèvement</span><strong>${U.dateFR(a.dateDernier)}</strong></div>
                    ${a.datePremierEchec ? `<div class="fiche-row"><span>Premier rejet</span><strong>${U.dateFR(a.datePremierEchec)} — ${U.nombre(a.rangPremierEchec)}ᵉ prélèvement</strong></div>` : ''}
                    ${a.delaiPremierEchec != null ? `<div class="fiche-row"><span>Délai avant le premier rejet</span><strong>${U.jours(a.delaiPremierEchec)}</strong></div>` : ''}
                    ${a.motifs.length ? `<div class="fiche-row"><span>Motifs</span><strong>${U.escapeHtml(a.motifs.join(', '))}</strong></div>` : ''}
                </div>
                <h4 class="fiche-soustitre">Échéancier</h4>
                <table class="data-table"><thead><tr><th>Échéance</th><th class="ta-r">Montant</th><th>Statut</th><th>Motif</th></tr></thead>
                <tbody>${lignes}</tbody></table>
            </div>`, [{ label: 'Fermer', primary: true }]);
    }

    function rendreQualitePrelevements() {
        const anomalies = PR.qualite(state.apprenants, state.gclOrphelins,
            !!(state.gcl.clients && state.gcl.clients.length));
        const el = $('#prlv-qualite');
        if (!anomalies.length) {
            el.innerHTML = '<div class="note note-ok"><div class="note-body"><strong>Rien à signaler</strong>'
                + '<span>Chaque prélèvement est rattaché à un apprenant identifié par son e-mail.</span></div></div>';
            return;
        }
        el.innerHTML = anomalies.map(a => `
            <div class="quality-item quality-${a.gravite}">
                <div class="quality-head">
                    <span class="quality-dot"></span>
                    <div class="quality-title"><strong>${U.escapeHtml(a.titre)}</strong><span>${U.nombre(a.nb)}</span></div>
                </div>
                <p class="quality-advice">${U.escapeHtml(a.conseil)}</p>
            </div>`).join('');
    }

    // ══════════════════════════════════════════════
    //  Onglet : Data Quality
    // ══════════════════════════════════════════════

    /**
     * Anomalies de récupération, distinctes des anomalies de contenu : elles
     * portent sur ce qui n'est pas arrivé jusqu'à l'application. Une facture
     * absente ne se voit nulle part ailleurs — c'est précisément le danger.
     */
    function anomaliesImport() {
        const out = [];
        const monday = state.boards.filter(b => !String(b.id).startsWith('file:'));

        // Tableaux dont le chargement a échoué
        const enEchec = monday.filter(b => b.actif && b.erreurChargement);
        if (enEchec.length) out.push({
            code: 'IMPORT_ECHEC', unite: 'tableau', gravite: 'haute',
            titre: 'Tableaux dont le chargement a échoué',
            nb: enEchec.length, euros: 0,
            conseil: "Aucune facture de ces tableaux n'est présente dans les indicateurs. "
                + 'Relancez « Charger les tableaux cochés » dans l\'onglet Données.',
            detail: enEchec.map(b => `${b.name} — ${b.erreurChargement}`),
        });

        // Écart entre ce que Monday annonce et ce qui est arrivé
        const partiels = monday
            .filter(b => b.actif && !b.erreurChargement && b.itemsCount != null
                && b.charge != null && b.charge < b.itemsCount)
            .map(b => ({ nom: b.name, manquantes: b.itemsCount - b.charge, attendues: b.itemsCount }));
        if (partiels.length) out.push({
            code: 'IMPORT_PARTIEL', gravite: 'haute',
            titre: "Factures annoncées par Monday mais non importées",
            nb: partiels.reduce((n, p) => n + p.manquantes, 0), euros: 0,
            conseil: 'Chargement incomplet : relancez le chargement. Si l\'écart persiste, '
                + 'il peut s\'agir d\'éléments supprimés ou de sous-éléments non repris.',
            detail: partiels.map(p => `${p.nom} — ${U.nombre(p.manquantes)} manquantes sur ${U.nombre(p.attendues)}`),
        });

        // Champs essentiels vides ou non reconnus, tableau par tableau.
        //
        // C'est la cause la plus fréquente de chiffres à zéro : la colonne
        // existe dans Monday, elle est renseignée, mais l'application ne l'a pas
        // reconnue sous ce nom. Sans ce contrôle, l'erreur ne se voit qu'à
        // l'arrivée, sous la forme d'un financement entier à 0 € ou de factures
        // sans échéance calculable.
        const ESSENTIELS = [
            { champ: 'montant', nom: 'Montant', effet: 'ces factures pèsent 0 € dans tous les montants' },
            { champ: 'dateFacture', nom: 'Date de facture', effet: "l'échéance ne peut pas être calculée" },
            { champ: 'dateFinFormation', nom: 'Fin de formation', effet: "l'échéance ne peut pas être calculée" },
        ];
        const trous = [];
        for (const b of monday) {
            if (!b.actif || b.role === 'ignore' || b.role === 'technique' || !b.charge) continue;
            for (const e of ESSENTIELS) {
                const c = (b.couverture || {})[e.champ];
                if (!c) continue;                       // tableau chargé avant cette mesure
                if (!c.colId) trous.push({ b, e, txt: 'aucune colonne reconnue', nb: b.charge });
                else if (c.taux < 50) trous.push({ b, e, txt: `renseignée sur ${Math.round(c.taux)} % des lignes`, nb: b.charge });
            }
        }
        if (trous.length) out.push({
            code: 'CHAMP_ESSENTIEL', unite: 'tableau', gravite: 'haute',
            titre: 'Colonnes essentielles non reconnues',
            nb: trous.length, euros: 0,
            conseil: 'La colonne existe peut-être dans Monday sous un autre nom. '
                + 'Ouvrez « Correspondance des colonnes » dans l\'onglet Données, choisissez le tableau '
                + 'concerné et associez la bonne colonne, puis rechargez ce tableau.',
            detail: trous.map(t => `${t.b.name} — ${t.e.nom} : ${t.txt} (${t.e.effet})`),
        });

        // Tableaux cochés mais jamais chargés
        const jamais = monday.filter(b => b.actif && b.role !== 'ignore' && b.charge == null);
        if (jamais.length) out.push({
            code: 'IMPORT_JAMAIS', unite: 'tableau', gravite: 'moyenne',
            titre: 'Tableaux cochés mais jamais chargés',
            nb: jamais.length, euros: 0,
            conseil: 'Cliquez sur « Charger les tableaux cochés » dans l\'onglet Données.',
            detail: jamais.map(b => b.name),
        });

        // Lignes importées mais vides de toute information exploitable
        const creuses = state.factures.filter(f =>
            f.montant == null && !f.dateFacture && !f.dateFinFormation
            && !f.dateEcheanceSource && !f.cle);
        if (creuses.length) out.push({
            code: 'LIGNE_CREUSE', gravite: 'moyenne',
            titre: 'Lignes importées sans aucune donnée exploitable',
            nb: creuses.length, euros: 0, items: creuses,
            conseil: 'Ni numéro, ni montant, ni date : ces lignes gonflent les compteurs sans rien '
                + 'apporter. Souvent des lignes de séparation ou des brouillons dans Monday.',
        });

        // Répartition des motifs de règlement. Quand tout le portefeuille bascule
        // en « payée », un motif écrase les autres et désigne la colonne fautive.
        const payees = state.factures.filter(f => f.paye);
        if (payees.length) {
            const parMotif = new Map();
            for (const f of payees) parMotif.set(f.motifPaye || 'Motif inconnu',
                (parMotif.get(f.motifPaye || 'Motif inconnu') || 0) + 1);
            const lignes = [...parMotif.entries()].sort((a, b) => b[1] - a[1]);
            const part = payees.length / Math.max(1, state.factures.length);

            out.push({
                code: 'MOTIF_PAYE',
                gravite: part > 0.95 ? 'haute' : 'basse',
                unite: 'facture',
                titre: part > 0.95
                    ? `Quasiment tout le portefeuille est considéré comme réglé (${U.pourcent(part * 100, 0)})`
                    : 'Pourquoi les factures sont considérées comme réglées',
                nb: payees.length, euros: 0,
                conseil: part > 0.95
                    ? "Un tel taux est rarement réel. Le motif majoritaire ci-dessus désigne la colonne "
                      + "en cause : si c'est « Date de contrôle paiement » ou « Statut Monday », vérifiez "
                      + "dans l'onglet Données que cette colonne est bien celle que vous croyez."
                    : "Récapitulatif des critères ayant conclu au règlement, du plus fréquent au moins fréquent.",
                detail: lignes.map(([m, n]) => `${m} — ${U.nombre(n)} factures`),
            });
        }

        return out;
    }

    function rendreQualite(data) {
        const anomalies = [...anomaliesImport(), ...X.qualite(data)];
        const score = X.scoreQualite(data, anomalies.filter(a => a.items));
        const couleur = score >= 85 ? 'var(--green)' : score >= 65 ? 'var(--amber)' : 'var(--red)';

        $('#quality-score').innerHTML = `
            <div class="score-ring" style="--score:${score};--score-color:${couleur}">
                <span class="score-value">${score}</span>
                <span class="score-label">/ 100</span>
            </div>
            <div class="score-text">
                <h3>Fiabilité des indicateurs</h3>
                <p>${U.nombre(data.length)} factures analysées · ${anomalies.length} type${anomalies.length > 1 ? 's' : ''} d'anomalie détecté${anomalies.length > 1 ? 's' : ''}.</p>
                <p class="fv-hint">Chaque anomalie renvoie vers les factures concernées. Corriger dans Monday puis actualiser.</p>
            </div>`;

        const el = $('#quality-list');
        if (!anomalies.length) {
            el.innerHTML = '<div class="note note-ok"><div class="note-body"><strong>Aucune anomalie détectée</strong><span>Les dates, montants et types de financement sont exploitables sur l\'ensemble du périmètre.</span></div></div>';
            return;
        }

        el.innerHTML = anomalies.map((a, i) => `
            <div class="quality-item quality-${a.gravite}">
                <div class="quality-head">
                    <span class="quality-dot"></span>
                    <div class="quality-title">
                        <strong>${U.escapeHtml(a.titre)}</strong>
                        <span>${U.nombre(a.nb)} ${a.unite || 'facture'}${a.nb > 1 ? 's' : ''}${a.euros ? ' · ' + U.euros(a.euros) : ''}</span>
                    </div>
                    ${a.items ? `<button class="btn btn-ghost btn-sm" data-q="${i}">Voir les factures</button>` : ''}
                </div>
                ${a.detail ? `<ul class="quality-detail">${a.detail.map(d => `<li>${U.escapeHtml(d)}</li>`).join('')}</ul>` : ''}
                <p class="quality-advice">${U.escapeHtml(a.conseil)}</p>
            </div>`).join('');

        $$('[data-q]', el).forEach(b => b.addEventListener('click', () => {
            const a = anomalies[+b.dataset.q];
            if (!a.items) return;
            const rows = a.items.slice(0, 300);
            U.modal(a.titre + ` — ${U.nombre(a.nb)} factures`, U.table([
                { key: 'numero', label: 'Facture' },
                { key: 'client', label: 'Client' },
                { key: 'board', label: 'Tableau' },
                { key: 'montant', label: 'Montant', align: 'right', format: v => U.euros(v) },
                { key: 'dateFacture', label: 'Date facture', align: 'center', format: U.dateFR },
                { key: 'dateEcheance', label: 'Échéance', align: 'center', format: U.dateFR },
                { key: 'etat', label: 'État', format: v => `<span class="pill ${U.etatClass(v)}">${U.escapeHtml(v)}</span>` },
            ], rows, { vide: '—' })
            + (a.nb > 300 ? `<p class="fv-hint">Affichage limité aux 300 premières lignes sur ${U.nombre(a.nb)}.</p>` : ''),
            [
                { label: 'Exporter cette liste', onClick: () => exporterListe(a.items, a.titre) },
                { label: 'Fermer', primary: true },
            ]);
        }));
    }

    // ══════════════════════════════════════════════
    //  Onglet : Données
    // ══════════════════════════════════════════════

    async function rendreDonnees() {
        rendreChaineTraitement();
        rendreExclusions();
        rendreTableBoards();
        rendreSelectMapping();
        rendreTableMapping();
        rendreHistoriqueImports();
        rendreInfoStockage();

        const st = $('#settings-monday-status');
        if (state.compte) {
            st.className = 'connect-status ok';
            st.textContent = `Connecté : ${state.compte.name} — compte ${state.compte.account ? state.compte.account.name : ''}`;
        }
    }

    /**
     * Chaîne de traitement, de la ligne Monday à la facture comptée.
     *
     * Le total affiché sur le tableau de bord est inférieur au nombre de lignes
     * de Monday, pour deux raisons légitimes — les groupes de service écartés et
     * les doublons fusionnés. Sans ce détail, l'écart passe pour une perte de
     * données.
     */
    function rendreChaineTraitement() {
        const el = $('#chaine-traitement');
        if (!el) return;

        const ignorees = state.nbLignesIgnorees || 0;
        const brutes = state.brutes.length;
        const consolidees = state.factures.length;
        const fusionnees = Math.max(0, brutes - ignorees - consolidees);
        const ecartees = state.factures.filter(f => f.role === 'technique' || f.groupeTechnique).length;
        const analysees = consolidees - ecartees;

        // Les doublons attendus — tableau des factures payées, groupes
        // d'archive — se distinguent de ceux entre tableaux opérationnels, qui
        // signalent une facture à ranger dans Monday. Le total reste le même,
        // la lecture change : seule la seconde ligne appelle une correction.
        const dblOp = X.sum(state.factures, f => f.doublonsRetiresOp || 0);
        const dblPay = X.sum(state.factures, f => f.doublonsRetiresPayees || 0);
        const dblAttendus = Math.max(0, fusionnees - dblOp - dblPay);
        const nbFacturesDblOp = state.factures.filter(f => f.doublonOperationnel).length;
        const nbFacturesDblPay = state.factures.filter(f => f.doublonPayees).length;

        const ligne = (o) => `
            <div class="chaine-ligne${o.fort ? ' chaine-fort' : ''}${o.retrait ? ' chaine-retrait' : ''}${o.action ? ' chaine-cliquable' : ''}"${o.action ? ` data-chaine="${o.action}"` : ''}>
                <span class="chaine-signe">${o.signe || ''}</span>
                <span class="chaine-label">${U.escapeHtml(o.label)}</span>
                <span class="chaine-nb${o.danger ? ' cell-danger' : ''}">${U.nombre(o.nb)}</span>
                <span class="chaine-note">${U.escapeHtml(o.note || '')}</span>
            </div>`;

        el.innerHTML =
            ligne({ label: 'Lignes récupérées depuis Monday et des fichiers', nb: brutes, fort: true,
                    note: 'à comparer au nombre d\'éléments affiché dans Monday' })
            + ligne({ signe: '−', retrait: true, label: 'Doublons attendus', nb: dblAttendus, action: 'doublons',
                      note: 'tableau des factures payées et groupes de service : le circuit fonctionne ainsi' })
            + ligne({ signe: '−', retrait: true, label: 'Doublons entre tableaux opérationnels',
                      nb: dblOp, action: 'doublons-op', danger: dblOp > 0,
                      note: dblOp
                          ? `${U.nombre(nbFacturesDblOp)} factures présentes sur deux tableaux opérationnels à la fois — cliquez pour les voir`
                          : 'aucune facture présente sur deux tableaux opérationnels à la fois' })
            + ligne({ signe: '−', retrait: true, label: 'Doublons dans les factures payées',
                      nb: dblPay, action: 'doublons-payees', danger: dblPay > 0,
                      note: dblPay
                          ? `${U.nombre(nbFacturesDblPay)} factures saisies plusieurs fois dans « 0.1. ALL - Factures payées » — cliquez pour les voir`
                          : 'aucune facture saisie deux fois dans le tableau des factures payées' })
            + ligne({ signe: '−', retrait: true, label: 'Groupes et tableaux de service',
                      nb: ecartees + ignorees,
                      note: ignorees
                          ? `technique, archive, corbeille — dont ${U.nombre(ignorees)} lignes de tableaux de sous-éléments, qui ne sont pas des factures`
                          : 'technique, archive, corbeille' })
            + ligne({ signe: '=', label: 'Factures analysées', nb: analysees, fort: true,
                      note: 'ce que comptent les indicateurs, avant filtres de période et de source' });
    }

    /**
     * Détail des doublons fusionnés.
     *
     * Quand le total analysé est plus bas que le nombre de lignes de Monday, la
     * question est toujours la même : est-ce que ce sont de vrais doublons ? Le
     * chiffre seul ne permet pas d'en juger — il faut voir les numéros et les
     * tableaux d'où ils viennent, pour aller vérifier dans Monday.
     */
    const FAMILLES_DOUBLON = {
        attendus: {
            titre: 'Doublons attendus',
            garde: f => f.doublon && !f.doublonOperationnel && !f.doublonPayees,
            vide: "<p>Aucune facture n'apparaît sur plusieurs tableaux.</p>",
            colonnes: f => f.presenceTableaux || [],
            compte: f => (f.presenceTableaux || []).length,
            enTete: 'Vue sur',
        },
        op: {
            titre: 'Doublons entre tableaux opérationnels',
            garde: f => f.doublonOperationnel,
            vide: "<p>Aucune facture n'est présente sur deux tableaux opérationnels à la fois. "
                + 'Le circuit Tampon → ADV → Recouvrement déplace bien les factures au lieu de les dupliquer.</p>',
            colonnes: f => f.boardsOperationnels || [],
            compte: f => f.nbLignesOperationnelles || 0,
            enTete: 'Tableaux opérationnels',
        },
        payees: {
            titre: 'Doublons dans les factures payées',
            garde: f => f.doublonPayees,
            vide: "<p>Aucune facture n'est saisie deux fois dans « 0.1. ALL - Factures payées ».</p>",
            colonnes: f => f.groupesPayees || [],
            compte: f => f.nbLignesPayees || 0,
            enTete: 'Groupes du tableau des payées',
        },
    };

    function montrerDoublons(famille) {
        const fam = FAMILLES_DOUBLON[famille] || FAMILLES_DOUBLON.attendus;
        // Les trois listes s'excluent, comme les trois lignes de la chaîne.
        const doublons = state.factures.filter(fam.garde);
        if (!doublons.length) { U.modal(fam.titre, fam.vide); return; }

        const lignes = doublons.map(f => ({
            numero: f.numero || '—',
            client: f.client || '—',
            montant: f.montant,
            // Le nombre de lignes qui fait le doublon, propre à la famille :
            // deux lignes du même tableau n'apparaîtraient pas dans un décompte
            // de tableaux distincts.
            nb: fam.compte(f),
            tableaux: fam.colonnes(f).join(' + '),
        })).sort((a, b) => b.nb - a.nb || String(a.numero).localeCompare(String(b.numero)));

        const retirees = X.sum(lignes, l => l.nb - 1);

        const intros = {
            op: `Ces ${U.nombre(doublons.length)} factures portent le même numéro sur
                 <strong>deux tableaux opérationnels à la fois</strong>. Le circuit
                 Tampon → ADV → Recouvrement déplace une facture, il ne la duplique pas :
                 chacune de ces lignes est à ranger dans Monday, en supprimant l'exemplaire
                 resté sur le tableau qu'elle a quitté.`,
            payees: `Ces ${U.nombre(doublons.length)} factures sont saisies
                 <strong>plusieurs fois dans « 0.1. ALL - Factures payées »</strong>, le plus
                 souvent dans deux groupes différents. Une facture n'a qu'un règlement :
                 c'est un doublon de saisie, à supprimer dans Monday. Tant qu'il subsiste, le
                 nombre de factures réglées par groupe est surévalué, et l'origine retenue
                 pour la facture — le groupe d'où elle venait — est ambiguë.`,
            attendus: `Ces ${U.nombre(doublons.length)} factures portent le même numéro sur plusieurs
                 tableaux : elles sont comptées une seule fois, ce qui retire
                 ${U.nombre(retirees)} lignes du total. C'est le fonctionnement attendu —
                 une facture présente à la fois sur son tableau opérationnel et sur
                 « 0.1. ALL - Factures payées », ou rangée dans un groupe d'archive.
                 Si un numéro ci-dessous désigne en réalité deux factures différentes,
                 dites-le : la règle de rapprochement doit alors être revue.`,
        };
        const suffixe = famille === 'attendus' ? ''
            : " L'application n'en compte qu'une, les indicateurs ne sont donc pas faussés — mais Monday, lui, l'est.";

        U.modal(`${fam.titre} — ${U.nombre(doublons.length)} factures`,
            `<p class="fv-hint">${intros[famille] || intros.attendus}${suffixe}</p>
            <div class="table-scroll" style="max-height:52vh">` + U.table([
                { key: 'numero', label: 'Facture', format: v => `<span class="mono">${U.escapeHtml(v)}</span>` },
                { key: 'client', label: 'Client', format: v => `<span class="cell-clip" title="${U.escapeHtml(v)}">${U.escapeHtml(v)}</span>` },
                { key: 'montant', label: 'Montant', align: 'right', format: v => v != null ? U.euros(v) : '—' },
                { key: 'nb', label: 'Lignes', align: 'right', format: U.nombre },
                { key: 'tableaux', label: fam.enTete },
            ], lignes, { vide: '—' }) + '</div>');

    }

    /**
     * Détail de ce que l'exclusion écarte. Retirer plusieurs milliers de lignes
     * des indicateurs sans le dire serait aussi trompeur que de les compter.
     */
    function rendreExclusions() {
        const el = $('#exclusions-info');
        if (!el) return;

        const ecartees = state.factures.filter(f => f.role === 'technique' || f.groupeTechnique);
        if (!ecartees.length) {
            el.innerHTML = '<span class="fv-hint">Aucun groupe ni tableau de service détecté.</span>';
            return;
        }

        const parOrigine = new Map();
        for (const f of ecartees) {
            const cle = f.groupeTechnique ? `${f.board} › ${f.groupe}` : `${f.board} (tableau technique)`;
            parOrigine.set(cle, (parOrigine.get(cle) || 0) + 1);
        }
        const lignes = [...parOrigine.entries()].sort((a, b) => b[1] - a[1]);

        el.innerHTML = `
            <span class="fv-hint">${U.nombre(ecartees.length)} factures écartées des indicateurs :</span>
            <ul class="exclusions-liste">
                ${lignes.map(([nom, n]) =>
                    `<li><span>${U.escapeHtml(nom)}</span><strong>${U.nombre(n)}</strong></li>`).join('')}
            </ul>`;
    }

    function rendreTableBoards() {
        const el = $('#boards-table');
        if (!state.boards.length) {
            el.innerHTML = '<p class="fv-hint">Aucun tableau. Connectez-vous à Monday puis cliquez sur « Rafraîchir la liste », ou importez des exports de fichiers.</p>';
            return;
        }

        const roles = Object.keys(R.ROLE_LABELS);

        // Inventaire par tableau, calculé sur TOUTES les factures et non sur
        // la vue filtrée : c'est ce qui permet de comprendre où elles passent.
        const parBoard = new Map();
        for (const f of state.factures) {
            const k = f.board || '—';
            let d = parBoard.get(k);
            if (!d) { d = { retenues: 0, ecartees: 0, sansEcheance: 0, enRetard: 0, payees: 0, nonEchues: 0 }; parBoard.set(k, d); }
            if (f.role === 'technique' || f.groupeTechnique) { d.ecartees++; continue; }
            d.retenues++;
            if (f.etat === 'Échéance inconnue') d.sansEcheance++;
            else if (f.etat === 'En retard') d.enRetard++;
            else if (f.etat === 'Non échue') d.nonEchues++;
            else d.payees++;
        }

        const vide = { retenues: 0, ecartees: 0, sansEcheance: 0, enRetard: 0, payees: 0, nonEchues: 0 };
        const rows = state.boards.map(b => {
            const r = { ...b, ...(parBoard.get(b.name) || vide) };
            // Écart entre ce que Monday annonce et ce qui est arrivé : c'est la
            // seule perte réelle. Les doublons fusionnés et les groupes de
            // service, eux, sont des retraits voulus.
            r.manquantes = (b.itemsCount != null && b.charge != null)
                ? Math.max(0, b.itemsCount - b.charge) : null;
            return r;
        });
        el.innerHTML = U.table([
            {
                key: 'actif', label: '', align: 'center', width: '40px', sortable: false,
                format: (v, r) => `<input type="checkbox" class="board-actif" data-id="${U.escapeHtml(r.id)}" ${v ? 'checked' : ''}>`,
            },
            { key: 'name', label: 'Tableau' },
            {
                key: 'role', label: 'Rôle', sortable: false,
                format: (v, r) => `<select class="input input-sm board-role" data-id="${U.escapeHtml(r.id)}">`
                    + roles.map(k => `<option value="${k}"${k === v ? ' selected' : ''}>${U.escapeHtml(R.ROLE_LABELS[k])}</option>`).join('')
                    + '</select>',
            },
            { key: 'itemsCount', label: 'Sur Monday', align: 'right', format: v => v == null ? '—' : U.nombre(v),
              title: "Nombre d'éléments annoncé par Monday" },
            { key: 'charge', label: 'Chargées', align: 'right', format: v => v == null ? '—' : U.nombre(v),
              title: 'Factures effectivement récupérées' },
            { key: 'manquantes', label: 'Manquantes', align: 'right',
              title: "Annoncées par Monday mais jamais récupérées — la seule perte réelle",
              format: v => v == null ? '—' : (v ? `<span class="cell-danger">${U.nombre(v)}</span>` : '0') },
            { key: 'ecartees', label: 'Écartées', align: 'right', format: v => v ? U.nombre(v) : '—',
              title: 'Groupes de service : archives, technique, corbeille' },
            { key: 'retenues', label: 'Analysées', align: 'right', format: v => `<strong>${U.nombre(v)}</strong>`,
              title: 'Factures qui entrent dans les indicateurs' },
            { key: 'sansEcheance', label: 'Sans échéance', align: 'right',
              title: "Échéance non calculable : ces factures sortent de tous les taux. Cliquez pour savoir pourquoi.",
              format: (v, r) => v
                  ? `<button class="lien-cellule cell-danger" data-sans-echeance="${U.escapeHtml(r.name)}">${U.nombre(v)}</button>`
                  : '—' },
            { key: 'enRetard', label: 'En retard', align: 'right', format: v => v ? U.nombre(v) : '—' },
            { key: 'nonEchues', label: 'Non échues', align: 'right', format: v => v ? U.nombre(v) : '—' },
            { key: 'payees', label: 'Payées', align: 'right', format: v => v ? U.nombre(v) : '—' },
        ], rows, { vide: '—', total: {
            name: 'Total',
            charge: U.nombre(X.sum(rows, r => r.charge || 0)),
            manquantes: U.nombre(X.sum(rows, r => r.manquantes || 0)),
            ecartees: U.nombre(X.sum(rows, r => r.ecartees)),
            retenues: U.nombre(X.sum(rows, r => r.retenues)),
            sansEcheance: U.nombre(X.sum(rows, r => r.sansEcheance)),
            enRetard: U.nombre(X.sum(rows, r => r.enRetard)),
            nonEchues: U.nombre(X.sum(rows, r => r.nonEchues)),
            payees: U.nombre(X.sum(rows, r => r.payees)),
        } });

        $$('.board-actif', el).forEach(c => c.addEventListener('change', () => {
            const b = state.boards.find(x => String(x.id) === c.dataset.id);
            if (b) { b.actif = c.checked; sauverBoards(); }
        }));
        $$('.board-role', el).forEach(s => s.addEventListener('change', () => {
            const b = state.boards.find(x => String(x.id) === s.dataset.id);
            if (!b) return;
            b.role = s.value;
            const meta = ROLE_META[b.role] || {};
            b.perimetre = meta.perimetre || 'Inconnu';
            b.source = meta.source || null;
            sauverBoards();
            rendreTableBoards();
        }));
    }

    const ROLE_META = {
        payees:       { perimetre: 'Tous',      source: 'payees' },
        tampon:       { perimetre: 'Corporate', source: 'adv' },
        adv:          { perimetre: 'Corporate', source: 'adv' },
        recouvrement: { perimetre: 'Corporate', source: 'recouvrement' },
        opco:         { perimetre: 'Corporate', source: 'opco' },
        b2c:          { perimetre: 'B2C',       source: 'b2c' },
        technique:    { perimetre: 'Tous',      source: 'technique' },
        ignore:       { perimetre: 'Inconnu',   source: null },
    };

    function rendreSelectMapping() {
        const sel = $('#mapping-board-select');
        const avecCols = state.boards.filter(b => b.columns && b.columns.length);
        sel.innerHTML = avecCols.length
            ? avecCols.map(b => `<option value="${U.escapeHtml(String(b.id))}">${U.escapeHtml(b.name)}</option>`).join('')
            : '<option value="">Aucun tableau chargé</option>';
        if (state.ui.mappingBoardId && avecCols.some(b => String(b.id) === state.ui.mappingBoardId)) {
            sel.value = state.ui.mappingBoardId;
        } else if (avecCols.length) {
            state.ui.mappingBoardId = String(avecCols[0].id);
            sel.value = state.ui.mappingBoardId;
        }
    }

    function rendreTableMapping() {
        const el = $('#mapping-table');
        const board = state.boards.find(b => String(b.id) === state.ui.mappingBoardId);
        if (!board || !board.columns) {
            el.innerHTML = '<p class="fv-hint">Chargez un tableau pour ajuster la correspondance de ses colonnes.</p>';
            return;
        }
        const mapping = board.mapping || {};

        // Les champs qui font tourner le calcul passent en tête : c'est là que
        // se joue un montant à zéro ou une échéance introuvable.
        const ESSENTIELS = ['numero', 'montant', 'dateFacture', 'dateFinFormation', 'dateDebutFormation', 'financement', 'typeClient'];
        const defs = I.FIELD_DEFS.slice().sort((a, b2) => {
            const ia = ESSENTIELS.indexOf(a.field), ib = ESSENTIELS.indexOf(b2.field);
            return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
        });

        const couv = board.couverture || {};

        // Les valeurs brutes conservées à l'import servent à juger des colonnes
        // candidates, sans repasser par Monday.
        const brutesBoard = state.brutes.filter(f => String(f.boardId) === String(board.id) && f.__brut);
        const valeursDe = colId => brutesBoard.slice(0, 300).map(f => f.__brut[colId] || '');

        const rows = defs.map(def => {
            const c = couv[def.field];
            const essentiel = ESSENTIELS.includes(def.field);
            const taux = mapping[def.field] ? (c ? c.taux : null) : null;
            // On ne propose que là où c'est utile : champ essentiel non pourvu,
            // ou pourvu par une colonne presque vide.
            const aBesoin = essentiel && brutesBoard.length
                && (!mapping[def.field] || (taux != null && taux < 50));
            return {
                field: def.field, label: def.label, essentiel,
                colId: mapping[def.field] || '',
                taux,
                candidats: aBesoin
                    ? I.colonnesCandidates(board.columns, mapping, valeursDe, def.field) : [],
                exemple: exempleValeur(board, mapping[def.field]),
            };
        });

        el.innerHTML = U.table([
            { key: 'label', label: 'Champ de l\'application',
              format: (v, r) => U.escapeHtml(v) + (r.essentiel ? ' <span class="pill pill-muted" title="Sert au calcul de l\'échéance ou des montants">essentiel</span>' : '') },
            {
                key: 'colId', label: 'Colonne Monday', sortable: false,
                format: (v, r) => `<select class="input input-sm map-sel" data-field="${r.field}">`
                    + '<option value="">— non utilisé —</option>'
                    + board.columns.map(c => `<option value="${U.escapeHtml(c.id)}"${c.id === v ? ' selected' : ''}>${U.escapeHtml(c.title)}${c.type ? ' (' + c.type + ')' : ''}</option>`).join('')
                    + '</select>',
            },
            // Quand un champ essentiel n'est pas pourvu, deviner un nom de plus
            // ne mène nulle part : on montre les colonnes dont les valeurs
            // conviendraient, et il suffit d'en désigner une.
            { key: 'candidats', label: 'Colonnes possibles', sortable: false,
              title: 'Colonnes de ce tableau dont les valeurs conviendraient à ce champ',
              format: (v, r) => (!v || !v.length) ? ''
                  : v.map(c => `<button class="candidat" data-champ="${r.field}" data-col="${U.escapeHtml(c.id)}"`
                      + ` title="${U.escapeHtml(c.title)} — ${U.pourcent(c.taux, 0)} rempli · ex. « ${U.escapeHtml(String(c.exemple).slice(0, 30))} »">`
                      + `${U.escapeHtml(c.title)}</button>`).join('') },
            // Une colonne bien nommée mais jamais renseignée produit exactement
            // les mêmes zéros qu'une colonne absente : le taux le dit.
            { key: 'taux', label: 'Renseignée', align: 'right',
              title: 'Part des lignes de ce tableau où la colonne porte une valeur',
              format: (v, r) => {
                  if (!r.colId) return r.essentiel
                      ? '<span class="cell-danger">aucune colonne</span>' : '<span class="ag-zero">—</span>';
                  if (v == null) return '<span class="ag-zero">à recharger</span>';
                  const txt = U.pourcent(v, 0);
                  return (v < 50 && r.essentiel) ? `<span class="cell-danger">${txt}</span>` : txt;
              } },
            { key: 'exemple', label: 'Exemple de valeur', cls: () => 'cell-note' },
        ], rows, { vide: '—' });

        $$('.candidat', el).forEach(b => b.addEventListener('click', () => {
            board.mapping = board.mapping || {};
            board.mapping[b.dataset.champ] = b.dataset.col;
            sauverBoards();
            rendreTableMapping();
            U.toast('Correspondance mise à jour — rechargez ce tableau pour l\'appliquer.', 'info', 7000);
        }));

        $$('.map-sel', el).forEach(s => s.addEventListener('change', () => {
            board.mapping = board.mapping || {};
            if (s.value) board.mapping[s.dataset.field] = s.value;
            else delete board.mapping[s.dataset.field];
            sauverBoards();
            U.toast('Correspondance mise à jour — rechargez le tableau pour l\'appliquer.', 'info');
        }));
    }

    /**
     * Détail des factures sans échéance d'un tableau, cause par cause.
     *
     * Le nombre seul n'indique pas quoi corriger : une colonne non reconnue,
     * une date vide, et une règle qui réclame une date de formation absente
     * produisent le même chiffre et appellent trois gestes différents.
     */
    function montrerSansEcheance(nomBoard) {
        const lot = state.factures.filter(f =>
            (f.board === nomBoard || f.boardOperationnel === nomBoard)
            && !f.dateEcheance && !(f.role === 'technique' || f.groupeTechnique));
        const causes = X.causesSansEcheance(lot);

        U.modal(`${U.escapeHtml(nomBoard)} — ${U.nombre(lot.length)} factures sans échéance`,
            `<p class="fv-hint">Ces factures ne peuvent être ni en retard ni non échues : elles sortent
             de tous les taux. Voici ce qui manque, du cas le plus fréquent au plus rare.</p>`
            + causes.map(c => `
                <div class="cause-bloc">
                    <div class="cause-titre">
                        <strong>${U.escapeHtml(c.cause)}</strong>
                        <span class="cause-nb">${U.nombre(c.nb)} factures · ${U.euros(c.euros)}</span>
                    </div>
                    <p class="fv-hint">${U.escapeHtml(c.conseil)}</p>
                    <div class="table-wrap">` + U.table([
                        { key: 'numero', label: 'Facture', format: v => `<span class="mono">${U.escapeHtml(v || '—')}</span>` },
                        { key: 'client', label: 'Client', format: v => `<span class="cell-clip" title="${U.escapeHtml(v)}">${U.escapeHtml(v)}</span>` },
                        { key: 'groupe', label: 'Groupe', format: v => `<span class="cell-clip" title="${U.escapeHtml(v)}">${U.escapeHtml(v || '—')}</span>` },
                        { key: 'montant', label: 'Montant', align: 'right', format: v => v != null ? U.euros(v) : '—' },
                    ], c.items.slice(0, 25), { vide: '—' })
                    + (c.items.length > 25 ? `<p class="fv-hint">… et ${U.nombre(c.items.length - 25)} autres</p>` : '')
                    + `</div>
                </div>`).join(''));
    }

    function exempleValeur(board, colId) {
        if (!colId) return '';
        const f = state.brutes.find(x => String(x.boardId) === String(board.id) && x.__brut && x.__brut[colId]);
        return f ? String(f.__brut[colId]).slice(0, 60) : '';
    }

    function rendreHistoriqueImports() {
        const el = $('#import-history');
        if (!state.imports.length && !state.grandLivre.length) {
            el.innerHTML = '<p class="fv-hint">Aucun import de fichier.</p>';
            return;
        }
        let h = '';
        if (state.grandLivre.length) {
            const st = state.glStats;
            const detail = st
                ? `${U.nombre(st.rapprochees)} factures rapprochées · ${U.nombre(st.completees)} dates complétées`
                  + (st.remplacees ? ` · ${U.nombre(st.remplacees)} dates remplacées` : '')
                : '';
            h += `<div class="import-row">
                <span class="pill pill-role">Grand livre lettré</span>
                <span>${U.nombre(state.grandLivre.length)} lignes</span>
                <span class="fv-hint">${U.escapeHtml(detail)}</span>
                <button class="btn btn-ghost btn-sm" id="btn-clear-gl">Retirer</button>
            </div>`;
        }
        h += state.imports.map(im => `<div class="import-row">
            <span class="pill pill-role">${U.escapeHtml(R.ROLE_LABELS[im.role] || im.role)}</span>
            <span>${U.escapeHtml(im.nom)}</span>
            <span class="fv-hint">${U.nombre(im.lignes)} lignes · ${U.escapeHtml(im.date)}</span>
        </div>`).join('');
        el.innerHTML = h;

        const btn = $('#btn-clear-gl');
        if (btn) btn.addEventListener('click', async () => {
            state.grandLivre = [];
            await S.set(S.KEYS.grandLivre, []);
            U.toast('Grand livre retiré.', 'info');
            recalculer({ conserverPeriode: true });
            rendreHistoriqueImports();
        });
    }

    async function rendreInfoStockage() {
        const u = await S.usage();
        const mo = v => (v / 1048576).toFixed(1).replace('.', ',') + ' Mo';
        $('#storage-info').innerHTML = `
            <div class="storage-line"><span>Version de l'application</span><strong>${VERSION} — ${VERSION_DATE}</strong></div>
            <div class="storage-line"><span>Factures enregistrées</span><strong>${U.nombre(state.brutes.length)}</strong></div>
            <div class="storage-line"><span>Tableaux configurés</span><strong>${U.nombre(state.boards.length)}</strong></div>
            <div class="storage-line"><span>Espace utilisé</span><strong>${u.quota ? mo(u.used) + ' / ' + mo(u.quota) : '—'}</strong></div>`;
    }

    // ══════════════════════════════════════════════
    //  Chargement depuis Monday
    // ══════════════════════════════════════════════

    function log(msg) {
        const el = $('#loader-log');
        if (!el) return;
        const p = document.createElement('div');
        p.textContent = msg;
        el.appendChild(p);
        el.scrollTop = el.scrollHeight;
        if (el.childElementCount > 200) el.removeChild(el.firstChild);
    }

    function statut(msg) { const el = $('#loader-status'); if (el) el.textContent = msg; }

    async function connecterMonday(token, silencieux) {
        if (!token) { U.toast('Renseignez un jeton API Monday.', 'error'); return false; }
        const cibles = [$('#monday-status'), $('#settings-monday-status')].filter(Boolean);
        cibles.forEach(c => { c.className = 'connect-status pending'; c.textContent = 'Connexion…'; });
        try {
            const me = await M.me(token);
            state.token = token;
            state.compte = me;
            if ($('#monday-remember').checked !== false) await sauverReglages();
            cibles.forEach(c => {
                c.className = 'connect-status ok';
                c.textContent = `Connecté : ${me.name}${me.account ? ' — ' + me.account.name : ''}`;
            });
            if (!silencieux) U.toast('Connexion Monday établie.', 'success');
            return true;
        } catch (e) {
            cibles.forEach(c => { c.className = 'connect-status error'; c.textContent = e.message; });
            U.toast(e.message, 'error', 9000);
            return false;
        }
    }

    async function chargerListeBoards() {
        if (!state.token) { U.toast('Connectez-vous à Monday d\'abord.', 'error'); return; }
        U.toast('Récupération de la liste des tableaux…', 'info');
        try {
            const boards = await M.listBoards(state.token);
            const existants = new Map(state.boards.map(b => [String(b.id), b]));
            state.boards = boards.map(b => {
                const prev = existants.get(String(b.id));
                const detect = R.detectBoardRole(b.name);
                return {
                    id: String(b.id),
                    name: b.name,
                    itemsCount: b.items_count,
                    workspace: b.workspace ? b.workspace.name : '',
                    role: prev ? prev.role : detect.role,
                    perimetre: prev ? prev.perimetre : detect.perimetre,
                    source: prev ? prev.source : detect.source,
                    financementDefaut: prev ? prev.financementDefaut : detect.financementDefaut,
                    actif: prev ? prev.actif : detect.role !== 'ignore' && detect.role !== 'technique',
                    columns: prev ? prev.columns : null,
                    mapping: prev ? prev.mapping : null,
                    charge: prev ? prev.charge : null,
                };
            });
            await sauverBoards();
            rendreTableBoards();
            rendreSelectMapping();
            const actifs = state.boards.filter(b => b.actif).length;
            U.toast(`${boards.length} tableaux trouvés — ${actifs} sélectionnés automatiquement.`, 'success');
        } catch (e) {
            U.toast(e.message, 'error', 9000);
        }
    }

    /**
     * @param {Object} [opts]
     * @param {boolean} [opts.silencieux] Actualisation de fond : l'écran de
     *   chargement n'est pas affiché et les données en place restent visibles
     *   jusqu'au remplacement. Les erreurs ne s'imposent pas non plus.
     */
    // ══════════════════════════════════════════════
    //  Veille de l'ordinateur
    //
    //  Un chargement complet depuis Monday dure plusieurs minutes. Si le poste
    //  se met en veille entre-temps, le navigateur est suspendu et le
    //  chargement s'interrompt au milieu — sans erreur visible, ce qui laisse
    //  des tableaux à moitié récupérés. Plutôt que de demander à l'utilisatrice
    //  de modifier les réglages d'alimentation de Windows, l'application
    //  demande elle-même à rester éveillée pendant qu'elle travaille, et rend
    //  la main dès qu'elle a fini.
    // ══════════════════════════════════════════════

    let verrouVeille = null;

    async function empecherVeille() {
        if (verrouVeille) return true;
        if (!('wakeLock' in navigator)) return false;
        try {
            verrouVeille = await navigator.wakeLock.request('screen');
            // Le verrou est perdu si l'onglet passe en arrière-plan ou si
            // l'écran s'éteint : on le reprend au retour, tant que le
            // chargement n'est pas terminé.
            verrouVeille.addEventListener('release', () => { verrouVeille = null; });
            return true;
        } catch (e) {
            // Navigateur trop ancien, page non sécurisée, ou refus système :
            // le chargement se poursuit, sans garantie contre la veille.
            console.warn('[Recouvrement] Veille non bloquée :', e.message);
            verrouVeille = null;
            return false;
        }
    }

    async function autoriserVeille() {
        if (!verrouVeille) return;
        try { await verrouVeille.release(); } catch (e) { /* déjà relâché */ }
        verrouVeille = null;
    }

    document.addEventListener('visibilitychange', () => {
        if (!document.hidden && state.chargementEnCours) empecherVeille();
    });

    async function chargerBoardsActifs(opts) {
        const silencieux = !!(opts && opts.silencieux);
        if (state.chargementEnCours) return;

        const actifs = state.boards.filter(b => b.actif && b.role !== 'ignore');
        if (!actifs.length) {
            if (!silencieux) U.toast('Cochez au moins un tableau à charger.', 'error');
            return;
        }
        if (!state.token) {
            if (!silencieux) U.toast('Connectez-vous à Monday d\'abord.', 'error');
            return;
        }

        state.chargementEnCours = true;
        majIndicateurActualisation();

        // Le poste doit rester éveillé le temps du chargement, sous peine
        // d'interrompre la pagination Monday au milieu.
        const veilleBloquee = await empecherVeille();
        if (!silencieux) {
            log(veilleBloquee
                ? 'ⓘ Mise en veille suspendue pendant le chargement.'
                : 'ⓘ La mise en veille ne peut pas être suspendue par l\'application — laissez l\'écran allumé.');
        }

        if (!silencieux) {
            montrerEcran('loading');
            $('#loader-log').innerHTML = '';
        }
        statut(`Chargement de ${actifs.length} tableaux`);

        // Les factures issues de fichiers sont conservées, celles de Monday remplacées
        const conserve = state.brutes.filter(f => String(f.boardId).startsWith('file:'));
        const collecte = [...conserve];
        const echecs = [];

        try {
            for (let i = 0; i < actifs.length; i++) {
                const b = actifs[i];
                statut(`(${i + 1}/${actifs.length}) ${b.name}`);
                log(`→ ${b.name}`);
                b.erreurChargement = null;

                // L'échec d'un tableau ne doit pas emporter les suivants :
                // mieux vaut un chargement partiel, signalé, qu'un écran vide.
                try {
                    if (!b.columns) {
                        const meta = await M.boardColumns(state.token, b.id);
                        b.columns = meta ? meta.columns : [];
                    }
                    const mappingManuel = !!(b.mapping && Object.keys(b.mapping).length);

                    const { board, items } = await M.fetchBoardItems(state.token, b.id, log);
                    if (!board) throw new Error('Tableau inaccessible');

                    // L'association se fait sur les noms de colonnes, puis se
                    // vérifie sur les valeurs. Les deux étapes sont menées
                    // ensemble : un candidat démenti par les données — la
                    // colonne « Problématique Pré-échéance », qui contient le
                    // mot échéance sans porter de dates — laisse ainsi la place
                    // au candidat suivant sur ce champ, au lieu de l'emporter
                    // puis de le laisser vide.
                    const echantillon = items.slice(0, 200);
                    const valeursDe = colId => echantillon.map(it => {
                        const cv = (it.column_values || []).find(c => c.id === colId);
                        return cv ? M.columnValue(cv) : '';
                    });

                    let rejets = [];
                    if (mappingManuel) {
                        // Une correspondance choisie à la main fait foi : elle
                        // est contrôlée, jamais remplacée.
                        const contr = I.validerMapping(b.mapping, valeursDe);
                        b.mapping = contr.mapping;
                        rejets = contr.rejets;
                    } else {
                        const auto = I.autoMapColumns(b.columns || [], valeursDe);
                        b.mapping = auto.mapping;
                        rejets = auto.rejets;
                        const manquants = ['numero', 'montant'].filter(k => !b.mapping[k]);
                        if (manquants.length) log(`   ⚠ colonnes non reconnues : ${manquants.join(', ')}`);
                    }
                    b.rejetsMapping = rejets;
                    rejets.forEach(r => {
                        const repris = b.mapping[r.champ];
                        log(`   ⚠ « ${r.colonne} » écartée du champ ${r.champ} : ${r.raison}`
                            + (repris ? ` — « ${repris} » retenue à la place` : ''));
                    });

                    // Une colonne correctement nommée peut n'être jamais
                    // renseignée. Le taux de remplissage est mesuré ici, sur les
                    // valeurs réelles, et conservé pour l'écran de
                    // correspondance : un montant absent doit se voir avant de
                    // ressortir en zéros dans les indicateurs.
                    b.couverture = I.couvertureMapping(b.mapping, colId =>
                        echantillon.map(it => {
                            const cv = (it.column_values || []).find(c => c.id === colId);
                            return cv ? M.columnValue(cv) : '';
                        }), echantillon.length);

                    for (const champ of ['montant', 'dateFacture', 'dateFinFormation']) {
                        const c = b.couverture[champ];
                        const nom = (I.FIELD_BY_NAME[champ] || {}).label || champ;
                        if (!c || !c.colId) log(`   ⚠ ${nom} : aucune colonne reconnue sur ce tableau`);
                        else if (c.taux < 50) log(`   ⚠ ${nom} : colonne renseignée sur ${Math.round(c.taux)} % des lignes seulement`);
                    }

                    const factures = I.facturesFromMondayBoard(board, items, b.mapping, b);
                    // Conserver les valeurs brutes pour l'aperçu du mapping
                    items.forEach((it, idx) => {
                        const brut = {};
                        for (const cv of (it.column_values || [])) { const v = M.columnValue(cv); if (v) brut[cv.id] = v; }
                        if (factures[idx]) factures[idx].__brut = brut;
                    });

                    collecte.push(...factures);
                    b.charge = factures.length;
                    log(`   ✓ ${factures.length} factures`);

                    if (b.itemsCount != null && factures.length < b.itemsCount) {
                        log(`   ⚠ ${b.itemsCount - factures.length} éléments manquants sur ${b.itemsCount}`);
                    }
                } catch (e) {
                    b.erreurChargement = e.message;
                    b.charge = 0;
                    echecs.push(b.name);
                    log(`   ✗ ${e.message}`);
                }
            }

            if (echecs.length) {
                U.toast(`${echecs.length} tableau(x) non chargé(s) — voir Data Quality.`, 'error', 10000);
            }

            state.brutes = collecte;
            state.derniereActualisation = new Date();
            await sauverFactures();
            await sauverBoards();
            await S.set('rec_derniere_actualisation', state.derniereActualisation.toISOString());
            statut('Calcul des indicateurs');
            recalculer({ conserverPeriode: silencieux });
            if (!silencieux) montrerEcran('app');
            U.toast(`${U.nombre(collecte.length)} factures chargées depuis Monday.`, 'success');
        } catch (e) {
            log('✗ ' + e.message);
            state.derniereErreur = e.message;
            if (silencieux) {
                console.warn('[Recouvrement] Actualisation automatique échouée', e);
            } else {
                statut('Échec du chargement');
                U.toast(e.message, 'error', 12000);
                setTimeout(() => montrerEcran(state.factures.length ? 'app' : 'welcome'), 1500);
            }
        } finally {
            state.chargementEnCours = false;
            await autoriserVeille();
            majIndicateurActualisation();
        }
    }

    // ══════════════════════════════════════════════
    //  Actualisation automatique
    // ══════════════════════════════════════════════

    let minuteurActualisation = null;

    /**
     * Relance périodiquement la récupération Monday tant que l'application est
     * ouverte. Une facture ajoutée dans Monday apparaît donc sans intervention,
     * au prochain passage.
     */
    function programmerActualisation() {
        if (minuteurActualisation) { clearInterval(minuteurActualisation); minuteurActualisation = null; }
        const minutes = parseInt(state.options.actualisationAuto, 10) || 0;
        if (!minutes) { majIndicateurActualisation(); return; }

        minuteurActualisation = setInterval(() => {
            if (document.hidden) return;                 // inutile hors écran
            if (!state.token || state.chargementEnCours) return;
            chargerBoardsActifs({ silencieux: true });
        }, minutes * 60 * 1000);

        majIndicateurActualisation();
    }

    /** Horodatage discret dans la barre supérieure. */
    function majIndicateurActualisation() {
        const el = $('#indicateur-actualisation');
        if (!el) return;

        if (state.chargementEnCours) {
            el.className = 'maj-indic en-cours';
            el.textContent = 'Actualisation…';
            return;
        }
        if (!state.derniereActualisation) { el.textContent = ''; el.className = 'maj-indic'; return; }

        const minutes = Math.round((Date.now() - state.derniereActualisation.getTime()) / 60000);
        const quand = minutes < 1 ? "à l'instant"
            : minutes < 60 ? `il y a ${minutes} min`
            : minutes < 1440 ? `il y a ${Math.round(minutes / 60)} h`
            : 'le ' + U.dateFR(state.derniereActualisation);

        const auto = parseInt(state.options.actualisationAuto, 10) || 0;
        el.className = 'maj-indic';
        el.textContent = 'Données de ' + quand;
        el.title = auto
            ? `Actualisation automatique toutes les ${auto} minutes`
            : "Actualisation automatique désactivée — cliquez sur Actualiser, ou activez-la dans l'onglet Données";
    }

    // ══════════════════════════════════════════════
    //  Import de fichiers
    // ══════════════════════════════════════════════

    function lireFichier(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            const estCSV = /\.csv$/i.test(file.name);
            reader.onerror = () => reject(new Error('Lecture impossible : ' + file.name));
            reader.onload = e => {
                try {
                    if (estCSV) {
                        const res = Papa.parse(e.target.result, { header: true, skipEmptyLines: true, delimiter: '' });
                        resolve(res.data);
                    } else {
                        const wb = XLSX.read(e.target.result, { type: 'array', cellDates: true });
                        const sheet = wb.Sheets[wb.SheetNames[0]];
                        resolve(XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false }));
                    }
                } catch (err) { reject(err); }
            };
            if (estCSV) reader.readAsText(file, 'UTF-8');
            else reader.readAsArrayBuffer(file);
        });
    }

    async function importerFichiers(files) {
        if (!files || !files.length) return;
        montrerEcran('loading');
        $('#loader-log').innerHTML = '';
        statut('Lecture des fichiers');
        log(`${files.length} fichier(s) à traiter`);

        const collecte = state.brutes.filter(f => !String(f.boardId).startsWith('file:'));
        const dejaImportes = new Map(state.imports.map(im => [im.nom, im]));

        try {
            for (const file of files) {
                const nom = file.name.replace(/\.(csv|xlsx|xls)$/i, '');
                log(`→ ${file.name}`);
                const rows = await lireFichier(file);
                if (!rows.length) { log('   ⚠ fichier vide'); continue; }

                const detect = R.detectBoardRole(nom);
                const cfg = {
                    role: detect.role === 'ignore' ? 'adv' : detect.role,
                    perimetre: detect.perimetre === 'Inconnu' ? 'Corporate' : detect.perimetre,
                    source: detect.source || 'adv',
                    financementDefaut: detect.financementDefaut,
                    mapping: null,
                };
                const { factures, mapping, columns, couverture } = I.facturesFromRows(rows, cfg, nom);

                // Le fichier devient un « tableau » de la configuration
                const id = 'file:' + nom;
                const existant = state.boards.find(b => b.id === id);
                const entree = {
                    id, name: nom, itemsCount: rows.length, workspace: 'Import fichier',
                    role: cfg.role, perimetre: cfg.perimetre, source: cfg.source,
                    financementDefaut: cfg.financementDefaut, actif: true,
                    columns, mapping, couverture, charge: factures.length,
                };
                if (existant) Object.assign(existant, entree); else state.boards.push(entree);

                factures.forEach((f, i) => { f.__brut = rows[i]; });
                collecte.push(...factures);
                dejaImportes.set(file.name, { nom: file.name, role: cfg.role, lignes: rows.length, date: new Date().toLocaleString('fr-FR') });
                log(`   ✓ ${factures.length} lignes · rôle « ${R.ROLE_LABELS[cfg.role]} »`);
            }

            state.brutes = collecte;
            state.imports = [...dejaImportes.values()];
            await Promise.all([sauverFactures(), sauverBoards(), S.set(S.KEYS.imports, state.imports)]);
            recalculer();
            montrerEcran('app');
            U.toast(`${U.nombre(collecte.length)} factures au total après import.`, 'success');
        } catch (e) {
            log('✗ ' + e.message);
            U.toast(e.message, 'error', 9000);
            setTimeout(() => montrerEcran(state.factures.length ? 'app' : 'welcome'), 1500);
        }
    }

    /**
     * Import des exports GoCardless. Chaque fichier est reconnu à ses colonnes,
     * l'ordre de dépôt n'a donc pas d'importance ; un même type déposé deux
     * fois remplace le précédent.
     */
    async function importerGoCardless(files) {
        if (!files || !files.length) return;
        const journal = [];
        const recus = {};

        try {
            for (const file of files) {
                const rows = await lireFichier(file);
                if (!rows.length) { journal.push(`${file.name} : fichier vide`); continue; }

                const type = PR.detecterType(Object.keys(rows[0]));
                if (!type) { journal.push(`${file.name} : type non reconnu, ignoré`); continue; }

                switch (type) {
                    case 'paiements':   recus.paiements = PR.normaliserPaiements(rows); break;
                    case 'clients':     recus.clients = PR.normaliserClients(rows); break;
                    case 'mandats':     recus.mandats = PR.normaliserMandats(rows); break;
                    case 'abonnements': recus.abonnements = PR.normaliserAbonnements(rows); break;
                }
                journal.push(`${file.name} : ${type} — ${U.nombre(rows.length)} lignes`);
            }

            if (!Object.keys(recus).length) {
                U.toast("Aucun export GoCardless reconnu. Attendus : Payments, Customers, Subscriptions, Mandates.", 'error', 9000);
                return;
            }

            const g = state.gcl;
            Object.assign(g, recus);
            g.fichiers = [...new Set([...(g.fichiers || []), ...journal])];
            if (recus.paiements) g.unite = null;   // ré-évaluer l'unité sur les nouveaux montants

            recalculerPrelevements();
            await sauverGoCardless();
            proposerReprise();

            if (!g.paiements.length) {
                U.toast("Aucun prélèvement chargé : l'export Payments est indispensable.", 'error', 9000);
            } else {
                U.toast(`${U.nombre(state.apprenants.length)} apprenants reconstitués sur `
                    + `${U.nombre(g.paiements.length)} prélèvements.`, 'success', 7000);
            }
            ouvrirOnglet('prelevements');
        } catch (e) {
            U.toast(e.message, 'error', 9000);
        }
    }

    async function sauverGoCardless() {
        try {
            const g = state.gcl;
            await S.set(S.KEYS.gocardless, {
                paiements: g.paiements.map(serialiser),
                clients: g.clients.map(serialiser),
                mandats: g.mandats.map(serialiser),
                abonnements: g.abonnements.map(serialiser),
                fichiers: g.fichiers,
            });
        } catch (e) { console.warn('[Recouvrement] Sauvegarde GoCardless impossible', e); }
    }

    const CHAMPS_DATE_GCL = ['dateEcheance', 'dateCreation', 'dateDebut', 'dateFin'];

    function revivreGcl(o) {
        const r = { ...o };
        for (const c of CHAMPS_DATE_GCL) r[c] = r[c] ? R.parseDate(r[c]) : null;
        return r;
    }

    /** Import du grand livre pointé : numéro de facture → date de règlement. */
    async function importerGrandLivre(file) {
        try {
            const rows = await lireFichier(file);
            if (!rows.length) { U.toast('Fichier vide.', 'error'); return; }

            const cols = Object.keys(rows[0]).map(h => ({ id: h, title: h }));
            const map = I.autoMapColumns(cols);
            const colNum = map.numero, colDate = map.datePaiement || map.dateFacture, colMt = map.montant;

            if (!colNum || !colDate) {
                U.toast("Colonnes « numéro de facture » et « date de règlement » introuvables dans le fichier.", 'error', 9000);
                return;
            }

            state.grandLivre = rows.map(r => ({
                numero: r[colNum], datePaiement: r[colDate], montant: colMt ? r[colMt] : null,
            })).filter(l => l.numero);

            await S.set(S.KEYS.grandLivre, state.grandLivre);
            recalculer({ conserverPeriode: true });
            rendreHistoriqueImports();
            const st = state.glStats || {};
            U.toast(`Grand livre intégré : ${U.nombre(st.rapprochees || 0)} factures rapprochées, `
                + `${U.nombre(st.completees || 0)} dates de paiement complétées`
                + (st.remplacees ? `, ${U.nombre(st.remplacees)} remplacées` : '') + '.', 'success', 8000);
        } catch (e) {
            U.toast(e.message, 'error', 9000);
        }
    }

    // ══════════════════════════════════════════════
    //  Persistance
    // ══════════════════════════════════════════════

    async function sauverFactures() {
        try { await S.set(S.KEYS.factures, state.brutes.map(serialiser)); }
        catch (e) { console.warn('[Recouvrement] Sauvegarde impossible', e); }
    }
    async function sauverBoards() {
        try { await S.set(S.KEYS.boards, state.boards.map(b => ({ ...b, columns: b.columns || null }))); }
        catch (e) { console.warn('[Recouvrement] Sauvegarde des tableaux impossible', e); }
    }
    async function sauverReglages() {
        try {
            await S.set(S.KEYS.settings, {
                token: $('#monday-remember') && $('#monday-remember').checked === false ? '' : state.token,
                options: state.options,
            });
        } catch (e) { console.warn('[Recouvrement] Sauvegarde des réglages impossible', e); }
    }
    async function sauverRegles() {
        try { await S.set(S.KEYS.rules, state.rules); } catch { /* ignore */ }
    }

    // ══════════════════════════════════════════════
    //  Exports
    // ══════════════════════════════════════════════

    function lignesExport(factures) {
        return factures.map(f => ({
            'Numéro de facture': f.numero,
            'Client': f.client,
            'Type de financement': R.getRule(f.financement, state.rules).label,
            'Montant': f.montant,
            'Reste dû': f.encours,
            'Date de facture': f.dateFacture ? U.dateFR(f.dateFacture) : '',
            'Début de formation': f.dateDebutFormation ? U.dateFR(f.dateDebutFormation) : '',
            'Fin de formation': f.dateFinFormation ? U.dateFR(f.dateFinFormation) : '',
            'Date d\'échéance': f.dateEcheance ? U.dateFR(f.dateEcheance) : '',
            'Origine échéance': f.echeanceOrigine || '',
            'Règle appliquée': R.getRule(f.financement, state.rules).note || '',
            'Date de paiement': f.datePaiement ? U.dateFR(f.datePaiement) : '',
            'Date contrôle paiement': f.dateControlePaiement ? U.dateFR(f.dateControlePaiement) : '',
            'Retard (jours)': f.retardJours,
            'Antériorité': f.bucket ? f.bucket.label : '',
            'État': f.etat,
            'Tableau': f.board,
            'Groupe': f.groupe,
            'Groupe d\'origine': f.groupeOrigine,
            'Périmètre': f.perimetre,
            'Propriétaire': f.proprietaire,
            'Statut Monday': f.statut,
        }));
    }

    function exporterExcel() {
        const data = facturesFiltrees();
        if (!data.length) { U.toast('Aucune donnée à exporter.', 'error'); return; }

        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(lignesExport(data)), 'Factures');

        // Synthèse
        const v = X.vueEnsemble(data);
        const synthese = [
            { Indicateur: "Version de l'application", Valeur: VERSION + ' — ' + VERSION_DATE },
            { Indicateur: 'Factures analysées', Valeur: v.total },
            { Indicateur: 'Total facturé (€)', Valeur: Math.round(v.totalEuros) },
            { Indicateur: 'Factures en retard', Valeur: v.nbEnRetard },
            { Indicateur: 'Montant en retard (€)', Valeur: Math.round(v.eurosEnRetard) },
            { Indicateur: '% en recouvrement (nombre)', Valeur: +v.tauxNb.toFixed(2) },
            { Indicateur: '% en recouvrement (€)', Valeur: +v.tauxEuros.toFixed(2) },
            { Indicateur: '% cohorte échue en retard (nombre)', Valeur: +v.tauxCohorteNb.toFixed(2) },
            { Indicateur: '% cohorte échue en retard (€)', Valeur: +v.tauxCohorteEuros.toFixed(2) },
            { Indicateur: "Réglé avant l'échéance — nombre", Valeur: v.nbRegleATemps },
            { Indicateur: "Réglé avant l'échéance — % (nombre)", Valeur: +v.tauxRegleATempsNb.toFixed(2) },
            { Indicateur: "Réglé avant l'échéance — % (€)", Valeur: +v.tauxRegleATempsEuros.toFixed(2) },
            { Indicateur: 'Réglé en recouvrement — % (€)', Valeur: +v.tauxRegleRetardEuros.toFixed(2) },
            { Indicateur: 'Reste à recouvrer — % (€)', Valeur: +v.tauxResteEuros.toFixed(2) },
            { Indicateur: 'Jamais passé par le recouvrement — % (€)', Valeur: +v.tauxHorsRecouvrementEuros.toFixed(2) },
            { Indicateur: 'Retard moyen (jours)', Valeur: v.retardMoyen == null ? '' : Math.round(v.retardMoyen) },
            { Indicateur: 'Retard médian (jours)', Valeur: v.retardMedian == null ? '' : Math.round(v.retardMedian) },
            { Indicateur: 'Retard moyen pondéré € (jours)', Valeur: v.retardMoyenPondere == null ? '' : Math.round(v.retardMoyenPondere) },
            { Indicateur: 'Retard moyen au paiement (jours)', Valeur: v.retardMoyenPaiement == null ? '' : Math.round(v.retardMoyenPaiement) },
            { Indicateur: 'Délai moyen facture → règlement (jours)', Valeur: v.delaiPaiementMoyen == null ? '' : Math.round(v.delaiPaiementMoyen) },
            { Indicateur: 'Reste à encaisser (€)', Valeur: Math.round(v.encoursTotal) },
            { Indicateur: 'Arrêté au', Valeur: U.dateFR(state.filtres.dateRef) },
        ];
        XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(synthese), 'Synthèse');

        // Par mois
        const mois = X.parMois(data, state.filtres.baseMois).map(m => ({
            'Mois': U.moisLabel(m.mois),
            'Factures échues': m.assietteNb,
            'Montant échu (€)': Math.round(m.assietteEur),
            'Payées à temps': m.nbPayeeATemps,
            'Payées en retard': m.nbPayeeRetard,
            'Encore en retard': m.nbEnRetard,
            'Montant en retard (€)': Math.round(m.eurEnRetard),
            '% en retard (nombre)': +m.tauxNb.toFixed(2),
            '% en retard (€)': +m.tauxEur.toFixed(2),
            '% encore impayé (€)': +m.tauxImpayeEur.toFixed(2),
            'Retard moyen (j)': m.retardMoyen == null ? '' : Math.round(m.retardMoyen),
        }));
        XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(mois), 'Par mois');

        // Par financement
        const fins = X.parFinancement(data, state.rules).map(r => ({
            'Type de financement': r.label,
            'Périmètre': r.perimetre,
            'Factures': r.nbTotal,
            'Total facturé (€)': Math.round(r.eurTotal),
            'En retard (nombre)': r.nbEnRetard,
            'Montant en retard (€)': Math.round(r.eurEnRetard),
            '% en retard (nombre)': +r.tauxNb.toFixed(2),
            '% en retard (€)': +r.tauxEur.toFixed(2),
            '% cohorte échue (€)': +r.tauxCohorteEur.toFixed(2),
            "Réglé avant l'échéance (nombre)": r.nbRegleATemps,
            "Réglé avant l'échéance — % (€)": +r.tauxRegleATempsEur.toFixed(2),
            'Retard moyen (j)': r.retardMoyen == null ? '' : Math.round(r.retardMoyen),
            'Retard au paiement (j)': r.retardMoyenPaiement == null ? '' : Math.round(r.retardMoyenPaiement),
        }));
        XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(fins), 'Par financement');

        // Répartition hors / en recouvrement, à plat
        const dims = state.ui.repartitionDims.split(',').map(k => DIMENSIONS[k]).filter(Boolean);
        const repartition = [];
        (function aplatir(noeuds) {
            for (const n of noeuds) {
                repartition.push({
                    'Niveau': DIMENSIONS[n.dimension] ? DIMENSIONS[n.dimension].titre : n.dimension,
                    'Libellé': n.label,
                    'Factures': n.nb,
                    'Montant total (€)': Math.round(n.total),
                    'Hors recouvrement (€)': Math.round(n.eurHorsRecouvrement),
                    'dont réglé (€)': Math.round(n.eurRegle),
                    'dont non échu (€)': Math.round(n.eurNonEchu),
                    'En recouvrement (€)': Math.round(n.eurEnRecouvrement),
                    'Reste dû (€)': Math.round(n.encoursEnRecouvrement),
                    '% en recouvrement (€)': +n.tauxEur.toFixed(2),
                    'Retard moyen (j)': n.retardMoyen == null ? '' : Math.round(n.retardMoyen),
                });
                if (n.enfants.length) aplatir(n.enfants);
            }
        })(X.repartitionMontants(data, dims));
        XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(repartition), 'Répartition');

        // Balance âgée
        const aging = X.balanceAgee(data).map(b => ({
            'Antériorité': b.label, 'Factures': b.nb, 'Montant en retard (€)': Math.round(b.euros),
            '% de l\'encours': +b.partEuros.toFixed(2),
        }));
        XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(aging), 'Balance âgée');

        const nom = `Suivi_Recouvrement_Liora_${new Date().toISOString().slice(0, 10)}.xlsx`;
        XLSX.writeFile(wb, nom);
        U.toast('Export Excel généré.', 'success');
    }

    function exporterApprenants() {
        if (!state.apprenants.length) { U.toast('Aucun apprenant à exporter.', 'error'); return; }
        const rows = state.apprenants.map(a => ({
            'Apprenant': a.nom,
            'E-mail': a.email,
            'Identifié par': a.email ? 'E-mail' : (a.identifieParNom ? 'Nom' : 'Identifiant GoCardless'),
            'État': a.etat,
            'Prélèvements présentés': a.nbPresentes,
            'Encaissés': a.nbSucces,
            'Rejets': a.nbEchecs,
            '% de rejet': +a.tauxEchec.toFixed(2),
            'Rang du 1er rejet': a.rangPremierEchec || '',
            'Délai avant 1er rejet (j)': a.delaiPremierEchec == null ? '' : a.delaiPremierEchec,
            'Montant encaissé (€)': Math.round(a.montantEncaisse),
            'Montant rejeté (€)': Math.round(a.montantEchoue),
            'Premier prélèvement': a.datePremier ? U.dateFR(a.datePremier) : '',
            'Dernier prélèvement': a.dateDernier ? U.dateFR(a.dateDernier) : '',
            'Motifs de rejet': a.motifs.join(' · '),
        }));

        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'Apprenants');

        const st = PR.statistiques(state.apprenants, state.gcl.paiements);
        XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet([
            { Indicateur: 'Apprenants', Valeur: st.nbApprenants },
            { Indicateur: 'Abonnements', Valeur: st.nbAbonnements },
            { Indicateur: 'Sans incident', Valeur: st.nbSansIncident },
            { Indicateur: 'Sans incident — %', Valeur: +st.partSansIncident.toFixed(2) },
            { Indicateur: 'Avec incident', Valeur: st.nbAvecIncident },
            { Indicateur: 'En difficulté', Valeur: st.nbEnDifficulte },
            { Indicateur: 'Incidents rattrapés — %', Valeur: +st.partRattrapes.toFixed(2) },
            { Indicateur: 'Taux de rejet des prélèvements — %', Valeur: +st.tauxEchecPrelevements.toFixed(2) },
            { Indicateur: 'Délai médian avant 1er rejet (j)', Valeur: st.delaiMedianPremierEchec == null ? '' : Math.round(st.delaiMedianPremierEchec) },
            { Indicateur: 'Rang médian du 1er rejet', Valeur: st.rangMedianPremierEchec || '' },
            { Indicateur: 'Montant encaissé (€)', Valeur: Math.round(st.montantEncaisse) },
            { Indicateur: 'Montant rejeté (€)', Valeur: Math.round(st.montantEchoue) },
            { Indicateur: 'Montant à risque (€)', Valeur: Math.round(st.montantARisque) },
        ]), 'Synthèse');

        XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(
            PR.survie(state.apprenants, 24).map(p => ({
                'Mois depuis le 1er prélèvement': p.mois,
                'Sans incident (%)': +p.survie.toFixed(2),
                'Apprenants observés': p.aRisque,
                'Premiers rejets': p.evenements,
            }))), 'Survie');

        XLSX.writeFile(wb, `Prelevements_Liora_${new Date().toISOString().slice(0, 10)}.xlsx`);
        U.toast('Export généré.', 'success');
    }

    function exporterListe(factures, titre) {
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(lignesExport(factures)), 'Factures');
        XLSX.writeFile(wb, `Recouvrement_${(titre || 'liste').replace(/[^\w]+/g, '_')}.xlsx`);
    }

    // ══════════════════════════════════════════════
    //  Navigation
    // ══════════════════════════════════════════════

    function montrerEcran(nom) {
        $$('.screen').forEach(s => s.classList.remove('active'));
        const el = $('#' + nom + '-screen');
        if (el) el.classList.add('active');
        window.scrollTo(0, 0);
        if (nom === 'app') requestAnimationFrame(mesurerNavbar);
    }

    function ouvrirOnglet(nom) {
        state.ui.onglet = nom;
        $$('.nav-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === nom));
        $$('.tab-content').forEach(c => c.classList.toggle('active', c.id === 'tab-' + nom));
        // La barre de filtres n'a pas de sens sur l'onglet Données
        $('#filters-wrap').classList.toggle('hidden', nom === 'donnees' || nom === 'prelevements');
        rendreTout();
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    // ══════════════════════════════════════════════
    //  Éditeur de règles
    // ══════════════════════════════════════════════

    function ouvrirEditeurRegles() {
        const bases = [
            ['dateFacture', 'Date de facture'],
            ['dateFinFormation', 'Fin de formation'],
            ['dateDebutFormation', 'Début de formation'],
        ];
        const html = `
            <p class="fv-hint">L'échéance est calculée en ajoutant un nombre de jours à une date de référence. Les modifications s'appliquent immédiatement et sont conservées sur ce poste.</p>
            <table class="data-table rules-editor">
                <thead><tr><th>Type de financement</th><th>Date de référence</th><th>Jours</th><th>Repli</th><th>Jours repli</th></tr></thead>
                <tbody>
                ${state.rules.map((r, i) => `
                    <tr>
                        <td>${U.escapeHtml(r.label)}</td>
                        <td><select class="input input-sm" data-r="${i}" data-k="base">${bases.map(b => `<option value="${b[0]}"${r.base === b[0] ? ' selected' : ''}>${b[1]}</option>`).join('')}</select></td>
                        <td><input class="input input-sm input-num" type="number" data-r="${i}" data-k="jours" value="${r.jours}"></td>
                        <td><select class="input input-sm" data-r="${i}" data-k="fallback"><option value="">— aucun —</option>${bases.map(b => `<option value="${b[0]}"${r.fallback === b[0] ? ' selected' : ''}>${b[1]}</option>`).join('')}</select></td>
                        <td><input class="input input-sm input-num" type="number" data-r="${i}" data-k="fallbackJours" value="${r.fallbackJours != null ? r.fallbackJours : r.jours}"></td>
                    </tr>`).join('')}
                </tbody>
            </table>`;

        const body = U.modal('Règles de date d\'échéance', html, [
            {
                label: 'Rétablir les règles Liora', onClick: async () => {
                    state.rules = R.DEFAULT_ECHEANCE_RULES.map(r => ({ ...r }));
                    await sauverRegles();
                    recalculer({ conserverPeriode: true });
                    U.toast('Règles rétablies.', 'success');
                },
            },
            { label: 'Fermer', primary: true },
        ]);

        $$('[data-r]', body).forEach(inp => inp.addEventListener('change', async () => {
            const r = state.rules[+inp.dataset.r];
            const k = inp.dataset.k;
            r[k] = (k === 'jours' || k === 'fallbackJours') ? (parseInt(inp.value, 10) || 0) : (inp.value || null);
            await sauverRegles();
            recalculer({ conserverPeriode: true });
        }));
    }

    // ══════════════════════════════════════════════
    //  Jeu de démonstration
    // ══════════════════════════════════════════════

    function genererDemo() {
        const clients = ['ALLIANZ I.A.R.D.', 'SOCIETE GENERALE', 'MFP MICHELIN', 'AEROPORTS DE PARIS', 'SUEZ INTERNATIONAL',
            'CREDIT AGRICOLE CORPORATE', 'ARTHUR HUNT CONSULTING', 'MISSIONEO', 'ANTARGAZ', 'UNISERV Sarl',
            'CABINET LACOMBLEZ', 'Marie Dupont', 'Karim Benali', 'Sophie Legrand', 'Thomas Moreau', 'Inès Rossi'];
        const config = [
            { board: '1.2. Entreprise - Recouvrement', role: 'recouvrement', source: 'recouvrement', perimetre: 'Corporate', fins: ['B2B', 'ETAT', 'INTERCO'], groupes: ['1.2.1. Relance 1', '1.2.2. Relance 2', '1.2.3. Mise en demeure'], poids: 26 },
            { board: '1.1. Entreprise - ADV', role: 'adv', source: 'adv', perimetre: 'Corporate', fins: ['BTC_ENTREPRISE', 'B2B'], groupes: ['1.1.1. Factures non conformes', '1.1.2. Factures incomplètes (Mail)', '1.1.5. Factures en cours'], poids: 30 },
            { board: '1.0. Entreprise - Tampon', role: 'tampon', source: 'adv', perimetre: 'Corporate', fins: ['BTC_ENTREPRISE'], groupes: ['1.0.1. Arrivées'], poids: 8 },
            { board: '1.3. Entreprise - OPCO', role: 'opco', source: 'opco', perimetre: 'Corporate', fins: ['OPCO'], groupes: ['1.3.1. Dossiers déposés'], poids: 18 },
            { board: '2.2. Financement CPF', role: 'b2c', source: 'b2c', perimetre: 'B2C', fins: ['CPF'], groupes: ['2.2.1. En cours'], poids: 20 },
            { board: '2.3. Financement pôle emploi : AIF / POEI', role: 'b2c', source: 'b2c', perimetre: 'B2C', fins: ['AIF', 'POEI'], groupes: ['2.3.1. AIF'], poids: 12 },
            { board: '2.4. Financement complexe : REGION / TRANSITION / AGEFIPH', role: 'b2c', source: 'b2c', perimetre: 'B2C', fins: ['REGION', 'TRANSITION', 'AGEFIPH'], groupes: ['2.4.1. Instruction'], poids: 10 },
            { board: '2.1. Financement Personnel', role: 'b2c', source: 'b2c', perimetre: 'B2C', fins: ['BTC_PERSO'], groupes: ['2.1.1. Échéancier'], poids: 8 },
        ];

        let seed = 20260828;
        const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
        const pick = a => a[Math.floor(rnd() * a.length)];

        const brutes = [];
        const aujourdhui = R.stripTime(new Date());
        let n = 1000;

        for (const cfg of config) {
            for (let i = 0; i < cfg.poids * 6; i++) {
                const moisAvant = Math.floor(rnd() * 20);
                const dateFacture = new Date(aujourdhui.getFullYear(), aujourdhui.getMonth() - moisAvant, 1 + Math.floor(rnd() * 27));
                const finFormation = R.addDays(dateFacture, -Math.floor(rnd() * 20));
                const fin = pick(cfg.fins);
                const montant = Math.round((400 + rnd() * 14000) / 10) * 10;

                // Probabilité de règlement d'autant plus forte que la facture est ancienne
                const proba = Math.min(0.94, 0.25 + moisAvant * 0.075);
                const paye = rnd() < proba;
                const rule = R.getRule(fin);
                const base = rule.base === 'dateFacture' ? dateFacture : finFormation;
                const echeance = R.addDays(base, rule.jours);

                let datePaiement = null, dateControle = null;
                if (paye) {
                    const derive = Math.round((rnd() - 0.66) * 75);
                    datePaiement = R.addDays(echeance, derive);
                    if (datePaiement > aujourdhui) datePaiement = R.addDays(aujourdhui, -Math.floor(rnd() * 10));
                    // Une part des règlements n'a pas de date réelle : seule la validation existe
                    if (rnd() < 0.3) { dateControle = R.addDays(datePaiement, 3 + Math.floor(rnd() * 20)); datePaiement = null; }
                }

                const numero = 'FACT-' + String(dateFacture.getFullYear()).slice(2)
                    + String(dateFacture.getMonth() + 1).padStart(2, '0') + '-' + String(n++).padStart(5, '0');

                brutes.push(I.buildFacture({
                    numero, client: pick(clients), montant,
                    dateFacture, dateFinFormation: finFormation,
                    dateDebutFormation: R.addDays(finFormation, -35),
                    datePaiement, dateControlePaiement: dateControle,
                    financement: R.getRule(fin).label,
                    proprietaire: pick(['Cédric Ngan', 'David Mamou', 'Zehavit Tordjman', 'M. Cédric Nelhomme']),
                    statut: paye ? 'Payée' : '',
                }, {
                    boardId: 'file:' + cfg.board, boardName: cfg.board, role: cfg.role,
                    source: cfg.source, perimetre: cfg.perimetre, financementDefaut: fin,
                    groupTitle: pick(cfg.groupes), itemId: 'demo' + n, itemName: numero,
                }));
            }
        }

        // Tableau « ALL - Factures payées » : reprend les factures réglées
        const payees = brutes.filter(f => f.datePaiement || f.dateControlePaiement);
        for (const f of payees) {
            brutes.push(I.buildFacture({
                numero: f.numero, client: f.client, montant: f.montant,
                dateFacture: f.dateFacture, datePaiement: f.datePaiement,
                dateControlePaiement: f.dateControlePaiement,
                financement: f.financementBrut, groupeOrigine: f.board, statut: 'Payée',
            }, {
                boardId: 'file:0.1. ALL - Factures payées', boardName: '0.1. ALL - Factures payées',
                role: 'payees', source: 'payees', perimetre: 'Tous', financementDefaut: null,
                groupTitle: '0.1.1. Factures Payées ADV', itemId: 'pay' + f.itemId, itemName: f.numero,
            }));
        }

        state.brutes = brutes;
        state.boards = [...new Set(brutes.map(f => f.board))].map(name => {
            const s = brutes.find(f => f.board === name);
            return { id: 'file:' + name, name, itemsCount: brutes.filter(f => f.board === name).length,
                workspace: 'Démonstration', role: s.role, perimetre: s.perimetre, source: s.source,
                financementDefaut: null, actif: true, columns: null, mapping: null,
                charge: brutes.filter(f => f.board === name).length };
        });
        recalculer();
        montrerEcran('app');
        U.toast('Jeu de démonstration chargé — les données sont fictives.', 'info', 7000);
    }

    // ══════════════════════════════════════════════
    //  Événements
    // ══════════════════════════════════════════════

    function brancherEvenements() {
        // ── Écran d'accueil ──
        $('#btn-token-visible').addEventListener('click', () => basculerVisibilite('#monday-token'));
        $('#btn-settings-token-visible').addEventListener('click', () => basculerVisibilite('#settings-token'));

        $('#btn-monday-connect').addEventListener('click', async () => {
            const token = $('#monday-token').value.trim();
            if (await connecterMonday(token)) {
                $('#settings-token').value = token;
                await chargerListeBoards();
                montrerEcran('app');
                ouvrirOnglet('donnees');
                U.toast('Vérifiez les tableaux à suivre puis cliquez sur « Charger les tableaux cochés ».', 'info', 8000);
            }
        });
        $('#monday-token').addEventListener('keydown', e => { if (e.key === 'Enter') $('#btn-monday-connect').click(); });

        $('#btn-open-saved').addEventListener('click', () => {
            recalculer();
            montrerEcran('app');
            // Sans facture enregistrée, l'onglet utile est celui des prélèvements
            if (!state.brutes.length && state.apprenants.length) ouvrirOnglet('prelevements');
            actualiserAuDemarrageSiUtile();
        });
        $('#btn-demo').addEventListener('click', genererDemo);

        brancherZoneDepot('#welcome-drop', '#welcome-file-input', files => importerFichiers(files));
        brancherZoneDepot('#settings-drop', '#settings-file-input', files => importerFichiers(files));
        brancherZoneDepot('#gl-drop', '#gl-file-input', files => importerGrandLivre(files[0]));
        brancherZoneDepot('#prlv-drop', '#prlv-file-input', files => importerGoCardless(files));
        brancherZoneDepot('#gcl-drop', '#gcl-file-input', files => importerGoCardless(files));

        $('#btn-prlv-remplacer').addEventListener('click', () => $('#prlv-file-input-2').click());
        $('#prlv-file-input-2').addEventListener('change', e => {
            if (e.target.files.length) importerGoCardless([...e.target.files]);
            e.target.value = '';
        });

        brancherActes();
        brancherFenetreMois();
        $$('#seg-regl-origine .seg-btn').forEach(b => b.addEventListener('click', () => {
            state.ui.reglOrigine = b.dataset.origine;
            $$('#seg-regl-origine .seg-btn').forEach(x => x.classList.toggle('active', x === b));
            rendreTout();
        }));
        $$('#seg-evocat-unite .seg-btn').forEach(b => b.addEventListener('click', () => {
            state.ui.evoCatUnite = b.dataset.unite;
            $$('#seg-evocat-unite .seg-btn').forEach(x => x.classList.toggle('active', x === b));
            rendreTout();
        }));
        $$('#seg-rang-unite .seg-btn').forEach(b => b.addEventListener('click', () => {
            state.ui.rangUnite = b.dataset.unite;
            $$('#seg-rang-unite .seg-btn').forEach(x => x.classList.toggle('active', x === b));
            rendrePrelevements();
        }));
        $$('#seg-prlv-etat .seg-btn').forEach(b => b.addEventListener('click', () => {
            state.ui.prlvEtat = b.dataset.etat;
            $$('#seg-prlv-etat .seg-btn').forEach(x => x.classList.toggle('active', x === b));
            rendrePrelevements();
        }));
        let debPrlv;
        $('#prlv-recherche').addEventListener('input', e => {
            clearTimeout(debPrlv);
            debPrlv = setTimeout(() => { state.ui.prlvRecherche = e.target.value; rendrePrelevements(); }, 250);
        });
        $('#btn-prlv-export').addEventListener('click', exporterApprenants);

        // ── Navigation ──
        $$('.nav-tab').forEach(t => t.addEventListener('click', () => ouvrirOnglet(t.dataset.tab)));
        $('#nav-logo-home').addEventListener('click', () => ouvrirOnglet('dashboard'));

        // ── Filtres ──
        $('#date-select-all').addEventListener('click', () => { state.filtres.mois = null; state.ui.page = 1; rendreBoutonsMois(); rendreTout(); });
        $('#date-select-none').addEventListener('click', () => { state.filtres.mois = new Set(); state.ui.page = 1; rendreBoutonsMois(); rendreTout(); });
        $('#date-select-12').addEventListener('click', () => {
            state.filtres.mois = new Set(state.moisDispo.slice(-12));
            state.ui.page = 1; rendreBoutonsMois(); rendreTout();
        });

        $$('#seg-base-mois .seg-btn').forEach(b => b.addEventListener('click', () => {
            state.filtres.baseMois = b.dataset.base;
            majSegments();
            majMoisDisponibles(false);
            state.ui.page = 1;
            rendreTout();
        }));

        $$('#seg-perimetre .seg-btn').forEach(b => b.addEventListener('click', () => {
            state.filtres.perimetre = b.dataset.perimetre;
            majSegments();
            state.ui.page = 1;
            rendreTout();
        }));

        $$('#seg-unite-mois .seg-btn').forEach(b => b.addEventListener('click', () => {
            state.ui.uniteMois = b.dataset.unite;
            $$('#seg-unite-mois .seg-btn').forEach(x => x.classList.toggle('active', x === b));
            rendreTout();
        }));
        $$('#seg-flux-unite .seg-btn').forEach(b => b.addEventListener('click', () => {
            state.ui.fluxUnite = b.dataset.unite;
            $$('#seg-flux-unite .seg-btn').forEach(x => x.classList.toggle('active', x === b));
            rendreTout();
        }));
        $$('#seg-dso-methode .seg-btn').forEach(b => b.addEventListener('click', () => {
            state.ui.dsoMethode = b.dataset.methode;
            $$('#seg-dso-methode .seg-btn').forEach(x => x.classList.toggle('active', x === b));
            rendreTout();
        }));
        $$('#seg-histo-unite .seg-btn').forEach(b => b.addEventListener('click', () => {
            state.ui.histoUnite = b.dataset.unite;
            $$('#seg-histo-unite .seg-btn').forEach(x => x.classList.toggle('active', x === b));
            rendreTout();
        }));
        $$('#seg-treemap-dim .seg-btn').forEach(b => b.addEventListener('click', () => {
            state.ui.treemapDim = b.dataset.dim;
            $$('#seg-treemap-dim .seg-btn').forEach(x => x.classList.toggle('active', x === b));
            rendreTout();
        }));
        $$('#seg-repartition .seg-btn').forEach(b => b.addEventListener('click', () => {
            state.ui.repartitionDims = b.dataset.dims;
            state.ui.repartitionOuverts = new Set();
            $$('#seg-repartition .seg-btn').forEach(x => x.classList.toggle('active', x === b));
            rendreTout();
        }));
        $('#btn-repartition-toggle').addEventListener('click', () => {
            const s = state.ui.repartitionOuverts;
            if (s.size) { s.clear(); $('#btn-repartition-toggle').textContent = 'Tout déplier'; }
            else {
                const dims = state.ui.repartitionDims.split(',').map(k => DIMENSIONS[k]).filter(Boolean);
                (function collecter(noeuds) {
                    for (const n of noeuds) { if (n.enfants.length) { s.add(n.chemin); collecter(n.enfants); } }
                })(X.repartitionMontants(facturesFiltrees(), dims));
                $('#btn-repartition-toggle').textContent = 'Tout replier';
            }
            rendreTout();
        });
        $$('#seg-unite-recup .seg-btn').forEach(b => b.addEventListener('click', () => {
            state.ui.uniteRecup = b.dataset.unite;
            $$('#seg-unite-recup .seg-btn').forEach(x => x.classList.toggle('active', x === b));
            rendreTout();
        }));
        $$('#seg-unite-heat .seg-btn').forEach(b => b.addEventListener('click', () => {
            state.ui.uniteHeat = b.dataset.unite;
            $$('#seg-unite-heat .seg-btn').forEach(x => x.classList.toggle('active', x === b));
            rendreTout();
        }));
        $$('#seg-aging-dim .seg-btn').forEach(b => b.addEventListener('click', () => {
            state.ui.agingDim = b.dataset.dim;
            $$('#seg-aging-dim .seg-btn').forEach(x => x.classList.toggle('active', x === b));
            rendreTout();
        }));

        const dateRef = $('#date-ref');
        dateRef.value = toISO(state.filtres.dateRef);
        dateRef.addEventListener('change', () => {
            const d = R.parseDate(dateRef.value);
            if (!d) return;
            state.filtres.dateRef = d;
            recalculer({ conserverPeriode: true });
        });

        let debounce;
        $('#search-input').addEventListener('input', e => {
            clearTimeout(debounce);
            debounce = setTimeout(() => {
                state.filtres.recherche = e.target.value;
                state.ui.page = 1;
                rendreTout();
            }, 250);
        });

        $('#btn-reset-filters').addEventListener('click', reinitialiserFiltres);

        $('#page-size').addEventListener('change', e => {
            state.ui.pageSize = parseInt(e.target.value, 10) || 50;
            state.ui.page = 1;
            rendreTout();
        });

        // ── Actions de la barre supérieure ──
        $('#btn-export-xlsx').addEventListener('click', exporterExcel);
        $('#btn-export-table').addEventListener('click', exporterExcel);
        $('#btn-export-pdf').addEventListener('click', () => window.print());
        $('#btn-refresh').addEventListener('click', async () => {
            if (state.token && state.boards.some(b => b.actif && !String(b.id).startsWith('file:'))) {
                await chargerBoardsActifs();
            } else {
                ouvrirOnglet('donnees');
                U.toast('Connectez-vous à Monday ou réimportez vos fichiers pour actualiser.', 'info');
            }
        });

        // ── Onglet Données ──
        $('#btn-settings-connect').addEventListener('click', async () => {
            const token = $('#settings-token').value.trim();
            if (await connecterMonday(token)) await chargerListeBoards();
        });
        $('#btn-settings-forget').addEventListener('click', async () => {
            state.token = ''; state.compte = null;
            $('#settings-token').value = ''; $('#monday-token').value = '';
            await S.set(S.KEYS.settings, { token: '', options: state.options });
            $('#settings-monday-status').className = 'connect-status';
            $('#settings-monday-status').textContent = 'Jeton effacé de ce poste.';
            U.toast('Jeton oublié.', 'info');
        });
        $('#btn-boards-refresh').addEventListener('click', chargerListeBoards);
        $('#btn-boards-load').addEventListener('click', chargerBoardsActifs);

        $('#boards-table').addEventListener('click', (e) => {
            const b = e.target.closest('[data-sans-echeance]');
            if (b) montrerSansEcheance(b.dataset.sansEcheance);
        });

        $('#chaine-traitement').addEventListener('click', (e) => {
            const l = e.target.closest('[data-chaine]');
            if (!l) return;
            if (l.dataset.chaine === 'doublons') montrerDoublons('attendus');
            if (l.dataset.chaine === 'doublons-op') montrerDoublons('op');
            if (l.dataset.chaine === 'doublons-payees') montrerDoublons('payees');
        });
        $('#mapping-board-select').addEventListener('change', e => {
            state.ui.mappingBoardId = e.target.value;
            rendreTableMapping();
        });

        const opt = (sel, cle, recalc) => $(sel).addEventListener('change', async e => {
            state.options[cle] = e.target.checked;
            await sauverReglages();
            if (recalc) recalculer({ conserverPeriode: true }); else rendreTout();
        });
        opt('#opt-prefere-monday', 'prefereEcheanceMonday', true);
        opt('#opt-masquer-technique', 'masquerTechnique', false);
        $('#opt-masquer-technique').addEventListener('change', rendreExclusions);
        opt('#opt-payees-hors-portefeuille', 'payeesHorsPortefeuille', true);
        $('#opt-actualisation-auto').addEventListener('change', async e => {
            state.options.actualisationAuto = parseInt(e.target.value, 10) || 0;
            await sauverReglages();
            programmerActualisation();
        });
        $('#opt-actualiser-demarrage').addEventListener('change', async e => {
            state.options.actualiserAuDemarrage = e.target.checked;
            await sauverReglages();
        });

        $('#btn-clear-data').addEventListener('click', async () => {
            U.modal('Effacer les factures ?', '<p>Les factures enregistrées sur ce poste seront supprimées. Les tableaux, règles et réglages sont conservés.</p>', [
                { label: 'Annuler' },
                {
                    label: 'Effacer', primary: true, onClick: async () => {
                        state.brutes = []; state.factures = [];
                        await S.set(S.KEYS.factures, []);
                        recalculer();
                        U.toast('Factures effacées.', 'info');
                        montrerEcran('welcome');
                    },
                },
            ]);
        });

        $('#btn-clear-all').addEventListener('click', () => {
            U.modal('Tout effacer ?', '<p>Factures, tableaux, correspondances de colonnes, règles personnalisées et jeton Monday seront supprimés de ce poste.</p>', [
                { label: 'Annuler' },
                {
                    label: 'Tout effacer', primary: true, onClick: async () => {
                        await S.clearAll();
                        location.reload();
                    },
                },
            ]);
        });

        // ── Aide ──
        $('#btn-aide').addEventListener('click', () => {
            const actif = document.body.classList.toggle('aide');
            $('#btn-aide').classList.toggle('actif', actif);
            S.set('rec_aide', actif).catch(() => {});
        });

        // ── Règles ──
        $('#btn-edit-rules').addEventListener('click', ouvrirEditeurRegles);

        // ── Mise en page ──
        window.addEventListener('resize', mesurerNavbar);

        // ── Modale ──
        $('#modal-close').addEventListener('click', U.closeModal);
        $('#modal-overlay').addEventListener('click', e => { if (e.target.id === 'modal-overlay') U.closeModal(); });
        document.addEventListener('keydown', e => { if (e.key === 'Escape') U.closeModal(); });
    }

    /** La barre de filtres se cale sous la navbar, dont la hauteur varie. */
    function mesurerNavbar() {
        const nav = document.querySelector('#app-screen .navbar');
        if (!nav) return;
        const h = nav.offsetHeight;
        if (h) document.documentElement.style.setProperty('--nav-h', h + 'px');
    }

    /**
     * Au retour sur des données enregistrées, une actualisation de fond évite
     * de travailler sur une photo de la veille. Elle est sautée si les données
     * datent de moins d'un quart d'heure, pour ne pas solliciter Monday à
     * chaque ouverture d'onglet.
     */
    function actualiserAuDemarrageSiUtile() {
        if (!state.options.actualiserAuDemarrage) return;
        if (!state.token || !state.boards.some(b => b.actif && !String(b.id).startsWith('file:'))) return;

        const recent = state.derniereActualisation
            && (Date.now() - state.derniereActualisation.getTime()) < 15 * 60 * 1000;
        if (recent) return;

        chargerBoardsActifs({ silencieux: true });
    }

    function basculerVisibilite(sel) {
        const el = $(sel);
        el.type = el.type === 'password' ? 'text' : 'password';
    }

    function toISO(d) {
        if (!d) return '';
        return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    }

    /** Zone de dépôt cliquable + glisser-déposer. */
    function brancherZoneDepot(zoneSel, inputSel, handler) {
        const zone = $(zoneSel), input = $(inputSel);
        if (!zone || !input) return;
        zone.addEventListener('click', () => input.click());
        input.addEventListener('change', () => { if (input.files.length) handler([...input.files]); input.value = ''; });
        ['dragenter', 'dragover'].forEach(ev => zone.addEventListener(ev, e => {
            e.preventDefault(); e.stopPropagation(); zone.classList.add('dragover');
        }));
        ['dragleave', 'drop'].forEach(ev => zone.addEventListener(ev, e => {
            e.preventDefault(); e.stopPropagation(); zone.classList.remove('dragover');
        }));
        zone.addEventListener('drop', e => {
            const files = [...(e.dataTransfer.files || [])].filter(f => /\.(csv|xlsx|xls)$/i.test(f.name));
            if (files.length) handler(files);
            else U.toast('Formats acceptés : .csv, .xlsx, .xls', 'error');
        });
    }

    // ── Démarrage ──
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();

})();
