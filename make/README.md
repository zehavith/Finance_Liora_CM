# Scénarios Make

Ce dossier versionne les **blueprints** des scénarios Make (make.com) utilisés
par Liora. Il est purement documentaire : l'application web du dépôt ne lit
jamais ces fichiers au runtime.

## Déposer un scénario

1. Dans Make, ouvrir le scénario → bouton `⋯` (bas de l'éditeur) →
   **Export Blueprint** → un fichier `.json` est téléchargé.
2. Le renommer en `kebab-case` décrivant son rôle, puis le placer dans
   `make/scenarios/`.

```
make/scenarios/
  import-releve-bancaire.json
  relance-factures-impayees.json
  sync-notion-tresorerie.json
```

3. Committer. Le diff Git entre deux exports montre précisément ce qui a
   changé dans le scénario — utile pour retrouver la cause d'une régression.

## ⚠️ Avant de committer : purger les secrets

Un blueprint exporté **ne contient pas** les connexions (identifiants OAuth,
clés API) : Make ne les exporte pas. En revanche il peut contenir des valeurs
saisies en dur dans les modules — token dans un header HTTP, URL de webhook,
adresses e-mail, identifiants de compte.

Relire le `.json` avant le commit et remplacer ces valeurs par un
marqueur, par exemple `"__REDACTED__"`.

## Convention de mise à jour

Un scénario modifié dans Make = un ré-export qui **écrase** le fichier
existant (même nom). L'historique vit dans Git, pas dans des suffixes de
fichiers (`-v2`, `-final`…).
