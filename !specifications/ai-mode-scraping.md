# AI모드 스크래핑

## 배경
사용자가 "AI가 컬럼 의미를 알고 몰 데이터에서 매핑되는 걸 찾아준다"고 오해하고 있었으나, 실제 기본
스크랩은 100% 규칙 기반(schema.org ld+json / og 메타태그 / 상품정보고시 라벨-값 표)이고 AI는 관여하지
않는다 — 매칭 안 되는 필드는 추측하지 않고 정직하게 비워둔다(설계 의도). 사용자의 "몰은 자주 안 바뀌니
한 번 매핑해두면 계속 재사용하면 된다"는 요청을 반영해, 스크랩 미리보기 시점에 AI가 그 몰을 1회 분석해
추출 규칙을 자동 생성·저장하고, 이후에는 AI 재호출 없이 그 규칙을 재사용하는 방식으로 구현했다.

## 설계 결정 (사용자 확인)
- AI 호출 시점: **몰당 1회 자동 분석 → 규칙 저장** (매 상품마다 AI를 다시 부르는 방식은 채택하지 않음 —
  비용/속도 문제 + "한 번 매핑해두면 재사용"이라는 사용자 의도와 맞지 않음)
- UI 배치: 기존 "단일/카테고리" 스크랩 모드 선택지 옆에 **별도 토글**로 추가 (스크랩 범위와 추출 방식은
  서로 다른 축이라 같은 선택지에 섞지 않음)

## 구성
- `lib/ai.ts`의 `generateExtractionRules` — 기존 "스크랩 조정"용 함수를 확장. `userPrompt`가 빈 문자열이면
  "AI모드" 경로로 분기해, 사용자가 지적한 특정 필드가 아니라 8개 필드(name/price/cost_price/shipping_fee/
  category/brand/manufacturer/origin) 전체를 스스로 분석하도록 프롬프트를 바꾼다. 스키마/에러처리는 기존과
  동일하게 공유.
- `lib/scrape/adjustment.ts`의 `runAutoAnalysis(siteId, pageText)` — `runAdjustment`와 규칙 저장 로직
  (`mergeRulesIntoSite`, Postgres jsonb `||` 원자적 병합)을 공유하는 새 함수. userPrompt 없이
  `generateExtractionRules`를 호출하고 결과를 `sites.extraction_rules`에 저장한다.
- `lib/scraper.ts`— `ScrapeOptions.aiMode` 플래그 추가. `applyAiModeRules(page, siteId, sourceUrl, opts)`
  헬퍼가 지금 열려있는 페이지의 텍스트를 뽑아 `runAutoAnalysis`를 호출하고, 병합된 규칙으로
  `extractProductRuleBased`를 다시 실행해 값을 새로고침한다. **AI 호출/분석 실패는 조용히 삼켜 null을
  반환** — 이미 규칙 기반으로 뽑은 결과가 있으니 미리보기 자체가 막히면 안 된다. `scrapeSingleProduct`
  (단일 상품 미리보기)와 `previewCatalog`(카탈로그 첫 상품 미리보기) 양쪽에 훅을 걸었다 — **실제 스크랩
  실행(catalog/single 본 실행)에는 걸지 않았다**, 미리보기 시점에만 규칙을 만들고 이후 실행은 그 저장된
  규칙을 기존 흐름대로 재사용한다.
- `app/api/scrape/preview`, `app/api/scrape/preview-catalog` — body에 `aiMode?: boolean` 추가, 그대로
  scrapeSingleProduct/previewCatalog에 전달.
- `components/panels/ScraperPanel.tsx` — "스크랩 모드" 선택지 옆에 "AI모드 스크래핑" 토글 버튼 추가.
  켜진 상태로 "스크랩 미리보기"를 누르면 두 preview 요청에 `aiMode: true`가 실린다. 로딩 중 버튼 텍스트도
  "AI 분석 중..."으로 구분 표시.

## 검증
- `tsc --noEmit`, `eslint`(변경 파일) 클린.
- `generateExtractionRules('')` 분기를 실제 살아있는 서버에 임시 디버그 라우트로 직접 호출해 검증 —
  Anthropic API까지 정상 도달하고, 설계대로 명확한 에러를 던지는 것까지 확인(원인: 이 계정의 Anthropic
  크레딧 잔액 부족 — `invoke 실패` 자체는 코드 문제가 아님, 크레딧 충전 후 재검증 필요).
- 실제 등록된 몰(걸스굽/가방쟁이)로 end-to-end(`aiMode:true`로 실제 상품 페이지 스크랩) 테스트는 진행했으나,
  **AI모드 유무와 무관하게** 두 몰 모두 기존 규칙 기반 추출 단계에서 "가격/이미지를 모두 찾지 못함"으로
  실패했다(aiMode:false로도 동일 재현 — 봇 차단으로 추정, 이 기능과 무관한 별개 이슈, 오늘 조사 범위 밖).
  따라서 **실제 몰 데이터로 AI모드의 최종 값 채움까지는 아직 실증 검증 못함** — Anthropic 크레딧 충전 +
  정상 스크랩되는 몰로 재검증 필요.

## 알려진 한계
- 8개 고정 필드(EXTRACTION_RULE_FIELDS)만 규칙 생성 대상 — 재고/이미지는 여전히 DOM 기반 별도 추출
  (`applyStockByOption`)이라 AI모드 대상 밖이며 그대로 유지된다. (옵션은 아래 2차 개선으로 AI모드가 검증에
  관여하게 됐다.)
- AI모드를 켜고 미리보기할 때마다 규칙을 다시 생성한다(캐시/스킵 로직 없음) — 몰 구조가 안 바뀌었으면
  다시 켤 필요 없이 그냥 꺼두면 저장된 규칙이 계속 쓰인다.

## 2차 개선 (실사용 중 발견된 문제 대응)
실제로 도매의신(site 14) 상품 페이지를 AI모드로 미리보기해보니:
1. **`options`가 완전히 엉뚱했다** — 도매의신은 카페24처럼 알려진 옵션 컨테이너 셀렉터가 없어(`extractOptionsFromDom`의
   `OPTION_CONTAINER_SELECTOR`가 안 걸림), document 전체에서 `<select>`를 찾다가 **검색창의 "검색범위"/
   카테고리 필터 드롭다운**을 상품 옵션으로 잘못 잡아 의미 없는 옵션조합(45개)까지 만들어졌다.
2. `price`/`shipping_fee`가 실제로 페이지에 값이 있는데도 null — 원인은 라벨 값이 다른 텍스트와 뭉쳐있는
   경우(예: "배송비"가 "배송유형" 설명 문장 안에 파묻힘)라 규칙만으론 못 뽑는 케이스.
3. `name`이 `<title>` 태그(사이트명 포함)를 그대로 써서 실제 상품명("품명" 라벨)과 다르게 나옴.

사용자 요청: "AI는 브라우저로 보는 것처럼 실제 사용자에게 노출되는 데이터 값만 기준으로 스크랩해야 한다."
이에 따라:
- **`generateExtractionRules`의 AI모드 프롬프트(빈 userPrompt 분기)에 명시적으로 추가**: 사이트 로고/메뉴/
  푸터, 검색창/필터/정렬, 로그인·장바구니 링크, 사이트 전체 내비게이션은 상품 데이터가 아니라고 못박고,
  `<title>`보다 페이지 내 실제 상품명 표시를 우선하도록 지시. 라벨 값에 다른 정보가 섞여 깨끗이 못 뽑을
  것 같으면 억지로 만들지 말고 비워두라고 명시(1번 케이스처럼 컴파운드 문자열은 근본적으로 규칙만으론
  100% 못 푸는 한계가 있어, 정직하게 비우는 쪽을 다시 한번 강조).
- **`lib/ai.ts`에 `filterRealProductOptions(mallName, candidates, pageText)` 신규 추가** — `extractOptionsFromDom`이
  찾은 후보 옵션 그룹(이름+값 목록)을 AI에게 보여주고, 실제 구매 옵션(색상/사이즈 등)인지 검색/필터/정렬
  같은 무관한 사이트 UI인지 판별해 진짜 이름만 골라 반환. **판단 실패(크레딧 부족 등) 시 보수적으로 후보
  전체를 그대로 유지** — "지우는" 동작이라 AI 문제로 진짜 옵션까지 사라지는 것보다 기존처럼 오탐이 섞인
  채 두는 쪽이 안전하다는 원칙.
- **`lib/scraper.ts`의 `applyAiModeRules`가 이 필터를 사용하도록 재구성** — 기존엔 AI모드 안에서
  `extractOptionsFromDom`을 한 번 더(중복) 스캔했는데, select 값을 실제로 선택해보는 상태 변경 동작이라
  같은 페이지에 두 번 개입하면 결과가 달라질 위험이 있어, 호출부(scrapeSingleProduct/previewCatalog)가
  이미 스캔해둔 `domOptions`를 그대로 받아 AI로 필터링만 하도록 시그니처를 바꿨다(중복 스캔 제거).
  옵션이 하나라도 제외되면 캐스케이딩 조합(`option_combinations`)도 더는 신뢰할 수 없어 함께 비운다.

**검증 상태**: 새 로직(`filterRealProductOptions`)이 크레딧 부족 시 정확히 설계대로 "후보 전체 유지"로
안전하게 폴백하는 것까지는 임시 디버그 라우트로 확인했다. 다만 이번에도 Anthropic 크레딧이 없어 **AI가
실제로 검색필터/진짜 옵션을 올바르게 구분해내는지는 여전히 실증 검증 못함** — 크레딧 충전 후 도매의신
같은 몰로 재검증 필요.
