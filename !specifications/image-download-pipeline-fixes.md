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

## 관련 파일

**수정**: `lib/extract.ts`, `lib/images.ts`, `lib/scrape/staging.ts`

## 상태

**완료 (2026-07-18).**
