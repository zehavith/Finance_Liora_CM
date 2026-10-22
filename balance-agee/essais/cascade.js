const {charger}=require('./charger');
const ctx=charger();const R=ctx.LioraRules;
const D=(s)=>s?new Date(s+'T00:00:00'):null;
const FIN=D('2026-06-30'),DEB=D('2026-01-15'),FAC=D('2026-02-10'),
      FFAV=D('2026-03-01'),FFAP=D('2026-08-15'),ECH=D('2026-09-30'),PAI=D('2026-01-05');
const keys=R.DEFAULT_ECHEANCE_RULES.map(r=>r.key).concat([null]);
const rows=[];
for(const fin of keys)
 for(const mandat of [false,true])
  for(const dFin of [null,FIN])
   for(const dDeb of [null,DEB])
    for(const dFac of [null,FAC])
     for(const dFF of [null,FFAV,FFAP])
      for(const dEch of [null,ECH])
       for(const dPai of [null,PAI]){
        const inv={financement:fin,mandatGocardless:mandat,dateFinFormation:dFin,
          dateDebutFormation:dDeb,dateFacture:dFac,dateFactureFacturation:dFF,
          dateEcheanceComptable:dEch,datePaiementEffective:dPai};
        const r=R.computeEcheance(inv,{grandLivre:true});
        const src=r.baseUtilisee?inv[r.baseUtilisee]:null;
        const delai=(r.date&&src)?R.diffDays(r.date,src):null;
        rows.push({fin,mandat,inv,origine:r.origine,base:r.baseUtilisee,
          motif:r.motif||null,date:r.date,delai,regleKey:r.regle.key});
       }
console.log('cas énumérés :',rows.length);
// 1) branches atteintes
const br=new Map();
for(const x of rows){const k=[x.origine,x.base,x.motif,x.delai].join(' ¦ ');
  br.set(k,(br.get(k)||0)+1);}
console.log('\n=== BRANCHES ATTEINTES (origine ¦ base ¦ motif ¦ délai) ===');
[...br.entries()].sort((a,b)=>b[1]-a[1]).forEach(([k,n])=>console.log(String(n).padStart(5),k));
// 2) ambiguïté du délai à partir des champs SURVIVANTS
const amb=new Map();
for(const x of rows){
  if(!x.date) continue;
  const k=[x.fin||'(à classer)',x.base,x.origine,x.motif].join(' ¦ ');
  if(!amb.has(k)) amb.set(k,new Set());
  amb.get(k).add(x.delai);
}
console.log('\n=== CLES (financement ¦ base ¦ origine ¦ motif) AVEC PLUSIEURS DELAIS ===');
let nAmb=0,nTot=0;
for(const [k,s] of amb){nTot++;if(s.size>1){nAmb++;console.log(k,'→ délais',[...s].sort((a,b)=>a-b).join(' / '));}}
console.log(`\n${nAmb} clés ambiguës sur ${nTot}`);
