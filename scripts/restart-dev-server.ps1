$projectPath = 'c:\Users\seyi-DESK\Project\scrape'
$escaped = [regex]::Escape($projectPath)

# 아래에서 워커를 포함해 node 프로세스를 강제종료(-Force)하기 전에, 열려있는 로그인 세션(들)을 먼저
# 정상 종료한다 — launchPersistentContext가 쓰는 --remote-debugging-pipe가 워커 프로세스와 파이프로
# 묶여있어 워커가 죽으면 그 크롬 창도 같이 닫히는데, 강제종료 직후엔 방금 로그인한 세션이 로그아웃
# 상태로 되돌아가는 사고가 실제로 있었다(lib/scraper.ts의 closeAllOpenSessionsGracefully 주석 참고).
# lib/workerRestart.ts의 restartWorker()(메모리 임계치 자동재시작, "PTP 서버 재시작" 버튼)는 이미 같은
# 프로세스 안에서 이 함수를 직접 부르지만, 이 스크립트는 외부 PowerShell이라 그 경로를 안 타므로 워커의
# RPC로 직접 불러야 한다(worker/registry.ts에 등록됨). 워커가 이미 안 떠 있거나 응답이 없으면(닫을
# 세션 자체가 없는 정상 상황) 그냥 넘어간다 — 이 재시작 자체를 막을 이유는 아니다.
try {
  Invoke-RestMethod -Uri 'http://127.0.0.1:4801/rpc' -Method Post -TimeoutSec 8 -ContentType 'application/json' `
    -Body (@{ id = 'restart-script'; fn = 'closeAllOpenSessionsGracefully'; args = @() } | ConvertTo-Json) | Out-Null
} catch { }

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
