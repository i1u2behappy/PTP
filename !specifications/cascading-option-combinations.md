# 옵션1↔옵션2 실제 조합 스크랩 — 신우처럼 색상별 사이즈가 다른 몰

## 배경

신우 같은 몰은 옵션1(색상)을 고르면 AJAX로 옵션2(사이즈) 목록이 바뀌는데, 색상마다 실제 구매 가능한
사이즈가 다르다 — 예를 들어 빨강은 100/105 사이즈가 있고 파랑은 100 사이즈만 있는 식이다. 기존 코드는
옵션1 값을 하나씩 선택해가며 나타나는 옵션2 값들을 전부 하나의 집합으로 합쳐버려서("사이즈: 100, 105"),
어느 색상에 어느 사이즈가 실제로 딸려 있는지 정보가 사라지는 문제가 있었다.

사용자가 확인해준 사실: 스크랩할 때 각 옵션1 값별로 옵션2 값이 매칭되는 형태로 데이터가 남아야 한다.

## 설계

일반모드(`lib/scraper.ts`)와 개발자모드(`extension-poc/background.js`)는 이미 옵션1을 하나씩 선택하며
캐스케이드를 순회하는 로직이 있었다(옵션1→옵션2 1단계까지만 지원, 3단계 이상 중첩은 범위 밖 — 기존
제약 그대로 유지). 그 순회 과정에서 매 옵션1 값 선택 직후 나타나는 옵션2 값들을 기존처럼 합집합
(`options` 필드, 하위 호환 유지)으로도 모으고, **동시에** `[옵션1값, 옵션2값]` 쌍 그대로도 별도 목록에
쌓는다 — 새 필드 `ExtractedProduct.option_combinations?: string[][]`.

- `lib/scraper.ts`의 `extractOptionsFromDom`이 `{ options, combinations }`를 반환하도록 반환 타입 변경,
  호출부 5곳 모두 `product.options`/`product.option_combinations`로 나눠 대입.
- `extension-poc/background.js`의 옵션1→옵션2 캐스케이드 루프(`selectEls` 순회)에 `optionCombinations`
  배열을 추가해 매 반복마다 `[val, v2]` 쌍을 push, `result.option_combinations`로 전달.
- 캐스케이딩이 없는 몰(옵션2가 항상 고정)은 매 옵션1 값에서 같은 옵션2 목록이 나와 결과적으로 전체
  카티전 곱과 동일해질 뿐이라 문제없음 — 별도 분기 없이 같은 코드 경로로 처리.
- `lib/scrape/staging.ts`의 `toScrapeResult`(재추출/재적용 시 raw_data에서 ExtractedProduct 복원)에도
  `option_combinations: extra.option_combinations || []` 추가 — `stock_by_option`과 같은 패턴(전용
  컬럼 없이 raw_data JSONB로만 보관).
- product_master/product_master 스키마는 건드리지 않는다 — 지금은 스크랩 검수 단계에서 정확히
  보이는 것까지만 범위.

### 검수 화면 표시

`components/panels/shared/StagingItemsGrid.tsx`에 "옵션 조합(옵션1별 옵션2)" 컬럼 신설 —
`option_combinations`를 옵션1 값별로 묶어 "레드: 100/105, 블루: 100" 형태로 보여준다(그리드에 실제
반영됐는지 사용자가 바로 확인할 수 있도록).

## 하지 않는 것 (알려진 한계)

- 옵션1→옵션2 1단계 캐스케이드만 지원(기존 제약과 동일) — 3단계 이상 중첩 옵션은 다루지 않는다.
- ~~`product_master`/마이그레이션/Excel 내보내기는 아직 `option_combinations`를 소비하지 않는다~~ →
  **2026-10-03 해소**: `migrateToMaster`가 `mall_products.raw_data.option_combinations`를
  `product_master.option_combinations`로 옮긴다(쿠팡 등록 `items[]` 설계 중, 평평한 옵션만으로
  카티전 곱을 만들면 실제로 없는 조합을 판매 가능한 것처럼 등록하게 되는 문제를 발견해 선행 작업으로
  처리 — [[marketplace-api-integration]] 참고). `getProductMasterRows`/엑셀 내보내기용
  `ProductMasterRow`에도 필드가 흐른다. 단, **엑셀 생성 로직(`lib/excel/coupang.ts` 등) 자체는 아직
  이 필드를 안 쓴다** — 지금 쓰는 곳은 `lib/marketplace/optionCombinations.ts`
  (`resolveOptionCombinations`, 실제 조합 우선 사용·없으면 카티전 곱 근사+경고 플래그)뿐이고, 이건
  쿠팡 API 어댑터가 `register()`를 구현할 때 소비할 예정이다(아직 `register()` 자체는 미구현).

## 관련 파일

- `lib/ai.ts`: `ExtractedProduct.option_combinations`
- `lib/scraper.ts`: `extractOptionsFromDom`(반환 타입 변경), 호출부 5곳
- `extension-poc/background.js`: 옵션1→옵션2 캐스케이드 루프, `manifest.json` 버전
- `lib/scrape/staging.ts`: `toScrapeResult`
- `components/panels/shared/StagingItemsGrid.tsx`: "옵션 조합" 컬럼

## 상태

**구현 완료.** 합성 데이터로 조합 로직 검증, 확장 런타임 문자열(`new Function()`)로 문법 확인,
tsc/eslint 클린. 개발자모드(신우)는 크롬 확장을 새로고침한 뒤 재스크랩해야 반영된다 — 실사용 확인은
사용자 몫으로 남음.
