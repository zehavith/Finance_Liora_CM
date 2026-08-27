#!/usr/bin/env python3
"""Génère « liora.ico », l'icône de l'application.

Écrit sans dépendance : un encodeur PNG minimal (zlib + CRC de la librairie
standard) et un conteneur ICO qui embarque directement les PNG — format admis
par Windows depuis Vista.

    python creer_icone.py

Le fichier produit est versionné : ce script ne sert qu'à le refaire si le
dessin doit changer. Il n'est pas lancé par l'application.

Le dessin : carré arrondi corail Liora, document blanc à coin replié, trois
traits corail figurant le texte. Le motif reste lisible à 16 pixels — c'est
la taille qui commande, un dessin plus détaillé y deviendrait une bouillie.
"""

from __future__ import annotations

import struct
import zlib
from pathlib import Path

CORAIL = (244, 116, 88)
CORAIL_FONCE = (224, 90, 64)
BLANC = (255, 255, 255)

TAILLES = (16, 24, 32, 48, 64, 128, 256)

# Échantillonnage par pixel pour lisser les bords : 4x4 sous-pixels.
SOUS_PIXELS = 4


def _dans_carre_arrondi(x: float, y: float, cote: float, rayon: float) -> bool:
    if x < 0 or y < 0 or x > cote or y > cote:
        return False
    # Distance au rectangle intérieur, coins compris.
    dx = max(rayon - x, 0.0, x - (cote - rayon))
    dy = max(rayon - y, 0.0, y - (cote - rayon))
    return dx * dx + dy * dy <= rayon * rayon


def _dans_document(x: float, y: float, cote: float) -> bool:
    """Feuille blanche centrée, coin supérieur droit replié."""
    gauche, droite = 0.28 * cote, 0.72 * cote
    haut, bas = 0.22 * cote, 0.78 * cote
    if not (gauche <= x <= droite and haut <= y <= bas):
        return False
    # Le pli : on retire le triangle du coin supérieur droit.
    pli = 0.16 * cote
    return (droite - x) + (y - haut) >= pli


def _dans_pli(x: float, y: float, cote: float) -> bool:
    droite, haut = 0.72 * cote, 0.22 * cote
    pli = 0.16 * cote
    return (droite - x) + (y - haut) < pli and x <= droite and y >= haut


def _dans_lignes(x: float, y: float, cote: float) -> bool:
    """Trois traits de texte. Le premier est plus court : il figure un titre."""
    gauche = 0.36 * cote
    epaisseur = 0.055 * cote
    for rang, longueur in enumerate((0.18, 0.28, 0.28)):
        centre = (0.40 + rang * 0.13) * cote
        if abs(y - centre) <= epaisseur / 2 and gauche <= x <= gauche + longueur * cote:
            return True
    return False


def _couleur(x: float, y: float, cote: float):
    """Couleur d'un sous-pixel, ou None s'il est hors de l'icône."""
    if not _dans_carre_arrondi(x, y, cote, cote * 0.22):
        return None
    if _dans_lignes(x, y, cote) and _dans_document(x, y, cote):
        return CORAIL_FONCE
    if _dans_document(x, y, cote):
        return BLANC
    if _dans_pli(x, y, cote):
        return CORAIL_FONCE
    return CORAIL


def dessiner(cote: int) -> bytes:
    """Raster RGBA, une ligne après l'autre, avec anticrénelage."""
    lignes = bytearray()
    pas = 1.0 / SOUS_PIXELS
    poids = SOUS_PIXELS * SOUS_PIXELS

    for py in range(cote):
        lignes.append(0)  # filtre PNG « None »
        for px in range(cote):
            rouge = vert = bleu = alpha = 0
            for sy in range(SOUS_PIXELS):
                for sx in range(SOUS_PIXELS):
                    couleur = _couleur(
                        px + (sx + 0.5) * pas, py + (sy + 0.5) * pas, float(cote)
                    )
                    if couleur is None:
                        continue
                    rouge += couleur[0]
                    vert += couleur[1]
                    bleu += couleur[2]
                    alpha += 255
            if alpha == 0:
                lignes += b"\x00\x00\x00\x00"
                continue
            # Couleurs moyennées sur les seuls sous-pixels couverts, sinon les
            # bords tireraient vers le noir.
            couverts = alpha // 255
            lignes += bytes((
                rouge // couverts, vert // couverts, bleu // couverts, alpha // poids,
            ))
    return bytes(lignes)


def _bloc(nom: bytes, donnees: bytes) -> bytes:
    corps = nom + donnees
    return struct.pack(">I", len(donnees)) + corps + struct.pack(
        ">I", zlib.crc32(corps) & 0xFFFFFFFF
    )


def png(cote: int) -> bytes:
    entete = struct.pack(">IIBBBBB", cote, cote, 8, 6, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + _bloc(b"IHDR", entete)
        + _bloc(b"IDAT", zlib.compress(dessiner(cote), 9))
        + _bloc(b"IEND", b"")
    )


def ico(tailles=TAILLES) -> bytes:
    images = [(cote, png(cote)) for cote in tailles]
    entete = struct.pack("<HHH", 0, 1, len(images))

    decalage = len(entete) + 16 * len(images)
    entrees, corps = b"", b""
    for cote, donnees in images:
        # 0 signifie 256 dans le format ICO.
        entrees += struct.pack(
            "<BBBBHHII",
            cote if cote < 256 else 0, cote if cote < 256 else 0,
            0, 0, 1, 32, len(donnees), decalage,
        )
        corps += donnees
        decalage += len(donnees)

    return entete + entrees + corps


if __name__ == "__main__":
    cible = Path(__file__).resolve().parent / "liora.ico"
    cible.write_bytes(ico())
    print(f"{cible} — {cible.stat().st_size} octets, {len(TAILLES)} tailles")
