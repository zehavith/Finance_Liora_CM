#!/usr/bin/env node
'use strict';

/**
 * Convertisseur Make (blueprint JSON) → n8n (workflow JSON).
 *
 * Usage :
 *   node convert.js <fichier|dossier> [dossier-sortie]
 *   node convert.js blueprints/                 # convertit tous les .json
 *   node convert.js blueprints/mon-scenario.json output/
 *
 * Ce qui est géré :
 *   - modules courants (voir module-map.js)
 *   - routeurs (fan-out multi-branches) et filtres de route → nœuds IF
 *   - itérateurs / aggregators (mapping best-effort)
 *   - conversion des expressions Make {{...}} → n8n {{ $json... }}
 *
 * Ce qui reste manuel :
 *   - connecteurs propriétaires Make sans équivalent direct → nœud NoOp
 *     annoté « ⚠️ À MAPPER » avec le module d'origine en note.
 *   - authentification / credentials (jamais exportés par Make ;
 *     à reconfigurer dans n8n).
 *
 * Aucune dépendance externe.
 */

const fs = require('fs');
const path = require('path');
const { MODULE_MAP, deepMapExpr } = require('./module-map.js');

// ---------------------------------------------------------------------------
// UUID déterministe (pas de dépendance). Suffisant pour des ids de nœuds n8n.
// ---------------------------------------------------------------------------
let uuidSeed = 0;
function uuid() {
  // uuid v4-like déterministe basé sur un compteur — stable entre exécutions.
  uuidSeed += 1;
  const hex = (n, len) => n.toString(16).padStart(len, '0');
  const a = hex(uuidSeed, 8);
  const b = hex((uuidSeed * 7) & 0xffff, 4);
  const c = '4' + hex((uuidSeed * 13) & 0xfff, 3);
  const d = ((8 + (uuidSeed % 4)) & 0xf).toString(16) + hex((uuidSeed * 17) & 0xfff, 3);
  const e = hex((uuidSeed * 23) & 0xffffffffffff, 12);
  return `${a}-${b}-${c}-${d}-${e}`;
}

// ---------------------------------------------------------------------------
// Conversion des expressions Make {{ ... }} → n8n {{ ... }}
// ---------------------------------------------------------------------------
// Make référence les données d'un module par son id numérique : {{ 12.field }}
// ou une valeur mappée {{ 12.data.items[].name }}. n8n référence l'item courant
// via $json et un nœud nommé via $node["Nom"].json.
//
// On fait une conversion best-effort :
//   {{ 12.field }}        -> {{ $node["<nom du module 12>"].json.field }}
//   {{ field }}           -> {{ $json.field }}
//   fonctions Make usuelles (upper, lower, length, join, now...) -> équivalents JS
//
// `nodeNameById` : map id Make -> nom de nœud n8n (rempli avant conversion).
function makeExprMapper(nodeNameById) {
  const FN = {
    upper: (arg) => `(${arg}).toUpperCase()`,
    lower: (arg) => `(${arg}).toLowerCase()`,
    length: (arg) => `(${arg}).length`,
    trim: (arg) => `(${arg}).trim()`,
  };

  function convertInner(expr) {
    let s = expr.trim();

    // Fonctions simples à un argument : upper(x) / lower(x) / length(x) / trim(x)
    for (const [name, fn] of Object.entries(FN)) {
      const re = new RegExp(`\\b${name}\\s*\\(([^()]*)\\)`, 'g');
      s = s.replace(re, (_, inner) => fn(convertInner(inner)));
    }

    // now  -> $now (Luxon dans n8n)
    s = s.replace(/\bnow\b/g, '$now');

    // Référence à un module par id : 12.a.b  ->  $node["Nom"].json.a.b
    s = s.replace(/\b(\d+)\.([A-Za-z_$][\w.$\[\]]*)/g, (whole, id, rest) => {
      const name = nodeNameById.get(Number(id));
      if (name) return `$node[${JSON.stringify(name)}].json.${rest}`;
      return whole;
    });

    // Champ nu (item courant) : field.sub -> $json.field.sub
    // (seulement si ça ressemble à un chemin de données, pas à un littéral)
    if (/^[A-Za-z_$][\w.$\[\]]*$/.test(s) && !s.startsWith('$')) {
      s = `$json.${s}`;
    }

    return s;
  }

  return function mapExpr(value) {
    if (typeof value !== 'string') return value;
    if (!value.includes('{{')) return value;

    let hadExpr = false;
    const converted = value.replace(/\{\{([\s\S]*?)\}\}/g, (_, inner) => {
      hadExpr = true;
      return `{{ ${convertInner(inner)} }}`;
    });

    // n8n : une valeur qui contient une expression doit être préfixée par "="
    return hadExpr && !converted.startsWith('=') ? `=${converted}` : converted;
  };
}

// ---------------------------------------------------------------------------
// Résolution d'un module Make → définition de nœud n8n
// ---------------------------------------------------------------------------
function resolveModule(makeModule) {
  const id = makeModule.module || '';
  if (MODULE_MAP[id]) return MODULE_MAP[id];
  const prefix = id.split(':')[0];
  const byPrefix = Object.entries(MODULE_MAP).find(([k]) => k.startsWith(prefix + ':'));
  if (byPrefix) return byPrefix[1];
  return null; // non mappé
}

// ---------------------------------------------------------------------------
// Aplatissement du flow Make en une liste ordonnée de "steps"
// ---------------------------------------------------------------------------
// Un flow Make est un tableau séquentiel. Un routeur porte `routes[]`, chaque
// route ayant son propre `flow[]` (sous-branche). On aplatit en gardant la
// topologie via des liens parent→enfant.
function flattenFlow(flow, parentId, steps, edges, routeFilter) {
  let prevId = parentId;
  let firstFilter = routeFilter; // filtre à poser sur le premier lien de la branche
  for (const mod of flow) {
    const stepId = mod.id;
    steps.push(mod);
    if (prevId != null) {
      edges.push({ from: prevId, to: stepId, filter: firstFilter, moduleFilter: mod.filter });
      firstFilter = null;
    }
    // Filtre inter-module Make : `mod.filter` conditionne l'entrée du module.
    if (Array.isArray(mod.routes)) {
      // Routeur : chaque route démarre une sous-branche depuis ce module.
      for (const route of mod.routes) {
        flattenFlow(route.flow || [], stepId, steps, edges, route.filter || null);
      }
      // Après un routeur, la séquence principale ne continue pas linéairement.
      prevId = null;
    } else {
      prevId = stepId;
    }
  }
}

// ---------------------------------------------------------------------------
// Construction d'un nœud IF n8n depuis un filtre Make
// ---------------------------------------------------------------------------
function buildIfNode(filter, mapExpr, position) {
  const conditions = (filter && filter.conditions) || [];
  // Make : conditions = tableau de groupes OR, chaque groupe = tableau AND.
  const flat = [];
  for (const group of conditions) {
    for (const cond of group) {
      flat.push({
        id: uuid(),
        leftValue: mapExpr(cond.a != null ? cond.a : ''),
        rightValue: mapExpr(cond.b != null ? cond.b : ''),
        operator: mapOperator(cond.o),
      });
    }
  }
  return {
    id: uuid(),
    name: (filter && filter.name) || 'Filtre',
    type: 'n8n-nodes-base.if',
    typeVersion: 2,
    position,
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
        combinator: conditions.length > 1 ? 'or' : 'and',
        conditions: flat.map((c) => ({
          id: c.id,
          leftValue: c.leftValue,
          rightValue: c.rightValue,
          operator: c.operator,
        })),
      },
      options: {},
    },
  };
}

function mapOperator(makeOp) {
  const M = {
    'text:equal': { type: 'string', operation: 'equals' },
    'text:notequal': { type: 'string', operation: 'notEquals' },
    'text:contain': { type: 'string', operation: 'contains' },
    'text:notcontain': { type: 'string', operation: 'notContains' },
    'number:equal': { type: 'number', operation: 'equals' },
    'number:greater': { type: 'number', operation: 'gt' },
    'number:less': { type: 'number', operation: 'lt' },
    'exist': { type: 'string', operation: 'exists', singleValue: true },
    'notexist': { type: 'string', operation: 'notExists', singleValue: true },
  };
  return M[makeOp] || { type: 'string', operation: 'equals' };
}

// ---------------------------------------------------------------------------
// Conversion d'un blueprint complet
// ---------------------------------------------------------------------------
function convertBlueprint(blueprint) {
  uuidSeed = 0; // ids stables par workflow
  const warnings = [];
  const flow = blueprint.flow || [];

  // 1) Aplatir la topologie.
  const steps = [];
  const edges = [];
  flattenFlow(flow, null, steps, edges, null);

  // 2) Pré-calculer les noms de nœuds (pour la conversion d'expressions).
  const nodeNameById = new Map();
  const nameCount = new Map();
  for (const mod of steps) {
    let base =
      (mod.metadata && mod.metadata.designer && mod.metadata.designer.name) ||
      (mod.label) ||
      (mod.module ? mod.module.split(':').pop() : 'Node');
    let name = base;
    let n = nameCount.get(base) || 0;
    if (n > 0) name = `${base} ${n + 1}`;
    nameCount.set(base, n + 1);
    nodeNameById.set(mod.id, name);
  }

  const mapExpr = makeExprMapper(nodeNameById);

  // 3) Construire les nœuds n8n.
  const nodes = [];
  const idToNodeName = new Map();
  let col = 0;
  const posOf = (i) => [250 + (i % 6) * 260, 200 + Math.floor(i / 6) * 180];

  steps.forEach((mod, i) => {
    const name = nodeNameById.get(mod.id);
    idToNodeName.set(mod.id, name);
    const def = resolveModule(mod);
    const position = posOf(i);

    if (!def) {
      warnings.push(`Module non mappé : "${mod.module}" (id ${mod.id}) → NoOp à compléter manuellement.`);
      nodes.push({
        parameters: {},
        id: uuid(),
        name: `⚠️ À MAPPER — ${name}`,
        type: 'n8n-nodes-base.noOp',
        typeVersion: 1,
        position,
        notes: `Module Make d'origine : ${mod.module}\nMapper: ${JSON.stringify(mod.mapper || {}, null, 2)}`,
      });
      return;
    }

    let parameters;
    try {
      parameters = def.params(mod, mapExpr) || {};
    } catch (e) {
      warnings.push(`Erreur mapping "${mod.module}" (id ${mod.id}): ${e.message}`);
      parameters = {};
    }

    nodes.push({
      parameters,
      id: uuid(),
      name,
      type: def.type,
      typeVersion: def.typeVersion,
      position,
    });
  });

  // 4) Construire les connexions (+ nœuds IF pour les filtres).
  const connections = {};
  const addConn = (fromName, toName, index = 0) => {
    if (!connections[fromName]) connections[fromName] = { main: [] };
    while (connections[fromName].main.length <= index) connections[fromName].main.push([]);
    connections[fromName].main[index].push({ node: toName, type: 'main', index: 0 });
  };

  let ifCounter = 0;
  for (const edge of edges) {
    const fromName = idToNodeName.get(edge.from);
    const toName = idToNodeName.get(edge.to);
    if (!fromName || !toName) continue;

    const filter = edge.filter || edge.moduleFilter;
    if (filter && filter.conditions) {
      // Insérer un nœud IF entre from et to : from -> IF -(true)-> to
      const ifNode = buildIfNode(filter, mapExpr, [250 + (ifCounter % 6) * 260, 120]);
      ifCounter += 1;
      nodes.push({ ...ifNode, parameters: ifNode.parameters });
      addConn(fromName, ifNode.name, 0);
      addConn(ifNode.name, toName, 0); // sortie "true" (index 0)
    } else {
      addConn(fromName, toName, 0);
    }
  }

  const workflow = {
    name: blueprint.name || 'Scénario Make migré',
    nodes,
    connections,
    active: false,
    settings: { executionOrder: 'v1' },
    tags: [{ name: 'migré-depuis-make' }],
    meta: { migratedFrom: 'make', sourceScenario: blueprint.name || null },
  };

  return { workflow, warnings };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function listJsonFiles(target) {
  const stat = fs.statSync(target);
  if (stat.isDirectory()) {
    return fs
      .readdirSync(target)
      .filter((f) => f.toLowerCase().endsWith('.json'))
      .map((f) => path.join(target, f));
  }
  return [target];
}

function main() {
  const [, , input, outDirArg] = process.argv;
  if (!input) {
    console.error('Usage: node convert.js <fichier|dossier> [dossier-sortie]');
    process.exit(1);
  }
  const outDir = outDirArg || path.join(__dirname, 'output');
  fs.mkdirSync(outDir, { recursive: true });

  const files = listJsonFiles(input);
  if (!files.length) {
    console.error(`Aucun .json trouvé dans ${input}`);
    process.exit(1);
  }

  let ok = 0;
  const allWarnings = [];
  for (const file of files) {
    let blueprint;
    try {
      blueprint = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      console.error(`✗ ${path.basename(file)} : JSON invalide (${e.message})`);
      continue;
    }
    if (!blueprint.flow) {
      console.error(`✗ ${path.basename(file)} : ne ressemble pas à un blueprint Make (pas de champ "flow").`);
      continue;
    }
    const { workflow, warnings } = convertBlueprint(blueprint);
    const base = path.basename(file, '.json').replace(/[^\w.-]+/g, '_');
    const outPath = path.join(outDir, `${base}.n8n.json`);
    fs.writeFileSync(outPath, JSON.stringify(workflow, null, 2));
    ok += 1;
    console.log(`✓ ${path.basename(file)} → ${path.relative(process.cwd(), outPath)} (${workflow.nodes.length} nœuds${warnings.length ? `, ${warnings.length} avertissement(s)` : ''})`);
    warnings.forEach((w) => allWarnings.push(`  [${path.basename(file)}] ${w}`));
  }

  console.log(`\n${ok}/${files.length} scénario(s) converti(s) → ${path.relative(process.cwd(), outDir)}/`);
  if (allWarnings.length) {
    console.log('\nAvertissements (revue manuelle nécessaire) :');
    allWarnings.forEach((w) => console.log(w));
  }
  console.log('\nImport dans n8n : Menu → Import from File → sélectionner le .n8n.json.');
  console.log('Pense à reconfigurer les credentials (Make ne les exporte jamais).');
}

if (require.main === module) main();

module.exports = { convertBlueprint, makeExprMapper };
