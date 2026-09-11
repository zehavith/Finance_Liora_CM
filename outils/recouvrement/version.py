"""Le numéro de version de l'outil, en un seul endroit.

Il sert deux choses qui doivent rester d'accord : ce que la page annonce en
en-tête, et ce dont chaque note de synthèse est marquée. Une note écrite par
une version antérieure ne dit plus ce que l'outil dirait aujourd'hui — la même
facture jointe à sept relances y tenait sept lignes, par exemple — et
l'application doit pouvoir le voir sans relire la note.
"""

from __future__ import annotations

VERSION = "159"
