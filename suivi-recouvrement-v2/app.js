/* Suivi recouvrement — version 2
   Pilotage : grand livre Pennylane (pilotage.json, repris de la v1).
   Opérationnel / Contrôles : tableaux Monday — instantané embarqué, puis
   actualisation en direct par le connecteur monday.com. */
(function () {
  'use strict';
  var N = window.LioraNorm;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };

  /* ───────── formats ───────── */
  function fmt(n, d) { return (n == null || !isFinite(n)) ? '—' : Number(n).toLocaleString('fr-FR', { minimumFractionDigits: d || 0, maximumFractionDigits: d || 0 }); }
  function meur(v) { return fmt(v / 1e6, 2) + ' M€'; }
  function keur(v) { return fmt(v / 1e3, 0) + ' k€'; }
  function eurAuto(v) { return Math.abs(v) >= 1e6 ? meur(v) : keur(v); }
  function eur(v) { return v == null ? '—' : fmt(v, 0) + ' €'; }
  function sgn(x, d) { if (x == null || !isFinite(x)) return '—'; var r = Number(Math.abs(x).toFixed(d || 0)); return (r === 0 ? '' : x > 0 ? '+' : '−') + fmt(r, d || 0); }
  function pct(a, b) { return b ? a / b * 100 : null; }
  var MOIS = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];
  var MOIS_L = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
  function mLabel(m, yr) { var y = +m.slice(0, 4), mm = +m.slice(5, 7); return MOIS[mm - 1] + (yr ? ' ' + String(y).slice(2) : ''); }
  function dFR(d) { return d ? d.slice(8, 10) + '/' + d.slice(5, 7) + '/' + d.slice(0, 4) : '—'; }
  function toD(s) { return s ? new Date(s + 'T00:00:00Z') : null; }
  function days(a, b) { return Math.round((toD(b) - toD(a)) / 864e5); }
  function addM(m, k) { var y = +m.slice(0, 4), mm = +m.slice(5, 7) - 1 + k; y += Math.floor(mm / 12); mm = ((mm % 12) + 12) % 12; return y + '-' + String(mm + 1).padStart(2, '0'); }
  function dim(m) { return new Date(Date.UTC(+m.slice(0, 4), +m.slice(5, 7), 0)).getUTCDate(); }
  function median(a) { if (!a.length) return null; var s = a.slice().sort(function (x, y) { return x - y; }); var h = s.length >> 1; return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2; }
  function sum(a, f) { var t = 0; for (var i = 0; i < a.length; i++) t += (f ? f(a[i]) : a[i]) || 0; return t; }
  function isoWeek(d) { var t = toD(d); var day = (t.getUTCDay() + 6) % 7; t.setUTCDate(t.getUTCDate() - day + 3); var y = t.getUTCFullYear(); var f = new Date(Date.UTC(y, 0, 4)); return 1 + Math.round(((t - f) / 864e5 - 3 + ((f.getUTCDay() + 6) % 7)) / 7); }
  function mondayOf(d) { var t = toD(d); var day = (t.getUTCDay() + 6) % 7; t.setUTCDate(t.getUTCDate() - day); return t.toISOString().slice(0, 10); }
  function addD(d, k) { var t = toD(d); t.setUTCDate(t.getUTCDate() + k); return t.toISOString().slice(0, 10); }

  /* ───────── stockage local ───────── */
  function lsGet(k, def) { try { var v = localStorage.getItem('srv2:' + k); return v == null ? def : JSON.parse(v); } catch (e) { return def; } }
  function lsSet(k, v) { try { localStorage.setItem('srv2:' + k, JSON.stringify(v)); } catch (e) { /* stockage indisponible */ } }
  var idb = (function () {
    var p = null;
    function open() {
      if (p) return p;
      p = new Promise(function (res) {
        try {
          var r = indexedDB.open('suivi-recouvrement-v2', 1);
          r.onupgradeneeded = function () { r.result.createObjectStore('kv'); };
          r.onsuccess = function () { res(r.result); };
          r.onerror = function () { res(null); };
        } catch (e) { res(null); }
      });
      return p;
    }
    return {
      get: function (k) { return open().then(function (db) { if (!db) return null; return new Promise(function (res) { try { var q = db.transaction('kv').objectStore('kv').get(k); q.onsuccess = function () { res(q.result || null); }; q.onerror = function () { res(null); }; } catch (e) { res(null); } }); }); },
      set: function (k, v) { return open().then(function (db) { if (!db) return false; return new Promise(function (res) { try { var t = db.transaction('kv', 'readwrite'); t.objectStore('kv').put(v, k); t.oncomplete = function () { res(true); }; t.onerror = function () { res(false); }; } catch (e) { res(false); } }); }); },
      del: function (k) { return open().then(function (db) { if (!db) return; try { db.transaction('kv', 'readwrite').objectStore('kv').delete(k); } catch (e) { } }); }
    };
  })();

  /* ───────── réglages ───────── */
  var DEFAULTS = {
    dsoCible: { 'Entreprise': 45, 'OPCO': 75, 'Financement personnel': 30, 'CPF': 60, 'France Travail': 90, 'Région / Transition / Agefiph': 90 },
    cibleFile: { adv: 10, rec: 15, fin: 90, cor: 30 },
    gros: 10000, sansAction: 15, ceiCible: 85, dsoGlobal: 90, overrides: {}
  };
  var CFG = Object.assign(JSON.parse(JSON.stringify(DEFAULTS)), lsGet('cfg', {}));
  function saveCfg() { lsSet('cfg', CFG); }

  /* ───────── état ───────── */
  var S = {
    view: 'pilotage', gl: null, mo: null, moSource: 'snapshot', history: [],
    fin: 'all', ent: 'all', idx: null, cohort: 'Entreprise',
    opFile: 'adv', opOpen: {}, opFin: 'all', opEnt: 'all', opSvc: 'all', opMonth: null, q: '', flux: null, logs: { state: 'idle', msg: '' },
    live: { state: 'idle', log: [], done: 0, total: 0 }, mcp: null, downloads: null, calc: {}, glMeta: null
  };

  /* ───────── grand livre ───────── */
  var CAT_FIN = {
    'CPF': 'CPF', 'POEI': 'France Travail', 'AIF': 'France Travail', 'Financement personnel': 'Financement personnel', 'Perso-Alternance': 'Financement personnel',
    'B2C-Entreprise': 'Entreprise', 'B2B': 'Entreprise', 'Corporate - Alternance': 'Entreprise', 'OPCO': 'OPCO', 'OPCO - Alternance': 'OPCO', 'Alternance': 'OPCO',
    'Region': 'Région / Transition / Agefiph', 'Transition Pro': 'Région / Transition / Agefiph', 'Agefiph': 'Région / Transition / Agefiph', 'ETAT': 'Région / Transition / Agefiph',
    'Interne - DST Allemagne': 'Interne (Allemagne)', 'Interco': 'Interne (Allemagne)', '(à compléter)': 'Non affecté'
  };
  var ALLEMAGNE = { 'Interne - DST Allemagne': 1, 'Interco': 1 };
  function glFin(cat) { return CAT_FIN[cat] || 'Non affecté'; }
  function catPass(cat, finOverride) {
    if (S.ent === 'fr' && ALLEMAGNE[cat]) return false;
    if (S.ent === 'de' && !ALLEMAGNE[cat]) return false;
    var f = finOverride || S.fin;
    return f === 'all' || glFin(cat) === f;
  }
  function encAt(i, fin) {
    var e = S.gl.encours[i], o = { total: 0, echu: 0, ne: 0, b: [0, 0, 0, 0, 0, 0, 0, 0, 0], nb: 0 };
    (e.parFinancement || []).forEach(function (r) {
      if (!catPass(r.cat, fin)) return;
      o.total += r.total; o.echu += r.echu; o.ne += r.nonEchu; o.nb += r.nb || 0;
      r.buckets.forEach(function (v, j) { o.b[j] += v; });
    });
    o.a = o.b[0]; o.bb = o.b[1] + o.b[2]; o.c = sum(o.b.slice(3));
    return o;
  }
  function fluxM(m, fin) {
    var o = { fac: 0, enc: 0, avo: 0 };
    S.gl.flux.forEach(function (r) { if (r.m === m && catPass(r.fin, fin)) { o.fac += r.fac || 0; o.enc += r.enc || 0; o.avo += r.avo || 0; } });
    return o;
  }
  function mOf(i) { return S.gl.dates[i].slice(0, 7); }
  // DSO, méthode de la v1 : délai moyen entre la date de facture et
  // l’encaissement, pondéré par les montants, sur l’exercice en cours
  // (du 1er juillet jusqu’au mois d’arrêté).
  function dsoInfo(i, fin) {
    var m = mOf(i), y = +m.slice(0, 4), mo = +m.slice(5, 7);
    var deb = (mo >= 7 ? y : y - 1) + '-07', mt = 0, mj = 0, nb = 0;
    S.gl.dso.forEach(function (r) { if (r.m >= deb && r.m <= m && catPass(r.fin, fin)) { mt += r.mt; mj += r.mj; nb += r.n || 0; } });
    return { d: mt > 0 ? mj / mt : null, mt: mt, n: nb, deb: deb };
  }
  function dsoAt(i, fin) { return dsoInfo(i, fin).d; }
  function ceiAt(i, fin) {
    if (i < 1) return null;
    var r0 = encAt(i - 1, fin).total, e1 = encAt(i, fin), F = fluxM(mOf(i), fin).fac;
    var den = r0 + F - e1.ne;
    return den > 0 ? (r0 + F - e1.total) / den * 100 : null;
  }
  function provRequise(i) {
    var P = S.gl.provision, e = S.gl.encours[i], T = S.gl.tranches, tot = 0;
    (e.parTypeClient || []).forEach(function (r) {
      var taux = P.taux[r.cat]; if (!taux) return;
      P.fenetres.forEach(function (w, wi) {
        w.tranches.forEach(function (t) { var j = T.indexOf(t); if (j >= 0) tot += Math.max(0, r.buckets[j]) * (taux[wi] || 0); });
      });
    });
    return tot;
  }
  function vintageBy(fin) {
    var byM = {};
    S.gl.vintage.forEach(function (r) {
      if (!catPass(r.fin, fin)) return;
      var o = byM[r.m] || (byM[r.m] = { fac: 0, p: [] });
      o.fac += r.fac || 0;
      (r.p || []).forEach(function (v, j) { o.p[j] = (o.p[j] || 0) + v; });
    });
    return byM;
  }

  /* ───────── Monday ───────── */
  var REF = '2026-11-09';
  var FILE = {}; N.FILES.forEach(function (f) { FILE[f.k] = f; });
    function fileOfItem(o) {
    if (o.nl) return 'cor';
    if (o.st2 === 'avoir' || o.st2 === 'monday' || o.st2 === 'gl') return 'regle';
    if (o.st2 === 'vir') return 'cor';
    var ov = CFG.overrides[N.prefix(o.g)];
    var f = ov || o.f;
    return f === 'cpt' ? 'cor' : f;
  }
  function retard(o) { return o.de ? days(o.de, REF) : null; }
  function openItems(opts) {
    opts = opts || {};
    return S.mo.open.filter(function (o) {
      var f = fileOfItem(o);
      if (!FILE[f]) return opts.withOthers ? true : false;
      if (opts.raw) return true;
      return openItems.pass(o);
    });
  }
  openItems.pass = function (o) {
    var q = (S.q || '').toLowerCase().trim();
    if (S.opFin !== 'all' && o.fin !== S.opFin) return false;
    if (S.opSvc !== 'all' && fileOfItem(o) !== S.opSvc) return false;
    var de = /allemagne|germany|gmbh|interco/i.test((o.tc || '') + ' ' + (o.cl || ''));
    if (S.opEnt === 'de' && !de) return false;
    if (S.opEnt === 'fr' && de) return false;
    if (q && (o.n + ' ' + (o.cl || '') + ' ' + (o.ap || '') + ' ' + o.g).toLowerCase().indexOf(q) < 0) return false;
    return true;
  };
  function mondayLink(o) {
    var b = N.BOARDS.filter(function (x) { return x.key === o.b; })[0];
    if (!b) return '';
    return 'https://cyberuniversity.monday.com/boards/' + b.id + (o.id ? '/pulses/' + o.id : '');
  }
  function paidSet() { if (!S._paidSet) { S._paidSet = {}; S.mo.paid.forEach(function (p) { S._paidSet[p.n] = p; }); } return S._paidSet; }

  /* historique des files (pour entrées / sorties / 12 semaines) */
  function snapshotOf(mo) {
    var f = {};
    mo.open.forEach(function (o) { var k = fileOfItem(o); if (!FILE[k]) return; (f[k] || (f[k] = [])).push(o.n); });
    return { at: mo.at.slice(0, 10), f: f };
  }
  function pushHistory(mo) {
    var s = snapshotOf(mo);
    S.history = S.history.filter(function (h) { return h.at !== s.at; });
    S.history.push(s);
    S.history.sort(function (a, b) { return a.at < b.at ? -1 : 1; });
    S.history = S.history.slice(-30);
    return idb.set('history', S.history);
  }
  function refSnapshot() {
    var cur = S.mo.at.slice(0, 10), best = null;
    S.history.forEach(function (h) { if (h.at < cur && days(h.at, cur) >= 25) best = h; });
    if (!best) S.history.forEach(function (h) { if (h.at < cur && !best) best = h; });
    return best;
  }

  /* ───────── petits composants ───────── */
  var ICON = {
    wallet: 'M4 7h15a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z M4 7l11-3v3 M16 13.5h1',
    clock: 'M3 12a9 9 0 1 0 18 0a9 9 0 1 0 -18 0 M12 7v5l3 2',
    alert: 'M12 4l9 16H3z M12 10v4 M12 17.5v.01',
    cal: 'M4 6h16v14H4z M4 10h16 M8 3v4 M16 3v4',
    target: 'M3 12a9 9 0 1 0 18 0a9 9 0 1 0 -18 0 M8 12a4 4 0 1 0 8 0a4 4 0 1 0 -8 0 M12 12v.01',
    shield: 'M12 3l8 3v6c0 5-3.5 8-8 9c-4.5-1-8-4-8-9V6z',
    inbox: 'M4 13h4l2 3h4l2-3h4 M5 5h14l1 8v6H4v-6z',
    check: 'M3 12a9 9 0 1 0 18 0a9 9 0 1 0 -18 0 M8 12l3 3 5-6',
    users: 'M4 20c0-3.5 2.5-5.5 5.5-5.5s5.5 2 5.5 5.5 M9.5 11.5a3.5 3.5 0 1 0 0-7a3.5 3.5 0 1 0 0 7 M16 4.6a3.5 3.5 0 0 1 0 6.8 M18 14.6c1.8.6 3 2.4 3 5.4'
  };
  var TONE = { info: 'background:var(--info-soft);color:var(--info)', acc: 'background:var(--accent-soft);color:var(--accent)', bad: 'background:var(--bad-soft);color:var(--bad)', good: 'background:var(--good-soft);color:var(--good)', warn: 'background:var(--warn-soft);color:var(--warn)' };
  function icon(p) { return '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="' + p + '"/></svg>'; }
  function spark(arr, color) {
    var a = arr.filter(function (v) { return v != null; });
    if (a.length < 2) return '';
    var mn = Math.min.apply(null, a), mx = Math.max.apply(null, a), w = 88, h = 22;
    var pts = arr.map(function (v, i) { return v == null ? null : [(1 + i / (arr.length - 1) * (w - 2)), (h - 3 - (v - mn) / ((mx - mn) || 1) * (h - 6))]; }).filter(Boolean);
    var last = pts[pts.length - 1];
    return '<svg class="sparky" width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '" aria-hidden="true"><polyline points="' + pts.map(function (p) { return p[0].toFixed(1) + ',' + p[1].toFixed(1); }).join(' ') + '" style="fill:none;stroke:' + (color || 'var(--g1)') + ';stroke-width:1.6"/><circle cx="' + last[0].toFixed(1) + '" cy="' + last[1].toFixed(1) + '" r="2.4" style="fill:' + (color || 'var(--g1)') + '"/></svg>';
  }
  function kpiCard(k) {
    return '<div class="kpi"><div class="kpi-top"><div class="kic" style="' + (k.tone || TONE.info) + '">' + icon(k.icon || ICON.wallet) + '</div><div style="min-width:0;flex:1"><span class="kl">' + esc(k.l) + '</span><span class="kv">' + k.v + '</span></div>' + (k.spark || '') + '</div>' +
      (k.sub ? '<span class="ks">' + k.sub + '</span>' : '') + (k.chips ? '<div class="kd">' + k.chips + '</div>' : '') + '</div>';
  }
  function chip(txt, cls) { return '<span class="chip ' + (cls || 'c-mute') + '">' + txt + '</span>'; }
  function deltaChip(label, x, unit, badWhenUp) {
    var cls = 'c-mute';
    if (x != null && isFinite(x) && Math.abs(x) >= 0.05 && badWhenUp != null) cls = ((x > 0) === badWhenUp) ? 'c-bad' : 'c-good';
    return chip(label + ' ' + (x == null || !isFinite(x) ? '—' : sgn(x, unit === ' %' || unit === ' pts' ? 1 : 0) + unit), cls);
  }
  function legend(items) { return '<div class="legend">' + items.map(function (l) { return '<span><i class="sw" style="background:' + l[1] + '"></i>' + esc(l[0]) + '</span>'; }).join('') + '</div>'; }
  function niceMax(v) { if (v <= 0) return 1; var p = Math.pow(10, Math.floor(Math.log10(v))), n = v / p; var s = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10; return s * p; }
  function yAxis(max, f) { var out = []; for (var i = 5; i >= 0; i--) out.push('<span style="top:' + ((5 - i) * 20) + '%">' + f(max * i / 5) + '</span>'); return '<div class="yax">' + out.join('') + '</div>'; }
  // Colonnes empilées : cols = [{label, tip, segs:[{v,c}]}]
  function stackChart(cols, f) {
    var mx = niceMax(Math.max.apply(null, cols.map(function (c) { return sum(c.segs, function (s) { return Math.max(0, s.v); }); })));
    return '<div class="chart">' + yAxis(mx, f) + '<div class="plot"><div class="cols">' + cols.map(function (c) {
      return '<div class="col" title="' + esc(c.tip || '') + '">' + c.segs.map(function (s) { return '<div style="height:' + (Math.max(0, s.v) / mx * 100).toFixed(2) + '%;background:' + s.c + '"></div>'; }).join('') + '</div>';
    }).join('') + '</div></div><div class="xax">' + cols.map(function (c) { return '<span>' + esc(c.label) + '</span>'; }).join('') + '</div></div>';
  }
  // Colonnes groupées : cols = [{label, bars:[{v,c,lab}]}]
  function groupChart(cols, f, opts) {
    opts = opts || {};
    var all = []; cols.forEach(function (c) { c.bars.forEach(function (b) { if (b.v != null) all.push(b.v); }); });
    var mx = niceMax(opts.max || Math.max.apply(null, all.concat([0])) * 1.12);
    return '<div class="chart">' + yAxis(mx, f) + '<div class="plot"><div class="cols">' + cols.map(function (c) {
      return '<div class="grp" title="' + esc(c.tip || '') + '">' + c.bars.map(function (b) { return b.v == null ? '<div class="bar"></div>' : '<div class="bar" style="height:' + (Math.max(0, b.v) / mx * 100).toFixed(2) + '%;background:' + b.c + '">' + (opts.labels ? '<span>' + esc(b.lab != null ? b.lab : f(b.v)) + '</span>' : '') + '</div>'; }).join('') + '</div>';
    }).join('') + '</div></div><div class="xax">' + cols.map(function (c) { return '<span>' + esc(c.label) + '</span>'; }).join('') + '</div></div>';
  }
  // Courbes : series = [{n,c,w,dash,vals:[]}], labels
  function lineChart(series, labels, f, opts) {
    opts = opts || {};
    var all = []; series.forEach(function (s) { s.vals.forEach(function (v) { if (v != null) all.push(v); }); });
    var mx = niceMax(opts.max || Math.max.apply(null, all.concat([1])) * 1.05), n = labels.length;
    var paths = series.map(function (s) {
      var d = '', dots = '', pen = false;
      s.vals.forEach(function (v, i) {
        if (v == null) { pen = false; return; }
        var x = n === 1 ? 50 : (i / (n - 1)) * 100, y = 100 - v / mx * 100;
        d += (pen ? 'L' : 'M') + x.toFixed(2) + ' ' + y.toFixed(2) + ' '; pen = true;
        if (i === s.vals.length - 1 || s.dots) dots += '<circle cx="' + x.toFixed(2) + '%" cy="' + y.toFixed(2) + '%" r="' + (s.w > 2 ? 4 : 2.6) + '" style="fill:' + s.c + '"><title>' + esc(s.n + ' · ' + labels[i] + ' : ' + f(v)) + '</title></circle>';
      });
      var hit = s.fin ? '<path class="hit" data-fin="' + esc(s.fin) + '" d="' + d + '" vector-effect="non-scaling-stroke"><title>' + esc(s.n) + ' : cliquer pour filtrer la page</title></path>' : '';
      return '<svg class="lines" viewBox="0 0 100 100" preserveAspectRatio="none"><path d="' + d + '" vector-effect="non-scaling-stroke" style="fill:none;stroke:' + s.c + ';stroke-width:' + (s.w || 1.6) + ';stroke-dasharray:' + (s.dash || 'none') + '"/>' + hit + '</svg><svg class="lines">' + dots + '</svg>';
    }).join('');
    return '<div class="chart">' + yAxis(mx, f) + '<div class="plot">' + paths + '</div><div class="xax xpos">' + labels.map(function (l, i) { return '<span style="left:' + (n === 1 ? 50 : i / (n - 1) * 100).toFixed(2) + '%">' + esc(l) + '</span>'; }).join('') + '</div></div>';
  }
  function hbars(rows, colors, f) {
    var mx = Math.max.apply(null, rows.map(function (r) { return sum(r.v); }).concat([1]));
    return '<div class="hb">' + rows.map(function (r) {
      return '<div class="r" title="' + esc(r.tip || r.l) + '"><span>' + esc(r.l) + '</span><div class="track">' + r.v.map(function (v, j) { return v > 0 ? '<div style="width:' + (v / mx * 100).toFixed(2) + '%;background:' + colors[j] + '"></div>' : ''; }).join('') + '</div><span class="v">' + (f ? f(sum(r.v)) : fmt(sum(r.v))) + '</span></div>';
    }).join('') + '</div>';
  }
  function table(head, rows, opts) {
    opts = opts || {};
    return '<div class="tw"><table' + (opts.cls ? ' class="' + opts.cls + '"' : '') + '><thead><tr>' + head.map(function (h, i) { return '<th' + (opts.right && opts.right.indexOf(i) >= 0 ? ' class="r"' : '') + '>' + esc(h) + '</th>'; }).join('') + '</tr></thead><tbody>' + rows.join('') + '</tbody></table></div>';
  }
  function td(v, cls, style) { return '<td' + (cls ? ' class="' + cls + '"' : '') + (style ? ' style="' + style + '"' : '') + '>' + v + '</td>'; }
  function mix(c, p) { return 'color-mix(in srgb, ' + c + ' ' + Math.max(0, Math.min(100, p)).toFixed(0) + '%, transparent)'; }
  function toast(t) { var el = $('#toast'); el.textContent = t; el.hidden = false; clearTimeout(toast._t); toast._t = setTimeout(function () { el.hidden = true; }, 4200); }

  /* ───────── export Excel ───────── */
  function exportXlsx(name, sheets) {
    if (!window.XLSX) { toast('La bibliothèque Excel ne s’est pas chargée. Rechargez la page.'); return; }
    var wb = XLSX.utils.book_new();
    sheets.forEach(function (s) { XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(s.rows), s.name.slice(0, 31)); });
    var bytes = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
    var blob = new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    var go = function (dl) {
      if (!dl) { toast('L’enregistrement de fichiers n’est pas disponible dans cette vue.'); return; }
      dl.save({ filename: name, data: blob }).then(function () { toast('« ' + name + ' » enregistré.'); }).catch(function (e) {
        if (e && e.code === 'declined') return;
        toast('L’enregistrement n’a pas abouti' + (e && e.code ? ' (' + e.code + ')' : '') + '.');
      });
    };
    if (S.downloads !== null && S.downloads !== undefined) go(S.downloads);
    else if (window.claude && claude.use) claude.use('downloads').then(function (d) { S.downloads = d; go(d); }, function () { go(null); });
    else go(null);
  }

  /* ═════════════════ PILOTAGE ═════════════════ */
  var FIN_COLORS = { 'Entreprise': 'var(--f1)', 'OPCO': 'var(--f2)', 'Financement personnel': 'var(--f3)', 'CPF': 'var(--f4)', 'France Travail': 'var(--f5)', 'Région / Transition / Agefiph': 'var(--f6)' };

  function renderPilotage() {
    var G = S.gl, n = S.idx, dates = G.dates, m = mOf(n);
    var range = []; for (var i = 0; i <= n; i++) range.push(i);
    var series = range.map(function (i) { return encAt(i); });
    var cur = series[n], prev = series[n - 1], y0 = n >= 12 ? series[n - 12] : null;
    var dsoS = range.map(function (i) { return dsoAt(i); }), ceiS = range.map(function (i) { return ceiAt(i); });
    var peS = series.map(function (e) { return pct(e.echu, e.total); }), cS = series.map(function (e) { return e.c; });

    function kp(l, arr, kind, badUp, sub, ic, tone, extra) {
      var v = arr[n], p = arr[n - 1], y = n >= 12 ? arr[n - 12] : null;
      var d = function (x) { return (v == null || x == null) ? null : kind === 'eur' ? (v / x - 1) * 100 : v - x; };
      var u = kind === 'eur' ? ' %' : kind === 'pct' ? ' pts' : ' j';
      var val = v == null ? '—' : kind === 'eur' ? meur(v) : kind === 'pct' ? fmt(v, 0) + ' %' : fmt(v, 0) + ' j';
      return kpiCard({ l: l, v: val, sub: sub + (extra ? ' · ' + extra : ''), icon: ic, tone: tone, spark: spark(arr.slice(-13), 'var(--g1)'), chips: deltaChip('vs M-1', d(p), u, badUp) + deltaChip('vs N-1', d(y), u, badUp) });
    }
    var provC = G.provision.comptabilisee, cible = S.fin === 'all' ? CFG.dsoGlobal : (CFG.dsoCible[S.fin] || CFG.dsoGlobal);
    var kpis = [
      kp('Encours clients', series.map(function (e) { return e.total; }), 'eur', null, 'dont non échu ' + meur(cur.ne), ICON.wallet, TONE.info),
      kp('Taux d’échu', peS, 'pct', true, 'soit ' + meur(cur.echu) + ' échus', ICON.clock, TONE.acc),
      kp('Échu à plus de 180 j', cS, 'eur', true, fmt(pct(cur.c, cur.total), 0) + ' % de l’encours', ICON.alert, TONE.bad),
      kp('DSO', dsoS, 'day', true, fmt(dsoInfo(n).n) + ' règlements · ' + eurAuto(dsoInfo(n).mt) + ' depuis le 01/07', ICON.cal, TONE.info, 'cible ' + cible + ' j'),
      kp('CEI', ceiS, 'pct', false, 'encaissé / exigible du mois', ICON.target, TONE.good, 'cible ' + CFG.ceiCible + ' %'),
      kpiCard({ l: 'Couverture des provisions', v: S.fin === 'all' && S.ent === 'all' ? fmt(pct(provC, encAt(n).c), 0) + ' %' : '—', icon: ICON.shield, tone: TONE.warn,
        sub: S.fin === 'all' && S.ent === 'all' ? keur(provC) + ' provisionnés sur ' + keur(encAt(n).c) + ' à plus de 180 j' : 'Disponible sans filtre financeur ni entité : la provision n’est lue qu’en global.',
        chips: chip('provision lue au ' + esc(G.provision.provisionLue ? G.provision.provisionLue.au : '—')) })
    ];

    // 1. Encours et âge, 13 mois
    var lo = Math.max(0, n - 12), encCols = [];
    for (var k = lo; k <= n; k++) {
      var e = series[k];
      encCols.push({ label: mLabel(mOf(k), k === lo || k === n), tip: dFR(dates[k]) + ' : ' + meur(e.total) + ', dont échu ' + meur(e.echu) + ' (> 180 j : ' + meur(e.c) + ')', segs: [{ v: e.ne, c: 'var(--c6)' }, { v: e.a, c: 'var(--c4)' }, { v: e.bb, c: 'var(--c2)' }, { v: e.c, c: 'var(--c5)' }] });
    }
    var cGrowth = n >= 12 ? (cur.c / series[n - 12].c - 1) * 100 : null;
    var encNote = 'Sur 13 mois, l’échu à plus de 180 jours passe de ' + meur(series[lo].c) + ' à ' + meur(cur.c) + (cGrowth != null ? ' (' + sgn(cGrowth, 0) + ' % sur un an)' : '') + '. Le non échu suit la facturation ; c’est la couche la plus sombre qui dit si le stock vieillit.';

    // 2. Qui se dégrade (lecture de la v1) : par mois d’échéance, part des
    // factures arrivées à échéance qui sont tombées en retard — payées après
    // l’échéance ou toujours impayées. Échéance calculée par les règles v1.
    var refM = REF.slice(0, 7), cohMonths = []; for (var c = 12; c >= 1; c--) cohMonths.push(addM(refM, -c));
    var CL = calcList().filter(function (x) {
      if (!x.de || x.src === 'avoir' || x.de >= REF) return false;
      var de = /allemagne|interco/i.test(x.rl || '');
      if (S.ent === 'de' && !de) return false; if (S.ent === 'fr' && de) return false;
      return true;
    });
    var degr = N.FINANCEURS.map(function (f) {
      var vals = cohMonths.map(function (mm) {
        var tot = 0, late = 0;
        CL.forEach(function (x) {
          if (x.fin !== f || x.de.slice(0, 7) !== mm) return;
          if (x.paid && !x.dp) return;
          tot++; if (!x.paid || x.dp > x.de) late++;
        });
        return tot >= 5 ? late / tot * 100 : null;
      });
      var a = vals.filter(function (v) { return v != null; });
      return { n: f, c: FIN_COLORS[f], vals: vals, last: a.length ? a[a.length - 1] : null, first: a.length ? a[0] : null };
    }).filter(function (s) { return s.last != null && (S.fin === 'all' || s.n === S.fin); });
    degr.forEach(function (s) { s.dd = s.last - s.first; });
    degr.sort(function (a, b) { return (b.dd || 0) - (a.dd || 0); });
    degr.forEach(function (s, i) { s.w = i < 2 && s.dd > 3 ? 3 : 1.8; s.fin = s.n; });

    // Bridge encours M-1 -> M (grand livre)
    var brStart = n > 0 ? encAt(n - 1).total : null, brEnd = cur.total, bf = { fac: 0, enc: 0, avo: 0, od: 0, banque: 0, autre: 0, nFac: 0, nEnc: 0, nAvo: 0, nod: 0, nbanque: 0, nautre: 0 };
    G.flux.forEach(function (r) {
      if (r.m !== m || !catPass(r.fin)) return;
      bf.fac += r.fac || 0; bf.enc += r.enc || 0; bf.avo += r.avo || 0; bf.nFac += r.nFac || 0; bf.nEnc += r.nEnc || 0; bf.nAvo += r.nAvo || 0;
      Object.keys(r.autG || {}).forEach(function (k) { bf[k] = (bf[k] || 0) + r.autG[k]; });
      Object.keys(r.nAutG || {}).forEach(function (k) { bf['n' + k] = (bf['n' + k] || 0) + r.nAutG[k]; });
    });
    var bridgeHtml = '<div class="empty">Pas de mois précédent pour cet arrêté.</div>';
    if (brStart != null) {
      var steps = [['Facturé', bf.fac, bf.nFac], ['Encaissé', -bf.enc, bf.nEnc], ['Avoirs', -bf.avo, bf.nAvo], ['Opérations diverses', bf.od, bf.nod], ['Banque hors règlement', bf.banque, bf.nbanque], ['Autres journaux', bf.autre, bf.nautre]];
      var ecart = brEnd - brStart - sum(steps, function (x) { return x[1]; });
      if (Math.abs(ecart) >= 1) steps.push(['Écart non expliqué', ecart, null]);
      var dPrev = dFR(dates[n - 1]), dCur = dFR(dates[n]);
      var wf = [{ l: 'Encours au ' + dPrev, a: 0, b: brStart, c: 'var(--c1)', v: brStart, tot: 1 }], run = brStart;
      steps.forEach(function (x) { wf.push({ l: x[0], a: run, b: run + x[1], c: x[1] >= 0 ? 'var(--bad)' : 'var(--good)', v: x[1] }); run += x[1]; });
      wf.push({ l: 'Encours au ' + dCur, a: 0, b: brEnd, c: 'var(--c1)', v: brEnd, tot: 1 });
      var lv = []; wf.forEach(function (w) { if (!w.tot) { lv.push(w.a, w.b); } });
      var lo = Math.min.apply(null, lv), hi = Math.max.apply(null, lv.concat([brStart, brEnd]));
      var span = Math.max(hi - lo, 1), step = niceMax(span / 2.5) / 2, bot = Math.max(0, Math.floor((lo - span * 0.8) / step) * step), top = Math.ceil(hi * 1.01 / step) * step;
      if ((top - bot) / step > 8) step = niceMax((top - bot) / 5);
      var ticks = []; for (var tv = bot; tv <= top + 1e-6; tv += step) ticks.push(tv);
      top = ticks[ticks.length - 1];
      var Y = function (v) { return (Math.max(v, bot) - bot) / (top - bot) * 100; };
      bridgeHtml = '<div class="chart"><div class="yax">' + ticks.map(function (tv) { return '<span style="top:' + (100 - Y(tv)).toFixed(2) + '%">' + fmt(tv / 1e6, 1) + ' M€</span>'; }).join('') + '</div>' +
        '<div class="plot" style="background:none">' + ticks.map(function (tv) { return '<i class="gl" style="bottom:' + Y(tv).toFixed(2) + '%"></i>'; }).join('') + '<div class="cols">' + wf.map(function (w) {
          var y0 = Y(Math.min(w.a, w.b)), y1 = Y(Math.max(w.a, w.b));
          return '<div class="col wf" title="' + esc(w.l + ' : ' + (w.tot ? eur(w.v) : (w.v >= 0 ? '+' : '−') + eur(Math.abs(w.v)))) + '"><div style="position:absolute;left:0;right:0;bottom:' + y0.toFixed(2) + '%;height:' + Math.max(0.6, y1 - y0).toFixed(2) + '%;background:' + w.c + ';border-radius:2px">' + (w.tot ? '<span class="wl">' + fmt(w.v / 1e6, 2) + ' M€</span>' : '') + '</div></div>';
        }).join('') + '</div></div><div class="xax">' + wf.map(function (w) { return '<span title="' + esc(w.l) + '">' + esc(w.tot ? (w.l.indexOf(dPrev) > 0 ? dPrev.slice(0, 5) : dCur.slice(0, 5)) : ({ 'Opérations diverses': 'OD', 'Banque hors règlement': 'Banque', 'Autres journaux': 'Autres', 'Écart non expliqué': 'Écart' }[w.l] || w.l)) + '</span>'; }).join('') + '</div></div>' +
        legend([['Encours', 'var(--c1)'], ['Fait monter l’encours', 'var(--bad)'], ['Fait baisser l’encours', 'var(--good)']]) +
        table(['Poste', 'Montant', 'Écritures'], ['<tr class="tot">' + td('Encours au ' + dPrev) + td(eur(brStart), 'r') + td('—', 'r') + '</tr>'].concat(steps.map(function (x) {
          return '<tr>' + td(esc(x[0])) + td((x[1] > 0 ? '+' : x[1] < 0 ? '−' : '') + eur(Math.abs(x[1])), 'r', 'color:' + (x[1] > 0.5 ? 'var(--bad)' : x[1] < -0.5 ? 'var(--good)' : 'var(--muted)')) + td(x[2] == null ? '' : fmt(x[2]), 'r') + '</tr>';
        })).concat(['<tr class="tot">' + td('Encours au ' + dCur) + td(eur(brEnd), 'r') + td('—', 'r') + '</tr>']), { right: [1, 2], cls: 'compact' });
    }

    // 3. Où se loge le retard
    var heatRows = N.FINANCEURS.concat(['Interne (Allemagne)', 'Non affecté']).map(function (f) {
      if (S.fin !== 'all' && S.fin !== f) return null;
      var e = encAt(n, f); if (Math.abs(e.total) < 1) return null;
      var cells = [e.ne, e.b[0], e.b[1] + e.b[2], e.b[3], e.b[4] + e.b[5], e.b[6] + e.b[7] + e.b[8]];
      var dso = dsoAt(n, f), cib = CFG.dsoCible[f];
      return { f: f, cells: cells, t: e.total, dso: dso, cib: cib };
    }).filter(Boolean);
    var mxNE = Math.max.apply(null, heatRows.map(function (r) { return r.cells[0]; }).concat([1]));
    var mxE = Math.max.apply(null, heatRows.map(function (r) { return Math.max.apply(null, r.cells.slice(1)); }).concat([1]));
    var heatHtml = table(['Financeur', 'Non échu', '0-3 mois', '3-6 mois', '6-12 mois', '12-24 mois', '> 24 mois', 'Total', 'DSO / cible'],
      heatRows.map(function (r) {
        var ratio = r.dso != null && r.cib ? r.dso / r.cib : null;
        return '<tr>' + td(esc(r.f)) + r.cells.map(function (v, j) { return td(fmt(v / 1000), 'h', 'background:' + (j === 0 ? mix('var(--c1)', 6 + v / mxNE * 30) : mix('var(--c2)', 6 + Math.max(0, v) / mxE * 55))); }).join('') + td(fmt(r.t / 1000), 'r') +
          td(chip((r.dso != null ? fmt(r.dso, 0) : '—') + '/' + (r.cib || '—') + ' j', ratio == null ? 'c-mute' : ratio >= 1.5 ? 'c-bad' : ratio > 1 ? 'c-warn' : 'c-good'), 'r') + '</tr>';
      }).concat(['<tr class="tot">' + td('Total') + [0, 1, 2, 3, 4, 5].map(function (j) { return td(fmt(sum(heatRows, function (r) { return r.cells[j]; }) / 1000), 'r'); }).join('') + td(fmt(sum(heatRows, function (r) { return r.t; }) / 1000), 'r') + td(chip(fmt(dsoS[n], 0) + '/' + cible + ' j', dsoS[n] / cible >= 1.5 ? 'c-bad' : dsoS[n] > cible ? 'c-warn' : 'c-good'), 'r') + '</tr>']),
      { right: [1, 2, 3, 4, 5, 6, 7, 8], cls: 'heat compact' });

    // Variation du DSO (lecture de la v1) : délai moyen entre la date de facture
    // et l’encaissement, pondéré par les montants, mois par mois du règlement.
    var dsoMs = [], dsoV = [], dsoN = [];
    var mN = mOf(n);
    G.dso.forEach(function (r) { if (r.m <= mN && dsoMs.indexOf(r.m) < 0) dsoMs.push(r.m); });
    dsoMs.sort(); dsoMs = dsoMs.slice(-16);
    dsoMs.forEach(function (mm) {
      var mt = 0, mj = 0, nb = 0;
      G.dso.forEach(function (r) { if (r.m === mm && catPass(r.fin)) { mt += r.mt; mj += r.mj; nb += r.n || 0; } });
      dsoV.push(mt > 0 ? mj / mt : null); dsoN.push(nb);
    });
    var dsoCib = S.fin === 'all' ? CFG.dsoGlobal : (CFG.dsoCible[S.fin] || null);
    var dsoSer = [{ n: S.fin === 'all' ? 'Tous financements (moyenne pondérée)' : S.fin, c: S.fin === 'all' ? 'var(--accent)' : (FIN_COLORS[S.fin] || 'var(--accent)'), w: 2.4, dots: true, vals: dsoV }];
    if (dsoCib) dsoSer.push({ n: 'Cible ' + dsoCib + ' j', c: 'var(--g2)', w: 1.4, dash: '5 4', vals: dsoMs.map(function () { return dsoCib; }) });
    var dsoOk = dsoV.filter(function (v) { return v != null; });
    var dsoHtml = dsoOk.length ? lineChart(dsoSer, dsoMs.map(function (mm, i) { var L = dsoMs.length - 1; return (i % 3 === L % 3) ? mLabel(mm, true) : ''; }), function (v) { return fmt(v, 0) + ' j'; }) + legend(dsoSer.map(function (x) { return [x.n, x.c]; })) +
      '<p class="note">Dernier mois : <b class="num">' + fmt(dsoOk[dsoOk.length - 1], 0) + ' j</b> sur ' + fmt(dsoN[dsoN.length - 1]) + ' règlements · moyenne sur la période : ' + fmt(sum(dsoOk) / dsoOk.length, 0) + ' j.</p>'
      : '<div class="empty">Aucun règlement sur la période pour ce filtre.</div>';

    // 4. Cohortes
    // Cohortes sur l’argent effectivement reçu : règlement lettré au grand
    // livre ou virement reçu (date réelle), ou tableau « Factures payées » pour
    // une facture antérieure au grand livre. Une facture « payée » dans Monday
    // mais ouverte au grand livre ne compte pas. Avoirs exclus.
    var cohFin = N.FINANCEURS.indexOf(S.fin) >= 0 ? S.fin : S.cohort;
    var tabs = N.FINANCEURS.map(function (f) { return '<button role="tab" aria-selected="' + (cohFin === f) + '" data-cohort="' + esc(f) + '">' + esc(f) + '</button>'; }).join('');
    var AGES = [1, 2, 3, 4, 6], AL = ['30 j', '60 j', '90 j', '120 j', '180 j'], by = {}, nEst = 0, nNonRecu = 0;
    function recu(x) { return x.paid && x.dp; }
    calcList().forEach(function (x) {
      if (!x.df || x.src === 'avoir' || x.fin !== cohFin) return;
      var de = /allemagne|interco/i.test(x.rl || ''); if (S.ent === 'de' && !de) return; if (S.ent === 'fr' && de) return;
      var o = by[x.df.slice(0, 7)] || (by[x.df.slice(0, 7)] = { fac: 0, items: [] });
      o.fac += x.mt; o.items.push(x);
    });
    var refMo = REF.slice(0, 7), cohorts = []; for (var cc = 6; cc >= 1; cc--) cohorts.push(addM(refMo, -cc));
    var refN1 = addM(cohorts[0], -12);
    function rate(mm, age) {
      var o = by[mm]; if (!o || !o.fac) return null;
      if (days(mm + '-' + String(dim(mm)).padStart(2, '0'), REF) < age * 30) return null;
      var p = 0; o.items.forEach(function (x) { if (recu(x) && days(x.df, x.dp) <= age * 30) p += x.mt; });
      return Math.min(100, p / o.fac * 100);
    }
    cohorts.concat([refN1]).forEach(function (mm) { (by[mm] ? by[mm].items : []).forEach(function (x) { if (recu(x) && x.pe) nEst++; if (x.paid && !recu(x)) nNonRecu++; }); });
    var ALP = [28, 40, 52, 66, 82, 100];
    var vSeries = cohorts.map(function (mm, i) { return { n: mLabel(mm, true), c: mix('var(--c2)', ALP[i]), w: i === 5 ? 2.6 : 1.6, dots: true, vals: AGES.map(function (a) { return rate(mm, a); }) }; });
    vSeries.push({ n: mLabel(refN1, true) + ' (référence N-1)', c: 'var(--c1)', w: 2, dash: '5 4', dots: true, vals: AGES.map(function (a) { return rate(refN1, a); }) });
    var vRows = cohorts.map(function (mm) {
      var cells = AGES.map(function (a) { return rate(mm, a); }), lastI = -1;
      cells.forEach(function (v, j) { if (v != null) lastI = j; });
      var mmN1 = addM(mm, -12), dN1 = lastI >= 0 ? (cells[lastI] - (rate(mmN1, AGES[lastI]) || 0)) : null;
      if (lastI >= 0 && rate(mmN1, AGES[lastI]) == null) dN1 = null;
      return '<tr>' + td(esc(mLabel(mm, true)) + ' <span class="foot">· ' + keur((by[mm] || {}).fac || 0) + '</span>') + cells.map(function (v) { return v == null ? td('·', 'r', 'color:var(--g3)') : td(fmt(v, 0) + ' %', 'r', 'background:' + mix('var(--c1)', 6 + v * 0.34)); }).join('') +
        td(dN1 == null ? '—' : sgn(dN1, 0) + ' pts', 'r', 'color:' + (dN1 == null ? 'var(--muted)' : dN1 <= -3 ? 'var(--bad)' : dN1 < 0 ? 'var(--warn)' : 'var(--muted)')) + '</tr>';
    });
    vRows.push('<tr class="tot">' + td(esc(mLabel(refN1, true))) + AGES.map(function (a) { var v = rate(refN1, a); return td(v == null ? '·' : fmt(v, 0) + ' %', 'r'); }).join('') + td('référence', 'r') + '</tr>');

    // 5. Risque B2C (financement personnel) : grand livre + dossiers Monday
    var fp = encAt(n, 'Financement personnel'), fpPrev = n >= 12 ? encAt(n - 12, 'Financement personnel') : null;
    var fpItems = S.mo.open.filter(function (o) { return !o.fromPaid && o.fin === 'Financement personnel' && FILE[fileOfItem(o)]; });
    var fpBy = {}; fpItems.forEach(function (o) { var g = o.g.replace(/^\s*[\d.]+\s*/, ''); (fpBy[g] || (fpBy[g] = [0, 0])); fpBy[g][0]++; fpBy[g][1] += o.mt || 0; });
    var fpRows = Object.keys(fpBy).map(function (g) { return { l: g, v: [fpBy[g][1]], tip: g + ' : ' + fpBy[g][0] + ' factures' }; }).sort(function (a, b) { return b.v[0] - a.v[0]; });
    var fpAges = range.slice(-13).map(function (i) { var e = encAt(i, 'Financement personnel'); return { label: mLabel(mOf(i), i === Math.max(0, n - 12) || i === n), segs: [{ v: e.a, c: 'var(--c4)' }, { v: e.bb, c: 'var(--c2)' }, { v: e.c, c: 'var(--c5)' }], tip: dFR(dates[i]) + ' : échu ' + meur(e.echu) }; });

    // 6. Trésorerie hebdo (Monday : échéances, promesses, paiements)
    var cash = cashWeeks();

    // provisions
    var provCols = [];
    for (var pk = lo; pk <= n; pk++) {
      var ec = encAt(pk), req = provRequise(pk);
      provCols.push({ label: mLabel(mOf(pk), pk === lo || pk === n), tip: dFR(dates[pk]) + ' : ' + keur(ec.c) + ' à plus de 180 j, provision requise ' + keur(req), bars: [{ v: ec.c, c: 'var(--c5)' }, { v: req, c: 'var(--c1)' }] });
    }
    var reqN = provRequise(n), finItems = S.mo.open.filter(function (o) { return fileOfItem(o) === 'fin'; });
    var perdus = finItems.filter(function (o) { return /perdu|lost/i.test(o.g); }), conten = finItems.filter(function (o) { return /contentieux/i.test(o.g); });
    var corItems = S.mo.open.filter(function (o) { return fileOfItem(o) === 'cor'; });
    var decisions = [
      ['Provision requise selon vos taux, fin ' + MOIS_L[+m.slice(5, 7) - 1], keur(reqN), 'var(--ink)'],
      ['Provision comptabilisée (au ' + (G.provision.provisionLue ? G.provision.provisionLue.au : '—') + ')', keur(provC), 'var(--ink)'],
      [reqN > provC ? 'Dotation complémentaire à arbitrer' : 'Reprise possible', keur(Math.abs(reqN - provC)), reqN > provC ? 'var(--warn)' : 'var(--good)'],
      ['Dossiers perdus / partiellement perdus (Monday)', perdus.length + ' · ' + keur(sum(perdus, function (o) { return o.mt; })), 'var(--bad)'],
      ['Dossiers en contentieux (Monday)', conten.length + ' · ' + keur(sum(conten, function (o) { return o.mt; })), 'var(--ink)'],
      ['Factures à annuler ou reclasser (Monday)', corItems.length + ' · ' + keur(sum(corItems, function (o) { return o.mt; })), 'var(--ink)']
    ];

    // mois en bref
    var monthRows = N.FINANCEURS.map(function (f) {
      if (S.fin !== 'all' && S.fin !== f) return null;
      var fl = fluxM(m, f), e = encAt(n, f), ep = encAt(n - 1, f), ey = n >= 12 ? encAt(n - 12, f) : null;
      var t = pct(e.echu, e.total), tp = pct(ep.echu, ep.total), ty = ey ? pct(ey.echu, ey.total) : null;
      return { f: f, fac: fl.fac, enc: fl.enc, t: t, d1: t != null && tp != null ? t - tp : null, d2: t != null && ty != null ? t - ty : null, dso: dsoAt(n, f) };
    }).filter(Boolean);
    var flT = fluxM(m), tT = pct(cur.echu, cur.total);
    function dc(x) { return x == null ? 'var(--muted)' : x >= 5 ? 'var(--bad)' : x > 0 ? 'var(--warn)' : x < 0 ? 'var(--good)' : 'var(--muted)'; }
    var monthHtml = table(['Financeur', 'Facturé', 'Encaissé', 'Taux d’échu', 'vs M-1', 'vs N-1', 'DSO'], monthRows.map(function (r) {
      return '<tr>' + td(esc(r.f)) + td(fmt(r.fac / 1000), 'r') + td(fmt(r.enc / 1000), 'r') + td(r.t == null ? '—' : fmt(r.t, 0) + ' %', 'r') + td(sgn(r.d1, 0) + ' pts', 'r', 'color:' + dc(r.d1)) + td(sgn(r.d2, 0) + ' pts', 'r', 'color:' + dc(r.d2)) + td(r.dso == null ? '—' : fmt(r.dso, 0) + ' j', 'r') + '</tr>';
    }).concat(['<tr class="tot">' + td('Total') + td(fmt(flT.fac / 1000), 'r') + td(fmt(flT.enc / 1000), 'r') + td(fmt(tT, 0) + ' %', 'r') + td(sgn(tT - pct(prev.echu, prev.total), 0) + ' pts', 'r') + td(y0 ? sgn(tT - pct(y0.echu, y0.total), 0) + ' pts' : '—', 'r') + td(fmt(dsoS[n], 0) + ' j', 'r') + '</tr>']), { right: [1, 2, 3, 4, 5, 6] });

    var worst = degr.filter(function (s) { return s.dd > 3; }).slice(0, 2);
    var autoComment = [
      'L’encours ' + (cur.total >= prev.total ? 'progresse' : 'recule') + ' de ' + fmt(Math.abs((cur.total / prev.total - 1) * 100), 1) + ' % sur le mois, à ' + meur(cur.total) + ', dont ' + meur(cur.echu) + ' échus (' + fmt(pct(cur.echu, cur.total), 0) + ' %). L’échu à plus de 180 jours atteint ' + meur(cur.c) + (cGrowth != null ? ' (' + sgn(cGrowth, 0) + ' % sur un an)' : '') + ' et le DSO s’établit à ' + fmt(dsoS[n], 0) + ' jours.',
      worst.length ? 'Financeurs qui se dégradent : ' + worst.map(function (s) { return s.n + ' (' + fmt(s.last, 0) + ' % des échéances tombées en retard, ' + sgn(s.dd, 0) + ' pts sur 12 mois)'; }).join(' et ') + '.' : 'Aucun financeur ne se dégrade nettement sur 12 mois.',
      'Provision requise selon vos taux : ' + keur(reqN) + ', pour ' + keur(provC) + ' comptabilisés. Côté Monday : ' + perdus.length + ' dossiers perdus et ' + conten.length + ' en contentieux à arbitrer.'
    ].join('\n\n');
    var commentKey = 'comment:' + m + ':' + S.fin + ':' + S.ent;
    var comment = lsGet(commentKey, null);

    var finOpts = '<option value="all">Tous les financeurs</option>' + N.FINANCEURS.concat(['Interne (Allemagne)', 'Non affecté']).map(function (f) { return '<option' + (S.fin === f ? ' selected' : '') + '>' + esc(f) + '</option>'; }).join('');
    var dateOpts = dates.map(function (d, i) { return '<option value="' + i + '"' + (i === n ? ' selected' : '') + '>' + dFR(d) + '</option>'; }).join('');

    return '<div class="head"><div><h1>Pilotage du recouvrement</h1><p class="lede">Revue mensuelle. Encours d’après le grand livre Pennylane, comparé au mois précédent et au même mois l’an dernier.</p></div>' +
      '<div class="actions"><button class="btn" id="x-pilotage">Exporter Excel</button></div></div>' +
      '<div class="filters"><label>Arrêté au<select id="f-idx">' + dateOpts + '</select></label><label>Financeur<select id="f-fin">' + finOpts + '</select></label>' +
      '<label>Entité<select id="f-ent"><option value="all">Toutes</option><option value="fr"' + (S.ent === 'fr' ? ' selected' : '') + '>France</option><option value="de"' + (S.ent === 'de' ? ' selected' : '') + '>Allemagne</option></select></label></div>' +
      '<div class="kpis">' + kpis.join('') + '</div>' +
      '<div class="grid2">' +
      '<section class="card"><div class="sh"><div><h2><span class="n">1</span>L’encours et son âge</h2><p>Encours clients en fin de mois par ancienneté de l’échu, 13 mois glissants</p></div></div>' +
      legend([['Non échu', 'var(--c6)'], ['Échu 0-90 j', 'var(--c4)'], ['Échu 91-180 j', 'var(--c2)'], ['Échu > 180 j', 'var(--c5)']]) + stackChart(encCols, function (v) { return v ? fmt(v / 1e6, 1) + ' M€' : '0'; }) + '<p class="note">' + encNote + '</p></section>' +
      '<section class="card"><div class="sh"><div><h2><span class="n">2</span>Bridge encours M / M+1</h2><p>' + (brStart != null ? 'L’encours passe de ' + eur(brStart) + ' à ' + eur(brEnd) + ', soit ' + (brEnd - brStart >= 0 ? '+' : '−') + eur(Math.abs(brEnd - brStart)) + '. En rouge ce qui le fait monter, en vert ce qui le fait baisser (grand livre).' : '') + '</p></div></div>' + bridgeHtml + '</section>' +
      '</div>' +
      '<section class="card"><div class="sh"><div><h2><span class="n">3</span>Où se loge le retard, et qui se dégrade</h2><p>En k€, au ' + dFR(dates[n]) + '. Plus la case est foncée, plus le montant pèse. Le DSO se lit contre le délai propre à chaque financeur (cibles dans Réglages).</p></div></div>' +
        '<div class="split"><div style="min-width:0;display:flex;flex-direction:column;gap:14px">' + heatHtml +
      '<div class="sub"><b>Qui se dégrade</b><p class="note">Part des factures arrivées à échéance dans le mois qui sont tombées en retard (réglées après l’échéance, ou toujours impayées), par financeur. Échéance calculée selon les règles de la v1 ; un point porte sur au moins cinq factures échues. Une courbe qui monte est un financeur qui se dégrade.</p>' +
      (degr.length ? lineChart(degr.slice().reverse(), cohMonths.map(function (mm, i) { return mLabel(mm, i === 0 || i === cohMonths.length - 1); }), function (v) { return fmt(v, 0) + ' %'; }, { max: 100 }) +
        '<div class="series">' + degr.map(function (s) { return '<button class="r fin-pick" data-fin="' + esc(s.n) + '" aria-pressed="' + (S.fin === s.n) + '" title="Filtrer la page sur ' + esc(s.n) + '"><i class="sw" style="background:' + s.c + '"></i><span>' + esc(s.n) + '</span><span class="num">' + fmt(s.last, 0) + ' %</span><span class="num" style="color:' + (s.dd >= 5 ? 'var(--bad)' : s.dd <= -5 ? 'var(--good)' : 'var(--muted)') + '">' + sgn(s.dd, 0) + ' pts sur 12 mois</span></button>'; }).join('') + '</div><p class="note">' + (S.fin === 'all' ? 'Cliquez une courbe ou une ligne de la légende pour filtrer toute la page sur ce financeur.' : 'Page filtrée sur ' + esc(S.fin) + '. <button class="btn fin-pick" data-fin="' + esc(S.fin) + '">Retirer le filtre</button>') + '</p>'
        : '<div class="empty">Pas assez de facturation sur la période pour tracer ces courbes.</div>') + '</div>' + '</div><div class="sub"><b>Variation du DSO' + (S.fin === 'all' ? '' : ' · ' + esc(S.fin)) + '</b><p class="note">Délai moyen entre la date de facture et l’encaissement, pondéré par les montants, par mois de règlement (méthode de la v1). ' + (S.fin === 'all' ? 'Tous financements : moyenne pondérée. Cliquez une courbe de « Qui se dégrade » pour un financeur.' : 'Financeur filtré.') + '</p>' + dsoHtml + '</div></div></section>' +
      '<section class="card"><div class="sh"><div><h2><span class="n">4</span>Les cohortes de facturation</h2><p>Part du montant facturé chaque mois effectivement reçue à 30, 60, 90, 120 et 180 jours de la date de facture. Seuls les âges atteints par toute la cohorte sont affichés.</p></div>' +
      '<div class="seg" role="tablist" aria-label="Financeur des cohortes">' + tabs + '</div></div>' +
      '<div class="grid2"><div class="sub">' + lineChart(vSeries, AL, function (v) { return fmt(v, 0) + ' %'; }, { max: 100 }) + legend(vSeries.map(function (s) { return [s.n, s.c]; })) + '</div>' +
      '<div style="display:flex;flex-direction:column;gap:10px;min-width:0">' + table(['Cohorte', '30 j', '60 j', '90 j', '120 j', '180 j', 'vs N-1'], vRows, { right: [1, 2, 3, 4, 5, 6] }) +
      '<p class="note">Reçu = règlement lettré au grand livre ou virement reçu sur Pennylane, à leur date réelle ; sinon paiement enregistré dans Sellsy (tableau « Factures payées »), à sa date de paiement' + (nEst ? ' (estimée par la date de contrôle pour ' + fmt(nEst) + ' factures)' : '') + '. Avoirs exclus. L’écart N-1 compare chaque cohorte au même mois de l’an dernier, au dernier âge atteint.</p></div></div></section>' +
      '<section class="card"><div class="sh"><div><h2><span class="n">5</span>Le risque B2C</h2><p>Financement personnel : l’échu au grand livre et les dossiers ouverts dans Monday.</p></div></div>' +
      '<div class="kpis">' + [
        kpiCard({ l: 'Échu financement personnel', v: meur(fp.echu), sub: fmt(pct(fp.echu, fp.total), 0) + ' % de son encours', icon: ICON.alert, tone: TONE.bad, chips: fpPrev ? deltaChip('vs N-1', (fp.echu / fpPrev.echu - 1) * 100, ' %', true) : '' }),
        kpiCard({ l: 'Échu à plus de 180 j', v: meur(fp.c), sub: fmt(pct(fp.c, fp.echu), 0) + ' % de l’échu B2C', icon: ICON.clock, tone: TONE.warn }),
        kpiCard({ l: 'Dossiers ouverts dans Monday', v: fmt(fpItems.length), sub: keur(sum(fpItems, function (o) { return o.mt; })) + ' restant dû', icon: ICON.users, tone: TONE.info })
      ].join('') + '</div><div class="grid2"><div class="sub"><b>Âge de l’échu B2C</b>' + legend([['0-90 j', 'var(--c4)'], ['91-180 j', 'var(--c2)'], ['> 180 j', 'var(--c5)']]) + stackChart(fpAges, function (v) { return v ? keur(v) : '0'; }) + '</div>' +
      '<div class="sub"><b>Où en sont les dossiers</b><p class="note">Restant dû par groupe Monday du tableau 2.1.</p>' + hbars(fpRows, ['var(--c2)'], keur) + '</div></div>' +
      '<p class="note">Les rejets de prélèvement GoCardless (taux de rejet, rang de la première rupture) demandent l’export GoCardless, qui n’est pas branché sur cette application.</p></section>' +
      '<div class="grid2">' +
      '<section class="card"><div class="sh"><div><h2><span class="n">6</span>Trésorerie : prévu et encaissé</h2><p>Encaissements clients par semaine, en k€.</p></div></div>' +
      legend([['Prévu', 'var(--g3)'], ['Encaissé', 'var(--c1)']]) + groupChart(cash.cols, function (v) { return v ? fmt(v / 1000) : '0'; }, { labels: true }) +
      '<div class="kpis">' + kpiCard({ l: 'Fiabilité du prévisionnel', v: cash.fiab == null ? '—' : fmt(cash.fiab, 1) + ' %', sub: 'encaissé / prévu, 4 dernières semaines', icon: ICON.target, tone: TONE.good }) +
      kpiCard({ l: 'Attendu sur 4 semaines', v: keur(cash.attendu), sub: 'dont ' + keur(cash.promis) + ' de promesses de paiement', icon: ICON.cal, tone: TONE.info }) + '</div>' +
      '<p class="note">' + cash.note + '</p></section>' +
      '<section class="card"><div class="sh"><div><h2>Provisions et décisions du mois</h2><p>Créances échues depuis plus de 180 jours face à la provision que vos taux exigent, en k€</p></div></div>' +
      legend([['Créances > 180 j', 'var(--c5)'], ['Provision requise', 'var(--c1)']]) + groupChart(provCols, function (v) { return v ? fmt(v / 1000) : '0'; }) +
      '<div class="hb">' + decisions.map(function (d) { return '<div class="r" style="grid-template-columns:1fr auto"><span style="white-space:normal">' + esc(d[0]) + '</span><span class="num" style="color:' + d[2] + ';font-weight:600">' + d[1] + '</span></div>'; }).join('') + '</div>' +
      '<a href="#operationnel" data-goto-file="fin">Voir les dossiers dans la file « Clore le dossier » →</a></section>' +
      '</div>' +
      '<div class="sh"><h2>Le mois en bref</h2><span class="foot">' + MOIS_L[+m.slice(5, 7) - 1] + ' ' + m.slice(0, 4) + '</span></div>' +
      '<div class="grid2"><section class="card"><div><b>Par financeur</b><p class="note">Facturé et encaissé du mois en k€ (grand livre), taux d’échu de l’encours et son évolution.</p></div>' + monthHtml + '</section>' +
      '<section class="card"><div class="sh"><b>Commentaire du mois</b>' + chip('brouillon à valider', 'c-warn') + '</div>' +
      '<textarea class="comment" id="comment" aria-label="Commentaire du mois">' + esc(comment != null ? comment : autoComment) + '</textarea>' +
      '<div class="actions"><button class="btn" id="comment-reset">Régénérer à partir des chiffres</button></div><p class="note">Le texte est rédigé à partir des chiffres ci-dessus. Vos modifications restent dans ce navigateur.</p></section></div>';
  }

  function cashWeeks() {
    var thisMon = mondayOf(REF), weeks = [];
    for (var k = -4; k < 4; k++) weeks.push(addD(thisMon, k * 7));
    var prev = {}, promis = {}, enc = {};
    weeks.forEach(function (w) { prev[w] = 0; promis[w] = 0; enc[w] = 0; });
    var first = weeks[0], end = addD(weeks[7], 7);
    function wk(d) { if (!d || d < first || d >= end) return null; return mondayOf(d); }
    calcList().forEach(function (x) {
      if (x.src === 'avoir') return;
      if (S.fin !== 'all' && x.fin !== S.fin) return;
      var w = wk(x.de); if (w && (w < thisMon || !x.paid)) prev[w] += x.mt;
      if (x.paid) { var we = wk(x.dp); if (we) enc[we] += x.mt; }
    });
    S.mo.open.forEach(function (o) {
      if (!o.dpr || o.dpr < REF || o.st2) return;
      if (S.fin !== 'all' && o.fin !== S.fin) return;
      var wp = wk(o.dpr); if (wp) promis[wp] += o.mt || 0;
    });
    var cols = weeks.map(function (w) {
      var past = w < thisMon, bars = [{ v: prev[w] + promis[w], c: 'var(--g3)' }];
      if (past) bars.push({ v: enc[w], c: 'var(--c1)' });
      return { label: 'S' + isoWeek(w), bars: bars, tip: 'Semaine du ' + dFR(w) + (promis[w] ? ' · dont promesses ' + keur(promis[w]) : '') };
    });
    var pe = sum(weeks.slice(0, 4), function (w) { return prev[w]; }), ee = sum(weeks.slice(0, 4), function (w) { return enc[w]; });
    var att = sum(weeks.slice(4), function (w) { return prev[w] + promis[w]; }), pr = sum(weeks.slice(4), function (w) { return promis[w]; });
    return { cols: cols, fiab: pe ? ee / pe * 100 : null, attendu: att, promis: pr,
      note: 'Prévu = factures dont l’échéance calculée (règles v1) tombe dans la semaine, plus les promesses de paiement. Encaissé = factures réglées dont la date de règlement tombe dans la semaine : lettrage du grand livre, virement reçu, ou tableau « Factures payées ».' };
  }

  /* ═════════════════ OPÉRATIONNEL ═════════════════ */
  /* Historique Monday : déplacements de factures entre groupes et tableaux
     (90 derniers jours, limite de Monday). Il donne les entrées et sorties
     de chaque étape, la destination des sorties et le temps passé. */
  var LOG_TYPES = ['move_pulse_from_group', 'move_pulse_from_board', 'move_pulse_into_board', 'create_pulse', 'archive_pulse', 'delete_pulse'];
  var BOARD_BY_ID = {}; N.BOARDS.forEach(function (b) { BOARD_BY_ID[String(b.id)] = b; });
  function stepOf(bkey, title) {
    if (bkey === 'payees') return 'paid';
    if (!bkey || !title) return null;
    var p = N.prefix(title), ov = CFG.overrides[p];
    if (ov) return ov === 'cpt' ? 'cor' : ov;
    return N.fileOf(title);
  }
  function loadLogs(force) {
    if (!S.mcp || S.logs.state === 'run') return;
    if (!force && S.flux && Date.now() - S.flux.fetched < 6 * 3600e3) return;
    var L = S.logs; L.state = 'run'; L.done = 0; L.msg = 'Lecture de l’historique Monday…'; L.total = N.BOARDS.length;
    if (S.view === 'operationnel') render();
    var from = new Date(Date.now() - 89 * 864e5).toISOString().slice(0, 10) + 'T00:00:00Z';
    var ids = N.BOARDS.map(function (b) { return b.id; }), gt = {}, ev = [], seen = {};
    return gql('query { boards(ids: [' + ids.join(',') + ']) { id groups { id title } } }').then(function (d) {
      (d.boards || []).forEach(function (bd) { (bd.groups || []).forEach(function (g) { gt[bd.id + '|' + g.id] = g.title; }); });
      var chain = Promise.resolve();
      N.BOARDS.forEach(function (b) {
        var types = b.paid ? ['move_pulse_into_board'] : LOG_TYPES;
        chain = chain.then(function () {
          var pages = 0;
          function page(cursor) {
            return gql('query { boards(ids: [' + b.id + ']) { activity_logs(limit: 500, from: ' + JSON.stringify(from) + ', event_types: ' + JSON.stringify(types) + (cursor ? ', cursor: ' + JSON.stringify(cursor) : '') + ') { cursor logs { event created_at data } } } }').then(function (r) {
              var al = (((r.boards || [])[0] || {}).activity_logs) || {};
              (al.logs || []).forEach(function (lg) {
                var x; try { x = JSON.parse(lg.data); } catch (e) { return; }
                var t = Math.round(+lg.created_at / 1e4), e = { t: t, n: (x.pulse && x.pulse.name) || x.pulse_name || '', id: String(x.pulse_id || '') };
                if (lg.event === 'move_pulse_from_group') { e.sb = b.key; e.sg = x.source_group && x.source_group.title; e.db = b.key; e.dg = x.dest_group && x.dest_group.title; }
                else if (lg.event === 'move_pulse_from_board' || lg.event === 'move_pulse_into_board') {
                  var sb = BOARD_BY_ID[String(x.source_board && x.source_board.id)], db = BOARD_BY_ID[String(x.dest_board && x.dest_board.id)];
                  e.sb = sb ? sb.key : 'x'; e.sg = x.source_group && x.source_group.title; e.db = db ? db.key : 'x'; e.dg = x.dest_group && x.dest_group.title;
                } else if (lg.event === 'create_pulse') { e.db = b.key; e.dg = gt[b.id + '|' + x.group_id]; e.sb = null; }
                else { e.sb = b.key; e.sg = gt[b.id + '|' + x.group_id]; e.db = null; e.del = 1; }
                var key = x.action_record_uuid || (e.id + '|' + lg.event + '|' + t);
                if (seen[key]) return; seen[key] = 1;
                ev.push(e);
              });
              pages++;
              if (al.cursor && pages < 60 && (al.logs || []).length) return page(al.cursor);
            });
          }
          return page(null).then(function () { L.done++; L.msg = b.nom.split(' ')[0] + ' lu (' + ev.length + ' mouvements)'; var pg = $('#logs-msg'); if (pg) pg.textContent = L.msg; });
        });
      });
      return chain;
    }).then(function () {
      ev.sort(function (a, b) { return a.t - b.t; });
      S.flux = { fetched: Date.now(), from: from.slice(0, 10), ev: ev };
      L.state = 'done'; S._fx = null;
      idb.set('flux', S.flux);
      if (S.view === 'operationnel') render();
    }).catch(function (e) { L.state = 'error'; L.msg = mondayErr(e); if (S.view === 'operationnel') render(); });
  }
  // Index : dernière entrée dans chaque étape, sorties du mois, entrées du mois.
  function fluxIndex(month) {
    if (!S.flux) return null;
    var key = month + '|' + JSON.stringify(CFG.overrides);
    if (S._fx && S._fx.key === key) return S._fx;
    var lastIn = {}, lastStep = {}, out = [], inn = [], paid = paidSet();
    S.flux.ev.forEach(function (e) {
      var sk = e.sb ? stepOf(e.sb, e.sg) : null, dk = e.db ? stepOf(e.db, e.dg) : null;
      if (sk == null && e.del) sk = lastStep[e.n] || null;
      if (sk === dk) return;
      var m = new Date(e.t).toISOString().slice(0, 7);
      if (FILE[sk]) {
        var entered = lastIn[e.n + '|' + sk], dur = entered ? (e.t - entered) / 864e5 : null, cat, avoir = /annul|avoir/i.test(e.sg || '');
        if (dk === 'paid' || paid[e.n] && !FILE[dk]) cat = 'enc';
        else if (FILE[dk]) cat = 'trf';
        else if (avoir) cat = 'avo';
        else if (dk === 'cours') cat = 'trf';
        else cat = 'aut';
        if (m === month) out.push({ n: e.n, k: sk, dk: dk, cat: cat, dur: dur, t: e.t });
      }
      if (FILE[dk]) { lastIn[e.n + '|' + dk] = e.t; if (m === month) inn.push({ n: e.n, k: dk }); }
      if (dk) lastStep[e.n] = dk;
    });
    S._fx = { key: key, lastIn: lastIn, out: out, inn: inn, from: S.flux.from };
    return S._fx;
  }
  function opMonth() { return S.opMonth || REF.slice(0, 7); }
  // Âge du traitement : depuis l’entrée dans l’étape (historique Monday),
  // sinon la date d’étape de Monday, sinon facture / échéance.
  function entryOf(o) {
    var f = fileOfItem(o), fx = S.flux ? fluxIndex(opMonth()) : null;
    var t = fx && fx.lastIn[o.n + '|' + f];
    if (t) return { d: new Date(t).toISOString().slice(0, 10), src: 'hist' };
    if (o.det) return { d: o.det, src: 'col' };
    var r = (FILE[f] && FILE[f].ref === 'facture') ? (o.df || o.de) : (o.de || o.df);
    return r ? { d: r, src: 'ref' } : null;
  }
  function ageItem(o) { var e = entryOf(o); return e ? Math.max(0, days(e.d, REF)) : null; }
  function fileStats(items, k) {
    var its = items.filter(function (o) { return fileOfItem(o) === k; }), cib = CFG.cibleFile[k];
    var ages = its.map(ageItem).filter(function (a) { return a != null; });
    var hors = ages.filter(function (a) { return a > cib; }).length;
    return { k: k, its: its, st: its.length, mt: sum(its, function (o) { return o.mt; }), a: median(ages), c: cib, h: ages.length ? hors / ages.length * 100 : null };
  }
  function hdChip(h) { return h == null ? '—' : chip(fmt(h, 0) + ' %', h >= 60 ? 'c-bad' : h >= 30 ? 'c-warn' : 'c-good'); }
  function miniBar(p, color) { return '<span style="display:inline-block;width:46px;height:5px;border-radius:3px;background:var(--sunk);vertical-align:middle;margin-left:8px;overflow:hidden"><span style="display:block;height:100%;width:' + Math.max(0, Math.min(100, p || 0)).toFixed(0) + '%;background:' + color + '"></span></span>'; }

  function priorityRows(its, k) {
    var cib = CFG.cibleFile[k];
    return its.map(function (o) {
      var r = retard(o), a = ageItem(o), tags = [];
      if (r != null && r > 0) tags.push(['Échue', 'c-bad']);
      if (a != null && a > cib) tags.push(['Hors délai', 'c-bad']);
      if (o.dpr && o.dpr < REF) tags.push(['Promesse non tenue', 'c-bad']);
      if (r != null && r > 180) tags.push(['Passe 6 mois', 'c-bad']);
      if ((o.mt || 0) >= CFG.gros) tags.push(['Gros montant', 'c-warn']);
      if (r != null && r <= 0 && r > -8) tags.push(['Échéance proche', 'c-warn']);
      if (k === 'rec' && (!o.drl || days(o.drl, REF) > CFG.sansAction)) tags.push(['Sans relance ' + CFG.sansAction + ' j', 'c-warn']);
      if (!o.de || o.mt == null) tags.push(['À vérifier données', 'c-info']);
      var score = (o.mt || 0) * (1 + Math.max(0, r || 0) / 30) + (o.dpr && o.dpr < REF ? 1e6 : 0);
      return { o: o, r: r, a: a, tags: tags, score: score };
    }).sort(function (x, y) { return y.score - x.score; });
  }

  var DEST = [['enc', 'Encaissé', 'var(--good)'], ['avo', 'Annulé par un avoir', 'var(--c4)'], ['trf', 'Passé dans une autre étape', 'var(--c1)'], ['aut', 'Sorti sans paiement identifié', 'var(--g3)']];

  function renderOperationnel() {
    var items = openItems(), stats = {}; N.FILES.forEach(function (f) { stats[f.k] = fileStats(items, f.k); });
    var month = opMonth(), fx = fluxIndex(month), inSet = {};
    items.forEach(function (o) { inSet[o.n] = o; });
    var allNames = {}; S.mo.open.forEach(function (o) { allNames[o.n] = o; });
    // entrées / sorties filtrées comme le reste (financeur, entité, recherche) quand la facture est connue
    function passes(n) { var o = allNames[n] || null; if (!o) return S.opFin === 'all' && S.opEnt === 'all' && !S.q; return openItems.pass(o); }
    var flow = {}; N.FILES.forEach(function (f) { flow[f.k] = { e: 0, s: 0, d: { enc: [], avo: [], trf: [], aut: [] }, dur: [] }; });
    if (fx) {
      fx.inn.forEach(function (x) { if (flow[x.k] && passes(x.n)) flow[x.k].e++; });
      fx.out.forEach(function (x) { if (!flow[x.k] || !passes(x.n)) return; flow[x.k].s++; flow[x.k].d[x.cat].push(x); if (x.dur != null) flow[x.k].dur.push(x.dur); });
    }
    var paid = paidSet();
    function amt(x) { var p = paid[x.n]; if (x.cat === 'enc' && p) return p.mt || 0; var o = allNames[x.n]; return o ? (o.mt || 0) : 0; }
    var monthLbl = MOIS_L[+month.slice(5, 7) - 1] + ' ' + month.slice(0, 4);
    var partial = fx && fx.from > month + '-01';

    function vign(k, arrow) {
      var s = stats[k], f = FILE[k];
      return '<button class="fcard" data-file="' + k + '"><span class="t">' + esc(f.n) + '<span>' + esc(f.svc) + '</span></span><span class="big">' + fmt(s.st) + ' <span style="font-size:13px;font-weight:500;color:var(--muted)">factures</span></span>' +
        '<span class="s">' + eurAuto(s.mt) + '</span>' +
        '<span class="s">âge médian du traitement <b class="num" style="color:var(--ink)">' + fmt(s.a) + ' j</b> · cible ' + s.c + ' j</span>' + (s.h == null ? '' : hdChip(s.h).replace('</span>', ' hors délai</span>')) + '</button>' + (arrow ? '<div class="arrow" aria-hidden="true">→</div>' : '');
    }

    // Tableau des étapes, dépliable par problématique pré-échéance
    var mxMt = Math.max.apply(null, N.FILES.map(function (f) { return stats[f.k].mt; }).concat([1]));
    var rows = [];
    N.FILES.forEach(function (f) {
      var s = stats[f.k], fl = flow[f.k], open = !!S.opOpen[f.k];
      rows.push('<tr>' + td('<button class="tog" data-toggle="' + f.k + '" aria-expanded="' + open + '"><span>' + (open ? '▾' : '▸') + '</span>' + esc(f.n) + '</button><br><span class="foot">' + esc(f.d) + '</span>') +
        td(fmt(s.st), 'r') + td(eur(s.mt) + miniBar(s.mt / mxMt * 100, 'var(--c1)'), 'r') + td(fx ? fmt(fl.e) : '—', 'r') + td(fx ? fmt(fl.s) : '—', 'r') +
        td(fmt(s.a) + ' j', 'r') + td(s.c + ' j', 'r') + td(s.h == null ? '—' : fmt(s.h, 1) + ' %' + miniBar(s.h, s.h >= 60 ? 'var(--bad)' : s.h >= 30 ? 'var(--warn)' : 'var(--good)'), 'r') + '</tr>');
      if (open) {
        var g = {}; s.its.forEach(function (o) { var key = o.pb || 'Problématique non renseignée'; (g[key] || (g[key] = [])).push(o); });
        Object.keys(g).sort(function (a, b) { return g[b].length - g[a].length; }).forEach(function (t) {
          var arr = g[t], ages = arr.map(ageItem).filter(function (a) { return a != null; }), h = ages.length ? ages.filter(function (a) { return a > s.c; }).length / ages.length * 100 : null;
          var m2 = sum(arr, function (o) { return o.mt; });
          rows.push('<tr class="subrow">' + td(esc(t)) + td(fmt(arr.length), 'r') + td(eur(m2) + miniBar(m2 / mxMt * 100, 'var(--g2)'), 'r') + td('', 'r') + td('', 'r') + td(fmt(median(ages)) + ' j', 'r') + td(s.c + ' j', 'r') + td(h == null ? '—' : fmt(h, 1) + ' %' + miniBar(h, h >= 60 ? 'var(--bad)' : h >= 30 ? 'var(--warn)' : 'var(--good)'), 'r') + '</tr>');
        });
      }
    });
    var tot = { st: sum(N.FILES, function (f) { return stats[f.k].st; }), mt: sum(N.FILES, function (f) { return stats[f.k].mt; }), e: sum(N.FILES, function (f) { return flow[f.k].e; }), s: sum(N.FILES, function (f) { return flow[f.k].s; }) };
    rows.push('<tr class="tot">' + td('Total circuit') + td(fmt(tot.st), 'r') + td(eur(tot.mt), 'r') + td(fx ? fmt(tot.e) : '—', 'r') + td(fx ? fmt(tot.s) : '—', 'r') + td('', 'r') + td('', 'r') + td('', 'r') + '</tr>');

    // Où sont parties les factures sorties (barres 100 %)
    var logsState = S.logs.state, sortiesHtml;
    if (!fx) {
      sortiesHtml = '<div class="empty">' + (logsState === 'run' ? '<span id="logs-msg">' + esc(S.logs.msg) + '</span>' : logsState === 'error' ? 'L’historique n’a pas pu être lu : ' + esc(S.logs.msg) + '<br><br><button class="btn" id="logs-go">Réessayer</button>'
        : !S.mcp ? 'L’historique se lit dans Monday par le connecteur monday.com, qui n’est pas disponible dans cette vue.' : 'Les entrées, sorties et destinations se lisent dans l’historique Monday.<br><br><button class="btn primary" id="logs-go">Charger l’historique Monday</button>') + '</div>';
    } else {
      var totOut = { enc: [], avo: [], trf: [], aut: [] };
      N.FILES.forEach(function (f) { DEST.forEach(function (d) { totOut[d[0]] = totOut[d[0]].concat(flow[f.k].d[d[0]]); }); });
      var bars = N.FILES.map(function (f) { return { l: f.n, d: flow[f.k].d, s: flow[f.k].s }; });
      bars.push({ l: 'Toutes étapes', d: totOut, s: tot.s, tot: true });
      sortiesHtml = bars.map(function (b) {
        if (!b.s) return '<div class="stk"><div class="stk-h"><b>' + esc(b.l) + '</b><span class="foot">aucune sortie en ' + esc(monthLbl) + '</span></div></div>';
        var seg = DEST.map(function (d) { var n = b.d[d[0]].length, p = n / b.s * 100; return n ? '<div style="width:' + p.toFixed(2) + '%;background:' + d[2] + '" title="' + esc(d[1] + ' : ' + n + ' factures, ' + fmt(p, 1) + ' %') + '">' + (p >= 9 ? fmt(p, 0) + ' %' : '') + '</div>' : ''; }).join('');
        var leg = DEST.map(function (d) { var arr = b.d[d[0]], n = arr.length; if (!n) return ''; var a = sum(arr, amt); return '<span><i class="sw" style="background:' + d[2] + '"></i>' + esc(d[1]) + ' — <b class="num">' + (a ? eur(a) : '') + '</b>' + (a ? ' · ' : '') + fmt(n) + ' factures · ' + fmt(n / b.s * 100, 1) + ' %</span>'; }).join('');
        var dm = median(b.tot ? [].concat.apply([], N.FILES.map(function (f) { return flow[f.k].dur; })) : flow[N.FILES.filter(function (f) { return f.n === b.l; })[0].k].dur);
        return '<div class="stk' + (b.tot ? ' stk-tot' : '') + '"><div class="stk-h"><b>' + esc(b.l) + '</b><span class="foot">' + fmt(b.s) + ' factures sorties' + (dm != null ? ' · restées ' + fmt(dm, 0) + ' j en médiane avant de sortir' : '') + '</span></div><div class="stk-bar">' + seg + '</div><div class="legend stk-l">' + leg + '</div></div>';
      }).join('');
    }

    // Focus sur l’étape choisie
    var k = S.opFile, s = stats[k], f = FILE[k], cib = s.c, fl = flow[k];
    var echues = s.its.filter(function (o) { var r = retard(o); return r != null && r > 0; });
    var prom = s.its.filter(function (o) { return o.dpr; }), promKO = prom.filter(function (o) { return o.dpr < REF; });
    var noRel = k === 'rec' ? s.its.filter(function (o) { return !o.drl || days(o.drl, REF) > CFG.sansAction; }) : [];
    var dmed = median(fl.dur);
    var fk = [
      ['Dans l’étape', fmt(s.st) + ' · ' + eurAuto(s.mt), fx ? fmt(fl.e) + ' entrées, ' + fmt(fl.s) + ' sorties en ' + monthLbl : 'historique non chargé', 'var(--muted)', ICON.inbox, TONE.info],
      ['Âge médian du traitement', fmt(s.a) + ' j', 'cible ' + cib + ' j · ' + (s.h == null ? '—' : fmt(s.h, 0) + ' % hors délai'), s.a > cib ? 'var(--warn)' : 'var(--good)', ICON.clock, TONE.acc],
      ['Délai avant sortie', dmed == null ? '—' : fmt(dmed, 0) + ' j', fx ? 'médiane des factures sorties en ' + monthLbl : 'historique non chargé', 'var(--muted)', ICON.cal, TONE.good],
      k === 'adv' ? ['Échues encore à l’ADV', fmt(echues.length) + ' · ' + eurAuto(sum(echues, function (o) { return o.mt; })), 'en retard sans avoir été rendues payables', 'var(--bad)', ICON.alert, TONE.bad]
        : k === 'rec' ? ['Sans relance depuis ' + CFG.sansAction + ' j', fmt(pct(noRel.length, s.st), 0) + ' %', fmt(noRel.length) + ' dossiers qui dorment', 'var(--bad)', ICON.alert, TONE.bad]
          : ['Promesses de paiement', fmt(prom.length), promKO.length + ' dont la date est passée', promKO.length ? 'var(--warn)' : 'var(--muted)', ICON.alert, TONE.warn]
    ];
    var byG = {}; s.its.forEach(function (o) { var g = o.g.replace(/^\s*[\d.]+\s*/, ''); byG[g] = (byG[g] || 0) + 1; });
    var gRows = Object.keys(byG).map(function (g) { return { l: g, v: [byG[g]] }; }).sort(function (a, b) { return b.v[0] - a.v[0]; });
    var BK = { adv: [5, 10, 20, 30], rec: [15, 30, 90, 180], fin: [90, 180, 365, 730], cor: [15, 30, 60, 120] }[k];
    var bl = ['0-' + BK[0] + ' j', (BK[0] + 1) + '-' + BK[1] + ' j', (BK[1] + 1) + '-' + BK[2] + ' j', (BK[2] + 1) + '-' + BK[3] + ' j', '> ' + BK[3] + ' j'], bc = [0, 0, 0, 0, 0];
    s.its.forEach(function (o) { var a = ageItem(o); if (a == null) return; var j = a <= BK[0] ? 0 : a <= BK[1] ? 1 : a <= BK[2] ? 2 : a <= BK[3] ? 3 : 4; bc[j]++; });
    var ageCols = bl.map(function (l, j) { var lo = j === 0 ? 0 : BK[j - 1]; return { label: l, bars: [{ v: bc[j], c: lo >= cib ? 'var(--c5)' : 'var(--c1)', lab: fmt(bc[j]) }] }; });
    var srcCount = { hist: 0, col: 0, ref: 0 }; s.its.forEach(function (o) { var e = entryOf(o); if (e) srcCount[e.src]++; });
    var pr = priorityRows(s.its, k), top = pr.slice(0, 30);
    var head = ['Facture · client', 'Financement', 'Étape Monday', 'Restant dû', 'Échéance', 'Dans l’étape depuis', 'Priorité'];
    var rowsHtml = top.map(function (p) {
      var o = p.o, who = o.cl || o.ap || '';
      return '<tr>' + td('<a href="' + esc(mondayLink(o)) + '" target="_blank" rel="noopener">' + esc(o.n) + '</a>' + (who ? '<br><span class="foot">' + esc(who) + '</span>' : '')) + td(esc(o.fin)) +
        td(esc(o.g.replace(/^\s*[\d.]+\s*/, '')) + (o.pb ? '<br><span class="foot">' + esc(o.pb) + '</span>' : '') + (o.q ? '<br><span class="foot">' + esc(o.q) + '</span>' : '')) +
        td(eur(o.mt), 'r') + td(o.de ? dFR(o.de) + (p.r != null ? '<br><span class="foot">' + (p.r > 0 ? 'dépassée de ' + p.r + ' j' : p.r === 0 ? 'aujourd’hui' : 'dans ' + (-p.r) + ' j') + '</span>' : '') : '—', 'r') +
        td(p.a == null ? '—' : p.a + ' j', 'r') + td('<div class="tags">' + p.tags.map(function (t) { return chip(t[0], t[1]); }).join('') + '</div>') + '</tr>';
    });

    var months = []; for (var i = 0; i < 4; i++) months.push(addM(REF.slice(0, 7), -i));
    var dateOpts = months.map(function (m, i) { var d = i === 0 ? REF : m + '-' + String(dim(m)).padStart(2, '0'); return '<option value="' + m + '"' + (m === month ? ' selected' : '') + '>' + dFR(d) + (i === 0 ? ' (aujourd’hui)' : '') + '</option>'; }).join('');
    var tabs = N.FILES.map(function (ff) { return '<button role="tab" aria-selected="' + (ff.k === k) + '" data-file="' + ff.k + '">' + esc(ff.n) + '<span class="cnt">' + fmt(stats[ff.k].st) + '</span></button>'; }).join('');
    var CLo = calcList().filter(function (x) { return x.op && !x.paid && x.src !== 'avoir' && calcPass(x); });
    var cEch = CLo.filter(function (x) { return x.de && x.de < REF; }), cNe = CLo.filter(function (x) { return x.de && x.de >= REF; }), cSe = CLo.filter(function (x) { return !x.de; });
    var tR = sum(CLo, function (x) { return x.mt; });
    var portefeuille = '<div class="kpis">' + [
      kpiCard({ l: 'Reste à encaisser', v: eur(tR), sub: fmt(CLo.length) + ' factures non réglées', icon: ICON.wallet, tone: TONE.info }),
      kpiCard({ l: 'En recouvrement', v: eur(sum(cEch, function (x) { return x.mt; })), sub: fmt(cEch.length) + ' factures échues non réglées · ' + fmt(pct(sum(cEch, function (x) { return x.mt; }), tR), 1) + ' % du reste', icon: ICON.alert, tone: TONE.bad }),
      kpiCard({ l: 'Non échu', v: eur(sum(cNe, function (x) { return x.mt; })), sub: fmt(cNe.length) + ' factures pas encore exigibles', icon: ICON.clock, tone: TONE.good }),
      kpiCard({ l: 'Sans échéance', v: eur(sum(cSe, function (x) { return x.mt; })), sub: fmt(cSe.length) + ' factures dont la date manque', icon: ICON.cal, tone: TONE.warn })
    ].join('') + '</div><p class="note">Échéance et avoirs calculés comme dans la v1. Réglé = tableau « Factures payées », lettré au grand livre (au ' + dFR(S.glMeta ? S.glMeta.arrete : '') + ') ou virement reçu sur Pennylane couvrant le reste dû. Les factures réglées ou annulées par avoir sortent des étapes ; les virements reçus non lettrés passent dans « Corriger ».</p>';
    var histLine = S.flux ? 'Historique Monday lu le ' + new Date(S.flux.fetched).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' }) + ', depuis le ' + dFR(S.flux.from) + '.' : '';

    return '<div class="head"><div><h1>Recouvrement opérationnel</h1><p class="lede">Ce qu’il faut traiter, étape par étape du circuit. Les actions se font dans Monday, via le lien de chaque ligne. Factures Monday au ' + dFR(S.mo.at.slice(0, 10)) + '.</p></div>' +
      '<div class="actions">' + (S.flux && S.mcp ? '<button class="btn" id="logs-go">Recharger l’historique</button>' : '') + '<button class="btn" id="x-file">Exporter l’étape</button></div></div>' +
      '<div class="filters"><label>Arrêté au<select id="o-month">' + dateOpts + '</select></label>' +
      '<label>Financeur<select id="o-fin"><option value="all">Tous les financeurs</option>' + N.FINANCEURS.map(function (x) { return '<option' + (S.opFin === x ? ' selected' : '') + '>' + esc(x) + '</option>'; }).join('') + '</select></label>' +
      '<label>Entité<select id="o-ent"><option value="all">Toutes</option><option value="fr"' + (S.opEnt === 'fr' ? ' selected' : '') + '>France</option><option value="de"' + (S.opEnt === 'de' ? ' selected' : '') + '>Allemagne</option></select></label>' +
      '<label>Service concerné<select id="o-svc"><option value="all">Tous les services</option>' + N.FILES.map(function (x) { return '<option value="' + x.k + '"' + (S.opSvc === x.k ? ' selected' : '') + '>' + esc(x.svc) + '</option>'; }).join('') + '</select></label>' +
      '<label>Recherche<input type="search" id="o-q" placeholder="Facture, client, groupe" value="' + esc(S.q) + '"></label>' +
      '<div style="align-self:flex-end"><button class="btn" id="o-reset">Réinitialiser</button></div></div>' +
      portefeuille +
      '<section class="card"><div class="sh"><div><h2><span class="n">1</span>Le circuit</h2><p>Combien de factures à chaque étape, depuis combien de temps elles y sont, face à la cible de traitement.</p></div></div>' +
      '<div class="flow">' + vign('adv', true) + vign('rec', true) + vign('fin') + '</div><div class="sep"><span></span>en parallèle du circuit<span></span></div><div class="flow">' + vign('cor') + '</div>' +
      '<div class="sub"><b>Les étapes du process</b><span class="foot">Entrées et sorties en ' + esc(monthLbl) + (partial ? ' (historique disponible à partir du ' + dFR(fx.from) + ')' : '') + '. Âge du traitement = jours depuis l’entrée dans l’étape. Dépliez une étape pour voir la problématique pré-échéance.</span>' +
      table(['Étape du process', 'Factures', 'Montant', 'Entrées', 'Sorties', 'Âge médian du traitement', 'Cible', '% hors délai'], rows, { right: [1, 2, 3, 4, 5, 6, 7] }) + '</div>' +
      '<div class="sub"><b>Où sont parties les factures sorties d’une étape</b><span class="foot">Sorties de ' + esc(monthLbl) + ', par destination. Les quatre parts s’excluent et totalisent 100 %. ' + histLine + '</span>' + sortiesHtml + '</div></section>' +
      '<section class="card"><div class="sh"><div><h2><span class="n">2</span>Focus sur chaque étape</h2><p>Quoi traiter, pourquoi ça bloque, et est-ce que ça avance</p></div></div>' +
      '<div class="seg" role="tablist" aria-label="Étapes du process">' + tabs + '</div>' +
      '<div class="sh"><b>' + esc(f.n) + ' · ' + esc(f.d) + '</b>' + chip(esc(f.svc), 'c-info') + '</div>' +
      '<div class="kpis">' + fk.map(function (x) { return kpiCard({ l: x[0], v: x[1], sub: '<span style="color:' + x[3] + '">' + esc(x[2]) + '</span>', icon: x[4], tone: x[5] }); }).join('') + '</div>' +
      '<div class="grid2"><div class="sub"><b>Où sont les factures</b><p class="note">Nombre de factures par groupe Monday.</p>' + hbars(gRows, ['var(--c1)']) + '</div>' +
      '<div class="sub"><b>Depuis combien de temps elles sont dans l’étape</b><p class="note">En foncé, au-delà de la cible de ' + cib + ' jours. Date d’entrée : historique Monday pour ' + fmt(srcCount.hist) + ' factures, date d’étape Monday pour ' + fmt(srcCount.col) + ', à défaut ' + (f.ref === 'facture' ? 'date de facture' : 'échéance') + ' pour ' + fmt(srcCount.ref) + '.</p>' +
      legend([['Dans la cible', 'var(--c1)'], ['Hors délai', 'var(--c5)']]) + groupChart(ageCols, function (v) { return fmt(v); }, { labels: true }) + '</div></div>' +
      '<div class="sub"><div class="sh"><b>Liste priorisée</b><span class="foot">' + fmt(Math.min(30, pr.length)) + ' premières lignes sur ' + fmt(pr.length) + ', classées par montant et ancienneté du retard. Le numéro ouvre la facture dans Monday ; « Exporter l’étape » donne toutes les lignes.</span></div>' +
      (top.length ? table(head, rowsHtml, { right: [3, 4, 5] }) : '<div class="empty">Aucune facture dans cette étape avec ces filtres.</div>') + '</div></section>';
  }

  /* ═════════════════ CONTRÔLES ═════════════════ */
  function controls() {
    var all = S.mo.open, tracked = all.filter(function (o) { return FILE[fileOfItem(o)] || fileOfItem(o) === 'cours'; });
    all.forEach(function () { });
    var paid = paidSet(), seen = {}, dup = [];
    all.forEach(function (o) { if (!o.fromPaid) (seen[o.n] || (seen[o.n] = [])).push(o); });
    Object.keys(seen).forEach(function (k) { if (seen[k].length > 1) dup = dup.concat(seen[k]); });
    var C = [
      { k: 'paid', t: 'Réglées mais encore dans une étape Monday', d: 'La facture est réglée (tableau « Factures payées » ou lettrée au grand livre) et figure encore dans un groupe de travail : à sortir du circuit. Elle n’est plus comptée dans les étapes.', rows: all.filter(function (o) { return !o.fromPaid && (o.st2 === 'monday' || o.st2 === 'gl'); }), sev: 'c-bad' },
      { k: 'avoir', t: 'Annulées par avoir mais encore dans une étape Monday', d: 'Soldées par un avoir au grand livre, sans règlement : rien n’est rentré, rien n’est plus dû. Exclues des chiffres, comme dans la v1.', rows: all.filter(function (o) { return o.st2 === 'avoir'; }), sev: 'c-warn' },
      { k: 'nonrecu', t: 'Payées dans Sellsy, non pointées au grand livre', d: 'Le paiement est enregistré dans Sellsy (tableau « Factures payées ») mais la facture reste ouverte dans Pennylane : à pointer. Elle compte comme réglée et figure dans l’étape « Corriger ».', rows: S.mo.paid.filter(function (o) { return o.nl; }), sev: 'c-info' },
      { k: 'vir', t: 'Virement reçu sur Pennylane, non lettré', d: 'Un virement non lettré cite la facture et couvre son reste dû : elle compte comme réglée, et passe dans l’étape « Corriger » pour être lettrée.', rows: all.filter(function (o) { return o.st2 === 'vir'; }), sev: 'c-info' },
      { k: 'advDue', t: 'Échues encore dans « Rendre payable »', d: 'L’échéance est passée alors que la facture n’a pas encore été rendue payable.', rows: all.filter(function (o) { return fileOfItem(o) === 'adv' && o.de && o.de < REF; }), sev: 'c-bad' },
      { k: 'prom', t: 'Promesses de paiement dépassées de plus de 7 jours', d: 'La date promise est passée sans encaissement : relancer ou requalifier.', rows: all.filter(function (o) { return FILE[fileOfItem(o)] && o.dpr && days(o.dpr, REF) > 7; }), sev: 'c-warn' },
      { k: 'dup', t: 'Numéros de facture en double', d: 'Le même numéro apparaît deux fois : deux lignes dans le même groupe, ou la facture suivie dans deux étapes à la fois (par exemple ADV et Recouvrement). Une fiche du tableau Tampon liée à sa copie de travail n’est pas un doublon et n’est pas comptée.', rows: dup, sev: 'c-warn' },
      { k: 'due', t: 'Échéance manquante', d: 'Sans date d’échéance, la facture n’entre ni dans les âges ni dans les retards.', rows: tracked.filter(function (o) { return !o.de; }), sev: 'c-warn' },
      { k: 'amt', t: 'Montant manquant', d: 'Ni reste dû ni total TTC lisible.', rows: tracked.filter(function (o) { return o.mt == null; }), sev: 'c-warn' },
      { k: 'own', t: 'Sans propriétaire', d: 'Personne n’est désigné dans la colonne « Propriétaire ».', rows: all.filter(function (o) { return FILE[fileOfItem(o)] && !o.ow; }), sev: 'c-info' },
      { k: 'other', t: 'Groupes Monday non classés', d: 'Ces groupes ne correspondent à aucune file. Classez-les dans Réglages.', rows: all.filter(function (o) { return fileOfItem(o) === 'autre'; }), sev: 'c-info' }
    ];
    return C;
  }
  function renderControles() {
    var C = controls(), n = S.idx, glRows = [];
    N.FINANCEURS.forEach(function (f) {
      var e = encAt(n, f), mo = S.mo.open.filter(function (o) { return o.fin === f && (FILE[fileOfItem(o)] || fileOfItem(o) === 'cours'); }), mt = sum(mo, function (o) { return o.mt; });
      var echuMo = sum(mo.filter(function (o) { return o.de && o.de < S.gl.dates[n]; }), function (o) { return o.mt; });
      glRows.push('<tr>' + td(esc(f)) + td(fmt(e.total / 1000), 'r') + td(fmt(mt / 1000), 'r') + td(sgn((mt - e.total) / 1000, 0), 'r', 'color:' + (Math.abs(mt - e.total) > 0.1 * Math.abs(e.total) ? 'var(--warn)' : 'var(--muted)')) + td(fmt(e.echu / 1000), 'r') + td(fmt(echuMo / 1000), 'r') + td(sgn((echuMo - e.echu) / 1000, 0), 'r', 'color:' + (Math.abs(echuMo - e.echu) > 0.1 * Math.abs(e.echu) ? 'var(--warn)' : 'var(--muted)')) + '</tr>');
    });
    var cards = C.map(function (c) {
      var mt = sum(c.rows, function (o) { return o.mt; });
      var rows = c.rows.slice(0, 200).map(function (o) { return '<tr>' + td('<a href="' + esc(mondayLink(o)) + '" target="_blank" rel="noopener">' + esc(o.n) + '</a>') + td(esc(o.cl || o.ap || '')) + td(esc(o.g)) + td(eur(o.mt), 'r') + td(dFR(o.de), 'r') + td(esc(o.ow || '—')) + '</tr>'; });
      return '<section class="card qcard"><div class="qhead"><div><b>' + esc(c.t) + '</b><p class="note">' + esc(c.d) + '</p></div><div class="kd">' + chip(fmt(c.rows.length) + ' factures', c.rows.length ? c.sev : 'c-good') + (mt ? chip(eurAuto(mt)) : '') + '</div></div>' +
        (c.rows.length ? '<details><summary>Voir les factures' + (c.rows.length > 200 ? ' (200 premières)' : '') + '</summary>' + table(['Facture', 'Client / apprenant', 'Groupe Monday', 'Montant', 'Échéance', 'Propriétaire'], rows, { right: [3, 4] }) + '</details>' : '') + '</section>';
    });
    return '<div class="head"><div><h1>Contrôles</h1><p class="lede">Ce qui fausse les chiffres ou bloque le traitement : incohérences entre tableaux Monday, données manquantes, écarts avec le grand livre.</p></div>' +
      '<div class="actions"><button class="btn" id="x-controles">Exporter les contrôles</button></div></div>' +
      '<section class="card"><div class="sh"><div><h2>Monday face au grand livre</h2><p>Par financeur, en k€. Grand livre au ' + dFR(S.gl.dates[n]) + ', Monday au ' + dFR(S.mo.at.slice(0, 10)) + ' (files de travail et factures en cours). Un écart de plus de 10 % est signalé.</p></div></div>' +
      table(['Financeur', 'Encours GL', 'Ouvert Monday', 'Écart', 'Échu GL', 'Échu Monday', 'Écart'], glRows, { right: [1, 2, 3, 4, 5, 6] }) + '</section>' + cards.join('');
  }

  /* ═════════════════ RÉGLAGES ═════════════════ */
  function renderReglages() {
    var L = S.live, groups = {};
    S.mo.open.forEach(function (o) { var key = o.b + '|' + o.g; groups[key] = groups[key] || { b: o.b, g: o.g, n: 0, f: o.f }; groups[key].n++; });
    var opts = function (cur) { return N.FILES.map(function (f) { return [f.k, f.n + ' (' + f.svc + ')']; }).concat([['cours', 'En cours (pas à traiter)'], ['autre', 'Non classé']]).map(function (x) { return '<option value="' + x[0] + '"' + (cur === x[0] ? ' selected' : '') + '>' + esc(x[1]) + '</option>'; }).join(''); };
    var gRows = Object.keys(groups).sort(function (a, b) { return groups[a].g.localeCompare(groups[b].g, 'fr', { numeric: true }); }).map(function (key) {
      var g = groups[key], p = N.prefix(g.g), cur = CFG.overrides[p] || g.f;
      return '<tr>' + td(esc(g.g)) + td(fmt(g.n), 'r') + td('<select class="field" data-group="' + esc(p) + '" aria-label="File du groupe ' + esc(g.g) + '">' + opts(cur) + '</select>') + '</tr>';
    });
    var mcpTxt = !S.mcp ? 'Le connecteur n’est pas disponible dans cette vue (page ouverte hors de claude.ai, ou connecteurs non autorisés pour cette page).' : 'Le connecteur monday.com est utilisé avec votre compte : la première actualisation vous demande l’autorisation.';
    return '<div class="head"><div><h1>Réglages</h1><p class="lede">Sources de données, actualisation Monday, cibles et classement des groupes. Les réglages restent dans ce navigateur.</p></div></div>' +
      '<section class="card"><div class="sh"><div><h2>Sources</h2><p>D’où viennent les chiffres de chaque onglet.</p></div></div>' +
      table(['Source', 'Utilisée pour', 'Date', 'Contenu'], [
        '<tr>' + td('<b>Monday</b> · ' + (S.moSource === 'live' ? 'actualisé par le connecteur' : 'instantané repris de la v1')) + td('Opérationnel, Contrôles, trésorerie hebdo, risque B2C') + td(dFR(S.mo.at.slice(0, 10)) + ' ' + S.mo.at.slice(11, 16), 'r') + td(fmt(S.mo.open.length) + ' factures ouvertes · ' + fmt(S.mo.paid.length) + ' payées') + '</tr>',
        '<tr>' + td('<b>Grand livre Pennylane</b>') + td('Pilotage, Contrôles') + td(dFR(S.gl.arrete), 'r') + td(esc(S.gl.source) + ' · 13 fins de mois') + '</tr>',
        '<tr>' + td('<b>Grand livre détaillé</b> · balance âgée Liora') + td('Factures réglées (lettrage), annulées par avoir, virements reçus non lettrés') + td(dFR(S.glMeta ? S.glMeta.arrete : ''), 'r') + td(fmt(Object.keys(S.glMap || {}).length) + ' factures') + '</tr>',
        '<tr>' + td('<b>GoCardless</b>') + td('Rejets de prélèvement') + td('—', 'r') + td('Non branché') + '</tr>'
      ], { right: [2] }) +
      '<div class="sub"><div class="sh"><div><b>Actualiser depuis Monday</b><p class="note">' + mcpTxt + ' Lit les 9 tableaux (' + N.BOARDS.map(function (b) { return b.nom.split(' ')[0]; }).join(', ') + '), groupe par groupe, sans les groupes techniques. Compter deux à quatre minutes.</p></div>' +
      '<div class="actions"><button class="btn primary" id="live-go"' + (L.state === 'run' || !S.mcp ? ' disabled' : '') + '>' + (L.state === 'run' ? 'Actualisation en cours…' : 'Actualiser depuis Monday') + '</button>' +
      (S.moSource === 'live' ? '<button class="btn" id="live-reset">Revenir à l’instantané</button>' : '') + '</div></div>' +
      (L.state !== 'idle' ? '<div class="progress"><div style="width:' + (L.total ? L.done / L.total * 100 : 3).toFixed(1) + '%"></div></div><div class="log" id="live-log">' + esc(L.log.slice(-40).join('\n')) + '</div>' : '') + '</div></section>' +
      '<section class="card"><div class="sh"><div><h2>Règles de calcul</h2><p>Les mêmes que la v1 (son moteur tourne dans cette application), sauf la définition du réglé.</p></div></div>' +
      '<div class="sub"><b>Une facture est réglée</b><p class="note">si elle est dans le tableau Monday « Factures payées », ou soldée par un règlement au grand livre (lettrée), ou couverte par un virement reçu sur Pennylane non encore lettré qui la cite. Elle est <b>annulée par avoir</b> si le grand livre la solde par un avoir sans règlement : elle sort alors des chiffres, comme dans la v1.</p></div>' +
      table(['Dispositif', 'Échéance calculée'], window.LioraRules.DEFAULT_ECHEANCE_RULES.map(function (r) { return '<tr>' + td(esc(r.label)) + td(esc(r.note || '')) + '</tr>'; })) + '</section>' +
      '<section class="card"><div class="sh"><div><h2>Cibles</h2><p>Elles colorent les DSO, les âges et les « hors délai ».</p></div><button class="btn" id="cfg-reset">Rétablir les valeurs par défaut</button></div>' +
      '<b>DSO cible par financeur (jours)</b><div class="formgrid">' + N.FINANCEURS.map(function (f, i) { return '<label for="dso-' + i + '">' + esc(f) + '<input class="field" id="dso-' + i + '" type="number" min="0" data-dso="' + esc(f) + '" value="' + CFG.dsoCible[f] + '"></label>'; }).join('') +
      '<label for="dso-g">Global<input class="field" id="dso-g" type="number" min="0" data-cfg="dsoGlobal" value="' + CFG.dsoGlobal + '"></label><label for="cei-c">CEI cible (%)<input class="field" id="cei-c" type="number" min="0" max="100" data-cfg="ceiCible" value="' + CFG.ceiCible + '"></label></div>' +
      '<b>Délai cible par file (jours)</b><div class="formgrid">' + N.FILES.map(function (f) { return '<label for="cf-' + f.k + '">' + esc(f.n) + '<input class="field" id="cf-' + f.k + '" type="number" min="0" data-file-cible="' + f.k + '" value="' + CFG.cibleFile[f.k] + '"></label>'; }).join('') + '</div>' +
      '<b>Seuils</b><div class="formgrid"><label for="cfg-gros">Gros montant (€)<input class="field" id="cfg-gros" type="number" min="0" data-cfg="gros" value="' + CFG.gros + '"></label><label for="cfg-sa">Sans relance après (jours)<input class="field" id="cfg-sa" type="number" min="0" data-cfg="sansAction" value="' + CFG.sansAction + '"></label></div>' +
      '<b>Taux de provision (grand livre)</b>' + table(['Type de client'].concat(S.gl.provision.fenetres.map(function (w) { return w.label; })), Object.keys(S.gl.provision.taux).map(function (t) { return '<tr>' + td(esc(t)) + S.gl.provision.taux[t].map(function (v) { return td(fmt(v * 100, 0) + ' %', 'r'); }).join('') + '</tr>'; }), { right: [1, 2, 3, 4] }) + '</section>' +
      '<section class="card"><div class="sh"><div><h2>Classement des groupes Monday</h2><p>Chaque groupe alimente une file de travail. « En cours » = factures suivies mais pas encore à traiter.</p></div></div>' + table(['Groupe', 'Factures', 'File'], gRows, { right: [1] }) + '</section>';
  }

  /* ───────── actualisation Monday (connecteur) ───────── */
  function mondayErr(e) {
    var c = e && e.code;
    if (c === 'server_not_connected') return 'Le connecteur monday.com n’est pas ajouté à votre compte : ajoutez-le dans claude.ai, Réglages → Connecteurs.';
    if (c === 'needs_reauth') return 'La connexion monday.com a expiré : reconnectez-la dans claude.ai, Réglages → Connecteurs.';
    if (c === 'not_in_manifest' || c === 'approval_required' || c === 'consent_required') return 'L’accès à monday.com n’a pas été autorisé pour cette page. Relancez l’actualisation et acceptez la demande.';
    if (c === 'blocked_by_policy') return 'Votre organisation bloque cet outil monday.com pour votre compte.';
    if (c === 'selection_required') return 'Plusieurs connecteurs monday.com existent : choisissez-en un dans la fenêtre proposée par claude.ai.';
    if (c === 'server_unavailable') return 'monday.com ne répond pas pour le moment. Réessayez dans quelques minutes.';
    return (e && e.message) || String(e);
  }
  function gql(query) {
    var call = function () { return S.mcp.callTool('monday.com', 'all_monday_api', { query: query, variables: '{}' }, { cache: false }); };
    return call().catch(function (e) {
      if (e && e.retryable) return new Promise(function (r) { setTimeout(r, (e.retryAfterMs || 1500) + Math.random() * 800); }).then(call);
      throw e;
    }).then(function (r) {
      var p = r.payload;
      if (typeof p === 'string') { try { p = JSON.parse(p); } catch (x) { throw new Error('Réponse Monday illisible : ' + p.slice(0, 160)); } }
      if (p && p.errors && p.errors.length) throw new Error('Monday : ' + p.errors.map(function (x) { return x.message; }).join(' · '));
      if (p && p.data) p = p.data;
      return p;
    });
  }
  var CV = '{ id type text value ... on MirrorValue { display_value } ... on FormulaValue { display_value } ... on BoardRelationValue { display_value } ... on DependencyValue { display_value } }';
  // Le moteur de la v1 sur les éléments lus en direct : mêmes colonnes
  // reconnues, même consolidation, mêmes règles d’échéance.
  function calcFromLive(raw, refISO) {
    var R = window.LioraRules, I = window.LioraIngest, M = window.LioraMonday, all = [];
    Object.keys(raw).forEach(function (id) {
      var x = raw[id], d = R.detectBoardRole(x.board.name), ech = x.items.slice(0, 200);
      var valeursDe = function (colId) { return ech.map(function (it) { var cv = (it.column_values || []).filter(function (c) { return c.id === colId; })[0]; return cv ? M.columnValue(cv) : ''; }); };
      var cfg = { role: d.role === 'ignore' ? 'adv' : d.role, perimetre: d.perimetre === 'Inconnu' ? 'Corporate' : d.perimetre, source: d.source || 'adv', financementDefaut: d.financementDefaut, columns: x.columns };
      cfg.mapping = I.autoMapColumns(x.columns, valeursDe).mapping;
      all = all.concat(I.facturesFromMondayBoard(x.board, x.items, cfg.mapping, cfg));
    });
    var p = refISO.split('-');
    return window.LioraEngine.compute(all, new Date(+p[0], +p[1] - 1, +p[2]), S.glMap);
  }
  function liveRefresh() {
    var L = S.live; L.state = 'run'; L.log = ['Lecture de la structure des 9 tableaux…']; L.done = 0; L.total = 1;
    var log = function (t) { L.log.push(t); var el = $('#live-log'); if (el) { el.textContent = L.log.slice(-40).join('\n'); el.scrollTop = 1e6; } var pg = $('.progress>div'); if (pg) pg.style.width = (L.total ? L.done / L.total * 100 : 3).toFixed(1) + '%'; };
    render();
    var ids = N.BOARDS.map(function (b) { return b.id; });
    var out = { open: [], paid: [] }, jobs = [];
    var raw = {};
    return gql('query { boards(ids: [' + ids.join(',') + ']) { id name columns { id title type } groups { id title } } }').then(function (d) {
      (d.boards || []).forEach(function (bd) {
        var b = N.BOARDS.filter(function (x) { return String(x.id) === String(bd.id); })[0]; if (!b) return;
        var cols = {}; (bd.columns || []).forEach(function (c) { cols[c.id] = N.norm(c.title); });
        raw[b.id] = { board: { id: String(bd.id), name: bd.name || b.nom }, columns: bd.columns || [], items: [] };
        (bd.groups || []).forEach(function (g) {
          if (b.paid ? N.technique(g.title) : N.fileOf(g.title) == null) return;
          jobs.push({ b: b, g: g, cols: cols });
        });
      });
      L.total = jobs.length + 1; L.done = 1;
      log(jobs.length + ' groupes à lire.');
      var i = 0;
      function worker() {
        if (i >= jobs.length) return Promise.resolve();
        var j = jobs[i++];
        return readGroup(j).then(function (n) { L.done++; log(j.b.nom.split(' ')[0] + ' · ' + j.g.title + ' : ' + n + ' factures'); return worker(); });
      }
      function readGroup(j) {
        var sel = 'cursor items { id name column_values ' + CV + ' }', n = 0;
        function take(items) {
          (items || []).forEach(function (it) {
            it.group = { id: j.g.id, title: j.g.title }; raw[j.b.id].items.push(it);
            var map = {}; (it.column_values || []).forEach(function (cv) { var t = j.cols[cv.id]; if (t && (map[t] == null || map[t] === '')) map[t] = N.cvText(cv); });
            var rec = N.record(j.b, j.g.title, it.name, map, it.id);
            if (rec) { Object.keys(rec).forEach(function (k) { if (rec[k] === '' || rec[k] == null) delete rec[k]; }); (j.b.paid ? out.paid : out.open).push(rec); n++; }
          });
        }
        function next(cursor) {
          if (!cursor) return Promise.resolve(n);
          return gql('query { next_items_page(cursor: ' + JSON.stringify(cursor) + ', limit: 250) { ' + sel + ' } }').then(function (d2) { var p = d2.next_items_page || {}; take(p.items); return next(p.cursor); });
        }
        return gql('query { boards(ids: [' + j.b.id + ']) { groups(ids: [' + JSON.stringify(j.g.id) + ']) { items_page(limit: 250) { ' + sel + ' } } } }').then(function (d1) {
          var g = (((d1.boards || [])[0] || {}).groups || [])[0], p = (g && g.items_page) || {};
          take(p.items); return next(p.cursor);
        });
      }
      return Promise.all([worker(), worker(), worker()]);
    }).then(function () {
      var now = new Date(), at = new Date(now.getTime() - now.getTimezoneOffset() * 6e4).toISOString().slice(0, 19);
      var mo = { at: at, source: 'Connecteur monday.com', open: out.open, paid: out.paid };
      log('Calcul des échéances et des règlements (moteur de la v1)…');
      S.calc = calcFromLive(raw, at.slice(0, 10));
      setMonday(mo, 'live');
      log('Terminé : ' + out.open.length + ' factures ouvertes, ' + out.paid.length + ' payées.');
      L.state = 'done';
      return idb.set('monday', mo).then(function () { return idb.set('calc', S.calc); }).then(function () { return pushHistory(mo); });
    }).then(function () { render(); toast('Données Monday actualisées.'); }).catch(function (e) {
      L.state = 'error'; log('Arrêt : ' + mondayErr(e)); render(); toast(mondayErr(e));
    });
  }
  // Le tableau Tampon porte la fiche d’origine de la facture ; les tableaux
  // ADV, Recouvrement, OPCO… en sont des copies liées (« Espace tampon »).
  // Quand les deux existent, c’est une seule facture : on garde la copie de travail.
  function dedupeTampon(mo) {
    var other = {}; mo.open.forEach(function (o) { if (o.b !== 'tampon') other[o.n] = 1; });
    var before = mo.open.length;
    mo.open = mo.open.filter(function (o) { return o.b !== 'tampon' || !other[o.n]; });
    mo.tamponLies = before - mo.open.length;
    return mo;
  }
  // Échéance, montant et dispositif tels que la v1 les calcule ; statut réglé / avoir.
  function applyCalc(mo) {
    var E = window.LioraEngine;
    function one(o) {
      var v = S.calc[E.key(o.n)];
      if (o.deM === undefined) { o.deM = o.de || null; o.mtM = o.mt; }
      if (!v) { o.st2 = ''; return; }
      o.de = v.de || null; o.eb = v.eb; o.dl = v.rl;
      if (v.mt != null) o.mt = v.mt;
      if (v.rl && CAT_FIN[v.rl]) o.fin = CAT_FIN[v.rl];
      o.st2 = v.src; o.dpay = v.dp;
      o.nl = v.src === 'monday' && v.gs === 'o';
    }
    mo.open.forEach(one); mo.paid.forEach(one);
  }
  // Univers des factures vu par le calcul v1, avec le financeur v2.
  function calcList() {
    if (S._cl) return S._cl;
    S._cl = Object.keys(S.calc).map(function (k) { var v = S.calc[k]; return { k: k, n: v.n, de: v.de, mt: v.mt || 0, fin: CAT_FIN[v.rl] || 'Non affecté', rl: v.rl, src: v.src, paid: v.paid, dp: v.dp, df: v.df, op: v.op, gs: v.gs || '', pe: !!v.pe }; });
    return S._cl;
  }
  function calcPass(x) {
    if (S.opFin !== 'all' && x.fin !== S.opFin) return false;
    var de = /allemagne|interco/i.test(x.rl || '');
    if (S.opEnt === 'de' && !de) return false;
    if (S.opEnt === 'fr' && de) return false;
    return true;
  }
  function setMonday(mo, src) {
    mo.open = mo.open.filter(function (o) { return !o.fromPaid; });
    dedupeTampon(mo);
    S._cl = null;
    applyCalc(mo);
    var enCours = {}; mo.open.forEach(function (o) { enCours[o.n] = 1; });
    mo.paid.forEach(function (p) {
      if (!p.nl || enCours[p.n]) return;
      mo.open.push(Object.assign({}, p, { fromPaid: true, f: 'cor', pb: 'Payée dans Sellsy, non pointée au grand livre' }));
    });
    S.mo = mo; S.moSource = src; S._paidSet = null; S._fx = null;
    var d = mo.at.slice(0, 10);
    REF = d;
  }

  /* ───────── rendu & événements ───────── */
  function renderFresh() {
    var moDate = S.mo ? dFR(S.mo.at.slice(0, 10)) + ' à ' + S.mo.at.slice(11, 16).replace(':', 'h') : '—';
    $('#fresh').innerHTML = '<span><i class="dot ' + (S.moSource === 'live' ? 'ok' : 'warn') + '"></i>Monday · ' + moDate + (S.moSource === 'live' ? '' : ' (instantané)') + '</span>' +
      '<span><i class="dot ok"></i>Grand livre · ' + (S.gl ? dFR(S.gl.arrete).slice(0, 5) : '—') + '</span><span><i class="dot off"></i>GoCardless · non branché</span>';
  }
  function render() {
    if (!S.gl || !S.mo) return;
    document.querySelectorAll('.tabs a').forEach(function (a) { if (a.dataset.view === S.view) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
    var html;
    try {
      html = S.view === 'operationnel' ? renderOperationnel() : S.view === 'controles' ? renderControles() : S.view === 'reglages' ? renderReglages() : renderPilotage();
    } catch (e) { html = '<div class="empty">Cet onglet n’a pas pu être calculé : ' + esc(e.message) + '</div>'; console.error(e); }
    $('#view').innerHTML = html;
    var nC = controls().filter(function (c) { return c.rows.length && c.sev !== 'c-info'; }).length;
    $('#cnt-controles').textContent = nC ? nC + ' alertes' : 'ok';
    renderFresh();
  }
  function route() {
    var h = (location.hash || '').replace('#', '');
    S.view = ['pilotage', 'operationnel', 'controles', 'reglages'].indexOf(h) >= 0 ? h : 'pilotage';
    lsSet('view', S.view);
    render();
    if (S.view === 'operationnel') loadLogs(false);
    window.scrollTo(0, 0);
  }
  window.addEventListener('hashchange', route);

  document.addEventListener('change', function (ev) {
    var t = ev.target;
    if (t.id === 'f-idx') { S.idx = +t.value; render(); }
    else if (t.id === 'f-fin') { S.fin = t.value; if (N.FINANCEURS.indexOf(t.value) >= 0 || t.value === 'all') S.opFin = t.value; render(); }
    else if (t.id === 'f-ent') { S.ent = t.value; render(); }
    else if (t.id === 'o-month') { S.opMonth = t.value; S._fx = null; render(); }
    else if (t.id === 'o-ent') { S.opEnt = t.value; render(); }
    else if (t.id === 'o-svc') { S.opSvc = t.value; if (t.value !== 'all') S.opFile = t.value; render(); }
    else if (t.id === 'o-fin') { S.opFin = t.value; S.fin = t.value; render(); }
    else if (t.dataset.group != null) { var g = N.GROUP_FILE[t.dataset.group]; if (t.value === g) delete CFG.overrides[t.dataset.group]; else CFG.overrides[t.dataset.group] = t.value; saveCfg(); toast('Classement enregistré.'); }
    else if (t.dataset.dso) { CFG.dsoCible[t.dataset.dso] = +t.value || 0; saveCfg(); }
    else if (t.dataset.fileCible) { CFG.cibleFile[t.dataset.fileCible] = +t.value || 0; saveCfg(); }
    else if (t.dataset.cfg) { CFG[t.dataset.cfg] = +t.value || 0; saveCfg(); }
  });
  var qTimer;
  document.addEventListener('input', function (ev) {
    var t = ev.target;
    if (t.id === 'o-q') { clearTimeout(qTimer); qTimer = setTimeout(function () { S.q = t.value; var pos = t.selectionStart; render(); var n = $('#o-q'); if (n) { n.focus(); try { n.setSelectionRange(pos, pos); } catch (e) { } } }, 250); }
    else if (t.id === 'comment') { lsSet('comment:' + mOf(S.idx) + ':' + S.fin + ':' + S.ent, t.value); }
  });
  document.addEventListener('click', function (ev) {
    var pf = ev.target.closest('[data-fin]');
    if (pf) { var nf = S.fin === pf.getAttribute('data-fin') ? 'all' : pf.getAttribute('data-fin'); S.fin = nf; S.opFin = nf; S._fx = null; render(); toast(nf === 'all' ? 'Filtre financeur retiré.' : 'Page filtrée sur ' + nf + '.'); return; }
    var t = ev.target.closest('button,a'); if (!t) return;
    if (t.dataset.cohort) { S.cohort = t.dataset.cohort; render(); }
    else if (t.dataset.file && (t.classList.contains('fcard') || t.getAttribute('role') === 'tab')) { S.opFile = t.dataset.file; render(); if (t.classList.contains('fcard')) { var tl = document.querySelector('[aria-label="Files de travail"]'); if (tl) tl.scrollIntoView({ block: 'start' }); } }
    else if (t.dataset.toggle) { S.opOpen[t.dataset.toggle] = !S.opOpen[t.dataset.toggle]; render(); }
    else if (t.id === 'o-reset') { S.opFin = 'all'; S.opEnt = 'all'; S.opSvc = 'all'; S.opMonth = null; S.q = ''; S._fx = null; render(); }
    else if (t.id === 'logs-go') { loadLogs(true); }
    else if (t.dataset.gotoFile) { S.opFile = t.dataset.gotoFile; }
    else if (t.id === 'comment-reset') { lsSet('comment:' + mOf(S.idx) + ':' + S.fin + ':' + S.ent, null); try { localStorage.removeItem('srv2:comment:' + mOf(S.idx) + ':' + S.fin + ':' + S.ent); } catch (e) { } render(); }
    else if (t.id === 'live-go') { if (!S.mcp) toast('Le connecteur monday.com n’est pas disponible dans cette vue.'); else liveRefresh(); }
    else if (t.id === 'live-reset') { idb.del('monday'); idb.del('calc'); loadSnapshot().then(function () { render(); toast('Instantané rétabli.'); }); }
    else if (t.id === 'cfg-reset') { var ov = CFG.overrides; CFG = JSON.parse(JSON.stringify(DEFAULTS)); CFG.overrides = ov; saveCfg(); render(); toast('Cibles rétablies.'); }
    else if (t.id === 'x-pilotage') exportPilotage();
    else if (t.id === 'x-file') exportFile();
    else if (t.id === 'x-controles') exportControles();
  });

  function exportPilotage() {
    var rows = [['Fin de mois', 'Encours', 'Non échu', 'Échu', 'Échu 0-90 j', 'Échu 91-180 j', 'Échu > 180 j', 'Taux d’échu', 'DSO (j)', 'CEI (%)', 'Facturé du mois', 'Encaissé du mois']];
    for (var i = 0; i <= S.idx; i++) { var e = encAt(i), fl = fluxM(mOf(i)); rows.push([S.gl.dates[i], Math.round(e.total), Math.round(e.ne), Math.round(e.echu), Math.round(e.a), Math.round(e.bb), Math.round(e.c), +(pct(e.echu, e.total) || 0).toFixed(1), dsoAt(i) == null ? '' : +dsoAt(i).toFixed(0), ceiAt(i) == null ? '' : +ceiAt(i).toFixed(1), Math.round(fl.fac), Math.round(fl.enc)]); }
    var r2 = [['Financeur', 'Non échu', '0-3 mois', '3-6 mois', '6-12 mois', '12-24 mois', '> 24 mois', 'Total', 'DSO (j)', 'DSO cible (j)']];
    N.FINANCEURS.forEach(function (f) { var e = encAt(S.idx, f); r2.push([f, Math.round(e.ne), Math.round(e.b[0]), Math.round(e.b[1] + e.b[2]), Math.round(e.b[3]), Math.round(e.b[4] + e.b[5]), Math.round(e.b[6] + e.b[7] + e.b[8]), Math.round(e.total), dsoAt(S.idx, f) == null ? '' : Math.round(dsoAt(S.idx, f)), CFG.dsoCible[f]]); });
    exportXlsx('pilotage-recouvrement-' + S.gl.dates[S.idx] + '.xlsx', [{ name: 'Encours mensuel', rows: rows }, { name: 'Retard par financeur', rows: r2 }]);
  }
  function itemRow(o) { return [o.n, o.fin, o.cl || '', o.ap || '', o.g, FILE[fileOfItem(o)] ? FILE[fileOfItem(o)].n : fileOfItem(o), o.mt, o.de || '', o.df || '', retard(o), ageItem(o), o.ow || '', o.e || '', o.q || '', o.dpr || '', o.drl || '', mondayLink(o)]; }
  var ITEM_HEAD = ['Facture', 'Financement', 'Client', 'Apprenant', 'Groupe Monday', 'File', 'Restant dû', 'Échéance', 'Date facture', 'Jours de retard', 'Âge dans la file', 'Propriétaire', 'Étape process', 'Qualification', 'Promesse de paiement', 'Dernière relance', 'Lien Monday'];
  function exportFile() {
    var k = S.opFile, pr = priorityRows(openItems().filter(function (o) { return fileOfItem(o) === k; }), k);
    exportXlsx('etape-' + FILE[k].n.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '-' + REF + '.xlsx', [{ name: FILE[k].n, rows: [ITEM_HEAD.concat(['Priorité'])].concat(pr.map(function (p) { return itemRow(p.o).concat([p.tags.map(function (t) { return t[0]; }).join(', ')]); })) }]);
  }
  function exportControles() {
    exportXlsx('controles-recouvrement-' + REF + '.xlsx', controls().filter(function (c) { return c.rows.length; }).map(function (c) { return { name: c.t.replace(/[\\\/?*\[\]:]/g, ' ').slice(0, 31), rows: [ITEM_HEAD].concat(c.rows.map(itemRow)) }; }));
  }

  /* ───────── chargement ───────── */
  function getJSON(u) { return fetch(u).then(function (r) { if (!r.ok) throw new Error(u + ' : HTTP ' + r.status); return r.json(); }); }
  function loadSnapshot() { return Promise.all([getJSON('data/monday.json'), getJSON('data/v1calc.json')]).then(function (r) { S.calc = r[1]; setMonday(r[0], 'snapshot'); return r[0]; }); }
  Promise.all([getJSON('data/pilotage.json'), idb.get('monday'), idb.get('history'), idb.get('flux'), getJSON('data/v1calc.json'), getJSON('data/gl.json'), idb.get('calc')]).then(function (r) {
    S.gl = r[0]; S.idx = S.gl.dates.length - 1; S.history = r[2] || []; S.flux = r[3] || null;
    S.glMap = r[5].m; S.glMeta = { arrete: r[5].arrete, source: r[5].source };
    S.calc = (r[1] && r[6]) ? r[6] : r[4];
    var first = r[1] ? Promise.resolve(setMonday(r[1], 'live')) : loadSnapshot();
    return first.then(function () {
      if (!S.history.length) return loadSnapshotForHistory();
    });
  }).then(function () {
    if (!location.hash) { var v = lsGet('view', 'pilotage'); if (v !== 'pilotage') { location.hash = v; return; } }
    route();
  }).catch(function (e) {
    $('#view').innerHTML = '<div class="empty">Les données n’ont pas pu être chargées : ' + esc(e.message) + '</div>';
  });
  function loadSnapshotForHistory() {
    if (S.moSource === 'snapshot') return pushHistory(S.mo);
    return getJSON('data/monday.json').then(function (mo) { var keep = S.mo; S.history = []; var s = snapshotOf(mo); S.history.push(s); return pushHistory(keep); });
  }

  if (window.claude && typeof claude.use === 'function') {
    claude.use('mcp').then(function (m) { S.mcp = m; if (S.view === 'reglages' || S.view === 'operationnel') render(); if (m && S.view === 'operationnel') loadLogs(false); }, function () { S.mcp = null; });
    claude.use('downloads').then(function (d) { S.downloads = d; }, function () { S.downloads = null; });
  } else { S.mcp = null; }
})();
