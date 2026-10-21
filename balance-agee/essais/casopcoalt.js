const DEPOT=require('path').resolve(__dirname,'..','..');
const fs=require('fs'), vm=require('vm');
const R=DEPOT+'/recouvrement';
const ctx={self:{},window:{},console,Buffer,process,TextDecoder,TextEncoder,Date,Math,JSON};
ctx.self=ctx;ctx.window=ctx;ctx.globalThis=ctx;vm.createContext(ctx);
for(const f of [R+'/js/rules.js',R+'/js/ingest.js',R+'/js/grandlivre.js']) vm.runInContext(fs.readFileSync(f,'utf8'),ctx);
const GL=ctx.LioraGrandLivre, Rr=ctx.LioraRules, RG=Rr.DEFAULT_ECHEANCE_RULES;
const ok=(t,c)=>{console.log((c?'  OK  ':'ÉCHEC ')+t); if(!c) process.exitCode=1;};
const j=d=>d?new Date(d).toISOString().slice(0,10):null;
const L=c=>c.financement?Rr.getRule(c.financement,RG).label:'—';

console.log('=== l’alternance Filiz : qui paie décide du barème ===');
// « Si c'est OPCO, date de fin + 15 jours ; si c'est l'entreprise, date de
// facture + 30 jours. » L'aiguillage se fait sur le payeur, pas sur le numéro.
const creances=[
  {numero:'FCT-FILIZ-DST-2026-101', cle:'FCTFILIZDST2026101', compte:'4111001170000',
   tiers:'AKTO', montant:3000, resteDu:3000, qualif:'', filiz:true,
   dateFacture:new Date(2025,0,15)},
  {numero:'FCT-FILIZ-DST-2026-102', cle:'FCTFILIZDST2026102', compte:'411ALSTOM',
   tiers:'ALSTOM TRANSPORT SA', montant:4000, resteDu:4000, qualif:'', filiz:true,
   dateFacture:new Date(2025,0,15)},
];
const sellsy=[
  {cle:'FCTFILIZDST2026101', numero:'FCT-FILIZ-DST-2026-101', client:'AKTO',
   dateDebutService:new Date(2025,0,6), dateFinService:new Date(2026,5,30),
   dateFacture:new Date(2025,0,15)},
  {cle:'FCTFILIZDST2026102', numero:'FCT-FILIZ-DST-2026-102', client:'ALSTOM TRANSPORT SA',
   dateDebutService:new Date(2025,0,6), dateFinService:new Date(2026,5,30),
   dateFacture:new Date(2025,0,15)},
];
const cl=GL.classer(creances,{rules:RG, sellsy, mandats:[]});
ok('payée par un OPCO → OPCO - Alternance', L(cl[0])==='OPCO - Alternance');
ok('facturée à l’entreprise → Corporate - Alternance', L(cl[1])==='Corporate - Alternance');

console.log('\n=== OPCO : fin de formation + 30 jours ===');
ok("30/06/2026 + 30 j → 30/07/2026", j(cl[0].dateEcheance)==="2026-07-30");
ok('  … et la base est bien la fin de formation', cl[0].echeanceBase==='dateFinFormation');
ok('  … et le délai annoncé est celui appliqué', cl[0].echeanceJours===30);

// Le 15/10/2026 elle a aligné Corporate - Alternance sur le B2C-Entreprise :
// même facturation, même barème, et c'est la FIN DE FORMATION qui date la
// créance, non la date de facture. Ce bloc attendait encore la règle d'avant.
console.log('\n=== entreprise : fin de formation + 30 jours ===');
ok('30/06/2026 + 30 j → 30/07/2026', j(cl[1].dateEcheance)==='2026-07-30');
ok('  … et la base est bien la fin de formation', cl[1].echeanceBase==='dateFinFormation');
ok('  … et le délai annoncé est celui appliqué', cl[1].echeanceJours===30);

console.log('\n=== le barème lui-même, tel qu’il est écrit ===');
const r=k=>RG.find(x=>x.key===k);
ok('OPCO - Alternance : fin de formation + 30 (suivi)',
   r('OPCO_ALTERNANCE').base==='dateFinFormation' && r("OPCO_ALTERNANCE").jours===30);
ok('OPCO - Alternance : fin de formation + 30 (balance âgée)',
   r('OPCO_ALTERNANCE').gl.base==='dateFinFormation' && r("OPCO_ALTERNANCE").gl.jours===30);
ok('Corporate - Alternance : fin de formation + 30 (suivi)',
   r('CORPORATE_ALTERNANCE').base==='dateFinFormation' && r('CORPORATE_ALTERNANCE').jours===30);
ok('Corporate - Alternance : fin de formation + 30 (balance âgée)',
   r('CORPORATE_ALTERNANCE').gl.base==='dateFinFormation' && r('CORPORATE_ALTERNANCE').gl.jours===30);
ok('  … et la phrase imprimée dit la même chose',
   /fin de formation \+30/i.test(r('CORPORATE_ALTERNANCE').note||''));
ok('l’OPCO reste hors recouvrement', r('OPCO_ALTERNANCE').sansRecouvrement===true);

console.log('\n=== sans fin de formation, rien n’est inventé ===');
const nues=[{numero:'FCT-FILIZ-DST-2026-103', cle:'K103', compte:'4111001170000',
  tiers:'AKTO', montant:1000, resteDu:1000, qualif:'', filiz:true,
  dateFacture:new Date(2025,0,15), dateEcheance:new Date(2025,0,20),
  dateEcheanceLivre:new Date(2025,0,20)}];
const cn=GL.classer(nues,{rules:RG, sellsy:[], mandats:[]});
ok('l’échéance du grand livre sert de repli', j(cn[0].dateEcheance)==='2025-01-20');
ok('  … et la source le dit', cn[0].echeanceOrigine==='Grand livre');
ok('  … sans ajouter de délai', cn[0].echeanceJours===0);
