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
- **프로필 폴더 그대로 재사용**: `.playwright-profiles/{siteId}`는 원래도 "로그인 창 쿠키를 남겨 이후
  헤드리스 스크래핑이 재사용"하는 용도였다(`lib/scraper.ts`의 `withContext`). 이 설계를 그대로 살려,
  PTP의 자동화 창 대신 **사용자가 그 폴더를 가리키는 완전히 독립적인 크롬**(`chrome.exe --user-data-dir=...`)
  으로 수동 로그인하게 하면, WebAuthn 인증까지 정상적으로 완료된 세션이 디스크에 남고, 이후 스크래핑은
  코드 변경 없이 그 쿠키를 그대로 읽는다.
- **스크래핑 화면의 안내 박스**: `manual_login_required=true`인 몰을 선택하면 기존 "로그인 창 열기 / 로그인
  확인" 버튼 대신, 그 몰의 `profile_dir`을 채운 복사 가능한 크롬 실행 명령을 보여준다(`ManualLoginNotice`,
  `components/panels/ScraperPanel.tsx`). PTP가 그 몰용으로 열어둔 로그인 창이 있으면 프로필 폴더가
  잠겨 충돌하므로, 먼저 닫으라는 안내도 포함.
- **Mall 관리 화면 표기**: `SiteDetailPanel`에 체크박스, `SitesListPanel` 목록에 배지(🔒 직접로그인 필수)로
  노출.
- **별개로 시도했다가 유지한 개선**: 로그인 창을 실제 설치된 크롬(`channel: 'chrome'`)으로 띄우고,
  `navigator.webdriver`를 숨기고, `chromiumSandbox: true`로 `--no-sandbox` 경고 배너를 없앤 것 — WebAuthn
  문제 자체는 해결 못 했지만, 일반적인 봇 탐지(UA/webdriver 체크) 회피에는 유효해 그대로 유지.

## 관련 파일

- `lib/db.ts`: `sites.manual_login_required` 컬럼
- `lib/scraper.ts`: `profileDir` export, `launchVisibleWindow`(`channel: 'chrome'`, `chromiumSandbox: true`,
  `navigator.webdriver` 숨김)
- `app/api/sites/route.ts`, `app/api/sites/[id]/route.ts`: `manual_login_required` CRUD, 상세 GET에
  `profile_dir` 포함
- `components/panels/SiteDetailPanel.tsx`: "직접로그인 필수" 체크박스
- `components/panels/SitesListPanel.tsx`: 목록 배지
- `components/panels/ScraperPanel.tsx`: `ManualLoginNotice` 안내 박스

## 상태

**구현 완료 (2026-07-17).** 커밋: `a74832f`. `mojasareo.com`(site id 3)에 플래그를 켜서 확인함.

미검증: 실제로 수동 크롬 로그인 후 스크래핑이 그 세션을 이어받아 정상 동작하는지 end-to-end 확인은
사용자가 다음에 직접 로그인해본 뒤 확인 예정.
