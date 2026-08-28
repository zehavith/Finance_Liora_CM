@echo off
setlocal enabledelayedexpansion
title Suivi Recouvrement Liora

rem ============================================================
rem  Lance Suivi Recouvrement dans le navigateur.
rem
rem  Un petit serveur web local est demarre depuis le dossier
rem  du depot : c'est necessaire pour que la connexion a l'API
rem  Monday fonctionne (les navigateurs bloquent les appels
rem  reseau depuis une page ouverte en file://).
rem
rem  Rien n'est publie sur Internet : le serveur n'ecoute que
rem  sur cette machine.
rem ============================================================

rem Se placer a la racine du depot (le dossier parent de celui-ci)
cd /d "%~dp0.."

set PORT=8777
set URL=http://localhost:%PORT%/recouvrement/

echo.
echo   Suivi Recouvrement Liora
echo   ------------------------
echo.

rem --- Chercher un interpreteur disponible -------------------
set LANCEUR=
where py >nul 2>nul        && set LANCEUR=py
if "!LANCEUR!"=="" ( where python >nul 2>nul && set LANCEUR=python )
if "!LANCEUR!"=="" ( where python3 >nul 2>nul && set LANCEUR=python3 )
if "!LANCEUR!"=="" ( where node >nul 2>nul && set LANCEUR=node )

if "!LANCEUR!"=="" goto :sans_serveur

echo   Demarrage du serveur local sur le port %PORT%...
echo   Ouverture de %URL%
echo.
echo   GARDEZ CETTE FENETRE OUVERTE pendant l'utilisation.
echo   Pour quitter : fermez cette fenetre, ou Ctrl+C.
echo.

start "" "%URL%"

if "!LANCEUR!"=="node" (
    npx --yes http-server -p %PORT% -c-1 --silent
) else (
    !LANCEUR! -m http.server %PORT%
)
goto :fin

rem --- Ni Python ni Node : ouverture directe du fichier -------
:sans_serveur
echo   Python et Node.js sont introuvables sur ce poste.
echo.
echo   L'application va s'ouvrir directement depuis le fichier.
echo   Tout fonctionne dans ce mode SAUF la connexion a l'API
echo   Monday : utilisez l'import des exports Excel / CSV.
echo.
echo   Pour activer la connexion Monday, installez Python
echo   depuis https://www.python.org/downloads/ (cochez
echo   "Add Python to PATH"), puis relancez ce fichier.
echo.
start "" "%~dp0index.html"
pause

:fin
endlocal
