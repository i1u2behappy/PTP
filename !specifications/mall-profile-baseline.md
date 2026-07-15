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
