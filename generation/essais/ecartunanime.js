// Compare deux balance.json : ce que la règle d'unanimité a changé.
// usage : node ecartunanime.js avant.json apres.json
const fs=require('fs');
const lire=f=>{const d=JSON.parse(fs.readFileSync(f,'utf8'));
  const V=(l,n)=>{const i=d.cols.indexOf(n); const v=i<0?'':l[i];
    return typeof v==='number'?d.dico[v]:(v==null?'':String(v));};
  return {d,V};};
const A=lire(process.argv[2]), B=lire(process.argv[3]);
const CLE='Clé de la créance', CAT='Type de client',
      SOUS='Sous-catégorie de la créance', PAR='Classé par', TOT='Reste dû de la créance';
const num=v=>{const n=Number(String(v).replace(/\s| |€/g,'').replace(',','.'));return isFinite(n)?n:0;};
const carte=({d,V})=>{const m=new Map();
  for(const l of d.lignes){const k=V(l,CLE); if(!k||m.has(k)) continue;
    m.set(k,{cat:V(l,CAT),sous:V(l,SOUS),par:V(l,PAR),
      cpt:V(l,'N° de compte')+' - '+(V(l,'Libellé de compte')||V(l,'Tiers')),
      fac:V(l,'N° de facture'),mt:num(V(l,TOT))});}
  return m;};
const a=carte(A), b=carte(B);
const e=n=>(n<0?'−':'')+Math.round(Math.abs(n)).toLocaleString('fr-FR')+' €';
let nb=0, mt=0; const vers=new Map(), lignes=[];
for(const [k,x] of a){const y=b.get(k); if(!y) continue;
  if(x.cat===y.cat && x.sous===y.sous) continue;
  nb++; mt+=y.mt;
  const t=(x.sous||x.cat||'—')+'  →  '+(y.sous||y.cat||'—');
  const g=vers.get(t)||{nb:0,mt:0}; g.nb++; g.mt+=y.mt; vers.set(t,g);
  lignes.push({k,t,...y,avantPar:x.par});}
console.log('créances reclassées : '+nb+'  ·  '+e(mt));
for(const [t,g] of [...vers].sort((p,q)=>q.g-p.g||q[1].nb-p[1].nb))
  console.log('  '+String(g.nb).padStart(4)+'  '+e(g.mt).padStart(12)+'   '+t);
console.log('\nles 25 plus gros montants :');
for(const l of lignes.sort((p,q)=>q.mt-p.mt).slice(0,25))
  console.log('  '+e(l.mt).padStart(11)+'  '+l.cpt.slice(0,46).padEnd(46)+'  '+(l.fac||'—').padEnd(18)+'  '+l.t);
// ce que la balance agée dit avant / après
const bal=({d,V})=>{const m=new Map();
  for(const l of d.lignes){const k=V(l,CLE); if(!k) continue;
    const c=V(l,SOUS)||V(l,CAT)||'—'; if(!m.has(k+'|'+c)) m.set(k+'|'+c,[c,num(V(l,TOT))]);}
  const s=new Map();
  for(const [,[c,v]] of m){const g=s.get(c)||{nb:0,mt:0}; g.nb++; g.mt+=v; s.set(c,g);}
  return s;};
const sa=bal(A), sb=bal(B);
console.log('\nligne de balance'.padEnd(34)+'avant'.padStart(14)+'       '+'après'.padStart(14)+'        écart');
for(const c of new Set([...sa.keys(),...sb.keys()])){
  const x=sa.get(c)||{nb:0,mt:0}, y=sb.get(c)||{nb:0,mt:0};
  if(Math.round(x.mt)===Math.round(y.mt) && x.nb===y.nb) continue;
  console.log('  '+c.slice(0,30).padEnd(30)+e(x.mt).padStart(13)+String(x.nb).padStart(6)
    +e(y.mt).padStart(14)+String(y.nb).padStart(6)+e(y.mt-x.mt).padStart(13));}
