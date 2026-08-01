# 쿠팡 카테고리별 옵션·고시정보 슬롯 매핑

## 배경

목표: 스크래핑한 데이터를 특정 엑셀 양식(쿠팡 대량등록)으로 마이그레이션. 기존
`!specifications/marketplace-formats/coupang.md`에 실제 쿠팡 Wing 양식 분석이 이미 있었다 — 핵심은
컬럼 구조(117~125개, 3단 헤더, 대분류별 시트)는 고정이지만, **구매옵션(옵션유형1~6)/검색옵션(옵션유형
1~20)/고시정보(값1~14) 슬롯의 실제 의미는 카테고리마다 완전히 다르다**는 점 — 따라서 "몰 하나당 매핑
하나"가 아니라 **"쿠팡 카테고리 하나당 매핑 하나"**가 맞는 재사용 단위(같은 카테고리면 몰이 달라도
매핑을 그대로 씀).

실제 데이터 확인 결과 스크래핑 중인 3개 몰(시즌백/걸스굽/펫투비)의 카테고리(백팩/슬링백/ACC&사은품/
강아지간식)는 `coupang.md`의 예시 데이터(우산/초콜릿/이어폰)와 하나도 안 겹쳐, 슬롯 라벨을 그대로
가져다 쓸 수 없었다. 라벨은 실제 쿠팡 Wing에서 카테고리를 선택했을 때 동적으로 뜨는 값이라 추측하면
등록 시 검증 실패 위험이 있어, **구조만 먼저 만들고 실제 라벨은 사용자가 나중에 직접 확인해서 채우는**
방식으로 결정(사용자 확인).

## 구현 — 새 테이블 없이 기존 컬럼 재사용

- `category_channel_mappings(master_category, marketplace_code, channel_category_value)` — 이미 있던
  "카테고리 매핑" 화면(몰 카테고리 ↔ 마켓별 채널 카테고리값)을 그대로 씀. 여기서 마켓='coupang'으로
  입력해둔 채널 카테고리값이 아래 프로필의 키가 된다.
- `marketplace_configs.template_mapping JSONB` — 이미 테이블에 있었지만 아무도 안 쓰던 빈 컬럼을
  재사용. `{ categoryProfiles: { "<채널 카테고리값>": { sheetName, hasFashionExtraColumns,
  purchaseOptions[6], searchOptions[20], noticeInfo: { categoryValue, fields[14] } } } }` 구조로 저장.
- **API**: `GET/PUT /api/marketplace-configs/coupang/category-profile?category=`.
- **UI**: `CategoryMappingPanel.tsx`의 카테고리 매핑 그리드에서, 마켓='coupang' 열에 값이 채워진 셀마다
  🎛️ 버튼이 뜨고, 누르면 `CoupangCategoryProfileEditor.tsx` 모달이 열려 구매옵션/검색옵션/고시정보 슬롯
  라벨 + 매핑 대상 필드(자유 텍스트, product_master 필드명 또는 커스텀필드 키)를 편집한다. 라벨/필드는
  전부 빈 값으로 시작 — 실제 값은 사용자가 쿠팡 Wing에서 확인 후 입력.

## 의도적으로 안 한 것

- 5개 실제 카테고리에 미리 값을 채워 넣지 않음 — 실제 쿠팡 소분류명/슬롯 라벨을 모르는 상태에서 채우면
  추측 데이터가 됨. 기존 카테고리 매핑 그리드에 이 카테고리들이 이미 뜨니, 실제 쿠팡 카테고리명을
  확인하면 그 자리에 입력 → 🎛️로 슬롯 채우는 순서로 사용.
- `lib/excel/coupang.ts`(실제 파일 생성 로직, 현재 20컬럼 placeholder)는 아직 안 건드림 — 라벨이 다
  채워진 다음 단계. 이번 작업은 매핑 구조까지만.

## 검증

`tsc --noEmit`/`eslint` 통과. `/api/marketplace-configs/coupang/category-profile` GET(기본 골격:
purchaseOptions 6개/searchOptions 20개/noticeInfo.fields 14개 빈 슬롯)·PUT 왕복을 실제 로그인 세션으로
확인(테스트 카테고리키로 저장 후 삭제). 최초 시도에서 curl `-d` 셸 인코딩 문제로 한글이 깨져 보였으나
UTF-8 파일 기반 요청으로 재확인해 실제 저장은 정상임을 검증.

## 관련 파일

**신규**: `app/api/marketplace-configs/[code]/category-profile/route.ts`,
`components/panels/shared/CoupangCategoryProfileEditor.tsx`

**수정**: `components/panels/CategoryMappingPanel.tsx`

## 상태

**구조 완료, 실데이터 라벨 입력 대기 (2026-08).**
