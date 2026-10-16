const DEPOT=require('path').resolve(__dirname,'..','..');
// Le filtre « Seulement les lignes non lettrées ».
//
// L'onglet qui lui était dédié a été retiré du classeur à sa demande : le
// classeur n'a plus que ses cinq onglets. Ce que le filtre annonce à l'écran
// doit donc se retrouver dans le détail ligne à ligne du classeur téléchargé
// pendant que le filtre est posé — et l'onglet retiré ne doit pas revenir.
const { chromium } = require(process.env.PLAYWRIGHT || '/opt/node-tools/node_modules/playwright');
const XLSX=require(DEPOT+'/vendor/xlsx.full.min.js');
const fs=require('fs'), D=require('path').resolve(__dirname,'..'), SORTIE=__dirname;
const ONGLETS=['Sommaire','Règles','Balance âgée','Par type de financement','Détail ligne à ligne'];
(async () => {
  const b=await chromium.launch(); const ctx=await b.newContext({acceptDownloads:true});
  const p=await ctx.newPage({viewport:{width:1500,height:980}});
  const errs=[]; p.on('pageerror',e=>errs.push('PAGE: '+e.message.slice(0,160)));
  await p.goto('file://'+D+'/Balance-agee-Liora.html',{waitUntil:'load'});
  await p.waitForTimeout(5000);
  await p.selectOption('#fac','credit'); await p.waitForTimeout(1500);
  const note=await p.textContent('#cpt');
  console.log('la page annonce : '+note);
  const nPage=Number((note.match(/[\d   ]+/)||['0'])[0].replace(/[^\d]/g,''));
  const [dl]=await Promise.all([ p.waitForEvent('download',{timeout:240000}),
    p.evaluate(()=>document.getElementById('dl-xlsx').click()) ]);
  const f=SORTIE+'/essai-paiements.xlsx'; await dl.saveAs(f);
  const wb=XLSX.read(fs.readFileSync(f),{type:'buffer'});
  console.log('onglets  : '+wb.SheetNames.join(' │ '));
  const trop=wb.SheetNames.filter(n=>!ONGLETS.includes(n));
  const absents=ONGLETS.filter(n=>!wb.SheetNames.includes(n));
  console.log(trop.length||absents.length
    ? 'ÉCART : en trop '+(trop.join(' · ')||'aucun')+' · manquants '+(absents.join(' · ')||'aucun')
    : 'OK  les cinq onglets, ni plus ni moins');
  // Le classeur est le livrable du mois : son détail porte TOUTES les
  // écritures, filtre à l'écran ou non. Ce que le filtre annonce doit donc s'y
  // retrouver comme sous-ensemble — les lignes sans code de lettrage.
  const a=XLSX.utils.sheet_to_json(wb.Sheets['Détail ligne à ligne'],{header:1,blankrows:true});
  const iE=a.findIndex(l=>l&&String(l[0]||'')==='Compte - Client');
  const iLet=a[iE].indexOf('Let.');
  const corps=a.slice(iE+1).filter(l=>l&&l[0]);
  // La colonne « Let. » ne reste pas vide : elle porte « (non lettré) », pour
  // qu'une cellule vide ne puisse jamais passer pour un oubli d'export.
  const sansCode=v=>{const t=String(v==null?'':v).trim(); return !t||t==='(non lettré)';};
  const nonLettrees=corps.filter(l=>sansCode(l[iLet])).length;
  console.log('détail   : '+corps.length+' lignes, dont '+nonLettrees+' sans code de lettrage');
  console.log(nonLettrees===nPage
    ? 'OK  le détail porte exactement les '+nPage+' lignes que le filtre annonce'
    : 'ÉCART : la page dit '+nPage+', le détail en compte '+nonLettrees);
  console.log('erreurs  : '+(errs.length?errs.join(' · '):'aucune'));
  await b.close();
})();
