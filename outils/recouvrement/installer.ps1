# Cree les raccourcis "Liora - Suivi contentieux".
#
# Le raccourci pointe sur Lancer-silencieux.vbs plutot que sur Lancer.bat :
# le .bat ouvre une fenetre noire qui reste au premier plan et que l'on ferme
# par reflexe, ce qui tue l'export en cours. Le .vbs lance le meme outil sans
# aucune fenetre.
#
# ATTENTION : ce fichier doit rester en ASCII pur, sans aucun accent.
# Windows PowerShell 5.1 lit un .ps1 sans BOM dans la page de codes du poste,
# et non en UTF-8 : un seul caractere accentue casse l'analyse du script
# entier ("Le terminateur " est manquant dans la chaine"). Le test hors ligne
# le verifie.

$ErrorActionPreference = "Stop"

$racine = Split-Path -Parent $MyInvocation.MyCommand.Path
$cible  = Join-Path $racine "Lancer-silencieux.vbs"
$icone  = Join-Path $racine "liora.ico"
$nom    = "Liora - Suivi contentieux.lnk"

if (-not (Test-Path $cible)) {
    Write-Host "Introuvable : $cible"
    Write-Host "Le dossier de l'application est incomplet."
    Write-Host "Recopiez tous les fichiers de l'archive, puis relancez."
    exit 1
}

$shell = New-Object -ComObject WScript.Shell

$emplacements = @(
    [Environment]::GetFolderPath("Desktop"),
    (Join-Path ([Environment]::GetFolderPath("ApplicationData")) "Microsoft\Windows\Start Menu\Programs")
)

$faits = 0
foreach ($dossier in $emplacements) {
    if (-not (Test-Path $dossier)) { continue }

    $chemin = Join-Path $dossier $nom
    $raccourci = $shell.CreateShortcut($chemin)
    $raccourci.TargetPath       = $cible
    $raccourci.WorkingDirectory = $racine
    $raccourci.Description      = "Export et suivi des dossiers contentieux"
    if (Test-Path $icone) { $raccourci.IconLocation = "$icone,0" }
    $raccourci.Save()

    Write-Host "Raccourci cree : $chemin"
    $faits = $faits + 1
}

if ($faits -eq 0) {
    Write-Host "Aucun emplacement de raccourci accessible."
    exit 1
}
