/* Suivi recouvrement v2 — calcul aligné sur la v1.
   Le moteur de la v1 (règles d'échéance, table Zoho, consolidation) tourne
   tel quel ; ce module n'ajoute que la définition du « réglé » retenue pour
   la v2 et l'exclusion des factures annulées par avoir :
     réglé  = tableau Monday « Factures payées »
            ou facture soldée par règlement au grand livre (lettrée)
            ou virement reçu sur Pennylane, non lettré, couvrant le reste dû
     avoir  = facture soldée par un avoir au grand livre (règle de la v1). */
(function (G) {
  'use strict';
  function iso(d) {
    if (!d) return undefined;
    if (typeof d === 'string') return d.slice(0, 10);
    return new Date(d.getTime() - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 10);
  }
  function key(n) { return G.LioraIngest.factureKey(n); }
  // factures : sortie de facturesFromRows / facturesFromMondayBoard, tous tableaux.
  function compute(factures, dateRef, gl) {
    var R = G.LioraRules, I = G.LioraIngest, Z = G.LioraZoho;
    var c = I.consolider(factures.filter(function (f) { return f.role !== 'ignore'; }));
    var payees = {};
    c.forEach(function (f) { if (f.paye === true) payees[f.cle || key(f.numero)] = 1; });
    I.appliquerSellsy(c, Z ? Z.lignes() : []);
    I.enrichir(c, { dateRef: dateRef, rules: R.DEFAULT_ECHEANCE_RULES.map(function (r) { return Object.assign({}, r); }), financementsManuels: {} });
    var out = {};
    c.forEach(function (f) {
      var k = f.cle || key(f.numero); if (!k) return;
      var g = gl && gl[k], av = !!(g && g.s === 'a'), reg = !!(g && g.s === 'r'), vir = !!(g && g.s === 'v'), pm = !!payees[k];
      var paid = !av && (pm || reg || vir);
      out[k] = {
        n: f.numero, de: iso(f.dateEcheance), eb: f.echeanceBase || '', rl: f.regleLabel || '', mt: f.montant,
        paid: paid, src: av ? 'avoir' : pm ? 'monday' : reg ? 'gl' : vir ? 'vir' : '',
        dp: paid || av ? ((g && g.dp) || iso(f.datePaiementEffective)) : undefined,
        df: iso(f.dateFacture), op: f.role !== 'payees' || (f.nbLignesOperationnelles || 0) > 0
      };
    });
    return out;
  }
  G.LioraEngine = { compute: compute, iso: iso, key: key };
})(typeof window !== 'undefined' ? window : globalThis);
