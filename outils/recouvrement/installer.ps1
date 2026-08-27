# Crée les raccourcis « Liora - Suivi contentieux ».
#
# Le raccourci pointe sur Lancer-silencieux.vbs plutôt que sur Lancer.bat :
# le .bat ouvre une fenêtre noire qui reste au premier plan et que l'on ferme
# par réflexe — ce qui tue l'export en cours. Le .vbs lance le même outil sans
# aucune fenêtre.

$ErrorActionPreference = "Stop"

$racine  = Split-Path -Parent $MyInvocation.MyCommand.Path
$cible   = Join-Path $racine "Lancer-silencieux.vbs"
$icone   = Join-Path $racine "liora.ico"
$nom     = "Liora - Suivi contentieux.lnk"

if (-not (Test-Path $cible)) {
    Write-Host "Introuvable : $cible"
    Write-Host "Le dossier de l'application est incomplet — recopiez tous les fichiers."
    exit 1
}

$shell = New-Object -ComObject WScript.Shell

$emplacements = @(
    [Environment]::GetFolderPath("Desktop"),
    (Join-Path ([Environment]::GetFolderPath("ApplicationData")) "Microsoft\Windows\Start Menu\Programs")
)

foreach ($dossier in $emplacements) {
    if (-not (Test-Path $dossier)) { continue }

    $chemin = Join-Path $dossier $nom
    $raccourci = $shell.CreateShortcut($chemin)
    $raccourci.TargetPath       = $cible
    $raccourci.WorkingDirectory = $racine
    $raccourci.Description      = "Export et suivi des dossiers contentieux"
    if (Test-Path $icone) { $raccourci.IconLocation = "$icone,0" }
    $raccourci.Save()

    Write-Host "Raccourci créé : $chemin"
}
