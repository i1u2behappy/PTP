Set objShell = CreateObject("WScript.Shell")
objShell.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -File ""c:\Users\seyi_MOVE\Project\scrape\scripts\restart-dev-server.ps1""", 0, False
