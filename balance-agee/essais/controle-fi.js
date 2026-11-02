const fs=require('fs');
// LA BALANCE À VÉRIFIER EST CELLE DU DOSSIER DE TRAVAIL.
//
// Ce chemin était écrit en dur. Le contrôle ne pouvait donc vérifier qu'une
// seule balance — celle du dépôt — et rendait ses chiffres quelle que soit
// celle qu'on venait de construire. Une balance à date, bâtie à côté,
// repartait avec un satisfecit qui ne la concernait pas.
//
// Le défaut est le même partout : le code se résout depuis son propre
// dossier, les données depuis le répertoire de travail.
const path=require('path');
const CIBLE=process.argv[2] || path.resolve(process.cwd(),'art','balance.json');
if(!fs.existsSync(CIBLE)){
  console.error('balance introuvable : '+CIBLE);
  console.error('lancez le contrôle depuis le dossier qui porte art/balance.json,');
  console.error('ou donnez-lui le fichier en argument.');
  process.exit(2);
}
console.log('balance vérifiée : '+CIBLE);
const d=JSON.parse(fs.readFileSync(CIBLE,'utf8'));
const C=d.cols, dico=d.dico, L=d.lignes;
const ix=new Map(C.map((c,i)=>[c,i]));
const V=(r,n)=>{const j=ix.get(n); if(j===undefined) return ''; const v=r[j];
  return typeof v==='number'?(dico[v]!==undefined?dico[v]:v):(v===null?'':v);};
const N=(r,n)=>{const v=V(r,n); if(v==='') return 0; const x=Number(String(v).replace(/\s|€/g,'').replace(',','.')); return isFinite(x)?x:0;};
const cts=n=>Math.round(n*100);
const eur=c=>(c/100).toLocaleString('fr-FR',{minimumFractionDigits:2,maximumFractionDigits:2})+' €';

// ── F. le total : débit − crédit, en centimes entiers ──
let deb=0, cre=0;
for(const r of L){ deb+=cts(N(r,'Débit')); cre+=cts(N(r,'Crédit')); }
console.log('F · le total');
console.log('    débit '+eur(deb)+' − crédit '+eur(cre)+' = '+eur(deb-cre));

// ── G. une créance = une clé, un reste dû, un dispositif, une tranche ──
// UNE LIGNE SANS CLÉ SORTAIT DU CONTRÔLE SANS UN MOT.
// C'était le trou par lequel une créance orpheline passait : le 21/10/2026,
// 13 011,34 € de reliquats d'imputation que plus aucune ligne ne portait ne
// produisaient ni compteur ni message — seul l'écart final les trahissait, et
// encore fallait-il le lire. On les compte, et on dit ce qu'elles pèsent.
const cr=new Map(); let incoh=0, sansCle=0, mtSansCle=0;
for(const r of L){
  const k=V(r,'Clé de la créance');
  if(!k){ sansCle++; mtSansCle+=cts(N(r,'Débit'))-cts(N(r,'Crédit')); continue; }
  const o={rd:cts(N(r,'Reste dû de la créance')), sc:V(r,'Type de financement de la créance'),
           tc:V(r,'Type de client de la créance'), tr:V(r,'Tranche de la créance')};
  const v=cr.get(k);
  if(!v) cr.set(k,o);
  else if(v.rd!==o.rd||v.sc!==o.sc||v.tr!==o.tr) incoh++;
}
console.log('\nG · une clé de créance = un seul reste dû, un seul dispositif, une seule tranche');
console.log('    créances distinctes : '+cr.size+'  ·  lignes en contradiction avec leur créance : '+incoh);
let som=0, pos=0, neg=0, nul=0;
for(const [,v] of cr){ som+=v.rd; if(v.rd>0) pos++; else if(v.rd<0) neg++; else nul++; }
console.log('    Σ des restes dus : '+eur(som)+'  ·  écart au total : '+eur(som-(deb-cre)));
console.log('    au débit '+pos+' · au crédit '+neg+' · soldées '+nul+'  ·  ouvertes '+(pos+neg));
console.log('    lignes sans clé de créance : '+sansCle+' ('+eur(mtSansCle)+')'
  +(Math.abs(mtSansCle)>0.005?'  ⚠ elles pèsent, et aucune créance ne les porte':''));

// ── H. la provision : assiette × taux, refaite à la main ──
const P=d.provision, FAM=P.familles, TAUX=P.taux, FEN=P.fenetres;
const familleDe=sc=>{ for(const [f,l] of Object.entries(FAM)) if(l.indexOf(sc)>=0) return f; return null; };
// l'assiette : les crédits d'un lot s'imputent sur ses dettes, de la plus ancienne à la plus récente
const lots=new Map(); const vus=new Set();
for(const r of L){
  const k=V(r,'Clé de la créance'); if(!k||vus.has(k)) continue; vus.add(k);
  const lot=V(r,'N° de compte');   // imputation par compte client, sa décision du 20/10
  const jc=V(r,'Jours de retard de la créance');
  const jr=jc!==''?jc:V(r,'Jours de retard');
  if(!lots.has(lot)) lots.set(lot,[]);
  lots.get(lot).push({k, rd:cts(N(r,'Reste dû de la créance')), j:jr===''?-1:Number(jr),
    sc:V(r,'Type de financement de la créance'), tr:V(r,'Tranche de la créance')});
}
// L'imputation pour provision se fait en DEUX TEMPS depuis sa décision du
// 02/11/2026. Premier temps : par compte client. Second temps : le crédit
// qu'aucune créance du compte n'a absorbé compense les créances du même type
// de financement et de la même tranche d'ancienneté, sur l'ASSIETTE et non sur
// la provision. Refait ici à la main, sans rien emprunter à la page.
const ancien=(a,b)=>b.j-a.j||(a.k<b.k?-1:a.k>b.k?1:0);
const ASS=new Map();
const reliquat=[];
for(const [,g] of lots){
  const dettes=g.filter(c=>c.rd>0).sort(ancien);
  for(const dt of dettes) ASS.set(dt.k, dt.rd);
  for(const cr of g.filter(c=>c.rd<0).sort(ancien)){
    let reste=-cr.rd;
    for(const dt of dettes){
      if(reste<=0) break;
      const a=ASS.get(dt.k); if(!(a>0)) continue;
      const pris=Math.min(reste,a); ASS.set(dt.k, a-pris); reste-=pris;
    }
    if(reste>0) reliquat.push({sc:cr.sc, tr:cr.tr, reste});
  }
}
// Temps 3, 4 et 5 : la tranche propre, puis la cascade vers le plus ancien,
// puis la redescente vers le plus jeune — toujours dans le même type de
// financement. Chaque temps est purgé pour TOUS les crédits avant le suivant.
const cleCT=(sc,tr)=>(sc||'')+'\u0001'+(tr||'');
const parCT=new Map();
for(const [,g] of lots) for(const c of g){
  if(!(c.rd>0)) continue;
  const u=cleCT(c.sc,c.tr);
  if(!parCT.has(u)) parCT.set(u,[]);
  parCT.get(u).push(c);
}
for(const [,v] of parCT) v.sort(ancien);
const viderCT=(r,tr)=>{
  for(const c of (parCT.get(cleCT(r.sc,tr))||[])){
    if(r.reste<=0) return;
    const a=ASS.get(c.k); if(!(a>0)) continue;
    const pris=Math.min(r.reste,a); ASS.set(c.k, a-pris); r.reste-=pris;
  }
};
const ECH=(d.tranches||[]).slice();
const inconnuesCT=new Set();
for(const [,g] of lots) for(const c of g)
  if(c.tr && ECH.indexOf(c.tr)<0) inconnuesCT.add(c.tr);
for(const t of [...inconnuesCT].sort().reverse()) ECH.unshift(t);
const credit0=reliquat.reduce((s,r)=>s+r.reste,0);
for(const r of reliquat) viderCT(r, r.tr);
const apres3=reliquat.reduce((s,r)=>s+r.reste,0);
for(const r of reliquat){ if(r.reste<=0) continue;
  const dep=ECH.indexOf(r.tr); if(dep<0) continue;
  for(let i=dep+1;i<ECH.length && r.reste>0;i++) viderCT(r, ECH[i]); }
const apres4=reliquat.reduce((s,r)=>s+r.reste,0);
for(const r of reliquat){ if(r.reste<=0) continue;
  const dep=ECH.indexOf(r.tr); if(dep<0) continue;
  for(let i=dep-1;i>=0 && r.reste>0;i--) viderCT(r, ECH[i]); }
const sansEmploi=reliquat.reduce((s,r)=>s+(r.reste>0?r.reste:0),0);
const employe=credit0-sansEmploi;
let prov=0, parFam=new Map(), sansFamille=new Map(), horsFenetre=0;
for(const [,g] of lots) for(const c of g){
  if(c.rd<=0) continue;
  const base=ASS.has(c.k)?ASS.get(c.k):c.rd; if(base<=0) continue;
  const j=FEN.findIndex(f=>f.tranches.indexOf(c.tr)>=0);
  if(j<0){ horsFenetre+=base; continue; }
  const fam=familleDe(c.sc);
  if(!fam){ sansFamille.set(c.sc,(sansFamille.get(c.sc)||0)+base); continue; }
  const t=(TAUX[fam]||[])[j]||0;
  const p=base*t; prov+=p; parFam.set(fam,(parFam.get(fam)||0)+p);
}
console.log('\nH · provision = assiette × taux de la famille dans sa fenêtre (refait à la main)');
for(const [f,v] of [...parFam].sort()) console.log('    '+f.padEnd(24)+eur(v).padStart(16));
console.log('    '+'TOTAL'.padEnd(24)+eur(prov).padStart(16));
console.log('    reste dû hors des quatre fenêtres (moins de 121 j, non échu) : '+eur(horsFenetre));
console.log('    compensation dans le financement : '+eur(credit0)+' à employer → '
  +eur(credit0-apres3)+' par sa tranche, '+eur(apres3-apres4)+' vers le plus ancien, '
  +eur(apres4-sansEmploi)+' vers le plus jeune');
console.log('    crédit resté SANS EMPLOI : '+eur(sansEmploi)
  +' — financement sans aucune dette ouverte');
console.log('    dispositif sans famille de provision : '+(sansFamille.size?[...sansFamille].map(([k,v])=>k+' '+eur(v)).join(' · '):'aucun'));

// ── I. échu + non échu = total, et les 9 tranches font l'échu ──
let echu=0, nonEchu=0, parTr=new Map();
for(const [,g] of lots) for(const c of g){
  if(c.tr==='Non échu'||c.tr===''){ nonEchu+=c.rd; } else { echu+=c.rd; parTr.set(c.tr,(parTr.get(c.tr)||0)+c.rd); }
}
console.log('\nI · échu + non échu');
console.log('    échu '+eur(echu)+' + non échu '+eur(nonEchu)+' = '+eur(echu+nonEchu));
let s9=0; for(const [,v] of parTr) s9+=v;
console.log('    Σ des 9 tranches échues = '+eur(s9)+'  ·  écart à l’échu : '+eur(s9-echu));
// ET LA COMPARAISON QUI MANQUAIT. « échu + non échu » était imprimé en face du
// total de F sans jamais lui être comparé : le 21/10/2026 les deux lignes ont
// affiché 14 648 134,36 € et 14 635 123,02 € l'une sous l'autre, 13 011,34 €
// d'écart sous les yeux, et aucune des deux ne l'a relevé.
// Le seuil d'alarme est à l'euro : 0,08 € de résidu d'arrondi traînent depuis
// toujours — `ar()` arrondit chaque reste dû publié à deux décimales sur 16 082
// lignes — et sonner l'alarme dessus la rendrait muette. Une vraie rupture se
// compte en milliers. (Tout se compte ici en CENTIMES : le seuil est 100.)
const ecartI=(echu+nonEchu)-(deb-cre);
console.log('    écart au total du grand livre : '+eur(ecartI)
  +(Math.abs(ecartI)>100?'  ⚠ LA BALANCE NE BOUCLE PLUS':'  (résidu d’arrondi)'));
