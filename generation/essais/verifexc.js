// Le filtre « comptes en excédent » : il doit montrer les écritures des
// comptes réellement créditeurs, groupées par compte, et annoncer le bon total.
const { chromium } = require(process.env.PLAYWRIGHT || '/opt/node-tools/node_modules/playwright');
const D=__dirname;
(async () => {
  const b=await chromium.launch(); const p=await (await b.newContext()).newPage();
  const errs=[]; p.on('pageerror',e=>errs.push('PAGE: '+e.message.slice(0,200)));
  p.on('console',m=>{if(m.type()==='error')errs.push('CONS: '+m.text().slice(0,200));});
  await p.goto('file://'+D+'/Balance-agee-Liora.html',{waitUntil:'load'});
  await p.waitForTimeout(5000);
  for(const [v,nom] of [['excedent','comptes en excédent'],['credit','montants non lettrés'],['','tout']]){
    await p.selectOption('#fac',v); await p.waitForTimeout(1200);
    console.log(nom.padEnd(26)+' → '+(await p.textContent('#cpt')));
  }
  await p.selectOption('#fac','excedent'); await p.waitForTimeout(1200);
  const prem=await p.evaluate(()=>[...document.querySelectorAll('#cale .lig')].slice(0,6)
    .map(e=>e.textContent.replace(/\s+/g,' ').slice(0,96)));
  console.log('les 3 premières lignes (le plus gros excédent en tête) :');
  prem.forEach(x=>console.log('   '+x));
  console.log('erreurs : '+(errs.length?errs.join(' · '):'aucune'));
  await b.close();
})();
