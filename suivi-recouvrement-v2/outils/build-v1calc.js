const fs=require('fs'),path=require('path');
const V1=process.argv[2],OUT=process.argv[3];
global.window=global;global.location={protocol:'https:'};global.Papa=require(path.join(V1,'vendor/papaparse.min.js'));
const M=path.join(OUT,'moteur-v1');
for(const f of ['rules.js','zoho.js','monday.js','ingest.js']) eval(fs.readFileSync(path.join(M,f),'utf8'));
eval(fs.readFileSync(path.join(OUT,'engine.js'),'utf8'));
const R=global.LioraRules,I=global.LioraIngest;
const man=JSON.parse(fs.readFileSync(path.join(V1,'donnees/du-jour.json'),'utf8'));
let all=[];
for(const nomF of man.fichiers){
  const m=Papa.parse(fs.readFileSync(path.join(V1,'donnees',nomF),'utf8'),{header:false,skipEmptyLines:true,delimiter:''}).data;
  const g=I.aplatirExportMonday(m),nom=g.tableau,d=R.detectBoardRole(nom);
  const cfg={role:d.role==='ignore'?'adv':d.role,perimetre:d.perimetre==='Inconnu'?'Corporate':d.perimetre,source:d.source||'adv',financementDefaut:d.financementDefaut,mapping:null};
  all.push(...I.facturesFromRows(g.lignes,cfg,nom).factures);
}
const gl=JSON.parse(fs.readFileSync(path.join(OUT,'data/gl.json'),'utf8')).m;
const res=global.LioraEngine.compute(all,new Date(2026,10,9),gl);
fs.writeFileSync(path.join(OUT,'data/v1calc.json'),JSON.stringify(res));
const v=Object.values(res),op=v.filter(x=>x.op),ouv=op.filter(x=>!x.paid&&x.src!=='avoir');
const s=a=>Math.round(a.reduce((t,x)=>t+(x.mt||0),0));const ref='2026-11-09';
console.log('factures',v.length,'src',v.reduce((c,x)=>(c[x.src||'ouverte']=(c[x.src||'ouverte']||0)+1,c),{}));
console.log('reste à encaisser',ouv.length,s(ouv),'| échu',ouv.filter(x=>x.de&&x.de<ref).length,s(ouv.filter(x=>x.de&&x.de<ref)),'| sans échéance',ouv.filter(x=>!x.de).length);
