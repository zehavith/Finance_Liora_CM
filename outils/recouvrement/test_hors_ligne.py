#!/usr/bin/env python3
"""Vérification hors ligne : lecture du fichier de dossiers, construction des
requêtes, décodage d'un message et génération des fichiers de sortie.

Ne touche pas à Gmail et ne demande aucune autorisation. À lancer après une
installation pour vérifier que le poste est correctement équipé :

    python test_hors_ligne.py
"""

from __future__ import annotations

import inspect
import io
import json
import shutil
import subprocess
import sys
import tempfile
import threading
import time
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
    verifier('filename:"FA-2024-0153"' in requete,
             "requête : numéro de facture en pièce jointe, entre guillemets")
    # Sans guillemets, « filename:FA 2024 0153 » se lit chez Gmail comme trois
    # conditions ET : le nom de fichier voulu n'est plus cherché.
    corps_requete = requete[requete.index("(") + 1:requete.rindex(")")]
    verifier(all(terme.endswith('"') for terme in corps_requete.split(" OR ")
                 if terme.startswith("filename:")),
             f"requête : aucun terme filename: laissé sans guillemets "
             f"(fautifs : {[x for x in corps_requete.split(' OR ') if x.startswith('filename:') and not x.endswith(chr(34))]})")
    verifier("after:2023/09/01" in requete, "requête : borne de date convertie pour Gmail")

    # Les deux critères sont réunis par OU, jamais par ET : connaître
    # l'adresse ne doit pas restreindre la recherche aux messages qui portent
    # aussi le numéro. Un dossier qui a une adresse cherche quand même sur sa
    # facture, et inversement — sinon la moitié des échanges reste invisible.
    verifier(" AND " not in requete and " OR " in requete,
             "requête : adresse OU facture, jamais l'une exigeant l'autre")
    debut = requete.index("marie.dupont@exemple.fr")
    verifier(requete.index('"FA-2024-0153"') > debut,
             "requête : les deux critères figurent ensemble dans la même requête")

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
        # Un export comptable écrit les milliers avec un point et les
        # décimales avec une virgule. Lu comme du français, « €8.000,00 »
        # devenait « 8.000.00 » : refusé par Python, donc zéro, sans un mot.
        ("€8.000,00", 8000.0),
        ("€5.930,00", 5930.0),
        ("8.000", 8000.0),
        ("1.234.567,89", 1234567.89),
        # Et l'anglais, où le point porte les décimales.
        ("1938.46", 1938.46),
        ("1,234.50", 1234.5),
        ("0.0", 0.0),
    ]
    for texte, attendu in cas:
        verifier(_montant(texte) == attendu,
                 f"« {texte} » vaut {attendu} (obtenu : {_montant(texte)})")
        verifier(module_suivi._nombre(texte) == attendu,
                 f"au suivi aussi, « {texte} » vaut {attendu}")

    verifier(_montant(7188) == 7188.0 and _montant(5990.0) == 5990.0,
             "un nombre déjà typé traverse la lecture sans dommage")


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


def test_saisie_convention_diplome_echeance() -> None:
    """Ce que le tableau tait, le service le saisit — et cela l'emporte."""
    print("\nSaisie de la convention, du diplôme et de l'échéance")

    import suivi as module_suivi  # noqa: PLC0415

    with tempfile.TemporaryDirectory() as repertoire:
        sortie = Path(repertoire) / "export"
        sortie.mkdir()
        (sortie / "d").mkdir()
        (sortie / "_recapitulatif.csv").write_text(
            "reference;nom;repertoire;montant_du;date_echeance;convention_signee;diplome\n"
            "FACT-1;A;d;1 000 €;;;\n"
            "FACT-2;B;d;500;2024-03-01;oui;non\n",
            encoding="utf-8-sig",
        )
        chemin = Path(repertoire) / "suivi.json"
        donnees: dict[str, dict] = {}

        avant = module_suivi.inventaire(sortie, chemin)
        verifier(avant[0]["convention_signee"] is None
                 and avant[0]["date_echeance"] == "",
                 "sans rien, le dossier est non renseigné")
        # Un récapitulatif déjà produit garde la forme ISO de Monday : elle
        # doit devenir lisible sans qu'on refasse l'export.
        verifier(avant[1]["date_echeance"] == "01/03/2024",
                 f"une échéance du tableau s'affiche en français "
                 f"(obtenu : {avant[1]['date_echeance']})")

        module_suivi.mettre_a_jour(
            donnees, "FACT-1", convention="oui", diplome="non",
            echeance="15/06/2024")
        module_suivi.enregistrer(chemin, donnees)

        apres = module_suivi.inventaire(sortie, chemin)
        verifier(apres[0]["convention_signee"] is True,
                 "la convention saisie est prise en compte")
        verifier(apres[0]["diplome"] is False, "le diplôme saisi aussi")
        verifier(apres[0]["date_echeance"] == "15/06/2024",
                 f"l'échéance saisie aussi (obtenu : {apres[0]['date_echeance']})")
        verifier(apres[0]["anciennete_jours"] is not None
                 and apres[0]["anciennete_jours"] > 0,
                 "le retard se calcule sur l'échéance saisie")
        verifier(apres[0]["convention_saisie"] and apres[0]["echeance_saisie"],
                 "la page peut distinguer une saisie d'une valeur lue")

        # La saisie l'emporte sur ce que l'export a lu.
        module_suivi.mettre_a_jour(donnees, "FACT-2", convention="non")
        module_suivi.enregistrer(chemin, donnees)
        apres = module_suivi.inventaire(sortie, chemin)
        verifier(apres[1]["convention_signee"] is False,
                 "une saisie contraire l'emporte sur le tableau")

        # Vider la saisie rend la main au tableau : ce n'est pas un « non ».
        module_suivi.mettre_a_jour(donnees, "FACT-2", convention="")
        module_suivi.enregistrer(chemin, donnees)
        apres = module_suivi.inventaire(sortie, chemin)
        verifier(apres[1]["convention_signee"] is True,
                 "vidée, la saisie rend la main à ce qu'a lu l'export")
        verifier("convention" not in module_suivi.charger(chemin)["FACT-2"],
                 "et ne laisse pas de valeur vide derrière elle")

        # Le décompte du tableau de bord suit la saisie.
        s = module_suivi.solidite(module_suivi.inventaire(sortie, chemin))
        verifier(s["convention"]["oui"] == 2,
                 f"la solidité compte les saisies (obtenu : {s['convention']})")


def test_completer_depuis_fichier() -> None:
    """Le fichier de suivi complète les dossiers déjà exportés."""
    print("\nComplément depuis un fichier de suivi")

    import suivi as module_suivi  # noqa: PLC0415
    from dossiers import charger_grille  # noqa: PLC0415

    with tempfile.TemporaryDirectory() as repertoire:
        sortie = Path(repertoire) / "export"
        sortie.mkdir()
        (sortie / "d").mkdir()
        (sortie / "_recapitulatif.csv").write_text(
            "reference;nom;repertoire;montant_du;factures;date_echeance\n"
            "FACT-2405-00409;SAS EDEN;d;5 990 €;FACT-2405-00409;\n"
            "SIJO;Sijo;d;23 250 €;FACT-2409-05275 | FACT-2409-05431;\n"
            "FACT-2601-13302;JAADI;d;2 500 €;FACT-2601-13302;\n",
            encoding="utf-8-sig",
        )
        chemin_suivi = Path(repertoire) / "suivi.json"

        # Le fichier de Liora : ses intitulés, tels quels.
        fichier = Path(repertoire) / "suivi_btc.csv"
        fichier.write_text(
            "Numero;convention signé ?;Diplome reçu ?;Nb d'heure Theorique;"
            "Heure de Log;Date d'échéance\n"
            # Écrit sans tirets : le rapprochement ne doit pas s'y perdre.
            "FACT2405 00409;oui;non;60;42;2024-06-15\n"
            # Rattachée par l'une des deux factures du dossier groupé.
            "FACT-2409-05431;non;;120;;01/03/2025\n"
            "FACT-9999-99999;oui;oui;10;10;\n",
            encoding="utf-8-sig",
        )

        resultat = module_suivi.completer_depuis_grille(
            charger_grille(fichier),
            module_suivi.inventaire(sortie, chemin_suivi),
            chemin_suivi,
        )
        verifier(resultat["dossiers"] == 2,
                 f"deux dossiers complétés (obtenu : {resultat['dossiers']})")
        verifier(resultat["sans_correspondance"] == 1,
                 "la ligne sans dossier est comptée, non ignorée en silence")
        verifier(resultat["exemples"] == ["FACT-9999-99999"],
                 f"et nommée : un compte seul ne dit pas si le fichier est le "
                 f"bon (obtenu : {resultat['exemples']})")

        apres = {d["reference"]: d for d in
                 module_suivi.inventaire(sortie, chemin_suivi)}
        eden = apres["FACT-2405-00409"]
        verifier(eden["convention_signee"] is True and eden["diplome"] is False,
                 "convention et diplôme sont repris")
        verifier(eden["heures_theoriques"] == "60" and eden["heures_log"] == "42",
                 "les heures aussi")
        verifier(eden["date_echeance"] == "15/06/2024",
                 f"l'échéance ISO devient lisible (obtenu : {eden['date_echeance']})")
        verifier(eden["anciennete_jours"] and eden["anciennete_jours"] > 0,
                 "et sert au calcul du retard")

        sijo = apres["SIJO"]
        verifier(sijo["convention_signee"] is False,
                 "un dossier groupé se retrouve par l'une de ses factures")
        verifier(sijo["diplome"] is None,
                 "une colonne vide dans le fichier n'écrase rien")

        verifier(apres["FACT-2601-13302"]["convention_signee"] is None,
                 "un dossier absent du fichier reste tel quel")

        # Repasser le même fichier ne doit rien casser ni rien dupliquer.
        deux = module_suivi.completer_depuis_grille(
            charger_grille(fichier),
            module_suivi.inventaire(sortie, chemin_suivi),
            chemin_suivi,
        )
        verifier(deux["dossiers"] == 2, "un second passage est sans effet de bord")

    print("  -- rapprochement par raison sociale et montant --")
    # Une facture émise sous un autre outil ne partage aucun numéro avec celle
    # du tableau. Elle porte le même débiteur et la même somme : c'est par là
    # qu'on la retrouve. Répertoire à part : ce cas réécrit le récapitulatif.
    with tempfile.TemporaryDirectory() as repertoire:
        sortie = Path(repertoire) / "export"
        sortie.mkdir()
        (sortie / "d").mkdir()
        (sortie / "_recapitulatif.csv").write_text(
            "reference;nom;repertoire;montant_du;factures;date_echeance\n"
            "FACT-2405-00409;SAS EDEN;d;5 990 €;FACT-2405-00409;\n"
            "FACT-2601-13302;JAADI PERFORM;d;2 500 €;FACT-2601-13302;\n",
            encoding="utf-8-sig",
        )
        zoho = Path(repertoire) / "zoho.csv"
        zoho.write_text(
            "Numero;Client;Montant\n"
            # Même raison sociale, même montant, numéro d'un autre outil.
            "DV-003453;SAS EDEN;5990\n"
            # Même nom mais montant différent : ce n'est pas la même facture.
            "DV-009999;JAADI PERFORM;99\n",
            encoding="utf-8-sig",
        )
        chemin_zoho = Path(repertoire) / "suivi-zoho.json"
        bilan = module_suivi.completer_depuis_grille(
            charger_grille(zoho),
            module_suivi.inventaire(sortie, chemin_zoho),
            chemin_zoho,
        )
        verifier(bilan["dossiers"] == 1,
                 f"un seul dossier rapproché (obtenu : {bilan['dossiers']})")
        verifier(bilan["sans_correspondance"] == 1,
                 "le montant qui ne colle pas n'est pas rapproché de force")
        etat = module_suivi.charger(chemin_zoho)
        verifier(etat["FACT-2405-00409"]["references"] == ["DV-003453"],
                 f"l'ancien numéro devient une référence de recherche "
                 f"(obtenu : {etat.get('FACT-2405-00409', {}).get('references')})")
        verifier("FACT-2601-13302" not in etat,
                 "le dossier au montant différent reste intact")

        # Un second passage ne doit pas dupliquer la référence trouvée.
        module_suivi.completer_depuis_grille(
            charger_grille(zoho),
            module_suivi.inventaire(sortie, chemin_zoho),
            chemin_zoho,
        )
        verifier(module_suivi.charger(chemin_zoho)["FACT-2405-00409"]
                 ["references"] == ["DV-003453"],
                 "et n'est pas ajoutée deux fois")

    print("  -- factures d'un outil comptable --")
    # Le cas réel : Monday porte le hors taxes, l'export comptable le toutes
    # taxes, et les montants sont écrits à l'européenne. Le fichier porte en
    # plus l'adresse à qui la facture est partie, que Monday n'a pas.
    with tempfile.TemporaryDirectory() as repertoire:
        sortie = Path(repertoire) / "export"
        sortie.mkdir()
        (sortie / "d").mkdir()
        (sortie / "_recapitulatif.csv").write_text(
            "reference;nom;repertoire;montant_du;factures;date_echeance\n"
            "FACT-2405-00409;SAS EDEN;d;5 990 €;FACT-2405-00409;\n"
            "FACT-2501-07706;ISE SYSTEMS;d;8 000 €;FACT-2501-07706;\n"
            "FACT-2601-13302;JAADI PERFORM;d;2 500 €;FACT-2601-13302;\n",
            encoding="utf-8-sig",
        )
        compta = Path(repertoire) / "compta.csv"
        compta.write_text(
            "N° de facture;Nom du client;Statut de la facture;"
            "Montant de la facture;Solde;E-mail\n"
            # 5 990 HT facturés 7 188 TTC : même facture, autre base.
            "DV-003453;SAS EDEN;En retard;€7.188,00;€7.188,00;\n"
            # Même numéro que le dossier : l'adresse le rejoint directement.
            "FACT-2501-07706;ISE SYSTEMS;En retard;€8.000,00;€8.000,00;"
            "sophie.attias@ise-systems.fr\n"
            # Réglée : son nom et son montant ne doivent rapprocher personne.
            "DV-009999;JAADI PERFORM;Payé;€2.500,00;0.0;paye@exemple.fr\n",
            encoding="utf-8-sig",
        )
        chemin = Path(repertoire) / "suivi.json"
        bilan = module_suivi.completer_depuis_grille(
            charger_grille(compta),
            module_suivi.inventaire(sortie, chemin),
            chemin,
        )
        etat = module_suivi.charger(chemin)

        verifier(etat.get("FACT-2405-00409", {}).get("references") == ["DV-003453"],
                 f"la facture TTC rejoint le dossier HT à la TVA près "
                 f"(obtenu : {etat.get('FACT-2405-00409', {}).get('references')})")
        verifier(etat.get("FACT-2501-07706", {}).get("adresses")
                 == ["sophie.attias@ise-systems.fr"],
                 f"l'adresse du client est reprise pour la recherche "
                 f"(obtenu : {etat.get('FACT-2501-07706', {}).get('adresses')})")
        verifier(bilan["adresses"] == 1,
                 f"et comptée dans le bilan (obtenu : {bilan['adresses']})")
        verifier("FACT-2601-13302" not in etat,
                 "une facture soldée ne se rapproche pas sur le nom et le montant")

    print("  -- l'adresse reprise sert la recherche --")
    with tempfile.TemporaryDirectory() as repertoire:
        from dossiers import Dossier  # noqa: PLC0415
        from export_mails import _ajouter_references_saisies  # noqa: PLC0415

        chemin = Path(repertoire) / "suivi.json"
        module_suivi.enregistrer(chemin, {"FACT-2501-07706": {
            "adresses": ["sophie.attias@ise-systems.fr"],
            "references": ["DV-003453"],
        }})
        lot = [Dossier(reference="FACT-2501-07706", nom="ISE SYSTEMS",
                       emails=["compta@ise-systems.fr"], factures=["FACT-2501-07706"])]
        dit: list[str] = []
        _ajouter_references_saisies(lot, dit.append, chemin)
        verifier(lot[0].emails == ["compta@ise-systems.fr",
                                   "sophie.attias@ise-systems.fr"],
                 f"l'adresse du fichier s'ajoute à celle du tableau "
                 f"(obtenu : {lot[0].emails})")
        verifier(lot[0].factures == ["FACT-2501-07706", "DV-003453"],
                 "et l'ancien numéro à la liste des factures cherchées")
        verifier(any("adresse" in ligne for ligne in dit),
                 f"le journal le dit (obtenu : {dit})")

        # Repasser ne doit pas empiler la même adresse.
        _ajouter_references_saisies(lot, dit.append, chemin)
        verifier(lot[0].emails.count("sophie.attias@ise-systems.fr") == 1,
                 "sans doublon au second passage")

        # Ce qui est saisi dans l'application doit atteindre la note. Sans
        # cette reprise, cocher « convention signée » ou écrire le contexte
        # ne changeait rien au document produit — la saisie ne servait à rien.
        module_suivi.enregistrer(chemin, {"FACT-2501-07706": {
            "convention": "oui", "diplome": "non", "echeance": "15/03/2024",
            "contexte": "Il ne répond pas au téléphone",
        }})
        lot2 = [Dossier(reference="FACT-2501-07706", nom="ISE SYSTEMS",
                        factures=["FACT-2501-07706"], convention_signee="",
                        date_echeance="01/01/2020")]
        dit2: list[str] = []
        _ajouter_references_saisies(lot2, dit2.append, chemin)
        verifier(lot2[0].convention_signee == "oui",
                 f"la convention saisie atteint le dossier "
                 f"(obtenu : {lot2[0].convention_signee!r})")
        verifier(lot2[0].diplome == "non", "le diplôme saisi aussi")
        verifier(lot2[0].date_echeance == "15/03/2024",
                 f"l'échéance saisie l'emporte sur celle du tableau "
                 f"(obtenu : {lot2[0].date_echeance})")
        verifier(lot2[0].contexte == "Il ne répond pas au téléphone",
                 f"et le contexte écrit à la main (obtenu : {lot2[0].contexte!r})")
        verifier(any("saisie" in ligne for ligne in dit2),
                 f"le journal le dit (obtenu : {dit2})")

    print("  -- un classeur comptable réel --")
    # Trois pièges relevés sur le fichier de Liora, chacun capable d'emporter
    # un onglet entier de quinze mille lignes.
    with tempfile.TemporaryDirectory() as repertoire:
        sortie = Path(repertoire) / "export"
        sortie.mkdir()
        (sortie / "d").mkdir()
        (sortie / "_recapitulatif.csv").write_text(
            "reference;nom;repertoire;montant_du;factures;date_echeance\n"
            "FACT-2405-00409;SAS EDEN;d;5 990 €;FACT-2405-00409;\n"
            # Un gros client, plusieurs factures du même montant.
            "FACT-2406-03966;Caisse des Depots;d;1 000 €;FACT-2406-03966;\n",
            encoding="utf-8-sig",
        )
        # En-tête abîmé par un aller-retour d'encodage, comme dans le fichier.
        fichier = Path(repertoire) / "compta.csv"
        fichier.write_text(
            "NumÃ©ro;Client;Statut;Montant dÃ» TTC;Email client;Date dâ€™Ã©chÃ©ance\n"
            # Une cellule de date cassée par le tableur : cette ligne perd son
            # échéance, les suivantes doivent survivre.
            "FACT-2405-00409;SAS EDEN;Retard;5990;eden@exemple.fr;#VALUE!\n"
            # Deux lignes revendiquent le même dossier sur le seul couple
            # nom + montant : aucune ne l'identifie.
            "DV-100001;Caisse des Depots;Retard;1000;;01/03/2025\n"
            "DV-100002;Caisse des Depots;Retard;1000;;01/03/2025\n",
            encoding="utf-8-sig",
        )
        chemin = Path(repertoire) / "suivi.json"
        bilan = module_suivi.completer_depuis_grille(
            charger_grille(fichier),
            module_suivi.inventaire(sortie, chemin),
            chemin,
        )
        etat = module_suivi.charger(chemin)

        verifier(etat.get("FACT-2405-00409", {}).get("adresses")
                 == ["eden@exemple.fr"],
                 f"un en-tête abîmé par l'encodage reste reconnu "
                 f"(obtenu : {etat.get('FACT-2405-00409', {}).get('adresses')})")
        verifier(not etat.get("FACT-2405-00409", {}).get("echeance"),
                 "la date illisible est écartée, pas devinée")
        verifier(bilan["dates_illisibles"] == 1,
                 f"et comptée (obtenu : {bilan['dates_illisibles']})")
        verifier("FACT-2406-03966" not in etat,
                 f"deux lignes qui revendiquent le même dossier n'en "
                 f"rapprochent aucune (obtenu : {sorted(etat)})")
        verifier(bilan["ambigus"] == ["FACT-2406-03966"],
                 f"le dossier disputé est nommé (obtenu : {bilan['ambigus']})")

    print("  -- un export de factures Zoho --")
    # Le cas d'usage réel : le fichier porte côte à côte le numéro Sellsy, qui
    # identifie le dossier, et le numéro Zoho, qui est le seul à figurer dans
    # les échanges de l'époque. Retenir le premier sans le second laisserait
    # justement de côté celui qu'on cherche.
    with tempfile.TemporaryDirectory() as repertoire:
        sortie = Path(repertoire) / "export"
        sortie.mkdir()
        (sortie / "d").mkdir()
        (sortie / "_recapitulatif.csv").write_text(
            "reference;nom;repertoire;montant_du;factures;date_echeance\n"
            "FACT-2406-03723;Serruya Aaron;d;5 100 €;FACT-2406-03723;\n",
            encoding="utf-8-sig",
        )
        zoho = Path(repertoire) / "zoho.csv"
        zoho.write_text(
            "N° de facture;Nom du client;Statut de la facture;"
            "Montant de la facture;Solde;Date d’échéance;E-mail;"
            "Facture sellsy correspondante\n"
            "FA-550-3689-2;Serruya Aaron;En retard;€5.100,00;€5.100,00;"
            "2024-05-21;aaronserruya3105@gmail.com;FACT-2406-03723\n",
            encoding="utf-8-sig",
        )
        chemin = Path(repertoire) / "suivi.json"
        bilan = module_suivi.completer_depuis_grille(
            charger_grille(zoho),
            module_suivi.inventaire(sortie, chemin),
            chemin,
        )
        entree = module_suivi.charger(chemin).get("FACT-2406-03723", {})

        verifier(entree.get("references") == ["FA-550-3689-2"],
                 f"le numéro Zoho est retenu bien que le rapprochement se soit "
                 f"fait sur le numéro Sellsy (obtenu : {entree.get('references')})")
        verifier(entree.get("adresses") == ["aaronserruya3105@gmail.com"],
                 f"l'adresse suit (obtenu : {entree.get('adresses')})")
        verifier(entree.get("echeance") == "21/05/2024",
                 f"l'échéance aussi (obtenu : {entree.get('echeance')})")
        verifier(bilan["dossiers"] == 1 and bilan["adresses"] == 1,
                 "et le bilan les compte")

        # Le numéro qui identifie déjà le dossier ne se réécrit pas en
        # référence de recherche : il y est déjà.
        verifier("FACT-2406-03723" not in (entree.get("references") or []),
                 "sans réécrire le numéro que le dossier porte déjà")

    print("  -- garde-fou sur le nombre de références --")
    with tempfile.TemporaryDirectory() as repertoire:
        sortie = Path(repertoire) / "export"
        sortie.mkdir()
        (sortie / "d").mkdir()
        (sortie / "_recapitulatif.csv").write_text(
            "reference;nom;repertoire;montant_du;factures;date_echeance\n"
            "FACT-2405-00409;SAS EDEN;d;5 990 €;FACT-2405-00409;\n",
            encoding="utf-8-sig",
        )
        # Vingt lignes qui désignent toutes le même dossier par son numéro :
        # chacune apporte le sien, et la requête Gmail exploserait.
        lignes_csv = ["N° de facture;Facture sellsy correspondante"]
        lignes_csv += [f"DV-{9000 + i};FACT-2405-00409" for i in range(20)]
        gros = Path(repertoire) / "gros.csv"
        gros.write_text("\n".join(lignes_csv) + "\n", encoding="utf-8-sig")

        chemin = Path(repertoire) / "suivi.json"
        bilan = module_suivi.completer_depuis_grille(
            charger_grille(gros),
            module_suivi.inventaire(sortie, chemin),
            chemin,
        )
        gardees = module_suivi.charger(chemin)["FACT-2405-00409"]["references"]
        verifier(len(gardees) == module_suivi.MAXIMUM_REFERENCES,
                 f"le nombre de références est plafonné "
                 f"(obtenu : {len(gardees)})")
        verifier(bilan["debordements"] == ["FACT-2405-00409"],
                 f"et le dossier concerné est nommé "
                 f"(obtenu : {bilan['debordements']})")

    print("  -- une facture écrite deux fois dans le fichier --")
    with tempfile.TemporaryDirectory() as repertoire:
        # Une même facture figure sur deux lignes du tableau, qui se
        # contredisent : la seconde est la plus récente et fait foi.
        sortie = Path(repertoire) / "sortie"
        (sortie / "d").mkdir(parents=True)
        (sortie / "_recapitulatif.csv").write_text(
            "reference;nom;repertoire;montant_du;factures;date_echeance\n"
            "FACT-2410-06038;Thomas De Oliveira;d;4 660 €;FACT-2410-06038;\n",
            encoding="utf-8-sig",
        )
        double = Path(repertoire) / "double.csv"
        double.write_text(
            "Numero;Passage en contentieux;Email client sur sellsy;"
            "Date d'échéance;convention signé ?\n"
            "FACT-2410-06038;Mise en demeure transmise;"
            "thomas.deo@icloud.com;2024-10-15;\n"
            "FACT-2410-06038;à transmettre au service contentieux;;;oui\n",
            encoding="utf-8-sig",
        )

        chemin = Path(repertoire) / "suivi.json"
        module_suivi.completer_depuis_grille(
            charger_grille(double),
            module_suivi.inventaire(sortie, chemin),
            chemin,
        )
        entree = module_suivi.charger(chemin)["FACT-2410-06038"]
        verifier(entree["statut"] == "non-transmis",
                 f"sur une contradiction, la dernière ligne fait foi "
                 f"(obtenu : {entree['statut']!r})")
        verifier(entree.get("convention") == "oui",
                 "ce qu'elle ajoute est repris")
        # Une case vide n'est pas une contradiction, c'est une absence : la
        # dernière ligne n'efface pas ce que la première a renseigné, sans
        # quoi une ligne courte ferait perdre l'adresse et l'échéance.
        verifier(entree.get("echeance") == "15/10/2024",
                 f"une case vide n'efface pas l'échéance déjà reprise "
                 f"(obtenu : {entree.get('echeance')!r})")
        verifier(entree.get("adresses") == ["thomas.deo@icloud.com"],
                 f"ni l'adresse (obtenu : {entree.get('adresses')!r})")

    print("  -- intitulés à l'apostrophe typographique --")
    from dossiers import _normaliser_entete  # noqa: PLC0415

    # Une apostrophe courbe supprimée sans être remplacée collait les mots :
    # « Date d’échéance » devenait « date dechance », que rien ne reconnaît.
    for intitule in ("Date d'échéance", "Date d’échéance", "Date d‘échéance"):
        obtenu = _normaliser_entete(intitule)
        verifier(obtenu == "date d echeance",
                 f"« {intitule} » se normalise en « date d echeance » "
                 f"(obtenu : « {obtenu} »)")
    verifier(_normaliser_entete("NumÃ©ro") == "numero",
             "et un intitulé abîmé par l'encodage retrouve ses accents")


def test_recapitulatif_atomique() -> None:
    """Le récapitulatif ne doit jamais être lu à moitié écrit."""
    print("\nÉcriture atomique du récapitulatif")

    import indexation as module_indexation  # noqa: PLC0415

    with tempfile.TemporaryDirectory() as repertoire:
        chemin = Path(repertoire) / "_recapitulatif.csv"

        def resume(rang):
            return module_indexation.ResumeDossier(
                reference=f"FACT-{rang}", nom=f"Debiteur {rang}",
                emails="a@b.fr", factures=f"FACT-{rang}", requete="q",
                repertoire=f"d{rang}",
            )

        module_indexation.ecrire_recapitulatif(chemin, [resume(i) for i in range(40)])
        lues = chemin.read_text(encoding="utf-8-sig").strip().split("\n")
        verifier(len(lues) == 41, f"quarante lignes plus l'en-tête (obtenu : {len(lues)})")

        # Aucun fichier provisoire ne doit survivre à l'écriture.
        restes = [f.name for f in Path(repertoire).iterdir() if "en-cours" in f.name]
        verifier(not restes, f"aucun fichier provisoire ne reste ({restes})")

        # Une passe plus courte ne fait pas disparaître les autres dossiers.
        # Le fichier était remplacé par les seuls dossiers de la passe : une
        # recherche ponctuelle effaçait de la liste les cinquante-deux autres,
        # qui restaient pourtant sur le disque avec leurs pièces versées.
        module_indexation.ecrire_recapitulatif(chemin, [resume(i) for i in range(3)])
        lues = chemin.read_text(encoding="utf-8-sig").strip().split("\n")
        verifier(len(lues) == 41,
                 f"une passe d'un dossier n'efface pas les autres "
                 f"(obtenu : {len(lues)} lignes)")

        # Un dossier retraité remplace sa rangée : la passe en cours dit la
        # vérité sur lui, et il ne doit pas figurer deux fois.
        module_indexation.ecrire_recapitulatif(chemin, [
            module_indexation.ResumeDossier(
                reference="FACT-2", nom="Debiteur corrige", emails="a@b.fr",
                factures="FACT-2", requete="q", repertoire="d2", nb_mails=9),
        ])
        rangees = module_indexation.lire_recapitulatif(chemin)
        verifier(len(rangees) == 40,
                 f"sans doublon (obtenu : {len(rangees)} dossiers)")
        corrige = [r for r in rangees if r["reference"] == "FACT-2"]
        verifier(len(corrige) == 1 and corrige[0]["nom"] == "Debiteur corrige",
                 f"et c'est la rangée fraîche qui reste ({corrige})")

        # Vider la liste reste possible : c'est « Tout effacer » qui le fait,
        # en retirant le fichier, non un export plus court.
        chemin.unlink()
        module_indexation.ecrire_recapitulatif(chemin, [resume(0)])
        verifier(len(module_indexation.lire_recapitulatif(chemin)) == 1,
                 "un récapitulatif retiré repart d'une liste vide")


def test_colonnes_vides_signalees() -> None:
    """Reconnue mais vide sur toutes les lignes : le journal le dit."""
    print("\nColonnes reconnues mais vides")

    import export_mails  # noqa: PLC0415
    from dossiers import dossiers_depuis_grille  # noqa: PLC0415

    # Le cas des colonnes miroir : les intitulés sont là, les valeurs non.
    grille = [
        (1, ["N° Facture", "Entreprise", "Email", "Reste à devoir TTC"]),
        (2, ["FACT-1", "", "", ""]),
        (3, ["FACT-2", "", "", ""]),
    ]
    dits: list[str] = []
    export_mails._signaler_colonnes_vides(
        dossiers_depuis_grille(grille, "tableau Monday 42"), dits.append)
    verifier(any("vide(s) sur les 2 lignes" in ligne for ligne in dits),
             "les colonnes muettes sont signalées d'emblée")
    for attendu in ("nom du debiteur", "adresse mail", "montant du"):
        verifier(any(attendu in ligne for ligne in dits),
                 f"« {attendu} » est nommée")

    # Une seule ligne renseignée suffit : la colonne n'est pas muette, elle
    # est incomplète, et c'est une autre affaire.
    grille[1] = (2, ["FACT-1", "Sijo", "a@b.fr", "2 500 €"])
    dits.clear()
    export_mails._signaler_colonnes_vides(
        dossiers_depuis_grille(grille, "tableau Monday 42"), dits.append)
    verifier(not dits, "une colonne partiellement remplie n'est pas signalée")

    dits.clear()
    export_mails._signaler_colonnes_vides([], dits.append)
    verifier(not dits, "un tableau sans ligne ne dit rien")


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


def test_pieces_versees() -> None:
    """Pièces versées à la main, et messages téléchargés ajoutés au dossier."""
    print("\nPièces versées dans un dossier")

    import export_mails  # noqa: PLC0415
    import suivi as module_suivi  # noqa: PLC0415
    import synthese as module_synthese  # noqa: PLC0415
    from dossiers import Dossier  # noqa: PLC0415

    donnees: dict[str, dict] = {}
    module_suivi.ajouter_piece(donnees, "FACT-1", "Relevé comptable", "grand-livre.pdf")
    module_suivi.ajouter_piece(donnees, "FACT-1", "Facture", "FACT-1.pdf")
    verifier(len(donnees["FACT-1"]["pieces"]) == 2, "deux pièces inscrites")

    # Reverser le même fichier remplace la ligne : c'est ce que fait le
    # disque, la liste doit dire la même chose.
    module_suivi.ajouter_piece(donnees, "FACT-1", "Convention de formation",
                               "grand-livre.pdf")
    pieces = donnees["FACT-1"]["pieces"]
    verifier(len(pieces) == 2, f"un même fichier n'est pas doublé ({len(pieces)})")
    verifier(pieces[-1]["nature"] == "Convention de formation",
             "et sa nature est celle du dernier dépôt")

    try:
        module_suivi.ajouter_piece(donnees, "FACT-1", "Bordereau", "x.pdf")
        verifier(False, "une nature inconnue est refusée")
    except ValueError:
        verifier(True, "une nature inconnue est refusée")

    module_suivi.retirer_piece(donnees, "FACT-1", "FACT-1.pdf")
    verifier([p["fichier"] for p in donnees["FACT-1"]["pieces"]] == ["grand-livre.pdf"],
             "une pièce retirée disparaît de la liste")

    print("  -- une pièce versée répond pour sa colonne --")
    # Verser la convention signée répond à « la convention est-elle signée ? » :
    # la pièce est là. Redemander serait faire répondre deux fois.
    repondu: dict[str, dict] = {}
    module_suivi.ajouter_piece(repondu, "FACT-2", "Convention de formation", "c.pdf")
    verifier(repondu["FACT-2"].get("convention") == "oui",
             "verser la convention renseigne la colonne Convention")
    module_suivi.ajouter_piece(repondu, "FACT-2", "Diplôme", "d.pdf")
    verifier(repondu["FACT-2"].get("diplome") == "oui",
             "verser le diplôme renseigne la colonne Diplôme")
    module_suivi.ajouter_piece(repondu, "FACT-2", "Relevé comptable", "r.pdf")
    verifier(repondu["FACT-2"].get("convention") == "oui",
             "une pièce d'une autre nature ne touche à rien")

    # Retirée, la pièce reprend sa réponse — sauf si une autre la porte.
    module_suivi.ajouter_piece(repondu, "FACT-2", "Convention de formation", "c2.pdf")
    module_suivi.retirer_piece(repondu, "FACT-2", "c.pdf")
    verifier(repondu["FACT-2"].get("convention") == "oui",
             "une seconde convention au dossier maintient la réponse")
    module_suivi.retirer_piece(repondu, "FACT-2", "c2.pdf")
    verifier("convention" not in repondu["FACT-2"],
             "la dernière retirée, la convention n'est plus établie")
    verifier(repondu["FACT-2"].get("diplome") == "oui",
             "et le diplôme n'est pas emporté au passage")

    # La note les reprend, dans une rubrique qui dit ce qu'elles valent.
    html = module_synthese.construire_html(
        dossier=Dossier(reference="FACT-1", nom="A", emails=["a@b.fr"],
                        factures=["FACT-1"]),
        boites=["billing@liora.io"], lignes=[],
        synthese=module_synthese.analyser([], {}),
        date_export=datetime(2026, 3, 1, tzinfo=timezone(timedelta(hours=1))),
        pieces_ajoutees=[{"nature": "Relevé comptable", "fichier": "grand-livre.pdf"}],
    )
    verifier("grand-livre.pdf" in html and "Relevé comptable" in html,
             "la pièce versée figure dans la note")
    verifier("versées au dossier par le service" not in html,
             "la note ne commente pas la provenance de la pièce")

    # Un message téléchargé rejoint les échanges, avec son numéro de pièce.
    with tempfile.TemporaryDirectory() as repertoire:
        rep = Path(repertoire) / "dossier"
        rep.mkdir()
        brut = (
            "From: debiteur@exemple.fr\r\n"
            "To: recouvrement@liora.io\r\n"
            "Subject: Re: votre facture\r\n"
            "Date: Wed, 12 Mar 2025 10:22:00 +0100\r\n"
            "Message-ID: <depose@exemple.fr>\r\n"
            "Content-Type: text/plain; charset=utf-8\r\n\r\n"
            "Je conteste le montant reclame.\r\n"
        ).encode("utf-8")

        ligne = export_mails.verser_message(
            rep, brut,
            Dossier(reference="FACT-1", nom="A", emails=["debiteur@exemple.fr"],
                    factures=["FACT-1"]),
            {"liora.io"},
        )
        verifier(ligne.piece_n == 1, "le premier message déposé prend le n° 1")
        verifier(ligne.sens == "reçu",
                 f"son sens est déduit des domaines maison (obtenu : {ligne.sens})")
        verifier((rep / "index.csv").exists(), "l'index du dossier est écrit")
        verifier(any((rep / "mails").glob("*.eml")), "le .eml est conservé")

        # Un second message prend le numéro suivant, même antérieur en date.
        ancien = brut.replace(b"12 Mar 2025", b"02 Jan 2025").replace(
            b"<depose@exemple.fr>", b"<ancien@exemple.fr>")
        deux = export_mails.verser_message(
            rep, ancien,
            Dossier(reference="FACT-1", nom="A", emails=["debiteur@exemple.fr"],
                    factures=["FACT-1"]),
            {"liora.io"},
        )
        verifier(deux.piece_n == 2,
                 "un numéro déjà attribué ne change jamais de sens")

        # Le même message deux fois : refusé, plutôt que compté deux fois.
        try:
            export_mails.verser_message(
                rep, brut,
                Dossier(reference="FACT-1", nom="A", emails=["debiteur@exemple.fr"],
                        factures=["FACT-1"]),
                {"liora.io"},
            )
            verifier(False, "un message déjà présent est refusé")
        except ErreurDossiers as exc:
            verifier("figure déjà" in str(exc), "un message déjà présent est refusé")

        lignes, textes, _b, _c = export_mails.relire_dossier(rep, rep / "index.csv")
        verifier(len(lignes) == 2, "les deux messages sont relus depuis l'index")
        verifier(any("conteste" in texte for texte in textes.values()),
                 "et leur texte est relu depuis le .eml")


def test_ancienne_reference_facture() -> None:
    """Une facture emise sous un autre outil garde son numero d'alors."""
    print("\nAncien numéro de facture")

    from dossiers import dossiers_depuis_grille  # noqa: PLC0415

    grille = [
        (1, ["N° Facture", "Numero Zoho", "E-mail"]),
        (2, ["FACT-2405-00409", "INV-2023-0088", "a@b.fr"]),
    ]
    dossier = dossiers_depuis_grille(grille, "tableau Monday 42")[0]
    verifier(dossier.factures == ["FACT-2405-00409", "INV-2023-0088"],
             f"les deux numéros sont retenus (obtenu : {dossier.factures})")

    requete = dossier.requete_gmail()
    verifier('"INV-2023-0088"' in requete,
             "l'ancien numéro est cherché comme le nouveau")
    verifier('"FACT-2405-00409"' in requete, "et le nouveau ne disparaît pas")


def test_annuaire_entreprises() -> None:
    """Fiches publiques des débiteurs, et répartition par forme juridique."""
    print("\nAnnuaire des entreprises")

    import entreprises as module_entreprises  # noqa: PLC0415

    for code, attendu in [("5710", "SAS"), ("5720", "SASU"), ("5499", "SARL"),
                          ("5410", "SARL"), ("5599", "SA"), ("6540", "SCI"),
                          ("1000", "Entrepreneur individuel"),
                          ("9220", "Association"), ("", "")]:
        obtenu = module_entreprises.forme_lisible(code)
        verifier(obtenu == attendu, f"{code or '(vide)'} → {attendu} (obtenu : {obtenu})")
    verifier(module_entreprises.forme_lisible("8888").startswith("Forme"),
             "un code inconnu est rendu tel quel, non deviné")

    # L'annuaire répond toujours quelque chose : une réponse sans rapport
    # avec le débiteur ne doit pas devenir sa fiche.
    reponses = {}

    def faux_appel(nom):
        return reponses.get(nom, {"results": []})

    vrai = module_entreprises._appeler
    module_entreprises._appeler = faux_appel
    try:
        reponses["SAS EDEN"] = {"results": [{
            "siren": "123456789", "nom_complet": "SAS EDEN",
            "nature_juridique": "5710", "etat_administratif": "A",
            "date_creation": "2015-04-02", "tranche_effectif_salarie": "11",
            "siege": {"libelle_commune": "PARIS"},
        }]}
        fiche = module_entreprises.chercher("SAS EDEN")
        verifier(fiche["forme"] == "SAS" and fiche["etat"] == "en activité",
                 "la fiche est lue et traduite")
        verifier(fiche["fiche"].endswith("123456789"),
                 "la fiche publique est citée en lien, pour vérification")
        verifier(fiche["a_verifier"] is False,
                 "un nom portant une mention commerciale est tenu pour sûr")

        reponses["JAADI PERFORM"] = {"results": [{
            "siren": "987654321", "nom_complet": "JAADI PERFORM",
            "nature_juridique": "5499", "etat_administratif": "C",
            "date_creation": "2023-01-10", "tranche_effectif_salarie": "NN",
        }]}
        cessee = module_entreprises.chercher("JAADI PERFORM")
        verifier(cessee["etat"] == "cessée" and cessee["forme"] == "SARL",
                 "une société cessée est reconnue comme telle")
        verifier(cessee["a_verifier"] is True,
                 "sans mention commerciale, la correspondance est à vérifier")

        # Réponse sans rapport : rien vaut mieux qu'une fiche fausse.
        reponses["MCAPI"] = {"results": [{
            "siren": "111", "nom_complet": "BOULANGERIE DU CENTRE",
            "nature_juridique": "5499", "etat_administratif": "A",
        }]}
        verifier(module_entreprises.chercher("MCAPI") is None,
                 "une réponse sans rapport n'est pas retenue")
        verifier(module_entreprises.chercher("XX") is None,
                 "un nom trop court n'est pas même interrogé")
    finally:
        module_entreprises._appeler = vrai

    # Le score se relit ligne à ligne : chaque point compté est nommé.
    risque = module_entreprises.evaluer(
        {"anciennete_jours": 900, "montant_du": 23250.0}, cessee)
    verifier(risque["score"] >= 60, f"une société cessée pèse lourd ({risque['score']})")
    verifier(any("cessée" in m for m in risque["motifs"])
             and any("900 jours" in m for m in risque["motifs"]),
             f"et les motifs sont nommés ({risque['motifs']})")
    verifier(module_entreprises.evaluer({"anciennete_jours": 10,
                                         "montant_du": 500.0}, fiche)["score"] == 0,
             "un dossier récent sur une société active ne pèse rien")
    verifier(module_entreprises.evaluer({}, None)["score"] > 0,
             "l'absence de fiche compte, sans être décisive")

    dossiers = [
        {"reference": "A", "nom": "SAS EDEN", "montant_du": 5990.0, "clos": False},
        {"reference": "B", "nom": "JAADI", "montant_du": 2500.0, "clos": False},
        {"reference": "C", "nom": "MCAPI", "montant_du": 3730.0, "clos": False},
        {"reference": "D", "nom": "X", "montant_du": 9999.0, "clos": True},
    ]
    annuaire = {"A": fiche, "B": cessee, "C": None}
    r = module_entreprises.repartition(dossiers, annuaire)
    verifier(r["nb_debiteurs"] == 3, "les dossiers clôturés sortent du décompte")
    verifier(r["sans_fiche"] == 1, "les débiteurs sans fiche sont comptés")
    verifier([f["forme"] for f in r["formes"]][0] == "SAS",
             "les formes sont classées par montant en jeu")
    verifier(len(r["cessees"]) == 1 and r["montant_cesse"] == 2500.0,
             "les sociétés cessées sont listées, avec le montant en jeu")


def test_note_perimee_retiree() -> None:
    """Un PDF qui n'a pas pu être réécrit ne doit pas passer pour à jour."""
    print("\nNote de synthèse périmée")

    from rendu import ecrire_pdf  # noqa: PLC0415
    import suivi as module_suivi  # noqa: PLC0415

    with tempfile.TemporaryDirectory() as repertoire:
        racine = Path(repertoire)
        pdf = racine / "synthese.pdf"
        pdf.write_bytes(b"%PDF ancienne version")

        # Sans moteur PDF, la note est écrite en HTML. Laisser le PDF
        # précédent est le pire des cas : l'application y renvoie, il porte
        # l'ancienne version, et l'on croit que la pièce déposée n'a pas été
        # prise en compte alors qu'elle figure dans la page fraîche.
        reussi, motif = ecrire_pdf("<html><body>note à jour</body></html>", pdf)
        verifier(not reussi, "sans moteur PDF, l'écriture du PDF échoue")
        verifier(not pdf.exists(),
                 "et le PDF périmé est retiré plutôt que laissé en place")
        verifier((racine / "synthese.html").read_text(encoding="utf-8")
                 == "<html><body>note à jour</body></html>",
                 "la note à jour est dans la page HTML")
        verifier("HTML" in motif and "moteur" in motif,
                 f"le motif dit ce qui s'est passé (obtenu : {motif!r})")

    # L'application ouvre la note qui existe réellement.
    with tempfile.TemporaryDirectory() as repertoire:
        racine = Path(repertoire)
        sortie = racine / "export"
        (sortie / "dos").mkdir(parents=True)
        (sortie / "_recapitulatif.csv").write_text(
            "reference;nom;repertoire\nA;Débiteur;dos\n", encoding="utf-8-sig")

        inventaire = module_suivi.inventaire(sortie, racine / "suivi.json")
        verifier(not inventaire[0]["a_synthese"],
                 "sans note, rien n'est proposé")

        (sortie / "dos" / "synthese.html").write_text("x", encoding="utf-8")
        inventaire = module_suivi.inventaire(sortie, racine / "suivi.json")
        verifier(inventaire[0]["a_synthese"]
                 and inventaire[0]["fichier_synthese"] == "synthese.html",
                 f"la page HTML est proposée quand elle est seule "
                 f"(obtenu : {inventaire[0].get('fichier_synthese')})")

        (sortie / "dos" / "synthese.pdf").write_bytes(b"%PDF")
        inventaire = module_suivi.inventaire(sortie, racine / "suivi.json")
        verifier(inventaire[0]["fichier_synthese"] == "synthese.pdf",
                 "et le PDF reprend la main dès qu'il existe")

    import interface as module_interface  # noqa: PLC0415

    verifier("fichier_synthese" in module_interface.PAGE,
             "la page ouvre le fichier que le dossier porte vraiment")


def test_messages_autre_facture() -> None:
    """Un message du même débiteur sur une autre facture est mis à part."""
    print("\nMessages concernant une autre facture")

    import synthese as module_synthese  # noqa: PLC0415
    from dossiers import Dossier  # noqa: PLC0415
    from indexation import LigneIndex  # noqa: PLC0415

    dossier = Dossier(reference="FACT-2405-00409", nom="SAS EDEN",
                      emails=["compta@eden.fr"], factures=["FACT-2405-00409"],
                      montant_du="5 990 €")

    # Chercher par adresse ramène tout ce qui vient du débiteur.
    cas = [
        ("Votre facture FACT-2405-00409 reste impayee.", [], "la nôtre"),
        ("Concernant la facture FACT-2409-05275, pouvez-vous regulariser ?",
         ["fact-2409-05275"], "une autre"),
        ("Les factures FACT-2405-00409 et FACT-2409-05275 sont dues.",
         [], "les deux : le dossier est concerné"),
        ("Bonjour, je vous confirme la reception.", [], "aucune : générique"),
        ("Le 19/12/2024 a 13h00 — montant 5 990,00 EUR, tel 07.55.52.08.49",
         [], "ni date ni téléphone ne passent pour une facture"),
    ]
    for texte, attendu, quoi in cas:
        obtenu = dossier.concerne_une_autre_facture(texte)
        verifier(obtenu == attendu,
                 f"{quoi} → {attendu or 'gardé'} (obtenu : {obtenu})")

    def piece(numero, critere, sens="reçu"):
        return LigneIndex(
            piece_n=numero, date=datetime(2024, 5, numero, tzinfo=timezone.utc),
            sens=sens, expediteur="compta@eden.fr", destinataires="r@liora.io",
            copie="", objet=f"Message {numero}", nb_pieces_jointes=0,
            pieces_jointes="", critere=critere, boites="b", fichier_pdf="",
            fichier_eml="", dossier_pieces_jointes="", thread_id=f"t{numero}",
            message_id=f"<{numero}>")

    lignes = [
        piece(1, "adresse+facture", "envoyé"),
        piece(2, "adresse"),
        piece(3, "autre facture : FACT-2409-05275"),
    ]
    synthese = module_synthese.analyser(lignes, {})
    verifier(synthese.nb_pieces == 2,
             f"le message d'une autre facture ne compte pas parmi les pièces "
             f"(obtenu : {synthese.nb_pieces})")
    verifier(len(synthese.autres_factures) == 1,
             "mais il est retenu à part, non perdu")

    note = module_synthese.construire_html(
        dossier, ["r@liora.io"], lignes, synthese,
        datetime(2026, 9, 7, tzinfo=timezone.utc), textes={})
    verifier("Messages écartés — autres factures du même débiteur" in note,
             "la note les liste sous leur propre titre")
    verifier("FACT-2409-05275" in note,
             "en nommant la facture qui les rattache ailleurs")
    verifier("ne comptent pas parmi les pièces qui établissent cette créance"
             in note,
             "et dit pourquoi ils sont à part")

    # Ils ne se glissent ni dans les conversations ni dans les réponses.
    conversations = module_synthese._bloc_conversations(lignes, {})
    verifier("Message 3" not in conversations,
             f"ils ne figurent pas parmi les conversations "
             f"(obtenu : {conversations[:80]!r})")
    reponses = module_synthese._bloc_reponses(lignes, {})
    verifier("une réponse du débiteur" in reponses,
             f"une seule réponse est comptée, pas deux (obtenu : {reponses[:60]!r})")


def test_feuille_emargement() -> None:
    """La feuille d'émargement est reconnue à la forme de son nom."""
    print("\nFeuilles d'émargement")

    import synthese as module_synthese  # noqa: PLC0415
    from dossiers import Dossier  # noqa: PLC0415
    from indexation import LigneIndex  # noqa: PLC0415

    # Le nom réel d'une feuille Edusign : l'apprenant, les deux dates de la
    # formation, un identifiant. Le mot « émargement » n'y figure nulle part.
    reel = "Anas_AIT_BELAID_02_09_2024_31_12_2025_880ceucmlwnozdz_1.pdf"
    lue = module_synthese.lire_emargement(reel)
    verifier(lue is not None, "le nom réel est reconnu")
    verifier(lue["apprenant"] == "Anas AIT BELAID",
             f"l'apprenant en est tiré (obtenu : {lue['apprenant']!r})")
    verifier(lue["debut"] == "02/09/2024" and lue["fin"] == "31/12/2025",
             f"et la période (obtenu : {lue['debut']} → {lue['fin']})")

    # Ce qui n'a pas cette forme n'en est pas une : un faux positif ferait
    # annoncer une preuve de présence qui n'existe pas.
    for autre in ("FACT-2405-00409.pdf", "Devis signe Sofiane.pdf",
                  "Rib BNP Datascientest (1).pdf", "releve_2024_01_x.pdf"):
        verifier(module_synthese.lire_emargement(autre) is None,
                 f"« {autre} » n'est pas pris pour un émargement")

    def piece(numero, jointes):
        return LigneIndex(
            piece_n=numero, date=datetime(2024, 5, numero, tzinfo=timezone.utc),
            sens="reçu", expediteur="a@b.fr", destinataires="c@d.fr", copie="",
            objet="Formation", nb_pieces_jointes=1, pieces_jointes=jointes,
            critere="apprenant", boites="b", fichier_pdf="", fichier_eml="",
            dossier_pieces_jointes="", thread_id="t", message_id=f"<{numero}>")

    lignes = [piece(1, "FACT-2405-00409.pdf"), piece(2, reel)]
    classees = dict(module_synthese.classer_pieces_jointes(lignes))
    verifier("Feuille d'émargement" in classees,
             f"elle a sa propre rubrique (obtenu : {sorted(classees)})")
    verifier(classees["Feuille d'émargement"] == [f"{reel} (pièce n° 2)"],
             "et y figure sous son nom")

    # Elle établit la présence effective : c'est la pièce la plus forte du
    # dossier sur l'exécution, et le contexte la dit.
    dossier = Dossier(reference="FACT-2405-00409", nom="SAS EDEN",
                      montant_du="5 990 €", date_echeance="30/05/2024")
    contexte = dict(module_synthese.resumer_situation(
        dossier, module_synthese.analyser(lignes, {}),
        datetime(2026, 9, 7, tzinfo=timezone.utc), None, lignes))["Contexte"]
    verifier("feuille d'émargement d'Anas AIT BELAID" in contexte,
             f"le contexte la cite, élision comprise (obtenu : {contexte[:150]})")
    verifier("du 02/09/2024 au 31/12/2025" in contexte,
             "avec la période qu'elle couvre")

    # Une feuille d'émargement porte le nom de l'apprenant, pas le numéro de
    # facture : la chercher dans le nom des pièces jointes la ramène.
    avec_apprenant = Dossier(
        reference="FACT-2405-00409", nom="SAS EDEN",
        factures=["FACT-2405-00409"],
        colonnes={"entreprise": "SAS EDEN",
                  "nom prenom de l apprenant": "Anas AIT BELAID"})
    requete = avec_apprenant.requete_gmail()
    verifier('filename:"Anas AIT BELAID"' in requete,
             "le nom de l'apprenant est cherché dans les pièces jointes")

    # Les bornes de date sont ajoutees a la fin de la requete : c'est
    # exactement ce que la troncature du journal emportait. Un dossier borne
    # sans qu'on le voie cherche dans une fenetre trop etroite, et l'on
    # conclut que le message n'existe pas.
    import export_mails  # noqa: PLC0415

    borne = Dossier(reference="F", nom="X", emails=["a@b.fr"],
                    factures=["FACT-2405-00409"],
                    date_debut="2024/09/02", date_fin="2025/12/31")
    dit: list[str] = []
    export_mails._journaliser_requete(borne, dit.append)
    trace = "\n".join(dit)
    verifier("recherche bornée : du 2024-09-02 au 2025-12-31" in trace,
             f"les bornes de date sont dites, hors de la requête tronquée "
             f"(obtenu : {dit})")
    verifier("les messages postérieurs à cette date sont exclus" in trace,
             "et l'on dit ce que cela coûte")

    sans_borne: list[str] = []
    export_mails._journaliser_requete(
        Dossier(reference="F", nom="X", factures=["FACT-1"]), sans_borne.append)
    verifier(not any("bornée" in ligne for ligne in sans_borne),
             "un dossier sans borne ne déclenche aucun avertissement")


def test_copie_vers_sharepoint() -> None:
    """Les dossiers produits sont recopiés vers un second emplacement."""
    print("\nCopie vers un dossier synchronisé")

    import export_mails  # noqa: PLC0415
    from dossiers import ErreurDossiers  # noqa: PLC0415

    with tempfile.TemporaryDirectory() as repertoire:
        racine = Path(repertoire)
        source = racine / "recouvrement-export"
        piece = source / "FACT-2405-00409_sas-eden" / "pieces-jointes" / "piece-03"
        piece.mkdir(parents=True)
        (piece / "Devis signe Sofiane.pdf").write_bytes(b"DEVIS")
        (source / "FACT-2405-00409_sas-eden" / "synthese.pdf").write_bytes(b"PDF")
        (source / "_recapitulatif.csv").write_text("reference\n", encoding="utf-8")

        # Le chemin d'une bibliothèque SharePoint synchronisée : 188
        # caractères avant même le nom du dossier. Windows s'arrête à 260.
        cible = (racine / "INSEEC"
                 / "DST-EquipeFinance - Documents partages"
                 / "05. Cash Management (CM) et Recouvrement"
                 / "Contentieux - Dossier Zehavith Tordjman"
                 / "Dossiers créés par l'application contentieux")
        destination = export_mails.verifier_destination_copie(str(cible))
        verifier(destination.is_dir(), "le dossier de destination est créé")

        journal: list[str] = []
        echecs = export_mails.copier_export(source, destination, journal.append)
        verifier(echecs == 0, f"aucun échec de copie (obtenu : {echecs})")
        verifier(any("4 fichier(s) copié(s)" in ligne for ligne in journal)
                 or any("3 fichier(s) copié(s)" in ligne for ligne in journal),
                 f"le journal dit combien (obtenu : {journal})")

        recopie = (destination / "FACT-2405-00409_sas-eden" / "pieces-jointes"
                   / "piece-03" / "Devis signe Sofiane.pdf")
        verifier(recopie.exists() and recopie.read_bytes() == b"DEVIS",
                 "l'arborescence et le contenu sont conservés")

        # Un export refait recopie par-dessus sans se plaindre.
        (source / "FACT-2405-00409_sas-eden" / "synthese.pdf").write_bytes(b"PDF v2")
        export_mails.copier_export(source, destination, lambda _l: None)
        verifier((destination / "FACT-2405-00409_sas-eden" / "synthese.pdf")
                 .read_bytes() == b"PDF v2",
                 "un second export met la copie à jour")

    # L'adresse du site n'est pas un dossier : collée telle quelle, elle
    # créerait un répertoire « https: » et l'export s'y copierait en silence.
    for adresse in ("https://inseecadmin.sharepoint.com/sites/DST-EquipeFinance",
                    "http://exemple.fr/dossier"):
        try:
            export_mails.verifier_destination_copie(adresse)
            verifier(False, f"adresse web refusée ({adresse[:40]})")
        except ErreurDossiers as exc:
            verifier("pas un dossier du poste" in str(exc),
                     f"l'adresse web est refusée, et l'on dit quoi faire "
                     f"({adresse[:34]}…)")

    # La ligne de commande et la page la transmettent.
    options = export_mails.analyser_arguments(
        ["--dossiers", "x.csv", "--copier-vers", "D:\\Partage"])
    verifier(options.copier_vers == "D:\\Partage",
             f"l'option existe (obtenu : {options.copier_vers!r})")

    import interface as module_interface  # noqa: PLC0415

    arguments, _sortie = module_interface.construire_arguments(
        {"copie_vers": "D:\\Partage"}, Path("x.csv"))
    verifier("--copier-vers" in arguments
             and arguments[arguments.index("--copier-vers") + 1] == "D:\\Partage",
             f"et la page la transmet (obtenu : {arguments})")
    verifier('id="copieVers"' in module_interface.PAGE,
             "le champ figure dans la page")
    verifier("copieVers" in module_interface.PAGE.split("CHAMPS_REGLAGES")[1][:200],
             "et il est mémorisé d'une session à l'autre")

    # La table des documents reste dans sa carte, comme celle de l'état des
    # dossiers : sans conteneur défilant, elle débordait de la page.
    verifier('+ `<div class="defilable"><table class="donnees">'
             in module_interface.PAGE,
             "la table des documents défile dans sa carte, comme celle de "
             "l'état des dossiers")
    verifier("Relevé bancaire" in module_interface.PAGE,
             "la colonne du relevé bancaire figure au tableau des documents")
    verifier("function etatPiece" in module_interface.PAGE,
             "et son état se lit dans les pièces versées")


def _comparateur_de_tri() -> str:
    """Le tri de la page, isolé pour être exécuté hors du navigateur.

    Découpé dans la page plutôt que recopié : une copie finirait par ne plus
    dire la même chose que ce qui tourne réellement chez la personne.
    """
    import interface as module_interface  # noqa: PLC0415

    page = module_interface.PAGE
    debut = page.index("function reduire(valeur)")
    reduire = page[debut:page.index("function reduireNumero")]
    tri = page[page.index("// -- tri par colonne"):page.index("function brancherTri")]
    return reduire + tri


def test_tri_des_colonnes() -> None:
    """Chaque en-tête trie, et le premier clic prend le sens utile."""
    import interface as module_interface  # noqa: PLC0415

    print("\nTri par colonne")

    page = module_interface.PAGE
    verifier("entetesTriables(COLONNES_SUIVI" in page,
             "les en-têtes de l'état des dossiers sont des boutons")
    verifier("entetesTriables(COLONNES_DOCUMENTS" in page,
             "ceux des documents aussi")
    verifier("trier(retenus, COLONNES_SUIVI" in page
             and "trier(retenus, COLONNES_DOCUMENTS" in page,
             "et les deux tableaux passent par le tri")
    # Le tri est une façon de regarder : il ne réécrit pas l'ordre de l'export.
    verifier("liste.slice().sort" in page,
             "la liste d'origine n'est jamais réordonnée sur place")

    node = shutil.which("node") or shutil.which("nodejs")
    if not node:
        print("  --   node absent : le comparateur n'est pas exécuté ici")
        return

    dossiers = [
        {"reference": "FACT-B", "montant_du": 5990.0, "date_echeance": "",
         "anciennete_jours": None, "convention_signee": None, "statut": "clos"},
        {"reference": "FACT-A", "montant_du": 12490.0,
         "date_echeance": "05/01/2023", "anciennete_jours": 1300,
         "convention_signee": False, "statut": "non-transmis"},
        {"reference": "FACT-C", "montant_du": 5674.17,
         "date_echeance": "12/03/2024", "anciennete_jours": 900,
         "convention_signee": True, "statut": "non-transmis"},
    ]
    programme = _comparateur_de_tri() + f"""
const STATUTS = [{{cle: "non-transmis"}}, {{cle: "clos"}}];
const DOSSIERS = {json.dumps(dossiers, ensure_ascii=False)};
const ordre = (cle, clics) => {{
  TRI.suivi = {{colonne: "", sens: 1}};
  const colonne = COLONNES_SUIVI.find((c) => c.cle === cle);
  for (let i = 0; i < clics; i += 1) {{
    if (TRI.suivi.colonne === cle) TRI.suivi.sens = -TRI.suivi.sens;
    else {{ TRI.suivi.colonne = cle; TRI.suivi.sens = colonne.sens || 1; }}
  }}
  return trier(DOSSIERS, COLONNES_SUIVI, "suivi").map((d) => d.reference);
}};
console.log(JSON.stringify({{
  montant: ordre("montant", 1), montant2: ordre("montant", 2),
  dossier: ordre("dossier", 1), echeance: ordre("echeance", 1),
  retard: ordre("retard", 1), convention: ordre("convention", 1),
  etat: ordre("etat", 1), aucun: ordre("montant", 0),
}}));
"""
    with tempfile.TemporaryDirectory() as dossier:
        script = Path(dossier) / "tri.js"
        script.write_text(programme, encoding="utf-8")
        sortie = subprocess.run([node, str(script)], capture_output=True,
                                text=True, timeout=60)
    verifier(sortie.returncode == 0,
             f"le comparateur s'exécute sans erreur ({sortie.stderr[:300]})")
    obtenu = json.loads(sortie.stdout)

    # Personne ne cherche le plus petit impayé d'abord.
    verifier(obtenu["montant"] == ["FACT-A", "FACT-B", "FACT-C"],
             f"le premier clic met les gros montants en haut ({obtenu['montant']})")
    verifier(obtenu["montant2"] == ["FACT-C", "FACT-B", "FACT-A"],
             f"recliquer inverse l'ordre ({obtenu['montant2']})")
    verifier(obtenu["dossier"] == ["FACT-A", "FACT-B", "FACT-C"],
             f"les noms partent de A ({obtenu['dossier']})")
    verifier(obtenu["etat"] == ["FACT-A", "FACT-C", "FACT-B"],
             f"les états suivent le parcours, pas l'alphabet ({obtenu['etat']})")

    # Une valeur absente n'est ni la plus grande ni la plus petite : la voir
    # coiffer le tableau ferait douter du tri tout entier.
    verifier(obtenu["echeance"] == ["FACT-A", "FACT-C", "FACT-B"],
             f"l'échéance la plus ancienne vient en tête, la vide en bas "
             f"({obtenu['echeance']})")
    verifier(obtenu["retard"][-1] == "FACT-B",
             f"un retard inconnu reste en bas ({obtenu['retard']})")

    # « À qui manque-t-il une convention ? » est la question qu'on se pose en
    # cliquant : le manque vient donc en premier.
    verifier(obtenu["convention"] == ["FACT-A", "FACT-B", "FACT-C"],
             f"les conventions manquantes remontent, le non-renseigné entre "
             f"les deux ({obtenu['convention']})")

    verifier(obtenu["aucun"] == ["FACT-B", "FACT-A", "FACT-C"],
             f"sans tri, l'ordre de l'export est gardé ({obtenu['aucun']})")

    # Trier puis cocher est le geste même : perdre les cases obligerait à tout
    # reprendre au clic suivant.
    verifier("CHOISIS.has(d.reference)" in page,
             "les cases cochées survivent au tri")


def test_references_parasites() -> None:
    """Une chaîne technique n'est pas un numéro de facture."""
    import dossiers as module_dossiers  # noqa: PLC0415
    import interface as module_interface  # noqa: PLC0415
    import suivi as module_suivi  # noqa: PLC0415

    print("\nRéférences parasites")

    # Elles viennent de la plomberie des messages : identifiants Gmail,
    # adresses de groupes, jeux de caractères, espaces de noms Microsoft.
    for parasite in ("goog_97526804", "groups/13606280", "iso-8859-1",
                     "office/2004/12", "wrd0000", "sep 2024"):
        verifier(not module_dossiers.ressemble_a_une_facture(parasite),
                 f"« {parasite} » n'est pas une facture")
    for vraie in ("FACT-2405-00409", "DV-003453", "FACT 2405 00409",
                  "2024-118", "INV0093"):
        verifier(module_dossiers.ressemble_a_une_facture(vraie),
                 f"« {vraie} » en est une")

    # Le mal qu'elles faisaient : entrées dans la requête Gmail, et
    # « goog_97526804 » figure dans presque tous les messages Gmail.
    dossier = module_dossiers.Dossier(
        reference="FACT-2509-11537", nom="MCAPI", emails=["c@x.fr"],
        factures=["FACT-2509-11537"])
    verifier("goog" not in dossier.requete_gmail(),
             "aucune trace dans la requête d'un dossier sain")

    with tempfile.TemporaryDirectory() as repertoire:
        chemin = Path(repertoire) / "suivi.json"
        module_suivi.enregistrer(chemin, {
            "FACT-2509-11537": {"references": ["FACT-2409-05204",
                                               "goog_97526804",
                                               "groups/13606280"]},
            "FACT-2405-00409": {"references": ["DV-003453"]},
        })
        touches = module_suivi.purger_references_parasites(chemin)
        verifier(touches == ["FACT-2509-11537"],
                 f"seul le dossier pollué est signalé ({touches})")
        apres = module_suivi.charger(chemin)
        verifier(apres["FACT-2509-11537"]["references"] == ["FACT-2409-05204"],
                 f"la vraie référence est gardée "
                 f"({apres['FACT-2509-11537']['references']})")
        verifier(apres["FACT-2405-00409"]["references"] == ["DV-003453"],
                 "et un dossier sain n'est pas touché")
        verifier(module_suivi.purger_references_parasites(chemin) == [],
                 "repasser dessus ne signale plus rien")

    page = module_interface.PAGE
    verifier("function blocARefaire" in page,
             "la page nomme les dossiers réunis sur un critère faux")
    verifier("Refaire les notes ne suffira pas" in page,
             "en disant que refaire les notes n'y changera rien")


def test_message_quand_l_outil_ne_repond_pas() -> None:
    """« Failed to fetch » ne dit rien à personne."""
    import interface as module_interface  # noqa: PLC0415

    print("\nOutil injoignable depuis la page")

    page = module_interface.PAGE
    bloc = page[page.index("async function api(chemin, corps)"):
                page.index("// -- bascule entre les deux modes")]
    # Le message du navigateur est en anglais, sans sujet ni remède, et fait
    # croire à une panne de l'export alors qu'il ne dit qu'une chose : la
    # page a parlé dans le vide.
    verifier("try {" in bloc and "await fetch(chemin, options)" in bloc,
             "l'échec de connexion est intercepté")
    verifier("L'application ne répond pas" in bloc,
             "et remplacé par une phrase en français")
    verifier("Lancer.bat" in bloc and "fenêtre noire" in bloc,
             "qui nomme les deux causes et leur remède")
    verifier("Un export en cours, lui, continue" in bloc,
             "en disant que l'export, lui, n'est pas interrompu")

    # Une page qui ne joint plus l'outil ne peut rien faire, et chaque clic
    # echoue en silence. Un petit encart rouge au milieu d'une section ne
    # suffit pas : on cherche un bouton qui n'a jamais pu repondre.
    verifier('id="deconnecte"' in page and "signalerDeconnexion" in bloc,
             "une barre permanente s'affiche quand l'outil ne répond plus")
    verifier("signalerDeconnexion(false)" in bloc,
             "et disparaît dès qu'une requête aboutit")
    verifier('id="recharger"' in page,
             "avec de quoi recharger une fois l'outil rouvert")

    # L'outil se fermait au bout de trois minutes sans requête — or lire un
    # tableau n'en envoie aucune. On lisait le tableau de bord, l'outil se
    # fermait derrière, et le clic suivant échouait sans que rien n'ait été
    # fermé ni cassé. C'est l'origine de tous les « Failed to fetch ».
    # Au niveau du script, et non dans le corps d'une fonction : place dans
    # « refaireNotes », la mesure ne battait que si l'on cliquait ce bouton —
    # c'est-a-dire jamais, et l'outil se fermait quand meme.
    verifier('"/api/vivant"' in page and "\nsetInterval(async" in page,
             "la page bat la mesure des son ouverture, hors de toute fonction")
    verifier(page.index("\nsetInterval(async") > page.index("\nchargerDossiers();"),
             "juste apres le premier chargement")
    # Un selecteur d'identifiant l'emporte sur le [hidden] du navigateur :
    # sans regle explicite, la barre restait affichee en permanence, y compris
    # quand l'outil repondait parfaitement.
    verifier("#deconnecte[hidden]{display:none}" in page,
             "et la barre sait redevenir invisible")
    verifier(module_interface.DELAI_INACTIVITE > 45,
             f"et le battement est plus court que le délai d'inactivité "
             f"({module_interface.DELAI_INACTIVITE} s)")
    # Le conteneur est en flex : un <b> nu y devient une boîte à part, et la
    # phrase se cassait en trois morceaux à des hauteurs différentes.
    barre = page[page.index('<div id="deconnecte"'):page.index("<header>")]
    verifier(barre.count("<span>") == 1,
             "et le texte de la barre tient dans un seul bloc")

    # Le bouton disait « Lancer l'export » quel que soit l'onglet : sur une
    # recherche ponctuelle on cherchait un bouton qui n'existait pas, à côté
    # de celui qui l'aurait lancée.
    verifier('mode === "manuel"\n    ? "Lancer la recherche"' in page,
             "le bouton s'appelle « Lancer la recherche » en mode ponctuel")


def test_montant_inconnu_n_est_pas_zero() -> None:
    """Un montant que personne n'a renseigné ne s'affiche pas « 0 € »."""
    import interface as module_interface  # noqa: PLC0415
    import suivi as module_suivi  # noqa: PLC0415

    print("\nMontant non renseigné")

    with tempfile.TemporaryDirectory() as repertoire:
        sortie = Path(repertoire) / "sortie"
        for nom in ("a", "b", "c"):
            (sortie / nom).mkdir(parents=True)
        (sortie / "_recapitulatif.csv").write_text(
            "reference;nom;repertoire;montant_du;factures;date_echeance\n"
            "FACT-VIDE;SAS EDEN;a;;FACT-VIDE;\n"
            "FACT-ZERO;Soldé;b;0;FACT-ZERO;\n"
            "FACT-DU;Doit;c;5 990 €;FACT-DU;\n",
            encoding="utf-8-sig",
        )
        par_reference = {d["reference"]: d for d in module_suivi.inventaire(
            sortie, Path(repertoire) / "suivi.json")}

        # « 0 € » se lit comme une dette soldée. C'est la seule valeur qui
        # décide d'aller ou non au contentieux : l'inventer est un mensonge.
        verifier(par_reference["FACT-VIDE"]["montant_renseigne"] is False,
                 "une colonne vide se distingue d'un vrai zéro")
        verifier(par_reference["FACT-ZERO"]["montant_renseigne"] is True,
                 "un zéro écrit reste un zéro")
        verifier(par_reference["FACT-DU"]["montant_du"] == 5990.0,
                 f"et un montant se lit ({par_reference['FACT-DU']['montant_du']})")

    page = module_interface.PAGE
    verifier("function montantDu(dossier)" in page,
             "la page distingue les deux à l'affichage")
    verifier("${montantDu(d)}" in page,
             "et s'en sert dans le tableau")


def test_tout_effacer_respecte_la_reponse() -> None:
    """« Non » à « effacer aussi votre suivi » doit vouloir dire non."""
    import suivi as module_suivi  # noqa: PLC0415

    print("\nTout effacer : la troisième question")

    def preparer(dossier: Path) -> tuple[Path, Path]:
        racine = dossier / "export"
        (racine / "a").mkdir(parents=True)
        (racine / "_recapitulatif.csv").write_text(
            "reference;nom;repertoire;montant_du;factures;date_echeance\n"
            "FACT-2405-00409;SAS EDEN;a;5 990 €;FACT-2405-00409;\n",
            encoding="utf-8-sig")
        chemin = dossier / "suivi.json"
        module_suivi.enregistrer(chemin, {"FACT-2405-00409": {
            "statut": "transmis-contentieux", "frais": 250.0,
            "note": "Référence avocat", "contexte": "Chèque rejeté",
            "pieces": [{"nature": "Relevé comptable", "fichier": "p.pdf"}]}})
        return racine, chemin

    # Le suivi partait avec la ligne de la liste, quelle que soit la réponse :
    # on répondait « non », et étapes, frais, notes, contexte et pièces
    # versées disparaissaient. C'est la seule chose ici qu'aucun export ne
    # reconstitue.
    with tempfile.TemporaryDirectory() as dossier:
        racine, chemin = preparer(Path(dossier))
        module_suivi.tout_effacer(racine, chemin,
                                  avec_fichiers=True, avec_suivi=False)
        garde = module_suivi.charger(chemin).get("FACT-2405-00409") or {}
        verifier(garde.get("statut") == "transmis-contentieux",
                 f"l'étape est gardée ({garde.get('statut')})")
        verifier(garde.get("frais") == 250.0 and garde.get("note"),
                 "les frais et la note aussi")
        verifier(len(garde.get("pieces") or []) == 1,
                 "et les pièces versées à la main")
        verifier(not (racine / "a").exists(),
                 "tandis que les fichiers, eux, sont bien supprimés")
        verifier(not (racine / "_recapitulatif.csv").exists(),
                 "et la liste est bien vidée")

    # Demandé explicitement, il part — c'est le troisième degré, et lui seul.
    with tempfile.TemporaryDirectory() as dossier:
        racine, chemin = preparer(Path(dossier))
        module_suivi.tout_effacer(racine, chemin,
                                  avec_fichiers=True, avec_suivi=True)
        verifier(module_suivi.charger(chemin) == {},
                 "demandé, le suivi est effacé")


def test_doublons_de_la_liste() -> None:
    """Le même dossier ne figure pas deux fois dans la liste."""
    import export_mails as module_export  # noqa: PLC0415
    import indexation as module_indexation  # noqa: PLC0415
    import suivi as module_suivi  # noqa: PLC0415

    print("\nDoublons de la liste")

    with tempfile.TemporaryDirectory() as repertoire:
        racine = Path(repertoire) / "export"
        for nom in ("fact-2405-00409_sas-eden", "fact-2601-13302_jaadi"):
            (racine / nom).mkdir(parents=True)
            numero = ("FACT-2405-00409" if "eden" in nom else "FACT-2601-13302")
            (racine / nom / "index.csv").write_text(
                "piece_n;date;heure;sens;expediteur;destinataires;copie;objet;"
                "nb_pieces_jointes;pieces_jointes;critere;factures_concernees;"
                "adresses_concernees;boites;fichier_pdf;fichier_eml\n"
                f"1;21/05/2024;09:30;envoyé;a@l.io;c@x.fr;;Relance;1;f.pdf;;"
                f"{numero};c@x.fr;a@l.io;p.pdf;p.eml\n",
                encoding="utf-8-sig")

        def rangee(reference, nom, repertoire_dossier):
            return module_indexation.ResumeDossier(
                reference=reference, nom=nom, emails="c@x.fr",
                factures=reference, requete="q",
                repertoire=repertoire_dossier, nb_mails=4)

        module_indexation.ecrire_recapitulatif(racine / "_recapitulatif.csv", [
            rangee("FACT-2405-00409", "SAS EDEN", "fact-2405-00409_sas-eden"),
            # Écrite quand « Retrouver » prenait le répertoire pour une
            # référence : le même dossier, une seconde fois et sans son nom.
            rangee("fact-2405-00409_sas-eden", "", "fact-2405-00409_sas-eden"),
            rangee("fact-2601-13302_jaadi", "", "fact-2601-13302_jaadi"),
        ])

        retirees = module_export.nettoyer_recapitulatif(racine)
        verifier(retirees == ["fact-2405-00409_sas-eden"],
                 f"le doublon est retiré ({retirees})")

        suivant = Path(repertoire) / "suivi.json"
        listes = {d["reference"]: d for d in module_suivi.inventaire(
            racine, suivant)}
        verifier(sorted(listes) == ["FACT-2405-00409", "FACT-2601-13302"],
                 f"la liste ne montre plus chaque dossier qu'une fois "
                 f"({sorted(listes)})")
        verifier(listes["FACT-2405-00409"]["nom"] == "SAS EDEN",
                 "et c'est la rangée complète qui reste, pas la rangée vide")
        # Celle qui n'existait que sous son nom de répertoire n'est pas perdue :
        # on lui rend son numéro, lu dans son index.
        verifier(Path(listes["FACT-2601-13302"]["repertoire"]).name
                 == "fact-2601-13302_jaadi",
                 f"le dossier sans doublon reprend son numéro sans être perdu "
                 f"({listes['FACT-2601-13302']['repertoire']})")

        verifier(module_export.nettoyer_recapitulatif(racine) == [],
                 "repasser dessus ne retire plus rien")


def test_retrouver_les_dossiers_du_disque() -> None:
    """Un dossier tombé de la liste se retrouve sans refaire d'export."""
    import export_mails as module_export  # noqa: PLC0415
    import indexation as module_indexation  # noqa: PLC0415
    import interface as module_interface  # noqa: PLC0415

    print("\nRetrouver les dossiers restés sur le disque")

    with tempfile.TemporaryDirectory() as repertoire:
        racine = Path(repertoire) / "export"
        # Nommés comme le vrai outil les nomme : « <slug référence>_<slug
        # nom> », et non la référence nue. Une fixture trop simple avait
        # laissé passer un rapprochement fait sur le nom du répertoire, qui
        # ajoutait un doublon au lieu de reconnaître le dossier.
        repertoires = {"FACT-2405-00409": "fact-2405-00409_sas-eden",
                       "FACT-2411-06955": "fact-2411-06955_djiala"}
        for reference, nom_repertoire in repertoires.items():
            dossier = racine / nom_repertoire
            dossier.mkdir(parents=True)
            (dossier / "index.csv").write_text(
                "piece_n;date;heure;sens;expediteur;destinataires;copie;objet;"
                "nb_pieces_jointes;pieces_jointes;critere;factures_concernees;"
                "adresses_concernees;boites;fichier_pdf;fichier_eml\n"
                f"1;21/05/2024;09:30;envoyé;a@liora.io;client@x.fr;;Relance;"
                f"1;facture.pdf;;{reference};client@x.fr;a@liora.io;p.pdf;p.eml\n",
                encoding="utf-8-sig",
            )
        # Le récapitulatif ne porte plus que le dernier dossier traité.
        module_indexation.ecrire_recapitulatif(
            racine / "_recapitulatif.csv",
            [module_indexation.ResumeDossier(
                reference="FACT-2411-06955", nom="Djiala", emails="client@x.fr",
                factures="FACT-2411-06955", requete="q",
                repertoire="fact-2411-06955_djiala", nb_mails=1)],
        )

        lignes: list[str] = []
        nombre = module_export.retrouver_dossiers(racine, lignes.append)
        verifier(nombre == 1, f"le dossier manquant est retrouvé ({nombre})")

        # Dire ce qu'on a vu, et pas seulement ce qu'on a fait : « rien ne
        # s'est passé » laisse croire à une panne, alors que la réponse est
        # souvent qu'il n'y a qu'un répertoire là où l'on en attendait
        # cinquante.
        compte_rendu = " ".join(lignes)
        verifier("2 répertoire(s)" in compte_rendu
                 and "dont 2 constitué(s)" in compte_rendu
                 and "1 déjà dans la liste" in compte_rendu,
                 f"et l'on sait ce qui a été vu sur le disque ({compte_rendu})")

        rangees = {r["reference"]: r for r in module_indexation.lire_recapitulatif(
            racine / "_recapitulatif.csv")}
        verifier(sorted(rangees) == ["FACT-2405-00409", "FACT-2411-06955"],
                 f"la liste porte de nouveau les deux ({sorted(rangees)})")
        retrouve = rangees["FACT-2405-00409"]
        # Le numéro tel qu'il est écrit dans l'index, casse comprise : c'est
        # lui que la recherche et le tableau de suivi rapprochent.
        verifier(retrouve["nb_mails"] == "1"
                 and retrouve["factures"] == "FACT-2405-00409",
                 f"avec son vrai numéro, non le nom du répertoire "
                 f"({retrouve['factures']}, {retrouve['nb_mails']} message)")
        verifier(retrouve["repertoire"] == "fact-2405-00409_sas-eden",
                 f"et le répertoire où le rouvrir ({retrouve['repertoire']})")
        # Celui qui était déjà là n'est pas retouché : sa rangée vient de
        # l'export, plus complète que ce que le disque seul peut redire.
        verifier(rangees["FACT-2411-06955"]["nom"] == "Djiala",
                 "et celui qui y était garde sa raison sociale")

        # Rejouer ne crée pas de doublon ni ne réécrit ce qui est là.
        verifier(module_export.retrouver_dossiers(racine, lignes.append) == 0,
                 "rejouer ne retrouve plus rien : la liste est complète")

    page = module_interface.PAGE
    verifier('id="retrouver"' in page and '"/api/retrouver"' in page,
             "la page offre de retrouver les dossiers du disque")

    # Un bouton rangé sous un titre qu'il faut d'abord déplier est un bouton
    # qu'on ne trouve pas : il était dans le bloc replié des factures absentes.
    bloc = page[page.index("function blocAbsentsDuSuivi"):
                page.index("// -- onglet État des dossiers")]
    verifier("data-retrouver" in bloc[:bloc.index("<details")],
             "et le propose hors du bloc repliable, non dedans")
    verifier("data-retrouver" in page[page.index("function messageVideAvecRattrapage"):
                                      page.index("function pastilleStatut")],
             "y compris là où la liste est vide, qui est où on le cherche")
    # Il n'est branche que dans l'onglet « Etat des dossiers » : ailleurs — au
    # tableau de bord, aux documents — il s'affichait sans rien faire au clic.
    ordinaire = page[page.index("function messageVide()"):
                     page.index("function messageVideAvecRattrapage")]
    verifier("data-retrouver" not in ordinaire,
             "et nulle part ailleurs, où il ne serait branché à rien")
    # « Aucun export trouve » pendant un export est faux et inquietant : la
    # liste se reconstitue, elle n'est pas absente.
    verifier("EXPORT_EN_COURS" in ordinaire and "au fur et à mesure" in ordinaire,
             "pendant un export, le message dit que la liste se reconstitue")
    # Sans retour à la ligne, un bouton de plus était poussé hors de l'écran.
    verifier("flex-wrap:wrap" in page[page.index(".barre-selection{"):
                                      page.index(".barre-selection span")],
             "la barre revient à la ligne plutôt que de pousser un bouton dehors")


def test_arreter_un_export() -> None:
    """Un export lancé par erreur peut être arrêté."""
    import interface as module_interface  # noqa: PLC0415

    print("\nArrêt d'un export en cours")

    execution = module_interface.Execution()
    verifier(execution.demander_arret() is False,
             "sans export en cours, il n'y a rien à arrêter")

    # L'arrêt est demandé, pas imposé : le dossier en cours va à son terme.
    # Un dossier laissé à demi serait pire qu'un export plus court.
    vus: list[int] = []
    depart, fini = threading.Event(), threading.Event()

    def faux_executer(_options, relais=None, arret=None):
        depart.set()
        for numero in range(1, 51):
            if arret is not None and arret():
                relais(f"⏹ Arrêt demandé — {numero - 1} dossier(s) traités.")
                break
            vus.append(numero)
            relais(f"[{numero}/50] FACT-{numero}")
            time.sleep(0.02)
        fini.set()
        return 0

    vrai_executer = module_interface.export_mails.executer
    module_interface.export_mails.executer = faux_executer
    try:
        execution.lancer(["--dossiers", "x.csv", "--sortie", "s"], "s")
        depart.wait(5)
        time.sleep(0.1)
        verifier(execution.demander_arret() is True,
                 "un export en cours entend la demande")
        fini.wait(5)
        verifier(len(vus) < 50,
                 f"il s'arrête avant la fin ({len(vus)} dossier(s) sur 50)")
        verifier(vus == list(range(1, len(vus) + 1)),
                 "sans sauter de dossier : il s'arrête, il ne saute pas")
        etat = execution.etat(0)
        verifier(any("Arrêt demandé" in ligne for ligne in etat["lignes"]),
                 "et le journal dit où il en était")
    finally:
        module_interface.export_mails.executer = vrai_executer

    # Le fil de l'export finit son travail après la boucle : on attend qu'il
    # se soit vraiment rendu avant d'en relancer un.
    for _ in range(200):
        if not execution.etat(0)["en_cours"]:
            break
        time.sleep(0.05)

    # Un export suivant repart d'un drapeau propre, sans quoi il s'arrêterait
    # aussitôt sans qu'on comprenne pourquoi.
    execution._arret.set()
    module_interface.export_mails.executer = lambda *a, **k: 0
    try:
        execution.lancer(["--dossiers", "x.csv", "--sortie", "s"], "s")
        time.sleep(0.2)
        verifier(execution.etat(0)["arret_demande"] is False,
                 "l'export suivant repart sans arrêt en attente")
    finally:
        module_interface.export_mails.executer = vrai_executer

    page = module_interface.PAGE
    verifier('id="arreter"' in page and '"/api/arreter"' in page,
             "la page offre d'arrêter pendant l'export")
    verifier("arret_demande" in page,
             "et le dit même si la demande vient d'ailleurs")


def test_absents_de_l_export() -> None:
    """Une facture du tableau que l'export n'a pas ramenée est nommée."""
    import interface as module_interface  # noqa: PLC0415
    import suivi as module_suivi  # noqa: PLC0415

    print("\nFactures du tableau absentes de l'export")

    with tempfile.TemporaryDirectory() as repertoire:
        sortie = Path(repertoire) / "sortie"
        (sortie / "a").mkdir(parents=True)
        (sortie / "_recapitulatif.csv").write_text(
            "reference;nom;repertoire;montant_du;factures;date_echeance\n"
            "FACT-2405-00111;A;a;1 €;FACT-2405-00111;\n",
            encoding="utf-8-sig",
        )
        # « Numero » ne dit rien de son contenu : la colonne est reconnue sur
        # ses valeurs, d'où des numéros réalistes plutôt que « FACT-A ».
        grille = [
            (1, ["Numero", "Passage en contentieux"]),
            (2, ["FACT-2405-00111", "Mise en demeure transmise"]),
            (3, ["FACT-2405-00222", "Transmis au service contentieux"]),
            (4, ["FACT-2405-00333", "Transmis au service contentieux"]),
        ]
        chemin = Path(repertoire) / "suivi.json"
        bilan = module_suivi.completer_depuis_grille(
            grille, module_suivi.inventaire(sortie, chemin), chemin)

        # Le compte existait déjà ; ce sont les noms qui manquaient, et sans
        # eux « pourquoi je ne retrouve pas ce dossier » restait sans réponse.
        verifier(bilan["sans_correspondance"] == 2,
                 f"deux lignes sans dossier ({bilan['sans_correspondance']})")
        verifier(bilan["absents"] == ["FACT-2405-00222", "FACT-2405-00333"],
                 f"et elles sont nommées ({bilan['absents']})")

    page = module_interface.PAGE
    verifier("function blocAbsentsDuSuivi" in page,
             "la page les affiche dans l'état des dossiers")
    # Recoupé avec la liste plutôt que cru sur parole : un export plus récent
    # a pu ramener depuis un dossier que le fichier disait absent.
    verifier("connus.has(reduireNumero(r))" in page,
             "après recoupement avec les dossiers réellement exportés")
    verifier("relancez un export en les incluant" in page,
             "en disant quoi faire pour les faire entrer")


def test_note_refaite_datee_et_recopiee() -> None:
    """Une note refaite se voit, et suit l'export dans sa copie."""
    import interface as module_interface  # noqa: PLC0415
    import synthese as module_synthese  # noqa: PLC0415

    print("\nNote refaite : datation et copie")

    # Une note refaite portait la date du jour comme date d'extraction. C'était
    # faux — aucun message n'est relu — et surtout indiscernable : rien ne
    # disait si le fichier ouvert était celui d'avant ou celui d'après.
    signature = inspect.signature(module_synthese.construire_html)
    verifier("date_note" in signature.parameters,
             "la note peut porter sa propre date de rédaction")
    verifier("Note rédigée le" in Path("synthese.py").read_text(encoding="utf-8"),
             "et l'annonce sous son nom")
    source = Path("interface.py").read_text(encoding="utf-8")
    verifier("date_export=datetime.fromtimestamp(" in source,
             "refaire une note garde la date d'extraction de l'export")

    with tempfile.TemporaryDirectory() as repertoire:
        sortie = Path(repertoire) / "sortie"
        dossier = sortie / "eden"
        dossier.mkdir(parents=True)
        (dossier / "synthese.pdf").write_bytes(b"%PDF-1.4 neuf\n")
        (dossier / "synthese.version").write_text("99", encoding="utf-8")
        copie = Path(repertoire) / "sharepoint"
        (copie / "eden").mkdir(parents=True)
        (copie / "eden" / "synthese.pdf").write_bytes(b"%PDF-1.4 vieux\n")

        faites = module_interface.recopier_note(dossier, sortie, copie)
        verifier(faites == 2, f"la note et sa marque sont reportées ({faites})")
        verifier((copie / "eden" / "synthese.pdf").read_bytes()
                 == b"%PDF-1.4 neuf\n",
                 "et la copie porte bien la note refaite, non l'ancienne")

        # Un PDF que la réécriture a retiré doit l'être de la copie aussi :
        # l'y laisser rendrait l'ancienne note plus visible que la nouvelle.
        (dossier / "synthese.pdf").unlink()
        (dossier / "synthese.html").write_text("<p>note</p>", encoding="utf-8")
        module_interface.recopier_note(dossier, sortie, copie)
        verifier(not (copie / "eden" / "synthese.pdf").exists(),
                 "un PDF retiré à la source est retiré de la copie")
        verifier((copie / "eden" / "synthese.html").exists(),
                 "et le HTML qui le remplace y est déposé")

        # Sans copie configurée, il ne se passe rien du tout.
        verifier(module_interface.recopier_note(dossier, sortie, None) == 0,
                 "sans second emplacement, rien n'est copié")


def test_refaire_notes_choisies() -> None:
    """On refait la note des dossiers cochés, pas celle des deux cents."""
    import interface as module_interface  # noqa: PLC0415

    print("\nRefaire les notes des seuls dossiers choisis")

    class _Sortie:
        """Un gestionnaire réduit à ce que la route utilise : sa réponse."""

        def __init__(self) -> None:
            self.reponse: dict = {}

        def _json(self, _code: int, corps: dict) -> None:
            self.reponse = corps

        _refaire_notes = module_interface.Gestionnaire._refaire_notes

    with tempfile.TemporaryDirectory() as repertoire:
        sortie = Path(repertoire) / "sortie"
        for nom in ("a", "b", "c"):
            (sortie / nom).mkdir(parents=True)
        (sortie / "_recapitulatif.csv").write_text(
            "reference;nom;repertoire;montant_du;factures;date_echeance\n"
            "FACT-A;A;a;1 €;FACT-A;\nFACT-B;B;b;1 €;FACT-B;\n"
            "FACT-C;C;c;1 €;FACT-C;\n",
            encoding="utf-8-sig",
        )

        faites: list[str] = []
        vrai_refaire = module_interface._refaire_synthese
        vraies_preferences = module_interface.lire_preferences
        module_interface._refaire_synthese = (
            lambda _rep, dossier, _suivi: (faites.append(dossier["reference"]),
                                           (True, ""))[1])
        module_interface.lire_preferences = lambda: {"sortie": str(sortie)}
        try:
            gestionnaire = _Sortie()
            gestionnaire._refaire_notes({"references": ["FACT-C", "FACT-A"]})
            verifier(sorted(faites) == ["FACT-A", "FACT-C"],
                     f"seules les notes cochées sont refaites ({sorted(faites)})")
            verifier(gestionnaire.reponse["refaites"] == 2,
                     f"et le compte le dit ({gestionnaire.reponse['refaites']})")

            # Sans rien de coché, le bouton garde son sens d'origine : tout.
            faites.clear()
            gestionnaire._refaire_notes({})
            verifier(sorted(faites) == ["FACT-A", "FACT-B", "FACT-C"],
                     f"sans sélection, toutes les notes sont refaites "
                     f"({sorted(faites)})")

            # Une référence qui n'existe plus est nommée plutôt que comptée
            # comme faite : sinon « 0 note refaite » resterait inexpliqué.
            faites.clear()
            gestionnaire._refaire_notes({"references": ["FACT-Z"]})
            verifier(faites == [] and gestionnaire.reponse["inconnues"] == ["FACT-Z"],
                     f"un dossier inconnu est signalé "
                     f"({gestionnaire.reponse.get('inconnues')})")
        finally:
            module_interface._refaire_synthese = vrai_refaire
            module_interface.lire_preferences = vraies_preferences

    page = module_interface.PAGE
    verifier("CHOIX_NOTES" in page and "choix-note" in page,
             "la page offre de cocher les dossiers du tableau des documents")
    verifier('api("/api/refaire-notes", { references: choisis })' in page,
             "et transmet la sélection")
    # Les cases de « État des dossiers » commandent une suppression : un même
    # geste ne doit pas pouvoir déclencher l'une pour l'autre.
    verifier("CHOIX_NOTES" in page and "const CHOISIS" in page
             and "CHOISIS.has" in page,
             "les deux sélections restent distinctes")
    # Les notes en retard ne se demandent plus : elles se refont seules, en
    # arriere-plan. Corriger une echeance et devoir ensuite penser a refaire
    # la note etait une facon de laisser la note mentir.
    verifier("def rafraichir_notes" in Path("interface.py").read_text(
        encoding="utf-8"), "les notes en retard se refont d'elles-mêmes")
    verifier('"sont en cours de mise à jour"' in page,
             "et la page l'annonce au lieu d'offrir un bouton")
    # Pendant un export la remise a jour est suspendue — deux ecritures dans
    # les memes repertoires se marcheraient dessus. Annoncer « en cours »
    # serait promettre ce qui n'a pas lieu.
    verifier('seront mises à jour à la fin de l\'export' in page,
             "et dit qu'elle attend, quand un export tourne")


def test_barre_toujours_presente() -> None:
    """La barre d'outils reste là quand la liste est vide."""
    import interface as module_interface  # noqa: PLC0415

    print("\nBarre d'outils de l'état des dossiers")

    page = module_interface.PAGE
    rendu = page[page.index("function rendreSuivi()"):
                 page.index("// -- onglet Tableau de bord")]

    # Elle s'en allait avec la liste, or c'est justement quand la liste est
    # vide ou fausse qu'on cherche « Tout effacer » et « Compléter depuis un
    # fichier » : les boutons qui remettent l'application d'aplomb
    # disparaissaient avec le problème qu'ils servent à régler.
    verifier("$(\"tableSuivi\").innerHTML = messageVide();" not in rendu,
             "la liste vide ne remplace plus tout le contenu de l'onglet")
    verifier('id="toutEffacer"' in rendu and 'id="complement"' in rendu,
             "la barre est rendue dans tous les cas")
    verifier("? (retenus.length ? \"\" : messageAucuneCorrespondance())" in rendu
             and ": messageVideAvecRattrapage()}" in rendu,
             "et le message « aucun export » prend la place du tableau, "
             "pas celle de la barre")
    # Effacer ce qui n'existe pas n'a pas de sens : le bouton est là pour
    # qu'on le trouve, grisé pour qu'il ne promette rien.
    verifier('DOSSIERS.length ? "" : " disabled"' in rendu,
             "« Tout effacer » est visible mais grisé sans aucun dossier")


def test_note_perimee() -> None:
    """Une note écrite avant le dernier changement est signalée."""
    import interface as module_interface  # noqa: PLC0415
    import suivi as module_suivi  # noqa: PLC0415

    print("\nNotes de synthèse en retard sur le suivi")

    with tempfile.TemporaryDirectory() as repertoire:
        sortie = Path(repertoire) / "sortie"
        dossier = sortie / "d"
        dossier.mkdir(parents=True)
        (sortie / "_recapitulatif.csv").write_text(
            "reference;nom;repertoire;montant_du;factures;date_echeance\n"
            "FACT-2405-00409;SAS EDEN;d;5 990 €;FACT-2405-00409;\n",
            encoding="utf-8-sig",
        )
        note = dossier / "synthese.pdf"
        note.write_bytes(b"%PDF-1.4\n")
        marque = dossier / "synthese.version"
        marque.write_text(module_suivi.VERSION, encoding="utf-8")

        chemin = Path(repertoire) / "suivi.json"
        etat = module_suivi.charger(chemin)
        etat["FACT-2405-00409"] = {"statut": "non-transmis"}

        # Une note écrite après le dernier enregistrement est à jour.
        hier = datetime.now() - timedelta(days=1)
        etat["FACT-2405-00409"]["maj"] = hier.strftime("%d/%m/%Y %H:%M")
        module_suivi.enregistrer(chemin, etat)
        obtenu = module_suivi.inventaire(sortie, chemin)[0]
        verifier(obtenu["note_perimee"] is False,
                 "une note plus récente que le suivi n'est pas signalée")

        # Le cas courant : un fichier de suivi appliqué après coup renseigne
        # l'échéance et le contexte de dossiers dont les notes datent de
        # l'export.
        demain = datetime.now() + timedelta(days=1)
        etat["FACT-2405-00409"]["maj"] = demain.strftime("%d/%m/%Y %H:%M")
        module_suivi.enregistrer(chemin, etat)
        obtenu = module_suivi.inventaire(sortie, chemin)[0]
        verifier(obtenu["note_perimee"] is True,
                 "une note antérieure au dernier changement est signalée")

        # Signaler à tort use le signal : « maj » est daté à la minute, et une
        # note écrite dans la même minute paraîtrait périmée de 59 secondes.
        juste_avant = datetime.now() - timedelta(seconds=30)
        etat["FACT-2405-00409"]["maj"] = juste_avant.strftime("%d/%m/%Y %H:%M")
        module_suivi.enregistrer(chemin, etat)
        obtenu = module_suivi.inventaire(sortie, chemin)[0]
        verifier(obtenu["note_perimee"] is False,
                 "la minute d'écriture du suivi ne suffit pas à périmer la note")

        # Une note ne vieillit pas que par le suivi : elle vieillit aussi
        # parce que l'outil a change. La meme facture jointe a sept relances
        # tenait sept lignes avant qu'on ne regroupe les pieces par document,
        # et la note s'ouvrait sans rien dire de son age.
        etat["FACT-2405-00409"]["maj"] = hier.strftime("%d/%m/%Y %H:%M")
        module_suivi.enregistrer(chemin, etat)
        marque.write_text("12", encoding="utf-8")
        obtenu = module_suivi.inventaire(sortie, chemin)[0]
        verifier(obtenu["note_perimee"] is True,
                 "une note écrite par une version antérieure est signalée")

        marque.unlink()
        obtenu = module_suivi.inventaire(sortie, chemin)[0]
        verifier(obtenu["note_perimee"] is True,
                 "une note sans marque de version aussi : elle est plus "
                 "ancienne que la marque elle-même")

        # Un dossier sans note n'a rien à refaire : il n'a rien.
        note.unlink()
        etat["FACT-2405-00409"]["maj"] = demain.strftime("%d/%m/%Y %H:%M")
        module_suivi.enregistrer(chemin, etat)
        obtenu = module_suivi.inventaire(sortie, chemin)[0]
        verifier(obtenu["note_perimee"] is False,
                 "un dossier sans note n'est pas dit en retard")

    page = module_interface.PAGE
    verifier("d.note_perimee" in page and "à refaire" in page,
             "la page marque les notes à refaire")
    verifier("aide perimees" in page,
             "et les annonce en tête du tableau des documents")


def test_part_abandon_possible() -> None:
    """La part du portefeuille laissée en suspens, pas seulement le nombre."""
    import interface as module_interface  # noqa: PLC0415
    import suivi as module_suivi  # noqa: PLC0415

    print("\nPart des possibles abandons")

    dossiers = [
        {"reference": f"F{i}", "statut": statut, "montant_du": 1000.0,
         "frais": 0.0, "duree_jours": None, "date_echeance": "",
         "anciennete_jours": None, "mise_en_demeure": ""}
        for i, statut in enumerate(
            ["abandon-possible", "abandon-possible", "non-transmis",
             "transmis-contentieux"])
    ]
    chiffres = module_suivi.agreger(dossiers)
    verifier(chiffres["nb_abandon_possible"] == 2,
             f"deux dossiers en possible abandon ({chiffres['nb_abandon_possible']})")
    verifier(chiffres["part_abandon_possible"] == 50,
             f"soit la moitié du portefeuille ({chiffres['part_abandon_possible']} %)")
    verifier(chiffres["montant_abandon_possible"] == 2000.0,
             f"et {chiffres['montant_abandon_possible']} € à trancher")

    # Rapportée à tout le portefeuille : un possible abandon n'est pas une
    # issue, c'est une décision qui reste à prendre sur un dossier ouvert.
    verifier(module_suivi.agreger([])["part_abandon_possible"] is None,
             "sans aucun dossier, aucune part n'est inventée")

    page = module_interface.PAGE
    verifier("Possible abandon" in page, "la tuile figure au tableau de bord")
    verifier("part_abandon_possible: DOSSIERS.length" in page,
             "et la page la recalcule elle-même quand une étape change")


def test_pieces_citees_une_fois() -> None:
    """Un document est cité une fois, avec les pièces où il figure."""
    print("\nPièces jointes regroupées par document")

    import synthese as module_synthese  # noqa: PLC0415
    from indexation import LigneIndex  # noqa: PLC0415

    def piece(numero, jointes):
        return LigneIndex(
            piece_n=numero, date=datetime(2024, 5, numero, tzinfo=timezone.utc),
            sens="envoyé", expediteur="a@b.fr", destinataires="c@d.fr", copie="",
            objet="Relance", nb_pieces_jointes=1, pieces_jointes=jointes,
            critere="facture", boites="b", fichier_pdf="", fichier_eml="",
            dossier_pieces_jointes="", thread_id="t", message_id=f"<{numero}>")

    # La même facture jointe à sept relances : elle donnait sept lignes
    # identiques, et la liste ne disait plus quels documents composent le
    # dossier, seulement combien de fois ils ont été envoyés.
    lignes = [piece(n, "FACT-2405-00409.pdf") for n in (1, 3, 4, 6, 9)]
    lignes += [piece(n, "FACT-2405-00409.pdf | Rib BNP Datascientest (1).pdf")
               for n in (2, 5)]
    lignes.append(piece(7, "Devis signe Sofiane.pdf"))

    classees = dict(module_synthese.classer_pieces_jointes(lignes))
    factures = classees["Facture / avoir"]
    verifier(len(factures) == 1,
             f"une seule ligne pour la facture (obtenu : {factures})")
    verifier(factures[0]
             == "FACT-2405-00409.pdf (pièces n° 1, 2, 3, 4, 5, 6 et 9)",
             f"avec toutes ses pièces citées (obtenu : {factures[0]})")
    verifier(classees["Autre document"]
             == ["Rib BNP Datascientest (1).pdf (pièces n° 2 et 5)"],
             f"deux occurrences se lisent « pièces n° 2 et 5 » "
             f"(obtenu : {classees['Autre document']})")
    verifier(classees["Contrat / convention"]
             == ["Devis signe Sofiane.pdf (pièce n° 7)"],
             f"et un document unique garde le singulier "
             f"(obtenu : {classees['Contrat / convention']})")

    # Le même fichier téléchargé depuis Monday et déjà extrait d'un message
    # est un seul document, pas deux : la facture figurait une troisième fois
    # sous « Documents issus du tableau de suivi ».
    from dossiers import Dossier  # noqa: PLC0415

    dossier = Dossier(reference="FACT-2405-00409", nom="SAS EDEN",
                      montant_du="5 990 €")
    note = module_synthese.construire_html(
        dossier, ["b@liora.io"], lignes,
        module_synthese.analyser(lignes, {}),
        datetime(2026, 9, 7, tzinfo=timezone.utc),
        documents_monday=["FACT-2405-00409.pdf", "Convention EDEN.pdf"],
        textes={})
    verifier(note.count("FACT-2405-00409.pdf") == 1,
             f"la facture n'est citée qu'une fois dans toute la note "
             f"(obtenu : {note.count('FACT-2405-00409.pdf')})")
    verifier("Convention EDEN.pdf" in note,
             "mais un document du tableau que les messages ne portent pas "
             "reste cité")


def test_suivi_livre_avec_l_application() -> None:
    """Le suivi du service est livré avec l'outil, et s'applique tout seul."""
    print("\nSuivi livré avec l'application")

    import interface as module_interface  # noqa: PLC0415
    import suivi as module_suivi  # noqa: PLC0415

    livre = Path(module_interface.__file__).resolve().parent / "suivi-initial.csv"
    verifier(livre.exists(),
             "le suivi extrait du tableau du service accompagne l'application")

    with tempfile.TemporaryDirectory() as repertoire:
        racine = Path(repertoire)
        sortie = racine / "export"
        (sortie / "d").mkdir(parents=True)
        # Un export tout neuf : aucun suivi, aucun fichier déposé.
        (sortie / "_recapitulatif.csv").write_text(
            "reference;nom;repertoire;montant_du;factures\n"
            "FACT-2406-03978;M Ouissam Gouni;d;;FACT-2406-03978\n"
            "FACT-9999-99999;Inconnu du fichier;d;;FACT-9999-99999\n",
            encoding="utf-8-sig")

        anciennes = (module_interface.RACINE, module_interface.SUIVI,
                     module_interface.PREFERENCES, module_interface.COMPLEMENTS)
        module_interface.RACINE = racine
        module_interface.SUIVI = racine / "suivi.json"
        module_interface.PREFERENCES = racine / "prefs.json"
        module_interface.COMPLEMENTS = racine / "complements-suivi"
        try:
            module_interface.ecrire_preferences({"sortie": str(sortie)})
            bilan = module_interface.appliquer_complements_si_besoin()
            verifier(bilan["fichiers"] == 1,
                     f"il s'applique sans qu'on dépose quoi que ce soit "
                     f"(obtenu : {bilan})")

            etats = module_suivi.charger(module_interface.SUIVI)
            connu = etats.get("FACT-2406-03978", {})
            verifier(connu.get("statut") == "abandon-possible",
                     f"un dossier du tableau reçoit son étape "
                     f"(obtenu : {connu.get('statut')})")
            verifier("Ne peut pas passer" in (connu.get("note") or ""),
                     f"et son motif (obtenu : {connu.get('note')!r})")
            verifier(connu.get("adresses"),
                     f"ainsi que son adresse (obtenu : {connu.get('adresses')})")
            verifier(not etats.get("FACT-9999-99999", {}).get("statut"),
                     "un dossier absent du tableau n'invente rien")

            # Une étape saisie ici l'emporte, comme pour un fichier déposé.
            etats = module_suivi.charger(module_interface.SUIVI)
            module_suivi.mettre_a_jour(etats, "FACT-2406-03978", statut="avocats")
            module_suivi.enregistrer(module_interface.SUIVI, etats)
            module_interface.memoriser_preferences({"complements_appliques": {}})
            module_interface.appliquer_complements_si_besoin()
            verifier(module_suivi.charger(module_interface.SUIVI)
                     ["FACT-2406-03978"]["statut"] == "avocats",
                     "et la saisie faite ici n'est jamais écrasée par le livré")

            # Il n'est pas annoncé comme un fichier déposé : personne ne l'a
            # choisi, et le dire laisserait croire à un dépôt.
            verifier(module_interface.complement_memorise() is None,
                     "il ne se fait pas passer pour un fichier déposé")
        finally:
            (module_interface.RACINE, module_interface.SUIVI,
             module_interface.PREFERENCES,
             module_interface.COMPLEMENTS) = anciennes


def test_etape_depuis_monday() -> None:
    """L'étape du tableau est reprise, que le tableau vienne de Monday."""
    print("\nÉtape reprise du tableau Monday")

    import suivi as module_suivi  # noqa: PLC0415
    from dossiers import Dossier  # noqa: PLC0415

    with tempfile.TemporaryDirectory() as repertoire:
        suivi = Path(repertoire) / "suivi.json"
        lot = [
            Dossier(reference="FACT-1", nom="A", factures=["FACT-1"],
                    etape="Montant trop faible - Ne peut pas passer en contentieux"),
            Dossier(reference="FACT-2", nom="B", factures=["FACT-2"],
                    etape="Transmis au service contentieux"),
            Dossier(reference="FACT-3", nom="C", factures=["FACT-3"], etape=""),
        ]
        # Une étape posée à la main : elle doit résister à l'export suivant.
        etats = module_suivi.charger(suivi)
        module_suivi.mettre_a_jour(etats, "FACT-2", statut="avocats")
        module_suivi.enregistrer(suivi, etats)

        reprises = module_suivi.reprendre_etapes_du_tableau(lot, suivi)
        apres_export = module_suivi.charger(suivi)
        verifier(reprises == 1,
                 f"une seule étape reprise (obtenu : {reprises})")
        verifier(apres_export["FACT-1"]["statut"] == "abandon-possible",
                 f"celle du dossier vierge (obtenu : "
                 f"{apres_export['FACT-1'].get('statut')})")
        verifier("Montant trop faible" in (apres_export["FACT-1"].get("note") or ""),
                 "avec son motif")
        verifier(apres_export["FACT-2"]["statut"] == "avocats",
                 f"l'étape saisie à la main est intacte (obtenu : "
                 f"{apres_export['FACT-2'].get('statut')})")
        verifier("FACT-3" not in apres_export
                 or not apres_export["FACT-3"].get("statut"),
                 "un dossier sans étape au tableau n'en reçoit pas")

        # Le tableau évolue : l'étape qu'il avait posée suit.
        lot[0].etape = "Transmis au service contentieux"
        module_suivi.reprendre_etapes_du_tableau(lot, suivi)
        suite = module_suivi.charger(suivi)
        verifier(suite["FACT-1"]["statut"] == "transmis-contentieux",
                 f"l'étape du tableau se met à jour (obtenu : "
                 f"{suite['FACT-1'].get('statut')})")
        verifier(suite["FACT-2"]["statut"] == "avocats",
                 "et la saisie à la main reste intacte")

    import export_mails  # noqa: PLC0415

    verifier("reprendre_etapes_du_tableau" in
             Path(export_mails.__file__).read_text(encoding="utf-8"),
             "l'export Monday la reprend aussi, pas seulement l'import fichier")


def test_complement_reapplique_seul() -> None:
    """Le fichier retenu se réapplique tout seul dès qu'il change."""
    print("\nRéapplication automatique du fichier de suivi")

    import interface as module_interface  # noqa: PLC0415
    import suivi as module_suivi  # noqa: PLC0415

    with tempfile.TemporaryDirectory() as repertoire:
        racine = Path(repertoire)
        sortie = racine / "export"
        (sortie / "d").mkdir(parents=True)
        (sortie / "_recapitulatif.csv").write_text(
            "reference;nom;repertoire;montant_du;factures\n"
            "FACT-2501-07581;Ja REVET;d;1750 €;FACT-2501-07581\n",
            encoding="utf-8-sig")

        anciennes = (module_interface.RACINE, module_interface.SUIVI,
                     module_interface.PREFERENCES, module_interface.COMPLEMENTS)
        module_interface.RACINE = racine
        module_interface.SUIVI = racine / "suivi.json"
        module_interface.PREFERENCES = racine / "prefs.json"
        module_interface.COMPLEMENTS = racine / "complements-suivi"
        try:
            module_interface.ecrire_preferences({"sortie": str(sortie)})
            module_interface.COMPLEMENTS.mkdir()
            fichier = module_interface.COMPLEMENTS / "publipostage.csv"
            fichier.write_text(
                "Numero;Client;Passage en contentieux\n"
                "FACT-2501-07581;Ja REVET;"
                "Montant trop faible - Ne peut pas passer en contentieux\n",
                encoding="utf-8-sig")
            module_interface.memoriser_preferences(
                {"complements": ["publipostage.csv"]})

            premier = module_interface.appliquer_complements_si_besoin()
            verifier(premier["fichiers"] >= 1 and premier["etapes"] >= 1,
                     f"le fichier est appliqué sans qu'on le redépose "
                     f"(obtenu : {premier})")

            # Inchangé : on ne relit pas un classeur de trente mille lignes
            # à chaque ouverture de la page.
            second = module_interface.appliquer_complements_si_besoin()
            verifier(second["fichiers"] == 0,
                     f"un fichier inchangé n'est pas relu (obtenu : {second})")

            # Une version fraîche déposée au même endroit est reprise seule.
            import time  # noqa: PLC0415

            time.sleep(0.01)
            fichier.write_text(
                "Numero;Client;Passage en contentieux\n"
                "FACT-2501-07581;Ja REVET;Transmis au service contentieux\n",
                encoding="utf-8-sig")
            troisieme = module_interface.appliquer_complements_si_besoin()
            verifier(troisieme["fichiers"] >= 1,
                     f"une version fraîche est reprise d'elle-même "
                     f"(obtenu : {troisieme})")
            etats = module_suivi.charger(module_interface.SUIVI)
            verifier(etats["FACT-2501-07581"]["statut"] == "transmis-contentieux",
                     f"et l'étape suit (obtenu : "
                     f"{etats['FACT-2501-07581'].get('statut')})")
        finally:
            (module_interface.RACINE, module_interface.SUIVI,
             module_interface.PREFERENCES,
             module_interface.COMPLEMENTS) = anciennes


def test_refaire_les_notes() -> None:
    """Les notes se refont sans retourner sur Gmail."""
    print("\nRéécriture des notes de synthèse")

    import interface as module_interface  # noqa: PLC0415
    from indexation import LigneIndex, ecrire_index_dossier  # noqa: PLC0415

    with tempfile.TemporaryDirectory() as repertoire:
        racine = Path(repertoire)
        sortie = racine / "export"
        dossier = sortie / "FACT-2405-00409_sas-eden"
        dossier.mkdir(parents=True)
        ecrire_index_dossier(dossier / "index.csv", [LigneIndex(
            piece_n=1, date=datetime(2024, 5, 20, 9, tzinfo=timezone.utc),
            sens="envoyé", expediteur="r@liora.io", destinataires="c@x.fr",
            copie="", objet="Facture FACT-2405-00409", nb_pieces_jointes=0,
            pieces_jointes="", critere="facture", boites="r@liora.io",
            fichier_pdf="", fichier_eml="", dossier_pieces_jointes="",
            thread_id="t", message_id="<1>")])
        # Une note écrite par une version précédente de l'outil.
        (dossier / "synthese.html").write_text("<html>ANCIENNE NOTE</html>",
                                               encoding="utf-8")
        (sortie / "_recapitulatif.csv").write_text(
            "reference;nom;repertoire;montant_du;factures\n"
            "FACT-2405-00409;SAS EDEN;FACT-2405-00409_sas-eden;5 990 €;"
            "FACT-2405-00409\n", encoding="utf-8-sig")

        anciennes = (module_interface.RACINE, module_interface.SUIVI,
                     module_interface.PREFERENCES)
        module_interface.RACINE = racine
        module_interface.SUIVI = racine / "suivi.json"
        module_interface.PREFERENCES = racine / "prefs.json"
        try:
            module_interface.ecrire_preferences({"sortie": str(sortie)})
            reussi, motif = module_interface._refaire_synthese(
                dossier,
                {"reference": "FACT-2405-00409", "nom": "SAS EDEN",
                 "montant_du": "5 990 €", "factures": "FACT-2405-00409",
                 "emails": ""},
                {})
            note = (dossier / "synthese.html").read_text(encoding="utf-8")
            verifier("ANCIENNE NOTE" not in note,
                     "la note d'avant est remplacée")
            verifier("1. Résumé de la situation" in note,
                     f"par une note au format courant (obtenu : {note[:60]!r})")
            del reussi, motif
        finally:
            (module_interface.RACINE, module_interface.SUIVI,
             module_interface.PREFERENCES) = anciennes

    # Les messages, eux, ne changent qu'en relançant un export : la page doit
    # le dire, sans quoi on croirait la recherche refaite.
    verifier("ne changent qu'en relançant un export" in module_interface.PAGE,
             "la page distingue refaire les notes de refaire la recherche")


def test_colonnes_du_suivi_a_la_main() -> None:
    """Les intitulés du suivi tenu à la main, tels qu'ils sont écrits."""
    print("\nColonnes du suivi « publipostage »")

    from dossiers import ALIAS_COLONNES, _normaliser_entete  # noqa: PLC0415

    def champ_de(intitule):
        plat = _normaliser_entete(intitule)
        return next((c for c, alias in ALIAS_COLONNES.items() if plat in alias), "")

    attendus = [
        ("Email client sur sellsy", "email"),
        ("Montant reste à charge TTC", "montant_du"),
        ("Chèque de caution", "commentaire"),
        ("Probabilité de récupération", "statut"),
        ("Qualification", "statut"),
        ("Nb d'heure Theorique", "heures_theoriques"),
        ("Heure de Log", "heures_log"),
        ("convention signé ?", "convention_signee"),
        ("Diplome reçu ?", "diplome"),
    ]
    for intitule, champ in attendus:
        obtenu = champ_de(intitule)
        verifier(obtenu == champ,
                 f"« {intitule} » → {champ} (obtenu : {obtenu or 'rien'})")

    # La colonne voisine ne porte pas d'adresses mais des mentions de
    # traitement : la rattacher ferait chercher « Non traité » dans Gmail.
    verifier(champ_de("email gocardless sur gcl") == "",
             f"« email gocardless sur gcl » n'est pas prise pour une adresse "
             f"(obtenu : {champ_de('email gocardless sur gcl') or 'rien'})")

    # Une colonne « Date » ne doit pas devenir une borne de recherche : elle
    # exclurait tout ce qui suit, c'est-à-dire les relances.
    verifier(champ_de("Date") == "",
             f"une colonne « Date » ne borne pas la recherche "
             f"(obtenu : {champ_de('Date') or 'rien'})")

    print("  -- l'étape écrite dans le tableau --")
    import suivi as module_suivi  # noqa: PLC0415

    verifier(champ_de("Passage en contentieux") == "etape",
             "la colonne « Passage en contentieux » est reconnue")
    verifier(champ_de("Montant reçu") == "montant_recu",
             "et « Montant reçu » aussi")

    # Les huit valeurs réelles de la colonne, telles qu'elles sont écrites.
    attendus = [
        ("Transmis au service contentieux", "transmis-contentieux"),
        ("Mise en demeure transmise", "transmission-en-cours"),
        ("à transmettre au service contentieux", "non-transmis"),
        # Cinq motifs différents, un même constat : la voie du contentieux
        # est fermée. Ce n'est pas encore un abandon — la décision n'est pas
        # prise, et la créance reste due entre-temps.
        ("Formation pas faite/peu faite - Ne peut pas passer en contentieux",
         "abandon-possible"),
        ("Montant trop faible - Ne peut pas passer en contentieux",
         "abandon-possible"),
        ("Perdu / Ne peut pas passer en contentieux", "abandon-possible"),
        # Deux espaces dans l'original : la comparaison ne doit pas s'y perdre.
        ("Pas de convention - Ne peut pas passer  en contentieux",
         "abandon-possible"),
        ("Délai de 2 ans dépassé - Ne peut pas passer en contentieux",
         "abandon-possible"),
        ("", ""),
        ("une mention inconnue", ""),
    ]
    for valeur, etape in attendus:
        obtenu = module_suivi.etape_depuis_tableau(valeur)
        verifier(obtenu == etape,
                 f"« {valeur[:44] or '(vide)'} » → {etape or 'rien'} "
                 f"(obtenu : {obtenu or 'rien'})")

    with tempfile.TemporaryDirectory() as repertoire:
        from dossiers import charger_grille  # noqa: PLC0415

        racine = Path(repertoire)
        sortie = racine / "export"
        sortie.mkdir()
        (sortie / "d").mkdir()
        (sortie / "_recapitulatif.csv").write_text(
            "reference;nom;repertoire;factures\n"
            "FACT-2501-07581;Ja REVET;d;FACT-2501-07581\n"
            "FACT-2405-03070;Jihane El gasmi;d;FACT-2405-03070\n",
            encoding="utf-8-sig")
        fichier = racine / "publipostage.csv"
        fichier.write_text(
            "Numero;Client;Passage en contentieux\n"
            "FACT-2501-07581;Ja REVET;"
            "Montant trop faible - Ne peut pas passer en contentieux\n"
            "FACT-2405-03070;Jihane El gasmi;Transmis au service contentieux\n",
            encoding="utf-8-sig")

        chemin = racine / "suivi.json"
        # Une étape posée à la main : elle ne doit pas être écrasée.
        etats = module_suivi.charger(chemin)
        module_suivi.mettre_a_jour(etats, "FACT-2405-03070", statut="avocats")
        module_suivi.enregistrer(chemin, etats)

        bilan = module_suivi.completer_depuis_grille(
            charger_grille(fichier),
            module_suivi.inventaire(sortie, chemin), chemin)
        apres_import = module_suivi.charger(chemin)

        verifier(apres_import["FACT-2501-07581"]["statut"] == "abandon-possible",
                 f"l'étape du tableau est reprise "
                 f"(obtenu : {apres_import['FACT-2501-07581'].get('statut')})")
        verifier("Montant trop faible" in (apres_import["FACT-2501-07581"].get("note") or ""),
                 f"avec le motif, sans lequel un abandon est incompréhensible "
                 f"(obtenu : {apres_import['FACT-2501-07581'].get('note')!r})")
        verifier(apres_import["FACT-2501-07581"].get("historique"),
                 "et l'étape est datée, comme une étape saisie")
        verifier(apres_import["FACT-2405-03070"]["statut"] == "avocats",
                 f"une étape posée à la main n'est jamais écrasée "
                 f"(obtenu : {apres_import['FACT-2405-03070'].get('statut')})")
        verifier(bilan["etapes"] == 1,
                 f"le bilan compte les étapes reprises (obtenu : {bilan['etapes']})")

        # Le tableau évolue : le dossier passe au contentieux. L'étape que le
        # tableau avait posée doit suivre — sinon il faudrait tout ressaisir.
        fichier.write_text(
            "Numero;Client;Passage en contentieux\n"
            "FACT-2501-07581;Ja REVET;Transmis au service contentieux\n"
            "FACT-2405-03070;Jihane El gasmi;Transmis au service contentieux\n",
            encoding="utf-8-sig")
        module_suivi.completer_depuis_grille(
            charger_grille(fichier),
            module_suivi.inventaire(sortie, chemin), chemin)
        suite = module_suivi.charger(chemin)
        verifier(suite["FACT-2501-07581"]["statut"] == "transmis-contentieux",
                 f"une étape venue du tableau se met à jour depuis le tableau "
                 f"(obtenu : {suite['FACT-2501-07581'].get('statut')})")
        verifier(suite["FACT-2405-03070"]["statut"] == "avocats",
                 f"celle posée à la main ne bouge toujours pas "
                 f"(obtenu : {suite['FACT-2405-03070'].get('statut')})")
        verifier(len(suite["FACT-2501-07581"].get("historique") or []) == 2,
                 f"le passage d'une étape à l'autre est daté "
                 f"(obtenu : {suite['FACT-2501-07581'].get('historique')})")


def test_extrait_zoho_de_bout_en_bout() -> None:
    """Un extrait Zoho seul suffit à faire chercher les anciens numéros."""
    print("\nExtrait Zoho : de l'import à la requête Gmail")

    import suivi as module_suivi  # noqa: PLC0415
    from dossiers import Dossier, charger_grille  # noqa: PLC0415
    from export_mails import _ajouter_references_saisies  # noqa: PLC0415

    with tempfile.TemporaryDirectory() as repertoire:
        racine = Path(repertoire)
        sortie = racine / "export"
        sortie.mkdir()
        (sortie / "d").mkdir()
        # Les dossiers tels que Monday les donne : numéro Sellsy, montant HT.
        (sortie / "_recapitulatif.csv").write_text(
            "reference;nom;repertoire;montant_du;factures;date_echeance\n"
            "FACT-2405-00409;SAS EDEN;d;5 990 €;FACT-2405-00409;30/05/2024\n"
            "FACT-2406-03723;Serruya Aaron;d;5 100 €;FACT-2406-03723;21/05/2024\n"
            "FACT-9999-00000;AUTRE SARL;d;1 234 €;FACT-9999-00000;\n",
            encoding="utf-8-sig")

        # L'extrait Zoho, aux intitulés de l'outil et aux valeurs réelles.
        extrait = racine / "Factures_Zoho_impayees.csv"
        extrait.write_text(
            "N° de facture;Nom du client;Statut de la facture;"
            "Montant de la facture;Solde;Date d\u2019échéance;E-mail;"
            "Facture sellsy correspondante\n"
            # Rien en face côté Sellsy, et 7 188 TTC contre 5 990 HT.
            "DV-003453;SAS EDEN;En retard;7188;7188;2024-05-30;;\n"
            # Le numéro Sellsy est renseigné : rapprochement direct.
            "FA-550-3689-2;Serruya Aaron;En retard;5100;5100;2024-05-21;"
            "aaronserruya3105@gmail.com;FACT-2406-03723\n"
            # Soldée : elle ne doit rapprocher personne.
            "DV-009999;AUTRE SARL;Payé;1234;0;2023-01-01;;\n",
            encoding="utf-8-sig")

        suivi = racine / "suivi.json"
        bilan = module_suivi.completer_depuis_grille(
            charger_grille(extrait),
            module_suivi.inventaire(sortie, suivi),
            suivi)
        etats = module_suivi.charger(suivi)

        verifier(etats.get("FACT-2405-00409", {}).get("references")
                 == ["DV-003453"],
                 f"le numéro Zoho rejoint le dossier malgré l'écart de TVA "
                 f"(obtenu : {etats.get('FACT-2405-00409', {}).get('references')})")
        verifier(etats.get("FACT-2406-03723", {}).get("references")
                 == ["FA-550-3689-2"],
                 "et par la colonne « Facture sellsy correspondante » quand "
                 "elle est renseignée")
        verifier(etats.get("FACT-2406-03723", {}).get("adresses")
                 == ["aaronserruya3105@gmail.com"],
                 "l'adresse de l'extrait suit")
        verifier("FACT-9999-00000" not in etats,
                 f"une facture soldée ne rapproche personne "
                 f"(obtenu : {sorted(etats)})")
        verifier(bilan["dossiers"] == 2,
                 f"deux dossiers complétés (obtenu : {bilan['dossiers']})")

        # Les numéros saisis rejoignent la recherche du prochain export.
        lot = [Dossier(reference="FACT-2405-00409", nom="SAS EDEN",
                       factures=["FACT-2405-00409"],
                       emails=["sufyen.b@gmail.com"],
                       colonnes={"entreprise": "SAS EDEN",
                                 "nom prenom de l apprenant": "Benallaoua Sofiane"})]
        _ajouter_references_saisies(lot, lambda _l: None, suivi)
        verifier(lot[0].factures == ["FACT-2405-00409", "DV-003453"],
                 f"le dossier cherche les deux numéros "
                 f"(obtenu : {lot[0].factures})")

        requete = lot[0].requete_gmail()
        for terme in ('"FACT-2405-00409"', '"DV-003453"',
                      'filename:"DV-003453"', '"Benallaoua Sofiane"',
                      'from:sufyen.b@gmail.com'):
            verifier(terme in requete,
                     f"la requête Gmail porte {terme}")


def test_fils_completes() -> None:
    """Un fil dont un seul message cite le numéro est repris en entier."""
    print("\nConversations reprises en entier")

    import export_mails  # noqa: PLC0415
    from gmail_api import SourcesGmail  # noqa: PLC0415

    # Le cas réel du dossier SAS EDEN : la facture part avec le numéro en
    # objet, l'entreprise répond sur un autre objet et sans le numéro, et
    # c'est cette réponse-là qui conteste la signature du devis.
    class ClientFil:
        adresse_boite = "billing@liora.io"

        MESSAGES = {
            "m1": {
                "id": "m1", "threadId": "T1",
                "objet": "Facture FACT-2405-00409 - formation",
                "de": "billing@liora.io", "a": "edenmarket2017@gmail.com",
                "texte": "Veuillez trouver la facture FACT-2405-00409.",
            },
            "m2": {
                "id": "m2", "threadId": "T1",
                "objet": "Re: Formation Benallaoua sofiane",
                "de": "edenmarket2017@gmail.com", "a": "billing@liora.io",
                "texte": "La signature sur le devis ne correspond pas a la mienne.",
            },
            "m3": {
                "id": "m3", "threadId": "T2",
                "objet": "Sans rapport", "de": "x@ailleurs.fr",
                "a": "billing@liora.io", "texte": "Bonjour.",
            },
        }

        def rechercher_identifiants(self, requete, inclure_spam_corbeille=True,
                                    plafond=None):
            # Seul m1 porte le numéro : c'est tout ce que Gmail rendrait.
            return ["m1"] if "FACT-2405-00409" in requete else []

        def identifiants_des_fils(self, fils, inclure_spam_corbeille=True):
            return [m["id"] for m in self.MESSAGES.values()
                    if m["threadId"] in set(fils)]

        def recuperer_messages(self, identifiants):
            from message import MessageMail  # noqa: PLC0415
            rendus = []
            for identifiant in identifiants:
                donnees = self.MESSAGES[identifiant]
                rendus.append(MessageMail(
                    id=donnees["id"], thread_id=donnees["threadId"],
                    date=datetime(2025, 10, 30, 12, tzinfo=timezone.utc),
                    expediteur=donnees["de"], destinataires=donnees["a"],
                    copie="", copie_cachee="", objet=donnees["objet"],
                    corps_texte=donnees["texte"], corps_html="",
                    pieces_jointes=[], boites=[self.adresse_boite],
                    message_id=f"<{identifiant}@exemple>",
                ))
            return rendus

    sources = SourcesGmail([ClientFil()])
    vraies = export_mails.ouvrir_sources
    export_mails.ouvrir_sources = lambda **_: sources
    try:
        with tempfile.TemporaryDirectory() as repertoire:
            racine = Path(repertoire)
            fichier = racine / "dossiers.csv"
            fichier.write_text(
                "reference;nom;facture\nEDEN;SAS EDEN;FACT-2405-00409\n",
                encoding="utf-8")
            sortie = racine / "export"
            journal: list[str] = []
            code = export_mails.executer(
                export_mails.analyser_arguments([
                    "--dossiers", str(fichier), "--sortie", str(sortie),
                    "--sans-decouverte-adresses",
                ]),
                relais=journal.append)
            verifier(code == 0, "code de sortie 0")

            repertoires = sorted(c.name for c in sortie.iterdir() if c.is_dir())
            verifier(len(repertoires) == 1,
                     f"un répertoire pour le dossier (obtenu : {repertoires})")
            index = _lire_index(sortie / repertoires[0] / "index.csv")
            objets = [ligne["objet"] for ligne in index]
            verifier(len(index) == 2,
                     f"les deux messages du fil sont au dossier "
                     f"(obtenu : {len(index)} — {objets})")
            verifier(any("Benallaoua" in objet for objet in objets),
                     f"dont la réponse qui ne cite aucun numéro (obtenu : {objets})")
            verifier(not any("Sans rapport" in objet for objet in objets),
                     "et rien d'un fil que rien ne rattachait au dossier")
            verifier(any("en suivant les conversations" in ligne
                         for ligne in journal),
                     f"le journal dit ce qui a été ajouté "
                     f"(obtenu : {[l for l in journal if 'message' in l][:3]})")

            # L'option existe pour s'en passer, et alors le fil n'est pas suivi.
            sortie2 = racine / "export2"
            export_mails.executer(
                export_mails.analyser_arguments([
                    "--dossiers", str(fichier), "--sortie", str(sortie2),
                    "--sans-decouverte-adresses", "--sans-fils-complets",
                ]),
                relais=lambda _l: None)
            dossier2 = next(c for c in sortie2.iterdir() if c.is_dir())
            seul = _lire_index(dossier2 / "index.csv")
            verifier(len(seul) == 1,
                     f"sans l'option, seul le message trouvé est repris "
                     f"(obtenu : {len(seul)})")
    finally:
        export_mails.ouvrir_sources = vraies


def test_note_interne_au_propre() -> None:
    """Une note de tableau écrite par ajouts, rendue lisible."""
    print("\nMise au propre de la note interne")

    import synthese as module_synthese  # noqa: PLC0415

    # La note réelle d'un dossier : des entrées empilées, séparées par des
    # tirets, et deux collées l'une à l'autre faute de séparateur.
    note = ("relance mail - demande de l'apc, celui-ci n'a pas été retrouvé "
            "chez l'opcommerce - devis a été signé par l'apprenant - pas de "
            "convention - pièce d'identité du proprio de eden pour preuve - "
            "doit être payé par l'apprenantrelance faite - dit que c l'opco "
            "qui devait regul, en attente d'un retour de sa part - relance faite")
    entrees = module_synthese.mettre_au_propre(note)

    verifier(len(entrees) == 9,
             f"chaque intervention fait sa ligne (obtenu : {len(entrees)})")
    verifier(entrees[0] == "Relance mail.",
             f"majuscule et point final (obtenu : {entrees[0]!r})")
    verifier("Doit être payé par l'apprenant." in entrees,
             f"deux entrées collées sont séparées (obtenu : {entrees})")
    verifier("Relance faite." in entrees,
             "et la seconde retrouve son sens")

    # Rien n'est réécrit : la note reste opposable telle qu'elle a été tenue.
    recompose = " ".join(entrees).lower()
    for mot in ("opcommerce", "opco", "regul", "proprio", "apc"):
        verifier(mot in recompose,
                 f"« {mot} » est conservé tel quel, sans correction")

    verifier(module_synthese.mettre_au_propre("") == [],
             "une note vide ne produit rien")
    verifier(module_synthese.mettre_au_propre("relance faite") == ["Relance faite."],
             "une note d'une seule ligne traverse sans dommage")

    # Un mot ordinaire ne doit pas être coupé au milieu sous prétexte qu'il
    # contient une formule d'ouverture.
    verifier(module_synthese.mettre_au_propre("montant relancé le 3") ==
             ["Montant relancé le 3."],
             f"aucune coupure au milieu d'une phrase ordinaire (obtenu : "
             f"{module_synthese.mettre_au_propre('montant relancé le 3')})")


def test_contexte_saisi() -> None:
    """Ce que le service sait et qu'aucun tableau ne porte."""
    print("\nContexte saisi à la main")

    import suivi as module_suivi  # noqa: PLC0415

    print("  -- le contexte saisi se conserve --")
    with tempfile.TemporaryDirectory() as repertoire:
        chemin = Path(repertoire) / "suivi.json"
        etats = module_suivi.charger(chemin)
        module_suivi.mettre_a_jour(
            etats, "FACT-1",
            contexte="Il ne répond pas au téléphone. Chèque de caution rejeté",
        )
        module_suivi.enregistrer(chemin, etats)
        relu = module_suivi.charger(chemin)["FACT-1"]
        verifier(relu["contexte"].startswith("Il ne répond pas"),
                 f"le contexte est enregistré (obtenu : {relu.get('contexte')!r})")

        # Une chaîne vide l'efface, comme les autres saisies : elle ne vaut
        # pas « pas de contexte connu ».
        module_suivi.mettre_a_jour(etats, "FACT-1", contexte="")
        verifier("contexte" not in etats["FACT-1"],
                 "et une saisie vidée le retire plutôt que de garder l'ancien")


def test_recherche_dossiers() -> None:
    """Retrouver un dossier par sa facture, son adresse ou son nom."""
    print("\nRecherche dans les dossiers")

    import interface as module_interface  # noqa: PLC0415

    page = module_interface.PAGE

    # La recherche est portée par la page, pas par le serveur : elle doit
    # donc s'y trouver en entier, et chaque morceau est vérifié nommément —
    # une insertion ratée dans le gabarit ne se voit pas à l'exécution.
    for morceau, quoi in (
        ("function dossiersFiltres", "le filtre"),
        ("function correspond", "la comparaison d'un dossier au terme"),
        ("function reduireNumero", "la comparaison des numéros sans ponctuation"),
        ("dossier.factures", "la recherche porte sur les factures"),
        ("dossier.emails", "et sur les adresses du tableau"),
        ("dossier.adresses", "et sur celles reprises de la facturation"),
        ("dossier.references", "et sur les numéros d'un outil précédent"),
        ("dossier.nom", "et sur le nom du débiteur"),
        ("majCompteRecherche", "le décompte des dossiers retenus"),
        ("messageAucuneCorrespondance", "le message quand rien ne correspond"),
        ("chercherDossiers", "la saisie relie les deux onglets"),
    ):
        verifier(morceau in page, f"{quoi} figure dans la page ({morceau})")

    # Les deux onglets partagent un même terme : trouver un dossier dans l'un
    # puis passer à l'autre est le geste courant.
    verifier(page.count('placeholder="Facture, adresse mail, nom…"') == 2,
             "les deux onglets portent une barre de recherche")
    verifier("rendreSuivi();" in page and "rendreDocuments();" in page,
             "et la saisie redessine les deux")

    # « Tout effacer » porte sur tous les dossiers, filtre ou non : le taire
    # laisserait croire qu'il ne retire que ce qui est affiché.
    verifier("Une recherche est en cours" in page,
             "« Tout effacer » avertit qu'il ignore le filtre")


def test_resume_de_situation() -> None:
    """La note s'ouvre sur la situation, et renvoie les échanges en annexe."""
    print("\nRésumé de la situation et annexe")

    import synthese as module_synthese  # noqa: PLC0415
    from dataclasses import replace  # noqa: PLC0415
    from dossiers import Dossier  # noqa: PLC0415
    from indexation import LigneIndex  # noqa: PLC0415

    maintenant = datetime(2026, 9, 4, tzinfo=timezone.utc)

    def piece(n, mois, jour, sens, objet, pj=0):
        return LigneIndex(
            piece_n=n, date=datetime(2024, mois, jour, 9, tzinfo=timezone.utc),
            sens=sens, expediteur="debiteur@exemple.fr" if sens == "reçu"
            else "recouvrement@liora.io",
            destinataires="x@y.fr", copie="", objet=objet,
            nb_pieces_jointes=pj, pieces_jointes="facture.pdf" if pj else "",
            critere="FACT-2406-03723", boites="recouvrement@liora.io",
            fichier_pdf="", fichier_eml=f"p{n}.eml",
            dossier_pieces_jointes="", thread_id="t1", message_id=f"<m{n}>")

    dossier = Dossier(
        reference="FACT-2406-03723", nom="SAS EDEN",
        emails=["client@exemple.fr"],
        factures=["FACT-2406-03723", "DV-003453"],
        montant_du="5 990 €", date_echeance="21/05/2024",
        convention_signee="oui", diplome="non",
    )
    lignes = [
        piece(1, 5, 22, "envoyé", "Facture FACT-2406-03723 - relance", 1),
        piece(2, 6, 10, "reçu", "RE: Facture FACT-2406-03723 - relance"),
        piece(3, 9, 3, "envoyé", "Mise en demeure - FACT-2406-03723"),
    ]
    textes = {
        1: "Sauf erreur, la facture reste impayee.",
        2: "Je conteste le montant : la formation n'a pas ete suivie.",
        3: "Mise en demeure de payer sous huit jours.",
    }
    synthese = module_synthese.analyser(lignes, textes)
    points = module_synthese.resumer_situation(
        dossier, synthese, maintenant, lignes=lignes)
    par_titre = dict(points)

    verifier([titre for titre, _ in points] == [
        "Montant", "Contexte", "Contrat signé et factures",
        "Preuve des actions engagées"],
        f"les quatre points du service, dans leur ordre "
        f"(obtenu : {[t for t, _ in points]})")

    verifier("5 990" in par_titre["Montant"]
             and "jours de retard" in par_titre["Montant"],
             f"1. le montant et son retard (obtenu : {par_titre['Montant']})")

    # 2. Le contexte se lit d'un trait : c'est le point que lit d'abord celui
    # qui recoit le dossier.
    contexte = par_titre["Contexte"]
    print(f"     contexte obtenu : {contexte}")
    verifier(contexte.startswith("La formation a été suivie"),
             f"2. le récit s'ouvre sur l'exécution de la formation "
             f"(obtenu : {contexte[:90]})")
    verifier("le diplôme n'a pas été délivré" in contexte,
             "et dit ce qu'il en est du diplôme")
    # SAS EDEN est une société : c'est elle qui doit, pas l'apprenant. Écrire
    # « L'apprenant n'a pas payé » désignerait la mauvaise partie, et devant
    # un tribunal c'est l'employeur qui est assigné.
    verifier("SAS EDEN n'a pas payé" in contexte and "5 990" in contexte,
             f"puis le défaut de paiement, imputé au débiteur qui doit "
             f"(obtenu : {contexte[90:200]})")
    verifier("L'apprenant n'a pas payé" not in contexte,
             "et jamais à l'apprenant sur une facture d'entreprise")

    # Sur un dossier de particulier, l'apprenant est le débiteur, et le récit
    # doit le dire ainsi.
    particulier = dict(module_synthese.resumer_situation(
        replace(dossier, nom="Benallaoua Sofiane"), synthese, maintenant))["Contexte"]
    verifier("L'apprenant a suivi la formation" in particulier
             and "Il n'a pas payé" in particulier,
             f"un particulier reste « l'apprenant » (obtenu : {particulier[:110]})")
    verifier("malgré une relance" in contexte or "malgré 2 relance" in contexte,
             f"et ce qui a été tenté (obtenu : {contexte[:200]})")
    verifier("conteste le montant depuis le 10/06/2024" in contexte,
             "l'attitude du débiteur est rapportée, datée")
    verifier("mise en demeure lui a été adressée le 03/09/2024" in contexte,
             "et le dossier situé à sa dernière étape")
    verifier(". " in contexte and not contexte.startswith("•"),
             "le tout en phrases, pas en liste")

    verifier("voir pièces jointes" in par_titre["Contrat signé et factures"],
             f"3. renvoie aux pièces "
             f"(obtenu : {par_titre['Contrat signé et factures']})")
    verifier("relance" in par_titre["Preuve des actions engagées"],
             f"4. compte les actions engagées "
             f"(obtenu : {par_titre['Preuve des actions engagées']})")

    # Un paiement revenu impayé est le fait le plus parlant du dossier : il
    # doit figurer au contexte comme à la preuve des actions.
    lignes_rejet = [*lignes, piece(4, 10, 2, "reçu", "Prélèvement rejeté")]
    textes_rejet = {**textes, 4: "Votre prelevement a ete rejete faute de provision."}
    avec_rejet = dict(module_synthese.resumer_situation(
        dossier, module_synthese.analyser(lignes_rejet, textes_rejet), maintenant))
    verifier("rejeté" in avec_rejet["Contexte"],
             f"un paiement rejeté figure au contexte "
             f"(obtenu : {avec_rejet['Contexte'][-170:]})")
    verifier("Paiements refusés" in avec_rejet["Preuve des actions engagées"],
             f"et les paiements refusés sont listés au point 4 "
             f"(obtenu : {avec_rejet['Preuve des actions engagées']})")

    # Ce que l'outil ne peut pas savoir — appels téléphoniques, chèque de
    # caution — est saisi dans l'application et repris tel quel.
    dossier_saisi = replace(
        dossier,
        contexte="Il ne répond pas au téléphone. Son chèque de caution a été "
                 "encaissé puis rejeté",
    )
    complete = dict(module_synthese.resumer_situation(
        dossier_saisi, synthese, maintenant))["Contexte"]
    verifier("Il ne répond pas au téléphone." in complete,
             f"le contexte saisi rejoint le récit (obtenu : {complete[-140:]})")
    verifier(complete.rstrip().endswith("rejeté."),
             "et se termine proprement, point final ajouté au besoin")

    # Un dossier vide ne doit rien affirmer.
    vide = dict(module_synthese.resumer_situation(
        Dossier(reference="D1", nom="Sans rien", emails=[]),
        module_synthese.analyser([], {}), maintenant))
    verifier("non renseigné" in vide["Montant"],
             f"sans montant, le point 1 le dit (obtenu : {vide['Montant']})")
    verifier("aucune pièce au dossier" in vide["Contrat signé et factures"],
             "sans pièce, le point 3 le dit")
    verifier("aucun message retrouvé" in vide["Preuve des actions engagées"],
             f"sans message, le point 4 ne prétend aucune relance "
             f"(obtenu : {vide['Preuve des actions engagées']})")

    html_note = module_synthese.construire_html(
        dossier, ["recouvrement@liora.io"], lignes, synthese, maintenant,
        textes=textes,
    )
    verifier("1. Résumé de la situation" in html_note,
             "la note s'ouvre sur le résumé")
    for rang, titre in enumerate(
            ("1. Résumé de la situation", "2. Détail du dossier",
             "3. Contrat signé et factures", "4. Preuve des actions engagées",
             "Annexe — Conversations"), start=1):
        verifier(titre in html_note, f"partie {rang} présente : {titre}")

    # Les échanges passent en annexe : le corps de la note se transmet seul.
    rang_annexe = html_note.find("Annexe — Conversations")
    for bloc in ("Suite des échanges", "Réponses du débiteur"):
        verifier(html_note.find(bloc) > rang_annexe,
                 f"« {bloc} » est reporté en annexe")
    # La chronologie faisait doublon avec les événements repérés, juste avant.
    verifier("Chronologie complète" not in html_note,
             "la chronologie ne figure plus : les événements la précèdent déjà")
    verifier(html_note.find("Événements repérés") < rang_annexe,
             "tandis que les événements repérés restent dans le corps")
    verifier("page-break-before" in html_note,
             "et l'annexe commence sur une nouvelle page à l'impression")


def test_reponses_du_debiteur() -> None:
    """Ce que le débiteur a répondu, cité tel quel et daté."""
    print("\nRéponses du débiteur dans la note")

    import synthese as module_synthese  # noqa: PLC0415

    # L'historique cité en fin de réponse ne doit pas être repris : il ferait
    # citer nos propres relances comme si le débiteur les avait écrites.
    extrait = module_synthese._extrait_lisible(
        "Bonjour,\nJe conteste le montant reclame.\n\nCordialement\n\n"
        "Le 03/03/2025, recouvrement@liora.io a ecrit :\n"
        "> Votre facture est echue depuis trois mois"
    )
    verifier("conteste le montant" in extrait, "le propos du débiteur est repris")
    verifier("facture est echue" not in extrait,
             "l'historique cité en réponse ne l'est pas")
    verifier("Cordialement" not in extrait, "ni la formule de politesse")

    # Beaucoup de messages n'ont aucune version texte : les citer sans les
    # depouiller ferait figurer « <meta http-equiv » dans la note.
    depouille = module_synthese._extrait_lisible(
        '<html><head><meta http-equiv="content-type" content="text/html"></head>'
        '<body dir="auto"><div dir="ltr">Bonjour</div>'
        '<div dir="ltr">Je n&#39;ai pas fait la formation.</div>'
        '<div dir="ltr"><br><blockquote type="cite">Le 10 nov. 2025, '
        'Recouvrement a ecrit : votre facture est echue</blockquote></div>'
        "</body></html>"
    )
    verifier("Je n'ai pas fait la formation." in depouille,
             f"le propos est extrait du HTML (obtenu : {depouille!r})")
    verifier("<" not in depouille and "http-equiv" not in depouille,
             "et aucune balise n'y subsiste")
    verifier("votre facture est echue" not in depouille,
             "la citation du fil, en blockquote, est écartée")

    # Un message sans balise n'a pas a passer par le depouillement.
    verifier(module_synthese._extrait_lisible("Je conteste. 5 < 10 euros dus.")
             == "Je conteste. 5 < 10 euros dus.",
             "un texte contenant « < » n'est pas pris pour du HTML")

    verifier(module_synthese._extrait_lisible("") == "",
             "un message sans texte ne produit aucun extrait")
    long = module_synthese._extrait_lisible("mot " * 400)
    verifier(len(long) <= module_synthese.LONGUEUR_EXTRAIT + 1 and long.endswith("…"),
             f"un long message est coupé et le signale (obtenu : {len(long)})")

    def ligne(n, sens, exp):
        return LigneIndex(
            piece_n=n, date=datetime(2025, 3, n, 10, 0, tzinfo=timezone(timedelta(hours=1))),
            sens=sens, expediteur=exp, destinataires="x@y.fr", copie="",
            objet=f"Message {n}", nb_pieces_jointes=0, pieces_jointes="",
            critere="adresse", boites="recouvrement@liora.io", fichier_pdf="",
            fichier_eml="", dossier_pieces_jointes="", thread_id="t",
            message_id=f"<m{n}>")

    bloc = module_synthese._bloc_reponses(
        [ligne(1, "envoyé", "recouvrement@liora.io"),
         ligne(2, "reçu", "debiteur@exemple.fr")],
        {2: "Je conteste le montant."},
    )
    verifier("une réponse du débiteur figure" in bloc,
             f"seules les réponses reçues sont comptées, et accordées "
             f"(obtenu : {bloc[:70]!r})")
    verifier("debiteur@exemple.fr" in bloc,
             "l'auteur de la réponse figure")
    # Le propos est cité plus haut, à sa place dans la conversation : le
    # répéter ici ferait lire deux fois la même chose.
    verifier("Je conteste le montant." not in bloc,
             "et non son propos, déjà cité dans la conversation")
    verifier("citées plus haut" in bloc or "citée plus haut" in bloc,
             f"le tableau dit où le lire (obtenu : {bloc[:130]!r})")
    verifier("recouvrement@liora.io" not in bloc,
             "nos propres envois ne figurent pas parmi les réponses")

    muet = module_synthese._bloc_reponses(
        [ligne(1, "envoyé", "recouvrement@liora.io")], {})
    verifier("Aucune réponse du débiteur" in muet,
             "l'absence de réponse est dite, et non passée sous silence")


def test_conversations_resumees() -> None:
    """Les échanges d'un même fil, regroupés et résumés."""
    print("\nConversations suivies")

    import synthese as module_synthese  # noqa: PLC0415

    def ligne(n, jour, sens, fil, objet="Facture FACT-1"):
        return LigneIndex(
            piece_n=n,
            date=datetime(2025, 3, jour, 10, 0, tzinfo=timezone(timedelta(hours=1))),
            sens=sens,
            expediteur="a@b.fr" if sens == "reçu" else "recouvrement@liora.io",
            destinataires="x@y.fr", copie="", objet=objet, nb_pieces_jointes=0,
            pieces_jointes="", critere="adresse", boites="recouvrement@liora.io",
            fichier_pdf="", fichier_eml="", dossier_pieces_jointes="",
            thread_id=fil, message_id=f"<m{n}>")

    lignes = [
        ligne(1, 3, "envoyé", "T1"),
        ligne(2, 8, "reçu", "T1"),
        ligne(3, 14, "envoyé", "T1"),
        # Un fil sans réponse : il compte quand même comme conversation.
        ligne(4, 20, "envoyé", "T2", "Mise en demeure"),
        ligne(5, 22, "envoyé", "T2", "Mise en demeure"),
        # Un message isolé n'est pas une conversation.
        ligne(6, 25, "envoyé", "T3", "Pour information"),
    ]
    textes = {2: "Je conteste le montant reclame."}

    bloc = module_synthese._bloc_conversations(lignes, textes)
    # L'annexe remplace la chronologie : elle ne doit rien laisser de côté,
    # pas même un message isolé qui ne forme pas vraiment un fil.
    verifier("3 conversations figurent" in bloc,
             f"toutes les conversations figurent, isolés compris "
             f"(obtenu : {bloc[:70]!r})")
    verifier("Pour information" in bloc,
             "le message isolé n'est plus perdu")
    verifier("Message unique du 25/03/2025" in bloc,
             f"et se présente comme tel (obtenu : "
             f"{bloc[bloc.find('Pour information'):][:90]!r})")
    verifier("3 messages du 03/03/2025 au 14/03/2025" in bloc,
             "le fil est daté de bout en bout")
    verifier("soit 11 jours" in bloc, "et sa durée donnée")
    verifier("Pièces n° 1 à n° 3" in bloc,
             "les pièces du fil sont citées par leur numéro")
    verifier("2 émis par Liora, 1 reçu." in bloc,
             f"le sens est compté, au singulier quand il n'y en a qu'un "
             f"(obtenu : {bloc[bloc.find('émis par Liora') - 20:][:60]!r})")
    verifier("Je conteste le montant reclame." in bloc,
             "le propos du débiteur est cité à sa place dans le fil")
    verifier("2 émis par Liora, 0 reçu." in bloc,
             f"un fil resté sans réponse se lit à son décompte "
             f"(obtenu : {bloc[bloc.find('Mise en demeure'):][:120]!r})")

    # Chaque message a sa ligne, avec sa date et son sens : c'est ce qui
    # permet de retirer la chronologie sans rien perdre.
    for numero in range(1, 7):
        verifier(f"pièce n° {numero} ·" in bloc,
                 f"la pièce n° {numero} figure dans l'annexe")

    verifier(module_synthese._bloc_conversations([], {}) == "",
             "sans échange, aucun bloc n'est produit")
    verifier(module_synthese._bloc_avec_titre("Conversations", "") == "",
             "un titre qui n'annoncerait rien est tu")


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
        # Le suivi saisi à la main ne part pas avec la ligne de la liste : il
        # ne se refait pas, et un dossier retiré par erreur le retrouve.
        verifier("FACT-1" in module_suivi.charger(chemin_suivi),
                 "son état de suivi est gardé, la liste seule a changé")
        verifier(module_suivi.supprimer(
                     sortie, chemin_suivi, ["FACT-1"], avec_suivi=True
                 )["oublies"] == 1,
                 "et ne s'oublie que si on le demande")
        verifier("FACT-1" not in module_suivi.charger(chemin_suivi),
                 "alors seulement il est retiré")
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
        verifier("Export contentieux" in page, "la page est servie")

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
            ('id="chercheSuivi"', "recherche dans l'état des dossiers"),
            ('id="refaireNotes"', "bouton de réécriture des notes"),
            ('data-champ="contexte"', "saisie du contexte d'un dossier"),
            ('id="chercheDocuments"', "recherche dans les documents"),
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

        print("  -- l'annuaire se consulte tout seul --")
        # Interroge sans resultat, un debiteur doit etre memorise comme tel :
        # sans quoi il serait redemande a chaque ouverture, indefiniment.
        verifier("consulterAnnuaireSiBesoin()" in page,
                 "la page consulte l'annuaire pour les débiteurs inconnus")
        verifier("annuaire_manquants" in page,
                 "et sait lesquels n'ont jamais été interrogés")
        verifier("_consulter_annuaire" in Path(interface.__file__).read_text(
                     encoding="utf-8"),
                 "la fin d'un export le consulte aussi")
        statut, dossiers = appeler("/api/dossiers")
        verifier("annuaire_manquants" in dossiers and "entreprises" in dossiers,
                 "la liste porte le décompte et la répartition par forme")

        print("  -- le fichier de suivi est retenu, puis réappliqué --")
        # Deposé une fois, il doit servir aux exports suivants sans qu'on ait
        # à le redéposer : c'est la seule façon qu'il serve vraiment.
        avant_complement = interface.lire_preferences()
        temoins = {c.name for c in interface.complements_memorises()}
        try:
            contenu = (
                "Numero;convention signé ?;Diplome reçu ?\n"
                "FACT-9999-99999;oui;non\n"
            ).encode("utf-8")
            statut, reponse = appeler("/api/completer", {
                "nom": "suivi_btc.csv",
                "contenu": base64.b64encode(contenu).decode("ascii"),
            })
            verifier(reponse.get("memorise") == "suivi_btc.csv",
                     "le dépôt annonce que le fichier est retenu")
            retenu = interface.complement_memorise()
            verifier(retenu is not None and retenu.exists(),
                     "le fichier est conservé à côté de l'outil")
            verifier(retenu.name.startswith("suivi_btc"),
                     f"sous son propre nom, reconnaissable ({retenu.name})")
            verifier(retenu.name in
                     (interface.lire_preferences().get("complements") or []),
                     "et son nom est mémorisé")

            page_retenue = urllib.request.urlopen(
                f"{base}/", timeout=10).read().decode("utf-8")
            verifier("réappliqué" in page_retenue,
                     "la page le dit, plutôt que de laisser redéposer à l'aveugle")

            # La facturation est répartie sur deux outils : Zoho porte les
            # numéros d'origine, Sellsy les adresses, et un dossier n'est
            # complet qu'avec les deux. Un second fichier s'ajoute au premier.
            statut, seconde = appeler("/api/completer", {
                "nom": "factures_zoho.csv",
                "contenu": base64.b64encode(contenu).decode("ascii"),
            })
            noms = [c.name for c in interface.complements_memorises()
                    if c.name not in temoins]
            verifier(len(noms) == 2,
                     f"les deux fichiers sont retenus ensemble ({noms})")
            verifier(sorted(seconde.get("retenus") or [])[-1].startswith("suivi"),
                     f"et le dépôt les annonce tous "
                     f"(obtenu : {seconde.get('retenus')})")

            # Redéposer le même nom le met à jour, sans en faire un doublon.
            appeler("/api/completer", {
                "nom": "factures_zoho.csv",
                "contenu": base64.b64encode(contenu).decode("ascii"),
            })
            noms = [c.name for c in interface.complements_memorises()
                    if c.name not in temoins]
            verifier(len(noms) == 2,
                     f"un fichier du même nom remplace le sien ({noms})")

            # Un fichier déposé engageait pour de bon : il était réappliqué
            # après chaque export sans qu'aucun moyen ne permette d'y
            # renoncer. C'est le contraire d'un outil qu'on maîtrise.
            page_retenue = urllib.request.urlopen(
                f"{base}/", timeout=10).read().decode("utf-8")
            verifier('id="oublierComplements"' in page_retenue,
                     "la page offre de les oublier")
            verifier("factures_zoho.csv" in page_retenue,
                     "en nommant ce qui est retenu")

            statut, oubli = appeler("/api/oublier-complements", {})
            verifier(len(oubli.get("oublies") or []) >= 2,
                     f"les fichiers sont retirés (obtenu : {oubli.get('oublies')})")
            verifier(interface.complements_memorises() == [],
                     "plus rien n'est retenu")
            verifier(not (interface.lire_preferences().get("complements") or []),
                     "ni mémorisé dans les préférences")

            # Le suivi livré avec l'application n'a pas été déposé : il fait
            # partie de l'installation. L'oubli cessait de le lire *et*
            # l'effaçait, si bien qu'une remise à zéro le perdait pour de bon
            # et qu'il fallait réinstaller l'outil pour le retrouver.
            verifier(interface.SUIVI_INITIAL.exists(),
                     "oublier n'efface pas le suivi livré avec l'application")

            # Ce qu'ils ont déjà écrit dans le suivi reste : l'échéance d'un
            # dossier lui appartient une fois reprise.
            statut, encore = appeler("/api/oublier-complements", {})
            verifier(encore.get("oublies") == [],
                     "oublier deux fois de suite ne casse rien")
        finally:
            for reste in interface.complements_memorises():
                if reste.name not in temoins:
                    reste.unlink(missing_ok=True)
            interface.ecrire_preferences(avant_complement)

        # Un format non pris en charge est refusé, sans rien retenir.
        try:
            appeler("/api/completer", {"nom": "suivi.docx", "contenu": "eA=="})
            verifier(False, "format non pris en charge refusé")
        except urllib.error.HTTPError as exc:
            verifier(exc.code == 400, f"format non pris en charge refusé ({exc.code})")

        print("  -- la page sait reprendre un export en cours --")
        # Un export tourne dans l'outil, pas dans la page : recharger celle-ci
        # ne l'interrompt pas, mais l'écran restait muet et l'export passait
        # pour arrêté.
        verifier("reprendreSuiviEnCours()" in page,
                 "la page interroge l'outil au chargement")
        verifier('id="exportEnCours"' in page and "majBandeauExport" in page,
                 "le tableau de bord annonce qu'un export reconstruit la liste")
        verifier("en_cours" in page,
                 "et sait distinguer un export en cours d'un export fini")
        statut, journal_vide = appeler("/api/journal?depuis=0")
        verifier("en_cours" in journal_vide,
                 "le journal annonce si un export tourne")

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
            {"mode": "monday", "tableau": "42", "sous_elements": True,
             "filtre_colonne": "Etape process recouvrement",
             "filtre_valeur": "contentieux"},
            Path("dossiers.csv"),
        )
        verifier("--avec-sous-elements" in args,
                 "la case des sous-éléments atteint la ligne de commande")
        verifier("--tableau-monday" in args and "--filtre-colonne" in args,
                 "le tableau et son filtre l'atteignent aussi")
        sans, _ = interface.construire_arguments(
            {"mode": "monday", "tableau": "42"}, Path("d.csv"))
        verifier("--avec-sous-elements" not in sans,
                 "décochée, elle n'ajoute rien")

        # La page envoie toujours tout ce qu'elle a sous la main. Une recherche
        # ponctuelle emportait le tableau coché la veille, et l'export repartait
        # lire Monday au lieu de chercher la seule facture demandée.
        ponctuel, _ = interface.construire_arguments(
            {"mode": "manuel", "tableau": "42", "groupes": "topics"},
            Path("d.csv"))
        verifier("--tableau-monday" not in ponctuel
                 and "--groupes-monday" not in ponctuel,
                 f"une recherche ponctuelle ne repart pas lire Monday "
                 f"({ponctuel})")
        depuis_fichier, _ = interface.construire_arguments(
            {"tableau": "42"}, Path("d.csv"))
        verifier("--tableau-monday" not in depuis_fichier,
                 "un export déposé non plus : le fichier fait foi")
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
        verifier(len(set(cles)) == 10,
                 f"dix étapes distinctes (obtenu : {len(set(cles))})")
        # Un dossier « possible abandon » attend une décision : sa créance est
        # toujours due, il n'est donc ni clôturé, ni gagné, ni perdu.
        verifier("abandon-possible" not in module_suivi.CLOTURES
                 and "abandon-possible" not in module_suivi.PERDUS,
                 "un possible abandon n'est ni clôturé ni perdu")
        verifier("abandon-possible" in module_suivi.EN_SUSPENS,
                 "il est en suspens, et sa créance compte parmi celles en cours")
        verifier("abandon" in module_suivi.PERDUS,
                 "l'abandon décidé, lui, reste une créance perdue")
        issues = [s for s in module_suivi.STATUTS
                  if s["famille"] in ("gagne", "perdu", "suspens")]
        verifier(
            all(s["icone"] for s in issues),
            "les cinq issues portent une icône, la couleur ne suffisant pas "
            "à les distinguer en vision deutan",
        )
        # Deux issues peuvent partager la couleur de leur famille — le vert des
        # clôtures favorables, le rouge des créances perdues — mais jamais
        # l'icône : c'est elle qui les sépare quand la couleur ne le fait pas.
        icones = [s["icone"] for s in issues]
        verifier(len(set(icones)) == len(icones),
                 f"et chacune la sienne (obtenu : {icones})")
        verifier(
            "abandon" in module_suivi.PERDUS
            and "abandon" in module_suivi.CLOTURES,
            "l'abandon de créance clôt le dossier et compte comme non recouvré",
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
    test_saisie_convention_diplome_echeance()
    test_completer_depuis_fichier()
    test_recapitulatif_atomique()
    test_colonnes_vides_signalees()
    test_colonnes_miroir_monday()
    test_pieces_versees()
    test_ancienne_reference_facture()
    test_annuaire_entreprises()
    test_note_perimee_retiree()
    test_messages_autre_facture()
    test_feuille_emargement()
    test_copie_vers_sharepoint()
    test_tri_des_colonnes()
    test_references_parasites()
    test_message_quand_l_outil_ne_repond_pas()
    test_montant_inconnu_n_est_pas_zero()
    test_tout_effacer_respecte_la_reponse()
    test_doublons_de_la_liste()
    test_retrouver_les_dossiers_du_disque()
    test_arreter_un_export()
    test_absents_de_l_export()
    test_note_refaite_datee_et_recopiee()
    test_refaire_notes_choisies()
    test_barre_toujours_presente()
    test_note_perimee()
    test_part_abandon_possible()
    test_pieces_citees_une_fois()
    test_suivi_livre_avec_l_application()
    test_etape_depuis_monday()
    test_complement_reapplique_seul()
    test_refaire_les_notes()
    test_colonnes_du_suivi_a_la_main()
    test_extrait_zoho_de_bout_en_bout()
    test_fils_completes()
    test_note_interne_au_propre()
    test_contexte_saisi()
    test_recherche_dossiers()
    test_resume_de_situation()
    test_reponses_du_debiteur()
    test_conversations_resumees()
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
