# 개발자모드 안내 정확화 + "현재 카테고리 가져오기" 반복 수집 (2026-08-22)

## 배경 — 뭉뚱그린 경고문이 설정 버튼까지 오해하게 함

"상품 페이지 미리보기" 카드 상단의 개발자모드 경고문이 "이 버튼들이 결과를 바로 가져오지 않습니다"라고
4개 버튼(동시 처리 자동, AI모드, 스크랩 미리보기, 스크랩 대상 직접지정)을 뭉뚱그려 경고하고 있었다.
실제로는 "동시 처리"/"AI모드"는 진짜 설정값이라 PTP 화면에서 누르는 즉시 저장·적용되고, 몰 탭 확장이
반드시 필요한 건 "스크랩 미리보기"/"스크랩 대상 직접지정" 둘뿐이다(사용자 지적). 경고문을 그 둘만
콕 집도록 좁히고, 몰 탭에서 찾아야 할 확장 아이콘이 빨간 배경/흰 글자 "PTP"인 것과 시각적으로
연결되도록 해당 버튼 옆에 작은 빨간 "PTP" 표시를 추가했다.

또한 "브라우저에서 바로 열기" 클릭 시 안내가 네이티브 `alert()`로 떠서 사용자가 직접 "확인"을 눌러야만
닫혔다 — 5초 후 자동으로 사라지는 토스트(`devHint` state, 화면 하단 고정)로 교체했다. 순수 정보성
안내(에러 아님)라 자동으로 사라져도 문제 없고, 급하면 ✕로 바로 닫을 수 있다.

## "현재 카테고리 가져오기" — 단일 URL 덮어쓰기에서 반복 추가로

기존 "현재 페이지 가져오기"(일반모드)는 로그인 창의 현재 URL을 서버가 읽어와 **단일** `targetUrl`에
덮어썼다 — 카테고리를 하나씩 옮겨 다니며 여러 개를 모아야 하는 경우 매번 이전 값이 사라져 불편했다
(사용자 지적). "현재 카테고리 가져오기"로 이름을 바꾸고, 클릭할 때마다 "카테고리 URL 목록"
(`categoryUrlsText`, 여러 줄)에 새 줄로 추가되도록 바꿨다 — 이미 목록에 있는 URL이면 중복 추가하지
않는다. 왼쪽 "URL 하나만 그대로 쓰기" 입력칸은 이제 이 버튼과 무관한 순수 수동 입력으로 남는다.

## 개발자모드 이식 — 서버가 몰 탭에 접근할 수 없어 확장이 대신 보고

일반모드는 서버가 로그인 창(Playwright가 직접 제어하는 브라우저)의 URL을 즉시 읽을 수 있지만,
개발자모드는 사용자의 실제 크롬 탭이라 서버가 직접 볼 방법이 없다(다른 devmode 기능들과 동일한
구조적 제약). 필요한 정보가 `tab.url` 하나뿐이라(DOM 접근 불필요) chrome.debugger 없이 즉시 처리할
수 있는 유일한 devmode 기능이다.

- **확장(`extension-poc/background.js`)**: `runCaptureCurrentCategory(tab, site)` — `tab.url`을 그대로
  `POST /api/sites/{id}/current-category`로 전송. 팝업에 "📍 보조 - 현재 카테고리 가져오기" 버튼 추가.
- **서버(`app/api/sites/[id]/current-category/route.ts`, 신규)**: `sites.scrape_profile.categoryQueue`
  (문자열 배열)에 POST로 들어온 URL을 누적하고, GET이 호출되면 쌓인 걸 그대로 반환하면서 즉시 비운다
  (pop 방식 — 폴링이 같은 URL을 중복으로 못 가져가게 함). `proxy.ts`의 `PUBLIC_API_PATTERNS`에 이
  경로를 추가해 확장의 세션 쿠키 없는 POST를 허용한다(GET도 같은 경로라 함께 공개되지만, PTP 자체
  화면은 인증된 세션으로 호출하니 문제없다).
- **클라이언트(`ScraperPanel.tsx`)**: 개발자모드일 때 3초 간격으로 이 GET을 폴링, 새로 들어온 URL을
  `categoryUrlsText`에 중복 없이 이어붙이고 "카테고리 URL N개를 목록에 추가했습니다" 토스트(`devHint`)
  로 알린다. 별도 저장 UI 없이도 셀렉트/체크리스트 및 "스크랩 대상" 요약 표(둘 다 `categoryUrlsText`
  공유)에 그대로 반영된다.

## 관련 파일

- `components/panels/ScraperPanel.tsx`: 경고문 분리, PTP 배지, `devHint` 토스트(`showDevHint`),
  `handleRefreshCurrentUrl`(추가 방식으로 변경), 개발자모드 큐 폴링 `useEffect`, 가이드 목록에 신규
  버튼 안내 줄 추가.
- `app/api/sites/[id]/current-category/route.ts`(신규): POST(큐 적재)/GET(큐 반환+비움).
- `proxy.ts`: `PUBLIC_API_PATTERNS`에 `current-category` 경로 추가.
- `extension-poc/background.js`, `popup.html`, `popup.js`: `runCaptureCurrentCategory` + 팝업 버튼.

## 상태

**구현 완료.** tsc/eslint 클린. 확장은 `chrome://extensions`에서 새로고침해야 새 버튼이 반영된다 —
실사용 재현 테스트(모자사러 등에서 반복 클릭 시 실제로 누적되는지)는 아직 안 했다.
