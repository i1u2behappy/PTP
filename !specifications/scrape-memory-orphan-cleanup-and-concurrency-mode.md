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

`app/api/system/restart-server/route.ts`: 기존 재시작 스크립트(`Stop-Process` → `npm run dev:clean`)의
그대로 검증된 raw detached spawn 방식은 건드리지 않고, `Stop-Process`와 `npm run dev:clean` 사이에
`orphanedChromeCleanupScript()`를 이어붙였다. (참고: `restart-docker`가 겪은 "detached spawn이 조용히
죽는" Job Object 문제는 이 라우트에서는 재현되지 않았다는 게 스펙 문서(`docker-db-server-health-check.md`)에
이미 검증 기록으로 남아있어, 그 검증된 메커니즘 자체는 바꾸지 않았다.)

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

## 상태

**구현 완료.** tsc/eslint 클린(수정한 7개 파일 기준 — `npx eslint .` 전체 실행 시 나오는 나머지 경고/
에러는 이번 작업과 무관한 기존 파일들). `resolveConcurrency`의 clamp 경계값(0, 음수, 99, `undefined`)은
임시 node 스크립트로 직접 검증. 실사용 검증은 아직 안 됐다 — 수동 모드로 낮췄을 때 실제로 메모리 사용이
줄어드는지, 재시작 후 `Get-Process chrome`으로 orphan이 실제로 사라지는지는 다음 사용 중 확인 필요.
