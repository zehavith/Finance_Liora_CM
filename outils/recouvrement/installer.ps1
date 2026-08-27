# Cree les raccourcis "Liora - Suivi contentieux".
#
# Le raccourci vise directement pythonw.exe, avec interface.py en argument.
# Deux raisons :
#   - pythonw n'ouvre aucune fenetre de console, et une fenetre visible se
#     ferme par reflexe, ce qui tue l'export en cours ;
#   - un raccourci vers un programme installe ne declenche pas l'avertissement
#     "Editeur inconnu" que Windows oppose a tout script telecharge.
# Lancer-silencieux.vbs reste la solution de repli quand pythonw est absent.
#
# Les fichiers de l'archive portent la marque "telecharge d'Internet", qui
# provoque ce meme avertissement a chaque ouverture : Unblock-File la retire.
#
# ATTENTION : ce fichier doit rester en ASCII pur, sans aucun accent.
# Windows PowerShell 5.1 lit un .ps1 sans BOM dans la page de codes du poste,
# et non en UTF-8 : un seul caractere accentue casse l'analyse du script
# entier ("Le terminateur " est manquant dans la chaine"). Le test hors ligne
# le verifie.

$ErrorActionPreference = "Stop"

$racine = Split-Path -Parent $MyInvocation.MyCommand.Path
$icone  = Join-Path $racine "liora.ico"
$appli  = Join-Path $racine "interface.py"
$repli  = Join-Path $racine "Lancer-silencieux.vbs"
$nom    = "Liora - Suivi contentieux.lnk"

if (-not (Test-Path $appli)) {
    Write-Host "Introuvable : $appli"
    Write-Host "Le dossier de l'application est incomplet."
    Write-Host "Recopiez tous les fichiers de l'archive, puis relancez."
    exit 1
}

# Retire la marque "telecharge d'Internet" de tous les fichiers du dossier.
Get-ChildItem -Path $racine -File | ForEach-Object {
    try { Unblock-File -Path $_.FullName -ErrorAction Stop } catch { }
}
Write-Host "Fichiers debloques."

$python = $null
foreach ($candidat in @("pythonw.exe", "python.exe")) {
    $trouve = Get-Command $candidat -ErrorAction SilentlyContinue
    if ($trouve) { $python = $trouve.Source; break }
}

if ($python) {
    $cible     = $python
    $arguments = '"' + $appli + '"'
    Write-Host "Python utilise : $python"
} else {
    # Sans Python dans le PATH, le .vbs sait au moins afficher un message
    # comprehensible plutot que de ne rien faire du tout.
    $cible     = $repli
    $arguments = ""
    Write-Host "Python introuvable dans le PATH : repli sur Lancer-silencieux.vbs"
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
    $raccourci.Arguments        = $arguments
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
