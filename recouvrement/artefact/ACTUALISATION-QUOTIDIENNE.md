# Actualisation quotidienne du Suivi Recouvrement

Cette procédure est exécutée chaque matin par une tâche programmée, dans une
session neuve qui ne sait rien de la veille. Elle est écrite pour être suivie
sans rien deviner.

**But** : à 10 h, l'artefact s'ouvre déjà rempli des créances de Monday,
avec la date et l'heure de l'arrêté affichées.

**Artefact à republier** : https://claude.ai/artifact/WPXvahZu9uV1oiaZ4QUVuC
Toujours republier **cette adresse**. Une publication sans `url` crée un
second artefact et Zehavit perd son lien.

---

## Les neuf tableaux, et eux seuls

Le classement vient de Zehavit, confirmé sur son arborescence Monday du
25/10/2026. Le numéro du tableau fait foi : série 1 = Corporate, série 2 =
B2C, rang 9 = technique et donc écarté.

| Tableau | id Monday | lignes au 25/10 |
|---|---|---:|
| 0.1. ALL - Factures payées | 1842356810 | 7 249 |
| 1.0. Entreprise - Tampon | 1818713092 | 893 |
| 1.1. Entreprise - ADV | 1817877566 | 3 703 |
| 1.2. Entreprise - Recouvrement | 1840539926 | 3 710 |
| 1.3. Entreprise - OPCO | 5099882263 | 200 |
| 2.1. Financement Personnel | 1909949610 | 775 |
| 2.2. Financement CPF | 1912012437 | 1 209 |
| 2.3. Financement pôle emploi : AIF / POEI | 1912012068 | 528 |
| 2.4. Financement complexe | 1912012597 | 361 |

**À ne jamais inclure** : les tableaux `1.9.` et `2.9.` (techniques),
`2.5. Recouvrement B2C` (lignes d'essai, écarté nommément dans `js/rules.js`),
`DST_Germany_Planning` (planning de présence d'équipe), et tout tableau hors
des dossiers « 1. Corporate » et « 2. B2C ».

Les comptes de lignes ci-dessus datent du 25/10 : ils bougent. Ce qui ne bouge
pas, c'est qu'il faut **lire le compte annoncé par Monday le jour même**
(`items_count`) et vérifier que le nombre de lignes écrites lui est égal.
Un écart n'est pas une approximation acceptable : c'est un export tronqué,
et il vaut mieux ne rien republier que republier une balance fausse.

---

## 1. Sortir les données

Outil : `mcp__monday_com__execute_code` (bac à sable authentifié, **lecture
seule** — aucune écriture dans Monday, jamais).

Deux limites à respecter, mesurées le 25/10/2026 :

- **La coupure est à 60 s** côté connecteur, et le bac à sable se tue à
  `timeout_sec`. Viser **40 s de travail utile** par appel.
- **Le coût vient du nombre de colonnes.** Une page de 500 lignes prend
  ~2,2 s avec 2 colonnes et ~3,7 s avec 19. Donc : ne demander que les
  colonnes exploitables, et ne **jamais** redemander `column { title }` ligne
  par ligne — lire les titres une fois via `boards { columns { id title } }`.

Budget constaté : les six petits tableaux (3 966 lignes) sortent en **36 s**
dans un seul appel. Les trois gros — ADV, Recouvrement, Factures payées —
demandent un appel chacun, voire deux pour les 7 249 lignes des payées.

**Le curseur de pagination survit d'un appel à l'autre** (vérifié). Un
tableau inachevé renvoie donc son curseur, et l'appel suivant reprend où il
s'est arrêté : passer les curseurs restants en entrée du tour suivant.

### Quelles colonnes

Les colonnes retenues sont celles que l'application sait lire. Pour les
retrouver sans les deviner, lire les colonnes des neuf tableaux, puis les
apparier avec **le code de l'application lui-même** :

```js
// charge rules.js puis ingest.js dans un contexte vm avec { window: {} }
const mapping = window.LioraIngest.autoMapColumns(colonnes, null);
// -> { champ: idDeColonne } ; les valeurs sont les colonnes à exporter
```

`autoMapColumns` renvoie l'appariement **directement**, pas enveloppé dans un
objet `{ mapping }`. Au 25/10, les neuf tableaux reconnaissaient tous les cinq
champs essentiels : `numero`, `client`, `montant`, `dateFacture`,
`dateEcheanceSource`. Si l'un venait à manquer, **ne pas republier** : le
tableau a changé de colonnes et la balance serait fausse.

Deux colonnes à ne jamais exporter :

- `name` — ce n'est pas une colonne mais le pseudo-champ vide de Monday. Il
  porte le même alias que « Nom » et **écraserait le numéro de facture**.
- tout ce qui ressemble à `mot de passe` ou `identifiant OPCO` — le tableau
  OPCO stocke des accès de portail en clair, qui n'ont rien à faire dans un
  export.

### Forme du fichier

Un CSV par tableau, **nommé comme le tableau** (le rôle se déduit du nom du
fichier), encodé en UTF-8 avec BOM, séparateur virgule :

```
Groupe,Nom,<titre colonne 1>,<titre colonne 2>,…
```

### Trois pièges, payés comptant

**1. Le format doit être celui d'un export Monday, pas un CSV plat.**
L'application a été écrite pour la forme hiérarchique que Monday produit, et
elle en tire deux choses distinctes : le **titre du groupe** où la facture est
rangée, et la colonne **« Groupe »** du tableau, qui porte l'origine. Sur
« 0.1. ALL - Factures payées » les deux existent et ne disent pas la même
chose. Un CSV plat avec une colonne « Groupe » ajoutée les confond, et des
factures payées passent pour des factures en tampon. La forme attendue :

```
<titre du tableau>              <- une seule cellule remplie
<titre du groupe>               <- une seule cellule remplie
Name,<colonnes du tableau>      <- l'en-tête, après le premier groupe
<lignes du groupe>
<titre du groupe suivant>
<lignes>
```

Aucune ligne de données ne doit avoir une seule cellule remplie : elle passerait
pour un titre de groupe et effacerait le groupe courant.

**2. Le nom du fichier doit être en ASCII.** Un nom accentué —
« Factures payées.csv », « pôle emploi » — est **silencieusement perdu** au
dépôt : le fichier n'arrive jamais à l'import, sans erreur ni message. Sept
tableaux sur neuf passaient, et les deux manquants — dont les 7 249 factures
payées — ne laissaient aucune trace. Le classement n'en souffre pas : le rôle
se déduit du **titre du tableau écrit dans le fichier**, pas du nom du fichier.

**3. Les colonnes miroir et formule n'ont pas de `text`.** Il faut demander
`display_value`, et retomber sur `text` puis sur la valeur brute analysée — la
cascade exacte de `columnValue()` dans `js/monday.js`. Sans cela « 1.1. ADV »
et « 1.2. Recouvrement », qui ne sont presque que des miroirs, ressortent
entièrement vides.

`Groupe` porte le titre du groupe Monday : il est indispensable. C'est lui qui
permet d'écarter les groupes techniques **à l'intérieur** d'un tableau retenu
— au 25/10, 874 lignes du seul Tampon, dont 667 déjà parties vers ADV ou
Recouvrement, qui seraient comptées deux fois sans lui.

---

## 2. Déposer les fichiers

Les récupérer par leurs liens de téléchargement (valables 5 minutes) et les
écrire dans `recouvrement/artefact/donnees-du-jour/`, avec un manifeste :

```json
{
  "arreteLe": "2026-10-25",
  "arreteA": "10h00",
  "source": "Monday — connecteur monday.com",
  "fichiers": ["0.1. ALL - Factures payées.csv", "…"]
}
```

`arreteLe` est au format `AAAA-MM-JJ` : la page la pose dans son filtre
« Arrêté au », et tout le calcul du retard en dépend.

Ce dossier est écarté par `.gitignore`. **Ces fichiers ne vont jamais au
dépôt** : ils portent le portefeuille réel, leur place est dans l'artefact
privé, pas dans l'historique Git.

---

## 3. Reconstruire et republier

```bash
node recouvrement/artefact/construire.js   # copie donnees-du-jour/ en donnees/
node recouvrement/artefact/essayer.js      # doit finir sans aucun échec
```

`construire.js` **s'arrête** si le manifeste annonce un fichier absent : une
page qui s'ouvre sur un portefeuille incomplet sans le dire serait pire
qu'une page vide.

Puis republier `recouvrement/artefact/paquet/index.html` à l'adresse ci-dessus,
avec `root` sur `paquet/` et, dans `files`, **les fichiers de `donnees/`**
listés par `A-PUBLIER.txt` en plus des modules habituels.

---

## 4. Ce qu'il faut dire, et à qui

Ne rien écrire à Zehavit quand tout s'est bien passé : une actualisation qui
réussit n'a pas à se faire remarquer. Lui écrire, en revanche, si :

- un tableau sort avec moins de lignes que Monday n'en annonce ;
- un champ essentiel n'est plus reconnu sur un tableau ;
- un tableau a disparu, ou un tableau numéroté inconnu est apparu ;
- la republication a échoué.

Dans ces cas, **ne pas republier une balance partielle** : mieux vaut que la
page garde les chiffres de la veille, qui sont justes et datés, qu'un arrêté
du jour amputé d'un tableau.

---

## 5. La relecture incrémentale — règles validées par Zehavit le 25/10/2026

Sur 18 628 lignes, **55 changent en vingt-quatre heures** (0,3 %), et le relevé
de ce qui a bougé prend 15 secondes contre plus de trois minutes pour l'export
entier. Mesuré, pas supposé. La relecture complète quotidienne est donc deux
cents fois le travail nécessaire.

Le filtre : colonne virtuelle `__last_updated__`, opérateur `within_the_last`,
`compare_value: ["DAYS", N]`. L'opérateur `greater_than` est refusé sur cette
colonne — `no_operator_config`.

**Mais une mise à jour incrémentale ment facilement**, et une balance qui ment
sans le dire est pire qu'une balance lente. Trois protections, non
négociables :

1. **Les suppressions ne se voient pas.** Une facture effacée dans Monday ne
   « change » pas, elle disparaît, et aucun filtre sur la date de modification
   ne la rattrapera. Chaque matin, comparer le nombre de lignes annoncé par
   Monday (`items_count`) à celui détenu, tableau par tableau. **Au moindre
   écart, ce tableau est relu en entier**, sans discussion.
2. **Récupérer les modifiées SANS filtrer les groupes.** Une facture déplacée
   vers « Technique - Archive » a bien changé, mais un export qui écarte les
   groupes techniques à la source ne la verrait plus : elle resterait dans la
   copie pour toujours. On prend tout ce qui a bougé, et l'on décide ensuite,
   ligne par ligne, de garder ou de retirer.
3. **Relecture complète chaque lundi**, quoi qu'il arrive. Le filet contre ce
   que les deux premières n'attrapent pas : une colonne renommée, un groupe
   créé, une dérive silencieuse.

La base de départ se reprend depuis l'artefact publié (`Artifact` action `read`
avec le `path` de chaque fichier de `donnees/`) : c'est lui qui porte l'état de
la veille, daté.

À construire une fois que la tâche tourne avec son connecteur et son dépôt :
bâtir l'incrémental sur une chaîne qui ne démarre pas serait bâtir sur du vide.
