# Export des mails de recouvrement depuis Gmail

Outil en ligne de commande destiné au service recouvrement : à partir d'une
liste de dossiers (adresse mail de l'apprenante et/ou numéro de facture), il
constitue pour chacun un répertoire complet des échanges, prêt à transmettre
au contentieux.

L'accès à la boîte est **en lecture seule** : le script ne peut ni envoyer, ni
supprimer, ni modifier quoi que ce soit.

## Ce qui est produit

```
export/
├── 2024-118_marie-dupont/
│   ├── synthese.pdf                 note de synthèse du dossier
│   ├── index.csv                    chronologie numérotée des échanges
│   ├── mails/
│   │   ├── 001_2024-10-15_1022_recouvrement_facture-fa-2024-0153.eml
│   │   ├── 001_2024-10-15_1022_recouvrement_facture-fa-2024-0153.pdf
│   │   └── ...
│   ├── pieces-jointes/
│   │   └── 001_2024-10-15_1022_.../facture-fa-2024-0153.pdf
│   ├── factures/                    si le débiteur en doit plusieurs
│   │   ├── fa-2024-0153/            sous-dossier complet, transmissible seul
│   │   │   ├── synthese.pdf
│   │   │   ├── index.csv
│   │   │   ├── mails/
│   │   │   └── pieces-jointes/
│   │   └── fa-2024-0154/
│   └── adresses/                    sur option, si plusieurs adresses
│       ├── marie-dupont-exemple-fr/ même structure, vue par adresse
│       └── m-dupont-travail-fr/
├── 2024-119_sophie-bernard/
├── _recapitulatif.csv               une ligne par dossier
├── LISEZ-MOI.txt                    méthode d'extraction, à joindre au dossier
└── journal.log
```

Pour chaque message, deux fichiers portant le même nom :

- **`.eml`** — le message d'origine intégral, en-têtes techniques compris
  (horodatage serveur, chemin de remise, identifiants). C'est la version qui a
  la meilleure valeur probatoire ; un PDF n'est qu'une impression.
- **`.pdf`** — la version lisible et imprimable, avec un bandeau d'en-tête
  rappelant le dossier, le numéro de pièce, les parties, la date et le
  Message-ID.

Les fichiers sont numérotés dans l'ordre chronologique : `001`, `002`, `003`…
Ce numéro est le **numéro de pièce** repris dans `index.csv` et dans le
bandeau du PDF, ce qui permet de citer directement « pièce n° 3 ».

### La note de synthèse

`synthese.pdf` est la page de couverture du dossier, structurée comme un
dossier contentieux :

- un bandeau **Montant en recouvrement**, repris du tableau de suivi ;
- **1. Contexte** — formation suivie, montant facturé et reste dû, ancienneté
  de l'échéance, statut, et la note interne du tableau reproduite telle quelle ;
- **2. Contrat signé et factures** — les pièces jointes trouvées dans les
  échanges, classées par nature (convention, facture, mise en demeure,
  échéancier), chacune renvoyant à son numéro de pièce ;
- **3. Preuve des actions engagées** — chiffres clés, constats, événements
  repérés et chronologie complète des échanges.

Les montants, dates de formation et statuts viennent du tableau Monday ; le
reste des seuls messages extraits.

Son contenu est **entièrement déduit des messages extraits**, jamais rédigé
librement. Chaque constat renvoie à un numéro de pièce vérifiable :

> *2 relance(s) ont été adressées à l'apprenante (pièces n° 4, n° 5), la
> dernière le 05/02/2025.*
> *Aucune contestation du montant ou de la prestation n'apparaît dans les
> échanges extraits.*

Les événements — envoi de facture, relance, mise en demeure, échéancier
évoqué, contestation, annonce de paiement, difficultés financières invoquées,
transmission au contentieux — sont repérés par correspondance de formulations
dans l'objet et le corps des messages. Les réponses automatiques (absence du
bureau, échec de remise) sont exclues du décompte des réponses de l'apprenante.

**Deux limites, énoncées aussi dans le PDF lui-même :**

- la détection repose sur des formulations courantes ; un message rédigé
  autrement peut ne pas être reconnu, et la liste des événements peut donc
  être incomplète ;
- ce n'est pas une analyse juridique. La note doit être relue avant
  transmission, en vérifiant les pièces citées.

Aucune donnée n'est envoyée à un service tiers pour produire cette note :
tout est calculé sur le poste. C'est un choix assumé — le contenu d'un dossier
contentieux n'a pas à transiter par un service externe, et un texte rédigé
automatiquement ne serait pas vérifiable pièce par pièce.

`--sans-synthese` désactive cette génération.

## Deux façons de s'en servir

**L'interface graphique** — double-cliquez sur **`Lancer.bat`** (ou lancez
`python interface.py`). Votre navigateur s'ouvre sur une page où vous
choisissez les boîtes et la destination, puis suivez la progression à l'écran.
Aucune commande à taper.

L'application comporte quatre onglets :

| Onglet | Rôle |
|---|---|
| **Tableau de bord** | page d'accueil : montants en recouvrement, frais, issues, répartition par étape |
| **État des dossiers** | avancement de la procédure et frais engagés, saisis et conservés |
| **Documents** | les dossiers produits — ouvrir la note de synthèse ou le répertoire |
| **Export** | lancer une extraction, depuis un export Monday ou une recherche ponctuelle |

L'ordre suit l'usage : le tableau de bord se consulte tous les jours,
l'extraction se lance de loin en loin.

L'avancement suit six états : non transmis, transmis, en cours chez l'avocat,
passage au tribunal, clôturé gagné, clôturé perdu. Il est enregistré dans
`suivi-dossiers.json`, **à côté de l'outil et non dans l'export** : refaire une
extraction n'efface pas l'état d'avancement.

### Plusieurs factures pour un même débiteur

Par défaut, les factures **partageant une adresse mail** sont réunies en un
dossier unique, avec la dette cumulée, toutes les factures et l'échéance la
plus ancienne. Sans cela, elles produiraient autant de répertoires au contenu
identique : la recherche se faisant sur l'adresse, elle ramène les mêmes
messages à chaque facture.

Le regroupement s'annonce à l'écran, débiteur par débiteur, avec les
références réunies. Il se fait sur l'adresse et jamais sur le nom : deux
homonymes sont deux débiteurs, une adresse partagée désigne la même personne.

#### Un dossier qui mène à un sous-dossier par facture

Le dossier du débiteur reste l'ensemble — c'est lui qui porte la dette
cumulée, l'état d'avancement et les frais engagés. Il contient en plus un
sous-répertoire **`factures/`**, avec un sous-dossier par facture en retard :

| Le message… | va dans… |
|---|---|
| nomme `FA-2024-0153` | le seul sous-dossier `fa-2024-0153` |
| nomme les deux factures | les deux sous-dossiers |
| n'en nomme aucune (relance générale, réponse de l'apprenante) | **tous** les sous-dossiers, car il vaut pour toute la dette |

Chaque sous-dossier est **autonome** : sa propre note de synthèse, sa
chronologie, ses messages, ses pièces jointes et, s'il y a un jeton Monday, sa
propre facture PDF et sa convention. Il peut donc partir seul chez l'avocat,
sur une clé ou dans une archive, sans rien perdre.

Les numéros de pièce ne sont **pas** renumérotés : « pièce n° 7 » désigne le
même message dans le dossier du débiteur et dans chacun de ses sous-dossiers,
et la note de couverture du dossier récapitule la répartition. La colonne
`factures_concernees` de `index.csv` indique, message par message, ce qui a
été retenu.

Un numéro n'est reconnu que s'il est isolé dans le texte : une facture « 118 »
n'est jamais reconnue dans « 1180 » ni à l'intérieur d'un numéro plus long.

Un débiteur ne devant qu'une facture ne reçoit pas de `factures/` : le
découpage n'ajouterait qu'un niveau de répertoire. Pour le désactiver
entièrement, décochez *Un sous-dossier par facture*, ou passez
`--sans-sous-dossiers`.

#### Le même découpage, par adresse mail

Quand les échanges d'un même débiteur passent par plusieurs adresses —
personnelle et professionnelle, apprenante et employeur — la case *Un
sous-dossier par adresse mail* (ou `--sous-dossiers-par-adresse`) produit un
sous-répertoire `adresses/`, bâti sur le même principe :

| Le message… | va dans… |
|---|---|
| a `marie.dupont@exemple.fr` en en-tête | la vue de cette adresse |
| a les deux adresses en en-tête | les deux vues |
| n'a aucune adresse du dossier en en-tête (échange interne remonté par le numéro de facture) | **toutes** les vues |

Le rattachement se fait sur les **en-têtes** du message — expéditeur,
destinataires, copies — et non sur son corps : une adresse recopiée dans un
message transféré ne fait pas de son titulaire une partie à l'échange.

Deux différences avec le découpage par facture : cette vue est **optionnelle**
(décochée par défaut, la plupart des dossiers portant une adresse de contact
et une adresse de prélèvement sans que cela mérite deux répertoires), et les
**montants n'y sont pas répartis** — une adresse ne porte pas une part de la
dette, c'est la même dette vue par un autre canal.

Les deux découpages sont indépendants : un débiteur qui doit deux factures et
écrit depuis deux adresses obtient `factures/` **et** `adresses/`, deux
lectures du même dossier.

### Compléter un dossier au lieu de le refaire

Un dossier vit : l'apprenante répond, une relance part, une mise en demeure
est envoyée. Trois façons de relancer l'outil sur un export existant :

| | Ce qui se passe |
|---|---|
| *(rien de coché)* | tout est refait de zéro, les numéros de pièce sont réattribués |
| **Reprendre** | les dossiers déjà exportés sont passés sans être regardés |
| **Compléter les dossiers déjà exportés** | les messages déjà présents sont conservés tels quels, les nouveaux ajoutés à la suite |

En mode *Compléter*, un message déjà au dossier est reconnu à son
**Message-ID** — l'identifiant que lui donne le serveur d'envoi, stable d'une
boîte et d'une extraction à l'autre. Ni son `.eml`, ni son PDF, ni ses pièces
jointes ne sont réécrits, et son numéro de pièce ne change pas : une note déjà
transmise citant « pièce n° 7 » reste exacte.

Les nouvelles pièces prennent les numéros suivants, **même si elles sont plus
anciennes**. `index.csv` reste trié par date, les numéros n'y sont donc plus
forcément croissants — c'est assumé : un dossier contentieux numérote ses
pièces dans l'ordre où elles y sont versées, pas dans celui des faits.

La note de synthèse, elle, est refaite entièrement à chaque mise à jour :
constats, événements et chronologie tiennent compte des nouvelles pièces. Les
textes des anciennes sont relus dans les `.eml` conservés, sans retélécharger
quoi que ce soit.

Un dossier sans rien de nouveau est laissé intact, à l'octet près, et signalé
« à jour ». Et si la recherche ne ramène plus rien alors que le dossier est
constitué — boîte purgée, requête modifiée —, il est **conservé** : réécrire
un index vide effacerait un dossier complet.

*Reprendre* et *Compléter* ensemble n'ont pas de sens : reprendre passe les
dossiers avant de les regarder, donc rien n'est complété. L'outil le signale
plutôt que de laisser croire à une mise à jour.

### Retrouver les adresses à partir du numéro de facture

Beaucoup de lignes n'ont qu'un numéro de facture, sans adresse mail. La
recherche sur ce seul numéro ramène les relances — qui le citent — mais **pas
les réponses de l'apprenante**, qui n'écrit jamais « FA-2024-0153 » dans son
message. C'est justement la preuve la plus utile qui manque.

La case *Retrouver les adresses depuis le numéro de facture* (ou
`--decouvrir-adresses`) ajoute une seconde passe :

1. recherche sur le numéro de facture ;
2. dans les messages qui le **citent**, relevé des adresses figurant en
   en-tête (expéditeur, destinataires, copies) ;
3. recherche relancée sur chaque adresse retenue, et fusion sans doublon.

Tout le risque est dans le filtrage : une relance porte aussi en en-tête les
adresses de Liora, et relancer la recherche sur `recouvrement@liora.io`
ramènerait la boîte entière. Trois garde-fous, dans cet ordre :

| Écarté | Pourquoi |
|---|---|
| les domaines des boîtes interrogées, plus ceux de `--domaines-internes` | ce sont vos propres adresses |
| `noreply@`, `mailer-daemon@`, `postmaster@`… | des robots, pas des parties à l'échange |
| toute adresse ramenant à elle seule plus de `--max-mails` messages | une boîte interne ou partagée, jamais celle d'un débiteur |

**Rien n'est retenu en silence** : chaque adresse découverte est annoncée à
l'écran avec le nombre de messages qu'elle apporte, chaque adresse écartée est
annoncée avec son motif, et la colonne `adresses_decouvertes` de
`_recapitulatif.csv` les récapitule — à relire avant transmission. Au plus
5 adresses sont sondées par dossier (`--max-adresses-decouvertes`).

L'option n'est pas cochée par défaut : elle double le nombre de requêtes
Gmail, et elle élargit le dossier. Faites-la d'abord tourner en simulation.

### Documents stockés dans Monday

Les colonnes contenant une adresse de document — `Facture PDF`,
`Convention de formation` — sont reconnues automatiquement. Avec un **jeton
d'accès Monday**, les fichiers sont téléchargés dans le sous-répertoire
`documents-monday` de chaque dossier ; sans jeton, ils sont seulement cités en
lien dans la note.

Le jeton se crée depuis Monday : avatar en haut à droite → *Développeurs* →
*Mes jetons d'accès*. Collez-le dans le champ prévu de l'interface : il est
enregistré dans `monday-token.txt`, exclu du dépôt au même titre que les
identifiants Gmail.

> Ces documents sont rangés **à part** des pièces extraites des messages, et
> la note le dit. Un document produit depuis le tableau atteste de son
> existence ; une pièce extraite d'un message établit qu'elle a été transmise
> au débiteur. Devant un tribunal, ce n'est pas la même chose.

Une panne de Monday, un jeton refusé ou un document supprimé n'interrompent
jamais l'export : l'échec est signalé ligne par ligne et les échanges sont
constitués quand même.

> Sur le tableau de bord, la longueur des barres représente le **montant dû**,
> pas le nombre de dossiers : c'est l'enjeu financier qui décide où porter
> l'effort. Les quatre étapes en cours partagent une teinte unique, de la plus
> soutenue à la plus claire ; les deux issues portent une couleur d'état **et
> une icône**, parce que le vert et le rouge sont indistinguables en vision
> deutéranope — un daltonien sur douze hommes ne doit pas confondre un dossier
> gagné avec un dossier perdu.

Deux façons de désigner les dossiers à extraire, au choix par onglet :

- **Depuis un export Monday** — vous y déposez le fichier, tel quel ;
- **Recherche ponctuelle** — vous saisissez une adresse mail et/ou un numéro
  de facture pour un dossier isolé, sans rien préparer dans Monday. Les deux
  critères se combinent par un OU, comme pour un fichier : les renseigner tous
  les deux élargit la recherche, il ne la restreint pas.

C'est un serveur local : il n'écoute que sur `127.0.0.1`, et chaque appel doit
porter un jeton tiré au hasard au démarrage, connu de la seule page servie. Une
page web ouverte par ailleurs ne peut donc pas le piloter. Une page HTML seule
n'aurait de toute façon pas suffi — un navigateur ne peut ni s'authentifier
auprès de Gmail ni écrire sur le disque ; l'interface n'est qu'un panneau de
commande, le travail reste sur le poste.

**La ligne de commande** — tout ce que fait l'interface est disponible en
options de `export_mails.py`, décrites plus bas. Utile pour automatiser ou pour
les cas particuliers.

## L'application sur le Bureau

Un double-clic sur **`Installer.bat`**, une seule fois, crée le raccourci
**Liora - Suivi contentieux** sur le Bureau et dans le menu Démarrer, avec son
icône. Ensuite, l'application s'ouvre depuis ce raccourci comme n'importe quel
logiciel.

Le raccourci vise `Lancer-silencieux.vbs` et non `Lancer.bat` : le `.bat`
ouvre une fenêtre de commande que l'on referme par réflexe, et sa fermeture
tue l'export en cours. Le `.vbs` lance le même outil sans aucune fenêtre.

Sans fenêtre à fermer, l'outil s'arrête de lui-même : trois minutes sans
aucune page ouverte et il rend la main. Un export en cours l'emporte toujours
— fermer l'onglet ne l'interrompt pas, il va à son terme et l'outil s'arrête
ensuite.

L'icône est produite par `creer_icone.py`, sans dépendance. Le fichier
`liora.ico` est versionné ; le script ne sert qu'à le refaire si le dessin
doit changer.

### Rien à enregistrer

Les champs et les cases de l'onglet Export sont mémorisés au fil de la saisie
et à la fermeture de la page. Adresses, destination, domaines d'envoi, filtre
de références, jeton Monday, cases cochées : tout revient dans l'état laissé.
L'avancement des dossiers et les frais engagés le sont déjà à chaque
modification.

## Mise en place (une seule fois)

### 1. Python

Installer Python 3.9 ou plus récent depuis [python.org](https://www.python.org/downloads/).
Sous Windows, cocher **« Add Python to PATH »** pendant l'installation.

Puis, dans un terminal ouvert sur ce répertoire :

```bash
pip install -r requirements.txt
```

### 2. Autoriser l'accès à Gmail

Il faut créer un identifiant OAuth dans la console Google Cloud. **C'est
faisable seul, sans passer par le service informatique**, dans la plupart des
organisations : à la création d'une organisation Google Cloud, tous les
comptes du domaine reçoivent par défaut le rôle *Créateur de projet*, et un
projet configuré en **Interne** échappe à la procédure de validation Google
normalement exigée pour la portée `gmail.readonly`.

Deux cas peuvent malgré tout nécessiter un administrateur :

- l'administrateur a restreint la création de projets sur le domaine — la
  console affiche alors une erreur d'autorisation à l'étape 1 ;
- l'accès doit porter sur une **boîte partagée** plutôt que sur la vôtre, ce
  qui suppose une délégation à l'échelle du domaine (voir plus bas).

1. Ouvrir [console.cloud.google.com](https://console.cloud.google.com/) et
   créer un projet, par exemple `liora-recouvrement`.
2. **API et services → Bibliothèque** → rechercher **Gmail API** → *Activer*.
3. **API et services → Écran de consentement OAuth** → type **Interne**
   (l'outil ne sert qu'aux comptes du domaine `liora.io`).
4. **API et services → Identifiants → Créer des identifiants →
   ID client OAuth** → type d'application **Application de bureau**.
5. Télécharger le fichier JSON, le renommer **`credentials.json`** et le
   déposer dans ce répertoire.

Au premier lancement, le navigateur s'ouvre pour demander l'autorisation. Le
jeton obtenu est ensuite mémorisé dans `token.json` ; les lancements suivants
ne redemandent rien.

> `credentials.json` et `token.json` donnent accès à la boîte : ils sont exclus
> du dépôt par `.gitignore` et ne doivent jamais être partagés ni envoyés par
> mail.

### 3. Vérifier l'installation

```bash
python test_hors_ligne.py
```

Ce test ne touche pas à Gmail et ne demande aucune autorisation. Il vérifie la
lecture du fichier de dossiers, la construction des requêtes, le décodage d'un
message et la génération des fichiers. Il affiche aussi le **moteur PDF**
détecté sur le poste.

## Préparer la liste des dossiers

Le fichier peut être un **`.xlsx`** (export Monday ou Excel) ou un **`.csv`**.
Format minimal, sur le modèle de `dossiers.exemple.csv` :

```csv
reference;nom;email;facture;date_debut;date_fin
2024-118;Marie Dupont;marie.dupont@exemple.fr;FA-2024-0153;01/09/2023;
2024-119;Sophie Bernard;sophie.bernard@exemple.fr|s.bernard@autre.fr;FA-2024-0161;;
2024-121;Nadia Chevalier;;FA-2024-0201;;
```

| Colonne | Obligatoire | Remarque |
|---|---|---|
| `reference` | non | Numéro de dossier. Sert à nommer le répertoire. Généré si absent. |
| `nom` | non | Nom de l'apprenante, pour retrouver le répertoire d'un coup d'œil. |
| `email` | **oui\*** | Une ou plusieurs adresses, séparées par `\|`. |
| `facture` | **oui\*** | Un ou plusieurs numéros, séparés par `\|`. |
| `date_debut` | non | Ne remonter que les messages postérieurs. `JJ/MM/AAAA`. |
| `date_fin` | non | Ne remonter que les messages antérieurs. |

\* Au moins l'un des deux par ligne. Une ligne sans aucun des deux fait échouer
le script avec le numéro de ligne concerné, plutôt que de produire un dossier
vide passé inaperçu.

Le fichier peut être préparé dans Excel et enregistré en **CSV UTF-8**. Le
séparateur `;`, `,` ou tabulation est détecté automatiquement, ainsi que les
intitulés de colonnes courants (`mail`, `adresse mail`, `numero facture`,
`apprenante`, `Name`…).

### Depuis un tableau Monday

L'export Monday s'utilise **tel quel**, sans aucune retouche ni conversion :
depuis le tableau, menu `⋯` → *Export board to Excel*, puis

```bash
python export_mails.py --dossiers "2.1. Financement Personnel.xlsx" --simulation
```

Le `.xlsx` est lu directement ; le CSV reste accepté. Les particularités de
ces exports sont gérées automatiquement :

- le fichier commence par le nom du tableau puis celui du groupe : les
  intitulés de colonnes n'arrivent qu'en troisième ligne, elle est retrouvée
  seule ;
- la colonne `Name` porte selon les tableaux le nom de l'apprenante ou le
  numéro de facture. Quand une colonne plus explicite existe — `Nom & Prénom
  de l'apprenant` — c'est elle qui l'emporte ;
- **plusieurs colonnes d'adresses sont réunies** : `E-mail` et `E-mail GCard`
  alimentent toutes deux la recherche, les doublons étant retirés. Idem pour
  les colonnes de numéros de facture ;
- à défaut de colonne de référence de dossier, le **numéro de facture** sert
  d'identifiant, ce qui donne des répertoires parlants
  (`fact-2405-00030_aissata-conte`) ;
- les **lignes de total de groupe** ajoutées par Monday, qui ne contiennent
  que des plages de dates, sont écartées et signalées à l'écran — jamais
  escamotées en silence.

> Attention aux intitulés génériques : dans un tableau de facturation, la
> colonne `Adresse` désigne l'adresse **postale**. Elle n'est volontairement
> pas rattachée aux adresses mail — sans quoi le script chercherait
> « 9 rue du Grenier-Saint-Lazare » dans Gmail.

Au lancement, les colonnes retenues sont affichées. Vérifiez cette ligne
avant de lancer l'export réel :

```
Colonnes reconnues : « Nom & Prénom de l'apprenant » → nom,
« N° Facture » → facture, « E-mail » → email, « E-mail GCard » → email
```

En revanche, les **lignes de séparation de groupe** (« Contentieux »,
« Échéancier accepté »…) n'ont ni adresse ni facture. Par défaut le script
s'arrête dessus en indiquant le numéro de ligne, pour ne pas risquer de passer
sous silence un vrai dossier incomplet. Une fois vérifié qu'il s'agit bien de
lignes de groupe :

```bash
python export_mails.py --dossiers monday.csv --ignorer-lignes-incompletes --simulation
```

Les lignes écartées sont alors listées à l'écran, une par une.

Il suffit que le tableau comporte une colonne d'adresses mail **ou** une
colonne de numéros de facture ; les colonnes supplémentaires (statut, montant,
propriétaire…) sont ignorées sans gêner.

## Utilisation

**Toujours commencer par une simulation.** Elle exécute les recherches et
affiche le nombre de messages trouvés par dossier, sans rien télécharger ni
écrire :

```bash
python export_mails.py --dossiers dossiers.csv --simulation
```

C'est le moment de repérer les dossiers à 0 message (adresse erronée,
apprenante qui écrivait depuis une autre adresse) et ceux qui en ont
anormalement beaucoup.

Dans l'application, le fichier importé est conservé à côté de l'outil sous le
nom `dossiers-depose.xlsx`. À la réouverture, la zone de dépôt le rappelle —
« Dernier fichier importé, prêt à relancer » — et le bouton *Lancer* repart
dessus sans qu'il faille le redéposer. Aucun navigateur ne sait repeupler un
champ de fichier : sans ce rappel, l'import semblait perdu. Déposer un autre
fichier le remplace.

Puis l'export réel :

```bash
python export_mails.py --dossiers dossiers.csv --sortie ./export
```

Une quarantaine de dossiers prend quelques minutes selon le volume de messages
et de pièces jointes.

### Options

| Option | Effet |
|---|---|
| `--dossiers CHEMIN` | Fichier des dossiers (défaut : `dossiers.csv`). |
| `--sortie CHEMIN` | Répertoire de destination (défaut : `./export`). |
| `--simulation` | Compte les messages sans rien écrire. |
| `--reprendre` | Passe les dossiers déjà exportés. À utiliser après une interruption. |
| `--mettre-a-jour` | Complète les dossiers déjà exportés au lieu de les refaire : seuls les messages nouveaux sont ajoutés. |
| `--seulement REF1,REF2` | Ne traiter que ces références. Pratique pour refaire un dossier. |
| `--max-mails N` | Plafond par dossier (défaut : 500). Un dépassement est signalé. |
| `--sans-spam` | Exclut spam et corbeille, inclus par défaut. |
| `--ignorer-lignes-incompletes` | Passe les lignes sans adresse ni facture (lignes de groupe Monday) au lieu de s'arrêter. Les lignes écartées sont listées. |
| `--fuseau ZONE` | Fuseau d'affichage des dates (défaut : `Europe/Paris`). |
| `--boites A,B` | Boîtes à lire, séparées par des virgules. Les doublons entre boîtes sont écartés. |
| `--sans-synthese` | N'écrit pas la note de synthèse PDF de chaque dossier. |
| `--sans-regroupement` | Traite chaque facture comme un dossier distinct au lieu de réunir celles d'un même débiteur. |
| `--sans-sous-dossiers` | N'ouvre pas un sous-dossier par facture dans `factures/`. |
| `--sous-dossiers-par-adresse` | Ouvre en plus un sous-dossier par adresse mail, dans `adresses/`. |
| `--decouvrir-adresses` | Relève les adresses du débiteur dans les messages citant sa facture, et relance la recherche sur chacune. |
| `--max-adresses-decouvertes N` | Adresses sondées par dossier (défaut : 5). |
| `--domaines-internes A,B` | Domaines à ne jamais retenir comme adresse de débiteur. Ceux des boîtes interrogées le sont déjà. |
| `--sans-navigateur` | N'ouvre pas le navigateur : affiche l'adresse à coller vous-même, dans la fenêtre où la boîte est déjà connectée. |
| `--compte-service CLE.json` | Lire des boîtes partagées via un compte de service (voir ci-dessous). |

### Lire plusieurs boîtes (billing@ et recouvrement@)

```bash
python export_mails.py --dossiers dossiers.csv \
    --boites billing@liora.io,recouvrement@liora.io
```

Chaque dossier réunit alors les échanges des deux boîtes. Un même message
présent des deux côtés — le cas courant quand l'une est en copie de l'autre —
n'est **écrit qu'une fois**, en mémorisant les deux provenances. Le
dédoublonnage s'appuie sur l'en-tête `Message-ID`, stable d'une boîte à
l'autre, et non sur l'identifiant Gmail qui diffère. La colonne `boites` de
`index.csv` indique l'origine de chaque pièce, et `_recapitulatif.csv`
comptabilise les doublons écartés.

Deux façons d'y accéder, selon ce dont vous disposez :

**1. Vous pouvez vous connecter à chaque boîte** (vous en avez les
identifiants). Aucune intervention d'un administrateur n'est nécessaire : le
navigateur s'ouvre une fois par boîte, et vous vous connectez à chaque fois
avec le compte correspondant. Un jeton distinct est mémorisé par boîte
(`token-billing-liora-io.json`, `token-recouvrement-liora-io.json`).

> **Si la boîte est déjà connectée dans une autre fenêtre ou un autre profil
> du navigateur**, ajoutez `--sans-navigateur`. Sans cette option, l'ouverture
> automatique se fait dans le profil par défaut, qui valide aussitôt avec le
> compte qu'il connaît déjà — sans vous laisser le temps de choisir. Avec
> l'option, le script affiche l'adresse à coller vous-même dans la bonne
> fenêtre, et attend.
>
> C'est aussi la solution quand Google réclame une vérification d'identité sur
> une boîte générique (« consultez la messagerie de l'adresse indiquée dans
> 24 heures ») : une session déjà ouverte n'a rien à revérifier.

> Le script vérifie que le compte réellement autorisé est bien celui demandé.
> Si vous vous connectez par erreur avec un autre compte, il s'arrête et vous
> indique quel fichier de jeton supprimer — plutôt que d'exporter en silence
> le contenu de la mauvaise boîte.

**2. Les boîtes vous sont déléguées dans Gmail** (elles apparaissent dans
votre interface, mais vous n'avez pas leurs mots de passe). La délégation
Gmail **ne fonctionne pas** avec l'API : un jeton personnel ne permet pas de
lire une boîte déléguée. Il faut alors un **compte de service avec délégation
à l'échelle du domaine**, créé par l'administrateur Google Workspace et
autorisé sur la portée `https://www.googleapis.com/auth/gmail.readonly` :

```bash
python export_mails.py --dossiers dossiers.csv \
    --compte-service cle-service.json \
    --boites billing@liora.io,recouvrement@liora.io
```

C'est le seul cas qui impose de passer par un administrateur — mais c'est
aussi le plus confortable ensuite : une clé unique, aucune connexion
navigateur, et l'ajout d'une boîte supplémentaire ne coûte rien.

## Comment les messages sont retrouvés

Pour chaque dossier, une requête Gmail combine les deux critères par un **OU** :

- **adresse mail** — cherchée dans les en-têtes (`from:`, `to:`, `cc:`, `bcc:`)
  *et* dans le texte du message, ce qui rattrape les échanges où l'apprenante
  est simplement citée ;
- **numéro de facture** — cherché dans l'objet, dans le corps, *et* dans les
  noms de pièces jointes (`filename:`).

La colonne `critere` d'`index.csv` indique, message par message, lequel des
deux l'a fait remonter (`adresse`, `facture`, ou `adresse+facture`). La requête
exacte de chaque dossier est reportée dans `_recapitulatif.csv`, ce qui rend
l'extraction reproductible et vérifiable.

Spam et corbeille sont inclus par défaut : une réponse d'apprenante classée en
indésirable reste une réponse, et son absence du dossier se remarquerait.

### Limite à connaître

**Gmail n'indexe pas le contenu textuel des pièces jointes PDF.** Un message
dont le numéro de facture n'apparaît *que* dans le PDF joint — ni dans le
texte du message, ni dans le nom du fichier — ne remonte pas par le critère
« facture ». Il remonte en revanche par le critère « adresse » dès lors que
l'apprenante figure en expéditeur, destinataire ou copie.

C'est la raison pour laquelle il vaut mieux renseigner **les deux critères**
quand ils sont connus, et lire la colonne `critere` : un dossier dont tous les
messages sont remontés par la seule adresse signale que le numéro de facture
n'est écrit nulle part en clair.

## Génération des PDF

Le script cherche un moteur dans cet ordre, et garde le premier qui fonctionne :

1. **Chrome ou Edge** en mode sans interface — rendu le plus fidèle, aucune
   installation supplémentaire sous Windows (Edge est toujours présent).
   Forcer un chemin précis avec la variable d'environnement `CHROME_BIN`.
2. **WeasyPrint**, s'il est installé.
3. **xhtml2pdf**, installé par `requirements.txt`.

Si une pièce refuse de s'imprimer — le plus souvent à cause d'une image abîmée
dans le message — le script réessaie sans les images intégrées. Si aucun moteur
n'aboutit, il conserve la page **`.html`** à la place du PDF et le signale en
fin d'exécution : une pièce n'est jamais perdue silencieusement.

Les **images distantes ne sont jamais téléchargées** lors de la génération.
C'est délibéré : un pixel de traçage dans un mail de relance signalerait à
l'expéditeur le moment exact où le dossier est constitué. Elles apparaissent
sous la forme d'une mention « non téléchargée ». Les images réellement
intégrées au message (logos de signature) sont, elles, présentes dans le PDF.

## En cas de problème

| Message | Cause et solution |
|---|---|
| `Fichier d'identifiants introuvable` | `credentials.json` absent du répertoire — voir « Mise en place ». |
| `il faut au minimum une colonne « email » ou « facture »` | Intitulés de colonnes non reconnus dans le CSV. Reprendre `dossiers.exemple.csv`. |
| `ligne N : ni adresse mail ni numéro de facture` | Ligne incomplète dans le CSV, à corriger ou supprimer. S'il s'agit d'une ligne de groupe Monday : `--ignorer-lignes-incompletes`. |
| Erreur d'autorisation à la création du projet Google Cloud | L'administrateur du domaine a restreint la création de projets ; c'est le seul cas où son intervention est indispensable. |
| `Date incomprise` | Utiliser `JJ/MM/AAAA` ou `AAAA-MM-JJ`. |
| `plafond de 500 messages atteint` | Dossier tronqué : relancer avec `--max-mails 2000` et `--seulement REF`. |
| `⚠ Dossiers sans aucun message` | Vérifier l'adresse et le numéro de facture, ou élargir les bornes de dates. |
| `PDF non généré` | Aucun moteur PDF n'a abouti. Installer Chrome ou Edge, puis relancer avec `--reprendre`. |
| Interruption en cours d'export | Relancer la même commande avec `--reprendre`. |

## Données personnelles

L'export contient des données personnelles d'anciennes apprenantes. Il est
constitué pour la constatation et l'exercice d'un droit en justice, ce qui en
justifie le traitement — à condition d'en rester là :

- limiter l'export aux dossiers effectivement transmis au contentieux ;
- le conserver sur un emplacement à accès restreint, pas sur un poste partagé
  ni dans un espace de partage ouvert ;
- le supprimer à l'issue de la procédure et des voies de recours.

Rien n'est envoyé vers un serveur tiers : les messages transitent de Gmail vers
le poste, et nulle part ailleurs.
