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
│   └── pieces-jointes/
│       └── 001_2024-10-15_1022_.../facture-fa-2024-0153.pdf
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
| **Export** | lancer une extraction, depuis un export Monday ou une recherche ponctuelle |
| **Documents** | les dossiers produits — ouvrir la note de synthèse ou le répertoire |
| **État des dossiers** | avancement de la procédure et frais engagés, saisis et conservés |
| **Tableau de bord** | montants en recouvrement, frais, issues, répartition par étape |

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
| `--seulement REF1,REF2` | Ne traiter que ces références. Pratique pour refaire un dossier. |
| `--max-mails N` | Plafond par dossier (défaut : 500). Un dépassement est signalé. |
| `--sans-spam` | Exclut spam et corbeille, inclus par défaut. |
| `--ignorer-lignes-incompletes` | Passe les lignes sans adresse ni facture (lignes de groupe Monday) au lieu de s'arrêter. Les lignes écartées sont listées. |
| `--fuseau ZONE` | Fuseau d'affichage des dates (défaut : `Europe/Paris`). |
| `--boites A,B` | Boîtes à lire, séparées par des virgules. Les doublons entre boîtes sont écartés. |
| `--sans-synthese` | N'écrit pas la note de synthèse PDF de chaque dossier. |
| `--sans-regroupement` | Traite chaque facture comme un dossier distinct au lieu de réunir celles d'un même débiteur. |
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
