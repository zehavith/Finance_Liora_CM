const fs=require('fs');
const d=JSON.parse(fs.readFileSync('/home/user/Finance_Liora_CM/balance-agee/art/balance.json','utf8'));
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
const ASS=new Map();
for(const [,g] of lots){
  let credit=-g.filter(c=>c.rd<0).reduce((s,c)=>s+c.rd,0);
  for(const c of g.filter(c=>c.rd>0).sort((a,b)=>b.j-a.j||(a.k<b.k?-1:a.k>b.k?1:0))){
    const pris=Math.min(credit,c.rd); credit-=pris; ASS.set(c.k,c.rd-pris);
  }
}
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
