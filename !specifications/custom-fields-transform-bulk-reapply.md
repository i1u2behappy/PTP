# 거래처별 커스텀 필드 + Transform 일괄적용 + 연속관리 연동 — 요구사항 기록

## 배경 / 요구사항 (사용자 지시 원문 기준, 2026-07-18)

> 다시 마이그레이션 방법을 정리해야겠어. 스크랩을 한 후, 내가 몰의 필요한 데이터들이 다 들어왔는지 검수
> 후 확정을 지으면, 이 데이터를 기반으로 '마이그레이션'을 진행할 수 있는거야. 마이그레이션은 무엇보다
> '기준 Master DB'를 내가 엑셀파일로 등록해 줄거야. 그 기반으로 '기준 Master DB' 테이블을 만들어. 그 이후
> 각 하위메뉴들의 '기존 Master DB'를 기반으로 각기 마이그레이션 작업을 관련한 컬럼들 기준으로 스크래핑한
> 컬럼을 거래처가 원하는 형태로 마이그레이션 기준을 만들어 정의하고, 다음 번 스크랩 데이터도 같은 기준으로
> 컬럼 데이터를 마이그레이션 하는 기능이야. 즉, 각 마이그레이션 기능의 컬럼별 마이그레이션 형태를 설정하고,
> 수정하고, 편집 반영할 수 있는 기능 및 일괄적용 기능 등이 필요하니까. 이러한 사항을 잘 처리할 수 있는
> 사례나 관련 UI/UX가 외부 레퍼런스로 있다면 참고하여서 개발해봐

조사 결과 이미 마이그레이션2_Transform이 컬럼별 규칙 엔진(AI생성/값매핑/그대로복사/합성,
`transform_column_rules`)을 갖고 있었지만 두 gap이 있었음: (1) 생성된 값을 한 행씩만 "반영"할 수 있고
일괄적용이 없음, (2) 이 규칙이 마이그레이션3_연속관리(재스크랩 변동분 재마이그레이션)와 전혀 연동되지
않아 "다음 스크랩도 같은 기준으로"가 실제로는 안 됨. 또한 `product_master`의 컬럼이 앱 전체에 고정돼
있어 거래처마다 다른 커스텀 필드(예: "해외배송여부", "시즌코드")를 표현할 방법이 없었음.

## 확정된 방향 (AskUserQuestion 3개로 확인, 2026-07-18)

1. **거래처별 완전 커스텀 컬럼까지 지원** (상품마스터 고정 컬럼 매핑 정도로는 부족하다고 판단).
2. **우선 Transform 보완 + 연속관리 연동부터** — 판매관리코드/브랜드/옵션/가격 등 다른 하위메뉴 통합은
   이번 범위 아님(이후 단계로 명시적으로 미룸).
3. **재적용 시점은 사람이 확인 후 버튼을 눌러야 자동 적용** — 스크랩 완료 즉시 무인 자동 적용 아님. 기존
   연속관리의 "변동 감지 → 확인 → 재마이그레이션" 흐름을 그대로 유지하되, 그 클릭이 Transform 규칙까지
   함께 트리거한다.

## 외부 레퍼런스 조사 (Agent 리서치 기반)

- **Akeneo PIM**: 공급사 헤더→표준 속성 매핑을 "공급사별 재사용 프로필"로 저장, 향후 임포트마다 자동
  재적용. "미매핑만 보기" 필터로 스키마 변경 후 델타만 사람이 확인. → 이번 기능의 "기준 Master DB 필드
  목록은 client별로 저장, 업로드 시 헤더 자동 매칭 초안" 설계에 반영.
- **Fivetran**: 스키마 드리프트를 조용히 흘려보내지 않고 승인 게이트로 표시 — 이미 Transform의
  `orphanedRules` 경고(TO-BE 헤더 변경 시)로 구현돼 있어 그대로 유지, 커스텀 필드 스키마에도 같은 원칙
  적용 여지 있음(이번엔 별도 게이트 추가 안 함, 향후 검토).
- **Airbyte**: 매핑은 "연결"(여기선 몰) 단위로 저장돼 실행마다 자동 재적용, 사람의 override는 별도
  레이어에서 — 연속관리의 "재마이그레이션 클릭 = 확인"으로 사람 개입 시점을 하나로 응축한 것과 같은 원칙.

## 구현

### 1. 커스텀 필드 — JSONB (EAV 아님)
- `product_master.custom_fields JSONB DEFAULT '{}'` (`lib/db.ts`) — 이미 이 코드베이스가 `options`/
  `composite_config`/`raw_data` 등에 쓰는 JSONB 관행 그대로. EAV 테이블은 기존 12곳 이상의 `product_master`
  조회 코드에 전부 join을 추가해야 해서 범위가 훨씬 큼.
- `client_master_schema_fields(id, client_id, field_key, field_label, is_custom, sort_order)` — 거래처별
  "기준 Master DB" 타깃 필드 목록. `UNIQUE(client_id, field_key)`.

### 2. "기준 Master DB" 엑셀 업로드
- `app/api/master/schema/upload/route.ts` (POST) — `lib/transform/matching.ts`의 기존
  `parseReferenceWorkbook()`을 재사용해 헤더만 파싱, `lib/master/schema.ts`의 새 `guessFixedFieldMapping()`
  (한국어 라벨 정규식 사전)으로 기존 고정 컬럼 매칭 초안 생성 — 저장은 안 하고 초안만 반환.
- `app/api/master/schema/route.ts` (GET/PUT) — 거래처의 필드 목록 조회/전체교체저장.
- UI: `ClientDetailPanel.tsx`에 "기준 Master DB" 섹션 추가 — 엑셀 업로드 → 편집 가능한 표(라벨/필드키/
  고정·커스텀 여부/삭제) → 직접 추가도 가능 → 저장.

### 3. Transform의 타깃 필드가 거래처별 동적 목록으로
- `lib/transform/generate.ts`: `ALLOWED_TARGET_FIELDS` → `FIXED_TARGET_FIELDS`로 개명(의미 유지), 새
  `getAllowedTargetFields(clientId)`가 고정 목록 ∪ 그 거래처의 커스텀 필드를 반환.
- `app/api/transform/columns/route.ts`: `siteId → sites.client_id` 조회 후 동적 허용 목록으로
  GET(`allowedTargetFields`/`customFields`)·PUT(`targetField` 검증) 처리.
- `commitGeneratedRow()`: 커스텀 필드로 매핑된 값은 `custom_fields = custom_fields || $N::jsonb`로 병합,
  고정 필드는 기존처럼 실제 컬럼에 `UPDATE` — 같은 문장에 함께 포함.
- `TransformPanel.tsx`: 컬럼 규칙의 타깃 필드 드롭다운에 "거래처 커스텀 필드" optgroup 추가.

### 4. Transform 3번(검토) 일괄적용
- `lib/transform/generate.ts`에 `commitGeneratedRows(ids, clientId)` 추가 — 기존 단건 `commitGeneratedRow`를
  id별로 try/catch 순회(배치가 보통 수십~수백 행이라 4가지 rule mode를 전부 배치 SQL로 새로 짜는 것보다
  이미 검증된 단건 로직 재사용이 더 작고 안전한 diff).
- `app/api/transform/results/bulk/route.ts` (신규) — `POST {siteId, clientId, ids?}`, ids 생략 시 그 site의
  draft 전체.
- `TransformPanel.tsx` 3번 검토 그리드 헤더에 "전체 반영 (N)" 버튼 추가.

### 5. 마이그레이션3_연속관리 ↔ Transform 연동
- `app/api/master/reapply/route.ts` (신규, 기존 `/api/master/migrate`는 다른 화면도 쓰므로 안 건드림) —
  `migrateToMaster()`(기존) → `generateForProducts()`(기존, draft 생성) → 그 draft id들을 조회 →
  `commitGeneratedRows()`(4번) — draft 검토 화면 없이 바로 확정. "재마이그레이션" 클릭 자체가 이미 사람의
  확인이므로 한 번 더 검토 단계를 넣지 않음(확정된 방향 3번).
- `ContinuousMigrationPanel.tsx`의 `migrateSelected()`: fetch 대상을 `/api/master/migrate`에서
  `/api/master/reapply`로 변경, 컴포넌트 state에 이미 있던 `siteId`를 body에 추가.

## 엣지 케이스

- 몰에 아직 `transform_column_rules`가 없으면 `generateForProducts`가 빈 값을 반환하고 `commitGeneratedRows`도
  변경할 게 없어 조용히 아무 일도 안 함 — `migrateToMaster()`의 기존 동작만 남음(에러 아님, 실제 테스트로
  확인).
- 거래처 A, B가 같은 라벨("시즌코드")로 커스텀 필드를 각자 등록해도 충돌 없음 — 둘 다 client_id로 이미
  분리돼 있음.
- 한 site의 `client_id`가 나중에 바뀌면 그 site 규칙이 예전 거래처의 커스텀 필드를 참조한 채로 남을 수
  있음 — 드문 관리자 조작이라 이번엔 가드 추가 안 함(알려진 한계로만 기록).

## 검증

테스트 거래처/몰/상품(id는 확인 후 전부 삭제)으로 전체 흐름을 curl로 직접 확인:
1. 엑셀 업로드 → 헤더 자동매칭(고정 2개 + 커스텀 2개) 확인 → PUT으로 저장 → GET 재조회 일치.
2. Transform 컬럼 규칙에 커스텀 필드를 타깃으로 지정 → 생성(`/api/transform/generate`) → draft 확인.
3. `/api/transform/results/bulk` → `product_master.custom_fields`에 실제로 값이 들어간 것을 DB에서 직접 확인.
4. `mall_products` 값을 변경(재스크랩 시뮬레이션) → `/api/master/reapply` 호출 → `stock_qty`(고정 필드,
   migrateToMaster 몫)와 `custom_fields`(Transform 규칙 몫) 둘 다 자동 갱신, `transform_generated_rows.status`가
   draft를 거치지 않고 바로 `committed`인 것 확인.
5. 규칙이 아예 없는 몰에서 `/api/master/reapply` 호출 → 에러 없이 `migrateToMaster()`만 동작, `custom_fields`는
   빈 객체로 유지되는 것 확인.

`npx tsc --noEmit`, 프로젝트 전체 `npx eslint .` 통과 확인(이번 작업과 무관한 기존 파일들의 pre-existing
lint 에러는 그대로 — 손대지 않음).

## 관련 파일

**신규**: `lib/master/schema.ts`, `app/api/master/schema/route.ts`, `app/api/master/schema/upload/route.ts`,
`app/api/master/reapply/route.ts`, `app/api/transform/results/bulk/route.ts`

**수정**: `lib/db.ts`, `lib/transform/generate.ts`, `app/api/transform/columns/route.ts`,
`components/panels/TransformPanel.tsx`, `components/panels/ClientDetailPanel.tsx`,
`components/panels/ContinuousMigrationPanel.tsx`

## 상태

**기본 기능 구현 완료 (2026-07-18).** 판매관리코드/브랜드/옵션/가격 등 다른 하위메뉴를 같은 규칙 엔진으로
통합하는 것은 명시적으로 다음 단계로 미룸.
