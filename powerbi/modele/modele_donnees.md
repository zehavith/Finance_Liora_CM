# Modèle de données — consolidation par n° de facture

Rôle de chaque source (validé avec l'équipe) :

| Source | Rôle | Ce qu'on en tire |
|--------|------|------------------|
| **Sellsy** | Référentiel des factures **émises** | Liste complète → détecte les **factures manquantes sur Monday** |
| **Monday** | Suivi opérationnel des factures | Statut de relance, responsable, dates de relance |
| **Pennylane** | **Vérité sur le paiement** | Reste dû, statut payé/impayé, échéance |

## Chaîne des requêtes (Power Query)

```
  Sellsy_Factures ─────┐   (staging, chargement désactivé)
  Pennylane_Paiements ─┼──►  Factures  ──►  (table de faits chargée)
  Monday_Suivi ────────┘        │
                                │  fusion par "cle" = n° de facture normalisé
  Calendrier ───────────────────┘   (dimension temps)
```

- Les 3 requêtes de staging (`Sellsy_Factures`, `Pennylane_Paiements`,
  `Monday_Suivi`) : **clic droit > décocher « Activer le chargement »**.
  Elles alimentent uniquement la fusion.
- Seules **`Factures`** et **`Calendrier`** sont chargées dans le modèle.

## Pourquoi une table consolidée (et pas un schéma en étoile classique)

Les trois sources décrivent le **même objet** (une facture) sous 3 angles. Les
réunir en une seule ligne par facture, clé = numéro, permet :

1. de savoir en un coup d'œil, pour chaque facture, **payée ? à jour ? en
   recouvrement ? suivie sur Monday ?** ;
2. de calculer la couverture Sellsy → Monday (**factures manquantes**) par simple
   flag `present_monday` ;
3. d'éviter les pièges de relations multiples (ambiguïté de filtre) sur un n° de
   facture partagé.

## Relations à créer (onglet *Modèle*)

| De (dimension)     | Vers (faits)                 | Cardinalité | Filtre | Active |
|--------------------|------------------------------|-------------|--------|--------|
| `Calendrier[Date]` | `Factures[date_echeance]`    | 1 → *       | Simple | ✅ Oui |
| `Calendrier[Date]` | `Factures[date_emission]`    | 1 → *       | Simple | ❌ Non (relation inactive, pour `USERELATIONSHIP` si besoin) |

Le reste (client, statut relance, présence Monday) est **déjà dans `Factures`** →
aucune autre relation nécessaire.

## Clé de réconciliation `cle`

Chaque requête de staging produit une colonne `cle` =
`Text.Upper(Text.Trim(numero))`. Pour que les fusions matchent, le **n° de
facture doit être identique** dans les 3 outils (mêmes préfixes, mêmes zéros).

- Si Monday stocke le n° dans une colonne « N° facture » : parfait.
- Si Monday n'a pas ce champ, le connecteur retombe sur le **nom de l'item**
  (à adapter). Idéalement, ajoutez une colonne « N° facture » sur le tableau.
- Si les formats diffèrent (ex. `FAC-0012` vs `FAC12`), normalisez dans le `.pq`
  concerné (ex. `Text.Remove([numero], {"-"," "})`).

## Marquage de la table de dates

*Modèle > clic droit sur `Calendrier` > Marquer comme table de dates* (colonne
`Date`). Indispensable pour le DSO et les analyses temporelles.

## Colonnes à masquer en vue rapport

`cle`, `present_pennylane`, `statut_pennylane` (technique) — clic droit > *Masquer*.
