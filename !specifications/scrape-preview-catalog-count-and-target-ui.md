# 스크랩 미리보기 카테고리 개수 정확도 + 스크랩 대상 UI 재설계 + 진행 상태 표시

## 배경

`ScraperPanel`의 "스크랩 대상" → "상품 페이지 미리보기" 흐름을 손보면서 세 가지 문제를 함께 해결했다.

1. **미리보기가 너무 느렸다**: 카테고리별 상품 개수를 구하려고 각 카테고리의 모든 페이지를 실제로
   열어 이름/썸네일/링크까지 모으고 있었다(5.6~7.7분 소요, 실사용 보고로 발견). 하지만 그 데이터는
   "스크래핑 시작"이 어차피 처음부터 다시 모으므로, 미리보기 시점엔 개수만 알면 충분하다는 게 사용자
   판단이었다.
2. **개수가 부정확했다**: 여러 카테고리가 서로 다른데 정확히 같은 개수로 나오는 버그가 두 번 발견됐다
   (아래 "카테고리 개수 계산" 참고) — 한 번은 페이지 전체 텍스트 스캔이 무관한 배지 숫자를 잘못 집은
   것, 한 번은 카페24류 스킨의 페이지네이션 위젯이 "현재 보이는 페이지 번호 묶음"만 노출하는 것을
   실제 마지막 페이지로 착각한 것.
3. **"스크랩 대상" 카드의 UI가 순서형(위→아래)처럼 보였다**: "현재 페이지 가져오기"(단일 URL 그대로
   사용)와 "카테고리 불러오기"(카테고리 자동 탐색 후 여러 개 선택)는 실제로는 서로 대체 관계인
   선택지(하나를 쓰면 다른 하나는 무시됨)인데, 세로로 쌓여 있어 1단계→2단계처럼 오인되기 쉬웠다.

## 카테고리 개수 계산 (`lib/scraper.ts`)

### 설계 — 첫 상품 1건만 상세 스크랩, 나머지는 개수만

`previewCatalog()`가 카테고리[0]에서 상품 1건만 상세 데이터를 뽑고, 나머지 모든 카테고리는
`countCategoryProducts()`로 개수만 구한다(이름/썸네일/링크 미수집). 사용자가 지정한 계산식을 그대로
구현:

```
총개수 = 페이지당 노출개수 × (총페이지수 − 1) + 마지막페이지_노출개수
```

- `countProductsOnPage()`: 기존 `scanForProducts`와 같은 링크 매칭 기준으로 개수만 반환(이름/썸네일
  미생성).
- `readMaxPageNumber()`: 페이지네이션 위젯의 `a[href]` 중 가장 큰 페이지 번호를 총 페이지수로 읽는다.
  `span`/`strong` 등 링크가 아닌 요소는 보지 않는다 — 아래 버그 참고.
- `countCategoryProducts()`(worker당 새 탭, `context.newPage()`로 로그인 창과 완전히 분리): 1페이지
  개수 × 마지막 페이지 방문으로 위 계산식을 실행하고, 페이지네이션을 못 읽거나 못 믿을 상황이면
  안전하게 페이지를 하나씩 순회하며 개수만 세는 방식(`AUTO_PAGINATION_CAP=50`)으로 폴백한다 — 정확한
  개수 보장이 최우선이라는 설계 원칙.
- `previewCatalog()`는 카테고리별로 `COUNT_CONCURRENCY=4`개 탭을 동시에 띄워 개수를 모은다.

### 버그 1 — 페이지 전체 텍스트 스캔이 무관한 배지를 집음 (제거됨)

처음엔 `readListedTotalCount()`가 `document.body.innerText`에서 "총 N개" 패턴을 찾는 지름길을 썼다.
서로 다른 카테고리(보스턴백/크로스백/백팩)가 전부 "240개"로 나오는 버그가 실사용 스크린샷으로
발견됨 — 원인은 목록과 무관한 페이지 어딘가의 다른 배지 숫자를 잘못 집은 것. `readListedTotalCount`와
호출부를 전부 제거하고, 항상 실제 상품 링크 개수를 세는 구조적 방식만 쓰도록 재설계했다.

### 버그 2 — 페이지네이션 위젯의 "보이는 번호 묶음"을 마지막 페이지로 착각 (수정됨)

버그 1을 고친 뒤에도 같은 증상(여러 카테고리가 똑같이 240개)이 재발했다. 실제 사이트
(`seasonbag.co.kr`, 카페24)에 진단 로그를 심어 확인한 원인:

```
"브랜드"        perPage=48 maxPage=5 lastPageCount=48 → count=240
"크로스/슬링백"  perPage=48 maxPage=5 lastPageCount=48 → count=240
"백팩"          perPage=48 maxPage=5 lastPageCount=48 → count=240
"전체상품"      perPage=48 maxPage=5 lastPageCount=48 → count=240
```

카페24 기본 페이지네이션 위젯은 한 번에 페이지 번호를 5개(1~5)만 노출하고 다음 묶음은 화살표로만
이동한다. `readMaxPageNumber()`가 "화면에 보이는 가장 큰 번호"를 총 페이지수로 오인했고, 5페이지가
여전히 48개(꽉 참)였다는 게 결정적 단서 — 진짜 마지막 페이지라면 보통 꽉 차지 않는다.

**수정**: "마지막"이라고 읽은 페이지(`maxPage`) 바로 다음 페이지(`maxPage+1`)도 비어있는지 한 번 더
확인한다. 비어있어야만 계산식을 신뢰하고, 상품이 더 있으면 안전한 직접 순회 폴백으로 전환한다.

### 버그 3 — 위젯 캡 폴백(직접 순회)이 순차 탐색이라 대형 카테고리에서 다시 느려짐 (수정됨)

버그 2의 수정으로 정확도는 맞았지만, "직접 순회로 전환"이 **1페이지씩 순서대로** 빈 페이지가 나올
때까지 여는 방식이라 카테고리가 실제로 수십~수백 페이지짜리면 그만큼 느렸다. 다른 몰
(`1020bag.com`, 고도몰류)의 실사용 로그로 재확인:

```
"국내생산제품" maxPage=9 → page 10에도 33개 더 있음 → 직접 순회로 전환   (수십 페이지 순차 방문)
"지갑 > 반지갑" maxPage=2 → page 3에도 33개 더 있음 → 직접 순회로 전환
"지갑 > 중지갑" / "지갑 > 카드지갑" / "방한용품" 도 동일 패턴
```

**수정**: 순차 탐색 대신 `findRealLastPage()` — 지수 확장(1, 2, 4, 8...페이지씩 건너뛰며 빈 페이지가
나올 때까지) + 그 사이를 이분 탐색해 실제 마지막 페이지를 찾는다. 카테고리가 300페이지짜리여도
로그(n)번(~20번 안팎)만 페이지를 열면 되므로 대형 카테고리에서도 빠르다. 탐색 상한
(`AUTO_PAGINATION_CAP*100`페이지)을 넘도록 못 찾으면 기존의 안전한 순차 폴백으로 다시 떨어진다
(정확도는 그대로 보장).

### 버그 4 — "maxPage 자체가 비어있는" 케이스는 옛 순차 탐색이 그대로 남아있었음 (수정됨)

버그 3의 수정은 "위젯 묶음 끝이라 maxPage+1에도 상품이 더 있는" 경우만 고쳤다. `maxPage` 페이지를
열었더니 **완전히 비어있는**(`lastPageCount === 0`, 페이지 번호를 아예 잘못 읽은 경우) 케이스는 여전히
맨 아래 옛날 순차 탐색으로 빠졌다 — 실사용 확인(`1020bag.com`): perPage=651·723인 카테고리 2개가
이 경로로 빠져 각각 1577개·5622개를 한 페이지씩(page당 최대 75개) 순회하느라 미리보기 전체가
20.7분 걸림. **수정**: 이 폴백도 `findRealLastPage()`를 1페이지(이미 확인된 `perPage`)부터 재사용하도록
통일 — 두 실패 케이스 다 같은 빠른 탐색을 탄다. 그래도 못 찾을 때만(탐색 상한 초과) 최후 수단으로
옛 순차 탐색이 남아있다.

### 성능 — 페이지 방문 1회당 고정비용이 지수+이분 탐색 횟수만큼 누적돼 여전히 느렸음 (수정됨)

버그 3·4로 알고리즘(방문 횟수)은 O(log n)까지 줄였는데도 여전히 느리다는 재보고 — 원인은 **페이지
방문 1회의 고정비용** 자체였다:

- `settleAfterNav()`가 `networkidle`(네트워크 연결이 500ms 동안 하나도 없어야 통과)을 최대 5초까지
  기다리는데, 광고/채팅위젯/분석 스크립트가 계속 폴링하는 몰은 네트워크가 절대 완전히 안 잠잠해져
  **매 방문마다 5초를 통째로 날렸다**. 탐색이 카테고리 하나에 페이지를 수십 번 열 수 있어 누적 효과가
  가장 컸다. → 타임아웃을 5000ms → 500ms로 줄였다(지연 리다이렉트 레이스 방지 목적은 짧은 유예로도
  충분하고, 최악의 낭비를 10분의 1로 줄인다).
- 개수만 세는 데(`<a>` 태그 존재 여부만 보면 됨) `waitUntil: 'load'`(이미지·광고까지 전부 받을 때까지
  대기)를 쓰고 있었다 → `'domcontentloaded'`(HTML 파싱 완료 시점)로 변경(`countCategoryProductsOnce`/
  `findRealLastPage`의 모든 카운팅용 `goto`, 부트스트랩/상품 1건 상세 추출용 `goto`는 그대로 `'load'`
  유지 — 이미지·옵션 등 실제 콘텐츠가 필요함).
- **알려진 한계**: 상품 목록을 순수 클라이언트 JS로 나중에 그려 넣는(서버 렌더링이 아닌) 스킨에서는
  `domcontentloaded` 시점에 아직 상품 링크가 DOM에 없어 개수를 잘못 셀 이론적 여지가 있다 — 지금까지
  확인된 몰(카페24/고도몰류)은 전부 서버 렌더링이라 문제없었다.

### 안정성 — 탐색 중 발생하는 "Execution context was destroyed" 자동 복구

`goto` 직후 바로 `page.evaluate`를 부르면, 몰 페이지의 지연 리다이렉트와 겹쳐 실행 컨텍스트가
사라지는 레이스가 있다(로그인 제출부에서 먼저 발견된 것과 같은 문제). 위 "다음 페이지 확인" 로직이
페이지 이동 횟수를 늘리면서 실사용 중 이 오류가 미리보기 전체를 깨뜨리는 게 확인됐다(사용자가
"확인 실패" 알림을 수동으로 닫아야 했음).

- `settleAfterNav()`: 각 `goto` 뒤 `networkidle`까지 짧게(최대 5초) 한 번 더 대기해 레이스를 줄인다.
- `countCategoryProducts()`는 내부적으로 `countCategoryProductsOnce()`를 감싸 실패 시 그 카테고리만
  조용히 한 번 더 재시도하고, 그래도 실패하면 해당 카테고리만 0개로 처리한다 — 카테고리 1건의 실패가
  `Promise.all`을 타고 전체 미리보기를 깨뜨리지 않는다(사용자 개입 없이 자동 복구).

## 미리보기 중지

미리보기가 오래 걸릴 수 있으니(위 성능 수정 이후에도 몰에 따라 카테고리가 아주 많으면 시간이 걸림)
언제든 중지하고, 위 "스크랩 대상"을 다시 조정해 바로 새 미리보기를 시작할 수 있어야 한다는 요청.

- **왜 실제 스크랩의 중지(`requestStop`/`isStopRequested`, `!specifications/scraping-control-and-retry.md`
  참고)를 못 쓰는가**: 그 메커니즘은 `sessionId`(DB `scrape_session` row) 기준인데, 미리보기는 DB
  세션을 만들지 않는 단발 요청이라 키로 쓸 세션이 없다.
- **대신 요청 자체의 `AbortSignal`을 재사용**: 클라이언트(`ScraperPanel.tsx`)가 `AbortController`를
  만들어 `fetch`에 물리고, "⏹ 중지" 버튼은 `controller.abort()`만 부른다. 서버
  (`app/api/scrape/preview-catalog/route.ts`)는 그 요청의 `req.signal`을 `previewCatalog`에
  `stopSignal`로 그대로 전달한다(`ScrapeOptions.stopSignal?: AbortSignal`, 신규 필드).
- `previewCatalog` 내부에 `const stop = () => !!opts.stopSignal?.aborted`를 만들어 워커 풀 루프,
  `countCategoryProducts`/`countCategoryProductsOnce`, `findRealLastPage`의 이분/지수 탐색 루프,
  순차 폴백 루프, 마지막 상품 1건 추출 단계까지 다음 네트워크 왕복 전에 매번 확인한다 — 중지 후
  서버가 계속 도는 것을 막아 곧바로 새 미리보기를 시작해도 이전 시도와 충돌하지 않는다.
  `categoryCounts` 배열은 중지 시 처리 못 한 칸이 비므로(`(CategoryCount | undefined)[]`) 반환 직전
  `filter(Boolean)`으로 걸러낸다.
- `GlobalErrorNet`의 `window.fetch` 패치가 이 의도된 abort(`DOMException name==='AbortError'`)까지
  "서버 오류"로 잡아 자동 재시도를 걸면, 중지해도 몇 초 뒤 같은 요청이 저절로 다시 나가는 문제가
  생긴다 — AbortError는 `addFailure` 호출에서 제외하도록 예외 처리했다.
- UI: "🔍 스크랩 미리보기" 옆에 로딩 중(`previewLoading`, 일반모드 한정)일 때만 "⏹ 중지" 버튼이
  뜬다. 개발자모드는 서버가 아니라 사용자 브라우저의 확장이 도는 구조라 이 fetch로 멈출 서버 작업이
  없어 제외(기존 2분 타임아웃만 그대로 있음).

## 중복 실행 방지 + 진행률 표시

미리보기 중지 기능을 넣은 뒤에도 "끝없이 오래 걸린다"는 재보고가 있었다. 로그를 보니 **같은 몰에
대해 미리보기 실행이 여러 개 겹쳐 돌고 있었다** — 워커 풀 구조상 한 실행 안에서는 카테고리가 절대
중복 처리될 수 없는데, 완전히 같은 결과 메시지가 짧은 시간 안에 두 번씩 로그에 찍혔고, 그 와중에
`/api/health/db` 같은 가벼운 요청도 14~71초씩 걸렸다(Playwright 탭 여러 벌이 CPU를 나눠 먹은
정황). 원인: "중지" 기능이 생기기 전에는 미리보기를 도중에 멈출 방법이 아예 없었고, 코드를 여러 번
고치는 동안 이미 실행 중이던 예전 시도들은 그 순간의 (더 느린) 코드로 계속 돌면서 쌓였다.

- **`previewRuns`(신규, `lib/scraper.ts`)**: `Map<siteId, PreviewRunState>`(`{superseded, done, total}`,
  `globalThis` 저장). `beginPreviewRun(siteId)`가 그 몰의 이전 실행을 `superseded=true`로 표시하고
  이번 실행용 새 항목을 만든다. `previewCatalog`의 `stop()`이 클라이언트 abort뿐 아니라
  `runEntry.superseded`도 함께 확인해, 밀려난 실행이 다음 체크포인트에서 스스로 멈춘다.
- **진행률 폴링**: 워커가 카테고리 하나를 끝낼 때마다 `runEntry.done++`. `getPreviewProgress(siteId)`를
  새 엔드포인트 `GET /api/scrape/preview-progress`가 노출하고, `ScraperPanel.tsx`가 1초마다 폴링해
  버튼에 "카테고리 확인 중... (12/34)"로 보여준다 — 멈춘 건지 도는 건지 알 수 있게.
- **공유 탭 경쟁(재점검 중 발견, 수정됨)**: `superseded` 체크만으론 부트스트랩(카테고리 0번 1건 확보)과
  맨 끝 "상품 1건 상세 추출" 단계를 못 막았다 — 이 두 단계가 `withContext`가 넘겨주는 **공유 로그인
  탭**에 직접 `goto`를 걸고 있어서, 같은 몰에 미리보기가 두 개 겹치면 한쪽이 다른 쪽이 막 이동한
  페이지 내용을 읽어 **에러 없이 조용히 틀린 결과**가 나올 수 있었다. 카운팅 워커가 이미 항상
  `context.newPage()`로 새 탭을 쓰는 것과 같은 이유로, 이 두 단계도 전용 `scratchPage`(새 탭)를 열어
  쓰도록 바꿨다 — 같은 컨텍스트 안이라 로그인 세션은 그대로 공유되면서 경쟁은 사라진다.
- **밀려난 실행의 응답을 화면이 "완료"로 잘못 표시하던 문제(수정됨)**: `previewRuns`가 siteId당 항목
  하나뿐이라 두 탭이 같은 몰을 보면 진행률이 서로 덮어써질 뿐 아니라, 밀려난 실행도 **정상 200
  응답**을 그대로 돌려줘 클라이언트가 그걸 "완료된 미리보기"인 줄 알고 화면에 반영해버렸다. 응답에
  `superseded?: boolean` 필드를 추가하고, `handlePreview`는 이 값이 true면 결과를 조용히 무시한다
  (진짜 최신 요청의 응답이 따로 옴).
- **AI모드 낭비 방지**: 밀려난 실행이 마지막에 외부 AI API 호출 + DB 저장까지 무조건 돌리던 것을,
  그 호출 직전에도 `stop()`을 한 번 더 확인하도록 해 건너뛰게 했다.
- **더 넓은 범위의 후속 조치**: 이 문제의 진짜 근본 원인(`withContext`가 로그인 창의 공유 탭을 잠금
  없이 여러 호출에 나눠줌)은 `previewCatalog` 하나만의 문제가 아니라 스크랩 관련 9개 기능 전체에
  걸쳐 있었다 — 전용 리뷰 워크플로로 전수조사해 `withSiteLock`이라는 범용 락으로 한 번에 고쳤다.
  자세한 내용은 `!specifications/concurrent-execution-guard.md` 참고.

## 스크랩 대상 카드 UI 재설계 (`components/panels/ScraperPanel.tsx`)

### 진행 상태를 버튼 색으로 구분 (파일럿: 스크래핑 메뉴)

"이미 완료한 단계"와 "다음에 할 단계"를 버튼 색으로 구분해달라는 요청(보조 버튼은 제외)에 따라,
아래 4개 **주 진행(primary) 버튼**에 전/후 상태를 적용:

- 클릭 전: 진한 색 채움(`bg-teal-500`/`bg-emerald-600` 등)
- 완료 후: 흰 배경 + 굵은 색 테두리(`border-2`) + 텍스트에 `✓` 접두 — 색 대비만으론 헷갈릴 수 있어
  아이콘도 함께 바꿨다.

대상: ① 로그인 창 열기/몰 페이지 열기(`loginStep`) ② 로그인 확인(`loginStep==='confirmed'`)
③ 🔍 스크랩 미리보기(`previewResult` 존재) ④ 스크래핑 시작(`status==='done'`) ⑤ 현재 페이지
가져오기(`currentUrlFetched`) ⑥ 모든 카테고리 불러오기(`categories.length>0`).

**보조 버튼**(몰 구조 파악/다시 확인/스크랩 대상 직접지정)은 명시적 요청대로 손대지 않되, 팔레트
자체를 회색 테두리(`border-gray-300`/`text-gray-600`)로 분리해 주 버튼과 시각적으로 확실히
구분되게 했다 — 이전엔 teal 계열 1px 테두리라 주 버튼의 "완료" 상태(teal 2px 테두리)와 얼핏
비슷해 보였다.

`ScrapeStepBox`(신규 로컬 컴포넌트, `components/panels/ScraperPanel.tsx` 상단)가 이 전/후 색상
패턴과 "설명 + 보조버튼 + 주버튼" 레이아웃을 강제로 공유하게 해, 두 곳(현재 페이지 가져오기 /
카테고리 불러오기)이 따로 스타일이 어긋나지 않게 했다.

**색상 신호 진화**: 처음엔 각 버튼이 자기 로컬 성공 여부(`currentUrlFetched`/`categories.length>0`)로
색을 바꿨는데, 이 둘은 독립적이라 하나만 성공하면 색이 서로 달라져("둘이 다른 버튼처럼 보임", 사용자
피드백) 잠깐 `staticColor`(색은 항상 고정, 라벨만 변경)로 눌렀다가, 최종적으로는 `colorDone` prop을
따로 둬서 **"다음 단계(🔍 스크랩 미리보기 성공, `previewResult` 존재)로 넘어갔는지"라는 두 버튼
공통 신호**로 색(+✓ 아이콘)을 함께 바꾸도록 정리했다. 라벨 텍스트(`doneLabel`)는 그와 별개로 각자
실제 로컬 성공 여부로만 바뀐다 — 안 누른 버튼에 "불러옴" 같은 거짓 라벨이 붙지 않는다.
(`ScrapeStepBox`의 `primary.done`=라벨용 로컬 신호, `primary.colorDone`=색상용 공유 신호, 미지정 시
`done`으로 폴백.)

### 선택형 레이아웃 — "위/아래 단계"가 아니라 "둘 중 하나"

"시작 URL을 그대로 스크랩" vs "카테고리를 자동으로 찾아 여러 개 지정"은 대체 관계(하나를 채우면
다른 하나는 무시됨, 기존부터 있던 동작)인데 세로로 쌓여 있어 순서형 단계처럼 보였다. 좌/우 2단
레이아웃 + 가운데 "또는" 구분선으로 재배치:

- 왼쪽 열: "현재 페이지 가져오기" 버튼(`ScrapeStepBox`) → 그 결과인 **현재 페이지 URL** 입력칸(옛
  "시작 URL") → 경고문
- 오른쪽 열: "모든 카테고리 불러오기" 버튼(`ScrapeStepBox`, 옛 "시작 URL에서 카테고리 불러오기") →
  그 결과인 **선택 - 카테고리 URL 목록** 텍스트영역(옛 "카테고리 URL 목록 (한 줄에 하나씩)")
- 버튼을 입력칸보다 위에 둔 것은 "눌러서 채우고 그 아래에서 결과 확인"이 되도록 하기 위함(먼저
  입력칸을 보여주고 그 아래 버튼을 두면 반대로 읽힘).
- 카테고리 검색 결과(캐시 안내/감지된 플랫폼/체크리스트)는 폭이 넓게 필요해 2단 배치 밖에 전체
  너비로 별도 박스로 둔다.
- (수정) 처음엔 로그인 미확인 상태에서 왼쪽 "현재 페이지 가져오기" 박스 자체를 숨겼는데, 그러면
  오른쪽(카테고리)만 있고 왼쪽이 비어 "같은 레벨" 느낌이 깨진다는 피드백으로, 이제 항상 두 열 다
  보여주고 왼쪽은 `loginStep==='none'`일 때 버튼만 disabled 처리한다(열려있는 브라우저 세션이
  없어 눌러도 조용히 무반응이라는 실질적 이유가 있음 — "카테고리 불러오기"가 `targetUrl` 없을 때
  disabled인 것과 같은 근거).

### 카테고리 체크리스트 — 전체선택을 우측 텍스트 링크에서 좌측 마스터 체크박스로

"전체 선택 (몰 전체상품)"/"전체 해제"가 표 우측 끝 텍스트 링크였는데(눈에 잘 안 띔, 사용자 발견),
각 행 체크박스와 같은 왼쪽 칸(`w-6`)으로 옮겼다. 폭을 픽셀 단위까지 정확히 맞추려고 헤더 행을
별도 `<div>`가 아니라 같은 `<table>`의 `<thead>`로 합쳤다(`tbody`와 열 폭이 항상 자동으로 맞음).
체크박스는 전체 선택 시 checked, 일부만 선택 시 `indeterminate`(ref 콜백으로 DOM 프로퍼티 직접 설정
— React가 `indeterminate` HTML 속성을 지원하지 않음), 헤더 행은 `sticky top-0`으로 스크롤해도
보이게 했다.

### 접기/펼치기 라벨 통일

"상품 페이지 미리보기" 카드만 "▲ 결과 접기"/"▼ 결과 펼치기"로 다르게 표기되던 것을, 다른 4곳
(Mall 선택/로그인 정보/스크랩 대상/개발자모드 안내)과 같은 "▲ 접기"/"▼ 펼치기"로 통일.

## 화면 전역 자동 재시도 (`components/shell/GlobalErrorNet.tsx`)

사용자가 h/w 상황을 통제할 수 없어 "다시 시도"를 언제 눌러야 할지 판단하기 어렵다는 피드백에 따라,
5xx/네트워크 실패 요청을 4초부터 2배씩 늘려가며(4/8/16/32/64초, 최대 5회) 자동 재시도하도록 추가.
성공하면 사용자가 아무것도 안 눌러도 알림이 사라진다. 수동 "다시 시도"/"닫기" 버튼은 그대로 유지.
`DbHealthBanner`가 전담하는 `/api/health/db` 등은 중복 표시 방지를 위해 제외.

## 관련 파일

- `lib/scraper.ts`: `countProductsOnPage`, `readMaxPageNumber`, `findRealLastPage`(신규, 지수+이분
  탐색), `countCategoryProducts`(+`Once`), `settleAfterNav`, `previewCatalog` 재작성.
  `readListedTotalCount`(전체 텍스트 스캔 방식) 완전 제거. `ScrapeOptions.stopSignal?: AbortSignal`
  신규 필드 + 카운팅 루프 전반에 `stop()` 체크 추가. `previewRuns`/`beginPreviewRun`/`endPreviewRun`/
  `getPreviewProgress`(신규, 중복 실행 방지 + 진행률). `previewCatalog`의 부트스트랩/최종 상품 추출이
  공유 `page` 대신 전용 `scratchPage`(`context.newPage()`) 사용. `CatalogPreviewResult.superseded?:
  boolean`(신규 필드).
- `app/api/scrape/preview-catalog/route.ts`: `previewCatalog`에 `stopSignal: req.signal` 전달.
- `app/api/scrape/preview-progress/route.ts`(신규): `GET ?siteId=` → `{done, total}` 진행률 폴링용.
- `app/api/scrape/categories/route.ts`: `sites.scrape_profile.categoryLinks` 캐시를 먼저 확인 후
  없으면 `discoverCategoryLinks`로 직접 훑고 캐시에 반영(`force=true`면 강제 새로고침) — "몰 구조
  파악"이 이미 찾아둔 목록을 "카테고리 불러오기"가 재사용.
- `components/panels/ScraperPanel.tsx`: `ScrapeStepBox` 신규 컴포넌트(`colorDone` prop 포함), 버튼
  전/후 색상, 스크랩 대상 2단 레이아웃, 카테고리 체크리스트 마스터 체크박스, 접기/펼치기 라벨 통일,
  `previewAbortRef`/`handleStopPreview`(미리보기 중지), `previewProgress`/`previewProgressPollRef`
  (진행률 폴링), `d.superseded` 체크(밀려난 응답 무시).
- `components/shell/GlobalErrorNet.tsx`(신규): 지수 백오프 자동 재시도, `AbortError` 예외 처리.
- `app/layout.tsx`: `<GlobalErrorNet />` 마운트.

## 상태

**구현 완료.** tsc/eslint 클린. 카테고리 개수 버그(1~4)는 실제 몰(seasonbag.co.kr, 1020bag.com)
로그로 원인을 확인하고 수정했다. 속도는 알고리즘(지수+이분 탐색)과 페이지 방문 1회당 고정비용
(`settleAfterNav` 타임아웃, `waitUntil`) 양쪽을 다 손봐야 했다 — 하나만 고쳤을 땐 "여전히 느리다"는
재보고가 반복됐다. "현재 페이지 가져오기"가 느리다는 문의는 실제 코드(application-code 7~74ms)가
아니라 `next dev` 개발 모드의 온디맨드 컴파일 오버헤드임을 프로덕션 빌드 비교(격리된 git worktree에서
`next build --webpack` 후 포트 비교 — 프로덕션 20~40ms vs 개발 서버 730ms~3.5s)로 확인했다(코드
수정 없음, 환경 특성). 카테고리 개수/속도 모두 재현 확인은 사용자가 다음 미리보기 실행에서 검증 예정.
