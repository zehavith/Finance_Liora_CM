// L'IMPUTATION DES RÈGLEMENTS — « un paiement peut être pour plusieurs
// factures », 21/10/2026.
//
// Ce fichier vérifie la règle telle qu'elle a été posée, dans son ordre :
//   1. on ne retient que les factures du lot ;
//   2. les avoirs d'abord — on n'impute pas sur une facture annulée ;
//   3. le montant exact d'abord ;
//   4. sinon de la plus ancienne à la plus récente, à concurrence du reste dû ;
//   5. le reste n'est jamais forcé : il reste visible.
const DEPOT=require('path').resolve(__dirname,'..','..');
const fs=require('fs'), vm=require('vm');
const R=DEPOT+'/recouvrement';
const ctx={self:{},window:{},console,Buffer,process,TextDecoder,TextEncoder,Date,Math,JSON};
ctx.self=ctx;ctx.window=ctx;ctx.globalThis=ctx;vm.createContext(ctx);
for(const f of [R+'/js/rules.js',R+'/js/ingest.js',R+'/js/grandlivre.js'])
  vm.runInContext(fs.readFileSync(f,'utf8'),ctx);
const GL=ctx.LioraGrandLivre, I=ctx.LioraIngest, Rr=ctx.LioraRules;
const RG=Rr.DEFAULT_ECHEANCE_RULES;
const ok=(t,c)=>{console.log((c?'  OK  ':'ÉCHEC ')+t); if(!c) process.exitCode=1;};
const eur=n=>Math.round((n||0)*100)/100;

// Une ligne de grand livre, réduite à ce qui compte ici.
const L=(cpt,let_,num,lib,D,C,date)=>({
  'N° de compte':cpt,'Libellé de compte':'CLIENT X','Let.':let_,'Tiers':'CLIENT X',
  'Identifiant du tiers':'T-1','N° de facture':num,'Libellé de ligne':lib,
  'Débit':String(D),'Crédit':String(C),'Date':date,'Date d’enregistrement':date});
// Le reste dû de chaque facture, tel que la balance le publiera.
const restes=lu=>{
  const m=new Map();
  for(const c of GL.creancesOuvertes(lu)) if(c.numero) m.set(c.numero, eur(c.resteDu));
  return m;
};
const horsFacture=lu=>GL.creancesOuvertes(lu)
  .filter(c=>c.sansNumero).reduce((s,c)=>s+(c.resteDu||0),0);
const solde=lu=>lu.groupes.reduce((s,g)=>s+g.debit-g.credit,0);
const impDe=(lu,pred)=>{
  for(const g of lu.groupes) for(const l of g.reglements.concat(g.autres))
    if(pred(l)) return l;
  return null;
};

console.log('=== le montant exact passe avant l’ancienneté ===');
// Transitions Pro solde trois dossiers d'un coup : trois virements, chacun du
// montant exact d'une des trois factures, et tous trois nomment les trois.
const TROIS='LOT 528 FACT-2602-13500 FACT-2602-13497 FACT-2602-13501';
const exact=[
  L('411TP00000000','a','FACT-2602-13500','Facture A','2340.80','0','05/02/2026'),
  L('411TP00000000','a','FACT-2602-13497','Facture B','507.00','0','05/02/2026'),
  L('411TP00000000','a','FACT-2602-13501','Facture C','2160.20','0','05/02/2026'),
  L('411TP00000000','a','','VIR '+TROIS,'0','2340.80','10/03/2026'),
  L('411TP00000000','a','','VIR '+TROIS,'0','507.00','11/03/2026'),
  L('411TP00000000','a','','VIR '+TROIS,'0','2160.20','12/03/2026'),
];
const lu1=GL.lire(exact,{});
const r1=restes(lu1);
ok('les trois factures sont soldées, chacune par son virement',
   eur(r1.get('FACT-2602-13500'))===0 && eur(r1.get('FACT-2602-13497'))===0
   && eur(r1.get('FACT-2602-13501'))===0);
ok('  … et rien ne reste en l’air', eur(horsFacture(lu1))===0);
ok('  … le motif dit que c’est le montant exact',
   /montant exact/.test((impDe(lu1,l=>l.credit===2340.8).imputations[0]||{}).motif||''));
ok('  … et l’écriture porte le numéro de la facture qu’elle solde',
   impDe(lu1,l=>l.credit===507).numero==='FACT-2602-13497');

console.log('\n=== sans montant exact : de la plus ancienne à la plus récente ===');
const DEUX='PAIEMENT FACT-2601-13284 FACT-2604-14736';
const ordre=[
  L('411CPF0000000','ok','FACT-2601-13284','Facture ancienne','116.00','0','22/01/2026'),
  L('411CPF0000000','ok','FACT-2604-14736','Facture récente','1020.00','0','28/04/2026'),
  L('411CPF0000000','ok','','VIR '+DEUX,'0','284.10','15/05/2026'),
];
const lu2=GL.lire(ordre,{});
const r2=restes(lu2);
ok('la plus ancienne est soldée la première', eur(r2.get('FACT-2601-13284'))===0);
ok('  … et la suivante reçoit le reste : 1 020 − 168,10 = 851,90',
   eur(r2.get('FACT-2604-14736'))===851.90);
const imp2=impDe(lu2,l=>l.credit===284.1).imputations;
ok('  … l’écriture porte les DEUX imputations', imp2.length===2);
ok('  … 116,00 € sur l’ancienne', eur(imp2[0].montant)===116 && imp2[0].numero==='FACT-2601-13284');
ok('  … 168,10 € sur la suivante', eur(imp2[1].montant)===168.10 && imp2[1].numero==='FACT-2604-14736');
ok('  … rien ne reste en l’air', eur(horsFacture(lu2))===0);

console.log('\n=== on n’impute pas sur une facture annulée ===');
// « Tu prends bien en compte les avoirs quand tu impute pour être sûr que tu
// n'impute pas sur une facture annulée ? », 21/10/2026.
const avec='REGLEMENT FACT-2601-13284 FACT-2604-14736';
const annulee=[
  L('411AVO0000000','a','FACT-2601-13284','Facture annulée','1000.00','0','22/01/2026'),
  L('411AVO0000000','a','AVR-2602-00001','Avoir sur FACT-2601-13284','0','1000.00','01/02/2026'),
  L('411AVO0000000','a','FACT-2604-14736','Facture vivante','800.00','0','28/04/2026'),
  L('411AVO0000000','a','','VIR '+avec,'0','800.00','15/05/2026'),
];
const lu3=GL.lire(annulee,{});
const r3=restes(lu3);
ok('la facture annulée ne reçoit rien du virement', eur(r3.get('FACT-2601-13284'))===0);
ok('  … c’est la facture vivante qui est soldée', eur(r3.get('FACT-2604-14736'))===0);
ok('  … et le virement la nomme', impDe(lu3,l=>l.credit===800).numero==='FACT-2604-14736');

console.log('\n=== le reste n’est jamais forcé ===');
// Le virement nomme trois factures ; une seule est dans son lettrage, et elle
// ne doit pas tout. Ce qui dépasse ne s’impute sur rien et reste visible.
const TROP='ALMA PAYOUT FACT-2511-12491 FACT-2601-13132 FACT-2601-13143';
const trop=[
  L('411ALM0000000','(non lettré)','FACT-2601-13143','Facture du lot','1992.00','0','09/01/2026'),
  L('411ALM0000000','(non lettré)','','VIR '+TROP,'0','2241.00','19/01/2026'),
];
const lu4=GL.lire(trop,{});
const r4=restes(lu4);
ok('la facture du lot est soldée, pas au-delà', eur(r4.get('FACT-2601-13143'))===0);
ok('  … les 249 € qui dépassent restent visibles, en une créance à part',
   eur(horsFacture(lu4))===-249);
const imp4=impDe(lu4,l=>l.credit===2241);
ok('  … la ligne dit ce qu’elle a imputé', eur(imp4.imputations[0].montant)===1992);
ok('  … et ce qu’elle n’a pas pu imputer', eur(imp4.resteImpute)===249);
ok('  … le total du lot est conservé', eur(solde(lu4))===eur(1992-2241));

console.log('\n=== une facture d’un autre lettrage ne reçoit rien ===');
const ailleurs=[
  L('411LET0000000','a','FACT-2508-10910','Facture du lettrage a','5000.00','0','10/08/2025'),
  L('411LET0000000','b','FACT-2511-12102','Facture du lettrage b','8530.00','0','05/11/2025'),
  // le virement est dans le lettrage b, et nomme les deux
  L('411LET0000000','b','','VIR FACT-2508-10910 FACT-2511-12102','0','8490.00','12/11/2025'),
];
const lu5=GL.lire(ailleurs,{});
const r5=restes(lu5);
ok('la facture de l’autre lettrage est intacte', eur(r5.get('FACT-2508-10910'))===5000);
ok('  … c’est celle de SON lettrage qui est payée', eur(r5.get('FACT-2511-12102'))===40);
const imp5=impDe(lu5,l=>l.credit===8490);
ok('  … et la ligne garde la trace du numéro qu’elle portait',
   imp5.numero==='FACT-2511-12102' && imp5.numeroAvant==='FACT-2508-10910');

console.log('\n=== une seule facture nommée : rien à arbitrer ===');
// Un sur-paiement sur une facture unique est un fait du compte, pas un choix
// d'imputation : la facture passe en négatif, comme auparavant.
const seule=[
  L('411UNE0000000','a','FACT-2601-13143','Facture seule','1000.00','0','09/01/2026'),
  L('411UNE0000000','a','','VIR FACT-2601-13143','0','1200.00','19/01/2026'),
];
const lu6=GL.lire(seule,{});
ok('la facture sur-payée reste négative', eur(restes(lu6).get('FACT-2601-13143'))===-200);
ok('  … et rien ne part en créance à part', eur(horsFacture(lu6))===0);
ok('  … l’arbitrage n’a pas eu lieu', impDe(lu6,l=>l.credit===1200).imputationArbitree===false);

console.log('\n=== le total est conservé, quoi qu’il arrive ===');
for(const [nom,lot] of [['exact',exact],['ordre',ordre],['annulée',annulee],
                        ['trop',trop],['ailleurs',ailleurs],['seule',seule]]){
  const lu=GL.lire(lot,{});
  const somme=GL.creancesOuvertes(lu).reduce((s,c)=>s+(c.resteDu||0),0);
  const attendu=lu.groupes.filter(g=>!g.soldee&&Math.abs(g.debit-g.credit)>=GL.TOLERANCE)
    .reduce((s,g)=>s+g.debit-g.credit,0);
  ok('  « '+nom+' » : Σ des restes dus = solde des lots ouverts', eur(somme)===eur(attendu));
}
