# 판매관리코드 관리 — 순차 스텝 레시피로 재설계

## 배경

기존 `SalesCodePanel`은 "거래처 코드 앞 2자리 + 몰 상품코드"라는 단일 하드코딩 공식뿐이었다. 사용자
요구사항: 스크래핑한 데이터를 불러와 원하는 컬럼을 골라 값 변경/조합/AI 생성 등을 원하는 순서로 자유롭게
적용할 수 있어야 하고, 같은 몰×거래처 조합은 다음에도 같은 절차를 그대로 재사용해야 한다.

## 설계 — 참고한 유사 사례

Power Query의 "적용된 단계"(순서대로 쌓이는 편집 가능한 단계 목록, 새로고침 시 그대로 재적용)와
OpenRefine의 "조작 이력 추출/적용"(단계들을 저장해 다른 데이터셋에 재적용) — 둘 다 "순차 단계 + 저장해서
재사용" 패턴의 실제 검증된 사례라 이 설계의 뼈대로 삼았다.

기존 마이그레이션2_Transform의 규칙엔진(`ai`/`lookup`/`copy`/`composite`)은 "TO-BE 컬럼별로 독립된 규칙
여러 개(병렬)"라 이번 요구사항(한 값을 순서대로 가공, 직렬)과는 안 맞아 재사용하지 않고, 대신 **몰×거래처
조합 하나당 순차 스텝 배열**을 저장하는 새 구조로 만들었다.

## 구현

- **DB**: `sales_code_recipes(site_id, client_id, steps JSONB, UNIQUE(site_id, client_id))` — `steps`는
  순서 있는 배열, 각 항목은 `{ mode: 'rename'|'combine'|'ai', ... }`.
- **엔진**(`lib/salesCode/generate.ts`, `runRecipe()`): 단계별 스텝 모드
  - `rename`: 원본값 A → B 값 변경(표에 없는 값은 그대로 통과)
  - `combine`: `{_prev}-{brand}` 같은 템플릿 문자열(`_prev`=이전 단계 결과, 그 외는 원본 필드명)
  - `ai`: 기존 Transform이 쓰던 `generateTransformColumns()`(Anthropic tool-call) 재사용, 원본 필드 +
    `_prev`를 참고 자료로 전달
  - 각 스텝의 `sourceField`를 비워두면 자동으로 `_prev`(직전 결과)를 입력으로 쓴다 — 첫 단계뿐 아니라
    모든 단계가 "원본 컬럼에서 새로 시작"과 "이전 결과 이어받기"를 자유롭게 고를 수 있음.
- **API**: `GET/PUT /api/sales-code/recipe?siteId=&clientId=`(레시피 조회/저장),
  `POST /api/sales-code/preview`(선택한 상품들에 레시피를 적용해 draft 코드 생성, 아직 저장 안 함).
- 원본 소스 필드(`SOURCE_FIELD_OPTIONS`)는 `lib/transform/generate.ts`의 `SOURCE_FIELD_KEYS`/
  `buildSourceFields()`를 export해 재사용 — mall_products 원본 컬럼 목록을 두 곳에서 따로 관리하지 않음.

## UI — 세 번 반복해서 다듬음

1. **1차**: 그리드(상품명/몰상품코드/미리보기/판매관리코드) 위에 별도 "생성 단계" 카드를 얹은 형태로
   구현. 사용자 피드백: "레시피 적용 미리보기 기능과 우측 생성단계가 어떻게 쓰는지 모르겠다."
2. **2차 재설계**: 그리드가 몰의 **기본 스크래핑 컬럼**(상품명/가격/브랜드/제조사/원산지/카테고리/재고
   상태 등)을 그대로 보여주도록 데이터 소스를 `/api/master?sessionId=`(마이그레이션된 값)에서
   `/api/scrape-staging?sessionId=`(원본 스크래핑 값, mp_* 필드)로 바꿨다 — 엔진이 실제로 읽는 테이블
   (`mall_products`)과 그리드에 보이는 값이 항상 일치하게(WYSIWYG) 하기 위함. 컬럼 헤더 클릭 →
   `selectedColumn` 지정 → 우측 "생성 단계" 패널의 "+ 단계 추가" 버튼이 그 컬럼을 자동으로 채운 스텝을
   생성. 우측 패널은 판매관리코드관리 자체 특성상(그리드=상품 데이터, 패널=레시피라는 서로 다른 두
   개체) 그리드+사이드패널 분리를 유지.
3. 이후 세부 조정: "스크래핑 목록" 접기/펼치기 버튼을 `ScrapeScopePicker`(마이그레이션 하위 메뉴 공용
   컴포넌트)의 스크래핑 목록 바에서 상단 거래처/몰 선택 줄 우측 끝으로 이동 — `ProductsListPanel`에
   이미 있던 "버튼은 항상 같은 자리 고정" 패턴을 그대로 따름. 공용 컴포넌트라 이 메뉴 하나가 아니라
   `ScrapeScopePicker`를 쓰는 모든 마이그레이션 하위 메뉴에 함께 적용됨.

## 검증

`tsc --noEmit`/`eslint` 통과. 실제 시즌백 몰 데이터(session 68, mall_category="백팩", brand="BANGE"/
"자체브랜드")로 값변경("백팩"→"BAG")→조합(`{_prev}-{brand}`) 2단계 레시피를 저장·미리보기까지 실행해
`"BAG-BANGE"`, `"BAG-자체브랜드"`가 정확히 나오는 것 API 레벨로 확인 후 테스트 데이터 삭제.

## 알려진 제약

AI 스텝은 Transform과 동일하게 상품 1건당 1회 호출이라 대량 배치엔 느리다 — 기존 방식과의 일관성을
택했고, 실사용에서 느리면 배치 호출로 바꾸면 됨(아직 필요성 확인 안 됨, 미착수).

## 관련 파일

**신규**: `lib/salesCode/generate.ts`, `app/api/sales-code/recipe/route.ts`, `app/api/sales-code/preview/route.ts`

**수정**: `components/panels/SalesCodePanel.tsx`, `components/panels/shared/ScrapeScopePicker.tsx`,
`lib/db.ts`(`sales_code_recipes` 테이블), `lib/transform/generate.ts`(`buildSourceFields`/`MallProductRow` export)

## 상태

**완료 (2026-08).**
