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

### 후속 — "몰 URL 복사" 옆에 "브라우저에서 바로 열기" + 로그인 정보 복사 추가 (2026-07-24)

사용자: 이미지가 로그인 세션이 있어야 열리는 몰 얘기가 나오면서, 몰 URL을 복사해 사용자가 직접 붙여넣는
대신 "브라우저에서 바로 열기" 버튼으로 실제 로그인까지 자동으로 끝내줄 수 없냐는 요청.

**ID/PW 자동입력 + 자동 로그인 완료는 구조적으로 불가능하다고 판단해 만들지 않았다** — 이 창은 CDP(원격
디버깅) 연결이 전혀 없는 진짜 크롬이어야 한다(그래야 이 몰들이 자동화로 감지해 차단하지 않는다). 그런데
입력창에 값을 자동으로 채워 넣으려면 그 탭을 CDP로 붙잡고 조작해야 하므로, "자동입력이 된다" = "그
몰이 차단 신호로 감지하는 바로 그 상태"라 두 요구가 서로 모순된다.

대신 아래 절충안으로 구현:
- "🌐 브라우저에서 바로 열기" 버튼 추가(`selectedSite.login_url || selectedSite.url` — 로그인 URL이 따로
  등록돼 있으면 그쪽을 연다, 일반모드 로그인 카드와 동일한 우선순위) — 위 "정리 대상으로만 남김"이라고
  적어뒀던 `openManualLoginWindow`
  (CDP 없는 진짜 크롬을 그냥 여는 함수, `/api/scrape/login`에 `manualLogin:true`로 이미 연결돼 있었음)를
  그대로 재사용한다. 다만 이 함수/라우트는 일반모드 "로그인 확인" 카드 전용이라 `mallMode==='normal'`일
  때만 화면에 노출됐었고, 개발자모드(`mallMode==='devmode'`) 화면엔 호출 지점이 아예 없었다 — 이번에
  추가한 버튼이 개발자모드에서 이 함수를 실제로 쓰는 첫 지점이라, 아래 "관련 파일"의 "더 이상 화면에서
  쓰이지 않는" 문구는 더 이상 사실이 아니다(삭제 대상에서 제외해야 함).
- 화면에 그 몰의 저장된 로그인 아이디를 그대로 보여주고(이미 로그인 확인 폼에 쓰던 것과 같은
  `loginId`/`loginPw` 상태를 재사용 — 새로 노출한 데이터 없음), 비밀번호는 마스킹한 채 "복사" 버튼만
  제공해 사용자가 붙여넣기만 하면 되게 했다. 로그인 정보 줄은 "브라우저에서 바로 열기" 버튼 바로 아래에
  오도록 배치(사용자 요청).
- 이 패널의 독립된 "몰 URL 복사" 버튼은 "브라우저에서 바로 열기"로 대체돼 제거(사용자 요청) — 최초
  "스크래핑 Start" 버튼이 클릭 시 URL을 클립보드에 복사해두는 동작은 그대로 남아있다(`handleCopyMallUrl`).
- 검증: `tsc --noEmit`/`eslint` 통과. 실제 개발자모드 몰로 "바로 열기" 클릭 시 크롬이 뜨는지는 이 환경에서
  데스크톱 세션 없이 육안 확인 불가 — 사용자 실사용 확인 필요.

### 후속 — 개발자모드 "스크래핑 전 단건 미리보기" + "스크랩 대상 직접지정" (2026-07-26)

사용자 요청: 일반모드 스크래핑 화면의 "AI모드/스크랩 미리보기/스크랩 대상 직접지정" 3버튼 UI를 개발자모드
에도 "스크래핑 후" 넣어달라는 것. 처음 조사에서 정확히 같은 방식은 구조적으로 불가능함을 확인(PTP 서버가
이 몰 탭에 CDP로 접근할 방법이 아예 없다 — 그게 개발자모드의 정의 자체). 대신 사용자가 "스크래핑 전 단건
미리보기를 새로 구축"을 선택해, 확장을 확장해 아래처럼 구현했다:

- **미리보기**: 확장에 새 우클릭 메뉴 `PTP 미리보기 실행` 추가. 지금 보고 있는 페이지를 그대로(이동 없이)
  캡처해 새 엔드포인트 `POST /api/sites/{id}/preview-capture`로 전송 — 규칙기반 추출(`extractFromHtml`)
  + (AI모드 켜져 있으면) `runAutoAnalysis`로 자동분석까지 해서 `sites.last_adjustment_preview`에 저장한다
  (기존 "스크랩 조정"이 쓰던 바로 그 컬럼을 재사용 — 스키마 추가 없음). PTP 화면의 "🔍 스크랩 미리보기"
  버튼은 `POST /api/sites/{id}/preview-arm`(이전 결과를 비움)을 부른 뒤 3초 간격으로 `GET /api/sites/{id}`를
  폴링해 값이 채워지면 표시한다(2분 타임아웃) — 정상모드처럼 버튼 클릭이 즉시 결과를 만들지 않고, 사용자가
  실제 몰 탭에서 우클릭해야 채워진다는 게 핵심 차이.
- **AI모드**: 새 컬럼 `sites.devmode_ai_preview`(BOOLEAN)로 토글 상태를 영구 저장 — 확장은 PTP 화면과
  직접 연결된 게 아니라(별도 실제 크롬 탭) 우클릭 시점에 `/api/sites/resolve`로 이 값을 같이 받아와야
  안다. `PATCH /api/sites/{id}`에 `devmodeAiPreview` 필드 추가.
- **스크랩 대상 직접지정**: 클릭식 피커 대신 기존 "스크랩 조정" 2단계 메커니즘(`adjust/prompt` +
  우클릭 `PTP 조정 테스트 실행` + `adjust/capture`)을 그대로 재사용 — 새 코드 없이, 아직 스크랩을 한 번도
  안 한 몰에서도 되도록 `adjust/target`이 `testUrl`을 못 찾으면(미확정 상품이 없으면) 확장이 다른 URL로
  이동하지 않고 **지금 보고 있는 페이지를 그대로** 테스트 대상으로 쓰도록 `background.js`의 `ptp-adjust`
  핸들러만 수정했다(`testUrl = target.testUrl || tab.url`).
- ScraperPanel의 개발자모드 "스크래핑 방법" 안내 카드 바로 아래, 일반모드의 "상품 페이지 미리보기" 블록과
  같은 자리에 새 카드로 추가 — devModeStarted 이후(= 사용자 요청의 "스크래핑 후")에만 보인다.

**후속 — 우클릭이 안 되는 몰 대응: 팝업(popup) UI로 기본 접근 경로 전환 (2026-07-26, 같은 날)**

실사용 중 신우(sinwoo.com)에서 우클릭 자체가 아예 안 뜨는 것을 확인(크롬 기본 복사/뒤로가기 메뉴조차
안 뜸— Shift+우클릭 우회도 안 됨). 몰 페이지가 JS로 `contextmenu` 이벤트를 강하게 차단하는 것으로 추정
— 이러면 "PTP 미리보기 실행"뿐 아니라 기존 "PTP 조정 테스트 실행"/"PTP 실패 상품 재수집"도 같은 이유로
이 몰에서는 근본적으로 못 쓴다(우클릭 의존 자체가 이 몰 부류에서 불안정한 설계였다는 뜻).

**해결**: 확장 툴바 아이콘에 `default_popup`(`popup.html`)을 등록해, 아이콘을 클릭하면 4개 버튼(🔄 스크랩
시작 / 🔍 미리보기 실행 / 🎯 조정 테스트 실행 / ♻ 실패 상품 재수집)이 있는 작은 팝업이 뜨도록 바꿨다.
툴바 아이콘 클릭은 몰 페이지의 JS가 개입할 방법이 전혀 없는 확장 UI 자체라 이 제약을 원천적으로 피한다.
우클릭이 정상 동작하는 몰을 위해 기존 컨텍스트메뉴 3개는 보조 경로로 그대로 남겨뒀다(둘 다 같은
`background.js` 함수를 공유하도록 리팩터링 — `startScrape`/`runPreview`/`runAdjust`/`retryFailed`).

- `default_popup`을 등록하면 브라우저 자체 규칙상 아이콘 클릭이 항상 팝업을 여는 것으로 바뀌어
  `chrome.action.onClicked`가 더는 발생하지 않는다 — 그래서 "스크랩 시작"(예전엔 아이콘 클릭 한 번으로
  바로 실행됐음)도 팝업의 버튼 + `chrome.runtime.sendMessage`로 옮겼다.
- 탭 조회는 반드시 **popup.js 쪽에서** `chrome.tabs.query({active:true, currentWindow:true})`로 하고
  `tabId`/`tabUrl`을 메시지에 실어 보낸다 — 서비스 워커(`background.js`)는 특정 창에 매인 UI가 아니라
  "현재 창"이라는 개념 자체가 없어, 거기서 같은 쿼리를 하면 어느 창 기준인지 불확실해진다(직접 겪은
  실수 — 처음엔 background.js에서 쿼리하도록 짰다가 이 문제를 뒤늦게 알아채고 고쳤다).
- `run()`(전체 스크랩 순회)과 실패 재수집 순회는 몇 분씩 걸릴 수 있어, 메시지 핸들러가 완료를 기다리지
  않고 백그라운드로 흘려보낸 뒤 "시작했다"는 응답만 즉시 돌려준다 — 진행상황은 PTP 화면의 기존 5초
  폴링이 이어받는다. 미리보기/조정 테스트는 캡처 1건이라 빠르니 그대로 기다렸다가 결과를 보여준다.
- 매니페스트 버전 1.20→1.21. **사용자가 `chrome://extensions`에서 이 확장을 새로고침해야** 새 팝업/메뉴가
  반영된다(설치된 확장은 파일이 바뀌어도 자동 반영 안 됨 — `chrome.runtime.onInstalled`는 설치/업데이트
  시점에만 발화).

**후속 — 개발자모드 프로세스 전체 재설계: PTP 왕복 제거, 팝업 안에서 전부 끝내기 (2026-07-27)**

사용자 피드백: "미리보기/지정이 '버튼 누르면 바로 결과'가 아니라 여러 단계를 거쳐야 해서 불편하다." 위
2026-07-26 설계(PTP에서 버튼→arm→다른 창으로 가서 팝업 클릭→PTP로 돌아와 폴링 결과 확인)가 정확히
그 문제였다 — 팝업으로 우클릭 문제는 해결했지만, "결과를 어디서 보는가"가 여전히 PTP였던 게 왕복을
안 없앴다. 이번엔 **PTP 쪽 미리보기/지정 UI를 통째로 삭제**하고, 팝업이 요청+결과 표시를 전부 맡도록
재설계했다:

- **미리보기**: 팝업에 AI모드 체크박스를 추가(서버에 저장할 필요 없이 요청마다 그대로 실어 보냄 —
  `sites.devmode_ai_preview` 컬럼/`PATCH devmodeAiPreview`/`resolve`의 `aiPreviewMode` 전부 롤백해
  삭제). 버튼을 누르면 background.js가 캡처+추출까지 마치고 결과(`{ok, preview}`)를 그대로 돌려주고,
  팝업이 그 자리에서 상품명/가격/카테고리/브랜드/커스텀필드를 렌더링한다. PTP로 돌아갈 필요가 없다.
- **스크랩 대상 직접지정**: 팝업에 프롬프트 textarea + 새 필드명 input을 추가해, "PTP에 먼저 저장 →
  몰 페이지에서 우클릭/팝업 클릭 → PTP로 돌아가 확인" 3단계였던 걸 "팝업에 입력 → 클릭 → 그 자리에서
  결과 확인" 1단계로 줄였다. `background.js`의 `runAdjust(tab, site, inlinePrompt, newField)`가 프롬프트를
  직접 받으면 `adjust/target` 조회(기존 우클릭 경로 전용)를 건너뛰고 바로 캡처+`adjust/capture`를 호출한다
  — `adjust/capture`도 body에 `prompt`가 실려오면 `pending_adjustment_prompt`보다 그걸 우선하도록 수정
  (기존 우클릭 경로는 그대로 호환 유지). 결과(변경된 규칙 + 재추출 미리보기)도 팝업에 바로 렌더링.
- **PTP 쪽(ScraperPanel)**: 위 두 기능의 카드를 완전히 삭제하고, "미리보기/AI모드/조정/재수집은 전부
  확장 팝업에서 처리합니다"라는 한 줄 안내로 대체 — 중복 UI 없이 팝업이 유일한 진입점이 되도록 정리.
- 이 리팩터로 `app/api/sites/[id]/preview-arm/route.ts`(폴링 시작용, 더 안 씀)를 삭제했고,
  `sites.devmode_ai_preview` 컬럼 추가도 되돌렸다(같은 세션에서 만들고 같은 세션에서 폐기 — 실제
  배포/의존 전이라 안전하게 제거 가능했음).
- 검증: `tsc --noEmit`/`eslint` 클린, Playwright로 ScraperPanel의 개발자모드 섹션이 안내 문구만 보여주고
  콘솔 에러 없이 렌더링되는 것 확인. 팝업의 실제 chrome.debugger 캡처+렌더링 자체는 이 환경에 실제
  크롬/확장이 없어 육안 확인 불가 — 사용자 실사용 확인 필요.

검증: `tsc --noEmit`/`eslint` 전부 클린. Playwright로 실제 로그인 후 신우(개발자모드 몰) 선택 →
스크래핑 Start → AI모드 토글(DB PATCH 저장 확인) → 스크랩 미리보기 클릭(대기 안내 문구 표시 확인) →
지정 개시(프롬프트 저장 성공 메시지 확인)까지 end-to-end 확인. 확장의 우클릭 실행 자체(`chrome.debugger`
attach → 캡처 → POST)는 이 환경에 실제 크롬/확장이 없어 육안 확인 불가 — 사용자 실사용 확인 필요.

**후속 — 다시 통합: PTP를 1차 창구로, 팝업은 실행 트리거로 (2026-07-27, 같은 날 세 번째 재설계)**

사용자 지시: "개발모드 관련 UI/UX를 바꿨는데, 가능하다면 PTP에서 진행 가능한 부분은 PTP에서 할 수 있게
다시 설계해줘. 일반모드의 기능을 가능하면 최대한 그대로 살리는 방향으로, 쉽게 양쪽을 통합관리 가능하게."
바로 위 항목(팝업에 AI모드/프롬프트를 넣은 설계)을 다시 뒤집는 결정이다 — 우클릭이 막히는 문제와
"여러 단계를 거쳐야 하는" 문제는 서로 다른 문제였다는 걸 이번에 이해했다: 팝업 도입은 전자만 풀었고,
후자(설정+결과를 PTP 아닌 팝업에서 다뤄야 하는 불편)는 여전히 남아있었다.

**최종 구조**: 일반모드의 "상품 페이지 미리보기" 카드(`ScraperPanel.tsx`)를 개발자모드와 **완전히 공유**
한다 — 별도 카드를 만들지 않고 `mallMode === 'normal' || mallMode === 'devmode'`로 게이트를 넓히고,
기존 상태(`aiMode`/`previewResult`/`previewLoading`/`pickerActive`/`pickerRules`)를 그대로 재사용한다.
모드별로 다른 부분만 분기:
- **AI모드 토글**: 같은 버튼/상태(`aiMode`). 개발자모드일 때만 클릭 시 `PATCH /api/sites/{id}`로
  `devmodeAiPreview`도 같이 저장(확장이 `/api/sites/resolve`로 실행 시점마다 읽어감 — 되돌린 컬럼을
  다시 원복).
- **🔍 스크랩 미리보기 버튼**: 일반모드는 기존 `handlePreview`(즉시 fetch) 그대로. 개발자모드는
  `handleDevPreview` — `preview-arm`으로 이전 결과를 비운 뒤 `previewLoading`을 켜고 3초 간격으로
  `GET /api/sites/{id}`를 폴려 `last_adjustment_preview`가 채워지면 **같은 `previewResult` 상태**에
  담아 **같은 미리보기 테이블 JSX**로 보여준다(되돌린 `preview-arm` 라우트를 다시 살림). 결과 카드 안의
  "열기 ↗"/"새로고침" 미니 헤더는 일반모드 전용(개발자모드는 캡처된 URL을 추적하지 않아 의미 없음)이라
  `mallMode === 'normal'`일 때만 보인다.
- **🎯 스크랩 대상 직접지정 버튼**: 같은 `pickerActive` 토글을 공유하되, 켜졌을 때 내용이 다르다 —
  일반모드는 기존 클릭식 피커 안내 그대로, 개발자모드는 새 필드명 input + 프롬프트 textarea + "지정
  저장" 버튼(`handleDevAdjustSave`, 기존 `adjust/prompt` 1단계 그대로 재사용)이 같은 카드 안에 나타난다.
  저장에 성공하면 미리보기와 같은 폴링(`startDevResultPoll` — 두 핸들러가 공유하는 헬퍼)을 자동으로
  시작해, 사용자가 몰 탭에서 확장을 실행하면 결과가 저절로 미리보기 테이블에 나타난다.
- **팝업**: 설정(AI모드 체크박스/프롬프트 textarea)을 다시 빼서 "🔄 스크랩 시작 / 🔍 미리보기 실행 /
  🎯 조정 테스트 실행 / ♻ 실패 상품 재수집" 4개 버튼 + 안내 문구("AI모드/조정 지시문은 PTP 스크래핑
  화면에서 설정하세요")만 남기는 **실행 전용 트리거**로 되돌렸다. `background.js`의 `runPreview`는
  다시 `site.aiPreviewMode`(DB 저장값)를 읽고, `runAdjust`는 다시 `adjust/target`의 사전 저장 프롬프트만
  쓴다(팝업에서 프롬프트를 직접 보내는 경로 제거) — `adjust/capture` 라우트도 body의 `prompt` 오버라이드를
  제거하고 항상 `pending_adjustment_prompt`를 읽는 원래 형태로 되돌렸다. 매니페스트 1.22→1.23.
- 남는 물리적 제약: chrome.debugger는 실제 그 탭에서의 사용자 제스처가 있어야 붙일 수 있어서, "몰 탭으로
  가서 확장을 한 번 실행"하는 단계 자체는 없앨 수 없다 — 이번 재설계는 그 앞뒤(설정, 결과 확인)를 전부
  PTP로 모아 "정말 물리적으로 불가능한 딱 한 단계"만 남긴 것.

검증: `tsc --noEmit`/`eslint`/확장 문법검사 전부 클린. Playwright로 신우 선택 → 스크래핑 Start →
(일반모드와 동일한 자리에 뜬) AI모드 토글 클릭 확인 → 스크랩 미리보기 클릭 시 대기 안내 표시 확인 →
스크랩 대상 직접지정 토글 → 프롬프트 입력 → 저장 시 "자동으로 결과가 나타납니다" 확인 메시지까지
end-to-end 확인. 실제 확장의 캡처 자체는 이 환경에 크롬/확장이 없어 육안 확인 불가.

## 관련 파일

- `lib/db.ts`: `sites.manual_login_required` 컬럼 (의미: "PC인증 등으로 자동 로그인이 안 돼 크롬
  확장(개발자모드)으로 스크랩하는 몰")
- `lib/scraper.ts`: `syncManualLoginProfileCopy`/`realChromeUserDataDir`/`isManualLoginSite` — 크롬 확장
  전환 이후로 화면에서 안 쓰이는 이전 방식(정리 대상으로만 남김). `openManualLoginWindow`는 예외 —
  2026-07-24 "브라우저에서 바로 열기" 버튼이 다시 쓰기 시작해 더 이상 정리 대상이 아니다.
- `app/api/sites/resolve/route.ts`: 확장이 탭 도메인으로 siteId를 물어보는 공용 조회 (세션 쿠키 없이
  호출되므로 `proxy.ts`의 `PUBLIC_API_PREFIXES`에 포함)
- `app/api/scrape/extension-ingest/route.ts`: 확장이 긁은 상품을 기존 `scrape_staging_items` 파이프라인에
  태우는 입력 경로 (마찬가지로 `PUBLIC_API_PREFIXES`)
- `app/api/sessions/route.ts`: `?siteId=` 필터 추가 (스크래핑 화면의 몰별 세션 이력 조회용)
- `extension-poc/manifest.json`, `background.js`: 몰 공용 크롬 확장 본체
- `extension-poc/popup.html`, `popup.js`: 툴바 아이콘 클릭 시 뜨는 팝업(2026-07-26 추가) — 우클릭이
  차단된 몰에서도 쓸 수 있는 기본 접근 경로(컨텍스트메뉴는 보조 경로로 남아있음). 설정(AI모드/조정
  프롬프트)과 결과 표시는 전부 PTP로 옮겨져(2026-07-27 재통합), 지금은 "🔄 스크랩 시작 / 🔍 미리보기
  실행 / 🎯 조정 테스트 실행 / ♻ 실패 상품 재수집" 4개 실행 버튼만 있는 순수 트리거다
- `components/panels/SiteDetailPanel.tsx`: "🧩 크롬익스텐션-개발자모드" 체크박스, 자동 재스크랩 섹션
  조건부 숨김 + 저장 시 강제 비활성화
- `components/panels/SitesListPanel.tsx`: 목록 배지
- `components/panels/ScraperPanel.tsx`: 개발자모드 몰이면 안내 + 세션 이력 그리드로 교체. "상품 페이지
  미리보기" 카드는 2026-07-27부터 일반모드와 완전히 공유(`mallMode==='normal'||'devmode'`) — AI모드
  토글/미리보기 버튼/"스크랩 대상 직접지정" 토글이 같은 상태·같은 JSX를 쓰고, 개발자모드일 때만 실제
  데이터 취득 방식(즉시 fetch 대신 arm+폴링)과 "직접지정"의 내부(클릭 피커 대신 프롬프트 입력폼)가 갈린다
- `app/api/sites/[id]/preview-capture/route.ts`: 개발자모드 단건 미리보기 캡처 (2026-07-26 신규,
  `PUBLIC_API_PATTERNS`에 등록) — aiMode는 확장이 `/api/sites/resolve`로 받아온 `devmode_ai_preview`
  DB 값을 그대로 실어 보낸다
- `app/api/sites/[id]/preview-arm/route.ts`: 개발자모드 미리보기 폴링 시작 전 이전 결과를 비움
  (2026-07-26 신규 → 07-27 한때 삭제 → 같은 날 재통합하며 다시 살림)
- `components/shell/ChromeWarning.tsx`, `app/layout.tsx`: 크롬으로 PTP 접속 시 엣지 유도 팝업 (개인
  프로필 스크랩 방식 시절의 운영 습관 안내 — 지금은 모자사러에 해당 없지만 다른 몰엔 여전히 유효)

### 후속 — "스크랩 조정"(AI 추측) 완전 폐기, 팝업을 실행 트리거 2개로 축소 (2026-08 커밋분)

`!specifications/scrape-adjustment.md`가 다루던 "스크랩 조정"(AI가 컬럼을 추측하는 `adjust/prompt` +
`adjust/capture` + `adjust/target` 2단계 메커니즘) 자체가 AI모드 자동 추출규칙 생성 + "스크랩 대상
직접지정" 피커로 완전히 대체되면서, 개발자모드 쪽에 남아있던 그 마지막 흔적(팝업의 "🎯 조정 테스트
실행"/"♻ 실패 상품 재수집" 버튼, `background.js`의 `runAdjust`/`retryFailed`, 라우트
`app/api/sites/[id]/adjust/{capture,prompt,target}`, `app/api/scrape/failed-urls`)을 전부 제거했다.
개발자모드의 "스크랩 대상 직접지정"은 이제 새 라우트 `app/api/sites/[id]/picker/rule`을 통해 일반모드
피커(`ptpSavePick`)와 같은 `sites.extraction_rules` 저장소에 같은 방식(jsonb 병합, lost-update 없음)으로
저장된다 — 두 모드가 저장 방식까지 완전히 통일됨. 팝업(`popup.html`)은 이제 "🔍 스크랩 미리보기 실행"/
"🔄 스크랩 시작" 2개 버튼만 남은 순수 실행 트리거다.

### 후속 — 픽커/미리보기 동시사용 충돌, 프로필 복사 허용치 누락, 일반모드와 UI 통일 (2026-08-16)

**버그 1 — "스크랩 대상 직접지정" 켜둔 채 "스크랩 미리보기"를 실행하면 멈춤.** `attachDebugger()`의
"already attached"(자기 자신의 이전 세션) 복구 경로가 `chrome.debugger.detach()`를 부르는데, 이 호출에도
다른 `chrome.debugger.*` 호출들과 마찬가지로 자체 타임아웃이 없었다 — 픽커 세션이 아직 붙어있는 탭에
미리보기가 재attach를 시도하면 바로 이 경로를 타는데, detach 자체가 멈추면 콘솔 로그 한 줄 없이 전체
흐름이 통째로 멈췄다. `extension-poc/background.js`: `safeDetach(tabId)` 헬퍼(5초 타임아웃)를 추가해
파일 내 모든 `chrome.debugger.detach` 호출(attachDebugger 복구/스크랩 시작·미리보기·피커종료·피커시작실패
정리 경로, 총 5곳)을 통일했고, 강제 detach 시 낡은 `pickerSessions` 기록도 같이 정리한다. manifest
1.36→1.37.

**버그 2 — `allowStaleManualLoginProfile` 누락 4곳.** 개발자모드는 사용자의 실제 크롬을 켜둔 채 쓰는 게
정상 상태라, `withContext`가 그 프로필을 복사(robocopy)할 때 세션 파일이 잠겨 일부 복사가 실패하는 게
흔하다 — "몰 구조분석"에는 이미 이를 허용하는 `allowStaleManualLoginProfile:true`가 적용돼 있었는데,
같은 계열의 다른 라우트 4곳에는 빠져있어 개발자모드 몰에서 사실상 항상 실패했다: `app/api/scrape/
categories/route.ts`(카테고리 불러오기), `app/api/master/mall-structure-check/route.ts`(연속관리 구조
변경 감지), `app/api/master/recheck/route.ts`(연속관리 재체크), `app/api/products/[id]/rescrape/
route.ts`(상품 상세 "재스크랩" — 몰 종류 구분 없이 항상 노출되는 버튼이라 영향받음). 전부 이 플래그를
추가했다. 자세한 배경/패턴은 memory `devmode-stale-profile-gap-pattern` 참고.

**개선 — 개발자모드 안내 카드 UI를 일반모드와 완전히 통일.** (a) "몰 구조분석"/"카테고리 불러오기" 클릭
즉시, 결과가 나올 자리에 같은 모양의 스켈레톤(펄스 애니메이션 그리드/목록 + 회전 아이콘 + 소요시간 안내
문구)이 먼저 뜨고 결과가 도착하면 그 자리에 그대로 채워지도록 `MallProfileResultDisplay`/
`categoryChecklistBox`에 `loading` 상태를 추가했다. (b) 몰 구조분석 결과와 카테고리 불러오기 블록을
구분선 하나가 아니라 완전히 독립된 박스(각자 `bg-white border rounded-xl`)로 분리하고, 순서도 "몰 구조
파악 → 카테고리 선택"이 자연스럽도록 재배치했다. (c) 개발자모드의 카테고리 불러오기 버튼을 일반모드와
같은 `ScrapeStepBox`(주 버튼의 완료 표시 + "↻ 다시 확인" 버튼이 항상 같이 보임)로 교체 — 예전엔 버튼
하나가 라벨만 "다시 확인"으로 바뀌어 "카테고리 불러오기" 버튼 자체가 사라진 것처럼 보였다.

### 후속 — "카테고리 불러오기" 하위 펼치기가 로그인 필요 몰에서 절대 안 되는 이유 확정 (2026-08-18)

2026-08-17에 추가한 "대분류 허브 자동 펼치기"(`discoverCategoryLinks`, 대분류 페이지를 방문해 상품 0개면
하위 메뉴로 대신 펼침)가 모자사러(캡모자 → 볼캡/캠프캡/군모/마도로스/평챙모자)에서 "다시 확인"을 여러 번
눌러도 전혀 안 바뀐다는 신고로 시작. 처음엔 "크롬이 켜져있어 `syncManualLoginProfileCopy`의 robocopy가
Cookies 파일 잠금으로 최신 로그인을 못 옮겨서"(단순 stale 복사본 문제)로 추정했으나, 실제로 확인해보니
이미 위 "2026-07-18" 항목에 기록된 것과 같은 근본 한계였다:

- 크롬을 완전히 종료(`tasklist`로 `chrome.exe` 0개 확인)한 뒤 프로덕션과 동일한 코드 경로로 robocopy를
  다시 실행 — `Cookies`/`Network/Cookies` mtime이 원본과 완전히 일치하는 **신선한** 사본을 만들었다.
- 그 사본으로 헤드리스 브라우저를 띄워 `https://mojasareo.com/product/list.html?cate_no=98`에 접속 —
  그래도 여전히 `/member/login.html`로 리다이렉트되고 비밀번호 입력창이 뜸(로그인 안 된 상태).
- 즉 **stale 여부와 무관하게, 이 몰 종류(회원전용 도매몰)는 프로필을 아무리 완벽하게 복사해도 로그인
  세션이 절대 넘어오지 않는다** — 정확히 2026-07-18에 이미 검증됐던 결론 그대로였다. "카테고리
  불러오기"만 유독 이 옛 방식(`withContext`의 manual-login 분기, `syncManualLoginProfileCopy`)을 계속
  쓰고 있어서 몰랐을 뿐, 애초에 이 기능(하위 카테고리 확인차 로그인 필요 페이지를 방문)은 이런 몰에서
  구조적으로 성공할 수 없었다.

**적용한 수정** — "크롬을 닫고 다시 시도하라"는 (틀린) 안내 대신, 이 한계를 있는 그대로 알려주는 방향으로
변경:
- `lib/scraper.ts`의 `discoverCategoryLinks`: 하위 펼치기 확인 중 로그인 페이지로 튕긴 적이 있으면
  `loginBlockedExpansion: true`를 결과에 포함(`CategoryDiscoveryResult`에 필드 추가).
- `app/api/scrape/categories/route.ts`: 이 값을 응답에 그대로 실어 보냄.
- `components/panels/ScraperPanel.tsx`: 카테고리 체크리스트 상단(`categoryChecklistBox`, 일반모드/
  개발자모드 공유)에 "로그인이 필요한 페이지가 있어 일부 카테고리의 하위 구조를 자동으로 확인하지
  못했습니다 — 크롬을 닫아도 동일한 구조적 한계" 경고 + "카테고리 URL 목록에 직접 추가해달라"는 대안
  안내를 추가. 몰 변경 시(`selectSite`) 이 상태도 같이 초기화.

이번 김에 발견한 별개 버그(같은 세션)도 함께 고침: 서로 다른 대분류 허브가 겹치는 하위 카테고리로
펼쳐지면 같은 href가 두 번 나와 체크리스트의 React key 중복 경고가 났던 것 — `discoverCategoryLinks`
펼치기 결과와 `ScraperPanel`의 캐시 복원/신규 조회 두 지점 모두에 href 기준 dedupe 추가.

**남은 한계**: 로그인 필요 몰의 진짜 하위 카테고리 구조를 자동으로 알아내려면 실제 로그인된 브라우저를
직접 읽는 `chrome.debugger` 확장(위 "최종 채택" 방식)으로 이 기능도 옮겨야 한다 — 이번 수정은 "왜 안
되는지 알려주기"까지만이고, "그래도 자동으로 되게 하기"는 별도 작업(확장 기능 확장) 필요.

검증: `tsc --noEmit` 클린. 위 stale/fresh 비교 테스트는 실제 모자사러(site id 3)로 직접 재현.
`loginBlockedExpansion` 배너 렌더링 자체는 이 환경에 실제 크롬 프로필이 없어 화면 육안 확인은
사용자 실사용 확인 필요(로직 경로는 위 재현 테스트로 검증됨 — 로그인 페이지 감지 → 플래그 세팅 →
API 응답 → 프론트 표시).

### 후속 — 바로 위 "남은 한계"를 해소: 확장으로 카테고리 하위구조 자동확인 (2026-08-18, 같은 날)

사용자 지시: "자동화로 구현해줘." 바로 위 항목에서 "별도 작업 필요"로 남겨둔 것 그대로, 실제 로그인된
탭을 직접 읽는 `chrome.debugger` 확장에 새 실행 트리거를 추가해 서버(`discoverCategoryLinks`)가 못 하는
일을 대신하게 했다. `startScrape`/`runPreview`가 이미 하는 것과 같은 패턴(팝업 버튼 → 메시지 →
`attachDebugger` → 실제 탭에서 순회 → 서버에 결과 전송)을 그대로 따랐다:

- **`app/api/sites/resolve/route.ts`**: 확장이 순회할 대분류 전체 목록을 알아야 해서 `categoryLinks`
  (`sites.scrape_profile.categoryLinks`)를 응답에 추가.
- **`extension-poc/background.js`**:
  - `buildScanSubmenuExpr(topLevelHrefs)` — `scanCategoryMenu`(lib/scraper.ts, 라이브 DOM 버전)의 판정
    기준(class/id에 cat/lnb/snb/ovmenu/gnb, 그룹당 최소 2개, href dedup)을 그대로 포팅한 라이브 DOM
    스캔 함수. 탭 위젯 라벨 병합/이미지전용 메뉴 폴백은 이 화면에서 아직 필요한 사례가 없어 생략(같은
    코드를 Node 서버와 확장 양쪽에 두는 이유는 `buildExtractExpr`과 동일 — 서로 import 불가).
  - `runExpandCategories(tab, site)` — `site.categoryLinks`를 순서대로 실제 탭에서 방문해, 상품
    링크가 있으면(`COLLECT_LINKS_EXPR` 재사용) 그대로 두고 없으면 `buildScanSubmenuExpr`로 하위메뉴를
    찾아 `"부모 > 자식"`으로 펼친다 — `discoverCategoryLinks`의 확장 로직과 판정 기준은 같고, 서버
    헤드리스 복사본 대신 실제 로그인된 탭을 쓴다는 점만 다르다. 결과는 href 기준 dedupe 후
    새 엔드포인트로 전송.
  - `msg.action === 'expand-categories'` 메시지 분기 추가.
- **`app/api/sites/[id]/categories/expand/route.ts`** (신규): 확장이 보낸 최종 목록을
  `sites.scrape_profile.categoryLinks`에 덮어쓴다(`discoverCategoryLinks`가 스스로 찾았을 때와 같은
  자리 — "카테고리 불러오기"가 다음 조회부터 캐시로 그대로 돌려줌). `proxy.ts`의
  `PUBLIC_API_PATTERNS`에 등록(세션 쿠키 없이 `chrome-extension://` 출처에서 호출).
- **`extension-poc/popup.html`/`popup.js`**: "🧭 보조 - 카테고리 하위구조 자동확인" 버튼 추가. 대분류
  개수만큼 페이지를 하나씩 순서대로 열어봐야 해서(1.2~2.4초 throttle 포함) 몰 규모에 따라 몇 분 걸릴 수
  있다는 안내 문구 포함. 매니페스트 1.41→1.42.
- **`components/panels/ScraperPanel.tsx`**: `loginBlockedExpansion` 경고 문구를 "크롬을 닫아도
  소용없다"는 진단에서 "몰 탭에서 이 버튼을 실행한 뒤 다시 확인을 눌러달라"는 실행 가능한 안내로 교체.
  개발자모드 안내의 "보조 설명"에도 같은 버튼을 추가 안내.

**전제조건**: 이 버튼이 동작하려면 `site.categoryLinks`(대분류 목록)가 이미 있어야 한다 — 즉 PTP에서
"카테고리 불러오기"를 최소 한 번 실행해 대분류 이름/href를 확보해둔 뒤에 이 버튼을 눌러야 한다(대분류
자체는 로그인 없이도 공개 HTML로 찾아진다 — 이 세션 초반에 이미 확인됨). 없으면 그렇게 안내하는
에러를 반환한다.

검증: `tsc --noEmit` 클린, `node --check`로 `background.js`/`popup.js` 문법 확인, `buildScanSubmenuExpr`가
생성하는 문자열을 Node에서 `new Function()`으로 파싱해 문법 오류 없음을 확인. 실제 크롬 확장 재로드 후
모자사러로 클릭 테스트는 이 환경에 실제 크롬 세션이 없어 사용자 실사용 확인 필요 — 확장을
`chrome://extensions`에서 새로고침해야 반영된다.

### 후속 — 바로 위 `runExpandCategories`를 여러 탭으로 병렬화 (2026-08-22)

모자사러(17개 대분류)에서 "몰 구조분석"(카테고리 하위구조 자동확인 + 정렬 옵션 감지가 합쳐진 버튼,
`runFullMallProfile`)이 실제로 몇 분씩 걸리는 걸 로그(`.dev-server.log`)와 `sites.scrape_profile.
categoryLinks` 진행 상태로 직접 확인해 원인을 특정했다: 원인은 위 `runExpandCategories`가 대분류
개수만큼 실제 로그인 탭 **하나**를 순서대로(`for...of`) 재사용해 방문하기 때문 — 카테고리당 페이지
로딩(수 초~`navigate()`의 20초 상한) + 0.5초 안정화 + 1.2~2.4초 throttle이 전부 직렬로 누적된다.
사용자 지시: "병렬화 해줘."

`lib/scraper.ts`의 `discoverCategoryLinks`가 서버 쪽에서 이미 하는 것(`EXPAND_CONCURRENCY`만큼
Playwright 탭을 동시에 열어 워커 풀로 처리)과 같은 발상을 확장에도 적용했다:

- **`EXPAND_TAB_CONCURRENCY = 4`**(신규 상수) — 원래 탭(사용자가 보고 있던 탭)을 워커 0으로 재사용하고,
  나머지 최대 3개는 `chrome.tabs.create({ url: 'about:blank', active: false })`로 백그라운드에 새로
  연다. 새 탭도 같은 브라우저 프로필이라 쿠키/로그인 세션을 그대로 공유해 별도 로그인 처리가 필요
  없다 — `about:blank`로 열어두고 실제 카테고리 URL 로딩은 아래 워커 루프의 첫 `navigate()`가 맡아
  이중 로딩을 피한다.
- **`runExpandCategories`**: 순차 `for` 루프를 `cursor` 공유 변수 기반 워커 풀(`Promise.all(workerTabIds.
  map(worker))`)로 재작성 — 각 워커는 `attachDebugger`된 자기 탭에서 `cursor++`로 다음 미처리 카테고리를
  가져가 기존과 동일한 판정(상품 링크 있으면 그대로, 없으면 `buildScanSubmenuExpr`로 하위메뉴 탐색)을
  수행하고 `throttle()` 후 반복한다. 한 워커에서 예외가 나도(`try/catch`) 그 카테고리 하나만 미확장으로
  남기고 전체는 계속 진행된다. 끝나면(`finally`) 원래 탭은 시작 URL로 되돌리고, 새로 연 탭들은
  detach 후 `chrome.tabs.remove`로 닫는다.
- 탭 개수를 4로 제한한 이유: 너무 많이 열면 (1) 작은 도매몰 서버에 순간 부담을 줄 수 있고, (2) 사용자
  눈앞에 새 탭이 여러 개 뜨는 게 그 자체로 어수선하다 — 새 탭이 뜨는 것 자체를 감수하기로 한 트레이드
  오프이므로 개수는 보수적으로 잡았다.
- `runDetectSortOptions`는 대분류 1개(`categoryLinks[0]`)만 방문하므로 병렬화 대상이 아니다(변경 없음).

**효과(이론상)**: 17개 카테고리 기준 순차 처리 시간이 대략 1/4로 줄어든다(카테고리별 소요시간이
비슷하다는 전제하에) — 다만 첫 워커(원래 탭)와 새로 연 탭들의 실제 로딩 속도는 몰 서버 응답에 따라
갈릴 수 있어 정확히 4배는 아니다.

검증: `node --check`/`tsc --noEmit` 클린. 실제 크롬 확장 재로드 후 모자사러(다수 카테고리)로 처리
시간이 실제로 줄었는지는 사용자 실사용 확인 필요 — 확장을 `chrome://extensions`에서 새로고침해야
반영된다.

### 후속 — 개발자모드 "스크랩 시작"(`run()`)도 상품 상세 방문을 병렬화 (2026-08-22, 같은 날)

`runExpandCategories`/`sampleMallProfile` 병렬화에 이어, 실제 스크랩 본체인 `run()`도 같은 방식으로
개선했다. 사용자 지시: "2, 3번도 순차적으로 진행해줘"(먼저 정리해둔 병렬화 후보 목록의 2번, 3번을
차례로 진행하라는 뜻 — 코드를 순차 실행시키라는 의미 아님).

`run()`의 목록 탐색(다음 페이지 URL 찾기)은 원래 탭 하나로 순서대로 해야 하지만(다음 페이지 URL은
현재 페이지를 봐야 안다) — 그렇게 찾은 상품 링크들을 실제로 방문해 추출·보고하는 부분은 서로 완전히
독립적이라 병렬화 대상이었다. `runExpandCategories`와 같은 탭 워커풀 방식(`SCRAPE_TAB_CONCURRENCY = 4`)
을 적용했다.

**`runExpandCategories`와 다른, 이 함수만의 특수 처리 두 가지**:

1. **세션 생성 경합**: `report(url, product)`가 서버(`INGEST_ENDPOINT`)에 처음 보고할 때 `sessionId`가
   아직 `null`이면 서버가 새 `scrape_sessions` 행을 만들어 id를 응답으로 돌려주고, 이후 호출은 그
   `sessionId`를 실어 같은 세션에 계속 쌓는다. 여러 워커가 **동시에** `sessionId: null`로 보고하면
   세션이 여러 개로 쪼개진다 — 이걸 막기 위해 이 run() 전체에서 처음 보고하는 상품 딱 1건만 혼자
   먼저 처리해 `sessionId`를 확정한 뒤에야 나머지를 워커풀로 넘긴다.
2. **실패해도 계속 진행**: 스크랩은 몇 분~수십 분 걸리는 긴 작업이라, 탭을 추가로 열지 못하면(브라우저
   제한 등) `runExpandCategories`처럼 통째로 에러를 던지는 대신 그만큼 적은 동시 개수(최소 1, 원래
   탭만)로 조용히 계속 진행한다.

**받아들인 부정확성**: `MAX_PRODUCTS`(안전장치, 300개 단위로 세션을 나눔)와 카테고리별 `countLimit`
(개수 상한 설정)은 원래도 정확한 하드 리밋이 아니라 "이쯤에서 배치를 끊는다"는 기준이었는데, 워커
여러 개가 상한에 거의 다다른 시점에 동시에 "아직 상한 안 됨"을 확인하고 각자 처리를 시작할 수 있어
최대 동시 개수(4)만큼 살짝 넘길 수 있다 — 기존에도 정확한 값이 아니었으므로 감수하기로 했다.
"스크래핑 중지" 버튼 확인(`checkStopRequested`)은 각 워커가 다음 상품을 집기 전에 개별적으로 하므로
반응성은 기존과 동일하게 유지된다.

### 관련 파일 (스크랩 시작 병렬화)

**수정**: `extension-poc/background.js` — `SCRAPE_TAB_CONCURRENCY`(신규 상수), `run()`(탭 워커풀 +
세션 프라이밍 로직으로 재작성), `processProduct`(신규, 상품 1건 방문·추출·보고를 묶은 내부 함수).

## 상태

**구현 완료 (2026-07-18, 크롬 확장 방식으로 전환).** 이전 개인 프로필 방식 커밋: `a74832f`, `3e517e9`,
`763a775`, `e9c74e0`, `18493c2`(이후 되돌림), `037918f`, `b22c554`, `efe87ab`, `b92f31d`(엣지 유도 팝업,
지금도 유효). 이번 전환 커밋: `b1bad0d`(비표준 몰 추출 폴백 + 프로필 복사 시도 — 결과적으로 이것도
실패로 판명), `564523a`(크롬 확장 도입 + Mall 표기 변경 + 화면 재설계).
`mojasareo.com`(site id 3)에서 크롬 확장으로 실제 카테고리 3페이지·45개 상품 스크랩 성공까지 확인함.

**후속 (2026-07-19).** 미정 상태 도입 + 진행 상황 표시 통일: 커밋 `654c6cb`. 관련 정확도 개선(신우 링크
패턴, www 유무 처리 등)은 `56e71d2`에 같이 포함(`!specifications/scrape-adjustment.md` 참고).

**후속 (2026-08-07 커밋 `c8f3922`).** "브라우저에서 바로 열기" + 로그인 정보 복사(2026-07-24 작업분,
그동안 커밋 안 된 채 누적) + 위 "스크랩 조정 완전 폐기·피커로 통합" 반영. 실제 개발자모드 몰의 팝업
동작(캡처/저장)은 이 환경에 실제 크롬/확장이 없어 육안 확인 불가 — 사용자 실사용 확인 필요.

**후속 (2026-08-16).** 위 "픽커/미리보기 동시사용 충돌, 프로필 복사 허용치 누락, 일반모드와 UI 통일"
섹션 참고. `chrome.debugger.detach` 타임아웃 통일은 pettory.com(site 18) 실사용 중 재현·수정, 나머지는
관련 라우트 감사 중 함께 발견. tsc 클린. 확장 변경분(safeDetach)은 실제 크롬 확장 재로드 후 사용자
재테스트 필요.
