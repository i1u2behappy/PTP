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

## 하지 않는 것 (알려진 한계)

- 재시도 횟수 제한이나 자동 재시도(백오프 등)는 없다 — 사용자가 수동으로 재시도 버튼/메뉴를 누르는
  방식뿐.
- 실패 사유는 예외 메시지 그대로 노출한다 — 사용자 친화적으로 분류/번역하지 않는다.

## 관련 파일

- `lib/scraper.ts`: `isStopRequested`(export화), `clearStopRequest`(신규), 워커 루프 실패 시
  `scrape_item_log` 기록, bot-detection 오탐 방지(`cost_price`도 null 체크에 포함)
- `lib/scrape/run.ts`: 시작 시 `closeLoginWindow` 강제 호출 제거
- `app/api/scrape/stop-requested/route.ts`(신규) — `app/api/scrape/failed-urls/route.ts`는 이후 폐기(위 참고)
- `app/api/scrape/status/route.ts`: 좀비 세션(사용자 중지 없이 조용히 죽은 경우) 자동 감지·확정
- `app/api/scrape/extension-ingest/route.ts`: 실패 로그 기록 분기 추가
- `extension-poc/background.js`: `checkStopRequested`, `reportFailure`, `retryFailed`,
  컨텍스트 메뉴 `ptp-retry-failed`
- `proxy.ts`: `stop-requested`/`failed-urls` 공개 경로 추가
- `components/panels/ScraperPanel.tsx`: 개발자모드 중지 버튼, 성공/실패 분리 표시, 재시도 안내

## 상태

**구현 완료.** 커밋 `3500f61` → `f5f9ce4`(좀비 세션 즉시 확정 추가, 이후 "화면과 실제 상태 불일치"
문제의 원인이 됨) → `8dc74cb`(즉시 확정 대신 20초 유예 폴백으로 수정) → 이번 커밋(중지 요청 없이
조용히 죽는 세션까지 잡는 90초 상시 감시 추가). tsc/eslint 클린, 확장 런타임 문자열(`buildExtractExpr`
등) 실제 처리된 값 기준으로 재검증 완료. 좀비 감지 로직은 실제로 멈춰있던 세션(신우 session 50)에
대해 라이브로 자동 해소되는 것까지 확인함.
