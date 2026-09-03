/* ==========================================================
   Liora — Suivi Recouvrement
   app.js — Orchestration : état, chargement, filtres, rendu

   v2.31.0 — 2 septembre 2026
   ========================================================== */

(function () {
    'use strict';

    // Version de l'application, affichée dans la barre supérieure et dans
    // l'onglet Données. Elle figure ainsi sur toute capture d'écran, ce qui
    // évite d'avoir à deviner quelle version tourne quand un chiffre surprend.
    const VERSION = '2.36.0';
    const VERSION_DATE = '2 septembre 2026';

    const R = window.LioraRules;
    const PR = window.LioraPrelevements;
    const S = window.LioraStore;
    const M = window.LioraMonday;
    const I = window.LioraIngest;
    const X = window.LioraMetrics;
    const U = window.LioraUI;
    const SE = window.LioraSellsy;
    const Z = window.LioraZoho;

    /**
     * La facturation, Sellsy d'abord puis la table Zoho figée.
     *
     * Zoho n'émet plus rien : ses factures sont closes et embarquées dans
     * l'application, il n'y a donc rien à recharger. Elles passent après
     * l'export Sellsy, qui est la source vivante : sur un numéro connu des
     * deux, c'est Sellsy qui l'emporte.
     */
    function lignesFacturation() {
        const vivant = (state.sellsy && state.sellsy.lignes) || [];
        return Z ? vivant.concat(Z.lignes()) : vivant;
    }
    const GL = window.LioraGrandLivre;
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

        // Contrôle d'exhaustivité Sellsy ↔ Monday
        sellsy: { lignes: [], mapping: {}, entetes: [], ignorees: 0, nomFichier: null, date: null },
        sellsyResultat: null,
        glLecture: null,
        glOuvertes: [],
        // Correspondances numéro de facture → financement, apprises des
        // extraits déjà qualifiés. C'est l'ancien grand livre classé qui fait
        // foi : une fois ce travail fait, il ne se refait plus.
        qualifRef: {},
        // Règles de classement écrites à la main : « le libellé contient ALMA
        // → financement personnel ». Elles valent pour tous les extraits.
        reglesClassement: [],
        glCreances: [],
        // Les écritures du grand livre à plat, gardées pour que le classement
        // descende sur les règlements et que les non rattachés se pointent.
        glLignes: [],
        glEcritures: null,
        glBalance: null,
        glComparaison: null,

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
            montantsExacts: true,         // balances âgées : à l'euro, pas en k€
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
            exclureTampon: false,
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
            agingSource: 'monday',
            glNiveau: 'financement',
            page: 1,
            pageSize: 50,
            tri: { key: 'retardJours', sens: 'desc' },
            triFin: { key: 'eurEnRetard', sens: 'desc' },
            mappingBoardId: null,
            onglet: 'dashboard',
            rangUnite: 'nb',
            prlvEtat: '',
            prlvFenetre: 0,
            prlvRecherche: '',
            triPrlv: { key: 'montantEchoue', sens: 'desc' },
            evoCatUnite: 'nb',
            cmpBase: 'precedent',
            evoDetail: false,
            reglOrigine: 'recouvrement',
            vueEcheance: 'retard',
            finDetail: null,
            sellsyVue: 'absentes',
            sellsyPage: 1,
            triSellsy: { key: 'montant', sens: 'desc' },
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

        try {
            state.glLecture = await S.get('rec_gl_lecture', null);
            state.glOuvertes = (await S.get('rec_gl_ouvertes', [])) || [];
            state.qualifRef = (await S.get('rec_qualif_ref', {})) || {};
            state.reglesClassement = (await S.get('rec_regles_classement', [])) || [];
            state.glLignes = ((await S.get('rec_gl_lignes', [])) || [])
                .map(l => ({ ...l, date: l.date ? R.parseDate(l.date) : null }));
        } catch { /* ignore */ }

        try {
            const sellsy = revivreSellsy(await S.get(S.KEYS.sellsy, null));
            if (sellsy && sellsy.lignes.length) state.sellsy = sellsy;
        } catch (e) { console.warn('[Recouvrement] Rechargement Sellsy impossible', e); }

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

        // L'export Sellsy comble les vides de Monday — montants à zéro, dates
        // de facture absentes — avant tout calcul d'échéance, qui en dépend.
        // La table Zoho figée compte comme une source de facturation : les
        // factures « FA-… » qu'elle porte n'existent plus ailleurs.
        const facturation = lignesFacturation();
        state.sellsyStats = facturation.length
            ? I.appliquerSellsy(consolidees, facturation)
            : null;

        I.enrichir(consolidees, {
            dateRef: state.filtres.dateRef,
            rules: state.rules,
            prefereEcheanceMonday: state.options.prefereEcheanceMonday,
            financementsManuels: state.financementsManuels,
        });

        if (state.options.payeesHorsPortefeuille) consolidees = consolidees.filter(f => !f.paye);

        state.factures = consolidees;
        // Le contrôle Sellsy se lit sur les factures fraîchement consolidées :
        // un rechargement de Monday doit refermer les écarts qu'il a corrigés.
        recalculerSellsy();
        recalculerBalanceGL();
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
        majResumePeriode();
    }

    /** La période retenue, en une ligne, quand la liste des mois est repliée. */
    function majResumePeriode() {
        const el = $('#periode-resume');
        if (!el) return;
        const dispo = state.moisDispo || [];
        const sel = state.filtres.mois ? [...state.filtres.mois].sort() : dispo;
        if (!dispo.length) { el.textContent = ''; return; }
        el.textContent = !state.filtres.mois
            ? `tous les mois (${U.moisLabel(dispo[0], true)} → ${U.moisLabel(dispo[dispo.length - 1], true)})`
            : sel.length === 0 ? 'aucun mois retenu'
            : sel.length === 1 ? U.moisLabel(sel[0])
            : `${U.moisLabel(sel[0], true)} → ${U.moisLabel(sel[sel.length - 1], true)} · ${U.nombre(sel.length)} mois`;
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

        // Un nombre fixe de puces ne tient pas compte de la largeur des libellés
        // ni de celle de la fenêtre : « B2C-Entreprise / Corporate Alternance »
        // occupe trois fois « AIF ». On les pose toutes, puis on masque celles
        // qui débordent de la ligne — voir ajusterChipsFinancements.
        const tousVisibles = !!state.ui.finChipsTout;
        const montres = cles;

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

        const plus = document.createElement('button');
        plus.className = 'chip chip-plus';
        plus.dataset.plus = '1';
        plus.textContent = tousVisibles ? '− réduire' : '+ autres';
        plus.addEventListener('click', () => {
            state.ui.finChipsTout = !state.ui.finChipsTout;
            rendreChipsFinancements();
        });
        c.appendChild(plus);

        if (sel && sel.size) {
            const raz = document.createElement('button');
            raz.className = 'chip chip-plus';
            raz.textContent = 'Tous';
            raz.addEventListener('click', () => {
                state.filtres.financements = null; state.ui.page = 1; rendreTout();
            });
            c.appendChild(raz);
        }

        c.classList.toggle('chips-une-ligne', !tousVisibles);
        // Après la mise en page, sans quoi les largeurs ne sont pas connues.
        requestAnimationFrame(ajusterChipsFinancements);
    }

    /**
     * Ne garder qu'une ligne de puces.
     *
     * Le nombre de puces affichables dépend de la longueur des libellés et de
     * la largeur de la fenêtre : il se mesure, il ne se devine pas. Les puces
     * sont posées, puis celles qui débordent de la première ligne sont
     * masquées ; le bouton « + N autres » annonce le reste. Une puce
     * sélectionnée reste visible, sans quoi le filtre actif disparaîtrait.
     */
    function ajusterChipsFinancements() {
        const c = $('#chips-financements');
        if (!c || !c.children.length) return;

        const plus = c.querySelector('[data-plus]');
        const puces = [...c.children].filter(e => e !== plus && !e.classList.contains('chip-plus'));
        puces.forEach(e => { e.hidden = false; });
        if (plus) plus.hidden = true;
        if (state.ui.finChipsTout) return;

        const dispo = c.clientWidth;
        if (!dispo) return;                      // pas encore mis en page

        const style = getComputedStyle(c);
        const espace = parseFloat(style.columnGap || style.gap || '8') || 8;

        // On réserve la place du bouton « + N autres » dès qu'il en faudra un.
        if (plus) { plus.hidden = false; plus.textContent = '+ 0 autres'; }
        const largeurPlus = plus ? plus.getBoundingClientRect().width + espace : 0;

        let cumul = 0, caches = 0, deborde = false;
        for (const e of puces) {
            const l = e.getBoundingClientRect().width;
            const garde = e.classList.contains('active') && state.filtres.financements
                && state.filtres.financements.size;
            const reste = dispo - (deborde ? 0 : largeurPlus);
            if (!deborde && cumul + l <= reste) { cumul += l + espace; continue; }
            if (garde) { cumul += l + espace; continue; }   // le filtre actif reste visible
            deborde = true;
            e.hidden = true; caches++;
        }

        if (plus) {
            plus.hidden = caches === 0;
            plus.textContent = `+ ${U.nombre(caches)} autre${caches > 1 ? 's' : ''}`;
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
        // « Annulée par avoir » n'est pas un état du portefeuille : la créance
        // en est sortie. Sa puce se coche donc à part, et elle est éteinte par
        // défaut — sans quoi décocher « En retard » ramènerait au passage les
        // annulées, que personne n'a demandées.
        const ETAT_AVOIR = 'Annulée par avoir';
        const etats = ['En retard', 'Non échue', 'Payée en retard', 'Payée', 'Échéance inconnue'];
        c.innerHTML = '';
        for (const e of etats.concat([ETAT_AVOIR])) {
            const avoir = e === ETAT_AVOIR;
            const b = document.createElement('button');
            const actif = avoir
                ? !!(state.filtres.etats && state.filtres.etats.has(ETAT_AVOIR))
                : (!state.filtres.etats || state.filtres.etats.has(e));
            b.className = 'chip chip-etat ' + U.etatClass(e) + (actif ? ' active' : '');
            b.title = avoir
                ? 'Soldées par un avoir : elles ont quitté le portefeuille et ne comptent '
                  + 'ni dans l’encours ni dans les taux. Cochez pour les faire réapparaître.'
                : '';
            const n = state.factures.filter(f => f.etat === e).length;
            b.innerHTML = U.escapeHtml(e) + (n ? ` <span class="chip-count">${U.nombre(n)}</span>` : '');
            b.addEventListener('click', () => {
                let set = state.filtres.etats;
                if (!set) set = new Set(etats);
                if (set.has(e)) set.delete(e); else set.add(e);
                // Retour au filtre neutre quand la sélection redevient
                // exactement le portefeuille — l'avoir n'en fait pas partie.
                const neutre = set.size === etats.length && etats.every(x => set.has(x));
                state.filtres.etats = (neutre || set.size === 0) ? null : set;
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
        if (f.exclureTampon) add('Tampon exclu', () => { f.exclureTampon = false; majSegments(); });

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
        f.exclureTampon = false;
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
        $$('#seg-tampon .seg-btn').forEach(b =>
            b.classList.toggle('active',
                (b.dataset.tampon === 'exclure') === !!state.filtres.exclureTampon));
        rendreAideTampon();
    }

    /**
     * Rappelle combien de factures sont passées par le tampon, pour que le choix
     * « Incluses / Exclues » se fasse en connaissance de cause.
     */
    function rendreAideTampon() {
        const el = $('#aide-tampon');
        if (!el) return;
        const n = state.factures.filter(f => f.enTampon).length;
        const base = 'Le sas d\'attente avant le circuit : aucune relance n\'y est faite. '
            + 'Les exclure montre le travail réellement fourni par ADV et le recouvrement.';
        el.textContent = n ? base + ' ' + U.nombre(n) + ' facture' + (n > 1 ? 's' : '') + ' concernée'
            + (n > 1 ? 's' : '') + '.' : base;
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
        rendreAideTampon();
        rendreFiltresActifs();
        majBadgesPeriode(data);

        switch (state.ui.onglet) {
            case 'dashboard':    rendreDashboard(data); break;
            case 'aging':        rendreAging(data); rendreAgingSource(); rendreBoutonsPrecision(); break;
            case 'financements': rendreFinancements(data); break;
            case 'factures':     rendreFactures(data); break;
            case 'prelevements': rendrePrelevements(); break;
            case 'sellsy':       rendreSellsy(); break;
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
        // Le groupe central se lit de deux façons : ce qui est en retard, ou ce
        // qui n'est pas encore échu. Les libellés et l'aide suivent la bascule.
        rendreGroupeEcheance(v);
        const nonEchu = state.ui.vueEcheance === 'nonEchu';

        // Le sous-titre disait « X déjà réglés en retard » juste sous le montant
        // en retard, ce qui laissait croire que ce montant en faisait partie.
        // Il n'en fait pas partie : ce KPI ne compte que l'échu impayé.
        $('#kpi-euros-retard').textContent = U.euros(nonEchu ? v.eurosNonEchues : v.eurosEnRetard);
        $('#kpi-euros-retard-sub').textContent = nonEchu
            ? 'émises, échéance à venir' : 'échues et toujours impayées';

        $('#kpi-nb-retard').textContent = U.nombre(nonEchu ? v.nbNonEchues : v.nbEnRetard);
        $('#kpi-nb-retard-sub').textContent = `sur ${U.nombre(v.total)} factures · `
            + U.pourcent(nonEchu ? X.pct(v.nbNonEchues, v.total) : v.tauxNb);

        // Un pourcentage sans son dénominateur ne veut rien dire : celui-ci se
        // calcule sur le total facturé, pas sur le reste à encaisser, et les
        // deux lectures donnent des chiffres très différents.
        $('#kpi-taux-euros').textContent =
            U.pourcent(nonEchu ? v.tauxPortefeuilleNonEchu : v.tauxEuros);
        $('#kpi-taux-nb-sub').textContent =
            `${U.eurosCourt(nonEchu ? v.eurosNonEchues : v.eurosEnRetard)} sur ${U.eurosCourt(v.totalEuros)} facturés`;

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
        rendreQualifB2C(data);
        rendreReglements(data);


        // ── Classements ──
        rendreTopClients(X.topClients(data, 12));
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

        // Un clic ouvre la répartition par financement plutôt que la liste
        // brute : le chiffre global ne dit pas de quels dispositifs il est
        // fait, et c'est la première question qu'on se pose devant une tuile.
        $$('[data-etats]', el).forEach(b => b.addEventListener('click', () => {
            const etats = b.dataset.etats.split('|');
            const titre = $('.recup-label', b).textContent.trim();
            rendreApresClic(() => montrerRepartitionEtat(etats, titre));
        }));
    }

    /**
     * Répartition d'un état du portefeuille par type de financement.
     *
     * « 42 % réglé en recouvrement » ne dit pas si l'effort a porté sur du CPF
     * ou du B2B. Chaque ligne reste cliquable pour descendre aux factures.
     */
    function montrerRepartitionEtat(etats, titre) {
        const jeu = new Set(etats);
        const lignes = facturesFiltrees().filter(f => jeu.has(f.etat));
        const eur = state.ui.uniteRecup === 'euros';

        const parFin = new Map();
        for (const f of lignes) {
            const cle = f.financement || 'INCONNU';
            let l = parFin.get(cle);
            if (!l) {
                l = { cle, label: R.getRule(cle, state.rules).label, nb: 0, euros: 0, encours: 0 };
                parFin.set(cle, l);
            }
            l.nb++;
            l.euros += f.montant || 0;
            l.encours += f.encours || 0;
        }
        const rows = [...parFin.values()].sort((a, b) => (eur ? b.euros - a.euros : b.nb - a.nb));
        const totalNb = X.sum(rows, r => r.nb), totalEur = X.sum(rows, r => r.euros);

        const corps = U.table([
            { key: 'label', label: 'Financement' },
            { key: 'nb', label: 'Factures', align: 'right', format: U.nombre },
            { key: 'euros', label: 'Montant', align: 'right', format: U.euros },
            { key: 'part', label: 'Part', align: 'right',
              format: (v, r) => U.barre(eur ? r.euros : r.nb, eur ? totalEur : totalNb, U.couleurs.accent)
                + ' ' + U.pourcent(eur
                    ? (totalEur ? r.euros / totalEur * 100 : null)
                    : (totalNb ? r.nb / totalNb * 100 : null), 1) },
        ], rows, {
            vide: 'Aucune facture dans cet état.',
            total: { label: 'Total', nb: U.nombre(totalNb), euros: U.euros(totalEur) },
            onRowClick: true,
        });

        const el = U.modal(`${titre} — ${U.nombre(totalNb)} factures · ${U.euros(totalEur)}`, corps,
            [{ label: 'Voir toutes les factures', onClick: () => {
                state.filtres.etats = new Set(etats);
                state.filtres.financements = null;
                state.ui.page = 1;
                ouvrirOnglet('factures');
            } }, { label: 'Fermer', primary: true }]);

        U.bindTable(el, rows, {
            onRowClick: r => {
                state.filtres.etats = new Set(etats);
                state.filtres.financements = new Set([r.cle]);
                state.ui.page = 1;
                U.closeModal();
                ouvrirOnglet('factures');
            },
        });
    }

    /**
     * Ce que Monday annonce et que l'application n'a pas reçu.
     *
     * L'API ne dit pas quelles lignes manquent — seulement combien. La seule
     * source capable de les nommer est la facturation : une facture émise dans
     * Sellsy ou Zoho et absente de Monday est identifiée par son numéro. Le
     * clic renvoie donc là où la réponse existe, plutôt que d'afficher un
     * nombre sans suite.
     */
    function montrerManquantes(nomBoard) {
        const b = state.boards.find(x => x.name === nomBoard);
        if (!b) return;
        const nb = Math.max(0, (b.itemsCount || 0) - (b.charge || 0));
        const aLaFacturation = !!(state.sellsyResultat && state.sellsyResultat.absentes.length);

        U.modal(`${nomBoard} — ${U.nombre(nb)} lignes annoncées mais non reçues`, `
            <p>Monday annonce <strong>${U.nombre(b.itemsCount || 0)} éléments</strong> sur ce tableau ;
            l'application en a reçu <strong>${U.nombre(b.charge || 0)}</strong>. L'écart vient presque
            toujours d'un chargement interrompu — connexion coupée, session expirée, limite d'API
            atteinte.</p>
            <p><strong>L'API Monday ne dit pas lesquelles manquent</strong>, seulement combien. Deux
            façons de le savoir :</p>
            <ul>
                <li><strong>Recharger le tableau</strong> — le plus simple : si l'écart disparaît,
                    il s'agissait bien d'un chargement incomplet.</li>
                <li><strong>Le contrôle de facturation</strong> — Sellsy et Zoho savent quelles
                    factures existent. L'onglet <em>Contrôle Sellsy</em> nomme celles qui ne sont sur
                    aucun tableau Monday${aLaFacturation
                        ? `, et il en a déjà trouvé <strong>${U.nombre(state.sellsyResultat.absentes.length)}</strong>`
                        : ' — chargez-y vos exports de facturation'}.</li>
            </ul>`,
            [
                { label: 'Recharger les tableaux', onClick: () => chargerBoardsActifs() },
                { label: 'Voir les factures absentes', onClick: () => {
                    state.ui.sellsyVue = 'absentes';
                    ouvrirOnglet('sellsy');
                } },
                { label: 'Fermer', primary: true },
            ]);
    }

    /** Rappels métier contextuels (OPCO sans recouvrement, retards côté ADV). */
    function rendreNoteperimetre(data, v) {
        const el = $('#scope-note');
        if (!el) return;
        const notes = [];

        // Avant toute lecture métier : le portefeuille est-il complet ? Un
        // tableau coché mais vide de données rend tous les chiffres faux sans
        // qu'aucun d'eux n'ait l'air anormal — sur un chargement interrompu,
        // seul le premier tableau était arrivé, et le tableau de bord
        // présentait un neuvième du portefeuille comme s'il était entier.
        const presents = new Set(state.factures.map(f => f.board));
        const vides = state.boards.filter(b => b.actif && b.role !== 'technique' && b.role !== 'ignore'
            && !presents.has(b.name));
        if (vides.length && state.boards.some(b => presents.has(b.name))) {
            const attendues = X.sum(vides, b => b.itemsCount || 0);
            notes.push({
                ton: 'danger',
                titre: `${U.nombre(vides.length)} tableau${vides.length > 1 ? 'x' : ''} coché${vides.length > 1 ? 's' : ''} `
                    + `mais vide${vides.length > 1 ? 's' : ''} — tous les chiffres portent sur une partie du portefeuille`,
                texte: (attendues ? `${U.nombre(attendues)} factures y sont annoncées par Monday et ne sont pas là. ` : '')
                    + `${vides.map(b => b.name).join(', ')}. Un chargement interrompu — connexion, session `
                    + `expirée, limite d'API — laisse ce genre de trou sans rien afficher d'anormal.`,
                action: { label: 'Recharger les tableaux', fn: () => chargerBoardsActifs() },
            });
        }

        // Le filtre « Étape du circuit » écarte aussi les factures déjà réglées
        // dont l'origine est ailleurs : le tableau des factures payées conserve
        // le groupe d'où venait chaque facture, et une facture réglée qui n'est
        // jamais passée par l'étape retenue sort du périmètre. D'où un « réglé »
        // presque vide et un flux sans encaissements, sans que rien ne le dise.
        const toutesEtapes = R.SOURCES.length;
        const retenues = state.filtres.sources ? state.filtres.sources.size : toutesEtapes;
        if (retenues < toutesEtapes) {
            const complet = X.filtrer(state.factures, {
                ...state.filtres, sources: null,
                masquerTechnique: state.options.masquerTechnique,
            });
            const exclusReglees = complet.filter(f => f.paye).length - data.filter(f => f.paye).length;
            if (exclusReglees > 0) {
                const noms = [...state.filtres.sources]
                    .map(k => (R.SOURCES.find(x => x.key === k) || {}).label || k).join(', ');
                notes.push({
                    ton: 'info',
                    titre: `${U.nombre(exclusReglees)} factures déjà réglées sont exclues par le filtre d'étape`,
                    texte: `Vous ne regardez que « ${noms} ». Une facture réglée reste rattachée à `
                        + `l'étape d'où elle venait : celles passées par une autre étape sortent du `
                        + `périmètre, ce qui vide les indicateurs de règlement et le flux des `
                        + `encaissements. Rallumez les autres étapes pour voir tout ce qui est rentré.`,
                    action: { label: 'Toutes les étapes', fn: () => {
                        state.filtres.sources = new Set(R.SOURCES.map(x => x.key));
                        state.ui.page = 1;
                        rendreTout();
                    } },
                });
            }
        }

        // Elles ne sont plus dans `data` — elles ont quitté le portefeuille —
        // mais elles ne doivent pas disparaître sans un mot : c'est du chiffre
        // d'affaires annulé, pas du chiffre d'affaires encaissé.
        const annulees = state.factures.filter(f => f.etat === 'Annulée par avoir');
        if (annulees.length) {
            notes.push({
                ton: 'info',
                titre: `${U.nombre(annulees.length)} factures annulées par avoir, hors portefeuille`,
                texte: `${U.euros(X.sum(annulees, f => f.montant))} de factures que le grand livre solde `
                    + `par un avoir : la créance a disparu sans qu'un euro rentre. Elles ne sont ni à `
                    + `relancer ni encaissées, donc elles ne comptent ni dans l'encours, ni dans les `
                    + `taux de recouvrement, ni dans la balance âgée.`,
                action: { label: 'Voir ces factures', fn: () => {
                    state.filtres.etats = new Set(['Annulée par avoir']);
                    state.ui.page = 1;
                    ouvrirOnglet('factures');
                } },
            });
        }

        // Le filtre d'état rend certaines tuiles tautologiques : avec « En
        // retard » seul, « Encaissé » vaut nécessairement zéro et « % en
        // recouvrement » nécessairement cent. Le dire, plutôt que de laisser
        // lire un portefeuille entièrement impayé là où il ne s'agit que d'une
        // vue filtrée.
        const etatsFiltres = state.filtres.etats;
        if (etatsFiltres && etatsFiltres.size) {
            const REGLES = ['Payée', 'Payée en retard'];
            const NON_ECHUES = ['Non échue'];
            const sansRegle = REGLES.every(e => !etatsFiltres.has(e));
            const sansNonEchue = NON_ECHUES.every(e => !etatsFiltres.has(e));
            if (sansRegle || sansNonEchue) {
                const complet = X.filtrer(state.factures, {
                    ...state.filtres, etats: null,
                    masquerTechnique: state.options.masquerTechnique,
                });
                const cachees = complet.length - data.length;
                const reglees = complet.filter(f => f.paye).length;
                const nonEchues = complet.filter(f => f.etat === 'Non échue').length;
                const noms = [...etatsFiltres].join(', ');
                notes.push({
                    ton: 'info',
                    titre: `Vous ne regardez que « ${noms} » — ${U.nombre(cachees)} factures sont hors de cette vue`,
                    texte: `Le périmètre complet en compte ${U.nombre(complet.length)}, dont `
                        + `${U.nombre(reglees)} réglées et ${U.nombre(nonEchues)} pas encore échues. `
                        + (sansRegle ? `Aucune facture réglée ne passe ce filtre : « Encaissé » vaut donc `
                            + `nécessairement zéro et « % en recouvrement » cent pour cent — ce n'est pas `
                            + `un constat, c'est le filtre. ` : '')
                        + (sansNonEchue ? `Les factures pas encore échues en sont exclues aussi : le nombre `
                            + `d'impayés affiché est celui des seules créances déjà exigibles. ` : '')
                        + `Retirez le filtre d'état pour voir le portefeuille entier.`,
                    action: { label: 'Tous les états', fn: () => {
                        state.filtres.etats = null;
                        state.ui.page = 1;
                        rendreTout();
                    } },
                });
            }
        }

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
                // Un jeu de sources vide vaut « aucun filtre » : retirer la
                // dernière source affichait tout le portefeuille au lieu d'en
                // retirer les OPCO. On nomme alors explicitement les autres.
                action: { label: 'Exclure les OPCO', fn: () => {
                    const s = state.filtres.sources;
                    s.delete('opco');
                    if (!s.size) state.filtres.sources = new Set(
                        R.SOURCES.map(x => x.key).filter(k => k !== 'opco'));
                    state.ui.page = 1;
                    rendreTout();
                } },
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
        // « Étape » ne se lit pas dans le groupe Monday mais dans la colonne
        // « Qualification recouvrement avec basculement », que l'équipe
        // renseigne dossier par dossier. Le groupe reste disponible sous sa
        // propre dimension : les deux ne disent pas la même chose.
        etape:       { key: 'etape',       titre: 'Qualification recouvrement',
                       fn: f => f.qualifBascule || f.qualifRecouvrement || '(non qualifiée)' },
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
        const base = state.ui.cmpBase || 'precedent';
        $$('#seg-cmp-base .seg-btn').forEach(b => b.classList.toggle('active', b.dataset.base === base));

        const cmp = X.comparaisonMensuelle(rows, R.monthKey(state.filtres.dateRef), base);
        if (!cmp) { el.innerHTML = '<p class="fv-hint">Deux mois au minimum sont nécessaires pour comparer.</p>'; $('#month-compare-title').textContent = ''; return; }
        if (cmp.indisponible) {
            el.innerHTML = `<p class="fv-hint">${U.moisLabel(cmp.moisCible)} n'est pas dans l'historique
                chargé : la comparaison d'une année sur l'autre n'est pas possible pour
                ${U.moisLabel(cmp.mois)}.</p>`;
            $('#month-compare-title').textContent = '';
            return;
        }

        $('#month-compare-title').textContent = `${U.moisLabel(cmp.mois)} vs ${U.moisLabel(cmp.moisPrec)}`
            + (base === 'annee' ? ' — un an plus tôt' : '');

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
     * Le groupe central de la vue d'ensemble, à deux lectures.
     *
     * Ce qui est en retard répond au métier du recouvrement ; ce qui n'est pas
     * encore échu répond à celui de la trésorerie — combien va rentrer, et
     * quand. Les deux se lisent sur les mêmes trois cases, une bascule passant
     * de l'une à l'autre, plutôt que de doubler la vue d'ensemble.
     */
    function rendreGroupeEcheance(v) {
        const nonEchu = state.ui.vueEcheance === 'nonEchu';
        const t = $('#kpi-groupe-titre');
        if (t) t.textContent = nonEchu ? "Ce qui n'est pas encore échu" : 'Ce qui est en recouvrement';

        const textes = nonEchu ? {
            l1: 'Montant pas encore échu',
            a1: "Montant des factures déjà émises dont l'échéance, calculée selon les règles de "
              + "financement, <strong>n'est pas encore atteinte</strong>. C'est ce qui doit rentrer "
              + 'sans avoir à le réclamer — la lecture trésorerie du portefeuille.',
            l2: 'Factures pas encore échues',
            a2: "Nombre de factures émises dont l'échéance est à venir. Elles ne sont ni en retard "
              + 'ni réglées : elles attendent simplement leur date.',
            l3: '% pas encore échu (€)',
            a3: 'Montant pas encore échu divisé par le <strong>total facturé</strong> de la période. '
              + 'Plus il est élevé, plus votre portefeuille est jeune.',
        } : {
            l1: 'Montant en retard',
            a1: "Montant des factures dont la date d'échéance, calculée selon les règles de "
              + "financement, est dépassée à la date d'arrêté <strong>et qui ne sont toujours pas "
              + "réglées</strong>. C'est l'argent que vous devez aller chercher. Les factures "
              + "finalement payées, mais en retard, n'y figurent pas : elles sont dans « Encaissé ».",
            l2: 'Factures en retard',
            a2: "Nombre de factures dont l'échéance calculée est dépassée et qui ne sont pas réglées, "
              + 'tous tableaux confondus.',
            l3: '% en recouvrement (€)',
            a3: 'Montant en retard divisé par le <strong>total facturé</strong> de la période. '
              + "À ne pas confondre avec la part du reste à encaisser qui est en retard : ce second "
              + 'pourcentage, plus élevé, figure sous « Reste à encaisser ».',
        };
        const poser = (n, label, aide) => {
            const l = $(`#aide-kpi-${n}-label`); if (l) l.textContent = label;
            const a2 = $(`#aide-kpi-${n}-texte`); if (a2) a2.innerHTML = aide;
        };
        poser(1, textes.l1, textes.a1);
        poser(2, textes.l2, textes.a2);
        poser(3, textes.l3, textes.a3);
    }

    // ══════════════════════════════════════════════
    //  Les qualifications du portefeuille B2C
    // ══════════════════════════════════════════════

    /**
     * Les quatre colonnes de qualification que porte le suivi B2C.
     *
     * Elles ne sont pas des champs de l'application : ce sont des listes de
     * choix tenues dans Monday, et c'est là que se lit le travail — pourquoi
     * une créance est bloquée, où elle en est, ce qu'en dit l'ADV. Le nom
     * exact varie d'un tableau à l'autre ; la reconnaissance se fait donc sur
     * un libellé normalisé.
     */
    const QUALIFS_B2C = [
        { cle: 'qualification generale',     titre: 'Qualification Générale' },
        { cle: 'statut creance',             titre: 'Statut créance' },
        { cle: 'groupe',                     titre: 'Groupe' },
        { cle: 'qualification recouvrement', titre: 'Qualification recouvrement' },
    ];

    /**
     * Répartition d'une colonne de qualification.
     *
     * Trois choses par valeur, parce que le nombre seul ne dit rien : combien
     * de factures et pour quel montant, ce qui en est déjà rentré — les mêmes
     * colonnes existent sur le tableau des factures payées, donc la part
     * réglée se lit —, et l'évolution des six derniers mois.
     */
    function repartitionQualif(data, cle, mois) {
        const champMois = state.filtres.baseMois === 'facture' ? 'moisFacture'
            : state.filtres.baseMois === 'paiement' ? 'moisPaiement' : 'moisEcheance';
        const index = new Map(mois.map((m, i) => [m, i]));
        const trouve = new Map();
        let nb = 0, euros = 0, sans = 0, sansEuros = 0;
        for (const f of data) {
            let v = null;
            for (const [k, val] of Object.entries(f.qualifs || {})) {
                if (R.norm(k) === cle) { v = val; break; }
            }
            // Une colonne de même nom peut porter une date sur un autre
            // tableau : « Fri Nov 20 2026 » n'est pas une qualification.
            if (typeof v === 'string' && /^[A-Z][a-z]{2} [A-Z][a-z]{2} \d{2} \d{4}/.test(v)) v = null;
            if (v == null || v === '') { sans++; sansEuros += f.montant || 0; continue; }
            let e = trouve.get(v);
            if (!e) { e = { label: v, nb: 0, euros: 0, nbPayees: 0, eurosPayees: 0,
                            serie: mois.map(() => 0), serieEuros: mois.map(() => 0) }; trouve.set(v, e); }
            e.nb++; e.euros += f.montant || 0;
            if (f.paye) { e.nbPayees++; e.eurosPayees += f.montant || 0; }
            const i = index.get(f[champMois]);
            if (i != null) { e.serie[i]++; e.serieEuros[i] += f.montant || 0; }
            nb++; euros += f.montant || 0;
        }
        return { lignes: [...trouve.values()], nb, euros, sans, sansEuros };
    }

    /** Les n derniers mois, celui de la date d'arrêté compris. */
    function derniersMoisSerie(n) {
        const d = state.filtres.dateRef || new Date();
        const out = [];
        for (let i = n - 1; i >= 0; i--) out.push(R.monthKey(new Date(d.getFullYear(), d.getMonth() - i, 1)));
        return out;
    }

    /** Une courbe de six points, en SVG, sans dépendance ni instance de graphique. */
    function etincelle(serie, couleur) {
        const max = Math.max(...serie, 1);
        const L = 92, H = 24, pas = serie.length > 1 ? L / (serie.length - 1) : 0;
        const pts = serie.map((v, i) => `${(i * pas).toFixed(1)},${(H - 2 - (v / max) * (H - 5)).toFixed(1)}`);
        const dernier = pts[pts.length - 1].split(',');
        return `<svg class="etincelle" viewBox="0 0 ${L} ${H}" width="${L}" height="${H}" aria-hidden="true">
            <polyline points="${pts.join(' ')}" fill="none" stroke="${couleur}" stroke-width="1.6"
                      stroke-linejoin="round" stroke-linecap="round" opacity=".85"></polyline>
            <circle cx="${dernier[0]}" cy="${dernier[1]}" r="2.2" fill="${couleur}"></circle>
        </svg>`;
    }

    /**
     * Les quatre colonnes de qualification, en classement plutôt qu'en camembert.
     *
     * Un camembert dit une part et rien d'autre. Ce qui se demande ici, c'est
     * combien, pour quel montant, ce qui est déjà rentré et si cela monte ou
     * descend — quatre lectures qu'une ligne porte sans peine : une barre pour
     * le poids, un fond vert pour la part encaissée, une courbe de six mois
     * pour la tendance, une pastille pour l'écart au mois précédent.
     */
    function rendreQualifB2C(data) {
        const bloc = $('#qualif-b2c');
        if (!bloc) return;
        const actif = state.filtres.perimetre === 'B2C';
        bloc.hidden = !actif;
        if (!actif) return;

        const unite = state.ui.qualifUnite || 'nb';
        $$('#seg-qualif-unite .seg-btn').forEach(b =>
            b.classList.toggle('active', b.dataset.unite === unite));
        const eur = unite === 'euros';
        const mois = derniersMoisSerie(12);
        const baseLabel = state.filtres.baseMois === 'facture' ? 'de facture'
            : state.filtres.baseMois === 'paiement' ? 'de paiement' : 'd’échéance';

        // Tout doit se lire sans mode d'emploi : chaque colonne porte son
        // titre, et la phrase d'aide dit en français ce que montre chaque
        // partie de la ligne.
        const hint = $('#qualif-b2c-hint');
        if (hint) hint.innerHTML = `Ces quatre colonnes viennent de Monday. Chaque ligne est une réponse
            possible, et vous montre combien de factures la portent.
            <span class="qualif-legende"><span class="pastille pastille-verte"></span> déjà payées
            <span class="pastille pastille-rouge"></span> encore dues</span>
            La courbe suit les 12 derniers mois (mois ${baseLabel}) et la flèche compare
            les 3 derniers mois aux 3 mois d'avant : rouge = il y en a plus qu'avant,
            vert = il y en a moins.`;

        const grille = $('#qualif-b2c-grid');
        grille.innerHTML = QUALIFS_B2C.map((q, i) => `
            <div class="chart-card qualif-card">
                <div class="chart-header"><h3>${U.escapeHtml(q.titre)}</h3></div>
                <span class="fv-hint" id="qualif-hint-${i}"></span>
                <div id="qualif-liste-${i}"></div>
            </div>`).join('');

        QUALIFS_B2C.forEach((q, i) => {
            const r = repartitionQualif(data, q.cle, mois);
            const sous = $('#qualif-hint-' + i);
            const liste = $('#qualif-liste-' + i);
            if (!r.lignes.length) {
                if (sous) sous.textContent = 'Cette colonne n’est renseignée sur aucune facture du périmètre.';
                liste.innerHTML = '<p class="qualif-vide">Aucune valeur</p>';
                return;
            }
            const valeur = l => eur ? l.euros : l.nb;
            const payee = l => eur ? l.eurosPayees : l.nbPayees;
            const tri = r.lignes.slice().sort((a, b) => valeur(b) - valeur(a));
            const gardees = tri.slice(0, 8);
            const reste = tri.slice(8);
            if (reste.length) gardees.push({
                label: `Autres (${reste.length} valeurs)`,
                nb: X.sum(reste, l => l.nb), euros: X.sum(reste, l => l.euros),
                nbPayees: X.sum(reste, l => l.nbPayees), eurosPayees: X.sum(reste, l => l.eurosPayees),
                serie: mois.map((_, k) => X.sum(reste, l => l.serie[k])),
                serieEuros: mois.map((_, k) => X.sum(reste, l => l.serieEuros[k])),
            });

            const total = eur ? r.euros : r.nb;
            const max = Math.max(...gardees.map(valeur), 1);
            if (sous) sous.textContent = `${U.nombre(r.nb)} factures renseignées`
                + (eur ? ` · ${U.euros(r.euros)}` : '')
                + (r.sans ? ` · ${U.nombre(r.sans)} sans valeur` : '');

            const entete = `<div class="qualif-ligne qualif-entete">
                <span>Réponse</span>
                <span>Poids · vert = payé</span>
                <span class="qualif-val">${eur ? 'Montant' : 'Factures'}</span>
                <span>12 derniers mois</span>
                <span class="qualif-ecart">Évolution</span>
            </div>`;
            liste.innerHTML = entete + gardees.map(l => {
                const v = valeur(l), p = payee(l);
                const part = total ? (v / total) * 100 : 0;
                const partPayee = v ? (p / v) * 100 : 0;
                const serie = eur ? l.serieEuros : l.serie;
                // Un mois contre le précédent ne dit rien à ce niveau de
                // détail : une valeur de qualification porte quelques factures
                // par mois, et l'écart n'est que du bruit. Trois mois contre
                // les trois d'avant tiennent debout.
                const somme = (a, b) => serie.slice(a, b).reduce((x, y) => x + y, 0);
                const ecart = somme(serie.length - 3) - somme(serie.length - 6, serie.length - 3);
                const sens = ecart > 0 ? 'hausse' : ecart < 0 ? 'baisse' : 'stable';
                const fleche = ecart > 0 ? '▲' : ecart < 0 ? '▼' : '=';
                const chiffre = eur ? U.eurosCourt(Math.abs(ecart)) : U.nombre(Math.abs(ecart));
                return `<div class="qualif-ligne" title="${U.escapeHtml(l.label)} — ${U.nombre(l.nb)} factures · ${U.euros(l.euros)} · ${U.nombre(l.nbPayees)} déjà encaissées · ${U.nombre(l.nb - l.nbPayees)} encore dues">
                    <span class="qualif-nom">${U.escapeHtml(l.label)}</span>
                    <span class="qualif-barre">
                        <span class="qualif-barre-fond" style="width:${(v / max) * 100}%">
                            <span class="qualif-barre-paye" style="width:${partPayee}%"></span>
                        </span>
                    </span>
                    <span class="qualif-val">${eur ? U.eurosCourt(v) : U.nombre(v)}
                        <span class="qualif-part">${U.pourcent(part, 0)}</span></span>
                    ${etincelle(serie, ecart >= 0 ? U.couleurs.retard : U.couleurs.paye)}
                    <span class="qualif-ecart qualif-${sens}">${fleche} ${ecart === 0 ? '—' : chiffre}</span>
                </div>`;
            }).join('');
        });
    }

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
            ? 'Encaissements après passage en recouvrement'
            : 'Encaissements sans passage en recouvrement';

        const enRetard = data.filter(f => f.etat === 'En retard');
        const enCours = { nb: enRetard.length, euros: X.sum(enRetard, f => f.montant) };

        const h = $('#regl-hint');
        if (h) h.innerHTML = (viaRecouv
            ? "Population : les factures <strong>encaissées</strong> qui étaient passées par le tableau "
              + "de recouvrement avant de l'être — c'est le groupe d'origine conservé dans "
              + "« 0.1. ALL - Factures payées » qui l'établit. Le recouvrement a donc obtenu leur règlement."
              : "Ces factures ont été payées sans jamais entrer dans le circuit de recouvrement : "
              + "<strong>Cela ne veut pas dire qu'elles ont été payées à l'heure</strong> : le compteur "
              + "« dont payées en retard » ci-dessous montre combien l'ont été après leur échéance, "
              + "sans qu'une relance ait été engagée. C'est une distinction de processus, pas de délai.")
            + (r.nbOrigineInconnue
                ? ` <strong>${U.nombre(r.nbOrigineInconnue)} factures réglées ne peuvent être attribuées</strong>,
                    faute de groupe d'origine renseigné dans « 0.1. ALL - Factures payées » : elles sont
                    hors de ce décompte.`
                : '')
            // Le compteur ne porte que sur ce qui est rentré. Une facture en
            // retard est en recouvrement — mais tant qu'elle n'est pas
            // encaissée, elle n'a pas sa place ici, et la lire comme « une
            // seule facture en recouvrement » serait un contresens. Le reste
            // à recouvrer est donc rappelé en regard.
            + (viaRecouv && enCours.nb
                ? ` <strong>Ce bloc ne compte que ce qui est rentré.</strong> À la même date,
                    <strong>${U.nombre(enCours.nb)} factures</strong> sont encore en retard —
                    donc en recouvrement — pour ${U.euros(enCours.euros)} : elles ne figurent pas
                    ici, faute d'avoir été encaissées.`
                : '');

        // Chaque tuile dit sur quoi elle est calculée : sans cela, « 416 payées
        // avant échéance » parmi des factures passées en recouvrement se lit
        // comme une contradiction, alors que c'est un signal — voir plus bas.
        $('#regl-kpi').innerHTML = [
            tuileDetail(U.nombre(r.nb), viaRecouv ? 'Factures récupérées' : 'Réglées hors recouvrement',
                U.euros(r.euros), viaRecouv ? U.couleurs.payeRetard : U.couleurs.paye,
                viaRecouv ? 'encaissées après être passées par le tableau de recouvrement'
                          : 'encaissées sans jamais y entrer', 'toutes'),
            tuileDetail(U.pourcent(r.partEuros, 1), 'Part des règlements',
                `${U.pourcent(r.partNb, 1)} en nombre`, U.couleurs.indigo,
                'part de cette population dans tout ce qui a été encaissé'),
            // La question posée à chaque fois : passer par le recouvrement ou
            // non ne dit rien du délai. Les deux sont donc affichés côte à côte.
            tuileDetail(U.nombre(r.nb - r.nbEnRetard), 'Payées avant échéance',
                U.euros(Math.max(0, r.euros - r.eurosEnRetard)), U.couleurs.paye,
                viaRecouv ? 'réglées avant leur date d’échéance calculée — cliquez pour les voir'
                          : 'réglées dans les délais, sans relance', 'avant'),
            tuileDetail(U.nombre(r.nbEnRetard), 'Payées après échéance',
                U.euros(r.eurosEnRetard), U.couleurs.retard,
                'réglées après leur date d’échéance calculée', 'apres'),
            tuileDetail(U.jours(r.retardMoyen), 'Retard moyen des retardataires',
                r.delaiMoyen != null ? `délai facture → règlement : ${U.jours(r.delaiMoyen)}` : '—',
                U.couleurs.nonEchue,
                'moyenne du seul groupe payé en retard, pas de l’ensemble'),
        ].join('');

        // Hors de la grille : dans une case de 215 px, l'explication s'étirait
        // sur quinze lignes d'un mot. Elle a sa place, en pleine largeur.
        const note = $('#regl-note');
        const avant = r.nb - r.nbEnRetard;
        if (note) {
            note.hidden = !(viaRecouv && avant > 0);
            note.innerHTML = (viaRecouv && avant > 0)
                ? `<p><strong>${U.nombre(avant)} factures passées par le recouvrement apparaissent
                   payées avant leur échéance.</strong> Vous avez raison de trouver ça contradictoire :
                   une facture n'entre en recouvrement qu'une fois échue. L'explication la plus probable
                   est la <strong>réémission après correction</strong> — la nouvelle date de facture
                   repousse l'échéance calculée après la date de règlement. Mais c'est une hypothèse :
                   <strong>ouvrez la tuile « Payées avant échéance » pour voir ces factures</strong> et
                   juger sur pièces.</p>`
                : '';
        }

        // Chaque tuile ouvre sa population : un chiffre qu'on ne peut pas
        // ouvrir ne se vérifie pas.
        $$('[data-regl]', $('#regl-kpi')).forEach(el => el.addEventListener('click', () => {
            rendreApresClic(() => montrerReglements(r, el.dataset.regl, viaRecouv));
        }));

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
                        label: viaRecouv ? 'Encaissé après relance' : 'Encaissé hors recouvrement',
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

    /**
     * Le format des cellules de balance âgée.
     *
     * Arrondi, un tableau de dix colonnes se lit d'un coup d'œil ; à l'euro,
     * il se recoupe avec la comptabilité. Les deux servent, à des moments
     * différents — le choix se fait donc, et il se conserve.
     */
    function fmtAg(v) {
        return state.options.montantsExacts ? U.euros(v) : U.eurosCourt(v);
    }

    /** Le bouton qui bascule d'un format à l'autre, sur les deux balances. */
    function rendreBoutonsPrecision() {
        const exact = !!state.options.montantsExacts;
        for (const id of ['#btn-aging-precision', '#btn-aging-gl-precision']) {
            const b = $(id);
            if (!b) continue;
            b.textContent = exact ? 'Montants arrondis' : 'Montants exacts';
            b.title = exact
                ? 'Revenir aux montants arrondis (k€ et M€), plus rapides à lire'
                : 'Afficher chaque montant à l’euro près, comme en comptabilité';
            b.classList.toggle('active', exact);
        }
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
            // Le montant en retard d'abord : c'est la question posée à cette
            // page. Le détail par tranche vient après, il dit depuis quand.
            { key: 'echu', label: 'Montant en retard', align: 'right',
              title: 'Factures échues et toujours impayées — toutes les tranches sauf « non échu »',
              format: (v, r) => v ? `<strong>${fmtAg(v)}</strong><span class="cell-mini">${U.nombre(r.echuNb)} factures</span>`
                                  : '<span class="ag-zero">·</span>',
              cls: () => 'ag-total' },
            ...R.AGING_BUCKETS.map(b => ({
                key: b.key, label: b.label, align: 'right',
                format: (v, row) => v ? `<span class="ag-cell" title="${row[b.key + '_nb']} factures">${fmtAg(v)}</span>` : '<span class="ag-zero">·</span>',
                cls: () => 'ag-col',
            })),
            { key: 'total', label: 'Total', align: 'right', format: U.euros, cls: () => 'ag-total' },
            { key: 'nb', label: 'Nb', align: 'right', format: U.nombre },
        ];

        const total = { label: 'Total général', total: U.euros(X.sum(rows, r => r.total)),
            nb: U.nombre(X.sum(rows, r => r.nb)),
            echu: `<strong>${fmtAg(X.sum(rows, r => r.echu))}</strong>`
                + `<span class="cell-mini">${U.nombre(X.sum(rows, r => r.echuNb))} factures</span>` };
        for (const b of R.AGING_BUCKETS) total[b.key] = fmtAg(X.sum(rows, r => r[b.key]));

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
    //  Balance âgée comptable et confrontation
    // ══════════════════════════════════════════════

    /**
     * Reconstitue la balance âgée du grand livre.
     *
     * Elle ne dépend pas des filtres de la barre : c'est la photographie du
     * compte client, et un filtre y ferait disparaître des créances que la
     * comptabilité, elle, continue de porter. Seule la date d'arrêté compte.
     */
    function recalculerBalanceGL() {
        const ouvertes = (state.glOuvertes || []).map(c => ({
            ...c,
            dateFacture: c.dateFacture ? R.parseDate(c.dateFacture) : null,
            dateEcheance: c.dateEcheance ? R.parseDate(c.dateEcheance) : null,
        }));
        if (!ouvertes.length) {
            state.glCreances = [];
            state.glEcritures = null;
            state.glBalance = null;
            state.glComparaison = null;
            return;
        }

        const classees = GL.classer(ouvertes, {
            referentiel: state.qualifRef,
            regles: state.reglesClassement,
            // Les mandats de prélèvement, ramenés au nom du client : chez un
            // client sous mandat l'argent est appelé, donc l'échéance est la
            // fin de la formation, sans délai de paiement.
            mandats: clientsGocardless(),
            factures: state.factures,
            sellsy: lignesFacturation(),
            historique: state.grandLivre,
            rules: state.rules,
        });
        state.glCreances = classees;
        // Le classement descend sur les écritures : une facture classée classe
        // son règlement et son avoir. Ce qui n'a pas de facture dans son
        // lettrage ressort à part, pour être pointé à la main.
        state.glEcritures = (state.glLignes && state.glLignes.length)
            ? GL.classerEcritures(state.glLignes, classees)
            : null;
        state.glBalance = GL.balanceAgee(classees, state.filtres.dateRef, state.rules,
            state.ui.glNiveau || 'financement');

        // La confrontation se fait sur le portefeuille Monday non réglé, sans
        // filtre non plus : comparer une vue filtrée à un compte complet
        // n'aurait aucun sens.
        const monday = X.balanceAgeeParDimension(
            state.factures, f => f.financement || 'INCONNU',
            k => R.getRule(k, state.rules).label);
        state.glComparaison = GL.comparer(state.glBalance,
            monday.map(m => ({ cle: m.key, label: m.label, total: m.total, nb: m.nb })), state.rules);
    }

    /**
     * Les clients GoCardless, avec leur mandat et ce qui a réellement été
     * prélevé chez eux.
     *
     * Le classeur de trésorerie fait deux calculs sur ces fichiers : l'état du
     * mandat — qui change la règle d'échéance — et la somme des prélèvements
     * effectivement sortis, statut « paid_out ». Un prélèvement rejeté n'est
     * pas de l'argent rentré, et ne compte donc pas.
     */
    function clientsGocardless() {
        const g = state.gcl || {};
        if (!g.clients || !g.clients.length) return [];
        const parId = new Map(g.clients.map(c => [c.id, c]));
        const mandatParId = new Map((g.mandats || []).map(m => [m.id, m]));

        // Le client d'un paiement, directement ou par son mandat.
        const clientDe = p => {
            if (p.clientId && parId.has(p.clientId)) return p.clientId;
            const m = p.mandatId ? mandatParId.get(p.mandatId) : null;
            return (m && m.clientId) || null;
        };

        const paye = new Map(), nbPaye = new Map();
        for (const p of (g.paiements || [])) {
            if (String(p.statutBrut || '').trim().toLowerCase() !== 'paid_out') continue;
            const id = clientDe(p);
            if (!id) continue;
            paye.set(id, (paye.get(id) || 0) + (p.montant || 0));
            nbPaye.set(id, (nbPaye.get(id) || 0) + 1);
        }
        const etat = new Map();
        for (const m of (g.mandats || [])) {
            if (m.clientId && !etat.has(m.clientId)) etat.set(m.clientId, m.statut || 'actif');
        }

        const out = [];
        for (const c of g.clients) {
            const nom = c.nomComplet || [c.prenom, c.nom].filter(Boolean).join(' ').trim();
            if (!nom && !c.email) continue;
            out.push({
                client: nom, email: c.email || '',
                etatMandat: etat.get(c.id) || '',
                montantPreleve: paye.get(c.id) || 0,
                nbPrelevements: nbPaye.get(c.id) || 0,
            });
        }
        return out;
    }

    function rendreAgingSource() {
        const src = state.ui.agingSource;
        $$('#seg-aging-source .seg-btn').forEach(b => b.classList.toggle('active', b.dataset.source === src));
        $('#aging-monday').hidden = src !== 'monday';
        $('#aging-gl').hidden = src !== 'gl';
        $('#aging-comparaison').hidden = src !== 'comparaison';

        const charge = !!(state.glBalance && state.glBalance.rows.length);
        const hint = $('#aging-source-hint');
        hint.textContent = src === 'monday'
            ? "Ce que le circuit Monday porte comme encours, filtres de la barre appliqués"
            : src === 'gl'
                ? "Le solde des comptes clients, sans filtre : la comptabilité ne connaît pas le circuit"
                : "Les deux côte à côte, sans filtre";

        if (src === 'gl') {
            $('#aging-gl-vide').hidden = charge;
            $('#aging-gl-contenu').hidden = !charge;
            if (charge) rendreBalanceGL();
        } else if (src === 'comparaison') {
            rendreComparaisonAging();
        }
    }

    /** Les colonnes d'ancienneté, de la plus ancienne à la plus récente. */
    function colonnesAnciennete() {
        return R.AGING_BUCKETS.slice().reverse();
    }

    /**
     * Les règles, rappelées au-dessus du tableau qu'elles produisent.
     *
     * Une balance âgée ne se lit pas sans savoir sur quelle date chaque
     * échéance a été calculée, ni comment le financement a été attribué. Le
     * bloc est replié par défaut : présent quand on en a besoin, discret sinon.
     */
    function rendreReglesGL() {
        const el = $('#aging-gl-regles-corps');
        if (!el) return;
        const libelle = { dateFacture: 'date de facture', dateDebutFormation: 'début de formation',
            dateFinFormation: 'fin de formation' };
        const regles = state.rules.filter(r => r.key !== 'INCONNU');

        el.innerHTML = `
            <p class="fv-hint">Ces règles sont modifiables dans l'onglet Données → « Règles d'échéance ».</p>
            ${U.table([
                { key: 'label', label: 'Financement' },
                { key: 'categorie', label: 'Catégorie' },
                { key: 'base', label: 'Échéance calculée sur' },
                { key: 'perimetre', label: 'Périmètre' },
            ], regles.map(r => ({
                label: r.label,
                categorie: R.categorieDe(r.key, state.rules),
                base: (libelle[r.base] || r.base) + (r.jours ? ` + ${r.jours} j` : ' (sans délai)')
                    + (r.plafondDebutFormation ? ', plafonné à début de formation + ' + r.jours + ' j' : '')
                    + (r.fallback ? ` — à défaut ${libelle[r.fallback] || r.fallback}` : ''),
                perimetre: r.perimetre,
            })), { vide: 'Aucune règle.' })}
            <p class="fv-hint"><strong>Classement d'une créance du grand livre</strong>, du plus sûr au moins
            sûr — le premier qui répond gagne : ① la facture Monday de même numéro ; ② le référentiel des
            qualifications déjà validées, c'est-à-dire l'ancien grand livre classé ; ③ <strong>vos règles
            de classement</strong>, dans l'ordre où vous les avez écrites ; ④ le « Type de client » de la
            facturation (Sellsy) ; ⑤ la qualification portée par le fichier, à vérifier ; ⑥ l'identifiant
            du tiers, puis ⑦ le numéro de compte, à condition qu'un seul financement y soit connu.
            Sinon : <em>À classer</em>.</p>`;
    }

    function rendreBalanceGL() {
        const b = state.glBalance;
        const parCat = state.ui.glNiveau === 'categorie';
        $$('#seg-gl-niveau .seg-btn').forEach(x =>
            x.classList.toggle('active', x.dataset.niveau === (state.ui.glNiveau || 'financement')));
        const t = $('#aging-gl-titre');
        if (t) t.textContent = parCat
            ? 'Reste dû comptable par type de client et par ancienneté'
            : 'Reste dû comptable par sous-catégorie et par ancienneté';
        rendreReglesGL();

        // Ce qui est réellement dû : le solde des comptes, débarrassé des
        // positions créditrices qui ne sont pas des créances.
        const du = b.total.total - (b.total.crediteur || 0);
        $('#aging-gl-kpi').innerHTML = [
            { couleur: U.couleurs.retard, valeur: U.euros(b.total.total),
              label: 'Reste dû au grand livre', detail: `${U.nombre(b.total.nb)} créances`,
              sub: 'solde des comptes clients, hors filtres' },
            // Le rapport se prend sur ce qui est dû, non sur le solde : un
            // compte créditeur abaisse le solde sans rien retirer aux arriérés,
            // et le taux dépassait alors cent pour cent.
            { couleur: U.couleurs.payeRetard, valeur: U.euros(b.total.echu),
              label: 'Dont échu',
              detail: U.pourcent(du ? b.total.echu / du * 100 : null, 0) + ' de ce qui est dû',
              sub: 'exigible à la date d’arrêté' },
            { couleur: U.couleurs.nonEchue, valeur: U.euros(b.total.nonEchu),
              label: 'Non échu',
              detail: U.pourcent(du ? b.total.nonEchu / du * 100 : null, 0) + ' de ce qui est dû',
              sub: 'pas encore exigible' },
            { couleur: U.couleurs.inconnu, valeur: U.euros(b.eurosAClasser || 0),
              label: 'À classer', detail: `${U.nombre(b.nbAClasser || 0)} créances`,
              sub: 'aucun recoupement concluant' },
        ].map(o => `
            <div class="recup-card">
                <span class="recup-bar" style="background:${o.couleur}"></span>
                <span class="recup-taux">${o.valeur}</span>
                <span class="recup-label">${U.escapeHtml(o.label)}</span>
                <span class="recup-value">${o.detail}</span>
                <span class="recup-sub">${U.escapeHtml(o.sub)}</span>
            </div>`).join('');

        const notes = [];
        const origines = {};
        for (const c of (state.glCreances || [])) {
            const k = c.origineClassement || 'Non classé';
            origines[k] = (origines[k] || 0) + 1;
        }
        notes.push('Financement recoupé depuis : '
            + Object.entries(origines).map(([k, n]) => `${k} — ${U.nombre(n)}`).join(' · ') + '.');
        const nRef = Object.keys(state.qualifRef || {}).length;
        if (nRef) notes.push(`Le référentiel retient ${U.nombre(nRef)} correspondances numéro → financement, `
            + `apprises des extraits déjà qualifiés. Chargez l'ancien grand livre classé pour l'enrichir : `
            + `ce travail ne se refait plus ensuite.`);
        if (b.sansDate)
            notes.push(`${U.nombre(b.sansDate)} créances n'ont ni date d'échéance ni date de facture `
                + `dans le grand livre : leur ancienneté n'est pas calculable, elles sont comptées en non échu.`);
        if (b.total.nbCrediteur)
            notes.push(`${U.nombre(b.total.nbCrediteur)} comptes présentent un solde créditeur `
                + `(${U.euros(b.total.crediteur)}) : acompte encaissé d'avance, trop-perçu ou avoir non `
                + `imputé. C'est de l'argent déjà reçu, pas une créance à vieillir — il compte dans le `
                + `total, qui reste le solde des comptes clients, mais il a sa propre colonne pour ne `
                + `pas effacer des arriérés bien réels dans les tranches d'ancienneté.`);
        const sansNum = (state.glCreances || []).filter(c => c.sansNumero).length;
        if (sansNum)
            notes.push(`${U.nombre(sansNum)} écritures ne portent pas de numéro de facture — acomptes, `
                + `écarts de règlement. Elles pèsent sur le solde du compte et sont conservées pour que `
                + `le total comptable se retrouve.`);
        $('#aging-gl-notes').innerHTML = notes.map(n => `<p>${n}</p>`).join('');

        const buckets = colonnesAnciennete();
        const cols = [
            { key: 'label', label: parCat ? 'Type de client' : 'Sous-catégorie' },
            { key: 'echu', label: 'Total échu', align: 'right',
              format: v => v ? `<strong>${fmtAg(v)}</strong>` : '<span class="ag-zero">·</span>',
              cls: () => 'ag-total' },
            ...buckets.map(bk => ({
                key: bk.key, label: bk.label, align: 'right',
                format: (v, row) => v ? `<span class="ag-cell">${fmtAg(v)}</span>` : '<span class="ag-zero">·</span>',
                cls: () => 'ag-col',
            })),
            { key: 'crediteur', label: 'Solde créditeur', align: 'right',
              title: 'Acomptes, trop-perçus et avoirs non imputés : de l’argent déjà reçu, '
                   + 'qui compte dans le total mais dans aucune tranche d’ancienneté',
              format: v => v ? `<span class="ag-cell">${fmtAg(v)}</span>` : '<span class="ag-zero">·</span>',
              cls: () => 'ag-col' },
            { key: 'total', label: 'Total', align: 'right', format: U.euros, cls: () => 'ag-total' },
            { key: 'nb', label: 'Nb', align: 'right', format: U.nombre },
        ];
        const rows = b.rows.map(r => ({ ...r, ...r.buckets }));
        const total = { label: 'TOTAL', echu: fmtAg(b.total.echu),
            crediteur: fmtAg(b.total.crediteur),
            total: U.euros(b.total.total), nb: U.nombre(b.total.nb) };
        for (const bk of buckets) total[bk.key] = fmtAg(b.total.buckets[bk.key]);

        const el = $('#aging-gl-table');
        el.innerHTML = U.table(cols, rows, { vide: 'Aucune créance ouverte au grand livre.', total,
            onRowClick: true, rowClass: r => r.cle === GL.A_CLASSER ? 'ligne-a-classer' : '' });
        U.bindTable(el, rows, { onRowClick: r => montrerCreancesGL(r) });

        rendreActionsGL();
        rendreOrphelins();
        rendreReglesClassement();
        rendreAClasser();
    }

    /**
     * Les paiements à pointer, seuls, en un clic.
     *
     * Le classeur complet les contient déjà, mais treize feuilles pour une
     * liste que l'on veut pointer ligne à ligne, c'est un détour. Chaque
     * règlement y porte le financement de sa contrepartie probable, faute
     * d'en avoir un à lui.
     */
    function exporterOrphelins() {
        const e = state.glEcritures;
        if (!e) { U.toast('Rechargez le grand livre pour exporter les paiements à pointer.', 'error'); return; }
        const aPointer = rapprochementsPossibles(e.orphelins);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(
            aPointer.length ? aPointer.map(l => ({
                'Date': l.date ? U.dateFR(l.date) : '',
                'N° de compte': l.compte, 'Client': l.tiers,
                'Libellé': l.libelle, 'Journal': l.journal, 'Lettrage': l.lettre,
                'Nature': l.nature === 'avoir' ? 'Avoir' : 'Règlement',
                'Montant': Math.round((l.credit || 0) * 100) / 100,
                'Facture de même montant': l.exact ? (l.exact.numero || '(sans numéro)') : '',
                'Financement de cette facture': l.exact && l.exact.financement
                    ? R.getRule(l.exact.financement, state.rules).label : '',
                'Créances ouvertes du compte': l.nbOuvertes,
                'Reste dû du compte': Math.round((l.eurosOuverts || 0) * 100) / 100,
                'Candidates': l.candidates.map(c => (c.numero || '(sans n°)')
                    + ' ' + Math.round(c.resteDu) + ' €').join(' | '),
            })) : [{ 'Date': 'Tous les règlements sont rattachés à une facture' }]),
            'Paiements à pointer');
        // Et, en regard, tous les règlements avec le financement dont ils héritent.
        XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(
            e.lignes.filter(l => l.nature === 'reglement' || l.nature === 'avoir').map(l => ({
                'Date': l.date ? U.dateFR(l.date) : '',
                'N° de compte': l.compte, 'Client': l.tiers,
                'Libellé': l.libelle, 'Lettrage': l.lettre,
                'Nature': l.nature === 'avoir' ? 'Avoir' : 'Règlement',
                'Montant': Math.round((l.credit || 0) * 100) / 100,
                'Financement': l.financement ? R.getRule(l.financement, state.rules).label : 'Non rattaché',
                'Type de client': l.typeClient || '',
                'Classé par': l.origineClassement || '',
            }))), 'Tous les règlements');
        XLSX.writeFile(wb, `Paiements_a_pointer_${new Date().toISOString().slice(0, 10)}.xlsx`);
        U.toast(`${U.nombre(aPointer.length)} paiements à pointer exportés.`, 'success');
    }

    /** Les créances à classer, telles qu'elles sont à l'écran. */
    function exporterAClasser() {
        const toutes = creancesAClasser();
        if (!toutes.length) { U.toast('Toutes les créances ont trouvé un financement.', 'info'); return; }
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(
            groupesAClasser(toutes).map(g => ({
                'Client': g.tiers, 'N° de compte': g.compte,
                'Créances': g.nb, 'Dont sans numéro': g.sansNumero,
                'Reste dû': Math.round(g.resteDu * 100) / 100,
                'Plus ancienne échéance': g.plusAncienne ? U.dateFR(g.plusAncienne) : '',
            }))), 'Par compte');
        XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(
            toutes.map(c => ({
                'N° de facture': c.numero || '', 'Client': c.tiers, 'N° de compte': c.compte,
                'Identifiant du tiers': c.identifiantTiers || '',
                'Libellé': c.libelle || '',
                'Reste dû': Math.round((c.resteDu || 0) * 100) / 100,
                'Date de facture': c.dateFacture ? U.dateFR(c.dateFacture) : '',
                'Échéance': c.dateEcheance ? U.dateFR(c.dateEcheance) : '',
            }))), 'Ligne à ligne');
        XLSX.writeFile(wb, `Creances_a_classer_${new Date().toISOString().slice(0, 10)}.xlsx`);
        U.toast(`${U.nombre(toutes.length)} créances à classer exportées.`, 'success');
    }

    /**
     * Tout ce qu'il y a à faire sur le grand livre, en haut de l'écran.
     *
     * Les boutons vivaient dans l'en-tête de leur tableau, sous six rangées de
     * filtres : ils n'étaient jamais vus. Ils sont désormais réunis là où le
     * regard tombe, avec le compte de ce qui les attend, et chacun conduit à
     * sa section.
     */
    function rendreActionsGL() {
        const el = $('#gl-actions');
        if (!el) return;
        const e = state.glEcritures;
        const nbPointer = e ? (e.orphelins || []).length : 0;
        const nbClasser = creancesAClasser().length;
        const nbRegles = (state.reglesClassement || []).length;
        const exact = !!state.options.montantsExacts;
        el.innerHTML = `
            <span class="gl-actions-titre">À faire</span>
            <button class="btn btn-secondary btn-sm" data-vers="#sec-pointage">Pointer les paiements
                <span class="compteur">${U.nombre(nbPointer)}</span></button>
            <button class="btn btn-secondary btn-sm" data-vers="#sec-aclasser">Classer les créances
                <span class="compteur">${U.nombre(nbClasser)}</span></button>
            <button class="btn btn-ghost btn-sm" data-vers="#sec-regles">Mes règles
                <span class="compteur">${U.nombre(nbRegles)}</span></button>
            <span style="margin-left:auto"></span>
            <button class="btn btn-ghost btn-sm" id="gl-actions-precision">${
                exact ? 'Montants arrondis' : 'Montants à l’euro'}</button>
            <button class="btn btn-primary btn-sm" id="gl-actions-export">Exporter le grand livre (Excel)</button>`;

        $$('[data-vers]', el).forEach(b => b.addEventListener('click', () => {
            const cible = $(b.dataset.vers);
            if (cible) cible.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }));
        $('#gl-actions-precision', el).addEventListener('click', async () => {
            state.options.montantsExacts = !state.options.montantsExacts;
            await sauverReglages();
            rendreTout();
        });
        $('#gl-actions-export', el).addEventListener('click', exporterBalanceGL);
    }

    /**
     * Ce qui pourrait expliquer un paiement non pointé.
     *
     * Un règlement orphelin se pointe contre les créances encore ouvertes du
     * même compte. Le montant identique est l'indice le plus fort — un
     * virement solde presque toujours une facture entière — et vient donc en
     * premier ; à défaut, les créances ouvertes du compte sont listées pour
     * que le rapprochement se fasse à l'œil.
     */
    function rapprochementsPossibles(orphelins) {
        const parCompte = new Map();
        for (const c of (state.glCreances || [])) {
            if (!c.compte || !(c.resteDu > 0)) continue;
            const l = parCompte.get(c.compte) || [];
            l.push(c);
            parCompte.set(c.compte, l);
        }
        const TOL = 0.01;
        return orphelins.map(o => {
            const candidates = (parCompte.get(o.compte) || [])
                .slice().sort((a, b) => Math.abs(b.resteDu) - Math.abs(a.resteDu));
            const exact = candidates.filter(c => Math.abs(c.resteDu - (o.credit || 0)) < TOL);
            return {
                ...o,
                exact: exact[0] || null,
                nbOuvertes: candidates.length,
                eurosOuverts: X.sum(candidates, c => c.resteDu),
                candidates: candidates.slice(0, 5),
            };
        });
    }

    /**
     * Les règlements que rien ne rattache.
     *
     * Le classement d'une facture descend sur tout ce qui la solde : son
     * règlement, son avoir, son rejet. Mais un règlement seul dans son
     * lettrage — un acompte, un virement non pointé, un solde de tout compte —
     * n'a aucune facture de qui hériter. Le deviner serait faux ; il est donc
     * montré tel quel, du plus gros au plus petit, pour être pointé.
     */
    function rendreOrphelins() {
        const el = $('#gl-orphelins'), note = $('#gl-orphelins-note');
        if (!el || !note) return;
        const e = state.glEcritures;
        if (!e) {
            note.innerHTML = '<p>Rechargez le grand livre pour voir le détail des écritures : '
                + 'les règlements ne sont conservés que depuis le dernier import.</p>';
            el.innerHTML = '';
            return;
        }
        const st = e.stats;
        const totalRegl = st.reglements + st.avoirs;
        note.innerHTML = `<p>Sur ${U.nombre(totalRegl)} règlements et avoirs du grand livre, `
            + `<strong>${U.nombre(st.reglementsClasses)}</strong> héritent du dispositif de la facture `
            + `qu'ils soldent. Les <strong>${U.nombre(st.reglementsOrphelins)}</strong> autres `
            + `(${U.euros(st.eurosReglementsOrphelins)}) ne sont rattachés à aucune facture : acompte, `
            + `virement non pointé, solde de tout compte. Ils sont listés ici pour être pointés à la main — `
            + `les deviner fausserait la répartition de ce qui rentre.</p>`;

        const avecRappro = rapprochementsPossibles(e.orphelins);
        const nbExacts = avecRappro.filter(o => o.exact).length;
        if (nbExacts) note.innerHTML += `<p><strong>${U.nombre(nbExacts)}</strong> d'entre eux tombent `
            + `au centime sur une créance encore ouverte du même compte : ce sont les plus faciles à `
            + `pointer, et la colonne « Rapprochement » les nomme.</p>`;

        const liste = avecRappro.slice(0, 300);
        el.innerHTML = U.table([
            { key: 'date', label: 'Date', align: 'center', format: U.dateFR },
            { key: 'tiers', label: 'Client', format: v => `<span class="cell-clip" title="${U.escapeHtml(v || '')}">${U.escapeHtml(v || '—')}</span>` },
            { key: 'compte', label: 'Compte', format: v => `<span class="mono">${U.escapeHtml(v || '—')}</span>` },
            { key: 'libelle', label: 'Libellé', format: v => `<span class="cell-clip" title="${U.escapeHtml(v || '')}">${U.escapeHtml(v || '—')}</span>` },
            { key: 'credit', label: 'Montant', align: 'right', format: U.euros },
            { key: 'nature', label: 'Nature', align: 'center',
              format: v => v === 'avoir' ? '<span class="pill pill-muted">avoir</span>' : '<span class="pill">règlement</span>' },
            { key: '__rappro', label: 'Rapprochement', sortable: false, format: (v, r) => r.exact
                ? `<span class="pill pill-ok" title="Même montant, même compte">${U.escapeHtml(r.exact.numero || 'créance sans numéro')}</span>`
                : r.nbOuvertes
                    ? `<span class="fv-hint">${U.nombre(r.nbOuvertes)} créance${r.nbOuvertes > 1 ? 's' : ''} ouverte${r.nbOuvertes > 1 ? 's' : ''} · ${U.euros(r.eurosOuverts)}</span>`
                    : '<span class="fv-hint">aucune créance ouverte sur ce compte</span>' },
        ], liste, { vide: 'Tous les règlements sont rattachés à une facture.' });
    }

    /**
     * Les créances qu'aucun recoupement n'a su classer, et de quoi les classer.
     *
     * C'est la seule ligne du tableau sur laquelle il y a quelque chose à faire.
     * Les traiter une par une n'est pas tenable à mille lignes : on coche, on
     * choisit un financement, on applique — et le choix rejoint le référentiel,
     * donc il vaut aussi pour les extraits suivants.
     */
    /**
     * Les règles de classement écrites à la main.
     *
     * Le grand livre ne nomme aucun dispositif, et le recoupement automatique
     * n'en retrouve qu'une partie : le reste, il faut le dire. Une règle écrite
     * une fois — « le nom du client contient ALMA » — range d'un coup tout ce
     * qui lui ressemble, dans cet extrait comme dans les prochains.
     *
     * Deux comptages, parce qu'ils ne disent pas la même chose : ce que la
     * règle *reconnaît*, et ce qu'elle *classe* réellement — une créance déjà
     * rattachée à sa facture Monday n'a pas besoin d'elle.
     */
    function rendreReglesLivrees() {
        const el = $('#gl-regles-livrees');
        if (!el) return;
        const portees = GL.porteeDesMotifs(state.glCreances || [])
            .filter(p => p.nb > 0)
            .sort((a, b) => b.nb - a.nb);
        if (!portees.length) { el.innerHTML = ''; return; }
        const nb = X.sum(portees, p => p.nb), euros = X.sum(portees, p => p.euros);
        el.innerHTML = `<p class="aide-bloc">Ces règles sont déjà en place, vous n'avez rien à faire :
            elles lisent le nom du compte client et en déduisent le financement. Elles classent
            aujourd'hui <strong>${U.nombre(nb)} créances</strong> pour ${U.euros(euros)}.
            Vos propres règles, écrites ci-dessous, passent avant elles.</p>`
            + U.table([
                { key: 'libelle', label: 'Quand le compte client dit…' },
                { key: 'financement', label: 'La créance est classée en', format: (v, r) =>
                    `<span class="pill">${U.escapeHtml(R.getRule(v, state.rules).label)}</span>`
                    + (r.arbitrage === 'poleEmploi'
                        ? ' <span class="fv-hint">ou POEI selon le montant</span>'
                        : r.arbitrage === 'opco'
                            ? ' <span class="fv-hint">ou OPCO - Alternance selon la facture</span>' : '') },
                { key: 'nb', label: 'Créances classées', align: 'right', format: U.nombre },
                { key: 'euros', label: 'Reste dû', align: 'right', format: U.euros },
            ], portees, { vide: '' });
    }

    function rendreReglesClassement() {
        rendreReglesLivrees();
        const el = $('#gl-regles-table');
        if (!el) return;
        remplirFormRegle();

        const regles = state.reglesClassement || [];
        const creances = state.glCreances || [];
        const portees = GL.porteeDesRegles(creances, regles);
        // Ce que chaque règle a effectivement classé : l'origine porte son nom.
        const posees = new Map();
        for (const c of creances) {
            const o = c.origineClassement || '';
            if (!o.startsWith('Règle : ')) continue;
            const e = posees.get(o.slice(8)) || { nb: 0, euros: 0 };
            e.nb++; e.euros += c.resteDu || 0;
            posees.set(o.slice(8), e);
        }

        const lignes = regles.map((r, i) => {
            const p = portees[i] || { nb: 0, euros: 0 };
            const q = posees.get(GL.etiquetteRegle(r)) || { nb: 0, euros: 0 };
            return { i, regle: r, nbVus: p.nb, nbPoses: q.nb, eurosPoses: q.euros,
                     financement: r.financement };
        });

        el.innerHTML = U.table([
            { key: 'i', label: 'Ordre', align: 'center', width: '78px', format: v => `
                <span class="regle-ordre">
                    <button class="btn-icone regle-monter" data-i="${v}"${v === 0 ? ' disabled' : ''}
                            title="Monter : la règle sera examinée plus tôt">&#9650;</button>
                    <button class="btn-icone regle-descendre" data-i="${v}"${v === lignes.length - 1 ? ' disabled' : ''}
                            title="Descendre">&#9660;</button>
                </span>` },
            { key: 'regle', label: 'Règle', format: v => U.escapeHtml(GL.etiquetteRegle(v)) },
            { key: 'financement', label: 'Classe en', format: v =>
                `<span class="pill">${U.escapeHtml(R.getRule(v, state.rules).label)}</span>` },
            { key: 'nbVus', label: 'Reconnaît', align: 'right',
              title: 'Créances du grand livre où le motif se retrouve', format: U.nombre },
            { key: 'nbPoses', label: 'Classe', align: 'right',
              title: 'Créances que cette règle a réellement classées — les autres l’étaient déjà par une source plus sûre',
              format: U.nombre },
            { key: 'eurosPoses', label: 'Reste dû classé', align: 'right', format: U.euros },
            { key: '__sup', label: '', align: 'center', width: '40px', format: (v, r) =>
                `<button class="btn-icone regle-supprimer" data-i="${r.i}" title="Supprimer cette règle">&times;</button>` },
        ], lignes, { vide: 'Aucune règle pour l’instant. Écrivez-en une ci-dessus.' });

        $$('.regle-supprimer', el).forEach(b => b.addEventListener('click', () => {
            const r = state.reglesClassement[Number(b.dataset.i)];
            if (!r) return;
            state.reglesClassement.splice(Number(b.dataset.i), 1);
            appliquerReglesClassement(`Règle supprimée : ${GL.etiquetteRegle(r)}.`);
        }));
        const bouger = (i, pas) => {
            const l = state.reglesClassement, j = i + pas;
            if (j < 0 || j >= l.length) return;
            [l[i], l[j]] = [l[j], l[i]];
            appliquerReglesClassement(null);
        };
        $$('.regle-monter', el).forEach(b => b.addEventListener('click', () => bouger(Number(b.dataset.i), -1)));
        $$('.regle-descendre', el).forEach(b => b.addEventListener('click', () => bouger(Number(b.dataset.i), 1)));
    }

    /** Les listes du formulaire, remplies une fois pour toutes. */
    function remplirFormRegle() {
        const champ = $('#gl-regle-champ');
        if (!champ || champ.options.length) return;
        champ.innerHTML = GL.CHAMPS_REGLE
            .map(c => `<option value="${U.escapeHtml(c.cle)}">${U.escapeHtml(c.label)}</option>`).join('');
        $('#gl-regle-op').innerHTML = GL.OPERATEURS
            .map(o => `<option value="${U.escapeHtml(o.cle)}">${U.escapeHtml(o.label)}</option>`).join('');
        $('#gl-regle-fin').innerHTML = '<option value="">Classer en…</option>'
            + state.rules.filter(r => r.key !== 'INCONNU')
                .map(r => `<option value="${U.escapeHtml(r.key)}">${U.escapeHtml(r.label)}</option>`).join('');
    }

    /** La règle en cours d'écriture, telle qu'elle est dans le formulaire. */
    function regleDuFormulaire() {
        return { champ: $('#gl-regle-champ').value, operateur: $('#gl-regle-op').value,
                 valeur: ($('#gl-regle-val').value || '').trim(),
                 financement: $('#gl-regle-fin').value };
    }

    // Les origines de classement qui passent APRÈS les règles écrites : une
    // nouvelle règle les remplace, alors qu'elle s'incline devant les autres.
    const ORIGINES_APRES_REGLES = new Set(['Type de client (facturation)',
        'Héritée du fichier (à vérifier)', 'Identifiant du tiers', 'Compte client']);

    /**
     * L'aperçu, avant d'écrire quoi que ce soit.
     *
     * Une règle trop large se voit à ce compte : « reconnaît 4 210 créances »
     * n'est pas une règle, c'est un accident. Autant le montrer avant.
     */
    function rendreApercuRegle() {
        const el = $('#gl-regle-apercu');
        if (!el) return;
        const r = regleDuFormulaire();
        if (!r.valeur) {
            el.textContent = 'Saisissez le texte à rechercher pour voir ce que la règle toucherait.';
            return;
        }
        const vus = (state.glCreances || []).filter(c => GL.regleCorrespond(r, c));
        if (!vus.length) { el.textContent = 'Aucune créance ne correspond à ce texte pour l’instant.'; return; }
        // Ajoutée en dernier, la règle ne prend que ce qu'aucune source plus
        // sûre — ni facture, ni référentiel, ni règle déjà écrite — ne tient.
        const pris = vus.filter(c => !c.financement || ORIGINES_APRES_REGLES.has(c.origineClassement));
        el.innerHTML = `Cette règle reconnaît <strong>${U.nombre(vus.length)}</strong> créance${vus.length > 1 ? 's' : ''} `
            + `du grand livre et en classerait <strong>${U.nombre(pris.length)}</strong> `
            + `(${U.euros(X.sum(pris, c => c.resteDu))})`
            + (pris.length < vus.length
                ? ` — les ${U.nombre(vus.length - pris.length)} autres sont déjà rattachées à une source plus sûre.`
                : '.');
    }

    /** Enregistre, reclasse, réaffiche. */
    async function appliquerReglesClassement(message) {
        try { await S.set('rec_regles_classement', state.reglesClassement); } catch { /* ignore */ }
        recalculerBalanceGL();
        rendreTout();
        rendreApercuRegle();
        if (message) U.toast(message, 'success', 7000);
    }

    /** Les créances qu'aucun recoupement n'a su classer. */
    function creancesAClasser() {
        return (state.glCreances || []).filter(c => !c.financement)
            .sort((a, b) => Math.abs(b.resteDu) - Math.abs(a.resteDu));
    }

    /**
     * L'identité d'une créance pour la sélection.
     *
     * Le numéro de facture quand il existe ; sinon ce qui ne bouge pas d'un
     * rendu à l'autre : le compte, la date et le montant. Sans cela une case
     * cochée se décoche au réaffichage.
     */
    function idCreance(c) {
        if (c.cle) return 'f:' + c.cle;
        return 'l:' + (c.compte || '') + '|' + (c.numero || '')
            + '|' + (c.dateFacture ? c.dateFacture.getTime() : '')
            + '|' + Math.round((c.resteDu || 0) * 100);
    }

    /**
     * Le même reste à classer, vu par compte client.
     *
     * Deux cents lignes à cocher une par une ne sont pas un travail ; les
     * mêmes deux cents lignes rangées en quarante clients le sont. Un compte
     * porte presque toujours un seul dispositif, et c'est de toute façon à ce
     * niveau que la règle s'écrira.
     */
    function groupesAClasser(liste) {
        const m = new Map();
        for (const c of liste) {
            const cle = c.compte || ('tiers:' + (c.tiers || '?'));
            let g = m.get(cle);
            if (!g) {
                g = { cle, id: 'g:' + cle, compte: c.compte || '', tiers: c.tiers || '',
                      nb: 0, resteDu: 0, avecNumero: 0, sansNumero: 0,
                      plusAncienne: null, creances: [] };
                m.set(cle, g);
            }
            g.nb++;
            g.resteDu += c.resteDu || 0;
            if (c.cle) g.avecNumero++; else g.sansNumero++;
            if (c.dateEcheance && (!g.plusAncienne || c.dateEcheance < g.plusAncienne)) {
                g.plusAncienne = c.dateEcheance;
            }
            g.creances.push(c);
        }
        return [...m.values()].sort((a, b) => Math.abs(b.resteDu) - Math.abs(a.resteDu));
    }

    /**
     * Les créances à classer, et de quoi les classer.
     *
     * C'est la seule ligne du tableau sur laquelle il y a quelque chose à
     * faire. On coche — un client entier ou une ligne —, on choisit un
     * financement, on applique. Ce qui porte un numéro de facture rejoint le
     * référentiel ; ce qui n'en a pas devient une règle sur son compte. Dans
     * les deux cas le choix est conservé et vaut pour les extraits suivants,
     * et dans les deux cas la case se coche : rien n'est bloqué.
     */
    function rendreAClasser() {
        const el = $('#aging-gl-aclasser');
        if (!el) return;
        const sel = state.ui.selGL || (state.ui.selGL = new Set());
        const vue = state.ui.vueAClasser || 'compte';
        $$('#seg-gl-aclasser .seg-btn').forEach(b =>
            b.classList.toggle('active', b.dataset.vue === vue));

        const toutes = creancesAClasser();
        rendreSuggestionsRegles(toutes);

        if (vue === 'compte') {
            const groupes = groupesAClasser(toutes).slice(0, 300);
            el.innerHTML = U.table([
                { key: '__sel', label: '', align: 'center', width: '34px', sortable: false,
                  format: (v, r) => `<input type="checkbox" class="gl-sel" data-id="${U.escapeHtml(r.id)}"${sel.has(r.id) ? ' checked' : ''}>` },
                { key: 'tiers', label: 'Client', format: v => `<span class="cell-clip cell-clip-lg" title="${U.escapeHtml(v || '')}">${U.escapeHtml(v || '—')}</span>` },
                { key: 'compte', label: 'Compte', format: v => `<span class="mono">${U.escapeHtml(v || '—')}</span>` },
                { key: 'nb', label: 'Créances', align: 'right', format: U.nombre },
                { key: 'sansNumero', label: 'Sans n°', align: 'right',
                  title: 'Créances sans numéro de facture : elles se classent par une règle sur le compte',
                  format: v => v ? U.nombre(v) : '<span class="ag-zero">·</span>' },
                { key: 'resteDu', label: 'Reste dû', align: 'right', format: U.euros },
                { key: 'plusAncienne', label: 'Plus ancienne échéance', align: 'center', format: U.dateFR },
                { key: '__regle', label: '', align: 'center', width: '110px', sortable: false,
                  format: (v, r) => r.compte
                      ? `<button class="btn btn-ghost btn-xs gl-depuis-ligne" data-champ="compte" data-valeur="${U.escapeHtml(r.compte)}">Écrire une règle</button>`
                      : '' },
            ], groupes, { vide: 'Toutes les créances ont trouvé un financement.' });
            brancherAClasser(el, groupes);
            rendreBarreGL(groupes, 'compte');
            return;
        }

        const lignes = toutes.slice(0, 300).map(c => ({ ...c, id: idCreance(c) }));
        el.innerHTML = U.table([
            { key: '__sel', label: '', align: 'center', width: '34px', sortable: false,
              format: (v, r) => `<input type="checkbox" class="gl-sel" data-id="${U.escapeHtml(r.id)}"${sel.has(r.id) ? ' checked' : ''}>` },
            { key: 'numero', label: 'Facture', format: v => v ? `<span class="mono">${U.escapeHtml(v)}</span>` : '<span class="pill pill-muted">sans numéro</span>' },
            { key: 'tiers', label: 'Client', format: v => `<span class="cell-clip cell-clip-lg" title="${U.escapeHtml(v || '')}">${U.escapeHtml(v || '—')}</span>` },
            { key: 'compte', label: 'Compte', format: v => `<span class="mono">${U.escapeHtml(v || '—')}</span>` },
            { key: 'resteDu', label: 'Reste dû', align: 'right', format: U.euros },
            { key: 'dateEcheance', label: 'Échéance', align: 'center', format: U.dateFR },
            { key: 'dateFacture', label: 'Facture', align: 'center', format: U.dateFR },
            { key: '__regle', label: '', align: 'center', width: '110px', sortable: false,
              format: (v, r) => r.tiers
                  ? `<button class="btn btn-ghost btn-xs gl-depuis-ligne" data-champ="tiers" data-valeur="${U.escapeHtml(r.tiers)}">Écrire une règle</button>`
                  : '' },
        ], lignes, { vide: 'Toutes les créances ont trouvé un financement.' });
        brancherAClasser(el, lignes);
        rendreBarreGL(lignes, 'ligne');
    }

    /** Cases à cocher et raccourcis « écrire une règle », dans les deux vues. */
    function brancherAClasser(el, lignes) {
        const sel = state.ui.selGL;
        $$('.gl-sel', el).forEach(c => c.addEventListener('click', ev => {
            ev.stopPropagation();
            if (c.checked) sel.add(c.dataset.id); else sel.delete(c.dataset.id);
            rendreAClasser();
        }));
        $$('.gl-depuis-ligne', el).forEach(b => b.addEventListener('click', ev => {
            ev.stopPropagation();
            const champ = $('#gl-regle-champ'), op = $('#gl-regle-op'), val = $('#gl-regle-val');
            if (!champ || !op || !val) return;
            champ.value = b.dataset.champ;
            op.value = b.dataset.champ === 'compte' ? 'egal' : 'contient';
            val.value = b.dataset.valeur;
            rendreApercuRegle();
            $('#gl-regle-form').scrollIntoView({ behavior: 'smooth', block: 'center' });
            val.focus();
        }));
    }

    /**
     * Ce qu'il resterait à classer, et par quoi commencer.
     *
     * Une table de règles vide n'aide personne : elle demande d'inventer le
     * motif autant que le financement. Les motifs, eux, se lisent dans ce qui
     * reste — un compte dont une partie est déjà classée dit ce que vaut le
     * reste, et un mot qui revient dans trente noms de clients est une règle
     * qui s'ignore. Le financement, lui, ne se devine pas : il se choisit.
     */
    function suggestionsRegles(aClasser) {
        const sug = [];
        const dejaEcrite = r => (state.reglesClassement || [])
            .some(x => GL.etiquetteRegle(x) === GL.etiquetteRegle(r));

        // 1. Les comptes qui portent déjà un financement connu ailleurs.
        const finsParCompte = new Map();
        for (const c of (state.glCreances || [])) {
            if (!c.compte || !c.financement) continue;
            const e = finsParCompte.get(c.compte) || new Set();
            e.add(c.financement);
            finsParCompte.set(c.compte, e);
        }
        const parCompte = new Map();
        for (const c of aClasser) {
            if (!c.compte) continue;
            const e = parCompte.get(c.compte) || { nb: 0, euros: 0, tiers: c.tiers };
            e.nb++; e.euros += c.resteDu || 0;
            parCompte.set(c.compte, e);
        }
        for (const [compte, e] of parCompte) {
            const fins = finsParCompte.get(compte);
            if (!fins || fins.size !== 1) continue;
            const regle = { champ: 'compte', operateur: 'egal', valeur: compte,
                            financement: [...fins][0] };
            if (dejaEcrite(regle)) continue;
            sug.push({ regle, nb: e.nb, euros: e.euros, sur: e.tiers || compte,
                       motif: 'Le reste de ce compte est déjà classé ainsi' });
        }

        return sug.sort((a, b) => Math.abs(b.euros) - Math.abs(a.euros)).slice(0, 10);
    }

    function rendreSuggestionsRegles(aClasser) {
        const el = $('#gl-regles-suggerees');
        if (!el) return;
        const liste = aClasser && aClasser.length ? suggestionsRegles(aClasser) : [];
        if (!liste.length) { el.innerHTML = ''; return; }

        const options = fin => state.rules.filter(r => r.key !== 'INCONNU')
            .map(r => `<option value="${U.escapeHtml(r.key)}"${r.key === fin ? ' selected' : ''}>${U.escapeHtml(r.label)}</option>`).join('');
        el.innerHTML = `
            <p class="aide-bloc">Voici par quoi commencer : les motifs qui couvrent le plus de reste
            à classer. Le financement n'est proposé que lorsqu'il est déjà connu ailleurs —
            sinon, c'est à vous de le choisir.</p>
            <div class="suggestions-regles">`
            + liste.map((s, i) => `
                <div class="suggestion" data-i="${i}">
                    <span class="suggestion-motif">${U.escapeHtml(GL.etiquetteRegle(s.regle))}</span>
                    <span class="fv-hint">${U.nombre(s.nb)} créance${s.nb > 1 ? 's' : ''}
                        · ${U.euros(s.euros)} · ${U.escapeHtml(s.motif)}
                        <br>${U.escapeHtml(s.sur)}</span>
                    <select class="input input-sm suggestion-fin">
                        <option value="">Classer en…</option>${options(s.regle.financement)}
                    </select>
                    <button class="btn btn-secondary btn-sm suggestion-ajouter">Créer la règle</button>
                </div>`).join('')
            + '</div>';

        $$('.suggestion', el).forEach(d => {
            const s = liste[Number(d.dataset.i)];
            $('.suggestion-ajouter', d).addEventListener('click', () => {
                const fin = $('.suggestion-fin', d).value;
                if (!fin) { U.toast('Choisissez le financement à attribuer.', 'error'); return; }
                ajouterRegle({ ...s.regle, financement: fin });
            });
        });
    }

    /** Écrit une règle, l'applique, et dit ce qu'elle a fait. */
    function ajouterRegle(regle) {
        const etiq = GL.etiquetteRegle(regle);
        if ((state.reglesClassement || []).some(x => GL.etiquetteRegle(x) === etiq)) {
            U.toast('Cette règle existe déjà.', 'error'); return false;
        }
        const neuves = (state.glCreances || [])
            .filter(c => !c.financement && GL.regleCorrespond(regle, c)).length;
        state.reglesClassement = (state.reglesClassement || []).concat([regle]);
        appliquerReglesClassement(`${etiq} → ${R.getRule(regle.financement, state.rules).label}. `
            + `${U.nombre(neuves)} créance${neuves > 1 ? 's' : ''} à classer y trouve`
            + `${neuves > 1 ? 'nt' : ''} un financement. La règle est conservée : elle vaudra `
            + `aussi pour les prochains extraits.`);
        return true;
    }

    /**
     * Barre d'action du classement par lot.
     *
     * Elle sait ce qu'elle va faire avant de le faire : combien de créances
     * entrent au référentiel par leur numéro, et combien de règles de compte
     * seront écrites pour celles qui n'en ont pas.
     */
    function rendreBarreGL(lignes, vue) {
        const barre = $('#aging-gl-barre');
        if (!barre) return;
        const sel = state.ui.selGL || new Set();
        if (!lignes.length) { barre.hidden = true; return; }

        const retenues = lignes.filter(l => sel.has(l.id));
        const creances = vue === 'compte'
            ? retenues.flatMap(g => g.creances)
            : retenues;
        const numerotees = creances.filter(c => c.cle);
        const comptes = [...new Set(creances.filter(c => !c.cle && c.compte).map(c => c.compte))];
        const perdues = creances.filter(c => !c.cle && !c.compte).length;

        barre.hidden = false;
        barre.innerHTML = `
            <label class="barre-tout"><input type="checkbox" id="gl-tout"${
                retenues.length === lignes.length ? ' checked' : ''}>
                Tout cocher (${U.nombre(lignes.length)})</label>
            <span class="barre-info">${U.nombre(creances.length)} créance${creances.length > 1 ? 's' : ''} `
            + `· ${U.euros(X.sum(creances, c => c.resteDu))}`
            + (comptes.length ? ` · dont ${U.nombre(creances.length - numerotees.length)} sans numéro `
                + `→ ${U.nombre(comptes.length)} règle${comptes.length > 1 ? 's' : ''} de compte` : '')
            + (perdues ? ` · ${U.nombre(perdues)} sans numéro ni compte, impossibles à mémoriser` : '')
            + `</span>
            <select id="gl-fin" class="input input-sm"${creances.length ? '' : ' disabled'}>
                <option value="">Classer en…</option>
                ${state.rules.filter(r => r.key !== 'INCONNU')
                    .map(r => `<option value="${U.escapeHtml(r.key)}">${U.escapeHtml(r.label)}</option>`).join('')}
            </select>
            <button class="btn btn-primary btn-sm" id="gl-appliquer"${creances.length ? '' : ' disabled'}>Appliquer</button>`;

        $('#gl-tout', barre).addEventListener('change', e => {
            state.ui.selGL = e.target.checked ? new Set(lignes.map(l => l.id)) : new Set();
            rendreAClasser();
        });
        $('#gl-appliquer', barre).addEventListener('click', async () => {
            const fin = $('#gl-fin', barre).value;
            if (!fin) { U.toast('Choisissez un financement.', 'error'); return; }

            // Validé à la main : c'est ce que le référentiel est censé contenir,
            // et c'est ce qui lui donne son rang de source sûre.
            for (const c of numerotees) state.qualifRef[c.cle] = { fin, source: 'valide' };
            // Sans numéro, rien à mettre au référentiel : le compte est la
            // seule identité stable de la créance. Une règle le dit, et elle
            // vaudra aussi pour les extraits suivants.
            let nbRegles = 0;
            for (const compte of comptes) {
                const r = { champ: 'compte', operateur: 'egal', valeur: compte, financement: fin };
                if ((state.reglesClassement || []).some(x => GL.etiquetteRegle(x) === GL.etiquetteRegle(r))) continue;
                state.reglesClassement = (state.reglesClassement || []).concat([r]);
                nbRegles++;
            }
            state.ui.selGL = new Set();
            try { await S.set('rec_qualif_ref', state.qualifRef); } catch { /* ignore */ }
            if (nbRegles) { try { await S.set('rec_regles_classement', state.reglesClassement); } catch { /* ignore */ } }
            recalculerBalanceGL();
            rendreTout();
            U.toast(`${U.nombre(creances.length)} créances classées en `
                + `${R.getRule(fin, state.rules).label}`
                + (nbRegles ? `, dont ${U.nombre(nbRegles)} compte${nbRegles > 1 ? 's' : ''} `
                    + `par une règle` : '')
                + `. Le choix est retenu : il vaudra aussi pour les prochains extraits.`
                + (perdues ? ` ${U.nombre(perdues)} créances sans numéro ni compte n'ont pas pu `
                    + `être mémorisées.` : ''), 'success', 9000);
        });
    }

    function montrerCreancesGL(row) {
        const liste = (row.creances || []).slice()
            .sort((a, b) => Math.abs(b.resteDu) - Math.abs(a.resteDu)).slice(0, 300);
        U.modal(`${row.label} — ${U.euros(row.total)} sur ${U.nombre(row.nb)} créances`,
            U.table([
                { key: 'numero', label: 'Facture', format: v => v ? `<span class="mono">${U.escapeHtml(v)}</span>` : '<span class="pill pill-muted">sans numéro</span>' },
                { key: 'tiers', label: 'Client', format: v => `<span class="cell-clip cell-clip-lg" title="${U.escapeHtml(v || '')}">${U.escapeHtml(v || '—')}</span>` },
                { key: 'resteDu', label: 'Reste dû', align: 'right', format: U.euros },
                { key: 'retardJours', label: 'Retard', align: 'right', format: U.pastilleRetard },
                { key: 'dateEcheance', label: 'Échéance', align: 'center', format: U.dateFR },
                { key: 'origineClassement', label: 'Classé par', format: v => U.escapeHtml(v || '—') },
                { key: 'montantPreleve', label: 'Prélevé', align: 'right',
                  title: 'Somme des prélèvements GoCardless réellement sortis chez ce client — rejets exclus',
                  format: (v, r) => v ? `${U.euros(v)}<span class="fv-hint"> · ${U.nombre(r.nbPrelevements)}</span>` : '—' },
            ], liste, { vide: 'Aucune créance.' }),
            [{ label: 'Fermer', primary: true }]);
    }

    function rendreComparaisonAging() {
        const c = state.glComparaison;
        const el = $('#aging-cmp-table');
        if (!c || !c.rows.length) {
            $('#aging-cmp-kpi').innerHTML = '';
            $('#aging-cmp-notes').innerHTML =
                '<p>Chargez un grand livre dans l’onglet Données pour confronter les deux balances.</p>';
            el.innerHTML = '';
            U.chart('chart-aging-cmp', videConfig('Aucun grand livre chargé'));
            return;
        }

        $('#aging-cmp-kpi').innerHTML = [
            { couleur: U.couleurs.indigo, valeur: U.euros(c.total.monday), label: 'Encours Monday',
              detail: `${U.nombre(c.total.nbMonday)} factures non réglées`, sub: 'ce que le circuit porte' },
            { couleur: U.couleurs.accent, valeur: U.euros(c.total.grandLivre), label: 'Reste dû comptable',
              detail: `${U.nombre(c.total.nbGL)} créances`, sub: 'ce que les comptes clients portent' },
            { couleur: c.total.ecart >= 0 ? U.couleurs.retard : U.couleurs.payeRetard,
              valeur: U.euros(c.total.ecart), label: 'Écart',
              detail: U.pourcent(c.total.ecartRelatif, 1) + ' de l’encours Monday',
              sub: c.total.ecart >= 0 ? 'la comptabilité porte davantage' : 'Monday porte davantage' },
        ].map(o => `
            <div class="recup-card">
                <span class="recup-bar" style="background:${o.couleur}"></span>
                <span class="recup-taux">${o.valeur}</span>
                <span class="recup-label">${U.escapeHtml(o.label)}</span>
                <span class="recup-value">${o.detail}</span>
                <span class="recup-sub">${U.escapeHtml(o.sub)}</span>
            </div>`).join('');

        $('#aging-cmp-notes').innerHTML =
            '<p>Un écart positif veut dire que la comptabilité porte plus que le circuit : des factures '
            + 'émises ne sont sur aucun tableau Monday. Un écart négatif veut dire l’inverse : des '
            + 'règlements sont encaissés sans être lettrés, ou des factures Monday n’existent pas en '
            + 'comptabilité. La ligne « À classer » n’a pas d’équivalent Monday par construction.</p>';

        el.innerHTML = U.table([
            { key: 'label', label: 'Financement' },
            { key: 'monday', label: 'Encours Monday', align: 'right', format: U.euros },
            { key: 'nbMonday', label: 'Nb', align: 'right', format: U.nombre },
            { key: 'grandLivre', label: 'Reste dû comptable', align: 'right', format: U.euros },
            { key: 'nbGL', label: 'Nb', align: 'right', format: U.nombre },
            { key: 'ecart', label: 'Écart', align: 'right',
              format: v => `<span class="pill ${Math.abs(v) < 1 ? 'pill-muted' : v > 0 ? 'pill-danger' : 'pill-soft'}">${U.euros(v)}</span>` },
            { key: 'ecartRelatif', label: 'Écart relatif', align: 'right', format: v => U.pourcent(v, 0) },
        ], c.rows, { vide: 'Rien à comparer.', total: {
            label: 'TOTAL', monday: U.euros(c.total.monday), grandLivre: U.euros(c.total.grandLivre),
            nbMonday: U.nombre(c.total.nbMonday), nbGL: U.nombre(c.total.nbGL),
            ecart: U.euros(c.total.ecart), ecartRelatif: U.pourcent(c.total.ecartRelatif, 0),
        } });

        // Un écart se lit en barres divergentes autour de zéro : le signe est
        // l'information, pas la hauteur absolue.
        const rows = c.rows.filter(r => Math.abs(r.ecart) >= 1).slice(0, 14);
        U.chart('chart-aging-cmp', {
            type: 'bar',
            data: {
                labels: rows.map(r => r.label),
                datasets: [{
                    label: 'Grand livre moins Monday',
                    data: rows.map(r => r.ecart),
                    backgroundColor: rows.map(r => r.ecart > 0 ? U.couleurs.retard : U.couleurs.nonEchue),
                    borderRadius: 3,
                }],
            },
            options: {
                indexAxis: 'y',
                scales: {
                    x: { grid: U.grille, ticks: { callback: v => U.eurosCourt(v) } },
                    y: { grid: { display: false } },
                },
                plugins: { legend: { display: false } },
            },
        });
    }

    /** Export Excel de la balance âgée comptable, dans sa présentation d'écran. */
    /**
     * Export Excel de la balance âgée comptable.
     *
     * Reprend la structure du classeur de trésorerie : une synthèse par
     * catégorie de client, une par financement, une par compte, le détail des
     * créances, ce qui reste à classer, les écritures non rattachées, et la
     * confrontation avec Monday. Les deux synthèses sont recalculées ici quel
     * que soit le niveau affiché à l'écran — un export n'a pas à dépendre de
     * l'onglet ouvert.
     */
    function exporterBalanceGL() {
        if (!state.glBalance || !state.glCreances) return;
        const buckets = colonnesAnciennete();
        const wb = XLSX.utils.book_new();
        const creances = state.glCreances;
        const ref = state.filtres.dateRef;

        // ── Une ligne de synthèse, dans l'ordre des colonnes du classeur ──
        const ligneSynthese = (r, colonne) => {
            const o = {};
            o[colonne] = r.label;
            o['Restant dû'] = arrondi(r.total);
            o['Total échu'] = arrondi(r.echu);
            for (const b of buckets) if (b.key !== 'nonEchu') o[b.label] = arrondi(r.buckets[b.key]);
            o['Non échu'] = arrondi(r.nonEchu);
            o['Solde créditeur'] = arrondi(r.crediteur || 0);
            o['Total'] = arrondi(r.total);
            o['Nb'] = r.nb;
            return o;
        };
        const feuilleSynthese = (niveau, colonne, nom) => {
            const b = GL.balanceAgee(creances, ref, state.rules, niveau);
            const lignes = b.rows.map(r => ligneSynthese(r, colonne));
            lignes.push(ligneSynthese({ ...b.total, label: 'TOTAL' }, colonne));
            XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(lignes), nom);
            return b;
        };

        const parCat = feuilleSynthese('categorie', 'Catégorie de client', 'Synthèse catégorie');
        const parFin = feuilleSynthese('financement', 'Financement', 'Synthèse financement');

        // ── Synthèse ──
        XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet([
            { Indicateur: 'Arrêté au', Valeur: U.dateFR(ref) },
            { Indicateur: 'Fichier', Valeur: (state.glLecture && state.glLecture.fichier) || '' },
            { Indicateur: 'Écritures lues', Valeur: (state.glLecture && state.glLecture.nbLignes) || '' },
            { Indicateur: 'Créances ouvertes', Valeur: parFin.total.nb },
            { Indicateur: 'Reste dû total', Valeur: arrondi(parFin.total.total) },
            { Indicateur: 'Dont échu', Valeur: arrondi(parFin.total.echu) },
            { Indicateur: 'Non échu', Valeur: arrondi(parFin.total.nonEchu) },
            { Indicateur: 'À classer — nombre', Valeur: parFin.nbAClasser },
            { Indicateur: 'À classer — montant', Valeur: arrondi(parFin.eurosAClasser) },
            { Indicateur: 'Catégories', Valeur: parCat.rows.length },
            { Indicateur: 'Financements', Valeur: parFin.rows.length },
            { Indicateur: 'Version de l\'application', Valeur: VERSION + ' — ' + VERSION_DATE },
        ]), 'Synthèse');

        // ── Par compte client : le niveau où l'on relance ──
        const parCompte = new Map();
        for (const c of creances) {
            const cle = c.compte || '(sans compte)';
            let g = parCompte.get(cle);
            if (!g) {
                g = { compte: cle, tiers: c.tiers || '', nb: 0, total: 0, echu: 0, nonEchu: 0,
                      financements: new Set(), buckets: {} };
                for (const b of buckets) g.buckets[b.key] = 0;
                parCompte.set(cle, g);
            }
            const base = c.dateEcheance || c.dateFacture;
            const retard = base ? R.diffDays(ref, base) : 0;
            const bk = R.bucketFor(retard) || R.AGING_BUCKETS[0];
            g.nb++; g.total += c.resteDu;
            g.buckets[bk.key] += c.resteDu;
            if (retard > 0) g.echu += c.resteDu; else g.nonEchu += c.resteDu;
            if (c.financement) g.financements.add(R.getRule(c.financement, state.rules).label);
        }
        XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(
            [...parCompte.values()].sort((a, b) => b.total - a.total).map(g => {
                const o = { 'Clé': (g.compte + ' - ' + (g.tiers || '')).trim().replace(/ -$/, ''),
                    'N° de compte': g.compte, 'Client': g.tiers,
                    'Financements': [...g.financements].join(' / ') || 'À classer',
                    'Restant dû': arrondi(g.total), 'Total échu': arrondi(g.echu) };
                for (const b of buckets) if (b.key !== 'nonEchu') o[b.label] = arrondi(g.buckets[b.key]);
                o['Non échu'] = arrondi(g.nonEchu);
                o['Nb'] = g.nb;
                return o;
            })), 'Par compte client');

        // ── Détail des créances ──
        const ligneCreance = c => {
            const base = c.dateEcheance || c.dateFacture;
            const retard = base ? R.diffDays(ref, base) : null;
            return {
                'Clé': ((c.compte || '') + ' - ' + (c.tiers || '')).trim().replace(/^- | -$/g, ''),
                'Facture': c.numero || '',
                'Client': c.tiers || '',
                'N° de compte': c.compte || '',
                'Identifiant tiers': c.identifiantTiers || '',
                'Lettrage': c.lettre || '',
                'Financement': c.financement ? R.getRule(c.financement, state.rules).label : 'À classer',
                'Catégorie': c.financement ? R.categorieDe(c.financement, state.rules) : 'À classer',
                'Classé par': c.origineClassement || '',
                'Montant facture': arrondi(c.montant),
                'Restant dû': arrondi(c.resteDu),
                'Date de facture': c.dateFacture ? U.dateFR(c.dateFacture) : '',
                'Échéance': c.dateEcheance ? U.dateFR(c.dateEcheance) : '',
                'Jours de retard': retard == null ? '' : retard,
                'Tranche': ((R.bucketFor(retard) || {}).label) || '',
                'Mandat de prélèvement': c.etatMandat || '',
                'Prélevé (paid_out)': c.montantPreleve ? arrondi(c.montantPreleve) : '',
                'Nb de prélèvements': c.nbPrelevements || '',
                'Numéro lu dans le libellé': c.numeroExtrait ? 'oui' : '',
            };
        };
        XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(
            creances.filter(c => !c.sansNumero).map(ligneCreance)), 'Créances');

        const aClasser = creances.filter(c => !c.financement);
        XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(
            aClasser.length ? aClasser.map(ligneCreance)
                : [{ 'Facture': 'Aucune créance à classer' }]), 'À classer');

        const sansNumero = creances.filter(c => c.sansNumero);
        XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(
            sansNumero.length ? sansNumero.map(c => ({
                'Clé': ((c.compte || '') + ' - ' + (c.tiers || '')).trim().replace(/^- | -$/g, ''),
                'N° de compte': c.compte, 'Client': c.tiers,
                'Lettrage': c.lettre, 'Restant dû': arrondi(c.resteDu),
                'Dernier mouvement': c.dateFacture ? U.dateFR(c.dateFacture) : '',
                'Nature': 'Acompte, écart de règlement ou crédit non rattaché',
            })) : [{ 'N° de compte': 'Aucune écriture sans numéro' }]), 'Écritures non rattachées');

        // ── Confrontation avec Monday ──
        if (state.glComparaison) {
            XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(
                state.glComparaison.rows.map(r => ({
                    'Financement': r.label,
                    'Encours Monday': arrondi(r.monday), 'Nb Monday': r.nbMonday,
                    'Reste dû comptable': arrondi(r.grandLivre), 'Nb comptable': r.nbGL,
                    'Écart': arrondi(r.ecart),
                    'Écart %': r.ecartRelatif == null ? '' : Math.round(r.ecartRelatif),
                })).concat([{
                    'Financement': 'TOTAL',
                    'Encours Monday': arrondi(state.glComparaison.total.monday),
                    'Nb Monday': state.glComparaison.total.nbMonday,
                    'Reste dû comptable': arrondi(state.glComparaison.total.grandLivre),
                    'Nb comptable': state.glComparaison.total.nbGL,
                    'Écart': arrondi(state.glComparaison.total.ecart),
                    'Écart %': state.glComparaison.total.ecartRelatif == null ? ''
                        : Math.round(state.glComparaison.total.ecartRelatif),
                }])), 'Monday vs grand livre');
        }

        // ── Les règles, pour que la balance se relise plus tard ──
        const libelle = { dateFacture: 'date de facture', dateDebutFormation: 'début de formation',
            dateFinFormation: 'fin de formation' };
        XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(
            state.rules.filter(r => r.key !== 'INCONNU').map(r => ({
                'Financement': r.label,
                'Catégorie': R.categorieDe(r.key, state.rules),
                'Périmètre': r.perimetre,
                'Échéance calculée sur': (libelle[r.base] || r.base) + (r.jours ? ` + ${r.jours} j` : ''),
                'Plafond début de formation': r.plafondDebutFormation ? 'oui' : '',
                'À défaut': libelle[r.fallback] || r.fallback || '',
            }))), 'Règles appliquées');

        // ── Les règlements : ce qui rentre, et par quel dispositif ──
        if (state.glEcritures) {
            const e = state.glEcritures;
            XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(
                e.lignes.filter(l => l.nature === 'reglement' || l.nature === 'avoir').map(l => ({
                    'Date': l.date ? U.dateFR(l.date) : '',
                    'Clé': (l.compte || '') + ' - ' + (l.tiers || ''),
                    'N° de compte': l.compte, 'Client': l.tiers,
                    'Libellé': l.libelle, 'Journal': l.journal, 'Lettrage': l.lettre,
                    'Nature': l.nature === 'avoir' ? 'Avoir' : 'Règlement',
                    'Montant': arrondi(l.credit),
                    'Sous-catégorie': l.financement
                        ? R.getRule(l.financement, state.rules).label : 'Non rattaché',
                    'Type de client': l.typeClient || '',
                    'Classé par': l.origineClassement || '',
                }))), 'Règlements');

            const aPointer = rapprochementsPossibles(e.orphelins);
            XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(
                aPointer.length ? aPointer.map(l => ({
                    'Date': l.date ? U.dateFR(l.date) : '',
                    'Clé': (l.compte || '') + ' - ' + (l.tiers || ''),
                    'N° de compte': l.compte, 'Client': l.tiers,
                    'Libellé': l.libelle, 'Journal': l.journal, 'Lettrage': l.lettre,
                    'Nature': l.nature === 'avoir' ? 'Avoir' : 'Règlement',
                    'Montant': arrondi(l.credit),
                    'Facture de même montant': l.exact ? (l.exact.numero || '(sans numéro)') : '',
                    'Sous-catégorie de cette facture': l.exact && l.exact.financement
                        ? R.getRule(l.exact.financement, state.rules).label : '',
                    'Créances ouvertes du compte': l.nbOuvertes,
                    'Reste dû du compte': arrondi(l.eurosOuverts),
                    'Candidates': l.candidates.map(c => (c.numero || '(sans n°)')
                        + ' ' + arrondi(c.resteDu) + ' €').join(' | '),
                })) : [{ 'Date': 'Tous les règlements sont rattachés à une facture' }]),
                'Paiements à pointer');
        }

        // ── Vos règles de classement, avec ce qu'elles ont réellement fait ──
        if ((state.reglesClassement || []).length) {
            const portees = GL.porteeDesRegles(creances, state.reglesClassement);
            XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(
                state.reglesClassement.map((r, i) => {
                    const etiq = GL.etiquetteRegle(r);
                    const posees = creances.filter(c => c.origineClassement === 'Règle : ' + etiq);
                    return {
                        'Ordre': i + 1,
                        'Règle': etiq,
                        'Classe en': R.getRule(r.financement, state.rules).label,
                        'Reconnaît': (portees[i] || {}).nb || 0,
                        'Classe': posees.length,
                        'Reste dû classé': arrondi(X.sum(posees, c => c.resteDu)),
                    };
                })), 'Règles de classement');
        }

        XLSX.writeFile(wb, `Balance_agee_grand_livre_${new Date().toISOString().slice(0, 10)}.xlsx`);
    }

    function arrondi(v) { return v == null ? '' : Math.round(v * 100) / 100; }

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
            { key: 'montant', label: 'Montant', align: 'right',
              format: (v, r) => U.euros(v) + (r.montantVientDeSellsy
                ? '<span class="calc-flag calc-gl" title="Montant absent de Monday, repris de l\'export Sellsy">S</span>' : '') },
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
            { key: 'dateEcheance', label: 'Échéance', align: 'center', format: (v, r) =>
                `${U.dateFR(v)}` + (r.echeanceOrigine === 'Règle'
                    ? `<span class="calc-flag" title="Calculée par la règle ${U.escapeHtml(r.regleLabel)}">ƒ</span>`
                    : r.echeanceOrigine === 'Sellsy'
                        ? '<span class="calc-flag calc-gl" title="Aucune règle applicable : échéance reprise de l\'export Sellsy">S</span>'
                        : '') },
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

    /**
     * Les factures derrière une tuile de règlement.
     *
     * « 382 payées avant échéance parmi celles passées en recouvrement » est
     * une contradiction apparente : on n'entre en recouvrement qu'une fois
     * échu. Plutôt que de demander de croire l'explication, la liste montre
     * pour chacune la date de facture, l'échéance calculée et le règlement —
     * l'écart entre les trois se lit alors directement.
     */
    function montrerReglements(r, quoi, viaRecouv) {
        const lignes = (r.factures || []).filter(f =>
            quoi === 'toutes' ? true
            : quoi === 'avant' ? !(f.retardJours > 0)
            : f.retardJours > 0);
        const titre = quoi === 'avant' ? 'Payées avant leur échéance'
            : quoi === 'apres' ? 'Payées après leur échéance'
            : (viaRecouv ? 'Factures récupérées' : 'Réglées hors recouvrement');

        const rows = lignes.slice().sort((a, b) => (a.retardJours || 0) - (b.retardJours || 0));
        const corps =
            (quoi === 'avant' && viaRecouv
                ? `<p>Une facture réglée <strong>avant</strong> son échéance calculée n'aurait pas dû
                   entrer en recouvrement. Comparez les trois dates : quand l'échéance calculée tombe
                   après le règlement, c'est que la <strong>date de facture est postérieure</strong> à
                   l'entrée en recouvrement — la facture a été refaite. La colonne « Écart » donne le
                   nombre de jours entre le règlement et l'échéance.</p>`
                : '')
            + U.table([
                { key: 'numero', label: 'Facture', format: v => `<span class="mono">${U.escapeHtml(v || '—')}</span>` },
                { key: 'client', label: 'Client', format: v => `<span class="cell-clip cell-clip-lg" title="${U.escapeHtml(v || '')}">${U.escapeHtml(v || '—')}</span>` },
                { key: 'financement', label: 'Financement', format: v => U.escapeHtml(R.getRule(v, state.rules).label) },
                { key: 'montant', label: 'Montant', align: 'right', format: U.euros },
                { key: 'dateFacture', label: 'Date de facture', align: 'center', format: U.dateFR },
                { key: 'dateEcheance', label: 'Échéance calculée', align: 'center', format: U.dateFR },
                { key: 'datePaiementEffective', label: 'Règlement', align: 'center', format: U.dateFR },
                { key: 'retardJours', label: 'Écart à l’échéance', align: 'right', format: U.pastilleRetard },
                { key: 'groupeOrigine', label: 'Groupe d’origine', format: v => `<span class="cell-clip" title="${U.escapeHtml(v || '')}">${U.escapeHtml(v || '—')}</span>` },
            ], rows.slice(0, 300), { vide: 'Aucune facture.' })
            + (rows.length > 300 ? `<p class="fv-hint">300 premières sur ${U.nombre(rows.length)}.</p>` : '');

        const el = U.modal(`${titre} — ${U.nombre(rows.length)} factures`, corps,
            [{ label: 'Fermer', primary: true }]);
        U.bindTable(el, rows.slice(0, 300), { onRowClick: f => { U.closeModal(); ouvrirFiche(f); } });
    }

    const tuileDetail = (valeur, label, detail, couleur, sub, cle) => `
        <${cle ? 'button' : 'div'} class="recup-card"${cle ? ` data-regl="${cle}" title="Voir ces factures"` : ''}>
            <span class="recup-bar" style="background:${couleur}"></span>
            <span class="recup-taux">${valeur}</span>
            <span class="recup-label">${U.escapeHtml(label)}</span>
            <span class="recup-value">${detail}</span>
            ${sub ? `<span class="recup-sub">${U.escapeHtml(sub)}</span>` : ''}
        </${cle ? 'button' : 'div'}>`;

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
        const baseLabel = { dateFacture: 'date de facture', dateFinFormation: 'fin de formation',
            dateDebutFormation: 'début de formation', 'colonne Monday': 'colonne Monday',
            dateEcheanceSellsy: 'échéance portée par la facturation' };
        const ligne = (l, v) => `<div class="fiche-row"><span>${U.escapeHtml(l)}</span><strong>${v}</strong></div>`;

        const explication = f.echeanceOrigine === 'Monday'
            ? "Échéance lue directement dans Monday."
            : f.echeanceOrigine === 'Sellsy'
                ? `Échéance reprise de la facturation : ${U.dateFR(f.dateEcheance)}. `
                  + `La règle de financement n'a pas pu la calculer, faute de date de facture `
                  + `comme de date de fin de formation.`
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
    /**
     * Reconstruit les apprenants à partir des prélèvements retenus.
     *
     * La fenêtre de période porte sur la date de prélèvement : elle sert à
     * regarder une saison plutôt que tout l'historique. Elle change vraiment ce
     * qui est analysé — un apprenant dont tous les prélèvements sont hors
     * fenêtre disparaît, et la courbe de survie se recalcule sur ce qui reste.
     * La note sous les indicateurs le dit, plutôt que de laisser croire à une
     * simple mise en évidence.
     */
    function recalculerPrelevements() {
        const g = state.gcl;
        if (!g.paiements.length) { state.apprenants = []; state.gclOrphelins = 0; return; }

        if (!g.unite) g.unite = PR.detecterUniteMontant(g.paiements);
        PR.appliquerUnite(g.paiements, g.unite.unite);

        const mois = state.ui.prlvFenetre || 0;
        let retenu = g;
        state.prlvPeriode = null;
        if (mois > 0) {
            const dates = g.paiements.map(p => p.dateEcheance || p.dateCreation).filter(Boolean);
            if (dates.length) {
                const fin = new Date(Math.max(...dates.map(d => +d)));
                const debut = new Date(fin.getFullYear(), fin.getMonth() - (mois - 1), 1);
                const dans = p => {
                    const d = p.dateEcheance || p.dateCreation;
                    return d ? d >= debut : false;
                };
                const paiements = g.paiements.filter(dans);
                retenu = { ...g, paiements };
                state.prlvPeriode = { debut, fin, retenus: paiements.length, total: g.paiements.length };
            }
        }

        // Les prélèvements retenus servent aussi aux statistiques : sans cela
        // le bandeau annonçait 900 prélèvements alors que 290 étaient analysés.
        state.gclRetenus = retenu.paiements;
        const r = PR.construireApprenants(retenu);
        state.apprenants = r.apprenants;
        state.gclOrphelins = r.orphelins;
    }

    function rendrePrelevements() {
        const charge = state.apprenants.length > 0;
        $('#prlv-vide').hidden = charge;
        $('#prlv-contenu').hidden = !charge;
        if (!charge) { $('#prlv-badge').textContent = ''; return; }

        const st = PR.statistiques(state.apprenants, state.gclRetenus || state.gcl.paiements);
        $('#prlv-badge').textContent =
            `${U.nombre(st.nbApprenants)} apprenants · ${U.nombre(st.nbPrelevements)} prélèvements`;

        // La fenêtre retenue, dite explicitement : tout ce qui suit ne porte
        // que sur elle, courbe de survie comprise.
        $$('#seg-prlv-fenetre .seg-btn').forEach(x =>
            x.classList.toggle('active', +x.dataset.fenetre === (state.ui.prlvFenetre || 0)));
        const per = $('#prlv-periode');
        if (per) per.textContent = state.prlvPeriode
            ? `Du ${U.dateFR(state.prlvPeriode.debut)} au ${U.dateFR(state.prlvPeriode.fin)} — `
              + `${U.nombre(state.prlvPeriode.retenus)} prélèvements retenus sur `
              + `${U.nombre(state.prlvPeriode.total)}. Un apprenant sans prélèvement dans la fenêtre `
              + `en sort, et la courbe de survie se recalcule sur ce qui reste.`
            : "Tout l'historique disponible";

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
        // Deux couleurs, donc deux séries nommées : le rouge des trois premiers
        // rangs signalait la rupture précoce, mais rien ne le disait — une
        // couleur qui porte du sens sans légende ne se lit pas.
        const PRECOCE = 3;
        const valeur = r => (eur ? r.euros : r.nb);
        U.chart('chart-rang', {
            type: 'bar',
            data: {
                labels: rows.map(r => r.rang),
                datasets: [
                    {
                        label: `Rupture précoce — dès les ${PRECOCE} premiers prélèvements`,
                        data: rows.map((r, i) => i < PRECOCE ? valeur(r) : null),
                        backgroundColor: U.couleurs.retard, borderRadius: 3, stack: 'a',
                    },
                    {
                        label: 'Rupture plus tardive',
                        data: rows.map((r, i) => i < PRECOCE ? null : valeur(r)),
                        backgroundColor: U.couleurs.payeRetard, borderRadius: 3, stack: 'a',
                    },
                ],
            },
            options: {
                scales: {
                    x: { stacked: true, grid: { display: false }, title: { display: true, text: 'Rang du prélèvement rejeté' } },
                    y: { stacked: true, grid: U.grille, ticks: { callback: v => eur ? U.eurosCourt(v) : U.nombre(v) } },
                },
                plugins: {
                    legend: { display: true },
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
    //  Onglet : Contrôle Sellsy
    // ══════════════════════════════════════════════

    /**
     * Confronte l'export Sellsy aux factures Monday.
     *
     * Le contrôle porte sur la totalité des factures Monday, sans les filtres de
     * la barre : une facture manquante ne peut pas être retrouvée par un filtre
     * qui, par construction, ne connaît que ce qui est déjà là.
     */
    function recalculerSellsy() {
        state.sellsyResultat = state.sellsy.lignes.length
            ? SE.rapprocher(state.sellsy.lignes, state.factures) : null;
    }

    /**
     * Sans facture Monday chargée, le rapprochement déclarerait tout l'export
     * manquant : ce n'est pas un constat, c'est l'absence de l'un des deux
     * termes de la comparaison. Le dire plutôt que d'afficher un faux contrôle.
     */
    function sellsyPretAComparer() {
        return state.factures.length > 0;
    }

    let introSellsyOrigine = null;

    function rendreSellsy() {
        const charge = !!(state.sellsyResultat && state.sellsy.lignes.length) && sellsyPretAComparer();
        $('#sellsy-vide').hidden = charge;
        $('#sellsy-contenu').hidden = !charge;
        const titre = $('#sellsy-vide h3'), intro = $('#sellsy-vide p');
        if (introSellsyOrigine == null) introSellsyOrigine = intro.innerHTML;
        if (state.sellsy.lignes.length && !sellsyPretAComparer()) {
            titre.textContent = 'Export Sellsy chargé, mais aucune facture Monday';
            intro.textContent = `${U.nombre(state.sellsy.lignes.length)} factures Sellsy sont en mémoire. `
                + `Chargez les tableaux Monday depuis l'onglet Données : sans eux, la comparaison `
                + `déclarerait tout l'export manquant.`;
        } else if (!charge) {
            titre.textContent = 'Aucun export Sellsy chargé';
            intro.innerHTML = introSellsyOrigine;
        }
        if (!charge) { $('#sellsy-badge').textContent = ''; return; }

        const res = state.sellsyResultat, st = res.stats;
        $('#sellsy-badge').textContent = `${U.nombre(st.nbSellsy)} factures Sellsy · `
            + `${U.nombre(state.factures.length)} factures Monday`
            + (state.sellsy.nomFichier ? ' · ' + state.sellsy.nomFichier : '');

        rendreKpiSellsy(st);
        rendreNotesSellsy(res);
        rendreChartSellsyMois(res);
        rendreRepartitionSellsy(res);
        rendreTableSellsy(res);
    }

    function rendreKpiSellsy(st) {
        const tuile = (o) => `
            <div class="recup-card">
                <span class="recup-bar" style="background:${o.couleur}"></span>
                <span class="recup-taux">${o.valeur}</span>
                <span class="recup-label">${U.escapeHtml(o.label)}</span>
                <span class="recup-value">${o.detail}</span>
                <span class="recup-sub">${U.escapeHtml(o.sub)}</span>
            </div>`;

        $('#sellsy-kpi').innerHTML = [
            tuile({
                couleur: U.couleurs.paye,
                valeur: U.pourcent(st.tauxCouverture, 1),
                label: 'Factures Sellsy suivies dans Monday',
                detail: `${U.nombre(st.nbAttendues - st.nbAbsentes)} sur ${U.nombre(st.nbAttendues)}`,
                sub: 'hors brouillons, avoirs et factures annulées',
            }),
            tuile({
                couleur: U.couleurs.retard,
                valeur: U.nombre(st.nbAbsentes),
                label: 'Factures absentes de Monday',
                detail: U.euros(st.eurosAbsentes) + ' facturés',
                sub: 'émises dans Sellsy, suivies par personne',
            }),
            tuile({
                couleur: U.couleurs.accent,
                valeur: U.euros(st.eurosAbsentesDues),
                label: 'Encore à encaisser parmi les absentes',
                detail: `${U.nombre(st.nbAbsentesImpayees)} non réglées · ${U.nombre(st.nbAbsentesPayees)} déjà réglées`,
                sub: 'le montant qui échappe au recouvrement',
            }),
            tuile({
                couleur: U.couleurs.payeRetard,
                valeur: U.nombre(st.nbEcartMontant + st.nbPayeeSellsySeulement + st.nbPayeeMondaySeulement),
                label: 'Écarts sur les factures communes',
                detail: `${U.nombre(st.nbEcartMontant)} de montant · ${U.nombre(st.nbPayeeSellsySeulement + st.nbPayeeMondaySeulement)} de statut`,
                sub: 'saisies Monday à corriger',
            }),
        ].join('');
    }

    /** Ce que le contrôle ne dit pas — les angles morts, énoncés. */
    function rendreNotesSellsy(res) {
        const st = res.stats, notes = [];
        if (st.nbHorsPerimetre)
            notes.push(`${U.nombre(st.nbHorsPerimetre)} lignes de l'export sont des brouillons, avoirs ou `
                + `factures annulées : elles n'ont pas à figurer dans Monday et ne comptent pas comme manquantes.`);
        if (state.sellsy.ignorees)
            notes.push(`${U.nombre(state.sellsy.ignorees)} lignes de l'export n'ont pas de numéro de facture `
                + `exploitable et n'ont pas pu être rapprochées.`);
        if (st.nbMondaySansNumero)
            notes.push(`${U.nombre(st.nbMondaySansNumero)} factures Monday n'ont pas de numéro : elles ne peuvent `
                + `être rapprochées de rien, et peuvent correspondre à des « absentes » listées ici.`);
        if (res.bornes.min && res.bornes.max)
            notes.push(`L'export couvre du ${U.dateFR(res.bornes.min)} au ${U.dateFR(res.bornes.max)}. `
                + `Les factures Monday hors de cette période ne sont pas jugées.`);
        if (!state.sellsy.mapping.statut)
            notes.push(`Aucune colonne « statut » n'a été reconnue dans l'export : les statuts affichés sont `
                + `déduits du reste dû.`);
        const c = state.sellsyStats;
        if (c && (c.montants || c.datesFacture || c.datesService))
            notes.push(`Cet export complète Monday là où il est muet : `
                + [c.montants ? `${U.nombre(c.montants)} montants absents ou à zéro` : '',
                   c.datesFacture ? `${U.nombre(c.datesFacture)} dates de facture` : '',
                   c.datesService ? `${U.nombre(c.datesService)} dates de début ou fin de service` : '']
                    .filter(Boolean).join(', ')
                + ` ont été repris de Sellsy. Les valeurs déjà saisies dans Monday ne sont jamais remplacées.`);
        if (st.nbMontantAberrant)
            notes.push(`${U.nombre(st.nbMontantAberrant)} facture${st.nbMontantAberrant > 1 ? 's' : ''} de `
                + `l'export porte${st.nbMontantAberrant > 1 ? 'nt' : ''} un montant aberrant `
                + `(${U.escapeHtml(st.numerosMontantAberrant.join(', '))}) : au-delà de `
                + `${U.euros(SE.MONTANT_ABERRANT)}, ce n'est pas une facture de formation mais une anomalie de `
                + `Sellsy. Le montant est écarté des totaux, la facture reste comptée — c'est à corriger dans `
                + `Sellsy.`);
        if (!state.sellsy.mapping.montant)
            notes.push(`Aucune colonne de montant n'a été reconnue : l'enjeu financier des absentes ne peut pas `
                + `être chiffré.`);

        const el = $('#sellsy-notes');
        el.hidden = !notes.length;
        el.innerHTML = notes.map(n => `<p>${n}</p>`).join('');
    }

    function rendreChartSellsyMois(res) {
        const rows = SE.absentesParMois(res.absentes, state.sellsy.lignes)
            .slice(-state.ui.fenetreMois);
        if (!rows.length) { U.chart('chart-sellsy-mois', videConfig('Aucune date de facture dans l\'export')); return; }
        U.chart('chart-sellsy-mois', {
            type: 'bar',
            data: {
                labels: rows.map(r => U.moisLabel(r.mois, true)),
                datasets: [
                    {
                        label: 'Suivies dans Monday', stack: 'a',
                        data: rows.map(r => r.total - r.absentes),
                        backgroundColor: U.couleurs.paye, borderRadius: 3,
                    },
                    {
                        label: 'Absentes de Monday', stack: 'a',
                        data: rows.map(r => r.absentes),
                        backgroundColor: U.couleurs.retard, borderRadius: 3,
                    },
                ],
            },
            options: {
                interaction: { mode: 'index', intersect: false },
                scales: {
                    x: { stacked: true, grid: { display: false } },
                    y: { stacked: true, grid: U.grille, ticks: { callback: v => U.nombre(v) } },
                },
                plugins: {
                    legend: { display: true },
                    tooltip: {
                        callbacks: {
                            afterBody: (items) => {
                                const r = rows[items[0].dataIndex];
                                return r.part == null ? '' :
                                    `${U.pourcent(r.part, 1)} du mois absentes · ${U.euros(r.euros)}`;
                            },
                        },
                    },
                },
            },
        });
    }

    /** Les absentes par statut : lesquelles sont encore à aller chercher. */
    function rendreRepartitionSellsy(res) {
        const parStatut = SE.absentesParStatut(res.absentes);
        const el = $('#sellsy-repartition');
        if (!parStatut.length) { el.innerHTML = ''; return; }
        const total = res.absentes.length;
        const couleur = k => k === 'payee' ? U.couleurs.paye
            : k === 'partielle' ? U.couleurs.payeRetard : U.couleurs.retard;
        el.innerHTML = parStatut.map(s => `
            <div class="recup-card">
                <span class="recup-bar" style="background:${couleur(s.key)}"></span>
                <span class="recup-taux">${U.nombre(s.nb)}</span>
                <span class="recup-label">Absentes — ${U.escapeHtml(s.label)}</span>
                <span class="recup-value">${U.euros(s.euros)} facturés</span>
                <span class="recup-sub">${U.pourcent(total ? s.nb / total * 100 : null, 0)} des absentes${
                    s.key !== 'payee' ? ' · ' + U.euros(s.resteDu) + ' à encaisser' : ''}</span>
            </div>`).join('');
    }

    const VUES_SELLSY = {
        absentes: {
            titre: 'Factures absentes de Monday',
            aide: 'Elles existent dans Sellsy et ne sont sur aucun tableau Monday : personne ne les relance. '
                + 'Les impayées sont à créer dans le circuit ; les payées expliquent une partie des factures '
                + 'qui « manquent » au total sans rien coûter.',
        },
        ecarts: {
            titre: 'Écarts entre Sellsy et Monday',
            aide: 'La facture est bien dans Monday, mais son montant ou son statut n\'y correspond pas à Sellsy. '
                + 'Sellsy fait foi : c\'est la saisie Monday qui est à corriger. Une facture encaissée dans '
                + 'Sellsy et encore ouverte dans Monday, c\'est une relance envoyée pour rien.',
        },
        surnumeraires: {
            titre: 'Factures Monday inconnues de Sellsy',
            aide: 'Leur numéro n\'existe pas dans l\'export, sur la période qu\'il couvre : numéro mal saisi, '
                + 'ligne de test, ou facture émise par un autre outil. Seules les factures dont la date tombe '
                + 'dans la période de l\'export sont jugées.',
        },
        ignorees: {
            titre: 'Lignes Sellsy hors périmètre',
            aide: 'Brouillons, avoirs et factures annulées : ils n\'ont pas vocation à être suivis en '
                + 'recouvrement, et leur absence de Monday est normale. Listés pour vérification.',
        },
    };

    /**
     * Les lignes d'une vue, mises à plat.
     *
     * Le tri de U.table passe par le nom de la colonne : une clé calculée n'y
     * survivrait pas. Chaque vue produit donc des objets aux champs simples.
     */
    function lignesVueSellsy(res, vue) {
        if (vue === 'ecarts') return res.rapprochees
            .filter(r => r.ecartMontant != null || r.ecartStatut)
            .map(r => ({
                numero: r.sellsy.numero,
                client: r.sellsy.client || r.facture.client,
                montantSellsy: r.sellsy.montant,
                montantMonday: r.facture.montant,
                ecartMontant: r.ecartMontant,
                statutSellsy: r.sellsy.statutLabel,
                etatMonday: r.facture.etat,
                ecartStatut: r.ecartStatut,
                board: r.facture.board,
                facture: r.facture,
            }));
        if (vue === 'surnumeraires') return res.surnumeraires;
        if (vue === 'ignorees') return res.horsPerimetre;
        return res.absentes;
    }

    function colonnesVueSellsy(vue) {
        const num = { key: 'numero', label: 'Facture', format: v => `<span class="mono">${U.escapeHtml(v || '—')}</span>` };
        const client = { key: 'client', label: 'Client',
            format: v => `<span class="cell-clip cell-clip-lg" title="${U.escapeHtml(v || '')}">${U.escapeHtml(v || '—')}</span>` };

        if (vue === 'ecarts') return [
            num, client,
            { key: 'montantSellsy', label: 'Montant Sellsy', align: 'right', format: v => v == null ? '—' : U.euros(v) },
            { key: 'montantMonday', label: 'Montant Monday', align: 'right', format: v => v == null ? '—' : U.euros(v) },
            { key: 'ecartMontant', label: 'Écart', align: 'right',
              title: 'Montant Monday moins montant Sellsy. Négatif : Monday sous-évalue la facture.',
              format: v => v == null ? '—' : `<span class="pill pill-danger">${U.euros(v)}</span>` },
            { key: 'statutSellsy', label: 'Statut Sellsy' },
            { key: 'etatMonday', label: 'État Monday', format: v => `<span class="pill ${U.etatClass(v)}">${U.escapeHtml(v)}</span>` },
            { key: 'ecartStatut', label: 'Écart de statut', format: v =>
                v === 'payee_sellsy_seulement' ? '<span class="pill pill-danger">Encaissée dans Sellsy, ouverte dans Monday</span>'
                : v === 'payee_monday_seulement' ? '<span class="pill pill-soft">Réglée dans Monday, impayée dans Sellsy</span>'
                : '—' },
        ];
        if (vue === 'surnumeraires') return [
            num, client,
            { key: 'montant', label: 'Montant', align: 'right', format: v => U.euros(v) },
            { key: 'etat', label: 'État Monday', format: v => `<span class="pill ${U.etatClass(v)}">${U.escapeHtml(v)}</span>` },
            { key: 'dateFacture', label: 'Date de facture', align: 'center', format: U.dateFR },
            { key: 'board', label: 'Tableau Monday', format: v => `<span class="cell-clip" title="${U.escapeHtml(v || '')}">${U.escapeHtml(v || '—')}</span>` },
        ];
        return [
            num, client,
            { key: 'montant', label: 'Montant TTC', align: 'right',
              format: (v, r) => v == null ? '—' : (r.montantAberrant
                ? `<span class="pill pill-danger" title="Montant aberrant dans Sellsy : écarté des totaux">${U.euros(v)}</span>`
                : U.euros(v)) },
            { key: 'resteDu', label: 'Reste dû', align: 'right', format: v => v == null ? '—' : U.euros(v) },
            { key: 'statutLabel', label: 'Statut Sellsy', format: (v, r) => {
                const cls = r.paye ? 'pill-ok' : r.statut === 'partielle' ? 'pill-soft' : 'pill-danger';
                return `<span class="pill ${cls}" title="${U.escapeHtml(r.statutBrut || v)}">${U.escapeHtml(v)}</span>`;
            } },
            { key: 'dateFacture', label: 'Date de facture', align: 'center', format: U.dateFR },
            { key: 'dateEcheance', label: 'Échéance Sellsy', align: 'center', format: U.dateFR },
        ];
    }

    function rendreTableSellsy(res) {
        const vue = state.ui.sellsyVue;
        const def = VUES_SELLSY[vue];
        $('#sellsy-titre-table').textContent = def.titre;
        $('#sellsy-aide-table').textContent = def.aide;
        $$('#seg-sellsy-vue .seg-btn').forEach(b => b.classList.toggle('active', b.dataset.vue === vue));

        const cols = colonnesVueSellsy(vue);
        const t = state.ui.triSellsy;
        const rows = lignesVueSellsy(res, vue).slice();
        if (cols.some(c => c.key === t.key)) {
            rows.sort((a, b) => {
                let va = a[t.key], vb = b[t.key];
                if (va instanceof Date) va = va.getTime();
                if (vb instanceof Date) vb = vb.getTime();
                let cmp;
                if (typeof va === 'string' || typeof vb === 'string')
                    cmp = String(va || '').localeCompare(String(vb || ''), 'fr');
                else cmp = (va == null ? -Infinity : va) - (vb == null ? -Infinity : vb);
                return t.sens === 'asc' ? cmp : -cmp;
            });
        }

        const pageSize = state.ui.pageSize;
        const nbPages = Math.max(1, Math.ceil(rows.length / pageSize));
        if (state.ui.sellsyPage > nbPages) state.ui.sellsyPage = nbPages;
        const debut = (state.ui.sellsyPage - 1) * pageSize;
        const page = rows.slice(debut, debut + pageSize);

        const el = $('#sellsy-table');
        el.innerHTML = U.table(cols, page, {
            tri: t, onSort: true,
            vide: 'Rien à signaler dans cette vue — c\'est la bonne nouvelle.',
        });
        U.bindTable(el, page, {
            onSort: k => {
                t.sens = (t.key === k && t.sens === 'desc') ? 'asc' : 'desc';
                t.key = k;
                state.ui.sellsyPage = 1;
                rendreTout();
            },
            // Les factures Monday ont une fiche ; les lignes Sellsy pures, non.
            onRowClick: (r) => {
                const f = r.facture || (vue === 'surnumeraires' ? r : null);
                if (f) ouvrirFiche(f);
            },
        });

        const p = $('#sellsy-pagination');
        p.innerHTML = `
            <div class="pagination-info">${U.nombre(rows.length)} lignes${resumeMontantSellsy(vue, rows)}</div>
            <div class="pagination-controls">
                <button class="btn btn-ghost btn-sm" data-page="1" ${state.ui.sellsyPage === 1 ? 'disabled' : ''}>«</button>
                <button class="btn btn-ghost btn-sm" data-page="${state.ui.sellsyPage - 1}" ${state.ui.sellsyPage === 1 ? 'disabled' : ''}>‹</button>
                <span class="pagination-page">Page ${state.ui.sellsyPage} / ${nbPages}</span>
                <button class="btn btn-ghost btn-sm" data-page="${state.ui.sellsyPage + 1}" ${state.ui.sellsyPage >= nbPages ? 'disabled' : ''}>›</button>
                <button class="btn btn-ghost btn-sm" data-page="${nbPages}" ${state.ui.sellsyPage >= nbPages ? 'disabled' : ''}>»</button>
            </div>`;
        $$('[data-page]', p).forEach(b => b.addEventListener('click', () => {
            state.ui.sellsyPage = Math.max(1, Math.min(nbPages, +b.dataset.page));
            rendreTout();
        }));
    }

    /**
     * Le total du pied de table, aligné sur celui des tuiles.
     *
     * Trois factures Sellsy portent des montants absurdes — des centaines de
     * milliards. Les tuiles les écartent déjà ; le pied de table les sommait
     * brut et affichait −461 milliards juste en dessous. Les lignes Sellsy
     * passent donc par le même filtre, les « surnuméraires » non : ce sont des
     * factures Monday, pas des lignes Sellsy.
     */
    function resumeMontantSellsy(vue, rows) {
        if (vue === 'ecarts') return '';
        const mt = vue === 'surnumeraires'
            ? X.sum(rows, r => r.montant)
            : X.sum(rows, r => (r.montantAberrant ? null : r.montant));
        return mt ? ' · ' + U.euros(mt) : '';
    }

    // ── Import ──

    /**
     * Import des exports de facturation.
     *
     * Sellsy émet les factures d'aujourd'hui ; Zoho n'en émet plus, mais les
     * factures « FA-… » qu'il a émises figurent encore au grand livre et lui
     * seul porte leurs dates de formation. Les deux exports sont donc acceptés
     * ensemble et fusionnés sur le numéro de facture : ce qui compte est la
     * facture, pas l'outil qui l'a émise.
     *
     * La fusion ne remplace jamais : le premier fichier qui renseigne un champ
     * le garde, les suivants ne comblent que les vides.
     */
    async function importerSellsy(files) {
        const liste = Array.isArray(files) ? files : [files];
        if (!liste.length) return;
        try {
            const parCle = new Map();
            const journal = [], entetes = [];
            let mapping = null, ignorees = 0, lues = 0;

            for (const file of liste) {
                const rows = await lireFichier(file);
                if (!rows.length) { journal.push(`${file.name} : fichier vide`); continue; }

                const lu = SE.lireExport(rows);
                if (!lu.mapping.numero || !lu.lignes.length) {
                    journal.push(`${file.name} : aucun numéro de facture exploitable`);
                    continue;
                }
                if (!mapping) mapping = lu.mapping;
                else for (const [k, v] of Object.entries(lu.mapping)) if (!mapping[k]) mapping[k] = v;
                entetes.push(...lu.entetes.filter(h => !entetes.includes(h)));
                ignorees += lu.ignorees;
                lues += lu.lignes.length;

                for (const l of lu.lignes) {
                    const prec = parCle.get(l.cle);
                    if (!prec) { parCle.set(l.cle, { ...l, source: file.name }); continue; }
                    // Complément seulement : la première source qui renseigne
                    // un champ fait foi, les suivantes bouchent les trous.
                    for (const [k, v] of Object.entries(l)) {
                        if (v == null || v === '' ) continue;
                        if (prec[k] == null || prec[k] === '') prec[k] = v;
                    }
                }
                journal.push(`${file.name} : ${U.nombre(lu.lignes.length)} factures`);
            }

            if (!parCle.size) {
                U.toast("Aucun export exploitable. Un numéro de facture est indispensable. "
                    + journal.join(' · '), 'error', 12000);
                return;
            }

            state.sellsy = {
                lignes: [...parCle.values()], mapping: mapping || {}, entetes,
                ignorees, fichiers: journal,
                nomFichier: liste.length === 1 ? liste[0].name : `${liste.length} exports`,
                date: new Date().toISOString(),
            };
            await sauverSellsy();
            // Recalcul complet : l'export ne sert pas qu'au contrôle, il comble
            // aussi les montants et les dates manquants de Monday.
            recalculer({ conserverPeriode: true });

            const st = state.sellsyResultat ? state.sellsyResultat.stats : null;
            const c = state.sellsyStats || {};
            const complements = [
                c.montants ? `${U.nombre(c.montants)} montants` : '',
                c.datesFacture ? `${U.nombre(c.datesFacture)} dates de facture` : '',
                c.datesService ? `${U.nombre(c.datesService)} dates de formation` : '',
            ].filter(Boolean).join(', ');
            U.toast(`Facturation intégrée : ${U.nombre(state.sellsy.lignes.length)} factures `
                + `(${journal.join(' · ')})`
                + (st ? `, ${U.nombre(st.nbAbsentes)} absentes de Monday (${U.euros(st.eurosAbsentes)})` : '')
                + (complements ? `. ${complements} complétés dans Monday` : '') + '.',
                st && st.nbAbsentes ? 'error' : 'success', 11000);
        } catch (e) {
            U.toast(e.message, 'error', 9000);
        }
    }

    async function sauverSellsy() {
        try {
            await S.set(S.KEYS.sellsy, {
                ...state.sellsy,
                lignes: state.sellsy.lignes.map(l => ({
                    ...l,
                    dateFacture: l.dateFacture ? l.dateFacture.toISOString() : null,
                    dateEcheance: l.dateEcheance ? l.dateEcheance.toISOString() : null,
                    dateDebutService: l.dateDebutService ? l.dateDebutService.toISOString() : null,
                    dateFinService: l.dateFinService ? l.dateFinService.toISOString() : null,
                })),
            });
        } catch (e) { console.warn('[Recouvrement] Sauvegarde Sellsy impossible', e); }
    }

    function revivreSellsy(o) {
        if (!o || !o.lignes) return null;
        return {
            ...o,
            lignes: o.lignes.map(l => ({
                ...l,
                dateFacture: l.dateFacture ? R.parseDate(l.dateFacture) : null,
                dateEcheance: l.dateEcheance ? R.parseDate(l.dateEcheance) : null,
                dateDebutService: l.dateDebutService ? R.parseDate(l.dateDebutService) : null,
                dateFinService: l.dateFinService ? R.parseDate(l.dateFinService) : null,
            })),
        };
    }

    /** Export Excel du contrôle : une feuille par nature d'écart. */
    function exporterSellsy() {
        const res = state.sellsyResultat;
        if (!res) return;
        const wb = XLSX.utils.book_new();
        const st = res.stats;

        XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet([
            { Indicateur: 'Factures dans l\'export Sellsy', Valeur: st.nbSellsy },
            { Indicateur: 'Dont attendues dans Monday', Valeur: st.nbAttendues },
            { Indicateur: 'Absentes de Monday', Valeur: st.nbAbsentes },
            { Indicateur: 'Montant des absentes', Valeur: st.eurosAbsentes },
            { Indicateur: 'Reste à encaisser sur les absentes', Valeur: st.eurosAbsentesDues },
            { Indicateur: 'Absentes non réglées', Valeur: st.nbAbsentesImpayees },
            { Indicateur: 'Absentes déjà réglées', Valeur: st.nbAbsentesPayees },
            { Indicateur: 'Taux de couverture', Valeur: st.tauxCouverture },
            { Indicateur: 'Écarts de montant', Valeur: st.nbEcartMontant },
            { Indicateur: 'Encaissées dans Sellsy, ouvertes dans Monday', Valeur: st.nbPayeeSellsySeulement },
            { Indicateur: 'Réglées dans Monday, impayées dans Sellsy', Valeur: st.nbPayeeMondaySeulement },
            { Indicateur: 'Factures Monday inconnues de Sellsy', Valeur: st.nbSurnumeraires },
            { Indicateur: 'Factures Monday sans numéro', Valeur: st.nbMondaySansNumero },
            { Indicateur: 'Fichier', Valeur: state.sellsy.nomFichier || '' },
            { Indicateur: 'Version de l\'application', Valeur: VERSION + ' — ' + VERSION_DATE },
        ]), 'Synthèse');

        const ligneSellsy = l => ({
            'Numéro': l.numero, 'Client': l.client,
            'Montant TTC': l.montant, 'Reste dû': l.resteDu,
            'Statut Sellsy': l.statutLabel, 'Statut brut': l.statutBrut,
            'Date de facture': l.dateFacture ? U.dateFR(l.dateFacture) : '',
            'Échéance Sellsy': l.dateEcheance ? U.dateFR(l.dateEcheance) : '',
        });
        XLSX.utils.book_append_sheet(wb,
            XLSX.utils.json_to_sheet(res.absentes.map(ligneSellsy)), 'Absentes de Monday');

        XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(
            res.rapprochees.filter(r => r.ecartMontant != null || r.ecartStatut).map(r => ({
                'Numéro': r.sellsy.numero, 'Client': r.sellsy.client || r.facture.client,
                'Montant Sellsy': r.sellsy.montant, 'Montant Monday': r.facture.montant,
                'Écart': r.ecartMontant,
                'Statut Sellsy': r.sellsy.statutLabel, 'État Monday': r.facture.etat,
                'Écart de statut': r.ecartStatut === 'payee_sellsy_seulement'
                    ? 'Encaissée dans Sellsy, ouverte dans Monday'
                    : r.ecartStatut === 'payee_monday_seulement'
                        ? 'Réglée dans Monday, impayée dans Sellsy' : '',
                'Tableau Monday': r.facture.board,
            }))), 'Écarts');

        XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(
            res.surnumeraires.map(f => ({
                'Numéro': f.numero, 'Client': f.client, 'Montant': f.montant,
                'État Monday': f.etat, 'Tableau Monday': f.board, 'Groupe': f.groupe,
                'Date de facture': f.dateFacture ? U.dateFR(f.dateFacture) : '',
            }))), 'Inconnues de Sellsy');

        XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(
            SE.absentesParMois(res.absentes, state.sellsy.lignes).map(r => ({
                'Mois': r.mois, 'Factures Sellsy': r.total, 'Absentes': r.absentes,
                'Part absentes': r.part, 'Montant absent': r.euros,
            }))), 'Absentes par mois');

        XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(
            SE.absentesParClient(res.absentes, 200).map(r => ({
                'Client': r.client, 'Factures absentes': r.nb, 'Montant': r.euros,
            }))), 'Absentes par client');

        XLSX.writeFile(wb, `Controle_Sellsy_Monday_${new Date().toISOString().slice(0, 10)}.xlsx`);
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
        // Le contrôle qualité doit voir ce que le portefeuille écarte : les
        // annulées par avoir en sortent partout ailleurs, mais c'est ici qu'on
        // vient vérifier qu'elles sont bien annulées. Les autres filtres — la
        // période, le périmètre — s'appliquent quand même.
        const annulees = X.filtrer(state.factures, {
            ...state.filtres, etats: new Set(['Annulée par avoir']),
            masquerTechnique: state.options.masquerTechnique,
        });
        const population = annulees.length ? data.concat(annulees) : data;
        const anomalies = [...anomaliesImport(), ...X.qualite(population)];
        const score = X.scoreQualite(population, anomalies.filter(a => a.items));
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
        // Le découpage par tableau Monday a quitté le tableau de bord : il dit
        // où la facture se trouve, pas ce qu'elle est. Sa place est ici, avec
        // les tableaux et leur inventaire.
        rendreParTableau(X.parTableau(facturesFiltrees()));
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
                      nb: ecartees + ignorees, action: 'ecartees',
                      danger: brutes > 0 && (ecartees + ignorees) > brutes * 0.4,
                      note: (ignorees
                          ? `technique, archive, corbeille — dont ${U.nombre(ignorees)} lignes de tableaux de sous-éléments, qui ne sont pas des factures`
                          : 'technique, archive, corbeille')
                          + ' — cliquez pour voir de quels groupes il s\'agit' })
            + ligne({ signe: '=', label: 'Factures analysées', nb: analysees, fort: true,
                      note: 'ce que comptent les indicateurs, avant filtres de période et de source' })
            + ligneSellsyComplement();
    }

    /**
     * Le détail de ce qui est écarté comme « groupe de service ».
     *
     * Sur le tableau de recouvrement réel, trois groupes nommés « 1.2.9.
     * Technique — Service ADV / Archive / Tampon » portent 85 % des lignes.
     * Les écarter est juste quand les tableaux ADV et Tampon sont chargés — ces
     * factures y sont, à leur vraie étape. Ce ne l'est plus du tout quand ils ne
     * le sont pas : les factures disparaissent alors purement et simplement.
     * Le détail par groupe permet d'en juger, plutôt que de subir un total.
     */
    function montrerEcartees() {
        const ignorees = state.brutes.filter(f => f.role === 'ignore');
        const service = state.brutes.filter(f =>
            f.role !== 'ignore' && (f.role === 'technique' || R.estGroupeTechnique(f.groupe)));

        const parGroupe = new Map();
        for (const f of service.concat(ignorees)) {
            const cle = (f.board || '—') + ' › ' + (f.groupe || '(sans groupe)');
            let g = parGroupe.get(cle);
            if (!g) { g = { cle, board: f.board, groupe: f.groupe || '(sans groupe)', nb: 0,
                            euros: 0, motif: f.role === 'ignore' ? 'Tableau de sous-éléments'
                                : f.role === 'technique' ? 'Tableau technique' : 'Groupe de service' }; parGroupe.set(cle, g); }
            g.nb++; g.euros += f.montant || 0;
        }
        const rows = [...parGroupe.values()].sort((a, b) => b.nb - a.nb);

        // Une facture écartée ici mais présente ailleurs n'est pas perdue :
        // c'est la question qui compte, et elle a une réponse chiffrée.
        // Bâtie sur les factures qui SURVIVENT à l'écartement : la construire
        // sur state.factures entier y remettait les techniques elles-mêmes,
        // « perdues » était vide par construction et le message rassurant
        // s'affichait toujours, y compris quand les tableaux ADV et Tampon
        // n'étaient pas chargés — le cas précis qu'il est censé détecter.
        const cles = new Set(state.factures
            .filter(f => f.role !== 'technique' && !f.groupeTechnique)
            .map(f => f.cle).filter(Boolean));
        const perdues = service.filter(f => {
            const k = I.factureKey(f.numero);
            return k && !cles.has(k);
        });

        // La ligne de la chaîne compte des factures consolidées, ce tableau
        // des lignes brutes : les deux nombres diffèrent légitimement dès
        // qu'une même facture figure sur deux tableaux. Autant les donner tous
        // les deux plutôt que de laisser l'écart sans explication.
        const nbFactures = new Set(service.concat(ignorees)
            .map(f => I.factureKey(f.numero)).filter(Boolean)).size;

        U.modal(`Groupes et tableaux écartés — ${U.nombre(service.length + ignorees.length)} lignes`,
            `<p>Ces ${U.nombre(service.length + ignorees.length)} lignes brutes portent
             ${U.nombre(nbFactures)} numéros de facture distincts : c'est ce second nombre,
             une fois consolidé, que retranche la ligne « Groupes et tableaux de service ».
             Ces lignes sont retirées avant tout calcul. Un groupe d'archive, oui — mais
             « Technique — Service ADV » ou « Technique — Tampon » contiennent des factures bien
             vivantes, simplement garées là en attendant d'être traitées ailleurs. Les écarter est
             juste <strong>si le tableau qui les porte vraiment est chargé</strong> ; sinon elles
             disparaissent de tous les chiffres.</p>
             ${perdues.length
                ? `<p class="cell-danger"><strong>${U.nombre(perdues.length)} de ces factures
                   n'existent nulle part ailleurs dans les données chargées</strong>
                   (${U.euros(X.sum(perdues, f => f.montant))}) : pour celles-là, l'écartement est
                   une perte sèche. Chargez les tableaux ADV et Tampon pour les retrouver.</p>`
                : `<p>Bonne nouvelle : <strong>toutes ces factures existent aussi sur un autre
                   tableau chargé</strong>. Aucune n'est perdue — elles sont comptées une seule
                   fois, à leur vraie étape.</p>`}
             ${U.table([
                { key: 'groupe', label: 'Groupe' },
                { key: 'board', label: 'Tableau' },
                { key: 'motif', label: 'Motif' },
                { key: 'nb', label: 'Lignes', align: 'right', format: U.nombre },
                { key: 'euros', label: 'Montant', align: 'right', format: U.euros },
             ], rows, { vide: 'Aucun groupe écarté.' })}`,
            [{ label: 'Fermer', primary: true }]);
    }

    /**
     * Ce que l'export Sellsy a comblé dans Monday.
     *
     * La chaîne dit d'où viennent les factures ; cette ligne dit ce qui, dans
     * ces factures, ne venait pas de Monday. Sans elle, un montant apparu de
     * nulle part serait incompréhensible.
     */
    function ligneSellsyComplement() {
        const c = state.sellsyStats;
        if (!c || !c.rapprochees) return '';
        const details = [
            c.montants ? `${U.nombre(c.montants)} montants absents ou à zéro` : '',
            c.datesFacture ? `${U.nombre(c.datesFacture)} dates de facture` : '',
            c.datesService ? `${U.nombre(c.datesService)} dates de service` : '',
        ].filter(Boolean).join(', ');
        // Le nombre de valeurs complétées n'est pas un nombre de factures : mis
        // dans la colonne des comptes, sous « factures analysées », il se lisait
        // comme un ajout au total. Il reste hors de la chaîne.
        return `
            <div class="chaine-ligne chaine-retrait chaine-aparte">
                <span class="chaine-signe"></span>
                <span class="chaine-label">Complétées par la facturation</span>
                <span class="chaine-nb">${U.nombre(c.rapprochees)}</span>
                <span class="chaine-note">factures retrouvées dans Sellsy ou Zoho${
                    details ? ' — ' + U.escapeHtml(details) + ' y ont été repris'
                            : ''}. Ces valeurs complètent des factures déjà comptées : elles n'en ajoutent aucune.</span>
            </div>`;
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

            // Un tableau dont aucune ligne n'est arrivée n'a pas « perdu » ses
            // factures : il n'a pas été chargé. Les confondre affichait la
            // totalité d'un tableau en rouge — 6 471 factures « manquantes »
            // sur le tableau des factures payées — alors qu'il suffisait de le
            // charger. Les trois cas sont distingués.
            const aDesLignes = !!parBoard.get(b.name) || (b.charge || 0) > 0;
            r.nonCharge = !aDesLignes;
            r.manquantes = (!aDesLignes || b.itemsCount == null || b.charge == null)
                ? null : Math.max(0, b.itemsCount - b.charge);
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
            { key: 'charge', label: 'Chargées', align: 'right',
              title: 'Factures effectivement récupérées',
              format: (v, r) => r.nonCharge
                  ? '<span class="pill pill-muted" title="Ce tableau n\'a pas été chargé dans cette session">non chargé</span>'
                  : (v == null ? '—' : U.nombre(v)) },
            { key: 'manquantes', label: 'Manquantes', align: 'right',
              title: "Annoncées par Monday mais jamais récupérées — la seule perte réelle. "
                  + "Un tableau non chargé n'est pas compté ici.",
              format: (v, r) => r.nonCharge ? '—' : (v
                  ? `<button class="lien-cellule cell-danger" data-manquantes="${U.escapeHtml(r.name)}">${U.nombre(v)}</button>`
                  : '0') },
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
            // Tout l'état du grand livre, pas seulement les lignes lettrées :
            // les créances ouvertes sont persistées à part, et les oublier
            // laissait la balance âgée comptable survivre au retrait comme au
            // rechargement de la page.
            state.grandLivre = [];
            state.glOuvertes = [];
            state.glLignes = [];
            state.glEcritures = null;
            state.glCreances = [];
            state.glLecture = null;
            state.glBalance = null;
            state.glComparaison = null;
            await S.set(S.KEYS.grandLivre, []);
            await S.set('rec_gl_ouvertes', []);
            await S.set('rec_gl_lignes', []);
            await S.set('rec_gl_lecture', null);
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
                    // Lecture en matrice d'abord : un export Monday n'est pas
                    // rectangulaire (titre, groupe, en-tête, lignes, et on
                    // recommence), et lu à plat il ne donne qu'une colonne.
                    let matrice;
                    if (estCSV) {
                        matrice = Papa.parse(e.target.result, { header: false, skipEmptyLines: true, delimiter: '' }).data;
                    } else {
                        const wb = XLSX.read(e.target.result, { type: 'array', cellDates: true });
                        const sheet = wb.Sheets[wb.SheetNames[0]];
                        // raw:true, sinon un numéro de compte long revient dans
                        // le format d'affichage de sa cellule — « 4.1106E+12 »
                        // au lieu de 4110600400000 — et les chiffres sont
                        // perdus, pas seulement masqués. Les dates arrivent en
                        // objets Date grâce à cellDates, les montants en
                        // nombres : les deux sont déjà gérés en aval.
                        matrice = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: true, blankrows: false });
                    }
                    const groupe = I.aplatirExportMonday(matrice);
                    if (groupe) {
                        // Le vrai nom du tableau est écrit dans le fichier ;
                        // celui du fichier a perdu sa ponctuation en chemin.
                        // Il voyage sur le tableau de lignes, sans devenir une
                        // colonne qui polluerait le mapping.
                        Object.defineProperty(groupe.lignes, 'tableauMonday',
                            { value: groupe.tableau, enumerable: false });
                        Object.defineProperty(groupe.lignes, 'totauxMonday',
                            { value: groupe.totaux || 0, enumerable: false });
                        resolve(groupe.lignes);
                        return;
                    }

                    // Fichier rectangulaire ordinaire : la première ligne
                    // non vide est l'en-tête.
                    const entete = (matrice.find(r => (r || []).some(c => String(c == null ? '' : c).trim())) || [])
                        .map(c => String(c == null ? '' : c).trim());
                    const debut = matrice.indexOf(matrice.find(r => (r || []).some(c => String(c == null ? '' : c).trim())));
                    const lignes = [];
                    for (let i = debut + 1; i < matrice.length; i++) {
                        const r = matrice[i] || [];
                        if (!r.some(c => String(c == null ? '' : c).trim())) continue;
                        const o = {};
                        for (let c = 0; c < entete.length; c++) {
                            const nom = entete[c] || ('Colonne ' + (c + 1));
                            if (!(nom in o)) o[nom] = r[c] == null ? '' : r[c];
                        }
                        lignes.push(o);
                    }
                    resolve(lignes);
                } catch (err) { reject(err); }
            };
            if (estCSV) reader.readAsText(file, 'UTF-8');
            else reader.readAsArrayBuffer(file);
        });
    }

    async function importerFichiers(files) {
        if (!files || !files.length) return;

        // Un grand livre déposé dans la zone des tableaux se faisait charger
        // comme un tableau Monday : 15 875 écritures comptables devenaient des
        // « factures ADV ». Les zones se ressemblent, le fichier ne ment pas —
        // on le reconnaît à ses colonnes et on l'envoie où il doit aller.
        // L'écran de chargement d'abord : cette boucle lit les fichiers en
        // entier — plusieurs secondes sur un gros export, thread principal
        // bloqué — et se faisait jusqu'ici sans que rien ne l'annonce.
        montrerEcran('loading');
        $('#loader-log').innerHTML = '';
        statut('Analyse des fichiers');

        // Chaque fichier n'est lu qu'une fois : la lecture de reconnaissance
        // sert aussi à l'import, au lieu d'être refaite en pure perte.
        const lus = new Map();
        const restants = [];
        for (const file of files) {
            let entetes = null;
            try {
                const apercu = await lireFichier(file);
                lus.set(file, apercu);
                entetes = apercu.length ? Object.keys(apercu[0]) : null;
            } catch { /* illisible : la suite s'en chargera */ }
            if (entetes && GL.estComptable(GL.detecterColonnes(entetes))) {
                U.toast(`${file.name} est un grand livre, pas un tableau Monday : il part au bon endroit.`,
                    'info', 8000);
                await importerGrandLivre(file);
                continue;
            }
            restants.push(file);
        }
        if (!restants.length) {
            // Rien d'autre à importer : c'était un grand livre. Sans cela
            // l'écran d'accueil restait affiché, données chargées mais
            // inaccessibles jusqu'à un rechargement manuel de la page.
            montrerEcran('app');
            ouvrirOnglet('aging');
            return;
        }
        files = restants;

        statut('Lecture des fichiers');
        log(`${files.length} fichier(s) à traiter`);

        const collecte = state.brutes.filter(f => !String(f.boardId).startsWith('file:'));
        const dejaImportes = new Map(state.imports.map(im => [im.nom, im]));

        try {
            for (const file of files) {
                log(`→ ${file.name}`);
                const rows = lus.get(file) || await lireFichier(file);
                if (!rows.length) { log('   ⚠ fichier vide'); continue; }
                const nom = rows.tableauMonday || file.name.replace(/\.(csv|xlsx|xls)$/i, '');
                if (rows.tableauMonday) log(`   tableau reconnu : ${rows.tableauMonday}`);
                // Monday ferme chaque groupe par une ligne de totaux, qui n'est
                // pas une facture. Le dire : un écart de comptage face à Monday
                // s'explique alors tout seul.
                if (rows.totauxMonday) log(`   ${rows.totauxMonday} ligne(s) de total de groupe écartée(s)`);

                const detect = R.detectBoardRole(nom);
                const cfg = {
                    role: detect.role === 'ignore' ? 'adv' : detect.role,
                    perimetre: detect.perimetre === 'Inconnu' ? 'Corporate' : detect.perimetre,
                    source: detect.source || 'adv',
                    financementDefaut: detect.financementDefaut,
                    mapping: null,
                };
                const { factures, mapping, columns, couverture, repeches } = I.facturesFromRows(rows, cfg, nom);
                if (repeches) log(`   ${repeches} numéro(s) retrouvé(s) dans une colonne voisine`);

                // Le fichier devient un « tableau » de la configuration
                const id = 'file:' + nom;
                const existant = state.boards.find(b => b.id === id);
                const entree = {
                    id, name: nom, itemsCount: rows.length, workspace: 'Import fichier',
                    role: cfg.role, perimetre: cfg.perimetre, source: cfg.source,
                    financementDefaut: cfg.financementDefaut, actif: true,
                    columns, mapping, couverture, charge: factures.length,
                    totauxEcartes: rows.totauxMonday || 0, numerosRepeches: repeches || 0,
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

    /**
     * Import du grand livre client.
     *
     * Deux formats sont acceptés : l'extrait comptable lettré — une ligne par
     * écriture, la facture au débit et le règlement au crédit, rattachés par la
     * lettre de lettrage — et la simple liste « numéro + date de règlement ».
     * Le premier est reconnu à ses colonnes de lettrage et de débit/crédit.
     */
    async function importerGrandLivre(file) {
        try {
            const rows = await lireFichier(file);
            if (!rows.length) { U.toast('Fichier vide.', 'error'); return; }

            // Les numéros déjà connus — Monday et Sellsy — servent d'arbitre
            // quand un libellé de virement cite plusieurs références.
            const connus = new Set();
            for (const f of state.factures) if (f.cle) connus.add(f.cle);
            for (const l of state.sellsy.lignes) if (l.cle) connus.add(l.cle);

            const lu = GL.lire(rows, { numerosConnus: connus });
            if (lu.erreur) { U.toast(lu.erreur + ' Colonnes trouvées : '
                + lu.entetes.slice(0, 10).join(', '), 'error', 12000); return; }
            if (!lu.lignes.length) {
                U.toast("Aucune facture identifiable dans ce grand livre : ni numéro de facture "
                    + "au débit, ni lettrage exploitable.", 'error', 10000);
                return;
            }

            state.grandLivre = lu.lignes.map(l => ({
                ...l,
                datePaiement: l.datePaiement ? l.datePaiement.toISOString() : null,
                dateFacture: l.dateFacture ? l.dateFacture.toISOString() : null,
                dateEcheance: l.dateEcheance ? l.dateEcheance.toISOString() : null,
                dateAvoir: l.dateAvoir ? l.dateAvoir.toISOString() : null,
            }));
            state.glLecture = { ...lu.stats, fichier: file.name };

            // Ce que ce fichier sait classer entre dans le référentiel, sans
            // jamais l'effacer : chaque extrait qualifié enrichit le suivant.
            // Ce que le fichier sait classer entre dans le référentiel comme
            // piste, jamais par-dessus une qualification validée à la main :
            // une colonne collée d'un ancien tableau ne fait pas foi contre du
            // travail vérifié.
            const appris = GL.referentielDepuis(lu.lignes, state.rules);
            const avant = Object.keys(state.qualifRef).length;
            for (const [cle, v] of Object.entries(appris)) {
                const dejaLa = state.qualifRef[cle];
                const valide = dejaLa && typeof dejaLa !== 'string' && dejaLa.source === 'valide';
                if (!valide && typeof dejaLa !== 'string') state.qualifRef[cle] = v;
                else if (!dejaLa) state.qualifRef[cle] = v;
            }
            state.glApprises = Object.keys(state.qualifRef).length - avant;

            // Les créances ouvertes sont la matière de la balance âgée
            // comptable : elles sont conservées à part, le classement par
            // financement dépendant de Monday et de Sellsy, qui bougent.
            // Les écritures à plat : c'est elles qui portent les règlements, et
            // donc le classement de ce qui rentre.
            state.glLignes = GL.ecrituresAPlat(lu);

            state.glOuvertes = GL.creancesOuvertes(lu).map(c => ({
                ...c,
                dateFacture: c.dateFacture ? c.dateFacture.toISOString() : null,
                dateEcheance: c.dateEcheance ? c.dateEcheance.toISOString() : null,
            }));

            await S.set(S.KEYS.grandLivre, state.grandLivre);
            await S.set('rec_gl_lecture', state.glLecture);
            await S.set('rec_gl_ouvertes', state.glOuvertes);
            await S.set('rec_gl_lignes', state.glLignes.map(l => ({
                ...l, date: l.date ? l.date.toISOString() : null })));
            await S.set('rec_qualif_ref', state.qualifRef);
            recalculer({ conserverPeriode: true });
            rendreHistoriqueImports();

            const st = state.glStats || {};
            const l = lu.stats;
            U.toast(`Grand livre ${l.comptable ? 'comptable' : ''} intégré : `
                + `${U.nombre(l.nbFactures)} factures sur ${U.nombre(l.nbLignes)} écritures`
                + (l.numerosExtraits ? ` (dont ${U.nombre(l.numerosExtraits)} numéros lus dans le libellé)` : '')
                + `, `
                + `${U.nombre(l.nbSoldeesParReglement)} soldées par règlement`
                + (l.nbSoldeesParAvoir ? `, ${U.nombre(l.nbSoldeesParAvoir)} par avoir` : '')
                + (l.nbOuvertes ? `, ${U.nombre(l.nbOuvertes)} encore ouvertes` : '')
                + (state.glBalance ? ` — ${U.euros(state.glBalance.total.total)} de reste dû comptable` : '')
                + (state.glApprises ? `. ${U.nombre(state.glApprises)} nouvelles qualifications retenues `
                    + `(${U.nombre(Object.keys(state.qualifRef).length)} au total)` : '')
                + `. ${U.nombre(st.rapprochees || 0)} retrouvées dans Monday`
                + (st.completees ? `, ${U.nombre(st.completees)} dates complétées` : '')
                + (st.remplacees ? `, ${U.nombre(st.remplacees)} remplacées` : '') + '.',
                'success', 12000);
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
        // Les puces ne se mesurent qu'une fois l'écran affiché : tant qu'il
        // est masqué, toutes les largeurs valent zéro et rien n'est masqué.
        if (nom === 'app') requestAnimationFrame(() => {
            mesurerNavbar();
            ajusterChipsFinancements();
        });
    }

    function ouvrirOnglet(nom) {
        state.ui.onglet = nom;
        $$('.nav-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === nom));
        $$('.tab-content').forEach(c => c.classList.toggle('active', c.id === 'tab-' + nom));
        // La barre de filtres n'a pas de sens sur l'onglet Données
        // Le contrôle Sellsy porte sur la totalité des factures : un filtre y
        // ferait passer pour manquantes celles qu'il vient d'écarter.
        $('#filters-wrap').classList.toggle('hidden',
            nom === 'donnees' || nom === 'prelevements' || nom === 'sellsy');
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

        // Tableau « ALL - Factures payées » : reprend les factures réglées.
        // Comme dans les tableaux réels, les plus anciennes sont rangées dans le
        // groupe « payées avant import » : elles étaient déjà soldées quand le
        // circuit de recouvrement a été mis en place.
        const payees = brutes.filter(f => f.datePaiement || f.dateControlePaiement);
        const seuilImport = R.addDays(aujourdhui, -450);
        for (const f of payees) {
            const regle = f.datePaiement || f.dateControlePaiement;
            const avantImport = regle < seuilImport;
            brutes.push(I.buildFacture({
                numero: f.numero, client: f.client, montant: f.montant,
                dateFacture: f.dateFacture, datePaiement: f.datePaiement,
                dateControlePaiement: f.dateControlePaiement,
                financement: f.financementBrut, groupeOrigine: f.board, statut: 'Payée',
            }, {
                boardId: 'file:0.1. ALL - Factures payées', boardName: '0.1. ALL - Factures payées',
                role: 'payees', source: 'payees', perimetre: 'Tous', financementDefaut: null,
                groupTitle: avantImport
                    ? '0.1.2. Factures payées avant import + Entre process ADV et recouvrement'
                    : '0.1.1. Factures Payées ADV',
                itemId: 'pay' + f.itemId, itemName: f.numero,
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
        brancherZoneDepot('#sellsy-drop', '#sellsy-file-input', files => importerSellsy(files));
        $('#btn-sellsy-recharger').addEventListener('click', () => $('#sellsy-file-input-2').click());
        $('#sellsy-file-input-2').addEventListener('change', e => {
            if (e.target.files.length) importerSellsy([...e.target.files]);
            e.target.value = '';
        });
        $('#btn-sellsy-export').addEventListener('click', exporterSellsy);
        $$('#seg-sellsy-vue .seg-btn').forEach(b => b.addEventListener('click', () => {
            state.ui.sellsyVue = b.dataset.vue;
            state.ui.sellsyPage = 1;
            rendreTout();
        }));

        brancherZoneDepot('#prlv-drop', '#prlv-file-input', files => importerGoCardless(files));
        brancherZoneDepot('#gcl-drop', '#gcl-file-input', files => importerGoCardless(files));

        $('#btn-prlv-remplacer').addEventListener('click', () => $('#prlv-file-input-2').click());
        $('#prlv-file-input-2').addEventListener('change', e => {
            if (e.target.files.length) importerGoCardless([...e.target.files]);
            e.target.value = '';
        });

        // La place disponible change avec la fenêtre : le nombre de puces
        // affichables se remesure au redimensionnement.
        let minuteurPuces = null;
        window.addEventListener('resize', () => {
            clearTimeout(minuteurPuces);
            minuteurPuces = setTimeout(ajusterChipsFinancements, 120);
        });

        brancherActes();
        brancherFenetreMois();
        $$('#seg-vue-echeance .seg-btn').forEach(b => b.addEventListener('click', () => {
            state.ui.vueEcheance = b.dataset.vue;
            $$('#seg-vue-echeance .seg-btn').forEach(x => x.classList.toggle('active', x === b));
            rendreTout();
        }));
        $$('#seg-cmp-base .seg-btn').forEach(b => b.addEventListener('click', () => {
            state.ui.cmpBase = b.dataset.base;
            rendreApresClic(() => rendreTout());
        }));

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
        $$('#seg-prlv-fenetre .seg-btn').forEach(b => b.addEventListener('click', () => {
            state.ui.prlvFenetre = +b.dataset.fenetre;
            recalculerPrelevements();
            rendreApresClic(() => rendreTout());
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
        $('#btn-periode-ouvrir').addEventListener('click', () => {
            const c = $('#date-filter-months');
            const replie = c.classList.toggle('replie');
            $('#btn-periode-ouvrir').textContent = replie ? 'Choisir les mois' : 'Replier les mois';
            mesurerNavbar();
        });
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

        $$('#seg-tampon .seg-btn').forEach(b => b.addEventListener('click', () => {
            state.filtres.exclureTampon = b.dataset.tampon === 'exclure';
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
        $$('#seg-aging-source .seg-btn').forEach(b => b.addEventListener('click', () => {
            state.ui.agingSource = b.dataset.source;
            rendreApresClic(() => rendreTout());
        }));
        $('#btn-aging-gl-export').addEventListener('click', exporterBalanceGL);
        $('#btn-gl-orphelins-export').addEventListener('click', exporterOrphelins);
        $('#btn-gl-aclasser-export').addEventListener('click', exporterAClasser);
        $$('#seg-qualif-unite .seg-btn').forEach(b => b.addEventListener('click', () => {
            state.ui.qualifUnite = b.dataset.unite;
            rendreTout();
        }));
        $$('#seg-gl-aclasser .seg-btn').forEach(b => b.addEventListener('click', () => {
            state.ui.vueAClasser = b.dataset.vue;
            state.ui.selGL = new Set();
            rendreAClasser();
        }));

        // Arrondi pour lire, à l'euro pour recouper : le choix se conserve.
        for (const id of ['#btn-aging-precision', '#btn-aging-gl-precision']) {
            const b = $(id);
            if (!b) continue;
            b.addEventListener('click', async () => {
                state.options.montantsExacts = !state.options.montantsExacts;
                await sauverReglages();
                rendreTout();
            });
        }

        // Règles de classement : l'aperçu suit la frappe, pour qu'une règle
        // trop large se voie avant d'être écrite.
        ['#gl-regle-champ', '#gl-regle-op', '#gl-regle-val'].forEach(sel => {
            const e = $(sel);
            if (e) e.addEventListener('input', rendreApercuRegle);
        });
        $('#gl-regle-val').addEventListener('keydown', ev => {
            if (ev.key === 'Enter') { ev.preventDefault(); $('#gl-regle-ajouter').click(); }
        });
        $('#gl-regle-ajouter').addEventListener('click', () => {
            const r = regleDuFormulaire();
            if (!r.valeur) { U.toast('Écrivez le texte que la règle doit reconnaître.', 'error'); return; }
            if (!r.financement) { U.toast('Choisissez le financement à attribuer.', 'error'); return; }
            const etiq = GL.etiquetteRegle(r);
            if ((state.reglesClassement || []).some(x => GL.etiquetteRegle(x) === etiq)) {
                U.toast('Cette règle existe déjà.', 'error'); return;
            }
            const touchees = (state.glCreances || []).filter(c => GL.regleCorrespond(r, c));
            const neuves = touchees.filter(c => !c.financement).length;
            state.reglesClassement = (state.reglesClassement || []).concat([r]);
            $('#gl-regle-val').value = '';
            appliquerReglesClassement(`${etiq} → ${R.getRule(r.financement, state.rules).label}. `
                + `${U.nombre(neuves)} créance${neuves > 1 ? 's' : ''} à classer y trouve`
                + `${neuves > 1 ? 'nt' : ''} un financement. La règle est conservée : elle vaudra `
                + `aussi pour les prochains extraits.`);
        });
        $$('#seg-gl-niveau .seg-btn').forEach(b => b.addEventListener('click', () => {
            state.ui.glNiveau = b.dataset.niveau;
            recalculerBalanceGL();
            rendreApresClic(() => rendreTout());
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
            if (b) { montrerSansEcheance(b.dataset.sansEcheance); return; }
            const m = e.target.closest('[data-manquantes]');
            if (m) montrerManquantes(m.dataset.manquantes);
        });

        $('#chaine-traitement').addEventListener('click', (e) => {
            const l = e.target.closest('[data-chaine]');
            if (!l) return;
            if (l.dataset.chaine === 'doublons') montrerDoublons('attendus');
            if (l.dataset.chaine === 'doublons-op') montrerDoublons('op');
            if (l.dataset.chaine === 'doublons-payees') montrerDoublons('payees');
            if (l.dataset.chaine === 'ecartees') montrerEcartees();
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

    /**
     * La barre de filtres se cale sous la navbar, dont la hauteur varie — et
     * la barre d'actions du grand livre sous la barre de filtres, dont la
     * hauteur varie aussi selon que les mois sont dépliés ou non. Sans cette
     * mesure, un clic « aller à la section » amenait la barre sous les filtres,
     * où elle disparaissait.
     */
    function mesurerNavbar() {
        const nav = document.querySelector('#app-screen .navbar');
        if (nav && nav.offsetHeight) {
            document.documentElement.style.setProperty('--nav-h', nav.offsetHeight + 'px');
        }
        const f = document.getElementById('filters-wrap');
        if (f && f.offsetHeight) {
            document.documentElement.style.setProperty('--filters-h', f.offsetHeight + 'px');
        }
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
