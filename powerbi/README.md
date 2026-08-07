# Tableau de bord Recouvrement — Power BI (Pennylane · Sellsy · Monday)

Kit clé en main pour connecter **Pennylane**, **Sellsy** et **Monday** à
**Power BI** et obtenir un suivi de recouvrement clair, **rafraîchi
automatiquement chaque jour**.

## Rôle de chaque source

| Source | Rôle | Apport au dashboard |
|--------|------|---------------------|
| **Sellsy** | Référentiel des factures **émises** | Détecte les **factures manquantes sur Monday** |
| **Monday** | Suivi des factures / relances | Statut de relance, responsable, prochaine relance |
| **Pennylane** | **Vérité paiement** | Reste dû, payé/impayé, échéance → encours & retard |

Réconciliation **par n° de facture**, table consolidée unique `Factures`.

## 🚦 Par où commencer

Le déploiement se fait en **2 phases** :

| Phase | Contenu | Durée | Guide |
|---|---|---|---|
| **Phase 1** ⬅️ *commencez ici* | Suivi recouvrement (KPI, DSO, à jour / en recouvrement, factures manquantes sur Monday) + refresh auto | 2 h 30 – 3 h | **[`PHASE1_demarrage.md`](PHASE1_demarrage.md)** |
| **Phase 2** | Balance âgée complète : règles d'échéance métier, type de client / financeur, avoirs | 1 h 30 – 2 h | fin de `PHASE1_demarrage.md` |

## Contenu du kit

```
powerbi/
├── README.md                          ← vous êtes ici (vue d'ensemble + maquette)
├── PHASE1_demarrage.md                ⬅️ CHECKLIST DE DÉMARRAGE (commencez ici)
├── connecteurs/
│   ├── sellsy_factures.pq             Factures émises (référentiel)         → Sellsy_Factures
│   ├── pennylane_factures.pq          Paiement (reste dû, échéance)         → Pennylane_Paiements
│   ├── monday_relances.pq             Suivi / relances                      → Monday_Suivi
│   ├── calendrier.pq                  Table de dates                        → Calendrier (chargée)
│   ├── factures_consolidees_phase1.pq Fusion simplifiée — PHASE 1           → Factures (chargée)
│   ├── factures_consolidees.pq        Fusion complète — PHASE 2             → Factures (chargée)
│   ├── sellsy_avoirs.pq               Avoirs (phase 2)                      → Sellsy_Avoirs
│   └── referentiel_factures.pq        Type client / dates formation (ph. 2) → Referentiel_Factures
├── modele/
│   └── modele_donnees.md              Schéma, relations, clés de liaison
├── mesures_dax.md                     Toutes les mesures (recouvrement, DSO, KPI…)
├── rafraichissement_service.md        Rafraîchissement auto quotidien (service Power BI)
├── option_rapprochement_bancaire.md   ⭐ Phase 2 : filet de sécurité banque ↔ Pennylane
└── connecteurs/banque_rapprochement.pq    (module optionnel associé)
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

### Page 1 — Vue d'ensemble recouvrement

Bandeau de **cartes KPI** (haut) :

```
┌───────────────┬───────────────┬───────────────┬───────────────┬───────────────┐
│ Encours total │  À jour       │ En recouvrement│  DSO (jours)  │ % échu        │
│  [Encours     │ [Encours à    │ [Encours en    │ [DSO (jours)] │ [% échu]      │
│   total]      │  jour]        │  recouvrement] │               │  🔴/🟠/🟢     │
└───────────────┴───────────────┴───────────────┴───────────────┴───────────────┘
```

Corps de page :
- **Balance âgée** (histogramme empilé) : axe `tranche_age`
  (Non échu · 0-30 · 31-60 · 61-90 · 90 j +), valeur `[Encours total]`.
- **Évolution de l'encours** (courbe) : `Calendrier[Année-Mois]` × `[Encours total]`.
- **Répartition À jour / En recouvrement / Payée** (anneau) : `statut_recouvrement`.
- **Top 10 clients débiteurs** (barres) : `client_nom` × `[Encours total]`, top N.

### Page 2 — Balance âgée (calquée sur votre feuille actuelle)

Une **matrice unique avec drill-down** remplace vos 3 onglets (type / sous-
catégorie / compte client) :

```
                     Restant dû   Total échu   0-3   3-4   4-8   8-12  12-18  18-24  24-36  36-48  >48   Non échu
 ▸ B2C                6 985 611    3 858 262    …     …     …     …      …      …      …      …     …       …
 ▸ B2C - Entreprise   2 153 476      998 444    …
 ▸ B2B                1 451 037      801 627    …
 ▸ Alternance           851 163      599 718    …
 ▸ POEI               3 706 370    2 636 575    …
 ▸ Interco               18 618       18 618    …
 TOTAL               15 166 277    8 913 246    …
```

Construction :
- **Visuel Matrice** —
  - **Lignes** (3 niveaux, drill-down avec ▸) : `type_client` →
    `sous_categorie` (CPF, OPCO, Région…) → `client_nom`
  - **Colonnes** : `tranche_age` (**en mois**, triée via `tranche_ordre` :
    Non échu → 0-3 → … → > 48 mois)
  - **Valeurs** : `[Restant dû]` ; ajoutez `[Total échu]` en 1re valeur pour
    reproduire vos deux colonnes de tête
  - Totaux ligne + colonne activés · dégradé de rouge sur les tranches hautes
- **Cartes** au-dessus : `[Restant dû]` · `[Total échu]` · `[Encours positif]`
  · `[Encours négatif (avoirs)]` · `[Encours net]` · `[Écart contrôle]` (=0)
- **Segments** : `statut_recouvrement` (pour isoler « Payée (à lettrer) » —
  votre distinction *A Lettrer / Excluding A Lettrer*), `type_client`, période.

> Chaque nombre de la matrice est **cliquable** : clic droit > *Extraire* pour
> voir les factures qui le composent ; export Excel d'un clic droit également.
> L'échéance qui alimente ces tranches est calculée par **vos règles métier**
> (fin de formation +30/45/60 j selon le type — voir `factures_consolidees.pq`).

### Page 3 — Détail & relances (opérationnel)

- **Table détaillée filtrable** : `numero`, `client_nom`, `montant_ttc`,
  `date_echeance`, `jours_retard`, `reste_du_net`, `statut_recouvrement`,
  `statut_relance`, `responsable_reco`, `prochaine_relance`.
  → dégradé de rouge sur `jours_retard`.
- **Segments** : `statut_recouvrement`, `responsable_reco`, `tranche_age`, période.
- **Carte** `[Retard moyen pondéré (jours)]` + `[Nb factures en recouvrement]`.

### Page 4 — Contrôle de cohérence (Sellsy ↔ Monday)

- **Carte d'alerte** `[Nb factures manquantes sur Monday]` (🔴 si > 0)
  et `[Encours manquant sur Monday]`.
- **Table** filtrée `present_monday = Faux` : factures émises (Sellsy) à
  **ajouter dans Monday** — liste actionnable pour l'équipe.
- **Carte** `[% couverture Monday]`.

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
