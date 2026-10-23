// ── LA BALANCE ÂGÉE DE L'APPLICATION CONTRE CELLE DE L'ARTEFACT ──
//
// La page publiée et l'application « Suivi recouvrement » partagent le même
// moteur, mais pas la même suite d'appels. L'application omettait la
// répartition au prorata : les écritures et les soldes de compte qu'aucune
// facture ne classe gardaient un dispositif emprunté, et la comparaison avec
// Monday se faisait donc sur une ventilation différente de celle de la
// balance publiée.
//
// Ce cas fait tourner les DEUX suites sur le MÊME grand livre, avec les MÊMES
// options, et ne change qu'une chose : l'appel manquant. Les imports annexes
// — Sellsy, facturation, mandats — sont volontairement laissés de côté ; ils
// sont identiques des deux côtés, donc ils ne pèsent pas sur l'écart mesuré.
// Ce qui est mesuré ici, c'est la suite d'appels, rien d'autre.
const path = require('path');
const { ctx, NOUV, feuille } = require(path.resolve(__dirname, '..', 'socle.js'));
const GL = ctx.LioraGrandLivre, R = ctx.LioraRules;
const RG = R.DEFAULT_ECHEANCE_RULES;
const ok = (t, c) => { console.log((c ? '  OK  ' : 'ÉCHEC ') + t); if (!c) process.exitCode = 1; };
const eur = n => Math.round(n).toLocaleString('fr-FR') + ' €';

const nouv = feuille(path.resolve(__dirname, '..', NOUV), 'Grand livre - Clients', 0);
const lu = GL.lire(nouv.rows, {});
const REF = (() => {
  let d = null;
  for (const r of nouv.rows) { const v = R.parseDate(r['Date']); if (v && (!d || v > d)) d = v; }
  const jour = new Date(); jour.setHours(0, 0, 0, 0);
  return (!d || d > jour) ? jour : d;
})();
const OPT = () => ({ rules: RG, sellsy: [], factures: [], mandats: [],
                     referentiel: {}, regles: [], appris: {} });

// La suite d'appels de recalculerBalanceGL(), avec ou sans l'appel manquant.
function suite(avecProrata) {
  const ouvertes = GL.creancesOuvertes(lu);
  const classees = GL.classer(ouvertes, OPT());
  const soldees = GL.classer(GL.facturesToutes(lu)
    .filter(c => c.statut && c.statut !== 'Ouverte' && c.statut !== 'Partiellement réglée'),
    OPT());
  const plat = GL.ecrituresAPlat(lu);
  const ecr = GL.classerEcritures(plat, classees, soldees, { sellsy: [], rules: RG, factures: [] });
  let bilan = null;
  if (avecProrata) bilan = GL.repartirAuProrata(ecr.lignes || ecr, classees, { rules: RG });
  return { bilan, balance: GL.balanceAgee(classees, REF, RG, 'financement') };
}

console.log('=== la suite d’appels de l’application, sans puis avec le prorata ===');
console.log('grand livre : ' + nouv.rows.length.toLocaleString('fr-FR') + ' lignes · arrêté au '
  + REF.toLocaleDateString('fr-FR'));

const sans = suite(false), avec = suite(true);

// 1. Le total ne bouge pas : le prorata reclasse, il ne crée ni ne détruit.
const somme = b => b.rows.reduce((s, r) => s + (r.total || 0), 0);
ok('le total de la balance est inchangé — ' + eur(somme(sans.balance)),
   Math.abs(somme(sans.balance) - somme(avec.balance)) < 0.01);

// 2. Mais la ventilation par dispositif, elle, bouge — et c'est exactement
//    cette ventilation que la comparaison avec Monday confronte.
const par = b => new Map(b.rows.map(r => [r.cle || r.key || r.label, r.total || 0]));
const a = par(sans.balance), z = par(avec.balance);
const lignes = [];
for (const k of new Set([...a.keys(), ...z.keys()])) {
  const d = (z.get(k) || 0) - (a.get(k) || 0);
  if (Math.abs(d) >= 0.01) lignes.push([k, d]);
}
lignes.sort((x, y) => Math.abs(y[1]) - Math.abs(x[1]));
const deplace = lignes.reduce((s, l) => s + Math.max(0, l[1]), 0);
ok('la ventilation par dispositif change — ' + lignes.length + ' lignes, ' + eur(deplace)
   + ' déplacés', lignes.length > 0);
for (const [k, d] of lignes)
  console.log('     ' + String(R.getRule(k, RG).label || k).padEnd(34)
    + (d > 0 ? '+' : '') + eur(d));

// 3. Ce que l'appel manquant fait, chiffré.
const b = avec.bilan;
console.log('  ce que la répartition tranche : ' + b.lignes + ' écritures sur ' + b.comptes
  + ' clients mixtes, dont ' + b.lignesChangees + ' changent (' + eur(b.euros) + ')');
console.log('  … et ' + b.creances + ' soldes de compte, dont ' + b.creancesChangees
  + ' changent (' + eur(b.eurosCreances) + ')');
console.log('  … règle France Travail : ' + b.montant + ' lignes et soldes, '
  + b.montantChangees + ' changements de dispositif');
ok('la répartition touche bien des soldes de compte de la balance', b.creancesChangees > 0);
