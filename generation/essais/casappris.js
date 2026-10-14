const DEPOT=require('path').resolve(__dirname,'..','..');
const fs=require('fs'), vm=require('vm');
const R=DEPOT+'/recouvrement';
const ctx={self:{},window:{},console,Buffer,process,TextDecoder,TextEncoder,Date,Math,JSON};
ctx.self=ctx;ctx.window=ctx;ctx.globalThis=ctx;vm.createContext(ctx);
for(const f of [DEPOT+'/vendor/papaparse.min.js',R+'/js/rules.js',R+'/js/ingest.js',R+'/js/grandlivre.js'])
  vm.runInContext(fs.readFileSync(f,'utf8'),ctx);
const GL=ctx.LioraGrandLivre, Rr=ctx.LioraRules, RG=Rr.DEFAULT_ECHEANCE_RULES;
const ok=(t,c)=>{console.log((c?'  OK  ':'ÉCHEC ')+t); if(!c) process.exitCode=1;};
const L=c=>c.financement?Rr.getRule(c.financement,RG).label:'À classer';
// Un extrait comptable se reconnaît à ses colonnes de lettrage et de
// débit/crédit : sans « Let. », le lecteur bascule sur un autre format et ne
// forme aucun groupe. La fixture doit donc porter la colonne.
const L_=(o)=>({'Let.':'', ...o});

// ── une balance déjà classée ──
const ancienne=[
  L_({'N° de compte':'411DUP00100','Libellé de compte':'Jean Dupont','Identifiant du tiers':'T-1',
   'Tiers':'Jean Dupont','N° de facture':'FACT-2501-0001','Débit':'1000','Crédit':'0',
   'Date de facture':'10/01/2025','Sous catégorie de type de client':'CPF'}),
  L_({'N° de compte':'411DUP00100','Libellé de compte':'Jean Dupont','Identifiant du tiers':'T-1',
   'Tiers':'Jean Dupont','N° de facture':'','Débit':'0','Crédit':'400',
   'Date de facture':'20/01/2025','Sous catégorie de type de client':'CPF'}),
  L_({'N° de compte':'411MIX00100','Libellé de compte':'Compte partagé','Identifiant du tiers':'T-2',
   'Tiers':'Compte partagé','N° de facture':'FACT-2501-0002','Débit':'500','Crédit':'0',
   'Date de facture':'11/01/2025','Sous catégorie de type de client':'CPF'}),
  L_({'N° de compte':'411MIX00100','Libellé de compte':'Compte partagé','Identifiant du tiers':'T-2',
   'Tiers':'Compte partagé','N° de facture':'FACT-2501-0003','Débit':'500','Crédit':'0',
   'Date de facture':'12/01/2025','Sous catégorie de type de client':'B2B'}),
];
const luRef=GL.lire(ancienne,{});
console.log('=== ce qu’une balance classée apprend ===');
ok('le lecteur reconnaît bien un extrait comptable', luRef.comptable===true);
ok('elle apprend le tiers unanime', !!luRef.apprisTiers['T-1']);
ok('  … avec le bon dispositif', luRef.apprisTiers['T-1'].qualif==='CPF');
ok('  … et le nombre de lignes qui le portent', luRef.apprisTiers['T-1'].nb===2);
ok('elle apprend le compte unanime', luRef.apprisComptes['411DUP00100'].qualif==='CPF');
ok('un compte partagé 50/50 n’apprend RIEN', !luRef.apprisComptes['411MIX00100']);
ok('  … ni son tiers', !luRef.apprisTiers['T-2']);
const appris={factures:{}, tiers:luRef.apprisTiers, comptes:luRef.apprisComptes};

// ── la nouvelle balance, sans aucune colonne de classement ──
const nouvelle=[
  L_({'N° de compte':'411DUP00100','Libellé de compte':'Jean Dupont','Identifiant du tiers':'T-1',
   'Tiers':'Jean Dupont','N° de facture':'FACT-2602-0009','Débit':'800','Crédit':'0',
   'Date de facture':'05/02/2026'}),
  L_({'N° de compte':'411DUP00100','Libellé de compte':'Jean Dupont','Identifiant du tiers':'T-1',
   'Tiers':'Jean Dupont','N° de facture':'','Débit':'0','Crédit':'300',
   'Date de facture':'08/02/2026'}),
];
const ouv=GL.creancesOuvertes(GL.lire(nouvelle,{}));
console.log('\n=== la nouvelle balance, sans vos colonnes ===');
ok('elle produit bien des créances (sinon le test ne prouve rien)', ouv.length>0);
const rien={factures:{},tiers:{},comptes:{}};
const sans=GL.classer(ouv,{rules:RG,sellsy:[],mandats:[],referentiel:{},regles:[],appris:rien});
ok('sans apprentissage, rien n’est classé', sans.length>0 && sans.every(x=>!x.financement));
const avec=GL.classer(ouv,{rules:RG,sellsy:[],mandats:[],referentiel:{},regles:[],appris});
ok('avec apprentissage, tout est classé', avec.length>0 && avec.every(x=>!!x.financement));
ok('  … en CPF', avec.every(x=>L(x)==='CPF'));
ok('  … et l’origine nomme l’ancien grand livre',
   avec.every(x=>/Ancien grand livre/.test(x.origineClassement||'')));

console.log('\n=== l’apprentissage comble, il ne recouvre pas ===');
// L'extrait porte lui-même une qualification : elle est retenue, mais DERRIÈRE
// l'ancien grand livre — c'est votre règle, « toujours prendre l'ancien grand
// livre comme référence quand il y a un désaccord ».
const avecQualif=nouvelle.map(r=>({...r,'Sous catégorie de type de client':'B2B'}));
const ouv3=GL.creancesOuvertes(GL.lire(avecQualif,{}));
ok('elle produit bien des créances', ouv3.length>0);
const c3=GL.classer(ouv3,{rules:RG,sellsy:[],mandats:[],referentiel:{},regles:[],appris});
ok('l’ancien grand livre l’emporte sur la colonne du fichier',
   c3.length>0 && c3.every(x=>L(x)==='CPF'));
// Et sans apprentissage, c'est bien la colonne du fichier qui sert.
const c3b=GL.classer(ouv3,{rules:RG,sellsy:[],mandats:[],referentiel:{},regles:[],appris:rien});
ok('  … et sans apprentissage, la colonne du fichier sert', c3b.every(x=>L(x)==='B2B'));

console.log('\n=== un compte inconnu reste à classer ===');
const inconnu=[
  L_({'N° de compte':'411ZZZ99900','Libellé de compte':'Client inconnu','Identifiant du tiers':'T-9',
   'Tiers':'Client inconnu','N° de facture':'FACT-2602-0099','Débit':'900','Crédit':'0',
   'Date de facture':'05/02/2026'}),
  L_({'N° de compte':'411ZZZ99900','Libellé de compte':'Client inconnu','Identifiant du tiers':'T-9',
   'Tiers':'Client inconnu','N° de facture':'','Débit':'0','Crédit':'100',
   'Date de facture':'06/02/2026'}),
];
const ouv4=GL.creancesOuvertes(GL.lire(inconnu,{}));
ok('elle produit bien des créances', ouv4.length>0);
const c4=GL.classer(ouv4,{rules:RG,sellsy:[],mandats:[],referentiel:{},regles:[],appris});
ok('rien n’est inventé', c4.every(x=>!x.financement));
