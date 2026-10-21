const DEPOT=require('path').resolve(__dirname,'..','..');
const fs=require('fs'), vm=require('vm');
const R=DEPOT+'/recouvrement';
const ctx={self:{},window:{},console,Buffer,process,TextDecoder,TextEncoder,Date,Math,JSON};
ctx.self=ctx;ctx.window=ctx;ctx.globalThis=ctx;vm.createContext(ctx);
for(const f of [R+'/js/rules.js',R+'/js/ingest.js',R+'/js/grandlivre.js']) vm.runInContext(fs.readFileSync(f,'utf8'),ctx);
const Rr=ctx.LioraRules, GL=ctx.LioraGrandLivre;
const ok=(t,c)=>{console.log((c?'  OK  ':'ÉCHEC ')+t); if(!c) process.exitCode=1;};
const D=(y,m,j)=>new Date(y,m-1,j);
const j=d=>d?d.toISOString().slice(0,10):null;
const RG=Rr.DEFAULT_ECHEANCE_RULES;
const calc=(inv)=>Rr.computeEcheance(inv,{rules:RG, grandLivre:true, prefereEcheanceMonday:false});

console.log('=== le moteur dit le délai qu’il a VRAIMENT appliqué ===');
// Sous mandat : la base est la fin de formation, mais SANS délai —
// le barème CPF dirait « + 60 », l’export l’annonçait, c’était faux.
const m=calc({financement:'CPF', dateFinFormation:D(2026,6,30), mandatGocardless:true});
ok('mandat → base fin de formation', m.baseUtilisee==='dateFinFormation');
ok('mandat → délai 0 (et non le +45 du barème)', m.jours===0);
ok('mandat → échéance = la fin de formation', j(m.date)==='2026-06-30');

// Facture postérieure : +30 figé, quel que soit le dispositif. Trente jours
// et non soixante — son ordre de préférence du 14/10/2026 : « si date de
// facture est postérieure à fin de formation, on prend date de facture + 30 ».
// La formule du classeur disait soixante ; c'est elle qui décide.
const ap=calc({financement:'OPCO', dateFinFormation:D(2025,1,10),
  dateFactureFacturation:D(2025,6,1)});
ok('facture postérieure → base date de facture facturation', ap.baseUtilisee==='dateFactureFacturation');
ok('facture postérieure → +30 j, même pour un OPCO dont le barème dit autre chose', ap.jours===30);
ok('facture postérieure → 01/06/2025 + 30 j', j(ap.date)==='2025-07-01');

// Le barème du dispositif, cas simple.
// Quarante-cinq jours, son tableau du 14/10/2026 ; le barème à soixante a
// été écarté ce jour-là, et le texte imprimé l'a suivi le 16/10.
const b=calc({financement:'CPF', dateFinFormation:D(2026,6,30)});
ok('CPF → fin de formation + 45', b.jours===45 && j(b.date)==='2026-08-14');
const o=calc({financement:'OPCO_ALTERNANCE', dateFinFormation:D(2026,6,30)});
ok('OPCO - Alternance → fin de formation + 30', o.jours===30 && j(o.date)==='2026-07-30');
const p=calc({financement:'BTC_PERSO', dateDebutFormation:D(2026,3,2)});
ok('B2C-Perso → début de formation, sans délai', p.jours===0 && j(p.date)==='2026-03-02');

// Le repli sur l’échéance du grand livre n’ajoute rien.
const r=calc({financement:'CPF', dateEcheanceComptable:D(2025,4,10)});
ok('repli grand livre → origine « Grand livre »', r.origine==='Grand livre');
ok('repli grand livre → délai 0, pas le +45 du barème', r.jours===0);
ok('repli grand livre → la date du grand livre, intacte', j(r.date)==='2025-04-10');

// Rien du tout.
const z=calc({financement:'CPF'});
ok('aucune base → aucune date', z.date===null);
ok('aucune base → délai nul (non renseigné)', z.jours===null);

console.log('\n=== la créance garde de quoi se justifier ===');
const creances=[
  {numero:'FACT-2601-13000', cle:'FACT260113000', compte:'411CDC', tiers:'CAISSE DES DEPOTS',
   montant:5000, resteDu:5000, qualif:'',
   dateFacture:D(2025,1,15), dateFactureFacturation:D(2025,1,15),
   dateEcheanceLivre:D(2025,2,14),          // la colonne AA de votre fichier
   dateEcheance:D(2025,2,14),
   dateFinFormation:D(2026,6,30),
   ancien:{numero:'CPF', numeroType:'B2C', numeroSousType:'CPF'},
   brut:{numeroZoho:'FA-880-0097', commentaire:'vu avec le client',
         statutSellsy:'Envoyée', avoirApparente:'AVR-2601-001',
         nbJoursEchus:120, typeClientFichier:'B2C', sousCategorieFichier:'CPF',
         dateComptable:D(2025,1,15)}},
];
const cl=GL.classer(creances,{rules:RG, sellsy:[], mandats:[]});
const c=cl[0];
ok('le délai appliqué est posé sur la créance', c.echeanceJours===45);
ok('la base aussi', c.echeanceBase==='dateFinFormation');
ok('l’échéance du grand livre est conservée intacte', j(c.dateEcheanceGrandLivre)==='2025-02-14');
ok('  … alors que l’échéance retenue, elle, a changé', j(c.dateEcheance)==='2026-08-14');
ok('les colonnes du fichier survivent (n° Zoho)', c.brut && c.brut.numeroZoho==='FA-880-0097');
ok('  … le commentaire', c.brut.commentaire==='vu avec le client');
ok('  … le statut Sellsy', c.brut.statutSellsy==='Envoyée');
ok('  … l’avoir apparenté', c.brut.avoirApparente==='AVR-2601-001');
ok('le type ET la sous-catégorie de l’ancien grand livre', 
   c.ancien.numeroType==='B2C' && c.ancien.numeroSousType==='CPF');

console.log('\n=== le calcul se refait de tête ===');
const base=c.dateFinFormation;
const refait=new Date(base.getFullYear(), base.getMonth(), base.getDate()+c.echeanceJours);
ok('fin de formation + délai appliqué = échéance retenue', j(refait)===j(c.dateEcheance));
