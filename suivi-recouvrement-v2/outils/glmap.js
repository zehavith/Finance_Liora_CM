// Carte grand livre par facture : r = soldée par règlement, a = soldée par avoir,
// v = virement reçu non lettré couvrant le reste dû, o = ouverte.
const {lu,rows}=require('./gl.js');
const I=global.LioraIngest;
const iso=d=>d?new Date(d.getTime()-d.getTimezoneOffset()*6e4).toISOString().slice(0,10):undefined;
const map={};
lu.lignes.forEach(l=>{const k=l.cle||I.factureKey(l.numero);if(!k)return;
  const s=l.soldee?(l.parAvoir?'a':'r'):'o';
  const prev=map[k]; if(prev&&prev.s!=='o')return;
  map[k]={s, dp:iso(l.parAvoir?l.dateAvoir:l.datePaiement)};});
const num=s=>parseFloat(String(s).replace(/[\s  ]/g,'').replace('€','').replace(',','.'))||0;
const vir={};
rows.forEach(r=>{
  if(r['Nature de l’écriture']!=='reglement')return;
  const let_=r['Let.'];if(let_&&let_!=='(non lettré)')return;
  const f=r['Fiabilité du rapprochement'];if(f!=='forte'&&f!=='certaine')return;
  const m=/^((?:FACT|FCT|FA|AVR)[\w-]+)\s*·\s*reste dû\s*([\d\s ,.]+)€/.exec(r['Proposition de rapprochement']||'');if(!m)return;
  const k=I.factureKey(m[1]);const v=vir[k]||(vir[k]={c:0,reste:num(m[2]),d:''});v.c+=num(r['Crédit']);
  const dd=r['Date'].split('/').reverse().join('-');if(dd>v.d)v.d=dd;});
let nv=0;for(const k in vir){const v=vir[k];if(v.c>=v.reste-0.01&&(!map[k]||map[k].s==='o')){map[k]={s:'v',dp:v.d};nv++;}}
const cnt={};for(const k in map)cnt[map[k].s]=(cnt[map[k].s]||0)+1;
console.error('glmap',cnt,'virements couvrants',nv,'factures citées',Object.keys(vir).length);
module.exports={map,arrete:'2026-11-08'};
if(require.main===module){require('fs').writeFileSync(process.argv[4],JSON.stringify({arrete:'2026-11-08',source:'Grand livre Pennylane (balance âgée Liora, arrêté au 08/11/2026)',m:map}));}
