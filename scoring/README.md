# Liora Scoring Entreprises

Application web de **scoring du risque de solvabilité** des entreprises françaises,
construite à partir des données publiques officielles (info.gouv) — **gratuites,
sans clé d'API ni inscription**.

> Application **autonome** : elle ne partage ni code, ni base de données, ni
> configuration avec le Cash Flow Analyzer situé à la racine du dépôt. Elle vit
> entièrement dans le dossier `scoring/`.

---

## Lancer l'application

Aucune compilation, aucun serveur, aucune dépendance à installer.

1. Ouvrir `scoring/index.html` dans un navigateur moderne (double-clic).
2. Saisir un nom d'entreprise, un SIREN (9 chiffres) ou un SIRET (14 chiffres).

L'application appelle des API publiques : **une connexion Internet est nécessaire**
pour interroger une entreprise pour la première fois. Les fiches déjà consultées
sont conservées en cache local (IndexedDB) et restent lisibles hors ligne, tout
comme le portefeuille suivi.

---

## Fonctionnalités

| Onglet | Rôle |
|---|---|
| **Recherche** | Recherche par nom, SIREN ou SIRET, avec filtres département / secteur / état. Fiche détaillée : score, jauge, points de vigilance, détail des six piliers, comptes annuels, procédures collectives, dirigeants. |
| **Portefeuille** | Entreprises suivies, avec score moyen, répartition par grade, tri, filtre par grade, rafraîchissement de masse et export CSV. |
| **Import en masse** | Collage ou dépôt d'un fichier CSV/TXT de SIREN : scoring séquentiel avec barre de progression, ajout automatique au portefeuille, export des résultats. |
| **Réglages** | Pondération des six piliers (curseurs), gestion du cache, sauvegarde / restauration JSON, méthodologie complète. |

---

## Sources de données

| Source | Usage | Accès |
|---|---|---|
| [API Recherche d'Entreprises](https://recherche-entreprises.api.gouv.fr) (DINUM) | Répertoire SIRENE, comptes annuels déposés, dirigeants, labels | Gratuit, sans clé, licence ouverte |
| [BODACC — annonces commerciales](https://bodacc-datadila.opendatasoft.com) (DILA) | Procédures collectives (sauvegarde, redressement, liquidation) | Gratuit, sans clé |

Aucune donnée n'est envoyée à un serveur tiers : les seules requêtes sortantes
sont les lectures de ces deux API publiques. Le portefeuille, les pondérations
et le cache restent dans le navigateur (IndexedDB, base `liora_scoring`).

Si le BODACC est injoignable, le scoring se poursuit sans lui et l'interface
signale explicitement que le contrôle des procédures collectives n'a pas abouti —
l'absence de procédure affichée ne vaut alors pas confirmation.

---

## Modèle de score

Score de **0 à 100** : plus il est élevé, plus le risque d'impayé est faible.

### Les six piliers

| Pilier | Poids par défaut | Ce qu'il mesure |
|---|---:|---|
| Pérennité | 20 | Ancienneté de l'entreprise (les défaillances se concentrent sur les 3 premières années) |
| Taille & structure | 15 | Tranche d'effectif, catégorie INSEE, établissements ouverts / fermés |
| Santé financière | 30 | Marge nette, tendance du CA, exercices déficitaires, fraîcheur des comptes |
| Transparence | 15 | Publication des comptes, convention collective, dirigeants identifiés, labels, diffusion publique |
| Forme juridique | 10 | Protection du patrimoine et obligations comptables selon la catégorie juridique |
| Secteur d'activité | 10 | Sinistralité observée par section NAF |

Les poids sont modifiables dans l'onglet **Réglages** et **renormalisés
automatiquement** : leur somme n'a pas besoin de valoir 100. Toute modification
rescore l'intégralité du portefeuille.

### Règles éliminatoires

Certaines situations **plafonnent** le score quelle que soit la moyenne pondérée :

| Situation | Plafond |
|---|---:|
| Entreprise cessée au répertoire SIRENE | 5 |
| Liquidation judiciaire | 5 |
| Clôture pour insuffisance d'actif | 8 |
| État de cessation des paiements | 15 |
| Redressement judiciaire | 20 |
| Procédure de sauvegarde | 35 |
| Plan de redressement arrêté | 42 |
| Plan de sauvegarde arrêté | 50 |
| Sortie de procédure de moins de 3 ans | 62 |

Seule l'annonce BODACC **la plus récente** est retenue : un plan de redressement
arrêté après une ouverture de procédure traduit un redressement en cours, pas un
cumul de sanctions.

### Grades

| Grade | Score | Niveau de risque |
|---|---|---|
| **A** | 80 – 100 | Très faible |
| **B** | 65 – 79 | Faible |
| **C** | 50 – 64 | Modéré |
| **D** | 35 – 49 | Élevé |
| **E** | 0 – 34 | Très élevé |

### Indice de confiance

Part des piliers réellement documentés par les données publiques. Une entreprise
qui ne dépose pas ses comptes obtient un score de confiance faible : le score
repose alors sur des valeurs neutres par défaut et doit être interprété avec
prudence.

### Plafond d'encours indicatif

Un mois de chiffre d'affaires pondéré par le grade (A : 100 %, B : 60 %,
C : 30 %, D : 10 %, E : 0 %). **Purement indicatif** — il n'est calculé que si le
chiffre d'affaires est publié, et ne remplace pas une décision de crédit.

---

## Structure des fichiers

```
scoring/
├── index.html            Structure de l'application (4 onglets)
├── app.js                Interface : recherche, fiche, portefeuille, import, réglages
├── scoring.js            Moteur de score — module pur, sans DOM ni réseau
├── api.js                Couche données — API publiques, normalisation, cache IndexedDB
├── styles.css            Design system « Dark Navy »
├── assets/               Logo et police Inter (aucun CDN)
└── test/
    └── test-scoring.js   Tests du moteur et de la normalisation
```

`scoring.js` et `api.js` sont volontairement dépourvus de dépendance au DOM :
ils s'exécutent aussi bien dans le navigateur (`window.LioraScoring`,
`window.LioraApi`) que sous Node, ce qui rend le moteur testable.

## Tests

```bash
node scoring/test/test-scoring.js
```

32 tests couvrent les cas nominaux, les règles éliminatoires, la détection des
signaux financiers, la renormalisation des pondérations, la normalisation des
réponses de l'API et la validation des SIREN (clé de Luhn).

---

## Limites connues

- **Délai de publication.** Les données publiques ont un temps de latence : une
  procédure collective très récente peut ne pas encore figurer au BODACC, et les
  comptes du dernier exercice ne sont pas toujours déposés.
- **Comptes confidentiels.** De nombreuses PME demandent légalement la
  confidentialité de leurs comptes. Leur pilier financier repose alors sur une
  valeur neutre, ce que l'indice de confiance signale.
- **Débit des API.** Les API publiques limitent le nombre de requêtes par minute.
  L'import en masse espace donc ses appels d'environ 220 ms ; une liste de plusieurs
  centaines de SIREN prend quelques minutes.
- **Ce n'est pas une notation réglementée.** Le score est un outil d'aide à la
  décision construit sur des données ouvertes. Il ne constitue ni une notation
  financière au sens réglementaire, ni une garantie de solvabilité.
