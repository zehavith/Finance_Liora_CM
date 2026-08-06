# Option (phase 2) — Filet de sécurité bancaire au lettrage Pennylane

## Pourquoi

Pennylane fait foi pour le paiement, mais le lettrage n'est **que partiel**.
Sans garde-fou, une facture **déjà encaissée mais non encore lettrée** apparaît
« En recouvrement » → risque de **relancer un client qui a déjà payé**.

Ce module réutilise **votre extraction Google Sheets** (les formules qui sortent
les n° de facture des libellés bancaires) pour poser un flag **« encaissé en
banque »**, et crée un statut **« Payée (à lettrer) »** qu'on sort des relances.

> On ne recode pas vos REGEX : Power Query n'a pas de regex natif. L'extraction
> reste dans Sheets ; Power BI ne fait que lire le résultat.

## Étape A — Préparer un onglet propre dans Google Sheets

Dans votre classeur, créez un onglet **`PowerBI_Rapprochement`** avec **3 colonnes**
alimentées par vos formules existantes :

| date_paiement | montant_recu | numeros_factures |
|---|---|---|
| 2025-07-14 | 8900 | FACT-2024-00123, FACT-2024-00124 |
| 2025-07-15 | 3120,75 | FCT-FILIZ-DST-2025-7 |

- `numeros_factures` = la sortie de votre `TEXTJOIN(", ";…)` (plusieurs n°
  séparés par « , » = géré, on les éclate).
- Gardez des **en-têtes en 1re ligne** exactement comme ci-dessus.

## Étape B — Connecter la feuille à Power BI

*Accueil > Obtenir les données > Plus > Google Sheets* → collez l'**URL de
partage** du classeur → authentifiez-vous Google → choisissez l'onglet
`PowerBI_Rapprochement` → **nommez cette requête `Banque_Source`**.

Puis créez une requête vide `Banque_Rapprochement` et collez
`connecteurs/banque_rapprochement.pq` (elle transforme `Banque_Source`).
Désactivez le chargement de `Banque_Source` et `Banque_Rapprochement` (staging).

> Rafraîchissement auto : le connecteur Google Sheets est supporté par le
> service Power BI, mais demande une **auth Google** sur le jeu de données
> (Paramètres > Identifiants de source > OAuth Google). Alternative « zéro
> friction » : copier l'onglet dans un **fichier Excel sur OneDrive/SharePoint**
> — le service Power BI le rafraîchit nativement, sans passerelle.

## Étape C — Brancher le rapprochement dans `Factures`

Dans `connecteurs/factures_consolidees.pq`, **juste avant** l'étape `A5`
(« Payée ? »), insérez la fusion avec la banque :

```m
    // --- Fusion avec le rapprochement bancaire (module optionnel) -----
    JoinBanque = Table.NestedJoin(
        A4, {"cle"},
        Banque_Rapprochement, {"cle"},
        "banque", JoinKind.LeftOuter
    ),
    ExpBanque = Table.ExpandTableColumn(
        JoinBanque, "banque",
        {"encaisse_banque","date_paiement"},
        {"encaisse_banque","date_encaissement_banque"}
    ),
```

Puis remplacez la ligne `A5` (est_payee) et `A7` (statut_recouvrement) par :

```m
    // Payée si Pennylane l'indique OU si la banque l'a encaissée
    A5 = Table.AddColumn(ExpBanque, "est_payee", each
            [reste_du_net] <= 0 or [encaisse_banque] = true, type logical),

    ...

    // Statut affiné avec le filet bancaire
    A7 = Table.AddColumn(A6, "statut_recouvrement", each
            if [reste_du_net] <= 0 then "Payée"
            else if [encaisse_banque] = true then "Payée (à lettrer)"
            else if [jours_retard] = null then "Sans échéance"
            else if [jours_retard] <= 0 then "À jour"
            else "En recouvrement", type text),
```

Enfin, ajoutez `encaisse_banque` et `date_encaissement_banque` à la liste
`Table.SelectColumns(A8, {...})` de l'étape `Final` pour les garder.

## Étape D — Mesures DAX complémentaires

```DAX
Encaissé non lettré =
CALCULATE ( [Encours total],
    Factures[statut_recouvrement] = "Payée (à lettrer)" )
```

```DAX
Nb factures à lettrer =
CALCULATE ( DISTINCTCOUNT ( Factures[numero] ),
    Factures[statut_recouvrement] = "Payée (à lettrer)" )
```

> Mettez `Nb factures à lettrer` en carte (🟠) sur la page « Détail & relances ».
> C'est votre liste « à pointer dans Pennylane » — et surtout « ne PAS relancer ».

## Attention

- Ne **sommez pas** `montant_recu` par facture si un même virement couvre
  plusieurs factures (montant dupliqué). Ce module est un **flag** + date, pas
  une source de montant. Le montant fait toujours foi via Pennylane/Sellsy.
- Si un n° extrait ne matche aucune facture (format différent), il est
  simplement ignoré — vérifiez la cohérence des préfixes (`FACT-`, `FCT-`).
