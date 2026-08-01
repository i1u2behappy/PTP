# 마이그레이션 하위 메뉴 — "기준 Master 테이블 관리" 신설

## 배경 / 요구사항 (사용자 지시 원문 기준, 2026-07-18)

> 마이그레이션 하위 메뉴 첫번째에 '기준 Master 테이블 관리' 메뉴를 하나 만들어. 이 메뉴는 '기준 마스터
> 샘플 파일'을 내가 기초로 등록을 할 거야. 이 기준 마스터 테이블의 컬럼들을 내가 1차적으로 작성 작업을
> 할 것이고, 각 컬럼별 마이그 기준을 설정할 수 있게 메뉴를 만들어줘

AskUserQuestion으로 "각 컬럼별 마이그 기준 설정"의 범위를 확인: **스키마(컬럼 목록) 관리만 이 화면이
담당** — 컬럼별 실제 마이그레이션 방식(AI 생성/값 매핑/그대로 복사/합성)은 몰마다 원본 데이터가 달라
기존 마이그레이션2_Transform에서 몰을 고른 뒤 설정하고, 이 화면에는 그리로 가는 링크만 둔다(추천안 채택).

기존에 "기준 Master DB" 스키마 관리(엑셀 업로드 → 헤더 자동매칭 → 편집 → 저장)는 이미 구현돼 있었지만
`ClientDetailPanel`(거래처 상세) 안의 카드 하나로만 존재해 마이그레이션 메뉴 흐름과 분리돼 있었다. 이번
작업은 그 기능을 마이그레이션 메뉴의 첫 번째 진입점으로 승격한 것 — 백엔드(`/api/master/schema`,
`/api/master/schema/upload`, `lib/master/schema.ts`)는 전부 기존 그대로 재사용, 신규 백엔드 코드 없음.

## 구현

- 새 탭 타입 `'master-schema'`(`components/shell/TabsContext.tsx`), `Workspace.tsx`에 라우팅 추가.
- 새 컴포넌트 `components/panels/MasterSchemaPanel.tsx` — 거래처 선택 → 엑셀 업로드/필드 목록 편집(라벨/
  필드키/고정·커스텀/삭제)/저장. `ClientDetailPanel.tsx`에 있던 것과 동일한 UI·핸들러를 이 화면으로 이전.
  하단에 "마이그레이션2_Transform에서 설정하기" 링크(클릭 시 `clientId`를 params로 넘겨 Transform의
  거래처 필터를 미리 채움 — `TransformPanel`이 `params?.clientId`를 받도록 소폭 확장).
- `ClientDetailPanel.tsx`의 "기준 Master DB" 카드 제거, 대신 이 새 메뉴로 이동하는 링크 버튼으로 교체
  (같은 로직을 두 곳에 중복 유지하지 않기 위함).
- `Sidebar.tsx`: 마이그레이션 NavGroup의 **첫 번째** 하위 항목으로 추가(판매관리코드 관리보다 위).
  같은 파일에서, 이전부터 있던 마이그레이션 NavGroup 자체의 폰트 크기 불일치(다른 하위 메뉴는 `text-sm`인데
  그룹 라벨만 `text-xs`)도 함께 수정(`text-sm`으로 통일) — 사용자가 "마이그레이션 메뉴바의 폰트가 작다"고
  지적한 별개 요청.

## 엣지 케이스

동일 클라이언트-스키마-Transform 연동의 엣지 케이스는 기존 [[custom-fields-transform-bulk-reapply]] 문서
참고(이번 작업은 새 화면만 추가했을 뿐 그 뒤 로직은 손대지 않음).

## 검증

`tsc --noEmit`, 변경 파일 `eslint` 통과(이 새 파일의 `useEffect(() => { loadFields() }, [loadFields])`
패턴은 `SalesCodePanel.tsx` 등 다른 마이그레이션 하위 메뉴와 동일하게 이미 존재하는 pre-existing
`set-state-in-effect` lint 패턴 — 이번에 새로 만든 문제가 아니라 기존 코드 스타일을 그대로 따른 것).
`/api/master/schema?clientId=` 실제 호출로 응답 확인.

## 관련 파일

**신규**: `components/panels/MasterSchemaPanel.tsx`

**수정**: `components/shell/TabsContext.tsx`, `components/shell/Workspace.tsx`, `components/shell/Sidebar.tsx`,
`components/panels/ClientDetailPanel.tsx`, `components/panels/TransformPanel.tsx`

## 상태

**완료 (2026-07-18).**

---

## 2026-08 재설계 — "거래처별"이 아니라 시스템 전체 단일 기준 테이블로 전환

### 배경

> 기준 마스트테이블은 기준테이블로서, 거래처별로 따로 가져가지 않을거야.

기존엔 `client_master_schema_fields(client_id, field_key, field_label, is_custom, sort_order)`로 거래처마다
독립된 스키마를 가졌다. 사용자 지시로 **거래처 구분을 완전히 없애고 시스템 전체가 공유하는 단일 테이블**로
바꿨다 — DB 테이블을 `master_schema_fields`(client_id 컬럼 없음, `UNIQUE(field_key)`)로 교체(예전 테이블은
비어 있어 데이터 이관 없이 `DROP TABLE IF EXISTS` 후 재생성, `lib/db.ts`).

### 하위 메뉴 정합성 정리

> 기준마스터테이블은 판매관리코드관리, 카테고리매핑 등등 후속 작업의 기준테이블로서, 모두 동일한
> 기준테이블 기반으로 작업할 것이기에 이렇게 마이그레이션 하위 메뉴들의 프로세스와 기본 테이블을 정리해

전체 마이그레이션 하위메뉴를 감사(`관리코드 생성`/`상품명 관리`/`옵션 관리`/`이미지 편집`/`이미지 호스팅
관리`는 단일 전용 컬럼이거나 별도 테이블이라 기준 테이블과 무관 — 손대지 않음)한 결과, 실제로 어긋나 있던
3곳만 고쳤다:

- **`lib/transform/generate.ts`**: `getAllowedTargetFields(clientId)` → `getAllowedTargetFields()`(무인자,
  전역 조회)로 변경. `commitGeneratedRow()`의 커스텀필드 조회도 동일하게 client_id 제거.
- **`app/api/transform/columns/route.ts`**: site→client 역조회(`getClientIdForSite`)가 필요 없어져 제거.
- **`components/panels/shared/useRegisteredFieldKeys.ts`**(신규 공용 훅): `/api/master/schema`를 읽어
  현재 등록된 field_key `Set`을 반환. `BrandOriginPanel.tsx`(브랜드/제조사/원산지 탭)과
  `PricingManagementPanel.tsx`(가격 컬럼)이 이 훅으로 필터링해, 기준 테이블에서 뺀 컬럼은 그 메뉴에서도
  자동으로 사라지게 했다. `TransformPanel.tsx`의 타겟필드 15개 하드코딩 목록도 `FIXED_FIELD_INFO` import로
  교체해 라벨 드리프트를 없앴다.
- `app/api/master/field-values/route.ts`의 `ALLOWED_FIELDS`(brand/master_category/manufacturer/origin)는
  SQL에 컬럼명을 직접 끼워 넣어 **일부러 하드코딩된 보안 화이트리스트**라 DB 기반으로 바꾸지 않았다 —
  대신 그 화이트리스트 중 기준 테이블에 실제 등록된 것만 화면에 노출하는 방식으로 처리(위 두 패널).
- 판매관리코드 관리/Transform의 "소스 필드"(스크래핑 원본 컬럼 목록)는 기준 테이블과 별개 개념(스크래핑에
  뭐가 있는지 vs 기준 테이블에 뭘 채울지)이라 그대로 뒀다.

### 스크래핑 매칭 감사 중 발견한 실제 버그 — `lib/master/migrate.ts`

기준 테이블 컬럼별로 "스크래핑 시 자동 매칭되는지" 점검하다가 실제 데이터 버그 두 개를 발견해 함께 고쳤고,
둘 다 임시 테스트 행으로 실제 이관을 돌려 검증했다:

1. **정상가(list_price)가 판매가(sale_price)와 같은 값으로 채워지던 버그.** `salePrice` 변수 하나를
   `sale_price`/`list_price` 두 컬럼에 그대로 재사용하고 있었다(할인 없는 상품은 두 값이 같아 안 드러남).
   `listPrice = mp.price ?? mp.sale_price`(몰의 소비자판가)로 분리.
2. **"상세설명"이 실제 상세페이지 본문이 아니라 SEO 문구로 채워지던 문제.** `mall_products.description`은
   `lib/extract.ts`에서 JSON-LD description이 없으면 `og:description`/`<meta name="description">`까지
   폴백한 값이라 몰에 따라 SEO 키워드 나열에 가까웠다. 실제 상세페이지 텍스트는 이미 `detailText`로
   추출되고 있었지만(`lib/extract.ts`) `mall_products.raw_data.detail_text`에만 저장되고 아무 컬럼에도
   승격되지 않아 버려지고 있었다 — `migrateToMaster()`가 `raw_data.detail_text`를 `mp.description`보다
   우선 쓰도록 수정(본문 없는 몰은 예전처럼 SEO 문구로 폴백).
   - **알려진 한계**: 상세설명이 전부 이미지로만 된 몰(예: 시즌백)은 `detailText` 추출기가 실제 본문 대신
     "PRODUCT DETAIL WITH ITEM SHOPPING GUIDE Q&A" 같은 탭 제목 UI 텍스트를 대신 주워온다 — 이건 몰별
     추출 정확도 문제라 이번 작업 범위 밖으로 남겨둠(신우 등 실제 텍스트 본문이 있는 몰에서는 정상 동작
     확인).

`lib/master/schema.ts`의 `FIXED_FIELD_INFO`(15개 고정 필드 + `mallSource`)에 위 내용을 반영: `list_price`
→ `mallSource: 'price'`(이전엔 null), `cost_price`/`shipping_fee`는 `mall_products` 정식 컬럼이 아니라
raw_data 안에 몰에 따라 있을 수도 없을 수도 있는 값이라는 주석 추가.

### UI 재설계

`MasterSchemaPanel.tsx`를 컬럼 목록 하나만 다루는 **단일 통합 그리드**로 다시 짰다(판매관리코드 관리의
그리드+우측패널 분리 대신 — 다루는 개체가 필드 목록 하나뿐이라 분리가 오히려 같은 걸 두 번 보여주는
셈이라 판단):

- **📋 기본 컬럼 전체 추가** 버튼 — `FIXED_FIELD_INFO` 15개를 한 번에 씨드. 로그온 시 `lib/db.ts`가
  `master_schema_fields`가 비어 있으면 이 15개를 자동으로 미리 채워둬(그리드가 빈 화면으로 안 열리게).
- 각 필드 행에 **스크래핑 매칭 배지**(초록 "자동 매칭 · mall_products.X" / 주황 "스크래핑에 없음·직접
  입력 필요")로 후속 절차가 필요한 컬럼을 바로 보여줌.
- **드래그앤드롭 순서 변경** — 이 앱에 이미 있던 네이티브 HTML5 DnD 패턴(`StagingItemsGrid.tsx`의 컬럼
  순서변경과 동일 — 새 라이브러리 추가 없음) 재사용. 처음엔 행 React `key`를 드래그 식별자로 쓰던
  `field_key` 그대로 썼다가, 커스텀 필드 키 입력창에 한 글자 칠 때마다 그 값이 바뀌어 행이 통째로
  리마운트되며 입력 포커스가 날아가는 버그가 생겨(사용자 신고로 발견) `key`는 배열 인덱스로 되돌리고
  드래그 식별자(`dragKey`)만 field_key를 씀 — 이 둘을 반드시 분리해야 함.
  - 커스텀 필드 추가 시 방금 추가한 행으로 자동 스크롤(`scrollIntoView`, ref+effect).
  - 그리드 자체(표 헤더 아래)만 내부 스크롤되도록 `flex-1 min-h-0 overflow-auto` + `sticky` 헤더 적용,
    페이지 전체가 늘어나지 않게 함.
- **엑셀 업로드-추측 기능(`/api/master/schema/upload`, `guessFixedFieldMapping`) 통째로 제거** — 전역
  단일 테이블이 되면서 "기본 컬럼 전체 추가" + "커스텀 필드 추가"만으로 충분해져 중복이라는 사용자
  지적으로 백엔드 라우트까지 함께 삭제(다른 곳에서 쓰는 곳 없음 확인 후).

### admin 전용화

> 기준 마스터테이블관리 메뉴는 'admin' 계정만 볼 수 있게

3중으로 처리: `Sidebar.tsx`에서 `useCurrentUser().isAdmin`이 아니면 메뉴 자체를 안 보여줌 → 이미 열려있던
탭 대비 `MasterSchemaPanel.tsx`도 `isAdmin` 아니면 "관리자만 접근 가능" 안내만 표시 → **실제 차단은**
`/api/master/schema` **PUT**이 `isAdminRequest()`로 403 (다른 admin 전용 기능과 같은 패턴,
`lib/auth.ts`/`app/api/clients/[id]/route.ts` 참고). GET은 admin 제한 없음 — `useRegisteredFieldKeys`로
이 목록을 읽는 다른 admin-비전용 메뉴(브랜드·제조사·원산지 관리 등)가 계속 동작해야 하기 때문. 임시
테스트 계정으로 일반 계정은 조회 가능/저장 시 403 확인 후 계정 삭제.

### 검증

`tsc --noEmit`/전체 `eslint` 통과(제 변경으로 인한 새 오류 없음). `migrateToMaster` 가격 분리·상세설명
수정은 임시 mall_products/product_master 행으로 실제 이관을 돌려 결과값 확인 후 삭제. admin 전용화는
임시 비-admin 계정으로 GET 200/PUT 403 확인 후 계정 삭제.

### 관련 파일

**신규**: `components/panels/shared/useRegisteredFieldKeys.ts`

**수정**: `lib/db.ts`, `lib/master/schema.ts`, `lib/master/migrate.ts`, `lib/transform/generate.ts`,
`components/panels/MasterSchemaPanel.tsx`, `components/panels/BrandOriginPanel.tsx`,
`components/panels/PricingManagementPanel.tsx`, `components/panels/TransformPanel.tsx`,
`components/shell/Sidebar.tsx`, `components/shell/Workspace.tsx`, `components/panels/ClientDetailPanel.tsx`,
`app/api/master/schema/route.ts`, `app/api/transform/columns/route.ts`

**삭제**: `app/api/master/schema/upload/route.ts`

### 상태

**완료 (2026-08).**
