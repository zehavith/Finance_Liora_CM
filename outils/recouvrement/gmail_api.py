"""Authentification et accès à l'API Gmail (lecture seule)."""

from __future__ import annotations

import base64
import os
import re
from collections.abc import Callable
from pathlib import Path
from typing import Iterator

from message import MessageMail, lire_message

# Lecture seule : le script ne peut ni envoyer, ni supprimer, ni modifier
# quoi que ce soit dans la boîte.
PORTEES = ["https://www.googleapis.com/auth/gmail.readonly"]

# Nombre de tentatives automatiques de la librairie Google sur les erreurs
# transitoires (429 quota dépassé, 500/503 côté Google).
NB_RETENTATIVES = 5


class ErreurGmail(RuntimeError):
    pass


def _importer_dependances():
    try:
        from googleapiclient.discovery import build  # noqa: PLC0415
        from googleapiclient.errors import HttpError  # noqa: PLC0415
    except ImportError as exc:  # pragma: no cover - dépend de l'environnement
        raise ErreurGmail(
            "Dépendances Google manquantes. Lancez :\n"
            "    pip install -r requirements.txt"
        ) from exc
    return build, HttpError


def fichier_token_de_boite(fichier_token: Path, boite: str | None) -> Path:
    """Un jeton par boîte : billing@ et recouvrement@ sont deux comptes
    distincts, chacun avec sa propre autorisation."""
    if not boite:
        return fichier_token
    prefixe = re.sub(r"[^a-z0-9]+", "-", boite.lower()).strip("-")
    return fichier_token.with_name(f"{fichier_token.stem}-{prefixe}{fichier_token.suffix}")


def _identifiants_utilisateur(
    fichier_credentials: Path,
    fichier_token: Path,
    boite: str | None = None,
    ouvrir_navigateur: bool = True,
):
    """Flux OAuth « application de bureau » : ouvre le navigateur au premier
    lancement, puis réutilise le jeton stocké.

    `ouvrir_navigateur=False` se contente d'afficher l'adresse à ouvrir. C'est
    indispensable quand la boîte visée est connectée dans une *autre* fenêtre
    ou un autre profil du navigateur : l'ouverture automatique se ferait dans
    le profil par défaut, qui validerait aussitôt avec le mauvais compte sans
    laisser le temps de choisir.
    """
    from google.auth.transport.requests import Request  # noqa: PLC0415
    from google.oauth2.credentials import Credentials  # noqa: PLC0415
    from google_auth_oauthlib.flow import InstalledAppFlow  # noqa: PLC0415

    identifiants = None
    if fichier_token.exists():
        try:
            identifiants = Credentials.from_authorized_user_file(str(fichier_token), PORTEES)
        except ValueError:
            identifiants = None

    if identifiants and identifiants.valid:
        return identifiants

    if identifiants and identifiants.expired and identifiants.refresh_token:
        identifiants.refresh(Request())
    else:
        if not fichier_credentials.exists():
            raise ErreurGmail(
                f"Fichier d'identifiants introuvable : {fichier_credentials}\n"
                "Voir la section « Mise en place » du README."
            )
        flux = InstalledAppFlow.from_client_secrets_file(str(fichier_credentials), PORTEES)
        precision = f" en tant que {boite}" if boite else ""

        if ouvrir_navigateur:
            invite = (
                f"Ouvrez cette adresse dans votre navigateur et connectez-vous"
                f"{precision} pour autoriser l'accès en lecture :\n{{url}}"
            )
        else:
            invite = (
                "\n" + "=" * 74 + "\n"
                f"COPIEZ l'adresse ci-dessous et collez-la dans la fenêtre du\n"
                f"navigateur déjà connectée{precision} :\n\n"
                "{url}\n\n"
                "Le terminal attend ici jusqu'à ce que l'autorisation soit accordée.\n"
                + "=" * 74
            )

        identifiants = flux.run_local_server(
            port=0,
            open_browser=ouvrir_navigateur,
            authorization_prompt_message=invite,
            success_message=(
                "Autorisation accordée. Vous pouvez fermer cet onglet et "
                "revenir au terminal."
            ),
        )

    fichier_token.parent.mkdir(parents=True, exist_ok=True)
    fichier_token.write_text(identifiants.to_json(), encoding="utf-8")
    os.chmod(fichier_token, 0o600)
    return identifiants


def _identifiants_compte_service(fichier_service: Path, boite: str):
    """Compte de service avec délégation à l'échelle du domaine : permet de
    lire une boîte partagée (ex. recouvrement@liora.io) sans mot de passe."""
    from google.oauth2 import service_account  # noqa: PLC0415

    if not fichier_service.exists():
        raise ErreurGmail(f"Clé de compte de service introuvable : {fichier_service}")

    identifiants = service_account.Credentials.from_service_account_file(
        str(fichier_service), scopes=PORTEES
    )
    return identifiants.with_subject(boite)


class ClientGmail:
    def __init__(
        self,
        fichier_credentials: Path,
        fichier_token: Path,
        fichier_compte_service: Path | None = None,
        boite: str | None = None,
        ouvrir_navigateur: bool = True,
    ):
        build, http_error = _importer_dependances()
        self._http_error = http_error

        if fichier_compte_service is not None:
            if not boite:
                raise ErreurGmail(
                    "L'option --boites est obligatoire avec un compte de service "
                    "(adresse des boîtes à lire)."
                )
            identifiants = _identifiants_compte_service(fichier_compte_service, boite)
        else:
            identifiants = _identifiants_utilisateur(
                fichier_credentials,
                fichier_token_de_boite(fichier_token, boite),
                boite,
                ouvrir_navigateur,
            )

        self._service = build("gmail", "v1", credentials=identifiants, cache_discovery=False)
        self._adresse: str | None = None
        self.boite = boite or "me"

        # Garde-fou : au moment de l'autorisation dans le navigateur, rien
        # n'empêche de se connecter avec le mauvais compte. Sans cette
        # vérification, l'export porterait silencieusement sur une autre boîte.
        if boite:
            reelle = self.adresse_boite
            if reelle.lower() != boite.lower():
                jeton = fichier_token_de_boite(fichier_token, boite)
                raise ErreurGmail(
                    f"Boîte demandée : {boite}\n"
                    f"Boîte réellement autorisée : {reelle}\n"
                    f"Supprimez le fichier {jeton.name} puis relancez, en vous "
                    f"connectant cette fois avec le compte {boite}."
                )
        self.boite = boite or self.adresse_boite

    @property
    def adresse_boite(self) -> str:
        """Adresse réellement interrogée, pour tracer l'origine de l'export."""
        if self._adresse is not None:
            return self._adresse
        try:
            profil = self._service.users().getProfile(userId="me").execute(
                num_retries=NB_RETENTATIVES
            )
            self._adresse = profil.get("emailAddress", self.boite)
        except Exception:  # noqa: BLE001 - purement informatif
            self._adresse = self.boite
        return self._adresse

    def rechercher_identifiants(
        self,
        requete: str,
        inclure_spam_corbeille: bool = True,
        plafond: int | None = None,
    ) -> list[str]:
        """Retourne les identifiants des messages correspondant à la requête."""
        identifiants: list[str] = []
        jeton_page = None

        while True:
            try:
                reponse = (
                    self._service.users()
                    .messages()
                    .list(
                        userId="me",
                        q=requete,
                        includeSpamTrash=inclure_spam_corbeille,
                        maxResults=500,
                        pageToken=jeton_page,
                    )
                    .execute(num_retries=NB_RETENTATIVES)
                )
            except self._http_error as exc:
                raise ErreurGmail(f"Recherche Gmail en échec : {exc}") from exc

            for message in reponse.get("messages", []):
                identifiants.append(message["id"])
                if plafond is not None and len(identifiants) >= plafond:
                    return identifiants

            jeton_page = reponse.get("nextPageToken")
            if not jeton_page:
                return identifiants

    def recuperer_messages(self, identifiants: list[str]) -> Iterator[MessageMail]:
        """Télécharge chaque message au format brut et le décode."""
        for identifiant in identifiants:
            try:
                reponse = (
                    self._service.users()
                    .messages()
                    .get(userId="me", id=identifiant, format="raw")
                    .execute(num_retries=NB_RETENTATIVES)
                )
            except self._http_error as exc:
                raise ErreurGmail(
                    f"Téléchargement du message {identifiant} en échec : {exc}"
                ) from exc

            brut = base64.urlsafe_b64decode(reponse["raw"].encode("ascii"))
            message = lire_message(reponse, brut)
            message.boites = [self.boite]
            yield message


class SourcesGmail:
    """Plusieurs boîtes interrogées comme une seule source.

    Un même échange se retrouve fréquemment dans billing@ et recouvrement@
    (l'une en copie de l'autre) : il n'est écrit qu'une fois au dossier, en
    mémorisant les deux boîtes d'origine.
    """

    def __init__(self, clients: list[ClientGmail]):
        if not clients:
            raise ErreurGmail("Aucune boîte à interroger.")
        self.clients = clients

    @property
    def adresses(self) -> list[str]:
        return [client.adresse_boite for client in self.clients]

    @property
    def domaines(self) -> set[str]:
        return {
            adresse.split("@")[-1].lower() for adresse in self.adresses if "@" in adresse
        }

    def identifiants_dossier(
        self, requete: str, inclure_spam_corbeille: bool = True, plafond: int | None = None
    ) -> list[tuple[ClientGmail, str]]:
        trouves: list[tuple[ClientGmail, str]] = []
        for client in self.clients:
            restant = None if plafond is None else max(0, plafond - len(trouves))
            if restant == 0:
                break
            for identifiant in client.rechercher_identifiants(
                requete, inclure_spam_corbeille, restant
            ):
                trouves.append((client, identifiant))
        return trouves

    def messages(
        self, paires: list[tuple[ClientGmail, str]]
    ) -> tuple[list[MessageMail], int]:
        """Retourne les messages dédoublonnés et le nombre de doublons écartés."""
        par_cle: dict[str, MessageMail] = {}
        doublons = 0

        for client in self.clients:
            identifiants = [
                identifiant for source, identifiant in paires if source is client
            ]
            for message in client.recuperer_messages(identifiants):
                cle = message.cle_dedoublonnage
                existant = par_cle.get(cle)
                if existant is None:
                    par_cle[cle] = message
                    continue
                doublons += 1
                for boite in message.boites:
                    if boite not in existant.boites:
                        existant.boites.append(boite)

        return sorted(par_cle.values(), key=lambda message: message.date), doublons


def ouvrir_sources(
    boites: list[str],
    fichier_credentials: Path,
    fichier_token: Path,
    fichier_compte_service: Path | None,
    signaler: Callable[[str], None] | None = None,
    ouvrir_navigateur: bool = True,
) -> SourcesGmail:
    clients = []
    for boite in boites or [None]:
        if signaler and boite:
            signaler(f"Ouverture de la boîte {boite}…")
        clients.append(
            ClientGmail(
                fichier_credentials=fichier_credentials,
                fichier_token=fichier_token,
                fichier_compte_service=fichier_compte_service,
                boite=boite,
                ouvrir_navigateur=ouvrir_navigateur,
            )
        )
    return SourcesGmail(clients)
