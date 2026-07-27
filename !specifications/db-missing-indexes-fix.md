# DB 인덱스 누락으로 인한 전반적 성능 저하 — 진단 및 수정 (2026-07-28)

## 배경

사용자가 "Mall 상세관리에서 데이터를 불러오는 속도가 느려진 것 같다"고 지적. 원인을 찾아보니
`scrape_sessions.site_id`에 인덱스가 없어, Mall 목록(`GET /api/sites`)이 몰마다 "가장 최근 세션"을
LATERAL 서브쿼리로 찾을 때 매번 `scrape_sessions` 전체를 순차 스캔하고 있었다. 이 테이블은 스크랩할
때마다 계속 쌓이는 테이블이라, 시간이 지날수록 체감 속도가 계속 나빠지는 게 당연한 구조였다.

이어서 "다른 메뉴에도 이런 게 있으면 같이 고쳐달라"는 요청을 받아, `app/api/**`의 쿼리를 전수
점검해 같은 패턴(FK 컬럼에 인덱스 없이 필터/조인 + 그 테이블이 계속 커짐)을 모두 찾아 고쳤다.

## 근본 원인 — Postgres는 FK에 자동으로 인덱스를 만들지 않는다

`REFERENCES` 제약(외래키)을 걸어도 참조하는 쪽 컬럼에 인덱스가 자동 생성되지 않는다(참조당하는 쪽 PK만
인덱스가 있음). 이 프로젝트는 스키마를 짤 때 이 점을 놓쳐서, "계속 쌓이는 로그/이력성 테이블"들을
FK 컬럼으로 필터/조인하는 곳이 전부 인덱스 없이 순차 스캔에 의존하고 있었다.

## 찾아서 고친 것 (`lib/db.ts`에 인덱스 추가, `initDb()`가 기동 시 `CREATE INDEX IF NOT EXISTS`로 적용)

| 테이블 | 추가한 인덱스 | 어디서 느려지고 있었나 |
|---|---|---|
| `scrape_sessions` | `(site_id, created_at DESC)` | Mall 상세관리 목록의 "최근 세션(차단여부)" LATERAL 조회 |
| `scrape_item_log` | `(session_id, id DESC)` | 스크래핑 진행화면 실시간 로그 폴링 + 확장의 "실패 재수집" |
| `mall_products` | `(last_seen_session_id)` | 세션 그리드(`/api/sessions`)의 상품 수 집계 조인, 세션별 상품 목록 필터 |
| `scrape_staging_items` | `(session_id, status)` / `(site_id, created_at DESC)` / `(matched_mall_product_id)` | 스크랩 Raw 확인 그리드, 세션 그리드의 상태별 카운트 서브쿼리 4개, 마이그레이션/Transform의 세션→상품마스터 조인 |
| `stock_snapshots` | `(mall_product_id, captured_at DESC)` | 상품마스터 상세의 "가공내역(재고/가격 변동 이력)" |
| `product_images` | `(mall_product_id, image_type, sort_order)` / `(product_master_id, image_type, sort_order)` | 상품 목록/상세, 마스터 목록/상세, 마이그레이션 화면의 썸네일·상세이미지 조회 전부 |
| `transform_reference_rows` | `(upload_id)` | Transform 업로드 매칭(`lib/transform/matching.ts`)의 반복 조회 |

`mall_products.site_id`는 기존 `UNIQUE(site_id, mall_product_code)`가 왼쪽 컬럼이라 이미 인덱스로
커버되고 있어 따로 추가하지 않았다.

## 검증

`lib/db.ts` 수정 후 `tsc --noEmit`/`eslint` 클린. 9개 인덱스 전부 실제 DB에 직접 적용해
`pg_indexes`로 생성 확인 완료(개발 서버가 다음 요청 때 `initDb()`를 통해서도 동일하게
`CREATE INDEX IF NOT EXISTS`를 실행하므로 재기동 시에도 안전).

## 의도적으로 건드리지 않은 것

`client_memos`/`site_memos`(거래처/Mall당 메모 몇 건 수준, 무한정 쌓이는 테이블이 아님),
`marketplace_credentials`/`registration_jobs`(5단계 설계만 되어있고 소비하는 코드 없음)는 같은
패턴이어도 실질적 영향이 없어 인덱스를 추가하지 않았다.
