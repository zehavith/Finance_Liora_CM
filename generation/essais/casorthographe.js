const DEPOT=require('path').resolve(__dirname,'..','..');
const fs=require('fs'), vm=require('vm');
const R=DEPOT+'/recouvrement';
const ctx={self:{},window:{},console,Buffer,process,TextDecoder,TextEncoder,Date,Math,JSON};
ctx.self=ctx;ctx.window=ctx;ctx.globalThis=ctx;vm.createContext(ctx);
for(const f of [DEPOT+'/vendor/papaparse.min.js',R+'/js/rules.js',R+'/js/ingest.js',R+'/js/grandlivre.js'])
  vm.runInContext(fs.readFileSync(f,'utf8'),ctx);
const GL=ctx.LioraGrandLivre, Rr=ctx.LioraRules, RG=Rr.DEFAULT_ECHEANCE_RULES;
const ok=(t,c)=>{console.log((c?'  OK  ':'ÉCHEC ')+t); if(!c) process.exitCode=1;};

// Sa feuille écrit la même chose de deux façons : « Transition Pro » 479 fois,
// « Transition pro » 138 fois. Un compte qui porte les deux orthographes ne
// porte qu'UN avis.
const ligne=(n,sous)=>({'N° de compte':'4110TRA00100','Libellé de compte':'Fabrice TRANSIT',
  'Identifiant du tiers':'T-77','Tiers':'Fabrice TRANSIT','Let.':'',
  'N° de facture':'FACT-2505-0'+n,'Libellé de ligne':'2025-05-0'+n+' – Formation',
  'Débit':'1000','Crédit':'0','Date':'0'+n+'/05/2025','Date d’enregistrement':'10/05/2025',
  'Date d\'échéance recalculée':'', 'Sous catégorie de type de client':sous,
  'Type de client':'B2C'});

console.log('=== deux orthographes du même dispositif ne font qu’un avis ===');
const melange=[ligne(1,'Transition Pro'),ligne(2,'Transition pro'),
               ligne(3,'Transition Pro'),ligne(4,'Transition pro')];
const lu=GL.lire(melange,{rules:RG});
ok('elle produit bien des lignes', lu.lignes.length>0);
const parCompte=lu.apprisComptes['4110TRA00100'];
ok('le compte garde sa catégorie apprise', !!parCompte);
ok('  … et c’est bien Transition Pro', !!parCompte && /transition pro/i.test(parCompte.qualif));
ok('  … à l’unanimité des quatre lignes', !!parCompte && parCompte.nb===4 && parCompte.part===1);
ok('  … dans l’orthographe la plus fréquente',
   !!parCompte && (parCompte.qualif==='Transition Pro'||parCompte.qualif==='Transition pro'));
const parTiers=lu.apprisTiers['T-77'];
ok('le tiers aussi', !!parTiers && /transition pro/i.test(parTiers.qualif));

console.log('\n=== deux dispositifs DIFFÉRENTS restent deux avis ===');
const vrai=[ligne(1,'Transition Pro'),ligne(2,'CPF'),ligne(3,'Transition Pro'),ligne(4,'CPF')];
const lu2=GL.lire(vrai,{rules:RG});
ok('elle produit bien des lignes', lu2.lignes.length>0);
ok('aucun consensus : 50/50 n’apprend rien', !lu2.apprisComptes['4110TRA00100']);

console.log('\n=== une seule dissidence sur dix casse l’apprentissage ===');
// La règle de majorité à 90 % est retirée : « il ne faut pas faire ce
// raccourci ». Neuf factures d'accord ne décident plus de la dixième.
const presque=[];
for(let i=1;i<=9;i++) presque.push(ligne(i,i%2?'Transition Pro':'Transition pro'));
presque.push(ligne(1,'CPF'));
const lu3=GL.lire(presque,{rules:RG});
const g=lu3.apprisComptes['4110TRA00100'];
ok('elle produit bien des lignes', lu3.lignes.length>0);
ok('9 sur 10 ne suffisent plus : le compte n’apprend rien', !g);
ok('  … et le tiers non plus', !lu3.apprisTiers['T-77']);

console.log('\n=== sans la correction, le mélange aurait tout perdu ===');
// La preuve par l'absurde : si l'on comptait les orthographes séparément,
// « Transition Pro » ferait 2 voix sur 4 — pas l'unanimité, donc rien d'appris,
// alors que les quatre lignes disent la même chose.
const brut=new Map([['Transition Pro',2],['Transition pro',2]]);
let tete=0; for(const [,n] of brut) tete=Math.max(tete,n);
ok('le vote naïf aurait donné 2 voix sur 4, donc aucun apprentissage', tete < 4);
