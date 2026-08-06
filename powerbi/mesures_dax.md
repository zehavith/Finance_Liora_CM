# Mesures DAX — Suivi recouvrement

Toutes les mesures s'appuient sur la table de faits consolidée **`Factures`**
(produite par `connecteurs/factures_consolidees.pq`). Les statuts et tranches
d'âge sont **déjà calculés à l'import** (colonnes `statut_recouvrement`,
`tranche_age`, `jours_retard`, `est_payee`, `present_monday`), donc les mesures
restent simples et rapides.

Créez-les dans une table de mesures dédiée `_Mesures` (*Nouvelle mesure*).

> Colonnes clés de `Factures` :
> `montant_ttc` (facturé) · `reste_du_net` (reste dû, Pennylane fait foi) ·
> `date_echeance` · `jours_retard` · `statut_recouvrement`
> (`Payée` / `À jour` / `En recouvrement` / `Sans échéance`) ·
> `tranche_age` · `present_monday` (bool).

---

## 1. KPI principaux (cartes en haut du dashboard)

```DAX
Montant facturé = SUM ( Factures[montant_ttc] )
```

```DAX
Encours total = SUM ( Factures[reste_du_net] )
```

```DAX
Montant encaissé =
SUMX ( Factures, Factures[montant_ttc] - Factures[reste_du_net] )
```

```DAX
Taux de recouvrement = DIVIDE ( [Montant encaissé], [Montant facturé] )
```

```DAX
Nb factures = DISTINCTCOUNT ( Factures[numero] )
```

---

## 2. Factures À JOUR vs EN RECOUVREMENT

```DAX
Encours à jour =
CALCULATE ( [Encours total], Factures[statut_recouvrement] = "À jour" )
```

```DAX
Encours en recouvrement =
CALCULATE ( [Encours total], Factures[statut_recouvrement] = "En recouvrement" )
```

```DAX
Nb factures à jour =
CALCULATE ( DISTINCTCOUNT ( Factures[numero] ),
            Factures[statut_recouvrement] = "À jour" )
```

```DAX
Nb factures en recouvrement =
CALCULATE ( DISTINCTCOUNT ( Factures[numero] ),
            Factures[statut_recouvrement] = "En recouvrement" )
```

```DAX
% encours en recouvrement =
DIVIDE ( [Encours en recouvrement], [Encours total] )
```

---

## 3. DSO — Days Sales Outstanding

Délai moyen de paiement, sur le CA glissant 90 jours :

```DAX
DSO (jours) =
VAR NbJours = 90
VAR CA =
    CALCULATE (
        [Montant facturé],
        DATESINPERIOD ( Calendrier[Date], MAX ( Calendrier[Date] ), - NbJours, DAY )
    )
RETURN
DIVIDE ( [Encours total] * NbJours, CA )
```

Variante « best possible DSO » (sur le seul non-échu, pour comparer) :

```DAX
Best DSO (jours) =
VAR NbJours = 90
VAR CA =
    CALCULATE ( [Montant facturé],
        DATESINPERIOD ( Calendrier[Date], MAX ( Calendrier[Date] ), - NbJours, DAY ) )
VAR NonEchu = CALCULATE ( [Encours total], Factures[jours_retard] <= 0 )
RETURN DIVIDE ( NonEchu * NbJours, CA )
```

---

## 4. Retard & balance âgée

```DAX
Créances échues =
CALCULATE ( [Encours total], Factures[jours_retard] > 0 )
```

```DAX
% échu = DIVIDE ( [Créances échues], [Encours total] )
```

```DAX
Retard moyen pondéré (jours) =
DIVIDE (
    SUMX ( FILTER ( Factures, Factures[jours_retard] > 0 ),
           Factures[reste_du_net] * Factures[jours_retard] ),
    [Créances échues]
)
```

La **balance âgée** s'obtient en mettant `tranche_age` en axe d'un histogramme
avec `[Encours total]` en valeur. Pour l'ordre des tranches : sélectionnez la
colonne `tranche_age` (vue Données) → *Outils de colonne > Trier par colonne >
`tranche_ordre`*. Le tri Non échu → 90 j + devient automatique partout.

---

## 5. Contrôle Sellsy ↔ Monday : factures MANQUANTES sur Monday

C'est le rôle de Sellsy : toute facture émise **absente** du tableau Monday.

```DAX
Nb factures manquantes sur Monday =
CALCULATE (
    DISTINCTCOUNT ( Factures[numero] ),
    Factures[present_monday] = FALSE (),
    Factures[reste_du_net] > 0        -- on cible les factures encore dues
)
```

```DAX
Encours manquant sur Monday =
CALCULATE ( [Encours total],
    Factures[present_monday] = FALSE (), Factures[reste_du_net] > 0 )
```

> Mettez `Nb factures manquantes sur Monday` en **carte d'alerte** (rouge si > 0)
> et proposez à côté une table filtrée `present_monday = Faux` listant les
> factures à ajouter dans Monday.

---

## 6. KPI complémentaires (facultatifs)

```DAX
Ticket moyen = DIVIDE ( [Montant facturé], [Nb factures] )
```

```DAX
Top débiteur (encours) =
MAXX ( VALUES ( Factures[client_nom] ), [Encours total] )
```

```DAX
Encours 90 j + =
CALCULATE ( [Encours total], Factures[tranche_age] = "90 j +" )
```

```DAX
% couverture Monday =
DIVIDE (
    CALCULATE ( DISTINCTCOUNT ( Factures[numero] ), Factures[present_monday] = TRUE () ),
    [Nb factures]
)
```

---

## 7. Mise en forme conditionnelle conseillée

| Mesure | Vert | Orange | Rouge |
|--------|------|--------|-------|
| `% échu` | < 15 % | 15–30 % | > 30 % |
| `% encours en recouvrement` | < 15 % | 15–30 % | > 30 % |
| `DSO (jours)` | < délai contractuel | +0 à +15 j | > +15 j |
| `Nb factures manquantes sur Monday` | 0 | 1–3 | > 3 |
| `Retard moyen pondéré` | < 15 j | 15–45 j | > 45 j |
