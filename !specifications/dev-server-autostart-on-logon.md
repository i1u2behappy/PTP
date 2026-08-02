# 로그온 시 dev 서버 자동 기동

## 배경
2026-07-29 23:22경 컴퓨터가 재부팅되면서 `next dev`(그냥 평범한 터미널 프로세스)가 같이 죽었고,
재부팅 후 자동으로 다시 띄워주는 게 없어 24시간 가까이 서버가 죽은 채 방치됐다(사용자가 "지금 서버가
죽어 있는 이유는 뭐야"로 발견). DB 컨테이너(scrape-postgres)는 Docker Desktop이 자동 재시작해줘서
멀쩡했다 — DB 문제가 아니라 dev 서버 프로세스 자체가 감시자 없이 떠 있던 게 원인.

같은 세션에서 Claude Code의 백그라운드 실행으로 dev 서버를 띄우는 것도 임시방편일 뿐이라는 게 같이
확인됐다 — 그 백그라운드 프로세스는 Claude Code 세션(에이전트)에 묶여 있어서, 세션이 끝나면 서버도
같이 죽는다([[windows_spawn_job_object_kill]]과 같은 유형: Job Object에 묶인 프로세스가 부모 종료 시
같이 정리됨).

## 구성
- `scripts/start-dev-server.cmd` — 프로젝트 폴더로 `cd /d` 한 뒤 `npm run dev:clean`을 실행하고
  `.next` 삭제 후 재빌드까지 포함), 출력을 `.dev-server.log`로 리다이렉트한다(git-ignore 처리).
- `scripts/start-dev-server-hidden.vbs` — `WScript.Shell.Run`으로 위 cmd를 창 없이(`0, False`)
  실행하는 래퍼. cmd 창이 로그온마다 뜨는 게 거슬린다는 피드백으로 추가.
- Windows 작업 스케줄러 작업 `ScrapeDevServer` — `/SC ONLOGON`(현재 사용자 로그온 시), 처음엔
  `Task To Run`을 `cmd.exe /c start-dev-server.cmd`로 등록했다가, 창 숨김 요청 이후
  `wscript.exe start-dev-server-hidden.vbs`로 바꾸는 작업 진행 중.

## 알려진 제약 — 작업 스케줄러 등록/변경은 반드시 관리자 권한 필요
이 계정은 관리자 계정이지만 Claude Code(및 그 하위 PowerShell/Bash 프로세스)는 UAC로 필터링된 일반
권한 토큰으로 돈다(`whoami /groups`에 `BUILTIN\Administrators`가 "Group used for deny only"로 찍힘).
`schtasks /Create`, `schtasks /Change` 둘 다 이 토큰으로는 `Access is denied`로 막힌다 — Claude Code가
UAC 상승을 스스로 할 수 없으므로, **작업 등록/수정은 항상 사용자가 관리자 권한 PowerShell에서 직접
실행**해야 한다. 최초 등록(`/Create`)은 사용자가 실행해 성공했고, 창 숨김으로 바꾸는 `/Change` 명령은
안내만 해둔 상태(사용자 실행 대기).

## 검증
- `schtasks /Query /TN "ScrapeDevServer" /V /FO LIST`로 `Task To Run`, `Last Run Time`, `Last Result`
  확인.
- 재부팅 없이 테스트하려면 기존 수동 dev 서버를 먼저 종료한 뒤 `schtasks /Run /TN "ScrapeDevServer"`,
  이후 `http://localhost:3000` 응답 및 `.dev-server.log`의 `✓ Ready` 확인.

## 근본 원인 발견 — "알약" 실시간 검사가 Turbopack 파일 I/O를 방해 + 매일 새벽 자동 재기동 추가 (2026-08)

장시간(20시간+) 켜져 있던 dev 서버가 반복적으로 `FATAL: An unexpected Turbopack error`로 죽는 문제가
재발 — `.dev-server.log`를 보니 `app/globals.css` 컴파일 워커와의 IPC가 타임아웃(`failed to receive
message... deadline has elapsed`)나고 있었고, 단순 API 라우트 하나 컴파일에 최대 48초가 걸릴 만큼
`⚠ Slow filesystem detected` 경고까지 함께 찍혔다.

- **원인**: Windows Security Center 조회 결과 Windows Defender는 꺼져 있고(다른 백신이 주 실시간
  감시일 때의 정상 동작) "알약"(AhnLab)이 실시간 검사를 담당 중이었다 — Turbopack이 `.next`/
  `node_modules`에 초당 수백 개의 작은 파일을 쓰고 읽는데, 알약의 실시간 스캔이 하나하나를 가로채며
  I/O가 심하게 느려지고, 그 지연이 길어지면 Turbopack 내부 프로세스 간 통신이 타임아웃나 FATAL
  panic으로 이어진 것으로 진단.
- **근본 조치(사용자 수동 실행 필요)**: 알약 설정(환경설정 > 검사 설정/예외 처리)에 이 프로젝트의
  `node_modules`/`.next`/`.playwright-profiles` 폴더를 실시간 검사 제외로 등록. Windows Defender용
  `Add-MpPreference -ExclusionPath ...` 명령도 안내했으나, Defender 서비스 자체가 지금 비활성 상태라
  `0x800106ba` 에러로 실행되지 않는다(Defender가 나중에 다시 주 백신이 될 경우를 대비한 보조 조치일
  뿐, 지금 당장 필요한 조치는 알약 쪽 예외 등록).
- **보조 완화책 — 매일 새벽 4시 자동 재기동**: Turbopack 파일시스템 캐시가 장시간 가동될수록 계속
  커지며 열화되는 특성이 있어, 알약 예외 등록과 별개로 매일 한 번 캐시를 비우고 재기동하도록
  `scripts/restart-dev-server.ps1`(신규)을 추가했다 — 이 프로젝트의 next dev 프로세스만 커맨드라인에
  프로젝트 경로가 포함된 것으로 정확히 골라 종료(다른 MCP 서버 프로세스는 안 건드림) → `.next` 삭제 →
  `scripts/restart-dev-server-hidden.vbs`(신규, 기존 로그온 시작과 같은 숨김 방식)로 재기동.
  `ScrapeDevServerDailyRestart`라는 이름으로 Windows 작업 스케줄러에 `/SC DAILY /ST 04:00`으로 등록
  (기존 `ScrapeDevServer`의 `/SC ONLOGON`과는 별개 작업).

## 검증 (2026-08 추가분)
- 수동으로 프로세스를 죽이고(`Get-CimInstance Win32_Process` + `Stop-Process`) `.next` 삭제 후 스케줄
  작업을 재실행해, 캐시 없이도 깨끗하게 재기동되고 이후 컴파일이 진행됨을 확인.
- `schtasks /Query /TN "ScrapeDevServerDailyRestart" /V /FO LIST`로 `Next Run Time`(다음날 04:00)과
  스케줄 타입(`Daily`) 확인.
- 알약 실시간 검사로 인한 근본적인 속도 저하 자체는 알약 예외 등록(사용자가 직접 실행)이 아직 완료
  안 됐다면 계속 남아있을 수 있음 — 등록 후 체감 속도 재확인 권장.
