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
