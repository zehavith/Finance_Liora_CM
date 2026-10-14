const DEPOT=require('path').resolve(__dirname,'..');
// Socle commun : charger l'appli, lire les deux classeurs, apprendre.
const fs=require('fs'),vm=require('vm');
const R0=DEPOT+'/recouvrement';
const ctx={self:{},window:{},console,Buffer,process,TextDecoder,TextEncoder,Date,Math,JSON,setTimeout,clearTimeout};
ctx.self=ctx;ctx.window=ctx;ctx.globalThis=ctx;ctx.global=ctx;vm.createContext(ctx);
for(const f of [DEPOT+'/vendor/papaparse.min.js',DEPOT+'/vendor/xlsx.full.min.js',
  R0+'/js/rules.js',R0+'/js/ingest.js',R0+'/js/zoho.js',R0+'/js/sellsy.js',R0+'/js/grandlivre.js'])
  vm.runInContext(fs.readFileSync(f,'utf8'),ctx);
const X=ctx.XLSX;
const ANC='depot-ancienne/balance-ancienne.xlsx', NOUV='depot-nouvelle/balance-nouvelle.xlsx';

// L'export Sellsy de son classeur a été lu en latin-1 : « NumÃ©ro » pour
// « Numéro ». Sans réparation, aucun en-tête ne se reconnaît.
const reparer = s => {
  if (typeof s !== 'string' || !/[ÃÂâ€]/.test(s)) return s;
  try { return Buffer.from(s, 'latin1').toString('utf8'); } catch { return s; }
};
// Huit caractères de son export Pennylane sont arrivés abîmés, et le U+0013 y
// remplace le tiret partout. Chaque remplacement se lit dans SES propres
// fichiers : « Écart de lettrage » et « Romain Fillâtre » y figurent corrects
// dans la base Sellsy, et le signe € derrière un montant ne fait pas de doute.
// Le seul cas vraiment ambigu est le séparateur de « Data Analyst_Apprenant » :
// ailleurs dans le même fichier elle écrit « Data Analyst Apprenant », donc une
// espace — rien n'est ajouté que ce que le fichier dit déjà.
const reparerTexte = s => {
  if (typeof s !== 'string' || !/[\u0013\uFFFD]/.test(s)) return s;
  return s.replace(/\u0013/g, '–')
    .replace(/\uFFFDcart/g, 'Écart')
    .replace(/Fill\uFFFDtre/g, 'Fillâtre')
    .replace(/(\d)\s*\uFFFD/g, '$1 €')
    .replace(/ \uFFFD /g, ' à ')
    .replace(/\uFFFD/g, ' ')
    .replace(/ {2,}/g, ' ');
};
function feuille(fichier, nom, ligneEntetes){
  const wb=X.read(new Uint8Array(fs.readFileSync(fichier)),
    {type:'array',raw:true,cellDates:false,cellStyles:false,cellFormula:false,sheets:[nom]});
  const m=X.utils.sheet_to_json(wb.Sheets[nom],{header:1,defval:'',raw:true,blankrows:false});
  const ent=(m[ligneEntetes]||[]).map(x=>reparer(String(x==null?'':x)).replace(/[\r\n]+/g,' ').trim());
  const rows=[];
  for(let i=ligneEntetes+1;i<m.length;i++){
    const x=m[i]; if(!x || x.every(v=>String(v).trim()==='')) continue;
    const o={}; ent.forEach((h,k)=>{ if(h) o[h]=reparerTexte(reparer(x[k])); });
    rows.push(o);
  }
  return {entetes:ent, rows};
}
// Une date Excel, sous l'une ou l'autre de ses deux formes.
//
// Un même export peut livrer ses dates en nombre de série (45705) ou en texte
// (« 10/09/2027 ») selon qu'il sort du tableur ou de l'outil métier. Ne lire
// que le nombre revenait à jeter en silence les 4 662 dates de l'export du
// financeur, et à dégrader la balance en croyant l'enrichir.
const dser=v=>{
  const n=Number(v);
  if (isFinite(n) && n>1000) return new Date(Date.UTC(1899,11,30+Math.floor(n)));
  return ctx.LioraRules ? ctx.LioraRules.parseDate(v) : null;
};
module.exports={ctx,X,ANC,NOUV,feuille,dser,reparer,reparerTexte};
