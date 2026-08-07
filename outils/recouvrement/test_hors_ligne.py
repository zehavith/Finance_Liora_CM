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
from datetime import datetime, timedelta, timezone
from email.message import EmailMessage
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from dossiers import ErreurDossiers, lire_dossiers  # noqa: E402
from indexation import LigneIndex  # noqa: E402
from synthese import analyser, rediger_constats  # noqa: E402
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


EXPORT_MONDAY = """Recouvrement 2024-2025

Contentieux
Name,Statut,Email,Facture,Montant,Propriétaire
Marie Dupont,En cours,marie.dupont@exemple.fr,FA-2024-0153,1890,Zehavit
Sophie Bernard,Relancée,sophie.bernard@exemple.fr,FA-2024-0161,940,Zehavit

Échéancier accepté
Camille Leroy,Échéancier,camille.leroy@exemple.fr,FA-2024-0174,2300,Zehavit
"""


def test_export_monday() -> None:
    """Un export Monday brut, sans retouche : en-tête décalé, séparateur
    virgule, lignes de groupe intercalées."""
    print("\nLecture d'un export Monday")
    with tempfile.TemporaryDirectory() as repertoire:
        fichier = Path(repertoire) / "monday.csv"
        fichier.write_text(EXPORT_MONDAY, encoding="utf-8")

        try:
            lire_dossiers(fichier)
            verifier(False, "ligne de groupe signalée par défaut")
        except ErreurDossiers as exc:
            verifier("ligne 8" in str(exc), f"ligne de groupe localisée en ligne 8 ({exc})")
            verifier("Échéancier accepté" in str(exc), "contenu de la ligne fautive rappelé")

        avertissements: list[str] = []
        liste = lire_dossiers(
            fichier, ignorer_lignes_incompletes=True, signaler=avertissements.append
        )
        verifier(len(liste) == 3, f"3 dossiers lus (obtenu : {len(liste)})")
        verifier(liste[0].nom == "Marie Dupont", "colonne « Name » reconnue comme le nom")
        verifier(
            liste[2].emails == ["camille.leroy@exemple.fr"],
            "dossier situé après une ligne de groupe correctement lu",
        )
        verifier(
            any("ligne(s) 8" in message for message in avertissements),
            "ligne écartée signalée, jamais silencieusement",
        )


def test_export_monday_reel() -> None:
    """Reproduit la structure d'un export Monday de facturation : en-tête en
    ligne 3, « Name » portant le n° de facture, deux colonnes d'adresses, une
    colonne « Adresse » postale, et des lignes de total de groupe."""
    print("\nExport Monday de facturation (structure réelle)")
    entetes = [
        "Name", "Type de paiement", "Nom & Prénom de l'apprenant", "Raison social",
        "N° Facture", "E-mail", "E-mail GCard", "Adresse", "Code postal",
        "Total Facture", "Statut Créance",
    ]
    rangees = [
        ["2.1. Financement Personnel"] + [""] * 10,
        ["2.1.4. Factures en recouvrement"] + [""] * 10,
        entetes,
        ["FACT-2405-00030", "GoCardLess", "Aïssata Conte", "Aïssata Conte",
         "FACT-2405-00030", "aichaconte@yahoo.fr", "", "9 Rue du Grenier", "75003",
         "1280", "Créance douteuse"],
        ["FACT-2405-00142", "GoCardLess", "Julien Roux", "Julien Roux",
         "FACT-2405-00142", "persee67@gmail.com", "jr.pro@societe.fr",
         "11 rue Staedel", "67100", "3721", "Créance douteuse"],
        # Ligne de total de groupe ajoutée par Monday.
        ["", "", "", "", "", "", "", "", "", "2022-03-15 to 2024-03-05", ""],
        ["", "", "", "", "", "", "", "", "", "", ""],
    ]

    with tempfile.TemporaryDirectory() as repertoire:
        fichier = Path(repertoire) / "monday-facturation.csv"
        with fichier.open("w", encoding="utf-8", newline="") as sortie:
            import csv as module_csv  # noqa: PLC0415

            module_csv.writer(sortie, delimiter=";").writerows(rangees)

        messages: list[str] = []
        liste = lire_dossiers(fichier, signaler=messages.append)

        verifier(len(liste) == 2, f"2 dossiers lus (obtenu : {len(liste)})")

        colonnes = " ".join(messages)
        verifier(
            "« Adresse » → email" not in colonnes,
            "l'adresse postale n'est pas prise pour une adresse mail",
        )
        verifier(
            "« Nom & Prénom de l'apprenant » → nom" in colonnes,
            "la colonne de nom précise l'emporte sur « Name »",
        )
        verifier(
            liste[0].nom == "Aïssata Conte",
            f"nom de l'apprenante retenu (obtenu : {liste[0].nom!r})",
        )
        verifier(
            liste[0].factures == ["FACT-2405-00030"], "numéro de facture retenu"
        )
        verifier(
            liste[0].reference == "FACT-2405-00030",
            "à défaut de colonne dédiée, la facture sert de référence de dossier",
        )
        verifier(
            liste[1].emails == ["persee67@gmail.com", "jr.pro@societe.fr"],
            f"les deux colonnes d'adresses sont réunies (obtenu : {liste[1].emails})",
        )
        verifier(
            "9 Rue du Grenier" not in liste[0].requete_gmail(),
            "l'adresse postale n'entre pas dans la requête Gmail",
        )
        verifier(
            any("total ou de groupe" in message for message in messages),
            "ligne de total de groupe signalée, non escamotée",
        )


def test_lecture_xlsx() -> None:
    """Le même tableau au format Excel, lu sans conversion préalable."""
    print("\nLecture directe d'un fichier Excel")
    try:
        import openpyxl  # noqa: PLC0415
    except ImportError:
        print("  info  openpyxl absent : vérification sans objet")
        return

    with tempfile.TemporaryDirectory() as repertoire:
        fichier = Path(repertoire) / "dossiers.xlsx"
        classeur = openpyxl.Workbook()
        feuille = classeur.active
        feuille.append(["2.1. Financement Personnel"])
        feuille.append([])
        feuille.append(["Name", "Nom & Prénom de l'apprenant", "N° Facture",
                        "E-mail", "Adresse", "Date facture"])
        feuille.append(["FACT-1", "Marie Dupont", "FACT-2024-0153",
                        "marie.dupont@exemple.fr", "3 rue de la Paix",
                        datetime(2024, 10, 15)])
        classeur.save(fichier)

        liste = lire_dossiers(fichier)
        verifier(len(liste) == 1, "dossier lu depuis le .xlsx")
        verifier(liste[0].nom == "Marie Dupont", "nom lu depuis le .xlsx")
        verifier(
            liste[0].emails == ["marie.dupont@exemple.fr"], "adresse lue depuis le .xlsx"
        )
        verifier(
            liste[0].factures == ["FACT-2024-0153"], "facture lue depuis le .xlsx"
        )


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


def _reponse_apprenante() -> EmailMessage:
    """Réponse de l'apprenante, antérieure à la mise en demeure, sollicitant
    un échéancier."""
    msg = EmailMessage()
    msg["From"] = "Marie Dupont <marie.dupont@exemple.fr>"
    msg["To"] = "recouvrement@liora.io"
    msg["Subject"] = "Re: facture FA-2024-0153"
    msg["Date"] = "Mon, 04 Mar 2024 08:00:00 +0100"
    msg["Message-ID"] = "<reponse-apprenante@exemple.fr>"
    msg.set_content(
        "Bonjour, puis-je échelonner le paiement en trois mensualités ? "
        "Je traverse des difficultés financières."
    )
    return msg


def _message_variante(identifiant: str) -> EmailMessage:
    """m1 : mise en demeure émise par Liora, avec pièce jointe.
    m2 : réponse de l'apprenante, plus ancienne.
    m1 est servi par les deux boîtes — c'est le doublon à écarter."""
    return _reponse_apprenante() if identifiant == "m2" else message_de_test()


class ClientFictif:
    """Remplace une boîte Gmail. `boite` détermine ce qu'elle contient."""

    def __init__(self, boite="recouvrement@liora.io", messages=("m1", "m2"), **_):
        self._boite = boite
        self._messages = list(messages)

    @property
    def adresse_boite(self) -> str:
        return self._boite

    def rechercher_identifiants(self, requete, inclure_spam_corbeille=True, plafond=None):
        return list(self._messages) if "marie.dupont" in requete else []

    def recuperer_messages(self, identifiants):
        for identifiant in identifiants:
            message = lire_message(
                {"id": identifiant, "threadId": "t1", "internalDate": "1710231243000"},
                _message_variante(identifiant).as_bytes(),
            )
            message.boites = [self._boite]
            yield message


def _sources_fictives(**_):
    """billing@ ne détient que la mise en demeure, déjà présente dans
    recouvrement@ : elle doit être reconnue comme un doublon."""
    from gmail_api import SourcesGmail  # noqa: PLC0415

    return SourcesGmail([
        ClientFictif("recouvrement@liora.io", ["m1", "m2"]),
        ClientFictif("billing@liora.io", ["m1"]),
    ])


def test_export_complet() -> None:
    """Chaîne complète : lecture du CSV, export, index et récapitulatif."""
    print("\nExport complet (accès Gmail simulé)")
    import csv as module_csv  # noqa: PLC0415

    import export_mails  # noqa: PLC0415

    vraies_sources = export_mails.ouvrir_sources
    export_mails.ouvrir_sources = _sources_fictives
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
                len(list((dossier1 / "pieces-jointes").rglob("*.pdf"))) == 1,
                "pièce jointe extraite (seule la mise en demeure en porte une)",
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
            verifier(
                set(rangees[1]["boites"].split(" | "))
                == {"recouvrement@liora.io", "billing@liora.io"},
                "message présent dans les deux boîtes : les deux sont citées",
            )
            verifier(
                (dossier1 / "synthese.pdf").exists()
                or (dossier1 / "synthese.html").exists(),
                "note de synthèse générée",
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
            verifier(recap[0]["nb_mails"] == "2", "récapitulatif : messages dédoublonnés")
            verifier(
                recap[0]["doublons_ecartes"] == "1",
                "récapitulatif : doublon inter-boîtes décompté",
            )
            verifier(
                recap[0]["mise_en_demeure"] == "non",
                "récapitulatif : absence de mise en demeure signalée",
            )
            verifier(
                recap[0]["echeancier"] == "04/03/2024",
                "récapitulatif : demande d'échéancier repérée",
            )
            verifier(
                recap[0]["contestation"] == "non",
                "récapitulatif : absence de contestation signalée",
            )
            verifier(
                recap[0]["derniere_reponse"] == "04/03/2024",
                "récapitulatif : dernière réponse de l'apprenante",
            )
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
        export_mails.ouvrir_sources = vraies_sources


def _ligne(piece: int, jour: int, sens: str, objet: str) -> LigneIndex:
    return LigneIndex(
        piece_n=piece,
        date=datetime(2025, 3, jour, 10, 0, tzinfo=timezone(timedelta(hours=1))),
        sens=sens,
        expediteur="x@y.fr",
        destinataires="z@w.fr",
        copie="",
        objet=objet,
        nb_pieces_jointes=0,
        pieces_jointes="",
        critere="adresse",
        boites="recouvrement@liora.io",
        fichier_pdf="",
        fichier_eml="",
        dossier_pieces_jointes="",
        thread_id="t",
        message_id=f"<m{piece}>",
    )


def test_synthese() -> None:
    """Détection des événements et rédaction des constats."""
    print("\nNote de synthèse")
    reference = datetime(2025, 4, 20, tzinfo=timezone(timedelta(hours=1)))

    lignes = [
        _ligne(1, 3, "envoyé", "Votre facture FA-2024-0153"),
        _ligne(2, 5, "reçu", "Re: votre facture"),
        _ligne(3, 8, "envoyé", "Relance — facture reste impayée"),
        _ligne(4, 12, "reçu", "Absence du bureau"),
        _ligne(5, 15, "envoyé", "Mise en demeure de régler"),
    ]
    textes = {
        1: "Veuillez trouver la facture correspondant à votre formation.",
        2: "Puis-je étaler le paiement en plusieurs fois ? Je suis au chômage.",
        3: "La somme reste impayée à ce jour.",
        4: "Je suis absente jusqu'au 20 mars. Réponse automatique.",
        5: "Nous vous mettons en demeure de régler sous quinze jours.",
    }

    analyse = analyser(lignes, textes, doublons=2)
    libelles = {ev.libelle for ev in analyse.evenements}

    verifier("Envoi de facture" in libelles, "envoi de facture repéré")
    verifier("Échéancier évoqué" in libelles, "demande d'échéancier repérée")
    verifier("Difficultés financières invoquées" in libelles, "difficultés financières repérées")
    verifier("Relance" in libelles, "relance repérée")
    verifier("Mise en demeure" in libelles, "mise en demeure repérée")
    verifier("Contestation" not in libelles, "aucune contestation inventée")

    verifier(
        analyse.derniere_reponse is not None and analyse.derniere_reponse.day == 5,
        "réponse automatique non comptée comme réponse de l'apprenante",
    )
    verifier(analyse.nb_envoyes == 3 and analyse.nb_recus == 2, "décompte par sens")
    verifier(analyse.doublons_ecartes == 2, "doublons inter-boîtes reportés")

    constats = " ".join(rediger_constats(analyse, reference))
    verifier("pièce n° 5" in constats, "constat de mise en demeure rattaché à sa pièce")
    verifier(
        "Aucune contestation" in constats,
        "absence de contestation formulée explicitement",
    )
    # Du 15/03 à 10h00 au 20/04 à 00h00 : 35 jours pleins.
    verifier("35 jours" in constats, "silence calculé depuis le dernier échange")

    print("\nNote de synthèse — dossier sans aucune réponse")
    muet = analyser(
        [_ligne(1, 3, "envoyé", "Relance"), _ligne(2, 9, "envoyé", "Relance")],
        {1: "reste impayé", 2: "reste impayé"},
    )
    constats_muet = " ".join(rediger_constats(muet, reference))
    verifier(
        "Aucune réponse de l'apprenante" in constats_muet,
        "silence total de l'apprenante signalé",
    )
    verifier(
        "Aucune mise en demeure" in constats_muet,
        "absence de mise en demeure signalée comme point à vérifier",
    )


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
    test_export_monday()
    test_export_monday_reel()
    test_lecture_xlsx()
    test_nettoyage_html()
    test_synthese()
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
