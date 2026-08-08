# Parité avec votre tableau de bord actuel

Inventaire exhaustif de l'ancien dashboard Google Sheets, et la mesure DAX
qui le reproduit dans Power BI. **Aucun indicateur ne doit être perdu.**

> Convention : les mesures s'appuient sur la table `Factures`
> (voir `mesures_dax.md` pour les mesures de base).

---

## 1. Les 8 indicateurs, en double vue

Votre outil affiche chaque indicateur **deux fois** : en global et sur la
période sélectionnée. En Power BI, **une seule mesure suffit** — c'est le
segment de période qui produit la seconde vue.

| # | Ancien libellé | Valeur actuelle | Mesure Power BI |
|---|---|---|---|
| 1 | Nombre de facture créée | 15 461 | `[Nb factures créées]` |
| 2 | Nombre de facture en recouvrement | 5 563 | `[Nb factures en recouvrement]` |
| 3 | Nombre de facture recouvrée | 1 912 | `[Nb factures recouvrées]` |
| 4 | Somme Facture en recouvrement | 27 196 249,71 € | `[Somme en recouvrement]` |
| 5 | Somme Facture recouvrée | 10 201 193,37 € | `[Somme recouvrée]` |
| 6 | Délai moyen de recouvrement | 360 j | `[Délai moyen de recouvrement]` |
| 7 | Nb facture Bad Debt (> 360 j) | 1 840 | `[Nb Bad Debt]` |
| 8 | Nb facture Bad Debt payée | 254 | `[Nb Bad Debt payée]` |

> 💡 **Vous gagnez la comparaison automatique** : au lieu de deux blocs figés,
> une carte peut afficher la valeur *et* son écart vs période précédente.

### Les mesures

```DAX
Nb factures créées = DISTINCTCOUNT ( Factures[numero] )
```

```DAX
Nb factures en recouvrement =
CALCULATE ( DISTINCTCOUNT ( Factures[numero] ),
    Factures[perimetre] = "Recouvrement" )
```

```DAX
-- Recouvrée = payée APRÈS être passée en retard
Nb factures recouvrées =
CALCULATE (
    DISTINCTCOUNT ( Factures[numero] ),
    Factures[est_payee] = TRUE (),
    Factures[jours_retard] > 0
)
```

> Variante fidèle à vos statuts Monday, si vous préférez :
> `CALCULATE ( DISTINCTCOUNT ( Factures[numero] ), CONTAINSSTRING ( Factures[statut_relance], "Payée - Recouvrement" ) )`

```DAX
Somme en recouvrement =
CALCULATE ( [Encours total], Factures[perimetre] = "Recouvrement" )
```

```DAX
Somme recouvrée =
CALCULATE (
    SUM ( Factures[montant_ttc] ),
    Factures[est_payee] = TRUE (),
    Factures[jours_retard] > 0
)
```

```DAX
-- Délai réel facture → paiement (colonne Monday « Délai de paiement »)
Délai moyen de recouvrement =
AVERAGEX (
    FILTER ( Factures, NOT ISBLANK ( Factures[delai_paiement] ) ),
    Factures[delai_paiement]
)
```

```DAX
Nb Bad Debt =
CALCULATE ( DISTINCTCOUNT ( Factures[numero] ), Factures[jours_retard] > 360 )
```

```DAX
Nb Bad Debt payée =
CALCULATE ( DISTINCTCOUNT ( Factures[numero] ),
    Factures[jours_retard] > 360, Factures[est_payee] = TRUE () )
```

```DAX
Somme Bad Debt =
CALCULATE ( [Encours total], Factures[jours_retard] > 360 )
```

---

## 2. Les taux — le cœur de votre pilotage

```DAX
Taux de facture en recouvrement =
DIVIDE ( [Nb factures en recouvrement], [Nb factures créées] )
```

```DAX
Taux nb factures recouvrées =
DIVIDE ( [Nb factures recouvrées], [Nb factures en recouvrement] )
```

```DAX
Taux montant recouvré =
DIVIDE ( [Somme recouvrée], [Somme en recouvrement] )
```

```DAX
Taux de facture Bad Debt =
DIVIDE ( [Nb Bad Debt], [Nb factures créées] )
```

```DAX
Taux Bad Debt recouvrée =
DIVIDE ( [Nb Bad Debt payée], [Nb Bad Debt] )
```

### Les seuils (bandes rouge / orange / verte)

Vos objectifs sont codés en dur dans Sheets. En Power BI, mettez-les dans une
table `Seuils` (*Accueil > Entrer des données*) pour pouvoir les changer sans
retoucher les visuels :

| Indicateur | Vert | Orange | Rouge |
|---|---|---|---|
| Taux de facture en recouvrement | ≤ 10 % | 10-20 % | > 30 % |
| Taux par type de financement | ≤ 5 % | 5-8 % | > 12 % |

Puis, sur le graphique : *Mise en forme > Axe Y > Lignes constantes*, une par
seuil, avec sa couleur. Ou une mesure d'état pour colorer le point :

```DAX
État taux recouvrement =
VAR t = [Taux de facture en recouvrement]
RETURN SWITCH ( TRUE (), t <= 0.10, "Bon", t <= 0.20, "Vigilance",
                          t <= 0.30, "Alerte", "Critique" )
```

---

## 3. Les 5 graphiques

| Ancien graphique | Reproduction Power BI |
|---|---|
| Taux de facture en recouvrement (mensuel + seuils) | Courbe · axe `Calendrier[Année-Mois]` · valeur `[Taux de facture en recouvrement]` · 3 lignes constantes |
| Taux de facture recouvrée, tous financements | Courbe 2 séries · `[Taux nb factures recouvrées]` + `[Taux montant recouvré]` |
| Taux en recouvrement par type de financement | Même courbe, filtrée par le segment `sous_categorie` |
| Taux recouvrées par type de financement | Histogramme groupé · axe `Calendrier[Année-Mois]` · 2 séries |
| Taux de facture Bad Debt (camembert) | **Barres horizontales** par `sous_categorie` — plus lisible qu'un camembert à 6 parts, et les valeurs restent comparables |

---

## 4. Les filtres

| Ancien contrôle | Équivalent Power BI |
|---|---|
| Analyse entre le … et le … (jour/mois/année ×2) | **Un** segment `Calendrier[Date]` en mode « Entre » — 2 clics au lieu de 6 listes |
| BdD … en fonction de : Date de facture | Mesure `USERELATIONSHIP` (voir `mesures_dax.md` §8) |
| Type de financement | Segment `sous_categorie` |
| **Prise en compte des avoirs : OUI / NON** | Voir ci-dessous ⬇️ |

### Le bouton « avoirs »

Créez une table déconnectée (*Accueil > Entrer des données*) nommée `Avoirs`
avec une colonne `Choix` = `Oui` / `Non`, mettez-la en segment, puis :

```DAX
Nb factures créées (avoirs paramétrable) =
VAR AvecAvoirs = SELECTEDVALUE ( Avoirs[Choix], "Non" ) = "Oui"
RETURN
CALCULATE (
    DISTINCTCOUNT ( Factures[numero] ),
    FILTER ( Factures, AvecAvoirs || Factures[montant_ttc] >= 0 )
)
```

> Appliquez le même motif à toute mesure de comptage devant respecter ce choix.

---

## 5. Ce que le nouveau tableau de bord ajoute

Au-delà de la parité :

| Nouveauté | Pourquoi c'est utile |
|---|---|
| **Balance âgée par ancienneté** | Voir *où* le retard se concentre, pas seulement combien |
| **ADV vs Recouvrement calculé** | Le partage se met à jour seul, plus de classement manuel |
| **Factures manquantes sur Monday** | Sellsy révèle les factures jamais mises en suivi |
| **Factures mal rangées** | En retard mais encore côté ADV → à basculer |
| **Doublons inter-tableaux neutralisés** | 3 831 lignes en double retirées automatiquement |
| **Exploration par clic** | Cliquer une tranche pour descendre jusqu'à la facture |
| **Rafraîchissement quotidien** | Plus aucune manipulation |

---

## 6. Checklist de recette

À vérifier au premier chargement, en filtrant sur la même période que votre
Sheets actuel — les écarts doivent s'expliquer, pas surprendre.

- [ ] `[Nb factures créées]` ≈ 15 461
- [ ] `[Nb factures en recouvrement]` ≈ 5 563
- [ ] `[Nb factures recouvrées]` ≈ 1 912
- [ ] `[Somme en recouvrement]` ≈ 27 196 249,71 €
- [ ] `[Somme recouvrée]` ≈ 10 201 193,37 €
- [ ] `[Délai moyen de recouvrement]` ≈ 360 j
- [ ] `[Nb Bad Debt]` ≈ 1 840 · `[Nb Bad Debt payée]` ≈ 254

> ⚠️ **Des écarts sont attendus, et c'est plutôt bon signe** : le nouveau
> modèle retire les doublons inter-tableaux et les lignes techniques que
> votre Sheets compte encore. Notez chaque écart et sa cause — c'est ce qui
> vous permettra de faire confiance au nouvel outil.
