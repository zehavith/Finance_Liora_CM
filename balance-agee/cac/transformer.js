#!/usr/bin/env node
/**
 * LA BALANCE ÂGÉE SELON LES RÈGLES DU COMMISSAIRE AUX COMPTES.
 *
 * Sa demande du 02/11/2026 : « duplique l'artefact balance âgée client que
 * l'on travaille et nomme la nouvelle version balance agé - Liora ; sur cette
 * balance âgée utilise les règles de l'onglet CAC pour bien cadrer avec ce qui
 * est mis pour être provisionné », puis « tu fais comme le fichier ».
 *
 * DEUX BALANCES, DEUX DOCTRINES. « Les 2 balances âgées se basent sur des
 * règles différentes, c'est normal qu'elles ne soient pas identiques. » Celle-
 * ci ne remplace pas la sienne : elle dit ce que le CAC provisionnerait.
 *
 * ON NE REFAIT PAS LA CHAÎNE, ON TRANSFORME SA SORTIE. Le grand livre, le
 * lettrage, le rapprochement et les restes dus ne changent pas d'une doctrine
 * à l'autre — seules l'échéance, la tranche et l'assiette changent. Refaire
 * construire.js avec un second jeu de règles aurait dupliqué trois mille
 * lignes de code pour recalculer à l'identique tout ce qui ne bouge pas.
 *
 * Les règles sont celles de l'onglet « Règles CAC » de son fichier
 * « Balance_agee_300626_regles_CAC_reste_du_artefact », lu le 02/11/2026.
 */
const fs=require('fs'), path=require('path');

const SRC=process.argv[2]||path.join(__dirname,'..','art','balance.json');
const DST=process.argv[3]||path.join(__dirname,'..','art-cac','balance.json');

// ───────── les règles CAC, telles qu'écrites dans son onglet ─────────
//
// Rang 1  facture postérieure à la fin de formation, ou facture sans fin de
//         formation            → date de facture + 60 j
// Rang 2  mandat GoCardless    → fin de formation + 30 j
// Rang 3  le barème du dispositif
// Rang 4  base manquante       → échéance Pennylane, à défaut la date de la ligne
const PLUS60=new Set(['Agefiph','AIF','B2B','B2C-Entreprise','CPF','POEI','Region',
  'Transition Pro','Interco','Interne - DST Allemagne']);
const PLUS30=new Set(['ETAT','OPCO','OPCO - Alternance','Alternance']);
const DEBUT=new Set(['Financement personnel','B2C-Perso','Perso-Alternance']);
const FACT30=new Set(['Corporate - Alternance']);

// Les bornes du CAC, en jours de retard. « mois de 30 j », son onglet.
const BORNES=[[90,'0 à 3 mois'],[120,'3 à 4 mois'],[180,'4 à 6 mois'],[360,'6 à 12 mois'],
  [540,'12 à 18 mois'],[720,'18 à 24 mois'],[1080,'24 à 36 mois'],[1440,'36 à 48 mois']];

// Les familles du CAC. INTERCO EST EXCLU, et « Interne - DST Allemagne » ne
// figure dans aucune famille : ni l'un ni l'autre n'est provisionné.
const FAMILLES={
  'B2C':['Financement personnel','B2C-Perso','Perso-Alternance'],
  'ETATIQUE':['CPF','Transition Pro','AIF','POEI','Region','Agefiph','ETAT','OPCO','OPCO - Alternance'],
  'B2B':['B2C-Entreprise','B2B','Corporate - Alternance'],
};
const TAUX={'B2C':[0.2,0.4,0.9,1],'ETATIQUE':[0,0,0.5,1],'B2B':[0.4,0.4,0.9,1]};
const FENETRES=[
  {label:'121 - 180 j',tranches:['4 à 6 mois']},
  {label:'181 - 360 j',tranches:['6 à 12 mois']},
  {label:'361 - 720 j',tranches:['12 à 18 mois','18 à 24 mois']},
  {label:'> 720 j',tranches:['24 à 36 mois','36 à 48 mois','> 48 mois']},
];
// Ce que le grand livre ne peut pas dire : repris de son fichier CAC.
const COMPTA={provisionEnCompta:-1396287.77, compte511:-275353.88};

// ───────── outils de date ─────────
const J=86400000;
function lire(s){
  if(!s) return null;
  const t=String(s).trim();
  let m=/^(\d{2})\/(\d{2})\/(\d{4})$/.exec(t);
  if(m) return Date.UTC(+m[3],+m[2]-1,+m[1]);
  m=/^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
  return m?Date.UTC(+m[1],+m[2]-1,+m[3]):null;
}
const ecrire=t=>t==null?'':new Date(t).toISOString().slice(0,10).split('-').reverse().join('/');
const plus=(t,j)=>t==null?null:t+j*J;

// ───────── le dictionnaire ─────────
// Chaque cellule est un indice dans d.dico. Pour écrire une valeur neuve il
// faut l'y ajouter — et ne l'ajouter qu'une fois, sinon le dictionnaire double
// de taille à chaque colonne réécrite.
function dictionnaire(dico){
  const vers=new Map();
  dico.forEach((v,i)=>{ if(!vers.has(v)) vers.set(v,i); });
  return {
    index(v){
      const s=v==null?'':String(v);
      let i=vers.get(s);
      if(i===undefined){ i=dico.length; dico.push(s); vers.set(s,i); }
      return i;
    }
  };
}

function transformer(){
  const d=JSON.parse(fs.readFileSync(SRC,'utf8'));
  const C={}; d.cols.forEach((c,i)=>{ C[c]=i; });
  const dic=dictionnaire(d.dico);
  const txt=(l,nom)=>{ const i=C[nom]; return i===undefined?'':String(d.dico[l[i]]??''); };
  const nb=(l,nom)=>{ const v=txt(l,nom).replace(/\s/g,'').replace(',','.');
                      const x=parseFloat(v); return Number.isFinite(x)?x:0; };
  const REF=lire(d.arrete);
  if(REF==null) throw new Error('date d’arrêté illisible : '+d.arrete);

  // ── l'échéance CAC d'une facture ──
  function echeance(l){
    const fin=lire(txt(l,'Date de fin de formation'));
    const deb=lire(txt(l,'Date de début de formation'));
    const fac=lire(txt(l,'Date de facture (facturation)'))||lire(txt(l,'Date'));
    const penn=lire(txt(l,'Date d’échéance'));
    const sc=txt(l,'Type de financement de la créance')||txt(l,'Type de financement');
    const mandat=/mandat de prélèvement GoCardless/.test(txt(l,'Règle de datation appliquée'));
    if(fac!=null && (fin==null || fac>fin))
      return {t:plus(fac,60), base:'date de facture', dateBase:fac, jours:60,
        regle:'Rang 1 · facture postérieure à la fin de formation'};
    if(mandat && fin!=null)
      return {t:plus(fin,30), base:'fin de formation', dateBase:fin, jours:30,
        regle:'Rang 2 · mandat de prélèvement GoCardless'};
    if(PLUS60.has(sc) && fin!=null)
      return {t:plus(fin,60), base:'fin de formation', dateBase:fin, jours:60,
        regle:'Rang 3 · barème du dispositif'};
    if(PLUS30.has(sc) && fin!=null)
      return {t:plus(fin,30), base:'fin de formation', dateBase:fin, jours:30,
        regle:'Rang 3 · barème du dispositif'};
    if(DEBUT.has(sc) && deb!=null)
      return {t:deb, base:'début de formation', dateBase:deb, jours:0,
        regle:'Rang 3 · barème du dispositif'};
    if(FACT30.has(sc) && fac!=null)
      return {t:plus(fac,30), base:'date de facture', dateBase:fac, jours:30,
        regle:'Rang 3 · barème du dispositif'};
    if(penn!=null)
      return {t:penn, base:'échéance Pennylane', dateBase:penn, jours:0,
        regle:'Rang 4 · base manquante, échéance Pennylane'};
    const own=lire(txt(l,'Date'));
    return {t:own, base:'date de l’écriture', dateBase:own, jours:0,
      regle:'Rang 4 · base manquante, aucune échéance Pennylane'};
  }
  const tranche=j=>{ if(j==null||j<=0) return '';
    for(const [b,n] of BORNES) if(j<=b) return n; return '> 48 mois'; };

  // ── l'échéance de chaque créance, portée par sa facture ──
  const groupes=new Map();
  for(const l of d.lignes){
    const k=txt(l,'Clé de la créance'); if(!k) continue;
    if(!groupes.has(k)) groupes.set(k,[]);
    groupes.get(k).push(l);
  }
  const ech=new Map();
  for(const [k,g] of groupes){
    const f=g.find(x=>/facture/i.test(txt(x,'Nature de l’écriture')))||g[0];
    ech.set(k, echeance(f));
  }

  // ── réécrire les colonnes de datation, ligne par ligne ──
  let refaites=0;
  for(const l of d.lignes){
    const k=txt(l,'Clé de la créance');
    const e=k?ech.get(k):echeance(l);
    const j=e.t==null?null:Math.round((REF-e.t)/J);
    const tr=tranche(j);
    const detail=(e.jours?(e.base+' '+ecrire(e.dateBase)+' + '+e.jours+' j'):(e.base+' '+ecrire(e.dateBase)))
      +' = '+ecrire(e.t);
    l[C['Date d’échéance recalculée']]=dic.index(ecrire(e.t));
    l[C['Jours de retard']]=dic.index(j==null?'':String(j));
    l[C['Tranche d’ancienneté']]=dic.index(tr);
    l[C['Base de calcul retenue']]=dic.index(e.base);
    l[C['Date de la base retenue']]=dic.index(ecrire(e.dateBase));
    l[C['Délai appliqué (jours)']]=dic.index(String(e.jours));
    l[C['Règle de datation appliquée']]=dic.index(e.regle);
    l[C['Détail du calcul']]=dic.index(detail);
    l[C['Jours de retard de la créance']]=dic.index(j==null?'':String(j));
    l[C['Tranche de la créance']]=dic.index(tr);
    refaites++;
  }

  // ── refaire les synthèses, PAR CRÉANCE ──
  const TR=d.tranches;
  function synthese(champ){
    const m=new Map(), vues=new Set();
    for(const l of d.lignes){
      const k=txt(l,'Clé de la créance'); if(!k||vues.has(k)) continue; vues.add(k);
      const c=txt(l,champ); if(!c) continue;
      const rd=nb(l,'Reste dû de la créance');
      let o=m.get(c);
      if(!o){ o={cat:c,total:0,echu:0,nonEchu:0,crediteur:0,nb:0,buckets:TR.map(()=>0)}; m.set(c,o); }
      o.total+=rd;
      const i=TR.indexOf(txt(l,'Tranche de la créance'));
      if(i>=0){ o.buckets[i]+=rd; o.echu+=rd; } else o.nonEchu+=rd;
      if(rd<0) o.crediteur+=rd;
      if(Math.abs(rd)>=0.005) o.nb++;
    }
    const liste=[...m.values()].sort((a,b)=>b.total-a.total);
    const T={cat:'TOTAL',total:0,echu:0,nonEchu:0,crediteur:0,nb:0,buckets:TR.map(()=>0)};
    for(const o of liste){ T.total+=o.total; T.echu+=o.echu; T.nonEchu+=o.nonEchu;
      T.crediteur+=o.crediteur; T.nb+=o.nb; o.buckets.forEach((v,i)=>{T.buckets[i]+=v;}); }
    liste.push(T);
    return liste;
  }
  d.syntheseCat=synthese('Type de client de la créance');
  d.synthese=synthese('Type de financement de la créance');

  // ── la provision CAC : le solde NET, sans aucune imputation ──
  //
  // « Sommes nettes par sous-catégorie, montants négatifs compris », son
  // onglet. Le CAC n'impute rien : chaque créance porte son reste dû dans sa
  // tranche, débiteur ou créditeur, et le taux s'applique au solde net de la
  // famille dans la fenêtre. Une tranche négative allège donc la provision.
  const famDe=sc=>{ for(const [f,l] of Object.entries(FAMILLES)) if(l.indexOf(sc)>=0) return f; return null; };
  const assiette={}, provision={};
  for(const f of Object.keys(TAUX)){ assiette[f]=FENETRES.map(()=>0); provision[f]=FENETRES.map(()=>0); }
  for(const o of d.synthese){
    if(o.cat==='TOTAL') continue;
    const f=famDe(o.cat); if(!f) continue;
    o.buckets.forEach((v,i)=>{
      const w=FENETRES.findIndex(x=>x.tranches.indexOf(TR[i])>=0);
      if(w>=0) assiette[f][w]+=v;
    });
  }
  let total=0;
  for(const f of Object.keys(TAUX)){
    provision[f]=assiette[f].map((v,i)=>v*TAUX[f][i]);
    total+=provision[f].reduce((a,b)=>a+b,0);
  }
  d.provision={
    confirme:true, methode:'CAC',
    fenetres:FENETRES, taux:TAUX, familles:FAMILLES,
    quand:d.arrete,
    // Ce que la doctrine CAC fait de l'assiette, dit une fois pour toutes.
    assiette:'solde net de la sous-catégorie dans la tranche, négatifs compris, sans imputation',
    exclus:['Interco','Interne - DST Allemagne'],
  };
  d.provisionCac={ assiette, provision, total,
    provisionEnCompta:COMPTA.provisionEnCompta, compte511:COMPTA.compte511,
    aPasser: total+COMPTA.provisionEnCompta+COMPTA.compte511 };
  d.source=d.source+' · règles du commissaire aux comptes';
  d.doctrine='CAC';

  fs.mkdirSync(path.dirname(DST),{recursive:true});
  fs.writeFileSync(DST, JSON.stringify(d), 'utf8');
  const eur=n=>Math.round(n).toLocaleString('fr-FR')+' €';
  const T=d.synthese[d.synthese.length-1];
  console.log('balance âgée · règles CAC · arrêtée au '+d.arrete);
  console.log('  '+refaites.toLocaleString('fr-FR')+' écritures redatées · '
    +groupes.size.toLocaleString('fr-FR')+' créances · dictionnaire '+d.dico.length.toLocaleString('fr-FR'));
  console.log('  reste dû '+eur(T.total)+' · échu '+eur(T.echu)+' · non échu '+eur(T.nonEchu));
  console.log('\n  assiette      '+FENETRES.map(f=>f.label.padStart(14)).join('')+'         TOTAL');
  for(const f of Object.keys(TAUX))
    console.log('  '+f.padEnd(14)+assiette[f].map(v=>eur(v).padStart(14)).join('')
      +eur(assiette[f].reduce((a,b)=>a+b,0)).padStart(14));
  console.log('\n  provision     '+FENETRES.map(f=>f.label.padStart(14)).join('')+'         TOTAL');
  for(const f of Object.keys(TAUX))
    console.log('  '+f.padEnd(14)+provision[f].map(v=>eur(v).padStart(14)).join('')
      +eur(provision[f].reduce((a,b)=>a+b,0)).padStart(14));
  console.log('  '+'TOTAL'.padEnd(14)+FENETRES.map(()=>''.padStart(14)).join('')+eur(total).padStart(14));
  console.log('\n  provision théorique '+eur(total));
  console.log('  provision en compta '+eur(COMPTA.provisionEnCompta));
  console.log('  compte d’attente 511 '+eur(COMPTA.compte511));
  console.log('  PROVISION À PASSER   '+eur(d.provisionCac.aPasser));
  console.log('\n  écrit dans '+DST);
}
transformer();
