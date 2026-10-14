const DEPOT=require('path').resolve(__dirname,'..','..');
// L'onglet « Paiements non lettrés » : son contenu doit tenir avec ce que
// la page annonce, ligne pour ligne et euro pour euro.
const { chromium } = require(process.env.PLAYWRIGHT || '/opt/node-tools/node_modules/playwright');
const XLSX=require(DEPOT+'/vendor/xlsx.full.min.js');
const fs=require('fs'), D=__dirname;
(async () => {
  const b=await chromium.launch(); const ctx=await b.newContext({acceptDownloads:true});
  const p=await ctx.newPage({viewport:{width:1500,height:980}});
  const errs=[]; p.on('pageerror',e=>errs.push('PAGE: '+e.message.slice(0,160)));
  await p.goto('file://'+D+'/Balance-agee-Liora.html',{waitUntil:'load'});
  await p.waitForTimeout(5000);
  // ce que la page annonce sous le filtre
  await p.selectOption('#fac','credit'); await p.waitForTimeout(1500);
  const note=await p.textContent('#cpt');
  console.log('la page annonce : '+note);
  const [dl]=await Promise.all([ p.waitForEvent('download',{timeout:240000}),
    p.evaluate(()=>document.getElementById('dl-xlsx').click()) ]);
  const f=D+'/essai-paiements.xlsx'; await dl.saveAs(f);
  const wb=XLSX.read(fs.readFileSync(f),{type:'buffer'});
  const ws=wb.Sheets['Montants non lettrés'];
  if(!ws){ console.log('ONGLET ABSENT'); await b.close(); return; }
  // blankrows:false supprime la ligne vide avant l'en-tête et décale tout
  // d'un cran : on repère l'en-tête par son contenu, pas par son rang.
  const a=XLSX.utils.sheet_to_json(ws,{header:1,blankrows:true});
  console.log('bandeau  : '+a[1][0]);
  const iE=a.findIndex(l=>l&&String(l[0]||'')==='Compte - Client');
  if(iE<0){ console.log('EN-TÊTE INTROUVABLE'); await b.close(); return; }
  console.log('entêtes  : (ligne '+(iE+1)+') '+a[iE].join(' | '));
  const corps=a.slice(iE+1).filter(l=>l&&l[0]);
  let mt=0, prop=0, mtD=0;
  for(const l of corps){ mtD+=Number(l[2])||0; mt+=Number(l[3])||0; if(String(l[6]||'').trim()) prop++; }
  console.log('lignes   : '+corps.length+'  ·  débit : '+Math.round(mtD).toLocaleString('fr-FR')+' €  ·  crédit : '+Math.round(mt).toLocaleString('fr-FR')+' €');
  console.log('avec une facture proposée : '+prop+'  ·  sans : '+(corps.length-prop));
  console.log('exemple  : '+corps[0].slice(0,7).map(x=>String(x).slice(0,26)).join(' | '));
  console.log('erreurs  : '+(errs.length?errs.join(' · '):'aucune'));
  await b.close();
})();
