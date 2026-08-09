# 상품 원본 URL "열기"를 Chrome(없으면 Edge)으로 직접 열기

## 배경

PTP는 사용자의 Edge 탭 안에서 돌기 때문에, 상품 목록/상세 화면의 "열기" 링크를 그냥 `window.open`으로
열면 항상 그 Edge에서 새 탭이 뜬다. 상품 원본 페이지는 Chrome으로 확인하고 싶다는 요청(2026-08-10) —
Chrome이 설치돼 있으면 Chrome, 없으면 PTP를 띄운 것과 무관하게 Edge로 직접 열어달라는 것.

## 제약 — 왜 클라이언트 JS로는 안 되는가

웹페이지 JS에는 "이 링크를 다른 브라우저 앱으로 열어라"를 지정할 방법이 없다(브라우저가 보안상
막아둠) — `window.open`/`<a target>` 어느 쪽도 OS의 브라우저 연결 설정을 우회하지 못한다. 이 앱은
사용자의 로컬 PC에서만 도는 도구라는 전제(다른 스크래핑 브라우저 실행 방식과 동일) 위에서, **서버가
대신 OS 프로세스로 브라우저를 띄우는** 방식으로 구현했다.

## 구현

`app/api/system/open-in-browser/route.ts`(신규): `{ url }`을 받아 Windows의 알려진 설치 경로를
순서대로 확인해 Chrome을 우선 시도하고, 없으면 Edge로 폴백한다.

```
Chrome: C:\Program Files\Google\Chrome\Application\chrome.exe
        C:\Program Files (x86)\Google\Chrome\Application\chrome.exe
        %LOCALAPPDATA%\Google\Chrome\Application\chrome.exe
Edge:   C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe
        C:\Program Files\Microsoft\Edge\Application\msedge.exe
```

찾은 실행파일을 `spawn(path, [url], { detached: true, stdio: 'ignore' }).unref()`로 띄운다 — 서버
프로세스와 무관하게 독립적으로 계속 살아야 하는 GUI 앱이라 `detached`+`unref`로 요청을 곧바로
끝낸다(이 앱의 다른 스크립트 재시작 로직이 겪은 Job Object kill-on-close 문제는 "부모가 곧 죽는"
시나리오에만 해당돼 여기엔 적용되지 않는다 — 서버는 이 요청 뒤에도 계속 살아있음).

**연결한 곳** (기존에 `window.open(url, '_blank', 'noreferrer')`만 쓰던 3곳): 이 새 엔드포인트로 먼저
POST하고, 실패(설치된 브라우저를 못 찾음 등)하면 기존 `window.open`으로 최후 폴백한다.

- `components/panels/shared/StagingItemsGrid.tsx`의 `handleOpenSourceUrl` — 스크랩 Raw 확인 그리드의
  "상품url" 컬럼 "열기".
- `components/panels/ScraperPanel.tsx`의 `handleOpenItem` — 미리보기 목록의 "열기". 이 몰 전용 로그인
  창(`/api/scrape/open-url`, 로그인 쿠키를 재사용해 로그인 상태로 보여줌)을 1순위로 그대로 유지하고,
  그게 실패했을 때만 이 새 경로를 2순위로 시도한다.
- `components/panels/ProductDetailPanel.tsx`의 `handleOpenSourceUrl` — 상품 상세의 "원본 페이지 열기".
  마찬가지로 로그인 창 시도가 1순위, 이 새 경로가 2순위.

## 검증

인증이 필요한 앱 화면을 거치지 않고, 같은 탐색+spawn 로직만 별도 Node 스크립트로 직접 실행해
확인했다 — Chrome 경로가 정확히 감지되고, 실제로 Chrome 프로세스가 뜨는 것까지 확인(`Get-Process`로
`chrome`/해당 URL 타이틀 확인).

## 관련 파일

- `app/api/system/open-in-browser/route.ts`(신규).
- `components/panels/shared/StagingItemsGrid.tsx`, `components/panels/ScraperPanel.tsx`,
  `components/panels/ProductDetailPanel.tsx`: 기존 `window.open` 호출부를 폴백으로 남기고 이 경로를
  우선 시도하도록 수정.

## 상태

**구현 완료.** tsc/eslint 클린. OS 레벨 탐색+spawn 동작은 직접 검증했고, 실제 앱 화면(인증된 상태)에서의
최종 확인은 사용자가 다음 사용 시 확인 예정.
