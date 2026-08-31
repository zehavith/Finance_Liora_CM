@echo off
setlocal
title Raccourci bureau - Suivi Recouvrement

rem ============================================================
rem  Cree un raccourci "Suivi Recouvrement" sur le Bureau,
rem  avec l'icone Liora. Le raccourci lance l'application.
rem
rem  A executer une seule fois. Rien n'est installe : le
rem  raccourci pointe simplement vers le fichier de demarrage.
rem ============================================================

cd /d "%~dp0"

set CIBLE=%~dp0..\DEMARRER - Suivi Recouvrement.bat
set ICONE=%~dp0icones\liora.ico

if not exist "%CIBLE%" (
    echo   ERREUR : "DEMARRER - Suivi Recouvrement.bat" est introuvable.
    echo   Ce fichier doit rester dans le sous-dossier "recouvrement".
    echo.
    pause
    exit /b
)

set VBS=%TEMP%\liora_raccourci.vbs
> "%VBS%" echo Set oWS = WScript.CreateObject("WScript.Shell")
>>"%VBS%" echo sBureau = oWS.SpecialFolders("Desktop")
>>"%VBS%" echo Set oLien = oWS.CreateShortcut(sBureau ^& "\Suivi Recouvrement.lnk")
>>"%VBS%" echo oLien.TargetPath = "%CIBLE%"
>>"%VBS%" echo oLien.WorkingDirectory = "%~dp0.."
>>"%VBS%" echo oLien.IconLocation = "%ICONE%"
>>"%VBS%" echo oLien.Description = "Liora - Suivi Recouvrement"
>>"%VBS%" echo oLien.Save

cscript //nologo "%VBS%"
del "%VBS%" >nul 2>nul

echo.
echo   Raccourci "Suivi Recouvrement" cree sur votre Bureau.
echo.
echo   Astuce : pour l'epingler a la barre des taches, faites
echo   un clic droit dessus une fois l'application ouverte.
echo.
pause
endlocal
