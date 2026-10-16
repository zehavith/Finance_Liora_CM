const DEPOT=require('path').resolve(__dirname,'..','..');
// Les deux balances âgées du classeur téléchargé : plus de colonnes de dates,
// et la colonne de l'autre lecture remplie sur chaque ligne de compte.
const { chromium } = require(process.env.PLAYWRIGHT || '/opt/node-tools/node_modules/playwright');
const XLSX=require(DEPOT+'/vendor/xlsx.full.min.js');
const fs=require('fs'), D=require('path').resolve(__dirname,'..'), SORTIE=__dirname;
(async () => {
  const b=await chromium.launch(); const ctx=await b.newContext({acceptDownloads:true});
  const p=await ctx.newPage({viewport:{width:1500,height:980}});
  const errs=[]; p.on('pageerror',e=>errs.push('PAGE: '+e.message.slice(0,160)));
  p.on('console',m=>{if(m.type()==='error')errs.push('CONS: '+m.text().slice(0,160));});
  await p.goto('file://'+D+'/Balance-agee-Liora.html',{waitUntil:'load'});
  await p.waitForTimeout(5000);
  const [dl]=await Promise.all([ p.waitForEvent('download',{timeout:240000}),
    p.evaluate(()=>document.getElementById('dl-xlsx').click()) ]);
  const f=SORTIE+'/essai-colonnes.xlsx'; await dl.saveAs(f);
  console.log((fs.statSync(f).size/1048576).toFixed(2)+' Mo · onglets attendus ci-dessous');
  const wb=XLSX.read(fs.readFileSync(f),{type:'buffer'});
  console.log('onglets : '+wb.SheetNames.join(' │ '));
  for(const nom of ['Balance âgée','Par type de financement']){
    const ws=wb.Sheets[nom]; if(!ws){console.log('ABSENT : '+nom);continue;}
    const a=XLSX.utils.sheet_to_json(ws,{header:1,blankrows:true});
    const iE=a.findIndex(l=>l&&String(l[1]||'')==='Restant dû');
    const ent=a[iE]||[];
    console.log('\n=== '+nom+' ===');
    console.log('  '+ent.length+' colonnes : '+ent.map((x,i)=>i+':'+x).join(' | '));
    const der=ent.length-1;
    let cpt=0,vide=0,cat=0; const ex=[];
    for(const l of a.slice(iE+1)){
      if(!l||l[0]===undefined) continue;
      const t=String(l[0]);
      if(!/^ /.test(t)){ cat++; continue; }
      if(/^ {10}/.test(t)) continue;           // écriture
      cpt++; const v=String(l[der]||'');
      if(!v) vide++; else if(ex.length<6) ex.push(t.trim().slice(0,42).padEnd(42)+' → '+v);
    }
    console.log('  '+cat+' catégories · '+cpt+' comptes');
    console.log('  comptes sans « '+ent[der]+' » : '+vide+' / '+cpt);
    ex.forEach(x=>console.log('    '+x));
  }
  console.log('\nerreurs : '+(errs.length?errs.join(' · '):'aucune'));
  await b.close();
})();
