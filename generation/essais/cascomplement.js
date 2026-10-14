const DEPOT=require('path').resolve(__dirname,'..','..');
const fs=require('fs'), vm=require('vm');
const R=DEPOT+'/recouvrement';
const ctx={self:{},window:{},console,Buffer,process,TextDecoder,TextEncoder,Date,Math,JSON};
ctx.self=ctx;ctx.window=ctx;ctx.globalThis=ctx;vm.createContext(ctx);
for(const f of [R+'/js/rules.js',R+'/js/ingest.js',R+'/js/grandlivre.js']) vm.runInContext(fs.readFileSync(f,'utf8'),ctx);
const GL=ctx.LioraGrandLivre, Rr=ctx.LioraRules, RG=Rr.DEFAULT_ECHEANCE_RULES;
const ok=(t,c)=>{console.log((c?'  OK  ':'ÉCHEC ')+t); if(!c) process.exitCode=1;};
const D=(y,m,j)=>new Date(y,m-1,j);
const j=d=>d?new Date(d).toISOString().slice(0,10):null;

// Une CPF dont la fin de formation manque : elle retombe sur le grand livre.
const base=()=>[{numero:'FACT-2601-13000', cle:'FACT260113000', compte:'411CDC',
  tiers:'CAISSE DES DEPOTS', montant:5000, resteDu:5000, qualif:'',
  dateFacture:D(2025,1,15), dateEcheance:D(2025,2,14), dateEcheanceLivre:D(2025,2,14)}];

console.log('=== sans complément : repli sur l’échéance du grand livre ===');
const a=GL.classer(base(),{rules:RG, sellsy:[], mandats:[], referentiel:{}})[0];
ok('le dispositif est trouvé', a.financement==='CPF');
ok('mais la règle ne peut pas s’appliquer', a.echeanceOrigine==='Grand livre');
ok('l’échéance est celle du grand livre', j(a.dateEcheance)==='2025-02-14');

console.log('\n=== vous complétez la FIN DE FORMATION : votre barème s’applique ===');
const ref1={FACT260113000:{fin:'CPF', source:'valide', finFormation:'2026-06-30',
  note:'relevé sur le dossier', le:'2026-10-12'}};
const b=GL.classer(base(),{rules:RG, sellsy:[], mandats:[], referentiel:ref1})[0];
ok('la fin de formation est reprise', j(b.dateFinFormation)==='2026-06-30');
ok('l’origine redevient « Règle »', b.echeanceOrigine==='Règle');
ok('la base est la fin de formation', b.echeanceBase==='dateFinFormation');
ok('le délai est celui du barème CPF (+60)', b.echeanceJours===60);
ok('30/06/2026 + 60 j = 29/08/2026', j(b.dateEcheance)==='2026-08-29');
ok('la trace dit ce qui a été complété', b.complementQuoi==='fin de formation');
ok('  … et quand', b.complementLe==='2026-10-12');
ok('  … et votre note', b.complementNote==='relevé sur le dossier');
ok('l’échéance du grand livre reste lisible', j(b.dateEcheanceGrandLivre)==='2025-02-14');

console.log('\n=== vous posez une ÉCHÉANCE à la main : elle prime, et se voit ===');
const ref2={FACT260113000:{fin:'CPF', source:'valide', echeance:'2026-01-31',
  note:'accord écrit du client', le:'2026-10-12'}};
const c=GL.classer(base(),{rules:RG, sellsy:[], mandats:[], referentiel:ref2})[0];
ok('l’échéance posée est retenue', j(c.dateEcheance)==='2026-01-31');
ok('l’origine le dit', c.echeanceOrigine==='Saisie à la main');
ok('aucun délai n’est ajouté', c.echeanceJours===0);
ok('le motif porte votre note', c.echeanceMotif==='accord écrit du client');
ok('la trace nomme l’échéance', c.complementQuoi==='échéance');

console.log('\n=== la fin de formation prime sur ce que porterait un fichier ===');
const avecSellsy=[{cle:'FACT260113000', numero:'FACT-2601-13000',
  dateFinService:D(2025,12,31), client:'CAISSE DES DEPOTS'}];
const d=GL.classer(base(),{rules:RG, sellsy:avecSellsy, mandats:[], referentiel:ref1})[0];
ok('Sellsy dit 31/12/2025, vous dites 30/06/2026 → c’est vous', j(d.dateFinFormation)==='2026-06-30');
ok('  … et l’échéance suit votre date', j(d.dateEcheance)==='2026-08-29');

console.log('\n=== compléter une date ne reclasse pas ===');
const ref3={FACT260113000:{fin:'CPF', source:'valide', finFormation:'2026-06-30', le:'2026-10-12'}};
const e=GL.classer(base(),{rules:RG, sellsy:[], mandats:[], referentiel:ref3})[0];
ok('le dispositif reste celui qui était connu', e.financement==='CPF');

console.log('\n=== une entrée sans date ne change rien ===');
const ref4={FACT260113000:{fin:'CPF', source:'valide'}};
const f=GL.classer(base(),{rules:RG, sellsy:[], mandats:[], referentiel:ref4})[0];
ok('aucune trace de complément', !f.complementLe && !f.complementQuoi);
ok('l’échéance reste le repli', f.echeanceOrigine==='Grand livre');
