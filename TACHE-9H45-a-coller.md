# Tâche de 9h45 — ce qu'il faut régler, et le texte à coller

## Les trois réglages

| | Valeur |
|---|---|
| **Récurrence** | tous les jours à **9:45**, fuseau **Europe/Paris** |
| **Connecteur** | **monday.com** — sans lui la tâche ne lit rien |
| **Dépôt** | **zehavith/Finance_Liora_CM**, branche `claude/suivi-recouvrement-monday-app-15a03y` — sans lui elle n'a ni le code ni la procédure |

Les notifications push sont déjà activées.

---

## Le texte des instructions, à coller tel quel

Actualisation quotidienne du Suivi Recouvrement de Zehavit, pour qu'à 10 h son artefact s'ouvre déjà rempli des créances de Monday.

DÉPÔT : /home/user/Finance_Liora_CM, branche `claude/suivi-recouvrement-monday-app-15a03y` (fais `git fetch origin claude/suivi-recouvrement-monday-app-15a03y && git checkout claude/suivi-recouvrement-monday-app-15a03y` en arrivant).

LIS D'ABORD, EN ENTIER : `recouvrement/artefact/ACTUALISATION-QUOTIDIENNE.md`. Elle donne les neuf tableaux à prendre, ceux à ne jamais inclure, les colonnes, le format exact des fichiers et les pièges qui ont déjà coûté un portefeuille faux. Ne t'en écarte pas.

LECTURE SEULE SUR MONDAY. N'écris jamais dans Monday : aucune mutation, aucune création, aucune modification d'élément. Les outils de lecture sont autorisés dans `.claude/settings.json`. Si le connecteur monday.com n'est pas disponible dans la session, ne republie rien et préviens Zehavit.

LA MARCHE À SUIVRE, en bref — le détail est dans le document :

1. Sors les neuf tableaux avec `mcp__monday_com__execute_code`, en écartant les groupes techniques dès la requête et en lisant les colonnes comme `columnValue()` de `js/monday.js` (display_value, puis text, puis la valeur brute). Vise 40 s de travail par appel ; reprends par curseur si un tableau n'est pas fini.
2. Vérifie tableau par tableau que le nombre de lignes écrites égale `items_count` moins les lignes des groupes écartés. Un écart est un export tronqué.
3. Dépose les fichiers dans `recouvrement/artefact/donnees-du-jour/`, en ASCII, à la forme d'un export Monday, avec `du-jour.json` portant `arreteLe` (AAAA-MM-JJ du jour) et `arreteA` ("10h00").
4. `node recouvrement/artefact/construire.js` puis `node recouvrement/artefact/essayer.js` — aucun échec toléré.
5. Republie `recouvrement/artefact/paquet/index.html` à l'adresse https://claude.ai/artifact/WPXvahZu9uV1oiaZ4QUVuC avec `root` sur `paquet/` et, dans `files`, tous les fichiers de `donnees/` listés par `A-PUBLIER.txt`. Sans eux la page servirait les chiffres de la veille.
6. Commit et pousse sur la branche. Les fichiers de `donnees-du-jour/` sont écartés par `.gitignore` : ils ne doivent jamais entrer dans l'historique.

NE PUBLIE PAS UNE BALANCE AMPUTÉE. Si un tableau sort incomplet, si un champ essentiel (numéro, client, montant, date de facture, date d'échéance) n'est plus reconnu sur un tableau, si un tableau a disparu ou si un tableau numéroté inconnu est apparu : laisse la page en l'état — les chiffres de la veille sont justes et datés — et écris-le à Zehavit en disant précisément ce qui ne va pas.

NE MODIFIE AUCUNE RÈGLE DE CALCUL. Ni les règles d'échéance, ni le classement des tableaux, ni les motifs de groupes techniques. Cette actualisation reconstruit avec les règles telles qu'elles sont ; elle ne décide de rien. Si quelque chose te paraît devoir changer, dis-le à Zehavit au lieu de le faire.

SI TOUT S'EST BIEN PASSÉ, N'ÉCRIS RIEN. Une actualisation qui réussit n'a pas à se faire remarquer.
