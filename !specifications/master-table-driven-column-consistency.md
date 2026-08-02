# 기준 마스터테이블이 다른 모든 화면의 컬럼 라벨·순서·구성의 기준이 되도록 (2026-08)

## 배경

한 세션 동안 사용자가 여러 화면(스크랩 미리보기, 스크랩 검토 그리드, 상품마스터 목록/상세, 가격 및
이익 관리, 스크랩 대상 직접지정 피커)에서 반복적으로 "라벨이 다르다", "컬럼 순서가 다르다", "컬럼
자체가 빠져 있다"고 지적했다. 매번 개별 파일을 하나씩 고쳤는데 그때마다 사용자가 다른 화면에서 또
같은 종류의 불일치를 발견하는 패턴이 반복되자, 마지막에 원칙을 명확히 확정했다:

> 기준마스터테이블은 판매관리코드관리, 카테고리매핑 등등 후속 작업의 기준테이블로서, 모두 동일한
> 기준테이블 기반으로 작업할 것이기에... 다른 메뉴에서 같은 테이블을 기준으로 데이터를 관리할 수
> 있어야해.
>
> 기준마스터테이블의 순서와 동일하게 가로로 컬럼 순서를 맞춰서 나와야 한다고. 즉 기준마스터테이블이
> 바뀌면 그에 맞춰서 다른 기준마스터테이블을 참조하는 테이블은 모두 동일하게 컬럼이 나와야 하고,
> 몰별로 별도로 컬럼을 만든 경우는 그에 따라서 더해지거나 줄어들거나 하면 돼.

즉 `master_schema_fields`(기준 마스터테이블관리, `MasterSchemaPanel.tsx`)가 **라벨·순서·컬럼 존재
여부** 전부의 단일 기준(source of truth)이고, 이를 참조하는 모든 화면은 이 등록 내용이 바뀌면 자동으로
따라가야 한다.

## 공용 메커니즘 — `useRegisteredFieldKeys` (`components/panels/shared/useRegisteredFieldKeys.ts`)

`/api/master/schema`(`ORDER BY sort_order, id`)를 조회해 아래를 반환한다 — Map/Set은 JS의 삽입 순서
보장 특성상 이 정렬 순서를 그대로 유지한다:
- `keys: Set<string>` — 등록된 전체 field_key.
- `customKeys: Set<string>` — 그중 `is_custom: true`인 것만(전용 DB 컬럼이 없어 `custom_fields` JSONB에
  저장되는 필드 — "종류" UI 표시와는 무관한, 저장 위치 구분용 내부 플래그).
- `labels: Map<string, string>` — field_key → 사용자가 실제로 지정한 field_label(사용자가 라벨을
  바꾸면 즉시 반영).

각 화면은 이 훅에서 얻은 `labels`(및 필요시 `keys`)로 자기 화면의 필드 목록/순서를 재구성한다 —
`lib/master/schema.ts`의 `FIXED_FIELD_INFO`(코드에 박힌 15개 고정 필드 기본값)는 로딩 전/미등록 시의
**폴백**일 뿐, 실제 표시값은 항상 레지스트리가 우선한다.

## 적용된 화면들

### 1. 스크랩 대상 직접지정 피커 (`lib/scraper.ts`)

라벨은 `masterLabels`(field_key→field_label), 순서는 `masterOrder`(정렬된 field_key 배열)를
`page.evaluate`로 브라우저에 함께 주입한다. `CANONICAL_FIELDS`가 `PICKER_TO_MASTER_KEY`(픽커 내부
필드명 → 마스터 field_key 매핑, 예: `price→list_price`, `thumbnail_urls→top_img`)로 대응시켜 라벨/순서
둘 다 재구성 — 대응하는 마스터 필드가 없는 것(영문상품명/상품요약정보)만 원래 순서로 맨 뒤에 남는다.
자세한 내용은 [[scrape-adjustment]] 참고.

### 2. 스크랩 미리보기 (`components/panels/ScraperPanel.tsx`)

`previewValueFor(product, sourceUrl, fieldKey, registryLabels)` 헬퍼가 각 마스터 field_key를 실제
스크랩 값으로 풀어낸다(예: `product_url`→`sourceUrl`, `master_category`→`product.category`). 표 컬럼
자체를 `masterOrderedKeys`(레지스트리 순서)로 통째로 다시 그려, 스크랩 시점엔 절대 안 채워지는 컬럼
(내부관리코드/판매관리코드/마켓별카테고리 등 후속 절차 전용)도 숨기지 않고 `-`로 비운 채 그대로
노출한다("값이 없는 컬럼은 비워둘 것"이라는 사용자 정책 그대로). 레지스트리에 없는 상품요약정보/
영문상품명은 참고용으로 뒤에 그대로 남긴다.

### 3. 스크랩 검토 그리드 (`components/panels/shared/StagingItemsGrid.tsx`)

이 그리드는 **사용자가 드래그로 컬럼 순서를 직접 커스터마이징할 수 있는 기존 기능**(`colOrder`,
localStorage에 영구 저장)이 있어, 다른 화면과 동일하게 처리할 수 없었다 — 매번 강제로 마스터 순서로
되돌리면 사용자의 개인화가 무의미해진다. 그래서:
- `COLUMN_TO_MASTER_KEY`(그리드 컬럼 키 → 마스터 field_key, 라벨 매핑에 이미 쓰던 것을 순서 매핑까지
  확장)로 대응되는 컬럼끼리만 서로 재배치하는 `reorderByMaster()`를 만들고,
- **사용자가 한 번도 순서를 바꾼 적이 없을 때(localStorage에 저장된 값이 없을 때)만** 레지스트리가
  로드되는 시점에 이 함수로 기본 순서를 한 번 맞춘다. 이미 드래그로 순서를 바꿔둔 사용자는 그 개인화를
  그대로 유지한다.
- 스크래핑 일시/URL/마이그레이션 상태 등 마스터테이블에 대응이 없는 그리드 전용 운영 컬럼은 원래
  상대 위치 그대로 둔다(매핑되지 않으므로 `reorderByMaster`가 건드리지 않음).

### 4. 상품마스터 목록 (`components/panels/MasterListPanel.tsx`)

카테고리/브랜드/제조사/원산지/가격 5종 필드(`REORDERABLE_KEYS`)만 레지스트리 순서로 재배치 —
체크박스/이미지/최종상품명(맨 앞, 항상 sticky)과 마진/재고/상태/상세보기(맨 뒤, 계산값·UI 전용)는
그리드 고유 UI라 고정 위치를 유지한다.

### 5. 상품마스터 상세 (`components/panels/MasterDetailPanel.tsx`)

기존엔 텍스트필드(TEXT_FIELDS)/숫자필드(NUMBER_FIELDS)/등록된 추가필드(extraFixedKeys)/커스텀필드
(customFieldKeys)가 각각 따로 그룹 지어 순서대로 나왔는데, 이제 전부 `orderedFieldKeys` 하나로 합쳐
레지스트리 순서 그대로 렌더링한다. 각 필드는 `TEXT_FIELD_CONFIG`(입력 형태: text/textarea/listId)에
있으면 그 설정을, 없으면 숫자/커스텀 여부에 따라 number 또는 text input으로 렌더링하고, 커스텀 필드는
`customForm`(→`custom_fields` JSONB) 상태에, 나머지는 `form`(→전용 컬럼) 상태에 바인딩한다. 등록 안 된
`other_cost`만 정렬 기준이 없어 맨 뒤로 밀린다.

서버 쪽(`app/api/master/[id]/route.ts`)도 `stock_status`/`stock_qty`/`internal_code`를 저장
화이트리스트(`ALLOWED`)에 추가하고, `custom_fields`는 통째로 덮어쓰지 않고 `COALESCE(...) ||`로
병합 저장하도록 고쳤다(스크랩 시 자동으로 채워진 다른 커스텀 값을 덮어쓰지 않기 위함).

### 6. 가격 및 이익 관리 (`components/panels/PricingManagementPanel.tsx`)

기존엔 등록 여부만 필터링(`registeredKeys.has(k)`)하고 순서는 고정 배열 그대로였다 — 필터링 후에도
레지스트리 순서로 다시 정렬하도록 추가.

## 검증

각 파일 수정 후 `npx tsc --noEmit`/`npx eslint <파일>` 통과 확인(신규 오류 없음, pre-existing 경고는
`git stash` 비교로 매번 사전 확인). 실제 화면 스크린샷으로 순서/라벨 일치 여부는 사용자가 직접 확인.

## 관련 파일

**수정**: `lib/scraper.ts`, `components/panels/ScraperPanel.tsx`,
`components/panels/shared/StagingItemsGrid.tsx`, `components/panels/MasterListPanel.tsx`,
`components/panels/MasterDetailPanel.tsx`, `components/panels/PricingManagementPanel.tsx`,
`app/api/master/[id]/route.ts`

## 상태

**완료 (2026-08).**
