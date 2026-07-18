# WebAuthn/Windows Hello 로그인 몰 — "직접로그인 필수" 표시 및 처리 — 요구사항 기록

## 배경

`mojasareo.com` 몰의 로그인 창(스크래핑 메뉴의 "로그인 창 열기")에서 로그인이 계속 되지 않는 문제를
사용자가 신고하며 시작된 세션. 순서대로 원인을 좁혀갔다:

1. 로그인 페이지 자체를 스크랩해 확인 — 카페24 표준 스킨, reCAPTCHA 등 눈에 띄는 봇 차단은 없음. 다만
   `certificationUrl` 필드와 `ipin-ec.cafe24.com` 본인인증 연동이 로그인 폼에 걸려있음을 확인.
2. `navigator.webdriver` true / 잘린 User-Agent 문자열 등 자동화 탐지 신호를 의심해 제거.
3. 그래도 실패 — 사용자가 "별도 크롬으로 직접 로그인하면 **윈도우 보안(윈도우 본인인증)** 창이 뜨는데,
   PTP가 띄우는 창은 그게 안 뜬다"고 알려줌 → WebAuthn/Windows Hello 기반 로그인 보안임을 확인.
4. Playwright 번들 Chromium 대신 실제 설치된 크롬(`channel: 'chrome'`)으로 바꿔봄 → 그래도 인증창이
   "빠르게 떴다 사라짐" — Chrome이 CDP로 자동화 제어되고 있음을 감지해(`--enable-automation`), 하드웨어
   기반 인증(WebAuthn) 요청을 사람이 응답하기 전에 자동으로 취소하는 것으로 결론.

## 요구사항 (사용자 지시 원문 기준)

> 별도로 브라우저를 통해 id, pw를 직접 입력하고 클릭하면, pc인증을 거쳐. 근데 PTP에서 띄우는 브라우저는
> pc인증을 거치지 않는데, 그 것 때문 아닐까?

> 응 그렇게 해 볼게. 앞으로도 동일한 경우의 다른 mall이 생긴다면 이와 같은 방법으로 처리되도록 개발하고,
> 나에게 '직접로그인 필수' 이렇게 mall 정보에 표기를 해줘.

즉:
1. WebAuthn/Windows Hello 기반 로그인은 Playwright 자동화로 근본적으로 통과 불가 — 이걸 붙잡고 더
   자동화를 시도하는 대신, "사용자가 완전히 별도인 진짜 크롬으로 딱 한 번 수동 로그인 → 그 세션(쿠키)을
   이후 스크래핑이 재사용"하는 흐름으로 우회한다.
2. 이런 몰은 Mall 정보에 "직접로그인 필수"로 표기해, 다음에 같은 증상을 겪을 때 바로 알아볼 수 있게 한다.

## 구현된 설계 결정

- **`sites.manual_login_required` (BOOLEAN)**: Mall 단위로 이 로그인 보안 방식을 쓰는지 표시. 자동 판별이
  아니라 사용자가 직접 겪어보고 켜는 수동 플래그 — WebAuthn 사용 여부를 스크립트로 사전에 확실히 판별할
  방법이 없기 때문(로그인 페이지 정적 마크업만으로는 조건부 로직을 알 수 없음).
- **Mall 관리 화면 표기**: `SiteDetailPanel`에 체크박스, `SitesListPanel` 목록에 배지(🔒 직접로그인 필수)로
  노출.
- **별개로 시도했다가 유지한 개선**: 로그인 창을 실제 설치된 크롬(`channel: 'chrome'`)으로 띄우고,
  `navigator.webdriver`를 숨기고, `chromiumSandbox: true`로 `--no-sandbox` 경고 배너를 없앤 것 — 이후
  드러난 진짜 원인과는 별개지만, 일반적인 봇 탐지(UA/webdriver 체크) 회피에는 유효해 그대로 유지.

### 시행착오 — 전용 프로필 폴더 접근은 실패

처음엔 `.playwright-profiles/{siteId}`(원래 "로그인 창 쿠키를 남겨 이후 헤드리스 스크래핑이 재사용"하던
전용 폴더, `lib/scraper.ts`의 `withContext`)를 그대로 살려, PTP의 자동화 창 대신 그 폴더를 가리키는
완전히 독립적인 실제 크롬(`chrome.exe --user-data-dir=... channel:'chrome'`, `child_process.spawn`으로
CDP 연결 전혀 없이 띄움)으로 수동 로그인하게 하는 방식(`openManualLoginWindow`)을 만들었다. 이 창에서는
Windows 보안(PC인증) 창이 정상적으로 뜨고 통과도 됐지만, **PC인증 통과 후에도 몰 서버가
"아이디 또는 비밀번호가 일치하지 않습니다"로 로그인 자체를 거부**했다 — 같은 아이디/비번을 사용자의
평소 개인 크롬으로 시도하면 즉시 정상 로그인됨을 확인해, 원인이 자동화 여부가 아니라 **프로필(브라우저
저장공간) 자체가 몰 입장에서 낯선 기기로 취급되는 것**임을 특정했다. 즉 PC인증(하드웨어 인증)은 통과해도,
그 프로필에 그 몰에 대한 기존 신뢰(쿠키/기기인식)가 없으면 로그인 자체가 거부된다.

### 최종 해결 — 사용자의 실제 개인 크롬 프로필을 그대로 사용

대안으로 검토한 3가지(①개인 프로필 그대로 사용 ②개인 프로필에서 로그인 후 쿠키만 수동 이전
③크롬 암호화 쿠키 저장소를 자동으로 복사) 중, 사용자가 가장 간단한 **①번**을 선택했다:

- **로그인 창 열기**(`lib/scraper.ts`의 `openManualLoginWindow`): `--user-data-dir`를 아예 지정하지 않고
  `spawn` — 평소 더블클릭으로 여는 크롬과 완전히 동일하게 사용자의 실제 기본 프로필로 뜬다.
- **헤드리스 스크래핑**(`withContext`): `sites.manual_login_required`를 DB에서 확인(`isManualLoginSite`)해,
  참이면 전용 폴더 대신 `realChromeUserDataDir()`(`%LOCALAPPDATA%\Google\Chrome\User Data`)를
  `launchPersistentContext`에 그대로 사용한다.
- **일반화**: `isManualLoginSite`가 `sites.manual_login_required` 플래그만 보고 판단하므로, 같은 유형의
  다른 몰도 그 플래그만 켜면 자동으로 이 방식(개인 프로필 사용)이 적용된다 — 몰별 특수 코드 불필요.
- 스크래핑 화면 안내 문구(`components/panels/ScraperPanel.tsx`)도 "복사해서 별도 명령 실행" 방식에서
  "본인 크롬을 닫고 로그인 창 열기를 누르면 본인 프로필이 그대로 뜬다"는 설명으로 교체.

### 후속 — "현재 페이지로" 버튼 및 안내 문구 정리

`getOpenPageUrl(siteId)`는 Playwright가 추적하는 `openSessions` 컨텍스트에서 현재 URL을 읽는데,
직접로그인 필수 몰은 완전히 독립된(추적 안 되는) 실제 크롬 프로세스를 쓰므로 이 함수가 항상 `null`을
반환해 "현재 페이지로" 버튼이 조용히 아무 일도 안 했다. CDP로 다시 연결해 살리는 방법은 검토했으나,
그러면 애써 고친 로그인(WebAuthn 자동취소 문제)이 재발할 위험이 커 시도하지 않았다. 대신 이 몰에서는
그 버튼 자리를 "시작페이지를 직접 입력해 주세요" 안내로 대체했다. 직접로그인 안내 문구(로그인 정보
섹션 상단)도 장황했던 걸 간결하게 줄였다.

### 후속 — 개인 크롬이 열려있으면 자동으로 닫고 재시도 (시도했다가 되돌림)

사용자가 개인 크롬을 켜둔 채 미리보기/스크랩을 시도하면 `launchPersistentContext`가 프로필 lock으로
실패했는데, 처음엔 "직접 닫아달라"는 에러만 띄웠다. 사용자 요청으로 자동 종료를 추가했었다: 실패 시
`taskkill`(`/F` 강제 종료 아님)로 정상 종료를 요청하고 2초 뒤 한 번 자동 재시도. **그런데 크롬의 프로필
lock은 탭/창 단위가 아니라 프로세스(브라우저 전체) 단위라, "이 몰 탭만" 골라 닫는 게 기술적으로 불가능** —
자동 종료를 실행하면 사용자가 평소 쓰던 무관한 다른 탭까지 전부 닫혀버려, 사용자가 "PTP를 쓸 수가 없다"고
반발해 이 자동 종료는 제거했다. 지금은 다시 "직접 닫아달라"는 에러만 보여주고, 실제로 닫는 건 사용자가
판단해서 하도록 되돌아갔다.
곁들여, `preview`/`preview-catalog` 라우트가 예외를 안 잡고 있어서 이 에러 메시지 자체가 화면에
`확인 실패: 500`으로 뭉개지던 것도 같이 고쳤다(try/catch로 실제 메시지 반환) — 이건 그대로 유지.

### 후속 — 전용 프로필 + 쿠키만 이전하는 방식 (시도했다가 폐기)

"스크랩하는 동안 크롬을 못 쓰는" 문제 자체를 없애려고, 격리된 전용 프로필(`profileDir`)은 그대로 두고
개인 크롬에서 로그인한 뒤 그 세션 쿠키만 Playwright의 `context.cookies()`/`context.addCookies()` 정식
API로 전용 프로필에 옮겨 심는 방식(`importPersonalChromeCookies`)을 만들어봤다. 실제로 옮겨보니 헤드리스
미리보기가 에러 없이 "성공"했지만, 반환된 데이터가 전부 가짜였다(상품명 대신 사이트 이름, 이미지 URL
대신 alt 텍스트). 그 상품 페이지를 로그인 없이 직접 열어보니 `/member/login.html`로 그대로 리다이렉트되는
것과 정확히 같은 모양 — **옮겨온 쿠키로도 서버는 로그인 안 된 것으로 취급**하고 있었다. 이 몰은
`사업자회원전용 도매쇼핑몰`(메타 설명)이라, 세션이 쿠키값만이 아니라 **PC인증을 실제로 통과한 그 브라우저
자체에 묶여있는 것으로 추정** — 쿠키만 복사해서는 신뢰가 안 옮겨진다. 이 방식은 작동하지 않아 폐기하고
`importPersonalChromeCookies`/관련 API 라우트를 제거, 개인 프로필을 로그인·스크래핑 모두에 그대로 쓰는
방식으로 되돌아갔다(커밋 `b22c554`).

**최종 운영 방법**: 이 몰을 스크랩하는 동안엔 개인 크롬을 닫아둬야 하는 제약은 그대로 남는다. 사용자가
제안한 실용적 해법 — 크롬은 이 몰(과 PTP 자동화) 전용으로만 쓰고, 평소 웹서핑은 다른 브라우저(엣지 등)로
분리하면 이 제약이 실질적으로 문제가 안 된다(별개 프로세스/프로필이라 서로 전혀 안 건드림). 코드 변경
없이 사용자 쪽 사용 습관으로 해결.

### 후속 — PTP 자체를 크롬으로 열면 엣지로 유도하는 팝업

위 운영 방법을 사용자가 잊지 않도록, PTP를 크롬으로 열면(Edge/Opera/Brave는 UA에 `Chrome/`이 있어도
각각 `Edg/`, `OPR/`, `Brave/`로 구분해 제외) "PTP는 엣지 브라우저에서 열어주세요" 팝업을 띄운다
(`components/shell/ChromeWarning.tsx`, `app/layout.tsx`에 전역 삽입). "엣지 바로가기" 버튼은 엣지 설치 시
Windows가 기본 등록하는 `microsoft-edge:` 프로토콜 핸들러로 현재 페이지를 그대로 엣지에서 연다(별도
설치/확장 불필요, `window.location.href = 'microsoft-edge:' + 현재 URL`).
이건 어디까지나 "크롬을 이 몰 전용으로 비워두라"는 운영 습관을 상기시키는 용도일 뿐 — PTP를 어느
브라우저로 여는지는 "현재 페이지로" 같은 서버 쪽 기능(Playwright 추적 여부)과는 무관하다.

### 후속 (2026-07-18) — 개인 프로필 방식도 결국 실패, 크롬 확장(개발자모드)으로 전환

"최종 해결"로 기록했던 개인 프로필 직접 사용 방식이 **최신 크롬(136+)에서 근본적으로 막혔다**:
크롬이 `--user-data-dir`가 OS 기본 프로필 디렉터리로 잡히는 원격 디버깅(CDP) 자체를 보안상 거부한다
("DevTools remote debugging requires a non-default data directory", 인포스틸러 악성코드 대응 조치,
엔터프라이즈 정책으로도 우회 불가). 그래서 프로필 전체를 별도 경로에 복사한 사본을 대신 띄우는 방식
(`syncManualLoginProfileCopy`)으로 한 번 더 우회를 시도했으나 — 이 사본은 CDP 연결까지는 성공했지만
(사용자가 신고한 "크롬을 모두 닫아도 실패" 증상의 실제 원인이 바로 이 CDP 거부였음), 실제 로그인 세션
자체가 파일 복사로는 옮겨지지 않아(신뢰가 프로필 파일이 아니라 그 브라우저/기기 자체에 묶여있음) 여전히
로그인 안 된 상태로 취급됐다.

**최종 채택**: `chrome.debugger` API 기반 크롬 확장(`extension-poc/`). Playwright/CDP 커맨드라인 자동화가
아니라 크롬 자체의 내부 확장 API라 위 원격 디버깅 거부 대상이 아니고, 사용자의 실제 로그인된 브라우저를
그대로 읽는다. 확장 아이콘 클릭 → 현재 탭 도메인으로 `/api/sites/resolve`를 호출해 siteId를 알아냄 →
상품 목록을 순회하며 `chrome.debugger`의 `Runtime.evaluate`로 페이지에서 직접 정보를 추출 →
`/api/scrape/extension-ingest`로 전송해 기존 스테이징 파이프라인에 그대로 태움. 모자사러 실제 카테고리
3페이지(45개 상품)까지 스크랩 검증 완료.

- 확장은 몰 하나에 종속되지 않는다 — 탭 도메인으로 siteId를 물어보므로, 같은 유형의 몰이 또 생겨도
  Mall 관리에서 체크박스만 켜면 되고 확장을 새로 만들거나 재설치할 필요가 없다.
- Mall 관리 표기를 실제 처리 방식에 맞게 "🔒 직접로그인 필수" → "🧩 크롬익스텐션-개발자모드"로 변경
  (`sites.manual_login_required` 컬럼/의미는 그대로 두고 라벨과 동작만 바꿈).
- 이 방식은 사람이 브라우저를 직접 열고 클릭해야 해서 cron 기반 "매일 자동 재스크랩"이 구조적으로
  불가능하다 — Mall 관리에서 해당 설정을 숨기고 저장 시 강제로 꺼지도록 함.
- 스크래핑 화면(`ScraperPanel.tsx`)도 이 몰이면 기존 로그인/시작URL/미리보기/시작버튼 UI를 전부 숨기고,
  사용법 안내 + 실시간 세션 이력(5초 폴링, `ScrapeSessionGrid` 재사용)으로 교체.
- 기존 `openManualLoginWindow`/`syncManualLoginProfileCopy`/`realChromeUserDataDir`/`isManualLoginSite`
  (`lib/scraper.ts`)와 `manualLogin` 로그인 라우트 분기는 이제 화면에서 트리거되지 않는 죽은 코드가
  됐지만, 이번 범위에서는 삭제하지 않고 남겨둠(알려진 정리 대상).

### 후속 — 스크랩 방식 "미정" 상태 도입 (2026-07-19)

신규 Mall을 등록하는 시점에는 그 몰이 PC인증 등으로 자동 로그인이 안 되는(개발자모드가 필요한) 몰인지
미리 알 방법이 없다(위에서 이미 여러 번 확인된 사실 — 실제로 겪어봐야 안다). 그런데 지금까지는 등록
즉시 `manual_login_required = false`(일반모드)로 암묵 결정돼버려, 나중에 문제를 겪어야 사용자가 뒤늦게
체크박스를 찾아 켜야 했다. `sites.manual_login_required`를 3단계로 재해석했다(컬럼은 이미 NULL을
허용해 마이그레이션 불필요):
- `null` = 아직 결정 안 함(신규 Mall 기본값)
- `false` = 일반모드, `true` = 개발자모드

Mall 상세관리는 체크박스 대신 "❔ 아직 모름 / 🤖 일반모드 / 🧩 개발자모드" 3단 선택으로 바뀌었고, 미리
정하지 않아도 스크래핑 화면에서 그 몰을 처음 선택하는 순간 "이 몰은 스크랩 방식이 아직 정해지지
않았습니다" 카드가 뜨서 그 자리에서 고르면(`PATCH /api/sites/{id}`) 바로 확정되고 기존 흐름(일반모드
UI 또는 개발자모드 안내)으로 이어진다. `lib/scraper.ts`의 `isManualLoginSite`(`!!`로 null→false 취급)와
`/api/sites/resolve`의 `WHERE manual_login_required = true`는 둘 다 null을 안전하게 일반모드로 처리해
수정이 필요 없었다.

### 후속 — 개발자모드 진행 상황 표시를 일반모드와 통일 (2026-07-19)

개발자모드 전용으로 만들었던 "세션 이력" 그리드를 없애고, 확장이 새 세션을 만들면(5초 폴링으로 감지)
그 세션의 `sessionId`/`status`를 표준 상태(`ScraperPanel`의 `sessionId`/`status`/`progress`)에 그대로
편입시키도록 바꿨다 — 그 뒤로는 일반모드에서 "스크래핑 시작"을 눌렀을 때와 완전히 같은 진행 상황
카드(진행률, 완료 시 "→ 스크랩 Raw 확인" 버튼)가 그대로 나온다. 개발자모드만의 별도 UI를 최소화해
일관성을 높였다.

## 관련 파일

- `lib/db.ts`: `sites.manual_login_required` 컬럼 (의미: "PC인증 등으로 자동 로그인이 안 돼 크롬
  확장(개발자모드)으로 스크랩하는 몰")
- `lib/scraper.ts`: `openManualLoginWindow`/`syncManualLoginProfileCopy`/`realChromeUserDataDir`/
  `isManualLoginSite` — 더 이상 화면에서 쓰이지 않는 이전 방식(정리 대상으로만 남김)
- `app/api/sites/resolve/route.ts`: 확장이 탭 도메인으로 siteId를 물어보는 공용 조회 (세션 쿠키 없이
  호출되므로 `proxy.ts`의 `PUBLIC_API_PREFIXES`에 포함)
- `app/api/scrape/extension-ingest/route.ts`: 확장이 긁은 상품을 기존 `scrape_staging_items` 파이프라인에
  태우는 입력 경로 (마찬가지로 `PUBLIC_API_PREFIXES`)
- `app/api/sessions/route.ts`: `?siteId=` 필터 추가 (스크래핑 화면의 몰별 세션 이력 조회용)
- `extension-poc/manifest.json`, `background.js`: 몰 공용 크롬 확장 본체
- `components/panels/SiteDetailPanel.tsx`: "🧩 크롬익스텐션-개발자모드" 체크박스, 자동 재스크랩 섹션
  조건부 숨김 + 저장 시 강제 비활성화
- `components/panels/SitesListPanel.tsx`: 목록 배지
- `components/panels/ScraperPanel.tsx`: 개발자모드 몰이면 안내 + 세션 이력 그리드로 교체
- `components/shell/ChromeWarning.tsx`, `app/layout.tsx`: 크롬으로 PTP 접속 시 엣지 유도 팝업 (개인
  프로필 스크랩 방식 시절의 운영 습관 안내 — 지금은 모자사러에 해당 없지만 다른 몰엔 여전히 유효)

## 상태

**구현 완료 (2026-07-18, 크롬 확장 방식으로 전환).** 이전 개인 프로필 방식 커밋: `a74832f`, `3e517e9`,
`763a775`, `e9c74e0`, `18493c2`(이후 되돌림), `037918f`, `b22c554`, `efe87ab`, `b92f31d`(엣지 유도 팝업,
지금도 유효). 이번 전환 커밋: `b1bad0d`(비표준 몰 추출 폴백 + 프로필 복사 시도 — 결과적으로 이것도
실패로 판명), `564523a`(크롬 확장 도입 + Mall 표기 변경 + 화면 재설계).
`mojasareo.com`(site id 3)에서 크롬 확장으로 실제 카테고리 3페이지·45개 상품 스크랩 성공까지 확인함.

**후속 (2026-07-19).** 미정 상태 도입 + 진행 상황 표시 통일: 커밋 `654c6cb`. 관련 정확도 개선(신우 링크
패턴, www 유무 처리 등)은 `56e71d2`에 같이 포함(`!specifications/scrape-adjustment.md` 참고).
