// Le chargeur du moteur, pour les fichiers de cas.
//
// Il vivait dans un répertoire temporaire de session, et cascade.js le
// réclamait par un chemin absolu : le fichier était committé, mais il ne
// tournait que dans ce conteneur-là. La boucle que le LISEZMOI documente —
// « for f in cas*.js; do node $f; done » — mourait dessus partout ailleurs.
// Il est maintenant dans le dépôt, et ses chemins partent de lui-même.
const fs = require('fs'), vm = require('vm'), path = require('path');
const DEPOT = path.resolve(__dirname, '..', '..');
const R0 = DEPOT + '/recouvrement';

function charger() {
  const ctx = {
    self: {}, window: {}, console, Buffer, process,
    TextDecoder, TextEncoder, Date, Math, JSON, setTimeout, clearTimeout,
  };
  ctx.self = ctx; ctx.window = ctx; ctx.globalThis = ctx; ctx.global = ctx;
  vm.createContext(ctx);
  for (const f of [DEPOT + '/vendor/papaparse.min.js', DEPOT + '/vendor/xlsx.full.min.js',
                   R0 + '/js/rules.js', R0 + '/js/ingest.js', R0 + '/js/zoho.js',
                   R0 + '/js/sellsy.js', R0 + '/js/grandlivre.js'])
    vm.runInContext(fs.readFileSync(f, 'utf8'), ctx);
  return ctx;
}

module.exports = { charger };
