Set objShell = CreateObject("WScript.Shell")
objShell.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -File ""c:\Users\seyi-DESK\Project\scrape\scripts\restart-dev-server.ps1""", 0, False
