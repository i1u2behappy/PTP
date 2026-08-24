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

### 버그 5 — 새 탭이 로그인 화면으로 튕겨도 감지 못 해 카테고리 하나에 페이지를 수십 번 열며 헤맴 (수정됨)

2026-08-09 실사용 확인(`seasonbag.co.kr`): "동시 처리"를 수동 2개로 낮춰서 미리보기를 돌렸는데, 실제
브라우저 창을 보니 카테고리 하나당 페이지를 하나씩 계속 열며 끝을 못 찾는 상태가 관찰됐다. 원인은
카운팅 경로(`countProductsOnPage`/`findRealLastPage`/`countCategoryProductsOnce`)가 이 파일의 다른
모든 페이지 방문 함수와 달리 `loginIfNeeded()`를 거치지 않는다는 것 — 카운팅 워커가 새로 여는 탭이
이 몰의 세션 검증에 걸려 로그인 화면으로 리다이렉트되면, 로그인 화면에 우연히 있는 `<img>` 링크
몇 개를 "상품"으로 잘못 세어 `count > 0`이 나온다. 지수+이분 탐색은 "빈 페이지(`count===0`)"를 절대
못 만나 끝을 못 찾고, 최후의 순차 폴백(최대 50페이지)까지 전부 소진하게 된다.

**수정**: `countProductsOnPage`가 매 페이지 평가(`page.evaluate`) 때 `input[type="password"]` 존재
여부도 같이 확인해(`isLoginPage`, 추가 왕복 없음) 돌려준다. 카운팅 경로의 모든 지점(1페이지 확인,
`maxPage`/`maxPage+1` 확인, `findRealLastPage`의 지수/이분 탐색, 최후 순차 폴백)에서 로그인 화면이면
그 즉시 지금까지 확인한 값으로 멈추고 `CategoryCount.needsLogin`을 표시한다. `previewCatalog`는 이
값들을 모아 최상위 `needsLogin`에 반영하는데, 이 필드는 이미 화면(`ScraperPanel.tsx`의
`applyCatalogPreview` — "세션 끊김" 배너 + 로그인 창 자동 재오픈)에 연결돼 있어 화면 쪽은 손댈 게 없었다.

### 버그 6 — 범위 밖 page 파라미터를 몰이 마지막 유효 페이지로 그대로 되돌려줘도 "더 있다"로 오인 (수정됨)

버그 5를 고친 뒤에도 같은 몰에서 재현된 문제: URL은 `page=16`, `page=32`로 계속 올라가는데 실제
페이지네이션 위젯은 여전히 14페이지가 마지막이라고 보여줌(사용자가 실제 브라우저 창으로 직접 확인).
원인: 이 몰은 범위를 벗어난 `page` 파라미터를 요청해도 빈 화면이 아니라 **마지막 유효 페이지(14) 내용을
그대로 다시 돌려준다** — `count`만 보면 0이 아니라서 "아직 더 있다"고 오판해 지수 탐색이 진짜 끝을 못
찾고 페이지 번호만 계속 올린다.

**1차 시도(부족했음)**: `countProductsOnPage`가 상품 링크 목록을 정렬해 이어붙인 `fingerprint`도 같이
반환하게 하고, "현재 확인 중인 페이지(`lo`)와 내용이 완전히 같으면 반복이니 끝으로 본다"로 고쳤다.
그런데 지수 확장은 한 번에 여러 페이지를 건너뛰므로(1,2,4,8,16...), 건너뛴 자리가 하필 그 "반복
지점"이면 — 실제 내용은 페이지마다 다르므로 — 저 멀리 있는 `lo`와는 우연히 달라 보여 여전히 "새
내용"으로 오판할 수 있다(직접 시뮬레이션으로 재현: `lo=8`에서 `probe=16`으로 건너뛰었는데 16이 이미
14페이지 내용의 반복이지만 8페이지 내용과는 여전히 달라 새 페이지로 오인 → 최종 결과가 실제(14)보다
큰 16으로 잘못 확정됨).

**최종 수정**: `findRealLastPage`의 지수 확장 단계에서 "새 내용처럼 보이는" `probe`를 발견하면, 그
자리를 곧바로 믿지 않고 바로 다음 페이지(`probe+1`)까지 한 번 더 확인한다 — 그것도 같은 내용이면
반복이 안정적으로 계속된다는 뜻이므로 `probe`를 새 `lo`로 승격하지 않고 그 자리를 벽(`hi`)으로
확정한다. 이 안전장치가 확립된 뒤로는 이분 탐색 단계는 그대로(단순 비교만으로 충분 — `lo`/`hi`가 이미
검증된 기준점이라 사이에 있는 `mid`가 우연히 먼 곳과 헷갈릴 여지가 없다). 순수 JS로 시뮬레이션해
검증: 클램핑 몰(실제 14페이지, 그 이후 반복) → 정확히 14로 수렴, 정상 몰(300페이지, 그 이후 진짜
빈 화면) → 정확히 300으로 수렴(방문 25회, 로그 스케일 유지), 1·3페이지짜리 극소 카테고리도 각각
정확히 수렴.

### 버그 7 — clamp된 응답의 상품 내용이 매번 조금씩 달라 fingerprint 비교로도 못 잡음 (수정됨)

버그 6을 고친 뒤 실사용에서 또 재현(2026-08-09, 사용자가 실제 브라우저 스크린샷으로 직접 확인):
같은 몰에서 URL이 `page=21`까지 올라갔는데도, 페이지네이션 위젯은 여전히 "14"를 현재 페이지로 굵게
표시하고 있었다. 즉 버그 6의 클램핑 자체는 맞았지만, **클램핑된 응답의 상품 목록 내용이 매번 완전히
똑같지는 않다**(광고/추천 위젯 등이 섞여 fingerprint가 매 요청마다 달라짐으로 추정) — 그래서
"내용이 똑같으면 반복으로 본다"는 fingerprint 비교로는 이 케이스를 못 잡았다.

DB에 저장된 이 몰의 실제 로그인 정보(`sites.login_pw_encrypted`, 앱과 동일한
`CREDENTIALS_ENCRYPTION_KEY`로 복호화)로 헤드리스 브라우저를 직접 로그인시켜 재현/검증했다:
- `page=15/16/21/32/50`을 반복 요청 → 상품 개수는 매번 0(내 테스트 세션에선 진짜로 빈 화면 — 사용자의
  실사용 세션과 몰의 반응이 완전히 같지는 않았을 수 있음, 세션 이력/누적 요청량에 따라 몰의 반응이
  달라질 수 있다는 뜻으로 추정).
- 하지만 **페이지네이션 위젯 자체는 항상 안정적으로 "14"를 현재 페이지로 보고**했다. 실제 마크업
  확인: 카페24 기본 스킨은 현재 페이지도 `href 없는 요소가 아니라 여전히 `<a href>`이고, 클래스만
  다르다(`<a class="other">11</a>` ... `<a class="this">14</a>`) — 그래서 애초에 "href 없는 요소가
  현재 페이지"라는 첫 시도 가정이 틀렸다는 것도 이 과정에서 확인했다.

**수정**: `readCurrentPageNumber()`(신규) — 페이지네이션 위젯 안 페이지 번호 링크들 중 **"클래스가
다수와 다른 하나"**를 현재 페이지로 찾는다(스킨마다 클래스 이름은 다를 수 있지만 "현재 페이지만
클래스가 다르다"는 구조는 흔함). 상품 데이터가 아니라 위젯 구조 자체를 읽으므로 광고/추천 위젯 같은
데이터 노이즈에 영향받지 않는다. `findRealLastPage`의 지수/이분 탐색과 `countCategoryProductsOnce`의
`maxPage+1` 확인 지점 전부에서, **요청한 페이지 번호와 위젯이 보고하는 현재 페이지가 다르면 상품
개수가 몇 개든 그 즉시 벽으로 확정**한다 — fingerprint 비교보다 우선 신호로 쓰고, 위젯을 못 읽는
스킨(`readCurrentPageNumber`가 `null`)이면 기존 fingerprint 비교로 자동 폴백한다(버그 6 수정을 대체
하지 않고 보완).

순수 JS 시뮬레이션으로 검증: 클램핑된 응답의 내용이 매번 랜덤하게 달라지는 경우(이번에 확인된 실제
상황) → 위젯 신호로 정확히 14로 수렴(10회 방문). 위젯 신호가 전혀 없는 몰(폴백 경로) → 기존
fingerprint 방식 그대로 정확히 수렴. 평범한 300페이지짜리 몰 → 로그 스케일 방문 수 그대로 정상 동작.
`node`로 이 몰에 실제 로그인해 `readCurrentPageNumber`와 동일한 로직을 그대로 실행해 page=14에서
정확히 `{value:14, cls:"this"}`를 얻는 것도 확인했다.

### 버그 8 — 위젯 신호(버그 7)도 없는 스킨이면 결국 지수+이분 탐색 자체가 필요, "마지막 페이지로" 버튼 href를 직접 읽는 방식으로 근본 해결 (수정됨)

버그 7 수정 이후에도 2026-08-09 실사용에서 같은 유형의 증상 재보고: 첨부 스크린샷 기준 실제로는
6페이지가 마지막인 카테고리인데 URL이 `page=261`까지 올라갔고, 위젯은 여전히 "6"을 보여주고 있었다.
`readCurrentPageNumber`(버그 7) 자체는 정확히 동작했지만, 지수 확장(1,2,4,8,16,32,64,128,256...)이
"막힌 벽"을 찾을 때까지 매 단계마다 페이지를 열어야 하는 구조라, 실제 마지막 페이지가 작을수록(6처럼)
오히려 261까지 커진 뒤에야 벽에 부딪혀 되돌아오는 비효율이 있었다 — 알고리즘은 맞게 동작했지만 "몇
번을 시도하고서야 멈추는지"가 사용자에게는 "계속 넘어간다"로 보였다.

**발견**: 카페24 기본 페이지네이션 위젯에는 "마지막 페이지로" 이동 버튼이 있고
(`<a href=".../page=6"><img alt="마지막 페이지"></a>` 형태, 텍스트 없는 이미지 버튼), 이 버튼은 그
역할상 지금 몰이 보여주는 페이지가 몇 번이든 **항상 진짜 마지막 페이지의 href를 그대로 가리켜야
한다**. `sites.login_pw_encrypted`를 복호화해 seasonbag.co.kr에 직접 로그인시켜 실사용 검증: `cate_no=41`을
1/3/6/7/261 페이지로 각각 요청해도 이 버튼의 href는 한 번도 안 바뀌고 항상 `page=6`을 가리켰다. 즉
지수+이분 탐색이나 위젯의 "현재 페이지" 표시를 볼 필요 없이, 이 버튼 href의 쿼리파라미터 하나만
읽으면 즉시 정답이 나온다.

**수정**: `readLastPageFromNavButton(page)`(신규) — 페이지네이션 컨테이너(`[class*="paging" i]`,
`[class*="pagination" i]`) 안에서 클래스명 또는 `<img alt>`에 "last"/"마지막"이 포함된 `<a href>`를
찾아, 그 href의 `page` 쿼리파라미터를 총 페이지수로 직접 읽는다. `countCategoryProductsOnce`에서
1순위로 시도하고, `null`(버튼이 없는 스킨)이면 기존 `readMaxPageNumber`(텍스트 기반)로 자동
폴백한다 — 있으면 탐색 자체가 필요 없어지고, 없으면 버그 1~7에서 다져온 기존 안전장치가 그대로
살아있다.

**검증**: seasonbag.co.kr(카페24) 5개 카테고리 전부 1~2회 페이지 방문으로 즉시 해결(기존엔 최대
261회) 확인. 독립된 다른 카페24 몰(걸스굽 girlsgoob.cafe24.com)에서도 재현 검증 — 197페이지짜리
카테고리를 정확히 197로 즉시 인식. 고도몰류(1020bag.com)는 "마지막 페이지로" 버튼 자체가 마크업에
없어 이 함수가 항상 `null`을 반환하고 기존 방식으로 자동 폴백하는 것도 확인 — 부작용 없음.

**다른 플랫폼(고도몰) 조사 결과 — 코드 수정 불필요**: 버그 6~7이 고도몰(1020bag.com, pettob.co.kr)에도
있는지 실사용 계정으로 직접 로그인해 조사했다. 범위 밖 `page` 파라미터를 요청하면 고도몰은 카페24처럼
마지막 유효 페이지로 clamp하지 않고 **정직하게 0개**를 돌려준다 — 애초에 이 버그 계열 자체가 존재하지
않는 플랫폼이라, 억지로 대응 코드를 추가하지 않았다(불필요한 복잡도 회피).

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

### 버그 9 — 지수+이분 탐색 자체가 무겁다: probe 한 번마다 실제 브라우저 탭 렌더링을 거쳐 이벤트루프까지 막음 (부분 수정)

버그 8(마지막 페이지 버튼 href 직접 읽기) 이후에도, 그 버튼을 못 찾는 카테고리(위젯이 "보이는 번호
묶음"만 노출하고 점프 버튼이 없는 스킨)는 여전히 지수+이분 탐색을 타야 했다. 2026-08-09~10 실사용
확인(seasonbag.co.kr "크로스/슬링백", 134페이지): 이 탐색이 도는 동안 `GET /`처럼 전혀 무관한 요청까지
정확히 같은 21.2초 동안 함께 500으로 죽었다 — probe 하나당 `workerPage.goto()`(실제 브라우저 네비게이션)
+ `page.evaluate()` 두 번(CDP 왕복)을 거치는 구조라, 대형 카테고리에서 이게 수십 번 누적되며 Node
이벤트루프/메모리를 함께 잡아먹었다(같은 시간대 RSS 1.5~1.6GB로 치솟음, 자동재시작 임계치 1536MB에
근접).

**조사한 대안**: (a) 카페24 공식 API의 `totalCnt`(운영자 OAuth 앱 등록 필요, 이 도구의 "아무 몰이나
로그인해서 스크랩" 방식과 안 맞음), (b) 브라우저는 로그인/세션 확보용으로만 쓰고 나머지 페이지 카운팅은
같은 세션 쿠키를 재사용한 순수 HTTP 요청으로 처리하는 하이브리드 패턴(업계에서 흔히 쓰는 방식) — (b)를
채택.

**수정**: `findRealLastPage` 진입 시, 이미 브라우저로 확인된 기준 페이지(`knownNonEmptyPage`) 하나를
Playwright의 `context.request.get()`(같은 `BrowserContext`라 로그인 쿠키가 자동으로 실림, 브라우저 탭·
렌더링·CDP 왕복 없음)로 다시 읽어 개수가 일치하는지 캘리브레이션한다. 일치하면 이후 모든 probe를
`countProductsFromHtml`/`readCurrentPageNumberFromHtml`(cheerio 기반, `countProductsOnPage`/
`readCurrentPageNumber`와 판정 기준을 반드시 동일하게 유지)로 처리해 브라우저 탭을 전혀 안 띈다.
캘리브레이션이 실패하면(클라이언트 JS로 그리는 몰 등) 기존 브라우저 방식 그대로 진행 — 이 최적화가
안 맞는 몰에서도 지금보다 나빠지지 않는다.

**한계(미해결로 남음)**: 실사용 재검증에서 "크로스/슬링백"은 하필 캘리브레이션이 실패했다(브라우저
10개 vs cheerio 12개 — cheerio의 fallback 스캔이 브라우저 querySelector와 정확히 같은 요소 집합을
보지 못한 것으로 추정, 원인 미조사) — 안전하게 기존 방식으로 폴백해 이벤트루프 정지가 다시 발생했다.
**더 심각한 발견**: 같은 카테고리를 순수 브라우저 방식(제 변경 이전과 동일한 코드 경로)으로 완전히
동일한 조건에서 두 번 실행했는데, 결과가 실제 마지막 페이지=134(개수 6394) → 14(개수 634)로 10배
차이가 났다 — 이건 이번 최적화와 무관한, 지수+이분 탐색 알고리즘 자체가 이 몰(범위 밖 page를 요청하면
직전 유효 페이지를 그대로 반복해서 돌려주는, 버그 6~7의 그 몰)에서 실행마다 다른 결과를 낼 수 있다는
기존 정확성 문제로 보인다(타이밍/캐시 상태에 따라 clamp 감지 지점이 달라지는 것으로 추정) — **원인
조사·수정 미착수, 다음 작업 시 우선 검토 필요**.

### 버그 10 — "TODAY VIEW"(최근 본 상품)/사이트 공통 헤더의 링크가 상품처럼 잡혀 상품이 0개인 카테고리를 있는 것처럼 오판

2026-08-10 실사용 확인(seasonbag.co.kr "대량구매/제작문의", `cate_no=209`): 실제로는 배너/안내문구만
있고 상품이 하나도 없는 페이지인데, `countProductsOnPage`/`countProductsFromHtml`의 폴백 경로(`userSel`/
`platformSel`이 매칭 안 될 때 쓰는 일반 `<a><img>` 스캔)가 0이 아닌 개수를 잡아 지수+이분 탐색이 있지도
않은 "다음 페이지"를 찾아 헤매는 원인이 됐다. 실제 HTML을 직접 받아 확인한 결과:
- "TODAY VIEW"(최근 본 상품) 위젯 — 카페24 플랫폼 코어 마크업(`xans-layout-productrecent`)이며,
  로그인 세션에 따라 실제 최근 본 상품(다른 카테고리의 상품일 수 있음) 또는 미치환 템플릿 플레이스홀더
  (`<a href="/product/detail.html##param##"><img src="about:blank"/></a>`)를 보여준다 — 둘 다 이
  카테고리의 실제 상품이 아니다.
- 로고/장바구니/마이샵/상단메뉴/맨위로가기 등 사이트 공통 헤더 — 전부 `<a>`가 `<img>`를 감싸고 있어
  같은 필터를 통과한다. 실제 HTML 구조 확인: 이 요소들은 전부 `<div id="wrap">`(본문 영역) **바깥**에
  있었다 — TODAY VIEW도 마찬가지.

**수정**: 폴백 스캔을 `#contents`(카페24 표준 본문 영역 id, 있으면) 안쪽으로 제한하고, 그 id를 못 찾는
스킨이면 문서 전체를 그대로 본다(회귀 없음). 추가로 `xans-layout-productrecent` 조상을 가진 링크는
스코프와 무관하게 한 번 더 제외한다(일부 스킨은 이 위젯을 본문 안쪽에 붙이는 경우도 있어 방어적으로
유지). 검증: 실제로 받아온 HTML에 이 필터를 그대로 적용해 최종 개수가 0으로 나옴을 확인 — 이후
`perPage===0`이면 즉시 종료되므로 지수+이분 탐색 자체가 시작되지 않는다.

### 버그 11 — 가벼운 HTTP 탐색(버그 9)이 흔한 경로(위젯이 maxPage를 정확히 보여주는 몰)엔 안 쓰이고 있었음 (수정됨)

버그 9는 `findRealLastPage`(위젯을 못 믿어 지수+이분 탐색까지 가는 드문 경우)에만 가벼운 HTTP
캘리브레이션을 붙였다. 그런데 `countCategoryProductsOnce`가 **모든 카테고리마다** 거치는 흔한
검증 경로 — "마지막 페이지로" 읽은 `maxPage`가 진짜 끝인지 확인하려고 `maxPage` 페이지와
`maxPage+1` 페이지를 여는 것 — 은 여전히 항상 실제 브라우저 탭으로 열고 있었다. 사용자 재점검 요청
(2026-08-11, "카테고리가 많으면 미리보기가 느려지는데 어차피 개수만 세는 거니까 오래 걸리면 안
된다")으로 다시 확인: 카테고리가 19개면 지수+이분 탐색까지 가지 않는 정상 케이스에서도 최소
19×2회의 무거운 브라우저 탐색(`domcontentloaded` + `settleAfterNav`)이 쌓이고 있었다 — 카테고리 수가
많을 때 느려지는 주된 원인.

**수정**: `probeLightweight`를 `probeAt`(findRealLastPage 내부 클로저)에서 꺼내 top-level 함수
`probeCategoryPage(workerPage, context, firstPageUrl, pageNum, useHttp, ...)`로 분리(순수 리팩터,
`findRealLastPage`의 캘리브레이션/동작은 그대로). `countCategoryProductsOnce`는 1페이지 방문(라벨
추출 때문에 여전히 브라우저 필요) 직후 그 개수를 기준으로 자체 캘리브레이션(`probeLightweight`
1회)을 수행하고, `maxPage`/`maxPage+1` 확인 두 곳 모두 이 `useHttp` 판정으로
`probeCategoryPage`를 호출한다 — 서버가 HTML에 상품 링크를 그대로 내려주는 몰이면 카테고리 하나당
브라우저 탐색이 (라벨용) 1회로 줄고, 안 맞는 몰은 기존처럼 매번 브라우저로 처리돼 지금보다 나빠지지
않는다.

### "몰 구조 파악"이 페이지네이션 위젯 유무를 확인해 미리보기가 참조하게 함 (2026-08-11)

버그 11 수정 이후에도 위젯 자체가 아예 없는 몰(펫투비 등)은 카테고리마다
`readLastPageFromNavButton`/`readMaxPageNumber`를 매번 반복 시도해도 항상 실패할 뿐이었다 — 사용자
요청: "몰구조파악할 때 위젯이 없다는 것도 체크하게 하고, 그 결과를 미리보기가 참조하게 하라."

**수정**: `MallProfileSignals`에 `hasPaginationWidget: boolean`(신규) 추가. `sampleMallProfile`이
카테고리 목록 페이지를 방문한 김에(추가 이동 없이) 이 확인을 한 번만 하고 `sites.scrape_profile`에
저장한다(기존 저장 경로 그대로 재사용). `previewCatalog`가 `ScrapeOptions.knownNoPaginationWidget`
(신규)으로 이 신호를 받아 `countCategoryProductsOnce`에 전달하면, 위젯 확인 자체를 건너뛰고 곧장
지수+이분 탐색으로 넘어간다. `/api/scrape/preview-catalog`가 요청마다 `sites.scrape_profile`을 조회해
자동으로 실어보내므로 사용자가 따로 할 일은 없다(단, 이 필드가 없던 예전 프로파일은 "몰 구조 파악"을
한 번 다시 눌러야 채워진다). "몰 구조 파악" 결과 화면(`ScraperPanel.tsx`)에도 위젯이 없을 때만 눈에
띄는 배지로 표시.

### 버그 12 — 상품 카드 하나에 링크가 2개면 개수가 그대로 배로 부풀려짐 + `?page=N`이 아예 안 통하는 몰에서 최대 16만 배까지 폭주 (수정됨)

2026-08-12 실사용 확인: 펫투비 "사료" 카테고리가 실제로는 21개인데 32개·571개·16,363개·65,483개 등
매번 다른 틀린 값이 나왔다. 실제 계정으로 로그인해 라이브로 원인을 확인:

1. **중복 링크 미제거**: 이 몰 스킨은 상품 카드마다 `<a>`가 2개다(썸네일 링크 + 마우스오버 "빠른보기"
   오버레이 버튼 링크, 둘 다 같은 `goods_view.php?goodsno=`를 가리킴). `countProductsOnPage`/
   `countProductsFromHtml`의 `toResult`가 매칭된 href 목록을 중복 제거 없이 그대로 `list.length`로
   세고 있어서, 실제 21개가 42개로 잡혔다(직접 로그인해 확인: 두 링크 그룹 다 정확히 21개, href
   문자열까지 완전히 동일 — dedup으로 정확히 21로 수렴함을 라이브로 검증). 이건 이 몰만의 문제가
   아니라 카드에 링크가 여러 개인(썸네일+빠른보기 버튼 등 흔한 UI 패턴) 어떤 몰에서도 재현되는
   구조적 버그였다.
2. **`?page=N`이 이 몰에서는 실제로 아무 효과가 없음**: 3초 간격으로 천천히, 실제 로그인 세션으로
   `&page=3/5/8/...`을 하나씩 직접 열어봐도 전부 상품이 0개로 나왔다(속도/차단 문제가 아니라 이
   파라미터 자체가 이 몰의 실제 페이지 전환 방식이 아님 — 로그로 확인된 `.paging` 요소도 사실
   "최근본"(최근 본 상품) 위젯이었을 뿐, 상품 목록과 무관). 그런데 매 요청마다 오버레이 버튼 등
   렌더링이 미묘하게 달라 지수+이분 탐색의 반복(fingerprint) 판정이 계속 "새 페이지"로 오판해, 탐색이
   끝을 못 찾고 512·1024페이지까지 헤매다 그 지점을 "진짜 마지막 페이지"로 잘못 확정했다.

**수정**:
1. `countProductsOnPage`/`countProductsFromHtml`의 `toResult`가 href 목록을 `new Set(...)`으로
   중복 제거한 뒤 개수/fingerprint를 계산한다(두 함수 판정 기준 동일 유지 원칙 그대로).
2. `readStatedTotalCount(page, categoryLabel)`(신규) — 몰이 목록 페이지에 직접 적어둔 "총 N개"/
   "전체 N건" 문구를 읽어, 그 문구 주변 30자 안에 지금 카테고리 라벨의 마지막 구간(예: "강아지 >
   사료"의 "사료")이 같이 나오는지로 검증한다(전체 페이지에서 무작정 찾으면 무관한 배지 숫자를 잘못
   집는다 — 버그 1이 이미 겪은 실수를 반복하지 않기 위한 스코프 검증). `countCategoryProductsOnce`가
   1페이지 개수 확인 직후 이걸 최우선으로 시도해, 찾으면 그 값을 바로 총 개수로 쓰고 위젯 판독·탐색을
   전부 건너뛴다. 실사용 확인: 펫투비 "사료" 페이지에 실제로 "사료(옵션상품수 포함) 총 21개의 상품이
   준비되어 있습니다"라는 문구가 있어 정확히 매칭됨.

   **후속 수정(2026-08-12, 같은 날 재점검 중 발견)**: 처음엔 "찾은 값이 1페이지 개수(`perPage`)보다
   작으면 안 믿는다"는 조건을 추가로 걸었었다 — 그런데 `perPage` 자체가 (아래에서 설명하는 중복 링크
   문제로) 부풀려져 있으면, 정답인 `statedTotal`(21)이 부풀려진 `perPage`(31~32)보다 작다는 이유로
   정답을 스스로 찾아놓고 버려버리는 자기모순이 있었다(실사용 확인: "총 21개"를 정확히 찾았는데도
   `21 >= 31`이 거짓이라 무시되고 계속 지수+이분 탐색으로 넘어감). 카테고리 라벨 근접 검증만으로도
   오탐 방지에 충분하다고 보고 이 조건을 제거했다.
3. `findRealLastPage`의 탐색 상한을 `AUTO_PAGINATION_CAP*100`(5000페이지)에서
   `MAX_PAGE_SEARCH_BOUND = AUTO_PAGINATION_CAP*4`(200페이지, 신규 상수)로 낮췄다. 실제 확인된
   대형 카테고리(1020bag.com 5622개, ≈30페이지)도 이 값의 15% 안쪽이라 정상적인 대형 카테고리는
   여전히 넉넉하게 찾지만, 위 두 안전장치가 안 통하는 몰이라도 이제는 512·1024페이지까지 헤매다 틀린
   숫자로 확정하는 대신 훨씬 빨리 포기하고 안전한 순차 폴백으로 넘어간다.

세 수정 다 특정 몰 이름으로 예외처리한 게 아니라 범용 로직이라, 같은 유형(카드 중복 링크 / 위젯
없음 / `page=N` 무반응)의 다른 몰에도 그대로 적용된다.

### 버그 13 — 버그 12로도 못 잡는 카테고리는 여전히 최후수단 순회(최대 50페이지 실제 브라우저)까지 떨어져 틀린 개수로 확정 (수정됨)

버그 12 적용 이후에도 같은 몰(펫투비)의 다른 카테고리("미용용품", category=031003)에서 같은 유형의
증상이 재현됐다(2026-08-12, 사용자가 브라우저 주소창에 `page=14`까지 올라가는 걸 직접 보고 재보고).
로그로 원인 추적: 이 카테고리는 "총 N개" 문구가 감지되지 않았고(버그 12의 안전장치가 안 통함), 1페이지
캘리브레이션(순수 HTTP 확인)이 하필 그 순간 네트워크 오류로 실패해 `useHttp=false`로 확정됐다.
그런데 지수+이분 탐색은 자기 나름의 캘리브레이션을 별도로 다시 해서 성공했음에도 결국 끝을 못 찾고
포기했고, 그 뒤 최후수단 순차 순회로 떨어지면서 **앞서 실패했던 `useHttp=false`를 그대로 물려받아**
50페이지 전부를 실제 브라우저로 순회했다(perPage=114인데 count=462로 확정 — 틀린 값). 근본적으로는
버그 12에서 이미 확인한 것과 같은 원인: 이 몰은 `?page=N`을 붙여도 실제로 페이지가 안 넘어가는데, 매
요청마다 내용이 살짝 달라져서 "반복 감지"가 이 사실을 못 잡는다.

**수정**: 위젯을 못 찾은 카테고리는 지수+이분 탐색·최후수단 순회를 시작하기 전에, `paginationActuallyWorks()`
(신규)로 2페이지가 1페이지와 실제로 다른 상품을 보여주는지 딱 한 번만 가볍게 확인한다. 1페이지에
없던 새 상품이 하나도 없으면 "이 카테고리엔 페이지 번호가 아무 효과가 없다"고 즉시 판단해 1페이지
개수를 그대로 총 개수로 확정하고, 그 아래의 모든 탐색(위젯 재확인·지수+이분 탐색·최후수단 순회)을
전부 건너뛴다. 이 검증을 위해 `countProductsOnPage`/`countProductsFromHtml`/`probeLightweight`/
`probeCategoryPage`의 반환값에 중복 제거된 href 목록(`hrefs: string[]`)을 추가해, 두 페이지의 상품
집합을 직접 비교할 수 있게 했다(기존엔 정렬해 이어붙인 문자열 `fingerprint`만 있어 "완전히 같은지"만
비교 가능했고 "겹치는 게 있는지"는 비교할 수 없었다).

### 버그 14 — clamp 판정이 "요청과 다르면 무조건 clamp"라, 위젯이 엉뚱한 번호를 잘못 읽으면 진짜 새 페이지도 clamp로 오판 (수정됨)

2026-08-17 실사용 확인(girlsgoob.cafe24.com "여성화 > WEDGE", `cate_no=43`): 실제로는 7페이지(303개)인
카테고리가 계속 5페이지(240개)에서 멈췄다. `readMaxPageWithRetry`(위젯 늦게 뜨는 경우 재시도)와
`confirmedEnd`(끝 신호 3종 전부 재확인 — 버그 6의 clamp 판정을 count===0/fingerprint 중복과 함께
이중검증하도록 일반화)를 먼저 시도했지만 라이브 재현에서 둘 다 증상을 못 고쳤다. 디버그 로그를 임시로
심어 지수+이분 탐색의 각 probe를 직접 관찰해 원인을 확정:

```
bin-probe lo=4 hi=8 mid=6 count=48 currentPage=7 clamped=true fpMatch=false looksLikeEnd=true
```

6페이지를 요청했는데 진짜 새 상품 48개(직전 페이지와 fingerprint 다름)가 나왔는데도, 위젯이 자기
"현재 페이지"를 6이 아니라 7로 잘못 보고해(추정: 마지막 블록에서 "마지막 페이지로" 이동 링크의
목표 번호를 `readCurrentPageNumber`의 "클래스가 다수와 다른 하나" 판정이 현재 페이지로 잘못 집음)
`clamped = currentPage !== 요청` 조건에 그대로 걸려 "여기가 끝"으로 오판했다. 버그 6~7의 clamp 개념은
"범위 밖 페이지를 요청했더니 몰이 이전의 유효한(더 작은) 페이지로 되돌려준" 경우만 상정했는데, 실제
비교식은 방향을 안 가리고 있었다 — 요청보다 **큰** 번호가 나온 이번 경우까지 같은 취급을 받았다.

**수정**: clamp는 항상 "요청한 페이지보다 작은 번호로 되돌아간" 경우만 인정하도록(`currentPage < 요청`)
방향성을 추가 — 범위 밖 요청을 미래의 더 큰 페이지로 보내주는 몰은 있을 수 없으므로, 더 큰 번호가
나오면 그건 clamp가 아니라 `readCurrentPageNumber`의 오독이다. `findRealLastPage`의 지수 확장/이분
탐색/`confirmedEnd` 3곳과 `countCategoryProductsOnce`의 `maxPage+1` 확인(`afterLastClamped`) 1곳,
총 4곳 전부 동일하게 고쳤다. **검증**: cate_no=43 재실행 → 실제 마지막 페이지 7, count=303(사용자가
실제 몰에서 육안 확인한 "300여개"와 일치)로 정확해짐 — 로그도 `maxPage=null(불신) → 실제 마지막
페이지=7 → count=303`으로 확인.

### 버그 15 — 대형 카테고리 안전 상한(50페이지=2,400개)이 낮아 정말 그보다 큰 카테고리에서 조용히 잘림 + 이 상한이 실제 스크랩과도 공유됨 (수정됨)

버그 14 수정 뒤 재검증하던 중, "SOLD OUT" 카테고리가 계속 정확히 2,400개(48개×50페이지)로 멈추고
`truncated:true`("2,400개 이상")로 표시되는 걸 발견 — 사용자가 "정확히 전체 수량이 되어야만 한다"고
명확히 요구. 조사 결과 이건 버그 14와 다른 원인: `findRealLastPage`가 `MAX_PAGE_SEARCH_BOUND`(당시
200페이지) 안에서 끝을 못 찾고("탐색도 실패") `countCategoryProductsOnce`의 최후수단 직접 순회로
떨어졌는데, 그 순회 자체가 `AUTO_PAGINATION_CAP=50`페이지에서 멈추도록 만들어져 있었다 — 즉 이
카테고리는 실제로 50페이지(2,400개)보다 컸다.

**더 심각한 발견**: `AUTO_PAGINATION_CAP`은 이 미리보기 폴백 하나만 쓰는 게 아니라, `collectProductUrls`
(실제 스크랩의 목록 페이지 수집 함수)의 **기본 `maxPages` 값으로도 그대로 쓰이고 있었다**(다른 어떤
호출부도 `maxPages`를 명시적으로 넘기지 않음). 즉 이 상한은 미리보기 표시만의 문제가 아니라, **실제
스크래핑도 50페이지에서 조용히 멈춰 그 이후 상품을 전부 놓치는** 데이터 완전성 버그였다 — "실제
스크래핑은 미리보기 수량과 무관하게 끝까지 페이징한다"고 안내했던 이전 설명이 50페이지 넘는 대형
카테고리에 한해서는 틀렸던 셈이다.

**수정**: `AUTO_PAGINATION_CAP`을 50 → 1000으로 올렸다(`MAX_PAGE_SEARCH_BOUND`는 그 4배라 자동으로
200 → 4000). 이 상한이 낮게 유지돼야 했던 이유(버그 12·13 — `?page=N`이 안 통하는 몰에서 지수 탐색이
끝없이 헤맴)는 이미 `paginationActuallyWorks()`가 그런 몰을 탐색 시작 전에 걸러내므로 더 이상 유효하지
않다고 판단. 지수+이분 탐색은 O(log n)이라 상한을 올려도 정상 카테고리의 확인 속도에는 영향이 없다.
**검증**: SOLD OUT 재실행 → 로그 `maxPage=null(불신) → 실제 마지막 페이지=416 → count=19953`, 응답에
`truncated` 없음(총 1m38s) — 상한이 아니라 지수+이분 탐색이 실제 끝을 정확히 찾아낸 것으로 확인.

**개발자모드(Chrome 확장, `extension-poc/background.js`)에도 같은 유형의 문제가 별도로 있어 같이
수정**: devmode의 "스크랩 미리보기 실행"이 쓰는 `collectCategoryLinks()`가 (1) 페이지 상한 50을
그대로 갖고 있었고, (2) 실제 상세페이지를 방문·추출하는 `run()`의 세션당 처리량 제한
`MAX_PRODUCTS=300`("이 이상은 세션을 나눠서 다시 실행"이라는 별개 설계)을 개수 집계 루프에도 그대로
공유하고 있어, 개수만 세는 목적인데도 **300개(약 6~7페이지)에서 더 낮게 잘렸다** — 게다가 devmode
쪽은 `truncated` 신호 자체가 없어 잘린 값을 정확한 값처럼 보여주고 있었다(서버 쪽보다 더 나쁜
상태). **수정**: `collectCategoryLinks` 전용 상한 `MAX_PREVIEW_PAGES`를 신설해 `MAX_PRODUCTS`
공유를 끊고(개수만 세는 건 상세 추출만큼 비용이 크지 않아 `run()`의 세션-분할 제한과 성격이 다름),
페이지 상한에 걸려 멈췄을 때 `truncated: true`를 반환해 `runPreview()`가 `categoryCounts`에
같이 실어 보내도록 했다(`app/api/sites/[id]/preview-capture/route.ts`의 `CapturedCategoryCount`에도
**후속 수정(같은 날, 모자사러 실사용 확인)**: 처음엔 Node쪽(`AUTO_PAGINATION_CAP`)과 똑같이 1000으로
올렸는데, 이 확장엔 위젯 수식/지수+이분 탐색 같은 지름길이 전혀 없어 정말로 페이지마다 실제
navigate+throttle(1.2~2.4초)을 거친다 — 카테고리를 여러 개 선택해두면 그중 하나만 페이지가 많아도
체감상 "멈춘 것 같다"는 신고로 이어졌다. Node쪽과 성격이 달라 같은 숫자를 쓰면 안 된다고 판단해
150으로 다시 낮췄다(원래 문제였던 50페이지 하한 노출은 여전히 피하면서, 최악의 경우에도 카테고리
하나당 몇 분 안에는 끝나게 함).
`truncated?: boolean` 추가). 확장 버전 1.38 → 1.39.

## 카테고리 간 중복 제거 총계 확인 (2026-08-17, 신규 기능)

버그 14·15 대화 중 사용자 질문: 카테고리 목록에 "가격대별"(가로 분류)과 "여성화/남성화"(세로 분류)가
같이 있는데, 둘 다 선택하면 같은 상품이 두 번 집계돼 미리보기 총계가 부풀려지는 게 아닌지? 실제
스크랩도 같은 문제를 겪는지?

**분석**: 실제 스크랩(`collectProductUrls`)은 선택된 모든 카테고리를 하나의 공유 `Set<string>`
(`productUrlSet`)에 모아 URL 기준으로 자동 중복 제거하므로 문제없다 — 같은 상품이 몇 개 카테고리에
걸쳐 있든 정확히 1번만 스크랩된다. 반면 `previewCatalog`의 총계(`total = doneCounts.reduce((sum,c)
=> sum+c.count, 0)`)는 카테고리별로 독립적으로 구한 개수를 그냥 더한 값이라 겹치는 카테고리를 같이
선택하면 실제보다 크게 나온다(실사용 확인: 걸스굽 63개 전체 선택 시 합계 62,334 vs "전체상품보기"
9,523). 카테고리별 빠른 집계(위젯 수식/지수+이분 탐색)는 애초에 "실제 URL 목록을 안 모으고 숫자만
빠르게 구하는" 방식이라(버그 1~15에서 다져온 최적화의 핵심 전제) 카테고리 간 상품이 겹치는지 비교할
재료(실제 URL) 자체가 없다 — 정확한 중복 제거 총계를 구하려면 결국 실제 스크랩과 같은 방식(URL을
실제로 모음)을 써야 해서 그 최적화들을 못 쓰게 된다.

**설계 결정(사용자 선택)**: 세 가지 안(① 항상 정확히 자동 계산 ② 버튼으로 필요할 때만 계산 ③ 안내
문구만 추가) 중 ②를 선택 — 카테고리별 총계는 지금처럼 빠르게 두고, "중복 제거된 정확한 총 개수가
궁금할 때만" 별도 버튼으로 계산한다.

**구현**:
- `lib/scraper.ts`: `countDedupedProductUrls(opts)`(신규 export) — `withContext`로 감싸
  `collectProductUrls`를 호출하고 `urls.length`만 반환한다(상품 상세는 안 열어 실제 스크랩보다 빠름).
  `collectProductUrls`/`collectFromListing`이 기존엔 `isStopRequested(sessionId)`(DB 세션 기반, 실제
  스크랩 전용)만 봤는데, 이 신규 함수는 미리보기처럼 DB 세션이 없는 단발 요청이라 `stopSignal`
  (AbortSignal)도 같이 보는 `shouldStop()` 헬퍼로 통합했다(3곳).
- `app/api/scrape/exact-total/route.ts`(신규): 위 함수를 감싼 엔드포인트. `previewCatalog`와 같은
  패턴으로 `req.signal`을 `stopSignal`로 전달해 클라이언트가 중지(fetch abort)하면 서버 쪽 URL 수집도
  다음 페이지 전에 스스로 멈춘다.
- `components/panels/ScraperPanel.tsx`: `exactTotal`/`exactTotalLoading`/`exactTotalAbortRef`(신규).
  선택된 카테고리가 2개 이상일 때만(1개면 중복 우려 자체가 없음) "🎯 정확한 총 개수 확인(중복 제거)"
  버튼이 뜨고, 결과를 "→ 실제로는 정확히 N개(중복 제거)"로 보여준다. `handlePreview`/`handleDevPreview`가
  새로 시작될 때(스크랩 대상이 바뀔 수 있으므로) 이전 확인값을 같이 지운다.

**검증**: 걸스굽에서 겹치지 않는 두 카테고리(WEDGE 303 + 가격대별 15,000~19,900의 1,466)로 테스트 →
정확히 1,769(=단순합, 이 조합은 실제로 안 겹침)로 정상 응답. 겹침이 확실한 조합(상위 "여성화" +
그 하위 "FLAT&LOAFER", 173페이지짜리 대형 카테고리 포함)으로도 에러 없이 4.7분 만에 정상 완료됨을
로그로 확인했다 — 다만 이 두 번째 테스트는 클라이언트 쪽(curl) 타임아웃으로 실제 중복 제거 수치 자체는
받아오지 못했다(서버는 200으로 정상 완료, Set 기반 중복 제거 로직 자체는 실제 스크랩에서 이미 오래
검증된 코드라 그 결과값까지 별도로 재확인하지는 않았다).

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

## dev 서버 강제 새로고침에도 화면 상태가 덜 사라지게

미리보기 도중 dev 서버가 CPU 과부하로 불안정해지면(자동화 작업과 API가 한 프로세스를 공유하는 구조,
근본 해결은 아직 안 함) Next.js 자신의 빌드 매니페스트까지 손상되게 읽혀(`SyntaxError: Unexpected
end of JSON input`, `Error: Manifest file is empty`) Fast Refresh가 브라우저 탭을 통째로 강제
새로고침시키는 게 실사용 중 확인됐다("⚠ Fast Refresh had to perform a full reload"). 이 새로고침은
React 상태를 전부 초기화하는데, `localStorage`에 저장해두던 항목이 시작 URL/카테고리 URL 목록/
미리보기 결과뿐이라 로그인 확인 상태·발견된 카테고리 체크리스트·몰 구조 파악 결과가 사라진 것처럼
보였고, 그 사이 서버에서는 원래 요청이 계속 돌다가 몇 분 뒤 완료됐지만(`previewCatalog`는 정상
동작) 이미 새로고침된 화면은 그 결과를 받을 방법이 없었다.

- **저장 항목 확대**: `FORM_STATE_KEY`에 `loginStep`/`categories`/`categoriesCached`/`profileResult`를
  추가했다. 아이디/비밀번호는 `selectSite`가 매번 DB(`sites.login_id`/`login_pw_encrypted`)에서 다시
  채워주므로 제외했다(평문 비밀번호를 `localStorage`에 남기지 않기 위함이기도 함). `selectSite`는
  몰을 새로 고를 때 이 값들을 항상 초기화하므로(정상 동작), 복원 시 `selectSite` 완료 **이후**에
  다시 덮어써야 한다 — `openSessions`(로그인 창)는 브라우저만 새로고침됐을 뿐인 같은 서버 프로세스에
  그대로 남아있어 `loginStep` 복원이 실제 상태와 어긋나지 않는다.
- **진행 중인 미리보기 재관찰 + 결과 자동 회수**: 마운트 시 복원 대상 몰에 대해
  `GET /api/scrape/preview-progress`를 한 번 확인해, 아직 도는 실행이 있으면(`total>0`) 로딩 상태 +
  진행률을 이어서 보여준다(`resumePreviewProgressPolling`). 처음엔 새로고침으로 끊긴 요청의 최종
  결과를 이 탭이 받을 방법이 없어(원래 fetch를 기다리던 JS 컨텍스트가 없어짐) "다시 눌러달라"는
  안내만 띄웠는데, 서버가 완료된 결과를 잠시 들고 있다가 폴링하는 쪽에 그대로 내려주도록
  확장했다: `PreviewRunState.result?: CatalogPreviewResult`(신규 필드) — `previewCatalog`가 **정상
  완료**(중지/밀려남이 아닌)일 때만 `endPreviewRun`에 그 결과를 넘기고, `endPreviewRun`은 그 경우
  칸을 바로 지우지 않고 `result`를 채운 채 남겨둔다(다음 미리보기가 시작될 때 `beginPreviewRun`이
  덮어쓰며 자연히 정리되므로 별도 TTL/정리 타이머 불필요 — "로컬 단일 사용자 도구" 기준으로 감수).
  `getPreviewProgress`가 이 `result`도 함께 내려주고, 클라이언트는 폴링(또는 마운트 시 최초
  확인)에서 `result`를 받으면 `applyCatalogPreview`로 그대로 화면에 반영한다 — 새로고침 전 요청이
  실제로 완료됐다면 이제 자동으로 그 결과가 나타난다. `previewResumeNotice`(다시 눌러달라는 안내)는
  중지/밀려남/에러 등으로 **남길 결과가 없는** 경우에만 최후 수단으로 뜬다.
- 이 작업 중 기존 코드의 사각지대도 하나 발견해 같이 고쳤다: `!firstUrl || stop()`을 한 줄로 처리하던
  분기가 `stop()`으로 중단된 경우에도 `superseded` 플래그를 안 붙이고 있었다(진짜 "상품을 못 찾음"과
  같은 모양으로 나감) — 두 경우를 분리해 `stop()`이면 항상 `superseded:true`가 붙게 했다.
- `handleStopPreview`는 이제 `previewAbortRef`가 없을 때(=관찰만 하던 경우)도 폴링을 멈추고 화면을
  초기화하도록 분기 추가.

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

### 버튼을 누르면 결과가 나올 자리로 자동 스크롤 (2026-08-17)

"스크랩 미리보기"를 누르면 버튼만 보이고 아래 결과(카테고리별 개수 등)는 화면 밖이라 매번 직접
스크롤해야 한다는 요청. `handleStart`(스크래핑 시작)에 이미 있던 패턴(`progressSectionRef` +
`requestAnimationFrame(() => ref.current?.scrollIntoView({behavior:'smooth', block:'start'}))`)을
같은 방식으로 확장했다 — 상태 변경 직후 스크롤을 걸어야 방금 리렌더된 DOM(로딩 스켈레톤 포함)을
대상으로 스크롤된다.

- `previewSectionRef`: "상품 페이지 미리보기" 카드 전체(버튼 포함) — `handlePreview`/`handleDevPreview`
  시작 시.
- `profileResultRef`: `MallProfileResultDisplay`를 감싼 래퍼(일반모드/개발자모드 두 렌더 지점에 각각
  부착, 상호 배타적이라 하나의 ref 공유 가능) — `handleProfileMall` 시작 시.
- `categoryResultRef`: `categoryChecklistBox`를 감싼 래퍼(마찬가지로 두 지점 공유) — `handleLoadCategories`
  시작 시.

세 결과 컴포넌트 다 로딩 중에도 같은 모양의 스켈레톤을 먼저 그리므로(위 "결과가 나올 자리에 스켈레톤"
패턴), 클릭 즉시(응답 도착 전)에도 스크롤 대상이 이미 DOM에 존재해 바로 스크롤된다.

### 로그인 확인을 누르면 이미 보이던 몰구조분석 결과가 사라짐 (수정됨, 2026-08-17)

사용자 재현: 캐시된 몰구조분석 결과가 몰 선택 시 이미 복원돼 보이고 있었는데, "로그인 확인"을 누르면
그 내용이 사라졌다. 원인: `handleConfirmLogin`의 `setProfileResult(null)`이 몰구조분석 캐시 복원
기능(위 "선택형 레이아웃"/`selectSite`)이 생기기 전(커밋 `ca10f5d`)에 추가된 코드로, 그땐 로그인
확인마다 분석 결과를 비우는 게 맞았지만(그때는 애초에 복원해서 보여줄 캐시가 없었음) 지금은 이미
보여주고 있던 캐시 결과를 로그인 확인 한 번에 지워버리는 부작용이 됐다. **수정**: 이 리셋을 제거 —
로그인 확인은 몰 구조가 바뀌었는지와 무관한 동작이라 건드리지 않고, "몰 구조분석"을 다시 누르면 그때
새 결과로 덮어써진다.

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
  boolean`(신규 필드). (2026-08-09, 버그 5·6) `countProductsOnPage`의 반환값에 `isLoginPage`/
  `fingerprint` 추가, `findRealLastPage`가 `knownNonEmptyFingerprint` 인자 + 지수 확장 단계의
  probe+1 검증 로직을 받음, `CategoryCount.needsLogin?: boolean`(신규 필드). (2026-08-09, 버그 7)
  `readCurrentPageNumber`(신규) — 페이지네이션 위젯이 스스로 보고하는 현재 페이지 번호를 "클래스가
  다수와 다른 링크"로 찾아 읽는다. `findRealLastPage`가 `nextPageSelector` 인자를 추가로 받아 이 함수를
  fingerprint 비교보다 우선하는 clamp 판정 신호로 쓰고, `countCategoryProductsOnce`의 `maxPage+1`
  확인 지점에도 같은 방식을 적용. (2026-08-09, 버그 8) `readLastPageFromNavButton`(신규) — "마지막
  페이지로" 이동 버튼의 href에서 총 페이지수를 직접 읽어 `countCategoryProductsOnce`의 1순위 신호로
  사용(없으면 `readMaxPageNumber`로 폴백). (2026-08-10, 버그 9) `countProductsFromHtml`/
  `readCurrentPageNumberFromHtml`(신규, `cheerio` 의존성 추가) — 브라우저 없이 HTML 문자열만으로
  같은 판정을 재현. `probeLightweight`(신규) — `context.request.get()`으로 로그인 쿠키를 재사용한
  순수 HTTP GET. `findRealLastPage`가 진입 시 캘리브레이션(브라우저 확인값과 대조)해 일치하면 이후
  모든 probe를 가벼운 방식으로, 불일치/실패 시 기존 브라우저 방식으로 처리. (2026-08-10, 버그 10)
  `countProductsOnPage`/`countProductsFromHtml`의 폴백 스캔에 `#contents` 스코프 제한 +
  `xans-layout-productrecent`(TODAY VIEW) 조상 제외 추가. (2026-08-11, 버그 11) `probeCategoryPage`
  (신규, top-level로 분리) — `countCategoryProductsOnce`가 1페이지 개수로 자체 캘리브레이션 후
  `maxPage`/`maxPage+1` 확인에도 가벼운 HTTP 경로를 재사용. (2026-08-11) `MallProfileSignals.
  hasPaginationWidget`(신규) — "몰 구조 파악"이 목록 페이지 방문 김에 위젯 유무를 확인해 저장.
  `ScrapeOptions.knownNoPaginationWidget`(신규) — `previewCatalog`가 이 신호를 받아
  `countCategoryProductsOnce`의 위젯 확인 자체를 건너뛰게 함. (2026-08-12, 버그 12)
  `countProductsOnPage`/`countProductsFromHtml`의 `toResult`가 href를 `Set`으로 중복 제거.
  `readStatedTotalCount`(신규) — 몰이 직접 적어둔 "총 N개" 문구를 카테고리 라벨로 검증해 최우선
  신호로 사용. `MAX_PAGE_SEARCH_BOUND`(신규 상수, `AUTO_PAGINATION_CAP*4`=200) — 기존
  `AUTO_PAGINATION_CAP*100`(5000)이던 `findRealLastPage`의 탐색 상한을 낮춤. (2026-08-12, 버그 13)
  `countProductsOnPage`/`countProductsFromHtml`/`probeLightweight`/`probeCategoryPage`의 반환값에
  `hrefs: string[]`(신규, 중복 제거된 목록) 추가. `paginationActuallyWorks`(신규) — 위젯 못 찾은
  카테고리는 지수+이분 탐색·최후수단 순회 전에 2페이지가 1페이지와 실제로 다른 상품을 보여주는지
  먼저 확인하고, 안 그러면 곧장 1페이지 개수로 확정.
- `lib/scrape/mallProfile.ts`: (2026-08-11) `summarizeProfile`/`describeDiff`에 `hasPaginationWidget`
  반영.
- `app/api/scrape/preview-catalog/route.ts`: `previewCatalog`에 `stopSignal: req.signal` 전달.
  (2026-08-11) `sites.scrape_profile.hasPaginationWidget`을 조회해 `knownNoPaginationWidget`으로 전달.
- `app/api/scrape/preview-progress/route.ts`(신규): `GET ?siteId=` → `{done, total}` 진행률 폴링용.
- `app/api/scrape/categories/route.ts`: `sites.scrape_profile.categoryLinks` 캐시를 먼저 확인 후
  없으면 `discoverCategoryLinks`로 직접 훑고 캐시에 반영(`force=true`면 강제 새로고침) — "몰 구조
  파악"이 이미 찾아둔 목록을 "카테고리 불러오기"가 재사용.
- `components/panels/ScraperPanel.tsx`: `ScrapeStepBox` 신규 컴포넌트(`colorDone` prop 포함), 버튼
  전/후 색상, 스크랩 대상 2단 레이아웃, 카테고리 체크리스트 마스터 체크박스, 접기/펼치기 라벨 통일,
  `previewAbortRef`/`handleStopPreview`(미리보기 중지), `previewProgress`/`previewProgressPollRef`
  (진행률 폴링), `d.superseded` 체크(밀려난 응답 무시), `FORM_STATE_KEY` 저장 항목 확대
  (`loginStep`/`categories`/`categoriesCached`/`profileResult`), `resumePreviewProgressPolling`/
  `previewResumeNotice`(새로고침 후 진행 중 미리보기 재관찰).
- `components/shell/GlobalErrorNet.tsx`(신규): 지수 백오프 자동 재시도, `AbortError` 예외 처리.
- `app/layout.tsx`: `<GlobalErrorNet />` 마운트.
- (2026-08-11) `components/panels/ScraperPanel.tsx`: 로컬 `MallProfileSignals` 타입에
  `hasPaginationWidget` 추가 + 위젯 없을 때만 보이는 안내 배지.
- (2026-08-17, 버그 14) `lib/scraper.ts`의 `findRealLastPage`(지수 확장/이분 탐색/`confirmedEnd`)와
  `countCategoryProductsOnce`(`afterLastClamped`) — clamp 판정을 `currentPage !== 요청`에서
  `currentPage < 요청`(방향성 있는 비교)으로 수정.
- (2026-08-17, 버그 15) `lib/scraper.ts`: `AUTO_PAGINATION_CAP` 50 → 1000(`MAX_PAGE_SEARCH_BOUND`도
  연동해 200 → 4000) — `collectProductUrls`(실제 스크랩)의 기본 `maxPages`와 미리보기 최후수단 순회가
  이 상수를 공유하므로 둘 다 같이 늘어남. `extension-poc/background.js`: `collectCategoryLinks`가
  `MAX_PRODUCTS`(300, `run()`의 세션-분할 제한과 무관) 대신 전용 `MAX_PREVIEW_PAGES`(처음엔 1000,
  이 확장엔 Node쪽 지름길이 없어 너무 느려 같은 날 150으로 재조정 — 아래 참고)를 쓰도록 분리 + 상한에
  걸리면 `truncated: true` 반환, `runPreview()`가 `categoryCounts`에 그대로 실어 보냄.
  `app/api/sites/[id]/preview-capture/route.ts`의 `CapturedCategoryCount`에 `truncated?: boolean`
  추가. 확장 버전 1.38 → 1.39.
- (2026-08-17, 같은 날 후속) `extension-poc/background.js`: `MAX_PREVIEW_PAGES` 1000 → 150(모자사러
  실사용 확인 — 여러 카테고리 선택 시 체감상 멈춘 것처럼 보일 만큼 오래 걸림). 확장 버전 1.39 → 1.40.
- (2026-08-17) `components/panels/ScraperPanel.tsx`: `previewSectionRef`/`profileResultRef`/
  `categoryResultRef`(신규) — 미리보기/몰구조분석/카테고리 불러오기 시작 시 결과 자리로 자동 스크롤
  (`progressSectionRef`와 같은 패턴).
- (2026-08-17) `components/panels/ScraperPanel.tsx`: `handleConfirmLogin`의 `setProfileResult(null)`
  제거 — 캐시 복원된 몰구조분석 결과가 로그인 확인 한 번에 사라지던 문제 수정.
- (2026-08-17, 카테고리 간 중복 제거 총계) `lib/scraper.ts`: `countDedupedProductUrls`(신규 export),
  `collectProductUrls`/`collectFromListing`의 정지 체크를 `shouldStop()`(`isStopRequested`+`stopSignal`)
  으로 통합. `app/api/scrape/exact-total/route.ts`(신규). `components/panels/ScraperPanel.tsx`:
  `exactTotal`/`exactTotalLoading`/`exactTotalAbortRef`(신규), "🎯 정확한 총 개수 확인(중복 제거)" 버튼.

## 상태

**구현 완료.** tsc/eslint 클린. 카테고리 개수 버그(1~7)는 전부 실제 몰(seasonbag.co.kr, 1020bag.com)
재현으로 원인을 확인하고 수정했다 — 버그 7은 DB에 저장된 실제 로그인 정보로 헤드리스 브라우저를 직접
인증시켜 라이브로 재현/검증까지 마쳤다. 속도는 알고리즘(지수+이분 탐색)과 페이지 방문 1회당 고정비용
(`settleAfterNav` 타임아웃, `waitUntil`) 양쪽을 다 손봐야 했다 — 하나만 고쳤을 땐 "여전히 느리다"는
재보고가 반복됐다. "현재 페이지 가져오기"가 느리다는 문의는 실제 코드(application-code 7~74ms)가
아니라 `next dev` 개발 모드의 온디맨드 컴파일 오버헤드임을 프로덕션 빌드 비교(격리된 git worktree에서
`next build --webpack` 후 포트 비교 — 프로덕션 20~40ms vs 개발 서버 730ms~3.5s)로 확인했다(코드
수정 없음, 환경 특성). 버그 5·6은 순수 JS 시뮬레이션(클램핑 몰/정상 몰/극소 카테고리 3가지 경우)으로
알고리즘을 검증했지만, 실사용에서 버그 6 수정 이후로도 같은 몰에서 재현됐다(버그 7) — clamp된 응답의
상품 내용이 안정적이지 않다는 걸 놓쳤기 때문. 버그 7은 fingerprint가 아니라 위젯 구조 자체를 읽는
방식으로 더 근본적으로 고쳤고, DB의 실제 로그인 정보로 직접 인증해 라이브로 재현/검증까지 마쳤다.
버그 8은 "마지막 페이지로" 버튼 href를 직접 읽는 방식으로 지수+이분 탐색 자체를 대부분 우회하도록
근본적으로 고쳤고, 독립된 두 카페24 몰에서 라이브로 검증했다(seasonbag.co.kr, girlsgoob.cafe24.com).
같은 문제가 고도몰(1020bag.com, pettob.co.kr)에도 있는지 실사용 계정으로 직접 조사했고, 그 플랫폼은
애초에 이 clamp 버그가 없어(범위 밖 페이지 요청 시 정직하게 0개 반환) 코드 수정이 불필요하다는 것도
확인했다.

버그 9(가벼운 HTTP 탐색)와 버그 10(TODAY VIEW/헤더 오판 수정)은 tsc/eslint 클린, 버그 10은 실제 받아온
HTML에 필터를 직접 적용해 개수가 0으로 나오는 것까지 확인했다. 버그 9는 안전장치(캘리브레이션 실패 시
기존 방식 폴백)는 실사용 재검증으로 정상 동작을 확인했지만, **"크로스/슬링백" 카테고리 자체는 여전히
느린 브라우저 경로로 떨어져 이벤트루프 정지가 재현됐다** — 캘리브레이션이 왜 실패했는지(cheerio
fallback이 브라우저보다 2개 더 셈)는 원인 미조사 상태다. **더 중요한 미해결 이슈**: 같은 카테고리를
완전히 동일한 조건(순수 브라우저 방식)으로 두 번 실행했을 때 결과가 6394개 → 634개로 10배 달랐다 —
이건 이번 최적화와 무관한, 지수+이분 탐색 알고리즘 자체의 기존 정확성 문제(clamp 감지가 실행마다
다른 지점에서 걸리는 것으로 추정)로 보이며 원인 조사·수정에 착수하지 못했다 — 다음 작업 시 최우선
검토 대상.

버그 11(2026-08-11)은 tsc/eslint 클린. `findRealLastPage`의 기존 캘리브레이션/동작은 리팩터 전후
동일(순수 함수 추출)이라 회귀 위험이 없고, `countCategoryProductsOnce`의 신규 캘리브레이션은 실패해도
기존 브라우저 방식으로 그대로 폴백하므로 안 맞는 몰에서도 지금보다 나빠지지 않는다. 실제 카테고리가
많은 몰(펫투비 등)로 미리보기 소요 시간이 줄었는지는 다음 실사용에서 확인 예정.

몰구조파악 위젯 체크(2026-08-11)와 버그 12(2026-08-12)는 tsc/eslint 클린. 버그 12는 실제 계정으로
로그인해 펫투비에 라이브로 재현·검증했다: href 중복 제거는 진단 스크립트(플랫폼 셀렉터 없이 detail
패턴만으로 매칭)에서는 42→21로 정확히 수렴 확인, "총 N개" 문구 검증도 실제 페이지의 "사료(옵션상품수
포함) 총 21개의 상품이 준비되어 있습니다"와 정확히 매칭됨을 확인. **버그 9 문서 하단에 남겨뒀던
미해결 이슈("같은 카테고리를 완전히 동일한 조건으로 두 번 실행했는데 결과가 6394개 → 634개로 10배
달랐다")는 이번에 확인된 버그 12(중복 링크 미제거로 인한 개수 불안정 + `page=N` 무반응 몰에서의 지수
탐색 폭주)와 정확히 같은 유형의 증상이다 — 다만 seasonbag.co.kr "크로스/슬링백"에서 재현해 직접
검증하지는 않았으므로, 그 몰도 완전히 해소됐다고 확정하기보다는 다음에 그 몰을 다시 스크랩할 때 확인
예정으로 남겨둔다.

**후속 발견·수정(2026-08-12)**: 위 "총 N개" 신뢰 로직에 "1페이지 개수보다 작으면 안 믿는다"는 조건이
있어, `perPage` 자체가 부풀려진 상태에서는 정답(21)을 찾아놓고도 그 조건에 걸려 스스로 버리는
자기모순이 실사용에서 확인돼 그 조건을 제거했다(위 버그 12 "후속 수정" 절 참고) — tsc/eslint 클린.
**미해결로 남은 부분**: 실제 앱 코드의 `countProductsOnPage`가 이 카테고리에서 정확히 어느 경로로
`perPage=31~32`를 얻는지는 진단 스크립트로 재현이 안 됐다 — `platformSel`(`.item_cont a, .goods_list
a`)은 실제로는 0개 매칭(라이브 확인), detail 패턴 기반 폴백(`#contents` 없어 `document` 전체 스캔 +
img 필수)은 정확히 21로 수렴(라이브 확인)해, 둘 다 31~32를 설명하지 못한다 — 화면에 저장된 "스크랩
대상 직접지정" 커스텀 셀렉터(`userSel`)가 관여할 가능성이 있으나 확인 못함. 다만 "총 N개" 신뢰
로직이 이 계산 자체를 건너뛰게 하므로 이 카테고리에서는 실질적 영향이 없다 — "총 N개" 문구가 없는
몰에서 `perPage`가 부정확하면 여전히 문제가 될 수 있어, 다음에 그런 몰을 만나면 우선 조사 대상.

버그 13(2026-08-12)은 위에서 예상했던 "'총 N개' 문구가 없는 몰"이 바로 재현된 사례다("미용용품"
카테고리, 사용자가 브라우저에서 실시간으로 `page=14`까지 올라가는 걸 직접 보고 재보고) — tsc/eslint
클린. `paginationActuallyWorks`는 코드 리뷰 수준으로는 정확하지만(2페이지 href 집합이 1페이지와
겹치기만 하면 "페이지네이션 없음"으로 판정), 실제로 이 재발 케이스에 대해 라이브 재실행으로 개수가
정확해졌는지까지는 다음 실사용에서 확인 예정.

버그 14·15(2026-08-17)는 tsc/eslint 클린이고, 실제 계정(girlsgoob.cafe24.com)으로 두 케이스 다
라이브 재현·검증했다: cate_no=43(여성화 > WEDGE)은 240 → 303(실제 마지막 페이지 5 → 7)으로, SOLD
OUT(cate_no=45)은 2,400개 이상(50페이지 상한) → 19,953개(실제 마지막 페이지 416)로 정확해짐을
직접 확인했다. 버그 15는 특히 `AUTO_PAGINATION_CAP`이 실제 스크랩(`collectProductUrls`)의 기본
페이지 상한과 공유된다는 걸 그 과정에서 뒤늦게 발견한 것이라 — 이전에는 "실제 스크랩은 미리보기와
무관하게 끝까지 페이징한다"고 안내했었는데, 50페이지가 넘는 대형 카테고리에 한해서는 그 설명 자체가
틀렸었다. 사용자 요청으로 걸스굽의 63개 카테고리 전체를 다시 훑는 재검증도 진행했다(`categoryUrls`에 63개를
모두 실어 한 번에 요청, 총 682초) — 결과에 `truncated`/`needsLogin`이 하나도 없었고, 이전 버그의
전형적 증상이던 "서로 다른 카테고리가 정확히 같은 개수"로 나오는 패턴도 더 이상 없었다(0~19,953까지
카테고리마다 자연스럽게 다른 값). 개발자모드(Chrome 확장)의 별도 카운팅 구현(`collectCategoryLinks`)도
같은 유형의 문제가 있어 같이 고쳤지만, 이쪽은 실제 devmode 몰로 라이브 재현·검증은 하지 못했다(정적
코드 검토만). 다른 몰(고도몰류)까지 라이브로 재검증하지는 않았는데, 버그 8에서 이미 고도몰은 이번
clamp류 문제 자체가 없다는 걸 확인해뒀고(범위 밖 페이지에 정직하게 0개 반환) 이번 수정도 특정 몰
전용이 아닌 범용 로직이라 우선순위를 낮췄다 — 다음에 그 몰들을 다시 스크랩할 때 확인 예정으로 남긴다.

로그인 확인 시 몰구조분석 결과가 사라지던 문제(2026-08-17)는 원인이 되는 리셋 한 줄만 제거한
단순한 수정이라 tsc 클린 확인만 하고 별도 라이브 재검증은 하지 않았다.

카테고리 간 중복 제거 총계(2026-08-17)는 tsc 클린. 겹치지 않는 두 카테고리 조합으로 정확히 단순합이
나옴을 라이브로 확인했고, 173페이지짜리 대형 카테고리를 포함한 조합도 에러 없이(4.7분) 완료됨을
서버 로그로 확인했다 — 다만 그 두 번째 테스트는 클라이언트 타임아웃으로 실제 중복 제거 수치 자체는
못 받아왔다(중복 제거 로직인 `Set<string>`은 실제 스크랩에서 이미 오래 쓰인 코드라 별도 재확인은
생략). 실제 화면에서 버튼을 눌러본 사용자 확인은 아직 받지 못한 상태.

개발자모드 `MAX_PREVIEW_PAGES=1000`(버그 15 후속)은 실사용(모자사러, 카테고리 17개 선택)에서 바로
문제가 드러났다 — Node쪽과 달리 이 확장은 지수+이분 탐색 같은 지름길이 없어 정말로 페이지마다
실제 navigate+throttle을 거치는데, 그 상한을 Node쪽과 똑같이 1000으로 올려버려 카테고리 여러 개를
선택하면 체감상 "미리보기가 멈췄다"는 신고로 이어졌다(실제로는 멈춘 게 아니라 매우 오래 걸리는
중이었음 — 로그로 이후 preview-capture가 결국 도착한 것을 확인). 150으로 재조정하고 해당 몰의
저장된 categoryCounts/last_adjustment_preview를 지워 사용자가 깨끗한 상태로 다시 시도할 수 있게
했다. 확장은 코드만 고쳐서는 반영되지 않는다 — chrome://extensions에서 새로고침해야 새 로직이
실제로 실행된다.
