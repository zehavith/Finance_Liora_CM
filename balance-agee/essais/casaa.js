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

// Le libellé porte PLUSIEURS dates : votre regex est gourmande, c'est la
// DERNIÈRE qui compte.
const LIB='2024-07-01 – 2023-10-27 – 2025-03-14 – Victoire Vincent – FA-550-3816';

console.log('=== un export Pennylane BRUT : sa « Date d’échéance » est ignorée ===');
const brut=[
  {'N° de compte':'411VIN00100','Libellé de compte':'CAISSE DES DEPOTS','Let.':'',
   'Identifiant du tiers':'T-1','Tiers':'CAISSE DES DEPOTS','N° de facture':'FA-550-3816',
   'Libellé de ligne':LIB,'Débit':'1000','Crédit':'0','Date':'01/07/2024',
   'Date d’enregistrement':'07/07/2026','Date d’échéance':'31/12/2026'},
  {'N° de compte':'411VIN00100','Libellé de compte':'CAISSE DES DEPOTS','Let.':'',
   'Identifiant du tiers':'T-1','Tiers':'CAISSE DES DEPOTS','N° de facture':'',
   'Libellé de ligne':'2024-08-02 – VIR SEPA RECU','Débit':'0','Crédit':'200',
   'Date':'02/08/2024','Date d’enregistrement':'07/07/2026','Date d’échéance':''},
];
const lu=GL.lire(brut,{});
const c=GL.classer(GL.creancesOuvertes(lu),{rules:RG,sellsy:[],mandats:[],referentiel:{},regles:[]})[0];
ok('l’échéance de Pennylane (31/12/2026) n’est pas reprise', j(c.dateEcheance)!=='2026-12-31');
ok('c’est la DERNIÈRE date du libellé qui sert (14/03/2025)', j(c.dateEcheance)==='2025-03-14');
ok('  … le dispositif est bien reconnu', c.financement==='CPF');
// L'origine dit QUI décide de la date, et c'est sa règle du 14/10/2026 :
// « on ne met pas de date arbitraire mais par défaut on prend la date
// d'échéance 1 ». La date est lue au grand livre, la décision est la règle —
// seule la colonne « Date d'échéance » du fichier, reprise telle quelle,
// s'annonce « Grand livre ». Le motif, lui, nomme la source exacte.
ok('  … et l’origine de la date le dit', c.echeanceOrigine==='Règle');
ok('  … la base retenue est l’échéance 1', c.echeanceBase==='echeance1');
ok('  … et le motif nomme le libellé', c.echeanceMotif==='dernière date du libellé');
ok('  … sans ajouter le délai du barème', c.echeanceJours===0);

console.log('\n=== sans date dans le libellé : la date d’enregistrement ===');
const brut2=brut.map((r,i)=>({...r,'Libellé de ligne': i?r['Libellé de ligne']:'Facture sans date'}));
const c2=GL.classer(GL.creancesOuvertes(GL.lire(brut2,{})),
  {rules:RG,sellsy:[],mandats:[],referentiel:{},regles:[]})[0];
ok('07/07/2026, la date d’enregistrement', j(c2.dateEcheance)==='2026-07-07');

console.log('\n=== VOTRE balance travaillée : sa colonne « Date d’échéance » EST votre AA ===');
const sien=brut.map(r=>({...r,
  'Date d\'échéance recalculée':'', 'Sous catégorie de type de client':'B2B'}));
const lu3=GL.lire(sien,{});
ok('le lecteur reconnaît votre feuille', !!lu3.lignes.length);
const c3=GL.classer(GL.creancesOuvertes(lu3),{rules:RG,sellsy:[],mandats:[],referentiel:{},regles:[]})[0];
ok('votre colonne AA (31/12/2026) est reprise telle quelle', j(c3.dateEcheance)==='2026-12-31');

console.log('\n=== aucune date arbitraire n’est inventée ===');
const vide=[
  {'N° de compte':'411ZZZ','Libellé de compte':'X','Let.':'','Tiers':'X',
   'N° de facture':'F1','Libellé de ligne':'sans date','Débit':'500','Crédit':'0'},
  {'N° de compte':'411ZZZ','Libellé de compte':'X','Let.':'','Tiers':'X',
   'N° de facture':'','Libellé de ligne':'sans date','Débit':'0','Crédit':'100'},
];
const c4=GL.classer(GL.creancesOuvertes(GL.lire(vide,{})),
  {rules:RG,sellsy:[],mandats:[],referentiel:{},regles:[]});
ok('aucune échéance n’est posée', c4.length>0 && c4.every(x=>!x.dateEcheance));
ok('  … et surtout jamais le 02/08/2024', c4.every(x=>j(x.dateEcheance)!=='2024-08-02'));
