# Suivi recouv — version 3

Sources de l'artefact « Suivi recouv version 3 »
(https://claude.ai/artifact/61VjSEeBcMMnEU6EQd9iLB).

Ce dossier ne contient que ce que la version 3 ajoute ou modifie par rapport
à « Suivi recouvrement » (branche `claude/suivi-recouvrement-monday-app-15a03y`,
dossier `recouvrement/`). Les autres fichiers de l'artefact (app.js, styles,
modules `js/`, bibliothèques) sont ceux de cette branche, inchangés.

| Fichier | Rôle |
|---|---|
| `suivi-recouv-v3.html` | La page publiée (sans squelette `<html>`). |
| `v3.css` | Menu latéral, en-têtes d'onglet, lexique, styles de l'onglet Opérationnel. |
| `v3.js` | En-têtes, lexique, actualisation Monday par le connecteur, dates complétées. |
| `js/monday.js` | Client Monday : jeton, ou connecteur monday.com (lecture complète ou des seuls changements). |
| `js/operationnel.js` | Circuit : vignette « Sous contrôle », descente tableaux › groupes › factures, correspondance groupe → étape, entrées et sorties. |
| `js/pilotage.js` | Pilotage : tableau par financeur resserré, libellé des échéances du mois. |

Aucune donnée réelle n'est dans ce dossier : les fichiers `donnees/` de
l'artefact sont produits par `recouvrement/artefact/actualiser.js` (lecture
directe de Monday, jeton `MONDAY_TOKEN`) et ne doivent jamais entrer dans le dépôt.
