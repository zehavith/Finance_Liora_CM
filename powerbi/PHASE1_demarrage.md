# PHASE 1 — Suivi recouvrement (checklist de démarrage)

Objectif : un tableau de bord recouvrement **qui tourne et se rafraîchit seul**,
en une séance. La balance âgée détaillée par type de client / financeur viendra
en **phase 2** (voir la fin de ce document).

⏱️ **Durée estimée : 2 h 30 – 3 h**

---

## ✅ Ce que vous aurez à la fin de la phase 1

- Encours total, montant encaissé, taux de recouvrement
- **Factures à jour** vs **factures en recouvrement**
- **DSO** (délai moyen de paiement) et % échu
- **Factures manquantes sur Monday** (contrôle Sellsy ↔ Monday)
- Table détaillée filtrable pour les relances
- Balance âgée **simple** (par tranche de mois, sans ventilation par type)
- **Rafraîchissement automatique quotidien**

## ⚠️ Ce qui est volontairement reporté en phase 2

| Reporté | Conséquence en phase 1 |
|---|---|
| Vos **règles d'échéance métier** (fin de formation +30/45/60 j) | L'échéance vient de Pennylane/Sellsy → les chiffres de **retard sont indicatifs**, pas exacts |
| **Type de client / sous-catégorie** (B2C, CPF, OPCO…) | Pas de ventilation de la balance par catégorie |
| **Avoirs Sellsy** (montants négatifs) | Les avoirs n'apparaissent pas encore dans l'encours |

> 👉 Tant que la phase 2 n'est pas faite, **vérifiez la facture dans
> Pennylane/Sellsy avant toute relance formelle** : le retard affiché peut
> différer de votre vraie échéance contractuelle.

### ⭐ Comment supprimer cette limite dès la phase 1

Si vos **tableaux Monday sont déjà séparés par type de client** (B2C,
Corporate, Alternance…), utilisez **`connecteurs/monday_multi_boards.pq`** au
lieu de `monday_relances.pq` (étape 4). Vous y déclarez, pour chaque tableau,
son type et sa règle d'échéance :

```
{"1111111111", "B2C - Entreprise",       "facture", 30},
{"2222222222", "Corporate - Alternance", "facture", 30},
```

Bénéfices immédiats, **sans référentiel ni saisie manuelle** :
- le **type de client** est déduit du tableau d'origine ;
- l'**échéance** suit votre règle « date de facture + N jours » → les chiffres
  de retard deviennent **justes** dès la phase 1 ;
- vous pouvez aussi ajouter une colonne **« Date d'échéance »** dans Monday :
  si elle est remplie, elle est prioritaire sur la règle.

> ⚠️ Reste en phase 2 : les règles basées sur les **dates de formation**
> (fin/début de formation +30/45/60 j), qui exigent le référentiel — les
> tableaux Monday ne portent pas ces dates. Les types concernés (CPF, POEI,
> OPCO, AIF…) gardent donc une échéance approchée jusque-là.

---

## Étape 1 — Réunir les 5 clés ⏱️ 15-30 min

| Clé | Où la trouver | Paramètre |
|---|---|---|
| Clé API Pennylane | Paramètres → API & webhooks | `pPennylaneApiKey` |
| Client ID Sellsy | Paramètres → API → Créer une application | `pSellsyClientId` |
| Client Secret Sellsy | (même écran, copiez-le tout de suite) | `pSellsyClientSecret` |
| Jeton Monday | Avatar → Développeurs → My access tokens | `pMondayToken` |
| Board id Monday | Dans l'URL du tableau `…/boards/1234567890` | `pMondayBoardId` |

💡 Générez le token Monday **sans expiration** → moins d'entretien plus tard.

- [ ] Les 5 valeurs sont notées

## Étape 2 — Installer Power BI Desktop ⏱️ 15 min

- [ ] Microsoft Store → « Power BI Desktop » → Installer
- [ ] Ouvrir l'application

## Étape 3 — Créer les paramètres ⏱️ 10 min

*Accueil → Transformer les données → Gérer les paramètres → Nouveau*

- [ ] `pPennylaneApiKey` (Texte)
- [ ] `pSellsyClientId` (Texte)
- [ ] `pSellsyClientSecret` (Texte)
- [ ] `pMondayToken` (Texte)
- [ ] `pMondayBoardId` (Texte)
- [ ] `pAnneeDebut` (Nombre, ex. `2023`)

## Étape 4 — Créer les 5 requêtes ⏱️ 45 min

Pour chacune : *Nouvelle source → Requête vide → Éditeur avancé*, coller le
contenu du fichier, **renommer la requête** exactement comme indiqué.

- [ ] `connecteurs/sellsy_factures.pq` → nommer **`Sellsy_Factures`**
- [ ] `connecteurs/pennylane_factures.pq` → **`Pennylane_Paiements`**
- [ ] `connecteurs/monday_relances.pq` → **`Monday_Suivi`**
      *(ou `connecteurs/monday_multi_boards.pq` si plusieurs tableaux — voir
      l'encadré ⭐ ci-dessus ; les deux sont interchangeables)*
- [ ] `connecteurs/calendrier.pq` → **`Calendrier`**
- [ ] `connecteurs/factures_consolidees_phase1.pq` → **`Factures`** ⬅️ *version
      phase 1, à créer en DERNIER*

> ⚠️ Bien prendre `factures_consolidees_**phase1**.pq` (pas la version
> complète, qui exige le référentiel et les avoirs).

**Adapter Monday à votre tableau** : dans `Monday_Suivi`, bloc
`ColonnesVoulues`, remplacer les titres par ceux **exacts** de votre tableau.

- [ ] Titres Monday adaptés

**Désactiver le chargement du staging** : clic droit sur `Sellsy_Factures`,
`Pennylane_Paiements`, `Monday_Suivi` → décocher **« Activer le chargement »**.

- [ ] Staging désactivé, puis **Fermer et appliquer**

## Étape 5 — Modèle ⏱️ 5 min

- [ ] Relation `Calendrier[Date]` → `Factures[date_echeance]` (1 → *)
- [ ] Clic droit sur `Calendrier` → **Marquer comme table de dates**
- [ ] Colonne `tranche_age` → *Outils de colonne → Trier par colonne →
      `tranche_ordre`*

## Étape 6 — Mesures ⏱️ 15 min

Créer une table `_Mesures`, puis coller depuis [`mesures_dax.md`](mesures_dax.md) :

- [ ] Montant facturé · Encours total · Montant encaissé · Taux de recouvrement
- [ ] Encours à jour · Encours en recouvrement · Nb factures (à jour / en recouvrement)
- [ ] DSO (jours) · Total échu · % échu · Retard moyen pondéré
- [ ] Nb factures manquantes sur Monday · Encours manquant sur Monday

> Sautez pour l'instant les mesures qui parlent de `type_client` — phase 2.

## Étape 7 — Les 3 pages ⏱️ 45 min

Voir la maquette dans [`README.md`](README.md).

- [ ] **Page 1 — Vue d'ensemble** : cartes KPI, évolution de l'encours,
      anneau À jour / En recouvrement / Payée, top 10 débiteurs
- [ ] **Page 2 — Détail & relances** : table filtrable + segments
- [ ] **Page 3 — Contrôle Sellsy ↔ Monday** : carte d'alerte + liste des
      factures à ajouter dans Monday

*(La page « Balance âgée » complète arrive en phase 2 — en attendant, un simple
histogramme `tranche_age` × `[Encours total]` donne déjà la vue globale.)*

## Étape 8 — Publier + rafraîchissement automatique ⏱️ 15 min

Voir [`rafraichissement_service.md`](rafraichissement_service.md) §0 à §5.

- [ ] *Accueil → Publier* → choisir l'espace de travail
- [ ] Service Power BI → jeu de données → **Paramètres**
- [ ] **Identifiants des sources** : Pennylane / Sellsy / Monday = **Anonyme**
- [ ] **Niveaux de confidentialité** : tous sur `Organizational`
- [ ] **Actualisation planifiée** : activée (ex. 7 h, Europe/Paris)
- [ ] **Notification d'échec** par e-mail activée
- [ ] Lancer un *Actualiser maintenant* pour valider

🎉 **Phase 1 terminée** — le tableau se met à jour tout seul chaque jour.

---

## PHASE 2 — Balance âgée complète (plus tard) ⏱️ 1 h 30 – 2 h

À faire quand la phase 1 tourne. Trois ajouts, dans cet ordre :

1. **Référentiel** (~45 min) — onglet Sheets `PowerBI_Referentiel` avec
   `numero_facture | type_client | sous_categorie | date_debut_formation |
   date_fin_formation`, alimenté par vos formules / l'ancien grand livre.
   Puis requête `Referentiel_Factures` (voir `connecteurs/referentiel_factures.pq`).
2. **Avoirs** (~15 min) — requête `Sellsy_Avoirs`
   (`connecteurs/sellsy_avoirs.pq`).
3. **Bascule** (~10 min) — remplacer le code de la requête `Factures` par
   `connecteurs/factures_consolidees.pq` (version complète). Elle active
   automatiquement **vos règles d'échéance métier** et la ventilation par
   type / sous-catégorie.
4. **Page Balance âgée** (~20 min) — matrice `type_client → sous_categorie →
   client_nom` × `tranche_age`, décrite dans `README.md`.

> Rien n'est à refaire : les pages et mesures de la phase 1 continuent de
> fonctionner, et les chiffres de retard deviennent **exacts** à ce moment-là.
