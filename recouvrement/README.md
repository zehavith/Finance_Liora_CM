# Liora — Suivi Recouvrement

Application web de pilotage du recouvrement, alimentée par les tableaux
**Monday.com** de Liora. Elle reprend la structure et le thème de
[Suivi Cash](../README.md) : filtre de période, vue d'ensemble, graphiques,
table détaillée et exports.

> Application 100 % navigateur, sans serveur ni build. Les données restent
> sur le poste (IndexedDB) ; la seule sortie réseau est l'appel à l'API Monday.

## Lancer l'application

**Double-cliquer sur `Lancer Suivi Recouvrement.bat`** (Windows) ou
`Lancer Suivi Recouvrement.command` (Mac). Le navigateur s'ouvre sur
l'application ; laisser la fenêtre noire ouverte pendant l'utilisation, la
fermer pour quitter.

Le lanceur démarre un petit serveur web local, uniquement sur le poste — rien
n'est publié sur Internet. C'est ce qui permet à la **connexion Monday** de
fonctionner : les navigateurs refusent les appels réseau depuis une page
ouverte en `file://`.

Le serveur sert aussi Suivi Cash, sur <http://localhost:8777/>.

### Sans le lanceur

Ouvrir `recouvrement/index.html` en double-clic fonctionne également : tous
les calculs, l'import Excel / CSV, les graphiques et les exports marchent. Seule
la connexion à l'API Monday est refusée ; l'application le signale dès l'accueil.

Si le lanceur annonce que Python et Node.js sont introuvables, il bascule
automatiquement en ouverture directe. Pour retrouver la connexion Monday,
installer [Python](https://www.python.org/downloads/) en cochant *Add Python to
PATH*, puis relancer.

## Ce que l'application répond

| Question | Où |
|---|---|
| Quel est mon encours en retard, en euros et en nombre ? | Tableau de bord — Vue d'ensemble |
| Quel % de factures est en recouvrement, par mois ? | Tableau de bord — *Taux de recouvrement par mois* |
| Le même %, croisé par type de financement ? | Tableau de bord — carte thermique *% par mois et par financement* |
| Combien y a-t-il en tout, dont combien en recouvrement ? | Tableau de bord — *Montants : hors recouvrement / en recouvrement* |
| Quelle part rentre sans passer par le recouvrement ? | Tableau de bord — bandeau *Récupération des factures échues* |
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
4. L'import d'un **extrait de grand livre lettré** (onglet *Données*) apporte
   les dates de règlement réelles, rapprochées sur le numéro de facture.

### Grand livre lettré

Deux modes, réglables dans *Données → Options de calcul* :

- **par défaut** — le grand livre ne comble que les dates absentes de Monday.
  Ce qui est déjà saisi est respecté ; les factures sans date réelle passent de
  la date de contrôle paiement à la date comptable, ce qui corrige le retard
  surestimé.
- **le grand livre fait foi** — les dates comptables remplacent aussi celles de
  Monday lorsqu'elles diffèrent. La date Monday d'origine reste visible dans la
  fiche de la facture.

Dans les deux cas, l'origine de chaque date est traçable : marqueur **GL** dans
la colonne *Paiement*, ligne « Date retenue pour le retard » dans la fiche, et
compte-rendu du rapprochement dans l'historique des imports.

## Indicateurs de recouvrement

Deux taux, complémentaires :

- **% en recouvrement (à date)** — part du portefeuille actuellement en retard.
  Réponse à « où en suis-je aujourd'hui ».
- **% cohorte échue** — sur les factures arrivées à échéance dans le mois, part
  de celles qui ont été payées en retard *ou* restent impayées. Réponse à
  « comment se comporte une génération de factures », indépendamment de
  l'ancienneté du mois.

### Répartition des montants

Le tableau *Montants — hors recouvrement / en recouvrement* décompose le
portefeuille en deux blocs qui s'additionnent exactement :

- **En recouvrement** — factures échues et impayées ;
- **Hors recouvrement** — tout le reste : réglé, non échu, ou échéance non
  calculable. Le détail apparaît en info-bulle.

Les colonnes portent le **montant facturé** afin qu'elles s'additionnent ;
l'encours restant dû, utile pour les factures partiellement réglées, est en
info-bulle de la colonne *En recouvrement*.

L'arbre se déplie sur deux niveaux, au choix : *Périmètre › Financement*,
*Financement › Tableau*, *Tableau › Groupe* ou *Mois › Financement*. Un clic sur
la flèche déplie, un clic sur la ligne bascule vers l'onglet *Factures* avec les
filtres correspondants déjà posés — y compris ceux du niveau parent. Les tuiles
du bandeau *Récupération* sont également cliquables.

L'export Excel contient un onglet *Répartition* reprenant l'arbre à plat.

### Graphiques du tableau de bord

| Graphique | Lecture |
|---|---|
| **Taux de recouvrement par mois** | barres empilées par issue + courbes de taux |
| **Flux de recouvrement** | entrées et sorties de part et d'autre de zéro, courbe de l'encours en retard à la fin de chaque mois |
| **Où se concentre l'encours** | treemap, dimension au choix : financement, client, tableau, groupe, propriétaire |
| **Encours par financement** | barres horizontales |
| **Balance âgée** | anneau par tranche d'antériorité |
| **Encours par propriétaire** | barres horizontales — charge de relance |
| **Structure du portefeuille** | double anneau : état à l'extérieur, périmètre à l'intérieur |
| **% par mois et financement** | carte thermique |
| **Évolution du retard moyen** | trois courbes en jours : retard moyen et médian de l'encours, écart au règlement |
| **DSO** | barres d'encours client + courbe du délai de règlement en jours (count-back ou simple) |
| **Répartition des retards** | histogramme par tranche, impayées contre finalement encaissées |
| **Antériorité par mois** | barres empilées (onglet *Balance âgée*) |

Tous sont cliquables et posent le filtre correspondant.

Le **flux de recouvrement** répond à « est-ce que je gagne ou perds du terrain » :
les entrées sont les factures devenues échues sans être réglées, les sorties les
factures en retard encaissées dans le mois. Le stock de fin de mois est recalculé
à chaque date plutôt que cumulé, afin de rester juste quand une facture entre et
sort dans le même mois.

### DSO

Le DSO est calculé mois par mois, sur l'encours client complet — factures
émises et non réglées à la fin du mois, échues ou non, comme le veut la
définition. Deux méthodes sont proposées :

- **count-back** (par défaut) — l'encours de fin de mois est épuisé contre le
  chiffre d'affaires des mois précédents, en comptant les jours. C'est la
  méthode du credit management, stable même quand la facturation est
  irrégulière. Quand l'encours est plus ancien que l'historique chargé, le
  calcul est marqué non concluant plutôt qu'approximé.
- **simple** — encours de fin de mois ÷ chiffre d'affaires du mois, ramené au
  nombre de jours du mois. Plus lisible, mais très sensible à un mois de
  facturation creux.

Afficher les deux ensemble rend visible l'écart, qui signale précisément les
mois où la méthode simple est trompeuse.

### Répartition des retards

L'histogramme sépare, pour chaque tranche de retard, ce qui est **encore
impayé** de ce qui a **fini par rentrer**. La comparaison des deux séries dit si
les créances anciennes finissent par être recouvrées ou si elles s'enkystent :
une seconde série qui s'éteint au-delà de 60 jours signifie qu'au-delà de ce
seuil, plus rien ne rentre. Un clic sur une tranche filtre les factures.

### Récupération

Le bandeau *Récupération des factures échues* répartit les factures arrivées à
échéance en trois postes qui totalisent 100 %, en euros ou en nombre :

- **Réglé sans recouvrement** — encaissé avant l'échéance, la facture n'a jamais
  été en retard.
- **Récupéré en retard** — encaissé, mais après l'échéance.
- **Reste à recouvrer** — échu et toujours impayé.

Une quatrième tuile, **Payé hors circuit recouvrement**, lit le processus plutôt
que la date : le tableau des factures payées conserve le groupe d'où venait la
facture au moment du règlement. Un groupe mentionnant le recouvrement, une
relance, une mise en demeure ou un contentieux compte comme passé par le
recouvrement ; les autres non. Cette tuile n'a de sens que si la colonne
« Groupe » du tableau 0.1 est renseignée — sinon elle le signale, et le nombre
de factures sans origine connue est affiché.

Le même taux est décliné par type de financement, colonne *% sans recouv.* de
l'onglet *Financements*, et repris dans l'export Excel.

Retards : moyen, médian, maximum, **pondéré par l'encours** (un gros impayé
ancien pèse plus qu'un petit), et **retard moyen au paiement** mesuré sur les
factures déjà réglées.

## Structure

```
Lancer Suivi Recouvrement.bat      Lanceur Windows (serveur local + navigateur)
Lancer Suivi Recouvrement.command  Lanceur macOS / Linux
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
