# "확정 (스크랩검수 후)" — product_master까지 실제로 생성하도록 수정

## 문제

사용자 질문(2026-07-18): "마이그레이션 하위 메뉴에서 '데이터 마이그 목록'에서 상태값이 '확정'으로 된 내역에
대해 작업이 가능하려면 각 하위 메뉴에서 조회가 되어야하는데 왜 안되는거지?"

원인: `StagingItemsGrid`의 "확정 (스크랩검수 후)" 버튼 → `/api/scrape-staging/merge` →
`mergeStagingItems()`(`lib/scrape/staging.ts`)는 `mall_products`만 upsert하고 `product_master`는 전혀
만들지 않고 있었다. `product_master`를 실제로 만드는 경로는 상품상세 화면의 개별 "마이그레이션" 버튼
(`ProductDetailPanel` → `/api/master/migrate`), Transform 확정, 연속관리 재마이그레이션뿐이었다. 그래서
"데이터 마이그 목록"에서는 세션이 "확정"으로 표시돼도(이 상태는 `scrape_staging_items.status` 기준),
판매관리코드/카테고리/옵션 등 8개 마이그레이션 하위 메뉴(전부 `product_master` 기준 조회)에는 아무것도
보이지 않았다.

## 수정

`mergeStagingItems()`(`lib/scrape/staging.ts`)가 `upsertMallProduct()` 직후 해당 몰의 `sites.client_id`를
조회해 `migrateToMaster([mallProductId], clientId)`(기존 함수, `lib/master/migrate.ts`)를 바로 호출하도록
추가했다. 사이트별 client_id는 세션 내에서 `Map` 캐시로 재사용(같은 세션에서 같은 사이트 반복 조회 방지).

`sites.client_id`는 nullable(몰 등록 시 거래처 지정이 필수가 아님)이라, client_id가 없는 몰은 여전히
`mall_products`까지만 반영되고 `product_master`는 만들지 않는다. 이 경우 `MergeResult.noClient: number[]`에
담아 반환하고, `StagingItemsGrid`가 "N개는 몰에 거래처가 연결되어 있지 않아 반영되지 않았습니다" 알림을
띄운다(기존 `skipped`—이미 가공된 상품—알림과 같은 패턴).

## 엣지 케이스

- `is_already_migrated && !force`로 스킵되는 항목(이미 예전에 migrateToMaster를 거친 상품)은 이번 변경과
  무관 — 그 항목들은 이미 `product_master` 행이 있으므로 다시 만들 필요가 없다.
- 몰에 거래처가 나중에 연결되면, 그 이후 확정하는 항목부터는 정상적으로 반영된다. 이미 `noClient`로
  스킵된 과거 항목은 소급 반영되지 않는다(개별 상품상세에서 수동 마이그레이션하거나, "이미 가공된 상품도
  포함" + force로 재확정 필요).

## 검증

테스트 거래처/몰/스크랩 세션/스테이징 항목을 만들어 `/api/scrape-staging/merge` 호출 → `product_master`
행이 실제로 생성되고 `/api/master?sessionId=`(하위 메뉴들이 쓰는 것과 동일한 조회)로 바로 조회되는 것까지
확인 후 테스트 데이터는 모두 삭제. `tsc --noEmit` 통과.

## 관련 파일

**수정**: `lib/scrape/staging.ts`, `components/panels/shared/StagingItemsGrid.tsx`

## 상태

**완료 (2026-07-18).** 관련 메모리: `session_merge_vs_item_confirm.md` (기존에 이 흐름이 이미 되는 것으로
잘못 기록돼 있던 부분을 이번 수정 내용으로 정정함).
