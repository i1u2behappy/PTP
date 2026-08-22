# 마이그레이션/연속관리 대량 처리 병렬화 (2026-08-22)

## 배경

몰 구조분석/개발자모드 스크랩(각각 `!specifications/mall-profile-baseline.md`,
`manual-login-required-malls.md` 참고)을 병렬화한 데 이어, PTP 전체에서 "여러 독립적인 항목을 순차
루프로 하나씩 처리하는" 나머지 병목을 조사(전용 조사 3갈래)해 우선순위를 매겼다. 그중 사용자가
"안전하고 쉬움" 다음으로 지목한, DB 중심 대량 처리 4곳을 이번에 병렬화했다. 이미 병렬화돼 있던
`mergeStagingItems`(`lib/scrape/staging.ts`, `MERGE_CONCURRENCY = 6`, 스크랩Raw "확정" 처리)의 청크
단위 `Promise.all` 패턴을 그대로 재사용했다 — 이유: 무제한 `Promise.all`은 DB 커넥션 풀(기본 10개)을
고갈시킬 수 있어, 6개씩 묶어 처리한다.

## 병렬화한 곳

### 1. `migrateToMaster` (`lib/master/migrate.ts`)

`mall_products` → `product_master` 이관. 상품 1건당 DB 왕복 5회 안팎(조회, reference_products 폴백
조회, upsert, 사내 관리코드 발급, mall_products/product_images 갱신)인데 서로 다른 상품은 완전히
독립적이다(각자 자기 행만 건드림). `MIGRATE_CONCURRENCY = 6`로 청크 병렬화.

**안전성 확인**: 사내 관리코드 발급(`nextInternalCode`)은 `UPDATE supply_clients SET next_internal_seq
= next_internal_seq + 1 ... RETURNING`으로 원자적이라, 여러 상품이 동시에 번호를 요청해도 겹치지
않는다(PostgreSQL의 행 단위 잠금이 순번을 보장). `ON CONFLICT (mall_product_id, client_id)`도 상품별로
서로 다른 키라 충돌 여지가 없다. `mergeStagingItems`의 `mergeOne`은 이미 `migrateToMaster`를 배열
길이 1로 호출하고 있었으므로(그 자체가 이미 병렬 청크 안에서 호출됨), 이번 변경은 **배열 여러 개를
한 번에 넘기는** `/api/master/migrate`, `/api/master/reapply`(연속관리 재적용) 경로에만 실질적인
효과가 있다.

### 2. `app/api/master/recheck/route.ts` — 연속관리 재확인 후처리

`recheckMallProducts`(`lib/scraper.ts`) 자체는 이미 워커풀로 병렬 실행되고 있었다(조사로 확인,
변경 없음) — 병목은 그 결과를 받은 **뒤** DB에 반영(`upsertMallProduct`)하고 이전 값과 비교하는
후처리 루프가 순차였던 부분이다. `RECHECK_CONCURRENCY = 6`으로 청크 병렬화. 결과 배열(`results`)의
순서는 `recheckMallProducts`가 이미 워커풀이라 원래도 요청 순서를 보장하지 않았으므로, 이번 변경으로
더 나빠지는 보장은 없다.

### 3. `generateForProducts` (`lib/transform/generate.ts`) — Transform AI 컬럼 생성

상품마다 DB 조회 1회 + (AI 규칙이 있으면) AI 호출 1회 + upsert 1회. `GENERATE_CONCURRENCY = 6`으로
청크 병렬화 — AI 호출이 껴 있어 상품 수가 많을 때 체감 효과가 가장 큰 곳이다. **주의**: AI 제공자
(Gemini 등, `lib/ai.ts`의 `generateTransformColumns`)의 분당 호출 한도에 걸릴 수 있으므로, 실사용 중
429/한도 오류가 보이면 이 상수를 낮춰야 한다(현재는 다른 곳과 통일해 6으로 시작).

### 4. `commitGeneratedRows` (`lib/transform/generate.ts`) — Transform 확정

여러 draft 행을 확정하는 함수 — 원래도 항목별 `try/catch`로 실패를 격리하고 있었다. `COMMIT_CONCURRENCY
= 6`으로 청크 병렬화하되, 개별 실패 격리(`committed`/`failed` 분리)는 그대로 유지했다.

## 병렬화하지 않은 것 (같은 조사에서 "위험" 또는 "이미 해결됨"으로 분류)

- 과거 데드락 버그(`db-migration-deadlock-fix.md`)는 "하나의 거대 트랜잭션"이 여러 테이블을 고정
  순서로 오래 잠근 게 원인이었다 — 위 4곳은 전부 개별 자동커밋 쿼리(명시적 `BEGIN` 없음)라 같은 유형의
  위험이 없다는 걸 확인 후 진행했다.
- `lib/images.ts`의 이미지 다운로드/`app/api/export`는 조사 결과 이미 병렬(`Promise.all`)이거나 단일
  배치 쿼리였다 — 손댈 게 없었다.

## 관련 파일

**수정**: `lib/master/migrate.ts`(`MIGRATE_CONCURRENCY`), `app/api/master/recheck/route.ts`
(`RECHECK_CONCURRENCY`), `lib/transform/generate.ts`(`GENERATE_CONCURRENCY`, `COMMIT_CONCURRENCY`).

## 상태

**구현 완료.** `tsc --noEmit`/`eslint` 클린. 실제 대량 데이터(연속관리 재확인, Transform AI 생성 등)로
처리 시간이 실제로 줄었는지, AI 호출 한도에 걸리지 않는지는 사용자 실사용 확인 필요.
