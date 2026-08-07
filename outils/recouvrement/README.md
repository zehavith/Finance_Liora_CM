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

## Mise en place (une seule fois)

### 1. Python

Installer Python 3.9 ou plus récent depuis [python.org](https://www.python.org/downloads/).
Sous Windows, cocher **« Add Python to PATH »** pendant l'installation.

Puis, dans un terminal ouvert sur ce répertoire :

```bash
pip install -r requirements.txt
```

### 2. Autoriser l'accès à Gmail

Il faut créer un identifiant OAuth dans la console Google Cloud. À faire par
une personne disposant d'un accès à la console (service informatique).

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

Créer un fichier `dossiers.csv` sur le modèle de `dossiers.exemple.csv` :

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
séparateur `;` comme `,` est accepté, ainsi que les intitulés de colonnes
courants (`mail`, `adresse mail`, `numero facture`, `apprenante`…).

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
| `--fuseau ZONE` | Fuseau d'affichage des dates (défaut : `Europe/Paris`). |
| `--boite ADRESSE` + `--compte-service CLE.json` | Lire une boîte partagée (voir ci-dessous). |

### Lire une boîte partagée

Pour extraire depuis une boîte commune (`recouvrement@liora.io`) plutôt que
depuis votre compte personnel, il faut un **compte de service avec délégation
à l'échelle du domaine**, créé par l'administrateur Google Workspace, autorisé
sur la portée `https://www.googleapis.com/auth/gmail.readonly` :

```bash
python export_mails.py --dossiers dossiers.csv \
    --compte-service cle-service.json --boite recouvrement@liora.io
```

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
| `ligne N : ni adresse mail ni numéro de facture` | Ligne incomplète dans le CSV, à corriger ou supprimer. |
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
