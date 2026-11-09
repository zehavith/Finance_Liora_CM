#!/bin/bash
# Construit la balance âgée arrêtée à une date, et ne garde que le fichier de
# données — art/arretes/balance-AAAA-MM-JJ.json, que la page sert.
#
#   bash arreter.sh 2026-09-30
#
# ARRÊTER N'EST PAS FILTRER : construire.js --arrete coupe le grand livre à la
# date demandée et REFAIT tout — lettrage, rapprochement, imputation au
# prorata, ancienneté. Une facture réglée le 15 octobre redevient due, et son
# règlement n'existe pas encore.
#
# Le travail se fait dans un dossier à part. construire.js prend son code dans
# son propre dossier et ses données dans le dossier de travail : la balance du
# jour, ses fichiers et son classeur ne sont jamais touchés. Compter environ
# trois minutes par date.
set -e
DATE="$1"
SRC=/home/user/Finance_Liora_CM/balance-agee
TRAVAIL=$(mktemp -d /tmp/arrete-XXXXXX)
cd "$TRAVAIL"
# depot-pennylane porte l'instantané des liens de facture. Sans lui dans le
# dossier de travail, chaque arrêté se referait sans aucun lien — en silence,
# puisqu'une colonne vide ne lève rien.
for d in depot-ancienne depot-nouvelle depot-sellsy depot-ech depot-pennylane; do
  [ -e "$SRC/$d" ] && ln -s "$SRC/$d" . || true
done
for f in Reference-septembre.xlsx complements.json mandats.json parametres.json principale.json; do
  [ -e "$SRC/$f" ] && ln -s "$SRC/$f" . || true
done
echo "=== arrêté au $DATE · $TRAVAIL"
# `tail -22` ne garde que la fin, et la construction en écrit quarante-quatre
# lignes : tout ce qu'elle dit au début est coupé. L'avertissement « aucun
# instantané de liens » sort en deuxième ligne — il disparaissait donc, et un
# arrêté se serait construit sans un seul lien sans que rien ne le dise.
# On garde la fin comme avant, mais on remonte d'abord ce qui alerte.
JOURNAL="$TRAVAIL/construction.log"
set -o pipefail
node "$SRC/construire.js" --arrete "$DATE" > "$JOURNAL" 2>&1
grep -E "ATTENTION|ÉCHEC|ERREUR" "$JOURNAL" || true
tail -22 "$JOURNAL"
mkdir -p "$SRC/art/arretes"
cp art/balance.json "$SRC/art/arretes/balance-$DATE.json"
echo "déposé : art/arretes/balance-$DATE.json  ($(du -h "$SRC/art/arretes/balance-$DATE.json" | cut -f1))"
cd /
rm -rf "$TRAVAIL"
