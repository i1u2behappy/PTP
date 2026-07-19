# 스크랩 조정 — 프롬프트 기반 추출 규칙 학습 + 재적용

## 배경

신우(개발자모드) 몰을 실제로 붙잡고 검증하는 과정에서, 가격이 두 종류(소비자가/도매가)인 것, 배송비
라벨 위치, 카테고리 위치, 옵션1 선택 시 옵션2가 AJAX로 채워지는 것 등을 매번 실제 페이지를 열어보며
사용자와 함께 하나씩 찾아 코드로 고쳤다. 사용자가 이 과정 자체를 PTP 기능으로 만들고 싶어했다: 스크랩
Raw 확인 화면에서 지금 스크랩된 값과 실제 몰 페이지를 비교해보고, 프롬프트로 지적하면 AI가 알아서
올바른 추출 규칙을 만들어 그 몰의 영구 기준으로 저장하고, 스크랩된 데이터에도 반영해달라는 것.

사용자가 확정한 방향:
1. 규칙은 1회성 수정이 아니라 **그 몰의 영구 규칙**으로 저장되어 앞으로의 스크랩에도 계속 적용된다.
2. 일반모드와 개발자모드 둘 다 지원한다. **"스크랩 조정"은 특정 모드 전용 기능이 아니라, 스크래핑
   방식이라면 반드시 갖춰야 하는 필수 공통 기능이다** — 지금은 2가지뿐이지만 앞으로 3번째 방식이
   생기더라도 반드시 이 기능을 지원해야 한다.
3. 버튼 위치는 상단 세션 목록이 아니라, 하단 "확정(스크랩검수 후)" 버튼 바로 옆 — 확정하기 전에 미흡한
   부분을 조정하는 흐름이라서.
4. 속도를 위해 "조정 개시"는 그리드 맨 위 상품 1건에만 먼저 테스트하고, "조정 확정"으로 전체 상품에
   반영한다.
5. 모드마다 절차가 완전히 달라(일반모드=자동, 개발자모드=브라우저 수동 조작 필요) 헷갈리기 쉬우므로,
   화면에 지금 몰이 어느 모드인지 배지로 보여주고 모드별 절차를 번호 목록으로 안내하며, 앞 단계를
   마치기 전엔 다음 버튼이 비활성화되게 한다.
6. **만족할 때까지 몇 번이든 반복**할 수 있어야 한다 — "조정 개시"(및 개발자모드의 "재기동")는 한 번
   쓰고 끝이 아니라 재사용 가능해야 하고, "조정 확정"은 사용자가 결과에 만족한 뒤에만 누르는 별개의
   마지막 단계다.
7. 모달이 뒤 그리드를 가려 비교하기 불편하므로, 드래그로 옮길 수 있어야 한다.

## 설계

### 공통 계약 — `lib/scrape/adjustment.ts`의 `runAdjustment()`

"AI 호출 → 그 몰의 영구 규칙으로 저장"하는 핵심 로직은 이 함수 하나뿐이다. 어떤 스크랩 방식이든 이
함수만 호출하면 되고, 모드별로 다른 건 딱 두 가지뿐이다:
- **(a) 페이지 확보**: 조정하려는 상품 1건의 실제 페이지 내용을 어떻게 구하는지
  (일반모드=`lib/scraper.ts`의 `fetchPageText`로 Playwright 재방문, 개발자모드=확장이 우클릭 캡처)
- **(c) 재적용**: 규칙 갱신 뒤 이미 스크랩된 데이터에 어떻게 반영하는지
  (일반모드=`lib/scrape/reextract.ts`의 `reExtractStagingItems`로 제자리 UPDATE, 개발자모드=확장을
  다시 실행해 새 세션으로 재수집)

페이지 원문 HTML은 DB에 영구 저장하지 않는다 — 조정 순간에만 잠깐 오가고 버려진다.

### 데이터 모델

`sites`에 컬럼 2개 추가(`lib/db.ts`):
- `extraction_rules JSONB DEFAULT '{}'` — `{ [field]: { type: 'label', pattern: string } | { type: 'selector', value: string } }`.
  `label`은 dt/dd·표 라벨(이번에 `lib/extract.ts`에 새로 만든 `infoRows` 스캔)에서 정규식으로 찾고,
  `selector`는 CSS 셀렉터로 직접 읽는다. 기존 `custom_name_selector` 등 3개 컬럼과 별개로 두고 하위 호환.
- `pending_adjustment_prompt TEXT` — 개발자모드 1단계(프롬프트 저장)와 2단계(확장 캡처) 사이에 잠깐
  들고 있는 값, 캡처가 오면 즉시 소비되고 비워진다.

### AI 규칙 생성 — `lib/ai.ts`의 `generateExtractionRules()`

`generateTransformColumns`(Transform 기능)와 같은 tool-call 강제 JSON 패턴. 몰 이름·사용자 프롬프트·
현재(잘못됐을 수 있는) 값·실제 페이지 텍스트를 주고, 확신하는 필드에만 `{type, value}` 규칙을 채워
받는다 — 확신 없는 필드는 절대 넣지 않도록 프롬프트에 명시.

### 추출 로직 반영 (최우선 순위)

`lib/extract.ts`의 `extractProductRuleBased`가 새 `extractionRules` 파라미터를 받아 ld+json/라벨스캔/
일반폴백보다 나중에(=가장 높은 우선순위로) 적용한다. `lib/scrape/run.ts`가 스크랩 실행 시마다
`sites.extraction_rules`를 같이 읽어 넘긴다. 확장(`extension-poc/background.js`)도 `/api/sites/resolve`
응답에 포함된 `extractionRules`를 받아 `buildExtractExpr(rules)`로 같은 원칙(라벨/셀렉터 매칭)을
그대로 적용 — 두 구현이 갈라지지 않게 로직 모양을 맞춤.

### 백엔드 라우트

- `POST /api/sites/[id]/adjust` — 일반모드 "조정 개시". body `{itemId, prompt}` → 그 상품 페이지를
  Playwright로 다시 열어 `runAdjustment` 호출 → 그 항목 1건만 `reExtractStagingItems`로 재추출.
- `POST /api/sites/[id]/adjust/confirm` — 일반모드 "조정 확정". body `{sessionId}` → 이미 저장된 규칙을
  그대로(AI 재호출 없이) 그 세션의 미확정 항목 전체에 `reExtractStagingItems` 적용.
- `POST /api/sites/[id]/adjust/prompt` — 개발자모드 1단계. body `{prompt}` → `pending_adjustment_prompt`
  저장만.
- `POST /api/sites/[id]/adjust/capture` — 개발자모드 2단계, **공개 경로**(확장이 세션 쿠키 없이 호출,
  `proxy.ts`의 `PUBLIC_API_PREFIXES`에 정규식으로 추가: `/^\/api\/sites\/\d+\/adjust\/capture$/`). body
  `{url, html}` → `pending_adjustment_prompt` 소비해 `runAdjustment` 호출 후 비움.

### 확장 — 우클릭 메뉴 "PTP 조정 반영"

`manifest.json`에 `contextMenus` 권한 추가. `chrome.contextMenus.onClicked`에서 탭 도메인으로 siteId
확인 → `chrome.debugger`로 `document.documentElement.outerHTML`(길이 제한) 캡처 → `/adjust/capture`로
전송. 안전 경계: 이 기능은 페이지를 읽기만 하고, 스크랩 실행(옵션 select 조작 등)과 달리 페이지에
어떤 입력도 하지 않는다.

### 프런트엔드 UI

`components/panels/shared/StagingItemsGrid.tsx`의 "확정(스크랩검수 후)" 버튼 옆에 "🔧 스크랩 조정" 추가
(siteId를 넘겨받은 화면에만 표시 — 지금은 `ProductsListPanel`뿐). 모달은 **전체화면 백드롭 없이** 뜨고,
**드래그로 옮길 수 있다**(제목 영역 `onMouseDown` → `mousemove`/`mouseup`로 `left/top` 갱신, 뒤 그리드와
비교하며 볼 수 있도록 — `StagingItemsGrid`의 컬럼 리사이즈 드래그와 같은 패턴). 모달을 다시 열 때마다
위치는 초기화된다.

- 제목 옆에 "🤖 일반모드"/"🧩 개발자모드" 배지로 지금 모드를 바로 알림.
- 모드별 안내를 번호 목록으로 각각 따로 보여줌(일반모드 3단계/개발자모드 4단계 — 공용 문구로 뭉뚱그리지
  않음).
- 그리드 맨 위(`visibleItems[0]`)의 현재 값(가격/공급가/배송비/카테고리) + 몰 페이지 링크 표시.
- 개발자모드에서는 "지금까지 학습된 규칙"(`sites.extraction_rules`, "개발자모드 재기동"으로 받아온 값)도
  같이 보여줘 지금까지 뭐가 반영됐는지 확인할 수 있다.
- 버튼: **스크랩 조정 개시**(프롬프트가 비어있지 않으면 언제든 다시 눌러도 됨 — 일반모드=대표 1건 재추출
  테스트, 개발자모드=프롬프트만 저장), 개발자모드에서만 추가로 **개발자모드 재기동**(사용자가 실제
  브라우저에서 확장 우클릭 캡처를 마친 뒤 누르면 `GET /api/sites/[id]`로 갱신된 `extraction_rules`를
  가져와 화면에 반영). 이 두 버튼은 **몇 번이든 반복** 가능 — "조정 개시"가 "확정"의 선행조건으로
  잠기지 않는다.
- 별도 줄에 **조정 확정(만족스러우면)** — 사용자가 결과에 만족했다고 판단한 뒤에만 누르는 마지막 단계.
  최소 한 번은 조정 개시(또는 재기동)를 거쳐야 활성화된다(`adjustRoundCount > 0`). 일반모드는 바로
  `/adjust/confirm`로 전체 재추출, 개발자모드는 `confirm()` 대화상자 없이 "확장으로 다시 스크랩해달라"는
  안내 메시지만 띄운다(재기동이 이미 체크포인트 역할을 하므로 이중 확인이 불필요).

## 하지 않는 것 (알려진 한계)

- 개발자모드의 "확정"은 새 세션으로 다시 스크랩하는 것이지 기존 행을 제자리에서 못 고친다(확장의 수집
  경로가 항상 새 INSERT라서).
- 페이지 원문 HTML은 어디에도 영구 저장하지 않는다.
- 규칙은 필드당 하나(라벨 또는 셀렉터)뿐 — 신우의 AJAX 옵션 캐스케이드처럼 복잡한 몰별 로직은 이
  규칙 시스템 밖(코드로 직접 구현)에 남아있다.

## 관련 파일

- `lib/db.ts`: `sites.extraction_rules`/`pending_adjustment_prompt`
- `lib/ai.ts`: `ExtractedProduct.cost_price/shipping_fee`, `generateExtractionRules`
- `lib/extract.ts`: `infoRows`에 `<dl>` 스캔 추가, `extractionRules` 최우선 적용, cost_price/shipping_fee/
  category 폴백
- `lib/scrape/adjustment.ts`(신규): `runAdjustment` 공용 계약
- `lib/scrape/reextract.ts`(신규): `reExtractStagingItems`
- `lib/scrape/run.ts`, `lib/scraper.ts`: `extractionRules` 스크랩 옵션에 threading, `fetchPageText`
- `lib/master/migrate.ts`: `product_master.cost_price/shipping_fee` 반영(raw_data에서 꺼냄)
- `app/api/sites/[id]/adjust/*`(신규 4개 라우트), `app/api/sites/resolve/route.ts`(extractionRules 포함),
  `proxy.ts`(adjust/capture 공개 경로)
- `extension-poc/background.js`, `manifest.json`: 라벨/캐스케이드 추출, 우클릭 메뉴
- `components/panels/shared/StagingItemsGrid.tsx`, `ProductsListPanel.tsx`

## 상태

**구현 완료.** 커밋 `56e71d2`(최초 2버튼 버전) → `c627f68`(반복 가능한 라운드 구조로 재설계: "개발자모드
재기동" 추가, "조정 확정"을 `adjustRoundCount` 기반 게이팅으로 전환, `GET /api/sites/[id]`가
`extraction_rules` 반환하도록 확장) → `bc7baac`(모달 드래그 이동 지원, 전체화면 백드롭 제거).

일반모드 라우트는 curl로 검증(대상 조회·에러 전파·확정 로직 정상 동작 확인 — 다만 테스트 시점에 시즌백
사이트의 실제 Playwright 재추출 자체가 이 기능과 무관한 사유로 막혀있어 "성공" 케이스까지는 못 봄, 재확인
필요). 개발자모드 우클릭 캡처 → 재기동 → 확정 전체 흐름은 사용자 실사용 확인 대기 중.
