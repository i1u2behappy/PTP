# 마이그레이션2_Transform — AS-IS/TO-BE 가이드 기반 3단계 마이그레이션 — 요구사항 기록

## 배경

기존 파이프라인(스크랩 → `scrape_staging_items` 검토 → `mall_products` → `migrateToMaster()` → `product_master`)은
몰마다 형식이 다른 "기존 작업내역 완성본" 엑셀을 참고해 새로 스크랩된 상품의 값을 채워 넣는 기능이 없었다.
`마이그레이션2_Transform` 메뉴는 이 위에 값을 채워 넣는 추가 단계로, `migrateToMaster()`를 대체하지 않고 그 결과에
매핑된 컬럼만 덮어쓴다.

최초 버전(2026-07-14, 이 세션 이전)은 완성본(TO-BE) 엑셀 1개만 업로드해 `mall_products`(당시 DB에 이미 있던 값)와
매칭하는 방식이었다. 이번 세션에서 "완성본이 나온 시점의 실제 원본이 지금 DB 상태와 다를 수 있다"는 문제를 사용자가
지적하며 AS-IS 엑셀도 별도로 업로드받는 현재 구조로 재설계했다.

## 요구사항 (사용자 지시 원문 기준, 2026-07-16)

> 마이그레인션2_transform 메뉴를 '마그이그레이션'메뉴의 상단 스크랩한 내역 검색선택하는 형태와 같이 일단 만들어줘

> 이 스크랩한 데이터 조회 및 선택을 1번으로 하고, 이 아래에 2번 'AS-IS / TO-BE 샘플 가이드'를 만들어서 기존
> 별도로 만든 엑셀파일을 AS-IS, TO-BE로 각기 업로드하여, 어떻게 마이그레이션 되었는지를 보여주고, 이 마이그레이션
> 기준에 따라 상기 조회한 데이터가 마이그레이션 되도록하는 3번 '마이그레이션 진행'을 넣어줘. 즉 순차적으로
> 스크랩한 데이터를 2번의 샘플을 참고하여, 최종 3번으로 가공하겠다는 거야.

> 사용하기 좋게 잘 설계해봐

> 2번, 3번도 화면에 보여지게 해

> 2번은 샘플 가이드를 등록관리하는 기능이라서 순차없이 별도로 작업이 가능하게 바꿔

> 3번의 마이그레이션 진행 기능은 1번 raw데이터를 2번의 전환 내역을 참고하여, 각 컬럼별로 자동 마이그를 한후,
> 2차검증작업을 할 수 있게 해야해. 즉 2차 검증은 각 컬럼별로 더 세부적인 전환 가이드/기준을 다시 제시하는
> 것이고, 그에 따라서 각 로우들을 직접 '반영'버튼으로 적용할 수 있게 해. '반영' 및 뒤돌아갈 수 도 있게 '취소'
> 버튼도 같이 만들어줘

즉:

1. **1번 (스크랩한 데이터 조회 및 선택)**: 마이그레이션 화면과 동일하게 거래처/몰 드롭다운 + 조회 버튼 +
   검색 가능한 스크래핑(세션) 목록에서 세션을 골라 대상 몰/데이터를 정한다.
2. **2번 (AS-IS / TO-BE 샘플 가이드)**: 몰 단위의 등록·관리 기능 — 1번의 세션 선택과 무관하게 별도로 작업
   가능해야 한다. 기존에 별도로 만들어 둔 AS-IS(원본) 엑셀과 TO-BE(완성본) 엑셀을 각각 업로드하면, 두 파일을
   상품코드로 매칭해 "이 상품이 이렇게 마이그레이션 되었다"를 보여주고, 완성본 컬럼별로 어떤 상품마스터 필드에
   어떤 방식(AI 생성/그대로 복사/값 매핑/복합)으로 반영할지 규칙을 설정한다.
3. **3번 (마이그레이션 진행)**: 1번에서 고른 raw 데이터(세션의 미가공 상품들)에 2번의 규칙/가이드를 적용해
   컬럼별로 자동 생성한 뒤, 2차 검증(컬럼마다 어떤 기준으로 생성됐는지 다시 표시)을 거쳐 행 단위로 "반영"
   (product_master에 확정 반영) 또는 "취소"(되돌려 다시 생성 가능하게)를 선택한다.
4. 전체 단계는 순서와 무관하게 화면에 항상 보이되, 아직 진행할 수 없는 단계는 잠금 안내로 표시한다(1번을
   선택해야 하는 3번 등). 2번만은 1번 없이도 독자적으로 진행 가능해야 한다.

## 구현된 설계 결정

- **AS-IS/TO-BE 업로드 분리**: `transform_reference_uploads`에 `kind` 컬럼(`as_is`|`to_be`) 추가. 몰당 각 종류
  최신 업로드 1건만 사용(`getLatestUpload`). 업로드마다 몰상품코드 컬럼을 사용자가 확정하면(`code_column`),
  그 값으로 `transform_reference_rows.mall_product_code`를 채운다(`matchReferenceRows` — `mall_products` 매칭
  통계는 참고용으로만 유지).
- **AS-IS↔TO-BE 매칭은 코드값으로 직접**: `getGuidePairs(siteId)`가 최신 AS-IS/TO-BE 업로드의 행을
  `mall_product_code`로 조인해 쌍을 만든다 — `mall_products` DB 상태를 거치지 않는다(그 시점 DB 상태와
  완성본 작업 당시 원본이 다를 수 있다는 문제의 해결).
- **few-shot 예시 소스 변경**: `generate.ts`의 `getFewShotExamples()`가 기존 "TO-BE 매칭된 mall_products 필드"
  대신 `getGuidePairs()`의 `{asIs, toBe}` 쌍을 그대로 예시로 사용한다. AS-IS/TO-BE 쌍의 헤더명이 실제
  `mall_products` 필드명과 달라도(예: "원본상품명" vs `name_original`) Claude의 tool-call 기반 자유
  생성(`generateTransformColumns`)이 의미 기반으로 대응 — 헤더 정합성 강제는 하지 않음(v1, 필요시 보완).
- **컬럼 규칙은 TO-BE 헤더 기준**: `/api/transform/columns` GET이 `kind='to_be'` 업로드의 `column_headers`만
  사용한다(AS-IS 헤더는 규칙 대상이 아님).
- **2번의 1번-비의존성**: `TransformPanel`에서 `selectedSite`를 세션 선택(`selectSite`)뿐 아니라 2번 자체의
  몰 드롭다운(`selectSiteDirect`)으로도 설정 가능. 세션 스코프는 `''`로 초기화되어, 3번의 대상 상품 목록은
  세션 없이 몰 전체(아직 미가공) 기준으로 대체 동작한다. 두 경로 모두 같은 `selectedSite` state를 공유하므로
  이후 1번에서 세션을 고르면 정상적으로 그 세션 기준으로 갱신된다.
- **단계 상시 노출**: `StepHeader`(완료 시 초록 체크, 진행 가능 시 청록, 잠김 시 회색) + `LockedNotice`
  (회색 점선 박스, "N번에서 ~하면 진행할 수 있습니다")로 1/2/3번을 항상 렌더링하고 내부에서만 조건 분기한다.
- **2차 검증 = 컬럼 규칙 재노출 + 반영/취소**: `생성 결과 검토` 그리드의 각 컬럼 헤더 아래에 그 컬럼의 규칙
  요약(`ruleSummary()` — AI 지시문 / 복사 원본필드 / 매핑 기준 / 복합 공식)을 다시 표시한다. 행별 액션은
  "반영"(기존 "확정"과 동일한 `commitGeneratedRow` 호출)과 "취소"(새 `DELETE /api/transform/results?id=` —
  `status='draft'`인 행만 삭제, 확정된 행은 보호)로 나눈다. 취소된 행은 3번 목록에서 다시 생성 대상으로 남는다.

## 관련 파일

- `lib/db.ts`: `transform_reference_uploads`(+`kind`), `transform_reference_rows`, `transform_column_rules`,
  `transform_lookup_entries`, `transform_generated_rows`
- `lib/transform/matching.ts`: `parseReferenceWorkbook`, `guessCodeColumn`, `getLatestUpload`, `getGuidePairs`,
  `matchReferenceRows`
- `lib/transform/generate.ts`: `getFewShotExamples`(AS-IS/TO-BE 쌍 기반), `generateForProducts`,
  `commitGeneratedRow`, `ALLOWED_TARGET_FIELDS`
- `lib/ai.ts`: `generateTransformColumns` (tool-call 강제 스키마, few-shot)
- `app/api/transform/uploads/route.ts`(GET/POST, kind 필수), `uploads/[id]/route.ts`(GET/PUT/DELETE),
  `guide/route.ts`(신규 — AS-IS/TO-BE 요약 + 매칭쌍), `columns/route.ts`(TO-BE 헤더 기준),
  `columns/[id]/lookup/route.ts`, `generate/route.ts`, `results/route.ts`(GET/PUT/POST/DELETE)
- `components/panels/TransformPanel.tsx`: `StepHeader`, `LockedNotice`, `UploadCard`, `diffFields`,
  `ruleSummary` + 메인 3단계 플로우
- `components/shell/TabsContext.tsx`(`'transform'` TabType), `Sidebar.tsx`, `Workspace.tsx`(라우팅)

## 상태

**구현 완료 (2026-07-16).** 커밋: `30aaeda`(1번 세션검색 UI), `ac4ec63`(AS-IS/TO-BE 3단계 재설계),
`4bb6505`(단계 상시노출 + 2번 독립화), `4ddabad`(2차검증 컬럼가이드 + 반영/취소).

미검증: 실제 AS-IS/TO-BE 엑셀 쌍을 업로드해 매칭·생성·반영까지 end-to-end로 손으로 확인한 적은 없음
(타입체크와 dev 서버 라우트 응답만 확인). 실 데이터로 한 번 돌려보는 것을 권장.
