# Tableau de bord Recouvrement — Power BI (Pennylane · Sellsy · Monday)

Kit clé en main pour connecter **Pennylane**, **Sellsy** et **Monday** à
**Power BI** et obtenir un suivi de recouvrement clair, **rafraîchi
automatiquement chaque jour**.

## Les trois sources de référence

Le modèle ne s'appuie que sur **ces trois API** — aucun fichier Excel ni
Google Sheets n'entre dans le rapport.

| Source | Rôle | Apport au dashboard |
|--------|------|---------------------|
| **Monday** | Suivi des factures / relances | Statut, relances, dates, type de client, règles d'échéance |
| **Sellsy** | Référentiel des factures **émises** (+ avoirs) | Détecte les **factures manquantes sur Monday** |
| **Pennylane** | **Vérité paiement** | Reste dû, payé/impayé → encours & retard |

Réconciliation **par n° de facture**, table consolidée unique `Factures`.

> 📊 **Maquette visuelle** du rendu final, construite sur vos données réelles :
> voir le lien d'aperçu partagé en conversation.

## 🚦 Par où commencer

Le déploiement se fait en **2 phases** :

| Phase | Contenu | Durée | Guide |
|---|---|---|---|
| **Phase 1** ⬅️ *commencez ici* | Suivi recouvrement (KPI, DSO, à jour / en recouvrement, factures manquantes sur Monday) + refresh auto | 2 h 30 – 3 h | **[`PHASE1_demarrage.md`](PHASE1_demarrage.md)** |
| **Phase 2** | Balance âgée complète : avoirs Sellsy + page matrice détaillée | ~45 min | fin de `PHASE1_demarrage.md` |

## Contenu du kit

```
powerbi/
├── README.md                          ← vous êtes ici (vue d'ensemble + maquette)
├── PHASE1_demarrage.md                ⬅️ CHECKLIST DE DÉMARRAGE (commencez ici)
├── connecteurs/
│   ├── sellsy_factures.pq             Factures émises (référentiel)         → Sellsy_Factures
│   ├── pennylane_factures.pq          Paiement (reste dû, échéance)         → Pennylane_Paiements
│   ├── monday_relances.pq             Suivi / relances (1 tableau)          → Monday_Suivi
│   ├── monday_multi_boards.pq         ⭐ Plusieurs tableaux + règle d'échéance → Monday_Suivi
│   ├── calendrier.pq                  Table de dates                        → Calendrier (chargée)
│   ├── factures_consolidees_phase1.pq Fusion simplifiée — PHASE 1           → Factures (chargée)
│   ├── factures_consolidees.pq        Fusion complète — PHASE 2             → Factures (chargée)
│   └── sellsy_avoirs.pq               Avoirs (phase 2)                      → Sellsy_Avoirs
├── modele/
│   └── modele_donnees.md              Schéma, relations, clés de liaison
├── mesures_dax.md                     Toutes les mesures (recouvrement, DSO, KPI…)
└── rafraichissement_service.md        Rafraîchissement auto quotidien (service Power BI)
```

## Pas-à-pas (≈ 45 min)

### 1. Créer les paramètres
Power BI Desktop → *Accueil > Gérer les paramètres > Nouveau*. Créez :
`pPennylaneApiKey`, `pSellsyClientId`, `pSellsyClientSecret`, `pMondayToken`,
`pMondayBoardId` (texte) et `pAnneeDebut` (nombre). Détails et où trouver les
clés → [`rafraichissement_service.md`](rafraichissement_service.md).

### 2. Créer les requêtes
*Accueil > Transformer les données > Nouvelle source > Requête vide >
Éditeur avancé*. Collez chaque fichier `.pq` et **nommez la requête** comme
indiqué (colonne de droite du tableau ci-dessus). Ordre :
`Sellsy_Factures` → `Pennylane_Paiements` → `Monday_Suivi` → `Calendrier` →
`Factures` (en dernier, car elle fusionne les 3 premières).

### 3. Désactiver le chargement du staging
Sur `Sellsy_Factures`, `Pennylane_Paiements`, `Monday_Suivi` : clic droit →
décocher **« Activer le chargement »**. Seules `Factures` et `Calendrier` sont
chargées. *Fermer et appliquer*.

### 4. Adapter Monday à VOTRE tableau
Dans `monday_relances.pq`, bloc `ColonnesVoulues` : remplacez les titres par
ceux **exacts** de votre tableau (ex. « N° facture », « Statut relance »…).
Idéalement, ajoutez une colonne **« N° facture »** sur Monday pour un
rapprochement fiable.

### 5. Modèle & relations
Créez la relation `Calendrier[Date] → Factures[date_echeance]` et marquez
`Calendrier` comme table de dates → [`modele/modele_donnees.md`](modele/modele_donnees.md).

### 6. Mesures
Créez une table `_Mesures` puis collez les mesures →
[`mesures_dax.md`](mesures_dax.md).

### 7. Rafraîchissement automatique quotidien
Publiez, renseignez les identifiants des sources, planifiez l'actualisation →
[`rafraichissement_service.md`](rafraichissement_service.md).

---

## Maquette du tableau de bord

### Page 1 — Vue d'ensemble : ADV vs Recouvrement ⭐

> **ADV = factures pas en retard · Recouvrement = factures en retard.**
> C'est l'axe de lecture principal du tableau de bord.

Bandeau de **cartes KPI** (haut) :

```
┌───────────────┬───────────────┬───────────────┬───────────────┬───────────────┐
│ Encours total │   🟢 ADV      │ 🔴 RECOUVREMENT│  DSO (jours)  │ % en recouvr. │
│ [Encours      │ [Encours ADV] │ [Encours       │ [DSO (jours)] │ [% encours en │
│  total]       │               │  Recouvrement] │               │  Recouvrement]│
└───────────────┴───────────────┴───────────────┴───────────────┴───────────────┘
```

Corps de page — **lecture par les DATES d'abord** :
- **Encours par ancienneté** (histogramme, visuel principal) :
  axe `tranche_age` (Non échu → 0-3 → … → > 48 mois), valeur
  `[Encours total]`, légende `perimetre` (ADV / Recouvrement).
  👉 C'est ici qu'on **explore en profondeur** : voir la hiérarchie ci-dessous.
- **Évolution ADV vs Recouvrement** (courbes, 2 séries) :
  `Calendrier[Année-Mois]` × `[Encours ADV]` et `[Encours Recouvrement]`
  → montre si la situation se dégrade ou s'assainit dans le temps.
- **Top 10 clients débiteurs** (barres) : `client_nom` × `[Encours total]`,
  filtré sur `perimetre = "Recouvrement"`.
- **Segments** : `perimetre`, `type_client`, `sous_categorie`, période.

> 💡 Mettez `perimetre` en **segment global** (synchronisé entre les pages) :
> vous basculez toute la lecture du dashboard entre ADV et Recouvrement d'un clic.

---

## 🔑 Principe de lecture : la DATE d'abord, la catégorie ensuite

Le tableau de bord se lit **par les dates en premier**. Les catégories
(type de client, financeur, client) ne sont pas l'entrée principale : elles
servent à **creuser** une tranche qui pose problème.

### Créer la hiérarchie d'exploration (à faire une fois)

Dans le volet *Données*, sur la table `Factures` :
1. Clic droit sur `tranche_age` → **Créer une hiérarchie**
   (nommez-la « Ancienneté → Détail »).
2. Faites glisser dessus, **dans cet ordre** : `perimetre`, puis
   `type_client`, puis `sous_categorie`, puis `client_nom`.

Vous obtenez :

```
  Ancienneté → Détail
    ├── tranche_age        ← niveau 1 : LA DATE (vue par défaut)
    ├── perimetre          ← niveau 2 : ADV / Recouvrement
    ├── type_client        ← niveau 3 : B2C, B2B, OPCO, CPF…
    ├── sous_categorie     ← niveau 4 : financeur
    └── client_nom         ← niveau 5 : le client
```

Placez cette hiérarchie en **axe** de l'histogramme (et en **lignes** de la
matrice de la page Balance âgée). Le visuel s'ouvre sur les **tranches
d'ancienneté** ; les 4 flèches en haut à droite du visuel permettent alors :

| Bouton | Effet |
|---|---|
| ⤓ *Explorer vers le bas* | descendre d'un niveau (tranche → périmètre → type…) |
| ⇅ *Développer* | garder la date **et** ajouter la catégorie en sous-niveau |
| ↑ | remonter |

> Vous pouvez aussi **cliquer directement sur une barre** (ex. « > 48 mois »)
> pour descendre uniquement dans cette tranche. C'est exactement le
> « d'abord les dates, puis creuser » demandé.

### Tris par défaut

- `tranche_age` : trié par `tranche_ordre` (*Outils de colonne → Trier par
  colonne*) → Non échu → 0-3 → … → > 48 mois, partout et automatiquement.
- **Tables détaillées** : trier par `jours_retard` **décroissant** (les plus
  anciennes créances en haut) ou par `date_echeance` croissante.
- **Courbes d'évolution** : axe `Calendrier[Année-Mois]`, ordre chronologique.

### Page 2 — Balance âgée (calquée sur votre feuille actuelle)

Une **matrice unique explorable**, ouverte **sur les tranches d'ancienneté**,
qu'on creuse ensuite par catégorie :

```
  ANCIENNETÉ            Restant dû     Total échu    Nb factures
  ▸ Non échu             4 250 000              0          312
  ▸ 0-3 mois             2 890 000      2 890 000          198
  ▸ 3-4 mois               640 000        640 000           47
  ▸ 4-8 mois             1 730 000      1 730 000          122
  ▸ 8-12 mois            1 150 000      1 150 000           88
  ▸ 12-18 mois             920 000        920 000           64
  ▸ 18-24 mois             745 000        745 000           51
  ▸ 24-36 mois             637 431        637 431           43
  ▸ 36-48 mois             851 930        851 930           39
  ▸ > 48 mois            1 352 916      1 352 916           95   🔴
  TOTAL                 15 166 277      8 913 246        1 059
```

En cliquant sur ▸ d'une tranche, on descend dans `perimetre` →
`type_client` → `sous_categorie` → `client_nom` :

```
  ▾ > 48 mois            1 352 916
      ▾ Recouvrement     1 352 916
          ▾ B2C            499 679
              CPF          312 400
              AIF          187 279
          ▸ B2B            171 912
```

Construction :
- **Visuel Matrice** —
  - **Lignes** : la hiérarchie **« Ancienneté → Détail »** créée plus haut
    (`tranche_age` en niveau 1)
  - **Valeurs** : `[Restant dû]`, `[Total échu]`, `[Nb factures]`
  - Totaux activés · dégradé de rouge sur les tranches les plus anciennes
- **Cartes** au-dessus : `[Restant dû]` · `[Total échu]` · `[Encours positif]`
  · `[Encours négatif (avoirs)]` · `[Encours net]` · `[Écart contrôle]` (=0)
- **Segments** : `perimetre`, `statut_recouvrement` (pour isoler « Payée
  (à lettrer) » — votre distinction *A Lettrer / Excluding A Lettrer*),
  `type_client`, période.

> 💡 **Vue croisée en option.** Si vous voulez retrouver ponctuellement votre
> présentation actuelle (catégories en lignes, tranches en colonnes), il
> suffit de mettre `type_client` en **Lignes** et `tranche_age` en
> **Colonnes** sur une seconde matrice. Les deux lectures coexistent sans
> rien changer aux données.

> Chaque nombre est **cliquable** : clic droit → *Extraire* pour voir les
> factures qui le composent ; export Excel d'un clic droit également.
> L'échéance qui alimente ces tranches est calculée par **vos règles métier**
> (fin de service +30/45/60 j selon le type — voir `factures_consolidees.pq`).

### Page 3 — Détail & relances (opérationnel)

- **Table détaillée filtrable** : `numero`, `client_nom`, `montant_ttc`,
  `date_echeance`, `jours_retard`, `reste_du_net`, `statut_recouvrement`,
  `statut_relance`, `responsable_reco`, `prochaine_relance`.
  → dégradé de rouge sur `jours_retard`.
- **Segments** : `statut_recouvrement`, `responsable_reco`, `tranche_age`, période.
- **Carte** `[Retard moyen pondéré (jours)]` + `[Nb factures en recouvrement]`.

### Page 4 — Contrôle de cohérence (Sellsy ↔ Monday)

**A. Factures manquantes sur Monday**
- **Carte d'alerte** `[Nb factures manquantes sur Monday]` (🔴 si > 0)
  et `[Encours manquant sur Monday]`.
- **Table** filtrée `present_monday = Faux` : factures émises (Sellsy) à
  **ajouter dans Monday** — liste actionnable pour l'équipe.
- **Carte** `[% couverture Monday]`.

**B. Factures mal rangées (ADV ↔ Recouvrement)**
- **Carte d'alerte** `[Nb factures à déplacer]` (🟠) et `[Encours à déplacer]`.
- **Table** filtrée `coherence_monday = "À déplacer"` : factures devenues
  en retard mais encore dans un tableau ADV → à basculer côté Recouvrement.
  Colonnes utiles : `numero`, `client_nom`, `reste_du_net`, `jours_retard`,
  `perimetre` (calculé) vs `perimetre_monday` (rangement réel).

> Palette conseillée : *À jour* = vert, *En recouvrement* = orange/rouge,
> *Payée* = gris/bleu. Restez cohérent entre tous les visuels.

---

## Notes importantes

- **Champs API à vérifier** : les blocs `Expand` des `.pq` reflètent les
  structures usuelles des API ; ouvrez une fois chaque endpoint et ajustez les
  noms de champs si votre compte diffère (indiqué en commentaire dans chaque
  fichier).
- **Rien n'est stocké en dur** : toutes les clés passent par des paramètres,
  chiffrés dans le jeu de données publié.
- **Balance âgée & retard** utilisent la date du dernier refresh → le
  rafraîchissement quotidien garde les chiffres justes.
