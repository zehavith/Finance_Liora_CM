// Ce qu'un changement de règle d'échéance déplace : la date, la tranche,
// et le montant qui passe d'un seau à l'autre.
const fs=require('fs');
const lire=f=>{const d=JSON.parse(fs.readFileSync(f,'utf8'));
  const V=(l,n)=>{const i=d.cols.indexOf(n);const v=i<0?'':l[i];
    return typeof v==='number'?d.dico[v]:(v==null?'':String(v));};
  return {d,V};};
const num=v=>{const n=Number(String(v).replace(/\s| |€/g,'').replace(',','.'));return isFinite(n)?n:0;};
const carte=({d,V})=>{const m=new Map();
  for(const l of d.lignes){const k=V(l,'Clé de la créance'); if(!k||m.has(k))continue;
    const rd=num(V(l,'Reste dû de la créance')); if(Math.abs(rd)<0.005) continue;
    m.set(k,{rd, tr:V(l,'Tranche de la créance')||V(l,'Tranche d’ancienneté'),
      ech:V(l,"Date d'échéance recalculée"), base:V(l,'Base retenue'),
      j:V(l,'Délai appliqué (jours)'), motif:V(l,'Motif particulier'),
      sous:V(l,'Sous-catégorie de la créance'),
      cpt:V(l,'N° de compte')+' - '+(V(l,'Libellé de compte')||V(l,'Tiers')),
      fac:V(l,'N° de facture')||'—'});}
  return m;};
const A=carte(lire(process.argv[2])), B=carte(lire(process.argv[3]));
const e=n=>(n<0?'−':'')+Math.round(Math.abs(n)).toLocaleString('fr-FR')+' €';
const T=['Non échu','0 à 3 mois','3 à 4 mois','4 à 6 mois','6 à 12 mois','12 à 18 mois',
  '18 à 24 mois','24 à 36 mois','36 à 48 mois','> 48 mois'];
const sa=new Map(), sb=new Map(); let nbD=0,mtD=0, nbT=0,mtT=0; const ex=[];
for(const [k,x] of A){ const y=B.get(k); if(!y) continue;
  sa.set(x.tr,(sa.get(x.tr)||0)+x.rd); sb.set(y.tr,(sb.get(y.tr)||0)+y.rd);
  if(x.ech!==y.ech){ nbD++; mtD+=y.rd;
    if(x.tr!==y.tr){ nbT++; mtT+=y.rd;
      ex.push({...y, avant:x.ech, avantTr:x.tr, avantBase:x.base+' + '+x.j+' j'}); } } }
console.log('créances dont l’ÉCHÉANCE change : '+nbD+'  ·  '+e(mtD));
console.log('créances qui changent de TRANCHE : '+nbT+'  ·  '+e(mtT));
console.log('\n=== la balance âgée, tranche par tranche ===');
console.log('  '+'tranche'.padEnd(14)+'avant'.padStart(14)+'après'.padStart(15)+'écart'.padStart(14));
for(const t of T){const x=sa.get(t)||0,y=sb.get(t)||0;
  console.log('  '+t.padEnd(14)+e(x).padStart(14)+e(y).padStart(15)+e(y-x).padStart(14)+(Math.abs(y-x)>0.5?'':'   ='));}
const par=new Map();
for(const l of ex){const g=par.get(l.sous)||{nb:0,mt:0}; g.nb++; g.mt+=l.rd; par.set(l.sous,g);}
console.log('\n=== qui change de tranche, par dispositif ===');
for(const [k,v] of [...par].sort((a,b)=>Math.abs(b[1].mt)-Math.abs(a[1].mt)))
  console.log('  '+String(v.nb).padStart(5)+'  '+e(v.mt).padStart(13)+'   '+k);
console.log('\n=== les 20 plus gros déplacements ===');
for(const l of ex.sort((a,b)=>Math.abs(b.rd)-Math.abs(a.rd)).slice(0,20))
  console.log('  '+e(l.rd).padStart(11)+'  '+l.cpt.slice(0,34).padEnd(34)+' '+l.fac.padEnd(17)
    +' '+l.sous.slice(0,16).padEnd(16)+' '+l.avant+' → '+l.ech+'   '+l.avantTr+' → '+l.tr);
