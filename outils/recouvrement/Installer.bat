@echo off
REM Cree le raccourci "Liora - Suivi contentieux" sur le Bureau et dans le
REM menu Demarrer, avec l'icone de l'application. A lancer une seule fois.
REM
REM ATTENTION : ce fichier doit rester en ASCII pur, sans aucun accent.
REM "chcp 65001" change la page de codes en cours de lecture du .bat, et cmd
REM reprend alors la lecture au mauvais octet des que le fichier contient une
REM sequence UTF-8 : "echo." devient "cho.", et la suite part en morceaux.
REM Le test hors ligne le verifie.

cd /d "%~dp0"

echo.
echo Installation du raccourci "Liora - Suivi contentieux"...
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0installer.ps1"
if errorlevel 1 goto erreur

echo.
echo Termine. Le raccourci est sur votre Bureau et dans le menu Demarrer.
echo Vous pouvez fermer cette fenetre.
echo.
pause
goto fin

:erreur
echo.
echo L'installation a echoue. Le detail figure ci-dessus.
echo.
echo Solution de secours, sans PowerShell :
echo   1. clic droit sur Lancer-silencieux.vbs
echo   2. Afficher plus d'options / Envoyer vers / Bureau (creer un raccourci)
echo   3. sur le Bureau, renommer le raccourci en "Liora - Suivi contentieux"
echo   4. clic droit / Proprietes / Changer d'icone / Parcourir / liora.ico
echo.
pause

:fin
