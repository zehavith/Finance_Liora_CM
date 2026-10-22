# La chaîne qui fabrique la balance âgée

Ce dossier contient l'outil qui lit vos exports et produit les trois livrables :

| | |
|---|---|
| `art/balance-agee.html` + `art/balance.json` | la page publiée sur claude.ai |
| `Balance-agee-Liora.html` | la même page, en un seul fichier à envoyer |
| `Balance-agee-clients.xlsx` | le classeur à neuf onglets |

Le moteur métier, lui, est dans `../recouvrement/js/` : c'est le même code que
l'application. Ce dossier ne fait que l'alimenter et mettre en forme.

## Ce qu'il faut poser à côté

Aucune donnée n'est versionnée — ce sont vos fichiers, et certains portent des
noms et des adresses de vos clients. Avant de lancer la construction :

| fichier | d'où il vient |
|---|---|
| `depot-ancienne/balance-ancienne.xlsx` | votre balance travaillée du mois précédent |
| `depot-nouvelle/balance-nouvelle.xlsx` | l'export Pennylane du mois |
| `depot-sellsy/sellsy.csv` | export Sellsy, toutes les factures |
| `depot-sellsy/avoirs.csv` | export Sellsy, les avoirs |
| `depot-ech/echeances.xlsx` | les dossiers d'alternance Filiz, onglet « Échéances » |
| `Reference-septembre.xlsx` | votre arrêté de septembre : il sert de référence en cas de désaccord, et porte les onglets « BdD Zoho - Toutes les factures », « BdD Zoho -Avoir Zoho » et « BdD Filiz - Facture Alternance » |
| `complements.json` | vos décisions de classement, voir ci-dessous |
| `mandats.json` | les mandats GoCardless, voir ci-dessous |

Cette liste a été établie en lançant la chaîne depuis un dossier vide : elle
est complète parce qu'elle a été vérifiée, pas parce qu'elle a été écrite de
mémoire.

## Construire

```
node construire.js
```

Une seule commande : elle lit tout, classe, date, écrit le classeur, puis
appelle `gabarit.js` qui fabrique les deux pages.

La construction annonce en sortie le total, l'échu et le non échu. Ce sont eux
qu'il faut comparer à l'arrêté précédent.

## Rafraîchir la balance, mois après mois

Quatre fichiers changent d'un mois sur l'autre. Ce sont les seuls qu'il faut
redéposer :

| à remplacer | ce que c'est |
|---|---|
| `balance-agee/depot-nouvelle/balance-nouvelle.xlsx` | l'export Pennylane du grand livre clients, onglet « Grand livre - Clients » |
| `balance-agee/depot-sellsy/sellsy.csv` | l'export Sellsy des factures (séparateur `;`) |
| `balance-agee/depot-sellsy/avoirs.csv` | l'export Sellsy des avoirs (séparateur `;`) |
| `balance-agee/depot-ech/echeances.xlsx` | les dossiers d'alternance Filiz, onglet « Échéances » |

Le nom du fichier compte : la chaîne ouvre ces quatre chemins-là, pas d'autres.
Déposer l'export Filiz sous un autre nom — `Dossiers-Filiz.xlsx`, par exemple —
revient à construire la balance sans lui, sans que rien ne le signale.

Ne bougent qu'à l'occasion : `mandats.json` quand l'export GoCardless est refait.
L'arrêté de septembre — `depot-ancienne/balance-ancienne.xlsx` et
`Reference-septembre.xlsx` — ne bouge pas : c'est la référence en cas de
désaccord, et c'est de lui que viennent les onglets Zoho et Filiz anciens.

Les fichiers que la chaîne ouvre vraiment, et eux seuls, se relisent dans
`construire.js` : `depot-ancienne/balance-ancienne.xlsx`,
`depot-nouvelle/balance-nouvelle.xlsx`, `depot-sellsy/sellsy.csv`,
`depot-sellsy/avoirs.csv`, `depot-ech/echeances.xlsx`,
`Reference-septembre.xlsx`, `complements.json`, `mandats.json`.

Puis `node construire.js`, et la page republiée.

Il n'y a pas de connexion directe à Pennylane ni à Sellsy : ce sont les
exports qui font foi, et c'est voulu — la balance doit pouvoir être refaite
à l'identique à partir des fichiers d'un arrêté donné.

## Vos décisions de classement

Tout ce que vous complétez dans la page vit dans la base de l'artefact,
collection `complements`. Elle se lit directement, sans export de votre part.

`complements.json` n'en est qu'un **instantané** de secours, pour que la
chaîne tourne même sans accès à l'artefact. La construction affiche sa date et
réclame un rafraîchissement au-delà de vingt-quatre heures : il s'écrit en
lisant la collection `complements` et en posant un tableau JSON d'objets
`{cle, dispositif, compte, tiers, facture, quand}`.

Un rafraîchissement déplace les lettrages, donc les clés de créance. La chaîne
le sait : elle retrouve une décision dont le lettrage a changé, et annonce
combien elle en a repris, combien étaient perdues. Ce chiffre est à lire à
chaque construction.

## Les mandats GoCardless

L'export GoCardless arrive en PDF. Trois étapes :

```
pdftotext -bbox-layout gocardless.pdf tout.xml
python3 gocardless/lire-pdf.py tout.xml brut.tsv
python3 gocardless/table.py brut.tsv gocardless.json
node gocardless/mandats.js gocardless.json mandats.json
```

Le rapprochement se fait par **numéro de facture d'abord**, puis e-mail, puis
nom et prénom — le numéro désigne la créance, les deux autres seulement le
client.

## Vérifier

```
cd essais
for f in cas*.js; do node $f; done
```

Neuf jeux de cas, cent vingt-quatre vérifications. Ils portent sur les règles
qui ont été remises en cause au moins une fois : l'échéance lue dans la colonne
AA, l'apprentissage par compte, l'unanimité, les compléments, l'orthographe des
dispositifs, le contrat des colonnes.

Les autres essais demandent un navigateur (Playwright) et contrôlent le
classeur téléchargé depuis la page :

| | |
|---|---|
| `verifbal.js` | les deux balances âgées : colonnes et dépliement |
| `verifpaie.js` | l'onglet « Montants non lettrés » |
| `verifexc.js` | le filtre « comptes en excédent de trésorerie » |
| `ecartunanime.js` | ce qu'un changement de règle déplace, créance par créance |
| `ecartecheance.js` | ce qu'un changement de barème déplace, tranche par tranche |

Les deux derniers prennent deux `balance.json` et disent ce qui a bougé entre
eux. À lancer avant toute livraison qui change une règle.
