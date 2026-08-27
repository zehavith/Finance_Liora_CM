@echo off
REM Crée le raccourci « Liora - Suivi contentieux » sur le Bureau et dans le
REM menu Démarrer, avec l'icône de l'application. À lancer une seule fois.
chcp 65001 >nul
cd /d "%~dp0"

echo.
echo Installation du raccourci « Liora - Suivi contentieux »...
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
pause

:fin
