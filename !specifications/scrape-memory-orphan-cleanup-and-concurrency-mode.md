# 스크랩 메모리 점유 완화 — 재시작 시 orphan Chrome 정리 + 동시 처리 자동/수동 전환

## 배경

사용자 보고 두 가지:

1. PTP로 스크랩 작업을 하다 보면 메모리가 가득 차 더 이상 작업이 안 되고, PTP를 닫았다가 다시 켜도
   메모리가 줄지 않아 계속 멈춰있다.
2. 여러 카테고리를 동시에 참조하는 게 원인이라면, 일단 1개씩만 참조하게 하고 필요하면 개수를 조절할 수
   있게(자동/수동 구분) 다시 만들어달라.

## 조사

`lib/scraper.ts`를 훑어 실제로 브라우저 탭을 동시에 여는 지점 3곳을 확인했다:

- `collectProductUrls`의 `LISTING_CONCURRENCY`(카테고리별 목록/페이지네이션 수집, 고정 4)
- `previewCatalog`의 `COUNT_CONCURRENCY`(카테고리별 개수 집계, 고정 4)
- `scrapeCatalogPage`의 `MAX_CONCURRENCY`(실제 상품 페이지 스크랩, 적응형 동시성 — 1부터 시작해 연속
  성공 시 최대 8까지 스스로 올리고, 차단 감지 시 1로 낮춤). 이미지까지 로드하는 탭이 최대 8개까지 동시에
  뜰 수 있어 셋 중 메모리 영향이 가장 크다. 과거엔 사용자가 직접 숫자를 입력했는데, 이 적응형 방식이
  그 수동 입력을 대체했었다(`scrapeCatalogPage` 주석 참고) — 이번에 다시 수동 옵션을 추가한다.

"재시작해도 메모리가 안 줄어든다"는 별개 원인으로, `killOrphanedProfileProcess(siteId)`가 이미 존재하지만
**그 siteId를 다시 쓸 때만** 그 몰의 orphan `chrome.exe`를 정리한다. `app/api/system/restart-server`가
`Stop-Process`로 dev 서버 프로세스만 강제 종료하면, 헤드리스 컨텍스트의 `finally { context.close() }`가
실행될 기회 자체가 없어 그 순간 떠있던 Playwright Chrome이 그대로 orphan으로 남는다 — 재시작 후 그 몰을
다시 쓰기 전까지는(며칠~몇 주 뒤일 수 있음) 아무도 정리해주지 않아 메모리를 계속 붙들고 있었다.

## 수정 1 — 재시작 시 전체 orphan Chrome 정리

`lib/scraper.ts`:
- `killOrphanedProfileProcess`의 PowerShell 조각을 `killChromeByPathScript(pathFilter)`로 분리(경로
  필터만 파라미터화, 동작은 그대로).
- `orphanedChromeCleanupScript()`(신규, export) — `pathFilter`를 프로젝트 루트의 `.playwright-profiles`
  전체로 줘서, siteId 구분 없이 이 앱이 띄운 모든 Chrome(사이트별 프로필 + manual-login 사본 포함)을
  매칭하는 스크립트 조각을 문자열로 돌려준다(실행은 안 함 — 호출부가 자기 스크립트에 이어붙인다).

`app/api/system/restart-server/route.ts`: 처음엔 기존 재시작 스크립트(`Stop-Process` → `npm run
dev:clean`)의 raw detached spawn 방식을 건드리지 않고 `Stop-Process`와 `npm run dev:clean` 사이에
`orphanedChromeCleanupScript()`만 이어붙였다. **이후(2026-08-09) 이 가정 자체가 틀렸다는 게 재확인됨
— `docker-db-server-health-check.md`의 "이 라우트는 재현 안 됐다" 기록은 그 시점 우연이었을 뿐,
실제로는 `restart-docker`와 똑같은 Windows Job Object kill-on-close 문제가 있었다.** 자세한 경위와
최종 수정(schtasks 방식 + `lib/systemRestart.ts`로 분리)은 아래 "재시작 메커니즘이 실제로는 동작하지
않던 문제" 절 참고.

## 수정 2 — 동시 처리 자동/수동 모드

`lib/scraper.ts`:
- `ScrapeOptions.concurrencyMode?: 'auto' | 'manual'`(신규) — 생략/`'auto'`면 기존 동작 그대로.
- `resolveConcurrency(opts, autoDefault)`(신규, 내부 헬퍼) — `'manual'`이면 `opts.concurrency`를 1~8로
  clamp해서 쓰고, 아니면 `autoDefault`를 쓴다. ramp 로직이 없는 `LISTING_CONCURRENCY`/`COUNT_CONCURRENCY`
  둘 다 이걸로 교체(각각 `autoDefault=4`, 기존 고정값과 동일하게 유지).
- `scrapeCatalogPage`의 적응형 동시성은 헬퍼 대신 시작값 자체를 조정: `manualLimit`이 있으면
  `MAX_CONCURRENCY`와 `activeLimit`을 둘 다 그 값으로 맞춘다 — `activeLimit`이 이미 상한과 같아 "연속
  성공 시 상향" 조건(`activeLimit < MAX_CONCURRENCY`)이 성립하지 않아 고정된 채 유지된다. 차단 감지 시
  1로 낮추는 안전장치는 auto/manual 구분 없이 그대로 적용되고, manual이면 8이 아니라 그 고정값까지만
  다시 올라온다(관대한 값으로 설정해도 몰 차단 감지 시 안전하게 낮아진다).
- `recheckMallProducts`(연속관리 재체크)는 원래부터 `opts.concurrency`를 그대로 쓰는 고정값이라(ramp
  로직 없음) 손대지 않았다 — auto/manual 구분이 의미가 없는 기능.

전달 경로(값 하나가 미리보기/스크래핑 시작/예약 재스크랩까지 전부 관통):
- `components/panels/ScraperPanel.tsx`: "상품 페이지 미리보기" 카드 헤더에 자동/수동 토글 + 수동일 때만
  보이는 개수(1~8) 입력을 추가. `concurrencyMode`/`concurrency` state는 `handlePreview`(미리보기)와
  `handleStart`(스크래핑 시작) 요청 바디에 모두 실어 보낸다. 몰(site)과 무관한 전역 선호값이라
  `FORM_STATE_KEY`(몰별 작업 상태)와 분리해 `CONCURRENCY_PREF_KEY`로 따로 저장 — 몰을 바꿔도 "수동/1개"
  설정이 유지된다. 초기값은 `useState`의 lazy initializer로 localStorage에서 즉시 읽는다(마운트 후
  effect에서 읽으면 `react-hooks/set-state-in-effect` 린트 에러가 남 — effect 안에서 setState를
  동기적으로 부르는 대신 lazy init으로 대체).
- `app/api/scrape/route.ts` → `lib/scrape/run.ts`(`runScraping`) → `scrapeCatalogPage`: 값을 그대로
  전달하고, `productUrls` 지정이 아닌 일반 스크랩은 `sites.last_scrape_config`에도 같이 저장한다.
- `lib/scheduler.ts`(예약 재스크랩): `last_scrape_config`에서 값을 읽어 그대로 재사용 — 사용자가 없는
  시간에 도는 예약 스크랩도 같은 설정을 따른다.
- `app/api/scrape/preview-catalog/route.ts`: 요청 바디를 그대로 `previewCatalog`에 스프레드해서 넘기던
  기존 구조라 런타임 변경은 필요 없었고, 타입 캐스트에 필드만 추가했다.

## 기본값 변경 — 자동/4 → 수동/2 (2026-08-09)

실사용 확인(모니터링 로그): 자동 모드로 미리보기를 돌렸을 때 탭 7개(평상시) → 13개로 늘어난 구간이
2번 있었고, 그 구간 내내 CPU가 거의 100%에 붙어있었다(2코어 CPU에서 동시 탭이 늘면 병렬로 빠르게
끝나기보다 서로 CPU를 기다리며 전체 시간이 늘어남 — 메모리는 위험 수준까지 가지 않아 이번엔 CPU 경쟁이
"느림"의 주된 원인이었다). 이에 따라 `ScraperPanel.tsx`의 기본값을 자동/4 → **수동/2**로 바꿨다.

- `readConcurrencyPref()`의 세 fallback 지점(`typeof window==='undefined'`/파싱 성공 시 누락값/`catch`)
  전부 `{mode:'manual', value:2}`로 변경.
  `saved.mode` 판정도 뒤집었다(`saved.mode === 'auto' ? 'auto' : 'manual'` — 명시적으로 `'auto'`를
  저장해둔 경우만 자동을 유지하고, 그 외(값 없음 포함)는 수동을 기본으로 삼는다).
- **저장 키를 `scrape.scraper.concurrencyPref` → `scrape.scraper.concurrencyPref.v2`로 변경.** 이
  기능을 만든 직후부터 `ScraperPanel`이 마운트될 때마다 그 시점의 기본값(자동/4)을 곧바로
  localStorage에 써왔으므로, 브라우저에 이미 그 값이 저장돼 있다 — 키 이름을 그대로 두면 코드의
  fallback 기본값을 바꿔도 이미 저장된 값이 계속 읽혀 새 기본값이 전혀 적용되지 않는다. 로컬 단일
  사용자 도구라 서버에서 브라우저 저장값을 강제로 지우거나 마이그레이션할 방법이 없어, 키 자체를
  새로 만들어 우회했다(예전 키는 그냥 안 쓰는 채로 남는다 — 정리용 코드 불필요).

## 재시작 메커니즘이 실제로는 동작하지 않던 문제 + 메모리 임계치 자동 재시작 (2026-08-09)

### 배경 — "재시작해도 멈춘 게 안 풀린다" 재보고

미리보기 도중 PTP가 멈추고 화면 진행상황이 다 사라지는 사고가 재발했다. 조사 결과 이 서버 프로세스
(`process.memoryUsage().rss`)가 평소 300~700MB 수준에서 **3.65GB까지 불어난 채 줄지 않고** 있었다 —
V8이 한 번 늘린 힙을 스스로 OS에 반환하지 않는 특성상, 능동적으로 계속 새는 누수(handle/thread 수는
안정적이었음)라기보다 과거(지금은 고친) 지수+이분 탐색 버그가 페이지를 수백 번씩 열었던 하루의
누적 고수위로 추정된다. 이 상태에서 시스템 전체 여유 메모리도 1.12GB까지 줄어 dev 서버가 불안정해지고,
Fast Refresh 강제 새로고침이 화면 상태를 초기화한 것(`scrape-preview-catalog-count-and-target-ui.md`에
이미 기록된 증상)이 "진행상황이 사라졌다"로 나타났다고 결론지었다.

사용자가 "재시작하면 해결되는지 먼저 검증하고, 되면 재시작 시 이런 문제를 자동으로 처리하는 기능을
만들어달라"고 요청 — 검증을 먼저 하라고 명시했다.

### 발견 1 — "재시작" 버튼이 실제로는 완전히 무동작이었음

`app/api/system/restart-server/route.ts`를 실제로 두 차례 호출해 재시작 전후 PID/프로세스 시작시각을
직접 비교했다: `{"ok":true}`는 매번 정상 응답했지만 **PID와 시작시각이 완전히 동일** — 재시작이 전혀
일어나지 않고 있었다. 원인은 `child_process.spawn(powershell, {detached:true})`가 이 `npm run dev`
프로세스 안에서 호출되면 Windows Job Object의 kill-on-close 정책 때문에 조용히 실패하는 것으로 추정
(`detached:true`는 `CREATE_NEW_PROCESS_GROUP`만 줄 뿐 Job에서 breakaway는 되지 않음) —
[[windows_spawn_job_object_kill]] 메모에 이미 기록된, `restart-docker`가 예전에 겪었던 것과 동일한
문제가 이 라우트에서도 있었다(과거 스펙에 "이 라우트는 재현 안 됐다"고 남긴 기록은 그 시점의 우연이었을
뿐 실제로는 똑같이 취약했다).

**수정**: `restart-docker`와 동일하게, PowerShell 스크립트를 임시 `.ps1` 파일로 써두고
`schtasks /Create ... /SC ONCE /F` + `schtasks /Run /TN <name>`으로 작업 스케줄러에 등록해 실행하도록
전환 — 스케줄러 서비스가 완전히 별개의 프로세스 트리에서 띄우므로 이 문제를 원천적으로 피한다. 이
재시작 로직 전체(수동 버튼 + 아래의 자동 재시작이 공유)를 새 파일 `lib/systemRestart.ts`로 분리했다:
`restartPtpServer()`(재시작 실행), `isRestartInFlight()`(중복 트리거 방지 플래그 조회). 실제 재시작
확인: 3.65GB → 715MB, 핸들 1656 → 350.

### 발견 2 — 예약 작업이 "실행 중"에서 영원히 안 끝나 두 번째 트리거를 무시함

위 수정 직후 재현된 두 번째 문제: 생성한 `.ps1` 스크립트의 마지막 명령이 `npm run dev:clean`을 그대로
호출하는 것이었는데, 이 명령 자체가 새 서버로서 영원히 실행되므로 작업 스케줄러 입장에서는 이 작업이
"실행 중" 상태에서 절대 끝나지 않는다. 그 상태에서 같은 이름(`PTPRestartServer`)으로 다시 트리거하면
Windows가 "이미 실행 중인 작업"으로 보고 두 번째 실행을 조용히 무시해버렸다(실제로 재현).

**수정**: 스크립트의 마지막 단계를 `npm run dev:clean`을 직접 부르는 대신
`Start-Process -FilePath 'cmd.exe' -ArgumentList '/c npm run dev:clean' -WindowStyle Hidden`으로 완전히
분리된 프로세스로 띄우기만 하고 끝낸다 — 예약 작업 자신은 몇 초 안에 "완료(Ready/성공)" 상태가 되고,
새로 뜬 dev 서버는 그 작업과 무관하게 독립적으로 계속 산다. 매번 트리거 전에 `schtasks /End`로 혹시
남아있는 이전 인스턴스도 먼저 정리한다(실패해도 무시).

### 발견 3(검증 과정에서 실제로 겪은 사고) — 동시 인스턴스로 인한 `.next` 캐시 손상

위 수정을 수동으로 재현/검증하던 중(같은 `.ps1`을 서로 다른 경로로 짧은 시간 안에 두 번 실행), 스크립트에
박혀있던 오래된 PID를 대상으로 `Stop-Process`가 조용히 no-op된 사이 **dev 서버 인스턴스가 실제로 2개
동시에 뜬 상태**가 몇 분간 발생했다(하나는 포트 3000, 다른 하나는 포트 3001) — `orphaned_dev_server_
cache_corruption`/`dev_server_restart_corrupts_cache` 메모에 이미 기록된 것과 같은 유형의 사고를
직접 재현한 셈이다. 여파로 `/api/health/db`가 정상 JSON 대신 404 페이지 셸을 반환하는 상태가 됐다.

**복구**: 관련 프로세스(node/cmd 체인 전체)를 완전히 종료 확인 → `npm run dev:clean`으로 `.next`부터
새로 빌드해 인스턴스 1개만 정상 기동 → `{"ok":true}` 정상 응답 확인. 이 사고는 코드 버그가 아니라
검증 과정에서 수동으로 중복 실행한 데서 온 것이라 별도 코드 수정은 없음 — 다만 `restartInFlight`
모듈 플래그(이미 있던 중복 트리거 방지)가 실제 운영 경로(HTTP 라우트만 통해 트리거)에서는 이런 경합을
막아준다는 걸 재확인하는 계기가 됐다.

### 자동 재시작 — 메모리 임계치 + 유휴 상태 확인 (`lib/scheduler.ts`)

`checkMemoryAndAutoRestart()`(신규, 5분마다 실행) — 이 프로세스의 RSS가 `MEMORY_RESTART_THRESHOLD_MB`
(1536MB)를 넘고, **지금 어떤 몰이든 브라우저 세션을 쓰는 작업이 진행 중이 아니면**(`isAnySiteBusy()`,
`lib/scraper.ts`에 신규 — `siteLockStatus` 맵이 비어있는지로 판정) 조용히 `restartPtpServer()`를
호출한다. 작업 중간에 끼어들어 진행상황을 날리는 걸 막는 게 최우선이라, "지금 당장은 아니어도 다음
유휴 순간에" 정리되는 것으로 충분하다고 판단했다 — 재시작 자체가 이 프로세스를 죽이므로 "얼마 전에
이미 재시작했다"를 따로 기억해두는 코드도 불필요하다(새 프로세스는 항상 낮은 메모리로 시작).

### 검증 상태

**라이브로 엔드투엔드 검증 완료**: 실제 HTTP 라우트(`POST /api/system/restart-server`)를 1회 호출 →
기존 프로세스 정상 종료 → 예약 작업이 `Ready`/`Last Result: 0`으로 정상 완료(발견 2의 재발 없음
확인) → 새 인스턴스가 정확히 1개만 기동(포트 3000 소유 PID 단일 확인, 메모리 589MB 정상) →
`/api/health/db` 정상 JSON 응답까지 확인.

`checkMemoryAndAutoRestart`는 위에서 검증한 `restartPtpServer()`를 그대로 재사용하는 단순 임계값
비교 로직이라 코드 리뷰로는 문제없지만, 실제로 1.5GB+까지 메모리를 재현해 자동 트리거되는 순간까지는
아직 확인하지 않았다 — 다음 실사용(또는 임계값을 임시로 낮춘 강제 테스트)에서 확인 예정.

## 상태

**구현 완료.** tsc/eslint 클린(수정한 7개 파일 기준 — `npx eslint .` 전체 실행 시 나오는 나머지 경고/
에러는 이번 작업과 무관한 기존 파일들). `resolveConcurrency`의 clamp 경계값(0, 음수, 99, `undefined`)은
임시 node 스크립트로 직접 검증. 재시작 후 orphan chrome이 실제로 사라지는지는 확인됐다(`.playwright-
profiles`를 쓰는 chrome.exe 0개). 기본값을 수동/2로 낮춘 뒤의 CPU/속도 개선 체감은 사용자가 다음 사용
중 확인 예정. 재시작 메커니즘(schtasks 방식) + 메모리 임계치 자동 재시작은 별도 절 참고 — 라이브
엔드투엔드 검증 완료, 자동 트리거 자체는 다음 실사용에서 확인 예정.
