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
| `v3-regles.js` | Onglet « Règles d'application » : règles repliées, modifiables, gardées dans le navigateur. |
| `js/monday.js` | Client Monday : jeton, ou connecteur monday.com (lecture complète ou des seuls changements). |
| `js/operationnel.js` | Circuit : vignette « Sous contrôle », descente tableaux › groupes › factures, correspondance groupe → étape, entrées et sorties. |
| `js/pilotage.js` | Pilotage : tableau par financeur resserré, libellé des échéances du mois. |
| `outils/extraire-creances.py` | Fabrique `donnees/creances.json` (une ligne par créance, sans nom ni numéro) à partir des balances âgées publiées, et contrôle chaque arrêté au centime contre le relevé du Pilotage. C'est ce fichier qui permet au Pilotage de se recalculer quand un délai d'échéance change. |

Aucune donnée réelle n'est dans ce dossier : les fichiers `donnees/` de
l'artefact sont produits par `recouvrement/artefact/actualiser.js` (lecture
directe de Monday, jeton `MONDAY_TOKEN`) et ne doivent jamais entrer dans le dépôt.

## Données conservées dans la page publiée (jamais dans ce dépôt)

Ces fichiers vivent dans l'artefact « Suivi recouv version 3 », dossier `donnees/`.
Une publication qui ne les nomme pas les conserve tels quels. Pour repartir de
ce qui existe, les relire depuis l'artefact (action « read » avec leur chemin).

| Fichier | Contenu | Outil qui le produit |
|---|---|---|
| `edof.json` | Paiements CPF d'après les exports EDOF fournis par l'utilisatrice (2023, 2024, 2025). **Pour le CPF, EDOF fait foi.** | `outils/extraire-edof.py` |
| `reglements.json` | Règlements et avoirs par facture, d'après la balance âgée | `outils/extraire-reglements.py` |
| `rapprochements.json` | Règlements reçus non lettrés, avec la facture proposée | `outils/extraire-rapprochements.py` |
| `anciennes-factures.json` | Factures refaites et leur numéro d'origine (Monday) | `outils/extraire-anciennes-factures.py` |
| `provision.json` | Solde des comptes 491 (Pennylane) | `outils/extraire-provision.py` |
| `lignes.json`, `creances-<date>.json` | Détail ligne à ligne du Pilotage | `outils/extraire-lignes.py` |

### Ajouter un export EDOF (par exemple 2026)

Ne pas redemander les anciens exports : relire `donnees/edof.json` depuis
l'artefact, puis

    python3 outils/extraire-edof.py edof.json <edof.json relu> <nouvel export.csv>

et republier `donnees/edof.json`. La ligne la plus récente d'une facture l'emporte.
