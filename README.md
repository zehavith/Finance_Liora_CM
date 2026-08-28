# Liora Cash Flow Analyzer

Application web d'analyse de flux de trésorerie pour Liora. Importez une
extraction bancaire ou comptable (CSV / Excel) et obtenez automatiquement un
tableau de bord complet : KPIs, graphiques, catégorisation, projections et
simulations.

> Version applicative : **6.2.1h** — voir l'en-tête de `app.js`.

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
- Librairies **intégrées en local** (dossier `vendor/`) — l'app fonctionne
  hors-ligne, sans dépendre d'un CDN :
  - [Chart.js](https://www.chartjs.org/) 4.4.1 + plugin `chartjs-chart-treemap` 2.3.0 (graphiques)
  - [PapaParse](https://www.papaparse.com/) 5.4.1 (lecture CSV)
  - [SheetJS / xlsx](https://sheetjs.com/) 0.18.5 (lecture Excel)
- Police Inter (Google Fonts) — seule ressource encore chargée depuis Internet ;
  en cas d'absence de connexion, une police système prend le relais.
- **Persistance locale** via **IndexedDB** (base `liora_cashflow`). Les données
  et les règles apprises restent dans le navigateur ; rien n'est envoyé sur un
  serveur, **hormis** les appels à l'API Claude si une clé API est renseignée
  (onglet Fichiers → Data Quality).

## Lancer l'application

Aucune compilation, aucun serveur nécessaire.

1. Extraire l'ensemble des fichiers dans un même dossier (ne pas ouvrir
   `index.html` depuis l'intérieur d'une archive `.zip` : les fichiers voisins
   ne seraient pas chargés).
2. Ouvrir `index.html` dans un navigateur moderne (double-clic, ou glisser le
   fichier dans le navigateur).
3. L'app fonctionne **sans connexion Internet** (librairies locales). Seule la
   police Inter se charge en ligne, avec repli automatique sur une police
   système si nécessaire.
4. Importer un fichier `.csv`, `.xlsx` ou `.xls` via la zone d'upload.

> Astuce : les données des mois précédents sont conservées automatiquement
> (IndexedDB). Pour repartir de zéro, utiliser « Tout effacer » dans l'onglet
> **Fichiers**.

## Application soeur : Suivi Recouvrement

Le dossier [`recouvrement/`](recouvrement/README.md) contient une seconde
application, **Suivi Recouvrement**, qui partage le même design system et les
mêmes librairies (`vendor/`). Elle s'alimente sur les tableaux Monday.com,
calcule les dates d'échéance selon les règles de financement Liora et suit les
factures en retard : taux de recouvrement par mois et par type de financement
(en nombre et en euros), retard moyen, balance âgée.

## Structure du dépôt

```
index.html                   Structure de l'application (écrans + onglets)
app.js                       Logique applicative (≈ 3 750 lignes)
styles.css                   Styles (thème sombre « navy »)
vendor/                      Librairies tierces intégrées en local (Chart.js, PapaParse, xlsx, treemap)
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
