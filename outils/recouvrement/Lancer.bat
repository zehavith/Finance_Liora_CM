@echo off
REM Lance l'interface graphique de l'outil d'export recouvrement.
REM Se double-clique depuis l'Explorateur : aucune commande a taper.
chcp 65001 >nul
cd /d "%~dp0"

python interface.py
if errorlevel 9009 goto pas_de_python
if errorlevel 1 goto erreur
goto fin

:pas_de_python
echo.
echo Python est introuvable sur ce poste.
echo Installez-le depuis https://www.python.org/downloads/
echo en cochant "Add python.exe to PATH", puis relancez ce fichier.
echo.
pause
goto fin

:erreur
echo.
echo L'interface s'est arretee. Le detail figure ci-dessus.
echo.
pause

:fin
