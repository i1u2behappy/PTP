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
- **개인 브라우저 보호**: 두 경로 모두 기존 크롬 프로세스를 강제 종료하지 않는다(전용 폴더였을 때는
  `killOrphanedProfileProcess`로 정리했지만, 실제 개인 브라우저를 앱이 함부로 죽이면 안 되기 때문).
  대신 사용자가 크롬을 열어둔 채 스크랩을 시도하면(같은 프로필 동시 사용 불가로 `launchPersistentContext`가
  실패) "개인 크롬 브라우저가 열려있으면 이 몰은 스크랩할 수 없습니다" 에러로 명확히 안내한다.
- **일반화**: `isManualLoginSite`가 `sites.manual_login_required` 플래그만 보고 판단하므로, 같은 유형의
  다른 몰도 그 플래그만 켜면 자동으로 이 방식(개인 프로필 사용)이 적용된다 — 몰별 특수 코드 불필요.
- 스크래핑 화면 안내 문구(`components/panels/ScraperPanel.tsx`)도 "복사해서 별도 명령 실행" 방식에서
  "본인 크롬을 닫고 로그인 창 열기를 누르면 본인 프로필이 그대로 뜬다"는 설명으로 교체.

## 관련 파일

- `lib/db.ts`: `sites.manual_login_required` 컬럼
- `lib/scraper.ts`: `openManualLoginWindow`(개인 프로필로 로그인 창 열기), `realChromeUserDataDir`,
  `isManualLoginSite`, `withContext`(manual_login_required 몰은 개인 프로필로 헤드리스 실행)
- `app/api/scrape/login/route.ts`: `manualLogin` 플래그로 `openLoginWindow`/`openManualLoginWindow` 분기
- `app/api/sites/route.ts`, `app/api/sites/[id]/route.ts`: `manual_login_required` CRUD
- `components/panels/SiteDetailPanel.tsx`: "직접로그인 필수" 체크박스
- `components/panels/SitesListPanel.tsx`: 목록 배지
- `components/panels/ScraperPanel.tsx`: 로그인 정보 섹션의 안내 문구 + 아이디/비번 복사 버튼

## 상태

**구현 완료 (2026-07-17).** 커밋: `a74832f`(플래그/UI), `3e517e9`(모든 스크래핑 경로 실제 크롬으로 통일),
`763a775`(개인 프로필 사용으로 최종 해결). `mojasareo.com`(site id 3)에서 실제 로그인 성공까지 확인함.
