# Liora — Suivi Recouvrement

Application web de pilotage du recouvrement, alimentée par les tableaux
**Monday.com** de Liora. Elle reprend la structure et le thème de
[Suivi Cash](../README.md) : filtre de période, vue d'ensemble, graphiques,
table détaillée et exports.

> Application 100 % navigateur, sans serveur ni build. Les données restent
> sur le poste (IndexedDB) ; la seule sortie réseau est l'appel à l'API Monday.

## Lancer l'application

Ouvrir `recouvrement/index.html` dans un navigateur moderne.

Pour utiliser le connecteur Monday, il faut servir la page depuis un serveur
web plutôt que par double-clic : les navigateurs bloquent les appels réseau
depuis une page ouverte en `file://`. Depuis le dossier du dépôt :

```
npx http-server -p 8080      # puis http://localhost:8080/recouvrement/
```

L'import de fichiers Excel / CSV fonctionne, lui, en `file://`.

## Ce que l'application répond

| Question | Où |
|---|---|
| Quel est mon encours en retard, en euros et en nombre ? | Tableau de bord — Vue d'ensemble |
| Quel % de factures est en recouvrement, par mois ? | Tableau de bord — *Taux de recouvrement par mois* |
| Le même %, croisé par type de financement ? | Tableau de bord — carte thermique *% par mois et par financement* |
| Quel est le retard moyen ? | Vue d'ensemble : moyen, médian, max, pondéré par l'encours, et retard moyen constaté au paiement |
| Combien de factures en retard côté ADV ? Côté OPCO ? | Chips **Sources du retard** — activables séparément |
| Quelle est l'antériorité de l'encours ? | Onglet *Balance âgée* |
| Quels clients relancer en priorité ? | Tableau de bord — *Top clients en retard* |
| Mes données sont-elles fiables ? | Onglet *Data Quality* |

## Règles de date d'échéance

Une facture est **en recouvrement** lorsque sa date d'échéance est dépassée à
la date d'arrêté et qu'elle n'est pas réglée. L'échéance est calculée à partir
du type de financement, selon le référentiel Liora :

| Type de financement | Règle |
|---|---|
| BTC-Entreprise / Corporate Alternance | Date de facture **+30 j** (repli : début de formation +30 j) |
| B2B | Fin de formation +30 j |
| Alternance | Fin de formation +30 j |
| Transition pro | Fin de formation +60 j |
| REGION | Fin de formation +60 j |
| AIF | Fin de formation +60 j |
| POEI | Fin de formation +60 j |
| Agefiph | Fin de formation +60 j |
| Etat | Fin de formation +30 j |
| Interco | Fin de formation +60 j |
| Interne - DST Allemagne | Fin de formation +60 j |
| OPCO | Fin de formation +30 j — *pas de recouvrement, suivi du retard uniquement* |
| BTC-Perso / Perso-Alternance | Début / fin de formation (aucun délai) |
| CPF | Fin de formation +45 j |

Ces règles sont **modifiables dans l'application** (onglet *Financements* →
« Modifier les règles ») et conservées sur le poste. Quand Monday fournit
déjà une date d'échéance, elle est utilisée en priorité — comportement
désactivable dans l'onglet *Données*.

Chaque facture indique la règle qui l'a calculée : dans la table, le symbole
**ƒ** à côté de l'échéance ouvre l'info-bulle ; la fiche détaillée (clic sur
une ligne) explique le calcul complet.

## Rôles des tableaux Monday

Le rôle est déduit du nom du tableau, et reste modifiable dans l'onglet
*Données*. Il détermine le périmètre, la source de retard et le financement
par défaut des factures dont la colonne est vide.

| Rôle | Tableaux | Effet |
|---|---|---|
| `payees` | 0.1. ALL - Factures payées | Source de vérité du règlement, rapprochée par numéro de facture |
| `tampon` | 1.0. Entreprise - Tampon | Corporate, compté dans la source *ADV / Tampon* |
| `adv` | 1.1. Entreprise - ADV | idem |
| `recouvrement` | 1.2. Entreprise - Recouvrement | Corporate, source *Recouvrement* |
| `opco` | 1.3. Entreprise - OPCO | Corporate, source *OPCO*, financement OPCO par défaut |
| `b2c` | 2.1 à 2.4 | B2C, financement déduit du tableau (CPF, AIF, Personnel…) |
| `technique` | 1.9, 2.9 | Exclu des analyses |

### Circuit Tampon → ADV → Recouvrement

Une facture transite par le tampon, bascule en ADV, puis en recouvrement une
fois à échéance et l'ADV complet ; en cas de manque elle repart en ADV dans un
groupe distinct. L'application ne fige pas ce circuit : elle mesure le retard
partout, et les chips **Sources du retard** permettent d'isoler ou d'exclure
chaque étape. Un encart du tableau de bord signale les factures échues restées
côté ADV — celles qui devraient déjà être passées en recouvrement.

Pour l'**OPCO**, où il n'y a pas de recouvrement, le retard est mesuré et
affiché mais peut être exclu des indicateurs d'un clic.

Pour le **B2C**, il n'existe pas de tableau recouvrement : le retard est
déduit uniquement des dates et des règles d'échéance, conformément à la
demande. La colonne « qualification recouvrement » est lue mais n'entre dans
aucun calcul.

## Rapprochement des paiements

1. Une facture présente sur plusieurs tableaux est **dédoublonnée par numéro
   de facture** ; les champs vides d'une source sont complétés par les autres.
2. Sa présence dans *0.1. ALL - Factures payées* la marque réglée. La colonne
   **Groupe** de ce tableau est conservée comme groupe d'origine, ce qui permet
   de rattacher la facture à l'étape d'où elle venait au moment du règlement.
3. La date retenue est **Date paiement** (règlement réel). À défaut,
   **Date contrôle paiement** sert de repli : la facture porte alors le symbole
   **≈** et l'anomalie est listée en Data Quality, car cette date de validation
   est postérieure au règlement — le retard mesuré est donc majoré.
4. L'import d'un **extrait de grand livre pointé** (onglet *Données*) comble
   les dates de paiement manquantes par rapprochement sur le numéro de facture.

## Indicateurs de recouvrement

Deux taux, complémentaires :

- **% en recouvrement (à date)** — part du portefeuille actuellement en retard.
  Réponse à « où en suis-je aujourd'hui ».
- **% cohorte échue** — sur les factures arrivées à échéance dans le mois, part
  de celles qui ont été payées en retard *ou* restent impayées. Réponse à
  « comment se comporte une génération de factures », indépendamment de
  l'ancienneté du mois.

Retards : moyen, médian, maximum, **pondéré par l'encours** (un gros impayé
ancien pèse plus qu'un petit), et **retard moyen au paiement** mesuré sur les
factures déjà réglées.

## Structure

```
index.html          Écrans, onglets et barre de filtres
app.js              État, chargement, filtres, rendu, exports
styles.css          Compléments au design system de Suivi Cash
js/rules.js         Règles d'échéance, financements, rôles des tableaux
js/store.js         Persistance IndexedDB
js/monday.js        Client GraphQL Monday (API v2, pagination par curseur)
js/ingest.js        Détection des colonnes, normalisation, dédoublonnage
js/metrics.js       Calculs : taux, retards, balance âgée, qualité
js/ui.js            Formatage, tables, graphiques, modale, notifications
```

Les librairies (Chart.js, PapaParse, SheetJS) et le logo sont partagés avec
Suivi Cash via `../vendor/` et `../Liora_Logo_Orange_alpha.png`.

## Confidentialité

Le jeton API Monday et les factures récupérées sont stockés dans IndexedDB,
sur le poste uniquement. « Oublier le jeton » et « Tout effacer » sont
disponibles dans l'onglet *Données*.
