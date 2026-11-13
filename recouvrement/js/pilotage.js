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
     · l'encours par financeur, jour après jour depuis la facture.

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
    // « 2026-03 » ne se lit pas, « mars 26 » si. Les deux formes servent :
    // la courte sur un axe, la longue en titre de bloc.
    const moisFR = m => { const d = new Date(+String(m).slice(0, 4), +String(m).slice(5, 7) - 1, 1);
        return isNaN(d) ? String(m) : d.toLocaleDateString('fr-FR', { month: 'short', year: '2-digit' }); };
    const moisFRLong = m => { const d = new Date(+String(m).slice(0, 4), +String(m).slice(5, 7) - 1, 1);
        return isNaN(d) ? String(m) : d.toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' }); };
    // Un nombre à une décimale, à la française : 23,7 et non 23.7.
    const nb1 = v => (Math.round(v * 10) / 10).toLocaleString('fr-FR',
        { minimumFractionDigits: 1, maximumFractionDigits: 1 });

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

        majSortieFiltre();
        majBandeau(b, e);
        majVignettes(e, ec, f, fc, d, dc, bc);
        graphAncienneté(keep);
        graphHeatmap(e);
        graphRetard(keep);
        graphDso(keep);
        graphDegrade(keep);
        graphVintage(keep);
        brefDuMois(keep);
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
    // UNE ANCIENNETÉ N'EST PAS UNE LISTE DE CATÉGORIES, 12/11/2026.
    //
    // Les six bandes portaient six teintes sans rapport — bleu, turquoise,
    // vert, or, ambre, rouge. Un arc-en-ciel sur une donnée ORDONNÉE : rien
    // dans les couleurs ne disait que « 1 à 2 ans » est pire que « 3 à 6
    // mois », et le vert, qui veut dire « ça va », tombait au milieu de
    // l'échu. L'œil devait relire la légende à chaque bande.
    //
    // Les cinq tranches échues prennent donc UNE SEULE teinte — l'orange
    // Liora — du clair au foncé : la gravité se lit sans légende. Le non échu
    // n'est pas une tranche d'ancienneté mais son absence : il reste neutre,
    // en gris, et ne se confond avec aucune.
    const BANDES = [
        { nom: 'Non échu', tr: [], nonEchu: true, c: '#9A948D' },
        { nom: '0 à 3 mois', tr: ['0 à 3 mois'], c: '#F2BBA4' },
        { nom: '3 à 6 mois', tr: ['3 à 4 mois', '4 à 6 mois'], c: '#E8906B' },
        { nom: '6 à 12 mois', tr: ['6 à 12 mois'], c: '#D9532E' },
        { nom: '1 à 2 ans', tr: ['12 à 18 mois', '18 à 24 mois'], c: '#A8381B' },
        { nom: 'Plus de 2 ans', tr: ['24 à 36 mois', '36 à 48 mois', '> 48 mois'], c: '#6E2210' },
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
            label: b.nom, backgroundColor: b.c,
            borderWidth: 2, borderColor: '#FFFFFF', borderSkipped: false,
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
        // LE DSO SE LIT À CÔTÉ DU DÉLAI, PAS CONTRE LUI, 12/11/2026.
        //
        // La version 2 colore l'écart entre le DSO et le délai cible du
        // financeur. C'est faux sans en avoir l'air : une facture CPF émise au
        // début d'un parcours qui se termine six mois plus tard affiche plus de
        // trois cents jours de DSO en étant parfaitement dans les temps, parce
        // que son échéance court depuis la FIN de formation, pas depuis la
        // facture. Un écart calculé là-dessus désignerait les bons payeurs.
        //
        // Les deux colonnes se posent donc côte à côte, sans soustraction et
        // sans couleur : le DSO mesuré, et la règle qui s'applique à ce
        // financeur au grand livre. Qui veut comparer compare, en sachant ce
        // qu'il compare.
        // DEUX DSO CÔTE À CÔTE, 13/11/2026. « tu passe de 600j env à 0 ».
        //
        // La colonne suivait la période choisie. Sur un mois, Region affichait
        // 19 j : le délai d'UNE facture de 1 590 €, posé à côté de 520 544 €
        // d'encours dont 493 865 € dorment depuis plus d'un an. Un DSO calculé
        // sur une facture n'est pas un DSO, c'est cette facture-là.
        //
        // La période reste — c'est elle qui dit le mouvement récent — mais elle
        // se lit maintenant CONTRE un rythme de fond, douze mois glissants, que
        // le sélecteur ne bouge pas. Et chaque cellule porte sa base : sans le
        // nombre de règlements derrière, un délai ne se vérifie pas.
        const per = bornes();
        const finPer = D && D.arrete ? parseFR(D.arrete) : new Date();
        const moisDe = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
        const DOUZE_DEBUT = moisDe(new Date(finPer.getFullYear(), finPer.getMonth() - 11, 1));
        const DOUZE_FIN = moisDe(finPer);

        const cumuler = garde => {
            const m = new Map();
            for (const r of (D.dso || [])) {
                if (!keep.has(r.fin) || !garde(r)) continue;
                const o = m.get(r.fin) || { mt: 0, mj: 0, n: 0 };
                o.mt += r.mt; o.mj += r.mj; o.n += r.n;
                m.set(r.fin, o);
            }
            return m;
        };
        const dsoPar = cumuler(r => dans(r.m, per));
        const dsoDouze = cumuler(r => r.m >= DOUZE_DEBUT && r.m <= DOUZE_FIN);
        const lire = m => fin => {
            const o = m.get(fin);
            return o && o.mt ? { j: Math.round(o.mj / o.mt), n: o.n, mt: o.mt } : null;
        };
        const dsoDe = lire(dsoPar), dsoDouzeDe = lire(dsoDouze);
        // La cellule dit le délai ET sa base. « à compléter » quand il n'y a
        // eu aucun règlement : la case ne s'invente pas un nombre.
        const celluleDso = d => '<td class="n">'
            + (d ? d.j.toLocaleString('fr-FR') + ' j<small>' + d.n.toLocaleString('fr-FR')
                   + ' fact. · ' + eur(d.mt) + '</small>'
                 : '<span class="pil-acompleter">à compléter</span>')
            + '</td>';
        const totalDso = m => { let mt = 0, mj = 0, n = 0;
            for (const o of m.values()) { mt += o.mt; mj += o.mj; n += o.n; }
            return mt ? { j: Math.round(mj / mt), n: n, mt: mt } : null; };
        // Le délai propre vient de la règle d'échéance du GRAND LIVRE — celle
        // qui a servi à dater la créance — et non de celle du suivi de relance :
        // les deux ne mesurent pas la même chose, et c'est le grand livre qui
        // remplit cette carte.
        const REGLES = (window.LioraRules && window.LioraRules.DEFAULT_ECHEANCE_RULES) || [];
        const BASE_FR = { dateFacture: 'date de facture', dateFinFormation: 'fin de formation',
                          dateDebutFormation: 'début de formation' };
        const delaiPropre = fin => {
            const r = REGLES.find(x => x.label === fin);
            if (!r) return 'à compléter';
            const g = r.gl || r;
            const base = BASE_FR[g.base] || '';
            if (!base) return 'à compléter';
            return base + (g.jours ? ' + ' + g.jours + ' j' : '');
        };
        // LA CHALEUR DIT OÙ SONT LES MONTANTS À RISQUE, 12/11/2026.
        //
        // « ds le code couleur il y a des montant plus faible que d'autre avec
        // une couleur plus foncé que ces montant plus faible » — et c'était
        // vrai : 493 865 € ressortaient plus sombres que 1 130 141 € dans la
        // MÊME colonne. L'intensité se calculait sur la PART DE LA LIGNE, si
        // bien qu'un petit financeur dont tout dort dans une case virait au
        // rouge vif pendant qu'un gros financeur étalé restait pâle. La carte
        // désignait la concentration, pas le risque.
        //
        // Elle se calcule désormais sur le MONTANT ABSOLU, rapporté à la plus
        // grosse case du tableau. « le montant doit etre plus pondéré » : il
        // pèse l'essentiel, l'ancienneté ne fait plus que moduler — une case
        // ancienne est poussée vers le foncé, une case récente retenue vers le
        // clair, mais jamais au point qu'un petit montant double un gros.
        // À ancienneté égale, plus c'est gros, plus c'est foncé. Toujours.
        //
        // La racine relève le milieu de l'échelle : sans elle, une seule case
        // énorme écrase toutes les autres dans un dégradé invisible.
        const RISQUE = [0, 0.18, 0.45, 0.75, 1];
        const POIDS_AGE = 0.45;              // l'ancienneté module, elle ne décide pas
        const vmax = Math.max(...lignes.flatMap(r => r.cases.map(Math.abs)), 1);
        const chaleur = (v, tot, j) => {
            if (v <= 0 || !RISQUE[j]) return 'background:transparent';
            const part = Math.pow(Math.min(1, v / vmax), 0.55);
            const p = part * (1 - POIDS_AGE + POIDS_AGE * RISQUE[j]);
            return 'background:rgba(var(--chaleur), ' + (0.06 + p * 0.74).toFixed(3) + ')';
        };
        const tot = COLONNES.map((_, j) => lignes.reduce((s, r) => s + r.cases[j], 0));
        let h = '<table class="pil-heat"><thead><tr><th>Financeur</th><th>Équipe</th>'
            + COLONNES.map(c => '<th class="n">' + c.nom + '</th>').join('')
            + '<th class="n">Total</th>'
            + '<th class="n">DSO période</th><th class="n">DSO 12 mois</th>'
            + '<th>Délai propre</th></tr></thead><tbody>';
        for (const r of lignes) {
            h += '<tr><td class="fam">' + U().escapeHtml(r.fin) + '</td>'
                + '<td>' + U().escapeHtml(r.unite) + '</td>'
                + r.cases.map((v, j) => '<td class="n" style="' + chaleur(v, r.total, j) + '">'
                    + eur(v) + '</td>').join('')
                + '<td class="n"><strong>' + eur(r.total) + '</strong></td>'
                + celluleDso(dsoDe(r.fin))
                + celluleDso(dsoDouzeDe(r.fin))
                + '<td>' + U().escapeHtml(delaiPropre(r.fin)) + '</td></tr>';
        }
        h += '<tr class="total"><td>TOTAL</td><td></td>'
            + tot.map(v => '<td class="n">' + eur(v) + '</td>').join('')
            + '<td class="n">' + eur(tot.reduce((a, b) => a + b, 0)) + '</td>'
            + celluleDso(totalDso(dsoPar))
            + celluleDso(totalDso(dsoDouze))
            + '<td></td></tr>';
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
    // LA COULEUR SUIT LE FINANCEUR, PAS SON RANG, 10/11/2026 : « les couleurs
    // sont trop proches l'une de l'autre ».
    //
    // Deux défauts, et le second est le pire.
    //
    // 1. La palette tournait en boucle — pal[k % pal.length] — sur quatorze
    //    teintes dont la validation échoue : huit sur quatorze hors de la bande
    //    de luminosité, et la pire paire voisine, #A86A06 contre #1D7F55, à
    //    ΔE 1,5 en deutéranopie. Indiscernables.
    //
    // 2. L'indice k était celui de la LISTE FILTRÉE. Décocher une business unit
    //    renumérotait tout le monde : chaque financeur changeait de couleur à
    //    chaque filtre. On ne peut rien suivre d'un écran à l'autre.
    //
    // La teinte est donc accrochée au NOM du financeur, une fois pour toutes,
    // dans un ordre figé. Huit teintes validées sur le fond sombre de la page
    // (#111631) : bande de luminosité, plancher de chroma, séparation en vision
    // des couleurs, plancher en vision normale et contraste — tous passés.
    //
    // Au-delà de huit financeurs, une neuvième teinte inventée ne se distingue
    // plus : la teinte se répète, et c'est le TRAIT qui sépare — plein puis
    // pointillé, rond puis triangle puis losange. Deux financeurs de même
    // teinte n'ont donc jamais ni le même trait ni le même point.
    const TEINTES = ['#3987e5', '#d95926', '#199e70', '#c98500',
                     '#d55181', '#008300', '#9085e9', '#e66767'];
    const TRAITS = [[], [6, 4], [2, 3]];
    const POINTS = ['circle', 'triangle', 'rectRot'];
    // L'ordre est celui du référentiel des règles, et il ne bouge pas : un
    // financeur garde sa couleur même absent de l'écran.
    const rangFinanceur = f => {
        const tous = tousFinanceurs();
        const i = tous.indexOf(f);
        return i >= 0 ? i : tous.length;
    };
    const habit = (f) => {
        const r = rangFinanceur(f);
        return { couleur: TEINTES[r % TEINTES.length],
                 trait: TRAITS[Math.floor(r / TEINTES.length) % TRAITS.length],
                 point: POINTS[Math.floor(r / TEINTES.length) % POINTS.length] };
    };

    // UN CLIC SUR UNE COURBE FILTRE LA PAGE, 10/11/2026 : « lorsque l'on clique
    // sur l'une des courbes je dois avoir un filtre qui se déclenche sur le
    // type de financement de la courbe sur toute la page ».
    //
    // Le clic sur une courbe isole son financeur. Le même clic rend la main,
    // mais une fois isolée la légende ne porte plus qu'une entrée et rien ne
    // dit qu'il faut recliquer dessus — il faut en plus remonter jusqu'au
    // graphique. La sortie se tient donc là où le filtre a été posé, écrite.
    function majSortieFiltre() {
        const u = U();
        const liste = [...F.financeurs];
        const texte = liste.length === 0 ? ''
            : liste.length === 1 ? liste[0]
            : liste.length + ' financeurs';
        for (const id of ['pil-retard-sortie', 'pil-degrade-sortie', 'pil-vintage-sortie']) {
            const hote = document.getElementById(id);
            if (!hote) continue;
            if (!texte) { hote.innerHTML = ''; continue; }
            hote.innerHTML = '<button type="button" class="pil-sortie" '
                + 'title="Revenir à tous les financeurs">'
                + '<b>' + u.escapeHtml(texte) + '</b> seul'
                + (liste.length > 1 ? 's' : '') + ' · tout afficher'
                + '<span class="croix" aria-hidden="true">×</span></button>';
            hote.firstChild.onclick = () => { F.financeurs.clear(); synchroniserDeroule(); rendre(); };
        }
    }

    // Les cases du déroulé disent ce que l'état dit, sinon le filtre ment.
    function synchroniserDeroule() {
        const p = document.getElementById('pil-financeurs');
        if (!p) return;
        p.querySelectorAll('input[type=checkbox]').forEach(c => {
            if (c.dataset.tout) return;
            c.checked = F.financeurs.has(c.value);
        });
        majTout(p, F.financeurs);
        p.dispatchEvent(new Event('change'));   // l'étiquette du bouton suit
    }

    // Le même clic rend la main : cliquer le financeur déjà seul retenu
    // réaffiche tout le monde. Sans cela on ne saurait pas comment revenir, et
    // la case « Tous » du déroulé est à deux clics.
    function isolerFinanceur(f) {
        if (!f) return;
        const seul = F.financeurs.size === 1 && F.financeurs.has(f);
        F.financeurs.clear();
        if (!seul) F.financeurs.add(f);
        synchroniserDeroule();
        rendre();
    }

    function graphRetard(keep) {
        const fins = [...keep].filter(f => (D.encours || []).some(e =>
            (e.parFinancement || []).some(r => r.cat === f && (r.total || 0) >= PLANCHER)));
        const labels = (D.encours || []).map(e =>
            parseFR(e.d).toLocaleDateString('fr-FR', { month: 'short', year: '2-digit' }));
        const series = fins.map((f) => {
          const h = habit(f);
          return {
            label: f, borderColor: h.couleur, backgroundColor: 'transparent',
            borderDash: h.trait, pointStyle: h.point,
            borderWidth: 2, tension: 0.3, pointRadius: 3, pointHoverRadius: 6,
            spanGaps: true,
            data: (D.encours || []).map(e => {
                const r = (e.parFinancement || []).find(x => x.cat === f);
                if (!r || (r.total || 0) < PLANCHER) return null;
                return Math.round(r.echu / r.total * 1000) / 10;
            }),
          };
        });
        U().chart('pil-chart-retard', {
            type: 'line',
            data: { labels, datasets: series },
            options: {
                responsive: true, maintainAspectRatio: false,
                scales: { x: { grid: { display: false } },
                          y: { grid: U().grille, min: 0, max: 100,
                               ticks: { callback: v => v + ' %' } } },
                // Le survol prend la série la plus proche sans exiger le pixel :
                // un trait de deux pixels ne se vise pas.
                interaction: { mode: 'nearest', intersect: false },
                onHover: (ev, els) => {
                    const c = ev.native && ev.native.target;
                    if (c) c.style.cursor = els.length ? 'pointer' : 'default';
                },
                onClick: (ev, els, ch) => {
                    const pts = els.length ? els
                        : ch.getElementsAtEventForMode(ev, 'nearest', { intersect: false }, true);
                    if (!pts.length) return;
                    const ds = ch.data.datasets[pts[0].datasetIndex];
                    isolerFinanceur(ds && ds.label);
                },
                plugins: {
                    legend: {
                        position: 'bottom',
                        labels: { usePointStyle: true },
                        // La légende filtre elle aussi : c'est la cible la plus
                        // facile à viser, et masquer une série sans filtrer la
                        // page — le geste par défaut de Chart.js — répondrait à
                        // une autre question que la sienne.
                        onClick: (e, item) => isolerFinanceur(item && item.text),
                    },
                    tooltip: { callbacks: { label: c => c.dataset.label + ' : ' + c.raw + ' %' } },
                },
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

    // ═════════ 4. l'encours par financeur, jour après jour depuis la facture ═════════
    //
    // UN SEUL GRAPHIQUE, ET C'EST CELUI-CI, 04/11/2026 : « je t'ai demandé un
    // seul graphique avec des courbes, une courbe par financement, en abscisse
    // il y a des jours, en ordonnée les encours ; ça doit répondre à la
    // question : 80 % de mon encours B2C-Entreprise est payé sous 80 j après
    // date de facture ». Une seconde carte montrait la même décroissance mois
    // de facturation par mois de facturation : elle a été retirée, elle ne
    // répondait pas à cette question-là.
    //
    // LA COURBE SE LIT SUR LES ARRÊTÉS, PAS SUR LES RÈGLEMENTS. Bâtie sur les
    // seuls encaissements datables, elle plafonnait à 59 % de reste dû quand
    // la balance en publie 30 : elle ignorait les 18 293 726 € d'avoirs — dont
    // AUCUN ne porte de facture rattachée datée — et les 7 103 219 € de
    // règlements qu'aucune facture ne réclame. Un arrêté, lui, tient compte de
    // tout ce qui éteint une facture : paiement, avoir, lettrage. Chaque point
    // vient donc d'une balance refaite à cette date, et la courbe cadre avec
    // l'encours publié.
    //
    // L'ÂGE SE COMPTE DEPUIS LE 15 DU MOIS DE FACTURATION — le jour moyen
    // d'une facturation étalée sur le mois. Dater toute une facture du 1er la
    // vieillirait de quinze jours.
    //
    // DEUX BORNES, SANS QUOI RIEN NE SE LIT. Sans elles la courbe courait
    // jusqu'à 2 400 jours — l'âge d'une facture de 2020 vue au dernier arrêté,
    // quelques milliers d'euros qui font sauter le tracé — et quatorze
    // financeurs se croisaient en pelote. L'horizon s'arrête donc à un AN, où
    // se prend une décision de recouvrement, et le dessin garde les financeurs
    // qui pèsent. Ce qui est écarté est nommé sous le graphique.
    const DECROISSANCE_JOURS = 360;
    const DECROISSANCE_COURBES = 7;

    // ── 5. la variation du DSO ──
    // LE POINT DIT SUR COMBIEN IL REPOSE, 13/11/2026.
    //
    // « je ne compd pas comment tu calcul ton dso, tu passe de 600j env à 0 ».
    // La courbe d'AIF tombait à 3 j en septembre et montait à 580 j en juillet.
    // Les deux étaient exacts : septembre, UNE facture de 2 245 € payée trois
    // jours après son émission ; juillet, DEUX vieilles factures enfin réglées.
    // Mais la courbe les traçait du même trait qu'un mois à 31 règlements, si
    // bien qu'elle faisait lire un effondrement de performance là où il n'y
    // avait qu'une facture.
    //
    // Le diamètre du point porte donc le nombre de règlements, et l'infobulle
    // le dit en toutes lettres avec le montant. Un point minuscule se lit pour
    // ce qu'il est : une facture, pas une tendance.
    function graphDso(keep) {
        const parMois = new Map();
        for (const r of (D.dso || [])) {
            if (!keep.has(r.fin)) continue;
            const o = parMois.get(r.m) || { mt: 0, mj: 0, n: 0 };
            o.mt += r.mt; o.mj += r.mj; o.n += (r.n || 0); parMois.set(r.m, o);
        }
        const mois = [...parMois.keys()].sort().slice(-18);
        const base = mois.map(m => parMois.get(m) || { mt: 0, mj: 0, n: 0 });
        const nMax = Math.max(...base.map(o => o.n), 1);
        const rayon = n => n ? 2.5 + 5.5 * Math.sqrt(Math.min(1, n / nMax)) : 0;
        U().chart('pil-chart-dso', {
            type: 'line',
            data: {
                labels: mois.map(moisFR),
                datasets: [{
                    label: 'DSO du mois', borderColor: U().couleurs.accent,
                    backgroundColor: 'rgba(217, 83, 46, 0.10)', fill: true,
                    borderWidth: 2, tension: 0.3,
                    pointRadius: base.map(o => rayon(o.n)),
                    pointHoverRadius: base.map(o => rayon(o.n) + 2),
                    pointBackgroundColor: U().couleurs.accent,
                    data: base.map(o => o.mt ? Math.round(o.mj / o.mt) : null),
                }],
            },
            options: {
                responsive: true, maintainAspectRatio: false,
                scales: { x: { grid: { display: false } },
                          y: { grid: U().grille, ticks: { callback: v => v + ' j' } } },
                plugins: {
                    legend: { display: false },
                    tooltip: { callbacks: {
                        label: c => 'délai moyen pondéré : ' + c.raw + ' jours',
                        afterLabel: c => { const o = base[c.dataIndex] || {};
                            return 'sur ' + (o.n || 0).toLocaleString('fr-FR') + ' facture'
                                 + ((o.n || 0) > 1 ? 's' : '') + ' encaissée'
                                 + ((o.n || 0) > 1 ? 's' : '') + ' · ' + eur(o.mt || 0); },
                    } },
                },
            },
        });
        // CE QUI PORTE LE MOIS SE DIT SOUS LE TITRE, pas seulement au survol.
        const el = document.getElementById('pil-dso-dit');
        if (el) {
            const maigres = base.filter(o => o.n && o.n <= 2).length;
            el.textContent = 'Délai moyen entre la date de facture et l’encaissement, '
                + 'pondéré par les montants, sur les factures encaissées dans le mois. '
                + 'Le diamètre du point dit combien de factures le composent.'
                + (maigres ? ' ' + maigres + ' mois ne reposent que sur une ou deux factures : '
                           + 'leur délai est celui de ces factures-là, pas une tendance.' : '');
        }
    }

    // ── 6. le pont des encours, d'un arrêté au suivant ──
    //
    // Ce qu'elle demande : « encours en N 500 000 à N+1 600 000 — 100 000 à
    // expliquer — payé, annulé, facturé par exemple ». Les trois postes sont
    // lus dans les flux du mois ; ce qui reste est nommé « autres mouvements »
    // et n'est pas dissimulé : lettrage, reclassements, écarts d'arrondi.
    // LES « AUTRES MOUVEMENTS » N'EN SONT PLUS UN, 04/11/2026 : « mets à quoi
    // correspondent les autres mouvements ». Le poste était une DIFFÉRENCE —
    // l'encours d'arrivée moins celui de départ, moins le facturé, plus
    // l'encaissé et les avoirs. Un tampon, donc, qui ramassait tout ce que la
    // cascade ne savait pas nommer, et qu'on ne pouvait ni ouvrir ni
    // justifier. Ces écritures sont maintenant comptées pour ce qu'elles
    // sont : celles dont la nature n'est ni facture, ni règlement, ni avoir.
    // Leur JOURNAL dit ce qu'elles font — OD les opérations diverses
    // (réaffectations d'un compte client à un autre, régularisations), BQ la
    // banque (ce qui revient sur le compte du client sans être un règlement).
    // Chaque poste s'ouvre au clic sur la liste de ses écritures.
    //
    // CE QUI RESTE S'APPELLE UN ÉCART INEXPLIQUÉ, et il ne paraît que s'il
    // existe. Sur les douze passages d'un arrêté au suivant, il vaut zéro au
    // centime : facturé − encaissé − avoirs + autres mouvements rend très
    // exactement la variation de l'encours.
    const NOM_GROUPE = { od: 'Opérations diverses', banque: 'Banque hors règlement',
                         autre: 'Autres journaux' };
    const DIT_GROUPE = { od: 'd’opérations diverses',
                         banque: 'de mouvements bancaires hors règlement',
                         autre: 'd’écritures sur d’autres journaux' };
    const ORDRE_GROUPE = ['od', 'banque', 'autre'];

    // ═══════════ 1. Qui se dégrade — le retard par mois d'ÉCHÉANCE ═══════════
    //
    // Tout le reste du relevé se range par mois de FACTURATION. Celui-ci se
    // range sur la date promise : il ne dit pas quand on a facturé, il dit si
    // l'échéance qu'on s'était donnée a été tenue. Une créance est en retard
    // si elle a été réglée après son échéance, ou si elle n'est toujours pas
    // soldée alors que son échéance est passée.
    //
    // UN POINT PORTE SUR AU MOINS CINQ CRÉANCES ÉCHUES. En dessous, le taux
    // saute de 0 à 100 % d'une créance à l'autre et dessine une dégradation
    // qui n'existe pas. Le mois de l'arrêté est écarté : il n'est pas fini.
    const DEGRADE_MINI = 5;
    function moisPrecedentArrete() {
        const a = String(D.arrete || '').slice(0, 7);
        return a;
    }
    function graphDegrade(keep) {
        const R = (D.retard || []).filter(r => keep.has(r.fin));
        const dit = document.getElementById('pil-degrade-dit');
        const hoteListe = document.getElementById('pil-degrade-liste');
        const mArrete = moisPrecedentArrete();
        const mois = [...new Set(R.map(r => r.m))].sort().filter(m => m < mArrete).slice(-12);
        if (!(D.retard || []).length) {
            if (dit) dit.textContent = 'Le relevé comptable ne porte pas encore le retard par '
                + 'mois d’échéance : il sera là au prochain relevé de la balance âgée.';
            if (hoteListe) hoteListe.innerHTML = '';
            U().chart('pil-chart-degrade', { type: 'line', data: { labels: [], datasets: [] },
                options: { responsive: true, maintainAspectRatio: false } });
            return;
        }
        const par = new Map();                       // financeur → mois → {nEch,nRet,mEch,mRet}
        for (const r of R) {
            if (mois.indexOf(r.m) < 0) continue;
            let o = par.get(r.fin); if (!o) { o = new Map(); par.set(r.fin, o); }
            const a = o.get(r.m) || { nEch: 0, nRet: 0, mEch: 0, mRet: 0 };
            a.nEch += r.nEch; a.nRet += r.nRet; a.mEch += r.mEch; a.mRet += r.mRet;
            o.set(r.m, a);
        }
        const serie = o => mois.map(m => { const a = o.get(m);
            return a && a.nEch >= DEGRADE_MINI ? Math.round(1000 * a.nRet / a.nEch) / 10 : null; });
        const fins = [...par.keys()].filter(f => serie(par.get(f)).some(v => v !== null));
        const datasets = fins.map(f => { const h = habit(f), s = serie(par.get(f));
            return { label: f, data: s, borderColor: h.couleur, backgroundColor: h.couleur,
                     borderDash: h.trait, pointStyle: h.point, borderWidth: 2,
                     tension: 0.25, pointRadius: 3, spanGaps: true, fill: false }; });
        U().chart('pil-chart-degrade', {
            type: 'line',
            data: { labels: mois.map(moisFR), datasets: datasets },
            options: {
                responsive: true, maintainAspectRatio: false,
                interaction: { mode: 'nearest', intersect: false },
                onClick: (ev, els, ch) => { const d = els && els[0]; if (!d) return;
                    isolerFinanceur(ch.data.datasets[d.datasetIndex].label); },
                scales: { x: { grid: { display: false } },
                          y: { grid: U().grille, min: 0, max: 100,
                               ticks: { callback: v => v + ' %' } } },
                plugins: {
                    legend: { display: false },
                    tooltip: { callbacks: {
                        label: c => c.dataset.label + ' : ' + c.raw + ' % en retard',
                        afterLabel: c => { const a = (par.get(c.dataset.label) || new Map()).get(mois[c.dataIndex]);
                            return a ? 'sur ' + a.nEch + ' créance' + (a.nEch > 1 ? 's' : '')
                                     + ' échue' + (a.nEch > 1 ? 's' : '') + ' · ' + eur(a.mEch) : ''; },
                    } },
                },
            },
        });
        // LA LISTE DIT LE DERNIER MOIS ET L'ÉCART SUR LA FENÊTRE, et elle se
        // clique : c'est la cible la plus facile à viser, bien plus qu'une
        // courbe au milieu de quinze autres.
        if (hoteListe) {
            const u = U();
            const li = fins.map(f => { const s = serie(par.get(f));
                const vus = s.map((v, i) => [v, i]).filter(x => x[0] !== null);
                if (!vus.length) return null;
                const dernier = vus[vus.length - 1][0], premier = vus[0][0];
                const aDer = (par.get(f) || new Map()).get(mois[vus[vus.length - 1][1]]) || {};
                return { fin: f, pct: dernier, delta: Math.round(dernier - premier),
                         n: aDer.nEch || 0, couleur: habit(f).couleur };
            }).filter(Boolean).sort((a, b) => b.delta - a.delta);
            hoteListe.innerHTML = li.map(x =>
                '<button type="button" class="pil-dg-ligne" data-fin="' + u.escapeHtml(x.fin) + '">'
                + '<span class="pil-dg-pastille" style="background:' + x.couleur + '"></span>'
                + '<span class="pil-dg-nom">' + u.escapeHtml(x.fin)
                + '<small>sur ' + x.n + ' créance' + (x.n > 1 ? 's' : '') + ' échue'
                + (x.n > 1 ? 's' : '') + '</small></span>'
                + '<span class="pil-dg-pct">' + x.pct.toLocaleString('fr-FR') + ' %</span>'
                + '<span class="pil-dg-delta ' + (x.delta > 0 ? 'pire' : x.delta < 0 ? 'mieux' : '') + '">'
                + (x.delta > 0 ? '+' : '') + x.delta.toLocaleString('fr-FR') + ' pts</span>'
                + '</button>').join('')
                + '<p class="pil-dg-pied">Dernier mois et écart sur la fenêtre. '
                + 'Cliquez une courbe ou un financeur pour filtrer toute la page.</p>';
            hoteListe.querySelectorAll('.pil-dg-ligne').forEach(b =>
                b.onclick = () => isolerFinanceur(b.dataset.fin));
        }
        if (dit) {
            const maigres = [...par.values()].reduce((n, o) =>
                n + [...o.values()].filter(a => a.nEch > 0 && a.nEch < DEGRADE_MINI).length, 0);
            dit.textContent = 'Part des créances arrivées à échéance dans le mois qui sont tombées '
                + 'en retard : réglées après l’échéance, ou toujours impayées. Le mois de l’arrêté '
                + 'est écarté, il n’est pas fini.'
                + (maigres ? ' ' + maigres + ' points ne sont pas tracés : ils porteraient sur moins de '
                           + DEGRADE_MINI + ' créances échues.' : '');
        }
    }

    // ═══════════ 2. Les mois de facturation ═══════════
    //
    // « les cohortes ne m'interesse pas » : le mot ne disait rien de plus que
    // « mois de facturation », et c'est celui-là qui est écrit. Chaque courbe
    // est un mois de facturation ; on y lit quelle part du montant facturé ce
    // mois-là était rentrée à 30, 60, 90, 120 et 180 jours.
    //
    // SEULS LES ÂGES ATTEINTS PAR TOUT LE MOIS SONT TRACÉS. À un arrêté du
    // 12 novembre, le mois d'octobre n'a pas encore soixante jours : porter
    // son taux à 60 j reviendrait à mesurer une course avant l'arrivée.
    const VINT_AGES = [30, 60, 90, 120, 180];
    function graphVintage(keep) {
        const PAL = D.paliers || [];
        const col = VINT_AGES.map(p => PAL.indexOf(p));
        const dit = document.getElementById('pil-vintage-dit');
        const hoteT = document.getElementById('pil-vintage-table');
        const parMois = new Map();
        for (const r of (D.vintage || [])) {
            if (!keep.has(r.fin)) continue;
            let o = parMois.get(r.m);
            if (!o) { o = { fac: 0, nFac: 0, p: PAL.map(() => 0) }; parMois.set(r.m, o); }
            o.fac += r.fac; o.nFac += r.nFac;
            (r.p || []).forEach((v, i) => { o.p[i] += v; });
        }
        const arr = parseFR(D.arrete);
        const ageAtteint = m => {
            const finMois = new Date(+m.slice(0, 4), +m.slice(5, 7), 0);
            return Math.floor((arr - finMois) / 86400000);
        };
        // AUCUN MOIS ANTÉRIEUR AU GRAND LIVRE N'EST COMPARABLE, 13/11/2026.
        // Juin 2025 affichait 677 % encaissé. Les factures d'avant le premier
        // jour du grand livre y sont arrivées en report à nouveau : leur
        // montant facturé n'est pas compté — les reports ne sont ni une
        // facturation ni un encaissement — alors que les règlements qui les
        // ont suivies, eux, le sont. On connaît le numérateur et pas le
        // dénominateur. Ces mois-là ne sont ni tracés ni pris en référence.
        const PREMIER = (D.flux || []).reduce((a, r) => (!a || r.m < a) ? r.m : a, '');
        const fiable = m => !PREMIER || m >= PREMIER;
        const part = (o, i) => (o && o.fac) ? Math.round(1000 * o.p[i] / o.fac) / 10 : null;
        const tous = [...parMois.keys()].sort().filter(m => parMois.get(m).fac > 0
                                                         && fiable(m)
                                                         && ageAtteint(m) >= VINT_AGES[0]);
        const mois = tous.slice(-6);
        if (!mois.length) {
            if (dit) dit.textContent = 'Aucun mois de facturation n’a encore trente jours sur le périmètre retenu.';
            if (hoteT) hoteT.innerHTML = '';
            U().chart('pil-chart-vintage', { type: 'line', data: { labels: [], datasets: [] },
                options: { responsive: true, maintainAspectRatio: false } });
            return;
        }
        // Du plus pâle au plus soutenu : le mois le plus récent est le plus net.
        const TEINTE = (i, n) => { const a = 0.28 + 0.72 * (n > 1 ? i / (n - 1) : 1);
            return 'rgba(217, 83, 46, ' + a.toFixed(2) + ')'; };
        const serieDe = (m, o) => col.map((i, k) =>
            (i < 0 || ageAtteint(m) < VINT_AGES[k]) ? null : part(o, i));
        const datasets = mois.map((m, i) => ({
            label: moisFR(m), borderColor: TEINTE(i, mois.length),
            backgroundColor: TEINTE(i, mois.length), borderWidth: 2,
            pointRadius: 3, tension: 0.2, fill: false, spanGaps: false,
            data: serieDe(m, parMois.get(m)),
        }));
        // LA RÉFÉRENCE N-1 : le même mois, un an plus tôt. Elle se lit en
        // pointillé et n'est pas cliquable — ce n'est pas un mois du périmètre,
        // c'est le repère contre lequel il se mesure.
        // La référence est le N-1 du mois le PLUS RÉCENT qui en ait un dans le
        // grand livre : c'est celui-là qu'on veut battre, pas le plus vieux.
        let refM = '', refO = null;
        for (let i = mois.length - 1; i >= 0; i--) {
            const an1 = String(+mois[i].slice(0, 4) - 1) + mois[i].slice(4);
            const o1 = fiable(an1) ? parMois.get(an1) : null;
            if (o1 && o1.fac) { refM = an1; refO = o1; break; }
        }
        if (refO && refO.fac) {
            datasets.push({ label: moisFR(refM) + ' (référence N-1)',
                borderColor: U().couleurs.indigo || '#2B5DB8',
                backgroundColor: U().couleurs.indigo || '#2B5DB8',
                borderDash: [6, 4], borderWidth: 2, pointRadius: 3, tension: 0.2, fill: false,
                data: col.map(i => i < 0 ? null : part(refO, i)) });
        }
        U().chart('pil-chart-vintage', {
            type: 'line',
            data: { labels: VINT_AGES.map(a => a + ' j'), datasets: datasets },
            options: {
                responsive: true, maintainAspectRatio: false,
                scales: { x: { grid: { display: false } },
                          y: { grid: U().grille, min: 0, max: 100,
                               ticks: { callback: v => v + ' %' } } },
                plugins: {
                    legend: { position: 'bottom', labels: { usePointStyle: true, boxWidth: 8 } },
                    tooltip: { callbacks: { label: c => c.dataset.label + ' : '
                        + (c.raw === null ? 'pas encore atteint' : c.raw + ' % encaissé') } },
                },
            },
        });
        // LE TABLEAU DIT LES MÊMES CHIFFRES, EN TOUTES LETTRES, avec le montant
        // facturé du mois et l'écart au même mois de l'année précédente.
        if (hoteT) {
            const vert = v => v === null ? '' :
                'background:rgba(29, 127, 85, ' + (0.05 + 0.55 * Math.pow(v / 100, 1.1)).toFixed(3) + ')';
            let h = '<table class="pil-vint"><thead><tr><th>Mois de facturation</th>'
                + VINT_AGES.map(a => '<th class="n">' + a + ' j</th>').join('')
                + '<th class="n">vs N-1</th></tr></thead><tbody>';
            for (const m of mois) {
                const o = parMois.get(m), s = serieDe(m, o);
                const an1 = String(+m.slice(0, 4) - 1) + m.slice(4);
                const o1 = fiable(an1) ? parMois.get(an1) : null;
                // L'écart se prend au PLUS PROFOND des âges atteints par les deux,
                // sinon on comparerait trente jours à cent quatre-vingts.
                let ecart = null, ageCommun = null;
                if (o1 && o1.fac) {
                    for (let k = VINT_AGES.length - 1; k >= 0; k--) {
                        const a = part(o, col[k]), b = part(o1, col[k]);
                        if (s[k] !== null && a !== null && b !== null && ageAtteint(an1) >= VINT_AGES[k]) {
                            ecart = Math.round(a - b); ageCommun = VINT_AGES[k]; break;
                        }
                    }
                }
                h += '<tr><td class="fam">' + U().escapeHtml(moisFR(m))
                   + '<small>' + eur(o.fac) + ' · ' + o.nFac + ' fact.</small></td>'
                   + s.map(v => '<td class="n" style="' + vert(v) + '">'
                        + (v === null ? '<span class="pil-acompleter">·</span>'
                                      : v.toLocaleString('fr-FR') + ' %') + '</td>').join('')
                   + '<td class="n">' + (ecart === null
                        ? '<span class="pil-acompleter">à compléter</span>'
                        : '<span class="' + (ecart >= 0 ? 'ec-mieux' : 'ec-pire') + '">'
                          + (ecart > 0 ? '+' : '') + ecart + ' pts</span><small>à ' + ageCommun + ' j</small>')
                   + '</td></tr>';
            }
            h += '</tbody></table>';
            hoteT.innerHTML = h;
        }
        if (dit) {
            const pasEncore = tous.length ? [...parMois.keys()].sort()
                .filter(m => parMois.get(m).fac > 0 && ageAtteint(m) < VINT_AGES[0]) : [];
            dit.textContent = 'Part du montant facturé chaque mois effectivement encaissée à 30, 60, '
                + '90, 120 et 180 jours de la date de facture. Seuls les âges atteints par tout le '
                + 'mois sont tracés.'
                + (pasEncore.length ? ' ' + pasEncore.map(moisFR).join(', ')
                     + ' n’a pas encore trente jours et n’est pas tracé.' : '')
                + (PREMIER ? ' Le grand livre part du ' + moisFRLong(PREMIER) + ' : les mois '
                           + 'antérieurs sont arrivés en report à nouveau, leur montant facturé '
                           + 'n’est pas connu, et ils ne servent pas non plus de référence N-1.' : '');
        }
    }

    // ═══════════ 3. Le mois en bref ═══════════
    //
    // « Vision par financeur en ligne, en colonne nb facturé, nb encaissé, taux
    // de retard, comparaison N-1, M-1 » à gauche ; « commentaire, l'ia analyse
    // la selection faite » à droite.
    //
    // LE MOIS RETENU EST LE DERNIER MOIS COMPLET. Celui de l'arrêté est en
    // cours : son facturé et son encaissé ne sont pas comparables à un mois
    // entier, et les mettre côte à côte ferait lire un effondrement.
    //
    // LE TAUX D'ÉCHU N-1 DEMANDE UN ARRÊTÉ D'IL Y A UN AN. Le relevé en garde
    // treize ; au-delà la case dit « à compléter » plutôt qu'un chiffre faux.
    // LES FAMILLES DU « MOIS EN BREF », 13/11/2026 : « mets moi c financeur ».
    //
    // Six familles, celles de la version 2. Elles ne valent que pour CE
    // tableau : le reste de l'onglet garde les financeurs du grand livre, qui
    // sont la maille de la comptabilité. Mélanger les deux donnerait un écran
    // dont on ne saurait pas ce qu'il compte.
    //
    // L'INTRAGROUPE SE LIT SUR SA PROPRE LIGNE et n'est jamais noyé dans
    // Entreprise : c'est la règle du barème CAC — « l'intragroupe se lit sur sa
    // propre ligne, et non noyé dans Corporate » — et elle vaut ici aussi.
    //
    // UN FINANCEUR QUE LA TABLE NE NOMME PAS GARDE SON NOM, sur sa propre
    // ligne. Pas de poste « Autres » : « je ne veux pas de categorie tampon ».
    const FAMILLES_BREF = [
        ['Entreprise', ['B2B', 'B2C-Entreprise', 'Corporate - Alternance']],
        ['OPCO', ['OPCO', 'OPCO - Alternance']],
        ['Financement personnel', ['Financement personnel', 'Perso-Alternance']],
        ['CPF', ['CPF']],
        ['France Travail', ['AIF', 'POEI']],
        ['Région / Transition / Agefiph', ['Region', 'Transition Pro', 'Agefiph']],
        ['Interco', ['Interco', 'Interne - DST Allemagne']],
        ['ETAT', ['ETAT']],
    ];
    // Les familles retenues, membres filtrés par le périmètre de la page.
    function famillesDe(keep) {
        const vus = new Set();
        const out = [];
        for (const [nom, membres] of FAMILLES_BREF) {
            const m = membres.filter(x => keep.has(x));
            m.forEach(x => vus.add(x));
            if (m.length) out.push({ nom, membres: m });
        }
        for (const f of keep) if (!vus.has(f)) out.push({ nom: f, membres: [f] });
        return out;
    }

    function brefDuMois(keep) {
        const hoteT = document.getElementById('pil-bref-table');
        const hoteC = document.getElementById('pil-bref-commentaire');
        const hoteM = document.getElementById('pil-bref-mois');
        const hoteD = document.getElementById('pil-bref-dit');
        const mArrete = String(D.arrete || '').slice(0, 7);
        const moisFlux = [...new Set((D.flux || []).map(r => r.m))].sort().filter(m => m < mArrete);
        const M = moisFlux[moisFlux.length - 1];
        if (!M) { if (hoteT) hoteT.innerHTML = ''; if (hoteC) hoteC.innerHTML = ''; return; }
        const recule = (m, k) => { const d = new Date(+m.slice(0, 4), +m.slice(5, 7) - 1 - k, 1);
            return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'); };
        const M1 = recule(M, 1), N1 = recule(M, 12);
        if (hoteM) hoteM.textContent = moisFRLong(M);

        // L'encours d'un mois : l'arrêté qui tombe dans ce mois-là.
        const encoursDe = m => (D.encours || []).find(e => String(e.d).slice(0, 7) === m);
        const echuDe = (m, fin) => { const e = encoursDe(m); if (!e) return null;
            const r = (e.parFinancement || []).find(x => x.cat === fin);
            return r && r.total ? r.echu / r.total : null; };
        const echuTotal = m => { const e = encoursDe(m); if (!e) return null;
            const li = (e.parFinancement || []).filter(x => keep.has(x.cat));
            const t = li.reduce((a, x) => a + (x.total || 0), 0);
            const c = li.reduce((a, x) => a + (x.echu || 0), 0);
            return t ? c / t : null; };
        const fluxDe = (m, fin) => (D.flux || []).find(r => r.m === m && r.fin === fin);
        const dsoDeMois = (m, fin) => { const r = (D.dso || []).find(x => x.m === m && x.fin === fin);
            return r && r.mt ? { j: Math.round(r.mj / r.mt), n: r.n, mt: r.mt } : null; };

        // Les mêmes mesures, mais cumulées sur les membres de chaque famille.
        const fluxFam = (m, fam) => fam.membres.reduce((o, f) => { const r = fluxDe(m, f);
            if (r) { o.fac += r.fac || 0; o.enc += r.enc || 0; o.nFac += r.nFac || 0; o.nEnc += r.nEnc || 0; }
            return o; }, { fac: 0, enc: 0, nFac: 0, nEnc: 0 });
        const echuFam = (m, fam) => { const e = encoursDe(m); if (!e) return null;
            let t = 0, c = 0, vu = false;
            for (const f of fam.membres) { const r = (e.parFinancement || []).find(x => x.cat === f);
                if (r) { t += r.total || 0; c += r.echu || 0; vu = true; } }
            return (vu && t) ? c / t : null; };
        const dsoFam = (m, fam) => { let mt = 0, mj = 0, n = 0;
            for (const r of (D.dso || [])) { if (r.m !== m || fam.membres.indexOf(r.fin) < 0) continue;
                mt += r.mt; mj += r.mj; n += r.n; }
            return mt ? { j: Math.round(mj / mt), n: n, mt: mt } : null; };
        const familles = famillesDe(keep)
            .filter(fam => fluxFam(M, fam).fac || fluxFam(M, fam).enc || echuFam(M, fam) !== null)
            .sort((a, b) => fluxFam(M, b).fac - fluxFam(M, a).fac);
        const ptsCell = v => v === null ? '<span class="pil-acompleter">à compléter</span>'
            : '<span class="' + (v > 0 ? 'ec-pire' : v < 0 ? 'ec-mieux' : '') + '">'
              + (v > 0 ? '+' : '') + Math.round(v) + ' pts</span>';
        const delta = (a, b) => (a === null || b === null) ? null : 100 * (a - b);

        let h = '<table class="pil-bref-t"><thead><tr><th>Financeur</th>'
            + '<th class="n">Facturé</th><th class="n">Encaissé</th><th class="n">Taux d’échu</th>'
            + '<th class="n">vs M-1</th><th class="n">vs N-1</th><th class="n">DSO</th>'
            + '</tr></thead><tbody>';
        let tFac = 0, tEnc = 0;
        for (const fam of familles) {
            const fx = fluxFam(M, fam);
            const e0 = echuFam(M, fam), e1 = echuFam(M1, fam), e2 = echuFam(N1, fam);
            const d = dsoFam(M, fam);
            tFac += fx.fac; tEnc += fx.enc;
            h += '<tr><td class="fam">' + U().escapeHtml(fam.nom)
               + (fam.membres.length > 1
                    ? '<small>' + U().escapeHtml(fam.membres.join(' · ')) + '</small>' : '')
               + '</td>'
               + '<td class="n">' + eur(fx.fac) + '<small>' + fx.nFac + ' fact.</small></td>'
               + '<td class="n">' + eur(fx.enc) + '<small>' + fx.nEnc + ' règl.</small></td>'
               + '<td class="n">' + (e0 === null ? '<span class="pil-acompleter">à compléter</span>' : pct(e0)) + '</td>'
               + '<td class="n">' + ptsCell(delta(e0, e1)) + '</td>'
               + '<td class="n">' + ptsCell(delta(e0, e2)) + '</td>'
               + '<td class="n">' + (d ? jrs(d.j) + '<small>' + d.n + ' règl.</small>'
                                       : '<span class="pil-acompleter">à compléter</span>') + '</td></tr>';
        }
        const t0 = echuTotal(M), t1 = echuTotal(M1), t2 = echuTotal(N1);
        const dT = (() => { let mt = 0, mj = 0, n = 0;
            for (const r of (D.dso || [])) { if (r.m !== M || !keep.has(r.fin)) continue;
                mt += r.mt; mj += r.mj; n += r.n; }
            return mt ? { j: Math.round(mj / mt), n: n } : null; })();
        h += '<tr class="total"><td>Total</td>'
           + '<td class="n">' + eur(tFac) + '</td><td class="n">' + eur(tEnc) + '</td>'
           + '<td class="n">' + (t0 === null ? '<span class="pil-acompleter">à compléter</span>' : pct(t0)) + '</td>'
           + '<td class="n">' + ptsCell(delta(t0, t1)) + '</td>'
           + '<td class="n">' + ptsCell(delta(t0, t2)) + '</td>'
           + '<td class="n">' + (dT ? jrs(dT.j) : '<span class="pil-acompleter">à compléter</span>') + '</td></tr>';
        h += '</tbody></table>';
        if (hoteT) hoteT.innerHTML = h;
        if (hoteD) hoteD.textContent = 'Facturé et encaissé du mois d’après le grand livre, '
            + 'taux d’échu de l’encours arrêté à la fin du mois, et son évolution. '
            + 'Les financeurs du grand livre sont regroupés en familles, rappelées sous chaque nom ; '
            + 'l’intragroupe garde sa propre ligne et n’est pas compté dans Entreprise.';
        if (hoteC) hoteC.innerHTML = commentaireDuMois(keep, M, M1, N1, t0, t1, t2, dT, tFac, tEnc);
    }

    // LE COMMENTAIRE EST CALCULÉ, PAS DEVINÉ. Chaque phrase porte un chiffre
    // qui vient du relevé ; aucune ne porte d'appréciation que les chiffres ne
    // justifient. Il est présenté comme un BROUILLON À VALIDER, parce que
    // c'est elle qui signe ce qui sort.
    function commentaireDuMois(keep, M, M1, N1, t0, t1, t2, dT, tFac, tEnc) {
        const u = U(), ph = [];
        const encoursDe = m => (D.encours || []).find(e => String(e.d).slice(0, 7) === m);
        const somme = (m, champ) => { const e = encoursDe(m); if (!e) return null;
            return (e.parFinancement || []).filter(x => keep.has(x.cat))
                .reduce((a, x) => a + (x[champ] || 0), 0); };
        const e0 = somme(M, 'total'), e1 = somme(M1, 'total'), c0 = somme(M, 'echu');
        if (e0 !== null) {
            const v = (e1 !== null && e1) ? (e0 - e1) / e1 : null;
            ph.push('L’encours ' + (v === null ? 's’établit' : v < 0 ? 'recule de ' + pct(-v)
                        : 'progresse de ' + pct(v)) + (v === null ? '' : ' sur le mois')
                + ', à ' + eur(e0) + (c0 !== null ? ', dont ' + eur(c0) + ' échus ('
                        + pct(e0 ? c0 / e0 : null) + ')' : '') + '.');
        }
        // L'échu de plus de 120 jours : les tranches à partir de « 4 à 6 mois ».
        const tr = D.tranches || [];
        const iLong = tr.indexOf('4 à 6 mois');
        if (iLong >= 0) {
            const vieux = m => { const e = encoursDe(m); if (!e) return null;
                return (e.parFinancement || []).filter(x => keep.has(x.cat))
                    .reduce((a, x) => a + (x.buckets || []).slice(iLong)
                        .reduce((s, v) => s + (v || 0), 0), 0); };
            const v0 = vieux(M), vN = vieux(N1);
            if (v0 !== null) ph.push('L’échu de plus de 120 jours atteint ' + eur(v0)
                + (vN ? ' (' + (v0 >= vN ? '+' : '') + pct((v0 - vN) / vN) + ' sur un an)' : '')
                + (dT ? ' et le DSO du mois s’établit à ' + jrs(dT.j)
                        + ' sur ' + dT.n.toLocaleString('fr-FR') + ' règlements' : '') + '.');
        }
        // Qui se dégrade, d'après le mois d'échéance.
        const R = (D.retard || []).filter(r => keep.has(r.fin));
        if (R.length) {
            const mArrete = String(D.arrete || '').slice(0, 7);
            const mois = [...new Set(R.map(r => r.m))].sort().filter(m => m < mArrete).slice(-12);
            const par = new Map();
            for (const r of R) { if (mois.indexOf(r.m) < 0) continue;
                let o = par.get(r.fin); if (!o) { o = new Map(); par.set(r.fin, o); }
                const a = o.get(r.m) || { nEch: 0, nRet: 0 };
                a.nEch += r.nEch; a.nRet += r.nRet; o.set(r.m, a); }
            const li = [...par].map(([f, o]) => { const vus = mois.map(m => o.get(m))
                    .filter(a => a && a.nEch >= DEGRADE_MINI);
                if (vus.length < 2) return null;
                const d = 100 * vus[vus.length - 1].nRet / vus[vus.length - 1].nEch;
                const p = 100 * vus[0].nRet / vus[0].nEch;
                return { f, d: Math.round(d), delta: Math.round(d - p) }; })
                .filter(Boolean).sort((a, b) => b.delta - a.delta);
            const pires = li.filter(x => x.delta > 0).slice(0, 3);
            const mieux = li.filter(x => x.delta < 0).slice(-3).reverse();
            if (pires.length) ph.push('Financeurs qui se dégradent : '
                + pires.map(x => x.f + ' (' + x.d + ' % des échéances en retard, +'
                    + x.delta + ' pts sur douze mois)').join(' et ') + '.');
            if (mieux.length) ph.push('Qui s’améliore : '
                + mieux.map(x => x.f + ' (' + x.d + ' %, ' + x.delta + ' pts)').join(' et ') + '.');
        }
        if (tFac || tEnc) ph.push('Sur le mois, ' + eur(tFac) + ' facturés pour '
            + eur(tEnc) + ' encaissés' + (tFac ? ' — un encaissement de ' + pct(tEnc / tFac)
                + ' du facturé du mois' : '') + '.');
        if (t2 === null) ph.push('La comparaison N-1 du taux d’échu demande un arrêté d’il y a un an : '
            + 'le relevé n’en garde que treize mois, les cases concernées disent « à compléter ».');
        return ph.map(p => '<p>' + u.escapeHtml(p) + '</p>').join('')
            || '<p class="pil-acompleter">Rien à dire sur ce périmètre.</p>';
    }

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
        const autG = {}, nAutG = {};
        for (const r of (D.flux || [])) {
            if (!keep.has(r.fin) || r.m !== m) continue;
            fac += r.fac; enc += r.enc; avo += r.avo;
            for (const g of Object.keys(r.autG || {})) autG[g] = (autG[g] || 0) + r.autG[g];
            for (const g of Object.keys(r.nAutG || {})) nAutG[g] = (nAutG[g] || 0) + r.nAutG[g];
        }
        const totalAutres = ORDRE_GROUPE.reduce((t, g) => t + (autG[g] || 0), 0);
        const ecart = z.total - a.total - fac + enc + avo - totalAutres;

        const postes = [
            { nom: 'Encours au ' + parseFR(dep.d).toLocaleDateString('fr-FR'), v: a.total, type: 'socle' },
            { nom: 'Facturé', v: fac, type: 'plus' },
            { nom: 'Encaissé', v: -enc, type: 'moins' },
            { nom: 'Avoirs', v: -avo, type: 'moins' },
        ];
        for (const g of ORDRE_GROUPE) {
            const v = autG[g] || 0;
            if (Math.abs(v) <= 0.5) continue;
            postes.push({ nom: NOM_GROUPE[g], v, type: v >= 0 ? 'plus' : 'moins',
                          groupe: g, n: nAutG[g] || 0 });
        }
        // UN ÉCART QUI N'EXISTE PAS NE SE DESSINE PAS. S'il existe, il porte
        // son nom : on ne le range pas sous un poste qui ferait croire qu'il
        // est compris.
        if (Math.abs(ecart) > 0.5)
            postes.push({ nom: 'Écart inexpliqué', v: ecart, type: ecart >= 0 ? 'plus' : 'moins' });
        postes.push({ nom: 'Encours au ' + parseFR(fin.d).toLocaleDateString('fr-FR'),
                      v: z.total, type: 'socle' });

        // Une cascade se dessine en barres flottantes : chaque poste porte son
        // point de départ et son point d'arrivée. Le curseur part du socle de
        // gauche et marche de poste en poste jusqu'à celui de droite.
        let curseur = a.total;
        const data = postes.map(p => {
            if (p.type === 'socle') return [0, p.v];
            const de = curseur, vers = curseur + p.v; curseur = vers; return [de, vers];
        });

        // Le détail d'un poste : ses écritures, une par ligne.
        const ouvrirDetail = g => {
            const lignes = (D.mouvements || [])
                .filter(x => x.m === m && keep.has(x.fin) && x.g === g)
                .sort((x, y) => Math.abs(y.v) - Math.abs(x.v));
            const cols = [
                { key: 'd', label: 'Date', width: '92px' },
                { key: 'j', label: 'Journal', width: '72px' },
                { key: 'c', label: 'Compte', width: '130px' },
                { key: 't', label: 'Tiers' },
                { key: 'n', label: 'Facture', width: '150px',
                  format: v => v ? U().escapeHtml(v)
                    : '<span class="pil-acompleter">aucune</span>' },
                { key: 'l', label: 'Libellé' },
                { key: 'fin', label: 'Financeur', width: '150px' },
                { key: 'v', label: 'Montant', align: 'right', width: '110px',
                  format: v => (v >= 0 ? '+' : '−') + eur(Math.abs(v)) },
            ];
            const somme = lignes.reduce((t, x) => t + x.v, 0);
            U().modal(NOM_GROUPE[g] + ' — ' + U().moisLabel(m),
                '<p class="pil-note">' + lignes.length.toLocaleString('fr-FR')
                + ' écriture' + (lignes.length > 1 ? 's' : '') + ' · '
                + (somme >= 0 ? '+' : '−') + eur(Math.abs(somme))
                + ' sur l’encours. Ni facture, ni règlement, ni avoir.</p>'
                + '<div class="table-wrap-tall">'
                + U().table(cols, lignes, { vide: 'Aucune écriture.' }) + '</div>',
                [{ label: 'Fermer' }], { large: true });
        };

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
                    backgroundColor: postes.map(p => p.type === 'socle' ? '#2B5DB8'
                        : p.type === 'plus' ? '#B8352A' : '#1D7F55'),
                    borderWidth: 0,
                }],
            },
            options: {
                responsive: true, maintainAspectRatio: false,
                scales: { x: { grid: { display: false } },
                          y: { grid: U().grille, ticks: { callback: v => U().eurosCourt(v) } } },
                onClick: (ev, els) => {
                    if (!els || !els.length) return;
                    const p = postes[els[0].index];
                    if (p && p.groupe) ouvrirDetail(p.groupe);
                },
                onHover: (ev, els) => {
                    const c = ev && ev.native && ev.native.target;
                    if (c) c.style.cursor = (els && els.length && postes[els[0].index].groupe)
                        ? 'pointer' : 'default';
                },
                plugins: {
                    legend: { display: false },
                    tooltip: { callbacks: { label: c2 => {
                        const p = postes[c2.dataIndex];
                        if (p.type === 'socle') return eur(p.v);
                        return (p.v >= 0 ? '+' : '') + eur(p.v)
                            + (p.groupe ? ' · ' + p.n + ' écriture' + (p.n > 1 ? 's' : '')
                                          + ' · cliquez pour les lire' : ''); } } },
                },
            },
        });
        // LE TABLEAU DES POSTES, PARCE QUE LA BARRE NE SE VOIT PAS. Un poste de
        // 15 690 € sur une échelle de 14 M€ mesure un cinquième de pixel : il
        // ne se voit pas et il ne se clique pas. Chaque poste se lit donc aussi
        // en toutes lettres, avec son montant et son nombre d'écritures — un
        // fait dans une cellule, pas dans une phrase — et ceux qui ne sont ni
        // facture, ni règlement, ni avoir s'ouvrent sur leur détail.
        const bloc = document.getElementById('pil-bridge-postes');
        if (bloc) {
            let nFac = 0, nEnc = 0, nAvo = 0;
            for (const r of (D.flux || [])) {
                if (!keep.has(r.fin) || r.m !== m) continue;
                nFac += r.nFac || 0; nEnc += r.nEnc || 0; nAvo += r.nAvo || 0;
            }
            const nb = { 'Facturé': nFac, 'Encaissé': nEnc, 'Avoirs': nAvo };
            const lignes = [];
            lignes.push({ nom: postes[0].nom, v: a.total, n: null, socle: true });
            for (const p of postes.slice(1, -1))
                lignes.push({ nom: p.nom, v: p.v, n: p.groupe ? p.n : (nb[p.nom] || null),
                              groupe: p.groupe || '' });
            // UN POSTE À ZÉRO EST UN POSTE : deux écritures qui se compensent
            // ne dessinent aucune barre, et le compte ne tomberait plus juste.
            for (const g of ORDRE_GROUPE)
                if (Math.abs(autG[g] || 0) <= 0.5 && (nAutG[g] || 0) > 0)
                    lignes.push({ nom: NOM_GROUPE[g], v: 0, n: nAutG[g], groupe: g });
            lignes.push({ nom: postes[postes.length - 1].nom, v: z.total, n: null, socle: true });
            bloc.innerHTML = '<table class="data-table pil-postes-table"><thead><tr>'
                + '<th>Poste</th><th class="ta-r">Montant</th><th class="ta-r">Écritures</th>'
                + '</tr></thead><tbody>'
                + lignes.map(r => '<tr' + (r.socle ? ' class="total"' : '') + '>'
                    + '<td>' + U().escapeHtml(r.nom) + '</td>'
                    + '<td class="ta-r">' + (r.socle || Math.abs(r.v) <= 0.5 ? eur(r.v)
                        : (r.v > 0 ? '+' : '−') + eur(Math.abs(r.v))) + '</td>'
                    + '<td class="ta-r">' + (r.n == null ? '—'
                        : r.groupe
                          ? '<button type="button" class="lien-cellule" data-groupe="'
                            + U().escapeHtml(r.groupe) + '">'
                            + r.n.toLocaleString('fr-FR') + '</button>'
                          : r.n.toLocaleString('fr-FR')) + '</td></tr>').join('')
                + '</tbody></table>';
            bloc.onclick = ev => {
                const b = ev.target.closest('button[data-groupe]');
                if (b) ouvrirDetail(b.dataset.groupe);
            };
        }
        // LA PHRASE DISAIT « DONT », ET C'ÉTAIT FAUX. « −248 035 € à expliquer,
        // dont 1 899 548 € facturés » laissait croire que les 1,9 M€ étaient une
        // PART des 248 k€, alors qu'ils en sont un terme de sens contraire. Les
        // postes se rangent donc par sens : ce qui fait monter l'encours d'un
        // côté, ce qui le fait baisser de l'autre, et le solde entre les deux.
        const monte = [], baisse = [];
        (fac > 0 ? monte : baisse).push(eur(Math.abs(fac)) + ' facturés');
        if (Math.abs(enc) > 0.5) baisse.push(eur(Math.abs(enc)) + ' encaissés');
        if (Math.abs(avo) > 0.5) baisse.push(eur(Math.abs(avo)) + ' d’avoirs');
        for (const g of ORDRE_GROUPE) {
            const v = autG[g] || 0, n = nAutG[g] || 0;
            if (Math.abs(v) <= 0.5) continue;
            (v > 0 ? monte : baisse).push(eur(Math.abs(v)) + ' ' + DIT_GROUPE[g]
                + ' (' + n.toLocaleString('fr-FR') + ' écriture' + (n > 1 ? 's' : '') + ')');
        }
        if (Math.abs(ecart) > 0.5)
            (ecart > 0 ? monte : baisse).push(eur(Math.abs(ecart)) + ' d’écart inexpliqué');
        const et = l => l.length > 1
            ? l.slice(0, -1).join(', ') + ' et ' + l[l.length - 1] : (l[0] || '');
        const delta = z.total - a.total;
        const el = document.getElementById('pil-bridge-dit');
        if (el) el.textContent = 'L’encours passe de ' + eur(a.total) + ' à ' + eur(z.total)
            + ', soit ' + (delta >= 0 ? '+' : '−') + eur(Math.abs(delta)) + '. '
            + (monte.length ? 'Il monte de ' + et(monte) + '. ' : '')
            + (baisse.length ? 'Il baisse de ' + et(baisse) + '. ' : '')
            + 'En rouge ce qui le fait monter, en vert ce qui le fait baisser. '
            + 'Le tableau ci-dessous reprend chaque poste ; les écritures qui ne sont ni'
            + ' facture, ni règlement, ni avoir s’ouvrent sur leur détail.';
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
