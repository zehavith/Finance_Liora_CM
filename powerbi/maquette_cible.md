# Maquette cible — d'après votre schéma

Traduction de votre wireframe en visuels Power BI.

> **Le point clé** : vos blocs « Facture encours » et « Facture payée », avec
> leurs 9 catégories × (nb / montant) × (ADV / recouvrement), sont **une seule
> matrice**. Ce qui occupe 60 lignes dans Sheets tient dans un visuel qui se
> recalcule seul.

---

## 1. Les filtres (bandeau du haut)

| Votre schéma | Visuel Power BI |
|---|---|
| « mois pris en compte » — on clique les mois voulus | **Segment** `Calendrier[Année-Mois]`, mode *Liste*, sélection multiple |
| « possibilité de prendre une plage de date » (de … à …) | **Segment** `Calendrier[Date]`, mode *Entre* |
| « date prise = date de facture / début / fin de formation » | **Segment** sur la table `DatePilote` ⬇️ |

### Le sélecteur de date pilote (3 choix)

*Accueil > Entrer des données* → table **`DatePilote`**, colonne `Choix` :
`Date de facture` · `Début de formation` · `Fin de formation`.

Créez les 3 relations vers `Calendrier[Date]` (une seule active), puis :

```DAX
Encours (date pilote) =
VAR c = SELECTEDVALUE ( DatePilote[Choix], "Date de facture" )
RETURN
SWITCH ( c,
    "Début de formation",
        CALCULATE ( [Encours total], USERELATIONSHIP ( Calendrier[Date], Factures[date_debut_formation] ) ),
    "Fin de formation",
        CALCULATE ( [Encours total], USERELATIONSHIP ( Calendrier[Date], Factures[date_fin_formation] ) ),
    CALCULATE ( [Encours total], USERELATIONSHIP ( Calendrier[Date], Factures[date_emission] ) )
)
```

> Même motif pour toute mesure devant suivre le sélecteur.

---

## 2. Le bandeau KPI (votre bloc vert)

Une carte par indicateur, sur **deux lignes** : ADV à gauche, Recouvrement à droite.

| | ADV (pas recouvrement) | En recouvrement |
|---|---|---|
| **Nombre de factures** | `[Nb factures ADV]` | `[Nb factures Recouvrement]` |
| **Montant** | `[Encours ADV]` | `[Encours Recouvrement]` |
| **Nb recouvré** | `[Nb payées ADV]` | `[Nb payées Recouvrement]` |
| **Montant recouvré** | `[Montant payé ADV]` | `[Montant payé Recouvrement]` |

Au-dessus, en pleine largeur : `[Nb factures créées]`.
En dessous : `[DSO]` et `[Retard moyen pondéré]`.

---

## 3. La matrice « Encours » et « Payée » ⭐

Vos deux blocs oranges = **le même visuel**, filtré différemment.

```
                      ┌──── ADV ────┐  ┌─ RECOUVREMENT ─┐  ┌──── TOTAL ────┐
  CATÉGORIE            Nb    Montant    Nb     Montant     Nb     Montant
  ─────────────────────────────────────────────────────────────────────────
  ADV                   …        …       …         …        …         …
  OPCO                  …        …       …         …        …         …
  Financement personnel …        …       …         …        …         …
  CPF                   …        …       …         …        …         …
  Région                …        …       …         …        …         …
  Transition Pro        …        …       …         …        …         …
  AIF                   …        …       …         …        …         …
  POEI                  …        …       …         …        …         …
  Recouvrement corporate…        …       …         …        …         …
  ─────────────────────────────────────────────────────────────────────────
  TOTAL                 …        …       …         …        …         …
```

**Construction — un seul visuel Matrice :**
- **Lignes** : `sous_categorie`
- **Colonnes** : `perimetre` (ADV / Recouvrement)
- **Valeurs** : `[Nb factures]` et `[Encours total]`
- Totaux ligne et colonne activés → vos lignes « total ADV » et « TOTAL
  recouvrement » sont **automatiques**

**Encours vs Payée** : deux options, au choix.
1. **Deux pages** (Encours / Payée), chacune avec un filtre au niveau de la page.
2. **Une page + un segment** `statut_paiement` (Non payée / Payée) — plus compact,
   et vous basculez d'un clic. *Recommandé.*

> ✅ Vos totaux se recalculent seuls à chaque filtre. Plus de formules à
> maintenir ligne par ligne.

---

## 4. Les pourcentages (bas de votre schéma)

Mêmes mesures, affichées dans une seconde matrice `sous_categorie` × %.

| Votre libellé | Mesure |
|---|---|
| % facture payée / non payée ADV par catégorie | `[% payées]` filtré `perimetre = "ADV"` |
| % facture payée / non payée recouvrement par catégorie | `[% payées]` filtré `perimetre = "Recouvrement"` |
| % bad debt par catégorie | `[Taux de facture Bad Debt]` |
| % bad debt payée par catégorie | `[Taux Bad Debt recouvrée]` |

> Le filtre ADV / Recouvrement vient des **colonnes** de la matrice : une seule
> mesure `[% payées]` suffit pour les deux lignes de votre schéma.

---

## 5. Les variations (dernière ligne)

| Votre libellé | Mesure |
|---|---|
| Variation délai de paiement | `[Variation DSO]` (en jours, signée) |
| Variation DSO sur date sélectionnée | `[Variation DSO %]` + `[Tendance DSO]` |

Affichage conseillé : une **carte** avec `[DSO]` en valeur principale et
`[Variation DSO]` en dessous, colorée par `[Couleur variation DSO]`
(vert = s'améliore, rouge = se dégrade).

---

## 6. Ce que vous gagnez sur votre version Sheets

| Sheets aujourd'hui | Power BI |
|---|---|
| 9 catégories × 4 blocs × 2 mesures **écrites à la main** | 1 matrice, totaux automatiques |
| 6 listes déroulantes pour choisir une période | 1 segment « Entre » |
| Ajouter une catégorie = ajouter des lignes partout | Elle apparaît **toute seule** |
| Chiffres figés à la dernière mise à jour | Rafraîchis chaque matin |
| Aucun moyen de voir le détail d'une case | Clic droit → *Extraire* → les factures |

---

## 7. Ordre de construction conseillé

1. Segments (période, mois, date pilote, périmètre) — *15 min*
2. Bandeau KPI — *20 min*
3. **La matrice** (le cœur) — *15 min*
4. Matrice des % — *10 min*
5. Cartes de variation DSO — *10 min*

> Commencez par **la matrice** si vous manquez de temps : elle porte à elle
> seule les deux tiers de votre schéma.

---

## 8. Contrôle de couverture — votre schéma est le MINIMUM

Chaque élément de votre wireframe, et où il se trouve dans le nouveau rapport.

| Votre schéma | Couvert par | ✓ |
|---|---|---|
| Mois pris en compte (clic multiple) | Segment `Calendrier[Année-Mois]`, sélection multiple | ✅ |
| Plage de date (de … à …) | Segment `Calendrier[Date]`, mode *Entre* | ✅ |
| Date prise = facture / début / fin de formation | Table `DatePilote` + `USERELATIONSHIP` | ✅ |
| Nombre de facture créée | `[Nb factures créées]` | ✅ |
| Nb facture ADV / en recouvrement | `[Nb factures ADV]` · `[Nb factures Recouvrement]` | ✅ |
| Montant facture ADV / en recouvrement | `[Encours ADV]` · `[Encours Recouvrement]` | ✅ |
| Nb de facture recouvré ADV / recouvrement | `[Nb payées ADV]` · `[Nb payées Recouvrement]` | ✅ |
| Montant recouvré ADV / recouvrement | `[Montant payé ADV]` · `[Montant payé Recouvrement]` | ✅ |
| DSO · retard moyen | `[DSO]` · `[Retard moyen pondéré]` | ✅ |
| Facture encours par catégorie (nb + montant) | Matrice §3, segment *Non payée* | ✅ |
| Facture payée par catégorie (nb + montant) | Même matrice, segment *Payée* | ✅ |
| Totaux ADV / recouvrement / général | Totaux automatiques de la matrice | ✅ |
| % facture payée / non payée par catégorie | `[% payées]` · `[% non payées]` | ✅ |
| % bad debt par catégorie | `[Taux de facture Bad Debt]` | ✅ |
| % bad debt payée par catégorie | `[Taux Bad Debt recouvrée]` | ✅ |
| Variation délai de paiement | `[Variation DSO]` | ✅ |
| Variation DSO sur date sélectionnée | `[Variation DSO %]` · `[Tendance DSO]` | ✅ |

### Et ce qui vient en plus

| Ajout | Pourquoi |
|---|---|
| **Balance âgée** (Non échu → > 48 mois) | Voir *où* le retard se concentre |
| **Exploration par clic** | Descendre d'une tranche jusqu'à la facture |
| **Factures manquantes sur Monday** | Sellsy révèle celles jamais mises en suivi |
| **Factures mal rangées** | En retard mais encore côté ADV |
| **DSO médian, 3 mois glissants, année précédente** | Le DSO moyen seul se laisse tromper par quelques dossiers extrêmes |
| **Doublons neutralisés** | 3 831 lignes en double retirées automatiquement |
| **Rafraîchissement quotidien** | Plus aucune manipulation |
