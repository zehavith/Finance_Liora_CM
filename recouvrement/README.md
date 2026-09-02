# Liora — Suivi Recouvrement

**Version 2.13.0** — 2 septembre 2026

Le numéro figure à côté du titre dans la barre supérieure, donc sur toute
capture d'écran, ainsi que dans l'onglet *Données* et dans l'onglet *Synthèse*
de l'export Excel. Il évite d'avoir à deviner quelle version tourne quand un
chiffre surprend.

Chaque fichier de l'application porte sa version dans son adresse
(`app.js?v=2.13.0`) : sans cela le navigateur resservait ses fichiers en cache et
une mise à jour pouvait sembler installée sans l'être. Si les deux ne
concordent pas, l'application le signale et invite à forcer le rechargement par
Ctrl + F5.

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

## Ce qui se recalcule sans recharger

Les factures récupérées sont conservées telles quelles ; les indicateurs, eux,
sont recalculés à chaque ouverture. Une correction du référentiel profite donc
aux données déjà en place, sans repasser par Monday :

- règles d'échéance, dates d'échéance, retards et états ;
- reconnaissance du type de financement, y compris depuis le libellé du groupe ;
- étapes du circuit, groupes de service écartés, sources du retard ;
- tranches de la balance âgée, DSO, tous les graphiques et tableaux.

Un rechargement reste nécessaire pour ce qui est lu **au moment de l'import** :
la correspondance des colonnes — donc les montants et les dates récupérés — les
colonnes de qualification, et le taux de remplissage mesuré par tableau. En
pratique : après une mise à jour touchant la lecture des colonnes, rechargez ;
après une mise à jour touchant les règles ou l'affichage, il suffit d'ouvrir
l'application.

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
| B2C-Perso / Perso-Alternance | Début de formation (aucun délai) |
| CPF | Fin de formation +60 j |

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

### Les groupes du tableau des factures payées

*0.1. ALL - Factures payées* range ses lignes dans des groupes qui disent
l'appartenance de la facture, et c'est souvent la seule information disponible :
une facture réglée avant la mise en place du circuit n'existe nulle part
ailleurs. Le libellé du groupe est donc lu comme type de financement.

Ces groupes se répartissent en deux familles :

- ceux qui **nomment un financement** — *Factures payées Opco*, *CPF*, *REGION*,
  *TRANSITION PRO*, *AGEFIPH*, *AIF*, *POEI*, *B2C* — d'où le financement se
  déduit directement ; *B2C* employé seul y désigne le financement personnel,
  les financements publics ayant chacun leur propre groupe ;
- ceux qui **nomment une étape du circuit corporate** — *Factures Payées ADV*,
  *Factures payées avant import + Entre process ADV et recouvrement* — qui ne
  disent pas le financement mais établissent le périmètre. Ces factures
  reçoivent le financement *Corporate — financement à préciser*, calculé sur la
  règle corporate par défaut (facture +30 jours), et sont listées en Data
  Quality : renseigner « Type de client » les répartirait entre B2B et
  B2C-Entreprise.

Le groupe *Factures non payées : Perte / Contentieux* contient le mot « payées »
sans rien devoir au règlement : la négation est vérifiée avant tout, et ces
factures sont classées en contentieux, non en réglées.

### Écarter les factures en tampon

Le **tampon** est le sas où la facture attend avant d'entrer dans le circuit :
ni l'ADV ni le recouvrement n'y touchent. Une facture qui s'y trouve encore, ou
qui a été réglée sans jamais en sortir, entre dans les totaux facturés et
encaissés alors qu'**aucune relance n'a été faite dessus**.

Le sélecteur **Factures en tampon** de la barre de filtres — *Incluses* /
*Exclues* — les retire de toute l'application : indicateurs, graphiques,
tableaux et export. La ligne d'aide indique combien de factures sont
concernées, et un badge rappelle le filtre tant qu'il est actif.

- **Incluses** (par défaut) : la photographie complète du portefeuille, telle
  qu'elle sort de Monday.
- **Exclues** : le travail réellement fourni par l'ADV et le recouvrement.

Le tampon est reconnu partout où la facture en a gardé la trace — le tableau où
elle est, celui d'où elle vient, son rôle, et les groupes traversés. Une facture
passée au tampon puis réglée ne porte plus que son groupe d'origine pour le
dire : la chercher uniquement sur le tableau courant en manquerait la moitié.

Les deux lectures sont justes ; c'est la question posée qui change.

### Corriger un financement à la main

Une facture réglée avant l'entrée dans le circuit ne porte parfois que son
groupe pour toute indication, et ressort en *Corporate — financement à
préciser*. Le financement se corrige alors dans l'application, sans toucher à
Monday :

- **une facture** — la ligne *Type de financement* de sa fiche est une liste
  déroulante ;
- **plusieurs d'un coup** — chaque ligne du tableau *Factures* porte une case à
  cocher. Dès qu'une case est cochée, une barre apparaît : nombre de factures
  retenues, choix du financement, *Appliquer*. Un bouton *Tout sélectionner*
  prend l'ensemble des factures affichées, filtres compris — filtrer sur
  *Corporate — financement à préciser* puis tout sélectionner traite la
  catégorie entière en trois clics.

La correction l'emporte sur toute déduction et précède le calcul de l'échéance :
c'est la règle du financement choisi qui s'applique. Elle est retenue **sur le
numéro de facture**, donc elle survit à un rechargement complet de Monday. Les
factures ainsi corrigées portent une coche dans la colonne *Financement* ;
*Rendre au calcul automatique* les rend à la déduction.

Une facture sans numéro ne peut pas porter de correction durable : elle serait
perdue au rechargement, et l'application le dit plutôt que de laisser croire le
contraire.

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

### Trois familles de doublons

Tous les doublons ne se valent pas, et les additionner masquait ceux qui
demandent une correction. La chaîne de traitement les sépare donc en trois
lignes, chacune cliquable :

- **Doublons attendus** — une facture vue à la fois sur son tableau opérationnel
  et sur *0.1. ALL - Factures payées*, ou rangée dans un groupe d'archive. C'est
  le fonctionnement même du circuit ; rien à corriger.
- **Doublons entre tableaux opérationnels** — la même facture active sur deux
  tableaux à la fois. Dans un circuit Tampon → ADV → Recouvrement une facture se
  déplace, elle ne se duplique pas : l'exemplaire resté sur le tableau quitté est
  à supprimer dans Monday.
- **Doublons dans les factures payées** — la même facture saisie plusieurs fois
  dans *0.1. ALL - Factures payées*, le plus souvent dans deux groupes. Une
  facture n'a qu'un règlement : tant que le doublon subsiste, le nombre de
  factures réglées par groupe est surévalué et l'origine retenue pour la facture
  est ambiguë.

Les deux dernières passent en rouge dès qu'elles ne sont pas nulles, et chacune
a son anomalie en Data Quality. Les indicateurs, eux, ne sont pas faussés :
l'application ne compte la facture qu'une fois — c'est Monday qui porte la ligne
en trop.

Chaque liste donne le numéro, le client, le montant et les tableaux d'où
viennent les lignes, de quoi aller vérifier dans Monday. Deux factures réellement
distinctes portant le même numéro seraient fusionnées à tort : le signaler, la
règle de rapprochement devrait alors être revue.

### Taux de remplissage des colonnes

Une colonne peut être correctement associée et pourtant vide : nom reconnu,
mais colonne jamais renseignée dans Monday, ou bonne colonne choisie parmi
plusieurs homonymes. Le résultat est le même qu'une colonne absente — des
montants à zéro et des échéances non calculables — sans que rien ne l'explique.

L'écran *Correspondance des colonnes* porte donc, pour chaque champ, la **part
des lignes du tableau où la colonne est effectivement renseignée**, mesurée sur
les valeurs réelles. Les champs qui font tourner le calcul — numéro, montant,
date de facture, dates de formation, type de financement, type de client — sont
marqués *essentiel* et remontés en tête ; en dessous de 50 %, ou sans colonne
associée, ils passent en rouge.

La même mesure alimente une anomalie *Data Quality*, « Colonnes essentielles non
reconnues », qui nomme le tableau, le champ, le taux constaté et l'effet sur les
indicateurs. Il n'est donc pas nécessaire d'ouvrir les tableaux un par un pour
s'en apercevoir.

### Colonnes proposées

Élargir la liste des noms reconnus ne fait que déplacer la limite : il restera
toujours une colonne nommée autrement. Quand un champ essentiel n'est pas pourvu
— ou l'est par une colonne remplie à moins de la moitié — l'écran de
correspondance **propose les colonnes dont les valeurs conviendraient**, jugées
sur leur contenu et non sur leur nom : celles qui portent des nombres pour un
montant, des dates pour une date. Un clic sur l'une d'elles l'associe.

La proposition ne vaut que pour les champs dont les valeurs se reconnaissent —
dates, montants, numéros. Pour un type de financement, n'importe quelle colonne
de texte conviendrait : en proposer serait du bruit, pas une aide.

### Pourquoi une facture n'a pas d'échéance

Le nombre de factures sans échéance ne dit pas quoi corriger : une colonne non
reconnue, une date vide dans Monday et une règle qui réclame une date que la
facture ne porte pas donnent le même chiffre et appellent trois gestes
différents.

La colonne *Sans échéance* de l'inventaire par tableau est donc cliquable. Elle
ouvre le détail, cause par cause, de la plus fréquente à la plus rare :

- **Aucune date exploitable** — ni facture, ni début, ni fin de formation. Le
  plus souvent une colonne non reconnue sur ce tableau : le taux de remplissage
  de l'écran de correspondance le confirme.
- **Type de financement non identifié** — sans financement, aucune règle ne dit
  sur quelle date compter.
- **Règle non applicable** — le financement est connu, la règle aussi, mais la
  facture ne porte pas la date sur laquelle cette règle compte. Une facture
  *B2C-Perso* sans dates de formation en est le cas type : sa règle ne connaît
  que celles-là, et ne se rabat pas sur la date de facture.

Le même classement accompagne l'anomalie *Échéance impossible à calculer* de
Data Quality.

### Le vocabulaire des tableaux Liora

Les colonnes ne s'appellent pas partout pareil, et un nom non reconnu vaut une
colonne vide : la facture perd son montant ou son échéance sans que rien ne le
dise. Les libellés effectivement employés chez Liora sont donc connus
explicitement :

| Colonne Monday / Sellsy | Champ |
|---|---|
| Élément, Factures | numéro de facture |
| Total Facture | montant TTC |
| Montant dû TTC, Reste à payer | reste dû |
| Début de service, Fin de service | dates de formation |
| Date contrôle paiement | contrôle du règlement |

Deux pièges qui coûtaient cher :

- **« Montant dû » n'est pas le montant de la facture** mais ce qu'il en reste à
  payer : sur une facture réglée il vaut zéro. Le prendre pour le montant
  mettait des tableaux entiers à zéro. Il alimente le reste dû, d'où le montant
  est déduit quand aucune autre colonne ne le porte — et la déduction est
  marquée, car une facture partiellement réglée le sous-estime.
- **« Début » et « Fin de service » sont les dates de formation.** Sans ces
  libellés, les règles qui comptent sur la fin de formation ne trouvaient rien
  et des milliers de factures sortaient en « échéance impossible à calculer ».

### Contrôle des colonnes associées

La reconnaissance automatique se fait sur le nom des colonnes, ce qui suffit la
plupart du temps mais peut se tromper : *Problématique Pré-échéance* contient le
mot « échéance » sans porter de dates, une colonne de liens Monday contient le
mot « facture » sans porter de numéros.

Le nom et les valeurs sont donc **examinés ensemble** : chaque candidat est
confronté aux données du tableau avant d'être retenu, et **un candidat démenti
laisse la place au suivant sur ce champ**. Sans cela, un nom trompeur emportait
le champ, se faisait rejeter, et le champ restait vide alors qu'une autre colonne
convenait.

Les contrôles portent sur les valeurs réellement renseignées, les cases vides
étant écartées du calcul — une colonne de dates peu remplie reste une colonne de
dates :

| Champ | Rejeté si |
|---|---|
| une date | moins de la moitié des valeurs se lisent comme des dates |
| un montant | moins de la moitié des valeurs sont numériques |
| le numéro de facture | la moitié des valeurs sont des liens ou des adresses, ou moins de la moitié donnent un numéro exploitable |

Le numéro de facture n'est en revanche pas testé contre les dates : un numéro est
fait de groupes de chiffres, et certains se lisent comme une date — le test
rejetterait de vraies colonnes.

Chaque rejet est écrit dans le journal de chargement, avec la colonne retenue à
la place le cas échéant : « *« Problématique Pré-échéance » écartée du champ
dateEcheanceSource : ne contient pas de dates — « Echéance négociée » retenue à
la place* ». Une correspondance choisie à la main est contrôlée, jamais
remplacée.

### Tableaux de sous-éléments : jamais des factures

Les lignes d'un tableau « Sous-éléments de … » portent le nom du sous-élément en
guise de numéro — souvent le même pour toutes. Elles se rapprochaient donc entre
elles et ressortaient comme un doublon à plusieurs exemplaires. Elles sont
écartées avant toute consolidation, y compris lorsqu'un chargement antérieur les
a laissées en cache, et comptées avec les groupes de service.

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

## Contrôle d'exhaustivité — Sellsy ↔ Monday

Sellsy est le logiciel de facturation : c'est lui qui dit quelles factures
existent. Monday est le tableau de suivi. Une facture émise dans Sellsy et
absente de Monday **n'est relancée par personne** — et n'apparaît dans aucun
chiffre de cette application, puisque celle-ci ne connaît que Monday.

L'onglet **Contrôle Sellsy** répond à la question. Déposez l'export des
factures Sellsy (Facturation → Factures → Exporter) : le rapprochement se fait
sur le **numéro de facture**, ponctuation, espaces et casse ignorés, comme pour
les doublons entre tableaux Monday.

### Ce qu'il faut dans l'export

| Colonne | Rôle |
|---|---|
| Numéro de facture | **indispensable** — la clé du rapprochement |
| Statut | dit si la manquante est déjà payée ou reste à recouvrer |
| Montant TTC | chiffre l'enjeu et révèle les écarts de saisie |
| Reste dû | remplace le statut s'il est absent : à zéro, la facture est soldée |
| Date de facture | situe le trou dans le temps et borne le contrôle |
| Client | dit si le trou se concentre sur un compte |

Les libellés exacts de Sellsy sont reconnus en priorité — « Numéro »,
« Statut », « Montant », « Montant dû TTC », « Date d'échéance » — avant tout
rapprochement approché : l'export porte à la fois *Numéro* et *Numéro de
facture Zoho*, et un score de ressemblance choisissait la seconde, vide, qui ne
rapprochait rien. L'onglet indique ce qu'il n'a pas trouvé plutôt que de le
calculer sur du vide.

### Les statuts de Sellsy

| Statut Sellsy | Lu comme | Attendue dans Monday |
|---|---|---|
| Payée | réglée | oui |
| Retard | impayée | oui |
| À régler | impayée | oui |
| Paiement partiel | partiellement réglée | oui |
| Annulée | hors périmètre | non |

« À régler » contient *régl* : sans traitement explicite, il tombait sur le
motif des factures payées et des centaines d'impayées étaient comptées
encaissées. Les libellés d'autres outils — brouillon, avoir, unpaid, settled —
restent reconnus. À défaut de colonne de statut, le **reste dû** tranche : à
zéro, la facture est soldée.

### Montants aberrants

Au-delà de **10 000 000 €**, la valeur n'est pas une facture de formation mais
une anomalie de la source. L'export réel en contient trois, dont deux à
−421 046 417 789 € : additionnées, elles affichaient un total facturé de −460
milliards d'euros et rendaient toute lecture impossible.

Le montant est donc écarté des sommes ; **la facture reste comptée et
signalée**, nommément, sous les indicateurs et en rouge dans la table. C'est à
corriger dans Sellsy — pas à cet outil de le cacher.

### Sellsy complète Monday

Le rapprochement ne sert pas qu'à compter ce qui manque : il **comble les vides
de Monday**, selon la même règle que le grand livre — jamais de remplacement,
seulement des trous remplis.

- **Montant absent ou à zéro** → le montant TTC de Sellsy. Le tableau du
  financement personnel portait des montants à zéro : tous les indicateurs en
  euros de la catégorie valaient zéro.
- **Date de facture absente** → celle de Sellsy. C'est elle qui débloque le
  calcul de l'échéance : les factures du tableau des factures payées n'ont ni
  date de formation ni date de facture, et sortaient de tous les taux avec la
  mention « échéance inconnue ».
- **Dates de début et fin de service absentes** → celles de Sellsy. Ce sont les
  dates de formation : les reprendre laisse la règle de financement calculer
  normalement, plutôt que de recopier l'échéance de Sellsy.
- **Aucune règle applicable** → en tout dernier recours, la date d'échéance de
  Sellsy. Les règles de financement gardent la main partout où elles savent
  répondre : leur échéance n'est jamais remplacée par celle de Sellsy.

Les valeurs venues de Sellsy sont marquées d'un **S** dans la table des
factures, et le compte apparaît dans la chaîne « De Monday au tableau de bord ».

### Les quatre vues

- **Absentes de Monday** — émises dans Sellsy, sur aucun tableau. Ce sont
  celles à créer dans le circuit. Elles sont séparées par statut : les impayées
  sont de l'argent qui échappe au recouvrement ; les payées expliquent une
  partie des factures qui « manquent » au total sans rien coûter.
- **Écarts de saisie** — la facture est bien dans Monday, mais son montant ou
  son statut n'y correspond pas. Sellsy fait foi : c'est Monday qui est à
  corriger. Une facture encaissée dans Sellsy et encore ouverte dans Monday,
  c'est une relance envoyée pour rien.
- **Inconnues de Sellsy** — leur numéro n'existe pas dans l'export : numéro mal
  saisi, ligne de test, facture d'un autre outil. Seules les factures dont la
  date tombe dans la période couverte par l'export sont jugées.
- **Hors périmètre** — brouillons, avoirs et factures annulées. Leur absence de
  Monday est normale : les compter comme manquantes noierait les vraies.

### Ce que le contrôle ne peut pas dire

Les angles morts sont affichés sous les indicateurs, jamais tus :

- les lignes de l'export sans numéro exploitable, qui n'ont pu être
  rapprochées ;
- les factures Monday **sans numéro**, qui ne peuvent être rapprochées de rien
  et peuvent correspondre à des « absentes » listées ici ;
- la **période réellement couverte** par l'export, hors de laquelle aucune
  facture Monday n'est jugée ;
- l'absence d'une colonne de statut ou de montant, quand elle prive une lecture.

Le contrôle porte sur **la totalité des factures Monday**, sans les filtres de
la barre : la barre est masquée sur cet onglet. Un filtre y ferait passer pour
manquantes les factures qu'il vient lui-même d'écarter.

Le bouton **Exporter en Excel** produit un classeur à cinq feuilles — synthèse,
absentes, écarts, inconnues de Sellsy, absentes par mois et par client — de quoi
créer les manquantes dans Monday sans les ressaisir une par une.

L'export reste enregistré d'une session à l'autre, et le contrôle se recalcule
à chaque rechargement des tableaux Monday : les écarts corrigés disparaissent
d'eux-mêmes.

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

Un grand livre ne porte pas une ligne par facture mais **une ligne par
écriture** : la facture au débit, le règlement au crédit, l'avoir au crédit lui
aussi. Le virement bancaire ne nomme jamais la facture — c'est la **lettre de
lettrage**, au sein d'un même compte client, qui les rattache.

Le lire ligne à ligne comme une liste de règlements revenait à déclarer
encaissée toute facture qui y apparaît, y compris celles qui n'ont jamais été
payées. L'application regroupe donc les écritures par **compte + lettre**, et
lit le sort de chaque facture dans l'équilibre de son groupe :

| Le groupe | Ce que ça veut dire | Effet |
|---|---|---|
| débits = crédits, un règlement au crédit | soldée par un règlement | payée, à la date du dernier règlement |
| débits = crédits, seulement des avoirs | **annulée par avoir** | sort du portefeuille, mais ne compte pas comme récupérée |
| débits ≠ crédits | reste dû | signalée, jamais appliquée contre Monday |

L'**avoir** est la distinction qui compte : la créance a disparu sans qu'un
euro rentre. La compter encaissée gonflerait le taux de récupération d'un
argent qui n'existe pas ; la laisser en retard ferait relancer une facture
annulée. Elle a donc son propre état, **Annulée par avoir**, filtrable comme
les autres.

Une facture que Monday donne réglée et que le grand livre ne solde pas est
**signalée en Data Quality, jamais appliquée** : un extrait ne couvre qu'un
exercice, et une facture soldée avant sa première date y figure en à-nouveau.
Contredire Monday sur cette base ferait plus de dégâts que de bien.

Le grand livre complète aussi les vides, comme Sellsy : montant comptabilisé et
date de facture là où le tableau est muet. La comptabilité restant plus fiable
que la saisie, **une date lettrée remplace celle de Monday**, qui est conservée
dans la fiche pour référence.

Un fichier simple « numéro de facture + date de règlement » reste accepté : il
est reconnu à l'absence de colonnes de lettrage et de débit/crédit.

Colonnes reconnues : *N° de compte*, *Let.*, *Journal*, *Date*, *N° de
facture*, *Libellé de pièce*, *Débit*, *Crédit*, *Tiers*, *Date d'échéance* —
les libellés de Pennylane, Sage et Cegid.

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

### Les créances anciennes finissent-elles par rentrer ?

Le graphique juxtaposait deux séries que rien ne rend comparables : l'une porte
sur des factures encore dues, dont le retard court toujours, l'autre sur des
factures réglées, dont le retard est définitif. Deux hauteurs côte à côte, deux
significations — la lecture était impossible.

La question tient en une phrase : parmi les factures ayant atteint tel niveau
d'ancienneté, quelle part a fini par rentrer ? Chaque tranche est donc ramenée à
cent pour cent et se lit de haut en bas — vert, ce qui est rentré ; rouge, ce qui
est toujours dû. Les montants et les nombres restent en info-bulle, et un clic
ouvre les factures de la tranche.

### Le financement, pas le tableau

Le tableau Monday dit **où une facture se trouve** dans le circuit ; le
financement dit **ce qu'elle est**, et c'est lui qui commande la règle
d'échéance. Le tableau de bord s'analyse donc par financement, jamais par
tableau.

Deux conséquences. Le filtre *Financement* précède celui de l'étape du circuit,
lequel s'appelle désormais ainsi — *Sources du retard* laissait croire à un axe
de même nature, alors qu'il désigne un stade du parcours. Et la répartition par
tableau Monday a quitté le tableau de bord pour l'onglet *Données*, auprès de
l'inventaire des tableaux : elle sert à vérifier un chargement, pas à analyser
un portefeuille.

### Filtrer par financement

Le filtre existait dans le moteur mais ne s'atteignait qu'en cliquant une ligne
du tableau des catégories : il fallait deviner qu'il était là. Il prend sa place
dans la barre de filtres, sous forme de puces. Le premier clic **isole** le
dispositif choisi plutôt que d'en retirer un parmi quatorze ; *Tous* rétablit
l'ensemble. Seuls les six principaux sont montrés, les autres à la demande, pour
que la barre ne devienne pas plus haute que les graphiques qu'elle surplombe.

### Le fil du tableau de bord

Le groupe central de la vue d'ensemble a **deux lectures**, une bascule passant
de l'une à l'autre sur les mêmes trois cases : *En retard* — ce qu'il faut aller
chercher, le métier du recouvrement — et *Pas encore échu* — ce qui doit rentrer
sans avoir à le réclamer, la lecture trésorerie. Les intitulés et les phrases
d'aide suivent la bascule, de sorte qu'aucune case ne peut être lue pour une
autre.

La vue d'ensemble suit la même règle que le reste : **le portefeuille d'abord**
— ce qui a été facturé, encaissé, ce qu'il reste à encaisser — puis **ce qui est
en recouvrement**, puis **depuis combien de temps**. Du général au particulier,
jamais l'inverse.

Les blocs se suivaient sans ordre apparent. Ils sont désormais rangés en quatre
temps, chacun annoncé par un titre numéroté, du général au particulier :

1. **Par type de financement** — l'évolution du taux par catégorie (la carte
   thermique s'ouvre d'un clic sur la courbe), puis le montant en retard par
   dispositif.
2. **Les factures qui rentrent** — ce que le recouvrement récupère, avec une
   bascule vers ce qui rentre sans relance.
3. **Analyse du retard** — ce qui reste dû et depuis quand : les créances
   anciennes finissent-elles par rentrer, balance âgée, taux par mois, flux,
   retard moyen, DSO.
4. **Où aller chercher l'argent** — le détail jusqu'à la facture : treemap,
   arbre des montants, top clients, répartition par tableau.

La vue d'ensemble — indicateurs et état du portefeuille — reste en tête, avant
le premier temps.

Ranger les blocs dans le bon ordre n'en réduisait pas le nombre : sept écrans de
défilement, dont deux pour les seules tendances de fond — la partie la moins
consultée occupait la plus grande place. **Les deux derniers temps s'ouvrent donc
à la demande**, et le choix est mémorisé. La page s'ouvre sur trois écrans au
lieu de sept, sans que rien ne soit retiré.

Le treemap *Où se concentre le montant en retard* a rejoint le quatrième temps :
il fait doublon avec la carte thermique dans le deuxième, et c'est un outil de
fouille — sa dimension se change — plutôt qu'un constat.

### Les factures qui rentrent

Deux populations de factures réglées, qu'il faut savoir comparer : celles qui
sont passées par le recouvrement, et celles qui sont rentrées seules. La
première dit ce que le travail de relance rapporte, la seconde ce qui n'en a pas
eu besoin. Une bascule passe de l'une à l'autre sur la même mise en page, pour
que la comparaison se fasse d'un coup d'œil : nombre et montant, part des
règlements, combien ont été payées en retard, écart moyen à l'échéance, ce qui
rentre chaque mois, et la répartition par dispositif.

**Passer par le recouvrement ou non ne dit rien du délai.** Une facture peut
n'être jamais entrée dans le circuit et avoir été réglée des mois après son
échéance : c'est une distinction de processus, pas de ponctualité. Les deux vues
affichent donc côte à côte les factures **payées avant échéance** et celles
**payées après**, pour que la confusion ne soit pas possible.

L'appartenance se lit dans le groupe conservé par *0.1. ALL - Factures payées* :
un groupe mentionnant le recouvrement, une relance, une mise en demeure ou un
contentieux compte comme passé par le recouvrement. Les factures réglées dont ce
groupe n'est pas renseigné ne peuvent être attribuées ni à l'une ni à l'autre :
elles sont comptées à part et le nombre en est annoncé.

### Évolution du taux par catégorie

La carte thermique donne le taux mois par mois et par financement, mais une
grille de couleurs dit mal si une catégorie se dégrade ou s'assainit. Le
graphique *Évolution du % en recouvrement, par catégorie* trace une courbe par
type de financement : montante, la catégorie se dégrade ; descendante, elle
s'assainit. Un clic sur une légende isole une catégorie.

Un clic sur la courbe ouvre la **carte thermique** mois × financement, qui donne
le détail chiffré de ce que la courbe résume. Elle ne s'affiche plus en
permanence : deux lectures de la même chose côte à côte alourdissaient l'écran.

Le taux tracé est celui de la **cohorte échue** — sur les factures arrivées à
échéance dans le mois, la part payée en retard ou encore impayée. C'est le seul
comparable d'un mois à l'autre : un taux « à date » ferait chuter mécaniquement
les mois récents, dont les factures n'ont pas eu le temps d'être en retard. Les
mois dont la cohorte compte moins de cinq factures ne portent pas de point —
trois factures ne font pas un taux.

### Un graphique, une question

Les graphiques mensuels cumulaient jusqu'à sept séries sur deux axes verticaux,
et cinquante-sept mois en abscisse dont la moitié presque vide. Chacun répond
désormais à une seule question, sur **un seul axe**.

Deux échelles verticales sur un même graphique donnent une correspondance
arbitraire entre les deux séries et suggèrent des rapprochements que les chiffres
ne disent pas. Elles ont disparu :

| Graphique | Ce qui a été retiré | Ce qu'il dit maintenant |
|---|---|---|
| **Taux de recouvrement par mois** | deux courbes de pourcentage sur un axe de droite | ce que sont devenues les factures échues de chaque mois — le taux est en info-bulle, et la courbe par catégorie le trace |
| **Flux de recouvrement** | la courbe de stock, six fois plus haute que les barres | gagne-t-on ou perd-on du terrain ce mois-ci |
| **DSO** | les barres de reste à encaisser | un nombre de jours, ce que le DSO mesure |
| **Évolution du retard moyen** | l'écart au règlement, qui porte sur une autre population | depuis combien de jours les impayées attendent, en moyenne et en médiane |

Un sélecteur **12 / 24 mois / Tout**, en tête du troisième temps, règle la
fenêtre commune à ces graphiques ; deux ans par défaut, assez pour lire une
tendance sans écraser l'axe.

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

La courbe ne porte pas de point sur les mois où le calcul consommerait presque
tout l'historique chargé : elle y mesurerait la longueur de cet historique et
non le délai de règlement. Sur un chargement dont les premières factures datent
de trois ans, cela donnait une droite montant régulièrement de zéro à mille
jours — chaque mois ajoutant exactement sa propre durée. Un trou dans la courbe
vaut mieux qu'un chiffre qui n'en est pas un.

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

### Tranches de la balance âgée

Les tranches reprennent celles du tableau de balance âgée déjà utilisé chez
Liora, exprimées en mois : *non échu*, *0 à 3*, *3 à 4*, *4 à 6*, *6 à 12*,
*12 à 18*, *18 à 24*, *24 à 36*, *36 à 48*, *plus de 48 mois*. L'ancienneté des
créances s'y compte en années ; des tranches de trente jours n'y montraient rien.

Retards : moyen, médian, maximum, **pondéré par le montant** (un gros impayé
ancien pèse plus qu'un petit), et **retard moyen au paiement** mesuré sur les
factures déjà réglées.

## Entrer dans une catégorie

Les qualifications avaient leur onglet : on y lisait la répartition des
problématiques sans savoir de quelle catégorie elles parlaient, et il fallait
reconstituer le lien de tête. Elles sont désormais **là où on les cherche** —
en entrant dans une catégorie de financement.

Un clic sur une ligne du tableau *Par type de financement* ouvre, sous la
synthèse, le détail de cette catégorie :

- ses **chiffres** — factures, en retard, pas encore échu, retard moyen — et la
  règle d'échéance qui lui est appliquée ;
- la **répartition de ses qualifications, tableau par tableau** : chaque valeur
  avec son nombre, sa part, son montant et le nombre en retard. Un clic sur une
  barre ouvre les factures concernées, déjà filtrées sur la catégorie ;
- pour le **financement personnel**, qui se règle par mandat, les indicateurs
  **GoCardless** : part d'apprenants sans incident, taux de rejet, incidents
  rattrapés, montant à risque.

Sont retenues les colonnes dont le nom relève du vocabulaire de qualification :
*qualification*, *problématique*, *motif*, *litige*, *contentieux*, *anomalie*,
*blocage*.

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

Sans *Customers*, aucun prélèvement ne porte d'identité : l'export Payments ne
contient que des identifiants. Les apprenants sont alors regroupés sur leur
identifiant GoCardless, et une même personne titulaire de deux mandats compte
deux fois. *Fiabilité de l'analyse* le signale sous « Export Customers non
fourni » — en nommant le fichier manquant plutôt qu'en laissant croire à des
identités absentes de GoCardless.

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
