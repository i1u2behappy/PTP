# 일시적 요청 실패 유예시간(GlobalErrorNet) + 확정 진행률 표시

## 배경 — 요청실패 토스트가 간간이 뜨는 문제

`components/shell/GlobalErrorNet.tsx`(전역 `window.fetch` 래퍼 — 화면마다 에러 UI를 따로 안 만들고
5xx/네트워크 실패를 한 곳에서 잡아 토스트로 보여줌)가 실제로는 아무 조치도 필요 없는 "요청 실패"를
간간이 띄운다는 지적(2026-08-22)이 있었다. 원인은 dev 서버 핫리로드처럼 **순간적으로 끊겼다가 스스로
복구되는** 실패까지 실패 즉시 화면에 노출했기 때문 — 진짜 조치가 필요한 실패(서버/DB 다운)와 구분이
안 됐다.

## 설계 — 유예시간 동안은 조용히 재시도만

즉시 노출하는 대신, 실패를 "화면에 아직 안 보이는 대기 상태"로 먼저 들어가게 하고 그 안에서 빠르게
재시도하다가, 유예시간을 넘겨도 여전히 실패 중일 때만 처음으로 화면에 드러낸다.

```ts
const REVEAL_GRACE_MS = 5_000     // 처음엔 2초로 뒀으나 여전히 간간이 노출된다는 재지적으로 5초로 상향
const FAST_RETRY_DELAY_MS = 1_000
```

- `pending: Map<url, FailedRequest>` — 유예시간 중인 실패. 화면엔 안 보이지만 추적·재시도는 계속됨.
- `failures: FailedRequest[]` — 유예시간을 넘겨 실제로 화면에 드러난 것만.
- `addFailure()`가 `visible → pending → new` 순으로 확인해, 이미 보이는 것/이미 대기 중인 것/완전히
  새 실패를 각각 다르게 처리한다(보이는 것은 시도횟수만 증가, 대기 중인 것은 빠른 재시도만 이어감).
- `revealEntry(url)` — 유예 타이머(`revealTimers`)가 만료되면 `pending`에서 `failures`로 승격.
- 화면에 드러난 뒤에는 재시도 간격을 4s→8s→16s→32s→64s로 2배씩 늘리며 최대 5회(`MAX_AUTO_RETRIES`)
  자동 재시도 — 그 사이 성공하면 사용자가 아무것도 안 눌러도 토스트가 저절로 사라진다.

**하지 않은 것**: 진짜 서버/DB 다운은 유예시간 정도로 회복되지 않으므로 그대로 노출된다 — 유예시간은
"순간적 끊김"만 걸러내기 위한 것이지, 실패 자체를 숨기는 기능이 아니다. `DbHealthBanner`가 이미
전담하는 엔드포인트(`/api/health/db` 등)는 중복 노출을 피하기 위해 `EXCLUDED_PREFIXES`로 제외한다.

## 스크랩raw확인(StagingItemsGrid) 확정 진행률 표시

별개 요청(같은 세션에서 처리) — "스크랩raw확인" 메뉴에서 미확정 항목을 일괄 "확정" 처리할 때, 특히
수백 건 단위라 오래 걸리는데 진행 상황이 전혀 안 보인다는 지적. 서버 쪽(`/api/scrape-staging/merge`)
자체엔 진행률을 스트리밍할 방법이 없으므로(단일 POST 요청), 별도 폴링 전용 라우트를 추가했다.

- `GET /api/scrape-staging/merge/progress?ids=1,2,3`(신규) — 넘겨받은 staging item id들 중
  `status <> 'pending'`(이미 처리됨)인 개수를 세어 `{total, done}`으로 반환. 진행 상태를 별도로
  저장하지 않고 **이미 DB에 있는 status 컬럼을 직접 세는 방식**을 택했다 — 인메모리 Map으로
  추적하는 방법도 검토했으나, 이 프로젝트는 Next dev 서버가 파일 저장 시 `lib/` 모듈을 재평가해
  모듈 스코프 `Map`이 비워지는 문제가 있어(`globalThis` 캐싱이 기존 코드베이스의 표준 우회법 —
  `lib/scraper.ts`의 `siteLocks` 등 참고) 그 문제 자체를 피하는 쪽을 선택했다.
- `StagingItemsGrid.tsx`의 `handleMerge()`: 확정 POST 요청을 보내는 동안 800ms 간격으로 위 진행률
  라우트를 폴링(`mergeProgressPollRef`), 경과시간은 `mergeStartedAtRef`(`Date.now()` 기준)로 별도
  계산해 `mergeProgress: {total, done, elapsedSec}` state로 표시. 확정 버튼 위에 `"73% (512/700) ·
  42초"` 형태로 노출하고, 완료/에러 여부와 무관하게 `finally`에서 폴링 인터벌을 정리한다.

## 관련 파일

- `components/shell/GlobalErrorNet.tsx`: `REVEAL_GRACE_MS`/`FAST_RETRY_DELAY_MS`, `pending`/
  `revealTimers`, `revealEntry`, `addFailure`의 3분기 처리.
- `app/api/scrape-staging/merge/progress/route.ts`(신규): `GET ?ids=` → `{total, done}`.
- `components/panels/shared/StagingItemsGrid.tsx`: `mergeProgress` state, `handleMerge()`의 폴링
  로직, 확정 버튼 위 진행률 배지.

## 상태

**적용 완료.** 유예시간 값(2초→5초)은 실사용 피드백으로 한 차례 조정됨 — 추가로 여전히 노출된다는
피드백이 오면 유예시간을 더 늘리기보다 어떤 요청이 반복 노출되는지 먼저 확인할 것(유예시간을 무한정
늘리면 진짜 문제도 늦게 드러난다).
