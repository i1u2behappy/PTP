# Docker/DB/PTP 서버 상태 확인 + 재시작 버튼

## 배경
Docker Desktop이 꺼져 Postgres 컨테이너가 죽으면 로그인부터 모든 기능이 원인 불명의 "확인 실패: 500"으로
실패한다(2026-07-25 실제 발생 — Docker Desktop 자체가 꺼져있었음). 사용자가 매번 원인을 추적할 필요 없이,
화면에서 바로 알아채고 버튼 한 번으로 복구할 수 있게 만들었다.

## 구성
- `app/api/health/db/route.ts` — DB 연결 확인용 공개 엔드포인트. `pg.Pool`엔 기본 타임아웃이 없어
  Docker Desktop이 아직 안정화되지 않은 상태(WSL2 네트워킹)에서 연결이 에러 없이 그냥 몇 분씩 멈추는
  경우가 실제로 있었다 — 그래서 쿼리에 3초 타임아웃을 걸어 무조건 빨리 `{ok:false}`로라도 응답한다.
- `app/api/system/restart-docker/route.ts` — Docker Desktop 관련 프로세스를 전부 강제 종료했다가 다시
  띄운다. 컨테이너는 `unless-stopped` 정책으로 Docker Desktop이 뜨면 자동으로 따라 올라온다.
  - **처음엔 Docker Desktop 실행파일만 다시 `spawn`했는데 실사용해보니 이 버튼이 필요한 바로 그 상황
    (Docker Desktop은 떠 있는데 WSL2 네트워킹만 불안정한 경우)에서 아무 효과가 없었다** — Docker
    Desktop은 단일 인스턴스 앱이라 이미 떠 있으면 그냥 기존 창을 포커스할 뿐 백엔드(WSL2 VM)는 전혀
    재시작되지 않는다(2026-07-26, 사용자 지적으로 발견: "2번의 이유였다면, 백엔드를 재시작해야하는거야?").
    그래서 관련 프로세스를 전부 죽인 뒤 다시 띄우는 방식으로 바꿨다.
  - **`child_process.spawn(powershell, {detached:true})`로 직접 띄우는 방식은 이 서버(npm run dev)
    안에서 호출하면 조용히 실패한다.** `pid`는 정상 발급되고 `'error'` 이벤트도 없는데, `Get-Process`로
    직후 조회하면 이미 사라져 있다 — 스크립트를 실행하기도 전에 죽는다(`-Command` 문자열의 인용부호
    이스케이프 문제도 아니었음 — `.ps1` 파일 + `-File`로 바꿔도 동일). 같은 스크립트를 이 서버 프로세스
    밖(별도 터미널)에서 그대로 실행하면 정상 동작한다 — 이 dev 서버 프로세스가 속한 Windows Job Object의
    kill-on-close 특성 때문으로 추정([[windows_spawn_job_object_kill]] 메모 참고. `detached:true`는
    `CREATE_NEW_PROCESS_GROUP`만 줄 뿐 Job에서 breakaway는 안 됨). **해결**: PowerShell 스크립트를
    임시 `.ps1` 파일로 써두고, `schtasks /Create ... /SC ONCE /F` + `schtasks /Run /TN <name>`으로 작업
    스케줄러에 등록해 실행한다 — 스케줄러 서비스가 완전히 별개의 프로세스 트리에서 띄우므로 이 문제를
    원천적으로 피한다. 최종 검증: 실제 curl로 라우트를 호출해 `scrape-postgres` 컨테이너가 "Up 2
    seconds"로 재기동되고 `/api/health/db`가 `{"ok":true}`로 돌아오는 것까지 확인.
- `app/api/system/restart-server/route.ts` — PTP 서버(Next dev) 자체를 강제 재시작. **반드시
  `npm run dev:clean`(.next 삭제 후 기동)으로 재기동한다** — 과거에 강제종료 방식이 `.next` 캐시를 깨뜨려
  정상 라우트가 404 나던 사고가 있었다([[dev_server_restart_corrupts_cache]] 메모 참고).
  - 이 요청을 처리 중인 프로세스 자신(`process.pid`)을 죽여야 하므로, 죽이기/재기동은 분리된 detached
    PowerShell 프로세스에 맡긴다: 응답을 먼저 보내고, 1초 뒤 `Stop-Process`로 포트를 비운 뒤 새로 기동.
  - **프로세스 트리째 죽이는 방식(`taskkill /T`)은 쓰지 않는다.** 이 detached 프로세스 자체가 지금 죽이려는
    `process.pid`의 자식으로 생성되므로(Windows는 `detached:true`로도 부모 PID 기록 자체를 못 숨긴다),
    트리째 죽이면 재시작 스크립트 자신까지 같이 죽어버려 재기동이 실행되지 못한다 — 실제로 이 버그로 서버가
    죽은 채 복구되지 않는 것을 확인 후 수정.
  - **`cmd.exe`의 `timeout` 명령도 쓰지 않는다.** 이 앱이 Git Bash 환경에서 기동되어 PATH에 Git의
    coreutils(usr/bin)가 Windows System32보다 앞에 오면, Windows용 `timeout /t 1`이 아니라 문법이 다른 GNU
    `timeout`이 잡혀 즉시 에러로 죽어 재시작 자체가 조용히 실패했다(실제로 겪음). 그래서 `cmd.exe` 대신
    `powershell.exe -Command`로 바꾸고, 외부 실행파일이 아닌 내장 cmdlet(`Start-Sleep`, `Stop-Process`)만
    사용해 이 PATH 셰도잉 문제 자체를 피한다. 최종 검증: POST 후 약 6초 만에 정상 복구.
  - **중복 요청 방지 가드(`restartInFlight` 모듈 스코프 플래그).** 재시작 예약 후 실제 `Stop-Process`가
    실행되기까지 1초의 틈이 있어, 그 사이 두 번째 POST가 도착하면(중복 클릭 등) "아직 살아있는" 같은
    프로세스가 이를 처리해 재기동 체인을 하나 더 예약해버릴 수 있다 — 그러면 새 인스턴스가 둘 동시에 뜨며
    같은 `.next` 캐시에 동시에 써서 충돌하는 사고로 이어진다([[orphaned_dev_server_cache_corruption]]
    메모 참고 — 실제로 이 세션에서 다른 경로(반복 수동 재시작)로 겪은 것과 같은 유형의 사고). 이미 진행
    중이면 두 번째 요청은 409로 거부한다.
- `components/shell/DbHealthBanner.tsx` — 20초 주기로 `/api/health/db`를 폴링. `fetch` 자체가 실패(네트워크
  에러)하면 "PTP 서버 응답 없음"으로, fetch는 성공했지만 `{ok:false}`면 "DB 연결 실패"로 구분해서 배너와
  재시작 버튼을 다르게 보여준다. 재시작 중엔 폴링을 4초 간격으로 빠르게 전환.
- `proxy.ts` — 위 세 엔드포인트를 공개 경로에 추가. 로그인 화면 자체가 DB 장애로 막힌 상황에서도 배너/버튼이
  동작해야 하기 때문.

## 알려진 한계
PTP 서버가 완전히 다운되어 **새로 페이지를 열 수 없는 상태**에서는 배너 자체가 서버가 주는 페이지 위에서
동작하므로 새로고침/새 탭에서는 감지·재시작이 불가능하다. 이미 열려 있던 탭에서 서버가 중간에 죽는 경우에만
감지 및 재시작 버튼이 동작한다. 사용자가 이 한계를 인지한 상태로 "PTP 내부 배너 확장" 방식을 선택함
(대안이었던 "별도 감시자 프로세스"는 채택하지 않음).
