' Lance l'application sans fenetre noire.
'
' C'est la cible du raccourci "Liora - Suivi contentieux". Une fenetre de
' commande visible se ferme par reflexe, et sa fermeture tue l'export en
' cours : c'est ainsi qu'un export de trente-deux dossiers s'est arrete au
' deuxieme.
'
' pythonw.exe est la variante de Python sans console. A defaut, on retombe
' sur python.exe lance en fenetre masquee : meme resultat, sans dependre de
' la presence de pythonw.
'
' ATTENTION : ce fichier doit rester en ASCII pur, sans aucun accent.
' Windows Script Host lit un .vbs dans la page de codes du poste, et non en
' UTF-8. Le test hors ligne le verifie.

Option Explicit

Dim shell, fso, racine, commande, python

Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

racine = fso.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = racine

python = "pythonw.exe"
On Error Resume Next
shell.Run """" & python & """ --version", 0, True
If Err.Number <> 0 Then
    Err.Clear
    python = "python.exe"
End If
On Error Goto 0

commande = """" & python & """ """ & fso.BuildPath(racine, "interface.py") & """"

' 0 = aucune fenetre. False = on n'attend pas la fin : l'application tourne
' tant que le navigateur est ouvert.
On Error Resume Next
shell.Run commande, 0, False
If Err.Number <> 0 Then
    MsgBox "Python est introuvable sur ce poste." & vbCrLf & vbCrLf & _
           "Installez-le depuis python.org en cochant" & vbCrLf & _
           """Add python.exe to PATH"", puis relancez.", _
           vbExclamation, "Liora - Suivi contentieux"
End If
On Error Goto 0
