# 마이그레이션 하위 메뉴 — 거래처/몰/세션 스코프 일원화 — 요구사항 기록

## 배경

`마이그레이션` 메뉴 아래 9개 하위 메뉴(판매관리코드/카테고리매핑/관리코드생성/상품명/옵션/브랜드,제조사,원산지/
이미지관리/이미지호스팅/가격및이익)는 원래 "각 메뉴가 독립적으로, 상단에서 조회한 스크랩데이터를 선택해 그
범위로 작업한다"는 설계 의도였다. 실제 점검해보니 이 의도가 지켜진 곳은 2곳(판매관리코드/관리코드생성 —
거래처 단독 선택만 있었음)뿐이었고, 나머지 6곳은 거래처 선택 UI 자체가 없이 `clientId=1`로 하드코딩되거나
API 기본값(1)에 의존하고 있었다.

## 요구사항 (사용자 지시 원문 기준)

> 마이그레이션은 하위 메뉴들 각기 독립적으로 각기 메뉴 상단에서 조회한 스크랩데이터를 선택하여, 각기 메뉴의
> 마이그레이션 작업을 할 수 있께 전체적으로 구성한 것이니 다시 점검해봐

점검 결과를 보고한 뒤, 수정 범위를 확인:

> (수정 범위 질문에 대한 답) 거래처+몰+세션까지 완전히 맞춤

즉 6개 문제 메뉴뿐 아니라 이미 부분적으로 되어있던 2개(판매관리코드/관리코드생성)까지 포함해, 9개 중
전역설정 성격인 이미지호스팅관리 1개를 제외한 8개 전부를 "거래처 → 몰 → 스크랩 세션" 선택까지 완전히
갖추도록 통일했다.

## 구현된 설계 결정

- **공용 컴포넌트 `ScrapeScopePicker`**(`components/panels/shared/ScrapeScopePicker.tsx`): `MigrationDashboardPanel`이
  이미 쓰고 있던 "거래처/몰 드롭다운 + 조회 버튼 + 세션 검색·선택 그리드" UI를 그대로 추출해 8개 메뉴가
  공유한다. 세션을 고르면 그 세션이 속한 몰(`site_id`)과 몰의 거래처(`client_id`)까지 함께 콜백으로 알려준다
  (`onScopeChange({ clientId, siteId, sessionId })`).
- **`params` 기반 프리셀렉트**: `initialSiteId`/`initialSessionId`를 받으면 그 세션을 자동 선택한 상태로 시작한다
  — `MigrationDashboardPanel`의 진행현황 카드를 눌러 하위 메뉴로 들어갈 때 이 값을 넘겨준다(예전엔 아무 params
  없이 열려 매번 처음부터 다시 골라야 했음).
- **API의 `sessionId` 스코프 추가**: `product_master`는 `site_id`/`session_id`를 직접 갖지 않고
  `mall_product_id → mall_products.site_id`로만 연결되므로, `mall_products` + `scrape_staging_items`
  (`matched_mall_product_id`, `session_id`)를 조인해 "이 세션에서 병합된 상품마스터"로 범위를 좁힌다.
  - `/api/master`: `sessionId` 파라미터 지원 추가. 기존 `clientId` 방식은 하위호환으로 유지.
  - `/api/master/field-values`: GET/PUT 모두 `sessionId` 지원 추가(값 일괄변경(PUT)도 세션 범위로만 적용 가능).
  - `/api/master/images`: `sessionId` 지원 추가.
  - `/api/master/internal-codes`: `sessionId` 지원 추가 — 세션만 주어지면 거래처는 그 세션이 속한 몰의
    거래처로 서버가 자동 결정.
  - `/api/master/by-session`(구 MigrationDashboardPanel 전용, 필드가 부족했음)은 `/api/master`와 기능이
    겹쳐 통합 후 삭제.
- **8개 메뉴 개별 반영**: 상품명/옵션/가격/브랜드,제조사,원산지/이미지관리/카테고리매핑 — 거래처 선택 UI
  자체가 없던 6곳에 피커를 새로 추가. 판매관리코드/관리코드생성 — 기존 거래처 단독 드롭다운을 피커로 교체.
  **이미지호스팅관리**는 몰/거래처 무관 전역 설정(이미지 CDN 주소 1개)이라 대상에서 제외.
- **런타임 버그 수정(발견 즉시 수정)**: `/api/master/images`의 세션 스코프 쿼리를 처음엔 `SELECT DISTINCT` +
  `json_agg`(jsonb 아님) 조합으로 짰다가 "could not identify an equality operator for type json" 500 에러가
  나는 걸 curl 스모크테스트로 발견 — `WHERE EXISTS` 서브쿼리 구조로 바꿔 해결.

## 관련 파일

- `components/panels/shared/ScrapeScopePicker.tsx` (신규)
- `app/api/master/route.ts`, `field-values/route.ts`, `images/route.ts`, `internal-codes/route.ts`
  (`sessionId` 지원 추가), `by-session/route.ts` (삭제, `/api/master`로 통합)
- `components/panels/{ProductNamePanel,OptionManagementPanel,PricingManagementPanel,BrandOriginPanel,
  CategoryMappingPanel,ImageEditPanel,SalesCodePanel,InternalCodePanel}.tsx`
- `components/panels/MigrationDashboardPanel.tsx` (진행현황 카드가 siteId/sessionId를 하위 메뉴로 전달)
- `components/shell/Workspace.tsx` (8개 case에 `params={tab.params}` 전달)

## 상태

**구현 완료 (2026-07-17).** 커밋: `66d1de9`. `tsc --noEmit` 통과, 4개 API 라우트 curl 스모크테스트로
런타임 에러 없음 확인(그 과정에서 위 json/jsonb 버그 발견·수정).

미검증: 실제 브라우저에서 몰/세션을 선택해가며 8개 메뉴를 하나하나 클릭해보는 end-to-end 확인은 아직
안 함 — 현재 DB에 세션 단위로 병합된(matched_mall_product_id가 채워진) 상품마스터 데이터가 없어 실제
값이 보이는지는 사용자가 마이그레이션 병합을 한 번 진행한 뒤 확인 필요.
