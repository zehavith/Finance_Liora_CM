'use strict';

/**
 * Table de correspondance des modules Make → nœuds n8n.
 *
 * Clé   : identifiant du module Make (champ `module` du blueprint).
 *         On matche d'abord l'identifiant exact, puis par préfixe avant le ":".
 * Valeur: { type, typeVersion, params(mod) }
 *   - type        : type de nœud n8n (ex. "n8n-nodes-base.httpRequest")
 *   - typeVersion : version du nœud n8n
 *   - params      : fonction (module Make) -> parameters n8n
 *
 * `mapExpr` (injecté à l'exécution) convertit les expressions Make {{...}}
 * en expressions n8n. On le passe aux `params()` via `this`.
 *
 * Tout module absent de cette table devient un NoOp annoté "À MAPPER".
 */

/** Convertit récursivement toutes les chaînes d'un objet via mapExpr. */
function deepMapExpr(value, mapExpr) {
  if (typeof value === 'string') return mapExpr(value);
  if (Array.isArray(value)) return value.map((v) => deepMapExpr(v, mapExpr));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = deepMapExpr(v, mapExpr);
    return out;
  }
  return value;
}

const MODULE_MAP = {
  // ---- Déclencheurs / Webhooks --------------------------------------------
  'gateway:CustomWebHook': {
    type: 'n8n-nodes-base.webhook',
    typeVersion: 2,
    params: (m, mapExpr) => ({
      httpMethod: 'POST',
      path: (m.parameters && m.parameters.hook && String(m.parameters.hook)) || 'make-migrated',
      responseMode: 'onReceived',
      options: {},
    }),
  },
  'gateway:CustomWebHookResponse': {
    type: 'n8n-nodes-base.respondToWebhook',
    typeVersion: 1,
    params: (m, mapExpr) => ({
      respondWith: 'json',
      responseBody: deepMapExpr((m.mapper && m.mapper.body) || '={{ $json }}', mapExpr),
    }),
  },

  // ---- HTTP ----------------------------------------------------------------
  'http:ActionSendData': {
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: 4,
    params: (m, mapExpr) => {
      const map = m.mapper || {};
      const params = {
        url: mapExpr(map.url || ''),
        method: (map.method || 'GET').toUpperCase(),
        options: {},
      };
      if (Array.isArray(map.qs) && map.qs.length) {
        params.sendQuery = true;
        params.queryParameters = {
          parameters: map.qs.map((q) => ({ name: mapExpr(q.name), value: mapExpr(q.value) })),
        };
      }
      if (Array.isArray(map.headers) && map.headers.length) {
        params.sendHeaders = true;
        params.headerParameters = {
          parameters: map.headers.map((h) => ({ name: mapExpr(h.name), value: mapExpr(h.value) })),
        };
      }
      if (map.data || (Array.isArray(map.bodyValues) && map.bodyValues.length)) {
        params.sendBody = true;
        if (map.data) {
          params.contentType = 'raw';
          params.body = mapExpr(map.data);
        } else {
          params.contentType = 'json';
          params.specifyBody = 'keypair';
          params.bodyParameters = {
            parameters: map.bodyValues.map((b) => ({ name: mapExpr(b.key), value: mapExpr(b.value) })),
          };
        }
      }
      return params;
    },
  },

  // ---- Routeur -------------------------------------------------------------
  // Un routeur Make = branchement multi-sorties. En n8n on le rend par un
  // nœud NoOp qui fanne vers chaque route (les filtres de route deviennent
  // des nœuds IF, gérés dans le convertisseur principal).
  'builtin:BasicRouter': {
    type: 'n8n-nodes-base.noOp',
    typeVersion: 1,
    params: () => ({}),
    isRouter: true,
  },

  // ---- Itérateur / Aggregator ---------------------------------------------
  'builtin:BasicFeeder': {
    type: 'n8n-nodes-base.splitOut',
    typeVersion: 1,
    params: (m, mapExpr) => ({
      fieldToSplitOut: mapExpr((m.mapper && m.mapper.array) || 'data'),
      options: {},
    }),
  },
  'builtin:BasicAggregator': {
    type: 'n8n-nodes-base.aggregate',
    typeVersion: 1,
    params: () => ({ aggregate: 'aggregateAllItemData', options: {} }),
  },

  // ---- Set / Tools / Variables --------------------------------------------
  'util:SetVariable2': {
    type: 'n8n-nodes-base.set',
    typeVersion: 3,
    params: (m, mapExpr) => {
      const map = m.mapper || {};
      return {
        mode: 'manual',
        assignments: {
          assignments: [
            {
              id: String(map.name || 'var'),
              name: String(map.name || 'var'),
              type: 'string',
              value: mapExpr(map.value != null ? map.value : ''),
            },
          ],
        },
        options: {},
      };
    },
  },
  'util:SetVariables': {
    type: 'n8n-nodes-base.set',
    typeVersion: 3,
    params: (m, mapExpr) => {
      const vars = (m.mapper && m.mapper.variables) || [];
      return {
        mode: 'manual',
        assignments: {
          assignments: vars.map((v) => ({
            id: String(v.name),
            name: String(v.name),
            type: 'string',
            value: mapExpr(v.value != null ? v.value : ''),
          })),
        },
        options: {},
      };
    },
  },

  // ---- JSON ----------------------------------------------------------------
  'json:ParseJSON': {
    type: 'n8n-nodes-base.set',
    typeVersion: 3,
    params: (m, mapExpr) => ({
      mode: 'manual',
      assignments: {
        assignments: [
          {
            id: 'parsed',
            name: 'parsed',
            type: 'object',
            value: mapExpr((m.mapper && m.mapper.json) || '={{ $json }}'),
          },
        ],
      },
      options: {},
    }),
  },
  'json:CreateJSON': {
    type: 'n8n-nodes-base.set',
    typeVersion: 3,
    params: () => ({ mode: 'manual', assignments: { assignments: [] }, options: {} }),
  },

  // ---- Délai ---------------------------------------------------------------
  'builtin:Sleep': {
    type: 'n8n-nodes-base.wait',
    typeVersion: 1,
    params: (m, mapExpr) => ({
      amount: Number((m.mapper && m.mapper.delay) || 1),
      unit: 'seconds',
    }),
  },
};

module.exports = { MODULE_MAP, deepMapExpr };
