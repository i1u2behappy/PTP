# Mall 스크랩 기본정보(Baseline Profile) 및 변동 알림 — 요구사항 기록

## 배경

스크래핑 로직은 "몰마다 상품페이지 구조가 다르고, 같은 몰 안에서도 상품마다 노출되는 정보가 달라진다"는
전제(`lib/scraper.ts` 상단 주석) 위에서 동작해야 한다. 이 요구사항은 그 전제를 시스템적으로 강제하기 위한
것으로, 사람이 매번 "이 몰은 구조가 어떻더라"를 기억하는 대신 시스템이 몰별 기준 정보를 갖고 있게 한다.

## 요구사항 (사용자 지시 원문 기준, 2026-07-15)

> 새로운 Mall이 등록된 후, 로그인 및 로그인 확인이 된 이후에 최초 1번은 반드시, 몰 내 각 상품마다의
> 다른 부분을 체크해서 해당 Mall의 스크래핑할 기본정보로 가지고 있고, 이 기본정보의 변동사항이 있을
> 경우 알림을 준다.

즉:

1. **트리거**: 새 Mall 등록 → 로그인창 열기 → 로그인 확인 완료(`loginStep === 'confirmed'`) 시점, 해당
   Mall에 대해 아직 기본정보(baseline profile)가 없으면 최초 1회 자동으로 프로파일링을 수행한다.
2. **프로파일링 대상**: 몰 내 여러 상품(카테고리를 넘나드는 샘플)을 열어, 상품마다 달라질 수 있는
   구조적 특성을 체크한다 — 예:
   - 대표이미지/상세이미지 존재 여부 및 통상적인 개수 범위
   - 옵션 UI 형태 (`<select>` 단일/캐스케이딩, 라디오·체크박스, 스와치형 버튼 등 — `scanSelectOptions`/
     `scanSwatchOptions` 결과 형태)
   - 재고 표기 방식 (상품정보고시 표의 "재고" 행 / 품절 배지 텍스트 / 그 외 텍스트 패턴)
   - 상세페이지 구성 (이미지 위주 vs. `#prdDetail` 내 실제 텍스트 콘텐츠 존재 여부)
3. **저장**: 위 특성을 해당 Mall의 "기본 스크랩 프로파일"로 저장한다.
4. **변동 감지 & 알림**: 이후 스크랩(정기 재스크랩 포함) 시 실제 추출 결과가 기존 프로파일과 달라지면
   (예: 항상 있던 상세이미지가 없어짐, 옵션 UI 형태가 바뀜, 재고 표기 방식이 바뀜) 사용자에게 알림을 준다.

## 구현된 설계 결정 (2026-07-15, "최적의 안으로 구현해" 지시에 따른 최종 선택)

- **샘플링 범위/개수**: 로그인 확인 시점에 열려있는 페이지를 목록으로 간주해 `collectProductUrls`로 상품
  링크를 모으고, 그중 최대 6개(`MALL_PROFILE_SAMPLE_SIZE`)를 순서대로 샘플링한다. 목록으로 인식되지 않으면
  (상품 링크 0개) 현재 페이지 자체를 상품 1건으로 취급한다. 카테고리별 안배는 하지 않음 — 단순 선착순 6개.
- **저장 위치**: 별도 테이블 대신 `sites.scrape_profile JSONB` + `sites.scrape_profile_updated_at`
  컬럼에 저장 (몰당 프로파일 1개뿐이라 1:1 관계 — 별도 테이블은 과함).
- **비교/판정 기준**: 통계적 범위 대신 "있다/없다"류 구조적 신호만 비교 (개수 자체는 노이즈가 많아 제외):
  대표이미지 유무, 상세이미지 유무, 상세페이지 텍스트 유무, 옵션 UI 형태(select/swatch/none 집합),
  재고수량표시 유무, 재고상태문구 유무. `lib/scraper.ts`의 `MallProfileSignals`/`profileMallStructure()`,
  `lib/scrape/mallProfile.ts`의 `describeDiff()` 참고.
- **알림 노출 위치**: 새 UI를 만들지 않고 기존 `site_memos` 테이블(Mall 목록의 "메모" 컬럼)에 자동으로
  메모를 남긴다 — 최초 프로파일링 완료 시 "🔍 상품페이지 구조 파악 완료: ...", 이후 구조가 달라졌을 때만
  "⚠ 상품페이지 구조 변경 감지: ..." 형태로.
- **재실행 조건**: 별도의 수동 재프로파일링 버튼은 만들지 않음 — "로그인 확인"을 누를 때마다
  (`app/api/scrape/login-confirm/route.ts`) 백그라운드로 매번 재확인하고, 기준정보가 없으면 최초 저장,
  있으면 비교 후 달라진 경우만 알린다. 응답 지연을 막기 위해 결과를 기다리지 않고(fire-and-forget) 실행한다.

## 구현 시 관련 기존 코드

- `lib/scraper.ts`: `loginIfNeeded`, `previewCatalog`, `collectProductUrls`, `scanSelectOptions`,
  `scanSwatchOptions`, `extractOptionsFromDom` — 프로파일링 시 재사용 가능한 추출 유틸.
  파일 상단의 "가장 중요한 전제조건" 주석이 이 기능의 근거.
- `lib/extract.ts`: `extractProductRuleBased`, `scrapePageData` — 상품 1건 구조 특성 추출.
  `resolveStockQty`/`extractStockStatus` — 재고 표기 방식 판정에 참고.
- `components/panels/ScraperPanel.tsx`의 `loginStep === 'confirmed'` 처리부 — 트리거 지점 후보.
- `lib/db.ts`의 `sites` 테이블 — baseline 저장 컬럼/테이블 추가 시 수정 지점.

## 상태

**구현 완료 (2026-07-15).** 아래 파일 참고:
- `lib/scraper.ts`: `MallProfileSignals`, `profileMallStructure()`
- `lib/scrape/mallProfile.ts`: `runMallProfileCheck()` (비교 + `site_memos` 알림)
- `app/api/scrape/login-confirm/route.ts`: 트리거 지점
- `lib/db.ts`: `sites.scrape_profile` / `sites.scrape_profile_updated_at`

## 보완 (2026-07-17) — 로그인 확인 없이 도는 예약 스크랩도 감지하도록

기존엔 트리거가 "로그인 확인" 시점 하나뿐이라, 이미 로그인 세션이 남아있어 로그인 확인 없이 바로
스크랩(예약 스크랩 포함)만 도는 몰은 구조 변경을 영영 감지하지 못했다. 발견 경위: 사용자가 "각 mall을
등록한 후 첫 스크래핑을 하면... 이 기능이 반영되어 있는지 확인해달라"고 해 Explore 서브에이전트로
점검한 결과 이 gap과, 수동 로그인 몰에서 프로파일링이 조용히 실패하는 gap 두 가지를 발견했다.

- `lib/scraper.ts`: 기존 `profileMallStructure(siteId)`의 페이지 샘플링 로직을
  `sampleMallProfile(page, startUrl)`로 분리하고, 스크랩 옵션(`ScrapeOptions`)을 받아 `withContext`로
  페이지를 연 뒤 같은 샘플링을 수행하는 `profileMallStructureForScrape(opts)`를 추가했다. 시작 URL은
  `opts.url` → `opts.categoryUrls[0]` → `opts.productUrls[0]` 순으로 정한다(첫 값만 있으면 `page.url()`이
  `about:blank`라 아무 것도 못 읽고 조용히 실패하는 버그가 있었음 — 실제 스크랩 세션으로 재현/수정 확인).
- `lib/scrape/mallProfile.ts`: 비교+`site_memos` 기록 로직을 `applyProfileResult(siteId, next)`로 분리하고,
  `runMallProfileCheckForScrape(opts)` = `profileMallStructureForScrape` + `applyProfileResult`를 추가.
- `lib/scrape/run.ts`: 실제 스크랩 로직 직전에 `await runMallProfileCheckForScrape(scrapeOpts).catch(...)`를
  호출한다. **반드시 await**해야 한다 — fire-and-forget으로 두면 이 체크와 뒤이은 실제 스크랩이 동시에
  같은 프로필 디렉터리에 `launchPersistentContext`를 시도해 경합할 수 있다(수동 로그인 몰은 실제 개인
  Chrome 프로필을 공유하므로 특히 위험).
- 검증: 실제 몰(걸스굽, site 1)에 두 차례 실제 스크랩을 걸어 `scrape_profile_updated_at`/`site_memos`가
  올바르게 갱신됨을 `docker exec ... psql`로 확인 후, 테스트로 생성된 세션/메모 데이터는 삭제해 정리.

## 확장 (2026-07-20) — 수동 "몰 구조 파악" 버튼 + 카테고리/플랫폼 신호 + AI 컨텍스트 주입

기존엔 로그인 확인마다 완전히 조용히 도는 자동 체크뿐이라 사용자가 결과를 바로 볼 방법이 없었고,
상품 구조만 봤지 카테고리 구조나 어떤 구축 플랫폼인지는 몰랐다. 사용자 요청: 신규 몰 등록 → 로그인
확인 후 "몰 구조 파악" 버튼으로 즉시 실행+결과 확인 가능하게 하고, 그 결과(카테고리/상품 구조)가
이후 작업(AI 추출규칙 생성)에 실제로 반영되게 해달라는 것.

사용자가 확정한 방향:
1. 기존 자동 체크(로그인 확인마다 조용히)는 그대로 두고, 버튼은 "직접 실행+결과 화면 표시"용으로 추가.
2. "반영"은 AI가 추출규칙(스크랩 조정)을 생성할 때 이 몰의 알려진 구조를 프롬프트 컨텍스트로 자동
   주입하는 것을 의미 — 코드가 구조에 따라 자동으로 선택자를 바꾸는 것까지는 아님.

### 신호 확장 — `MallProfileSignals`(`lib/scraper.ts`)

- `platform: MallPlatform` — `collectProductUrls`가 이미 계산해두는 값을 재사용(새 페이지 방문 없음).
  카탈로그로 인식 못 해 못 얻으면(상품 상세 1건짜리 폴백일 때) `detectMallPlatform(page)`로 한 번 더 시도.
- `sampleProductUrl: string` — 샘플링에 실제로 쓴 상품 URL 1건. 나중에 이 몰을 다시 손볼 때(코드 수정,
  AI가 참고) 바로 열어볼 수 있는 참고용 — 매번 처음부터 카테고리를 찾아 들어갈 필요가 없다.
- `categoryPaths: string[]` / `categoryMaxDepth: number` — `collectProductUrls`가 상품 링크 수집 시
  이미 계산해두는 `categoryByUrl`(목록 페이지 브레드크럼)을 재사용해, 샘플링된 상품들의 카테고리 경로를
  모은다. **전체 카테고리 트리를 크롤링하는 게 아니다** — 샘플(최대 6개) 상품이 속한 경로만 아는 근사치.
  전체 트리를 걸으려면 카테고리 내비게이션 메뉴 자체를 파싱해야 하는데, 몰마다 마크업이 완전히 달라
  일반화하기 어려워 이번 범위에서 뺐다(하지 않는 것 참고).

### 수동 실행 — "몰 구조 파악" 버튼

- `lib/scrape/mallProfile.ts`: `applyProfileResult`/`runMallProfileCheck`/`runMallProfileCheckForScrape`가
  `void` 대신 `ProfileCheckResult { signals, diffs, isFirstTime }`를 반환하도록 변경 — 기존 fire-and-forget
  호출부(`login-confirm`, `lib/scrape/run.ts`)는 반환값을 그냥 버리므로 영향 없음.
- `app/api/sites/[id]/profile/route.ts`(신규): `runMallProfileCheck(siteId)`를 그대로 재사용해 즉시 실행
  하고 결과를 응답으로 돌려준다 — 새 로직을 만들지 않고 기존 자동 체크와 완전히 같은 경로를 태움.
- `components/panels/ScraperPanel.tsx`: 로그인 확인 버튼 옆에 "🔍 몰 구조 파악" 버튼 추가(`loginStep ===
  'confirmed'`일 때만), 결과를 플랫폼/카테고리 단계/옵션 UI/재고 표기 방식 등으로 요약해 카드 형태로 표시.

### AI 컨텍스트 주입

- `lib/ai.ts`의 `generateExtractionRules`가 `mallProfile?: Record<string, unknown> | null` 파라미터를
  추가로 받아 프롬프트에 "미리 확인해둔 정보(참고만, 실제 페이지가 우선)"로 포함한다.
- `lib/scrape/adjustment.ts`의 `runAdjustment`가 `sites.scrape_profile`을 같이 조회해 그대로 전달한다 —
  "스크랩 조정" 기능이 AI로 규칙을 생성할 때마다 자동으로 이 몰의 알려진 구조를 참고하게 된다.

## 하지 않는 것 (알려진 한계, 확장분)

- 카테고리 구조는 샘플 상품들의 브레드크럼 기준 근사치일 뿐, 카테고리 내비게이션 전체를 크롤링해
  정확한 트리(노드 수 등)를 만들지 않는다 — 단, 고도몰은 예외(아래 참고).
- 코드가 파악된 구조에 따라 스스로 선택자/로직을 바꾸는 자동화는 없다 — AI 프롬프트 컨텍스트로만 쓰인다.
- "몰 구조 파악" 버튼은 로그인 창(openSessions)이 열려있어야 동작한다(기존 자동 체크와 같은 제약).

## 보완 (2026-07-20) — 펫투비(고도몰) 실사용 중 발견된 정확도 문제

사용자가 실제로 "몰 구조 파악" 버튼을 눌러보니 대표/상세이미지·카테고리가 전부 "없음"으로 나왔다 —
플랫폼(고도몰)과 상품 URL은 정확히 찾았는데, 정작 그 상품 페이지 내용을 못 읽고 있었던 것. 사용자가
로그인한 실제 상품페이지 HTML(F12 → Copy outerHTML)을 받아 원인을 확인:

- **대표이미지**: 고도몰은 og:image/ld+json 없이 `#objImg`(`.img_big` 안)라는 자체 마크업을 쓴다 —
  기존 폴백(`#bigimage`, 신우 전용)에 `#objImg, .img_big img`를 추가.
- **카테고리 브레드크럼**: 고도몰은 `.path` 클래스에 `<li>` 없이 "HOME &gt; 강아지 &gt; 간식 &gt; 덴탈껌"
  처럼 평문 텍스트+`>` 구분자로만 되어 있다. `.path`를 후보에 추가하고, `<li>` 없는 브레드크럼은 `>`가
  있으면 그걸로(없으면 기존처럼 `/`로) 나누고 맨 앞의 "HOME/홈" 루트 라벨은 제외하도록 파싱 로직 보강.
- **카테고리 메뉴 전체 스캔(신규)**: 고도몰은 헤더 내비게이션(`.cate` 대분류, `.ovmenu` 중분류)에 카테고리
  전체가 항상 노출되어 있다 — 상품을 하나하나 열어보지 않고도 `scanCategoryMenu()`가 그 자리에서 전체
  카테고리명을 긁어온다. `MallProfileSignals.categoryMenuNames`로 저장, 있으면 화면/요약이 이걸
  우선하고 없으면(다른 플랫폼) 기존 샘플 기반 `categoryPaths`로 대신한다. **아직 고도몰만 지원** —
  다른 플랫폼은 실제 마크업이 확인되는 대로 `scanCategoryMenu`에 분기를 추가하면 된다.

### 마무리 — 사용자가 HTML을 붙여넣는 방식의 한계로 직접 로그인해 확인

사용자가 브라우저에서 페이지 HTML을 여러 차례 붙여넣어 줬으나 상세설명 영역 도달 전에 매번 5만자
제한에 걸려 못 받았다. 사용자가 "모두 직접 몰 구석구석 돌면서 직접 확인해"라고 지시 — DB에 이미
암호화 저장돼 있던 이 몰의 실제 로그인 자격증명(`sites.login_pw_encrypted`/`login_pw_iv`,
`lib/db.ts`의 `decryptSecret`과 같은 AES-256-GCM 로직)을 복호화해, Playwright 헤드리스 브라우저로
직접 로그인 후 카테고리/상품/공지사항/이용안내 페이지를 읽기 전용으로 열람(장바구니 담기·주문 등 상태
변경 동작은 전혀 하지 않음)해 나머지를 확인했다.

- **일반모드 자동 로그인이 실제로 된다** — 이 몰은 애초에 개발자모드가 필요 없었을 수도 있다(2026-07-20
  중 이미 의심됐던 부분이 확정됨). 표준 아이디/비번 폼이라 `loginIfNeeded`가 그대로 통과, 이전에 고친
  로그인 후 지연 리다이렉트 대응(`networkidle` 대기)도 문제없이 작동했다.
- **상세이미지 컨테이너**: `.view_detail`(`id="contents"`) — `#prdDetail`/`.detail_con` 폴백에 추가.
  실제 페이지에서 대표이미지/상세이미지/카테고리 전부 정상 인식되는 것까지 실제 로그인 세션으로 최종 검증.
- **택배사**: 공지사항 게시판(`board/list.php?id=notice`)의 "[05/26] 택배사 변경 안내" 글에서 확인 —
  "한진택배에서 CJ 대한통운으로 변경". 구조화된 필드가 아니라 게시글 본문 텍스트다.
- **거래은행/계좌번호**: "이용안내"(`shop/service/guide.php`) 페이지를 확인했으나, 이 몰은 고도몰
  스킨의 기본 안내문구를 커스터마이징하지 않은 채 그대로 쓰고 있어 "무통장 입금 가능 은행 - OO은행,
  OO은행"처럼 자리표시자(OO)만 있고 실제 은행명/계좌번호는 어디에도 게시돼 있지 않다. 실제 계좌번호는
  결제수단으로 "무통장 입금"을 선택하는 실제 주문 단계에서만 나올 가능성이 높은데, 그건 실제 주문을
  만들어야 확인되는 것이라(상태 변경 행위) 이번 조사 범위에서 의도적으로 시도하지 않았다.

## 하지 않는 것 (알려진 한계, 최종)

- 거래은행/계좌번호는 자동으로 알아낼 방법이 없다(펫투비는 게시돼 있지 않음, 결제 단계 진입 필요) —
  몰마다 있을 수도 없을 수도 있어 일반화된 자동 수집 대상으로 넣지 않는다.
- 카테고리 메뉴 전체 스캔은 고도몰만 지원(위 참고).
- ~~"몰 구조 파악"은 여전히 상품 구조까지만 다룬다 — 공지사항·이용안내는 매번 자동으로 훑지 않는다~~ →
  아래 2026-07-20(2차) 확장으로 뒤집힘: 이제 매번 공지/이용안내 등 안내성 게시판도 훑는다.

## 전면 재설계 (2026-07-20, 2차) — 8개 항목 AI 리포트 + "열려있던 페이지 아무거나" 버그 수정

바로 위 확장판(boolean 신호 나열: "대표이미지 있음/옵션 select" 등)을 실제로 써본 사용자 피드백:
"정말 불필요하고 맞지도 않은 내용들을 나열했어. URL 계층/카테고리 구조/결제계좌/택배사/재고 관리 형태/
업체 연락처/상품페이지 주요 구조/스크래핑 필요 데이터를 파악하는 것으로 개발한 것인데" — 즉 boolean
신호 방식 자체가 요청과 맞지 않았다. 전면 재설계함.

### 새 방식 — 원문을 실제로 모아 AI가 8개 항목을 채움

- `lib/scraper.ts`의 `gatherMallContextText(page)`(신규): 상품 샘플로 넘어가기 전, 지금 페이지(홈/목록)의
  하단 회사정보(footer/.company_info)와, "배송/반품/교환/환불/이용안내/공지/고객센터/무통장/계좌/입금안내"
  키워드가 붙은 링크(`findInfoPageLinks`, 최대 4개)를 실제로 열어 텍스트를 모은다 — 결제계좌/택배사/
  연락처는 상품페이지가 아니라 이런 정적 페이지에 있다는 게 위 절(펫투비 직접 로그인 조사)에서 이미
  확인된 사실이라, 이번엔 그 조사 과정 자체를 코드로 자동화했다.
- 샘플 상품 1건의 본문 텍스트(`productContextText`, 토큰 절약을 위해 첫 성공 샘플만)를 더한다.
- `lib/ai.ts`의 `generateMallProfileReport(mallName, platform, categoryHints, sampleProductUrl, contextText)`
  (신규): 모은 원문만 근거로 `MallStructureReport`(`urlHierarchy`/`categoryStructure`/`paymentAccount`/
  `shippingCourier`/`stockManagementType`/`companyContact`/`productPageStructure`/`scrapingNeeds`, 전부
  string) 8개 항목을 tool-call로 강제 채운다. **원문에 없으면 반드시 "확인 안됨"이라고만 답하도록
  프롬프트에서 명시** — 추측으로 지어내지 못하게 막는 것이 이번 재설계의 핵심(과거 boolean 신호도 부정확
  했던 게 문제였는데, 자유 서술형은 더 쉽게 그럴듯하게 지어낼 수 있어 훨씬 중요).
- `MallProfileSignals.report: MallStructureReport | null` — ANTHROPIC_API_KEY 미설정이거나 원문을 하나도
  못 모으면 null. 기존 boolean 신호(`hasMainImages` 등)와 `categoryMenuNames`/`categoryPaths`는 그대로
  유지 — 화면 하단에 "참고정보" 태그로만 축소 노출, `describeDiff`의 드리프트 비교에도 계속 쓰인다.
- `components/panels/ScraperPanel.tsx`: 화면을 boolean 나열 대신 8개 항목 카드 그리드로 전면 교체
  (아이콘+라벨+값, "확인 안됨"은 흐리게 표시해 실제로 못 찾은 것과 구분).

### 발견된 버그 — "로그인 확인 시점에 열려있던 페이지"를 무조건 기준으로 삼던 문제

재설계 후 첫 실사용(펫투비)에서 카테고리/이미지가 전부 비어 나와 원인을 DB(`sites.scrape_profile`)로
직접 확인한 결과, `sampleProductUrl`이 `shop/member/myinfo.php`(마이페이지)였다 — 로그인 확인 시점에
브라우저 창이 마이페이지에 가 있었는데, 기존 `profileMallStructure`가 "지금 열려있는 페이지 = 이 몰의
대표 페이지"라고 그대로 믿고 시작한 게 원인. 로그인 실패도, 코드 미반영도 아니었다. 연쇄 증상:
마이페이지엔 고도몰 감지 단서가 없어 `platform: unknown` → 상품 URL 필터(`goods_view.php?goodsno=`
패턴)가 없어져 "이미지 있는 링크는 다 상품"으로 취급하는 폴백 발동 → 마이페이지 사이드 위젯(최근 본
상품/장바구니 아이콘)을 상품으로 오인해 `infoLabels`에 "장바구니 담기" 같은 위젯 텍스트가 섞여 들어감,
`categoryMenuNames`도 (godomall 분기라 platform=unknown이면 스킵) 빈 배열.

**수정**: `profileMallStructure(siteId)`가 이제 프로파일링 시작 전 항상 `sites.url`(등록된 정식 시작
URL)로 먼저 `page.goto` — 로그인 확인 시점에 사용자가 마이페이지든 다른 화면이든 보고 있어도 영향받지
않는다. `sites.url`이 비어있으면(드묾) 기존처럼 지금 페이지를 그대로 쓴다. `siteInfo(siteId)`가
`name`과 `url`을 한 번에 조회하도록 기존 `siteName` 헬퍼를 대체.

## 용도 분리 (2026-07-20, 3차) — "로그인 확인"과 "몰 구조 파악"은 서로 다른 기능

2차 재설계 직후, 사용자가 실제로 "로그인 확인"을 눌렀더니 브라우저가 홈→안내페이지 여러 개→상품
샘플까지 우르르 열어보는 걸 보고 "무슨 작업을 한 거냐"고 물었다. 원인: `login-confirm` 라우트가 매번
자동으로 부르는 `runMallProfileCheck`와, "몰 구조 파악" 버튼이 부르는 함수가 **완전히 같은 경로**라
2차 재설계의 무거운 작업(하단 회사정보/안내 게시판 크롤링 + AI 8개 항목 리포트)이 로그인 확인 시점마다
매번 같이 돌고 있었던 것.

사용자 지시로 용도를 명확히 분리:
- **"로그인 확인"**(자동, 조용히) = 상품페이지/홈페이지 **구조 변화 감지 전용**. 대표/상세이미지 유무,
  옵션 UI 형태, 재고 표기 방식, 카테고리 등 기존 boolean 신호만 다시 확인하고 달라진 점만 site_memos에
  알린다 — 하단 회사정보/안내 게시판을 훑거나 AI 리포트를 만드는 무거운 작업은 하지 않는다.
- **"몰 구조 파악" 버튼**(수동) = 결제계좌/택배사/업체연락처/URL 계층 등 **거래정보 분석 전용**. 안내
  게시판 크롤링 + AI 8개 항목 리포트는 이제 여기서만 돈다.

### 구현

- `lib/scraper.ts`: `sampleMallProfile`에 `deep: boolean` 파라미터 추가 — `gatherMallContextText`/
  `generateMallProfileReport` 호출은 `deep === true`일 때만 실행한다. `profileMallStructure(siteId, deep
  = false)`가 그대로 전달, `profileMallStructureForScrape`(스크랩 시작 자동 체크)는 항상 `false` 고정
  (구조 변화 감지와 같은 용도라 계속 가벼워야 함).
- `lib/scrape/mallProfile.ts`: 기존 `runMallProfileCheck(siteId)`는 그대로 두되 내부적으로
  `profileMallStructure(siteId, false)`만 쓰도록 고정 — 로그인 확인 전용으로 남는다. 신규
  `runMallStructureReport(siteId)`가 `profileMallStructure(siteId, true)`를 불러 "몰 구조 파악" 버튼
  전용 경로가 됐다. `applyProfileResult(siteId, next, deep)`에 `deep` 인자를 추가해:
  - `deep=false`인데 `next.report`가 비어 있으면 `prev.report`(예전에 딥 리포트를 만들어둔 적 있으면)를
    그대로 이어받는다 — 로그인 확인이 매번 돌면서 예전 거래정보 리포트를 지워버리지 않도록.
  - `deep=true`일 때는 "구조 변경 감지" site_memos 알림을 남기지 않는다 — 버튼 클릭 시 결과 화면에
    바로 보여주므로 별도 알림과 용도가 섞이지 않게.
  - 최초 1회 메모 문구도 `deep` 여부에 따라 "상품페이지 구조 파악 완료"/"몰 거래정보 분석 완료"로 구분.
- `describeDiff`의 report-변경 diff 라인은 제거 — deep 호출은 diff 자체를 안 남기고, light 호출은
  report를 그대로 이어받아 절대 달라지지 않으므로 도달 불가능한 코드였다.
- `app/api/sites/[id]/profile/route.ts`(버튼): `runMallProfileCheck` 대신 `runMallStructureReport` 호출.
- `app/api/scrape/login-confirm/route.ts`(자동): 호출부 변경 없음 — 원래부터 `runMallProfileCheck`를
  그대로 썼으므로 자동으로 가벼운 경로만 타게 됨.

## AI 실패 시 규칙 기반 대체 (2026-07-20, 4차)

플랫폼 감지 수정 후 재테스트에서 원문 수집까지는 전부 정상 동작했는데, 마지막 AI 호출이
`"Your credit balance is too low to access the Anthropic API"`로 실패해 리포트가 계속 null이었다.
사용자 확인: `ANTHROPIC_API_KEY`(console.anthropic.com API 크레딧)와 claude.ai/Claude Code **월 정액
구독은 완전히 별개**라 구독 크레딧으로 이 앱의 API 호출을 대신할 방법이 없다. 사용자가 "크레딧 충전
방식 외 다른 방법으로 해결해달라"고 요청 — 즉 이 기능이 API 과금 없이도 동작해야 한다는 것.

- `lib/ai.ts`의 `buildHeuristicMallReport(input)`(신규, 동기 함수, API 호출 없음): 같은 8개 항목을
  규칙 기반으로 채운다.
  - `urlHierarchy`/`categoryStructure`/`stockManagementType`/`productPageStructure`는 이미 확보된
    구조적 신호(플랫폼/카테고리 메뉴·경로/재고 표기 flag/옵션 UI/이미지·상세텍스트 유무)를 그대로
    문장으로 조립 — AI 없이도 신뢰도가 높다(애초에 boolean 신호로 이미 검증된 값들이라).
  - `paymentAccount`/`shippingCourier`/`companyContact`는 원문(`contextText`)에서 은행명/택배사명
    키워드, 전화번호(`0\d{1,2}-\d{3,4}-\d{4}`), 이메일 패턴을 정규식/키워드 매칭으로 찾는다. 재현율은
    AI보다 낮지만(목록에 없는 택배사·계좌 표기 형태는 못 찾음) 오탐은 적다. 택배사명은 "CJ 대한통운"처럼
    띄어쓰기가 섞인 실제 표기가 있어(펫투비 사례) 공백을 지우고 비교한다.
  - `scrapingNeeds`는 자유 서술이 필요해 규칙으로 못 만드므로, 규칙 기반 리포트임을 알리는 고정 문구로
    대체(사용자가 화면에서 AI 분석과 구분할 수 있도록).
- `lib/scraper.ts`의 `sampleMallProfile`(deep 블록): `generateMallProfileReport(...).catch(() => null) ??
  buildHeuristicMallReport(...)` — AI 호출이 성공하면 AI 리포트를, 실패(크레딧 부족/키 없음/네트워크
  오류 등 무엇이든)하면 규칙 기반 리포트를 대신 채운다. "몰 구조 파악"이 이제 API 크레딧 없이도 항상
  결과를 낸다 — AI가 되면 더 정확한 리포트를, 안 되면 구조 신호+키워드 매칭 기반 리포트를 보여준다.

## 항목 확장 + Mall 관리 메모 자동 요약 (2026-07-20, 5차)

사용자 확인: "몰구조파악은 얼추 된 것 같아" — 이어서 두 가지 요청:
1. (확인 차원) 파악된 내용이 스크래핑 시 카테고리명 등 참고 자료로 쓰이는 것이 맞는지 — 기존 "AI
   컨텍스트 주입"(3차 확장, `lib/scrape/adjustment.ts`가 `scrape_profile`을 `generateExtractionRules`에
   전달)이 이미 이 역할을 한다. 별도 추가 구현 없음.
2. (신규) 결제계좌/은행정보, 배송 택배사, 택배비, 업체 연락처, 업체 이메일, 반품 주소지 같은 "몰 기본정보"를
   Mall 관리 화면의 "메모" 컬럼에 요약해서 남겨달라는 것 — 확인해보니 `components/panels/SiteDetailPanel.tsx`
   에 이미 이 정확한 용도의 **수동 메모 템플릿**이 있었다: `택배사: / 배송비: / 배송/반품 주소지: /
   연락처: / 은행: / 계좌번호: ` (MemoLog의 `template` prop). "몰 구조 파악"이 이 템플릿을 그대로
   자동으로 채워 넣도록 구현 — 별도 메모 포맷을 새로 만들지 않고 기존 것과 통일.

### 리포트 항목 확장 (8→11개)

`MallStructureReport`(`lib/ai.ts`): 기존 `paymentAccount`(뭉뚱그린 한 필드)를 `bankName`+`accountNumber`
2개로 분리하고, `shippingFeeInfo`(택배비/배송비)·`returnAddress`(배송/반품 주소지)를 신규 추가 — 위
메모 템플릿의 6개 항목(택배사/배송비/배송·반품주소지/연락처/은행/계좌번호)과 1:1로 대응시키기 위함
(사후에 정규식으로 쪼개는 것보다 애초에 AI/규칙 기반 양쪽 모두 분리된 필드로 뽑는 게 더 정확함).
`generateMallProfileReport`(AI)와 `buildHeuristicMallReport`(규칙 기반) 둘 다 갱신 — `findBankName`/
`findAccountNumber`(은행명 주변 60자에서 계좌번호 패턴)/`findShippingFee`("배송비"/"택배비" 키워드
주변)/`findReturnAddress`("반품"/"교환" 키워드 주변) 신규 헬퍼. `components/panels/ScraperPanel.tsx`의
카드 그리드도 8개→11개 항목으로 갱신.

### Mall 관리 메모 자동 기록

`lib/scrape/mallProfile.ts`의 `formatMallInfoMemo(report)`(신규): SiteDetailPanel의 수동 템플릿과 같은
순서로 6줄 텍스트를 만든다(맨 앞에 "🔍 몰 기본정보 자동 분석(규칙 기반일 수 있음...)" 안내줄 추가 —
사용자가 직접 입력한 메모와 자동 분석 메모를 구분할 수 있도록). `applyProfileResult`가 `deep === true`
(=="몰 구조 파악" 버튼)일 때마다 이 메모를 `site_memos`에 새로 INSERT한다 — 이전 4차 확장에서는 deep
호출이 별도 메모를 아예 안 남기기로 했었는데, 이번 요청으로 그 결정을 뒤집었다: 로그인 확인 전용의
"구조 변경 감지" 메모와는 완전히 별개 항목이라 서로 섞이지 않는다.

## 운영 메모는 사용자 공간, 자동분석 메모는 최신 1건만 유지 (2026-07-20, 6차)

5차에서 "몰 구조 파악"이 매번 새 메모를 INSERT하도록 만들었는데, 사용자가 재실행할 때마다 계속 쌓이면
`SiteDetailPanel`의 "운영 메모"(`site_memos`, 원래 사용자가 직접 택배사/계좌 등을 적어두는 수동 공간)가
자동분석 기록으로 도배될 수 있다는 문제 제기 — "운영메모 란은 사용자가 직접 기록·수정·관리하는 공간으로
유지하고, '몰 구조 파악' 메모는 화면에 계속 남기되 그 이전 것만 자동삭제해달라."

- `lib/scrape/mallProfile.ts`: `MALL_INFO_MEMO_PREFIX = '🔍 몰 기본정보 자동 분석'` 상수 도입.
  `applyProfileResult`의 deep 분기가 새 자동분석 메모를 INSERT하기 전에 `DELETE FROM site_memos WHERE
  site_id=$1 AND content LIKE '${MALL_INFO_MEMO_PREFIX}%'`로 이전 자동분석 메모만 지운다 — 사용자가 직접
  쓴 메모나 로그인 확인의 "구조 변경 감지"/"상품페이지 구조 파악 완료" 메모는 접두문구가 달라 전혀
  영향받지 않는다. 결과적으로 이 화면에는 자동분석 메모가 항상 최신 1건만 존재한다.
- Mall 목록의 "메모" 컬럼(`app/api/sites/route.ts`의 `latest_memo`, `site_memos ORDER BY memo_at DESC
  LIMIT 1`)은 이미 site_memos의 최신 행을 그대로 노출하고 있어 별도 수정 없이 자동으로 반영된다.
- `components/panels/SiteDetailPanel.tsx`: "운영 메모" 설명 문구에 "몰 구조 파악을 실행하면 자동분석
  메모가 최신 1건으로 자동 추가/교체되고, 직접 남긴 메모는 그대로 유지된다"는 안내를 추가.

## 정정 (2026-07-20, 7차) — 운영 메모는 site_memos에 안 씀, 참고용 별도 표시로 교체

6차에서 "몰 구조 파악" 결과를 `site_memos`(운영 메모)에 INSERT+이전 것 자동삭제하는 방식으로 구현했는데,
사용자가 의도를 다시 정정: "운영 메모"는 **사용자가 직접 기록·수정하는 순수한 공간**이어야 하고, "몰
구조 분석" 결과는 운영 메모와 섞이지 않는 **별도의 참고용 표시(최근 1건, 일시+내용)**로 그 아래 보여줘야
한다 — 사용자가 그 내용을 보고 필요한 걸 운영 메모에 직접 옮겨 적는 것이 목적이다. 6차의 site_memos
INSERT/DELETE 방식은 폐기.

- `lib/scrape/mallProfile.ts`: `applyProfileResult`의 deep 분기에서 site_memos INSERT/DELETE 로직
  전부 제거(`formatMallInfoMemo`/`MALL_INFO_MEMO_PREFIX`도 삭제) — deep 호출은 이제 `sites.scrape_profile`
  갱신만 하고 site_memos는 전혀 건드리지 않는다.
- `app/api/sites/[id]/route.ts`: GET 응답에 `mall_report`(`scrape_profile.report`)와
  `mall_report_updated_at`(`scrape_profile_updated_at`) 추가.
- `components/panels/SiteDetailPanel.tsx`: "운영 메모"(`MemoLog`) 아래에 별도 카드로 "🔍 몰 구조 분석
  (참고용, 최근 1건)"을 추가 — `mall_report_updated_at` 기준 일시 + 6개 항목(택배사/배송비/주소지/
  연락처/은행/계좌번호)을 읽기 전용으로 보여준다. `mallReport`가 없으면(아직 "몰 구조 파악"을 실행한
  적 없음) 카드 자체를 렌더링하지 않는다. 운영 메모 설명 문구도 "아래 참고 내용을 보고 직접 옮겨
  적으라"는 안내로 되돌림.

## 운영 메모를 로그(여러 건)에서 단일 값으로 단순화 (2026-07-20, 8차)

7차까지도 "운영 메모"는 `site_memos` 테이블 기반의 `MemoLog`(일시/내용/수정/삭제, 여러 건이 쌓이는 로그
테이블)를 그대로 썼다. 사용자에게 "추가 버튼으로 계속 새 행이 쌓이는 로그 방식과, 메모 1개만 유지하는
방식 중 뭘 원하냐"고 확인한 결과 **"메모는 딱 1개만 유지"**를 선택 — 택배사/계좌 같은 거래정보는 "현재
값"이지 "이력을 쌓는 로그"가 아니라는 것.

- `lib/db.ts`: `sites.memo TEXT` 컬럼 추가(단일 값, 여러 건 로그 아님).
- `app/api/sites/[id]/route.ts`: GET/PUT에 `memo` 필드 추가 — 기존 이름/URL 등 다른 필드와 완전히 같은
  방식(폼의 "수정 저장" 버튼 하나로 같이 저장)으로 통일했다. 별도의 저장/삭제 API를 새로 만들지 않음 —
  지우고 저장하면 그게 곧 삭제.
- `app/api/sites/route.ts`(목록): `latest_memo`를 `site_memos` LATERAL JOIN 대신 `sites.memo` 컬럼에서
  직접 가져온다.
- `components/panels/SiteDetailPanel.tsx`: `MemoLog` 대신 단일 `<textarea>` + "템플릿 채우기" 버튼으로
  교체. 저장은 폼 전체와 함께 "수정 저장" 버튼으로 처리된다.
- `app/api/sites/[id]/memos/route.ts`, `.../memos/[memoId]/route.ts` 삭제 — SiteDetailPanel이 유일한
  호출부였는데 더 이상 안 써서 고아 코드가 됨.
- **주의**: `site_memos` 테이블 자체와 자동 드리프트 알림("⚠ 구조 변경 감지"/"🔍 상품페이지 구조 파악
  완료", 로그인 확인 시 조용히 도는 `runMallProfileCheck`가 씀)은 그대로 남아있다 — 다만 이제 Mall
  목록의 "메모" 컬럼도, SiteDetailPanel 화면도 이 테이블을 더 이상 보여주지 않으므로, 이 자동 알림들은
  현재 어디서도 사용자에게 보이지 않는 상태가 됐다(DB에는 계속 쌓임). 이번 요청 범위 밖이라 손대지
  않았지만, 나중에 이 자동 알림을 다시 보여줄 방법이 필요해지면 참고할 것.

## 가방쟁이(고도몰 다른 스킨) 실사용 버그 수정 + "PTP 기본 노하우" 축적 시작 (2026-07-21)

사용자가 "몰 구조 파악"으로 갓 스크랩한 가방쟁이(godomall) 결과를 보고 "계좌번호에 전화번호가 들어갔다"고
제보 — 실제 로그인 세션으로 원인을 확인했다.

- **진짜 원인**: `findInfoPageLinks`가 "배송"처럼 느슨한 키워드로 안내 링크를 찾는데, 이 몰 홈페이지의
  추천상품 위젯에 "GE_5645 28인치캐리어/**배송**비별도" 같은 상품 링크가 있어 "배송" 키워드에 걸렸다.
  안내 링크 후보 4개 한도를 이런 상품 링크들이 다 채워버려 정작 "이용안내"(실제로 계좌 정보가 있던
  페이지)를 못 열어봤고, 결국 은행명을 못 찾은 채(`bank === '확인 안됨'`) 계좌번호 정규식이 원문 전체를
  훑다가 전화번호(031-523-3090, 계좌번호와 같은 "숫자-숫자-숫자" 모양)를 잘못 집었다.
- **수정**: `findInfoPageLinks`(`lib/scraper.ts`)에 안내 링크 텍스트 길이 상한(15자) 추가 — 상품명처럼
  긴 텍스트는 애초에 후보에서 제외. `findAccountNumber`(`lib/ai.ts`)는 은행명을 못 찾으면 원문 전체
  검색을 포기하고 바로 "확인 안됨"을 반환하도록 변경(전화번호/사업자등록번호 오인 방지). 계좌번호
  정규식도 구간 수를 3개로 고정하지 않고 2~4개까지 허용(농협 "312-0121-8472-61"처럼 4구간인 사례 확인).
- **카테고리**: 이 몰의 카테고리 전체보기 플라이아웃은 `.lnb` 클래스를 씀을 확인 — `scanCategoryMenu`에
  `.lnb a` 추가(닫기버튼 "×" 같은 글자/숫자 없는 텍스트는 제외하는 필터도 같이 추가).
- **택배사/반품주소지**: 실제로 이 몰은 특정 택배사명이나 반품 주소를 명시하지 않고 "택배 서비스
  이용"이라고만 되어 있어, "확인 안됨"이 정답이었다 — 버그가 아니라 실제로 없는 정보.

### "PTP 기본 노하우" 축적 (사용자 요청)

이번처럼 실사용 중 발견한 패턴/함정을 이 세션의 코드 수정으로만 끝내지 않고, **다른 몰을 분석할 때도
참고되도록** `lib/ai.ts`의 `MALL_ANALYSIS_KNOWLEDGE`(문자열 배열)에 한 줄씩 쌓는다. `generateMallProfileReport`
의 AI 프롬프트에 "다른 몰들을 분석하며 얻은 참고 지식" 섹션으로 매번 주입되어, 처음 보는 몰이라도 AI가
어디를 살펴봐야 할지/어떤 흔한 함정이 있는지 미리 참고할 수 있다(그 몰이 실제로 그렇다는 뜻은 아니고
힌트일 뿐 — 원문과 다르면 항상 원문 우선이라고 프롬프트에 명시). 오늘 발견한 6가지를 초기 항목으로 등록.

- **규칙 기반(`buildHeuristicMallReport`) 쪽 노하우는 이미 다른 방식으로 축적되고 있다**: `BANK_NAMES`/
  `COURIER_NAMES`/`INFO_PAGE_KEYWORDS`/`scanCategoryMenu`의 플랫폼별 선택자 등이 그 자체로 코드화된
  노하우라, 새 은행/택배사/스킨이 발견될 때마다 그 목록에 추가하면 된다(이미 해오던 방식, 새로 만든
  게 아님) — `MALL_ANALYSIS_KNOWLEDGE`는 AI 경로에 이 감각을 추가로 불어넣는 보완재.
- DB 테이블이나 UI 편집 화면은 만들지 않았다(과한 설계로 판단) — 지금처럼 실사용 버그를 고치는 과정에서
  발견되는 대로 코드에 한 줄씩 추가하는 것으로 충분하고, 그 편이 "실제로 확인된 것만 남긴다"는 이
  프로젝트의 기존 원칙과도 맞는다.

## 가방쟁이 "스크랩 미리보기 안 됨" — 상품 URL 대소문자 불일치 (2026-07-21)

사용자가 가방쟁이 카테고리 화면 스크린샷과 함께 "스크랩 미리보기가 카테고리 하위 상품을 못 찾는다"고
제보 — 실제 로그인 세션으로 카테고리 목록 페이지(`goods_list.php?cateCd=003003`)를 직접 열어 확인했다.

- **원인**: `collectProductUrls`의 `detailRe`(플랫폼별 상품 상세 URL 패턴 필터)가 `new RegExp(detailPatternSrc)`
  로 플래그 없이(대소문자 구분) 재구성되고 있었다. 고도몰 기본 패턴은 `goods_view\.php\?goodsno=`(소문자)
  인데, 이 몰의 실제 상품 URL은 `goods_view.php?goodsNo=22635`(대문자 N)를 쓴다 — 같은 고도몰이라도
  몰마다 이 쿼리파라미터의 대소문자 표기가 다를 수 있음을 실사용으로 확인. 대소문자 구분 정규식이라
  `.item_cont a`로 정확히 상품 링크를 잘 찾아놓고도(705개, 실제로는 정상 동작) 이 필터 단계에서 전부
  걸러져 최종 결과가 0개가 됐다.
- **수정**: `lib/scraper.ts`의 `scanCurrentPage`에서 `new RegExp(detailPatternSrc, 'i')`로 대소문자
  구분 없이 매칭하도록 변경 — 고도몰뿐 아니라 cafe24/makeshop 패턴에도 동일하게 적용되어 앞으로 비슷한
  대소문자 차이가 있는 몰도 자동으로 안전하다.

## 가방쟁이 상품페이지 데이터 정확도 개선 (2026-07-21, 2차)

사용자가 실제 상품페이지(`goods_view.php?goodsNo=22635`) 내용을 직접 붙여넣어 주고, 스크랩 데이터가
맞지 않는다고 제보 — 이번엔 사용자가 준 텍스트 + 실제 로그인 세션 확인을 병행했다.

- **가격**: `.item_detail_list`(dl/dt/dd)에 상품코드/정가/판매가/원산지/배송비가 있는데, 이 몰도 펫투비처럼
  "판매가"가 공급가(도매가)를, "정가"가 소비자 참고가를 의미한다(사용자 확인) — site 12 extraction_rules에
  `price←"정가"`, `cost_price←"판매가"` 추가. 원산지/배송비는 기존 일반 규칙이 이미 정상 처리 중이었다.
- **"상품필수 정보" 나머지 항목을 별도 컬럼으로**: 실제 페이지는 `<table class="left_table_type">`로 제품
  소재/색상/제조사(수입자/병행수입)/제조국/수입여부/종류/KC안전인증 대상 유무/상품 가로_세로_높이/상품_무게
  등을 나열한다 — 기존 `infoRows` 스캐너가 이미 다 잡고 있었지만 제조사/제조국(원산지) 말고는 전부 하나의
  `extra_info` 뭉치로만 보여주고 있었다. `extractProductRuleBased`(`lib/extract.ts`)에 라벨별로
  `custom_fields`에도 개별 저장하는 로직을 추가 — 브랜드/제조사/원산지/유통기한처럼 이미 전용 필드가 있는
  라벨과, 몰마다 표기가 달라 site별 extraction_rules로 처리하는 상품코드/가격/배송비류 라벨은 중복 노출을
  피하려고 제외했다. custom_fields는 이미 스크랩 Raw 확인 화면에 자동으로 컬럼화되므로 그리드 쪽 수정은 불필요.
- **관련상품 제외**: 실제 마크업을 확인해보니 `.detail_cont`(상세 이미지/설명)와 `#detail`(관련상품 탭
  라벨까지 포함하는 바깥 탭 컨테이너)이 부모-자식 관계였다 — `detailContainer` 후보를 `.detail_cont`를
  `#detail`보다 먼저 시도하도록 순서를 잡아, 관련상품 탭 내용이 섞이지 않게 했다(사용자가 관련상품은
  스크랩하지 말라고 명시).
- **옵션값 정리**: 품절 옵션의 `<option>` 텍스트에 "베이지(카키) -- [일시품절/재입고미정]"처럼 상태 문구가
  값 자체에 섞여 들어온다 — 끝에 붙는 대괄호 상태문구와 "--" 구분자를 걷어내는 정리 로직을 `scanSelectOptions`
  (`lib/scraper.ts`)에 추가.

## 가방쟁이 카테고리 브레드크럼 + 배송비 숨은 팝업 오염 (2026-07-21, 3차)

사용자가 상품페이지 상단의 "패션잡화 > 지갑 > 장지갑"류 브레드크럼을 알려주며 카테고리 스크래핑을
잘 해달라고 요청, 배송비의 "지역별 추가 배송비" 부분은 스크랩하지 말라고 명시 — 실제 로그인 세션으로
둘 다 확인했다.

- **카테고리**: 이 몰은 브레드크럼 각 단계를 `.location_select`로 감싸는데, 그 안에 "현재 선택된
  이름"(`.location_tit`)과 다른 카테고리로 바로 갈 수 있는 **숨겨진 `<ul>` 드롭다운**을 같이 둔다. 기존
  범용 로직처럼 `<li>`를 그대로 다 훑으면 그 드롭다운 대안 목록까지 섞여 카테고리가 완전히 틀어진다 —
  `.location_select > .location_tit`만 콕 집어 읽도록 `detectCategoryLabel`(`lib/scraper.ts`, 목록
  페이지용)과 `scrapePageData`의 categoryFromDetail 폴백(`lib/extract.ts`, 상품페이지 단건 스크랩용) 둘
  다에 추가했다(두 곳이 원래도 거의 같은 로직을 각자 들고 있던 기존 구조를 그대로 따름).
  - **타이밍 버그도 같이 발견**: `.location_wrap`은 페이지 로드 직후엔 비어있다가 JS로 뒤늦게(약 2초)
    채워진다 — 채워지기 전에 읽으면 빈 배열이 나와 카테고리를 통째로 놓친다. `.location_wrap`이 있는
    페이지에서만 `.location_tit`에 실제 텍스트가 채워질 때까지(최대 3초) 기다리는 `page.waitForFunction`을
    두 호출부 앞에 추가 — 이 위젯이 없는 몰은 즉시 통과해 불필요한 지연이 없다.
- **배송비 숨은 팝업 오염**: "배송비" `<dd>` 안에 "지역별추가배송비" 버튼과 함께 클릭해야 보이는
  `display:none` 팝업 레이어(전국 도서산간 지역별 추가금액 목록, 수백 줄)가 같이 들어있었다 —
  `textContent`는 숨김 여부와 무관하게 다 이어붙여, 실제로 확인해보니 정리 전 값 길이가 **16,229자**
  (라벨 하나에 온갖 지역명+금액 나열)였다. `infoRows`를 만들 때 각 셀/라벨/값을 읽기 전에 숨겨진
  하위 요소(`.layer_area`, `display:none`)를 제거한 사본에서 읽도록 `lib/extract.ts`에 `cleanText`
  헬�퍼를 추가 — 정리 후 길이는 416자로, 실제 배송비(3,500원)와 배송 방법/방문 수령지 안내만 남는다.
  `table`/`dl` 스캔 둘 다에 적용해 이런 숨은 팝업 레이어를 가진 다른 몰에도 일반적으로 도움이 된다.

## 하지 않는 것 (2차 재설계 기준, 최종)

- 8개 항목 리포트는 어디까지나 "실제로 모은 원문 안에서" 찾은 내용만 답한다 — 원문에 없는 정보(결제
  계좌 등)는 몰마다 있을 수도 없을 수도 있어 여전히 "확인 안됨"으로 남을 수 있다(위 펫투비 사례 그대로).
- 안내성 링크 탐색은 "배송/이용안내/공지/계좌" 등 고정 키워드 매칭 최대 4개뿐 — 그 키워드가 없는 몰이나
  회원 전용 게시판은 못 찾는다.
- `gatherMallContextText`는 로그인 확인 직후 페이지 기준으로만 한 번 훑는다 — 스크랩 도중 그 정보가
  바뀌어도 다음 "몰 구조 파악" 재실행 전까지는 갱신되지 않는다.
