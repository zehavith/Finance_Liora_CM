/* ══════════════════════════════════════════════════════════════════════
   SUIVI RECOUV — VERSION 3 — L'ONGLET « RÈGLES D'APPLICATION »
   ══════════════════════════════════════════════════════════════════════

   « Dans la partie Contrôles, une catégorie "Règles d'application" : toutes
   les règles — classement de la balance âgée, échéances de la balance âgée,
   classement dans les vignettes Sous contrôle, Rendre payable…, échéances de
   la partie opérationnelle. Elles doivent pouvoir être modifiées à la main,
   et se dérouler : le titre de la règle, puis la flèche pour voir le détail. »

   Chaque règle est un bloc replié : son titre, ce qu'elle vaut en une ligne,
   et son détail derrière la flèche. Ce qui se modifie ici :
     · les échéances par financement (suivi Monday et opérationnel) ;
     · les échéances de la balance âgée d'après le grand livre ;
     · le seuil des créances compromises ;
     · l'étape de chaque groupe Monday, les délais cibles, la vignette
       « Sous contrôle » ;
     · les mots qui désignent un groupe technique.

   Les modifications sont gardées dans ce navigateur et s'appliquent aux
   calculs de cette page. Elles ne changent rien dans Monday, et pas
   davantage le relevé comptable de l'onglet Pilotage, calculé en amont.
   ══════════════════════════════════════════════════════════════════════ */
(function (G) {
    'use strict';

    var S = G.LioraStore, R = G.LioraRules, OP = G.LioraOperationnel;
    var CLE = 'rec_v3_regles';
    var REG = { groupes: {}, cibles: {}, controle: {}, exclus: null, tranches: null };
    var EXCLUS_ORIGINE = (R && R.GROUPES_EXCLUS) ? R.GROUPES_EXCLUS.slice() : [];

    // ── Les tranches d'ancienneté ──
    //
    // Les bornes se choisissent sur la grille du relevé comptable (3, 4, 6,
    // 12, 18, 24, 36, 48 mois) : c'est la seule façon que la page et le
    // Pilotage découpent au même endroit. La borne des 12 mois reste
    // toujours posée — « plus d'un an » et les créances compromises s'y lisent.
    var GRILLE = [3, 4, 6, 12, 18, 24, 36, 48];
    var TRANCHES_ORIGINE = (R && R.AGING_BUCKETS) ? R.AGING_BUCKETS.map(function (b) { return Object.assign({}, b); }) : [];
    var CLES_PLUS_DUN_AN = ['m12_18', 'm18_24', 'm24_36', 'm36_48', 'm48p'];
    var TEINTES_TRANCHES = ['#1D7F55', '#a3c714', '#A8750B', '#A86A06', '#C2410C', '#D9532E', '#B8352A', '#B8352A', '#8E2A21'];
    function coupesRetenues() {
        var c = (REG.tranches || GRILLE).map(Number).filter(function (x) { return GRILLE.indexOf(x) >= 0; });
        if (c.indexOf(12) < 0) c.push(12);
        return c.sort(function (a, b) { return a - b; });
    }
    function tranchesDepuis(coupes) {
        var bornes = [0].concat(coupes).concat([Infinity]), n = bornes.length - 1, vieux = 0;
        var out = [Object.assign({}, TRANCHES_ORIGINE[0])];          // « Non échu », inchangé
        for (var i = 0; i < n; i++) {
            var lo = bornes[i], hi = bornes[i + 1];
            out.push({
                // Au-delà de douze mois, les noms internes d'origine sont repris :
                // la synthèse « plus d'un an » de la balance les cherche par ce nom.
                key: lo >= 12 ? CLES_PLUS_DUN_AN[vieux++] : (hi === Infinity ? 'm' + lo + 'p' : 'm' + lo + '_' + hi),
                label: hi === Infinity ? '> ' + lo + ' mois' : lo + ' à ' + hi + ' mois',
                min: lo * 30 + 1, max: hi === Infinity ? 1e9 : hi * 30,
                couleur: TEINTES_TRANCHES[Math.round(n > 1 ? i * (TEINTES_TRANCHES.length - 1) / (n - 1) : 0)],
            });
        }
        return out;
    }
    function appliquerTranches() {
        if (!R || !R.AGING_BUCKETS) return;
        var l = R.AGING_BUCKETS, nouvelles = REG.tranches ? tranchesDepuis(coupesRetenues()) : TRANCHES_ORIGINE;
        l.length = 0;
        nouvelles.forEach(function (b) { l.push(Object.assign({}, b)); });
        if (G.LioraPilotage && G.LioraPilotage.definirTranches) {
            G.LioraPilotage.definirTranches(REG.tranches ? coupesRetenues() : null);
        }
    }
    var OUVERTS = {};
    var etat = function () { return G.__recouvrement; };
    var hote = function () { return document.getElementById('v3-regles-corps'); };

    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }
    function dire(t, g) { var U = G.LioraUI; if (U && U.toast) U.toast(t, g || 'success', 5000); }

    // ── Les réglages gardés : relus avant que l'application ne démarre ──
    function appliquer() {
        if (OP && OP.appliquerReglages) OP.appliquerReglages(REG);
        if (R && R.GROUPES_EXCLUS) {
            var l = R.GROUPES_EXCLUS;
            l.length = 0;
            (REG.exclus && REG.exclus.length ? REG.exclus : EXCLUS_ORIGINE).forEach(function (m) { l.push(m); });
        }
        appliquerTranches();
    }
    var pret = (async function () {
        try {
            var r = S ? await S.get(CLE, null) : null;
            if (r && typeof r === 'object') {
                REG.groupes = r.groupes || {}; REG.cibles = r.cibles || {};
                REG.controle = r.controle || {}; REG.exclus = r.exclus || null;
                REG.tranches = Array.isArray(r.tranches) && r.tranches.length ? r.tranches : null;
            }
        } catch (e) { /* les règles d'origine s'appliquent */ }
        appliquer();
    })();
    function garder() { try { return S.set(CLE, REG); } catch (e) { return Promise.resolve(false); } }

    function recalculer() {
        var champ = document.getElementById('date-ref');
        if (champ) champ.dispatchEvent(new Event('change', { bubbles: true }));
    }

    // ══════════════════════════════════════════════
    //  Les échéances
    // ══════════════════════════════════════════════
    var BASES = { dateFacture: 'Date de facture', dateFinFormation: 'Fin de formation',
                  dateDebutFormation: 'Début de formation' };
    var BASES_GL = { dateFacture: 'Date de facture (écriture comptable)',
                     dateFactureFacturation: 'Date de facture (facturation)',
                     dateFinFormation: 'Fin de formation', dateDebutFormation: 'Début de formation' };

    function phrase(r) {
        var base = BASES[r.base] || r.base || '';
        var t = base + (r.jours ? ' +' + r.jours + ' jours' : '');
        if (r.plafondDebutFormation) {
            var j = r.fallbackJours != null ? r.fallbackJours : r.jours;
            t += ', sans dépasser début de formation' + (j ? ' +' + j + ' jours' : '');
        }
        return t;
    }
    function phraseGL(r) {
        var g = r.gl || r;
        return (BASES_GL[g.base] || g.base || '') + (g.jours ? ' +' + g.jours + ' jours' : '');
    }
    function origine(cle) {
        return (R.DEFAULT_ECHEANCE_RULES || []).find(function (x) { return x.key === cle; }) || null;
    }
    function memeRegle(a, b) {
        if (!a || !b) return false;
        return a.base === b.base && (+a.jours || 0) === (+b.jours || 0)
            && (a.fallback || '') === (b.fallback || '')
            && (a.fallbackJours == null ? null : +a.fallbackJours) === (b.fallbackJours == null ? null : +b.fallbackJours)
            && !!a.plafondDebutFormation === !!b.plafondDebutFormation;
    }
    function memeGL(a, b) {
        var x = (a && (a.gl || a)) || {}, y = (b && (b.gl || b)) || {};
        return x.base === y.base && (+x.jours || 0) === (+y.jours || 0);
    }
    var options = function (liste, valeur, vide) {
        return (vide ? '<option value="">' + esc(vide) + '</option>' : '')
            + Object.keys(liste).map(function (k) {
                return '<option value="' + k + '"' + (valeur === k ? ' selected' : '') + '>' + esc(liste[k]) + '</option>';
            }).join('');
    };

    function blocEcheances(st) {
        var regles = st.rules || [];
        var modif = regles.filter(function (r) { return !memeRegle(r, origine(r.key)); }).length;
        var lignes = regles.map(function (r, i) {
            var m = !memeRegle(r, origine(r.key));
            return '<tr><td><b>' + esc(r.label || r.key) + '</b>'
                + (m ? ' <span class="op-chip moyen">modifiée</span>' : '')
                + '<br><span class="op-pied">' + esc(phrase(r)) + '</span></td>'
                + '<td><select class="input input-sm" id="re-b-' + i + '" data-ech="' + i + '" data-k="base" aria-label="Date de départ">'
                + options(BASES, r.base) + '</select></td>'
                + '<td><input class="input input-sm input-num" type="number" min="0" id="re-j-' + i + '" data-ech="' + i
                + '" data-k="jours" value="' + (+r.jours || 0) + '" aria-label="Jours ajoutés"></td>'
                + '<td><select class="input input-sm" id="re-f-' + i + '" data-ech="' + i + '" data-k="fallback" aria-label="Date de repli">'
                + options(BASES, r.fallback || '', '— aucun —') + '</select></td>'
                + '<td><input class="input input-sm input-num" type="number" min="0" id="re-fj-' + i + '" data-ech="' + i
                + '" data-k="fallbackJours" value="' + (r.fallbackJours != null ? +r.fallbackJours : (+r.jours || 0))
                + '" aria-label="Jours du repli"></td>'
                + '<td class="n"><input type="checkbox" id="re-p-' + i + '" data-ech="' + i + '" data-k="plafondDebutFormation"'
                + (r.plafondDebutFormation ? ' checked' : '') + ' aria-label="Plafonner au début de formation"></td></tr>';
        }).join('');
        return bloc('echeances', 'Échéances — suivi Monday et opérationnel',
            regles.length + ' financements' + (modif ? ' · ' + modif + ' modifiée' + (modif > 1 ? 's' : '') : ' · règles d’origine'),
            'modifiable',
            '<p class="v3-regle-dit">L’échéance d’une facture se calcule en ajoutant un nombre de jours à une date. '
            + 'Elle sert partout où l’application lit Monday : tableau de bord, opérationnel (retard, « Sous contrôle »), '
            + 'balance âgée d’après Monday. Le <b>repli</b> est la date prise quand la première manque. '
            + 'Le <b>plafond</b> empêche l’échéance de dépasser le début de formation augmenté des jours du repli.</p>'
            + '<div class="table-wrap"><table class="op-t v3-regles-t"><thead><tr><th>Financement</th><th>Date de départ</th>'
            + '<th>+ jours</th><th>Repli</th><th>+ jours</th><th class="n">Plafond</th></tr></thead><tbody>' + lignes
            + '</tbody></table></div>'
            + '<p><button type="button" class="btn btn-ghost btn-sm" data-action="raz-echeances">Rétablir les règles d’origine</button></p>');
    }

    function blocEcheancesGL(st) {
        var regles = st.rules || [];
        var modif = regles.filter(function (r) { return !memeGL(r, origine(r.key)); }).length;
        var lignes = regles.map(function (r, i) {
            var g = r.gl || { base: r.base, jours: r.jours };
            return '<tr><td><b>' + esc(r.label || r.key) + '</b>'
                + (!memeGL(r, origine(r.key)) ? ' <span class="op-chip moyen">modifiée</span>' : '')
                + '<br><span class="op-pied">' + esc(phraseGL(r)) + '</span></td>'
                + '<td><select class="input input-sm" id="rg-b-' + i + '" data-gl="' + i + '" data-k="base" aria-label="Date de départ">'
                + options(BASES_GL, g.base) + '</select></td>'
                + '<td><input class="input input-sm input-num" type="number" min="0" id="rg-j-' + i + '" data-gl="' + i
                + '" data-k="jours" value="' + (+g.jours || 0) + '" aria-label="Jours ajoutés"></td></tr>';
        }).join('');
        return bloc('echeances-gl', 'Échéances — balance âgée d’après le grand livre et Pilotage',
            regles.length + ' financements' + (modif ? ' · ' + modif + ' modifiée' + (modif > 1 ? 's' : '') : ' · règles d’origine'),
            'modifiable',
            '<p class="v3-regle-dit">La balance âgée comptable (onglet Balance âgée → « D’après le grand livre ») date ses '
            + 'créances avec sa propre règle, qui peut différer de celle du suivi Monday : l’une mesure le travail de '
            + 'relance, l’autre le solde du compte. <b>Modifier ici la date de départ ou le délai d’un financement '
            + 'recalcule l’onglet Pilotage</b> : ses créances sont redatées puis reclassées par tranche, et l’échu, le non '
            + 'échu et le taux d’échu de ce financement sont refaits. Une créance datée par une exception (facture émise '
            + 'après la fin de formation, mandat de prélèvement) garde son échéance, et les arrêtés antérieurs au '
            + '30/06/2026 gardent les délais d’origine, leur détail n’étant pas disponible.</p>'
            + '<div class="table-wrap"><table class="op-t v3-regles-t"><thead><tr><th>Financement</th><th>Date de départ</th>'
            + '<th>+ jours</th></tr></thead><tbody>' + lignes + '</tbody></table></div>'
            + '<p><button type="button" class="btn btn-ghost btn-sm" data-action="raz-echeances">Rétablir les règles d’origine</button></p>');
    }

    // ══════════════════════════════════════════════
    //  La balance âgée
    // ══════════════════════════════════════════════
    function blocTranches(st) {
        var seuil = (st.options && st.options.seuilBadDebtJours) || 360;
        var lignes = (R.AGING_BUCKETS || []).map(function (b) {
            return '<tr><td>' + esc(b.label) + '</td><td class="n">'
                + (b.max <= 0 ? 'échéance pas encore passée'
                    : b.max >= 1e8 ? 'plus de ' + (b.min - 1) + ' jours de retard'
                    : 'de ' + b.min + ' à ' + b.max + ' jours de retard') + '</td></tr>';
        }).join('');
        var seuils = { 180: '6 mois (180 jours)', 360: '12 mois (360 jours)', 540: '18 mois (540 jours)', 720: '24 mois (720 jours)' };
        var coupes = coupesRetenues();
        var cases = GRILLE.map(function (m) {
            var oui = coupes.indexOf(m) >= 0, fixe = m === 12;
            return '<label class="check v3-coupe" for="rt-' + m + '"><input type="checkbox" id="rt-' + m + '" data-coupe="' + m + '"'
                + (oui ? ' checked' : '') + (fixe ? ' disabled' : '') + '> ' + m + ' mois'
                + (fixe ? ' <span class="op-pied">(toujours posée)</span>' : '') + '</label>';
        }).join('');
        return bloc('tranches', 'Balance âgée — tranches d’ancienneté et créances compromises',
            ((R.AGING_BUCKETS || []).length - 1) + ' tranches échues' + (REG.tranches ? ' · découpage modifié' : ' · découpage d’origine')
            + ' · compromise au-delà de ' + seuil + ' jours',
            'modifiable',
            '<p class="v3-regle-dit">Le reste dû est rangé selon le temps écoulé depuis l’échéance. '
            + '<b>Cochez les seuils où une tranche se termine</b> : décocher « 4 mois » réunit « 3 à 4 mois » et '
            + '« 4 à 6 mois » en une seule tranche « 3 à 6 mois ». Les seuils proposés sont ceux auxquels la comptabilité '
            + 'découpe l’encours ; c’est ce qui permet au Pilotage de suivre exactement le même découpage.</p>'
            + '<div class="v3-coupes">' + cases + '</div>'
            + '<div class="table-wrap"><table class="op-t"><thead><tr><th>Tranche obtenue</th><th class="n">Retard</th></tr></thead><tbody>'
            + lignes + '</tbody></table></div>'
            + (REG.tranches ? '<p><button type="button" class="btn btn-ghost btn-sm" data-action="raz-tranches">Rétablir le découpage d’origine</button></p>' : '')
            + '<p class="v3-regle-ligne"><label for="rs-seuil">Une créance est dite <b>compromise</b> (bad debt) au-delà de</label> '
            + '<select class="input input-sm" id="rs-seuil" data-action="seuil">' + options(seuils, String(seuil)) + '</select></p>');
    }

    function blocClassement(st) {
        var regles = st.reglesClassement || [];
        var corps = regles.length
            ? '<div class="table-wrap"><table class="op-t"><thead><tr><th>Champ lu</th><th>Condition</th><th>Texte</th>'
              + '<th>Financement attribué</th></tr></thead><tbody>'
              + regles.map(function (x) {
                  return '<tr><td>' + esc(x.champ || '') + '</td><td>' + esc(x.op || '') + '</td><td>'
                      + esc(x.valeur != null ? x.valeur : (x.val || '')) + '</td><td>'
                      + esc((R.getRule && x.fin ? R.getRule(x.fin, st.rules).label : x.fin) || '') + '</td></tr>';
              }).join('') + '</tbody></table></div>'
            : '<p class="op-vide">Aucune règle de classement n’est écrite pour l’instant.</p>';
        return bloc('classement', 'Balance âgée — classement des créances par financement',
            regles.length ? regles.length + ' règle' + (regles.length > 1 ? 's' : '') + ' écrite' + (regles.length > 1 ? 's' : '')
                          : 'aucune règle écrite',
            'modifiable dans Balance âgée',
            '<p class="v3-regle-dit">Le grand livre ne connaît pas les dispositifs. Chaque créance reçoit son financement '
            + 'dans cet ordre : la facture Monday du même numéro, puis une qualification déjà validée, puis vos règles '
            + '(« le nom du client contient ALMA → Financement personnel »), la première qui répond l’emportant. '
            + 'Ce qui n’est pas sûr part dans « À classer » : rien n’est deviné.</p>' + corps
            + '<p><button type="button" class="btn btn-ghost btn-sm" data-action="vers-aging">Ajouter ou modifier ces règles '
            + 'dans l’onglet Balance âgée</button> <span class="op-pied">Elles s’écrivent là-bas, sous la balance '
            + '« D’après le grand livre », une fois un grand livre chargé.</span></p>');
    }

    function blocSources() {
        var b = (G.LioraV3 && G.LioraV3.bilan && G.LioraV3.bilan()) || {}, gl = (G.LioraV3 && G.LioraV3.grandLivre && G.LioraV3.grandLivre()) || null;
        var jour = gl ? String(gl.arrete || '').split('-').reverse().join('/') : '';
        return bloc('sources', 'Quelle source fait foi : grand livre, Monday, ancienne facture, Sellsy', '6 priorités', 'lecture seule',
            '<dl class="v3-lexique">'
            + '<div><dt>Date de paiement</dt><dd>La date du grand livre passe toujours en premier. À défaut, la date de paiement de Monday ; '
            + 'en dernier recours la date de « contrôle paiement » (signalée comme estimée).'
            + (gl ? ' Grand livre utilisé : celui de la balance âgée, arrêté au ' + jour + '.' : '') + '</dd></div>'
            + '<div><dt>Paiement CPF</dt><dd>Pour le CPF, l’export EDOF fait foi : une facture « Versé » dans EDOF est payée, à la date de règlement EDOF, '
            + 'avant le grand livre et avant Monday.' + (b.edof ? ' ' + b.edof + ' facture(s) concernée(s) aujourd’hui.' : '') + '</dd></div>'
            + '<div><dt>Montant manquant</dt><dd>Complété par le grand livre, puis par l’export Sellsy, puis par le fichier du financeur '
            + '(Filiz…) quand il porte un montant — par numéro de facture, ou par numéro de dossier s’il n’y a qu’un montant pour ce dossier.</dd></div>'
            + '<div><dt>Facture refaite</dt><dd>Quand la colonne « Ancienne facture » de Monday donne le numéro d’origine, l’échéance se calcule '
            + 'sur la date de la facture d’origine : refaire une facture ne repousse pas ce qui est dû.'
            + (b.anciennes ? ' ' + b.anciennes + ' facture(s) concernée(s) aujourd’hui.' : '') + '</dd></div>'
            + '<div><dt>Facture saisie deux fois</dt><dd>Une facture présente sur plusieurs lignes ou plusieurs tableaux n’est comptée qu’une seule fois.</dd></div>'
            + '<div><dt>Factures Sellsy absentes de Monday</dt><dd>Quand elles sont incluses, les lignes au montant négatif (avoirs) ou supérieur à '
            + '500 000 € (erreur de saisie) sont écartées.'
            + ((b.sellsyEcartees || []).length ? ' ' + b.sellsyEcartees.length + ' ligne(s) écartée(s) aujourd’hui.' : '') + '</dd></div>'
            + '</dl>');
    }

    function blocEtats() {
        return bloc('etats', 'Réglée, en retard, annulée : comment une facture est qualifiée', '5 états', 'lecture seule',
            '<dl class="v3-lexique">'
            + '<div><dt>Réglée</dt><dd>La facture figure dans le tableau Monday des factures payées, ou porte une date de '
            + 'paiement, ou le grand livre la solde par un règlement.</dd></div>'
            + '<div><dt>En retard (en recouvrement)</dt><dd>Non réglée, et son échéance calculée est dépassée à la date d’arrêté.</dd></div>'
            + '<div><dt>Non échue</dt><dd>Non réglée, et son échéance calculée n’est pas encore passée.</dd></div>'
            + '<div><dt>Échéance inconnue</dt><dd>Une date manque pour calculer l’échéance : la facture sort des taux. '
            + 'La date peut être complétée depuis l’onglet Opérationnel.</dd></div>'
            + '<div><dt>Annulée par avoir</dt><dd>Soldée au grand livre par un avoir et non par un paiement : exclue des '
            + 'chiffres par défaut (filtre « Factures annulées par avoir »).</dd></div>'
            + '</dl><p class="op-pied">Ces définitions sont celles du moteur de calcul ; elles ne se règlent pas ici.</p>');
    }

    // ══════════════════════════════════════════════
    //  Le circuit de l'onglet Opérationnel
    // ══════════════════════════════════════════════
    var CATEGORIES = function () {
        var o = {};
        (OP.CIRCUIT || []).forEach(function (e) { o[e.k] = e.n + ' (' + e.svc + ')'; });
        o.cours = 'Sous contrôle (groupe « en cours »)';
        o.aucune = 'Non classé';
        return o;
    };

    var VOIR = {};
    function blocGroupes() {
        var cats = CATEGORIES();
        var nbModif = Object.keys(REG.groupes || {}).length;
        // Les factures non réglées de chaque groupe : le nombre s'ouvre sur ses factures.
        var st0 = etat() || {};
        var ouvertes = OP.ouvertesParGroupe ? OP.ouvertesParGroupe(st0.factures || []) : {};
        VOIR = {};
        var vus = {}, totalOuvert = 0;
        var compte = function (tableau, g) {
            var k = OP.cleGroupe(tableau, g), o = ouvertes[k];
            vus[k] = true;
            if (!o || !o.its.length) return '<td class="n">0</td>';
            totalOuvert += o.its.length;
            VOIR[k] = { titre: g, its: o.its, note: 'Factures non réglées du groupe Monday « ' + g + ' », tableau « ' + tableau + ' ».' };
            var montant = o.its.reduce(function (t, f) { return t + (Number(f.encours != null ? f.encours : f.montant) || 0); }, 0);
            return '<td class="n"><button type="button" class="op-lien" data-voir-groupe="' + esc(k) + '" title="Voir ces factures">'
                + o.its.length.toLocaleString('fr-FR') + '</button><br><span class="op-pied">'
                + Math.round(montant).toLocaleString('fr-FR') + ' €</span></td>';
        };
        var ligne = function (tableau, g, id) {
            var cle = OP.cleTitre(g);
            if (OP.estTechnique(g)) {
                return '<tr><td>' + esc(g) + '</td><td><span class="op-chip">Technique / archive</span> '
                    + '<span class="op-pied">écarté par les mots de la règle « Groupes écartés »</span></td>' + compte(tableau, g) + '</tr>';
            }
            var v = OP.categorieDuGroupe(g) || 'aucune';
            return '<tr><td><label for="' + id + '">' + esc(g) + '</label>'
                + (REG.groupes[cle] ? ' <span class="op-chip moyen">modifié</span>'
                    : OP.estPropose(g) ? ' <span class="op-chip moyen" title="Groupe classé par analogie par la '
                      + 'version 3 : à confirmer.">à vérifier</span>' : '') + '</td>'
                + '<td><select class="input input-sm" id="' + id + '" data-groupe="' + esc(cle) + '">'
                + options(cats, v) + '</select></td>' + compte(tableau, g) + '</tr>';
        };
        var corps = (OP.referentiel || []).map(function (t) {
            var base = 'rgp-' + OP.cleTitre(t[0]).replace(/[^a-z0-9]+/g, '-') + '-';
            var h = '<tr class="op-sous-tableau op-corr-tableau"><td colspan="3">' + esc(t[0]) + '</td></tr>'
                + t[1].map(function (g, i) { return ligne(t[0], g, base + i); }).join('');
            // Les groupes que Monday porte en plus de la liste connue, pour ce tableau.
            var prefixe = OP.cleGroupe(t[0], '').split('|')[0], n = 0;
            Object.keys(ouvertes).forEach(function (k) {
                if (vus[k] || k.split('|')[0] !== prefixe) return;
                h += ligne(t[0], ouvertes[k].groupe, base + 'x' + (n++));
            });
            return h;
        }).join('');
        var restes = Object.keys(ouvertes).filter(function (k) { return !vus[k]; });
        if (restes.length) corps += '<tr class="op-sous-tableau op-corr-tableau"><td colspan="3">Autres tableaux</td></tr>'
            + restes.map(function (k, i) { return ligne(ouvertes[k].tableau, ouvertes[k].groupe, 'rgp-autres-' + i); }).join('');
        return bloc('groupes', 'Circuit — dans quelle vignette compte chaque groupe Monday',
            nbModif ? nbModif + ' groupe' + (nbModif > 1 ? 's' : '') + ' reclassé' + (nbModif > 1 ? 's' : '') + ' à la main'
                    : 'classement d’origine',
            'modifiable',
            '<p class="v3-regle-dit">Une facture non réglée compte dans la vignette de l’étape où son groupe Monday est '
            + 'rangé : Rendre payable, Relancer, Clôture ou Corriger. Un groupe « Sous contrôle » n’est dans aucune étape : '
            + 'ses factures comptent dans la vignette « Sous contrôle » tant que leur échéance n’est pas passée. Une fois '
            + 'l’échéance passée, si la facture est restée dans ce groupe, elle sort de la vignette et apparaît dans '
            + 'l’alerte « échues encore dans un groupe en cours ».</p>'
            + '<p class="v3-regle-dit">La colonne « Factures non réglées » compte toutes les factures Monday non réglées du groupe, '
            + 'sans filtre de période (' + totalOuvert.toLocaleString('fr-FR') + ' au total). Cliquez un nombre pour voir les factures.</p>'
            + '<div class="table-wrap"><table class="op-t op-corr"><thead><tr><th>Groupe Monday</th><th>Compte dans</th><th class="n">Factures non réglées</th></tr></thead>'
            + '<tbody>' + corps + '</tbody></table></div>'
            + '<p><button type="button" class="btn btn-ghost btn-sm" data-action="raz-groupes">Rétablir le classement d’origine</button></p>');
    }

    function blocCibles() {
        var modif = Object.keys(REG.cibles || {}).length;
        return bloc('cibles', 'Circuit — délai cible de chaque étape',
            (OP.CIRCUIT || []).map(function (e) { return e.n + ' ' + e.cible + ' j'; }).join(' · '),
            'modifiable',
            '<p class="v3-regle-dit">Au-delà de ce nombre de jours dans l’étape, une facture est comptée « hors délai ». '
            + 'L’âge se compte depuis l’entrée dans l’étape quand Monday porte la date, sinon depuis la date de facture '
            + '(Rendre payable) ou l’échéance (les autres).</p>'
            + '<div class="v3-regle-grille">' + (OP.CIRCUIT || []).map(function (e) {
                return '<label for="rc-' + e.k + '">' + esc(e.n) + ' <span class="op-pied">' + esc(e.svc) + '</span>'
                    + '<span class="v3-regle-saisie"><input class="input input-sm input-num" type="number" min="1" id="rc-'
                    + e.k + '" data-cible="' + e.k + '" value="' + e.cible + '"> jours</span></label>';
            }).join('') + '</div>'
            + (modif ? '<p><button type="button" class="btn btn-ghost btn-sm" data-action="raz-cibles">Rétablir les délais d’origine</button></p>' : ''));
    }

    function blocControle() {
        var c = OP.CONTROLE || {};
        return bloc('controle', 'Circuit — vignette « Sous contrôle »',
            'avant échéance' + (c.horsEtapes ? ', hors étapes du circuit' : ', étapes comprises')
            + ' · alerte à ' + c.proche + ' jours',
            'modifiable',
            '<p class="v3-regle-dit">« Sous contrôle » réunit les factures non réglées dont l’échéance calculée n’est pas '
            + 'encore passée. Une facture déjà rangée dans une étape — à rendre payable, en recouvrement, en clôture, à '
            + 'corriger — est suivie par cette étape : elle n’est pas sous contrôle.</p>'
            + '<p class="v3-regle-ligne"><label class="check" for="rk-hors"><input type="checkbox" id="rk-hors" data-action="hors"'
            + (c.horsEtapes ? ' checked' : '') + '> Écarter de « Sous contrôle » les factures déjà dans une étape du circuit</label></p>'
            + '<p class="v3-regle-ligne"><label for="rk-proche">Signaler une échéance qui tombe dans les</label> '
            + '<input class="input input-sm input-num" type="number" min="1" id="rk-proche" data-action="proche" value="'
            + c.proche + '"> prochains jours</p>');
    }

    function blocCpf() {
        var payable = +(REG.controle && REG.controle.cpfPayable) > 0 ? +REG.controle.cpfPayable : 45;
        var st = etat() || {}, r = (st.rules || []).filter(function (x) { return x.key === 'CPF'; })[0] || {};
        var reco = r.jours != null ? r.jours : 60;
        return bloc('cpf', 'Circuit CPF — à quelle date une facture change d’étape',
            'Rendre payable à fin de formation + ' + payable + ' j · recouvrement à + ' + reco + ' j', 'modifiable',
            '<p class="v3-regle-dit">Pour le CPF, l’étape attendue se déduit de la date de fin de formation. Avant le premier seuil, la facture est '
            + '« Sous contrôle » ; entre les deux, elle doit être dans « Rendre payable » ; après le second, en recouvrement (« Relancer »). '
            + 'L’onglet Opérationnel compare cette étape attendue au groupe Monday où se trouve la facture, et range les écarts dans « Facturation à revérifier ».</p>'
            + '<p class="v3-regle-ligne"><label for="rk-cpf-payable">« Rendre payable » commence à fin de formation +</label> '
            + '<input class="input input-sm input-num" type="number" min="0" id="rk-cpf-payable" data-action="cpf-payable" value="' + payable + '"> jours</p>'
            + '<p class="v3-regle-ligne">Le recouvrement commence à fin de formation + <b>' + reco + ' jours</b> : c’est l’échéance CPF, '
            + 'qui se règle dans la règle « Échéances — suivi Monday et opérationnel », en haut de cette page.</p>');
    }

    function blocExclus() {
        var mots = (R.GROUPES_EXCLUS || []).slice();
        return bloc('exclus', 'Groupes écartés — techniques, archives, corbeilles',
            mots.length + ' mots' + (REG.exclus ? ' · liste modifiée' : ''),
            'modifiable',
            '<p class="v3-regle-dit">Un groupe Monday dont le titre contient l’un de ces mots est un groupe de service : '
            + 'ses factures sont hors du portefeuille et ne sont pas lues lors d’une actualisation depuis Monday. '
            + 'Écrivez les mots en minuscules, sans accent, séparés par des virgules.</p>'
            + '<p class="v3-regle-ligne"><label for="rx-mots" class="op-pied">Mots qui désignent un groupe écarté</label>'
            + '<textarea class="input v3-regle-texte" id="rx-mots" data-action="exclus" rows="2">' + esc(mots.join(', ')) + '</textarea></p>'
            + '<p><button type="button" class="btn btn-ghost btn-sm" data-action="raz-exclus">Rétablir la liste d’origine</button></p>');
    }

    // ══════════════════════════════════════════════
    //  Le bloc replié, et la page
    // ══════════════════════════════════════════════
    // Les pages que chaque règle modifie — et celles qu'elle ne modifie pas.
    var PORTEES = {
        echeances: ['Tableau de bord, Opérationnel, Balance âgée d’après Monday, Financements, Factures',
                    'le Pilotage : il suit la règle « balance âgée d’après le grand livre et Pilotage », juste en dessous'],
        'echeances-gl': ['Pilotage (échu, non échu, tranches et taux d’échu, pour les arrêtés du 30/06/2026 à aujourd’hui) et Balance âgée d’après le grand livre', ''],
        tranches: ['Balance âgée, Tableau de bord, et Pilotage (colonnes du tableau par financeur, graphique d’ancienneté)', ''],
        classement: ['Balance âgée d’après le grand livre', ''],
        controle: ['Opérationnel', ''],
        cpf: ['Opérationnel — carte « Le circuit », financement CPF', ''],
        groupes: ['Opérationnel', ''],
        cibles: ['Opérationnel', ''],
        exclus: ['toutes les pages qui lisent Monday : Tableau de bord, Opérationnel, Balance âgée, Financements, Factures', ''],
        etats: ['toutes les pages', ''],
        sources: ['Tableau de bord, Opérationnel, Balance âgée, Financements, Factures, Contrôles', 'le Pilotage, qui lit déjà le grand livre'],
    };
    function bloc(id, titre, resume, mode, corps) {
        var po = PORTEES[id];
        if (po) corps = '<p class="v3-regle-portee"><b>S’applique à :</b> ' + esc(po[0]) + '.'
            + (po[1] ? ' <b>Ne change pas</b> ' + esc(po[1]) + '.' : '') + '</p>' + corps;
        return '<details class="v3-regle" data-regle="' + id + '"' + (OUVERTS[id] ? ' open' : '') + '>'
            + '<summary><span class="v3-regle-titre">' + esc(titre) + '</span>'
            + '<span class="v3-regle-resume">' + esc(resume) + '</span>'
            + '<span class="op-chip' + (/lecture/.test(mode) ? '' : ' bon') + '">' + esc(mode) + '</span></summary>'
            + '<div class="v3-regle-corps">' + corps + '</div></details>';
    }
    function famille(titre, dit, blocs) {
        return '<section class="v3-regles-famille"><h3>' + esc(titre) + '</h3><p class="op-pied">' + esc(dit) + '</p>'
            + blocs.join('') + '</section>';
    }

    function rendre() {
        var h = hote(), st = etat();
        if (!h) return;
        if (!st || !OP || !R) { h.innerHTML = '<p class="op-vide">Les règles s’affichent une fois les données chargées.</p>'; return; }
        h.innerHTML = '<p class="aide-bloc">Chaque règle est repliée sous son titre : cliquez la flèche pour voir son détail '
            + 'et la modifier. Une modification s’applique tout de suite aux calculs de cette page et reste gardée dans '
            + 'ce navigateur. Chaque règle dit, dans son détail, quelles pages elle modifie. Rien n’est changé dans Monday.</p>'
            + famille('Échéances', 'La date à laquelle une facture doit être payée.',
                [blocEcheances(st), blocEcheancesGL(st)])
            + famille('Balance âgée', 'Comment le reste dû est rangé par ancienneté et par financement.',
                [blocTranches(st), blocClassement(st)])
            + famille('Circuit de l’onglet Opérationnel', 'Ce qui range une facture dans une vignette : Sous contrôle, Rendre payable, Relancer, Clôture, Corriger.',
                [blocControle(), blocCpf(), blocGroupes(), blocCibles(), blocExclus()])
            + famille('Qualification des factures', 'Ce que veulent dire les états affichés partout dans l’application.',
                [blocSources(), blocEtats()]);
    }

    // ── Les gestes ──
    async function surChangement(e) {
        var c = e.target, st = etat();
        if (!c || !st) return;
        var d = c.dataset || {};
        if (d.ech != null || d.gl != null) {
            var r = (st.rules || [])[+(d.ech != null ? d.ech : d.gl)];
            if (!r) return;
            var num = (d.k === 'jours' || d.k === 'fallbackJours');
            var v = c.type === 'checkbox' ? c.checked : num ? Math.max(0, parseInt(c.value, 10) || 0) : (c.value || null);
            if (d.gl != null) {
                r.gl = Object.assign({ base: r.base, jours: r.jours }, r.gl || {});
                r.gl[d.k] = v;
            } else {
                r[d.k] = v;
                r.note = phrase(r);
            }
            try { await S.set(S.KEYS.rules, st.rules); } catch (x) { /* vaut pour cette session */ }
            recalculer(); rendre(); dire('Règle d’échéance enregistrée : les chiffres sont recalculés.');
            return;
        }
        if (d.coupe != null) {
            var choisies = [];
            (hote().querySelectorAll('[data-coupe]') || []).forEach(function (x) { if (x.checked) choisies.push(+x.dataset.coupe); });
            REG.tranches = choisies.length ? choisies : [12];
            appliquer(); await garder(); recalculer(); rendre();
            dire('Tranches d’ancienneté enregistrées : la balance âgée, le tableau de bord et le Pilotage les suivent.');
            return;
        }
        if (d.groupe != null) {
            var titre = d.groupe;
            REG.groupes[titre] = c.value;
            appliquer();
            // Revenu à son classement d'origine : la surcharge n'a plus lieu d'être.
            var sans = Object.assign({}, REG.groupes); delete sans[titre];
            var essai = { groupes: sans, cibles: REG.cibles, controle: REG.controle };
            OP.appliquerReglages(essai);
            if ((OP.categorieDuGroupe(titre) || 'aucune') === c.value) delete REG.groupes[titre];
            appliquer(); await garder(); rendre(); dire('Classement du groupe enregistré.');
            return;
        }
        if (d.cible != null) {
            var j = parseInt(c.value, 10);
            if (j > 0) REG.cibles[d.cible] = j; else delete REG.cibles[d.cible];
            if (OP.CIBLES_ORIGINE && REG.cibles[d.cible] === OP.CIBLES_ORIGINE[d.cible]) delete REG.cibles[d.cible];
            appliquer(); await garder(); rendre(); dire('Délai cible enregistré.');
            return;
        }
        if (d.action === 'hors') { REG.controle.horsEtapes = c.checked; appliquer(); await garder(); rendre(); dire('Règle « Sous contrôle » enregistrée.'); return; }
        if (d.action === 'cpf-payable') {
            var cp = parseInt(c.value, 10);
            if (cp >= 0 && cp !== 45) REG.controle.cpfPayable = cp; else delete REG.controle.cpfPayable;
            await garder(); rendre(); dire('Règle du circuit CPF enregistrée.');
            return;
        }
        if (d.action === 'proche') {
            var p = parseInt(c.value, 10);
            if (p > 0) REG.controle.proche = p; else delete REG.controle.proche;
            appliquer(); await garder(); rendre(); dire('Règle « Sous contrôle » enregistrée.');
            return;
        }
        if (d.action === 'exclus') {
            var norm = R.norm || function (x) { return String(x).toLowerCase(); };
            var mots = String(c.value || '').split(',').map(function (m) { return norm(m).trim(); }).filter(Boolean);
            REG.exclus = mots.length && mots.join('|') !== EXCLUS_ORIGINE.join('|') ? mots : null;
            appliquer(); await garder(); recalculer(); rendre(); dire('Liste des groupes écartés enregistrée.');
            return;
        }
        if (d.action === 'seuil') {
            var sel = document.getElementById('opt-seuil-bad-debt');
            if (sel) { sel.value = c.value; sel.dispatchEvent(new Event('change', { bubbles: true })); }
            setTimeout(rendre, 300); dire('Seuil des créances compromises enregistré.');
        }
    }

    async function surClic(e) {
        var v = e.target && e.target.closest && e.target.closest('[data-voir-groupe]');
        if (v) { var l = VOIR[v.dataset.voirGroupe]; if (l && OP.montrerFactures) OP.montrerFactures(l.titre, l.its, l.note); return; }
        var b = e.target && e.target.closest && e.target.closest('[data-action]');
        var st = etat();
        if (!b || !st || b.tagName !== 'BUTTON') return;
        var a = b.dataset.action;
        if (a === 'raz-echeances') {
            st.rules = (R.DEFAULT_ECHEANCE_RULES || []).map(function (r) {
                return Object.assign({}, r, r.gl ? { gl: Object.assign({}, r.gl) } : {});
            });
            try { await S.set(S.KEYS.rules, st.rules); } catch (x) { /* ignore */ }
            recalculer(); rendre(); dire('Règles d’échéance d’origine rétablies.');
        } else if (a === 'raz-groupes') { REG.groupes = {}; appliquer(); await garder(); rendre(); dire('Classement d’origine rétabli.'); }
        else if (a === 'raz-cibles') { REG.cibles = {}; appliquer(); await garder(); rendre(); dire('Délais d’origine rétablis.'); }
        else if (a === 'raz-tranches') { REG.tranches = null; appliquer(); await garder(); recalculer(); rendre(); dire('Découpage d’origine rétabli.'); }
        else if (a === 'raz-exclus') { REG.exclus = null; appliquer(); await garder(); recalculer(); rendre(); dire('Liste d’origine rétablie.'); }
        else if (a === 'vers-aging') { var t = document.querySelector('.nav-tab[data-tab="aging"]'); if (t) t.click(); }
    }

    function brancher() {
        var h = hote();
        if (!h || h.dataset.pret) return;
        h.dataset.pret = '1';
        h.addEventListener('change', surChangement);
        h.addEventListener('click', surClic);
        // « toggle » ne remonte pas : on l'écoute à la descente, pour garder
        // ouvert ce qui l'était quand la page se redessine.
        h.addEventListener('toggle', function (e) {
            var d = e.target;
            if (d && d.dataset && d.dataset.regle) OUVERTS[d.dataset.regle] = d.open;
        }, true);
        var onglet = document.getElementById('tab-regles');
        if (onglet && G.MutationObserver) {
            new MutationObserver(function () { if (onglet.classList.contains('active')) rendre(); })
                .observe(onglet, { attributes: true, attributeFilter: ['class'] });
        }
    }

    G.LioraV3Regles = { pret: pret, rendre: rendre, brancher: brancher, reglages: function () { return REG; } };
})(window);
