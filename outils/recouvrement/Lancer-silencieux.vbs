' Lance l'application sans fenêtre noire.
'
' C'est la cible du raccourci « Liora - Suivi contentieux ». Une fenêtre de
' commande visible se ferme par réflexe, et sa fermeture tue l'export en
' cours — c'est exactement ce qui est arrivé à un export de trente-deux
' dossiers arrêté au deuxième.
'
' pythonw.exe est la variante de Python sans console. À défaut, on retombe
' sur python.exe lancé en fenêtre masquée : même résultat, sans dépendre de
' la présence de pythonw.

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

' 0 = aucune fenêtre. False = on n'attend pas la fin : l'application tourne
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
