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

## Contenu du kit

```
powerbi/
├── README.md                          ← vous êtes ici (pas-à-pas + maquette)
├── connecteurs/
│   ├── sellsy_factures.pq             Factures émises (référentiel)         → Sellsy_Factures
│   ├── pennylane_factures.pq          Paiement (reste dû, échéance)         → Pennylane_Paiements
│   ├── monday_relances.pq             Suivi / relances                      → Monday_Suivi
│   ├── factures_consolidees.pq        Fusion des 3 par n° de facture        → Factures (chargée)
│   └── calendrier.pq                  Table de dates                        → Calendrier (chargée)
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

### Page 2 — Détail & relances (opérationnel)

- **Table détaillée filtrable** : `numero`, `client_nom`, `montant_ttc`,
  `date_echeance`, `jours_retard`, `reste_du_net`, `statut_recouvrement`,
  `statut_relance`, `responsable_reco`, `prochaine_relance`.
  → dégradé de rouge sur `jours_retard`.
- **Segments** : `statut_recouvrement`, `responsable_reco`, `tranche_age`, période.
- **Carte** `[Retard moyen pondéré (jours)]` + `[Nb factures en recouvrement]`.

### Page 3 — Contrôle de cohérence (Sellsy ↔ Monday)

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
