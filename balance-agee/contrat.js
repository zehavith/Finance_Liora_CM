// ───────── le contrat : ce que le code nomme, les données le portent ─────────
//
// C'est le contrôle qui manquait. Une page qui demande une colonne absente ne
// lève aucune erreur : V() rend la chaîne vide, le filtre ne garde rien, et
// l'écran affiche « 0 écriture » comme si c'était la réponse. On refuse donc
// de construire une page qui nomme une colonne que le fichier n'a pas.
//
// Les alias comptent. fiche() écrit « const g=n=>V(i,n) » puis g('Calcul') :
// un contrôle qui ne lit que V(i,'…') et N(i,'…') rate trois colonnes sur
// seize — précisément le mode de panne qu'il est censé attraper.
const colonnesCitees=code=>{
  const alias=new Set(['V','N']);
  for(const m of code.matchAll(/const\s+(\w+)\s*=\s*\w+\s*=>\s*[VN]\(/g)) alias.add(m[1]);
  const noms=new Set();
  for(const a of alias){
    const re=new RegExp('\\b'+a+'\\((?:[^,\'"()]*,\\s*)?(?:\'([^\']+)\'|"([^"]+)")\\)','g');
    for(const m of code.matchAll(re)) noms.add(m[1]||m[2]);
  }
  return noms;
};
const verifierContrat=(code,cols,quoi)=>{
  const citees=colonnesCitees(code), presentes=new Set(cols);
  const manque=[...citees].filter(c=>!presentes.has(c));
  if(manque.length) throw new Error(quoi+' nomme '+manque.length
    +' colonne(s) que les données n’ont pas : '+manque.join(' · '));
  return citees.size;
};

module.exports={colonnesCitees,verifierContrat};
