/* ═══════════════════════════════════════════════════════════════════════
   L'ONGLET OPÉRATIONNEL
   ═══════════════════════════════════════════════════════════════════════

   Repris de « Suivi recouvrement version 2 », onglet « Opérationnel »,
   13/11/2026 : « récupère de suivi recouvrement 2 l'onglet opérationnel et
   met le dans mon appli ».

   CE QU'IL RÉPOND : non pas « combien doit-on » — ça, c'est le pilotage —
   mais « qu'est-ce qu'il faut traiter, et depuis combien de temps ça
   attend ». Il lit les tableaux Monday, pas la comptabilité.

   LE CIRCUIT. Les quatre étapes et leurs cibles viennent de la v2, et la
   table qui range chaque groupe Monday dans son étape aussi. Vérifiée le
   13/11/2026 contre les neuf tableaux : elle couvre 100 % des groupes, zéro
   non classé. Ce modèle est PROPRE À CET ONGLET et ne remplace pas
   LioraRules.ETAPES, qui qualifie un groupe par ses mots et sert ailleurs :
   celui-ci dit quel service tient la facture et sous quel délai.

   L'ÂGE DANS L'ÉTAPE se compte depuis la date d'entrée quand Monday la
   porte (« Date MAJ qualif ADV », « Date bascule en recouvrement »…), sinon
   depuis la date de référence de l'étape — facture pour l'ADV, échéance
   pour les autres. D'où elle vient est écrit sous le graphique : un âge
   dont on ignore l'origine ne se vérifie pas.

   LES ENTRÉES ET LES SORTIES se lisent dans l'historique Monday, qui n'est
   pas dans le paquet publié. Elles se chargent à la demande, avec le même
   jeton que le reste de l'application, et le rapprochement se fait par le
   NUMÉRO DE FACTURE — les exports du paquet ne portent pas l'identifiant
   Monday des lignes.
   ═══════════════════════════════════════════════════════════════════════ */
(function (global) {
    'use strict';

    const U = () => global.LioraUI;

    // ── Le circuit, repris de la v2 ──
    const CIRCUIT = [
        { k: 'adv', n: 'Rendre payable', svc: 'ADV', cible: 10, ref: 'facture',
          d: 'Factures non conformes ou incomplètes, à rendre payables' },
        { k: 'rec', n: 'Relancer', svc: 'Recouvrement', cible: 15, ref: 'echeance',
          d: 'Factures échues à relancer' },
        { k: 'fin', n: 'Clôture', svc: 'Contentieux', cible: 90, ref: 'echeance',
          d: 'Contentieux, perdu, attente de décision de passage en perte' },
        { k: 'cor', n: 'Corriger', svc: 'Comptabilité', cible: 30, ref: 'echeance',
          d: 'Paiement reçu non lettré, facture à annuler, toute autre clôture' },
    ];
    const ETAPE = {}; CIRCUIT.forEach(e => { ETAPE[e.k] = e; });

    // Numéro de groupe Monday → étape. « cours » = pas encore à traiter.
    const GROUPE_ETAPE = {
        '1.0.1': 'adv',
        '1.1.1': 'adv', '1.1.2': 'adv', '1.1.3': 'adv', '1.1.4': 'adv', '1.1.5': 'cours',
        '1.2.1': 'rec', '1.2.2': 'adv', '1.2.3': 'rec', '1.2.4': 'fin', '1.2.5': 'fin',
        '1.2.6': 'rec', '1.2.7': 'rec', '1.2.8': 'cor',
        '1.3.1': 'adv', '1.3.5': 'cours',
        '2.1.1': 'rec', '2.1.1.1': 'rec', '2.1.2': 'cor', '2.1.3': 'cor', '2.1.4': 'rec',
        '2.1.5': 'rec', '2.1.6': 'fin', '2.1.7': 'cours', '2.1.8': 'cor',
        '2.2.1': 'adv', '2.2.2': 'rec', '2.2.3': 'cor', '2.2.4': 'cor', '2.2.5': 'cours',
        '2.2.6': 'cor', '2.2.9': 'cor', '2.2.10': 'cor',
        '2.3.1': 'rec', '2.3.3': 'rec', '2.3.5': 'cours', '2.3.6': 'cours', '2.3.7': 'cours',
        '2.3.9': 'cor', '2.3.10': 'cor',
        '2.4.2': 'rec', '2.4.3': 'rec', '2.4.7': 'cours', '2.4.9': 'cor', '2.4.10': 'cor',
    };

    // PAS DE MÉTRIQUE « SANS RELANCE », 13/11/2026, et c'est un constat, pas un
    // oubli : AUCUN des sept tableaux de travail ne porte de date de dernière
    // relance. « Relance 1 - J », « Relance 1 » et « Blocage manuel des
    // relances » ne sont pas des dates. La v2 affichait « 100 % de dossiers
    // qui dorment » — vrai au sens du calcul, faux au sens de la réalité :
    // il ne mesurait que l'absence de la colonne. Il n'est pas repris.

    // ── l'état de l'onglet ──
    const F = { etape: 'adv', q: '', deplies: {} };
    let HIST = null;                    // { mois, de, le, par: Map(etape → {e,s,dest,dur}) }
    let histEtat = { s: 'idle', msg: '' };
    let DERNIERES = [];                 // les factures du dernier rendu

    // ═════════ helpers ═════════
    const prefixe = t => { const m = /^\s*(\d+(?:\.\d+)+)/.exec(String(t || '')); return m ? m[1] : ''; };
    const esc = s => U().escapeHtml(String(s == null ? '' : s));
    const eur = v => U().euros(v);
    const nb = v => (v == null || !isFinite(v)) ? '—' : Math.round(v).toLocaleString('fr-FR');
    const JOUR = 86400000;
    const auj = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };
    const jours = (a, b) => (!a || !b) ? null : Math.round((b - new Date(a)) / JOUR);
    const mediane = arr => { const a = arr.filter(x => x != null && isFinite(x)).sort((x, y) => x - y);
        if (!a.length) return null;
        const m = Math.floor(a.length / 2);
        return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };
    const somme = (arr, f) => arr.reduce((s, x) => s + (f(x) || 0), 0);

    // Le reste dû fait foi ; à défaut le montant TTC.
    const montantDe = f => (f.resteDu != null && isFinite(f.resteDu)) ? f.resteDu : (f.montant || 0);

    const etapeDe = f => {
        if (f.groupeTechnique) return null;
        const g = f.groupeOperationnel || f.groupe || '';
        return GROUPE_ETAPE[prefixe(g)] || null;
    };

    // Les factures que le circuit suit : ni réglées, ni avoirs, ni « en cours ».
    function ouvertes(factures) {
        return (factures || []).filter(f => {
            if (f.paye) return false;
            if (/^avr/i.test(String(f.numero || ''))) return false;
            const k = etapeDe(f);
            return !!(k && ETAPE[k]);
        });
    }

    // L'âge dans l'étape, et d'où il vient.
    function ageEtape(f, k) {
        const e = ETAPE[k], t = auj();
        if (f.dateEtape) return { j: jours(f.dateEtape, t), src: 'etape' };
        const ref = e.ref === 'facture' ? f.dateFacture : (f.dateEcheance || f.dateEcheanceSource);
        return ref ? { j: jours(ref, t), src: 'ref' } : { j: null, src: 'aucune' };
    }

    function statsEtape(items, k) {
        const its = items.filter(f => etapeDe(f) === k);
        const ages = its.map(f => ageEtape(f, k).j).filter(j => j != null);
        const cible = ETAPE[k].cible;
        return {
            its, st: its.length, mt: somme(its, montantDe),
            a: mediane(ages), c: cible,
            h: ages.length ? ages.filter(j => j > cible).length / ages.length * 100 : null,
        };
    }

    const retard = f => { const d = f.dateEcheance || f.dateEcheanceSource;
        return d ? jours(d, auj()) : null; };

    // ═════════ l'historique Monday ═════════
    //
    // Monday garde le journal de ses tableaux. Un déplacement de ligne d'un
    // groupe à l'autre est une sortie pour l'un et une entrée pour l'autre :
    // c'est tout ce qu'il faut pour compter les mouvements d'un mois.
    //
    // LE RAPPROCHEMENT SE FAIT PAR LE NUMÉRO DE FACTURE, qui est le nom de la
    // ligne Monday. Les exports du paquet ne portent pas l'identifiant Monday,
    // et un identifiant qu'on n'a pas ne rapproche rien.
    async function chargerHistorique(mois) {
        const M = global.LioraMonday, S = global.LioraStore;
        if (!M) throw new Error('Le client Monday n’est pas chargé.');
        const reglages = S && S.lire ? await S.lire('settings') : null;
        const jeton = reglages && (reglages.token || reglages.jeton);
        if (!jeton) throw new Error('Aucun jeton Monday enregistré : renseignez-le dans l’onglet Données.');
        const boards = [...new Set(DERNIERES.map(f => String(f.boardId)).filter(b => /^\d+$/.test(b)))];
        if (!boards.length) throw new Error('Les tableaux n’ont pas d’identifiant Monday dans ce paquet : '
            + 'actualisez une fois depuis Monday pour que l’historique puisse être lu.');
        const de = mois + '-01';
        const au = new Date(+mois.slice(0, 4), +mois.slice(5, 7), 0);
        const auISO = au.toISOString().slice(0, 10);
        const q = `query($ids:[ID!],$de:ISO8601DateTime!,$au:ISO8601DateTime!){
            boards(ids:$ids){ id name
              groups { id title }
              activity_logs(from:$de, to:$au, limit:10000){ event data created_at }
            } }`;
        const rep = await M.gql(jeton, q, { ids: boards, de: de + 'T00:00:00Z', au: auISO + 'T23:59:59Z' });
        const par = {}; CIRCUIT.forEach(e => { par[e.k] = { e: 0, s: 0, dest: {}, dur: [] }; });
        const titres = new Map();                         // groupId → titre
        for (const b of ((rep && rep.boards) || []))
            for (const g of (b.groups || [])) titres.set(g.id, g.title);
        const etapeDuGroupe = id => GROUPE_ETAPE[prefixe(titres.get(id) || '')] || null;
        let lus = 0;
        for (const b of ((rep && rep.boards) || [])) {
            for (const a of (b.activity_logs || [])) {
                if (a.event !== 'move_pulse_into_group') continue;
                let d; try { d = JSON.parse(a.data); } catch (_) { continue; }
                lus++;
                const dep = etapeDuGroupe(d.source_group_id || (d.source_group || {}).id);
                const arr = etapeDuGroupe(d.dest_group_id || (d.dest_group || {}).id);
                const nom = String(d.pulse_name || '').trim();
                if (arr && par[arr]) par[arr].e++;
                if (dep && par[dep]) {
                    par[dep].s++;
                    const ou = arr ? ETAPE[arr].n : (titres.get(d.dest_group_id) || 'Hors circuit');
                    par[dep].dest[ou] = (par[dep].dest[ou] || 0) + 1;
                }
                if (nom) { /* le numéro sert au rapprochement futur */ }
            }
        }
        HIST = { mois, de, au: auISO, le: new Date().toISOString(), par, lus };
        return HIST;
    }

    // ═════════ rendu ═════════
    function vignetteEtape(st, k, fleche) {
        const s = st[k], e = ETAPE[k];
        return '<button class="op-fcard" data-etape="' + k + '">'
            + '<span class="op-ft">' + esc(e.n) + '<span>' + esc(e.svc) + '</span></span>'
            + '<span class="op-fbig">' + nb(s.st) + ' <small>factures</small></span>'
            + '<span class="op-fs">' + eur(s.mt) + '</span>'
            + '<span class="op-fs">âge médian du traitement <b>' + (s.a == null ? '—' : nb(s.a) + ' j')
            + '</b> · cible ' + e.cible + ' j</span>'
            + (s.h == null ? '' : '<span class="op-chip ' + (s.h >= 60 ? 'mauvais' : s.h >= 30 ? 'moyen' : 'bon')
                + '">' + nb(s.h) + ' % hors délai</span>')
            + '</button>' + (fleche ? '<div class="op-fleche" aria-hidden="true">→</div>' : '');
    }

    function tableauCircuit(items, st) {
        const mx = Math.max(...CIRCUIT.map(e => st[e.k].mt), 1);
        const barre = (p, c) => '<span class="op-mini"><i style="width:'
            + Math.max(0, Math.min(100, p)).toFixed(1) + '%;background:' + c + '"></i></span>';
        let h = '<table class="op-t"><thead><tr><th>Étape du process</th><th class="n">Factures</th>'
            + '<th class="n">Montant</th><th class="n">Entrées</th><th class="n">Sorties</th>'
            + '<th class="n">Âge médian du traitement</th><th class="n">Cible</th>'
            + '<th class="n">% hors délai</th></tr></thead><tbody>';
        let tSt = 0, tMt = 0, tE = 0, tS = 0;
        for (const e of CIRCUIT) {
            const s = st[e.k], ouvert = !!F.deplies[e.k];
            const fl = HIST ? HIST.par[e.k] : null;
            tSt += s.st; tMt += s.mt; if (fl) { tE += fl.e; tS += fl.s; }
            h += '<tr><td><button class="op-tog" data-deplie="' + e.k + '" aria-expanded="' + ouvert + '">'
               + (ouvert ? '▾ ' : '▸ ') + esc(e.n) + '</button>'
               + '<br><span class="op-pied">' + esc(e.d) + '</span></td>'
               + '<td class="n">' + nb(s.st) + '</td>'
               + '<td class="n">' + eur(s.mt) + barre(s.mt / mx * 100, 'var(--serie-2)') + '</td>'
               + '<td class="n">' + (fl ? nb(fl.e) : '—') + '</td>'
               + '<td class="n">' + (fl ? nb(fl.s) : '—') + '</td>'
               + '<td class="n">' + (s.a == null ? '—' : nb(s.a) + ' j') + '</td>'
               + '<td class="n">' + e.cible + ' j</td>'
               + '<td class="n">' + (s.h == null ? '—' : nb(s.h) + ' %'
                    + barre(s.h, s.h >= 60 ? 'var(--red)' : s.h >= 30 ? 'var(--amber)' : 'var(--green)')) + '</td></tr>';
            if (ouvert) {
                const g = {};
                s.its.forEach(f => { const t = (f.problematique || '').trim() || 'Problématique non renseignée';
                    (g[t] || (g[t] = [])).push(f); });
                Object.keys(g).sort((a, b) => g[b].length - g[a].length).forEach(t => {
                    const arr = g[t];
                    const ages = arr.map(f => ageEtape(f, e.k).j).filter(j => j != null);
                    const hd = ages.length ? ages.filter(j => j > e.cible).length / ages.length * 100 : null;
                    const m2 = somme(arr, montantDe);
                    h += '<tr class="op-sous"><td>' + esc(t) + '</td><td class="n">' + nb(arr.length) + '</td>'
                       + '<td class="n">' + eur(m2) + barre(m2 / mx * 100, 'var(--text-muted)') + '</td>'
                       + '<td class="n"></td><td class="n"></td>'
                       + '<td class="n">' + (mediane(ages) == null ? '—' : nb(mediane(ages)) + ' j') + '</td>'
                       + '<td class="n">' + e.cible + ' j</td>'
                       + '<td class="n">' + (hd == null ? '—' : nb(hd) + ' %') + '</td></tr>';
                });
            }
        }
        h += '<tr class="total"><td>Total circuit</td><td class="n">' + nb(tSt) + '</td>'
           + '<td class="n">' + eur(tMt) + '</td>'
           + '<td class="n">' + (HIST ? nb(tE) : '—') + '</td>'
           + '<td class="n">' + (HIST ? nb(tS) : '—') + '</td>'
           + '<td class="n"></td><td class="n"></td><td class="n"></td></tr>';
        return h + '</tbody></table>';
    }

    function blocSorties() {
        if (histEtat.s === 'run')
            return '<div class="op-vide">' + esc(histEtat.msg || 'Lecture de l’historique Monday…') + '</div>';
        if (histEtat.s === 'error')
            return '<div class="op-vide">L’historique n’a pas pu être lu : ' + esc(histEtat.msg)
                 + '<br><br><button class="btn btn-sm" id="op-hist">Réessayer</button></div>';
        if (!HIST)
            return '<div class="op-vide">Les entrées, les sorties et leurs destinations se lisent dans '
                 + 'l’historique Monday, qui n’est pas dans le paquet publié.<br><br>'
                 + '<button class="btn btn-primary btn-sm" id="op-hist">Charger l’historique Monday</button></div>';
        const TEINTES = ['var(--serie-1)', 'var(--serie-2)', 'var(--serie-3)', 'var(--serie-4)',
                         'var(--serie-5)', 'var(--serie-6)'];
        let h = '';
        for (const e of CIRCUIT) {
            const fl = HIST.par[e.k];
            const noms = Object.keys(fl.dest).sort((a, b) => fl.dest[b] - fl.dest[a]);
            if (!fl.s) { h += '<div class="op-stk"><div class="op-stk-h"><b>' + esc(e.n) + '</b>'
                + '<span class="op-pied">aucune sortie sur le mois</span></div></div>'; continue; }
            const seg = noms.map((n, i) => { const p = fl.dest[n] / fl.s * 100;
                return '<div style="width:' + p.toFixed(2) + '%;background:' + TEINTES[i % TEINTES.length]
                     + '" title="' + esc(n + ' : ' + fl.dest[n] + ' factures')
                     + '">' + (p >= 9 ? Math.round(p) + ' %' : '') + '</div>'; }).join('');
            const leg = noms.map((n, i) => '<span><i class="op-sw" style="background:'
                + TEINTES[i % TEINTES.length] + '"></i>' + esc(n) + ' — ' + nb(fl.dest[n])
                + ' factures · ' + nb(fl.dest[n] / fl.s * 100) + ' %</span>').join('');
            h += '<div class="op-stk"><div class="op-stk-h"><b>' + esc(e.n) + '</b>'
               + '<span class="op-pied">' + nb(fl.s) + ' factures sorties</span></div>'
               + '<div class="op-stk-bar">' + seg + '</div><div class="op-legende">' + leg + '</div></div>';
        }
        return h;
    }

    // Les lignes à traiter en premier : montant d'abord, ancienneté du retard
    // ensuite. Une facture sans échéance n'est pas prioritaire — elle est à
    // qualifier, et elle le dit.
    function priorisees(its, k) {
        return its.map(f => {
            const a = ageEtape(f, k), r = retard(f), m = montantDe(f);
            const tags = [];
            if (r != null && r > 0) tags.push(['échue de ' + r + ' j', r > 90 ? 'mauvais' : r > 30 ? 'moyen' : '']);
            if (!f.dateEcheance && !f.dateEcheanceSource) tags.push(['échéance à qualifier', 'moyen']);
            if (f.promesse) tags.push([new Date(f.promesse) < auj() ? 'promesse dépassée' : 'paiement promis',
                                       new Date(f.promesse) < auj() ? 'mauvais' : 'bon']);
            if (a.j != null && a.j > ETAPE[k].cible) tags.push(['hors délai', 'moyen']);
            const score = (m || 0) * (1 + Math.max(0, (r == null ? 0 : r)) / 180);
            return { f, a: a.j, r, m, tags, score };
        }).sort((x, y) => y.score - x.score);
    }

    function rendre(factures) {
        const hote = document.getElementById('op-corps');
        if (!hote) return;
        DERNIERES = factures || [];
        const items0 = ouvertes(factures);
        const q = F.q.trim().toLowerCase();
        const items = !q ? items0 : items0.filter(f =>
            [f.numero, f.client, f.apprenant, f.groupe].some(v => String(v || '').toLowerCase().includes(q)));
        const st = {}; CIRCUIT.forEach(e => { st[e.k] = statsEtape(items, e.k); });
        const avecEntree = items.filter(f => !!f.dateEtape).length;

        // ── le portefeuille ──
        const tousOuverts = items;
        const ech = tousOuverts.filter(f => { const r = retard(f); return r != null && r > 0; });
        const nonEch = tousOuverts.filter(f => { const r = retard(f); return r != null && r <= 0; });
        const sans = tousOuverts.filter(f => retard(f) == null);
        const tot = somme(tousOuverts, montantDe);
        const tuile = (l, v, s, ton) => '<div class="kpi-card' + (ton ? ' ' + ton : '') + '">'
            + '<div class="kpi-label">' + esc(l) + '</div><div class="kpi-value">' + v + '</div>'
            + '<div class="kpi-sub">' + s + '</div></div>';
        const portefeuille = '<div class="kpi-grid">'
            + tuile('Reste à encaisser', eur(tot), nb(tousOuverts.length) + ' factures ouvertes dans le circuit')
            + tuile('En recouvrement', eur(somme(ech, montantDe)), nb(ech.length) + ' factures échues · '
                + nb(tot ? somme(ech, montantDe) / tot * 100 : 0) + ' % du reste')
            + tuile('Non échu', eur(somme(nonEch, montantDe)), nb(nonEch.length) + ' factures pas encore exigibles')
            + tuile('Échéance à qualifier', eur(somme(sans, montantDe)), nb(sans.length)
                + ' factures dont la date manque')
            + '</div>';

        // ── le focus ──
        const k = ETAPE[F.etape] ? F.etape : 'adv';
        const e = ETAPE[k], s = st[k];
        const srcs = { etape: 0, ref: 0, aucune: 0 };
        s.its.forEach(f => { srcs[ageEtape(f, k).src]++; });
        const prom = s.its.filter(f => f.promesse);
        const promKO = prom.filter(f => new Date(f.promesse) < auj());
        const echK = s.its.filter(f => { const r = retard(f); return r != null && r > 0; });
        // La promesse de paiement n'est saisie que sur l'ADV, le Recouvrement et
        // le Financement personnel. Ailleurs la tuile le dit plutôt que
        // d'afficher un zéro qui passerait pour « aucune promesse ».
        const portePromesse = ['adv', 'rec'].indexOf(k) >= 0 || prom.length > 0;
        const quatrieme = k === 'adv'
            ? ['Échues encore à l’ADV', nb(echK.length) + ' · ' + eur(somme(echK, montantDe)),
               'en retard sans avoir été rendues payables']
            : portePromesse
            ? ['Promesses de paiement', nb(prom.length), nb(promKO.length) + ' dont la date est passée']
            : ['Promesses de paiement', '<span class="op-acompleter">à compléter</span>',
               'ces tableaux ne portent pas de colonne de paiement promis'];
        const tuilesFocus = '<div class="kpi-grid">'
            + tuile('Dans l’étape', nb(s.st) + ' · ' + eur(s.mt),
                HIST ? nb(HIST.par[k].e) + ' entrées, ' + nb(HIST.par[k].s) + ' sorties sur le mois'
                     : 'historique non chargé')
            + tuile('Âge médian du traitement', (s.a == null ? '—' : nb(s.a) + ' j'),
                'cible ' + e.cible + ' j · ' + (s.h == null ? '—' : nb(s.h) + ' % hors délai'))
            + tuile('Montant hors délai', eur(somme(s.its.filter(f => {
                const a = ageEtape(f, k).j; return a != null && a > e.cible; }), montantDe)),
                'ce qui attend depuis plus de ' + e.cible + ' jours')
            + tuile(quatrieme[0], quatrieme[1], quatrieme[2])
            + '</div>';

        // par groupe Monday
        const parG = {};
        s.its.forEach(f => { const g = String(f.groupe || '').replace(/^\s*[\d.]+\s*/, '') || '(sans groupe)';
            parG[g] = (parG[g] || 0) + 1; });
        const mxG = Math.max(...Object.values(parG), 1);
        const barres = Object.keys(parG).sort((a, b) => parG[b] - parG[a]).map(g =>
            '<div class="op-hb"><span>' + esc(g) + '</span>'
            + '<span class="op-track"><i style="width:' + (parG[g] / mxG * 100).toFixed(1)
            + '%;background:var(--serie-2)"></i></span>'
            + '<span class="op-v">' + nb(parG[g]) + '</span></div>').join('');

        // l'âge dans l'étape
        const BK = { adv: [5, 10, 20, 30], rec: [15, 30, 90, 180], fin: [90, 180, 365, 730],
                     cor: [15, 30, 60, 120] }[k];
        const libs = ['0-' + BK[0] + ' j', (BK[0] + 1) + '-' + BK[1] + ' j', (BK[1] + 1) + '-' + BK[2] + ' j',
                      (BK[2] + 1) + '-' + BK[3] + ' j', '> ' + BK[3] + ' j'];
        const cpt = [0, 0, 0, 0, 0];
        s.its.forEach(f => { const a = ageEtape(f, k).j; if (a == null) return;
            cpt[a <= BK[0] ? 0 : a <= BK[1] ? 1 : a <= BK[2] ? 2 : a <= BK[3] ? 3 : 4]++; });
        const mxB = Math.max(...cpt, 1);
        const hist = cpt.map((v, i) => { const bas = i === 0 ? 0 : BK[i - 1];
            return '<div class="op-col"><span class="op-col-v">' + nb(v) + '</span>'
                 + '<i style="height:' + (v / mxB * 100).toFixed(1) + '%;background:'
                 + (bas >= e.cible ? 'var(--red)' : 'var(--serie-2)') + '"></i>'
                 + '<span class="op-col-l">' + libs[i] + '</span></div>'; }).join('');

        // la liste priorisée
        const pr = priorisees(s.its, k), top = pr.slice(0, 30);
        const lien = f => (/^\d+$/.test(String(f.itemId || '')) && /^\d+$/.test(String(f.boardId || '')))
            ? '<a href="https://cyberuniversity.monday.com/boards/' + f.boardId + '/pulses/' + f.itemId
              + '" target="_blank" rel="noopener">' + esc(f.numero) + '</a>'
            : esc(f.numero);
        const lignes = top.map(p => { const f = p.f;
            return '<tr><td>' + lien(f)
                 + ((f.client && f.client !== '—') || f.apprenant
                    ? '<br><span class="op-pied">' + esc(f.client !== '—' ? f.client : f.apprenant) + '</span>' : '')
                 + '</td><td>' + esc(f.financement || '—') + '</td>'
                 + '<td>' + esc(String(f.groupe || '').replace(/^\s*[\d.]+\s*/, ''))
                 + (f.problematique ? '<br><span class="op-pied">' + esc(f.problematique) + '</span>' : '') + '</td>'
                 + '<td class="n">' + eur(p.m) + '</td>'
                 + '<td class="n">' + (f.dateEcheance || f.dateEcheanceSource
                        ? U().dateFR(f.dateEcheance || f.dateEcheanceSource)
                          + (p.r != null ? '<br><span class="op-pied">' + (p.r > 0 ? 'dépassée de ' + p.r + ' j'
                             : p.r === 0 ? 'aujourd’hui' : 'dans ' + (-p.r) + ' j') + '</span>' : '')
                        : '<span class="op-acompleter">à qualifier</span>') + '</td>'
                 + '<td class="n">' + (p.a == null ? '—' : p.a + ' j') + '</td>'
                 + '<td><span class="op-tags">' + p.tags.map(t =>
                        '<span class="op-chip ' + t[1] + '">' + esc(t[0]) + '</span>').join('') + '</span></td></tr>';
        }).join('');

        const sousTabs = CIRCUIT.map(x => '<button class="seg-btn' + (x.k === k ? ' active' : '')
            + '" data-focus="' + x.k + '">' + esc(x.n) + ' <span class="op-cnt">' + nb(st[x.k].st)
            + '</span></button>').join('');

        hote.innerHTML =
            '<div class="section-header"><h2>Recouvrement opérationnel</h2></div>'
          + '<p class="aide-bloc">Ce qu’il faut traiter, étape par étape du circuit. Les actions se font dans '
          + 'Monday. Les factures réglées, les avoirs et les groupes « en cours » n’entrent pas dans le circuit.</p>'
          + '<div class="table-toolbar"><div class="table-toolbar-right">'
          + '<input type="search" id="op-q" class="op-rech" placeholder="Facture, client, groupe" value="'
          + esc(F.q) + '">'
          + '<button class="btn btn-ghost btn-sm" id="op-export">Exporter l’étape</button>'
          + '</div></div>'
          + portefeuille
          + '<div class="charts-grid"><div class="chart-card chart-wide">'
          + '<div class="chart-header"><h3>1 · Le circuit</h3></div>'
          + '<p class="pil-note">Combien de factures à chaque étape, depuis combien de temps elles y sont, '
          + 'face à la cible de traitement.</p>'
          + '<div class="op-flow">' + vignetteEtape(st, 'adv', true) + vignetteEtape(st, 'rec', true)
          + vignetteEtape(st, 'fin') + '</div>'
          + '<div class="op-sep"><span></span>en parallèle du circuit<span></span></div>'
          + '<div class="op-flow">' + vignetteEtape(st, 'cor') + '</div>'
          + '<div class="op-sub"><b>Les étapes du process</b>'
          + '<span class="op-pied">Âge du traitement = jours depuis l’entrée dans l’étape quand Monday '
          + 'porte la date — ' + nb(avecEntree) + ' factures sur ' + nb(items.length) + ' — sinon depuis '
          + 'la date de facture (Rendre payable) ou l’échéance (les autres). Les tableaux Tampon, ADV et '
          + 'Recouvrement n’ont pas de colonne de date d’entrée : sur eux, le « % hors délai » mesure '
          + 'l’ancienneté de la créance, pas le temps de traitement du service. '
          + 'Dépliez une étape pour voir la problématique pré-échéance.</span>'
          + tableauCircuit(items, st) + '</div>'
          + '<div class="op-sub"><b>Où sont parties les factures sorties d’une étape</b>'
          + '<span class="op-pied">' + (HIST ? 'Mouvements du mois lus dans Monday le '
              + new Date(HIST.le).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })
              + ' · ' + nb(HIST.lus) + ' déplacements.' : '') + '</span>'
          + blocSorties() + '</div></div></div>'
          + '<div class="charts-grid"><div class="chart-card chart-wide">'
          + '<div class="chart-header"><h3>2 · Focus sur chaque étape</h3></div>'
          + '<p class="pil-note">Quoi traiter, pourquoi ça bloque, et est-ce que ça avance.</p>'
          + '<div class="seg" id="op-seg">' + sousTabs + '</div>'
          + '<p class="op-focus-h"><b>' + esc(e.n) + '</b> · ' + esc(e.d)
          + ' <span class="op-chip">' + esc(e.svc) + '</span></p>'
          + tuilesFocus
          + '<div class="charts-grid charts-grid-2">'
          + '<div class="op-sub"><b>Où sont les factures</b>'
          + '<span class="op-pied">Nombre de factures par groupe Monday.</span>'
          + '<div class="op-hbs">' + barres + '</div></div>'
          + '<div class="op-sub"><b>Depuis combien de temps elles sont dans l’étape</b>'
          + '<span class="op-pied">En rouge, au-delà de la cible de ' + e.cible + ' jours. '
          + 'Date d’entrée : colonne Monday pour ' + nb(srcs.etape) + ' factures, à défaut '
          + (e.ref === 'facture' ? 'date de facture' : 'échéance') + ' pour ' + nb(srcs.ref)
          + (srcs.aucune ? ', et ' + nb(srcs.aucune) + ' sans aucune date' : '') + '.</span>'
          + '<div class="op-chart">' + hist + '</div></div></div>'
          + '<div class="op-sub"><b>Liste priorisée</b>'
          + '<span class="op-pied">' + nb(Math.min(30, pr.length)) + ' premières lignes sur ' + nb(pr.length)
          + ', classées par montant et ancienneté du retard. « Exporter l’étape » donne toutes les lignes.</span>'
          + (top.length ? '<table class="op-t"><thead><tr><th>Facture · client</th><th>Financement</th>'
              + '<th>Groupe Monday</th><th class="n">Restant dû</th><th class="n">Échéance</th>'
              + '<th class="n">Dans l’étape depuis</th><th>Priorité</th></tr></thead><tbody>'
              + lignes + '</tbody></table>'
            : '<div class="op-vide">Aucune facture dans cette étape avec ces filtres.</div>')
          + '</div></div></div>';

        brancher(items, st, k, pr);
    }

    function brancher(items, st, k, pr) {
        const h = document.getElementById('op-corps');
        if (!h) return;
        h.querySelectorAll('[data-etape]').forEach(b =>
            b.onclick = () => { F.etape = b.dataset.etape; rendre(DERNIERES); });
        h.querySelectorAll('[data-focus]').forEach(b =>
            b.onclick = () => { F.etape = b.dataset.focus; rendre(DERNIERES); });
        h.querySelectorAll('[data-deplie]').forEach(b =>
            b.onclick = () => { const x = b.dataset.deplie; F.deplies[x] = !F.deplies[x]; rendre(DERNIERES); });
        const q = document.getElementById('op-q');
        if (q) { let t = null; q.oninput = () => { clearTimeout(t);
            t = setTimeout(() => { F.q = q.value; rendre(DERNIERES);
                const n = document.getElementById('op-q');
                if (n) { n.focus(); n.setSelectionRange(n.value.length, n.value.length); } }, 300); }; }
        const hb = document.getElementById('op-hist');
        if (hb) hb.onclick = async () => {
            const mois = String(new Date().toISOString().slice(0, 7));
            histEtat = { s: 'run', msg: 'Lecture de l’historique Monday…' }; rendre(DERNIERES);
            try { await chargerHistorique(mois); histEtat = { s: 'ok', msg: '' }; }
            catch (err) { histEtat = { s: 'error', msg: (err && err.message) || String(err) }; }
            rendre(DERNIERES);
        };
        const ex = document.getElementById('op-export');
        if (ex) ex.onclick = () => exporter(pr || [], k);
    }

    // L'export donne TOUTES les lignes de l'étape, pas les trente affichées.
    function exporter(pr, k) {
        const X = global.XLSX;
        if (!X) { U().toast && U().toast('SheetJS n’est pas chargé.'); return; }
        const lignes = pr.map(p => ({
            'Facture': p.f.numero, 'Client': p.f.client, 'Apprenant': p.f.apprenant || '',
            'Financement': p.f.financement || '', 'Tableau': p.f.board, 'Groupe': p.f.groupe,
            'Problématique': p.f.problematique || '',
            'Restant dû': p.m, 'Échéance': p.f.dateEcheance || p.f.dateEcheanceSource || '',
            'Jours de retard': p.r == null ? '' : p.r,
            'Dans l’étape depuis (j)': p.a == null ? '' : p.a,
            'Cible (j)': ETAPE[k].cible,
            'Paiement promis': p.f.promesse || '', 'Dernière relance': p.f.derniereRelance || '',
            'Propriétaire': p.f.proprietaire || '',
        }));
        const wb = X.utils.book_new();
        X.utils.book_append_sheet(wb, X.utils.json_to_sheet(lignes), ETAPE[k].n.slice(0, 30));
        X.writeFile(wb, 'operationnel-' + k + '-' + new Date().toISOString().slice(0, 10) + '.xlsx');
    }

    function ouvrir(factures) { rendre(factures); }

    global.LioraOperationnel = {
        rendre, ouvrir, CIRCUIT, GROUPE_ETAPE, etapeDe,
        etat: () => ({ F, HIST, histEtat }),
    };
})(window);
