const {ctx,X,ANC,NOUV,feuille,dser}=require('./socle.js');
const GL=ctx.LioraGrandLivre, R=ctx.LioraRules, SE=ctx.LioraSellsy, I=ctx.LioraIngest;
const RG=R.DEFAULT_ECHEANCE_RULES, fs=require('fs');
// Les mandats de prélèvement, tirés de son export GoCardless. Sans eux,
// l'exception qu'elle a posée — « les GoCardless sont prioritaires, date
// d'échéance fin de formation » — ne se déclenchait sur aucune créance :
// la colonne de mandat est vide sur tout l'extrait Pennylane.
let MANDATS=[];
try{ MANDATS=JSON.parse(fs.readFileSync('mandats.json','utf8')); }catch(e){}
console.log('mandats GoCardless : '+MANDATS.length+' client'+(MANDATS.length>1?'s':'')
  +' · '+new Set(MANDATS.flatMap(m=>m.factures||[])).size+' numéros de facture');
const REF=new Date(2026,9,12);            // date d'arrêté
const fr=d=>{ if(!d) return ''; const x=new Date(d);
  return String(x.getUTCDate()).padStart(2,'0')+'/'+String(x.getUTCMonth()+1).padStart(2,'0')+'/'+x.getUTCFullYear(); };
const ar=n=>n==null?'':Math.round(n*100)/100;
const lab=f=>f?R.getRule(f,RG).label:'À classer';
// Ses trois types de client, dictés le 16/10/2026. Tout ce qui n'en est pas un
// est rendu vide plutôt que publié : un quatrième type naîtrait sinon d'un
// dispositif que le référentiel n'a pas encore rattaché, et la colonne
// « À compléter » est faite pour ça.
const TROIS=new Set(['Étatique','Corporate','Financement personnel']);
const troisTypes=t=>TROIS.has(t)?t:'';

// ───────── sources ─────────
// La référence de classement : sa feuille « Copie de Grand livre -Clients  »
// — l'onglet 4 de son classeur, intact — réunie à l'impression PDF de cette
// même feuille, qui porte des lignes que l'onglet n'a pas. Les deux s'accordent
// sur leurs 367 comptes communs sans un seul désaccord.
//
// L'onglet 3, « Grand livre -Clients  Non lettr », est écarté : c'est une
// feuille de travail dont les colonnes de classement sont des valeurs collées
// à la main — zéro formule — que ses propres XLOOKUP, qui pointent vers
// l'onglet 4, contredisent sur deux comptes sur trois.
const REFERENCE='Reference-septembre.xlsx';
const anc=feuille(REFERENCE,'Grand livre -Clients  Non lettr',1);
const luAnc=GL.lire(anc.rows,{rules:RG});
const appris={
  factures:Object.fromEntries(Object.entries(GL.referentielDepuis(luAnc.lignes,RG)).map(([k,v])=>[k,v.fin])),
  tiers:luAnc.apprisTiers, comptes:luAnc.apprisComptes };
// La facturation, dans ses exports frais : celui de son classeur s'arrêtait à
// FACT-2609-15986, et 229 des 230 factures de septembre du grand livre lui
// étaient postérieures. Les avoirs viennent avec, ils portent eux aussi un type
// de client.
const csv=f=>ctx.Papa.parse(fs.readFileSync(f,'utf8'),{header:true,skipEmptyLines:true,delimiter:';'}).data;
const zo=feuille(ANC,'BdD Zoho - Toutes les factures ',0);
const sellsy=(SE.lireExport(csv('depot-sellsy/sellsy.csv')).lignes||[])
  .concat(SE.lireExport(csv('depot-sellsy/avoirs.csv')).lignes||[])
  .concat(SE.lireExport(zo.rows).lignes||[]);
console.log('facturation : '+sellsy.length+' lignes (factures + avoirs + Zoho)');
// Les dossiers du financeur, dans leur export du 13/10/2026 : 4 662 lignes
// contre 3 006 au classeur, et 518 numéros de facture de plus. Ce sont les
// seules dates de formation de l'alternance — Sellsy ne les porte pas.
// L'export du 13/10 d'abord — 2 334 factures datées contre 1 827 — puis celui
// du classeur, qui connaît seul onze dossiers de plus.
const fi={rows: feuille('depot-ech/echeances.xlsx','Échéances',0).rows
  .concat(feuille(ANC,'BdD Filiz - Facture Alternance',0).rows)};
// Le fichier du financeur a UNE LIGNE PAR ÉCHÉANCE, pas par facture : 4 662
// lignes pour 2 334 factures. Garder la première ligne rencontrée revenait à
// tirer au sort laquelle des échéances datait la facture — et sur 151 d'entre
// elles la première ne portait pas de date de facturation. On consolide donc :
// le contrat commence au plus tôt, finit au plus tard, et la facturation est la
// première date réellement renseignée.
const parFacture=new Map();
for(const r of fi.rows){ const num=String(r['NUMERO FACTURE']||'').trim(); if(!num) continue;
  const cle=I.factureKey(num); if(!cle) continue;
  const d=dser(r['DATE DEBUT CONTRAT']), f=dser(r['DATE FIN CONTRAT']), fa=dser(r['DATE FACTURATION']);
  if(!d&&!f&&!fa) continue;
  const e=parFacture.get(cle)||{cle,numero:num,dateDebutFormation:null,dateFinFormation:null,dateFacture:null};
  if(d&&(!e.dateDebutFormation||d<e.dateDebutFormation)) e.dateDebutFormation=d;
  if(f&&(!e.dateFinFormation||f>e.dateFinFormation)) e.dateFinFormation=f;
  if(fa&&!e.dateFacture) e.dateFacture=fa;
  parFacture.set(cle,e); }
const factFiliz=[...parFacture.values()];
console.log('dossiers du financeur : '+fi.rows.length+' lignes → '+factFiliz.length+' factures consolidées');

// Les dates de formation que SA balance de septembre porte et que ni Sellsy ni
// Zoho ne connaissent : 194 factures d'alternance « FCT-FILIZ-… ». Elles ne
// viennent qu'en dernier, après Sellsy, et ne remplissent que les vides — une
// date de formation est un fait sur la formation, c'est la règle du dispositif
// qui décide ensuite de l'échéance.
const datesSeptembre=[];
for(const [cle,d] of (luAnc.datesParNumero||new Map())){
  if(!d.debut&&!d.fin&&!d.facture) continue;
  datesSeptembre.push({cle, numero:cle, dateDebutFormation:d.debut||null,
    dateFinFormation:d.fin||null, dateFacture:d.facture||null});
}
console.log('dates de formation reprises de septembre : '+datesSeptembre.length+' factures');

const nouv=feuille(NOUV,'Grand livre - Clients',0);
const lu=GL.lire(nouv.rows,{});
const cl=GL.classer(GL.creancesOuvertes(lu),
  {rules:RG, sellsy, factures:factFiliz.concat(datesSeptembre), mandats:MANDATS, referentiel:{}, regles:[], appris});

// ───────── ce qu'elle a complété dans la balance publiée ─────────
// Un dispositif qu'elle a tranché à la main dans la page revient ici et prime
// sur la règle : c'est sa décision, elle ne se redemande pas tous les mois.
// Le fichier est écrit depuis la base de l'artefact — une ligne par créance,
// avec sa clé, le dispositif retenu et la date du choix.
// Les intitulés qu'un dispositif a portés avant d'être renommé. Ses décisions
// sont enregistrées sous le nom en vigueur le jour où elle les a prises : sans
// cette table, renommer un type de financement les perdrait toutes en silence.
// « B2C-Perso » est devenu « Financement personnel » le 16/10/2026, et huit de
// ses décisions le portent encore.
const ANCIENS=[['B2C-Perso','BTC_PERSO']];
let complements=[];
try{ complements=JSON.parse(fs.readFileSync('complements.json','utf8')); }catch(e){}
// Ce fichier est un INSTANTANÉ de la base de l'artefact, pas la base elle-même :
// node ne sait pas l'interroger. Un instantané vieilli perd en silence tout ce
// qu'elle a complété dans la page depuis — c'est arrivé le 14/10, cinq
// décisions dont deux qu'elle venait de me donner. On dit donc son âge, et on
// refuse de construire sur un instantané de plus d'un jour sans le dire.
{
  let quandInstantane=null;
  try{ quandInstantane=fs.statSync('complements.json').mtime; }catch(e){}
  const ages=quandInstantane?(Date.now()-quandInstantane.getTime())/3600000:null;
  console.log('compléments : instantané du '+(quandInstantane?fr(quandInstantane)+' à '
    +String(quandInstantane.getHours()).padStart(2,'0')+'h'
    +String(quandInstantane.getMinutes()).padStart(2,'0'):'— aucun fichier —')
    +' · '+complements.length+' décision'+(complements.length>1?'s':''));
  if(ages===null||ages>24) console.log('  ⚠ À RAFRAÎCHIR depuis la base de l’artefact '
    +'(collection « complements ») avant de livrer : ce qu’elle a complété depuis serait perdu.');
}
if(complements.length){
  const parLabel=new Map(RG.filter(r=>r&&r.key&&r.label).map(r=>[r.label,r.key]).concat(ANCIENS));
  const parCleCreance=new Map();
  for(const c of cl) parCleCreance.set((c.compte||'')+'|'+(c.lettre||GL.POOL_NON_LETTRE)+'|'+(c.numero||''),c);
  // Trois rattrapages, du plus précis au plus large. Sa décision est rangée
  // sous « compte | lettrage | facture » : si le comptable lettre la facture le
  // mois suivant, la clé change et le complément se perdrait. On la retrouve
  // alors par le compte et la facture, puis — pour un solde sans facture — par
  // le seul compte.
  // Le dernier rattrapage rend une LISTE. Depuis qu'un lot sans facture fait
  // une créance par facture citée, sa décision prise sur « le solde du compte »
  // ne vise plus une créance mais plusieurs — et quand toutes les écritures du
  // lot citent un numéro, il n'en reste même aucune qui porte l'ancienne clé.
  // Trois de ses décisions se perdaient ainsi en silence.
  const parCompteFacture=new Map(), parComptesSansFacture=new Map(), parLotSansFacture=new Map();
  for(const c of cl){
    if(c.numero && !c.citee){ const k=(c.compte||'')+'|'+I.factureKey(c.numero);
      if(!parCompteFacture.has(k)) parCompteFacture.set(k,c); continue; }
    if(c.numero){ const k=(c.compte||'')+'|'+I.factureKey(c.numero);
      if(!parCompteFacture.has(k)) parCompteFacture.set(k,c); }
    const lot=(c.compte||'')+'|'+(c.lettre||GL.POOL_NON_LETTRE);
    if(!parLotSansFacture.has(lot)) parLotSansFacture.set(lot,[]);
    parLotSansFacture.get(lot).push(c);
    if(!parComptesSansFacture.has(c.compte)) parComptesSansFacture.set(c.compte,[]);
    parComptesSansFacture.get(c.compte).push(c);
  }
  // Une décision SANS NUMÉRO vise le solde d'un lot, pas une créance : depuis
  // qu'une écriture sans numéro fait la sienne, le lot en compte plusieurs et
  // sa décision doit toutes les atteindre. La chercher à la clé exacte n'en
  // aurait touché qu'une.
  const retrouver=v=>{
    const m=String(v.cle||'').split('|'), cpt=m[0], num=m[2]||'';
    if(num){ const exact=parCleCreance.get(v.cle); if(exact) return [exact];
      const c=parCompteFacture.get(cpt+'|'+I.factureKey(num)); return c?[c]:[]; }
    return parLotSansFacture.get(cpt+'|'+(m[1]||GL.POOL_NON_LETTRE))
      || parComptesSansFacture.get(cpt) || [];
  };
  let poses=0, rattrapes=0, eclates=0;
  for(const v of complements){
    const exact=parCleCreance.get(v.cle);
    const liste=retrouver(v), k=parLabel.get(v.dispositif);
    if(!liste.length||!k) continue;          // une écriture, pas une créance : voir plus bas
    if(!exact) rattrapes++;
    if(liste.length>1) eclates+=liste.length-1;
    for(const c of liste){
    c.financement=k;
    // La catégorie suit le dispositif, sinon la créance se contredit : Safran
    // est passé en B2B le 14/10 et sa colonne « Type de client » annonçait
    // encore « B2C - Entreprise » — la balance par catégorie l'aurait compté
    // du mauvais côté. classer() l'avait calculée avant ce crochet ; on la
    // recalcule donc ici, depuis le dispositif qu'elle vient de poser.
    c.typeClient=R.categorieDe(k,RG)||'';
    c.origineClassement='Complété à la main dans la balance publiée';
    c.preuveClassement=v.dispositif+(v.quand?' · le '+v.quand:'');
    }
    v.pose=true; poses++;
  }
  console.log('compléments repris sur les créances : '+poses+' / '+complements.length
    +(rattrapes?' · dont '+rattrapes+' retrouvés malgré un lettrage changé':'')
    +(eclates?' · '+eclates+' créances de plus touchées par une décision prise sur un solde de compte':''));
}

// ───────── la justification, mot pour mot comme dans l'appli ─────────
const BASES={dateFacture:'date de facture', dateDebutFormation:'début de formation',
  dateFinFormation:'fin de formation', dateFactureFacturation:'date de facture de la facturation',
  dateEcheanceComptable:'échéance portée par le grand livre',
  echeance1:'dernière date du libellé, sinon date d’enregistrement',
  saisieManuelle:'échéance posée à la main'};
const valeurBase=c=>({dateFacture:c.dateFacture, dateDebutFormation:c.dateDebutFormation,
  dateFinFormation:c.dateFinFormation, dateFactureFacturation:c.dateFactureFacturation,
  dateEcheanceComptable:c.dateEcheanceGrandLivre||c.dateEcheance,
  echeance1:c.dateEcheanceRepli||c.dateEcheance,
  saisieManuelle:c.dateEcheance}[c.echeanceBase]||null);
const bareme=c=>{ if(!c.financement) return '';
  const r=R.getRule(c.financement,RG), g=r&&r.gl?r.gl:r;
  return (!g||!g.base)?'':(BASES[g.base]||g.base)+(g.jours?' + '+g.jours+' j':' (sans délai)'); };
const calcul=c=>{ if(!c.dateEcheance) return '';
  // Une écriture sans facture se date SUR ELLE-MÊME. Sa règle, le 16/10/2026 :
  // « il ne faut pas regarder un lot, chaque ligne est indépendante ». La
  // phrase disait « de la plus récente écriture du lot » — elle renvoyait à une
  // autre ligne que celle qu'on lit, et faisait paraître la date sortie de
  // nulle part.
  //
  // La branche est nommée : la phrase annonçait « dernière date du libellé »
  // même quand le libellé n'en portait aucune et que l'enregistrement avait
  // servi, ce que le motif démentait sur la ligne d'à côté. Et seulement si
  // l'échéance vient VRAIMENT du repli : une écriture qui cite une facture
  // suit le barème de celle-ci, pas le repli.
  if(c.sansNumero&&c.dateFacture&&(!c.echeanceBase||c.echeanceBase==='echeance1')){
    const branche=c.echeance1Source==='libellé'
      ? 'dernière date du libellé de l’écriture'
      : 'date d’enregistrement de l’écriture';
    return branche+', le '+fr(c.dateFacture)+' = '+fr(c.dateEcheance);
  }
  const v=valeurBase(c); if(!v||!c.echeanceBase) return fr(c.dateEcheance);
  const j=c.echeanceJours||0;
  return (BASES[c.echeanceBase]||c.echeanceBase)+' '+fr(v)+(j?' + '+j+' j':'')+' = '+fr(c.dateEcheance); };
const pourquoiPas=c=>{ if(c.echeanceOrigine!=='Grand livre') return '';
  if(!c.financement) return 'aucun dispositif reconnu';
  const r=R.getRule(c.financement,RG), g=r&&r.gl?r.gl:r;
  return ((g&&g.base)?(BASES[g.base]||g.base):'la base du barème')
    +' absente — l’échéance du grand livre a servi de repli'; };
const aCompleter=c=>{
  if(!c.financement) return 'à compléter — dispositif à qualifier';
  if(!c.dateEcheance) return 'à compléter — aucune date d’échéance calculable';
  // Un solde sans facture n'aura jamais de date de formation : l'échéance 1 EST
  // sa règle, par l'une ou l'autre de ses deux branches. La branche retenue
  // reste écrite sur la ligne ; elle n'est pas signalée comme une lacune.
  if(c.sansNumero) return '';
  // L'échéance de repli est la deuxième branche de la règle, pas un défaut :
  // ce qui l'a produite reste dans « Origine de l’échéance », « Branche de
  // l'échéance 1 » et « Motif de l’écart au barème », mais elle n'est plus signalée.
  if(c.echeanceOrigine==='Grand livre') return '';
  return ''; };
const retard=c=>{ const b=c.dateEcheance||c.dateFacture; return b?R.diffDays(REF,b):null; };
const tranche=c=>{ const t=R.bucketFor(retard(c)); return t?t.label:''; };

// ───────── la feuille principale : une ligne par écriture ─────────
const plat=GL.ecrituresAPlat(lu);
// Les factures des lots entièrement soldés : hors balance, mais leurs
// écritures sont dans le grand livre et doivent se justifier.
const soldees=GL.classer(GL.facturesToutes(lu)
  .filter(c=>c.statut&&c.statut!=='Ouverte'&&c.statut!=='Partiellement réglée'),
  {rules:RG, sellsy, factures:factFiliz.concat(datesSeptembre), mandats:MANDATS, referentiel:{}, regles:[], appris});
const ecr=GL.classerEcritures(plat,cl,soldees,{sellsy,rules:RG});
const lignesEcr=ecr.lignes||ecr;
// La répartition au prorata, posée AVANT les compléments : une ligne qu'elle a
// tranchée à la main ne se redistribue pas, c'est sa décision qui prime.
{
  const b=GL.repartirAuProrata(lignesEcr,cl,{rules:RG});
  console.log('réparties au prorata : '+b.lignes+' écritures sur '+b.comptes+' comptes mixtes'
    +' · '+b.lignesChangees+' changent de type de financement ('
    +Math.round(b.euros).toLocaleString('fr-FR')+' €)'
    +' · '+b.creances+' soldes de compte, dont '+b.creancesChangees+' changent ('
    +Math.round(b.eurosCreances).toLocaleString('fr-FR')+' €)');
  for(const x of (b.ecartes||[]))
    console.log('   compte écarté du prorata : '+x.compte+' — ses factures portent '
      +x.types.join(' · ')+', qui n’est pas un type de financement à part entière');
}
// Le reste des compléments ne vise pas une créance : ce sont des écritures de
// lots déjà soldés, qui ne pèsent rien dans la balance mais qu'elle a tout de
// même classées — et que le premier crochet laissait filer. Sa clé est alors
// celle que la page forme à défaut de créance : compte, numéro, date.
if(complements.length){
  const parLabel2=new Map(RG.filter(r=>r&&r.key&&r.label).map(r=>[r.label,r.key]).concat(ANCIENS));
  const parCleEcriture=new Map();
  plat.forEach((l,i)=>{
    const B=l.brut||{};
    const cle=(l.compte||'')+'|'+(l.numero||B.numeroPiece||'·')+'|'+fr(l.date);
    if(!parCleEcriture.has(cle)) parCleEcriture.set(cle,[]);
    parCleEcriture.get(cle).push(i);
  });
  let poses=0, perdus=[];
  for(const v of complements){
    if(v.pose) continue;
    const idx=parCleEcriture.get(v.cle), k=parLabel2.get(v.dispositif);
    if(!idx||!k){ perdus.push(v.cle+' → '+v.dispositif); continue; }
    for(const i of idx){
      const e=lignesEcr[i]; if(!e) continue;
      e.financement=k;
      e.typeClient=R.categorieDe(k,RG)||'';
      e.origineClassement='Complété à la main dans la balance publiée';
      e.preuveClassement=v.dispositif+(v.quand?' · le '+v.quand:'');
    }
    v.pose=true; poses++;
  }
  console.log('compléments repris sur les écritures : '+poses
    +(perdus.length?' · perdus : '+perdus.join(' ; '):' · aucun perdu'));
}
// la créance qui porte la date, retrouvée par son numéro puis par son groupe
const parCle=new Map(), parGroupe=new Map(), parCompteCle=new Map();
for(const c of cl.concat(soldees)){ if(c.cle&&!parCle.has(c.cle)) parCle.set(c.cle,c);
  if(c.cle){ const k=(c.compte||'')+'|'+c.cle; if(!parCompteCle.has(k)) parCompteCle.set(k,c); }
  const g=(c.compte||'')+'|'+(c.lettre||'(non lettré)');
  if(!parGroupe.has(g)) parGroupe.set(g,c); }
// LA créance de la ligne : celle de SON compte ET de son lettrage. Le
// classement, lui, peut venir de la facture citée même si elle vit ailleurs —
// un règlement Alma cite la facture de son client, et c'est bien son dispositif
// qu'il faut suivre. Mais l'IDENTITÉ de la créance, non : 223 lignes portaient
// le reste dû, la sous-catégorie et la tranche d'une créance d'un autre compte,
// et le détail ouvert depuis la balance affichait B2B à 1 403 255 € là où la
// balance en compte 1 400 561.
const grp=x=>(x.compte||'')+'|'+(x.lettre||GL.POOL_NON_LETTRE);
// Deux factures du même numéro dans le même lettrage : le grand livre en porte
// 54 paires. Elles font deux créances, qui se partagent le solde au prorata.
// Sans rang, elles partageraient aussi leur clé et le détail n'en montrerait
// qu'une. Le rang ne s'écrit que lorsqu'il y a doublon : la clé d'une créance
// ordinaire ne bouge pas, et les compléments déjà posés restent valables.
// LE solde de compte d'un lot : la créance qui ne porte aucun numéro. Depuis
// qu'un lot sans facture fait UNE CRÉANCE PAR FACTURE CITÉE, un lot peut en
// compter plusieurs ; une écriture qui ne cite rien ne doit pas tomber sur la
// première venue. Sans cela les treize lignes du compte Alma affichaient
// toutes le reste dû et l'échéance de la facture FACT-2506-10079.
const parGroupeSolde=new Map(), parBrut=new Map();
for(const c of cl) if(c.sansNumero && !c.cle){ const g=grp(c);
  if(!parGroupeSolde.has(g)) parGroupeSolde.set(g,c);
  // Depuis qu'une écriture sans numéro fait SA créance, c'est la ligne
  // elle-même qui désigne la sienne. L'écriture à plat est un autre objet que
  // la ligne du grand livre, mais toutes deux portent la même ligne brute :
  // c'est elle qui fait le lien.
  if(c.brutLigne && !parBrut.has(c.brutLigne)) parBrut.set(c.brutLigne,c); }
const parGroupeCle=new Map(), cleDe=new Map();
{ const vus=new Map();
  for(const c of cl){
    const base=grp(c)+'|'+(c.numero||'');
    const n=(vus.get(base)||0)+1; vus.set(base,n);
    cleDe.set(c, n===1?base:base+'#'+n);
    if(c.cle){ const k=grp(c)+'|'+c.cle;
      if(!parGroupeCle.has(k)) parGroupeCle.set(k,[]);
      parGroupeCle.get(k).push(c); } }
  for(const c of soldees) if(!cleDe.has(c)) cleDe.set(c, grp(c)+'|'+(c.numero||''));
}
// Le rang de chaque écriture au débit parmi celles qui portent le même numéro
// dans le même lettrage : la première facture va à la première créance.
const rangLigne=new Map();
{ const vus=new Map();
  for(const l of plat){
    if((l.debit||0)<=0.01 || !l.numero) continue;
    const k=grp(l)+'|'+I.factureKey(l.numero);
    const n=(vus.get(k)||0)+1; vus.set(k,n); rangLigne.set(l,n); } }
const creanceDuCompte=l=>{
  if(l.numero){
    const liste=parGroupeCle.get(grp(l)+'|'+I.factureKey(l.numero));
    if(liste&&liste.length) return liste[Math.min(rangLigne.get(l)||1,liste.length)-1];
  } else {
    const propre=l.brut&&parBrut.get(l.brut); if(propre) return propre;
    const s=parGroupeSolde.get(grp(l)); if(s) return s;
  }
  return parGroupe.get(l.cleGroupe)
    || (l.numero&&parCompteCle.get((l.compte||'')+'|'+I.factureKey(l.numero)))
    || null;
};
// Le libellé de compte, seule colonne que l'écriture à plat ne porte pas.
const libelleCompte=new Map();
for(const r of nouv.rows){ const k=String(r['N° de compte']||'').trim();
  if(k && !libelleCompte.has(k)) libelleCompte.set(k, r['Libellé de compte']||''); }

// ───────── les propositions de rapprochement ─────────
// Un règlement non lettré, et les créances ouvertes de son compte : le moteur
// comptable dit laquelle il solderait, et avec quel degré de certitude. C'est
// la matière du filtre « proposition de rapprochement » de la page.
const nonPointes=plat.filter(l=>(l.credit||0)>0.01 && (l.lettre===GL.POOL_NON_LETTRE||!l.lettre));
const props=GL.propositionsRapprochement(nonPointes,cl);
const parLigne=new Map();
nonPointes.forEach((l,i)=>{ const p=props[i]; if(!p) return;
  const nums=(p.proposition||[]).map(c=>c.numero||'(solde de compte)').filter(Boolean);
  if(!nums.length) return;
  parLigne.set(l, {quoi:nums.join(' + '), force:p.force||'', raison:p.raison||'',
    euros:(p.proposition||[]).reduce((a,c)=>a+(c.resteDu||0),0)}); });
console.log('propositions de rapprochement : '+parLigne.size+' sur '+nonPointes.length+' règlements non pointés');

// Une proposition ne se lit qu'en couple : la facture au débit, le règlement
// au crédit, l'une sous l'autre — c'est ainsi qu'elle pointe à l'œil. On
// numérote donc chaque proposition et on pose ce numéro sur LES DEUX lignes,
// celle du paiement et celle de la ou des factures proposées. Le couple se
// reconstitue alors sans rapprochement de chaînes dans la page.
const numNorm=n=>String(n||'').trim().toUpperCase();
const lignesAuDebit=new Map();     // compte|lettre|numéro → lignes au débit
for(const l of plat){ if((l.debit||0)<=0.01) continue;
  const k=(l.compte||'')+'|'+(l.lettre||GL.POOL_NON_LETTRE)+'|'+numNorm(l.numero);
  const a=lignesAuDebit.get(k)||[]; a.push(l); lignesAuDebit.set(k,a); }
const rappro=new Map();            // ligne → numéros de rapprochement
const poser=(l,n)=>{ const a=rappro.get(l)||[]; a.push(n); rappro.set(l,a); };
let nRappro=0, sansLigne=0, apparies=0, trop=0;
nonPointes.forEach((l,i)=>{ const p=props[i]; if(!p||!parLigne.has(l)) return;
  const n=++nRappro; poser(l,n); let trouve=0;
  for(const c of (p.proposition||[])){
    const k=(c.compte||'')+'|'+(c.lettre||GL.POOL_NON_LETTRE)+'|'+numNorm(c.numero);
    let lignes=lignesAuDebit.get(k);
    // Une créance SANS NUMÉRO n'est pas une facture : c'est le solde du compte,
    // et la clé attrape alors TOUTES les écritures non numérotées du compte.
    // Une ou deux, c'est bien la dette qui fait face au règlement et il faut la
    // voir ; quarante, ce n'est plus un couple mais le relevé du compte — un
    // seul règlement en traînait 86, et l'écran ne montrait plus que des
    // débits. Au-delà de trois, le règlement reste seul et sa proposition dit
    // « (solde de compte) ».
    if(lignes && !numNorm(c.numero) && lignes.length>3){ trop++; lignes=null; }
    if(!lignes||!lignes.length){ sansLigne++; continue; }
    for(const m of lignes) poser(m,n);
    trouve++;
  }
  if(trouve) apparies++;
});
console.log('rapprochements numérotés : '+nRappro+' · avec leur ligne au débit : '+apparies
  +' · sans ligne retrouvée : '+sansLigne+' · soldes de compte trop larges pour un couple : '+trop);

const principale=[];
for(let i=0;i<plat.length;i++){
  const l=plat[i], e=lignesEcr[i]||{}, B=l.brut||{};
  const src0=(l.numero&&parCle.get(I.factureKey(l.numero)))
    ||(!l.numero&&l.brut&&parBrut.get(l.brut))
    ||(!l.numero&&parGroupeSolde.get(grp(l)))||parGroupe.get(l.cleGroupe)||{};
  // Quand aucune facture ne date la ligne, la ligne se date elle-même :
  // l'échéance 1, portée par l'écriture, avec son motif.
  // Quand aucune créance ne porte la ligne — un lot soldé à zéro, par exemple —
  // c'est l'écriture elle-même qui a été classée et datée. Lire la créance
  // absente faisait dire « dispositif à qualifier » à une ligne que la
  // facturation venait pourtant de classer.
  const propre=creanceDuCompte(l);
  const src={...src0,
    financement: src0.financement||e.financement||null,
    typeClient: src0.typeClient||e.typeClient||null,
    numero: src0.numero||e.numeroFacture||l.numero||'',
    sansNumero: src0.financement?src0.sansNumero:!l.numero,
    dateEcheance: src0.dateEcheance||e.dateEcheance||null,
    echeanceOrigine: src0.dateEcheance?src0.echeanceOrigine:(e.echeanceOrigine||''),
    echeanceMotif: src0.dateEcheance?src0.echeanceMotif:(e.echeanceMotif||'')};
  const o={
    // ── vos colonnes, dans votre ordre ──
    'N° de compte':l.compte||'',
    'Libellé de compte':libelleCompte.get(l.compte)||l.tiers||'',
    'Date':fr(l.date),
    'Journal':l.journal||'',
    'Libellé de pièce':B.libellePiece||'',
    'Libellé de ligne':B.libelleLigne||'',
    'N° de pièce':B.numeroPiece||'',
    'N° de facture':l.numero||'',
    'Taux d’attribution TVA':B.tauxTva==null?'':B.tauxTva,
    'Let.':l.lettre||'',
    'Devise':B.devise||'',
    'Taux de change':B.tauxChange==null?'':B.tauxChange,
    'Débit':ar(l.debit),
    'Crédit':ar(l.credit),
    'Solde':B.balance==null?'':B.balance,
    'Catégories analytiques':B.categories||'',
    'Identifiant du tiers':l.identifiantTiers||'',
    'Tiers':l.tiers||'',
    'SIREN':l.siren||'',
    'Date d’enregistrement':fr(B.dateEnregistrement),
    'Auteur':B.auteur||'',
    'Débit en devise d’origine':B.debitDevise==null?'':B.debitDevise,
    'Crédit en devise d’origine':B.creditDevise==null?'':B.creditDevise,
    'Date d’échéance':fr(l.dateEcheanceFichier),
    // ── le classement ──
    '— CLASSEMENT —':'',
    'Nature de l’écriture':l.nature||'',
    // Un type de financement entraîne son type de client : si ni l'écriture
    // ni la créance ne le portent, le barème le donne. Et le résultat doit
    // être l'un de ses trois types, pas un quatrième : « Alternance » seul ne
    // dit pas si l'alternance est financée par l'OPCO, par l'entreprise ou par
    // l'alternant, et le laisser passer ouvrait une catégorie de fait, à
    // quatre écritures. Sa règle pour ce cas est d'écrire « à compléter ».
    'Type de client':troisTypes(e.typeClient||src.typeClient
      ||R.categorieDe(e.financement||src.financement,RG)||''),
    'Type de financement':lab(e.financement||src.financement||null),
    // Sa décision prime sur l'origine de l'écriture. Sans cela, une créance
    // qu'elle a complétée à la main portait « Hérité de la facture du même
    // lettrage » : la balance appliquait bien son choix, mais la ligne ne le
    // disait plus — 15 décisions sur 34 devenaient invisibles à l'audit.
    'Origine du classement':(src.origineClassement||'').startsWith('Complété à la main')
      ? src.origineClassement : (e.origineClassement||src.origineClassement||''),
    'Justificatif du classement':(src.origineClassement||'').startsWith('Complété à la main')
      ? (src.preuveClassement||'') : (e.preuveClassement||src.preuveClassement||''),
    'Facture rattachée':src.numero||'',
    // ── l'échéance, justifiée ──
    '— ÉCHÉANCE —':'',
    'Date d’échéance du grand livre':fr(src.dateEcheanceGrandLivre),
    'Date d’échéance recalculée':fr(src.dateEcheance),
    'Jours de retard':retard(src)==null?'':retard(src),
    'Tranche d’ancienneté':tranche(src),
    'Barème appliqué':bareme(src),
    'Base de calcul retenue':src.echeanceBase?(BASES[src.echeanceBase]||src.echeanceBase):'',
    'Date de la base retenue':fr(valeurBase(src)),
    'Délai appliqué (jours)':src.echeanceJours==null?'':src.echeanceJours,
    'Détail du calcul':calcul(src),
    'Origine de l’échéance':src.echeanceOrigine||(src.dateEcheance?'':'aucune'),
    'Repli appliqué':src.echeance1Source||e.echeance1Source||'',
    'Exception appliquée':src.echeanceMotif||'',
    'Motif de l’écart au barème':pourquoiPas(src),
    'Date de début de formation':fr(src.dateDebutFormation),
    'Date de fin de formation':fr(src.dateFinFormation),
    'Date de facture (facturation)':fr(src.dateFactureFacturation),
    // Une créance que la balance compte dans « À classer » doit pouvoir être
    // complétée, même quand SON ÉCRITURE a été classée par ailleurs. Deux
    // d'entre elles — NEXORIS et David Jouve, 5 478 € au crédit — n'avaient
    // aucune ligne signalée : le compte n'a reçu qu'un règlement citant une
    // facture jamais passée au débit, la ligne héritait du classement de cette
    // facture, et la créance, elle, restait « À classer » sans que rien ne le
    // dise. Invisible au filtre, donc incomplétable.
    'À compléter':aCompleter(src)
      || ((src0&&src0.compte&&!src0.financement&&Math.abs(src0.resteDu||0)>0.005)
          ? 'à compléter — dispositif de la créance à qualifier' : '')
      || (troisTypes(e.typeClient||src.typeClient
            ||R.categorieDe(e.financement||src.financement,RG)||'')===''
          && (e.financement||src.financement)
          ? 'à compléter — « '+lab(e.financement||src.financement)
            +' » ne désigne pas encore un de vos trois types de client' : ''),
    'N° de rapprochement':(rappro.get(l)||[]).join(' · '),
    'Proposition de rapprochement':(parLigne.get(l)||{}).quoi||'',
    'Fiabilité du rapprochement':(parLigne.get(l)||{}).force||'',
    'Justificatif du rapprochement':(parLigne.get(l)||{}).raison||'',
    'Reste dû de la créance':propre?ar(propre.resteDu):'',
    // La sous-catégorie et la tranche DE LA CRÉANCE, et non celles que la
    // ligne affiche. Les deux diffèrent : quand la créance n'est pas classée,
    // la ligne retombe sur le classement de son écriture — « B2C-Entreprise »
    // s'affichait sur une créance que la balance compte dans « À classer ».
    // Un complément doit déplacer le montant depuis la ligne de synthèse où il
    // est réellement compté, pas depuis celle que l'écriture donne à voir.
    'Type de financement de la créance':propre?lab(propre.financement):'',
    // Et sa CATÉGORIE, pour la même raison. La page la devinait en rattachant
    // chaque sous-catégorie à la catégorie de la première ligne rencontrée :
    // les 31 créances « ETAT » tombaient toutes sous une seule des deux
    // catégories qu'elles portent réellement (29 B2C-Entreprise, 2 B2B), et
    // la balance par catégorie s'écartait de celle par sous-catégorie.
    // Chaque créance porte maintenant la sienne, lisible sur la ligne.
    'Type de client de la créance':propre?(propre.typeClient||R.categorieDe(propre.financement,RG)||''):'',
    'Tranche de la créance':propre?tranche(propre):'',
    // L'identité de la créance, telle que le moteur la forme : compte, lettre
    // de lettrage, numéro. Sans elle, la page ne peut pas réagréger — plusieurs
    // écritures portent le même reste dû, et les compter une fois chacune
    // gonflait le total. Avec elle, la page refait la balance à partir des
    // lignes, et une ligne complétée déplace son montant sous les yeux.
    'Clé de la créance':propre?(cleDe.get(propre)||grp(propre)+'|'+(propre.numero||'')):'',
  };
  principale.push(o);
}
console.log('feuille principale : '+principale.length+' lignes × '+Object.keys(principale[0]).length+' colonnes');
fs.writeFileSync('principale.json',JSON.stringify({n:principale.length}));

// ───────── les autres onglets ─────────
const ligneCreance=c=>({
  'À compléter':aCompleter(c),
  'Facture':c.numero||'', 'Client':c.tiers||'', 'N° de compte':c.compte||'',
  'Identifiant du tiers':c.identifiantTiers||'', 'Lettrage':c.lettre||'', 'SIREN':c.siren||'',
  'Nature':c.sansNumero?'Solde sans facture':'Facture',
  'Type de client':c.typeClient||R.categorieDe(c.financement,RG)||'', 'Type de financement':lab(c.financement),
  'Origine du classement':c.origineClassement||'', 'Justificatif du classement':c.preuveClassement||'',
  'Montant facture':ar(c.montant), 'Restant dû':ar(c.resteDu),
  'Date de facture':fr(c.dateFacture), 'Début de formation':fr(c.dateDebutFormation),
  'Fin de formation':fr(c.dateFinFormation), 'Date de facture (facturation)':fr(c.dateFactureFacturation),
  'Échéance du grand livre':fr(c.dateEcheanceGrandLivre),
  'Barème appliqué':bareme(c), 'Base de calcul retenue':c.echeanceBase?(BASES[c.echeanceBase]||c.echeanceBase):'',
  'Date de la base retenue':fr(valeurBase(c)), 'Délai appliqué (jours)':c.echeanceJours==null?'':c.echeanceJours,
  'Échéance recalculée':fr(c.dateEcheance), 'Détail du calcul':calcul(c),
  'Origine de l’échéance':c.echeanceOrigine||'', 'Repli appliqué':c.echeance1Source||'',
  'Exception appliquée':c.echeanceMotif||'',
  'Motif de l’écart au barème':pourquoiPas(c),
  'Jours de retard':retard(c)==null?'':retard(c), 'Tranche':tranche(c),
  'Libellé de l’écriture':c.libelle||'', 'Journal':c.journal||'',
});
const bal=GL.balanceAgee(cl,REF,RG);
const balCat=GL.balanceAgee(cl,REF,RG,'categorie');
const buckets=R.AGING_BUCKETS.filter(b=>b.key!=='nonEchu');
// La part du NOMBRE de créances que porte la ligne. Sa règle, le 16/10/2026 :
// « 3 324 créances en B2C : 3 324 / 5 525 ». Écrite en fraction de 1 et
// formatée en pourcentage par Excel, pour qu'elle reste calculable.
const ligneSynth=(r,col,total)=>{ const o={}; o[col]=r.label;
  o['Restant dû']=ar(r.total); o['Échu']=ar(r.echu);
  for(const b of buckets) o[b.label]=ar(r.buckets[b.key]);
  o['Non échu']=ar(r.nonEchu); o['dont créditeur']=ar(r.crediteur||0);
  o['Sans date']=ar(r.sansDate||0); o['Créances']=r.nb;
  o['Part des créances']=(total&&total.nb)?Math.round(r.nb/total.nb*10000)/10000:'';
  return o; };
const wb=X.utils.book_new();
// Excel refuse un nom d'onglet au-delà de 31 caractères. Le tronquer en
// silence donnait « Balance âgée par type de financ » : on le refuse plutôt,
// pour que l'onglet soit nommé et non coupé.
const add=(nom,rows)=>{
  if(nom.length>31) throw new Error('onglet trop long pour Excel ('+nom.length+' caractères) : '+nom);
  return X.utils.book_append_sheet(wb,X.utils.json_to_sheet(rows.length?rows:[{'':'(aucune ligne)'}]),nom);
};

// Le premier onglet est la balance âgée telle que vous la lisez : par type de
// client — B2C, B2C - Entreprise, B2B, POEI, Alternance, Interco. Les
// sous-catégories viennent ensuite, puis le détail ligne à ligne.
// Ses trois types de client, dictés le 16/10/2026 : « étatique : Transition
// Pro, AIF, POEI, CPF, Region, OPCO alternance, OPCO, ETAT, Agefiph ;
// Corporate : B2B, B2C entreprise, Corporate alternance, Interco ;
// Financement personnel : B2C perso, Perso alternance ». Les quinze types de
// financement y sont tous, et une seule fois.
const ORDRE=['Étatique','Corporate','Financement personnel'];
const rang=l=>{const i=ORDRE.indexOf(l); return i<0?ORDRE.length+1:i;};
const catRows=[...balCat.rows].sort((a,b)=>rang(a.label)-rang(b.label)||b.total-a.total);
// Une catégorie sans créance ouverte figure quand même, à zéro : son absence
// se lit alors comme un fait, pas comme un oubli.
const vide=l=>({label:l,total:0,echu:0,nonEchu:0,nb:0,crediteur:0,sansDate:0,
  buckets:Object.fromEntries(R.AGING_BUCKETS.map(b=>[b.key,0]))});
for(const l of ORDRE) if(!catRows.some(r=>r.label===l)) catRows.splice(rang(l),0,vide(l));
// Une ligne « À classer » à zéro ne dit rien : elle sort du tableau. Les six
// types de client restent, eux, affichés à zéro — leur absence se lirait comme
// un oubli alors qu'elle est un fait.
const aQuelqueChose=r=>!(r.label==='À classer' && !r.nb && Math.abs(r.total)<0.005);
add('Balance âgée',[...catRows.filter(aQuelqueChose).map(r=>ligneSynth(r,'Type de client',balCat.total)),
  ligneSynth(balCat.total,'Type de client',balCat.total)]);
add('Balance âgée par financement',[...bal.rows.filter(aQuelqueChose).map(r=>ligneSynth(r,'Type de financement',bal.total)),
  ligneSynth(bal.total,'Type de financement',bal.total)]);
add('Balance âgée ligne à ligne',principale);
add('Créances',cl.map(ligneCreance));
add('À classer',cl.filter(c=>!c.financement).map(ligneCreance));
// « À classer » liste les CRÉANCES sans dispositif ; « À compléter », les
// ÉCRITURES que la page signale. Les deux filtres étaient devenus le même et
// les deux onglets sortaient identiques au bit près : l'un répondait à la
// question de l'autre.
add('À compléter',principale.filter(o=>o['À compléter']));
// par compte
const parCompte=new Map();
for(const c of cl){ const k=c.compte||'(sans compte)';
  let g=parCompte.get(k); if(!g){g={'N° de compte':k,'Client':c.tiers||'','Créances':0,'Restant dû':0,
    'Types de financement':new Set(),'À compléter':0}; parCompte.set(k,g);} 
  g['Créances']++; g['Restant dû']+=c.resteDu||0; g['Types de financement'].add(lab(c.financement));
  if(aCompleter(c)) g['À compléter']++; }
add('Par compte client',[...parCompte.values()].sort((a,b)=>b['Restant dû']-a['Restant dû'])
  .map(g=>({...g,'Restant dû':ar(g['Restant dû']),'Types de financement':[...g['Types de financement']].join(' · ')})));
// ce que l'ancienne balance a appris
const apprisRows=[];
for(const [k,v] of Object.entries(appris.comptes)) apprisRows.push({'Clé':'compte','Valeur':k,
  'Type de financement appris':v.qualif,'Lignes qui la portent':v.nb,'Consensus':Math.round(v.part*100)+' %'});
for(const [k,v] of Object.entries(appris.tiers)) apprisRows.push({'Clé':'identifiant du tiers','Valeur':k,
  'Type de financement appris':v.qualif,'Lignes qui la portent':v.nb,'Consensus':Math.round(v.part*100)+' %'});
add('Appris de l’ancienne balance',apprisRows);
// les règles d'échéance appliquées
add('Règles d’échéance',RG.filter(r=>r.key!=='INCONNU').map(r=>{const g=r.gl||r; return {
  'Type de financement':r.label,
  'Suivi recouvrement':(BASES[r.base]||r.base||'')+(r.jours?' + '+r.jours+' j':' (sans délai)'),
  'Balance âgée comptable':(BASES[g.base]||g.base||'')+(g.jours?' + '+g.jours+' j':' (sans délai)'),
  'Repli si la base manque':(BASES[r.fallback]||r.fallback||'')
    +(r.fallbackJours!=null?' + '+r.fallbackJours+' j':''),
};}));
fs.writeFileSync('Balance-agee-classee.xlsx',Buffer.from(X.write(wb,{type:'array',bookType:'xlsx',compression:true})));
console.log('écrit : Balance-agee-classee.xlsx');
console.log('onglets : '+wb.SheetNames.join(' · '));
console.log('\nTOTAL : '+ar(bal.total.total).toLocaleString('fr-FR')+' € · échu '
  +ar(bal.total.echu).toLocaleString('fr-FR')+' € · non échu '+ar(bal.total.nonEchu).toLocaleString('fr-FR')+' €');


// ───────── les données de la page autonome ─────────
// Mêmes lignes, mêmes colonnes : seuls les deux intertitres sautent, qui ne
// servent qu'à aérer le tableur. Les textes sont mis en dictionnaire — 38 000
// chaînes pour 16 080 × 47 cases — sans quoi le fichier dépasse les 16 Mo.
const colsPage=Object.keys(principale[0]).filter(c=>!/^—/.test(c));
const dico=[''], index=new Map([['',0]]);
const lignesPage=principale.map(o=>colsPage.map(c=>{
  const v=o[c]==null?'':String(o[c]);
  let i=index.get(v); if(i===undefined){ i=dico.length; dico.push(v); index.set(v,i); }
  return i;}));
const synthPage=(b)=>{
  const out=[]; const par=new Map();
  for(const r of [...b.rows,b.total]){
    const nom=r===b.total?'TOTAL':r.label;
    let g=par.get(nom);
    if(!g){ g={cat:nom, total:0, echu:0, nonEchu:0, crediteur:0, nb:0,
      buckets:buckets.map(()=>0)}; par.set(nom,g); out.push(g); }
    g.total+=r.total; g.echu+=r.echu; g.nonEchu+=r.nonEchu;
    g.crediteur+=(r.crediteur||0); g.nb+=r.nb;
    buckets.forEach((x,i)=>{ g.buckets[i]+=r.buckets[x.key]; });
  }
  return out.map(g=>({...g, total:ar(g.total), echu:ar(g.echu), nonEchu:ar(g.nonEchu),
    crediteur:ar(g.crediteur), buckets:g.buckets.map(ar)}));
};
fs.writeFileSync('page-donnees.json',JSON.stringify({
  genere:fr(new Date()), arrete:fr(REF),
  source:'Grand livre Clients Pennylane · 01/07/2026 → 30/06/2027',
  cols:colsPage, dico, lignes:lignesPage,
  // Les règles telles qu'elles ont servi : le dispositif, le type de client
  // auquel il appartient, les mots que le moteur y reconnaît, et le barème
  // d'échéance avec son repli. La page en fait le premier onglet du classeur —
  // une balance qu'on ne peut pas relire n'est pas auditable.
  regles:RG.filter(r=>r.key!=='INCONNU').map(r=>{ const g=r.gl||r; return {
    dispositif:r.label,
    // Le même garde-fou que sur la feuille : ses trois types de client, et
    // rien d'autre. « Alternance » tout court ne dit pas qui paie — l'OPCO,
    // l'entreprise ou l'alternant — et la table des règles ne doit pas
    // annoncer un quatrième type que la balance ne publie plus.
    type:troisTypes(r.categorie||'')||'à compléter',
    perimetre:r.perimetre||'',
    base:(BASES[g.base]||g.base||''),
    jours:(g.jours==null?'':g.jours),
    repli:(BASES[r.fallback]||r.fallback||'')+(r.fallbackJours!=null?' + '+r.fallbackJours+' j':''),
    note:r.note||'',
    mots:(r.match||[]).join(' · '),
  };}),
  // L'ordre de préférence, tel qu'elle l'a dicté le 14/10/2026. Il passe
  // avant le tableau des barèmes : une créance sous mandat ne regarde jamais
  // son dispositif. Écrit ici pour qu'on puisse relire une date sans avoir à
  // deviner laquelle des cinq règles a parlé.
  // ───────── la répartition au prorata ─────────
  // Sa règle, le 16/10/2026. Livrée avec les données pour que l'onglet
  // « Règles » et la section « Paramètres » la disent toutes les deux, sans
  // qu'aucune des deux n'ait à la réécrire.
  prorata:{
    titre:'Répartition au prorata des paiements non rattachés',
    regle:'Un règlement ou un avoir qui ne nomme aucune facture, sur un compte '
      +'client dont les factures portent PLUSIEURS types de financement, ne prend '
      +'plus le type de la première facture venue. Il est réparti au prorata.',
    etapes:[
      {rang:'1', quoi:'La clé',
       dit:'Le nombre de factures de chaque type de financement sur le compte. '
          +'Cinq factures B2B et quatre B2C-Entreprise donnent 5/9 et 4/9.'},
      {rang:'2', quoi:'La cible',
       dit:'La part de chaque type, appliquée au montant total des lignes à répartir.'},
      {rang:'3', quoi:'L’attribution',
       dit:'Les lignes sont prises de la plus grosse à la plus petite et attribuées '
          +'ENTIÈRES au type dont il manque le plus, en euros, pour atteindre sa cible. '
          +'Aucune ligne ne figure des deux côtés.'},
      {rang:'4', quoi:'Le départage',
       dit:'À égalité, le type qui porte le plus de factures, puis le plus gros encours. '
          +'Jamais l’ordre alphabétique : sur une clé 4/4 il décidait du plus gros '
          +'règlement du compte.'},
      {rang:'5', quoi:'Ce qui est écarté',
       dit:'Un compte dont les factures portent « Alternance » tout court, ou un '
          +'dispositif non qualifié, n’est pas réparti du tout : le prorata ne '
          +'choisit pas entre un type valide et un fourre-tout.'},
    ],
    limites:'Cette règle ne déplace pas le reste dû des créances d’un lot qui contient '
      +'des factures : celui-là est déjà réparti sur ces factures au prorata de leur '
      +'MONTANT, la seule répartition qui laisse chaque facture avec un reste dû '
      +'cohérent avec son débit. Elle change le type de financement affiché sur les '
      +'écritures non numérotées, et celui des créances « solde de compte », qui n’ont '
      +'aucune facture à qui se raccrocher. La colonne « Justificatif du classement » porte la '
      +'clé, la part visée et la part obtenue : les deux diffèrent dès qu’une ligne est '
      +'trop grosse pour tenir dans sa part, puisqu’elle ne se coupe pas en deux.',
  },
  ordreEcheance:[
    {rang:'1', quand:'Le client a un mandat de prélèvement GoCardless',
     alors:'fin de formation, sans délai',
     note:'Rapproché par numéro de facture, puis e-mail, puis nom et prénom. '
         +'Un client prélevé ne se voit accorder aucun délai de paiement.'},
    {rang:'2', quand:'La date de facture est postérieure à la fin de formation',
     alors:'date de facture + 30 jours',
     note:'C’est une régularisation : le délai court depuis l’émission, pas depuis '
         +'une formation déjà terminée.'},
    {rang:'3', quand:'Sinon — le barème du dispositif',
     alors:'voir le tableau ci-dessous',
     note:'Chaque dispositif a sa base et son délai. C’est le cas ordinaire.'},
    {rang:'4', quand:'Sinon — la base du barème manque',
     alors:'dernière date lue dans le libellé',
     note:'Aucune date de formation ni de facture : on prend la date que le libellé '
         +'de l’écriture porte, sans délai ajouté.'},
    {rang:'5', quand:'Sinon — aucune date dans le libellé',
     alors:'date d’enregistrement',
     note:'Le dernier recours. La ligne reste datée, et dit qu’elle l’est ainsi.'},
  ],
  tranches:buckets.map(b=>b.label),
  // L'ordre de ses trois types de client, pour que la vue « à provisionner »
  // les présente comme le tableau.
  ordreTypeClient:ORDRE,
  // Les intitulés qu'un dispositif a portés avant d'être renommé. La page en
  // a besoin : ses décisions sont enregistrées sous le nom en vigueur le jour
  // où elle les a prises, et huit d'entre elles disaient encore « B2C-Perso ».
  // Sans cette table, la balance affichait deux lignes pour un seul dispositif.
  anciensDispositifs:Object.fromEntries(ANCIENS.map(([vieux,cle])=>
    [vieux,(RG.find(r=>r&&r.key===cle)||{}).label||vieux])),
  // ───────── le barème de provision ─────────
  //
  // Son tableau « Règles de provision Groupe », reçu le 16/10/2026. Les quatre
  // fenêtres coïncident exactement avec les tranches d'ancienneté déjà en
  // place : chacune est la somme de tranches entières, rien n'est à recouper
  // ni à proratiser. En deçà de 121 jours, aucune provision.
  //
  // Le rattachement des quinze types de financement aux trois familles n'est
  // plus une supposition : ce sont ses trois types de client, qu'elle a dictés
  // le 16/10/2026. Il se modifie malgré tout dans la page, section
  // « Paramètres ».
  provision:{
    confirme:true,
    fenetres:[
      {label:'121 - 180 j', tranches:['4 à 6 mois']},
      {label:'181 - 360 j', tranches:['6 à 12 mois']},
      {label:'361 - 720 j', tranches:['12 à 18 mois','18 à 24 mois']},
      {label:'> 720 j',     tranches:['24 à 36 mois','36 à 48 mois','> 48 mois']},
    ],
    // Son tableau du groupe nomme les trois familles B2C, ETATIQUE et B2B. Ce
    // sont exactement ses trois types de client : « Financement personnel »
    // pour B2C, « Corporate » pour B2B. On les appelle donc comme elle les
    // appelle dans la balance, pour n'avoir qu'un vocabulaire.
    taux:{'Étatique':[0,0,0.50,1],'Corporate':[0.40,0.40,0.90,1],
          'Financement personnel':[0.20,0.40,0.90,1]},
    familles:{
      'Étatique':['Transition Pro','AIF','POEI','CPF','Region',
                  'OPCO - Alternance','OPCO','ETAT','Agefiph'],
      'Corporate':['B2B','B2C-Entreprise','Corporate - Alternance','Interco',
                   'Corporate — financement à préciser','Interne - DST Allemagne'],
      'Financement personnel':['Financement personnel','Perso-Alternance'],
    },
  },
  // Le type de client d'abord — c'est la lecture que vous faites —, la
  // sous-catégorie ensuite, pour le détail du dispositif.
  syntheseCat:[...catRows,balCat.total].map(r=>({
    cat:r===balCat.total?'TOTAL':r.label, total:ar(r.total), echu:ar(r.echu), nonEchu:ar(r.nonEchu),
    crediteur:ar(r.crediteur||0), nb:r.nb, buckets:buckets.map(x=>ar(r.buckets[x.key]))})),
  synthese:synthPage(bal),
  // Le trop-perçu, lu par COMPTE CLIENT et non par lettrage. Un règlement non
  // pointé qui fait face à une facture impayée du même compte n'est pas de
  // l'argent en trop : c'est un lettrage à faire. Compter les deux ensemble
  // annonçait 1 320 921 € là où le client ne doit réellement rien rendre que
  // sur 1 033 118 €. Sa règle, le 14/10/2026 : « 1 033 118 € ».
  excedent:(()=>{
    const net=new Map();
    for(const l of plat){ const c=l.compte; if(!c) continue;
      net.set(c,(net.get(c)||0)+(l.debit||0)-(l.credit||0)); }
    let montant=0, comptes=0, sansDette=0;
    for(const [,v] of net) if(v<-0.004){ montant+=v; comptes++; }
    return {montant:ar(montant), comptes};
  })(),
}));
console.log('page-donnees.json : '+lignesPage.length+' lignes × '+colsPage.length
  +' colonnes · dictionnaire de '+dico.length+' chaînes');

// Les pages se refont dans le même souffle. Les reconstruire séparément a
// laissé, trente minutes durant, un classeur à 53 colonnes et des pages à 51 :
// la péremption était purement additive, donc invisible à toute comparaison de
// valeurs. Un seul geste, ou rien.
require('./gabarit.js');
