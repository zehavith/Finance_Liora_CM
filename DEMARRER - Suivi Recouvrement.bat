@echo off
setlocal enabledelayedexpansion
title Suivi Recouvrement Liora

rem ============================================================
rem  DEMARRER ICI.
rem
rem  Double-cliquez sur ce fichier : le navigateur s'ouvre sur
rem  l'application Suivi Recouvrement.
rem
rem  Un petit serveur web local est demarre depuis ce dossier.
rem  C'est ce qui permet a la connexion Monday de fonctionner :
rem  les navigateurs bloquent les appels reseau depuis une page
rem  ouverte par double-clic sur un fichier.
rem
rem  Rien n'est publie sur Internet : le serveur n'ecoute que
rem  sur cet ordinateur.
rem ============================================================

cd /d "%~dp0"

set PORT=8777
set URL=http://localhost:%PORT%/recouvrement/

cls
echo.
echo   ============================================
echo      LIORA - Suivi Recouvrement
echo   ============================================
echo.

rem --- Verifier que le dossier est complet ---------------------
if not exist "recouvrement\index.html" (
    echo   ERREUR : le dossier semble incomplet.
    echo.
    echo   Le sous-dossier "recouvrement" est introuvable.
    echo   Verifiez que l'archive ZIP a bien ete EXTRAITE en
    echo   entier, et que ce fichier se trouve a la racine du
    echo   dossier extrait.
    echo.
    pause
    exit /b
)

rem --- Chercher un interpreteur disponible ---------------------
set LANCEUR=
where py      >nul 2>nul && set LANCEUR=py
if "!LANCEUR!"=="" ( where python  >nul 2>nul && set LANCEUR=python )
if "!LANCEUR!"=="" ( where python3 >nul 2>nul && set LANCEUR=python3 )
if "!LANCEUR!"=="" ( where node    >nul 2>nul && set LANCEUR=node )

if "!LANCEUR!"=="" goto :sans_serveur

echo   Ouverture de %URL%
echo.
echo   GARDEZ CETTE FENETRE OUVERTE pendant que vous
echo   utilisez l'application.
echo   Pour quitter : fermez cette fenetre.
echo.
echo   (Suivi Cash est aussi accessible, sur
echo    http://localhost:%PORT%/ )
echo.

start "" "%URL%"

if "!LANCEUR!"=="node" (
    npx --yes http-server -p %PORT% -c-1 --silent
) else (
    !LANCEUR! -m http.server %PORT%
)
goto :fin

rem --- Ni Python ni Node : ouverture directe du fichier --------
:sans_serveur
echo   Python et Node.js sont introuvables sur ce poste.
echo.
echo   L'application va s'ouvrir directement. Tout fonctionne
echo   dans ce mode SAUF la connexion a l'API Monday : passez
echo   alors par l'import des exports Excel / CSV.
echo.
echo   Pour activer la connexion Monday, installez Python
echo   depuis https://www.python.org/downloads/ en cochant
echo   "Add Python to PATH", puis relancez ce fichier.
echo.
start "" "%~dp0recouvrement\index.html"
pause

:fin
endlocal
