# Make → n8n — Convertisseur de scénarios

Outil pour migrer des scénarios **Make** (ex-Integromat) vers des workflows
**n8n** importables. Lit les *blueprints* JSON exportés depuis Make et produit
un `.n8n.json` par scénario.

> Aucune dépendance externe. Node.js ≥ 18.

## 1. Exporter les scénarios depuis Make

Pour chaque scénario dans Make :

1. Ouvrir le scénario.
2. Menu **«...»** (en bas) → **Export Blueprint**.
3. Enregistrer le `.json` dans le dossier `blueprints/`.

> Pour 10-50 scénarios, tu peux tout déposer d'un coup dans `blueprints/` :
> le convertisseur traite le dossier entier.

## 2. Convertir

```bash
# Tout le dossier blueprints/
node convert.js blueprints/

# Un seul fichier, sortie personnalisée
node convert.js blueprints/mon-scenario.json output/
```

Sortie : un fichier `output/<nom>.n8n.json` par scénario, plus un récapitulatif
des **avertissements** (modules non reconnus à compléter à la main).

## 3. Importer dans n8n

Dans n8n : **Menu (⋮) → Import from File** → sélectionner le `.n8n.json`.

> ⚠️ **Credentials** : Make n'exporte jamais les identifiants/tokens. Après
> import, reconfigure les credentials de chaque nœud (HTTP auth, API keys…).

## Ce qui est géré automatiquement

| Make | n8n |
|---|---|
| `gateway:CustomWebHook` | `Webhook` |
| `gateway:CustomWebHookResponse` | `Respond to Webhook` |
| `http:ActionSendData` (URL, méthode, query, headers, body) | `HTTP Request` |
| `builtin:BasicRouter` + filtres de routes | `NoOp` fan-out + nœuds `IF` |
| Filtres inter-modules (`filter.conditions`) | nœuds `IF` |
| `builtin:BasicFeeder` (itérateur) | `Split Out` |
| `builtin:BasicAggregator` | `Aggregate` |
| `util:SetVariable2` / `SetVariables` | `Edit Fields (Set)` |
| `json:ParseJSON` / `CreateJSON` | `Set` |
| `builtin:Sleep` | `Wait` |
| Expressions `{{ 12.champ }}`, `{{ champ }}`, `upper/lower/length/trim`, `now` | `{{ $node["…"].json.champ }}`, `{{ $json.champ }}`, équivalents JS/Luxon |

## Ce qui reste manuel

- **Connecteurs propriétaires** (Google Sheets, Slack, Airtable, etc.) : ils
  deviennent un nœud `NoOp` nommé `⚠️ À MAPPER — …`, avec le module Make
  d'origine et son `mapper` conservés dans les **notes** du nœud. Il suffit de
  remplacer chaque NoOp par le nœud n8n équivalent (n8n a des nœuds natifs pour
  la plupart de ces services).
- **Credentials / authentification** (voir plus haut).
- **Expressions complexes** (fonctions Make imbriquées peu courantes) : à
  vérifier au cas par cas — le reste passe.

## Étendre les mappings

Tout se passe dans [`module-map.js`](./module-map.js). Pour ajouter un module :

```js
'google-email:ActionSendEmail': {
  type: 'n8n-nodes-base.gmail',
  typeVersion: 2,
  params: (m, mapExpr) => ({
    sendTo: mapExpr(m.mapper.to),
    subject: mapExpr(m.mapper.subject),
    message: mapExpr(m.mapper.html),
  }),
},
```

La clé est l'identifiant `module` du blueprint Make. Le convertisseur matche
l'identifiant exact puis, à défaut, par préfixe (`google-email:` → n'importe
quel module Gmail). **Envoie-moi 1-2 de tes vrais blueprints** et j'ajoute les
mappings de tes connecteurs spécifiques.

## Structure

```
make-to-n8n/
├── convert.js        Convertisseur (CLI + logique de topologie/expressions)
├── module-map.js     Table de correspondance modules Make → nœuds n8n
├── blueprints/       ← déposer ici les blueprints Make exportés (.json)
│   └── exemple-webhook-http.json   Exemple de démonstration
└── output/           ← workflows n8n générés (.n8n.json)
```

## Limites connues

- La reconstruction de la **topologie des routeurs** suppose la structure
  standard de Make (`routes[].flow[]`). Les scénarios avec boucles/erreurs
  personnalisées (error handlers) demandent une revue.
- Les **positions** des nœuds sont générées automatiquement (grille) — la mise
  en page dans n8n sera à réorganiser visuellement si besoin.
- Toujours **tester chaque workflow** dans n8n avant de le passer en `active`.
