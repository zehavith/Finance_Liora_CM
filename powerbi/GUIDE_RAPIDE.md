# Guide rapide — construire le dashboard le plus vite possible

Chemin le plus court pour un rapport **fonctionnel et propre**. Suivez
strictement l'ordre : chaque étape évite un retour en arrière coûteux.

⏱️ **≈ 2 h 15** au lieu de 4 h, grâce à trois accélérateurs :

| Accélérateur | Gain |
|---|---|
| `theme_liora.json` — toute la mise en forme en 1 import | **− 1 h 15** |
| `mesures_tabular_editor.csx` — 40 mesures en 1 clic | **− 40 min** |
| Config Monday pré-remplie (tableaux trouvés par leur nom) | **− 20 min** |

---

## Avant de commencer (5 min)

Installez **Tabular Editor 2** (gratuit) :
👉 https://github.com/TabularEditor/TabularEditor/releases → `TabularEditor.Installer.msi`

Il apparaîtra dans Power BI sous *Outils externes*. C'est lui qui crée les
40 mesures d'un coup.

---

## Étape 1 — Thème (2 min) · **à faire en premier**

*Affichage → Thèmes → Rechercher des thèmes* → `theme_liora.json`

> ⚠️ **Avant** de créer le moindre visuel. Sinon vous refaites la mise en
> forme une par une.

---

## Étape 2 — Paramètres (8 min)

*Accueil → Transformer les données → Gérer les paramètres → Nouveau*

| Paramètre | Type |
|---|---|
| `pMondayToken` | Texte |
| `pPennylaneApiKey` | Texte |
| `pSellsyClientId` | Texte |
| `pSellsyClientSecret` | Texte |
| `pAnneeDebut` | Nombre (ex. `2023`) |

---

## Étape 3 — Les requêtes (25 min)

*Nouvelle source → Requête vide → Éditeur avancé*, coller, **renommer**.

| Ordre | Fichier | Nom de la requête |
|---|---|---|
| 1 | `connecteurs/monday_multi_boards.pq` | `Monday_Suivi` |
| 2 | `connecteurs/sellsy_factures.pq` | `Sellsy_Factures` |
| 3 | `connecteurs/pennylane_factures.pq` | `Pennylane_Paiements` |
| 4 | `connecteurs/calendrier.pq` | `Calendrier` |
| 5 | `connecteurs/factures_consolidees_phase1.pq` | `Factures` |

Puis clic droit sur les **3 premières** → décocher *Activer le chargement*.
→ *Fermer et appliquer*.

### 💡 Le conseil qui fait gagner 30 min

Au premier essai, **ne gardez que 2 tableaux** dans `BoardsConfig` (commentez
les autres avec `//`). Chargement en 3 min au lieu de 30, et vous validez
tout de suite que les clés et les colonnes fonctionnent. Vous décommenterez
ensuite.

---

## Étape 4 — Modèle (7 min)

- [ ] Relation `Calendrier[Date]` → `Factures[date_echeance]` (1 → *)
- [ ] Clic droit sur `Calendrier` → **Marquer comme table de dates**
- [ ] Colonne `tranche_age` → *Outils de colonne → Trier par colonne →
      `tranche_ordre`*
- [ ] Clic droit sur `tranche_age` → *Créer une hiérarchie* « Ancienneté →
      Détail », puis y glisser `perimetre`, `type_client`, `sous_categorie`,
      `client_nom`

---

## Étape 5 — Les 40 mesures (3 min) ⚡

1. *Outils externes → Tabular Editor*
2. Onglet **C# Script**
3. Coller **tout** `mesures_tabular_editor.csx` → **F5**
4. **Ctrl+S** → retour dans Power BI

Les mesures arrivent rangées en 7 dossiers (Base, ADV vs Recouvrement,
Parité dashboard, Taux, DSO, Retard, Contrôles), déjà formatées en €, %, jours.

> Sans Tabular Editor : collez-les une par une depuis `mesures_dax.md` et
> `parite_ancien_dashboard.md` (~40 min).

---

## Étape 6 — Les pages (50 min)

Le thème ayant déjà réglé couleurs et polices, il ne reste que le placement.

### Page 1 — Vue d'ensemble (20 min)
- Bandeau de **cartes** : `Encours total`, `Encours ADV`, `Encours Recouvrement`,
  `DSO`, `Variation DSO`, `Nb Bad Debt`
- **Histogramme** : axe = hiérarchie « Ancienneté → Détail », valeur
  `Encours total`, légende `perimetre`
- **Courbe** : axe `Calendrier[Année-Mois]`, valeurs `DSO` et
  `DSO 3 mois glissants`
- **Segments** : période (`Calendrier[Date]`, mode « Entre »), `perimetre`,
  `sous_categorie`

### Page 2 — Détail & relances (15 min)
- **Table** : `numero`, `client_nom`, `reste_du_net`, `date_echeance`,
  `jours_retard`, `statut_relance`, `responsable_reco`
- Trier par `jours_retard` décroissant
- Mise en forme conditionnelle : dégradé sur `jours_retard`

### Page 3 — Contrôles (15 min)
- Cartes : `Nb factures manquantes sur Monday`, `Nb factures à déplacer`,
  `% couverture Monday`
- Deux tables filtrées : `present_monday = Faux`, puis
  `coherence_monday = "À déplacer"`

### Pour finir
*Affichage → Synchroniser les segments* → cocher les 3 pages pour la période
et `perimetre`. Vous filtrez une fois, tout suit.

---

## Étape 7 — Publier + rafraîchissement (12 min)

*Accueil → Publier*, puis dans le service :
*Jeu de données → Paramètres → Informations d'identification* (toutes en
**Anonyme**) → *Actualisation planifiée* (ex. 7 h, Europe/Paris) + alerte e-mail.

Détail : [`rafraichissement_service.md`](rafraichissement_service.md).

---

## Les 4 pièges qui coûtent du temps

| Piège | Comment l'éviter |
|---|---|
| Mise en forme visuel par visuel | Importer le thème **avant** de créer les visuels |
| Recharger 30 000 lignes à chaque essai | Tester sur 2 tableaux Monday d'abord |
| Créer les mesures à la main | Tabular Editor (étape 5) |
| Refaire le tri des tranches sur chaque visuel | *Trier par colonne* une seule fois (étape 4) |

---

## Quand vous bloquez

Envoyez-moi le **message d'erreur exact** (capture) — la plupart des blocages
Power BI sont des messages connus dont la correction tient en une ligne :
titre de colonne Monday différent, niveau de confidentialité, format de date.
Le dépannage courant est en fin de [`rafraichissement_service.md`](rafraichissement_service.md).
