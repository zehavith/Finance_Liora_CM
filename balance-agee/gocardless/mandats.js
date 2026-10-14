// L'export GoCardless → la liste de mandats que le moteur attend.
// Un client = un e-mail (à défaut son nom). On retient ses mandats, ses
// numéros de facture, et ce qui a réellement été prélevé.
const fs=require('fs');
const d=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
const num=v=>{const n=Number(String(v).replace(/[^0-9.,-]/g,'').replace(',','.'));return isFinite(n)?n:0;};
const RE=/\b((?:FA|FACT|AVR|DV|CN|INV)[-_. ]?[0-9][0-9A-Z-]*)/ig;
// « 09/02/2022 17:04mbodouliwa@gmail.com » : la date de création du client et
// son e-mail sont collés dans la même cellule. On coupe après l'heure.
const mailDe=v=>{const s=String(v||'').replace(/^\s*\d{2}\/\d{2}\/\d{4}\s*\d{2}:\d{2}/,'');
  const m=s.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/); return m?m[0].toLowerCase():'';};
const par=new Map();
for(const r of d){
  const mail=mailDe(r.clientcree);
  const nom=((r.prenom||'')+' '+(r.nom||'')).trim();
  const cle=mail||nom.toLowerCase(); if(!cle) continue;
  let g=par.get(cle);
  if(!g){ g={email:mail, client:nom, mandats:new Set(), factures:new Set(),
            preleve:0, nb:0, ok:0, ko:0}; par.set(cle,g); }
  if(!g.client&&nom) g.client=nom;
  if(/^MD/.test(r.mandat||'')) g.mandats.add(r.mandat);
  for(const src of [r.facture, r.reference, r.libelle]){
    let m; RE.lastIndex=0;
    while((m=RE.exec(String(src||'')))) g.factures.add(m[1].toUpperCase());
  }
  g.nb++;
  if(r.statut==='paid_out'||r.statut==='confirmed'){ g.ok++; g.preleve+=num(r.montant); }
  else if(r.statut==='failed'||r.statut==='charged_back') g.ko++;
}
const out=[...par.values()].filter(g=>g.mandats.size).map(g=>({
  email:g.email, client:g.client,
  etatMandat:(g.ok?'actif':'sans prélèvement abouti')+' — '+g.mandats.size
    +(g.mandats.size>1?' mandats':' mandat')+', '+g.nb+' prélèvement'+(g.nb>1?'s':'')
    +(g.ko?' dont '+g.ko+' en échec':''),
  montantPreleve:Math.round(g.preleve*100)/100, nbPrelevements:g.nb,
  factures:[...g.factures]}));
fs.writeFileSync(process.argv[3], JSON.stringify(out));
const fact=new Set(out.flatMap(o=>o.factures));
console.log('clients avec mandat : '+out.length
  +'  ·  avec e-mail : '+out.filter(o=>o.email).length
  +'  ·  avec nom : '+out.filter(o=>o.client).length
  +'  ·  numéros de facture : '+fact.size);
console.log('montant prélevé abouti : '+Math.round(out.reduce((s,o)=>s+o.montantPreleve,0)).toLocaleString('fr-FR')+' €');
console.log('exemple : '+JSON.stringify(out[0]));
