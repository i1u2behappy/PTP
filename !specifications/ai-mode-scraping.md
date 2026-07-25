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
- 8개 고정 필드(EXTRACTION_RULE_FIELDS)만 대상 — 옵션/재고/이미지는 DOM 기반 별도 추출(`extractOptionsFromDom`,
  `applyStockByOption`)이라 AI모드 대상 밖이며 그대로 유지된다.
- AI모드를 켜고 미리보기할 때마다 규칙을 다시 생성한다(캐시/스킵 로직 없음) — 몰 구조가 안 바뀌었으면
  다시 켤 필요 없이 그냥 꺼두면 저장된 규칙이 계속 쓰인다.
