// Le garde-fou doit crier. Un contrôle qui ne sait pas échouer ne protège rien.
const {colonnesCitees,verifierContrat}=require('./contrat.js');
const COLS=['Débit','Crédit','Calcul','Let.',"Date d'échéance recalculée"];
const CODE=`const V=(li,nom)=>D.dico[D.lignes[li][col[nom]]]||'';
const N=(li,nom)=>0;
function f(i){ const g=n=>V(i,n);
  return N(i,'Débit')+N(i,'Crédit')+g('Calcul')+V(i,"Date d'échéance recalculée")+V(i,'Let.'); }`;
let ok=0,ko=0;
const dit=(c,q)=>{ if(c){ok++;} else {ko++; console.log('   ÉCHEC : '+q);} };

const c=colonnesCitees(CODE);
dit(c.size===5,'cinq colonnes nommées, alias et guillemets doubles compris — vu '+c.size);
dit(c.has('Calcul'),'la colonne citée par l’alias g() est vue');
dit(c.has("Date d'échéance recalculée"),'la colonne entre guillemets doubles est vue');
dit(verifierContrat(CODE,COLS,'essai')===5,'le contrat passe quand tout est là');
let leve=false;
try{ verifierContrat(CODE,COLS.filter(x=>x!=='Calcul'),'essai'); }catch(e){ leve=/Calcul/.test(e.message); }
dit(leve,'le contrat REFUSE quand la colonne de l’alias manque');
leve=false;
try{ verifierContrat(CODE,COLS.filter(x=>x!=='Crédit'),'essai'); }catch(e){ leve=/Crédit/.test(e.message); }
dit(leve,'le contrat REFUSE quand une colonne de N() manque');
console.log('contrat : '+ok+' vérifications passées, '+ko+' en échec');
process.exit(ko?1:0);
