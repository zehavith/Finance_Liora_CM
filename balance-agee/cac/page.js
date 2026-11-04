#!/usr/bin/env node
/**
 * LA PAGE DE LA BALANCE CAC, TIRÉE DE LA MÊME.
 *
 * Une seule page sert les deux doctrines : c'est la donnée qui dit laquelle
 * elle est (d.doctrine). Un second gabarit aurait divergé du premier au
 * premier correctif. Il ne reste donc à changer que ce qui se lit en haut —
 * le nom de l'artefact et le titre.
 */
const fs=require('fs'), path=require('path');
const ICI=f=>path.join(__dirname,'..',f);
const src=fs.readFileSync(ICI('art/balance-agee.html'),'utf8');
const avant=[
  ['<title>05.01. Balance âgée clients</title>','<title>Balance âgée - Liora</title>'],
  ['<h1>Balance âgée · Grand livre Clients</h1>',
   '<h1>Balance âgée - Liora</h1>'],
];
let out=src, faits=0;
for(const [a,b] of avant){
  if(out.split(a).length-1!==1){ console.error('ancre absente ou multiple : '+a); process.exit(1); }
  out=out.replace(a,b); faits++;
}
fs.mkdirSync(ICI('art-cac'),{recursive:true});
fs.writeFileSync(ICI('art-cac/balance-agee.html'), out, 'utf8');
fs.copyFileSync(ICI('art/tableur.min.js'), ICI('art-cac/tableur.min.js'));
console.log('art-cac/balance-agee.html écrit ('+(out.length/1024).toFixed(1)+' ko · '+faits+' substitutions)');
console.log('art-cac/tableur.min.js copié');

// ───── LES DONNÉES SUIVENT LA PAGE ─────
//
// La construction scelle dans la page ce qu'elle attend de son fichier — le
// nombre d'écritures, l'arrêté et LE JOUR DE CONSTRUCTION — et la page le
// vérifie au chargement. Or ce script ne refaisait que la page : chaque
// reconstruction de la balance laissait les données CAC derrière elle, et
// l'artefact s'ouvrait sur « Les données affichées ne sont pas celles de cette
// page » — le 04/11/2026, les sept fichiers annonçaient le 31/10 quand la page
// attendait le 03/11. Même grand livre, même arrêté : seule l'estampille avait
// bougé, mais rien ne distingue cela d'un vrai désaccord, et c'est bien ainsi.
//
// Les fichiers CAC se retransforment donc ICI, depuis les sources courantes,
// et seulement ceux dont l'empreinte a bougé : une transformation coûte une
// minute et il y en a sept.
const {execFileSync}=require('child_process');
const TRANSFORMER=path.join(__dirname,'transformer.js');
const empreinte=f=>{ try{ const d=JSON.parse(fs.readFileSync(f,'utf8'));
  return JSON.stringify({n:(d.lignes||[]).length, a:d.arrete||'', g:d.genere||''});
}catch(e){ return null; } };

const paires=[[ICI('art/balance.json'), ICI('art-cac/balance.json')]];
const DARR=ICI('art/arretes');
if(fs.existsSync(DARR)){
  fs.mkdirSync(ICI('art-cac/arretes'),{recursive:true});
  for(const f of fs.readdirSync(DARR).filter(x=>x.endsWith('.json')).sort())
    paires.push([path.join(DARR,f), ICI('art-cac/arretes/'+f)]);
}
let refaits=0, gardes=0;
for(const [src,dst] of paires){
  if(!fs.existsSync(src)) continue;
  if(empreinte(src)===empreinte(dst)){ gardes++; continue; }
  console.log('  transformation de '+path.basename(dst)+'\u2026');
  execFileSync(process.execPath,[TRANSFORMER,src,dst],
    {stdio:['ignore','ignore','inherit'], maxBuffer:1<<28});
  refaits++;
}
// L'ACCORD SE VÉRIFIE, IL NE SE PROMET PAS. Un fichier qui reste en désaccord
// après transformation arrête le script plutôt que de laisser publier une
// page qui s'ouvrira sur son propre avertissement.
const faux=paires.filter(([src,dst])=>fs.existsSync(src)&&empreinte(src)!==empreinte(dst));
if(faux.length){
  console.error('empreintes en désaccord après transformation : '
    +faux.map(([,d])=>path.basename(d)).join(', '));
  process.exit(1);
}
console.log('art-cac : '+refaits+' fichier(s) de données retransformé(s), '
  +gardes+' inchangé(s) · empreintes en accord');
