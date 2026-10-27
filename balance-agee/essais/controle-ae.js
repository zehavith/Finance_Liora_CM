// Contrôle de bout en bout, écrit pour cette question-là : les montants
// correspondent-ils aux règles ? On ne fait confiance à rien de ce que la page
// calcule — on relit balance.json et on refait chaque addition à la main.
const fs=require('fs');
// LA BALANCE À VÉRIFIER EST CELLE DU DOSSIER DE TRAVAIL.
//
// Ce chemin était écrit en dur. Le contrôle ne pouvait donc vérifier qu'une
// seule balance — celle du dépôt — et rendait ses chiffres quelle que soit
// celle qu'on venait de construire. Une balance à date, bâtie à côté,
// repartait avec un satisfecit qui ne la concernait pas.
//
// Le défaut est le même partout : le code se résout depuis son propre
// dossier, les données depuis le répertoire de travail.
const path=require('path');
const CIBLE=process.argv[2] || path.resolve(process.cwd(),'art','balance.json');
if(!fs.existsSync(CIBLE)){
  console.error('balance introuvable : '+CIBLE);
  console.error('lancez le contrôle depuis le dossier qui porte art/balance.json,');
  console.error('ou donnez-lui le fichier en argument.');
  process.exit(2);
}
console.log('balance vérifiée : '+CIBLE);
const d=JSON.parse(fs.readFileSync(CIBLE,'utf8'));
const C=d.cols, dico=d.dico, L=d.lignes;
const ix=new Map(C.map((c,i)=>[c,i]));
const V=(r,n)=>{const j=ix.get(n); if(j===undefined) return ''; const v=r[j];
  return typeof v==='number'?(dico[v]!==undefined?dico[v]:v):(v===null?'':v);};
const N=(r,n)=>{const v=V(r,n); if(v==='') return 0; const x=Number(String(v).replace(/\s|€/g,'').replace(',','.')); return isFinite(x)?x:0;};
const D=s=>{const m=/^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(s||'').trim()); return m?Date.UTC(+m[3],+m[2]-1,+m[1]):null;};
const J=86400000;
const ARRETE=D(d.arrete);
const eur=n=>(Math.round(n*100)/100).toLocaleString('fr-FR',{minimumFractionDigits:2,maximumFractionDigits:2})+' €';

// ── A. l'addition de chaque ligne : base + délai = échéance ──
let aOK=0, aKO=[], aSansBase=0;
for(const r of L){
  const b=D(V(r,'Date de la base retenue')), e=D(V(r,'Date d’échéance recalculée'));
  const j=N(r,'Délai appliqué (jours)');
  if(e===null){ aSansBase++; continue; }
  if(b===null){ aSansBase++; continue; }
  if(b+j*J===e) aOK++; else aKO.push({c:V(r,'N° de compte'),f:V(r,'N° de facture'),b:V(r,'Date de la base retenue'),j,e:V(r,'Date d’échéance recalculée')});
}
console.log('A · base retenue + délai appliqué = échéance');
console.log('    exact : '+aOK+' / '+L.length+'  ·  sans base ou sans échéance : '+aSansBase+'  ·  FAUX : '+aKO.length);
for(const x of aKO.slice(0,5)) console.log('      '+x.c+' '+x.f+' : '+x.b+' + '+x.j+' j ≠ '+x.e);

// ── B. le délai appliqué est-il celui du barème de son dispositif ? ──
const BAR=new Map(d.regles.map(r=>[r.dispositif,r]));
let bSansDisp=0, bConf=0, bExc=new Map(), bEcart=[];
for(const r of L){
  const disp=V(r,'Type de financement'), reg=BAR.get(disp);
  const base=V(r,'Base de calcul retenue'), j=N(r,'Délai appliqué (jours)');
  // L'ALARME LISAIT DEUX COLONNES QUI N'EXISTENT PLUS.
  //
  // « Origine de l'échéance » et « Repli appliqué » ont été retirées du
  // classeur le 21/10/2026. V() rend '' pour une colonne absente : la
  // condition `org === 'Règle'` ne pouvait donc plus jamais être vraie, et le
  // seul compteur capable d'attraper une ligne dont le délai ne suit pas son
  // barème sans qu'aucune règle ne l'explique affichait zéro par
  // construction. Un contrôle qui ne peut pas sonner ne contrôle rien.
  //
  // Ce qui explique une ligne, c'est « Règle de datation appliquée ». Vide, et
  // le barème non suivi : voilà l'écart inexpliqué.
  const exc=V(r,'Règle de datation appliquée');
  // UNE LIGNE SANS DISPOSITIF N'EST PAS UN ÉCART INEXPLIQUÉ.
  //
  // Elle tombait dans le même panier que les vrais écarts, et l'alarme disait
  // « 9 » avec neuf lignes d'« undefined » — elle ne voulait plus rien dire.
  // Un dispositif à qualifier est un fait connu, compté à part : ces lignes
  // portent « type de financement à compléter » et c'est ainsi qu'on les
  // traite. L'alarme, elle, ne doit sonner que pour ce qu'on ne sait pas
  // expliquer.
  if(!reg){ bSansDisp++; continue; }
  const attBase=String(reg.base||''), attJ=Number(reg.jours===''?0:reg.jours);
  if(base===attBase && j===attJ){ bConf++; continue; }
  const cle=(exc?('exception : '+exc):'aucune règle nommée')+'';
  bExc.set(cle,(bExc.get(cle)||0)+1);
  if(!exc) bEcart.push({c:V(r,'N° de compte'),f:V(r,'N° de facture'),disp,base,j,attBase,attJ});
}
console.log('\nB · le délai appliqué est celui du barème du dispositif');
console.log('    conforme au barème : '+bConf+' / '+L.length);
console.log('    écarté par une règle de rang supérieur :');
for(const [k,v] of [...bExc].sort((a,b)=>b[1]-a[1])) console.log('      '+String(v).padStart(6)+'  '+k);
if(bSansDisp) console.log('    sans dispositif, donc hors barème (à compléter) : '+bSansDisp);
console.log('    ÉCART INEXPLIQUÉ (origine « Règle » mais barème non suivi) : '+bEcart.length);
for(const x of bEcart.slice(0,6)) console.log('      '+x.c+' '+x.f+' '+x.disp+' : '+x.base+' +'+x.j+' au lieu de '+x.attBase+' +'+x.attJ);

// ── C. jours de retard = arrêté − échéance ──
let cOK=0, cKO=[];
for(const r of L){
  const e=D(V(r,'Date d’échéance recalculée')); if(e===null) continue;
  const att=Math.round((ARRETE-e)/J), vu=N(r,'Jours de retard');
  if(att===vu) cOK++; else cKO.push({c:V(r,'N° de compte'),e:V(r,'Date d’échéance recalculée'),att,vu});
}
console.log('\nC · jours de retard = arrêté ('+d.arrete+') − échéance');
console.log('    exact : '+cOK+'  ·  FAUX : '+cKO.length);
for(const x of cKO.slice(0,4)) console.log('      '+x.c+' '+x.e+' : attendu '+x.att+' j, affiché '+x.vu);

// ── D. la tranche est celle des jours de retard ──
const M=30, BUCKETS=[['Non échu',-1e9,0],['0 à 3 mois',1,3*M],['3 à 4 mois',3*M+1,4*M],
  ['4 à 6 mois',4*M+1,6*M],['6 à 12 mois',6*M+1,12*M],['12 à 18 mois',12*M+1,18*M],
  ['18 à 24 mois',18*M+1,24*M],['24 à 36 mois',24*M+1,36*M],['36 à 48 mois',36*M+1,48*M],
  ['> 48 mois',48*M+1,1e9]];
const bucket=j=>(BUCKETS.find(b=>j>=b[1]&&j<=b[2])||[''])[0];
let dOK=0, dKO=[];
for(const r of L){
  const v=V(r,'Tranche d’ancienneté'); if(!v) continue;
  const att=bucket(N(r,'Jours de retard'));
  if(att===v) dOK++; else dKO.push({c:V(r,'N° de compte'),j:N(r,'Jours de retard'),att,vu:v});
}
console.log('\nD · la tranche est celle des jours de retard');
console.log('    exact : '+dOK+'  ·  FAUX : '+dKO.length);
for(const x of dKO.slice(0,4)) console.log('      '+x.c+' '+x.j+' j : attendu « '+x.att+' », affiché « '+x.vu+' »');

// ── E. « échu » veut dire strictement plus de zéro jour ──
let eKO=0;
for(const r of L){ const j=N(r,'Jours de retard'), t=V(r,'Tranche d’ancienneté'); if(!t) continue;
  if(j>0 && t==='Non échu') eKO++; if(j<=0 && t!=='Non échu') eKO++; }
console.log('\nE · échu = jours de retard strictement > 0 : '+(eKO?('FAUX sur '+eKO+' lignes'):'vérifié sur toutes les lignes'));
