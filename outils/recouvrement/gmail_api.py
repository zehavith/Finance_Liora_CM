"""Authentification et accès à l'API Gmail (lecture seule)."""

from __future__ import annotations

import base64
import os
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


def _identifiants_utilisateur(fichier_credentials: Path, fichier_token: Path):
    """Flux OAuth « application de bureau » : ouvre le navigateur au premier
    lancement, puis réutilise le jeton stocké."""
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
        identifiants = flux.run_local_server(
            port=0,
            authorization_prompt_message=(
                "Ouvrez cette adresse dans votre navigateur pour autoriser "
                "l'accès en lecture à la boîte :\n{url}"
            ),
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
    ):
        build, http_error = _importer_dependances()
        self._http_error = http_error

        if fichier_compte_service is not None:
            if not boite:
                raise ErreurGmail(
                    "L'option --boite est obligatoire avec un compte de service "
                    "(adresse de la boîte à lire)."
                )
            identifiants = _identifiants_compte_service(fichier_compte_service, boite)
        else:
            identifiants = _identifiants_utilisateur(fichier_credentials, fichier_token)

        self._service = build("gmail", "v1", credentials=identifiants, cache_discovery=False)
        self.boite = boite or "me"

    @property
    def adresse_boite(self) -> str:
        """Adresse réellement interrogée, pour tracer l'origine de l'export."""
        try:
            profil = self._service.users().getProfile(userId="me").execute(
                num_retries=NB_RETENTATIVES
            )
            return profil.get("emailAddress", self.boite)
        except Exception:  # noqa: BLE001 - purement informatif
            return self.boite

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
            yield lire_message(reponse, brut)
