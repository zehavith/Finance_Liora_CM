#!/usr/bin/env python3
"""Vérification hors ligne : lecture du fichier de dossiers, construction des
requêtes, décodage d'un message et génération des fichiers de sortie.

Ne touche pas à Gmail et ne demande aucune autorisation. À lancer après une
installation pour vérifier que le poste est correctement équipé :

    python test_hors_ligne.py
"""

from __future__ import annotations

import sys
import tempfile
from datetime import datetime
from email.message import EmailMessage
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from dossiers import ErreurDossiers, lire_dossiers  # noqa: E402
from message import lire_message  # noqa: E402
from rendu import (  # noqa: E402
    construire_html_message,
    ecrire_eml,
    ecrire_pdf,
    ecrire_pieces_jointes,
    moteur_pdf_disponible,
    nettoyer_html,
    nom_de_base,
    slug,
)

# PNG valide de 1x1 pixel (logo de signature simulé).
PIXEL_PNG = bytes.fromhex(
    "89504e470d0a1a0a0000000d494844520000000100000001080200000090"
    "7753de0000000c49444154789c63f89fc6000003cd0166c36cff5a000000"
    "0049454e44ae426082"
)

# Même en-tête PNG, flux de données tronqué : simule une image abîmée telle
# qu'on en trouve dans de vrais messages. Ne doit pas faire échouer le PDF.
PIXEL_PNG_CASSE = PIXEL_PNG[:30] + b"\x00\x00\x00\x00"

echecs: list[str] = []


def verifier(condition: bool, libelle: str) -> None:
    if condition:
        print(f"  ok   {libelle}")
    else:
        print(f"  ÉCHEC {libelle}")
        echecs.append(libelle)


def message_de_test(image: bytes = PIXEL_PNG) -> EmailMessage:
    msg = EmailMessage()
    msg["From"] = "Recouvrement Liora <recouvrement@liora.io>"
    msg["To"] = "Marie Dupont <marie.dupont@exemple.fr>"
    msg["Cc"] = "compta@liora.io"
    msg["Subject"] = "Relance n°2 — facture FA-2024-0153 échue"
    msg["Date"] = "Tue, 12 Mar 2024 09:14:03 +0100"
    msg["Message-ID"] = "<relance-2-fa20240153@liora.io>"

    msg.set_content(
        "Bonjour,\n\nSauf erreur, la facture FA-2024-0153 reste impayée.\n\nCordialement"
    )
    msg.add_alternative(
        """<html><body>
        <p>Bonjour,</p>
        <p>Sauf erreur, la facture <b>FA-2024-0153</b> reste impay&eacute;e.</p>
        <script>alert('code actif')</script>
        <img src="https://tracking.exemple.net/pixel.gif?id=42" alt="pixel" />
        <img src="cid:logo-liora" alt="Liora" />
        <a href="javascript:void(0)">lien actif</a>
        <p>Cordialement</p>
        </body></html>""",
        subtype="html",
    )

    partie_html = msg.get_payload()[1]
    partie_html.add_related(
        image, maintype="image", subtype="png", cid="<logo-liora>", filename="logo.png"
    )
    msg.add_attachment(
        b"%PDF-1.4 contenu de facture", maintype="application", subtype="pdf",
        filename="Facture FA-2024-0153.pdf",
    )
    return msg


def test_dossiers() -> None:
    print("\nLecture du fichier de dossiers")
    liste = lire_dossiers(Path(__file__).resolve().parent / "dossiers.exemple.csv")
    verifier(len(liste) == 4, f"4 dossiers lus (obtenu : {len(liste)})")

    premier = liste[0]
    requete = premier.requete_gmail()
    verifier("from:marie.dupont@exemple.fr" in requete, "requête : critère expéditeur")
    verifier("to:marie.dupont@exemple.fr" in requete, "requête : critère destinataire")
    verifier('"FA-2024-0153"' in requete, "requête : numéro de facture en texte")
    verifier("filename:FA-2024-0153" in requete, "requête : numéro de facture en pièce jointe")
    verifier("after:2023/09/01" in requete, "requête : borne de date convertie pour Gmail")

    verifier(len(liste[1].emails) == 2, "deux adresses sur un même dossier")
    verifier(len(liste[2].factures) == 2, "deux factures sur un même dossier")
    verifier(
        liste[3].emails == [] and liste[3].factures == ["FA-2024-0201"],
        "dossier sans adresse, uniquement par numéro de facture",
    )
    verifier(
        premier.criteres_trouves("relance facture fa-2024-0153 pour marie.dupont@exemple.fr")
        == "adresse+facture",
        "détection des deux critères sur un message",
    )

    print("\nRefus des saisies incomplètes")
    with tempfile.TemporaryDirectory() as repertoire:
        vide = Path(repertoire) / "vide.csv"
        vide.write_text("reference;nom;email;facture\nD1;Sans critere;;\n", encoding="utf-8")
        try:
            lire_dossiers(vide)
            verifier(False, "ligne sans critère rejetée")
        except ErreurDossiers:
            verifier(True, "ligne sans critère rejetée")

        mauvaises_colonnes = Path(repertoire) / "colonnes.csv"
        mauvaises_colonnes.write_text("nom;telephone\nX;06\n", encoding="utf-8")
        try:
            lire_dossiers(mauvaises_colonnes)
            verifier(False, "fichier sans colonne email ni facture rejeté")
        except ErreurDossiers:
            verifier(True, "fichier sans colonne email ni facture rejeté")


def test_nettoyage_html() -> None:
    print("\nNettoyage du HTML des messages")
    brut = (
        '<p onclick="voler()">texte</p><script>alert(1)</script>'
        '<img src="https://tracking.exemple.net/p.gif" alt="pixel" />'
        '<a href="javascript:x()">lien</a>'
        '<div style="background:url(https://exemple.net/f.png)">fond</div>'
    )
    propre = nettoyer_html(brut, {})
    verifier("<script" not in propre, "balise script supprimée")
    verifier("alert(1)" not in propre, "contenu du script supprimé")
    verifier("onclick" not in propre, "gestionnaire d'évènement supprimé")
    verifier("tracking.exemple.net" not in propre, "image distante non chargée")
    verifier("javascript:" not in propre, "lien javascript neutralisé")
    verifier("exemple.net/f.png" not in propre, "image de fond CSS neutralisée")
    verifier("texte" in propre and "lien" in propre, "texte du message conservé")


def test_rendu_message() -> None:
    print("\nDécodage et écriture d'un message")
    brut = message_de_test().as_bytes()
    donnees = {"id": "18f2ab", "threadId": "18f2aa", "internalDate": "1710231243000",
               "labelIds": ["SENT"]}
    message = lire_message(donnees, brut)

    verifier(message.objet.startswith("Relance n°2"), "objet décodé")
    verifier("marie.dupont@exemple.fr" in message.destinataires, "destinataire décodé")
    verifier(message.date.strftime("%d/%m/%Y %H:%M") == "12/03/2024 09:14", "date décodée")
    verifier(len(message.pieces_jointes) == 1, "1 pièce jointe détectée")
    verifier(
        message.pieces_jointes[0].nom == "Facture FA-2024-0153.pdf",
        "nom de pièce jointe conservé",
    )
    verifier(len(message.images_inline) == 1, "image intégrée détectée séparément")
    verifier("fa-2024-0153" in message.texte_recherchable, "texte recherchable alimenté")

    with tempfile.TemporaryDirectory() as repertoire:
        racine = Path(repertoire)
        base = nom_de_base(message, 1)
        verifier(base.startswith("001_2024-03-12_0914_"), f"nom de fichier daté ({base})")

        chemin_eml = ecrire_eml(message, racine / "mails", base)
        verifier(chemin_eml.read_bytes() == brut, ".eml écrit à l'identique de l'original")

        pieces = ecrire_pieces_jointes(message, racine / "pieces-jointes", base)
        verifier(len(pieces) == 1 and pieces[0].exists(), "pièce jointe extraite sur disque")
        verifier(
            pieces[0].read_bytes() == b"%PDF-1.4 contenu de facture",
            "pièce jointe intacte",
        )

        html = construire_html_message(
            message, 1, "2024-118", "recouvrement@liora.io", datetime(2026, 8, 7, 10, 0)
        )
        verifier("pièce n° 1" in html, "numéro de pièce dans l'en-tête du PDF")
        verifier("Message-ID" in html, "Message-ID reporté dans le PDF")
        verifier("tracking.exemple.net" not in html, "aucune ressource distante dans le PDF")
        verifier("data:image/png;base64" in html, "image intégrée incorporée au PDF")

        chemin_pdf = racine / "mails" / f"{base}.pdf"
        pdf_ok, moteur = ecrire_pdf(html, chemin_pdf)
        if pdf_ok:
            entete = chemin_pdf.read_bytes()[:5]
            verifier(entete == b"%PDF-", f"PDF généré via {moteur}")
            verifier(
                not chemin_pdf.with_suffix(".html").exists(),
                "fichier HTML intermédiaire nettoyé",
            )
        else:
            print("  info  aucun moteur PDF sur ce poste : page HTML conservée (comportement prévu)")
            verifier(chemin_pdf.with_suffix(".html").exists(), "page HTML conservée en secours")


def test_pdf_image_cassee() -> None:
    """Une image abîmée dans un message ne doit pas coûter la pièce."""
    print("\nRésistance à une image abîmée")
    if moteur_pdf_disponible().startswith("aucun"):
        print("  info  aucun moteur PDF sur ce poste : vérification sans objet")
        return

    brut = message_de_test(image=PIXEL_PNG_CASSE).as_bytes()
    message = lire_message({"id": "casse", "threadId": "casse"}, brut)
    html = construire_html_message(
        message, 1, "2024-118", "recouvrement@liora.io", datetime(2026, 8, 7, 10, 0)
    )
    verifier("data:image/png;base64" in html, "image abîmée tout de même incorporée au départ")

    with tempfile.TemporaryDirectory() as repertoire:
        chemin_pdf = Path(repertoire) / "piece.pdf"
        pdf_ok, moteur = ecrire_pdf(html, chemin_pdf)
        verifier(pdf_ok, f"PDF produit malgré l'image abîmée (moteur : {moteur})")
        if pdf_ok:
            verifier(chemin_pdf.read_bytes()[:5] == b"%PDF-", "fichier PDF valide")


class ClientFictif:
    """Remplace l'accès Gmail : renvoie deux messages pour le dossier dont la
    requête cite marie.dupont, aucun pour les autres."""

    def __init__(self, **_):
        pass

    @property
    def adresse_boite(self) -> str:
        return "recouvrement@liora.io"

    def rechercher_identifiants(self, requete, inclure_spam_corbeille=True, plafond=None):
        return ["m1", "m2"] if "marie.dupont" in requete else []

    def recuperer_messages(self, identifiants):
        for identifiant in identifiants:
            msg = message_de_test()
            if identifiant == "m2":
                # Deuxième message, plus ancien : vérifie le tri chronologique.
                del msg["Date"], msg["Subject"], msg["From"], msg["To"]
                msg["Date"] = "Mon, 04 Mar 2024 08:00:00 +0100"
                msg["Subject"] = "Premier envoi facture FA-2024-0153"
                msg["From"] = "Marie Dupont <marie.dupont@exemple.fr>"
                msg["To"] = "recouvrement@liora.io"
            yield lire_message(
                {"id": identifiant, "threadId": "t1", "internalDate": "1710231243000"},
                msg.as_bytes(),
            )


def test_export_complet() -> None:
    """Chaîne complète : lecture du CSV, export, index et récapitulatif."""
    print("\nExport complet (accès Gmail simulé)")
    import csv as module_csv  # noqa: PLC0415

    import export_mails  # noqa: PLC0415

    vrai_client = export_mails.ClientGmail
    export_mails.ClientGmail = ClientFictif
    try:
        with tempfile.TemporaryDirectory() as repertoire:
            racine = Path(repertoire)
            fichier = racine / "dossiers.csv"
            fichier.write_text(
                "reference;nom;email;facture\n"
                "2024-118;Marie Dupont;marie.dupont@exemple.fr;FA-2024-0153\n"
                "2024-119;Introuvable Personne;absente@exemple.fr;FA-2024-0999\n",
                encoding="utf-8",
            )
            sortie = racine / "export"
            code = export_mails.executer(
                export_mails.analyser_arguments(
                    ["--dossiers", str(fichier), "--sortie", str(sortie)]
                )
            )

            verifier(code == 0, "code de sortie 0")

            dossier1 = sortie / "2024-118_marie-dupont"
            verifier(dossier1.is_dir(), "répertoire du dossier créé")
            verifier(
                len(list((dossier1 / "mails").glob("*.eml"))) == 2,
                "2 fichiers .eml écrits",
            )
            verifier(
                len(list((dossier1 / "pieces-jointes").rglob("*.pdf"))) == 2,
                "pièces jointes extraites pour les 2 messages",
            )

            rangees = list(
                module_csv.DictReader(
                    (dossier1 / "index.csv").read_text(encoding="utf-8-sig").splitlines(),
                    delimiter=";",
                )
            )
            verifier(len(rangees) == 2, "index.csv : 2 lignes")
            verifier(
                rangees[0]["date"] == "04/03/2024" and rangees[1]["date"] == "12/03/2024",
                "index.csv trié par ordre chronologique",
            )
            verifier(rangees[0]["piece_n"] == "1", "numérotation des pièces à partir de 1")
            verifier(rangees[0]["sens"] == "reçu", "sens du message déterminé")
            verifier(rangees[1]["sens"] == "envoyé", "sens du message sortant déterminé")
            verifier(
                rangees[0]["critere"] == "adresse+facture", "critère de rattachement renseigné"
            )

            dossier2 = sortie / "2024-119_introuvable-personne"
            verifier(
                (dossier2 / "index.csv").exists(),
                "dossier sans message : index vide tout de même écrit",
            )

            recap = list(
                module_csv.DictReader(
                    (sortie / "_recapitulatif.csv").read_text(encoding="utf-8-sig").splitlines(),
                    delimiter=";",
                )
            )
            verifier(len(recap) == 2, "_recapitulatif.csv : une ligne par dossier")
            verifier(recap[0]["nb_mails"] == "2", "récapitulatif : nombre de messages")
            verifier(
                recap[0]["premier_mail"] == "04/03/2024"
                and recap[0]["dernier_mail"] == "12/03/2024",
                "récapitulatif : bornes de la chronologie",
            )
            verifier(
                recap[1]["statut"] == "aucun message",
                "récapitulatif : dossier vide signalé",
            )
            verifier(
                "from:marie.dupont@exemple.fr" in recap[0]["requete_gmail"],
                "récapitulatif : requête tracée pour vérification",
            )
            verifier(
                (sortie / "LISEZ-MOI.txt").exists() and (sortie / "journal.log").exists(),
                "note de méthode et journal écrits",
            )

            # Deuxième passage : les dossiers déjà faits doivent être ignorés.
            code = export_mails.executer(
                export_mails.analyser_arguments(
                    ["--dossiers", str(fichier), "--sortie", str(sortie), "--reprendre"]
                )
            )
            recap = list(
                module_csv.DictReader(
                    (sortie / "_recapitulatif.csv").read_text(encoding="utf-8-sig").splitlines(),
                    delimiter=";",
                )
            )
            verifier(
                code == 0 and recap[0]["statut"] == "ignoré (déjà exporté)",
                "--reprendre : dossier déjà exporté ignoré",
            )
    finally:
        export_mails.ClientGmail = vrai_client


def test_slug() -> None:
    print("\nNoms de fichiers")
    verifier(slug("Relance n°2 — facture échue") == "relance-n2-facture-echue", "accents retirés")
    verifier("/" not in slug("a/b\\c:d*e?f"), "caractères interdits retirés")
    verifier(len(slug("x" * 300)) <= 60, "longueur plafonnée")
    verifier(slug("") == "sans-titre", "nom vide remplacé")


def main() -> int:
    print(f"Python {sys.version.split()[0]}")
    print(f"Moteur PDF détecté : {moteur_pdf_disponible()}")

    test_dossiers()
    test_nettoyage_html()
    test_slug()
    test_rendu_message()
    test_pdf_image_cassee()
    test_export_complet()

    print()
    if echecs:
        print(f"{len(echecs)} vérification(s) en échec :")
        for libelle in echecs:
            print(f"  - {libelle}")
        return 1

    print("Toutes les vérifications sont passées.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
