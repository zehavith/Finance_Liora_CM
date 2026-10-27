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
| `depot-nouvelle/balance-nouvelle.xlsx` | l'export Pennylane du mois — **le grand livre COMPLET**, voir plus bas |
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
| `balance-agee/depot-nouvelle/balance-nouvelle.xlsx` | l'export Pennylane du grand livre clients, onglet « Grand livre - Clients », **sans filtre de lettrage** |
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

## Le grand livre doit être complet

L'export Pennylane doit porter **toutes les lignes, lettrées et soldées
comprises** — pas seulement les créances encore ouvertes.

Pourquoi : une facture de mai, encore due au 30 juin, encaissée en août,
disparaît d'un extrait des seules créances ouvertes. Elle en disparaît sur ses
DEUX jambes — ni la facture, ni son règlement — et rien ne distingue alors
« cette facture n'a jamais existé » de « cette facture a été soldée avant
l'export ». Tout arrêté passé est donc amputé : au 30/06/2026, l'extrait
filtré donnait 12 113 392 € là où le grand livre complet en donne
15 090 860 €, soit 2 977 468 € de moins.

Comment reconnaître un extrait filtré : grouper les écritures par
(compte + code de lettrage) et compter celles dont le net débit−crédit est
nul. Dans un grand livre complet, le lettrage soldé est le cas majoritaire ;
dans l'extrait déposé jusqu'au 27/10/2026, **aucun** des 1 251 groupes ne
l'était. Deux autres traces disent la même chose : un taux d'encaissement
apparent absurde (11,9 % sur juillet-octobre) et un taux qui DÉCROÎT avec
l'âge des créances, alors que les vieilles devraient être les mieux encaissées.

Ce que le complet coûte : 38 288 écritures au lieu de 16 151, trois minutes de
construction au lieu de quatre-vingt-quinze secondes, un `balance.json` de
14 Mo au lieu de 6, et surtout — le lettrage changeant avec le fichier — une
partie des compléments à repasser : 40 sur 60 ont été repris à la bascule.

Une limite à connaître : l'export part du 01/07/2025, et tout ce qui précède y
arrive en report à nouveau. La chaîne les redate depuis le « Libellé de
ligne », ce qui garde l'ancienneté juste, mais **aucun arrêté antérieur au
01/07/2025 n'est calculable** depuis ce fichier.

## Publier : plusieurs envois

La page, ses données et les arrêtés pèsent ensemble plus de 80 Mo, pour une
limite de **64 Mo par envoi** et de 16 Mo par fichier. Un envoi unique serait
refusé. On publie donc d'abord les arrêtés, deux ou trois par envoi, puis
`balance.json` et `tableur.min.js` EN DERNIER — ainsi la page ne pointe jamais
vers un arrêté qui n'est pas encore en ligne. Les fichiers qu'un envoi ne
nomme pas sont conservés : c'est ce qui rend le découpage possible.

## Arrêter la balance à une date

```
bash arreter.sh 2026-09-30
```

Dépose `art/arretes/balance-2026-09-30.json`, que la page sert sous son choix
« Balance arrêtée au ». Compter trois minutes par date.

**Arrêter n'est pas filtrer.** Le script coupe le grand livre à la date
demandée et refait TOUT — lettrage, rapprochement, imputation au prorata,
ancienneté. Une facture réglée le 15 octobre redevient due, et son règlement
n'existe pas encore. C'est exactement ce que la chaîne aurait produit ce
jour-là, et c'est la seule façon qu'un arrêté se justifie devant un
commissaire aux comptes. Masquer les écritures postérieures laisserait le
reste dû tel qu'il a été calculé aujourd'hui : on obtiendrait une balance qui
ressemble au 30 septembre sans en être une.

Le travail se fait dans un dossier temporaire : la balance du jour, ses
fichiers et son classeur ne sont jamais touchés.

Après avoir ajouté une date, relancer `node construire.js` : la liste des
arrêtés est scellée dans la page à la construction, avec la signature de
chaque fichier — sans ce passage, la nouvelle date n'apparaît pas dans le
choix. Et publier **tous** les `art/arretes/*.json`, pas seulement le nouveau :
un `files` incomplet retire les arrêtés déjà publiés.

Une date demandée depuis la page (champ « ou … Arrêter à cette date ») est
enregistrée dans `demandes/arrete` et construite par la relève horaire.

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
| `controle-ae.js` et `controle-fi.js` | prennent un fichier en argument : `node essais/controle-ae.js art/arretes/balance-2026-09-30.json` |
| `verifbal.js` | les deux balances âgées : colonnes et dépliement |
| `verifpaie.js` | l'onglet « Montants non lettrés » |
| `verifexc.js` | le filtre « comptes en excédent de trésorerie » |
| `ecartunanime.js` | ce qu'un changement de règle déplace, créance par créance |
| `ecartecheance.js` | ce qu'un changement de barème déplace, tranche par tranche |

Les deux derniers prennent deux `balance.json` et disent ce qui a bougé entre
eux. À lancer avant toute livraison qui change une règle.
