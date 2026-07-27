# 이미지 다운로드 파이프라인 — 추출/리사이즈 버그 수정 + 세션별 폴더 구조

## 배경

사용자가 `public/scraped/`에 받아진 이미지 파일들의 크기·해상도가 이상하다고 지적(2026-07-18). 실제
파일을 열어보니 두 가지 서로 다른 버그가 섞여 있었다:

1. **상세이미지 1장이 모든 상품에서 완전히 동일한 파일** — 걸스굽(카페24) 469개 상품 전부의 상세이미지
   중 하나가 정확히 같은 URL(`.../web/upload/appfiles/<hash>.jpg`)에서 받아진 동일 파일이었다. 카페24
   앱스토어 위젯(사이즈가이드/배송안내 배너 등)이 상세페이지 `#prdDetail` 영역 안에 몰 전체 공통으로
   심어놓은 이미지인데, 스크래퍼(`lib/extract.ts`)가 `#prdDetail img`(그 영역의 모든 `<img>`)를 통째로
   긁어와 진짜 상품 상세컷과 구분하지 못하고 있었다.
2. **진짜 상세이미지가 세로로 심하게 찌그러짐** — 원본이 국내 쇼핑몰 관행상 세로로 매우 긴 인포그래픽형
   (예: 실측 1000×19812px)인데, 리사이즈 로직(`lib/images.ts`)이 대표이미지와 똑같이 가로·세로 모두
   1200px 이내로 맞추다 보니 세로 1200에 맞추려고 가로를 47~221px까지 눌러버렸다.

이어서 사용자가 다운로드 폴더 구조도 재정의 요청(2026-07-18): "폴더 생성 기준은 '몰_스크래핑날짜_회차'로
하고, 그 하위에 'Top_img'와 'Detail_img'로 대표이미지와 상세이미지를 구분한 폴더 아래에 저장."

## 수정

### 1. 공통 배너 이미지 제외 (`lib/extract.ts`)
`#prdDetail img` 필터에 `!img.src.includes('/upload/appfiles/')` 추가. 카페24 앱스토어 위젯 리소스의
표준 URL 경로라 특정 몰 하드코딩이 아니라 카페24 공통 패턴으로 일반화됨.

### 2. 상세이미지 리사이즈를 가로만 제한 (`lib/images.ts`)
`downloadAndNormalize()`의 `sharp().resize()` 옵션을 타입별로 분리:
- `thumb`(대표이미지): 기존 그대로 `{ width: 1200, height: 1200, fit: 'inside', withoutEnlargement: true }`
- `detail`(상세이미지): `{ width: 1200, withoutEnlargement: true }` — 세로 제한 없음, 원본이 1200보다
  좁으면 리사이즈 자체를 안 함(확대 방지).

### 3. 폴더 구조: 세션 단위로 재편 (`lib/images.ts`, `lib/scrape/staging.ts`)
기존: `public/scraped/<mall_product_id>/파일명.jpg` (상품별 폴더, 대표·상세 혼재)

변경 후: `public/scraped/<몰이름>_<YYYYMMDD>_<회차>/Top_img|Detail_img/파일명.jpg`
- 폴더명은 새 `resolveScrapeFolderName(sessionId)`(`lib/images.ts`)가 계산: `scrape_sessions.created_at`으로
  날짜, "회차"는 **그 몰의 그 날짜(달력 기준) 내 몇 번째 스크랩 세션인지**(`site_id` + `created_at::date`
  조건으로 COUNT, 같은 세션이면 항상 같은 값 — 재확정해도 회차가 안 바뀜).
- `downloadProductImages()`는 이제 `sessionId`를 받아 폴더명을 내부에서 계산하고, `mallProductId` 대신
  `Top_img`/`Detail_img` 하위에 저장한다.
- **파일명 충돌 방지**: 폴더가 세션 단위로 여러 상품을 함께 담게 되면서, 예전엔 상품별 폴더라 있을 수
  없었던 "다른 상품인데 파일명이 겹쳐 덮어써지는" 위험이 새로 생겼다. `normalizeFileName()`이 상품명 앞에
  몰상품코드를 항상 붙이도록 바꿔 이 위험을 없앴다(예: `TESTFOLDER001_폴더구조_테스트_상품_대표1.jpg`).
- `mergeStagingItems()`(`lib/scrape/staging.ts`)의 `downloadProductImages()` 호출에 `row.mall_product_code`,
  `row.session_id` 추가 전달.

## 기존 데이터

사용자 지시로 `public/scraped/` 전체(걸스굽 469개 상품 폴더)와 대응하는 `product_images` 행 1842건을
전부 삭제(2026-07-18) — 옛 버그(찌그러진 상세이미지 + 공통 배너 오염)로 만들어진 파일이라 보존 가치 없음.
이 상품들은 `is_already_migrated=true` 상태라, 단순 재스크랩만으로는 이미지가 재다운로드되지 않는다 —
"이미 가공된 상품도 포함" + force로 재확정해야 새 로직으로 다시 받아진다.

## 검증

1. 리사이즈: 실제 원본(`SJ-sh750_1.jpg`, 1000×19812)을 새 로직으로 처리 → 찌그러짐 없이 1000×19812 그대로
   보존 확인(기존엔 47×1200으로 찌그러졌음).
2. 폴더 구조: 걸스굽 site_id=1에 테스트 세션/스테이징 항목을 만들어 `/api/scrape-staging/merge` 호출 →
   `public/scraped/걸스굽_20260718_1/Top_img/`, `.../Detail_img/`에 정확히 저장되고 `product_images.storage_path`도
   일치하는 것 확인 후 테스트 데이터 삭제.

`tsc --noEmit`, 변경 파일 `eslint` 통과.

## 개선 — "스크랩 Raw 확인" 그리드에 이미지 저장 폴더 "열기" 컬럼 추가 (2026-07-24)

사용자: 하단 그리드 URL 컬럼 옆에 '파일' 컬럼을 만들어, 열기를 누르면 그 상품의 대표/상세이미지가
저장된 로컬 폴더(둘의 상위 폴더)로 바로 가게 해달라는 요청.

- `lib/images.ts`에 `resolveScrapeFolderPath(sessionId)` 추가 — 기존 `downloadAndNormalize`가 쓰던 것과
  똑같은 `SAVE_ROOT + resolveScrapeFolderName(sessionId)` 조합을 그대로 노출해, 새 로직을 만들지 않고
  실제 다운로드 경로와 항상 일치하도록 했다.
- 새 라우트 `app/api/scrape/open-image-folder/route.ts`(POST `{sessionId}`): 폴더가 실제로 있는지
  확인(`fs.existsSync`) 후 `spawn('explorer', [folderPath])`로 탐색기를 띄운다. 병합 전이라 아직 이미지가
  한 장도 다운로드되지 않은 상품(폴더 자체가 없음)은 에러 메시지로 안내한다 — 이미지 다운로드가
  "스크랩 조정" 및 확정 단계(`mergeStagingItems`)에서만 일어나므로(`lib/scrape/staging.ts:170`)
  `status='pending'`인 항목은 아직 폴더가 없을 수 있다는 게 이 기능의 알려진 한계.
- `StagingItemsGrid.tsx`: "파일" 컬럼을 URL 컬럼 바로 옆에 추가(기존 저장된 컬럼 순서를 가진 사용자도
  같은 위치에 보이도록 `COL_ORDER_KEY`를 v9로 올려 리셋). 그리드가 "선택 병합"된 세션 그룹 전체를 함께
  보여줄 수 있어(`resolveSessionGroup`), 폴더 열기는 그리드에 넘어온 공통 `sessionId` prop이 아니라
  **행마다의 실제 `session_id`**를 써야 세션별로 다른 몰/날짜/회차 폴더가 섞이지 않는다 — API가 이미
  `si.*`로 `session_id`를 내려주고 있어 프런트 타입에 필드만 추가해 그대로 사용.
- 검증: `tsc --noEmit`/`eslint` 통과. DB 없이 확인 가능한 부분만 별도 테스트 — `spawn('explorer', [path])`가
  Windows에서 shell 없이도 예외 없이 실행됨을 임시 폴더로 확인(실제 탐색기 창이 뜨는지는 데스크톱 세션
  기준이라 이 환경에선 육안 확인 불가, 사용자 실사용 확인 필요).

## 개선 — 이미지 자체가 로그인 세션 없이는 안 열리는 몰 대응 (2026-07-24)

사용자: 스크랩이 몇 시간 걸려서 확정을 몰 연결 끊기기 전에 못 할 수도 있는데, 그중에는 이미지 자체가
로그인 세션이 있어야만 열리는 도매몰도 있다 — 이런 몰까지 감안해서 이미지를 나중에라도 받을 방법이
있어야 한다는 요청.

기존엔 `downloadAndNormalize`가 로그인과 무관하게 `axios.get()`으로 이미지 URL을 직접 받아왔다 — 대부분의
몰은 이미지가 공개 CDN이라 문제없지만, 이미지 자체에 로그인 세션이 필요한 몰은 이 방식으로는 항상 실패한다.

- `lib/scraper.ts`의 `withContext`(스크랩 실행이 이미 쓰던, "로그인 창이 열려있으면 재사용 → 없으면
  프로필 폴더의 저장된 쿠키로 헤드리스 재실행 → PC인증 몰은 실제 크롬 프로필 복사본" 폴백 전체)를
  export해 이미지 다운로드에도 그대로 재사용했다 — 새 로그인/쿠키 로직을 따로 만들지 않음.
- `lib/images.ts`: 기본은 그대로 `axios.get()`(빠르고 대부분의 몰에 충분). 실패한 URL만 모아뒀다가,
  `siteId`가 있으면 배치 전체에 대해 딱 한 번 `withContext`로 그 몰의 로그인 컨텍스트를 띄워
  `context.request.get(url)`로 재시도한다 — `BrowserContext.request`는 그 컨텍스트의 쿠키를 자동으로
  실어 보내는 Playwright 내장 동작이라 별도로 쿠키를 추출/주입할 필요가 없다. 로그인 창이 몇 시간 전에
  닫혔어도 프로필 폴더에 남은 쿠키가 아직 유효하면 그대로 통과한다(스크랩 자체가 이미 이 방식으로
  세션을 재사용하고 있어 같은 성격의 문제).
  성공/실패 무관하게 원래 이미지 순서(대표1/2/3...)를 그대로 유지하도록 인덱스 슬롯에 되돌려 채운다.
- `downloadProductImages`에 `siteId` 파라미터 추가(선택), 호출부 `lib/scrape/staging.ts:170`에서
  `row.site_id`를 그대로 넘긴다.
- 검증: `tsc --noEmit`/`eslint` 통과. 실제 로그인 세션이 필요한 몰로 라이브 검증은 이 환경에서 DB/브라우저
  세션에 접근할 수 없어 못 했다 — 코드 리뷰로 인덱스 보존/폴백 순서를 확인, 사용자 실사용 확인 필요.

## 관련 파일

**수정**: `lib/extract.ts`, `lib/images.ts`, `lib/scrape/staging.ts`, `lib/scraper.ts`, `components/panels/shared/StagingItemsGrid.tsx`
**신규**: `app/api/scrape/open-image-folder/route.ts`

## 상태

**완료 (2026-07-18), 파일 열기 컬럼 + 로그인 세션 필요 몰 이미지 폴백 추가 (2026-07-24, 사용자 실사용 확인 대기 중).**
