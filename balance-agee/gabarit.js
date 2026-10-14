// Les deux pages sortent du MÊME gabarit : page-avant.html + page-apres.html.
//
// Elles ne diffèrent que par trois points, et c'est ici — à un seul endroit —
// qu'ils sont écrits :
//   1. les données : embarquées dans le fichier autonome, servies à part et
//      chargées par fetch dans l'artefact ;
//   2. le téléchargement : une ancre dans le fichier, le canal « downloads »
//      dans l'artefact, qui bloque tout téléchargement qu'une page déclenche
//      elle-même ;
//   3. l'enveloppe : le fichier est un document complet, l'artefact est
//      enveloppé à la publication.
//
// Toute autre différence est une dérive. C'est une dérive de ce genre qui a
// fait partir une page neuve avec les données de la veille : le code savait
// lire trois colonnes que le fichier publié n'avait pas, et le filtre rendait
// zéro ligne sans une seule erreur.
const fs=require('fs');
// Le gabarit et la bibliothèque sont du CODE : ils vivent à côté de ce
// fichier, où qu'on lance la construction. Les données — page-donnees.json,
// art/ — restent relatives au dossier de travail, puisqu'elles changent à
// chaque arrêté.
const ICI=f=>require('path').join(__dirname,f);
const avant=fs.readFileSync(ICI('page-avant.html'),'utf8');
const apres=fs.readFileSync(ICI('page-apres.html'),'utf8');
const donnees=fs.readFileSync('page-donnees.json','utf8');

const {verifierContrat}=require('./contrat.js');

const coupe=(s,vieux,neuf,quoi)=>{
  if(!s.includes(vieux)) throw new Error('le gabarit a changé : '+quoi+' introuvable');
  return s.replace(vieux,neuf);
};

// ───────── 1. le fichier autonome ─────────
// Il doit marcher hors connexion : la bibliothèque qui écrit le classeur est
// donc embarquée dans le fichier, là où l'artefact la sert à côté de sa page.
const BALISE='<script src="tableur.min.js"></script>';
if(!avant.includes(BALISE)) throw new Error('le gabarit a changé : la balise de la bibliothèque est introuvable');
// Une balise <script> écrite dans la page ne peut pas porter la suite « <!-- » :
// l'analyseur HTML y entre dans un état d'échappement et coupe le script en
// silence — la bibliothèque arrivait tronquée à 218 801 caractères sur 881 727,
// « XLSX » n'existait pas, et le bouton ne faisait rien. Les quatre occurrences
// sont dans des expressions régulières, où « \u0021 » vaut « ! » à l'identique.
// Et ses tables de pages de code portent 800 octets de contrôle bruts, dont
// 33 ESC, qu'une publication de texte refuse. Dans un littéral de chaîne comme
// dans une classe de caractères, « \\x1b » vaut exactement le même caractère.
const XLSXJS=fs.readFileSync(ICI('vendor/tableur.min.js'),'utf8')
  .replace(/<!--/g,'<\\u0021--')
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g,
    c=>'\\x'+c.charCodeAt(0).toString(16).padStart(2,'0'))
  // Ses tables portent aussi 51 671 caractères U+FFFD — la case vide d'une
  // page de code, écrite telle quelle. « \\ufffd » dit le même caractère sans
  // que le fichier porte un caractère de remplacement.
  .replace(/\uFFFD/g,'\\ufffd');
if(/<\/script|<!--/i.test(XLSXJS))
  throw new Error('la bibliothèque porte encore une suite qui couperait la balise');
if(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFD]/.test(XLSXJS))
  throw new Error('la bibliothèque porte encore un caractère que la publication refuse');
// Et le piège qui a réellement tronqué la bibliothèque : dans un remplacement
// passé comme CHAÎNE, « $& », « $' » et « $` » sont des motifs. La bibliothèque
// en contient, et 881 727 caractères arrivaient en 218 801. Une FONCTION de
// remplacement ne substitue rien.
const autonome=avant.replace(BALISE,()=>'<script>'+XLSXJS+'</'+'script>') + donnees + apres;
if(!autonome.includes(XLSXJS)) throw new Error('la bibliothèque n’a pas été embarquée en entier');
fs.writeFileSync('Balance-agee-Liora.html', autonome);

// ───────── 2. la page de l'artefact ─────────
const P_AUTONOME='  <p class="sous">Fichier autonome : il fonctionne hors connexion, sans compte, dans n’importe quel navigateur.</p>\n';
let aAvant=coupe(avant,P_AUTONOME,'','la mention du fichier autonome');
// l'enveloppe est posée à la publication : on enlève la nôtre
aAvant=coupe(aAvant,'<!doctype html>\n<html lang="fr">\n<head>\n<meta charset="utf-8">\n'
  +'<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">\n</head>\n<body>\n',
  '','l’en-tête du document');
aAvant=coupe(aAvant,'<script id="donnees" type="application/json">','','la balise des données');

let aApres=apres;
aApres=coupe(aApres,'</script>\n<script>\nconst DONNEES=JSON.parse(document.getElementById("donnees").textContent);\n',
  '<script>\n','la lecture des données embarquées');
aApres=coupe(aApres,'Promise.resolve(DONNEES).then(d=>{ D=d;',
  "fetch('balance.json').then(r=>r.json()).then(d=>{ D=d;",'le chargement des données');
aApres=coupe(aApres,`let remettre=async(nom,octets)=>{const a=document.createElement('a');
  a.href=URL.createObjectURL(new Blob([octets],{type:MIME}));
  a.download=nom;document.body.appendChild(a);a.click();
  setTimeout(()=>{URL.revokeObjectURL(a.href);a.remove();},1000);};
E('telech').hidden=false;`,
`let remettre=null;
// Le visualiseur bloque les téléchargements qu'une page déclenche elle-même :
// seul le canal « downloads » en ouvre un, et le lecteur confirme. Sans lui,
// les boutons n'apparaissent pas plutôt que de ne rien faire.
(async()=>{ let DL=null;
  try{ DL=await window.claude?.use?.('downloads'); }catch(e){ DL=null; }
  if(!DL) return;
  remettre=async(nom,octets)=>{ await DL.save({filename:nom,data:octets}); };
  E('telech').hidden=false;
})();`,'le téléchargement');
// le bouton n'apparaît que si le canal existe : la déclaration du gabarit saute
aApres=coupe(aApres,'  E("telech").hidden=false;\n','','l’affichage des boutons');
aApres=coupe(aApres,'</script>\n\n</body>\n</html>','</script>\n','la fin du document');

fs.mkdirSync('art',{recursive:true});
fs.writeFileSync('art/balance-agee.html', aAvant + aApres);
fs.copyFileSync('page-donnees.json','art/balance.json');
fs.writeFileSync('art/tableur.min.js', XLSXJS);

// ───────── 3. les deux copies d'essai ─────────
// Elles vivent à part : rangées dans art/, elles portaient le nom même sous
// lequel l'artefact publie sa page, et l'une d'elles simule « window.claude ».
// Publiée par erreur, elle aurait l'air de marcher sans rien garder.
const ENV=s=>'<!doctype html><html><head><meta charset=utf8>'
  +'<meta name=viewport content="width=device-width,initial-scale=1"></head><body>'
  +s+'</body></html>';
const art=fs.readFileSync('art/balance-agee.html','utf8');
fs.mkdirSync('essais',{recursive:true});
fs.writeFileSync('essais/index2.html', ENV(art));
// La même page avec un faux « claude » : c'est le seul moyen d'exercer ici le
// chemin de la base de l'artefact, qui n'existe que chez le lecteur.
const FAUX=`<script>
const _lu=()=>{try{return new Map(JSON.parse(localStorage.getItem('_faussebase')||'[]'));}catch(e){return new Map();}};
const _ec=d=>{try{localStorage.setItem('_faussebase',JSON.stringify([...d]));}catch(e){}};
window.claude={ _d:_lu(), use(n){
  if(n==='downloads') return Promise.resolve({save:async()=>{window.__dl=(window.__dl||0)+1;}});
  if(n==='user') return Promise.resolve({can:async()=>true, isOwner:()=>true});
  if(n!=='db') return Promise.resolve(null);
  const d=this._d;
  const coll=p=>({ async get(){ return {docs:[...d].filter(([k])=>k.startsWith(p+'/'))
        .map(([k,v])=>({id:k.split('/').pop(),exists:true,data:()=>v}))}; },
    doc:(id)=>({ async set(v){ d.set(p+'/'+id,v); _ec(d); },
                 async delete(){ d.delete(p+'/'+id); _ec(d); } }) });
  return Promise.resolve({collection:coll});
} };
</script>`;
fs.writeFileSync('essais/index3.html', ENV(FAUX+art));
// Les essais lisent les MÊMES données que l'artefact, par un lien : une copie
// se périmerait, et c'est précisément le défaut qu'on cherche à rendre
// impossible.
try{ fs.unlinkSync('essais/balance.json'); }catch(e){}
fs.symlinkSync('../art/balance.json','essais/balance.json');
try{ fs.unlinkSync('essais/tableur.min.js'); }catch(e){}
fs.symlinkSync('../tableur.min.js','essais/tableur.min.js');

const COLS=JSON.parse(donnees).cols;
const n1=verifierContrat(apres,COLS,'la page autonome');
const n2=verifierContrat(aApres,COLS,'la page de l’artefact');
console.log('contrat des colonnes : '+n1+' nommées par la page autonome, '+n2
  +' par l’artefact — toutes présentes dans les '+COLS.length+' colonnes des données');

const ko=f=>(fs.statSync(f).size/1048576).toFixed(2)+' Mo';
console.log('Balance-agee-Liora.html : '+ko('Balance-agee-Liora.html'));
console.log('art/balance-agee.html   : '+(fs.statSync('art/balance-agee.html').size/1024).toFixed(1)+' ko');
console.log('art/balance.json        : '+ko('art/balance.json'));
