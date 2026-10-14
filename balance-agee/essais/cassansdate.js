const DEPOT=require('path').resolve(__dirname,'..','..');
const fs=require('fs'), vm=require('vm');
const R=DEPOT+'/recouvrement';
const ctx={self:{},window:{},console,Buffer,process,TextDecoder,TextEncoder,Date,Math,JSON};
ctx.self=ctx;ctx.window=ctx;ctx.globalThis=ctx;vm.createContext(ctx);
for(const f of [DEPOT+'/vendor/papaparse.min.js',R+'/js/rules.js',R+'/js/ingest.js',R+'/js/grandlivre.js'])
  vm.runInContext(fs.readFileSync(f,'utf8'),ctx);
const GL=ctx.LioraGrandLivre, Rr=ctx.LioraRules, RG=Rr.DEFAULT_ECHEANCE_RULES;
const ok=(t,c)=>{console.log((c?'  OK  ':'ÉCHEC ')+t); if(!c) process.exitCode=1;};
const j=d=>d?new Date(d).toISOString().slice(0,10):null;
const OPT={rules:RG,sellsy:[],mandats:[],referentiel:{},regles:[]};

console.log('=== un solde de compte SANS facture est daté quand même ===');
// Aucune ligne ne porte de numéro : la créance est un solde de compte. Aucun
// barème n'a sa base — mais votre règle dit qu'à défaut on prend l'échéance 1.
const soldeur=[
  {'N° de compte':'4110DUP00100','Libellé de compte':'Paul DUPONT','Let.':'',
   'Identifiant du tiers':'T-9','Tiers':'Paul DUPONT','N° de facture':'',
   'Libellé de ligne':'2025-02-10 – acompte formation','Débit':'900','Crédit':'0',
   'Date':'10/02/2025','Date d’enregistrement':'15/02/2025'},
  {'N° de compte':'4110DUP00100','Libellé de compte':'Paul DUPONT','Let.':'',
   'Identifiant du tiers':'T-9','Tiers':'Paul DUPONT','N° de facture':'',
   'Libellé de ligne':'VIR SEPA RECU','Débit':'0','Crédit':'100',
   'Date':'03/03/2025','Date d’enregistrement':'04/03/2025'},
];
const cs=GL.classer(GL.creancesOuvertes(GL.lire(soldeur,{})),OPT);
ok('elle produit bien une créance', cs.length===1);
const c=cs[0];
ok('  … c’est bien un solde sans facture', c.sansNumero===true);
ok('  … elle porte une échéance', !!c.dateEcheance);
ok('  … la dernière date du libellé du débit : 10/02/2025', j(c.dateEcheance)==='2025-02-10');
ok('  … et l’origine le dit', c.echeanceOrigine==='Grand livre');
ok('  … avec un motif lisible', /échéance 1|repli|libellé/i.test(c.echeanceMotif||''));

console.log('\n=== sans date dans le libellé, c’est l’enregistrement ===');
const soldeur2=soldeur.map((r,i)=>i?r:{...r,'Libellé de ligne':'acompte formation'});
const c2=GL.classer(GL.creancesOuvertes(GL.lire(soldeur2,{})),OPT)[0];
ok('15/02/2025, la date d’enregistrement du débit', j(c2.dateEcheance)==='2025-02-15');

console.log('\n=== l’écriture d’un lot entièrement soldé reste datée ===');
// Une facture et son avoir, non lettrés : le lot est à zéro, il n'y a plus de
// créance ouverte — mais les deux lignes sont au grand livre et doivent se
// justifier.
const solde=[
  {'N° de compte':'4110ARG00100','Libellé de compte':'ARGO','Let.':'',
   'Identifiant du tiers':'T-4','Tiers':'ARGO','SIREN':'123456789','N° de facture':'FACT-2601-13048',
   'Libellé de ligne':'2025-11-30 – formation ARGO','Débit':'3190','Crédit':'0',
   'Date':'15/01/2026','Date d’enregistrement':'16/01/2026'},
  {'N° de compte':'4110ARG00100','Libellé de compte':'ARGO','Let.':'',
   'Identifiant du tiers':'T-4','Tiers':'ARGO','SIREN':'123456789','N° de facture':'AVR-2608-03272',
   'Libellé de ligne':'avoir sur FACT-2601-13048','Débit':'0','Crédit':'3190',
   'Date':'20/08/2026','Date d’enregistrement':'21/08/2026'},
];
const lu=GL.lire(solde,{});
const ouvertes=GL.classer(GL.creancesOuvertes(lu),OPT);
ok('la balance âgée n’en retient rien', ouvertes.length===0);
const soldees=GL.classer(GL.facturesToutes(lu)
  .filter(x=>x.statut&&x.statut!=='Ouverte'&&x.statut!=='Partiellement réglée'),OPT);
ok('la facture soldée est bien classée à part', soldees.length===1 && !!soldees[0].financement);
const sans=GL.classerEcritures(GL.ecrituresAPlat(lu),ouvertes).lignes;
ok('sans elle, rien ne les classe', sans.every(l=>!l.financement));
ok('  … et leur date n’est que le repli de la ligne',
   sans.every(l=>/aucune facture/i.test(l.echeanceMotif||'')));
const avec=GL.classerEcritures(GL.ecrituresAPlat(lu),ouvertes,soldees).lignes;
ok('avec elle, les deux lignes sont datées', avec.length===2 && avec.every(l=>!!l.dateEcheance));
ok('  … et classées', avec.every(l=>!!l.financement));
ok('  … sur l’échéance de la facture, pas sur le repli',
   avec.every(l=>!/aucune facture/i.test(l.echeanceMotif||'')));
ok('  … l’avoir hérite de la facture de son lettrage',
   /Hérité|citée/.test(avec.find(l=>l.nature==='avoir').origineClassement||''));

console.log('\n=== un lot sans AUCUNE facture : la ligne se date elle-même ===');
// Un crédit et le débit qui l'annule, aucun numéro de facture nulle part.
const paire=[
  {'N° de compte':'411CINSTITP00','Libellé de compte':'INSTITUT PASTEUR','Let.':'',
   'Tiers':'INSTITUT PASTEUR','N° de facture':'DV-003356',
   'Libellé de ligne':'2026-04-09 – devis','Débit':'0','Crédit':'7188',
   'Date':'09/04/2026','Date d’enregistrement':'10/04/2026'},
  {'N° de compte':'411CINSTITP00','Libellé de compte':'INSTITUT PASTEUR','Let.':'',
   'Tiers':'INSTITUT PASTEUR','N° de facture':'',
   'Libellé de ligne':'annulation devis','Débit':'7188','Crédit':'0',
   'Date':'11/04/2026','Date d’enregistrement':'12/04/2026'},
];
const lu2=GL.lire(paire,{});
const e=GL.classerEcritures(GL.ecrituresAPlat(lu2),GL.classer(GL.creancesOuvertes(lu2),OPT),[]).lignes;
ok('elle produit bien deux écritures', e.length===2);
ok('les deux sont datées', e.every(l=>!!l.dateEcheance));
ok('  … chacune sur sa propre échéance 1', j(e.find(l=>l.credit>0).dateEcheance)==='2026-04-09');
ok('  … et le motif dit pourquoi',
   e.every(l=>/aucune facture/i.test(l.echeanceMotif||'')));

console.log('\n=== une date retenue n’est jamais muette ===');
// Tout ce qui est daté dit d'où la date vient : c'est la condition de l'audit.
for(const lot of [soldeur,solde,paire]){
  const l2=GL.lire(lot,{});
  const cc=GL.classer(GL.creancesOuvertes(l2),OPT);
  ok('aucune créance datée sans origine',
     cc.every(x=>!x.dateEcheance||!!x.echeanceOrigine));
  const ee=GL.classerEcritures(GL.ecrituresAPlat(l2),cc,
    GL.classer(GL.facturesToutes(l2).filter(x=>x.statut&&x.statut!=='Ouverte'
      &&x.statut!=='Partiellement réglée'),OPT)).lignes;
  ok('  … et aucune écriture datée sans origine',
     ee.every(x=>!x.dateEcheance||!!x.echeanceOrigine));
}
