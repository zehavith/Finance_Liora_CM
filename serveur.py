#!/usr/bin/env python3
"""
Le petit serveur web local des applications Liora.

Identique à « python -m http.server », à une chose près : il interdit au
navigateur de garder les fichiers en cache.

Pourquoi cela compte. index.html porte le numéro de version de tous les
autres fichiers (app.js?v=2.63.0, styles.css?v=2.63.0…). Si le navigateur
sert index.html depuis son cache, il redemande app.js?v=2.57.0 — et toute
l'application reste à l'ancienne version, en silence, alors que les
nouveaux fichiers sont bien sur le disque. Sans en-tête de cache, le
navigateur s'autorise à garder une page plusieurs heures : c'est ce qui
faisait rester l'application sur une version périmée après une mise à jour.

Rien n'est publié sur Internet : le serveur n'écoute que sur cette machine.
"""

import socket
import sys
import threading
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


class SansCache(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, must-revalidate')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()

    # Le journal du serveur n'apporte rien à l'utilisateur et noie la
    # fenêtre sous une ligne par fichier chargé.
    def log_message(self, fmt, *args):
        pass


class SurIPv6(ThreadingHTTPServer):
    address_family = socket.AF_INET6


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8777

    # L'application s'ouvre sur http://localhost:8777 — jamais sur une autre
    # adresse : c'est à cette origine-là que le navigateur garde le jeton
    # Monday et les données déjà chargées, et en changer les effacerait.
    # Or « localhost » se résout tantôt en 127.0.0.1, tantôt en ::1 selon le
    # poste. On écoute donc sur les deux, et seulement sur celles-là : rien
    # n'est joignable depuis le réseau.
    serveurs = []
    try:
        serveurs.append(SurIPv6(('::1', port), partial(SansCache)))
    except OSError:
        pass   # poste sans IPv6 : 127.0.0.1 suffit
    serveurs.append(ThreadingHTTPServer(('127.0.0.1', port), partial(SansCache)))

    for s in serveurs[:-1]:
        threading.Thread(target=s.serve_forever, daemon=True).start()
    try:
        serveurs[-1].serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        for s in serveurs:
            s.server_close()


if __name__ == '__main__':
    main()
