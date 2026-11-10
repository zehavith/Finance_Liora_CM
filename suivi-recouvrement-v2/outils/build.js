const fs=require('fs'),path=require('path');
const Papa=require('/home/user/Finance_Liora_CM/vendor/papaparse.min.js');
require('/home/user/Finance_Liora_CM/suivi-recouvrement-v2/normalize.js');
const N=globalThis.LioraNorm;
const src=process.argv[2], out=process.argv[3];
const files={payees:'0.1. ALL - Factures payees.csv',tampon:'1.0. Entreprise - Tampon.csv',adv:'1.1. Entreprise - ADV.csv',recouv:'1.2. Entreprise - Recouvrement.csv',opco:'1.3. Entreprise - OPCO.csv',perso:'2.1. Financement Personnel.csv',cpf:'2.2. Financement CPF.csv',ft:'2.3. Financement pole emploi AIF POEI.csv',region:'2.4. Financement complexe REGION TRANSITION AGEFIPH.csv'};
const open=[],paid=[],groups={};
for(const b of N.BOARDS){
  const txt=fs.readFileSync(path.join(src,files[b.key]),'utf8').replace(/^﻿/,'');
  const rows=Papa.parse(txt,{skipEmptyLines:false}).data;
  let g=null,hdr=null;
  for(let i=1;i<rows.length;i++){const r=rows[i];
    const nonEmpty=r.filter(x=>String(x).trim()!=='');
    if(nonEmpty.length===0){continue}
    if(nonEmpty.length===1&&String(r[0]).trim()&&r.slice(1).every(x=>!String(x).trim())&&/^\d+(\.\d+)+/.test(r[0].trim())){g=r[0].trim();continue}
    if(r[0]==='Name'){hdr=r.map(N.norm);continue}
    if(!hdr||!g)continue;
    const map={};hdr.forEach((h,j)=>{if(map[h]==null||map[h]==='')map[h]=r[j]});
    const rec=N.record(b,g,r[0],map,null);
    groups[b.key+'|'+g]=(groups[b.key+'|'+g]||0)+1;
    if(!rec)continue; (b.paid?paid:open).push(rec);
  }
}
const strip=o=>{for(const k in o) if(o[k]===''||o[k]==null) delete o[k]; return o};
fs.writeFileSync(path.join(out,'monday.json'),JSON.stringify({at:'2026-11-09T14:47:00',source:'Instantané repris de Suivi recouvrement v1',open:open.map(strip),paid:paid.map(strip)}));
const p=JSON.parse(fs.readFileSync(path.join(src,'pilotage.json'),'utf8'));
delete p.mouvements; delete p.ages;
fs.writeFileSync(path.join(out,'pilotage.json'),JSON.stringify(p));
console.log('open',open.length,'paid',paid.length);
const byF={};open.forEach(o=>{byF[o.f]=(byF[o.f]||0)+1});console.log(byF);
console.log('noDue',open.filter(o=>!o.de).length,'noAmt',open.filter(o=>o.mt==null).length,'owner',open.filter(o=>o.ow).length,'paidNoDp',paid.filter(o=>!o.dp).length);
console.log(open.slice(0,2),paid.slice(0,2));
