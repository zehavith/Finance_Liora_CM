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

## Installer en application de bureau

Deux façons, cumulables.

**Raccourci sur le Bureau** — double-cliquer une fois sur
`Creer le raccourci bureau.bat`. Une icône Liora « Suivi Recouvrement »
apparaît sur le Bureau et lance l'application.

**Application installée** — une fois l'application ouverte dans Edge ou Chrome,
cliquer sur l'icône d'installation dans la barre d'adresse (ou menu ⋯ →
*Applications* → *Installer ce site en tant qu'application*). Elle s'ouvre alors
dans sa propre fenêtre, sans barre de navigateur, avec son icône, et peut être
épinglée à la barre des tâches. Le serveur local doit tourner : garder le
lanceur ouvert.

## Actualisation depuis Monday

Trois moments, réglables dans *Données → Options de calcul* :

- **au clic** sur *Actualiser*, à tout moment ;
- **à l'ouverture** de l'application, en arrière-plan — sauté si les données ont
  moins d'un quart d'heure, pour ne pas solliciter Monday inutilement ;
- **à intervalle régulier** tant que l'application reste ouverte : 15 minutes,
  30 minutes, une heure, trois heures, ou jamais. Par défaut 30 minutes.

Une facture ajoutée dans Monday apparaît donc au passage suivant, sans rien
cliquer. L'actualisation périodique se fait en arrière-plan sans interrompre le
travail en cours : les données affichées restent en place jusqu'au
remplacement, les filtres et la période sont conservés, et un échec reste
silencieux plutôt que de bloquer l'écran. Elle est suspendue quand l'onglet
n'est pas affiché.

La barre supérieure indique l'ancienneté des données — « Données de il y a
12 min » — et affiche un rouet pendant la récupération.

Il ne s'agit pas d'une notification en temps réel : Monday ne pousse rien vers
l'application, c'est elle qui interroge.

### Mise en veille pendant le chargement

Un chargement complet dure plusieurs minutes. Si le poste se met en veille
entre-temps, le navigateur est suspendu et la récupération s'arrête au milieu,
sans erreur visible — des tableaux restent à moitié chargés.

L'application demande donc elle-même au système de rester éveillé tant qu'elle
charge, et rend la main dès qu'elle a fini : il n'y a aucun réglage
d'alimentation à modifier. Le journal de chargement l'indique (« *Mise en veille
suspendue pendant le chargement* »).

Quand le navigateur ne le permet pas — page ouverte en `file://` plutôt que par
le lanceur, ou navigateur trop ancien — le journal le dit également, et il faut
alors laisser l'écran allumé le temps du chargement.

## Aide intégrée

Le bouton **Aide** de la barre supérieure affiche une phrase d'explication sous
chaque indicateur, chaque filtre et en tête de chaque onglet. Le réglage est
mémorisé d'une session à l'autre.

Le point de vocabulaire le plus souvent posé y est traité d'emblée : **en
recouvrement** qualifie une facture échue et impayée, où qu'elle se trouve dans
Monday — y compris côté ADV ou OPCO — et le **montant en retard** en est la
contrepartie en euros. Ce ne sont pas deux populations différentes, mais la même
mesurée en nombre et en euros.

Le vocabulaire a été simplifié : les indicateurs portent désormais le **montant
facturé**, et non l'encours restant dû. Deux chiffres pour une même facture
prêtaient à confusion ; le reste dû n'apparaît plus que dans la fiche d'une
facture partiellement réglée, et dans l'export Excel.

## Ce que l'application répond

| Question | Où |
|---|---|
| Quel est mon montant en retard, en euros et en nombre ? | Tableau de bord — Vue d'ensemble |
| Quel % de factures est en recouvrement, par mois ? | Tableau de bord — *Taux de recouvrement par mois* |
| Le même %, croisé par type de financement ? | Tableau de bord — carte thermique *% par mois et par financement* |
| Combien y a-t-il en tout, dont combien en recouvrement ? | Tableau de bord — *Montants : hors recouvrement / en recouvrement* |
| Quelle part rentre sans passer par le recouvrement ? | Tableau de bord — bandeau *Récupération des factures échues* |
| Quel est le retard moyen ? | Vue d'ensemble : moyen, médian, max, pondéré par le montant, et retard moyen constaté au paiement |
| Combien de factures en retard côté ADV ? Côté OPCO ? | Chips **Sources du retard** — activables séparément |
| Quelle est l'antériorité du reste à encaisser ? | Onglet *Balance âgée* |
| Par catégorie, combien de factures en retard, combien pas encore échues, et pour quels montants ? | Onglet *Financements* |
| Combien de doublons, de créances douteuses, de problématiques pré-échéance ? | Onglet *Qualifications* |
| Quels clients relancer en priorité ? | Tableau de bord — *Top clients en retard* |
| Combien d'abonnements GoCardless vont au bout sans incident ? | Onglet *Prélèvements* |
| Au bout de combien de temps un apprenant décroche ? | Onglet *Prélèvements* — courbe de survie |
| Mes données sont-elles fiables ? | Onglets *Data Quality* et *Prélèvements* |

## Règles de date d'échéance

Une facture est **en recouvrement** lorsque sa date d'échéance, **calculée
selon les règles de financement**, est dépassée à la date d'arrêté, et qu'elle
n'est pas réglée. Ni le tableau ni le groupe Monday où elle se trouve n'entrent
dans cette définition : seules comptent la date calculée et l'absence de
règlement. L'échéance est calculée à partir
du type de financement, selon le référentiel Liora :

| Type de financement | Règle |
|---|---|
| B2C-Entreprise / Corporate Alternance | Date de facture **+30 j** (repli : début de formation +30 j) |
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
| B2C-Perso / Perso-Alternance | Début / fin de formation (aucun délai) |
| CPF | Fin de formation +45 j |

**Les règles font foi.** L'échéance est toujours recalculée à partir du type de
financement, même quand Monday porte une date d'échéance : la date saisie est
parfois vide, parfois issue d'une colonne voisine, et une échéance fausse fausse
tout le reste. La case *Faire primer la date d'échéance saisie dans Monday*, dans
*Données → Options de calcul*, permet l'inverse si besoin.

Un écart de plus de 60 jours entre la date Monday et la date calculée est
signalé en Data Quality : c'est la signature d'une colonne mal reconnue.

Le référentiel écrit *BTC-Entreprise* là où Monday écrit *B2C - Entreprise* :
les deux graphies sont reconnues et désignent la même chose, un particulier dont
la formation est facturée à une entreprise.

### D'où vient le type de financement

Du plus fiable au plus approximatif, la première source renseignée l'emporte :

1. la colonne **Type de financement** ;
2. la colonne **Type de client** — « B2C - Entreprise » y désigne bien un
   financement ;
3. le libellé du **groupe** ;
4. le nom du **tableau** ;
5. la valeur par défaut attachée au rôle du tableau.

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

### De Monday au tableau de bord

Le nombre de factures affiché est inférieur au nombre de lignes présentes dans
Monday, pour deux raisons légitimes. Le bloc *De Monday au tableau de bord*,
en tête de l'onglet *Données*, rend la soustraction visible :

```
    Lignes récupérées depuis Monday et des fichiers
  − Doublons fusionnés          même numéro sur plusieurs tableaux
  − Groupes et tableaux de service
  = Factures analysées
```

Les **doublons fusionnés** sont le poste le plus important et le plus mal
compris : une facture présente à la fois sur un tableau opérationnel et sur le
tableau des factures payées est une seule facture, pas deux. C'est précisément
ce rapprochement qui permet de savoir qu'elle a été réglée.

Comparer la première ligne au nombre d'éléments qu'affiche Monday dit
immédiatement si des factures manquent réellement.

### Inventaire par tableau

Le bloc *Tableaux suivis* de l'onglet *Données* montre, pour chaque tableau, ce
que deviennent ses factures : combien Monday en annonce, combien ont été
récupérées, combien sont écartées comme groupes de service, combien entrent
dans les indicateurs, et comment elles se répartissent entre sans échéance, en
retard, non échues et payées.

La colonne **Manquantes** isole la seule perte réelle : *Sur Monday* moins
*Chargées*. Un zéro partout signifie que rien n'a été perdu à la récupération —
si le total analysé reste plus bas que prévu, l'écart vient des doublons
fusionnés ou des groupes de service, deux retraits volontaires, et non d'un
défaut de chargement.

C'est le premier endroit à regarder quand un chiffre paraît trop bas. Une
colonne *Sans échéance* élevée signale des colonnes de dates non reconnues sur
ce tableau : la correspondance se corrige juste en dessous. Un écart entre
*Sur Monday* et *Chargées* signale un chargement incomplet.

### Vérifier les doublons fusionnés

Le nombre de doublons fusionnés ne suffit pas à juger s'ils sont légitimes. La
ligne *Doublons fusionnés* de la chaîne de traitement est donc cliquable : elle
ouvre la liste des factures concernées, avec leur numéro, leur client, leur
montant et les tableaux d'où viennent les lignes — de quoi aller vérifier dans
Monday.

Le cas normal est une facture présente à la fois sur son tableau opérationnel et
sur *0.1. ALL - Factures payées*. Deux factures réellement distinctes portant le
même numéro seraient en revanche fusionnées à tort, et la règle de rapprochement
devrait alors être revue.

### Contrôle des colonnes associées

La reconnaissance automatique des colonnes se fait sur le nom, ce qui suffit la
plupart du temps mais peut se tromper : la colonne *Problématique Pré-échéance*
du tableau 1.1 contient le mot « échéance » sans être une date, et se retrouvait
associée à la date d'échéance — d'où des échéances et des retards aberrants.

Chaque association est désormais **vérifiée sur les valeurs réelles** avant
d'être retenue : une colonne candidate à un champ de date dont moins de la
moitié des valeurs se lisent comme des dates est rejetée, de même pour un champ
de montant dont les valeurs ne sont pas numériques. Le rejet est écrit dans le
journal de chargement (« *« Problématique Pré-échéance » écartée du champ date
d'échéance : ne contient pas de dates* ») et la colonne reste disponible dans la
liste déroulante si l'association était en réalité correcte.

Sur le tableau des factures payées, une valeur *Analysées* à zéro est normale :
ses lignes se rapprochent des factures des tableaux opérationnels et sont
comptées là-bas. Un chiffre non nul y désigne des factures réglées qui
n'existent nulle part ailleurs.

### Tableaux de sous-éléments

Monday crée automatiquement un tableau « Sous-éléments de … » pour chaque
tableau utilisant des sous-éléments. Ses lignes ne sont pas des factures : ces
tableaux reçoivent le rôle *Ignoré* et ne sont pas proposés au chargement.

### Étape de traitement

Chez Liora, « recouvrement » désigne un **groupe** autant qu'un tableau : le CPF
a son groupe *Factures CPF recouvrement*, le Financement Personnel ses groupes
*Recouvrement - En cours de traitement* et *Facture en Contentieux*, la
plateforme pôle emploi son *Factures en recouvrement*. S'en tenir au rôle du
tableau revenait à ne compter que le seul 1.2.

Chaque facture porte donc une **étape**, déduite du libellé de son groupe :
Contentieux, Perdu / partiel, À annuler, Recouvrement, Comptabilité, Paiement
prévu, Dépôt / déposée, ADV à traiter, En cours, ou Non qualifié. Le premier
motif reconnu l'emporte, du plus spécifique au plus général — un groupe
« Recouvrement - Contentieux » relève du contentieux.

L'étape est disponible comme dimension de la répartition des montants
(*Étape › Financement*) et du treemap, sert de filtre, et figure sur la fiche
de chaque facture.

### Groupes de service

Un tableau opérationnel héberge souvent des groupes qui ne sont pas du suivi :
le tableau ADV contient par exemple `1.1.9. Technique - Archive`,
`1.1.9. Technique - Tampon` et `1.1.9. Technique - Service recouvrement`,
soit plusieurs milliers de lignes closes. Les compter multiplierait les volumes
par dix et fausserait tous les taux.

Sont donc écartés les groupes dont le libellé contient *technique*, *archive*,
*corbeille*, *poubelle*, *obsolète*, *à supprimer*, *ne pas utiliser*, *test*,
*brouillon* ou *doublon* — en plus des tableaux dont le rôle est *Technique*.

L'onglet *Données* liste précisément ce qui est écarté, groupe par groupe, avec
le nombre de factures concernées : retirer des milliers de lignes sans le dire
serait aussi trompeur que de les compter. La case *Exclure les tableaux et les
groupes de service* permet de tout réintégrer pour vérifier.

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
   Quand elle figure à la fois sur le tableau des factures payées et sur un
   tableau opérationnel, **c'est la ligne de règlement qui fait référence** :
   une facture réglée qui traîne encore côté opérationnel reste une facture
   réglée, et un « reste dû » hérité de là-bas est une valeur périmée, donc
   ignorée. Le tableau d'origine reste indiqué sur la fiche de la facture.
2. **Trois sources font règlement**, et elles seules : la présence dans le
   tableau *0.1. ALL - Factures payées*, le lettrage dans le grand livre
   importé, et l'appartenance à un **groupe de comptabilité** — *En traitement
   Comptabilité*, *Pennylane non pointé*, *Paiement non remonté sur Sellsy* —
   quel que soit le tableau qui l'héberge. Ces derniers désignent des factures
   encaissées dont le règlement n'est pas encore rapproché : elles ne sont plus
   à recouvrer, mais n'ont pas de date de paiement et ne pèsent donc pas dans
   les délais. Data Quality les liste sous *Règlements en attente de
   rapprochement comptable* ; importer le grand livre leur donne leur vraie
   date.

   En revanche, une date de paiement, une date de contrôle, un statut
   « payée » ou un reste dû nul saisis sur un tableau opérationnel ne
   suffisent pas : ces colonnes se sont révélées trop peu fiables, au point de
   faire basculer la quasi-totalité du portefeuille en « payée ». Elles sont
   néanmoins relevées en Data Quality sous *Signes de règlement hors du tableau
   des factures payées* — si ces factures sont bel et bien encaissées, il manque
   leur ligne dans le 0.1.

   Sa présence dans *0.1. ALL - Factures payées* la marque réglée. La colonne
   **Groupe** de ce tableau est conservée comme groupe d'origine, ce qui permet
   de rattacher la facture à l'étape d'où elle venait au moment du règlement.
3. La date retenue est **Date paiement** (règlement réel). À défaut,
   **Date contrôle paiement** sert de repli : la facture porte alors le symbole
   **≈** et l'anomalie est listée en Data Quality, car cette date de validation
   est postérieure au règlement — le retard mesuré est donc majoré.
Un « reste dû » nul saisi sur un tableau opérationnel est ignoré de même : il
contredirait le fait que la facture est comptée comme due. Un reste dû positif,
lui, décrit un règlement partiel et fait foi.

4. L'import d'un **extrait de grand livre lettré** (onglet *Données*) apporte
   les dates de règlement réelles, rapprochées sur le numéro de facture.

### Grand livre lettré

**Le grand livre fait foi.** La comptabilité étant plus fiable que la saisie
manuelle, une date lettrée est toujours retenue : elle comble les dates absentes
de Monday et remplace celles qui divergent. La date Monday d'origine reste
consultable dans la fiche de la facture, mais n'entre plus dans les calculs.

L'origine de chaque date est traçable : marqueur **GL** dans
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

Les colonnes portent le **montant facturé** afin qu'elles s'additionnent ; le
reste dû, utile pour les factures partiellement réglées, est en info-bulle de la
colonne *En recouvrement*.

L'arbre se déplie sur deux niveaux, au choix : *Périmètre › Financement*,
*Financement › Tableau*, *Tableau › Groupe* ou *Mois › Financement*. Un clic sur
la flèche déplie, un clic sur la ligne bascule vers l'onglet *Factures* avec les
filtres correspondants déjà posés — y compris ceux du niveau parent. Les tuiles
du bandeau *Récupération* sont également cliquables.

L'export Excel contient un onglet *Répartition* reprenant l'arbre à plat.

### Le tableau par catégorie

L'onglet *Financements* répond à la question la plus fréquente — *par catégorie,
combien de factures sont en retard, combien ne sont pas encore échues, et pour
quels montants ?* Chaque ligne porte, pour un type de financement :

| Colonne | Contenu |
|---|---|
| **Factures** | nombre total, montant facturé en dessous |
| **En retard** | échues et impayées — nombre et montant, en rouge |
| **Pas encore échu** | échéance à venir — nombre et montant |
| **Réglé** | nombre et montant des factures payées |
| **Sans échéance** | non réglées, sans échéance calculable — ni en retard, ni à venir |
| **% en retard** | part du nombre de factures, avec la part en euros en dessous |
| **Retard moyen** | en jours, sur les seules factures en retard |

Chaque case porte le nombre en gros et le montant associé en dessous, de sorte
qu'une ligne se lit d'un seul coup d'œil.

Les quatre états s'excluent : une facture réglée dont l'échéance n'est pas
calculable compte comme réglée, et nulle part ailleurs. Leur somme redonne donc
exactement le nombre total de factures de la ligne, et une phrase sous le tableau
le vérifie à l'écran plutôt que de laisser refaire l'addition à la main.

Le pourcentage porte sur le **nombre** de factures, la part en euros étant
donnée en dessous. Les deux diffèrent parfois beaucoup, et sur un financement
dont les montants sont absents de Monday, seul le nombre a un sens — le tableau
le signale alors au lieu d'afficher un trompeur 0 %.

La ligne *Total* reprend l'ensemble du portefeuille filtré. Un clic sur une
ligne bascule vers l'onglet *Factures* avec le financement déjà filtré.

### Graphiques du tableau de bord

| Graphique | Lecture |
|---|---|
| **Taux de recouvrement par mois** | barres empilées par issue + courbes de taux |
| **Flux de recouvrement** | entrées et sorties de part et d'autre de zéro, courbe du montant en retard à la fin de chaque mois |
| **Où se concentre le retard** | treemap, dimension au choix : financement, client, tableau, étape, groupe |
| **Montant en retard par financement** | barres horizontales |
| **Balance âgée** | anneau par tranche d'antériorité |
| **Structure du portefeuille** | double anneau : état à l'extérieur, périmètre à l'intérieur |
| **% par mois et financement** | carte thermique |
| **Évolution du retard moyen** | trois courbes en jours : retard moyen et médian des factures en retard, écart au règlement |
| **DSO** | barres du reste à encaisser + courbe du délai de règlement en jours (count-back ou simple) |
| **Répartition des retards** | histogramme par tranche, impayées contre finalement encaissées |
| **Antériorité par mois** | barres empilées (onglet *Balance âgée*) |

Tous sont cliquables et posent le filtre correspondant.

Le **flux de recouvrement** répond à « est-ce que je gagne ou perds du terrain » :
les entrées sont les factures devenues échues sans être réglées, les sorties les
factures en retard encaissées dans le mois. Le stock de fin de mois est recalculé
à chaque date plutôt que cumulé, afin de rester juste quand une facture entre et
sort dans le même mois.

### DSO

Le DSO est calculé mois par mois, sur le reste à encaisser complet — factures
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

### Où en est le portefeuille

Le bandeau répartit **toutes** les factures — échues ou non — en postes qui
totalisent 100 %, en euros ou en nombre :

- **Réglé avant l'échéance** — rentré tout seul, la facture n'est jamais tombée
  en recouvrement.
- **Réglé en recouvrement** — tombée en recouvrement, puis finalement encaissée.
- **Reste à recouvrer** — en recouvrement à ce jour, toujours impayée.
- **Pas encore échu** — facturé, échéance à venir : les encaissements attendus.
- **Échéance inconnue**, si le cas se présente — dates manquantes dans Monday,
  hors de tous les taux.

Le non-échu figure ici pour la lecture trésorerie : sans lui, le bandeau ne
montrait que le passé et taisait ce qui doit rentrer. La somme des montants des
tuiles égale exactement le total facturé.

Chaque tuile est cliquable et ouvre les factures correspondantes.

Une quatrième mesure, **Jamais passé par le recouvrement**, lit le processus
plutôt que la date. Elle n'est pas affichée sur le tableau de bord — sa base
diffère de celle des trois tuiles, ce qui prêtait à confusion — mais reste
calculée et figure dans l'onglet *Synthèse* de l'export Excel. Son principe : le tableau des factures payées conserve le groupe d'où venait la
facture au moment du règlement. Un groupe mentionnant le recouvrement, une
relance, une mise en demeure ou un contentieux compte comme passé par le
recouvrement ; les autres non. Cette tuile n'a de sens que si la colonne
« Groupe » du tableau 0.1 est renseignée — sinon elle le signale, et le nombre
de factures sans origine connue est affiché.

Le même taux est décliné par type de financement, colonne *% avant échéance* de
l'onglet *Financements*, et repris dans l'export Excel.

Retards : moyen, médian, maximum, **pondéré par le montant** (un gros impayé
ancien pèse plus qu'un petit), et **retard moyen au paiement** mesuré sur les
factures déjà réglées.

## Qualifications

Les tableaux Monday portent, en plus des dates et des montants, des colonnes de
qualification propres à chaque périmètre : *qualification recouvrement* sur le
tableau 1.2, *problématique pré-échéance* sur le 1.1, une qualification
spécifique sur le 2.1 B2C - Financement personnel, et ainsi de suite. Ces
colonnes ne servent pas au calcul du retard — l'échéance seule en décide — mais
elles disent *pourquoi* une facture est là.

L'onglet *Qualifications* les inventorie sans les avoir configurées : toute
colonne de type statut, couleur ou liste déroulante non déjà utilisée pour un
autre usage est capturée telle quelle, avec ses valeurs.

- L'**inventaire** liste, tableau par tableau, chaque colonne de qualification,
  le nombre de factures renseignées et le nombre de valeurs distinctes.
- Le **détail d'une colonne** donne la répartition en nombre, en pourcentage et
  en euros : combien de *doublon*, combien de *litige*, combien de *relance
  envoyée*. Un clic sur une valeur ouvre les factures concernées.
- Les **créances douteuses** sont comptées à part : factures des étapes
  *Contentieux* et *Perte*, en nombre et en montant.

Ces statistiques suivent les filtres de la barre supérieure — période, périmètre,
tableau — comme le reste de l'application.

## Prélèvements GoCardless

Onglet indépendant du suivi des factures : il analyse les échéanciers de
prélèvement des apprenants B2C.

### Exports à fournir

Déposer les exports du tableau de bord GoCardless — ils sont reconnus à leurs
colonnes, l'ordre n'importe pas.

| Export | Rôle |
|---|---|
| **Payments** | indispensable — une ligne par prélèvement : échéance, montant, statut, motif de rejet |
| **Customers** | indispensable — e-mail, prénom, nom |
| **Subscriptions** | utile — date de début, périodicité, nombre d'échéances |
| **Mandates** | utile — relie prélèvement et apprenant si Payments ne le fait pas |

Sans *Customers*, les apprenants sont regroupés sur l'identifiant GoCardless et
une même personne inscrite deux fois compte double ; l'application le signale.

### Identité de l'apprenant

L'**e-mail normalisé** fait foi. À défaut, repli sur **prénom + nom** normalisés,
sans accents ni casse. Ce repli peut confondre deux homonymes : les apprenants
concernés sont comptés et listés dans *Fiabilité de l'analyse*, avec les noms
portés par plusieurs apprenants.

### Statuts

Un prélèvement `confirmed` ou `paid_out` est encaissé, `failed` ou
`charged_back` est un **rejet**, `cancelled` est retiré avant présentation et
n'entre donc pas dans le taux de rejet.

### Indicateurs

- **Abonnements sans incident** — apprenants n'ayant jamais eu de rejet.
- **Délai avant le premier incident** — médiane et moyenne, en jours, plus le
  rang du prélèvement concerné.
- **Taux de rejet** — rejets rapportés aux prélèvements présentés.
- **Incidents rattrapés** — apprenants repartis durablement, c'est-à-dire sans
  aucun rejet sur leurs trois derniers prélèvements présentés. Un simple
  encaissement après l'incident ne suffit pas à le dire.
- **Montant à risque** — rejets non rattrapés et prélèvements encore en vol.

### Courbe de survie

La courbe donne la part d'apprenants n'ayant encore connu aucun rejet, mois
après mois depuis leur premier prélèvement, par **estimateur de Kaplan-Meier**.
Un apprenant entré il y a deux mois est observé deux mois puis « censuré » :
il ne compte pas comme survivant à douze mois. Sans cette correction, les
inscriptions récentes gonfleraient artificiellement le taux de tenue.

### Montants

Les exports du tableau de bord GoCardless sont libellés en euros décimaux.
Si un fichier présente des montants tous entiers et anormalement élevés, ils
sont lus comme des centimes et l'hypothèse est affichée en clair — jamais
appliquée en silence.

## Data Quality

L'onglet distingue deux familles.

**Ce qui n'est pas arrivé jusqu'à l'application** — le plus dangereux, puisque
ces factures ne se voient nulle part ailleurs :

- *Tableaux dont le chargement a échoué*, avec le message d'erreur de chacun.
  Un tableau en échec n'interrompt plus les autres : le chargement se poursuit
  et l'échec est signalé, plutôt que de laisser un écran vide sans explication.
- *Factures annoncées par Monday mais non importées*, quand le nombre récupéré
  est inférieur au nombre annoncé par le tableau.
- *Tableaux cochés mais jamais chargés*.
- *Lignes importées sans aucune donnée exploitable* — ni numéro, ni montant, ni
  date.

**Pourquoi les factures sont considérées comme réglées** — le récapitulatif des
critères ayant conclu au règlement, du plus fréquent au moins fréquent :
présence dans le tableau des factures payées, date de paiement, date de
contrôle paiement, statut Monday, reste dû nul. Au-delà de 95 % de factures
réglées, l'anomalie passe en gravité haute : un tel taux est rarement réel, et
le motif majoritaire désigne alors la colonne mal associée.

**Ce qui est arrivé mais reste incomplet** — échéance non calculable, type de
financement absent, montant nul, paiement sans date, doublons entre tableaux,
retards de plus d'un an, factures échues restées côté ADV.

Chaque anomalie porte le nombre concerné, le détail quand il s'agit de
tableaux, et l'accès aux factures quand il s'agit de factures. Le score de
fiabilité ne tient compte que des secondes : un tableau non chargé n'est pas un
défaut de qualité mais un incident de récupération, et il se corrige d'un clic.

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
js/metrics.js       Calculs : taux, retards, balance âgée, qualifications, qualité
js/prelevements.js  Analyse GoCardless : apprenants, survie, incidents
js/ui.js            Formatage, tables, graphiques, modale, notifications
```

Les librairies (Chart.js, PapaParse, SheetJS) et le logo sont partagés avec
Suivi Cash via `../vendor/` et `../Liora_Logo_Orange_alpha.png`.

## Confidentialité

Le jeton API Monday et les factures récupérées sont stockés dans IndexedDB,
sur le poste uniquement. « Oublier le jeton » et « Tout effacer » sont
disponibles dans l'onglet *Données*.
