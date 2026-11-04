/* ═══════════════════════════════════════════════════════════════════════
   L'ONGLET PILOTAGE
   ═══════════════════════════════════════════════════════════════════════

   Il ne lit PAS les tableaux Monday. Il lit la COMPTABILITÉ — le même grand
   livre Pennylane que la balance âgée clients — à travers un relevé
   précalculé, donnees/pilotage.json, fabriqué par balance-agee/pilotage.js.

   POURQUOI UN RELEVÉ, ET PAS LE GRAND LIVRE : le paquet publié ne porte que
   les neuf tableaux Monday, et l'API Pennylane est hors d'atteinte depuis un
   artefact. Le relevé tient en quelques centaines de kilo-octets parce qu'il
   est agrégé ; il est refait au dépôt d'un nouveau grand livre, et pas à
   chaque relève horaire.

   CE QU'IL PORTE :
     · treize fins de mois, chacune un VRAI ARRÊTÉ — lettrage, rapprochement,
       imputation au prorata et ancienneté refaits à la date. Le dernier point
       est la balance publiée : les deux se recollent au centime.
     · les flux du mois : facturé, encaissé, avoirs, hors reports à nouveau.
     · le délai de règlement, mesuré facture par facture.
     · les vintages : ce qui reste dû d'une cohorte de facturation.

   AUCUN CHIFFRE N'EST INVENTÉ ICI. Quand le relevé manque, l'onglet le dit et
   n'affiche rien — « ma balance agé doit etre auditable, il faut mettre à
   completer », 15/10/2026.
   ═══════════════════════════════════════════════════════════════════════ */
(function (global) {
    'use strict';

    const U = () => global.LioraUI;
    let D = null;            // le relevé
    let erreur = '';         // pourquoi il manque, le cas échéant

    // ── l'état des filtres, qui n'appartient qu'à cet onglet ──
    //
    // La barre de filtres du tableau de bord porte sur les factures Monday ;
    // celle-ci porte sur la comptabilité. Les mêlanger donnerait un écran dont
    // on ne saurait pas ce qu'il montre.
    const F = {
        periode: 'exercice',     // raccourci choisi
        du: '', au: '',          // dates, quand la période est personnalisée
        comparaison: '',         // '', 'M-1'..'M-3', 'A-1'..'A-3'
        unites: new Set(),       // vide = toutes
        financeurs: new Set(),   // vide = tous
    };

    // ═════════ le relevé ═════════

    async function charger() {
        if (D || erreur) return D;
        // Même garde que les données du jour : sans le drapeau, la page locale
        // n'a rien à côté d'elle et une requête sans réponse la laisserait
        // pendue.
        if (!global.LIORA_DONNEES_DU_JOUR) {
            erreur = 'Le relevé comptable n’est pas déposé à côté de cette page.';
            return null;
        }
        try {
            const a = new AbortController();
            setTimeout(() => a.abort(), 30000);
            const r = await fetch('donnees/pilotage.json', { cache: 'no-store', signal: a.signal });
            if (!r.ok) { erreur = 'Le relevé comptable n’a pas été publié avec cette page.'; return null; }
            D = await r.json();
        } catch (e) {
            erreur = 'Le relevé comptable n’a pas pu être lu.';
            return null;
        }
        return D;
    }

    // ═════════ les périodes ═════════

    const moisDe = iso => String(iso || '').slice(0, 7);
    const dernierJour = (a, m) => new Date(a, m + 1, 0);
    const iso = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0')
        + '-' + String(d.getDate()).padStart(2, '0');

    // L'exercice de Liora court du 1er juillet au 30 juin : c'est celui que
    // porte son filtre Pennylane, et le seul qui ait un sens pour un arrêté.
    function exercice(d, recul) {
        const a = d.getMonth() >= 6 ? d.getFullYear() : d.getFullYear() - 1;
        return { du: (a - (recul || 0)) + '-07-01', au: (a + 1 - (recul || 0)) + '-06-30' };
    }

    function bornes() {
        const fin = D && D.arrete ? parseFR(D.arrete) : new Date();
        switch (F.periode) {
            case 'exercice': return exercice(fin, 0);
            case 'exercice-1': return exercice(fin, 1);
            case 'mois': return { du: iso(new Date(fin.getFullYear(), fin.getMonth(), 1)),
                                  au: iso(dernierJour(fin.getFullYear(), fin.getMonth())) };
            case 'mois-1': return { du: iso(new Date(fin.getFullYear(), fin.getMonth() - 1, 1)),
                                    au: iso(dernierJour(fin.getFullYear(), fin.getMonth() - 1)) };
            case 'trimestre': { const t = Math.floor(fin.getMonth() / 3) * 3;
                return { du: iso(new Date(fin.getFullYear(), t, 1)),
                         au: iso(dernierJour(fin.getFullYear(), t + 2)) }; }
            case 'annee': return { du: fin.getFullYear() + '-01-01', au: fin.getFullYear() + '-12-31' };
            case 'annee-1': return { du: (fin.getFullYear() - 1) + '-01-01',
                                     au: (fin.getFullYear() - 1) + '-12-31' };
            case 'douze': { const d = new Date(fin.getFullYear(), fin.getMonth() - 11, 1);
                return { du: iso(d), au: iso(fin) }; }
            default: return { du: F.du || '', au: F.au || '' };
        }
    }

    function parseFR(s) {
        const t = String(s || '');
        if (/^\d{4}-\d{2}-\d{2}/.test(t)) return new Date(+t.slice(0, 4), +t.slice(5, 7) - 1, +t.slice(8, 10));
        if (/^\d{2}\/\d{2}\/\d{4}/.test(t)) return new Date(+t.slice(6, 10), +t.slice(3, 5) - 1, +t.slice(0, 2));
        return new Date();
    }

    // LA PÉRIODE S'ARRÊTE OÙ S'ARRÊTENT LES ÉCRITURES.
    //
    // L'exercice court jusqu'au 30 juin, mais le grand livre s'arrête à la
    // date d'arrêté : « du 01/07/2026 au 30/06/2027 » ne porte en réalité que
    // quatre mois de facturation. Comparer cela à douze mois pleins annonçait
    // « −33 749 684 € » — vrai au centime, et illisible.
    function finObservee(b) {
        const arrete = D && D.arrete ? D.arrete : '';
        if (!arrete) return b.au;
        return (!b.au || arrete < b.au) ? arrete : b.au;
    }

    // Le décalage demandé par le filtre de comparaison, appliqué aux bornes —
    // et à la DURÉE ÉCOULÉE, pas à la durée annoncée : on compare quatre mois
    // à quatre mois.
    function bornesComparaison() {
        const c = F.comparaison; if (!c) return null;
        const b = bornes(); if (!b.du || !b.au) return null;
        const m = /^M-(\d)$/.exec(c), a = /^A-(\d)$/.exec(c);
        const recule = (s, mois, ans) => { const d = parseFR(s);
            return iso(new Date(d.getFullYear() - (ans || 0), d.getMonth() - (mois || 0), d.getDate())); };
        const fin = finObservee(b);
        if (m) return { du: recule(b.du, +m[1], 0), au: recule(fin, +m[1], 0), quoi: 'M-' + m[1] };
        if (a) return { du: recule(b.du, 0, +a[1]), au: recule(fin, 0, +a[1]), quoi: 'A-' + a[1] };
        return null;
    }

    // ═════════ les financeurs retenus ═════════

    function tousFinanceurs() {
        const s = new Set();
        (D.flux || []).forEach(r => s.add(r.fin));
        (D.encours || []).forEach(e => (e.parFinancement || []).forEach(r => s.add(r.cat)));
        return [...s].sort();
    }

    function uniteDe(fin) {
        const u = (D && D.unites) || {};
        for (const nom of Object.keys(u)) if ((u[nom] || []).indexOf(fin) >= 0) return nom;
        return 'à rattacher';
    }

    function retenus() {
        const tous = tousFinanceurs();
        let l = tous;
        if (F.unites.size) l = l.filter(f => F.unites.has(uniteDe(f)));
        if (F.financeurs.size) l = l.filter(f => F.financeurs.has(f));
        return new Set(l);
    }

    // ═════════ les agrégats ═════════

    const dans = (m, b) => (!b.du || m >= moisDe(b.du)) && (!b.au || m <= moisDe(b.au));

    function flux(b, keep) {
        let fac = 0, enc = 0, avo = 0, nFac = 0;
        for (const r of (D.flux || [])) {
            if (!keep.has(r.fin) || !dans(r.m, b)) continue;
            fac += r.fac; enc += r.enc; avo += r.avo; nFac += r.nFac;
        }
        return { fac, enc, avo, nFac };
    }

    function delai(b, keep) {
        let mt = 0, mj = 0, n = 0;
        for (const r of (D.dso || [])) {
            if (!keep.has(r.fin) || !dans(r.m, b)) continue;
            mt += r.mt; mj += r.mj; n += r.n;
        }
        return { jours: mt ? mj / mt : null, montant: mt, n };
    }

    // L'arrêté retenu : le dernier qui ne dépasse pas la fin de la période.
    //
    // ET RIEN, S'IL N'Y EN A PAS. Les treize arrêtés ne remontent pas au-delà
    // d'octobre 2025 : pour une comparaison à l'année N-1, il n'existe pas
    // d'encours à montrer. Retomber sur le dernier arrêté connu donnait un
    // écart calculé entre deux dates qui n'étaient pas celles annoncées — un
    // chiffre faux, et faux en silence.
    // ET RIEN VEUT DIRE RIEN, 04/11/2026. Une période entièrement antérieure
    // au premier arrêté — « du 01/01/2024 au 31/12/2024 » — affichait l'encours
    // du jour, 14 132 742 €, sous une étiquette 2024 : un chiffre juste à la
    // mauvaise date est un chiffre faux. On ne retombe plus sur le dernier
    // arrêté connu ; l'absence se dit.
    function arreteRetenu(b) {
        const l = (D.encours || []).filter(e => !b.au || e.d <= b.au);
        return l.length ? l[l.length - 1] : null;
    }

    function encours(e, keep) {
        if (!e) return null;
        const nT = (D.tranches || []).length;
        const o = { total: 0, echu: 0, nonEchu: 0, crediteur: 0, nb: 0,
                    buckets: new Array(nT).fill(0) };
        for (const r of (e.parFinancement || [])) {
            if (!keep.has(r.cat)) continue;
            o.total += r.total || 0; o.echu += r.echu || 0; o.nonEchu += r.nonEchu || 0;
            o.crediteur += r.crediteur || 0; o.nb += r.nb || 0;
            (r.buckets || []).forEach((v, j) => { o.buckets[j] += v || 0; });
        }
        o.date = e.d;
        return o;
    }

    // Les tranches au-delà de 120 jours de retard : la balance les nomme
    // « 4 à 6 mois » et au-delà — 121 jours commence là.
    function indexAuDela120() {
        const t = D.tranches || [];
        const i = t.indexOf('4 à 6 mois');
        return i >= 0 ? i : Math.min(2, t.length - 1);
    }

    // ═════════ le rendu ═════════

    function vignette(libelle, valeur, sous, note) {
        return '<div class="kpi-card"><div class="kpi-data">'
            + '<span class="kpi-label">' + U().escapeHtml(libelle) + '</span>'
            + '<span class="kpi-value">' + valeur + '</span>'
            + (sous ? '<span class="kpi-sub">' + sous + '</span>' : '')
            + (note ? '<span class="kpi-sub pil-comparaison">' + note + '</span>' : '')
            + '</div></div>';
    }

    const eur = v => U().euros(v);
    const pct = v => (v === null || v === undefined || !isFinite(v)) ? '—'
        : (Math.round(v * 1000) / 10).toLocaleString('fr-FR') + ' %';
    const jrs = v => (v === null || v === undefined || !isFinite(v)) ? '—'
        : Math.round(v).toLocaleString('fr-FR') + ' j';

    function ecart(maintenant, avant, format, sens) {
        if (avant === null || avant === undefined || !isFinite(avant) || !isFinite(maintenant)) return '';
        const d = maintenant - avant;
        const signe = d > 0 ? '+' : '';
        const bon = sens === 'bas' ? d < 0 : d > 0;
        const cls = Math.abs(d) < 0.0001 ? '' : (bon ? ' pil-mieux' : ' pil-moins');
        return '<span class="' + cls.trim() + '">' + signe
            + (format === 'pct' ? pct(d) : format === 'j' ? jrs(d) : eur(d)) + '</span>';
    }

    function rendre() {
        const u = U();
        const hote = document.getElementById('tab-pilotage');
        if (!hote) return;
        if (!D) {
            document.getElementById('pil-vide').hidden = false;
            document.getElementById('pil-vide').textContent = erreur
                || 'Le relevé comptable n’est pas encore chargé.';
            document.getElementById('pil-corps').hidden = true;
            return;
        }
        document.getElementById('pil-vide').hidden = true;
        document.getElementById('pil-corps').hidden = false;

        const keep = retenus();
        const b = bornes();
        const bc = bornesComparaison();
        const e = encours(arreteRetenu(b), keep);
        const ec = bc ? encours(arreteRetenu(bc), keep) : null;
        const f = flux(b, keep), fc = bc ? flux(bc, keep) : null;
        const d = delai(b, keep), dc = bc ? delai(bc, keep) : null;

        majBandeau(b, e);
        majVignettes(e, ec, f, fc, d, dc, bc);
        graphAncienneté(keep);
        graphHeatmap(e);
        graphRetard(keep);
        graphDecroissance(keep);
        graphVintage(keep);
        graphDso(keep);
        graphBridge(keep, b);
    }

    function majBandeau(b, e) {
        const el = document.getElementById('pilotage-badge');
        if (!el) return;
        const d = x => x ? parseFR(x).toLocaleDateString('fr-FR') : '—';
        const fin = finObservee(b);
        el.textContent = 'du ' + d(b.du) + ' au ' + d(b.au)
            + (fin && fin !== b.au ? ' — écritures jusqu’au ' + d(fin) : '')
            + ' · encours arrêté au ' + (e && e.date ? parseFR(e.date).toLocaleDateString('fr-FR') : '—')
            + ' · source : grand livre Pennylane';
    }

    function majVignettes(e, ec, f, fc, d, dc, bc) {
        const i120 = indexAuDela120();
        const audela = e ? e.buckets.slice(i120).reduce((a, x) => a + x, 0) : 0;
        const audelaC = ec ? ec.buckets.slice(i120).reduce((a, x) => a + x, 0) : 0;
        const taux = e && e.total ? audela / e.total : null;
        const tauxC = ec && ec.total ? audelaC / ec.total : null;
        // LA COUVERTURE NE SE CALCULE QUE SUR LE PÉRIMÈTRE ENTIER.
        //
        // Le compte 491 porte un stock global : la comptabilité ne le ventile
        // pas par financeur ni par équipe. Le rapporter à un encours filtré
        // comparerait une provision de tout le portefeuille à une fraction des
        // créances, et annoncerait une couverture de 300 % sur un périmètre
        // étroit. Dès qu'un filtre est posé, la vignette le dit et se tait.
        const P = D.provision || {};
        const prov = P.comptabilisee;
        const filtre = F.unites.size > 0 || F.financeurs.size > 0;
        const couv = (!filtre && prov !== null && prov !== undefined && e && e.total)
            ? prov / e.total : null;
        const quoi = bc ? ' <span class="pil-ref">vs ' + bc.quoi + '</span>' : '';
        // Quand l'encours de la période de comparaison n'existe pas, on ne
        // montre pas d'écart : on dit qu'il n'y en a pas.
        const sansArrete = bc && !ec
            ? ' <span class="pil-ref">pas d’arrêté au ' + parseFR(bc.au).toLocaleDateString('fr-FR') + '</span>'
            : '';

        const v = [];
        v.push(vignette('Total facturé', eur(f.fac),
            f.nFac.toLocaleString('fr-FR') + ' factures',
            fc ? ecart(f.fac, fc.fac, 'eur', 'haut') + quoi : ''));
        // L'ABSENCE D'ARRÊTÉ SE DIT, elle ne se remplace pas par le dernier connu.
        const rien = '<span class="pil-acompleter">aucun arrêté dans cette période</span>';
        v.push(vignette('Total encours', e ? eur(e.total) : '—',
            e ? 'échu ' + eur(e.echu) + ' · non échu ' + eur(e.nonEchu) : rien,
            (e && ec) ? ecart(e.total, ec.total, 'eur', 'bas') + quoi : (e ? sansArrete : '')));
        v.push(vignette('Échu de plus de 120 jours', e ? pct(taux) : '—',
            e ? eur(audela) + ' sur ' + eur(e.total) : rien,
            (e && tauxC !== null) ? ecart(taux, tauxC, 'pct', 'bas') + quoi : (e ? sansArrete : '')));
        v.push(vignette('DSO', jrs(d.jours),
            d.n ? d.n.toLocaleString('fr-FR') + ' règlements · ' + eur(d.montant) : 'aucun règlement daté',
            dc && dc.jours !== null ? ecart(d.jours, dc.jours, 'j', 'bas') + quoi : ''));
        const lue = P.provisionLue || null;
        v.push(vignette('Couverture des provisions',
            couv === null ? '<span class="pil-acompleter">à compléter</span>' : pct(couv),
            couv !== null
                ? eur(prov) + ' provisionnés sur ' + eur(e.total) + ' de créances'
                : (filtre && prov !== null && prov !== undefined)
                  ? 'le compte 491 n’est pas ventilé par financeur : décochez les filtres pour la lire'
                  : (P.provisionMotif || 'le montant comptablement provisionné n’est pas déposé'),
            // UN RELEVÉ N'A PAS D'ÉCRITURES, IL A UNE DATE. Annoncer « 1 écriture »
            // pour un solde relevé à la main laisserait croire à un grand livre
            // dépouillé ligne à ligne. La date, elle, dit ce qu'il faut savoir :
            // à quand remonte le chiffre comparé à l'encours du jour.
            couv !== null && lue
                ? '<span class="pil-ref">compte ' + U().escapeHtml((lue.comptes || []).join(', '))
                  + ' · ' + (lue.au ? 'relevé au ' + U().escapeHtml(lue.au)
                                    : (lue.lignes || 0).toLocaleString('fr-FR') + ' écritures')
                  + '</span>'
                : ''));
        document.getElementById('pil-kpis').innerHTML = v.join('');
    }

    // ── 1. l'encours par ancienneté, treize mois ──
    //
    // Les bandes sont celles de la balance, regroupées pour rester lisibles :
    // c'est son aging, et le graphique doit se superposer à sa balance plutôt
    // que d'inventer une seconde échelle.
    const BANDES = [
        { nom: 'Non échu', tr: [], nonEchu: true, c: '#3b82f6' },
        { nom: '0 à 3 mois', tr: ['0 à 3 mois'], c: '#14b8a6' },
        { nom: '3 à 6 mois', tr: ['3 à 4 mois', '4 à 6 mois'], c: '#84cc16' },
        { nom: '6 à 12 mois', tr: ['6 à 12 mois'], c: '#eab308' },
        { nom: '1 à 2 ans', tr: ['12 à 18 mois', '18 à 24 mois'], c: '#f59e0b' },
        { nom: 'Plus de 2 ans', tr: ['24 à 36 mois', '36 à 48 mois', '> 48 mois'], c: '#ef4444' },
    ];

    function bandesDe(e) {
        const t = D.tranches || [];
        return BANDES.map(b => b.nonEchu ? (e ? e.nonEchu : 0)
            : b.tr.reduce((s, nom) => s + ((e && e.buckets[t.indexOf(nom)]) || 0), 0));
    }

    function graphAncienneté(keep) {
        const pts = (D.encours || []).map(x => encours(x, keep));
        const labels = pts.map(p => parseFR(p.date).toLocaleDateString('fr-FR', { month: 'short', year: '2-digit' }));
        const series = BANDES.map((b, j) => ({
            label: b.nom, backgroundColor: b.c, borderWidth: 0,
            data: pts.map(p => Math.round(bandesDe(p)[j])),
        }));
        U().chart('pil-chart-ancienneté', {
            type: 'bar',
            data: { labels, datasets: series },
            options: {
                responsive: true, maintainAspectRatio: false,
                scales: { x: { stacked: true, grid: { display: false } },
                          y: { stacked: true, grid: U().grille,
                               ticks: { callback: v => U().eurosCourt(v) } } },
                plugins: { legend: { position: 'bottom' },
                           tooltip: { callbacks: { label: c => c.dataset.label + ' : ' + eur(c.raw) } } },
            },
        });
    }

    // ── 2. la carte de chaleur par financeur ──
    //
    // Ses cinq colonnes, et un dégradé qui dit le risque : plus la créance est
    // vieille, plus la case est chaude. La valeur se lit dans la case — une
    // couleur seule ne se recopie pas dans un dossier.
    const COLONNES = [
        { nom: 'Non échu', nonEchu: true, tr: [] },
        { nom: '0 à 3 mois', tr: ['0 à 3 mois'] },
        { nom: '3 à 6 mois', tr: ['3 à 4 mois', '4 à 6 mois'] },
        { nom: '6 à 12 mois', tr: ['6 à 12 mois'] },
        { nom: 'Plus d’un an', tr: ['12 à 18 mois', '18 à 24 mois', '24 à 36 mois', '36 à 48 mois', '> 48 mois'] },
    ];

    function graphHeatmap(e) {
        const el = document.getElementById('pil-heatmap');
        if (!el) return;
        const arrete = arreteRetenu(bornes());
        if (!arrete) { el.innerHTML = '<p class="pil-vide">Aucun arrêté dans cette période :'
            + ' le relevé commence au ' + parseFR((D.encours || [{}])[0].d || '').toLocaleDateString('fr-FR')
            + '.</p>'; return; }
        const keep = retenus();
        const t = D.tranches || [];
        const lignes = (arrete.parFinancement || []).filter(r => keep.has(r.cat))
            .map(r => ({ fin: r.cat, unite: uniteDe(r.cat), total: r.total || 0,
                cases: COLONNES.map(c => c.nonEchu ? (r.nonEchu || 0)
                    : c.tr.reduce((s, nom) => s + ((r.buckets || [])[t.indexOf(nom)] || 0), 0)) }))
            .filter(r => Math.abs(r.total) > 0.005)
            .sort((a, b) => b.total - a.total);
        if (!lignes.length) { el.innerHTML = '<p class="pil-vide">Aucun encours sur ce périmètre.</p>'; return; }
        // LA CHALEUR DIT LE RISQUE, PAS LE VOLUME.
        //
        // Colorée sur la seule part de la ligne, la colonne « Non échu »
        // ressortait en rouge vif chez les financeurs qui payent bien — soit
        // exactement l'inverse de ce qu'on veut lire. L'intensité est donc le
        // produit de deux choses : la part que cette tranche pèse dans la
        // ligne, et le poids de risque de la tranche elle-même. Une créance
        // non échue ne porte aucun risque : sa case reste neutre.
        const RISQUE = [0, 0.18, 0.45, 0.75, 1];
        const chaleur = (v, tot, j) => {
            if (!tot || v <= 0 || !RISQUE[j]) return 'background:transparent';
            const p = Math.max(0, Math.min(1, v / tot)) * RISQUE[j];
            return 'background:rgba(239,68,68,' + (0.05 + p * 0.68).toFixed(3) + ')';
        };
        const tot = COLONNES.map((_, j) => lignes.reduce((s, r) => s + r.cases[j], 0));
        let h = '<table class="pil-heat"><thead><tr><th>Financeur</th><th>Équipe</th>'
            + COLONNES.map(c => '<th class="n">' + c.nom + '</th>').join('')
            + '<th class="n">Total</th></tr></thead><tbody>';
        for (const r of lignes) {
            h += '<tr><td class="fam">' + U().escapeHtml(r.fin) + '</td>'
                + '<td>' + U().escapeHtml(r.unite) + '</td>'
                + r.cases.map((v, j) => '<td class="n" style="' + chaleur(v, r.total, j) + '">'
                    + eur(v) + '</td>').join('')
                + '<td class="n"><strong>' + eur(r.total) + '</strong></td></tr>';
        }
        h += '<tr class="total"><td>TOTAL</td><td></td>'
            + tot.map(v => '<td class="n">' + eur(v) + '</td>').join('')
            + '<td class="n">' + eur(tot.reduce((a, b) => a + b, 0)) + '</td></tr>';
        h += '</tbody></table>';
        el.innerHTML = h;
    }

    // ── 3. le taux de retard par financeur, mois après mois ──
    //
    // UN RATIO NE SE TRACE PAS SUR UN DÉNOMINATEUR QUI FRÔLE ZÉRO. Interco
    // ferme à −6 960 € et OPCO passe par un solde quasi nul : leur part échue
    // montait alors à 1 000 % et écrasait l'échelle, où tous les autres se
    // lisent entre 20 et 80 %. On ne retient donc que les financeurs qui
    // pèsent, et on ne pose un point que là où le dénominateur tient debout.
    const PLANCHER = 50000;
    function graphRetard(keep) {
        const fins = [...keep].filter(f => (D.encours || []).some(e =>
            (e.parFinancement || []).some(r => r.cat === f && (r.total || 0) >= PLANCHER)));
        const labels = (D.encours || []).map(e =>
            parseFR(e.d).toLocaleDateString('fr-FR', { month: 'short', year: '2-digit' }));
        const pal = U().palette;
        const series = fins.map((f, k) => ({
            label: f, borderColor: pal[k % pal.length], backgroundColor: 'transparent',
            borderWidth: 2, tension: 0.3, pointRadius: 2,
            spanGaps: true,
            data: (D.encours || []).map(e => {
                const r = (e.parFinancement || []).find(x => x.cat === f);
                if (!r || (r.total || 0) < PLANCHER) return null;
                return Math.round(r.echu / r.total * 1000) / 10;
            }),
        }));
        U().chart('pil-chart-retard', {
            type: 'line',
            data: { labels, datasets: series },
            options: {
                responsive: true, maintainAspectRatio: false,
                scales: { x: { grid: { display: false } },
                          y: { grid: U().grille, min: 0, max: 100,
                               ticks: { callback: v => v + ' %' } } },
                plugins: { legend: { position: 'bottom' },
                           tooltip: { callbacks: { label: c => c.dataset.label + ' : ' + c.raw + ' %' } } },
            },
        });
        // CE QUI N'EST PAS TRACÉ SE DIT. Un financeur écarté parce qu'il pèse
        // moins de 50 000 € ne doit pas disparaître en silence.
        const el = document.getElementById('pil-retard-dit');
        if (el) {
            const dernier = (D.encours || [])[(D.encours || []).length - 1] || { parFinancement: [] };
            const ecartes = [...keep].filter(f => fins.indexOf(f) < 0)
                .filter(f => (dernier.parFinancement || []).some(r => r.cat === f
                    && Math.abs(r.total || 0) > 0.005));
            el.textContent = 'La part échue de l’encours de chaque financeur, arrêté après arrêté.'
                + (ecartes.length
                   ? ' Écartés, parce qu’ils pèsent moins de ' + eur(PLANCHER)
                     + ' et que leur ratio n’aurait aucun sens : ' + ecartes.join(', ') + '.'
                   : '');
        }
    }

    // ── 4. les vintages, mois de facturation par mois de facturation ──
    //
    // « Des vintage par mois de facturation (abscisse — met d jours) », puis
    // « les vintages ne doivent pas être en fonction de cohorte », 04/11/2026.
    // L'AXE EST EN JOURS, PAS EN MOIS. Il portait l'âge en mois — la maille des
    // arrêtés — et c'était une maille, pas une demande : elle a demandé des
    // jours. Chaque point garde donc l'âge RÉEL du mois de facturation à la
    // date de l'arrêté, compté depuis le 15 du mois — le jour moyen d'une
    // facturation étalée sur le mois ; la dater du 1er la vieillirait de
    // quinze jours. Les points d'une même courbe ne tombent plus à intervalle
    // régulier : ils tombent là où sont les arrêtés, et c'est juste.
    //
    // CE QUI RENTRE SE LIT SUR LES ARRÊTÉS, PAS SUR LES RÈGLEMENTS. Bâtie sur
    // les seuls encaissements rattachables à une facture datée, la courbe
    // laissait dehors 330 règlements sans facture et 1 909 dont la facture n'a
    // pas de date connue, et annonçait moins encaissé qu'il n'en rentre. Le
    // reste dû d'un arrêté, lui, tient compte de tout ce qui éteint une
    // facture — paiement, avoir, lettrage — et se recolle à la balance par
    // construction.
    function cohortesJours(keep) {
        const parMois = new Map();   // mois de facturation -> Map(âge en jours -> {f, r})
        for (const e of (D.cohortes || [])) {
            const da = parseFR(e.d); if (!da) continue;
            for (const l of (e.lignes || [])) {
                if (!keep.has(l.fin)) continue;
                const dm = new Date(+l.m.slice(0, 4), +l.m.slice(5, 7) - 1, 15);
                const j = Math.round((da - dm) / 86400000);
                if (j < 0) continue;
                const t = parMois.get(l.m) || new Map();
                const o = t.get(j) || { f: 0, r: 0 };
                o.f += l.f; o.r += l.r;
                t.set(j, o); parMois.set(l.m, t);
            }
        }
        return parMois;
    }

    // ═════════ ce qui reste dû, jour après jour depuis la facturation ═════════
    //
    // « Des vintage par mois de facturation (abscisse — met d jours) / encours
    // client (ordonné) par financeur — évolution de l'encours client — on doit
    // pv voir 80% de mon encours et payé av X j », 04/11/2026.
    //
    // ELLE SE LIT SUR LES ARRÊTÉS, PAS SUR LES RÈGLEMENTS. Bâtie sur les seuls
    // encaissements datables, la courbe plafonnait à 59 % de reste dû quand la
    // balance en publie 30 : elle ignorait les 18 293 726 € d'avoirs — dont
    // AUCUN ne porte de facture rattachée datée — et les 7 103 219 € de
    // règlements qu'aucune facture ne réclame. Un arrêté, lui, tient compte de
    // tout ce qui éteint une facture : paiement, avoir, lettrage. Chaque point
    // vient donc d'une balance refaite à cette date, et la courbe cadre avec
    // l'encours publié.
    //
    // L'ÂGE SE COMPTE DEPUIS LE 15 DU MOIS DE FACTURATION — le jour moyen d'une
    // facturation étalée sur le mois. Dater toute une cohorte du 1er la
    // vieillirait de quinze jours.
    //
    // DEUX BORNES, SANS QUOI RIEN NE SE LIT. Sans elles la courbe courait
    // jusqu'à 2 400 jours — l'âge d'une cohorte de 2020 vue au dernier arrêté,
    // quelques milliers d'euros qui font sauter le tracé — et quatorze
    // financeurs se croisaient en pelote. L'horizon s'arrête donc à un AN, où
    // se prend une décision de recouvrement, et le dessin garde les financeurs
    // qui pèsent. Ce qui est écarté est nommé sous le graphique.
    const DECROISSANCE_JOURS = 360;
    const DECROISSANCE_COURBES = 7;
    function graphDecroissance(keep) {
        const dit = document.getElementById('pil-decroissance-dit');
        const parFin = new Map();
        for (const e of (D.cohortes || [])) {
            const da = parseFR(e.d); if (!da) continue;
            for (const l of (e.lignes || [])) {
                if (!keep.has(l.fin) || !(l.f > 0)) continue;
                const dm = new Date(+l.m.slice(0, 4), +l.m.slice(5, 7) - 1, 15);
                const j = Math.round((da - dm) / 86400000);
                if (j < 0 || j > DECROISSANCE_JOURS + 15) continue;
                const pas = Math.round(j / 30) * 30;
                const t = parFin.get(l.fin) || new Map();
                const o = t.get(pas) || { f: 0, r: 0 };
                o.f += l.f; o.r += l.r;
                t.set(pas, o); parFin.set(l.fin, t);
            }
        }
        if (!parFin.size) {
            U().chart('pil-chart-decroissance', { type: 'line', data: { labels: [], datasets: [] },
                options: { responsive: true, maintainAspectRatio: false,
                           plugins: { legend: { display: false } } } });
            if (dit) dit.textContent = 'Aucune cohorte de facturation sur le périmètre retenu.';
            return;
        }
        const ages = [...new Set([].concat(...[...parFin.values()].map(t => [...t.keys()])))]
            .sort((a, b) => a - b);
        // UNE COURBE TIRÉE DE TROIS MILLE EUROS NE DIT RIEN : elle saute au gré
        // d'une facture. Le plancher les écarte du dessin, et la note les nomme.
        const PLANCHER = 100000;
        const poids = f => [...(parFin.get(f) || new Map()).values()]
            .reduce((s, o) => Math.max(s, o.f), 0);
        const assez = [...parFin.keys()].filter(f => poids(f) >= PLANCHER)
            .sort((a, b) => poids(b) - poids(a));
        const gardes = assez.slice(0, DECROISSANCE_COURBES);
        const ecartes = [...parFin.keys()].filter(f => poids(f) > 0 && assez.indexOf(f) < 0)
            .concat(assez.slice(DECROISSANCE_COURBES));
        const val = (f, a) => { const o = (parFin.get(f) || new Map()).get(a);
            return (o && o.f > 0) ? Math.max(0, Math.round((o.r / o.f) * 1000) / 10) : null; };
        // Le jour où la courbe passe sous 20 % de reste dû, interpolé entre les
        // deux âges qui l'encadrent.
        const croisement = f => {
            let avant = null, vAvant = null;
            for (const a of ages) { const v = val(f, a); if (v == null) continue;
                if (v <= 20) { if (avant == null || vAvant === v) return a;
                    return Math.round(avant + (vAvant - 20) * (a - avant) / (vAvant - v)); }
                avant = a; vAvant = v; }
            return null;
        };
        const palette = U().palette;
        const series = gardes.map((f, k) => ({
            label: f, borderColor: palette[k % palette.length], backgroundColor: 'transparent',
            borderWidth: 2, tension: 0.25, pointRadius: 2, spanGaps: true,
            data: ages.map(a => val(f, a)),
        }));
        series.push({ label: '20 % — quatre cinquièmes encaissés', borderColor: '#8b92a5',
            borderDash: [5, 4], borderWidth: 1, pointRadius: 0, backgroundColor: 'transparent',
            data: ages.map(() => 20) });
        U().chart('pil-chart-decroissance', {
            type: 'line',
            data: { labels: ages.map(a => a + ' j'), datasets: series },
            options: {
                responsive: true, maintainAspectRatio: false,
                scales: { x: { grid: { display: false } },
                          y: { grid: U().grille, min: 0, max: 100,
                               ticks: { callback: v => v + ' %' } } },
                plugins: {
                    legend: { display: true, position: 'bottom',
                              labels: { boxWidth: 12, font: { size: 11 } } },
                    tooltip: { callbacks: { label: c => c.dataset.label + ' : '
                        + (c.parsed.y == null ? '·' : c.parsed.y + ' % encore dû') } },
                },
            },
        });
        // Toutes natures confondues, sur le même périmètre.
        const tous = new Map();
        for (const [, t] of parFin) for (const [a, o] of t) {
            const x = tous.get(a) || { f: 0, r: 0 }; x.f += o.f; x.r += o.r; tous.set(a, x); }
        parFin.set('\u0000tous', tous);
        const jours = croisement('\u0000tous');
        parFin.delete('\u0000tous');
        const parNom = gardes.map(f => { const j = croisement(f);
            return f + ' ' + (j == null ? '— jamais sous 20 %' : j + ' j'); });
        if (dit) dit.textContent =
            (jours == null
              ? 'Sur le périmètre retenu, le reste dû d’une cohorte ne descend sous 20 % à aucun âge observé.'
              : 'Sur le périmètre retenu, 80 % de ce qui est facturé est éteint en ' + jours + ' jours.')
            + ' Par financeur, ce même seuil : ' + parNom.join(' · ') + '.'
            + (ecartes.length ? ' Hors du dessin, pour qu’il se lise : ' + ecartes.join(', ')
                + '.' : '')
            + ' Chaque point vient d’un arrêté refait à sa date : paiements, avoirs et lettrage'
            + ' y sont tous comptés, et le dernier point cadre avec l’encours publié.'
            + ' L’horizon s’arrête à un an — au-delà, une seule vieille cohorte suffit à'
            + ' faire sauter le tracé.';
    }

    function graphVintage(keep) {
        const parMois = cohortesJours(keep);
        // Les douze derniers mois de facturation qui ont de quoi se juger.
        const mois = [...parMois.keys()]
            .filter(m => [...parMois.get(m).values()].some(o => o.f > 0))
            .sort().slice(-12);
        const pal = U().palette;
        const courbe = m => [...parMois.get(m)]
            .filter(([, o]) => o.f > 0)
            .sort((a, b) => a[0] - b[0])
            .map(([j, o]) => ({ x: j, y: Math.round((1 - o.r / o.f) * 1000) / 10 }));
        const series = mois.map((m, k) => ({
            label: U().moisLabel ? U().moisLabel(m, true) : m,
            borderColor: pal[k % pal.length], backgroundColor: 'transparent',
            borderWidth: 2, tension: 0.25, pointRadius: 2, data: courbe(m),
        }));
        // LE SEUIL SE LIT SUR L'AXE, DONC IL SE TRACE DESSUS : la ligne des
        // 80 % encaissés dit d'un coup d'œil quelle courbe l'a franchie.
        const bornes = series.reduce((b, s2) => s2.data.reduce(
            (c, p) => [Math.min(c[0], p.x), Math.max(c[1], p.x)], b), [0, 0]);
        series.push({ label: '80 % encaissés', borderColor: '#8b92a5',
            borderDash: [5, 4], borderWidth: 1, pointRadius: 0,
            backgroundColor: 'transparent',
            data: [{ x: bornes[0], y: 80 }, { x: bornes[1], y: 80 }] });
        U().chart('pil-chart-vintage', {
            type: 'line',
            data: { datasets: series },
            options: {
                responsive: true, maintainAspectRatio: false,
                parsing: false, normalized: true,
                scales: {
                    x: { type: 'linear', grid: { display: false },
                         title: { display: true, text: 'jours depuis la facturation' },
                         ticks: { callback: v => v + ' j' } },
                    y: { grid: U().grille, min: 0, max: 100,
                         ticks: { callback: v => v + ' %' } },
                },
                plugins: {
                    legend: { position: 'bottom', labels: { boxWidth: 12, font: { size: 11 } } },
                    tooltip: { callbacks: {
                        title: c => 'facturé en ' + c[0].dataset.label,
                        label: c => c.parsed.y + ' % encaissé au bout de '
                            + c.parsed.x + ' jours' } },
                },
            },
        });
        // La lecture en une phrase : au bout de combien de JOURS 80 % rentre.
        // Le jour exact est interpolé entre les deux arrêtés qui l'encadrent —
        // un arrêté tombe fin de mois, le franchissement, lui, tombe un jour.
        const el = document.getElementById('pil-vintage-dit');
        if (!el) return;
        const jour80 = m => {
            const pts = courbe(m); let av = null;
            for (const p of pts) {
                if (p.y >= 80) return av && av.y < 80
                    ? Math.round(av.x + (80 - av.y) * (p.x - av.x) / (p.y - av.y))
                    : p.x;
                av = p;
            }
            return null;
        };
        const atteints = mois.map(jour80).filter(j => j !== null).sort((a, b) => a - b);
        const encore = mois.filter(m => jour80(m) === null);
        const med = atteints.length
            ? (atteints.length % 2 ? atteints[(atteints.length - 1) / 2]
               : Math.round((atteints[atteints.length / 2 - 1] + atteints[atteints.length / 2]) / 2))
            : null;
        el.textContent = !mois.length
            ? 'Pas assez de mois de facturation pour se prononcer.'
            : 'Une courbe par mois de facturation, l’âge en jours depuis le 15 du mois —'
              + ' le jour moyen d’une facturation étalée. '
              + (med === null
                 ? 'Aucun de ces ' + mois.length + ' mois n’a encore encaissé 80 % de son facturé.'
                 : 'Sur ' + atteints.length + ' des ' + mois.length + ' mois retenus,'
                   + ' 80 % du facturé est encaissé en ' + med + ' jours en médiane'
                   + (atteints.length > 1
                      ? ' — de ' + atteints[0] + ' à ' + atteints[atteints.length - 1] + ' jours'
                      : '') + '.')
            + (encore.length
               ? ' Pas encore à 80 % : ' + encore.map(m => U().moisLabel ? U().moisLabel(m, true) : m)
                   .join(', ') + '.'
               : '')
            + ' Chaque point vient d’un arrêté refait à sa date : paiements, avoirs et'
            + ' lettrage y sont tous comptés.';
    }

    // ── 5. la variation du DSO ──
    function graphDso(keep) {
        const parMois = new Map();
        for (const r of (D.dso || [])) {
            if (!keep.has(r.fin)) continue;
            const o = parMois.get(r.m) || { mt: 0, mj: 0 };
            o.mt += r.mt; o.mj += r.mj; parMois.set(r.m, o);
        }
        const mois = [...parMois.keys()].sort().slice(-18);
        U().chart('pil-chart-dso', {
            type: 'line',
            data: {
                labels: mois,
                datasets: [{
                    label: 'DSO du mois', borderColor: U().couleurs.accent,
                    backgroundColor: 'rgba(244,116,88,0.12)', fill: true,
                    borderWidth: 2, tension: 0.3, pointRadius: 2,
                    data: mois.map(m => { const o = parMois.get(m);
                        return o.mt ? Math.round(o.mj / o.mt) : null; }),
                }],
            },
            options: {
                responsive: true, maintainAspectRatio: false,
                scales: { x: { grid: { display: false } },
                          y: { grid: U().grille, ticks: { callback: v => v + ' j' } } },
                plugins: { legend: { display: false },
                           tooltip: { callbacks: { label: c => 'délai moyen pondéré : ' + c.raw + ' jours' } } },
            },
        });
    }

    // ── 6. le pont des encours, d'un arrêté au suivant ──
    //
    // Ce qu'elle demande : « encours en N 500 000 à N+1 600 000 — 100 000 à
    // expliquer — payé, annulé, facturé par exemple ». Les trois postes sont
    // lus dans les flux du mois ; ce qui reste est nommé « autres mouvements »
    // et n'est pas dissimulé : lettrage, reclassements, écarts d'arrondi.
    function graphBridge(keep, b) {
        const pts = (D.encours || []);
        if (pts.length < 2) return;
        const el0 = document.getElementById('pil-bridge-dit');
        const fin = arreteRetenu(b);
        if (!fin) {
            U().chart('pil-chart-bridge', { type: 'bar', data: { labels: [], datasets: [] },
                options: { responsive: true, maintainAspectRatio: false,
                           plugins: { legend: { display: false } } } });
            if (el0) el0.textContent = 'Aucun arrêté dans cette période : rien à expliquer.';
            return;
        }
        const k = pts.indexOf(fin);
        const dep = pts[Math.max(0, k - 1)];
        const a = encours(dep, keep), z = encours(fin, keep);
        const m = moisDe(fin.d);
        let fac = 0, enc = 0, avo = 0;
        for (const r of (D.flux || [])) {
            if (!keep.has(r.fin) || r.m !== m) continue;
            fac += r.fac; enc += r.enc; avo += r.avo;
        }
        const autres = z.total - a.total - fac + enc + avo;
        const postes = [
            { nom: 'Encours au ' + parseFR(dep.d).toLocaleDateString('fr-FR'), v: a.total, type: 'socle' },
            { nom: 'Facturé', v: fac, type: 'plus' },
            { nom: 'Encaissé', v: -enc, type: 'moins' },
            { nom: 'Avoirs', v: -avo, type: 'moins' },
            { nom: 'Autres mouvements', v: autres, type: autres >= 0 ? 'plus' : 'moins' },
            { nom: 'Encours au ' + parseFR(fin.d).toLocaleDateString('fr-FR'), v: z.total, type: 'socle' },
        ];
        // Une cascade se dessine en barres flottantes : chaque poste porte son
        // point de départ et son point d'arrivée. Le curseur part du socle de
        // gauche et marche de poste en poste jusqu'à celui de droite.
        let curseur = a.total;
        const data = postes.map(p => {
            if (p.type === 'socle') return [0, p.v];
            const de = curseur, vers = curseur + p.v; curseur = vers; return [de, vers];
        });
        U().chart('pil-chart-bridge', {
            type: 'bar',
            data: {
                // CHAQUE BARRE PORTE SON MONTANT, ET SON SIGNE, 04/11/2026 :
                // « j'ai pas compris ». Une cascade dont les barres n'ont que
                // leur nom oblige à survoler chacune pour savoir si elle ajoute
                // ou retranche — et la couleur seule ne le dit pas, puisqu'ici
                // elle dit l'effet sur le recouvrement, pas le sens du pas.
                labels: postes.map(p => p.type === 'socle'
                    ? [p.nom, eur(p.v)]
                    : [p.nom, (p.v >= 0 ? '+' : '−') + eur(Math.abs(p.v))]),
                datasets: [{
                    data,
                    backgroundColor: postes.map(p => p.type === 'socle' ? '#6366f1'
                        : p.type === 'plus' ? '#ef4444' : '#84cc16'),
                    borderWidth: 0,
                }],
            },
            options: {
                responsive: true, maintainAspectRatio: false,
                scales: { x: { grid: { display: false } },
                          y: { grid: U().grille, ticks: { callback: v => U().eurosCourt(v) } } },
                plugins: {
                    legend: { display: false },
                    tooltip: { callbacks: { label: c2 => {
                        const p = postes[c2.dataIndex];
                        return p.type === 'socle' ? eur(p.v)
                            : (p.v >= 0 ? '+' : '') + eur(p.v); } } },
                },
            },
        });
        // LA PHRASE DISAIT « DONT », ET C'ÉTAIT FAUX. « −248 035 € à expliquer,
        // dont 1 899 548 € facturés » laissait croire que les 1,9 M€ étaient une
        // PART des 248 k€, alors qu'ils en sont un terme de sens contraire. Les
        // postes se rangent donc par sens : ce qui fait monter l'encours d'un
        // côté, ce qui le fait baisser de l'autre, et le solde entre les deux.
        const monte = [], baisse = [];
        (fac > 0 ? monte : baisse).push(eur(Math.abs(fac)) + ' facturés');
        if (Math.abs(enc) > 0.5) baisse.push(eur(Math.abs(enc)) + ' encaissés');
        if (Math.abs(avo) > 0.5) baisse.push(eur(Math.abs(avo)) + ' d’avoirs');
        if (Math.abs(autres) > 0.5)
            (autres > 0 ? monte : baisse).push(eur(Math.abs(autres)) + ' d’autres mouvements');
        const et = l => l.length > 1
            ? l.slice(0, -1).join(', ') + ' et ' + l[l.length - 1] : (l[0] || '');
        const delta = z.total - a.total;
        const el = document.getElementById('pil-bridge-dit');
        if (el) el.textContent = 'L’encours passe de ' + eur(a.total) + ' à ' + eur(z.total)
            + ', soit ' + (delta >= 0 ? '+' : '−') + eur(Math.abs(delta)) + '. '
            + (monte.length ? 'Il monte de ' + et(monte) + '. ' : '')
            + (baisse.length ? 'Il baisse de ' + et(baisse) + '. ' : '')
            + 'En rouge ce qui le fait monter, en vert ce qui le fait baisser.';
    }

    // ═════════ les filtres, à l'écran ═════════

    // UN FILTRE À CHOIX MULTIPLE QUI S'OUVRE. Le bouton dit ce qui est retenu —
    // rien de coché veut dire TOUT, et c'est ce que le bouton annonce. Un clic
    // ailleurs ou la touche Échap referme : un panneau ouvert qui recouvre un
    // graphique est pire qu'un filtre encombrant.
    function brancherDeroule(idB, idP, tout, ens) {
        const b = document.getElementById(idB), p = document.getElementById(idP);
        if (!b || !p || b.dataset.pret) return;
        b.dataset.pret = '1';
        const etiquette = () => {
            const n = ens.size, l = [...ens];
            b.textContent = !n ? tout : (n <= 2 ? l.join(', ') : n + ' sélectionnés');
            b.title = !n ? tout : l.join(', ');
        };
        const fermer = () => {
            document.querySelectorAll('.pil-deroule-panneau').forEach(x => { x.hidden = true; });
            document.querySelectorAll('.pil-deroule-bouton')
                .forEach(x => x.setAttribute('aria-expanded', 'false'));
        };
        b.addEventListener('click', e => {
            e.stopPropagation();
            const ouvert = !p.hidden;
            fermer();
            if (ouvert) return;
            p.hidden = false; b.setAttribute('aria-expanded', 'true');
        });
        p.addEventListener('click', e => e.stopPropagation());
        document.addEventListener('click', fermer);
        document.addEventListener('keydown', e => { if (e.key === 'Escape') fermer(); });
        // Après le gestionnaire qui met F à jour : l'étiquette lit l'ensemble.
        p.addEventListener('change', etiquette);
        etiquette();
    }

    // UNE CASE « TOUS » EN TÊTE DE LISTE, 04/11/2026 : « j'ai pas tous ».
    // Aucune case cochée vaut bien TOUTES, mais rien ne le disait : un
    // financeur coché, il fallait deviner qu'il suffisait de le décocher pour
    // revoir le portefeuille entier. La case le dit et le fait. Elle n'est pas
    // un financeur de plus : elle EST l'absence de filtre, donc elle se coche
    // seule quand l'ensemble est vide, et on ne peut pas la décocher dans le
    // vide — décocher « tous » ne voudrait rien dire.
    const enTete = t => '<label class="pil-coche pil-coche-tout">'
        + '<input type="checkbox" data-tout="1" checked> ' + U().escapeHtml(t) + '</label>';
    function toutCocher(panneau, ens, source) {
        ens.clear();
        panneau.querySelectorAll('input[type="checkbox"]').forEach(i => {
            if (!i.dataset.tout) i.checked = false;
        });
        if (source) source.checked = true;
    }
    function majTout(panneau, ens) {
        const t = panneau.querySelector('input[data-tout]');
        if (t) t.checked = ens.size === 0;
    }

    function peuplerFiltres() {
        if (!D) return;
        const us = document.getElementById('pil-unites');
        const fs = document.getElementById('pil-financeurs');
        const ligne = n => '<label class="pil-coche"><input type="checkbox" value="'
            + U().escapeHtml(n) + '"> ' + U().escapeHtml(n) + '</label>';
        if (us && !us.dataset.pret) {
            const noms = Object.keys((D && D.unites) || {});
            us.innerHTML = enTete('Toutes les business units') + noms.map(ligne).join('');
            us.dataset.pret = '1';
            us.addEventListener('change', e => {
                if (e.target.dataset.tout) { toutCocher(us, F.unites, e.target); rendre(); return; }
                const v = e.target.value;
                if (e.target.checked) F.unites.add(v); else F.unites.delete(v);
                majTout(us, F.unites);
                rendre();
            });
        }
        if (fs && !fs.dataset.pret) {
            fs.innerHTML = enTete('Tous les financeurs') + tousFinanceurs().map(ligne).join('');
            fs.dataset.pret = '1';
            fs.addEventListener('change', e => {
                if (e.target.dataset.tout) { toutCocher(fs, F.financeurs, e.target); rendre(); return; }
                const v = e.target.value;
                if (e.target.checked) F.financeurs.add(v); else F.financeurs.delete(v);
                majTout(fs, F.financeurs);
                rendre();
            });
        }
        brancherDeroule('pil-unites-bouton', 'pil-unites', 'Toutes', F.unites);
        brancherDeroule('pil-financeurs-bouton', 'pil-financeurs', 'Tous', F.financeurs);
    }

    function brancher() {
        const p = document.getElementById('pil-periode');
        if (p && !p.dataset.pret) {
            p.dataset.pret = '1';
            p.addEventListener('change', () => {
                F.periode = p.value;
                const libre = document.getElementById('pil-dates');
                if (libre) libre.hidden = p.value !== 'libre';
                rendre();
            });
        }
        for (const id of ['pil-du', 'pil-au']) {
            const el = document.getElementById(id);
            if (el && !el.dataset.pret) {
                el.dataset.pret = '1';
                el.addEventListener('change', () => {
                    F.du = document.getElementById('pil-du').value;
                    F.au = document.getElementById('pil-au').value;
                    F.periode = 'libre';
                    const s = document.getElementById('pil-periode'); if (s) s.value = 'libre';
                    rendre();
                });
            }
        }
        const c = document.getElementById('pil-comparaison');
        if (c && !c.dataset.pret) {
            c.dataset.pret = '1';
            c.addEventListener('change', () => { F.comparaison = c.value; rendre(); });
        }
    }

    async function ouvrir() {
        brancher();
        if (!D && !erreur) {
            const v = document.getElementById('pil-vide');
            if (v) { v.hidden = false; v.textContent = 'Lecture du relevé comptable…'; }
            await charger();
            peuplerFiltres();
        }
        rendre();
    }

    global.LioraPilotage = { charger, ouvrir, rendre, etat: () => ({ D, erreur, F }) };
})(window);
