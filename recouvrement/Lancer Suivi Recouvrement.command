#!/bin/sh
# ============================================================
#  Lance Suivi Recouvrement dans le navigateur (macOS / Linux).
#
#  Un petit serveur web local est démarré depuis le dossier du
#  dépôt : c'est nécessaire pour que la connexion à l'API Monday
#  fonctionne, les navigateurs bloquant les appels réseau depuis
#  une page ouverte en file://.
#
#  Rien n'est publié sur Internet : le serveur n'écoute que sur
#  cette machine.
# ============================================================

cd "$(dirname "$0")/.." || exit 1

PORT=8777
URL="http://localhost:$PORT/recouvrement/"

echo
echo "  Suivi Recouvrement Liora"
echo "  ------------------------"
echo

ouvrir() {
    sleep 1
    if command -v open  >/dev/null 2>&1; then open "$URL"
    elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$URL"
    fi
}

if command -v python3 >/dev/null 2>&1; then
    echo "  Ouverture de $URL"
    echo "  GARDEZ CETTE FENÊTRE OUVERTE. Ctrl+C pour quitter."
    echo
    ouvrir &
    exec python3 -m http.server "$PORT"
elif command -v node >/dev/null 2>&1; then
    echo "  Ouverture de $URL"
    echo "  GARDEZ CETTE FENÊTRE OUVERTE. Ctrl+C pour quitter."
    echo
    ouvrir &
    exec npx --yes http-server -p "$PORT" -c-1 --silent
else
    echo "  Python et Node.js sont introuvables."
    echo "  Ouverture directe du fichier : tout fonctionne sauf la"
    echo "  connexion à l'API Monday (utilisez l'import de fichiers)."
    echo
    if command -v open >/dev/null 2>&1; then open "$(dirname "$0")/index.html"
    elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$(dirname "$0")/index.html"
    fi
    read -r _
fi
