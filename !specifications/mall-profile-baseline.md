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
- "몰 구조 파악"은 여전히 상품 구조(이미지/옵션/재고/카테고리)까지만 다룬다 — 공지사항·이용안내 같은
  정책성 페이지는 이번처럼 필요할 때 개별적으로 조사하는 것이지, 매번 자동으로 훑지 않는다(몰마다
  게시판 구조가 전혀 달라 일반화하기 어렵고, 자주 바뀌는 정보도 아니라 상시 자동화의 이득이 적음).
