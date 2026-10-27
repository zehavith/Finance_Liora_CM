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
for d in depot-ancienne depot-nouvelle depot-sellsy depot-ech; do ln -s "$SRC/$d" .; done
for f in Reference-septembre.xlsx complements.json mandats.json parametres.json principale.json; do
  [ -e "$SRC/$f" ] && ln -s "$SRC/$f" . || true
done
echo "=== arrêté au $DATE · $TRAVAIL"
node "$SRC/construire.js" --arrete "$DATE" 2>&1 | tail -22
mkdir -p "$SRC/art/arretes"
cp art/balance.json "$SRC/art/arretes/balance-$DATE.json"
echo "déposé : art/arretes/balance-$DATE.json  ($(du -h "$SRC/art/arretes/balance-$DATE.json" | cut -f1))"
cd /
rm -rf "$TRAVAIL"
