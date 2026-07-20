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

## 하지 않는 것 (2차 재설계 기준, 최종)

- 8개 항목 리포트는 어디까지나 "실제로 모은 원문 안에서" 찾은 내용만 답한다 — 원문에 없는 정보(결제
  계좌 등)는 몰마다 있을 수도 없을 수도 있어 여전히 "확인 안됨"으로 남을 수 있다(위 펫투비 사례 그대로).
- 안내성 링크 탐색은 "배송/이용안내/공지/계좌" 등 고정 키워드 매칭 최대 4개뿐 — 그 키워드가 없는 몰이나
  회원 전용 게시판은 못 찾는다.
- `gatherMallContextText`는 로그인 확인 직후 페이지 기준으로만 한 번 훑는다 — 스크랩 도중 그 정보가
  바뀌어도 다음 "몰 구조 파악" 재실행 전까지는 갱신되지 않는다.
