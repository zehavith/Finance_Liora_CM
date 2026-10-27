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
// Le logo, repris de son modèle de présentation et embarqué en clair dans la
// page : le fichier autonome doit s'ouvrir hors connexion, sans rien aller
// chercher. 11 ko de PNG, 15 ko une fois encodés.
const LOGO='data:image/png;base64,'+fs.readFileSync(ICI('logo-liora.png')).toString('base64');
const avant=fs.readFileSync(ICI('page-avant.html'),'utf8').split('{{LOGO}}').join(LOGO);
const B64=fs.readFileSync(ICI('logo-liora.png')).toString('base64');
const apres=fs.readFileSync(ICI('page-apres.html'),'utf8').split('{{LOGO_B64}}').join(B64);
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
// LES ARRÊTÉS CONSTRUITS D'AVANCE, SCELLÉS DANS LA PAGE.
//
// « j'aimerais pv télécharger une balance agé à date », 23/10/2026. Chacun est
// une balance refaite de bout en bout à sa date par cette même chaîne, posée
// dans art/arretes/. La page n'en recalcule aucun : elle les charge.
//
// La signature de chaque fichier — écritures, arrêté, jour de construction —
// part avec la liste : c'est elle que l'empreinte vérifiera au chargement, à
// la place de celle de la balance du jour.
const ARRETES_DISPO=(()=>{
  const dir='art/arretes';
  if(!fs.existsSync(dir)) return {};
  const out={};
  for(const f of fs.readdirSync(dir).filter(n=>/^balance-\d{4}-\d{2}-\d{2}\.json$/.test(n))){
    const m=JSON.parse(fs.readFileSync(require('path').join(dir,f),'utf8'));
    out[f.slice(8,18)]={n:(m.lignes||[]).length, a:m.arrete||'', g:m.genere||''};
  }
  return out;
})();
aApres=coupe(aApres,'let ARRETES={};',
  'let ARRETES='+JSON.stringify(ARRETES_DISPO)+';','la liste des arrêtés');
aApres=coupe(aApres,'Promise.resolve(DONNEES).then(d=>{ D=d;',
  "fetch(FICHIER_DONNEES()).then(r=>r.json()).then(d=>{ D=d; empreinte(d);",'le chargement des données');
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
// LA PAGE ET SES DONNÉES DOIVENT VENIR DE LA MÊME CONSTRUCTION.
//
// Le fichier autonome porte ses données en lui : elles ne peuvent pas se
// désaccorder. L'artefact, lui, sert deux fichiers — la page et balance.json —
// et une publication qui n'envoie que la page laisse les données de la veille
// en place. C'est arrivé le 22/10/2026 : la page affichait 14 635 123,02 €
// pendant que le grand livre déposé en disait 14 268 635,41 €, et rien ne le
// signalait. « On n'est pas à 14 268 635,41, prk ? »
//
// La construction scelle donc dans la page ce qu'elle attend du fichier — le
// nombre d'écritures, la date d'arrêté, le jour de construction — et la page
// le vérifie au chargement. Un désaccord s'affiche en grand, au-dessus de
// tout : des chiffres faux qui se taisent sont pires que pas de chiffres.
const att=JSON.parse(donnees);
const EMPREINTE=JSON.stringify({n:(att.lignes||[]).length, a:att.arrete||'', g:att.genere||''});
aApres=coupe(aApres,'</script>\n\n</body>\n</html>',
`
function empreinte(d){
  const att=SIGNATURE_ATTENDUE()||${EMPREINTE};
  const vu={n:(d.lignes||[]).length, a:d.arrete||'', g:d.genere||''};
  if(vu.n===att.n && vu.a===att.a && vu.g===att.g) return;
  const n=x=>Number(x||0).toLocaleString('fr-FR');
  const b=document.createElement('div');
  b.className='alerte-donnees';
  b.textContent='Les données affichées ne sont pas celles de cette page. '
    +'Elle attend la construction du '+att.g+' — '+n(att.n)+' écritures, arrêté au '+att.a
    +' — et a reçu celle du '+(vu.g||'?')+' — '+n(vu.n)+' écritures, arrêté au '+(vu.a||'?')
    +'. Ne vous fiez à aucun montant tant que la page n’a pas été republiée avec son fichier de données.';
  document.body.insertBefore(b,document.body.firstChild);
}
</script>
`,'la fin du document');

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
  // Le dépôt des fichiers du mois : un faux stockage, pour exercer ici le
  // chemin qui n'existe que chez le lecteur. Rien n'est envoyé nulle part.
  if(n==='comments') return Promise.resolve({
    canSendToClaude:async()=>'available',
    anchorFor:async(el)=>({path:'faux',x:0,y:0}),
    sendToClaude:async(t)=>{ window.__envoi=t; return {threadId:'f1',commentId:'c1'}; },
    create:async()=>({threadId:'f1',commentId:'c1'}),
  });
  if(n==='assets') return Promise.resolve({
    // Le faux magasin REFUSE ce que le vrai refuse.
    //
    // Il acceptait tout, et l'essai passait là où la page échouait chez elle :
    // le magasin d'un artefact n'accepte qu'une liste fermée de types, où un
    // classeur ne figure pas. Le dépôt du grand livre était refusé à chaque
    // fois — « le gd livre n'est pas accepté », 22/10/2026 — sans qu'aucun
    // essai ne le voie. Un faux qui pardonne ne prouve rien.
    upload:async(f,o)=>{
      const T=['image/png','image/jpeg','image/gif','image/webp','image/svg+xml',
               'video/mp4','video/webm','application/pdf','font/woff2','font/woff',
               'font/ttf','font/otf','text/csv','text/markdown','application/json',
               'text/plain','text/css','text/javascript'];
      const t=(o&&o.type)||f.type||'';
      if(T.indexOf(t)<0){ const e=new Error('unsupported_type : '+(t||'type absent'));
        e.code='unsupported_type'; throw e; }
      if(f.size>20*1024*1024){ const e=new Error('too_large'); e.code='too_large'; throw e; }
      window.__up=(window.__up||0)+1;
      return {id:'faux-'+window.__up, url:'', sizeBytes:f.size, contentType:t}; },
    list:async()=>({assets:[],usage:{}}), delete:async()=>{} });
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
// Le lien pointait sur « ../tableur.min.js », qui n'existe pas : les essais
// chargeaient une bibliothèque absente et le classeur ne pouvait pas être
// écrit depuis la page. Il pointe sur celle du dépôt, la même que la page
// autonome embarque.
fs.symlinkSync('../vendor/tableur.min.js','essais/tableur.min.js');
// Les arrêtés aussi : sans eux, le choix de date s'affiche dans les essais et
// chaque date répond 404 — un essai qui ne peut pas exercer le chemin qu'il
// montre ne prouve rien.
try{ fs.unlinkSync('essais/arretes'); }catch(e){}
if(fs.existsSync('art/arretes')) fs.symlinkSync('../art/arretes','essais/arretes');

const COLS=JSON.parse(donnees).cols;
const n1=verifierContrat(apres,COLS,'la page autonome');
const n2=verifierContrat(aApres,COLS,'la page de l’artefact');
console.log('contrat des colonnes : '+n1+' nommées par la page autonome, '+n2
  +' par l’artefact — toutes présentes dans les '+COLS.length+' colonnes des données');

// LE MÊME CONTRAT POUR LES CONTRÔLES.
//
// Il ne couvrait que les deux pages. Les contrôles et les outils d'écart
// lisent le MÊME fichier avec la MÊME tournure V(l,'…') et n'étaient jamais
// vérifiés : le 22/10/2026 on a découvert que le contrôle B lisait deux
// colonnes retirées la veille — sa seule alarme ne pouvait donc plus sonner —
// et que ecartecheance.js, l'outil que le LISEZMOI fait lancer avant toute
// livraison qui change une règle d'échéance, en lisait quatre qui n'existent
// pas, dont « Date d'échéance recalculée » écrite avec une apostrophe droite.
// Un lecteur aveugle ne dit pas qu'il ne voit rien : il affiche zéro.
//
// Sont contrôlés les fichiers qui lisent le dictionnaire de colonnes — les
// fichiers de cas, eux, montent leurs propres lignes avec les en-têtes du
// grand livre, qui n'ont rien à voir.
{
  const dossier=ICI('essais');
  const lus=[];
  for(const nom of fs.readdirSync(dossier).filter(x=>x.endsWith('.js'))){
    const code=fs.readFileSync(dossier+'/'+nom,'utf8');
    if(!/cols\.indexOf|d\.cols/.test(code)) continue;
    lus.push(nom+' ('+verifierContrat(code,COLS,'essais/'+nom)+')');
  }
  console.log('contrat des colonnes · contrôles : '+(lus.join(', ')||'aucun'));
}

const ko=f=>(fs.statSync(f).size/1048576).toFixed(2)+' Mo';
console.log('Balance-agee-Liora.html : '+ko('Balance-agee-Liora.html'));
console.log('art/balance-agee.html   : '+(fs.statSync('art/balance-agee.html').size/1024).toFixed(1)+' ko');
console.log('art/balance.json        : '+ko('art/balance.json'));
{
  const n=Object.keys(ARRETES_DISPO).length;
  console.log('arrêtés à date          : '+(n
    ? n+' — '+Object.keys(ARRETES_DISPO).sort().reverse()
        .map(k=>ARRETES_DISPO[k].a+' ('+ARRETES_DISPO[k].n+' écritures)').join(', ')
    : 'aucun — le choix de date ne s’affichera pas'));
}
