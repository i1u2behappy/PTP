# 몰별(siteId) 동시 실행 방지 — withSiteLock

## 배경

`previewCatalog`(스크랩 미리보기)의 "중복 실행 방지"(같은 몰에 새 미리보기가 뜨면 이전 실행을
`superseded` 처리)를 만들고 검증하던 중, 그 근본 원인이 `previewCatalog` 하나만의 문제가 아니라는 게
드러났다. `lib/scraper.ts`의 `withContext()`(스크랩 관련 거의 모든 기능이 몰의 브라우저
세션/프로필을 얻을 때 거치는 공용 함수)와, 그걸 거치지 않고 `openSessions`(로그인 창 탭)를 직접
만지는 몇몇 함수들이 **같은 몰(siteId)에 대해 두 작업이 동시에 뜨는 것을 전혀 막지 않고 있었다**:

- 로그인 창이 열려있으면 그 공유 탭(`Page` 객체)을 잠금 없이 그대로 여러 호출에 나눠준다 — 두 작업이
  동시에 그 탭에 `goto()`를 걸면 한쪽이 다른 쪽이 막 이동한 페이지 내용을 읽어버려 **에러 없이 조용히
  틀린 데이터**가 나올 수 있다(가장 위험한 형태).
- 로그인 창이 없으면 `killOrphanedProfileProcess`(그 몰 프로필 폴더를 쓰는 크롬을 전부 강제 종료)
  후 새 브라우저를 그 프로필 폴더에 띄우는데, 두 작업이 동시에 이 경로를 타면 한쪽이 방금 뜬 다른
  쪽의 살아있는 크롬을 죽여버린다.

전용 워크플로(여러 리뷰어가 각자 다른 각도로 검증)로 전수 조사한 결과, 이 패턴이 **9개의
`withContext` 호출 지점**(로그인 확인 후 자동 몰구조체크·재스크랩·스크랩조정·스크래핑
시작·미리보기·연속관리 재체크·카테고리 불러오기·이미지 다운로드 폴백)과, `withContext`를 안 거치고
`openSessions`를 직접 만지는 **5개 함수**(로그인 창 열기·로그인 확인 이동·몰 구조 파악·스크랩 대상
직접지정·미리보기 항목 열기)에 걸쳐 있었다. 각각을 따로 패치하는 대신, 근본 원인(공유 브라우저
자원에 잠금이 없음)을 한 곳에서 고치는 쪽을 택했다.

## 설계 — `withSiteLock(key, label, fn)`

`lib/scraper.ts`의 `withSiteLock`은 같은 key(보통 `siteId`)에 대한 실행을 **취소가 아니라 줄세우기
(큐)**로 처리하는 async 뮤텍스다. Promise 체이닝으로 구현(`siteLocks: Map<number|string, Promise<void>>`,
`globalThis` 저장 — 다른 인메모리 상태와 같은 이유로 dev 핫리로드에도 살아남게 함).

```ts
export async function withSiteLock<T>(key: number | string | undefined, label: string, fn: () => Promise<T>): Promise<T> {
  if (key === undefined) return fn()
  const prevTail = siteLocks.get(key) ?? Promise.resolve()
  let releaseTail!: () => void
  const myTail = new Promise<void>(resolve => { releaseTail = resolve })
  siteLocks.set(key, myTail)
  try {
    await prevTail
    siteLockStatus.set(key, { label, since: Date.now() })
    return await fn()
  } finally {
    siteLockStatus.delete(key)
    releaseTail()
    if (siteLocks.get(key) === myTail) siteLocks.delete(key)
  }
}
```

`label`(사람이 읽을 짧은 이름, 예: "스크래핑 시작"/"몰 구조 파악")은 잠금 로직 자체엔 필요 없고,
바로 아래 "대기 상태 표시" 기능을 위한 것이다.

**왜 취소(supersede)가 아니라 줄서기인가**: 브라우저 탭 네비게이션은 이미 시작한 뒤 안전하게 취소할
방법이 없다 — 그래서 뒤에 온 실행을 취소시키는 대신 앞의 실행이 완전히 끝날 때까지 기다리게 한다.
반대로 "화면에 최신 결과만 보여주면 충분하고, 오래된 요청은 버려도 되는" 경우(미리보기 —
`previewRuns`/`beginPreviewRun`, `!specifications/scrape-preview-catalog-count-and-target-ui.md` 참고)는
다른 문제라 다른 해법(밀어내기)을 쓴다: 그건 "사용자가 보는 결과"를 최신 것으로 덮어쓰는 문제고,
`withSiteLock`은 "브라우저 자원 자체를 안전하게 나눠 쓰는" 문제다. 미리보기 같은 화면 단위 기능은
두 패턴을 **같이** 쓴다 — `withSiteLock`이 브라우저 충돌을 막고, `previewRuns`가 오래된 응답이 화면에
반영되지 않게 막는다.

**트레이드오프**: 같은 몰의 서로 다른 기능도 이 큐를 공유해 순서대로만 실행된다 — 오래 걸리는 전체
스크래핑 중에는 그 몰의 다른 작업(몰 구조 파악, 미리보기 등)이 끝날 때까지 기다리게 된다. 애초에 같은
로그인 세션으로 두 자동화를 동시에 돌리면 안 되므로(둘 다 같은 탭/프로필을 씀) 감수하는 트레이드오프로
판단했다.

## 적용 범위

- **`withContext()`**: `siteId`가 있는 전체 분기(로그인 창 재사용 / manual-login 헤드리스 / 일반
  헤드리스)를 `withSiteLock(siteId, ...)`로 감쌌다 — 이걸 거치는 9개 호출부(`profileMallStructureForScrape`,
  `scrapeSingleProduct`, `fetchPageText`, `detectIsListingPage`, `previewCatalog`, `scrapeCatalogPage`,
  `recheckMallProducts`, `discoverCategoryLinks`, `lib/images.ts`의 `fetchViaLoginSession`)가 전부
  자동으로 보호된다. siteId가 없는 마지막 분기(완전히 독립된 1회용 헤드리스 브라우저)는 공유 자원이
  없어 잠글 필요가 없다.
- **manual-login 전용 전역 락**(`MANUAL_LOGIN_LOCK_KEY`): `MANUAL_LOGIN_PROFILE_COPY_ROOT`는
  siteId별이 아니라 경로 하나뿐이다(사용자의 개인 크롬 프로필 하나를 그대로 미러링하는 것이라 몰마다
  다를 이유가 없음) — 그래서 서로 **다른** manual-login 몰 두 곳을 동시에 다뤄도 이 물리 폴더 하나를
  두고 경쟁한다. siteId 락과 별개로 이 전역 자원 전용 키로 robocopy부터 컨텍스트를 닫을 때까지
  통째로 감쌌다 — 즉 manual-login 몰 관련 작업은 사실상 한 번에 하나만 전역적으로 돈다(더 강한
  트레이드오프지만, 물리적으로 하나뿐인 폴더라 다른 방법이 없다).
- **`withContext`를 거치지 않는 함수들**: `launchVisibleWindow`(내부적으로만 쓰임, 락은 호출부에서),
  `openLoginWindow`, `openManualLoginWindow`, `navigateOpenPageTo`, `profileMallStructure`,
  `startElementPicker`는 각자의 몸체 전체를 `withSiteLock(siteId, ...)`로 감쌌다. `openUrlInLoginWindow`는
  예외 — "이미 열린 세션에 새 탭을 여는" 안전한 경로(공유 탭을 안 건드림)는 락 없이 즉시 처리하고,
  "세션이 없어 새로 띄워야 하는" 위험한 경로만 락으로 감쌌다(그래야 미리보기 항목 "열기"가 다른 무거운
  작업 때문에 불필요하게 기다리지 않는다).
- **부수 효과**: `startElementPicker`의 `pickerExposedPages`(Page별 `exposeFunction` 중복 등록 방지)
  check-then-act 경쟁도, 같은 siteId 호출이 이제 겹칠 수 없어 자동으로 해소됐다. `구조 변화 감지`
  (`runMallProfileCheckForScrape` → `profileMallStructureForScrape` → `withContext`)가 예전에 있다가
  2026-08 리팩터링으로 사라졌던 `profileCheckInProgress` 가드도, `withContext`를 통해 다시 보호된다
  (별도 코드 없이 자동 해결).

## 스크래핑 시작(POST /api/scrape) — DB 레벨 중복 세션 방지

`withSiteLock`은 실제 브라우저 작업을 순서대로 처리해주지만, 그것만 믿으면 사용자가 "스크래핑 시작"을
두 번 누르거나 여러 탭에서 누르면 **두 번째 세션이 화면에는 "실행 중"으로 보이면서 실제로는 첫 번째가
끝날 때까지 설명 없이 멈춰있는 것처럼** 보인다. `app/api/scrape/route.ts`에 진행 중인 세션이 이미
있는지 확인하는 체크를 추가했다:

```ts
const running = await pool.query(`SELECT id FROM scrape_sessions WHERE site_id=$1 AND status='running' LIMIT 1`, [siteId])
if (running.rows[0]) return NextResponse.json({ error: '...', sessionId: running.rows[0].id }, { status: 409 })
```

클라이언트(`ScraperPanel.tsx`의 `handleStart`)는 409를 받으면 새로 시작하는 대신 그 기존
`sessionId`에 그대로 연결해 진행 상황을 이어서 보여준다. 이 SELECT~INSERT 사이에도 이론적으로 아주
짧은 경쟁 window가 남아있지만(두 요청이 정말 동시에 도착하면 둘 다 "없음"을 볼 수 있음), 최후
방어선은 `withSiteLock`이라 그 경우에도 데이터가 섞이지는 않는다 — 이 체크는 사용자에게 미리
설명해주기 위한 UX 장치일 뿐, 유일한 방어선이 아니다.

## 대기 상태를 화면에 보여주기 (`getSiteLockStatus`)

`withSiteLock`을 넣은 뒤부터, 같은 몰의 다른 작업이 아직 안 끝났으면 버튼을 눌러도 그게 끝날 때까지
조용히 대기열에서 기다리게 됐다 — 그런데 화면엔 아무 표시가 없어서, 사용자 입장에선 "이 버튼(예:
로그인 확인)이 원래 이렇게 느린 건지 다른 작업 때문에 밀린 건지" 구분할 방법이 없었다(실사용 중
"로그인 확인이 왜 이렇게 오래 걸리냐"는 질문으로 발견 — 실제로는 `login-confirm` 자체는 DB 조회
1번 + 페이지 이동 1번뿐인 가벼운 요청이었다).

- `siteLockStatus: Map<key, {label, since}>`(신규, `globalThis` 저장) — `withSiteLock`이 락을
  실제로 잡는 순간(대기가 끝나고 `fn()`을 부르기 직전) 이 몰을 지금 누가 쓰고 있는지 기록하고,
  `fn()`이 끝나면 지운다.
- `getSiteLockStatus(siteId)`(신규, export) — `{label, sinceMs}` 또는 `null`을 돌려준다.
  `sinceMs`가 아주 크면(예: 수 분) 그건 대기가 아니라 그 작업 자체가 오래 걸리고 있다는 뜻이다.
- `GET /api/scrape/site-lock-status?siteId=`(신규 라우트) — 위를 그대로 노출.
- `ScraperPanel.tsx`: 몰이 선택돼 있는 동안 1.5초마다 이 엔드포인트를 폴링해(`siteLockStatus` state),
  바쁘면 몰 정보 박스 바로 아래 "⏳ 이 몰은 지금 다른 작업(${label})이 진행 중입니다 — N초째 —
  끝나면 방금 누른 작업이 이어서 진행됩니다"를 보여준다. 특정 버튼에 종속시키지 않고 몰 단위로 항상
  보이게 했다 — 락도 몰 단위(siteId)라 어떤 버튼을 눌렀는지와 무관하게 같은 큐를 공유하기 때문이다.

## 하지 않은 것 (의도적으로)

- **`scrapeCatalogPage`/`recheckMallProducts`가 로그인 창의 공유 탭을 "워커 0"으로 그대로 재사용하는
  것**: `previewCatalog`처럼 새 탭(scratch page)으로 바꾸는 리팩터링은 하지 않았다 — 애초에 문제였던
  "다른 호출과 동시에 같은 탭을 건드림"은 `withContext`의 새 락이 원천적으로 막아주므로, 이미
  안전하게 직렬화된 하나의 실행 안에서 어떤 탭을 쓰는지는 더 이상 정확성 문제가 아니다(사용자가 보는
  로그인 창이 스크래핑 동안 상품 페이지들을 오가며 보이는 것은 UX상 다소 어색할 수 있지만 별개
  사안이며, 이번 "중복 실행 방지" 범위 밖으로 남겨둔다).
- **여러 Node 프로세스(여러 노드) 간 잠금**: `withSiteLock`은 `globalThis` 기반이라 **한 프로세스
  안에서만** 유효하다(여러 브라우저 탭/창은 다 같은 프로세스를 거치므로 문제없이 보호됨). PTP를 2~3개
  프로세스로 띄워 **같은 몰**을 동시에 만지는 경우까지 막으려면 Postgres 어드바이저리 락
  (`pg_try_advisory_lock`, siteId 기준) 같은 DB 기반 잠금이 필요하다 — 다만 그 경우에도 크롬 자체의
  프로필 폴더 잠금(`SingletonLock`)과 `killOrphanedProfileProcess`가 이미 서로를 강제 종료시키는
  구조라 지금 당장은 시도하지 않는 게 안전하다. 실제로 여러 프로세스로 같은 몰을 동시에 쓸 계획이
  생기면 그때 추가한다(서로 다른 몰끼리는 프로세스가 몇 개든 애초에 겹칠 일이 없어 지금도 안전하다).

## 향후 개발 시 참고 — 언제 `withSiteLock`을 써야 하는가

`lib/scraper.ts`에 함수를 새로 추가하거나 기존 함수를 고칠 때, 그 함수가 아래 둘 중 하나라도
한다면 — 같은 key로 동시에 두 번 불릴 수 있는지 먼저 따져보고, 가능하면
`withSiteLock(key, label, fn)`으로 감싼다:

1. `openSessions.get(siteId)`로 얻은 페이지에 `goto`/`evaluate`를 건다.
2. `profileDir(siteId)` 또는 `MANUAL_LOGIN_PROFILE_COPY_ROOT` 같은 몰(또는 전역) 전용 디스크 자원에
   `launchPersistentContext`를 건다.

`label`은 사람이 읽을 짧은 한국어 이름("몰 구조 파악", "카테고리 불러오기" 등) — 화면이
`getSiteLockStatus`로 "지금 무엇 때문에 기다리는지"를 보여줄 때 그대로 노출되니, 사용자가 봤을 때
바로 이해되는 이름을 쓴다. `withContext()`를 거치는 함수는 `withContext(opts, fn, label)`의 세
번째 인자로 라벨만 넘기면 자동으로 보호된다 — 새 스크랩 기능은 대부분 `withContext`를 재사용하는
것만으로 충분하다. 그럴 수 없는 특수한 경우(로그인 창 관련 함수들처럼 `openSessions`를 직접 만지는
경우)에만 `withSiteLock`을 직접 쓴다. 자세한 설명과 이유는 `lib/scraper.ts`의 `withSiteLock` 함수
바로 위 주석에도 그대로 있다(코드를 고치는 사람이 가장 먼저 보게 되는 곳).

## 관련 파일

- `lib/scraper.ts`: `withSiteLock`(신규, `label` 인자 포함), `siteLockStatus`/`getSiteLockStatus`
  (신규, 대기 상태 표시), `MANUAL_LOGIN_LOCK_KEY`(신규), `withContext`(락 적용 + `label` 인자 추가,
  9개 호출부 모두 라벨 지정), `launchVisibleWindow`/`openLoginWindow`/`openManualLoginWindow`/
  `navigateOpenPageTo`/`openUrlInLoginWindow`/`profileMallStructure`/`startElementPicker`(락 적용).
- `app/api/scrape/route.ts`: 진행 중인 세션 존재 여부 체크(409 + 기존 sessionId 반환).
- `app/api/scrape/site-lock-status/route.ts`(신규): `GET ?siteId=` → `{busy, label?, sinceMs?}`.
- `components/panels/ScraperPanel.tsx`: `handleStart`가 409 응답을 받으면 기존 세션에 연결.
  `siteLockStatus` state + 1.5초 폴링 + "⏳ 다른 작업 진행 중" 배너(몰 정보 박스 바로 아래).

## 상태

**구현 완료.** tsc/eslint 클린. 전수 조사는 전용 리뷰 워크플로(5개 관점 병렬 조사 + 2건 교차검증)로
수행했다 — 실사용 중 재현된 문제(previewCatalog의 밀려난 실행이 완료로 잘못 표시됨, 위젯 캡 폴백
성능 문제 등)는 별도 스펙(`scrape-preview-catalog-count-and-target-ui.md`)에 남아있고, 이 문서는
그중 "동시 실행 자체를 막는" 더 넓은 범위(9개 `withContext` 호출부 + 5개 직접 접근 함수 + 스크래핑
시작 라우트)를 다룬다. 실제 다중 탭/다중 클릭 시나리오로 라이브 재현 테스트는 아직 안 했다 —
사용자가 다음 사용 중 확인 예정.
