# 로그인 상태 화면이 서버 재시작 후에도 "확인됨"으로 잘못 남는 문제

## 배경

PTP 서버를 재시작한 뒤 화면을 다시 열면, "로그인 창 다시 열기"와 "확인됨" 버튼이 둘 다 이미 완료된
상태(✓)로 나오는데 실제로는 서버에 열려있는 로그인 창이 하나도 없는 문제가 실사용 중 확인됐다
(2026-08-09). 재시작 시점에 프로세스 확인으로 검증: `.playwright-profiles`를 쓰는 chrome.exe가 0개인
상태에서도 화면은 "확인됨"을 보여주고 있었다.

## 원인

화면(브라우저)과 서버, 두 곳의 상태가 서로 다른 저장소에 나뉘어 있다.

1. `components/panels/ScraperPanel.tsx`는 `loginStep`(로그인 창 열었는지/확인됐는지)을 **브라우저의
   localStorage**(`FORM_STATE_KEY`)에 저장하고, 화면을 다시 열 때마다 그 값을 그대로 복원한다 — 이건
   원래 "dev 서버가 Fast Refresh로 화면만 강제 새로고침될 때 진행 상태가 안 사라지게" 만든 의도된
   기능이다(그 경우엔 서버 프로세스가 안 죽고 그대로라 실제로 유효한 상태).
2. 반면 진짜 로그인 창(브라우저 세션)은 서버 쪽 `lib/scraper.ts`의 `openSessions`(`globalThis` 저장)
   에만 있다. 이건 코드 수정으로 인한 핫리로드는 견디지만, **서버 프로세스 자체를 재시작하면 완전히
   새로 시작**된다(게다가 `!specifications/scrape-memory-orphan-cleanup-and-concurrency-mode.md`의
   재시작 orphan 정리 때문에 남아있던 크롬 창까지 강제로 닫힌다).

즉 브라우저는 "이전에 확인했었다"는 값을 그대로 들고 있는데, 서버는 재시작되면서 그 로그인 창을
완전히 잃어버린 상태라 화면과 실제가 어긋난다. `selectSite()`에는 서버에 실제로 열려있는 로그인
창이 있는지 물어보는 확인 로직(`/api/scrape/current-url`)이 이미 있었지만, **긍정 케이스만
처리하고(있으면 `'confirmed'`) 부정 케이스(없으면 `'none'`으로 되돌리기)가 빠져 있었다** — 그래서
아래의 `FORM_STATE_KEY` 복원 로직이 그 자리를 stale한 localStorage 값으로 덮어써도 아무도 고쳐주지
않았다.

## 수정 — `lib/scraper.ts` 아님, `components/panels/ScraperPanel.tsx`만

```diff
  fetch(`/api/scrape/current-url?siteId=${siteId}`).then(r => r.json()).then((d) => {
-   if (d.url) setLoginStep('confirmed')
+   setLoginStep(d.url ? 'confirmed' : 'none')
  }).catch(() => {})
```

**왜 이 한 줄로 충분한가 — 타이밍 분석**: 몰을 다시 선택하면(마운트 시 `FORM_STATE_KEY` 복원도
내부적으로 `selectSite`를 호출) 두 가지가 동시에 진행된다:

1. `FORM_STATE_KEY` 복원 코드가 localStorage의 예전 `loginStep`을 즉시 복원(`setLoginStep(saved.loginStep)`)
   — 네트워크 요청 없이 마이크로태스크 수준으로 즉시 실행됨.
2. `selectSite` 내부의 `current-url` 확인 — 실제 서버에 물어보는 요청이라 응답에 최소 몇 ms(로컬호스트
   기준)가 걸림.

`selectSite(siteId)`가 반환하는 프로미스는 `current-url` fetch를 **await하지 않고 발사한 뒤**
함수 본문이 끝나자마자 resolve된다 — 그래서 (1)의 `.then()`이 (2)의 응답이 오기 **전에** 먼저
실행된다. 즉 (2)가 항상 나중에 실행되며 최종 값을 확정한다: 서버가 "없다"고 답하면 그 즉시
`'none'`으로 되돌려 화면이 정확해지고, 서버가 살아있는 정상 케이스(Fast Refresh)는 "있다"고 답해
그대로 `'confirmed'`가 유지된다.

## 관련 파일

- `components/panels/ScraperPanel.tsx`: `selectSite()` 내부의 `current-url` 확인 콜백 한 줄만 수정.

## 상태

**구현 완료.** tsc/eslint 클린. 재시작 후 chrome.exe 프로세스가 0개인 상태에서 실제로 화면이
"미확인"으로 정확히 되돌아가는지는 사용자가 다음 재시작 시 확인 예정.
