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

### 정밀 타겟팅 — "방금 스크랩한 세션"을 정확히 조준

기존엔 개발자모드 확장이 "이 몰에서 가장 최근에 스크랩된 미확정 상품"을 URL만으로 찾아 캡처 대상으로
삼았는데, 같은 URL이 여러 세션에 걸쳐 재수집돼 있으면 어떤 걸 봐야 할지 모호했다(다른 세션이 그 사이에
`running` 상태로 끼어들면 특히). `sites.pending_adjustment_item_id INT` 컬럼을 추가해, "조정 개시" 시점에
화면(`StagingItemsGrid`)에 실제로 보이던 그리드 맨 위 상품(`visibleItems[0].id`)을 같이 저장한다.

- `POST /api/sites/[id]/adjust/prompt` — body에 `itemId`도 받아 `pending_adjustment_item_id`로 저장.
- `GET /api/sites/[id]/adjust/target` — 확장이 우클릭 전에 "어느 페이지로 이동해 캡처할지" 물어보는 라우트.
  `pending_adjustment_item_id`가 있으면 그 정확한 행의 `source_url`을 반환하고, 없을 때만(예전 데이터·
  API 직접 호출 등) 기존 방식(그 몰에서 가장 최근 `pending` 상품)으로 대체.
- `POST /api/sites/[id]/adjust/capture` — `currentValues` 조회도 동일하게 `pending_adjustment_item_id`가
  있으면 `WHERE id=$1 AND site_id=$2`로 그 행을 정확히 집어 우선 사용.

live 검증: `pending_adjustment_item_id`를 다른(더 오래된) 세션의 항목으로 수동 지정한 뒤
`curl /api/sites/4/adjust/target` 호출 → 그 세션이 실제로 `running` 상태인 다른 세션이 있는 상황에서도
지정된 옛 항목의 URL을 정확히 반환하는 것을 확인.

### 커스텀 필드 — 8개 고정 필드를 벗어난 새 컬럼 학습

"스크랩 조정"으로 기존 8개 필드(name/price/cost_price/shipping_fee/category/brand/manufacturer/origin) 밖의
새 필드(예: "품번" 같은 몰 고유 항목)를 프롬프트로("'품번' 필드 추가" 같은 형식) 지시하면, AI가
`ExtractedProduct.custom_fields: Record<string,string>`에 담아 학습한다.

- `generateExtractionRules`의 tool 스키마는 `rules`에 `additionalProperties: ruleSchema`를 둬 임의 필드명을
  허용하되, 실사용 테스트 결과 `additionalProperties`만으로는 모델이 사용자가 지정한 정확한 필드명을
  안정적으로 쓰지 않는 경우가 있었다 — 프롬프트가 `/^'([^']+)' 필드 추가/` 패턴과 일치하면 그 필드명을
  스키마 `properties`에 직접 주입해 강제한다.
- `lib/master/migrate.ts`가 `raw_data.custom_fields`를 `product_master.custom_fields`에
  `COALESCE(...) || $N::jsonb`로 병합(Transform 기능의 기존 병합 컨벤션과 동일).
- `StagingItemsGrid`가 `items`에서 등장하는 모든 custom_fields 키를 스캔해 `custom_${key}` 컬럼을 동적으로
  그리드에 추가.

## 확장 (2026-07-21) — "요소 지정": 프롬프트 대신 클릭으로 규칙 생성

사용자 요청: 몰 페이지에서 원하는 값의 위치를 직접 클릭하고 그 자리에서 컬럼명을 타이핑해, 반복적으로
여러 컬럼을 지정할 수 있게 해달라는 것 — AI가 프롬프트+페이지 텍스트를 보고 규칙을 "추측"하는 기존
"스크랩 조정"과 달리, 사용자가 직접 요소를 짚어 규칙을 "확정"하는 대체 생성 경로다. 저장 데이터
(`sites.extraction_rules`, `{type:'label'|'selector', value}`)와 적용 로직(`extractProductRuleBased`)은
완전히 동일 — "스크랩 조정"이 AI로 채우던 자리를 사용자의 클릭이 대신 채울 뿐이라, 새 스키마나 별도
적용 경로가 필요 없었다.

먼저 분석·설계를 거쳐(AskUserQuestion 없이 대안 3가지를 텍스트로 제시 후 "추천대로" 확정) 아래처럼
구현. 사용자가 확정한 방향: 오버레이는 몰 페이지 안에 직접 주입(별도 PTP 패널로 창 전환 필요 없게),
일반모드부터 먼저 만들고 몰 공통정보 페이지 지원·AJAX 캐스케이드 옵션 지정은 다음 단계로 미룸(1단계=
상품페이지 컬럼 지정만 구현).

### 동작 방식

- **"🎯 요소 지정" 버튼**(`ScraperPanel.tsx`, "로그인 확인" 이후에만 노출) → `POST /api/sites/[id]/picker/start`
  → `lib/scraper.ts`의 `startElementPicker(siteId)`가 `openSessions`의 열려있는 실제 로그인 창에 클릭식
  피커를 주입한다.
- **하이라이트**: 마우스오버된 요소에 `outline` 인라인 스타일만 주는 방식(별도 오버레이 박스로 위치를
  동기화할 필요가 없어 가장 단순).
- **클릭 시 라벨 우선 판정**: 클릭된 요소가 `dt/dd`(4단계까지 부모 탐색) 또는 `th/td`(같은 `tr` 안의 `th`)
  구조 안에 있으면 그 라벨 텍스트를 채택(`type:'label'`) — 같은 몰의 다른 상품에서도 라벨 텍스트는
  대체로 그대로라 CSS 셀렉터보다 안정적이라는 게 오늘 하루 종일(펫투비/가방쟁이) 반복 확인된 교훈.
  라벨 구조가 없으면 CSS 셀렉터를 계산(`type:'selector'`) — id가 있으면 그것만, 없으면 태그+클래스(최대
  2개)+형제 중 순번(`:nth-of-type`)을 부모 방향으로 이어붙이며 `document.querySelectorAll(...).length===1`
  로 유일해지는 즉시 멈춘다(최대 6단계).
- **안내 패널**: 몰 페이지 자체 CSS와 충돌하지 않도록 인라인 스타일만 쓰는 `position:fixed` 패널을
  주입. 클릭된 요소의 라벨/셀렉터 미리보기 + 컬럼명 드롭다운(기존 8개 고정 필드를 한글로: 상품명/
  가격(소비자가)/공급가·원가/배송비/카테고리/브랜드/제조사/원산지 + "직접 입력...") + 저장/취소 버튼.
  저장을 누르면 `page.exposeFunction`으로 Node에 노출해둔 `ptpSavePick(payload)`를 호출해 그 자리에서
  `sites.extraction_rules`에 병합·저장 — 반복해서 여러 컬럼을 계속 지정할 수 있다. 패널 자체를 클릭해도
  피킹으로 오인하지 않도록 이벤트에서 패널 영역은 제외.
- **완료**: 패널 안의 "피커 종료" 버튼(로컬 정리만, Node 호출 없음 — 이미 각 저장이 개별적으로 즉시
  반영돼 있어 종료 시 별도로 알릴 게 없다) 또는 PTP 쪽 "요소 지정 종료" 버튼(`POST
  /api/sites/[id]/picker/stop` → `stopElementPicker`가 `window.__ptpPickerTeardown()`을 호출) 둘 다 지원.
- **ScraperPanel 쪽 목록**: 피커가 켜져있는 동안 2초 간격으로 `GET /api/sites/[id]`(이미 `extraction_rules`
  반환)를 폴링해 "지금까지 지정된 컬럼"을 태그 목록으로 보여주고, 태그마다 ✕로 개별 삭제
  (`DELETE /api/sites/[id]/picker/rule`, body `{field}`) 가능.
- `page.exposeFunction`은 같은 `Page` 인스턴스에 같은 이름을 두 번 노출하면 에러가 나므로, 노출한 Page를
  `WeakSet`으로 기억해 "요소 지정 시작"을 여러 번 눌러도 안전하게 했다. 주입 함수 자체도
  `window.__ptpPickerActive` 플래그로 중복 주입을 막는다.

### 검증

격리된(공유 `openSessions`를 안 쓰는) 별도 Playwright 브라우저로 가방쟁이 실제 상품 페이지에 주입
함수를 그대로 실행해 확인: `dt/dd` 라벨 구조 안의 "원산지" 값 클릭 → `{type:'label', value:'원산지'}`로
정확히 저장됨. 라벨 구조가 전혀 없는 `<h3>` 상품명 클릭 → `div.item_detail_tit:nth-of-type(1) > h3`
셀렉터로 정확히 계산됨(유일성 확인 로직이 필요한 깊이에서 멈춤). "피커 종료" 후 리스너·패널 정상 제거
확인.

## 확장 (2026-07-22) — 스크랩 미리보기와 연동 + 로그인 불필요 몰 지원

로그인 아이디를 등록하지 않은 몰(로그인 없이 스크래핑하는 몰)은 "로그인 창 열기/확인" 버튼 자체가
`needsLogin` 조건 안에 있어, 그 뒤에 나오는 "몰 구조 파악"/"요소 지정" 버튼까지 함께 숨겨져 있었다.
로그인 여부와 무관하게 두 버튼을 항상 노출하도록 수정(로그인 불필요 몰은 "몰 페이지 열기/확인"으로
문구만 다르게 표시 — 실제 로그인 시도는 하지 않고 페이지만 연다).

이어서 사용자 요청: "스크랩 미리보기 후 요소 지정을 클릭하면 미리보기에서 스크랩한 컬럼들의 값이
화면에 보이고, 그 부분을 수정처리 하거나 보완할 다른 부분에 대해 지정 후 컬럼을 만드는 프로세스"를
설계 후 구현.

- **"요소 지정" 클릭 시 미리보기가 열어본 그 상품 페이지를 로그인 창에 먼저 띄운다**
  (`handleOpenItem(previewResult.sourceUrl)` 재사용) — 화면에 보이는 미리보기 값과 실제 클릭할 요소가
  항상 같은 상품이 되도록.
- **규칙 저장 시 미리보기 자동 재실행**: 요소 지정 폴링(2초 간격, `refreshPickerRules`)에서
  `extraction_rules`가 바뀐 걸 감지하면 그 상품 하나만(`previewResult.sourceUrl`) 조용히 다시 추출해
  미리보기 테이블을 갱신한다 — 사용자가 직접 "새로고침"을 누르지 않아도 고친 값이 바로 보인다. 첫
  폴링(피커를 막 시작한 시점)에는 "바뀐 것"으로 오인하지 않도록 기준값만 세팅하고 재실행은 건너뛴다.
- **미리보기가 애초에 요소 지정 규칙을 반영하지 않던 버그를 같이 고쳤다**: `app/api/scrape/preview`,
  `preview-catalog` 두 라우트가 `sites.extraction_rules`를 DB에서 조회조차 하지 않고 있었다(실제 스크랩
  경로인 `lib/scrape/run.ts`만 조회해 넘기고 있었음) — 자동 재실행이 의미가 있으려면 먼저 고쳐야 하는
  선행 버그였다. 두 라우트 모두 `run.ts`와 같은 방식으로 조회해 넘기도록 수정.
- **요소 지정 대상 필드 확장**(8개 → 12개): 재고상태(`stock_status`)/재고수량(`stock_qty`)/
  영문상품명(`english_name`)/상품요약정보(`summary_info`) 추가 — 미리보기 테이블에 이미 나오는 필드와
  맞췄다. `lib/extract.ts`의 규칙 적용 분기에도 각 필드의 타입에 맞는 파싱(재고수량은 숫자, 나머지는
  문자열) 추가. 옵션/이미지는 여전히 제외(라벨/셀렉터 하나=값 하나 모델에 안 맞음 — 위 1단계 한계와
  같은 이유).
- **대상은 미리보기의 대표 상품 1건(`previewResult`)만** — 목록의 나머지 상품(`previewItems`, 상세
  페이지를 열어보지 않은 얕은 정보)은 대상에서 제외.

### 버그 수정 — 저장 한 번 하면 피커 패널이 사라지던 문제

위 "저장 시 미리보기 자동 재실행"이 그 자리에서 새 버그를 만들었다: 미리보기 재실행은 피커가 주입된
바로 그 탭을 다시 `page.goto`(리로드)하는데, 인젝션된 패널/리스너는 `page.evaluate`로 그 문서에만
심어져 있어 새 문서로 넘어가면(네비게이션마다) 통째로 사라진다(`exposeFunction`은 Playwright가
페이지 이동에도 유지해주지만 DOM 상태는 아님) — 즉 값 하나 저장하면 미리보기가 재실행→페이지
리로드→피커 소멸까지 이어져 추가 지정이 불가능했다. `startElementPicker`가 그 페이지에
`page.on('load', ...)` 리스너를 등록해두고, 페이지가 새로 로드될 때마다 `injectElementPicker`를 다시
실행하도록 고쳤다(`stopElementPicker`에서 리스너도 같이 정리). 격리된 브라우저로 가방쟁이 실제
페이지에서 리로드 전/후 모두 패널이 살아있는 것을 확인.

### 버그 수정 — "직접 입력" 커스텀 컬럼이 미리보기에 안 보이던 문제

인젝션 패널의 "직접 입력..." 옵션으로 만든 커스텀 컬럼은 저장되면 `ExtractedProduct.custom_fields`에
담기는데, 스크랩 미리보기 화면(`PreviewProduct`)은 `extra_info`만 표시하고 `custom_fields`는 아예
읽지 않고 있었다 — 새로 만든 컬럼이 저장은 되지만 미리보기엔 안 보이는 상태였다. `PreviewProduct`
인터페이스에 `custom_fields`를 추가하고, "직접 지정한 컬럼: " 줄로 표시하도록 수정.

## 확장 (2026-07-22) — 화면에 없는 값은 고정값으로 직접 등록

"스크랩 대상 직접지정"(요소 지정에서 명칭 변경, ScraperPanel.tsx)은 지금까지 페이지 안의 요소를 클릭하는
방식만 있었는데, 택배사처럼 페이지 어디에도 나오지 않지만 그 몰은 항상 같은 값인 필드는 클릭할 대상
자체가 없다. `ExtractionRule.type`에 `'fixed'`를 추가 — 페이지를 전혀 읽지 않고 저장된 value를 모든
상품에 그대로 채운다(`lib/extract.ts`의 규칙 적용 루프에서 `text = rule.value`로 바로 대입, label/selector
분기를 건너뜀).

- **UI**: "스크랩 대상 직접지정" 활성화 중, 지정된 컬럼 목록 아래에 컬럼명(12개 드롭다운 + 직접 입력)
  + 고정 값 입력줄을 추가 — 페이지 클릭 없이 바로 "추가" 가능.
- **API**: `app/api/sites/[id]/picker/rule`에 POST 핸들러 추가(`{field, value}` → `type:'fixed'`로 저장,
  기존 DELETE와 같은 파일).
- 저장 즉시 기존 폴링 기반 미리보기 자동 재실행이 그대로 동작 — 고정값도 "직접 지정한 컬럼" 줄에 곧바로
  나타난다.
- 택배사처럼 8개(→12개) 고정 필드 밖의 이름이면 기존과 동일하게 `custom_fields`로 들어간다.

### 정정 — 미리보기 그리드 컬럼은 "직접지정으로 등록한 필드"만

한 번은 `custom_fields` 전체(직접지정 + 상품정보고시 자동 스캔 라벨 모두)를 그리드 컬럼으로 노출했다가
롤백했다: 유통기한/주문단위/소재 등 자동 스캔 라벨까지 전부 컬럼으로 나오면서 그리드가 너무 산만해졌다
(사용자 피드백: "불필요한 컬럼이 너무 많이 들어갔어"). 사용자가 정정 요청: "ptp-picker-select 작업한
내용에 대해서만" — 즉 `sites.extraction_rules`에 실제로 등록된 필드만 컬럼으로 보이게.

- 프런트의 `pickerRules`(원래는 피커가 켜져있는 동안의 UI 폴링용 상태였음)를 그대로 필터 기준으로 재사용:
  `custom_fields`에서 `label in pickerRules`인 것만 그리드에 헤더+칸으로 추가, 나머지는 예전처럼
  "그 외 자동 스캔된 정보" 텍스트 한 줄로 남긴다.
- 이 필터가 항상 서버 상태와 맞도록, `pickerRules`를 더 이상 "피커를 시작해야만 채워지는 값"이 아니라
  "이 몰의 실제 등록 목록"으로 취급하도록 수정: `selectSite`가 몰 정보 조회 응답의 `extraction_rules`로
  바로 채워두고(추가 요청 없음), `handleConfirmLogin`도 무조건 `{}`로 비우던 것을 `refreshPickerRules()`
  재조회로 바꿨다 — 그래야 이번 접속에서 피커를 아직 한 번도 켜지 않았어도 예전에 등록해둔 컬럼이
  그리드에 바로 반영된다.

## 하지 않는 것 (알려진 한계, 요소 지정 1단계 기준)

- 개발자모드(크롬 확장, `chrome.debugger`)는 아직 지원하지 않는다 — 일반모드(Playwright `openSessions`)만.
  같은 CDP `Runtime.evaluate` 방식으로 확장에도 이식 가능하나 다음 단계.
- 몰 공통 정보 페이지(계좌/택배사 등 상품과 무관한 페이지) 지정은 아직 지원하지 않는다 — 지금은 상품
  상세 페이지의 `extraction_rules`(상품마다 적용)만 대상. 페이지를 이동해도 피커가 재주입되지 않는다.
- AJAX 캐스케이드 옵션(옵션1 선택 시 옵션2가 동적으로 채워지는 것) 지정 기능은 아직 없다 — 기존
  `extractOptionsFromDom`의 캐스케이딩 셀렉트 자동 스캔이 이미 이 패턴을 코드로 처리하고 있어, 다음
  단계에서는 완전히 새로운 매크로 녹화기보다는 "어느 컨트롤이 옵션1/옵션2인지"만 클릭으로 보정하는
  정도로 범위를 좁힐 계획.

## 하지 않는 것 (알려진 한계)

- 개발자모드의 "확정"은 새 세션으로 다시 스크랩하는 것이지 기존 행을 제자리에서 못 고친다(확장의 수집
  경로가 항상 새 INSERT라서).
- 페이지 원문 HTML은 어디에도 영구 저장하지 않는다.
- 규칙은 필드당 하나(라벨 또는 셀렉터)뿐 — 신우의 AJAX 옵션 캐스케이드처럼 복잡한 몰별 로직은 이
  규칙 시스템 밖(코드로 직접 구현)에 남아있다.

## 관련 파일

- `lib/db.ts`: `sites.extraction_rules`/`pending_adjustment_prompt`/`pending_adjustment_item_id`
- `lib/ai.ts`: `ExtractedProduct.cost_price/shipping_fee/custom_fields`, `generateExtractionRules`(동적 필드명
  주입 포함)
- `lib/extract.ts`: `infoRows`에 `<dl>` 스캔 추가, `extractionRules` 최우선 적용, cost_price/shipping_fee/
  category 폴백
- `lib/scrape/adjustment.ts`(신규): `runAdjustment` 공용 계약
- `lib/scrape/reextract.ts`(신규): `reExtractStagingItems`
- `lib/scrape/run.ts`, `lib/scraper.ts`: `extractionRules` 스크랩 옵션에 threading, `fetchPageText`,
  `extractFromHtml`(개발자모드 캡처 미리보기용)
- `lib/master/migrate.ts`: `product_master.cost_price/shipping_fee/custom_fields` 반영(raw_data에서 꺼냄)
- `app/api/sites/[id]/adjust/*`(prompt/capture/target/confirm 4개 라우트), `app/api/sites/resolve/route.ts`
  (extractionRules 포함), `proxy.ts`(adjust 하위 공개 경로)
- `extension-poc/background.js`, `manifest.json`: 라벨/캐스케이드 추출, 우클릭 메뉴
- `components/panels/shared/StagingItemsGrid.tsx`(itemId 전달, custom_${key} 동적 컬럼), `ProductsListPanel.tsx`

## 상태

**구현 완료.** 커밋 `56e71d2`(최초 2버튼 버전) → `c627f68`(반복 가능한 라운드 구조로 재설계: "개발자모드
재기동" 추가, "조정 확정"을 `adjustRoundCount` 기반 게이팅으로 전환, `GET /api/sites/[id]`가
`extraction_rules` 반환하도록 확장) → `bc7baac`(모달 드래그 이동 지원, 전체화면 백드롭 제거) → `a1fba3a`
(커스텀 컬럼 학습 + itemId 정밀 타겟팅 + 공급가 반영).

일반모드 라우트는 curl로 검증(대상 조회·에러 전파·확정 로직 정상 동작 확인 — 다만 테스트 시점에 시즌백
사이트의 실제 Playwright 재추출 자체가 이 기능과 무관한 사유로 막혀있어 "성공" 케이스까지는 못 봄, 재확인
필요). itemId 정밀 타겟팅은 다른 세션 항목을 수동 지정해 `/adjust/target`이 정확히 그 항목을 반환함을 curl로
확인. 개발자모드 우클릭 캡처 → 재기동 → 확정 전체 흐름은 사용자 실사용 확인 대기 중.
