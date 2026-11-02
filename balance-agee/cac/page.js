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
