#!/usr/bin/env python3
"""Vérification hors ligne : lecture du fichier de dossiers, construction des
requêtes, décodage d'un message et génération des fichiers de sortie.

Ne touche pas à Gmail et ne demande aucune autorisation. À lancer après une
installation pour vérifier que le poste est correctement équipé :

    python test_hors_ligne.py
"""

from __future__ import annotations

import io
import json
import sys
import tempfile
import threading
from datetime import datetime, timedelta, timezone
from email.message import EmailMessage
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from dossiers import (  # noqa: E402
    Dossier,
    ErreurDossiers,
    lire_dossiers,
    regrouper_par_debiteur,
)
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


def test_export_monday_entreprise() -> None:
    """Second tableau Monday : le débiteur est une société, « Name » porte le
    numéro de facture et non un nom, et trois colonnes d'adresses coexistent."""
    print("\nExport Monday entreprise (« Name » = numéro de facture)")
    rangees = [
        ["1.2. Entreprise - Recouvrement"] + [""] * 6,
        ["1.2.1. Recouvrement - Factures"] + [""] * 6,
        ["Name", "Service", "Entreprise", "Nom Prénom apprenant",
         "Email", "Email 2", "Email 3"],
        ["FACT-2405-02142", "Recouvrement", "Allianz SE", "Anna Geigenberger",
         "anna.g@ids.com", "compta@allianz.de", ""],
        ["FACT-2405-01408", "Recouvrement", "Pack and Tool", "Luc Marin",
         "luc@packandtool.fr", "", "adv@packandtool.fr"],
    ]
    with tempfile.TemporaryDirectory() as repertoire:
        fichier = Path(repertoire) / "entreprise.csv"
        with fichier.open("w", encoding="utf-8", newline="") as sortie:
            import csv as module_csv  # noqa: PLC0415

            module_csv.writer(sortie, delimiter=";").writerows(rangees)

        messages: list[str] = []
        liste = lire_dossiers(fichier, signaler=messages.append)
        colonnes = " ".join(messages)

        verifier(len(liste) == 2, f"2 dossiers lus (obtenu : {len(liste)})")
        verifier(
            "« Name » → facture" in colonnes,
            "« Name » rempli de références est reconnu comme numéro de facture",
        )
        verifier(
            "« Entreprise » → nom" in colonnes,
            "la société débitrice l'emporte pour nommer le dossier",
        )
        verifier(
            liste[0].factures == ["FACT-2405-02142"], "numéro de facture retenu"
        )
        verifier(liste[0].nom == "Allianz SE", "nom de la société retenu")
        verifier(
            liste[1].emails == ["luc@packandtool.fr", "adv@packandtool.fr"],
            f"les trois colonnes d'adresses sont réunies (obtenu : {liste[1].emails})",
        )
        verifier(
            liste[0].nom_repertoire == "fact-2405-02142_allianz-se",
            f"répertoire nommé par facture et société ({liste[0].nom_repertoire})",
        )

    print("\n  -- la même colonne « Name » remplie de noms reste un nom --")
    with tempfile.TemporaryDirectory() as repertoire:
        fichier = Path(repertoire) / "personnes.csv"
        fichier.write_text(
            "Name;Email;Facture\n"
            "Marie Dupont;marie@exemple.fr;FA-2024-0153\n"
            "Sophie Bernard;sophie@exemple.fr;FA-2024-0161\n",
            encoding="utf-8",
        )
        liste = lire_dossiers(fichier)
        verifier(liste[0].nom == "Marie Dupont", "« Name » de personnes reste un nom")
        verifier(
            liste[0].factures == ["FA-2024-0153"],
            "le vrai numéro de facture n'est pas supplanté",
        )


def test_regroupement() -> None:
    """Plusieurs factures d'un même débiteur forment un dossier unique."""
    print("\nRegroupement par débiteur")
    dossiers = [
        Dossier(reference="F-3", nom="Jean MONNEY", emails=["jb@exemple.fr"],
                factures=["F-3"], montant_du="1200", montant_total="1200",
                date_echeance="26/03/2024", liens=["https://monday.com/a"]),
        Dossier(reference="F-1", nom="Jean MONNEY", emails=["jb@exemple.fr"],
                factures=["F-1"], montant_du="750,50", montant_total="1500",
                date_echeance="26/01/2024", liens=["https://monday.com/b"]),
        Dossier(reference="F-2", nom="Autre Personne", emails=["autre@exemple.fr"],
                factures=["F-2"], montant_du="300"),
        # Même nom, adresse différente : deux homonymes, deux débiteurs.
        Dossier(reference="F-4", nom="Jean MONNEY", emails=["jm2@exemple.fr"],
                factures=["F-4"], montant_du="90"),
    ]

    messages: list[str] = []
    groupes = regrouper_par_debiteur(dossiers, signaler=messages.append)
    verifier(len(groupes) == 3, f"4 dossiers réduits à 3 (obtenu : {len(groupes)})")

    fusionne = next(d for d in groupes if len(d.factures) > 1)
    verifier(
        fusionne.reference == "F-1",
        f"la référence la plus basse nomme le dossier ({fusionne.reference})",
    )
    verifier(
        sorted(fusionne.factures) == ["F-1", "F-3"], "les deux factures sont réunies"
    )
    verifier(fusionne.montant_du == "1950.5", f"dette cumulée ({fusionne.montant_du})")
    verifier(
        fusionne.date_echeance == "26/01/2024",
        "l'échéance la plus ancienne est retenue, c'est elle qui date le retard",
    )
    verifier(len(fusionne.liens) == 2, "les liens des deux factures sont conservés")
    verifier(
        any("2 factures réunies" in m for m in messages),
        "le regroupement est annoncé, jamais silencieux",
    )
    verifier(
        sum(1 for d in groupes if d.nom == "Jean MONNEY") == 2,
        "deux homonymes d'adresses différentes restent deux dossiers",
    )

    intact = regrouper_par_debiteur(list(dossiers))
    verifier(len(intact) == 3, "le regroupement est reproductible")


def test_monday() -> None:
    """Téléchargement des documents Monday, API simulée.

    Le vrai service n'est pas joignable depuis un test : ce qui est vérifié
    ici, c'est la lecture des adresses, la construction de la requête, et
    surtout que rien n'interrompt l'export quand un document manque.
    """
    print("\nDocuments Monday")
    import monday as module_monday  # noqa: PLC0415

    url = ("https://cyberuniversity.monday.com/protected_static/23434454"
           "/resources/144307098/FACT-2405-00030.pdf")
    verifier(module_monday.identifiant(url) == "144307098", "identifiant de ressource extrait")
    verifier(module_monday.identifiant("https://exemple.fr/x.pdf") is None,
             "adresse sans identifiant reconnue comme telle")
    verifier(module_monday.nom_de_fichier(url) == "FACT-2405-00030.pdf", "nom de fichier déduit")

    with tempfile.TemporaryDirectory() as repertoire:
        racine = Path(repertoire)
        appels: list[str] = []

        def api_simulee(requete, jeton):
            appels.append(requete)
            return {"assets": [
                {"id": 144307098, "name": "FACT-2405-00030.pdf",
                 "public_url": "https://signe.exemple/facture.pdf"},
                # 999 est demandé mais absent de la réponse : droits ou suppression.
            ]}

        def telechargement_simule(url, destination):
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(b"%PDF-1.4 facture")
            return 16

        vraie_api = module_monday._appeler_api
        vrai_telechargement = module_monday.telecharger
        module_monday._appeler_api = api_simulee
        module_monday.telecharger = telechargement_simule
        try:
            ecrits, echecs = module_monday.recuperer_documents(
                [url, "https://cyberuniversity.monday.com/protected_static/1/resources/999/c.pdf",
                 "https://exemple.fr/sans-identifiant.pdf"],
                "jeton", racine / "documents-monday",
            )
        finally:
            module_monday._appeler_api = vraie_api
            module_monday.telecharger = vrai_telechargement

        verifier(ecrits == ["FACT-2405-00030.pdf"], f"document téléchargé ({ecrits})")
        verifier(
            (racine / "documents-monday" / "FACT-2405-00030.pdf").exists(),
            "fichier écrit sur le disque",
        )
        verifier(len(echecs) == 2, f"deux échecs signalés (obtenu : {len(echecs)})")
        verifier(
            any("999" in e for e in echecs),
            "ressource inaccessible nommée dans l'échec",
        )
        verifier(
            any("identifiant" in e for e in echecs),
            "adresse non reconnue signalée plutôt qu'ignorée",
        )
        verifier(
            "144307098" in appels[0] and "999" in appels[0],
            "une seule requête pour toutes les ressources du dossier",
        )

    print("\n  -- un service en panne n'interrompt pas l'export --")
    def api_en_panne(requete, jeton):
        raise module_monday.ErreurMonday("Monday injoignable : délai dépassé")

    vraie_api = module_monday._appeler_api
    module_monday._appeler_api = api_en_panne
    try:
        ecrits, echecs = module_monday.recuperer_documents(
            [url], "jeton", Path(tempfile.gettempdir()) / "inutilise"
        )
    finally:
        module_monday._appeler_api = vraie_api
    verifier(
        ecrits == [] and len(echecs) == 1 and "injoignable" in echecs[0],
        "panne remontée en échec, sans exception",
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


def _relance_seconde_facture() -> EmailMessage:
    """Relance ne concernant que la seconde facture."""
    msg = EmailMessage()
    msg["From"] = "Recouvrement Liora <recouvrement@liora.io>"
    msg["To"] = "Marie Dupont <marie.dupont@exemple.fr>"
    msg["Subject"] = "Relance — facture FA-2024-0154 échue"
    msg["Date"] = "Wed, 20 Mar 2024 09:00:00 +0100"
    msg["Message-ID"] = "<relance-fa20240154@liora.io>"
    msg.set_content("La facture FA-2024-0154 reste impayée à ce jour.")
    return msg


def _relance_generale() -> EmailMessage:
    """Relance qui ne nomme aucune facture : elle vaut pour toute la dette."""
    msg = EmailMessage()
    msg["From"] = "Recouvrement Liora <recouvrement@liora.io>"
    msg["To"] = "Marie Dupont <marie.dupont@exemple.fr>"
    msg["Subject"] = "Rappel — solde impayé"
    msg["Date"] = "Mon, 25 Mar 2024 09:00:00 +0100"
    msg["Message-ID"] = "<rappel-solde@liora.io>"
    msg.set_content(
        "Votre solde reste impayé malgré nos relances. Sans règlement sous "
        "huit jours, le dossier sera transmis au contentieux."
    )
    return msg


class ClientMultiFacture:
    """Boîte contenant les échanges d'une apprenante devant deux factures."""

    MESSAGES = {
        "m1": _reponse_apprenante,        # 04/03, nomme FA-2024-0153
        "m2": message_de_test,            # 12/03, nomme FA-2024-0153
        "m3": _relance_seconde_facture,   # 20/03, nomme FA-2024-0154
        "m4": _relance_generale,          # 25/03, n'en nomme aucune
    }

    adresse_boite = "recouvrement@liora.io"

    def rechercher_identifiants(self, requete, inclure_spam_corbeille=True, plafond=None):
        return list(self.MESSAGES) if "marie.dupont" in requete else []

    def recuperer_messages(self, identifiants):
        for identifiant in identifiants:
            message = lire_message(
                {"id": identifiant, "threadId": "t1", "internalDate": "1710231243000"},
                self.MESSAGES[identifiant]().as_bytes(),
            )
            message.boites = [self.adresse_boite]
            yield message


def _lire_index(chemin: Path) -> list[dict]:
    import csv as module_csv  # noqa: PLC0415

    return list(
        module_csv.DictReader(
            chemin.read_text(encoding="utf-8-sig").splitlines(), delimiter=";"
        )
    )


def test_sous_dossiers_par_facture() -> None:
    """Un débiteur, deux factures : un dossier qui mène à deux sous-dossiers."""
    print("\nUn sous-dossier par facture")

    import export_mails  # noqa: PLC0415
    from gmail_api import SourcesGmail  # noqa: PLC0415

    vraies_sources = export_mails.ouvrir_sources
    export_mails.ouvrir_sources = lambda **_: SourcesGmail([ClientMultiFacture()])
    try:
        with tempfile.TemporaryDirectory() as repertoire:
            racine = Path(repertoire)
            fichier = racine / "dossiers.csv"
            fichier.write_text(
                "reference;nom;email;facture;reste a payer\n"
                "2024-118;Marie Dupont;marie.dupont@exemple.fr;FA-2024-0153;1200\n"
                "2024-119;Marie Dupont;marie.dupont@exemple.fr;FA-2024-0154;800\n",
                encoding="utf-8",
            )
            sortie = racine / "export"
            code = export_mails.executer(
                export_mails.analyser_arguments(
                    ["--dossiers", str(fichier), "--sortie", str(sortie)]
                )
            )
            verifier(code == 0, "code de sortie 0")

            dossier = sortie / "2024-118_marie-dupont"
            verifier(dossier.is_dir(), "un seul dossier pour les deux factures")
            verifier(
                len(list(sortie.glob("2024-*"))) == 1,
                "aucun second répertoire au même contenu",
            )

            index = _lire_index(dossier / "index.csv")
            par_piece = {int(rangee["piece_n"]): rangee for rangee in index}
            verifier(len(index) == 4, "index du dossier : 4 pièces")
            verifier(
                par_piece[3]["factures_concernees"] == "FA-2024-0154",
                "la facture nommée dans le message est reconnue",
            )
            verifier(
                par_piece[4]["factures_concernees"] == "",
                "un message qui ne nomme aucune facture reste sans rattachement",
            )

            sous = dossier / "factures"
            verifier(sous.is_dir(), "le dossier mène à un répertoire « factures »")
            verifier(
                sorted(chemin.name for chemin in sous.iterdir())
                == ["fa-2024-0153", "fa-2024-0154"],
                "un sous-dossier par facture, nommé par son numéro",
            )

            premier = _lire_index(sous / "fa-2024-0153" / "index.csv")
            second = _lire_index(sous / "fa-2024-0154" / "index.csv")
            verifier(
                [int(r["piece_n"]) for r in premier] == [1, 2, 4],
                "FA-2024-0153 : ses deux échanges plus la relance générale",
            )
            verifier(
                [int(r["piece_n"]) for r in second] == [3, 4],
                "FA-2024-0154 : son échange plus la relance générale",
            )
            verifier(
                int(premier[0]["piece_n"]) == 1 and premier[-1]["piece_n"] == "4",
                "les numéros de pièce du dossier sont conservés, non renumérotés",
            )

            for nom, attendu in (("fa-2024-0153", 3), ("fa-2024-0154", 2)):
                cible = sous / nom
                verifier(
                    len(list((cible / "mails").glob("*.eml"))) == attendu,
                    f"{nom} : {attendu} message(s) réellement recopié(s)",
                )
                verifier(
                    (cible / "synthese.pdf").exists() or (cible / "synthese.html").exists(),
                    f"{nom} : note de synthèse propre au sous-dossier",
                )

            verifier(
                len(list((sous / "fa-2024-0153" / "pieces-jointes").rglob("*.pdf"))) == 1,
                "les pièces jointes suivent leur message dans le sous-dossier",
            )
            verifier(
                not (sous / "fa-2024-0154" / "pieces-jointes").exists(),
                "aucune pièce jointe recopiée dans le sous-dossier qui n'en a pas",
            )

            recap = _lire_index(sortie / "_recapitulatif.csv")
            verifier(
                recap[0]["sous_dossiers_factures"] == "2",
                "récapitulatif : les sous-dossiers sont décomptés",
            )
            verifier(
                recap[0]["montant_du"] == "2000",
                "récapitulatif : la dette du débiteur est bien cumulée",
            )

            # Sans l'option, la structure d'origine est conservée à l'identique.
            sortie2 = racine / "export-plat"
            export_mails.executer(
                export_mails.analyser_arguments([
                    "--dossiers", str(fichier), "--sortie", str(sortie2),
                    "--sans-sous-dossiers",
                ])
            )
            verifier(
                not (sortie2 / "2024-118_marie-dupont" / "factures").exists(),
                "--sans-sous-dossiers : aucun découpage par facture",
            )
    finally:
        export_mails.ouvrir_sources = vraies_sources


def test_factures_citees() -> None:
    """Reconnaissance d'un numéro de facture dans le texte d'un message."""
    print("\nRattachement d'un message à sa facture")
    from dossiers import Dossier  # noqa: PLC0415

    dossier = Dossier(
        reference="D1", nom="X",
        emails=["a@b.fr"], factures=["FA-2024-0153", "118"],
    )
    verifier(
        dossier.factures_citees("la facture fa-2024-0153 reste impayée")
        == ["FA-2024-0153"],
        "numéro reconnu quelle que soit la casse",
    )
    verifier(
        dossier.factures_citees("votre facture n° 118 du 3 mars") == ["118"],
        "numéro court reconnu quand il est isolé",
    )
    verifier(
        dossier.factures_citees("le montant de 1180 euros") == [],
        "un numéro court n'est pas reconnu à l'intérieur d'un autre nombre",
    )
    verifier(
        dossier.factures_citees("facture fa-2024-01530") == [],
        "un numéro n'est pas reconnu à l'intérieur d'un numéro plus long",
    )
    verifier(
        dossier.factures_citees("rappel de votre solde impayé") == [],
        "un message sans numéro ne se rattache à aucune facture",
    )

    seul = Dossier(reference="D2", nom="Y", emails=["a@b.fr"], factures=["F1"])
    verifier(
        seul.repartition_par_facture() == [],
        "une seule facture : aucun sous-dossier, le découpage n'apporterait rien",
    )

    multiple = Dossier(
        reference="D3", nom="Z", emails=["a@b.fr"],
        factures=["F1", "F2"], montant_du="900",
    )
    parts = multiple.repartition_par_facture()
    verifier(len(parts) == 2, "deux factures sur une même ligne : deux sous-dossiers")
    verifier(
        all(part.montant_du == "" for part in parts),
        "montant d'une ligne unique non réparti : il resterait faux sur chaque facture",
    )

    # La note du dossier doit annoncer les sous-dossiers, sinon personne ne
    # pense à les ouvrir : le PDF est le seul document réellement lu.
    import synthese as module_synthese  # noqa: PLC0415

    lignes = [
        _ligne(1, 3, "envoyé", "Relance F1"),
        _ligne(2, 5, "envoyé", "Rappel général"),
    ]
    lignes[0].factures_concernees = "F1"
    page = module_synthese.construire_html(
        dossier=multiple,
        boites=["recouvrement@liora.io"],
        lignes=lignes,
        synthese=module_synthese.analyser(lignes, {}),
        date_export=datetime(2025, 4, 1, tzinfo=timezone(timedelta(hours=1))),
    )
    verifier(
        "Répartition par facture" in page and "factures/f1" in page,
        "la note du dossier annonce ses sous-dossiers et leur chemin",
    )
    verifier(
        "2 dont 1 la nommant" in page,
        "la note distingue les échanges nommant la facture des relances générales",
    )

    # Même annonce pour la vue par adresse, mais seulement quand elle est
    # demandée : la note ne doit jamais citer un répertoire qui n'existe pas.
    deux_adresses = Dossier(
        reference="D4", nom="W", emails=["a@b.fr", "c@d.fr"], factures=["F1"],
    )
    verifier(
        deux_adresses.adresses_citees("De : A <a@b.fr> À : recouvrement@liora.io")
        == ["a@b.fr"],
        "adresse reconnue parmi les parties au message",
    )
    verifier(
        deux_adresses.adresses_citees("De : compta@liora.io") == [],
        "message sans adresse du débiteur en en-tête : aucun rattachement",
    )
    lignes[0].adresses_concernees = "a@b.fr"
    avec = module_synthese.construire_html(
        dossier=deux_adresses, boites=["recouvrement@liora.io"], lignes=lignes,
        synthese=module_synthese.analyser(lignes, {}),
        date_export=datetime(2025, 4, 1, tzinfo=timezone(timedelta(hours=1))),
        vues={"factures", "adresses"},
    )
    verifier(
        "Répartition par adresse mail" in avec and "adresses/a-b-fr" in avec,
        "la note annonce la vue par adresse quand elle est produite",
    )
    sans = module_synthese.construire_html(
        dossier=deux_adresses, boites=["recouvrement@liora.io"], lignes=lignes,
        synthese=module_synthese.analyser(lignes, {}),
        date_export=datetime(2025, 4, 1, tzinfo=timezone(timedelta(hours=1))),
        vues={"factures"},
    )
    verifier(
        "Répartition par adresse mail" not in sans,
        "la note n'annonce pas une vue par adresse qui n'a pas été écrite",
    )

    sous = module_synthese.pieces_de_facture(["F2"], lignes)
    verifier(
        [ligne.piece_n for ligne in sous] == [2],
        "un échange réservé à une autre facture n'entre pas dans le sous-dossier",
    )

    fille = module_synthese.construire_html(
        dossier=parts[0],
        boites=["recouvrement@liora.io"],
        lignes=lignes,
        synthese=module_synthese.analyser(lignes, {}),
        date_export=datetime(2025, 4, 1, tzinfo=timezone(timedelta(hours=1))),
        rattachement="D3 — Z",
    )
    verifier(
        "Rattaché au dossier" in fille and "Répartition par facture" not in fille,
        "la note d'un sous-dossier renvoie au dossier parent sans se redécouper",
    )


def _echange(sujet: str, de: str, a: str, jour: int, corps: str) -> EmailMessage:
    msg = EmailMessage()
    msg["From"] = de
    msg["To"] = a
    msg["Subject"] = sujet
    msg["Date"] = f"Mon, {jour:02d} Mar 2024 09:00:00 +0100"
    msg["Message-ID"] = f"<echange-{jour}@exemple.fr>"
    msg.set_content(corps)
    return msg


class ClientDeuxAdresses:
    """Une apprenante joignable à deux adresses, plus un échange interne."""

    MESSAGES = {
        "a1": lambda: _echange(
            "Ma situation", "marie.dupont@exemple.fr", "recouvrement@liora.io",
            4, "Je vous réponds au sujet de mon solde.",
        ),
        "a2": lambda: _echange(
            "Relance", "recouvrement@liora.io", "marie.dupont@exemple.fr",
            12, "Votre solde reste impayé.",
        ),
        "a3": lambda: _echange(
            "Depuis mon adresse professionnelle", "m.dupont@travail.fr",
            "recouvrement@liora.io", 20, "Je vous écris depuis mon travail.",
        ),
        # Aucune adresse de l'apprenante en en-tête : échange interne remonté
        # par le numéro de facture. Il concerne les deux adresses.
        "a4": lambda: _echange(
            "Point sur FA-2024-0153", "compta@liora.io", "recouvrement@liora.io",
            25, "La facture FA-2024-0153 reste ouverte au grand livre.",
        ),
    }

    adresse_boite = "recouvrement@liora.io"

    def rechercher_identifiants(self, requete, inclure_spam_corbeille=True, plafond=None):
        return list(self.MESSAGES)

    def recuperer_messages(self, identifiants):
        for identifiant in identifiants:
            message = lire_message(
                {"id": identifiant, "threadId": "t1", "internalDate": "1710231243000"},
                self.MESSAGES[identifiant]().as_bytes(),
            )
            message.boites = [self.adresse_boite]
            yield message


def test_sous_dossiers_par_adresse() -> None:
    """Plusieurs adresses pour un même débiteur : une vue par adresse."""
    print("\nUn sous-dossier par adresse mail")

    import export_mails  # noqa: PLC0415
    from gmail_api import SourcesGmail  # noqa: PLC0415

    vraies_sources = export_mails.ouvrir_sources
    export_mails.ouvrir_sources = lambda **_: SourcesGmail([ClientDeuxAdresses()])
    try:
        with tempfile.TemporaryDirectory() as repertoire:
            racine = Path(repertoire)
            fichier = racine / "dossiers.csv"
            fichier.write_text(
                "reference;nom;email;facture\n"
                "2024-118;Marie Dupont;"
                "marie.dupont@exemple.fr,m.dupont@travail.fr;FA-2024-0153\n",
                encoding="utf-8",
            )

            sortie = racine / "export"
            code = export_mails.executer(
                export_mails.analyser_arguments([
                    "--dossiers", str(fichier), "--sortie", str(sortie),
                    "--sous-dossiers-par-adresse",
                ])
            )
            verifier(code == 0, "code de sortie 0")

            dossier = sortie / "2024-118_marie-dupont"
            index = _lire_index(dossier / "index.csv")
            par_piece = {int(rangee["piece_n"]): rangee for rangee in index}
            verifier(len(index) == 4, "index du dossier : 4 pièces")
            verifier(
                par_piece[3]["adresses_concernees"] == "m.dupont@travail.fr",
                "l'adresse figurant en en-tête est reconnue",
            )
            verifier(
                par_piece[4]["adresses_concernees"] == "",
                "un échange interne sans adresse du débiteur reste sans rattachement",
            )

            sous = dossier / "adresses"
            verifier(
                sorted(chemin.name for chemin in sous.iterdir())
                == ["m-dupont-travail-fr", "marie-dupont-exemple-fr"],
                "un sous-dossier par adresse, nommé par l'adresse",
            )
            verifier(
                [int(r["piece_n"]) for r in _lire_index(
                    sous / "marie-dupont-exemple-fr" / "index.csv")] == [1, 2, 4],
                "adresse personnelle : ses échanges plus l'échange interne",
            )
            verifier(
                [int(r["piece_n"]) for r in _lire_index(
                    sous / "m-dupont-travail-fr" / "index.csv")] == [3, 4],
                "adresse professionnelle : son échange plus l'échange interne",
            )
            verifier(
                len(list((sous / "m-dupont-travail-fr" / "mails").glob("*.eml"))) == 2,
                "les messages sont réellement recopiés dans la vue par adresse",
            )
            verifier(
                not (dossier / "factures").exists(),
                "une seule facture : aucune vue par facture en parallèle",
            )

            recap = _lire_index(sortie / "_recapitulatif.csv")
            verifier(
                recap[0]["sous_dossiers_adresses"] == "2",
                "récapitulatif : les vues par adresse sont décomptées",
            )

            # Sans l'option, aucune vue par adresse : c'est un choix explicite.
            sortie2 = racine / "export-sans"
            export_mails.executer(
                export_mails.analyser_arguments(
                    ["--dossiers", str(fichier), "--sortie", str(sortie2)]
                )
            )
            verifier(
                not (sortie2 / "2024-118_marie-dupont" / "adresses").exists(),
                "sans l'option, aucun découpage par adresse",
            )
    finally:
        export_mails.ouvrir_sources = vraies_sources


class ClientDecouverte:
    """Boîte où le dossier n'est connu que par son numéro de facture."""

    MESSAGES = {
        # Relance : porte en en-tête l'adresse de l'apprenante, celle de Liora
        # et celle d'un tiers dont la boîte est énorme.
        "d1": lambda: _echange(
            "Relance — facture FA-2024-0153",
            "recouvrement@liora.io",
            "marie.dupont@exemple.fr, compta@liora.io, partage@grosclient.fr",
            12, "La facture FA-2024-0153 reste impayée.",
        ),
        # Échange interne citant la facture : aucune adresse externe.
        "d2": lambda: _echange(
            "Point sur FA-2024-0153", "compta@liora.io", "recouvrement@liora.io",
            25, "FA-2024-0153 toujours ouverte au grand livre.",
        ),
        # Réponse de l'apprenante : ne cite aucun numéro. Introuvable sans la
        # découverte d'adresse — c'est tout l'objet de la seconde passe.
        "d3": lambda: _echange(
            "Re: ma situation", "marie.dupont@exemple.fr", "recouvrement@liora.io",
            20, "Je ne peux pas payer ce mois-ci.",
        ),
    }

    adresse_boite = "recouvrement@liora.io"

    def rechercher_identifiants(self, requete, inclure_spam_corbeille=True, plafond=None):
        # Sondage d'une adresse : la requête ne porte que sur elle.
        if "FA-2024-0153" not in requete:
            if "marie.dupont@exemple.fr" in requete:
                return ["d1", "d3"]
            if "partage@grosclient.fr" in requete:
                return [f"x{index}" for index in range(6)]
            return []
        return ["d1", "d2"]

    def recuperer_messages(self, identifiants):
        for identifiant in identifiants:
            message = lire_message(
                {"id": identifiant, "threadId": "t1", "internalDate": "1710231243000"},
                self.MESSAGES[identifiant]().as_bytes(),
            )
            message.boites = [self.adresse_boite]
            yield message


def test_decouverte_adresses() -> None:
    """Le numéro de facture suffit à retrouver l'adresse, puis les échanges."""
    print("\nDécouverte des adresses depuis le numéro de facture")

    import export_mails  # noqa: PLC0415
    from decouverte import adresses_candidates  # noqa: PLC0415
    from gmail_api import SourcesGmail  # noqa: PLC0415

    class Faux:
        def __init__(self, parties):
            self.parties = parties.lower()

    candidates = adresses_candidates(
        [
            Faux("recouvrement@liora.io marie.dupont@exemple.fr noreply@monday.com"),
            Faux("marie.dupont@exemple.fr mailer-daemon@liora.io tuteur@ecole.fr"),
        ],
        domaines_internes={"liora.io"},
        deja_connues=[],
    )
    verifier(
        [adresse for adresse, _ in candidates]
        == ["marie.dupont@exemple.fr", "tuteur@ecole.fr"],
        "adresses internes et robots écartés, les autres classées par fréquence",
    )
    verifier(
        candidates[0][1] == 2,
        "une adresse présente dans deux messages est comptée deux fois",
    )
    verifier(
        adresses_candidates(
            [Faux("marie.dupont@exemple.fr")], {"liora.io"},
            ["MARIE.DUPONT@exemple.fr"],
        ) == [],
        "une adresse déjà au dossier n'est pas redécouverte",
    )

    vraies_sources = export_mails.ouvrir_sources
    export_mails.ouvrir_sources = lambda **_: SourcesGmail([ClientDecouverte()])
    try:
        with tempfile.TemporaryDirectory() as repertoire:
            racine = Path(repertoire)
            fichier = racine / "dossiers.csv"
            # Aucune adresse mail : le dossier n'est connu que par sa facture.
            fichier.write_text(
                "reference;nom;facture\n2024-118;Marie Dupont;FA-2024-0153\n",
                encoding="utf-8",
            )

            sortie = racine / "export"
            journal: list[str] = []
            code = export_mails.executer(
                export_mails.analyser_arguments([
                    "--dossiers", str(fichier), "--sortie", str(sortie),
                    "--max-mails", "5",
                ]),
                relais=journal.append,
            )
            verifier(code == 0, "code de sortie 0")

            trace = "\n".join(journal)
            verifier(
                "adresse découverte : marie.dupont@exemple.fr" in trace,
                "l'adresse de l'apprenante est retrouvée depuis la facture",
            )
            verifier(
                "adresse écartée : partage@grosclient.fr" in trace,
                "une adresse ramenant plus que le plafond est écartée, à voix haute",
            )
            verifier(
                "compta@liora.io" not in trace.split("Terminé")[0]
                .replace("Boîte(s) interrogée(s)", ""),
                "aucune adresse du domaine interne n'est retenue",
            )

            index = _lire_index(sortie / "2024-118_marie-dupont" / "index.csv")
            verifier(
                len(index) == 3,
                "la seconde passe ramène la réponse qui ne cite aucun numéro",
            )
            verifier(
                any("ma situation" in rangee["objet"] for rangee in index),
                "la réponse de l'apprenante figure bien au dossier",
            )

            recap = _lire_index(sortie / "_recapitulatif.csv")
            verifier(
                recap[0]["adresses_decouvertes"] == "marie.dupont@exemple.fr",
                "récapitulatif : l'adresse découverte est tracée pour vérification",
            )
            verifier(
                "marie.dupont@exemple.fr" in recap[0]["emails"],
                "l'adresse découverte rejoint les adresses du dossier",
            )
            verifier(
                "from:marie.dupont@exemple.fr" in recap[0]["requete_gmail"],
                "récapitulatif : la requête reflète la recherche réellement menée",
            )

            # La découverte est active par défaut : c'est en la coupant que
            # la réponse sans numéro redevient introuvable.
            sortie2 = racine / "export-sans"
            export_mails.executer(
                export_mails.analyser_arguments([
                    "--dossiers", str(fichier), "--sortie", str(sortie2),
                    "--sans-decouverte-adresses",
                ])
            )
            verifier(
                len(_lire_index(sortie2 / "2024-118_marie-dupont" / "index.csv")) == 2,
                "sans l'option, seule la recherche par facture est menée",
            )
    finally:
        export_mails.ouvrir_sources = vraies_sources


def test_sens_et_faux_positifs() -> None:
    """Relances émises sous une ancienne marque, et fausses contestations."""
    print("\nSens des messages et faux positifs")

    import export_mails  # noqa: PLC0415
    import synthese as module_synthese  # noqa: PLC0415

    class FausseSource:
        domaines = {"liora.io"}

    relance = lire_message(
        {"id": "r", "threadId": "t", "internalDate": "1710231243000"},
        _echange(
            "DataScientest - Suivi de facturation",
            "facturation@datascientest.com", "apprenante@exemple.fr",
            12, "Votre facture reste impayée.",
        ).as_bytes(),
    )

    sans = export_mails.analyser_arguments(["--dossiers", "x"])
    verifier(
        export_mails._sens_du_message(
            relance, export_mails.domaines_maison(FausseSource(), sans)
        ) == "reçu",
        "sans domaine déclaré, une relance d'une ancienne marque passe pour reçue",
    )

    avec = export_mails.analyser_arguments(
        ["--dossiers", "x", "--domaines-internes", "datascientest.com"]
    )
    verifier(
        export_mails._sens_du_message(
            relance, export_mails.domaines_maison(FausseSource(), avec)
        ) == "envoyé",
        "domaine déclaré : la relance est bien reconnue comme émise par nous",
    )

    # -- fausses contestations ------------------------------------------
    formule = (
        "en cas de contestation de votre part, merci de nous ecrire "
        "sous huit jours. la facture reste impayee."
    )
    verifier(
        not module_synthese.mentionne(
            formule, ("contestation",), module_synthese.SANS_PORTEE
        ),
        "« en cas de contestation » n'est pas une contestation",
    )
    verifier(
        module_synthese.mentionne(
            "je conteste le montant de cette facture", ("je conteste", "contestation"),
            module_synthese.SANS_PORTEE,
        ),
        "« je conteste » en est une",
    )
    verifier(
        module_synthese.mentionne(
            "en cas de contestation ecrivez-nous. par ailleurs votre contestation "
            "du 3 mars est enregistree",
            ("contestation",), module_synthese.SANS_PORTEE,
        ),
        "une occurrence de principe n'occulte pas une occurrence réelle",
    )

    mise_en_demeure = _ligne(1, 3, "envoyé", "Mise en demeure")
    reponse = _ligne(2, 5, "reçu", "Re: votre courrier")
    analyse = module_synthese.analyser(
        [mise_en_demeure, reponse],
        {1: formule, 2: "je conteste ce montant, je n ai jamais suivi cette formation"},
    )
    libelles = {(ev.piece, ev.libelle) for ev in analyse.evenements}
    verifier(
        (1, "Contestation") not in libelles,
        "aucune contestation retenue sur notre propre mise en demeure",
    )
    verifier(
        (2, "Contestation") in libelles,
        "la contestation du débiteur est bien retenue",
    )
    verifier(
        (1, "Mise en demeure") in libelles and (2, "Mise en demeure") not in libelles,
        "une mise en demeure n'est retenue que sur un message émis",
    )

    # -- alerte quand aucun message émis n'est reconnu -------------------
    muet = module_synthese.analyser([reponse], {2: "bonjour"})
    constats = module_synthese.rediger_constats(
        muet, datetime(2025, 4, 1, tzinfo=timezone(timedelta(hours=1)))
    )
    verifier(
        any("Aucun message émis par Liora n'a été reconnu" in c for c in constats),
        "la note alerte quand aucun message sortant n'est reconnu",
    )
    complet = module_synthese.analyser([mise_en_demeure, reponse], {})
    constats = module_synthese.rediger_constats(
        complet, datetime(2025, 4, 1, tzinfo=timezone(timedelta(hours=1)))
    )
    verifier(
        not any("Aucun message émis" in c for c in constats),
        "pas d'alerte quand les deux sens sont présents",
    )


class ClientEvolutif:
    """Boîte à laquelle un message s'ajoute entre deux exports."""

    TOUS = {
        "e1": lambda: _echange(
            "Relance FA-2024-0153", "recouvrement@liora.io",
            "marie.dupont@exemple.fr", 4, "La facture FA-2024-0153 reste impayée.",
        ),
        "e2": lambda: _echange(
            "Re: relance", "marie.dupont@exemple.fr", "recouvrement@liora.io",
            12, "Je vous réponds.",
        ),
        # Arrivé après le premier export, et antérieur aux deux autres : il ne
        # doit pas décaler les numéros de pièce déjà attribués.
        "e3": lambda: _echange(
            "Envoi initial", "recouvrement@liora.io", "marie.dupont@exemple.fr",
            2, "Veuillez trouver la facture FA-2024-0153.",
        ),
    }

    adresse_boite = "recouvrement@liora.io"
    disponibles = ["e1", "e2"]

    def rechercher_identifiants(self, requete, inclure_spam_corbeille=True, plafond=None):
        return list(self.disponibles)

    def recuperer_messages(self, identifiants):
        for identifiant in identifiants:
            message = lire_message(
                {"id": identifiant, "threadId": "t1", "internalDate": "1710231243000"},
                self.TOUS[identifiant]().as_bytes(),
            )
            message.boites = [self.adresse_boite]
            yield message


def _facture_pdf(chemin: Path, texte: str) -> None:
    """Écrit un PDF minimal, au format qu'un logiciel de facturation produit :
    flux de contenu compressé, texte en chaînes littérales."""
    import zlib as module_zlib  # noqa: PLC0415

    lignes = "".join(
        f"BT /F1 11 Tf 40 {760 - 18 * rang} Td ({ligne}) Tj ET\n"
        for rang, ligne in enumerate(texte.splitlines())
    )
    flux = module_zlib.compress(lignes.encode("latin-1"))

    objets = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] "
        b"/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        b"<< /Length " + str(len(flux)).encode() + b" /Filter /FlateDecode >>\nstream\n"
        + flux + b"\nendstream",
    ]

    sortie = bytearray(b"%PDF-1.4\n")
    decalages = []
    for numero, corps in enumerate(objets, start=1):
        decalages.append(len(sortie))
        sortie += f"{numero} 0 obj\n".encode() + corps + b"\nendobj\n"

    depart = len(sortie)
    sortie += f"xref\n0 {len(objets) + 1}\n0000000000 65535 f \n".encode()
    for decalage in decalages:
        sortie += f"{decalage:010d} 00000 n \n".encode()
    sortie += (
        f"trailer\n<< /Size {len(objets) + 1} /Root 1 0 R >>\nstartxref\n"
        f"{depart}\n%%EOF\n"
    ).encode()
    chemin.write_bytes(bytes(sortie))


def test_echeance_facture() -> None:
    """Lecture de l'échéance dans la facture PDF téléchargée depuis Monday."""
    print("\nÉchéance lue sur la facture")

    import facture_pdf  # noqa: PLC0415

    facture_liora = (
        "Facture FACT-2405-00030\n"
        "En date du : 06/06/2022\n"
        "Objet : Apprenant : AÏSSATA CONTE\n"
        "Début de formation : 06/06/2022\n"
        "Fin de formation : 13/06/2022\n"
        "Dates de service : 06/06/2022 - 13/06/2022\n"
        "Délai de règlement : À réception de facture\n"
        "Date limite de règlement : 06/06/2022\n"
    )
    dates = facture_pdf.dates_de_facture(facture_liora)
    verifier(
        dates["facture"] == "06/06/2022",
        f"« En date du » donne la date de facture (obtenu : {dates['facture']})",
    )
    verifier(
        dates["debut_formation"] == "06/06/2022"
        and dates["fin_formation"] == "13/06/2022",
        "début et fin de formation sont relevés séparément",
    )

    # Les cinq règles de Liora, sur cette facture.
    attendus = {
        "debut-formation": "06/06/2022",
        "facture30": "06/07/2022",
        "fin-formation-30": "13/07/2022",
        "fin-formation-45": "28/07/2022",
        "fin-formation-60": "12/08/2022",
    }
    obtenus = {
        cle: facture_pdf.echeance_selon_regle(dates, cle)[0]
        for cle in facture_pdf.REGLES
    }
    verifier(
        obtenus == attendus,
        f"les cinq règles d'échéance donnent la bonne date (obtenu : {obtenus})",
    )
    verifier(
        "30 jours" in facture_pdf.echeance_selon_regle(dates, "facture30")[1],
        "le mode de calcul est rapporté avec la date",
    )
    verifier(
        facture_pdf.echeance_selon_regle(dates, "facture30", delai=45)[0]
        == "21/07/2022",
        "le délai peut être forcé, quelle que soit la règle",
    )
    verifier(
        facture_pdf.normaliser_regle("formation") == "debut-formation"
        and facture_pdf.normaliser_regle("n'importe quoi") == "facture30",
        "une règle inconnue ou périmée retombe sur une règle valable",
    )

    verifier(
        facture_pdf.dates_de_facture(
            "Formation du 12/03/2024 au 20/06/2024. Montant 1 200 €"
        ) == {"facture": "", "debut_formation": "", "fin_formation": "",
              "limite_imprimee": ""},
        "une date sans intitulé reconnu n'est jamais retenue",
    )
    verifier(
        facture_pdf.dates_de_facture("Date limite de règlement : 31/02/2026")
        ["limite_imprimee"] == "",
        "une date qui n'existe pas au calendrier est écartée, non rattrapée",
    )
    verifier(
        facture_pdf.dates_de_facture("DATE D'ÉCHÉANCE 05.11.2025")["limite_imprimee"]
        == "05/11/2025",
        "majuscules, accents et points de séparation ne gênent pas la lecture",
    )
    verifier(
        facture_pdf.echeance_selon_regle(
            {"limite_imprimee": "01/02/2026"}, "debut-formation"
        ) == ("01/02/2026", "date limite imprimée sur la facture"),
        "sans date calculable, la limite imprimée sert de dernier recours",
    )
    date, origine = facture_pdf.echeance_selon_regle(
        {"facture": "01/03/2026"}, "fin-formation-60"
    )
    verifier(
        date == "30/04/2026" and "fin de formation absent" in origine,
        f"un repli sur une autre date est appliqué et nommé (obtenu : {origine})",
    )
    verifier(
        facture_pdf.echeance_selon_regle({}, "debut-formation")[0] == "",
        "sans aucune date, rien n'est inventé",
    )

    deduites = {
        nom: facture_pdf.regle_deduite(nom) for nom in (
            "1.1. Entreprise - ADV", "1.2. Entreprise - Recouvrement",
            "1.3. Entreprise - OPCO", "2.1. Financement Personnel",
            "2.2. Financement CPF", "2.3. Financement pôle emploi : AIF / POEI",
            "2.4. Financement complexe : REGION / TRANSITION / AGEFIPH")
    }
    verifier(
        list(deduites.values()) == [
            "facture30", "facture30", "fin-formation-30", "debut-formation",
            "fin-formation-45", "fin-formation-60", "fin-formation-60",
        ],
        f"chaque tableau reçoit sa règle (obtenu : {list(deduites.values())})",
    )
    verifier(
        deduites["1.3. Entreprise - OPCO"] == "fin-formation-30",
        "« Entreprise - OPCO » suit la règle OPCO, la plus précise des deux",
    )

    with tempfile.TemporaryDirectory() as repertoire:
        racine = Path(repertoire)
        facture = racine / "FACT-2405-00030.pdf"
        _facture_pdf(facture, (
            "LIORA - FACTURE FACT-2405-00030\n"
            "En date du : 12/03/2025\n"
            "Total TTC 2 700,00 EUR"
        ))

        verifier(
            "12/03/2025" in facture_pdf.texte_du_pdf(facture),
            "le texte est extrait d'un vrai PDF au flux compressé",
        )
        date, origine = facture_pdf.echeance_de_la_facture(facture, "facture30")
        verifier(date == "11/04/2025", f"échéance calculée du PDF (obtenu : {date})")
        verifier("30 jours" in origine, "l'origine de la date est rapportée")

        # Sans pypdf, le lecteur minimal doit donner le même résultat.
        vrai = facture_pdf._texte_via_pypdf
        facture_pdf._texte_via_pypdf = lambda chemin: ""
        try:
            verifier(
                facture_pdf.echeance_de_la_facture(facture, "facture30")[0]
                == "11/04/2025",
                "le lecteur de secours, sans pypdf, lit la même échéance",
            )
        finally:
            facture_pdf._texte_via_pypdf = vrai

        scannee = racine / "scan.pdf"
        scannee.write_bytes(b"%PDF-1.4\n% pas de texte\n%%EOF\n")
        date, origine = facture_pdf.echeance_de_la_facture(scannee)
        verifier(
            date == "" and origine == "illisible",
            "une facture scannée est déclarée illisible, non devinée",
        )

    # La convention n'est jamais lue comme une facture.
    import export_mails  # noqa: PLC0415
    from dossiers import Dossier  # noqa: PLC0415

    with tempfile.TemporaryDirectory() as repertoire:
        racine = Path(repertoire)
        documents = racine / "documents-monday"
        documents.mkdir()
        _facture_pdf(documents / "Convention de formation.pdf",
                     "Convention\nDébut de formation : 01/01/2000")
        _facture_pdf(documents / "Facture FACT-1.pdf",
                     "Facture\nDébut de formation : 15/06/2026")

        journal: list[str] = []
        date, _origine = export_mails._echeance_depuis_facture(
            Dossier(reference="FACT-1", nom="X", emails=["a@b.fr"], factures=["FACT-1"]),
            racine, journal.append, "debut-formation",
        )
        verifier(
            date == "15/06/2026",
            f"la facture est lue, la convention écartée (obtenu : {date})",
        )


def test_lecture_tableau_monday() -> None:
    """Lecture directe du tableau, et filtrage sur l'étape du process."""
    print("\nTableau Monday lu en direct")

    import monday as module_monday  # noqa: PLC0415
    from dossiers import (  # noqa: PLC0415
        ErreurDossiers,
        dossiers_depuis_grille,
        filtrer_par_colonne,
    )

    def colonne(titre, texte="", valeur=None):
        return {"column": {"title": titre}, "text": texte, "value": valeur}

    def element(nom, etape, email, montant, fichier=None):
        return {
            "name": nom,
            "column_values": [
                colonne("Nom & Prénom de l'apprenant", nom.split(" — ")[0]),
                colonne("E-mail", email),
                colonne("Etape process recouvrement", etape),
                colonne("Reste à payer", montant),
                colonne(
                    "Facture PDF", "",
                    json.dumps({"files": [{"public_url": fichier}]}) if fichier else None,
                ),
            ],
        }

    pages = [
        {
            "boards": [{"items_page": {
                "cursor": "page2",
                "items": [
                    element(
                        "FACT-2405-00030", "🔴 Dossier à faire passer en contentieux",
                        "aissata@exemple.fr", "1200",
                        "https://liora.monday.com/protected_static/1/resources/9/f.pdf",
                    ),
                    element(
                        "FACT-2405-00031", "Relance 2 en cours",
                        "paul@exemple.fr", "300",
                    ),
                ],
            }}]
        },
        {
            "boards": [{"items_page": {
                "cursor": None,
                "items": [
                    element(
                        "FACT-2405-00037", "Dossier a faire passer en contentieux",
                        "aldric@exemple.fr", "800",
                    ),
                ],
            }}]
        },
    ]

    requetes: list[str] = []

    def faux_appel(requete, jeton):
        requetes.append(requete)
        if "boards (limit" in requete:
            return {"boards": [{"id": 42, "name": "Recouvrement 2026"}]}
        return pages[min(len(requetes) - 1, len(pages) - 1)]

    vrai_appel = module_monday._appeler_api
    module_monday._appeler_api = faux_appel
    try:
        tableaux = module_monday.lister_tableaux("jeton")
        verifier(
            tableaux == [{"id": "42", "nom": "Recouvrement 2026", "espace": ""}],
            "les tableaux accessibles sont listés avec leur identifiant",
        )

        requetes.clear()
        grille = module_monday.lire_tableau("42", "jeton")
    finally:
        module_monday._appeler_api = vrai_appel

    verifier(len(requetes) == 2, "la pagination est suivie jusqu'au bout")
    verifier(
        'cursor: "page2"' in requetes[1],
        "la seconde page est demandée avec le curseur rendu par la première",
    )
    verifier(
        grille[0][1][0] == "Name"
        and "Etape process recouvrement" in grille[0][1],
        "la première ligne porte les intitulés de colonnes",
    )
    verifier(len(grille) == 4, "trois éléments lus sur les deux pages")

    dossiers = dossiers_depuis_grille(grille, "tableau Monday 42")
    verifier(len(dossiers) == 3, "les trois lignes deviennent des dossiers")
    verifier(
        dossiers[0].liens == [
            "https://liora.monday.com/protected_static/1/resources/9/f.pdf"
        ],
        "l'adresse d'un fichier est extraite de la valeur brute de la colonne",
    )
    verifier(
        dossiers[0].colonnes.get("etape process recouvrement", "").endswith(
            "Dossier à faire passer en contentieux"
        ),
        "les colonnes non exploitées restent disponibles pour le filtrage",
    )

    retenus = filtrer_par_colonne(
        dossiers, "Etape process recouvrement", "Dossier à faire passer en contentieux"
    )
    verifier(
        [d.reference for d in retenus] == ["FACT-2405-00030", "FACT-2405-00037"],
        "seules les lignes qualifiées sont retenues, emoji et accents ignorés",
    )
    verifier(
        len(filtrer_par_colonne(dossiers, "etape process recouvrement", "CONTENTIEUX"))
        == 2,
        "la comparaison se fait par inclusion, sans tenir compte de la casse",
    )
    verifier(
        filtrer_par_colonne(dossiers, "", "") == dossiers,
        "un filtre vide laisse passer tout le tableau",
    )

    try:
        filtrer_par_colonne(dossiers, "Etape du process", "contentieux")
        verifier(False, "une colonne introuvable est signalée")
    except ErreurDossiers as exc:
        verifier(
            "introuvable" in str(exc) and "Colonnes disponibles" in str(exc),
            "une colonne introuvable est signalée, avec la liste des colonnes",
        )

    try:
        filtrer_par_colonne(dossiers, "Etape process recouvrement", "cloture")
        verifier(False, "une valeur sans correspondance est signalée")
    except ErreurDossiers as exc:
        verifier(
            "Valeurs présentes" in str(exc),
            "une valeur sans correspondance est signalée, avec les valeurs vues",
        )


def test_refus_monday() -> None:
    """Un refus de l'API doit dire pourquoi, et un tableau large doit passer."""
    print("\nRefus et gros tableaux Monday")

    import urllib.error  # noqa: PLC0415
    import urllib.request  # noqa: PLC0415

    import monday as module_monday  # noqa: PLC0415

    class FauxRefus(urllib.error.HTTPError):
        def __init__(self, code, corps):
            super().__init__("https://api.monday.com/v2", code, "Bad Request",
                             {}, io.BytesIO(corps.encode("utf-8")))

    # Monday explique le refus dans le corps ; le code seul ne dit rien.
    def refus(requete, jeton):
        raise FauxRefus(400, json.dumps({"errors": [
            {"message": "Complexity budget exhausted, query cost 5000000"}
        ]}))

    vrai_urlopen = module_monday.urllib.request.urlopen
    module_monday.urllib.request.urlopen = lambda *a, **k: (_ for _ in ()).throw(
        FauxRefus(400, json.dumps({"errors": [{"message": "Field 'typo' doesn't exist"}]}))
    )
    try:
        module_monday._appeler_api("query { boards { id } }", "jeton")
        verifier(False, "le motif du refus est rapporté")
    except module_monday.ErreurMonday as exc:
        verifier("Field 'typo' doesn't exist" in str(exc),
                 "le motif écrit par Monday accompagne le code HTTP")
        verifier("HTTP 400" in str(exc), "le code HTTP reste indiqué")
    finally:
        module_monday.urllib.request.urlopen = vrai_urlopen

    # Un budget de complexité épuisé se rattrape en demandant moins à la fois.
    tailles: list[int] = []

    def parfois(requete, jeton):
        taille = int(requete.split("limit: ")[1].split(",")[0].split(")")[0])
        tailles.append(taille)
        if taille > 25:
            raise module_monday.ErreurMonday(
                "Monday a refusé la requête (HTTP 400). Complexity budget exhausted"
            )
        return {"boards": [{"name": "Recouvrement", "items_page": {
            "cursor": None,
            "items": [{"id": 1, "name": "FACT-1", "column_values": [
                {"column": {"title": "E-mail"}, "text": "a@b.fr"}]}],
        }}]}

    vrai_appel = module_monday._appeler_api
    module_monday._appeler_api = parfois
    try:
        grille = module_monday.lire_tableau("42", "jeton")
    finally:
        module_monday._appeler_api = vrai_appel

    verifier(tailles == [100, 25], f"la page est réduite puis relue (obtenu : {tailles})")
    verifier(len(grille) == 2, "le tableau est lu malgré le premier refus")

    # En dessous du plancher, l'erreur remonte : mieux vaut la dire que
    # multiplier indéfiniment les allers-retours.
    module_monday._appeler_api = lambda requete, jeton: (_ for _ in ()).throw(
        module_monday.ErreurMonday("HTTP 400. Complexity budget exhausted")
    )
    try:
        module_monday.lire_tableau("42", "jeton")
        verifier(False, "un refus persistant finit par être signalé")
    except module_monday.ErreurMonday as exc:
        verifier("Complexity" in str(exc), "un refus persistant finit par être signalé")
    finally:
        module_monday._appeler_api = vrai_appel


def test_montants_espace_insecable() -> None:
    """Monday sépare les milliers par une insécable, pas par une espace."""
    print("\nMontants venus de Monday")

    import suivi as module_suivi  # noqa: PLC0415
    from dossiers import _montant  # noqa: PLC0415

    cas = [
        ("2 500 €", 2500.0),   # insécable
        ("2 500 €", 2500.0),   # insécable fine, celle de Monday
        ("23 250 €", 23250.0),
        ("1 280,50", 1280.5),
        ("", 0.0),
        ("néant", 0.0),
    ]
    for texte, attendu in cas:
        verifier(_montant(texte) == attendu,
                 f"« {texte} » vaut {attendu} (obtenu : {_montant(texte)})")
        verifier(module_suivi._nombre(texte) == attendu,
                 f"au suivi aussi, « {texte} » vaut {attendu}")


def test_colonnes_typees_monday() -> None:
    """Une colonne « E-mail » range l'adresse ailleurs que dans son texte."""
    print("\nColonnes typées Monday")

    import monday as module_monday  # noqa: PLC0415

    cas = [
        # Le cas qui vidait vingt-deux dossiers : adresse saisie, aucun
        # libellé d'affichage, donc `text` vide.
        ({"text": "", "value": json.dumps({"email": "sufyen.b@gmail.com",
                                           "text": ""})},
         "sufyen.b@gmail.com", "une adresse sans libellé est lue"),
        ({"text": "", "value": json.dumps({"email": "a@b.fr", "text": "Sufyen B"})},
         "a@b.fr", "l'adresse l'emporte sur le libellé"),
        ({"text": "direct@c.fr", "value": None},
         "direct@c.fr", "un texte renseigné reste prioritaire"),
        ({"text": "", "value": json.dumps({"url": "https://x.fr", "text": ""})},
         "https://x.fr", "un lien sans libellé est lu"),
        ({"text": "", "value": json.dumps({"phone": "0601020304"})},
         "0601020304", "un téléphone est lu"),
        ({"text": "", "value": json.dumps(
            {"files": [{"public_url": "https://m.monday.com/f.pdf"}]})},
         "https://m.monday.com/f.pdf", "un fichier reste lu comme avant"),
        ({"text": "", "value": json.dumps({"label": {"text": "En retard"}})},
         "En retard", "un statut imbriqué est lu"),
        ({"text": "", "value": '"texte nu"'},
         "texte nu", "une valeur JSON nue est lue"),
        ({"text": "", "value": None}, "", "une cellule vide reste vide"),
        ({"text": "", "value": "{pas du json"}, "", "un JSON illisible ne casse rien"),
    ]
    for colonne, attendu, libelle in cas:
        obtenu = module_monday._valeur_colonne(colonne)
        verifier(obtenu == attendu, f"{libelle} (obtenu : « {obtenu} »)")


def test_colonnes_miroir_monday() -> None:
    """Une colonne miroir ne dit sa valeur que dans `display_value`."""
    print("\nColonnes miroir Monday")

    import monday as module_monday  # noqa: PLC0415

    verifier(module_monday._valeur_colonne(
        {"text": "", "value": None, "display_value": "sufyen.b@gmail.com"}
    ) == "sufyen.b@gmail.com", "la valeur affichée d'un miroir est lue")
    verifier(module_monday._valeur_colonne(
        {"text": "direct@c.fr", "display_value": "autre@c.fr"}
    ) == "direct@c.fr", "un texte propre reste prioritaire sur le miroir")
    verifier(module_monday._valeur_colonne(
        {"text": "", "value": None, "display_value": ""}
    ) == "", "un miroir vide reste vide")

    requetes: list[str] = []
    refus = {"reste": 1}

    def faux_appel(requete, jeton):
        requetes.append(requete)
        if "groups { id title }" in requete or "columns {" in requete:
            return {"boards": [{"groups": [], "columns": []}]}
        # La première requête est refusée comme le ferait une API qui ignore
        # le type MirrorValue.
        if "MirrorValue" in requete and refus["reste"]:
            refus["reste"] -= 1
            raise module_monday.ErreurMonday(
                "Monday a répondu par une erreur : "
                "Cannot query field 'display_value' on type 'MirrorValue'"
            )
        return {"boards": [{"name": "T", "items_page": {"cursor": None, "items": [
            {"id": 1, "name": "FACT-1", "column_values": [
                {"column": {"title": "Email"}, "text": "",
                 "display_value": "a@b.fr"}]}]}}]}

    vrai_appel = module_monday._appeler_api
    module_monday._appeler_api = faux_appel
    try:
        grille = module_monday.lire_tableau("42", "jeton")
    finally:
        module_monday._appeler_api = vrai_appel

    pages = [r for r in requetes if "items_page" in r]
    verifier("MirrorValue" in pages[0],
             "les colonnes miroir sont demandées d'emblée")
    verifier(len(pages) == 2 and "MirrorValue" not in pages[1],
             "un refus fait relire sans les fragments, pas échouer la lecture")
    verifier(len(grille) == 2, "le tableau est lu malgré le refus")

    # Sans refus, la valeur affichée arrive bien jusqu'à la grille.
    refus["reste"] = 0
    requetes.clear()
    module_monday._appeler_api = faux_appel
    try:
        grille = module_monday.lire_tableau("42", "jeton")
    finally:
        module_monday._appeler_api = vrai_appel
    entetes = grille[0][1]
    verifier(grille[1][1][entetes.index("Email")] == "a@b.fr",
             "l'adresse d'une colonne miroir atteint la grille")


def test_bloc_pieces() -> None:
    """Pièces jointes et documents Monday : quatre cas, aucun qui plante."""
    print("\nBloc « Contrat signé et factures »")

    import synthese as module_synthese  # noqa: PLC0415
    from dossiers import Dossier  # noqa: PLC0415

    piece = LigneIndex(
        piece_n=1,
        date=datetime(2024, 3, 12, 10, 22, tzinfo=timezone(timedelta(hours=1))),
        sens="envoyé",
        expediteur="recouvrement@liora.io",
        destinataires="a@b.fr",
        copie="",
        objet="Facture FACT-1",
        nb_pieces_jointes=1,
        pieces_jointes="facture.pdf",
        critere="facture",
        boites="billing@liora.io",
        fichier_pdf="",
        fichier_eml="",
        dossier_pieces_jointes="",
        thread_id="t",
        message_id="<1@liora.io>",
    )

    def note(lignes, documents, liens):
        dossier = Dossier(reference="FACT-1", nom="A", emails=["a@b.fr"],
                          factures=["FACT-1"], liens=liens)
        return module_synthese.construire_html(
            dossier=dossier,
            lignes=lignes,
            synthese=module_synthese.analyser(lignes, {}),
            boites=["billing@liora.io"],
            date_export=datetime(2026, 3, 1, 10, 0,
                                 tzinfo=timezone(timedelta(hours=1))),
            documents_monday=documents,
        )

    # Le cas qui plantait : aucun mail avec pièce jointe, mais un document
    # téléchargé depuis Monday.
    html_doc = note([], ["convention.pdf"], [])
    verifier("convention.pdf" in html_doc,
             "sans pièce jointe, un document Monday s'affiche quand même")
    verifier("Aucune pièce jointe" not in html_doc,
             "et n'est pas annoncé comme une absence de pièce")

    # Le cas symétrique : des pièces jointes, aucun document Monday. Le texte
    # d'absence effaçait la liste au lieu de s'abstenir.
    html_pj = note([piece], [], [])
    verifier("facture.pdf" in html_pj,
             "les pièces jointes restent listées sans document Monday")
    verifier("Aucune pièce jointe" not in html_pj,
             "et ne sont pas remplacées par le texte d'absence")

    html_deux = note([piece], ["convention.pdf"], [])
    verifier("facture.pdf" in html_deux and "convention.pdf" in html_deux,
             "les deux sources coexistent, aucune ne remplace l'autre")

    html_rien = note([], [], [])
    verifier("Aucune pièce jointe" in html_rien,
             "sans rien du tout, l'absence est dite")

    html_lien = note([], [], ["https://liora.monday.com/r/9/f.pdf"])
    verifier("liora.monday.com" in html_lien,
             "un document non téléchargé est cité en lien")


def test_execution_formation() -> None:
    """Convention, diplôme et heures suivies : lus, écrits, agrégés."""
    print("\nExécution de la formation")

    import suivi as module_suivi  # noqa: PLC0415
    import synthese as module_synthese  # noqa: PLC0415
    from dossiers import dossiers_depuis_grille  # noqa: PLC0415

    for texte, attendu in [
        ("oui", True), ("Oui", True), ("signé", True), ("signée le 12/03", True),
        ("x", True), ("1", True), ("reçu", True),
        ("non", False), ("Non signée", False), ("pas de convention", False),
        ("0", False), ("sans convention", False),
        ("", None), ("à vérifier", None), ("en attente", None),
    ]:
        obtenu = module_synthese._oui_non(texte)
        verifier(obtenu is attendu, f"« {texte} » vaut {attendu} (obtenu : {obtenu})")

    grille = [
        (1, ["Numero", "E-mail", "convention signé ?", "Diplome reçu ?",
             "Nb d'heure Theorique", "Heure de Log", "Commentaire contentieux"]),
        (2, ["FACT-1", "a@b.fr", "oui", "non", "60", "42", "relance sans effet"]),
        (3, ["FACT-2", "c@d.fr", "", "", "", "", ""]),
    ]
    dossiers = dossiers_depuis_grille(grille, "tableau Monday 42")
    premier, second = dossiers[0], dossiers[1]

    verifier(premier.convention_signee == "oui" and premier.diplome == "non",
             "convention et diplôme sont lus depuis leurs colonnes")
    verifier(premier.heures_theoriques == "60" and premier.heures_log == "42",
             "les heures prévues et suivies sont lues")
    verifier("relance sans effet" in premier.commentaire,
             "le commentaire contentieux rejoint les autres commentaires")

    lignes = module_synthese.rediger_execution(premier)
    verifier(any("signée" in l and "non" not in l.lower() for l in lignes),
             "la convention signée est affirmée")
    verifier(any("Diplôme non délivré" in l for l in lignes),
             "le diplôme manquant est dit")
    verifier(any("42 h sur 60 h" in l and "70 %" in l for l in lignes),
             f"les heures sont rapportées au volume prévu (obtenu : {lignes})")

    verifier(module_synthese.rediger_execution(second) == [],
             "un dossier sans ces colonnes ne produit aucune ligne inventée")

    # Une convention non renseignée ne doit jamais compter comme non signée.
    en_cours = [
        {"statut": "avocats", "montant_du": 1000.0, "convention_signee": True,
         "diplome": False, "heures_theoriques": "60", "heures_log": "30"},
        {"statut": "non-transmis", "montant_du": 500.0, "convention_signee": False,
         "diplome": None, "heures_theoriques": "40", "heures_log": "40"},
        {"statut": "non-transmis", "montant_du": 200.0, "convention_signee": None,
         "diplome": None, "heures_theoriques": "", "heures_log": ""},
        {"statut": "tribunal-perdu", "montant_du": 900.0, "convention_signee": False,
         "diplome": False, "heures_theoriques": "10", "heures_log": "0"},
    ]
    s = module_suivi.solidite(en_cours)
    verifier(s["nb_en_cours"] == 3, "les dossiers clôturés sortent du décompte")
    verifier(s["convention"] == {"oui": 1, "non": 1, "inconnu": 1, "montant_non": 500.0},
             f"conventions réparties en trois états (obtenu : {s['convention']})")
    verifier(s["diplome"]["inconnu"] == 2,
             "un diplôme non renseigné n'est pas compté comme non délivré")
    verifier(s["assiduite_mediane"] == 75 and s["nb_assiduite"] == 2,
             f"assiduité médiane sur les seuls dossiers renseignés "
             f"(obtenu : {s['assiduite_mediane']} sur {s['nb_assiduite']})")


def test_suppression_dossiers() -> None:
    """Retirer un dossier de la liste, avec ou sans ses fichiers."""
    print("\nSuppression de dossiers")

    import suivi as module_suivi  # noqa: PLC0415

    with tempfile.TemporaryDirectory() as repertoire:
        sortie = Path(repertoire) / "export"
        sortie.mkdir()
        for nom in ("2024-118_a", "2024-119_b", "2024-120_c"):
            (sortie / nom).mkdir()
            (sortie / nom / "index.csv").write_text("x", encoding="utf-8")
        (sortie / "_recapitulatif.csv").write_text(
            "reference;nom;repertoire;montant_du\n"
            "FACT-1;A;2024-118_a;2 500 €\n"
            "FACT-2;B;2024-119_b;800\n"
            "FACT-3;C;2024-120_c;100\n",
            encoding="utf-8-sig",
        )
        chemin_suivi = Path(repertoire) / "suivi.json"
        module_suivi.enregistrer(chemin_suivi, {
            "FACT-1": {"statut": "avocats", "frais": 300},
            "FACT-3": {"statut": "non-transmis"},
        })

        # Le montant lu depuis le récapitulatif doit survivre à l'insécable.
        avant = module_suivi.inventaire(sortie, chemin_suivi)
        verifier([d["montant_du"] for d in avant] == [2500.0, 800.0, 100.0],
                 f"les montants sont lus (obtenu : {[d['montant_du'] for d in avant]})")

        resultat = module_suivi.supprimer(sortie, chemin_suivi, ["FACT-1"])
        verifier(resultat["retires"] == 1 and resultat["effaces"] == 0,
                 "un dossier retiré, aucun fichier effacé par défaut")
        verifier((sortie / "2024-118_a" / "index.csv").exists(),
                 "les fichiers restent sur le disque")
        verifier("FACT-1" not in module_suivi.charger(chemin_suivi),
                 "son état de suivi est oublié")
        restants = module_suivi.inventaire(sortie, chemin_suivi)
        verifier([d["reference"] for d in restants] == ["FACT-2", "FACT-3"],
                 "il ne figure plus dans la liste")
        verifier(module_suivi.charger(chemin_suivi).get("FACT-3", {}).get("statut")
                 == "non-transmis", "les autres états sont intacts")

        resultat = module_suivi.supprimer(
            sortie, chemin_suivi, ["FACT-2"], avec_fichiers=True)
        verifier(resultat["effaces"] == 1, "sur demande, le répertoire est supprimé")
        verifier(not (sortie / "2024-119_b").exists(), "le répertoire a disparu")
        verifier((sortie / "2024-120_c").exists(), "les autres répertoires sont intacts")

        # Un chemin venu du fichier ne doit pas pouvoir désigner hors de l'export.
        (sortie / "_recapitulatif.csv").write_text(
            "reference;nom;repertoire;montant_du\n"
            "FACT-9;X;../../dehors;0\n",
            encoding="utf-8-sig",
        )
        dehors = Path(repertoire) / "dehors"
        dehors.mkdir()
        module_suivi.supprimer(sortie, chemin_suivi, ["FACT-9"], avec_fichiers=True)
        verifier(dehors.exists(),
                 "un répertoire hors de l'export n'est jamais supprimé")

        verifier(module_suivi.supprimer(sortie, chemin_suivi, [])["retires"] == 0,
                 "une demande vide ne fait rien")

        print("  -- tout effacer, en trois degrés séparés --")
        (sortie / "_recapitulatif.csv").write_text(
            "reference;nom;repertoire;montant_du\n"
            "FACT-A;A;2024-120_c;10\n"
            "FACT-B;B;dossier-b;20\n",
            encoding="utf-8-sig",
        )
        (sortie / "dossier-b").mkdir(exist_ok=True)
        module_suivi.enregistrer(chemin_suivi, {
            "FACT-A": {"statut": "avocats", "frais": 900, "note": "audience 12/04"},
        })

        # Degré 1 : la liste seule. Fichiers et suivi restent.
        r = module_suivi.tout_effacer(sortie, chemin_suivi)
        verifier(r["retires"] == 2, "les deux dossiers sont retirés de la liste")
        verifier(not (sortie / "_recapitulatif.csv").exists(),
                 "le récapitulatif vidé est supprimé")
        verifier((sortie / "dossier-b").exists(),
                 "les fichiers restent : ils n'étaient pas demandés")
        verifier(module_suivi.inventaire(sortie, chemin_suivi) == [],
                 "plus rien n'est listé")
        # Le suivi d'un dossier retiré part avec lui ; celui des autres reste.
        module_suivi.enregistrer(chemin_suivi, {
            "FACT-Z": {"statut": "tribunal-en-cours", "frais": 120},
        })

        # Degré 3 : le suivi, jamais emporté par les deux premiers.
        (sortie / "_recapitulatif.csv").write_text(
            "reference;nom;repertoire;montant_du\nFACT-C;C;dossier-b;5\n",
            encoding="utf-8-sig",
        )
        r = module_suivi.tout_effacer(sortie, chemin_suivi, avec_fichiers=True)
        verifier(r["effaces"] == 1 and not (sortie / "dossier-b").exists(),
                 "sur demande, les répertoires sont supprimés")
        verifier(module_suivi.charger(chemin_suivi).get("FACT-Z"),
                 "effacer les fichiers n'emporte pas le suivi")

        r = module_suivi.tout_effacer(sortie, chemin_suivi, avec_suivi=True)
        verifier(r["suivi_efface"] == 1 and module_suivi.charger(chemin_suivi) == {},
                 "le suivi n'est effacé que lorsqu'il est demandé")

        verifier(module_suivi.tout_effacer(sortie, chemin_suivi)["retires"] == 0,
                 "une remise à zéro sur un export déjà vide ne casse rien")


def test_filtre_chez_monday() -> None:
    """Le tri se fait chez Monday, pas après avoir tout rapatrié."""
    print("\nFiltre appliqué par Monday")

    import monday as module_monday  # noqa: PLC0415

    requetes: list[str] = []
    refuser = {"filtre": False}

    def faux_appel(requete, jeton):
        requetes.append(requete)
        if "columns {" in requete:
            return {"boards": [{"columns": [
                {"id": "status_1", "title": "Etape process recouvrement"},
                {"id": "text_4", "title": "E-mail"},
            ]}]}
        if refuser["filtre"] and "query_params" in requete:
            raise module_monday.ErreurMonday(
                "Monday a refusé la requête (HTTP 400). "
                "Argument 'query_params' on field 'items_page' is not supported"
            )
        return {"boards": [{"name": "1.2. Entreprise - Recouvrement",
                            "items_page": {"cursor": None, "items": [
                                {"id": 1, "name": "FACT-1", "column_values": [
                                    {"column": {"title": "E-mail"}, "text": "a@b.fr"}]}]}}]}

    vrai_appel = module_monday._appeler_api
    module_monday._appeler_api = faux_appel
    try:
        module_monday.lire_tableau(
            "42", "jeton",
            filtre=("Etape process recouvrement",
                    ["Dossier à faire passer en contentieux",
                     "Dossier à transmettre au service contentieux"]),
        )
        demande = [r for r in requetes if "items_page" in r][0]
        verifier("query_params" in demande, "le filtre part avec la requête")
        verifier('column_id: "status_1"' in demande,
                 "la colonne est désignée par son identifiant technique, pas son titre")
        verifier(demande.count("contains_text") == 2 and "operator: or" in demande,
                 "les deux libellés sont reliés par « ou »")

        # Un intitulé de colonne inconnu ne doit pas faire échouer la lecture :
        # le filtre local dira lui-même que la colonne est introuvable.
        requetes.clear()
        module_monday.lire_tableau("42", "jeton", filtre=("Colonne absente", ["x"]))
        verifier("query_params" not in [r for r in requetes if "items_page" in r][0],
                 "une colonne introuvable annule le filtre plutôt que la lecture")

        # Si l'API refuse le filtre, on relit sans lui : le tri local suffit.
        refuser["filtre"] = True
        requetes.clear()
        grille = module_monday.lire_tableau(
            "42", "jeton", filtre=("Etape process recouvrement", ["contentieux"]),
        )
        demandes = [r for r in requetes if "items_page" in r]
        verifier(len(demandes) == 2 and "query_params" not in demandes[-1],
                 "un filtre refusé est abandonné, et la lecture reprend sans lui")
        verifier(len(grille) == 2, "le tableau est lu malgré le refus du filtre")
    finally:
        module_monday._appeler_api = vrai_appel

    # Le curseur porte déjà le filtre : le répéter est refusé par l'API.
    suite = {"tour": 0}

    def deux_pages(requete, jeton):
        requetes.append(requete)
        if "columns {" in requete:
            return {"boards": [{"columns": [
                {"id": "status_1", "title": "Etape process recouvrement"}]}]}
        suite["tour"] += 1
        return {"boards": [{"name": "T", "items_page": {
            "cursor": "page2" if suite["tour"] == 1 else None,
            "items": [{"id": suite["tour"], "name": f"FACT-{suite['tour']}",
                       "column_values": []}],
        }}]}

    module_monday._appeler_api = deux_pages
    requetes.clear()
    try:
        module_monday.lire_tableau(
            "42", "jeton", filtre=("Etape process recouvrement", ["contentieux"]),
        )
    finally:
        module_monday._appeler_api = vrai_appel

    pages = [r for r in requetes if "items_page" in r]
    verifier("query_params" in pages[0] and "query_params" not in pages[1],
             "le filtre n'accompagne que la première page, jamais le curseur")


def test_groupes_monday() -> None:
    """Une facture qualifiée par son groupe, non par sa colonne d'étape."""
    print("\nGroupes Monday")

    import monday as module_monday  # noqa: PLC0415
    from dossiers import dossiers_depuis_grille, filtrer_par_colonne  # noqa: PLC0415

    def element(identifiant, nom, groupe, etape):
        return {
            "id": identifiant, "name": nom, "group": {"title": groupe},
            "column_values": [
                {"column": {"title": "Numéro de facture"}, "text": nom},
                {"column": {"title": "E-mail"}, "text": f"{identifiant}@exemple.fr"},
                {"column": {"title": "Etape process recouvrement"}, "text": etape},
            ],
        }

    # Dans le groupe contentieux, mais la colonne d'étape ne dit rien : c'est
    # le cas que le filtre par colonne seul laissait passer.
    au_groupe = element(1, "FACT-2405-00409", "1.2.5 Service contentieux", "")
    a_la_colonne = element(2, "FACT-2409-05275", "1.2.1 Relances",
                           "🔴 Dossier à faire passer en contentieux")
    aux_deux = element(3, "FACT-2601-13302", "1.2.5 Service contentieux",
                       "Dossier à faire passer en contentieux")
    ailleurs = element(4, "FACT-2404-00001", "1.2.1 Relances", "Relance 2")

    requetes: list[str] = []

    def faux_appel(requete, jeton):
        requetes.append(requete)
        if "groups { id title }" in requete:
            return {"boards": [{"groups": [
                {"id": "grp_relances", "title": "1.2.1 Relances"},
                {"id": "grp_cont", "title": "1.2.5 Service contentieux"},
            ]}]}
        if "columns {" in requete:
            return {"boards": [{"columns": [
                {"id": "status_1", "title": "Etape process recouvrement"}]}]}
        if "grp_cont" in requete:
            return {"boards": [{"name": "1.2. Entreprise - Recouvrement", "groups": [
                {"id": "grp_cont", "title": "1.2.5 Service contentieux",
                 "items_page": {"cursor": None, "items": [au_groupe, aux_deux]}}]}]}
        return {"boards": [{"name": "1.2. Entreprise - Recouvrement", "items_page": {
            "cursor": None, "items": [a_la_colonne, aux_deux]}}]}

    vrai_appel = module_monday._appeler_api
    module_monday._appeler_api = faux_appel
    dits: list[str] = []
    try:
        grille = module_monday.lire_tableau(
            "42", "jeton",
            filtre=("Etape process recouvrement", ["contentieux"]),
            groupes=["contentieux"],
            signaler=dits.append,
        )
    finally:
        module_monday._appeler_api = vrai_appel

    verifier(any("1.2.5 Service contentieux" in ligne for ligne in dits),
             "le groupe retenu est annoncé, pour qu'on puisse le vérifier")
    verifier(any('groups (ids: ["grp_cont"]' in r for r in requetes),
             "le groupe contentieux est lu pour lui-même")
    verifier(not any('grp_relances' in r for r in requetes),
             "le groupe des relances n'est jamais demandé")

    entetes = grille[0][1]
    references = [ligne[entetes.index("Name")] for _, ligne in grille[1:]]
    verifier(sorted(references) == ["FACT-2405-00409", "FACT-2409-05275",
                                    "FACT-2601-13302"],
             f"les trois factures qualifiées, sans doublon (obtenu : {sorted(references)})")
    verifier(references.count("FACT-2601-13302") == 1,
             "une facture retenue par son groupe et par sa colonne ne compte qu'une fois")
    verifier("Monday groupe" in entetes, "le groupe voyage avec la ligne")

    # Le filtre local ne doit pas défaire la lecture par groupe.
    dossiers = dossiers_depuis_grille(grille, "tableau Monday 42")
    retenus = filtrer_par_colonne(
        dossiers, "Etape process recouvrement", "contentieux", groupes="contentieux",
    )
    verifier(len(retenus) == 3,
             f"le tri local garde aussi les lignes qualifiées par leur groupe "
             f"(obtenu : {len(retenus)})")
    sans_groupe = filtrer_par_colonne(
        dossiers, "Etape process recouvrement", "contentieux",
    )
    verifier(len(sans_groupe) == 2,
             "sans mention de groupe, seul le filtre par colonne s'applique")

    # Sans groupe demandé, rien ne change : le tableau entier est lu.
    module_monday._appeler_api = faux_appel
    requetes.clear()
    try:
        module_monday.lire_tableau("42", "jeton", groupes=[])
    finally:
        module_monday._appeler_api = vrai_appel
    verifier(not any("groups (ids:" in r for r in requetes),
             "sans groupe demandé, aucune lecture par groupe n'est tentée")


def test_sous_elements_monday() -> None:
    """Les sous-éléments donnent des lignes, héritées de leur parent."""
    print("\nSous-éléments Monday")

    import monday as module_monday  # noqa: PLC0415
    from dossiers import dossiers_depuis_grille  # noqa: PLC0415

    parent = {
        "id": 10, "name": "Aissata Diallo",
        "column_values": [
            {"column": {"title": "E-mail"}, "text": "aissata@exemple.fr"},
            {"column": {"title": "Etape process recouvrement"},
             "text": "Dossier à faire passer en contentieux"},
            {"column": {"title": "Reste à payer"}, "text": "2000"},
        ],
        "subitems": [
            {"id": 11, "name": "FACT-2405-00030", "column_values": [
                {"column": {"title": "Numéro de facture"}, "text": "FACT-2405-00030"},
                {"column": {"title": "Reste à payer"}, "text": "1200"},
                # Vide : ne doit pas effacer l'adresse héritée du parent.
                {"column": {"title": "E-mail"}, "text": ""},
            ]},
            {"id": 12, "name": "FACT-2405-00031", "column_values": [
                {"column": {"title": "Numéro de facture"}, "text": "FACT-2405-00031"},
                {"column": {"title": "Reste à payer"}, "text": "800"},
            ]},
        ],
    }

    requetes: list[str] = []

    def faux_appel(requete, jeton):
        requetes.append(requete)
        return {"boards": [{"name": "1.2. Entreprise - Recouvrement",
                            "items_page": {"cursor": None, "items": [parent]}}]}

    vrai_appel = module_monday._appeler_api
    module_monday._appeler_api = faux_appel
    try:
        sans = module_monday.lire_tableau("42", "jeton")
        requete_sans = requetes[-1]
        avec = module_monday.lire_tableau("42", "jeton", avec_sous_elements=True)
        requete_avec = requetes[-1]
    finally:
        module_monday._appeler_api = vrai_appel

    # L'API peut renvoyer des sous-éléments sans qu'on les ait demandés : sans
    # l'option, ils ne doivent pas se glisser dans le lot pour autant.
    verifier(len(sans) == 2, "sans l'option, seul l'élément parent est lu")
    verifier("subitems" not in requete_sans and "subitems {" in requete_avec,
             "l'option seule ajoute les sous-éléments à la requête")
    verifier(len(avec) == 4, f"le parent et ses deux sous-éléments (obtenu : {len(avec) - 1})")

    entetes = avec[0][1]
    lignes = {ligne[entetes.index("Monday ID")]: dict(zip(entetes, ligne))
              for _, ligne in avec[1:]}
    verifier("Numéro de facture" in entetes,
             "une colonne propre au sous-élément figure dans l'en-tête")
    verifier(lignes["11"]["E-mail"] == "aissata@exemple.fr",
             "le sous-élément hérite de l'adresse du parent")
    verifier(lignes["11"]["Reste à payer"] == "1200",
             "ce que le sous-élément renseigne l'emporte sur le parent")
    verifier(lignes["10"]["Reste à payer"] == "2000",
             "le parent garde sa propre valeur")
    verifier(lignes["11"]["Monday parent"] == "10",
             "le sous-élément garde le lien vers son parent")
    verifier(lignes["11"]["Etape process recouvrement"].endswith("contentieux"),
             "la qualification portée par le parent vaut pour ses sous-éléments")
    verifier(lignes["10"].get("Monday parent", "") == "",
             "un élément parent n'a pas de parent")

    dossiers = dossiers_depuis_grille(avec, "tableau Monday 42")
    verifier(len(dossiers) == 3, "les trois lignes deviennent des dossiers")


def test_historique_etapes() -> None:
    """Dates de passage d'étape en étape, relevées dans le journal Monday."""
    print("\nHistorique des étapes")

    import monday as module_monday  # noqa: PLC0415
    import synthese as module_synthese  # noqa: PLC0415
    from dossiers import Dossier  # noqa: PLC0415

    def horodatage(jour):
        # Monday date ses journaux en dix-millionièmes de seconde.
        base = datetime(2026, 3, jour, 10, 0, tzinfo=timezone.utc)
        return str(int(base.timestamp() * 10_000_000))

    def entree(identifiant, jour, de, vers, colonne="status_1", element="777"):
        return {
            "id": identifiant,
            "event": "update_column_value",
            "created_at": horodatage(jour),
            "data": json.dumps({
                "pulse_id": element,
                "column_id": colonne,
                "previous_value": {"label": {"text": de}} if de else None,
                "value": {"label": {"text": vers}},
            }),
        }

    journaux = [
        entree("1", 2, "", "Relance 1"),
        entree("2", 5, "Relance 1", "Relance 2"),
        # Sur une autre colonne : ne doit pas entrer dans le parcours.
        entree("3", 6, "Vert", "Rouge", colonne="couleur"),
        entree("4", 9, "Relance 2", "🔴 Dossier à faire passer en contentieux"),
        entree("5", 20, "🔴 Dossier à faire passer en contentieux",
               "Process terminé - Montant récupéré"),
        # Un autre élément du même tableau.
        entree("6", 11, "Relance 1", "Dossier à transmettre au service contentieux",
               element="888"),
    ]

    def faux_appel(requete, jeton):
        if "columns" in requete:
            return {"boards": [{"columns": [
                {"id": "status_1", "title": "Etape process recouvrement"},
                {"id": "couleur", "title": "Priorité"},
            ]}]}
        return {"boards": [{"activity_logs": journaux}]}

    vrai_appel = module_monday._appeler_api
    module_monday._appeler_api = faux_appel
    try:
        historique = module_monday.historique_colonne(
            "42", "jeton", "Etape process recouvrement"
        )
        vide = module_monday.historique_colonne("42", "jeton", "Colonne absente")
    finally:
        module_monday._appeler_api = vrai_appel

    verifier(set(historique) == {"777", "888"}, "un historique par élément du tableau")
    verifier(
        len(historique["777"]) == 4,
        f"les changements d'une autre colonne sont écartés (obtenu : {len(historique['777'])})",
    )
    verifier(
        [e["vers"] for e in historique["777"]][:2] == ["Relance 1", "Relance 2"],
        "les changements sont rendus du plus ancien au plus récent",
    )
    verifier(
        historique["777"][0]["date"].year == 2026
        and historique["777"][0]["date"].month == 3,
        "l'horodatage Monday est correctement converti en date",
    )
    verifier(vide == {}, "une colonne absente rend un historique vide, sans erreur")

    dossier = Dossier(
        reference="FACT-1", nom="Marie", emails=["m@x.fr"], etapes=historique["777"]
    )
    trajet = module_synthese.parcours(dossier)
    verifier(
        trajet["contentieux"] is not None and trajet["contentieux"].day == 9,
        "la date de passage au contentieux est celle du changement d'étape",
    )
    verifier(
        trajet["cloture"] is not None and trajet["cloture"].day == 20,
        "la date de clôture est celle de l'étape « process terminé »",
    )
    verifier(
        trajet["issue"] == "Clôture — montant récupéré",
        "l'issue distingue le montant récupéré du montant perdu",
    )
    verifier(trajet["duree_jours"] == 11, "la durée de procédure est calculée")

    verifier(
        module_synthese.qualifier_etape("Process terminé - Montant perdu")
        == "Clôture — montant perdu",
        "le montant perdu est reconnu comme tel",
    )
    verifier(
        module_synthese.qualifier_etape("Dossier à transmettre au service contentieux")
        == "Passage au contentieux",
        "les deux libellés de passage au contentieux sont reconnus",
    )
    verifier(
        module_synthese.qualifier_etape("Relance 2") == "",
        "une étape courante n'est pas prise pour une étape marquante",
    )

    page = module_synthese.construire_html(
        dossier=dossier,
        boites=["recouvrement@liora.io"],
        lignes=[_ligne(1, 3, "envoyé", "Relance")],
        synthese=module_synthese.analyser([_ligne(1, 3, "envoyé", "Relance")], {}),
        date_export=datetime(2026, 4, 1, tzinfo=timezone(timedelta(hours=1))),
    )
    verifier(
        "Parcours du dossier" in page and "Passé au contentieux le" in page,
        "la note porte le parcours et la date de passage au contentieux",
    )
    verifier(
        "09/03/2026" in page and "20/03/2026" in page,
        "les dates des étapes figurent dans la note",
    )
    verifier(
        "11 jours de procédure" in page,
        "la durée de procédure est annoncée",
    )
    verifier(
        "journal d'activité de Monday" in page,
        "la note dit d'où viennent ces dates, et que ce journal est limité",
    )

    sans = module_synthese.construire_html(
        dossier=Dossier(reference="F", nom="X", emails=["a@b.fr"]),
        boites=["recouvrement@liora.io"],
        lignes=[_ligne(1, 3, "envoyé", "Relance")],
        synthese=module_synthese.analyser([_ligne(1, 3, "envoyé", "Relance")], {}),
        date_export=datetime(2026, 4, 1, tzinfo=timezone(timedelta(hours=1))),
    )
    verifier(
        "Parcours du dossier" not in sans,
        "sans historique, la note n'annonce pas un parcours vide",
    )


def test_liste_complete_tableaux() -> None:
    """Tous les tableaux du compte, pagination comprise, en ordre naturel."""
    print("\nListe des tableaux Monday")

    import monday as module_monday  # noqa: PLC0415

    # Les tableaux de Liora, tels qu'ils apparaissent dans Monday.
    noms = [
        "1.1. Entreprise - ADV", "1.2. Entreprise - Recouvrement",
        "1.3. Entreprise - OPCO", "1.9. Opco et plateforme - Technique",
        "1.9. Entreprise - Technique", "2.1. Financement Personnel",
        "2.2. Financement CPF", "2.3. Financement pôle emploi : AIF / POEI",
        "2.4. Financement complexe : REGION / TRANSITION / AGEFIPH",
        "2.9. Dossier AIF en cours - Technique", "2.9. Zone Kairos - Technique",
        "2.9. RIB Reçus - Technique", "2.9. Transactions - Technique",
    ]
    tous = [
        {"id": 100 + rang, "name": nom, "type": "board",
         "workspace": {"name": "Recouvrement"}}
        for rang, nom in enumerate(noms)
    ]
    # Monday crée un tableau technique par colonne de sous-éléments, glissé
    # dans la même liste. Les deux voies de détection sont éprouvées : le
    # champ `type`, et le nom seul quand l'API ne renvoie pas ce champ.
    parasites = [
        {"id": 900, "name": "Sous-éléments de 1.2. Entreprise - Recouvrement",
         "type": "sub_items_board", "workspace": {"name": "Recouvrement"}},
        {"id": 901, "name": "Sous-éléments de 2.1. Financement Personnel",
         "workspace": {"name": "Recouvrement"}},
        {"id": 902, "name": "Subitems of 1.1. Entreprise - ADV",
         "workspace": {"name": "Recouvrement"}},
        # Un vrai tableau dont le type manque doit rester, lui.
        {"id": 903, "name": "3.1. Sous-traitance", "workspace": {"name": "Recouvrement"}},
    ]
    noms.append("3.1. Sous-traitance")
    attendus = {str(tab["id"]) for tab in tous} | {"903"}
    tous = tous[:3] + parasites + tous[3:]

    pages: list[int] = []

    def faux_appel(requete, jeton):
        # Deux pages : la première pleine, la seconde partielle.
        page = int(requete.split("page: ")[1].split(",")[0])
        pages.append(page)
        taille = module_monday.TABLEAUX_PAR_PAGE
        debut = (page - 1) * taille
        return {"boards": tous[debut:debut + taille]}

    vrai_appel = module_monday._appeler_api
    taille_reelle = module_monday.TABLEAUX_PAR_PAGE
    module_monday._appeler_api = faux_appel
    module_monday.TABLEAUX_PAR_PAGE = 10  # force une seconde page
    try:
        tableaux = module_monday.lister_tableaux("jeton")
    finally:
        module_monday._appeler_api = vrai_appel
        module_monday.TABLEAUX_PAR_PAGE = taille_reelle

    verifier(pages == [1, 2], "la seconde page est demandée, puis la lecture s'arrête")
    verifier(
        len(tableaux) == len(noms),
        f"les {len(noms)} tableaux sont tous listés (obtenu : {len(tableaux)})",
    )
    verifier(
        [tab["nom"] for tab in tableaux] == sorted(noms, key=str.lower),
        "l'ordre est celui de la numérotation Monday, non celui d'usage",
    )
    verifier(
        tableaux[0]["espace"] == "Recouvrement",
        "l'espace de travail accompagne chaque tableau",
    )
    verifier(
        {tab["id"] for tab in tableaux} == attendus,
        "chaque tableau porte son identifiant, sous forme de texte",
    )
    verifier(
        not [tab for tab in tableaux if "ous-éléments" in tab["nom"]
             or tab["nom"].lower().startswith("subitems of")],
        "les tableaux de sous-éléments ne sont pas proposés",
    )
    verifier(
        any(tab["nom"] == "3.1. Sous-traitance" for tab in tableaux),
        "un tableau dont le nom commence par « Sous- » n'est pas écarté pour autant",
    )

    # Une API qui renverrait toujours la même page ne doit pas boucler sans fin.
    module_monday._appeler_api = lambda requete, jeton: {"boards": tous[:1] * 10}
    module_monday.TABLEAUX_PAR_PAGE = 10
    try:
        bornes = module_monday.lister_tableaux("jeton")
    finally:
        module_monday._appeler_api = vrai_appel
        module_monday.TABLEAUX_PAR_PAGE = taille_reelle
    verifier(
        len(bornes) == 1,
        "un même tableau renvoyé en boucle n'est compté qu'une fois",
    )


def test_deux_tableaux() -> None:
    """Deux tableaux, deux libellés de qualification, un seul lot."""
    print("\nDeux tableaux réunis")

    import export_mails  # noqa: PLC0415
    import monday as module_monday  # noqa: PLC0415
    from dossiers import rendre_repertoires_uniques  # noqa: PLC0415
    from gmail_api import SourcesGmail  # noqa: PLC0415

    def colonne(titre, texte):
        return {"column": {"title": titre}, "text": texte, "value": None}

    def ligne(nom, societe, etape, email):
        return {
            "name": nom,
            "column_values": [
                colonne("Entreprise", societe),
                colonne("E-mail", email),
                colonne("Etape process recouvrement", etape),
            ],
        }

    # Le tableau entreprise « fait passer », celui des particuliers
    # « transmet » : deux libellés pour la même étape.
    tableaux = {
        "101": [
            ligne("FACT-2405-00030", "ACME SARL",
                  "🔴 Dossier à faire passer en contentieux", "compta@acme.fr"),
            ligne("FACT-2405-00031", "BETA SAS", "Relance 1", "compta@beta.fr"),
        ],
        "202": [
            ligne("FACT-2405-00030", "", "Dossier à transmettre au service contentieux",
                  "marie@exemple.fr"),
            ligne("FACT-2405-00099", "", "Echéancier en cours", "paul@exemple.fr"),
        ],
    }

    def faux_appel(requete, jeton):
        for identifiant, elements in tableaux.items():
            if f"ids: [{identifiant}]" in requete:
                return {"boards": [{"items_page": {"cursor": None, "items": elements}}]}
        return {"boards": []}

    vrai_appel = module_monday._appeler_api
    vraies_sources = export_mails.ouvrir_sources
    module_monday._appeler_api = faux_appel
    export_mails.ouvrir_sources = lambda **_: SourcesGmail([ClientFictif()])
    try:
        with tempfile.TemporaryDirectory() as repertoire:
            racine = Path(repertoire)
            jeton = racine / "monday.txt"
            jeton.write_text("faux-jeton", encoding="utf-8")

            journal: list[str] = []
            code = export_mails.executer(
                export_mails.analyser_arguments([
                    "--sortie", str(racine / "export"),
                    "--jeton-monday", str(jeton),
                    "--tableau-monday", "101,202",
                    "--filtre-colonne", "Etape process recouvrement",
                    "--filtre-valeur",
                    "Dossier à faire passer en contentieux,"
                    "Dossier à transmettre au service contentieux",
                    "--simulation",
                ]),
                relais=journal.append,
            )
            trace = "\n".join(journal)
            verifier(code == 0, "code de sortie 0")
            verifier(
                "Lecture du tableau Monday 101" in trace
                and "Lecture du tableau Monday 202" in trace,
                "les deux tableaux sont lus",
            )
            verifier(
                "2 dossier(s) retenu(s) sur 4" in trace,
                "un seul dossier retenu par tableau, chacun sur son propre libellé",
            )
            verifier(
                "2 tableau(x) Monday" in trace,
                "le lot annonce son origine multiple",
            )
            verifier(
                trace.count("FACT-2405-00030") >= 1,
                "un numéro de facture présent dans les deux tableaux reste traité",
            )
            verifier(
                "[1/2]" in trace and "[2/2]" in trace,
                "les deux dossiers retenus sont traités séparément",
            )
    finally:
        module_monday._appeler_api = vrai_appel
        export_mails.ouvrir_sources = vraies_sources

    # Le renommage lui-même, indépendamment de Monday.
    from dossiers import Dossier  # noqa: PLC0415

    doubles = [
        Dossier(reference="FACT-1", nom="ACME", emails=["a@acme.fr"]),
        Dossier(reference="FACT-1", nom="ACME", emails=["b@acme.fr"]),
        Dossier(reference="FACT-1", nom="ACME", emails=["c@acme.fr"]),
    ]
    rendre_repertoires_uniques(doubles)
    verifier(
        len({d.nom_repertoire for d in doubles}) == 3,
        "trois références identiques donnent trois répertoires distincts",
    )
    verifier(
        doubles[0].reference == "FACT-1",
        "le premier garde sa référence, seuls les suivants sont renommés",
    )


def test_lanceurs_windows() -> None:
    """Les lanceurs Windows doivent rester en ASCII pur.

    Un .bat, un .ps1 ou un .vbs est lu dans la page de codes du poste, jamais
    en UTF-8. Un seul accent y suffit à tout casser : « echo. » devient
    « cho. » dans un .bat après un chcp, et PowerShell perd le guillemet
    fermant d'une chaîne. Les deux se sont produits.
    """
    print("\nLanceurs Windows")
    racine = Path(__file__).resolve().parent

    for nom in ("Installer.bat", "Lancer.bat", "Lancer-silencieux.vbs", "installer.ps1"):
        chemin = racine / nom
        if not chemin.exists():
            verifier(False, f"{nom} présent")
            continue
        octets = chemin.read_bytes()
        fautifs = sorted({octet for octet in octets if octet > 127})
        verifier(
            not fautifs,
            f"{nom} en ASCII pur"
            + (f" — octets fautifs : {[hex(o) for o in fautifs[:6]]}" if fautifs else ""),
        )

    installateur = (racine / "Installer.bat").read_text(encoding="ascii")
    verifier(
        "installer.ps1" in installateur and "Lancer-silencieux.vbs" in installateur,
        "l'installateur nomme le script PowerShell et la solution de secours",
    )
    script = (racine / "installer.ps1").read_text(encoding="ascii")
    verifier(
        "liora.ico" in script and "Liora - Suivi contentieux.lnk" in script,
        "le raccourci porte le bon nom et la bonne icône",
    )
    verifier(
        "pythonw.exe" in script and "interface.py" in script,
        "le raccourci vise pythonw directement, sans passer par un script",
    )
    verifier(
        "Unblock-File" in script,
        "la marque « téléchargé d'Internet » est retirée des fichiers",
    )
    verifier(
        "exit 1" in script,
        "un échec est remonté au .bat, qui affiche alors la solution de secours",
    )
    lanceur = (racine / "Lancer-silencieux.vbs").read_text(encoding="ascii")
    verifier(
        "pythonw.exe" in lanceur and "interface.py" in lanceur,
        "le lanceur silencieux vise pythonw et l'interface",
    )
    verifier((racine / "liora.ico").exists(), "l'icône est présente")


def test_mise_a_jour() -> None:
    """Compléter un dossier déjà exporté sans le refaire ni le renuméroter."""
    print("\nMise à jour d'un dossier existant")

    import export_mails  # noqa: PLC0415
    from gmail_api import SourcesGmail  # noqa: PLC0415

    client = ClientEvolutif()
    vraies_sources = export_mails.ouvrir_sources
    export_mails.ouvrir_sources = lambda **_: SourcesGmail([client])
    try:
        with tempfile.TemporaryDirectory() as repertoire:
            racine = Path(repertoire)
            fichier = racine / "dossiers.csv"
            fichier.write_text(
                "reference;nom;email;facture\n"
                "2024-118;Marie Dupont;marie.dupont@exemple.fr;FA-2024-0153\n",
                encoding="utf-8",
            )
            sortie = racine / "export"
            arguments = ["--dossiers", str(fichier), "--sortie", str(sortie)]

            export_mails.executer(export_mails.analyser_arguments(arguments))
            dossier = sortie / "2024-118_marie-dupont"
            index = _lire_index(dossier / "index.csv")
            verifier(len(index) == 2, "premier export : 2 pièces")

            empreintes = {
                chemin.name: chemin.stat().st_mtime_ns
                for chemin in (dossier / "mails").iterdir()
            }

            # Rien de neuf : le dossier ne doit pas bouger d'un octet.
            journal: list[str] = []
            export_mails.executer(
                export_mails.analyser_arguments(arguments + ["--mettre-a-jour"]),
                relais=journal.append,
            )
            verifier(
                "aucun message nouveau" in "\n".join(journal),
                "sans nouveauté, la mise à jour le dit et s'arrête",
            )
            verifier(
                {c.name: c.stat().st_mtime_ns for c in (dossier / "mails").iterdir()}
                == empreintes,
                "aucun fichier réécrit quand il n'y a rien de nouveau",
            )
            recap = _lire_index(sortie / "_recapitulatif.csv")
            verifier(
                recap[0]["nb_mails"] == "2" and recap[0]["statut"] == "à jour",
                "le récapitulatif compte les pièces du dossier, pas les téléchargements",
            )

            # Un message arrive, antérieur aux deux autres.
            client.disponibles = ["e1", "e2", "e3"]
            journal = []
            export_mails.executer(
                export_mails.analyser_arguments(arguments + ["--mettre-a-jour"]),
                relais=journal.append,
            )
            verifier(
                "1 message(s) nouveau(x)" in "\n".join(journal),
                "un seul message est signalé comme nouveau",
            )

            index = _lire_index(dossier / "index.csv")
            par_objet = {r["objet"]: r for r in index}
            verifier(len(index) == 3, "le dossier compte désormais 3 pièces")
            verifier(
                par_objet["Relance FA-2024-0153"]["piece_n"] == "1"
                and par_objet["Re: relance"]["piece_n"] == "2",
                "les numéros de pièce déjà attribués ne changent pas",
            )
            verifier(
                par_objet["Envoi initial"]["piece_n"] == "3",
                "la pièce nouvelle prend le numéro suivant, malgré sa date antérieure",
            )
            verifier(
                [r["date"] for r in index]
                == ["02/03/2024", "04/03/2024", "12/03/2024"],
                "l'index reste trié par date",
            )
            verifier(
                {c.name: c.stat().st_mtime_ns
                 for c in (dossier / "mails").iterdir()
                 if c.name in empreintes} == empreintes,
                "les pièces existantes ne sont ni retéléchargées ni réimprimées",
            )
            verifier(
                (dossier / "mails" / "003_2024-03-02_0900_recouvrement_envoi-initial.eml").exists(),
                "le nouveau message est bien écrit",
            )

            recap = _lire_index(sortie / "_recapitulatif.csv")
            verifier(recap[0]["nb_mails"] == "3", "récapitulatif à jour")
            verifier(
                recap[0]["nb_envoyes"] == "2" and recap[0]["nb_recus"] == "1",
                "les sens sont recomptés sur l'ensemble du dossier",
            )

            # Recherche devenue muette : un dossier constitué ne s'efface pas.
            client.disponibles = []
            export_mails.executer(
                export_mails.analyser_arguments(arguments + ["--mettre-a-jour"])
            )
            verifier(
                len(_lire_index(dossier / "index.csv")) == 3,
                "une recherche sans résultat n'efface pas un dossier existant",
            )
    finally:
        export_mails.ouvrir_sources = vraies_sources
        ClientEvolutif.disponibles = ["e1", "e2"]


def test_export_interrompu() -> None:
    """Un export coupé en plein milieu laisse un récapitulatif exploitable."""
    print("\nExport interrompu")

    import export_mails  # noqa: PLC0415
    from gmail_api import SourcesGmail  # noqa: PLC0415

    class ClientCoupure(ClientFictif):
        """Le poste se met en veille au troisième dossier."""

        def rechercher_identifiants(self, requete, inclure_spam_corbeille=True, plafond=None):
            if "troisieme@exemple.fr" in requete:
                raise KeyboardInterrupt
            return ["m1"] if "@exemple.fr" in requete else []

    vraies_sources = export_mails.ouvrir_sources
    export_mails.ouvrir_sources = lambda **_: SourcesGmail([
        ClientCoupure("recouvrement@liora.io", ["m1"])
    ])
    try:
        with tempfile.TemporaryDirectory() as repertoire:
            racine = Path(repertoire)
            fichier = racine / "dossiers.csv"
            fichier.write_text(
                "reference;nom;email;facture\n"
                "D1;Premiere;premiere@exemple.fr;FA-1\n"
                "D2;Deuxieme;deuxieme@exemple.fr;FA-2\n"
                "D3;Troisieme;troisieme@exemple.fr;FA-3\n",
                encoding="utf-8",
            )
            sortie = racine / "export"

            code = export_mails.executer(
                export_mails.analyser_arguments(
                    ["--dossiers", str(fichier), "--sortie", str(sortie)]
                )
            )
            verifier(
                code == 130,
                "l'interruption est signalée par un code distinct d'une erreur",
            )
            verifier(
                (sortie / "_recapitulatif.csv").exists(),
                "le récapitulatif existe malgré l'interruption",
            )
            recap = _lire_index(sortie / "_recapitulatif.csv")
            verifier(
                [rangee["reference"] for rangee in recap] == ["D1", "D2"],
                "il décrit les dossiers réellement traités, et eux seuls",
            )
            verifier(
                (sortie / "LISEZ-MOI.txt").exists(),
                "la note de méthode est écrite dès le départ, pas à la fin",
            )

            # C'est ce que lit le tableau de bord : sans récapitulatif, il
            # resterait vide alors que le travail est fait.
            from suivi import inventaire  # noqa: PLC0415

            dossiers = inventaire(sortie, racine / "suivi.json")
            verifier(
                len(dossiers) == 2 and all(d["a_index"] for d in dossiers),
                "le tableau de bord retrouve les dossiers d'un export interrompu",
            )

            # Reprise : les deux premiers sont sautés, le troisième repasse.
            reprise: list[str] = []
            export_mails.executer(
                export_mails.analyser_arguments([
                    "--dossiers", str(fichier), "--sortie", str(sortie),
                    "--reprendre",
                ]),
                relais=reprise.append,
            )
            verifier(
                "\n".join(reprise).count("déjà exporté, ignoré") == 2,
                "--reprendre saute les deux dossiers déjà écrits",
            )

            # Une panne imprévue doit laisser sa trace dans journal.log :
            # c'est la seule source consultable une fois l'appli refermée.
            class ClientCassé(ClientFictif):
                def rechercher_identifiants(self, requete, inclure_spam_corbeille=True, plafond=None):
                    raise ZeroDivisionError("panne simulée")

            export_mails.ouvrir_sources = lambda **_: SourcesGmail([ClientCassé()])
            sortie3 = racine / "export-panne"
            code = export_mails.executer(
                export_mails.analyser_arguments(
                    ["--dossiers", str(fichier), "--sortie", str(sortie3)]
                )
            )
            trace = (sortie3 / "journal.log").read_text(encoding="utf-8")
            verifier(code == 3, "une panne imprévue a son propre code de sortie")
            verifier(
                "Erreur inattendue : ZeroDivisionError : panne simulée" in trace,
                "journal.log nomme la panne au lieu de s'arrêter sans un mot",
            )
            verifier(
                "ZeroDivisionError" in trace and "rechercher_identifiants" in trace,
                "journal.log conserve la trace complète, exploitable à distance",
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


def test_interface() -> None:
    """Pilote l'interface graphique par son API, comme le ferait la page."""
    print("\nInterface graphique")
    import base64  # noqa: PLC0415
    import json as module_json  # noqa: PLC0415
    import time  # noqa: PLC0415
    import urllib.error  # noqa: PLC0415
    import urllib.request  # noqa: PLC0415

    import export_mails  # noqa: PLC0415
    import interface  # noqa: PLC0415

    def appeler(chemin, corps=None, jeton=interface.JETON):
        requete = urllib.request.Request(f"{base}{chemin}")
        if jeton is not None:
            requete.add_header("X-Jeton", jeton)
        if corps is not None:
            requete.data = module_json.dumps(corps).encode("utf-8")
            requete.add_header("Content-Type", "application/json")
        with urllib.request.urlopen(requete, timeout=10) as reponse:  # noqa: S310
            return reponse.status, module_json.loads(reponse.read().decode("utf-8"))

    vraies_sources = export_mails.ouvrir_sources
    export_mails.ouvrir_sources = _sources_fictives
    serveur = interface.demarrer(ouvrir=False)
    base = f"http://127.0.0.1:{serveur.server_address[1]}"
    threading.Thread(target=serveur.serve_forever, daemon=True).start()

    empreinte_avant = set(Path(interface.RACINE).iterdir())
    try:
        with urllib.request.urlopen(f"{base}/", timeout=10) as reponse:  # noqa: S310
            page = reponse.read().decode("utf-8")
        verifier("Export recouvrement" in page, "la page est servie")

        # Une insertion ratée dans le gabarit ne se voit pas à l'exécution :
        # la page s'affiche, le champ manque, et l'option devient inatteignable.
        # Chaque commande de la page est donc vérifiée nommément.
        attendus = [
            ('id="fichier"', "dépôt de fichier"),
            ('id="mEmail"', "recherche par adresse"),
            ('id="mFacture"', "recherche par facture"),
            ('id="boites"', "boîtes à interroger"),
            ('id="sortie"', "dossier de destination"),
            ('id="jetonMonday"', "jeton Monday"),
            ('id="domaines"', "domaines d'envoi"),
            ('id="tableau"', "choix du tableau Monday"),
            ('id="listerTableaux"', "bouton de listage des tableaux"),
            ('id="chercheTableau"', "recherche dans les tableaux"),
            ('id="filtreColonne"', "colonne de filtrage"),
            ('id="filtreValeur"', "valeur de filtrage"),
            ('data-volet="voletMonday"', "volet Monday en direct"),
            ('id="simulation"', "option simulation"),
            ('id="ignorer"', "option lignes incomplètes"),
            ('id="regrouper"', "option regroupement"),
            ('id="sousdossiers"', "option sous-dossier par facture"),
            ('id="sousdossiersadresse"', "option sous-dossier par adresse"),
            ('id="decouvrir"', "option découverte d'adresses"),
            ('id="dejaExporte"', "rappel d'un export déjà présent"),
            ('id="courbeBord"', "courbe d'avancement"),
            ('id="anciennete"', "ancienneté des créances"),
            ('id="dormants"', "dossiers en souffrance"),
            ('id="sansnav"', "option sans navigateur"),
            ('id="reprendre"', "option reprendre"),
            ('id="majdossiers"', "option compléter les dossiers"),
            ('id="seulement"', "filtre par références"),
            ('id="lancer"', "bouton lancer"),
            ('data-vue="vueBord"', "onglet tableau de bord"),
            ('data-vue="vueSuivi"', "onglet état des dossiers"),
            ('data-vue="vueDocuments"', "onglet documents"),
            ('data-vue="vueExport"', "onglet export"),
        ]
        manquants = [libelle for marqueur, libelle in attendus if marqueur not in page]
        verifier(not manquants, f"tous les champs de la page sont présents{' — manque : ' + ', '.join(manquants) if manquants else ''}")

        restants = [m for m in ("__JETON__", "__SORTIE__", "__BOITES__",
                                "__MOTEUR_PDF__", "__ETAT_MONDAY__", "__VERSION__",
                                "__INVITE_TABLEAUX__", "__CHANTIERS__",
                                "__CHANTIERS_PROPOSES__",
                                "__IMPORT__", "__DOMAINES__", "__OPTIONS__",
                                "__SEULEMENT__", "__TABLEAU__", "__REGIMES__",
                                "__FILTRE_COLONNE__", "__FILTRE_VALEUR__") if m in page]
        verifier(not restants, f"aucun marqueur de gabarit non remplacé{' — reste : ' + ', '.join(restants) if restants else ''}")
        verifier("__JETON__" not in page, "le jeton est injecté dans la page")
        verifier(f"Version {interface.VERSION}" in page,
                 f"l'en-tête annonce la version (obtenu : {interface.VERSION})")
        verifier(interface.JETON in page, "la page porte le jeton de la session")

        print("  -- refus sans jeton --")
        try:
            appeler("/api/journal", jeton=None)
            verifier(False, "appel sans jeton refusé")
        except urllib.error.HTTPError as exc:
            verifier(exc.code == 403, f"appel sans jeton refusé (HTTP {exc.code})")

        print("  -- refus d'un format inattendu --")
        try:
            appeler("/api/lancer", {"nom": "liste.docx", "contenu": "eA=="})
            verifier(False, "extension non prise en charge refusée")
        except urllib.error.HTTPError as exc:
            verifier(exc.code == 400, f"extension non prise en charge refusée ({exc.code})")

        print("  -- les anciens filtres par colonne sont retirés une fois --")
        avant_migration = interface.lire_preferences()
        try:
            interface.ecrire_preferences({
                "filtre_colonne": "Etape process recouvrement",
                "filtre_valeur": "Dossier à faire passer en contentieux,"
                                 "Dossier à transmettre au service contentieux",
            })
            migrees = interface.lire_preferences()
            verifier(migrees.get("filtre_valeur") == ""
                     and migrees.get("filtre_colonne") == "",
                     "un filtre laissé tel que proposé est retiré au profit du groupe")
            verifier(migrees.get("groupes") == interface.GROUPES_PAR_DEFAUT,
                     "le groupe prend le relais")
            verifier(migrees.get("filtres_migres") is True,
                     "la migration est marquée, elle n'a lieu qu'une fois")

            # Un champ vidé à la main ne doit pas se voir re-remplir, et une
            # valeur choisie par l'utilisateur ne doit pas être effacée.
            interface.ecrire_preferences({
                "filtre_colonne": "Statut Créance", "filtre_valeur": "impayé",
            })
            intactes = interface.lire_preferences()
            verifier(intactes.get("filtre_valeur") == "impayé",
                     "un filtre choisi par l'utilisateur est respecté")
            verifier("filtres_migres" not in intactes,
                     "rien n'est marqué quand il n'y a rien à migrer")
        finally:
            interface.ecrire_preferences(avant_migration)

        print("  -- une remise à zéro non confirmée est refusée --")
        # Elle est irrattrapable : la confirmation est portée dans la requête
        # plutôt que déduite d'un appel bien formé.
        try:
            appeler("/api/tout-effacer", {"fichiers": True, "suivi": True})
            verifier(False, "effacement sans confirmation refusé")
        except urllib.error.HTTPError as exc:
            verifier(exc.code == 400, f"effacement sans confirmation refusé ({exc.code})")

        print("  -- les options de la page arrivent bien à l'outil --")
        # Une case ajoutée à la page mais oubliée dans la ligne de commande ne
        # se voit pas : elle se coche, et ne change rien.
        args, _ = interface.construire_arguments(
            {"tableau": "42", "sous_elements": True,
             "filtre_colonne": "Etape process recouvrement",
             "filtre_valeur": "contentieux"},
            Path("dossiers.csv"),
        )
        verifier("--avec-sous-elements" in args,
                 "la case des sous-éléments atteint la ligne de commande")
        verifier("--tableau-monday" in args and "--filtre-colonne" in args,
                 "le tableau et son filtre l'atteignent aussi")
        sans, _ = interface.construire_arguments({"tableau": "42"}, Path("d.csv"))
        verifier("--avec-sous-elements" not in sans,
                 "décochée, elle n'ajoute rien")
        verifier("souselements" in interface.CASES_MEMORISEES,
                 "la case est mémorisée d'une session à l'autre")

        print("  -- les tableaux du travail courant sont proposés --")
        # Ils ne le sont qu'une fois : la trace enregistrée doit revenir dans
        # la page, sans quoi un tableau décoché serait recoché au listage
        # suivant.
        avant = interface.lire_preferences()
        try:
            verifier("__CHANTIERS__" not in page and '"1.2."' in page and '"2.1."' in page,
                     "la page porte les deux tableaux à cocher d'office")
            verifier("let chantiersProposes = false" in page,
                     "au premier lancement, la proposition reste à faire")
            appeler("/api/reglages", {"chantiers_proposes": True})
            verifier(interface.lire_preferences().get("chantiers_proposes") is True,
                     "la proposition faite est mémorisée")
            rendue = urllib.request.urlopen(f"{base}/", timeout=10).read().decode("utf-8")
            verifier("let chantiersProposes = true" in rendue,
                     "une fois proposés, les tableaux ne sont plus recochés d'office")
        finally:
            interface.ecrire_preferences(avant)

        print("  -- sans jeton Monday, le bouton s'explique --")
        # Le bandeau d'erreur vit en section 4 : un echec sur « Lister mes
        # tableaux », en section 1, y reste hors de l'ecran. Le motif doit
        # donc etre annonce des l'ouverture, sous le bouton lui-meme.
        jeton_range = None
        if interface.JETON_MONDAY.exists():
            jeton_range = interface.JETON_MONDAY.read_text(encoding="utf-8")
            interface.JETON_MONDAY.unlink()
        try:
            sans = urllib.request.urlopen(f"{base}/", timeout=10).read().decode("utf-8")
            verifier("jeton Monday n'est pas encore enregistré" in sans,
                     "sans jeton, la zone des tableaux dit pourquoi avant le clic")
            try:
                appeler("/api/tableaux", {"jeton_monday": ""})
                verifier(False, "listage refusé sans jeton")
            except urllib.error.HTTPError as exc:
                motif = json.loads(exc.read().decode("utf-8")).get("erreur", "")
                verifier(exc.code == 400 and "jeton Monday" in motif,
                         f"listage refusé sans jeton, avec le motif ({exc.code})")
        finally:
            if jeton_range is not None:
                interface.JETON_MONDAY.write_text(jeton_range, encoding="utf-8")

        print("  -- export complet piloté par l'interface --")
        contenu = (
            "reference;nom;email;facture\n"
            "2024-118;Marie Dupont;marie.dupont@exemple.fr;FA-2024-0153\n"
        ).encode("utf-8")
        with tempfile.TemporaryDirectory() as repertoire:
            statut, reponse = appeler(
                "/api/lancer",
                {
                    "nom": "export-monday.csv",
                    "contenu": base64.b64encode(contenu).decode("ascii"),
                    "boites": "billing@liora.io,recouvrement@liora.io",
                    "sortie": repertoire,
                    "simulation": True,
                },
            )
            verifier(statut == 200 and reponse.get("demarre"), "export démarré")

            etat = {}
            for _ in range(100):
                _statut, etat = appeler("/api/journal?depuis=0")
                if etat.get("termine"):
                    break
                time.sleep(0.1)

            verifier(etat.get("termine") is True, "l'interface signale la fin")
            verifier(etat.get("code") == 0, f"code de sortie 0 (obtenu : {etat.get('code')})")
            journal = "\n".join(etat.get("lignes", []))
            verifier("1 dossier(s) à traiter" in journal, "le journal remonte à l'interface")
            verifier(
                "recouvrement@liora.io" in journal and "billing@liora.io" in journal,
                "les deux boîtes sont citées dans le journal",
            )

            print("  -- réglages enregistrés sans rien cliquer --")
            statut, _reponse = appeler(
                "/api/reglages",
                {
                    "boites": "  billing@liora.io,recouvrement@liora.io  ",
                    "sortie": repertoire,
                    "domaines": "datascientest.com",
                    "seulement": "FACT-1",
                    "options": {"simulation": False, "decouvrir": True,
                                "inconnue": True},
                },
            )
            verifier(statut == 200, "réglages acceptés")

            preferences = interface.lire_preferences()
            verifier(
                preferences.get("boites") == "billing@liora.io,recouvrement@liora.io",
                "les adresses sont enregistrées, espaces retirés",
            )
            verifier(
                preferences.get("domaines") == "datascientest.com"
                and preferences.get("seulement") == "FACT-1",
                "domaines et filtre de références enregistrés",
            )
            cases = interface.cases_memorisees()
            verifier(
                cases["simulation"] is False and cases["decouvrir"] is True,
                "les cases décochées le restent à la réouverture",
            )
            verifier(
                cases["regrouper"] is True,
                "une case non transmise garde sa valeur de premier lancement",
            )
            verifier(
                "inconnue" not in cases and "inconnue" not in (
                    preferences.get("options") or {}
                ),
                "une case inconnue est ignorée plutôt qu'enregistrée",
            )

            page = urllib.request.urlopen(f"{base}/").read().decode("utf-8")
            verifier(
                '"simulation": false' in page or '"simulation":false' in page,
                "la page rouvre avec les cases dans l'état laissé",
            )
            verifier(
                'value="datascientest.com"' in page,
                "la page rouvre avec les domaines renseignés",
            )

            statut, _reponse = appeler("/api/vivant")
            verifier(statut == 200, "battement de cœur accepté")

            print("  -- le fichier importé survit à la fermeture de l'appli --")
            memoire = interface.dernier_import()
            verifier(
                memoire is not None and memoire["nom"] == "export-monday.csv",
                "l'import est mémorisé avec son nom d'origine",
            )
            rechargee = urllib.request.urlopen(f"{base}/").read().decode("utf-8")
            verifier(
                "export-monday.csv" in rechargee
                and "Dernier fichier importé" in rechargee,
                "rouvrir l'application rappelle le dernier fichier importé",
            )

            statut, reponse = appeler(
                "/api/lancer",
                {"reutiliser": True, "sortie": repertoire, "simulation": True,
                 "boites": "recouvrement@liora.io"},
            )
            verifier(
                statut == 200 and reponse.get("fichier") == "export-monday.csv",
                "relance possible sans redéposer le fichier",
            )
            for _ in range(100):
                _statut, etat = appeler("/api/journal?depuis=0")
                if etat.get("termine"):
                    break
                time.sleep(0.1)
            verifier(
                etat.get("code") == 0
                and "1 dossier(s) à traiter" in "\n".join(etat.get("lignes", [])),
                "la relance lit bien le fichier conservé sur le disque",
            )

            (interface.RACINE / "dossiers-depose.csv").unlink(missing_ok=True)
            verifier(
                interface.dernier_import() is None,
                "un fichier effacé à la main ne laisse pas de rappel trompeur",
            )
            statut = None
            try:
                appeler("/api/lancer", {"reutiliser": True, "sortie": repertoire})
                verifier(False, "relance refusée quand le fichier a disparu")
            except urllib.error.HTTPError as exc:
                verifier(
                    exc.code == 400, f"relance refusée quand le fichier a disparu ({exc.code})"
                )

            print("  -- recherche ponctuelle, sans fichier --")
            statut, _reponse = appeler(
                "/api/lancer",
                {
                    "mode": "manuel",
                    "email": "marie.dupont@exemple.fr",
                    "facture": "FA-2024-0153",
                    "nom_dossier": "Marie Dupont",
                    "boites": "recouvrement@liora.io",
                    "sortie": repertoire,
                    "simulation": True,
                },
            )
            verifier(statut == 200, "recherche manuelle acceptée")

            etat = {}
            for _ in range(100):
                _statut, etat = appeler("/api/journal?depuis=0")
                if etat.get("termine"):
                    break
                time.sleep(0.1)
            journal = "\n".join(etat.get("lignes", []))
            verifier(etat.get("code") == 0, "recherche manuelle menée à son terme")
            verifier(
                "1 dossier(s) à traiter" in journal,
                "la saisie manuelle produit bien un dossier",
            )
            verifier("Marie Dupont" in journal, "le nom saisi nomme le dossier")

            print("  -- saisie manuelle : plusieurs adresses et factures --")
            appeler(
                "/api/lancer",
                {
                    "mode": "manuel",
                    "email": "marie.dupont@exemple.fr,m.dupont@travail.fr",
                    "facture": "FA-2024-0153,FA-2024-0154",
                    "nom_dossier": "Marie Dupont",
                    "boites": "recouvrement@liora.io",
                    "sortie": repertoire,
                    "simulation": True,
                },
            )
            for _ in range(100):
                _statut, etat = appeler("/api/journal?depuis=0")
                if etat.get("termine"):
                    break
                time.sleep(0.1)
            journal = "\n".join(etat.get("lignes", []))
            verifier(
                "1 dossier(s) à traiter" in journal,
                "deux adresses et deux factures forment un seul dossier",
            )
            from dossiers import lire_dossiers  # noqa: PLC0415

            depose = lire_dossiers(interface.RACINE / "dossiers-depose.csv")[0]
            verifier(
                depose.emails == ["marie.dupont@exemple.fr", "m.dupont@travail.fr"],
                "les deux adresses saisies sont retenues, dans l'ordre",
            )
            verifier(
                depose.factures == ["FA-2024-0153", "FA-2024-0154"],
                "les deux numéros de facture saisis sont retenus",
            )
            requete = depose.requete_gmail()
            verifier(
                "from:m.dupont@travail.fr" in requete and '"FA-2024-0154"' in requete,
                "les deux adresses et les deux factures entrent dans la requête Gmail",
            )
            verifier(
                len(depose.repartition_par_facture()) == 2
                and len(depose.repartition_par_adresse()) == 2,
                "une saisie manuelle multiple donne bien ses sous-dossiers",
            )

            print("  -- refus d'une saisie manuelle sans aucun critère --")
            try:
                appeler(
                    "/api/lancer",
                    {"mode": "manuel", "email": "", "facture": "",
                     "nom_dossier": "X", "sortie": repertoire, "simulation": True},
                )
                verifier(False, "saisie manuelle sans critère refusée")
            except urllib.error.HTTPError as exc:
                verifier(exc.code == 400, f"saisie manuelle sans critère refusée ({exc.code})")

            print("  -- refus d'un second export simultané --")
            interface.EXECUTION.en_cours = True
            try:
                appeler(
                    "/api/lancer",
                    {
                        "nom": "x.csv",
                        "contenu": base64.b64encode(contenu).decode("ascii"),
                        "sortie": repertoire,
                        "simulation": True,
                    },
                )
                verifier(False, "second export simultané refusé")
            except urllib.error.HTTPError as exc:
                verifier(exc.code == 409, f"second export simultané refusé ({exc.code})")
            finally:
                interface.EXECUTION.en_cours = False
    finally:
        serveur.shutdown()
        serveur.server_close()
        export_mails.ouvrir_sources = vraies_sources
        # L'interface dépose le fichier reçu et ses préférences à côté de
        # l'outil : on ne laisse pas ces traces derrière un test.
        for chemin in set(Path(interface.RACINE).iterdir()) - empreinte_avant:
            if chemin.is_file():
                chemin.unlink(missing_ok=True)


def test_suivi() -> None:
    """État d'avancement et frais : persistance et agrégats du tableau de bord."""
    print("\nSuivi des dossiers")
    import csv as module_csv  # noqa: PLC0415

    import suivi as module_suivi  # noqa: PLC0415

    with tempfile.TemporaryDirectory() as repertoire:
        racine = Path(repertoire)
        fichier_suivi = racine / "suivi.json"

        colonnes = ["reference", "nom", "montant_du", "montant_total", "nb_mails",
                    "nb_pieces_jointes", "premier_mail", "dernier_mail",
                    "mise_en_demeure", "contestation", "jours_sans_echange",
                    "statut", "repertoire", "emails", "factures"]
        rangees = [
            ["F-1", "Allianz SE", "2 700,00", "2700", "12", "3", "01/01/2024",
             "01/03/2025", "03/03/2025", "non", "48", "ok", "f-1_allianz", "a@b.fr", "F-1"],
            ["F-2", "Marie Dupont", "680", "1280", "6", "4", "15/10/2024",
             "03/03/2025", "non", "non", "48", "ok", "f-2_dupont", "m@d.fr", "F-2"],
            ["F-3", "Pack and Tool", "1500", "1500", "0", "0", "", "",
             "non", "non", "", "aucun message", "f-3_pack", "", "F-3"],
        ]
        (racine / "f-1_allianz").mkdir()
        (racine / "f-1_allianz" / "synthese.pdf").write_bytes(b"%PDF-")
        with (racine / "_recapitulatif.csv").open("w", encoding="utf-8-sig", newline="") as f:
            redacteur = module_csv.writer(f, delimiter=";")
            redacteur.writerow(colonnes)
            redacteur.writerows(rangees)

        dossiers = module_suivi.inventaire(racine, fichier_suivi)
        verifier(len(dossiers) == 3, f"3 dossiers inventoriés (obtenu : {len(dossiers)})")
        verifier(
            dossiers[0]["montant_du"] == 2700.0,
            f"montant « 2 700,00 » lu correctement ({dossiers[0]['montant_du']})",
        )
        verifier(
            all(d["statut"] == "non-transmis" for d in dossiers),
            "un dossier inconnu du suivi est « non transmis » par défaut",
        )
        verifier(dossiers[0]["a_synthese"] is True, "note de synthèse détectée")
        verifier(dossiers[1]["a_synthese"] is False, "absence de note détectée")

        print("\n  -- enregistrement et relecture --")
        donnees = module_suivi.charger(fichier_suivi)
        module_suivi.mettre_a_jour(
            donnees, "F-1", statut="transmission-en-cours", date_etape="01/02/2026"
        )
        module_suivi.mettre_a_jour(
            donnees, "F-1", statut="avocats", frais="450,50", date_etape="20/02/2026"
        )
        module_suivi.mettre_a_jour(
            donnees, "F-2", statut="cloture-recouvrement", date_etape="05/01/2026"
        )
        module_suivi.mettre_a_jour(
            donnees, "F-3", statut="tribunal-perdu", frais="120", date_etape="10/03/2026"
        )
        module_suivi.enregistrer(fichier_suivi, donnees)

        dossiers = module_suivi.inventaire(racine, fichier_suivi)
        etats = {d["reference"]: d for d in dossiers}
        verifier(etats["F-1"]["statut"] == "avocats", "statut relu depuis le disque")
        verifier(etats["F-1"]["frais"] == 450.5, "frais « 450,50 » relus en nombre")
        verifier(bool(etats["F-1"]["maj"]), "date de modification enregistrée")

        try:
            module_suivi.mettre_a_jour(donnees, "F-1", statut="inconnu")
            verifier(False, "statut inconnu refusé")
        except ValueError:
            verifier(True, "statut inconnu refusé")

        print("\n  -- agrégats du tableau de bord --")
        agregats = module_suivi.agreger(dossiers)
        verifier(agregats["nb_dossiers"] == 3, "nombre de dossiers")
        verifier(agregats["nb_en_cours"] == 1, "un seul dossier encore en cours")
        verifier(
            agregats["montant_en_cours"] == 2700.0,
            f"montant en cours hors clôturés ({agregats['montant_en_cours']})",
        )
        verifier(agregats["montant_gagne"] == 680.0, "montant recouvré")
        verifier(agregats["montant_perdu"] == 1500.0, "montant perdu")
        verifier(agregats["frais_engages"] == 570.5, "frais engagés cumulés")
        verifier(
            agregats["taux_reussite"] == 50,
            "taux calculé sur les seuls dossiers clôturés, non sur l'ensemble",
        )

        print("\n  -- parcours daté --")
        verifier(
            [e["date"] for e in etats["F-1"]["etapes"]] == ["01/02/2026", "20/02/2026"],
            "chaque changement d'étape est daté, dans l'ordre",
        )
        verifier(
            etats["F-1"]["debut"] == "01/02/2026" and etats["F-1"]["cloture"] == "",
            "l'entrée au contentieux est datée, la clôture reste ouverte",
        )
        verifier(
            etats["F-3"]["duree_jours"] is None,
            "sans étape intermédiaire, aucune durée n'est inventée",
        )

        module_suivi.mettre_a_jour(
            donnees, "F-1", statut="tribunal-gagne", date_etape="12/05/2026"
        )
        module_suivi.enregistrer(fichier_suivi, donnees)
        parcours = module_suivi.parcours_dossier(
            module_suivi.charger(fichier_suivi)["F-1"]
        )
        verifier(parcours["duree_jours"] == 100, "durée de procédure calculée")
        verifier(parcours["issue"] == "tribunal-gagne", "issue de la procédure retenue")

        module_suivi.dater_etape(donnees, "F-1", 0, "15/01/2026")
        verifier(
            module_suivi.parcours_dossier(donnees["F-1"])["debut"] == "15/01/2026",
            "une date corrigée après coup change la durée de procédure",
        )
        module_suivi.dater_etape(donnees, "F-1", 0, "")
        verifier(
            len(donnees["F-1"]["historique"]) == 2,
            "une date vidée retire l'étape",
        )
        try:
            module_suivi.dater_etape(donnees, "F-1", 9, "01/01/2026")
            verifier(False, "étape inexistante refusée")
        except ValueError:
            verifier(True, "étape inexistante refusée")
        try:
            module_suivi.mettre_a_jour(donnees, "F-2", statut="avocats", date_etape="32/13/2026")
            verifier(False, "date impossible refusée")
        except ValueError:
            verifier(True, "date impossible refusée")

        print("\n  -- reprise des anciens états --")
        ancien = racine / "ancien.json"
        ancien.write_text(
            '{"F-9": {"statut": "avocat", "frais": 10, '
            '"historique": [{"statut": "gagne", "date": "01/01/2026"}]}}',
            encoding="utf-8",
        )
        repris = module_suivi.charger(ancien)
        verifier(
            repris["F-9"]["statut"] == "avocats",
            "un état de l'ancienne version est repris, non perdu",
        )
        verifier(
            repris["F-9"]["historique"][0]["statut"] == "cloture-recouvrement",
            "les étapes déjà enregistrées sont reprises elles aussi",
        )

        print("\n  -- courbe d'avancement --")
        courbe = module_suivi.courbe_par_mois([
            {"etapes": [
                {"statut": "transmission-en-cours", "date": "10/01/2026"},
                {"statut": "avocats", "date": "05/03/2026"},
            ]},
            {"etapes": [
                {"statut": "transmission-en-cours", "date": "20/02/2026"},
                {"statut": "cloture-recouvrement", "date": "02/03/2026"},
            ]},
            {"etapes": []},
        ])
        par_cle = {s["cle"]: s["valeurs"] for s in courbe["series"]}
        verifier(
            courbe["mois"][:3] == ["01/2026", "02/2026", "03/2026"],
            f"la courbe part du premier mois daté (obtenu : {courbe['mois'][:3]})",
        )
        verifier(
            par_cle["transmission-en-cours"][:3] == [1, 2, 0],
            "un dossier compte à son étape du moment, pas à toutes celles franchies",
        )
        verifier(
            par_cle["avocats"][:3] == [0, 0, 1] and par_cle["gagne"][:3] == [0, 0, 1],
            "en mars, chaque dossier est passé à son étape suivante",
        )
        verifier(
            "cloture-recouvrement" not in par_cle and "tribunal-gagne" not in par_cle,
            "les deux clôtures favorables ne forment qu'une bande, de même couleur",
        )
        fusion = module_suivi.courbe_par_mois([
            {"etapes": [{"statut": "cloture-recouvrement", "date": "10/01/2026"}]},
            {"etapes": [{"statut": "tribunal-gagne", "date": "12/01/2026"}]},
            {"etapes": [{"statut": "transmission-en-cours", "date": "15/02/2026"}]},
        ])
        bande_gagne = next(s for s in fusion["series"] if s["cle"] == "gagne")
        verifier(
            bande_gagne["valeurs"][0] == 2,
            "clôture amiable et clôture judiciaire comptent dans la même bande",
        )
        verifier(
            len({s["couleur"] for s in fusion["series"]}) == len(fusion["series"]),
            "deux bandes voisines n'ont jamais la même couleur",
        )
        verifier(
            "non-transmis" not in par_cle,
            "une étape que personne n'a atteinte ne figure pas dans la courbe",
        )
        verifier(
            module_suivi.courbe_par_mois([{"etapes": []}])["series"] == [],
            "sans aucune étape datée, la courbe reste vide plutôt qu'inventée",
        )

        print("\n  -- ancienneté, souffrance, coût --")
        aujourdhui = datetime.now()
        def il_y_a(jours):
            return (aujourdhui - timedelta(days=jours)).strftime("%d/%m/%Y")

        portefeuille = [
            {"statut": "avocats", "montant_du": 1000.0, "frais": 300.0,
             "anciennete_jours": 400, "jours_sans_mouvement": 95,
             "reference": "A", "nom": "Ancien", "duree_jours": None},
            {"statut": "transmis-contentieux", "montant_du": 500.0, "frais": 0.0,
             "anciennete_jours": 30, "jours_sans_mouvement": 10,
             "reference": "B", "nom": "Récent", "duree_jours": None},
            {"statut": "non-transmis", "montant_du": 800.0, "frais": 0.0,
             "anciennete_jours": 900, "jours_sans_mouvement": None,
             "reference": "C", "nom": "Jamais parti", "duree_jours": None},
            {"statut": "cloture-recouvrement", "montant_du": 2000.0, "frais": 200.0,
             "anciennete_jours": 800, "jours_sans_mouvement": 400,
             "reference": "D", "nom": "Réglé", "duree_jours": 60},
            {"statut": "avocats", "montant_du": 700.0, "frais": 0.0,
             "anciennete_jours": None, "jours_sans_mouvement": 3,
             "reference": "E", "nom": "Sans échéance", "duree_jours": None},
        ]
        agregats = module_suivi.agreger(portefeuille)

        tranches = {t["libelle"]: t for t in agregats["tranches_anciennete"]}
        verifier(
            tranches["1 à 2 ans"]["montant"] == 1000.0,
            "la créance de 400 jours tombe dans la tranche 1 à 2 ans",
        )
        verifier(
            tranches["Plus de 2 ans"]["montant"] == 800.0,
            "un dossier jamais transmis compte quand même dans l'ancienneté",
        )
        verifier(
            all(t["montant"] != 2000.0 for t in agregats["tranches_anciennete"]),
            "un dossier clôturé sort de l'ancienneté : sa créance n'a plus d'âge",
        )
        verifier(
            tranches["Échéance non renseignée"]["montant"] == 700.0,
            "une échéance absente a sa propre ligne, jamais fondue dans une tranche",
        )

        verifier(
            [d["reference"] for d in agregats["dormants"]] == ["A"],
            "seul le dossier transmis et immobile est en souffrance",
        )
        verifier(
            agregats["nb_jamais_transmis"] == 1,
            "les dossiers jamais transmis sont comptés à part",
        )
        verifier(
            agregats["cout_par_euro"] == 0.25,
            f"coût par euro recouvré : 500 € de frais / 2 000 € (obtenu : {agregats['cout_par_euro']})",
        )
        verifier(
            module_suivi.agreger([portefeuille[0]])["cout_par_euro"] is None,
            "sans rien de recouvré, aucun coût par euro n'est inventé",
        )
        verifier(
            module_suivi.tranche_anciennete(None) is None
            and module_suivi.tranche_anciennete(-5) is None,
            "une échéance à venir ou absente n'entre dans aucune tranche",
        )

        print("\n  -- couleurs des états --")
        cles = [s["cle"] for s in module_suivi.STATUTS]
        verifier(len(set(cles)) == 8, f"huit étapes distinctes (obtenu : {len(set(cles))})")
        verifier(
            all(s["icone"] for s in module_suivi.STATUTS
                if s["famille"] in ("gagne", "perdu")),
            "les trois issues portent une icône, la couleur ne suffisant pas "
            "à les distinguer en vision deutan",
        )
        cours = [s["couleur"] for s in module_suivi.STATUTS if s["famille"] == "cours"]
        verifier(
            len(set(cours)) == len(cours) == 5,
            "les cinq étapes en cours ont chacune leur nuance",
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
    test_export_monday_entreprise()
    test_regroupement()
    test_monday()
    test_lecture_xlsx()
    test_nettoyage_html()
    test_synthese()
    test_slug()
    test_rendu_message()
    test_pdf_image_cassee()
    test_export_complet()
    test_factures_citees()
    test_sous_dossiers_par_facture()
    test_sous_dossiers_par_adresse()
    test_decouverte_adresses()
    test_sens_et_faux_positifs()
    test_echeance_facture()
    test_lecture_tableau_monday()
    test_refus_monday()
    test_montants_espace_insecable()
    test_colonnes_typees_monday()
    test_colonnes_miroir_monday()
    test_bloc_pieces()
    test_execution_formation()
    test_suppression_dossiers()
    test_filtre_chez_monday()
    test_groupes_monday()
    test_sous_elements_monday()
    test_historique_etapes()
    test_liste_complete_tableaux()
    test_deux_tableaux()
    test_lanceurs_windows()
    test_mise_a_jour()
    test_export_interrompu()
    test_interface()
    test_suivi()

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
