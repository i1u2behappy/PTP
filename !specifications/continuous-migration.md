# 마이그레이션3_연속관리 — 요구사항 기록

## 배경 / 요구사항 (사용자 지시 원문 기준, 2026-07-17)

> 마이그레이션3_연속관리 메뉴를 만들어. 이 메뉴의 주요 기능은 '마이그레이션' 메뉴를 통해 '상품마스터'를
> 만들어서 거래처에 제공한 몰의 품목을 기준으로, 새로운 상품이 스크래핑되거나, 재고가 변동되거나, 옵션이
> 변동되거나, 가격이 변동되거나, 이미지가 변동되는 등의 상품의 주요변동사항이 발생한 정보를 체크하여
> 데이터화 시키고, 이를 통해 기존과 같이 마이그레이션 작업을 통해 최종 상품마스터를 만드는 거야. 즉 1차
> 스크래핑하여 최종 상품마스터를 만들기까지의 절차를 재차 하는 것이고, 변동된 상품들에 대해 거래처에
> 정보를 지속적으로 재공하는 목적이야. ... 우선 기본 메뉴들을 만들어줘.

즉 이미 `product_master`로 마이그레이션되어 거래처에 제공 중인 상품을 대상으로, 몰 쪽에서 재스크랩된
최신 값과 비교해 변동분(재고/옵션/이미지/가격)만 추려내고, 선택적으로 다시 마이그레이션(재고/옵션/이미지
갱신)하는 반복(연속) 관리 메뉴다. 신규 상품 자체의 최초 마이그레이션은 기존 "마이그레이션" 메뉴가 계속
담당하고, 이 메뉴는 그 이후 재스크랩분의 "변동 감지 → 재반영"만 담당한다. AI가 몰별 스크랩→마이그레이션
패턴을 학습해 마스터 컬럼을 자동 채우는 고도화는 사용자가 향후 방향으로만 언급했고, 이번엔 "기본 메뉴"만
만들어달라고 명시적으로 범위를 좁혔다.

## 설계 결정

- **새 merge 로직을 만들지 않는다.** 기존 `lib/master/migrate.ts`의 `migrateToMaster()`가 이미
  안전하게 재실행 가능(idempotent)하도록 짜여 있다 — `ON CONFLICT (mall_product_id, client_id)`에서
  `name_original`/`mall_category`/`options`/`stock_status`/`stock_qty`는 항상 몰 최신값으로 덮어쓰고,
  `brand`/`manufacturer`/`origin`/`description`은 비어있을 때만 채우며, `sale_price`/`list_price`는
  이미 값이 있으면 절대 자동으로 덮어쓰지 않는다(가격은 사람이 정하는 값이라는 기존 비즈니스 결정 보존).
  따라서 "재마이그레이션"은 이 함수/`app/api/master/migrate/route.ts`를 그대로 재사용하고, 이 기능은
  변동 감지(읽기 전용 diff)만 새로 만들면 된다.
- **변동 판정 기준**: `mall_products`(몰 최신 스크랩값)와 `product_master`(마스터 저장값)를
  `product_master.mall_product_id = mall_products.id`로 조인해 필드별로 비교한다.
  - 재고상태(`stock_status`)/재고수량(`stock_qty`)/옵션 구성(`options`, JSON 문자열 비교) — 실제 변경
    사유로 표시. `migrateToMaster`가 항상 덮어쓰는 필드라 재마이그레이션하면 실제로 갱신됨.
  - 이미지 개수 — 몰의 `thumbnail_urls`+`detail_image_urls` 개수 vs. 이미 연결된 `product_images`
    (`product_master_id`) 행 수 비교.
  - 가격 — 몰의 `sale_price ?? price`와 마스터의 `sale_price ?? list_price`가 다르면 **참고용으로만**
    표시하고 "(참고용, 자동 반영 안 됨)"이라 명시한다 — 재마이그레이션해도 안 바뀐다는 것을 사용자가
    오해하지 않도록. `reasons`가 전부 참고용이면 `priceOnly: true`로 플래그해 UI가 구분할 수 있게 함.
- **UI는 세션(스크랩 1회) 스코프가 아니라 몰(site) 스코프**라 기존 `ScrapeScopePicker`(세션 선택기)를
  쓰지 않고, 단순 거래처/몰 드롭다운 → "변동 감지" 버튼 → 결과 그리드(체크박스) → "선택 재마이그레이션"
  흐름으로 새로 만들었다.
- 버튼 배색은 이번 세션에 확정한 표준(teal=주요액션 "변동 감지", emerald=확인 "선택 재마이그레이션")을
  그대로 따른다.

## 새 파일 / 수정 파일

**신규**
- `app/api/master/changes/route.ts` — `GET ?siteId=` : 위 판정 로직으로 변동된 상품 목록을 반환
  (`{ mallProductId, masterId, clientId, nameOriginal, mallProductCode, lastScrapedAt, updatedAt, reasons, priceOnly }[]`,
  변동 없는 상품은 필터링해서 아예 제외).
- `components/panels/ContinuousMigrationPanel.tsx` — 거래처/몰 선택 → 변동 감지 → 결과 그리드
  (체크박스, 몰상품코드, 상품명, 변동내역, 최근 스크랩일시, 상세보기 링크) → 선택 재마이그레이션
  (`/api/master/migrate` 재사용, 완료 후 자동 재조회).

**수정**
- `components/shell/TabsContext.tsx` — `TabType`에 `'continuous-migration'` 추가.
- `components/shell/Sidebar.tsx` — 최상위 `NavLeaf` 추가("마이그레이션3_연속관리", 마이그레이션2_Transform
  옆, 기존 "마이그레이션" `NavGroup`과는 별개 — 세션 하나 아니라 마스터 전체를 다루는 별도 파이프라인이라
  같은 명명 규칙(마이그레이션N_이름)만 따르고 하위 메뉴로 묶지 않음).
- `components/shell/Workspace.tsx` — `case 'continuous-migration'` 라우팅 추가.

## 검증

- `npx tsc --noEmit` 통과.
- 실제 DB(site 1)에 테스트용 `mall_products` 1건을 넣고 `/api/master/migrate`로 최초 마이그레이션 →
  `mall_products`의 재고/옵션/가격을 변경 → `/api/master/changes?siteId=1`가 재고/옵션/가격 변동 3가지를
  정확히 감지(`reasons`)하는 것을 확인 → 재마이그레이션 후 다시 조회하면 재고/옵션은 사라지고 가격만
  참고용으로 남는 것(`priceOnly: true`)까지 확인. 테스트 데이터는 확인 후 삭제.

## 상태

**기본 메뉴 구현 완료 (2026-07-17).** AI 학습 기반 컬럼 자동 매핑은 사용자가 명시한 향후 방향이며
이번 범위에는 포함하지 않았다.
