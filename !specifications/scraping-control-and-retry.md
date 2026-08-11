# 스크래핑 제어 — 중지 / 실패 상품만 재수집 / 로그인 창 유지

## 배경

스크래핑 도중 CAPTCHA나 몰 쪽 일시적 오류로 일부 상품만 실패하는 일이 잦은데, 지금까지는 실패해도 어떤
상품이 왜 실패했는지 화면에서 구분이 안 됐고, 재시도하려면 전체를 처음부터 다시 스크랩해야 했다. 또한
개발자모드에는 중지 버튼 자체가 없었고, "스크래핑 시작"을 누르면 로그인 확인을 위해 열어둔 브라우저 창을
앱이 강제로 닫아버려 CAPTCHA를 풀고 재시도하려던 흐름이 매번 끊겼다.

사용자가 확정한 방향:
1. 수집 실패한 상품이 있으면 실패사유를 성공 상품과 분리해 별도로 표시한다.
2. 실패한 상품만 재수집할 수 있어야 한다 — 정상 수집된 상품은 다시 스크랩하지 않는다.
3. 개발자모드도 일반모드처럼 중지 버튼을 갖춰야 한다.
4. 로그인/CAPTCHA 확인을 위해 열어둔 브라우저 창은 스크래핑 시작 시 앱이 임의로 닫지 않는다 — 이미 열려
   있으면 재사용한다.

## 설계

### 중지 — 일반모드와 동일한 경로를 개발자모드에도 노출

`lib/scraper.ts`의 기존 `requestStop`/`isStopRequested`(in-memory `Set<sessionId>`)를 그대로 재사용.
`clearStopRequest(sessionId)`를 추가해 재시도 시작 시 이전 중지 신호가 남아있지 않게 정리한다.

개발자모드(확장)는 백엔드 상태를 폴링할 수 없는 별도 프로세스라, 공개 GET 라우트
`app/api/scrape/stop-requested/route.ts`(`?sessionId=` → `{stop}`)를 신설해 `background.js`의 수집 루프가
매 상품 처리 전 확인하고, `true`면 `outer: break outer`로 즉시 중단한다. `ScraperPanel.tsx`의 실행 버튼은
`mallMode === 'devmode' && status === 'running'`일 때도 일반모드와 같은 "⏸ 스크래핑 중지" 버튼을 그린다
(별도 UI를 새로 만들지 않고 기존 `handleStop` 재사용).

### 실패 추적 — 성공/실패를 같은 로그 테이블에 status로 구분

기존 `scrape_item_log`에 이미 있던 컬럼을 그대로 쓰되, 지금까지 성공 시에만 기록하던 것을 실패 시에도
기록하도록 양쪽 다 채운다:
- `app/api/scrape/extension-ingest/route.ts` — body에 `error`가 있으면 `status='failed'`로 INSERT하고
  종료; 없으면(정상) 기존 스테이징 처리 후 `status='success'`로도 INSERT.
- 일반모드(`lib/scraper.ts` 워커 루프)는 이미 `scrape_item_log`를 쓰고 있던 경로에 실패 케이스를 맞춰
  둘 다 조회 가능하게 함.

`app/api/scrape/failed-urls/route.ts`(신규, 공개 GET, `?siteId=`)는 "실패 로그는 있는데 그 이후 성공 로그가
없는" URL만 골라 반환(`NOT IN` 서브쿼리로 성공 여부 확인) — 재시도로 성공한 URL은 자동으로 목록에서
빠진다.

`ScraperPanel.tsx`는 `itemLog`를 `status`로 나눠 "❌ 수집 실패 (N개)"(URL + 에러 메시지 표시)와
"✓ 수집 성공 (N개)" 두 박스로 분리 표시.

### 재수집 — 실패 URL만 다시

- 일반모드: 기존 재시도 워커 루프가 실패 URL 목록만 대상으로 다시 돌게 함(같은 세션 재사용).
- 개발자모드: ~~`background.js`에 컨텍스트 메뉴 항목 "PTP 실패 상품 재수집"(`ptp-retry-failed`)을 추가,
  클릭 시 `retryFailed(tab)`이 `failed-urls` 엔드포인트로 목록을 받아와~~ **폐기됨(2026-08-07)** —
  팝업이 "🔍 스크랩 미리보기 실행"/"🔄 스크랩 시작" 2개 실행 버튼만 남은 순수 트리거로 정리되며
  `retryFailed`/`app/api/scrape/failed-urls`도 함께 제거됐다(`!specifications/manual-login-required-malls.md`
  참고). 개발자모드에서 실패 재수집이 필요하면 지금은 "스크래핑 시작"을 다시 눌러 이어서 스크랩하는
  방식만 남아있다.

### 중지 확정 타이밍 — 좀비 세션 방지와 "실제 상태와 다른 화면" 문제를 동시에 해결

처음엔 `POST /api/scrape/stop`이 `requestStop` 직후 곧바로 DB `status`를 `'stopped'`로 확정했다 —
브라우저 탭/MV3 서비스워커가 죽어버린 좀비 세션(아무도 `stop-requested`를 폴링하지 않아 상태가 영원히
`running`에 멈추는 문제)을 막기 위해서였다. 그런데 개발자모드는 실제 루프가 사용자 브라우저에서 돌고
있어 이 신호는 "멈춰달라"는 요청일 뿐 즉시 멈추는 게 아니다(상품 하나 처리 주기, 신우 기준 약 10초).
즉시 확정해버리면 PTP 화면은 "중지됨"을 보여주는데 실제 브라우저 탭은 몇 초~10여 초간 계속 상품을
순회하는 게 눈에 보이는 불일치가 생겼다(사용자 보고로 발견).

`app/api/scrape/stop/route.ts`를 수정: `requestStop` 직후 즉시 DB를 확정하지 않고, 확장이 실제로 멈춘
뒤 스스로 보고하는 것(`extension-ingest`의 `done` 처리)을 우선 기다린다. 대신 그 보고가 끝내 오지
않을 때만(좀비 세션) 처리하도록 `setTimeout`으로 20초 뒤 강제 확정하는 폴백을 건다(응답은 막지 않고
백그라운드로 예약). 살아있는 세션은 화면과 실제 상태가 항상 일치하고, 죽은 세션은 20초 안에는
반드시 풀린다.

### 좀비 세션 자동 감지 — 사용자가 중지를 누르지 않아도 조용히 죽는 경우

위 20초 폴백은 사용자가 실제로 "중지"를 눌렀을 때만 작동한다 — 그런데 개발자모드 확장은 아무도 중지를
누르지 않아도 스스로 조용히 죽을 수 있다(MV3 서비스워커 종료, `chrome.debugger` 분리, 탭 새로고침/포커스
아웃 등). 이 경우 `extension-ingest`로의 `POST`도, `stop-requested` 폴링도 전부 뚝 끊기고 아무 에러도
남기지 않은 채(죽는 순간 실행 중이던 코드가 통째로 사라지므로) 세션이 `running`에 영원히 멈춘다 —
사용자가 우연히 상태를 다시 볼 때까지 아무도 알아채지 못한다(실제 발견된 사례: 신우 세션이 마지막 활동
후 4분 넘게 `running`으로 멈춰 있었는데 중지 요청 이력이 없었음).

`app/api/scrape/status/route.ts`(PTP가 세션 진행 중 2초마다 자동 폴링하는 경로)에 감시 로직을 추가: 이
세션의 마지막 `scrape_item_log` 활동 시각(없으면 세션 생성 시각)으로부터 90초(일반적인 상품 처리 주기
보다 훨씬 긴 여유)가 지났는데도 `status='running'`이면, 폴링이 오는 그 순간 서버가 자동으로
`'stopped'`로 확정한다. 별도 백그라운드 워커나 크론 없이, 이미 존재하는 폴링 경로에 얹은 것이라 추가
인프라가 필요 없다 — 다만 아무도 그 세션의 상태를 더 이상 조회하지 않으면(패널을 떠난 뒤) 감지도 멈추고,
나중에 다시 들여다볼 때(devmode 사이트 선택 시 `checkForRunningSession`이 재개) 그제서야 해소된다.

### 로그인 창 강제 종료 제거

`lib/scrape/run.ts`의 `runScraping()` 시작부에서 `closeLoginWindow(siteId)`를 무조건 호출하던 코드를
제거(설명 주석만 남김). `withContext`가 이미 갖고 있던 "열린 창이 있으면 재사용" 로직이 이제 실제로
동작한다 — CAPTCHA를 풀어둔 창이 그대로 유지된 채 스크래핑이 이어진다.

## 2026-08-11 재설계 — 일반모드 "중지"가 백엔드에서 실제로는 안 멈추던 문제 + 수집 단계 진행률 사각지대

### 배경 — "중지를 눌러도 백엔드는 계속 스크래핑 중이었다"

일반모드(서버가 직접 Playwright를 돌리는 몰)에서 "동시처리수동 2"로 스크랩을 시작했는데 크롬 창이
여러 개 뜨는 걸 사용자가 발견 → 조사 요청 → "중지를 눌렀는데도 백엔드에서 여전히 스크래핑이 계속되고
있었다"는 게 재확인되면서, 사용자가 명확히 요구: 화면에서 중지/시작/옵션변경을 누르면 백엔드 전반이
반드시 같은 상태로 움직여야 하고, 이게 어긋나는 지점을 전부 다시 점검해서 재설계하라는 것.

기존 위 "중지 확정 타이밍"/"좀비 세션 자동 감지" 절은 **개발자모드(확장이 도는)를 기준으로 설계된
20초/90초 타이머**였다 — "이 시간이 지났는데도 running이면 죽은 것으로 본다"는 논리인데, 일반모드는
`withContext`가 시작부터 끝까지 `withSiteLock`을 쥐고 있어 "지금 이 몰 작업이 실제로 진행 중인가"를
직접 아는 방법(`getSiteLockStatus`)이 이미 있었다. 그런데 두 타이머 다 이 신호를 전혀 참조하지 않고
시간만으로 확정해버려, 상품 하나가 재시도 backoff나 차단 감지 대기로 잠깐 오래 걸리면(90초 초과)
실제로는 멈추지 않았는데 DB만 `'stopped'`로 확정되는 불일치가 실사용에서 확인됐다 — 화면은 "중지됨"을
보여주는데 뒤에서는 계속 상품을 쌓고 있었다.

### 수정 1 — 20초/90초 타이머를 site-lock 상태로 게이팅

- `app/api/scrape/stop/route.ts`: `requestStop` 직후 예약하는 20초 강제확정 타이머 실행 시점에
  `getSiteLockStatus(siteId)`를 다시 확인 — 락이 아직 살아있으면(=아직 실제로 안 멈춤, 좀비가 아님)
  확정을 건너뛴다. 락이 실제로 풀리는 순간(=`run.ts`가 최종 상태를 직접 씀)까지 기다리게 된다.
- `app/api/scrape/status/route.ts`: 90초 좀비 감지 조건에 `!getSiteLockStatus(row.site_id)`를 추가 —
  락이 살아있으면 로그 정체와 무관하게 죽은 게 아니라고 판단해 확정하지 않는다.
- 두 라우트 다 개발자모드(사이트 락을 안 쥐는 구조)에는 영향 없음 — `getSiteLockStatus`가 항상
  `null`이라 기존 시간 기반 판정 그대로 동작.

### 수정 2 — URL 수집(카테고리 목록 순회) 단계엔 중지 체크가 아예 없었음

다시 파이프라인을 처음부터(`runScraping` → `scrapeCatalogPage` → `collectProductUrls`) 재추적하다가
발견한, 수정 1과는 별개의 사각지대: 상품 URL을 모으는 `collectProductUrls`(카테고리별 페이지네이션
순회) 안에는 `isStopRequested` 체크가 **한 곳도 없었다**. 카테고리가 페이지 수십~수백 개짜리면 이
수집 단계만도 오래 걸리는데, 중지를 눌러도 상품을 하나도 못 긁은 채로 이 수집이 끝날 때까지 그냥
계속 돌았다.

- `CollectedLinks`에 `stopped: boolean` 필드 추가.
- `collectProductUrls`의 세 루프(카테고리 내 페이지 순회 `collectFromListing`, 카테고리 여러 개 동시
  순회 `worker`, 카테고리 여러 개 순차 순회) 전부에 `isStopRequested(opts.sessionId)` 체크 추가.
- `scrapeCatalogPage`가 `stopped: stoppedDuringCollection`을 받아 즉시 `{ total: 0, saved: 0, stopped:
  true, concurrencyLog: [] }`로 짧게 끝낸다.

### 수정 3 — 수집 단계 진행률이 화면에 아예 안 보이던 문제

위 수정과 별개로, "수집 진행상황은 왜 안 보여주는 거야?"라는 지적을 다시 점검하며 발견: `ScraperPanel`의
"진행 상황" 패널은 `product_count`/`saved_count`만 보는데, 이 값들은 상품을 하나씩 처리할 때
(`run.ts`의 `onItem` 콜백)만 갱신된다 — `collectProductUrls`가 도는 동안은 둘 다 0으로 남아 "수집 완료:
0개"만 계속 뜬다. 카테고리가 많은 몰(펫투비 19개)은 이 단계만 오래 걸릴 수 있는데, 멈춘 건지 도는 건지
화면에서 구분이 안 됐다. 미리보기가 이미 같은 문제를 `previewRuns`/`getPreviewProgress`로 풀어놨는데
(`scrape-preview-catalog-count-and-target-ui.md` "중복 실행 방지 + 진행률 표시" 참고), 실제 스크랩
쪽엔 그 대응이 없었다.

- `lib/scraper.ts`에 세션ID 기준 인메모리 `collectProgress`(신규, `Map<sessionId,{done,total}>`)를
  추가 — `collectProductUrls`가 카테고리 목록 길이로 `total`을 잡고, 카테고리 하나를 끝낼 때마다
  `done++`, 함수 종료 시 항목을 지운다(이후 상품별 진행률과 안 겹치게). `getCollectProgress(sessionId)`
  export.
- `app/api/scrape/status/route.ts`: 세션이 `running`일 때만 `collect_progress`로 같이 내려준다(좀비
  판정으로 `status`가 바뀐 뒤라면 안 내려줌).
- `ScraperPanel.tsx`: `progress.total===0`이면서 `collectProgress`가 있으면 "카테고리 목록 수집
  중... N / M"을 보여주고, 그 외엔 기존 "수집 완료: N개 / M개" 그대로.

### 부수 발견 — "다른 작업 진행 중" 배너가 자기 자신의 락을 다른 사람 것으로 오인

같은 재점검 중 발견한 관련 버그: `siteLockStatus` 폴링 배너(`selectedSite && siteLockStatus?.busy`)가
방금 자기 자신이 시작한 작업이 쥔 락도 "다른 작업이 진행 중"으로 그대로 보여줬다 — 자기 작업이 오래
걸리면 영원히 "누가 막고 있다"처럼 보이는 오인이었다. `handleStart`/`handlePreview` 클릭 시각을
`myLockClickAtRef`에 남기고, 배너 조건에 `sinceMs`(락을 쥔 지 얼마나 됐는지)가 그 클릭 시각보다
이전(=내가 시작하기 전부터 있던 락)일 때만 보이도록 추가.

## 하지 않는 것 (알려진 한계)

- 재시도 횟수 제한이나 자동 재시도(백오프 등)는 없다 — 사용자가 수동으로 재시도 버튼/메뉴를 누르는
  방식뿐.
- 실패 사유는 예외 메시지 그대로 노출한다 — 사용자 친화적으로 분류/번역하지 않는다.

## 관련 파일

- `lib/scraper.ts`: `isStopRequested`(export화), `clearStopRequest`(신규), 워커 루프 실패 시
  `scrape_item_log` 기록, bot-detection 오탐 방지(`cost_price`도 null 체크에 포함)
- `lib/scrape/run.ts`: 시작 시 `closeLoginWindow` 강제 호출 제거
- `app/api/scrape/stop-requested/route.ts`(신규) — `app/api/scrape/failed-urls/route.ts`는 이후 폐기(위 참고)
- `app/api/scrape/status/route.ts`: 좀비 세션(사용자 중지 없이 조용히 죽은 경우) 자동 감지·확정,
  (2026-08-11) `getSiteLockStatus`로 게이팅 + `collect_progress` 응답 필드 추가
- `app/api/scrape/extension-ingest/route.ts`: 실패 로그 기록 분기 추가
- `extension-poc/background.js`: `checkStopRequested`, `reportFailure`, `retryFailed`,
  컨텍스트 메뉴 `ptp-retry-failed`
- `proxy.ts`: `stop-requested`/`failed-urls` 공개 경로 추가
- `components/panels/ScraperPanel.tsx`: 개발자모드 중지 버튼, 성공/실패 분리 표시, 재시도 안내,
  (2026-08-11) `myLockClickAtRef`(자기 락 오인 방지), `collectProgress` 표시
- (2026-08-11) `app/api/scrape/stop/route.ts`: 20초 강제확정 타이머를 `getSiteLockStatus`로 게이팅
- (2026-08-11) `lib/scraper.ts`: `CollectedLinks.stopped`, `collectProductUrls` 3개 루프에 중지 체크,
  `scrapeCatalogPage`의 수집 단계 중지 시 즉시 반환, `collectProgress`/`getCollectProgress`(신규)

## 상태

**구현 완료.** 커밋 `3500f61` → `f5f9ce4`(좀비 세션 즉시 확정 추가, 이후 "화면과 실제 상태 불일치"
문제의 원인이 됨) → `8dc74cb`(즉시 확정 대신 20초 유예 폴백으로 수정) → `90초 상시 감시` 커밋(중지
요청 없이 조용히 죽는 세션까지 잡음) → 이번 커밋(일반모드 기준 재설계: 20초/90초 타이머를 시간만이
아니라 `getSiteLockStatus`로도 검증, 수집 단계 중지 사각지대 해소, 수집 단계 진행률 표시, 자기 락
오인 배너 수정). tsc/eslint 클린, 확장 런타임 문자열(`buildExtractExpr` 등) 실제 처리된 값 기준으로
재검증 완료. 좀비 감지 로직은 실제로 멈춰있던 세션(신우 session 50)에 대해 라이브로 자동 해소되는
것까지 확인함. 이번 재설계분은 실제 스크랩 세션으로의 라이브 재현(정지 클릭 후 site-lock이 실제로
안 풀렸던 상황)까지는 다음 실사용에서 확인 예정 — tsc/eslint 클린 + 코드 경로 재추적으로 검증.
