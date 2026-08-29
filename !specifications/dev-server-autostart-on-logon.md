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

## 정정 — "알약"이 원인이라던 진단은 틀렸음 (2026-08-28)

사용자 확인: 알약(AhnLab)은 애초에 이 PC에 설치된 적이 없다. 위 "원인" 항목의 Security Center 조회
당시엔 Windows Defender가 꺼져 있었던 게 맞지만, 그 자리를 채운 게 알약이라는 추론은 잘못됐다 —
방금 다시 조회해보니 지금은 **Windows Defender 자체가 실시간 보호까지 켜진 채 정상 동작 중**이다
(`Get-MpComputerStatus`: RealTimeProtectionEnabled=True). 즉 "webpack/Turbopack이 `.next`/
`node_modules`에 쏟아내는 대량의 작은 파일 I/O를 실시간 백신 검사가 가로채 늦춘다"는 메커니즘 자체는
여전히 유효한 가설이지만, 그 백신이 지금은 알약이 아니라 Windows Defender다.

이전엔 Defender 서비스가 꺼져 있어 `Add-MpPreference -ExclusionPath ...`가 `0x800106ba`로 실패했는데,
지금은 Defender가 켜져 있으니 이 명령이 실제로 동작해야 한다 — 아직 예외 등록이 안 돼 있다면(관리자
권한 없이는 Claude Code가 직접 조회도 등록도 못 한다, `Get-MpPreference`가 "Must be an administrator"로
막힘) 관리자 PowerShell에서 직접 등록해보는 걸 권장한다:
```powershell
Add-MpPreference -ExclusionPath "C:\Users\seyi-DESK\Project\scrape\node_modules"
Add-MpPreference -ExclusionPath "C:\Users\seyi-DESK\Project\scrape\.next"
Add-MpPreference -ExclusionPath "C:\Users\seyi-DESK\Project\scrape\.playwright-profiles"
```

## 검증 (2026-08 추가분)
- 수동으로 프로세스를 죽이고(`Get-CimInstance Win32_Process` + `Stop-Process`) `.next` 삭제 후 스케줄
  작업을 재실행해, 캐시 없이도 깨끗하게 재기동되고 이후 컴파일이 진행됨을 확인.
- `schtasks /Query /TN "ScrapeDevServerDailyRestart" /V /FO LIST`로 `Next Run Time`(다음날 04:00)과
  스케줄 타입(`Daily`) 확인.
- 알약 실시간 검사로 인한 근본적인 속도 저하 자체는 알약 예외 등록(사용자가 직접 실행)이 아직 완료
  안 됐다면 계속 남아있을 수 있음 — 등록 후 체감 속도 재확인 권장.

## 재발 및 근본 조치 — Turbopack → webpack 전환 (2026-08-07)

알약 예외 등록이 끝나지 않은 채로 매일 새벽 4시 자동 재기동 직후(새로 비운 캐시로 `app/globals.css`를
처음부터 다시 컴파일하는 시점) 같은 FATAL panic이 재발했고, 이번엔 panic 이후 프로세스가 완전히
멈춰버렸다(`Get-Process` CPU 델타 0%, 어떤 요청에도 응답 없음 — DB/Docker는 정상이었고 순수하게 이
프로세스만 죽어있었음). 재시작 스크립트로 되살려도 새 프로세스가 첫 요청(`/api/health/db`) 컴파일
과정에서 90초 안에 다시 같은 방식으로 멈추는 것을 반복 확인 — 알약 예외 등록 없이는 재시작만으로는
근본적으로 해결되지 않음을 확인했다.

- **조치**: `package.json`의 `dev`/`dev:clean`을 `next dev --webpack`으로 바꿔 Turbopack 자체를
  개발 모드에서 쓰지 않도록 전환(Next.js 16 CLI에 `--webpack` 옵션 존재, `next dev --help`로 확인).
  같은 조건에서 webpack 모드는 첫 컴파일 포함 정상적으로 응답(`GET /api/health/db 200`)해 재현하지
  않음을 확인.
- **트레이드오프**: 개발 중 hot reload/컴파일 속도가 Turbopack보다 느릴 수 있음(webpack이 원래
  더 느림) — 그래도 "몇 시간~하루씩 서버가 완전히 죽어있는" 문제보다는 낫다고 판단. 알약 예외
  등록을 완료하면 다시 Turbopack으로 되돌리는 것도 고려 가능(`package.json`에서 `--webpack` 제거).
- `scripts/restart-dev-server.ps1`/`start-dev-server.cmd`는 모두 `npm run dev:clean`을 호출하는
  방식이라 별도 수정 없이 이 전환이 그대로 적용된다.
- [components/shell/DbHealthBanner.tsx](../components/shell/DbHealthBanner.tsx)의 "PTP 서버
  재시작" 버튼은, 서버가 완전히 멈춘 경우 그 재시작 요청조차 같은 죽은 프로세스가 처리해야 해서
  응답이 영영 안 올 수 있다는 점을 놓치고 있었다(타임아웃 없이 무한정 "재시작 중..." 표시) — 6초
  타임아웃을 추가해, 응답이 없으면 "브라우저로는 더 해볼 수 없다"는 것을 바로 알려주도록 수정.

## 재부팅 시 Docker(Postgres)보다 dev 서버가 먼저 떠서 초기 DB 연결이 실패하던 문제 (2026-08-12)

PC를 재부팅했더니 Docker는 정상 기동됐는데 `localhost:3000`이 한동안 연결이 안 되는 것처럼 보인다는
사용자 보고. `.dev-server.log` 확인 결과 재부팅 직후 `Connection terminated unexpectedly`/
`Connection terminated due to connection timeout` 에러가 여러 번 찍혀 있었다. 원인 확인:

- Docker의 `scrape-postgres` 컨테이너 시작 시각과 `ScrapeDevServer`(`/SC ONLOGON`) 작업으로 뜬
  `next dev` 프로세스 시작 시각이 겨우 36초 차이(로그온 시 두 자동시작이 거의 동시에 걸림). 컨테이너가
  "Up" 상태가 돼도 Postgres 자체가 실제로 연결을 받기까지 몇 초가 더 걸리는데, `start-dev-server.cmd`는
  이를 전혀 기다리지 않고 곧바로 `next dev`를 띄워 첫 DB 쿼리들이 실패했다.
- 몇 분 뒤 재확인하니 이미 자연히 정상화돼 있었다(Postgres 연결 재시도 자체는 `pg` 드라이버가 알아서
  하므로 완전히 멈추지는 않음) — 그래도 재부팅마다 운에 따라 재현될 수 있는 구조적 틈이라 근본 수정.

**수정**: `scripts/start-dev-server.cmd`에 `npm run dev:clean` 실행 전 Postgres 준비 대기 루프 추가 —
`docker exec scrape-postgres pg_isready`를 최대 45회(각 시도 사이 약 2초, 최대 ~90초) 재시도하고,
준비되면(또는 상한을 넘기면) 곧바로 dev 서버를 띄운다. 이 스크립트는 `restart-dev-server.ps1`(매일
새벽 4시 재기동)도 그대로 재사용하므로 두 경로 다 한 번에 적용된다. `restartPtpServer()`(수동 재시작
버튼 + 메모리 임계치 자동재시작, `lib/systemRestart.ts`)는 이 스크립트를 안 거치고 별도로
`npm run dev:clean`을 직접 호출하는데, 이 경로는 앱이 이미 떠서 도는 중에만 트리거되므로(즉 그 시점엔
DB가 이미 정상 연결돼 있었다는 뜻) 같은 대기 로직이 필요 없어 손대지 않았다.

**구현 시 겪은 배치 스크립트 함정(전부 실사용 테스트로 검증)**:
- 재시도 루프에서 `goto`로 `( ... ) > 파일` 리다이렉션 블록(또는 그 안에 중첩된 `for /L do (...)`) 밖의
  라벨로 빠져나가면, 그 이후 출력이 리다이렉션을 벗어나 콘솔로 새어나간다(cmd.exe의 잘 알려진 한계) —
  `goto`/라벨을 전혀 안 쓰고, `set DBREADY=` + `for /L`의 매 반복마다 `if not defined DBREADY (...)`로
  건너뛰는 플래그 방식으로 재작성해서 해결.
- `timeout /t N /nobreak`는 콘솔 핸들이 없는 비대화형 컨텍스트(예약 작업이 띄운 창 숨김 cmd.exe)에서
  실제로는 대기하지 않고 즉시 반환될 수 있다(실사용 테스트로 확인: 3회 재시도가 1초 안에 다 끝남) —
  `ping -n 3 127.0.0.1 >nul`(약 2초)로 대체, 같은 조건에서 정확히 대기함을 확인.
- 배치 파일에 한글 텍스트를 넣었더니 인코딩 문제로 파서 자체가 깨졌다(`echo` 문구가 글자 단위로
  잘려 "명령이 아닙니다" 오류) — 이 스크립트의 echo 문구는 전부 영문으로 유지.

## 관련 파일
- `scripts/start-dev-server.cmd`: Postgres 준비 대기 루프 추가.

## 재컴파일 경합으로 인한 500/스타일 깨짐 (2026-08-22)

Claude Code가 한 세션 안에서 수십 개 파일을 짧은 시간에 잇달아 저장하자, webpack dev 서버가 그때마다
재컴파일을 시작하면서 여러 재컴파일이 겹쳐 도는 상황이 생겼다. 그 도중 들어온 요청이 아직 다 쓰이지
않은 webpack 빌드 매니페스트를 읽어버려 두 가지 증상이 실사용으로 확인됐다:

- 서버 로그에 `SyntaxError: Unexpected end of JSON input`과 함께 `GET /api/sites/3 500 in 5.6s` — 빈
  파일을 파싱해 생기는 에러.
- 브라우저에는 CSS가 하나도 안 먹은 화면(사이드바 로고가 원본 크기 그대로, 레이아웃 없이 쌓인 버튼들)
  이 순간적으로 노출됨 — CSS 청크가 아직 준비 안 된 상태로 응답됨.

Next.js 공식 문서(`node_modules/next/dist/docs`)에는 이 dev 서버 내부 매니페스트 read/write 경합
자체를 끌 수 있는 옵션이 없다 — 100% 원천 차단하는 공식 스위치는 없다. Turbopack이면 다를 수 있지만,
바로 위 "Turbopack → webpack 전환" 항목대로 알약(백신) 충돌로 이미 의도적으로 꺼둔 상태라 되돌리지
않는다.

**완화책**: `next.config.ts`에 dev 전용 `webpack.watchOptions.aggregateTimeout`을 늘려, 짧은 시간에
몰린 파일 저장을 재컴파일 1번으로 묶는다 — 재컴파일이 겹쳐 도는 구간 자체를 줄여 경합 확률을 낮춘다
(100% 보장은 아님, 완화책).

```ts
webpack: (config, { dev }) => {
  if (dev) config.watchOptions = { ...config.watchOptions, aggregateTimeout: 1000 }
  return config
},
```

이 현상은 사람이 파일 하나씩 저장하는 평소 개발 흐름에서는 거의 안 보이고, AI 에이전트가 한 번에
파일을 몰아서 고칠 때 노출 확률이 높아지는 구조다 — 재현되면 `scripts/restart-dev-server.ps1`로 dev
서버를 한 번 깨끗하게 재시작하면 즉시 해소된다.

### 관련 파일
- `next.config.ts`: `webpack()` 훅에 `aggregateTimeout` 추가.
