$projectPath = 'c:\Users\seyi-DESK\Project\scrape'
$escaped = [regex]::Escape($projectPath)

# 이 프로젝트의 next dev 프로세스만 정확히 골라 죽인다 — node.exe 전체를 죽이면 이 컴퓨터에서 같이 도는
# 다른 MCP 서버(firecrawl-mcp 등)까지 죽어버리므로, 커맨드라인에 이 프로젝트 경로가 들어있는 것만 대상으로 한다.
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match $escaped } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

Start-Sleep -Seconds 2

# Turbopack 파일시스템 캐시가 오래 쌓이면 열화되어(2026-08-02 FATAL panic 실사례) 느려지다 죽는 문제가
# 있어, 매일 재기동 시 캐시를 비우고 새로 시작한다.
Remove-Item -Recurse -Force (Join-Path $projectPath '.next') -ErrorAction SilentlyContinue

Start-Process -FilePath 'wscript.exe' -ArgumentList "`"$projectPath\scripts\start-dev-server-hidden.vbs`""
