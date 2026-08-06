# Liora Cash Flow Analyzer

Application web d'analyse de flux de trésorerie pour Liora. Importez une
extraction bancaire ou comptable (CSV / Excel) et obtenez automatiquement un
tableau de bord complet : KPIs, graphiques, catégorisation, projections et
simulations.

> Version applicative : **6.2.1h** — voir l'en-tête de `app.js`.

> 📊 **Tableau de bord Recouvrement (Power BI)** — kit de connexion
> Pennylane · Sellsy · Monday avec rafraîchissement quotidien automatique :
> voir [`powerbi/`](powerbi/README.md).

## Aperçu des fonctionnalités

| Onglet | Rôle |
|---|---|
| **Tableau de bord** | KPIs (encaissements / décaissements, volatilité), évolution des flux, solde cumulé, treemaps par catégorie, répartition par financeur / mode de paiement / équipe, table détaillée filtrable, synthèse analytique |
| **Data Quality** | Reclassement des transactions « DIVERS » (décaissements) et « Autres revenus » (encaissements), **suggestions par IA (API Claude)**, mémorisation des règles apprises |
| **Projection** | Prévision de trésorerie à 3 mois — modèle saisonnier ou moyennes mobiles pondérées |
| **Simulation** | Scénarios de trésorerie ajustables à partir des moyennes historiques |
| **Fichiers** | Import, historique des fichiers, état du stockage, récapitulatif des règles, configuration de la clé API |

## Stack technique

- **HTML + CSS + JavaScript pur** (vanilla), sans framework ni build.
- Librairies chargées via CDN :
  - [Chart.js](https://www.chartjs.org/) 4.4.1 + plugin `chartjs-chart-treemap` (graphiques)
  - [PapaParse](https://www.papaparse.com/) 5.4.1 (lecture CSV)
  - [SheetJS / xlsx](https://sheetjs.com/) 0.18.5 (lecture Excel)
  - Police Inter (Google Fonts)
- **Persistance locale** via **IndexedDB** (base `liora_cashflow`). Les données
  et les règles apprises restent dans le navigateur ; rien n'est envoyé sur un
  serveur, **hormis** les appels à l'API Claude si une clé API est renseignée
  (onglet Fichiers → Data Quality).

## Lancer l'application

Aucune compilation, aucun serveur nécessaire.

1. Ouvrir `index.html` dans un navigateur moderne (double-clic, ou glisser le
   fichier dans le navigateur).
2. Une connexion Internet est requise au premier chargement pour récupérer les
   librairies CDN.
3. Importer un fichier `.csv`, `.xlsx` ou `.xls` via la zone d'upload.

> Astuce : les données des mois précédents sont conservées automatiquement
> (IndexedDB). Pour repartir de zéro, utiliser « Tout effacer » dans l'onglet
> **Fichiers**.

## Structure du dépôt

```
index.html                   Structure de l'application (écrans + onglets)
app.js                       Logique applicative (≈ 3 750 lignes)
styles.css                   Styles (thème sombre « navy »)
regles_categorisation.csv    Référence des 774 règles de catégorisation (export documentaire)
Liora_Logo_Orange_alpha.png  Logo
extract-rules.html           Outil annexe : exporter les règles apprises depuis IndexedDB
```

### À propos de `regles_categorisation.csv`

Ce fichier est un **document de référence** : il liste les règles de
catégorisation (mot-clé → catégorie). Il **n'est pas lu au runtime** — les
règles intégrées sont codées dans les dictionnaires de mots-clés de `app.js`
(section « Keyword dictionaries »). Les règles *apprises* via l'onglet Data
Quality sont, elles, stockées dans IndexedDB.

## Catégorisation

Deux niveaux :

1. **Règles intégrées** — dictionnaires de mots-clés dans `app.js`, appliqués
   séparément aux encaissements (`categoriseEnc`) et décaissements
   (`categoriseDec`).
2. **Règles apprises** — déduites des reclassements manuels dans Data Quality et
   mémorisées dans IndexedDB, avec possibilité d'affiner le mot-clé reconnu.

L'onglet **Fichiers** propose un récapitulatif des deux jeux de règles.

## Confidentialité des données

Les extractions importées restent **locales au navigateur** (IndexedDB). La
seule sortie réseau applicative est l'appel à l'API Claude pour les suggestions
de catégorisation, uniquement si une clé API est configurée.
