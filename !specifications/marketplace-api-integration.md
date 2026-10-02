# 오픈마켓 API 연동 — 상품 등록/수정/삭제 (직접 구현) — 설계 검토안

> 개발 지시가 아니라 **검토 문서**입니다. [[ptp-migration-roadmap]] §04 4단계를 구체화한 것 — 그
> 문서가 "무엇을 왜" 다뤘다면, 이 문서는 "어떤 모양으로" 만들지를 다룹니다.

## 0. 목적 / 범위 (사용자 지시 원문 기준, 2026-10-03)

> 나의 목적은 ptp에 등록되는 거래처가 특정 몰의 상품을 스크래핑한 후 마이그레이션을 거쳐서 완성된
> 상품DB 최종결과물을 기반으로 각각의 오픈마켓에 api연동을 통해 해당 상품을 관리할 수 있는 범위까지야.
> 물론 더 나아가서, 별도의 메뉴를 통해 주문관리/배송관리/상담관리 등의 범위까지 이어서 구현할 수도 있어.

- **1차 범위(이 문서)**: `product_master`(status=ready, 즉 사람이 확정한 완성 상품)를 거래처가 보유한
  오픈마켓 계정으로 **등록/수정/삭제** — 쿠팡·네이버·ESM·11번가.
- **방식 결정**: 사방넷/샵링커 같은 중개 OMS를 경유하지 않고 **PTP가 각 마켓 REST API를 직접 호출**한다.
  다만 그 두 서비스가 실제로 어떻게 구현했는지(인증 모델/화면 구조/기능 범위)를 분석해, 검증된 패턴만
  가져온다 — 직접 구현이라고 매번 처음부터 설계할 필요는 없다.
- **2차 범위(이 문서에서 설계만 언급, 실제 구현 안 함)**: 주문관리/배송관리/상담관리. 아래 §6에서
  "지금 뭘 준비해두면 나중에 쉬운지"만 다룬다.

## 1. 경쟁사(사방넷·샵링커) 분석 요약

2026-10-03 웹 리서치 기반(전문은 대화 기록 참고, 핵심만 정리):

| 발견 | 내용 | PTP 설계에 주는 의미 |
|---|---|---|
| **인증 모델은 마켓마다 다른 필드 조합** | 샵링커 실사례 — 11번가는 ID/PW+API Key, 스마트스토어는 ID/PW+판매자ID+도메인, 텐바이텐은 API Key만. "ID/PW냐 API Key냐"는 양자택일이 아니다. | 인증정보 스키마는 고정 컬럼이 아니라 **마켓별로 다른 필드 집합을 담는 유연한 구조**여야 한다(§3). |
| **재고/가격 전용 경량 API가 별도로 있다** | 네이버가 2025-01 "재고/가격만 가볍게 바꾸는 경량 API"를 별도 출시 — 전체 상품수정 API와 분리. | 전체 수정(update)과 별개로 **재고/가격만 바꾸는 가벼운 엔드포인트**를 PTP도 따로 둬야 한다(§4). |
| **"상품 매핑" 단계가 항상 별도로 존재** | 사방넷은 등록 후 "사방넷 상품 ↔ 쇼핑몰 상품"을 연결하는 매핑 단계를 거친다. | PTP의 `product_channel_listings`(상품마스터 ↔ 마켓별 외부상품ID)가 이미 이 역할 — 추가 설계 불필요, 컬럼만 보강(§3). |
| **자동 품절 처리 / 재고연동이 핵심 기능으로 취급됨** | 두 서비스 다 "자동 품절"을 주요 기능으로 내세움. | 판매상태(품절/재개) 변경도 전용 엔드포인트가 필요(§4·§7). |
| **"직접연동(Direct API)" vs "제휴 솔루션" 구분이 샵링커 내부에도 있음** | 샵링커 자신도 표준 인터페이스(자기 쪽 계약)까지만 통일하고, 그 아래 마켓별 실제 연동은 나뉜다. | PTP가 설계한 "내부 표준 인터페이스 + 마켓별 어댑터" 구조가 업계 실제 구현과 같은 패턴임을 재확인. |

## 2. 데이터 모델

기존(이미 스키마만 존재, `lib/db.ts`)에 아래를 보강한다.

```sql
-- 기존 테이블 보강
ALTER TABLE marketplace_credentials ADD COLUMN IF NOT EXISTS last_verified_at TIMESTAMPTZ;
ALTER TABLE marketplace_credentials ADD COLUMN IF NOT EXISTS verify_error TEXT;
-- credential_data_encrypted에는 마켓마다 다른 키 꾸러미를 JSON으로 통째로 암호화해 담는다
-- 예: 쿠팡={"vendorId":"...","accessKey":"...","secretKey":"..."}
--     스마트스토어={"applicationId":"...","applicationSecret":"..."}

ALTER TABLE product_channel_listings ADD COLUMN IF NOT EXISTS external_product_id TEXT;
ALTER TABLE product_channel_listings ADD COLUMN IF NOT EXISTS sync_status TEXT DEFAULT 'none';
  -- 'none'|'pending'|'active'|'rejected'|'error'
ALTER TABLE product_channel_listings ADD COLUMN IF NOT EXISTS last_synced_at TIMESTAMPTZ;
ALTER TABLE product_channel_listings ADD COLUMN IF NOT EXISTS error_message TEXT;

-- 신규: 동기화 이력 로그 — "마지막 상태"만 남는 product_channel_listings와 달리, 무슨 일이 있었는지
-- 시간순으로 전부 남긴다. 사방넷류도 "처리이력" 조회 화면을 반드시 두고 있다 — 운영 중 "왜 실패했는지"를
-- 추적 못 하면 장애대응이 불가능하다(AGENTS.md "증상 진단 규칙"과 같은 이유 — 결과물을 사후에 대조할
-- 근거가 있어야 한다).
CREATE TABLE IF NOT EXISTS marketplace_sync_log (
  id                  SERIAL PRIMARY KEY,
  product_master_id   INT REFERENCES product_master(id) ON DELETE CASCADE,
  marketplace_code     TEXT REFERENCES marketplace_configs(code),
  action              TEXT NOT NULL,   -- 'register'|'update'|'delete'|'stock_price_sync'|'status_change'
  success             BOOLEAN NOT NULL,
  error_message       TEXT,
  request_snapshot    JSONB,           -- 디버깅용 — 실제로 뭘 보냈는지(민감정보 제외)
  created_at          TIMESTAMPTZ DEFAULT NOW()
);
```

`registration_jobs`(이미 존재)는 쿠팡처럼 승인에 며칠 걸리는 **비동기 작업 추적**용으로 그대로 쓴다.

## 3. 인터페이스 설계

```ts
// lib/marketplace/types.ts
export interface CredentialField { key: string; label: string; secret: boolean }

export interface CategoryMeta {
  requiredAttributes: { key: string; label: string; allowedValues?: string[] }[]
  requiredNotices: string[]   // 상품정보제공고시 필수 항목
}

export interface SyncResult {
  success: { productMasterId: number; externalId: string }[]
  failed: { productMasterId: number; error: string }[]
}

/** 상품 CRUD 전용 — 주문/배송/상담은 별도 인터페이스로 분리한다(§6), 여기 섞지 않는다. */
export interface MarketplaceProductAdapter {
  code: string
  credentialFields(): CredentialField[]
  verifyCredentials(cred: Record<string, string>): Promise<{ ok: boolean; error?: string }>
  fetchCategoryMeta(categoryCode: string, cred: Record<string, string>): Promise<CategoryMeta>
  validate(products: ProductMasterRow[], meta: CategoryMeta): { ok: boolean; errors: { productMasterId: number; field: string; reason: string }[] }
  register(products: ProductMasterRow[], cred: Record<string, string>): Promise<SyncResult>
  update(products: ProductMasterRow[], cred: Record<string, string>): Promise<SyncResult>
  updateStockPrice(items: { productMasterId: number; externalId: string; stockQty?: number; salePrice?: number }[], cred): Promise<SyncResult>
  updateStatus(items: { productMasterId: number; externalId: string; status: 'active' | 'suspended' }[], cred): Promise<SyncResult>
  delete(externalIds: string[], cred: Record<string, string>): Promise<SyncResult>
  checkStatus(externalIds: string[], cred: Record<string, string>): Promise<{ externalId: string; status: string }[]>
}
```

`register`/`update`와 `updateStockPrice`/`updateStatus`를 분리한 건 경쟁사 분석(§1)에서 확인한 "경량
API 분리" 패턴을 그대로 반영한 것 — 재고/가격처럼 자주 바뀌는 값을 매번 전체 상품정보와 함께 보내지
않는다.

## 4. PTP 내부 REST API

```
-- 인증정보 관리
POST   /api/marketplace/credentials            { clientId, marketplaceCode, fields{...} } → 저장+자동검증
GET    /api/marketplace/credentials?clientId=
DELETE /api/marketplace/credentials/{id}

-- 카테고리 메타데이터
GET    /api/marketplace/{code}/category-meta?categoryCode=

-- 상품 CRUD
POST   /api/marketplace/{code}/products          { productMasterIds: [...] }   → register()
PUT    /api/marketplace/{code}/products          { productMasterIds: [...] }   → update()
DELETE /api/marketplace/{code}/products          { productMasterIds: [...] }   → delete()

-- 신규: 경량 동기화 (§1·§7에서 도출)
PATCH  /api/marketplace/{code}/products/stock-price  { items: [{productMasterId, stockQty?, salePrice?}] }
PATCH  /api/marketplace/{code}/products/status       { items: [{productMasterId, status}] }

-- 상태/이력 조회
GET    /api/marketplace/{code}/products/status?ids=
GET    /api/marketplace/sync-log?productMasterId=    → marketplace_sync_log 조회(운영/디버깅용)
```

화면/자동화는 이 엔드포인트만 알면 되고, `{code}`만 바뀌면 어느 마켓이든 동일하게 다룹니다.

## 5. 처리 흐름 & 구현 순서 (기존 로드맵 §04와 동일, 반복 안 함)

1. ✅ 인증정보 저장 API+화면 (2026-10-03, 커밋 전)
2. ✅ 쿠팡 어댑터 — `credentialFields`/`verifyCredentials`/`fetchCategoryMeta`/`validate` (2026-10-03,
   커밋 전). 실제 쿠팡 서버에 가짜 키로 호출해 "HTTP 401: Specified key is not registered" 응답을
   받아 요청 형식(서명/헤더)이 서버가 파싱할 만큼 정확함을 확인 — 단 실제 발급받은 키로 성공 응답까지
   받아본 적은 없다(이 환경에 쿠팡 벤더 키 없음).
3. ✅ **쿠팡 `register()` 착수 중 발견한 구조적 공백 2건, 둘 다 선행 작업으로 해소**:
   - **공백 1(해소, 2026-10-03)**: `deliveryMethod`/`deliveryCompanyCode`/`returnCenterCode` 등 상품생성
     API의 필수 필드 상당수가 상품별 데이터가 아니라 **거래처(벤더) 단위 배송/반품 정책**인데, PTP
     어디에도 저장할 곳이 없었다. `marketplace_credentials.settings`(평문 JSONB, 암호화 안 함 —
     비밀값이 아니므로) 신규 컬럼 + `MarketplaceProductAdapter.settingsFields()`로 해결 —
     `returnCenterCode`를 모르는 거래처는 공식 문서가 명시한 대체 경로(`NO_RETURN_CENTERCODE` +
     수동 반품주소 15필드)로 대응, `outboundShippingPlaceCode`(별도 사전등록 필요)는 "묶음배송 쓸 때만
     필수"라 공란 허용. `credentialFields()`/`settingsFields()`를 내려주는
     `GET /api/marketplace/[code]/fields` 신설, 화면도 어댑터가 있는 마켓은 라벨+드롭다운 고정폼,
     없는 마켓은 기존 범용 key-value 폼으로 분기.
   - **공백 2(해소, 2026-10-03)**: 쿠팡 `items[]`는 "색상=빨강+사이즈=100" 같은 실제 구매 가능
     조합 단위인데, product_master가 옵션을 평평한 목록(`options`)으로만 가져 카티전 곱 근사 시 실제로
     없는 조합(빨강-105 등)을 판매 가능한 것처럼 등록하게 됨 — [[cascading-option-combinations]]
     스펙이 이미 "아직 안 끝남"으로 표시해뒀던 공백. `migrateToMaster`가 `option_combinations`을
     product_master까지 옮기고, `lib/marketplace/optionCombinations.ts`(`resolveOptionCombinations`)가
     실제 조합 우선 사용·불가 시 근사+경고 플래그를 제공하도록 완성. 실제 스크랩 데이터(사이즈 5종
     조합)로 마이그레이션 전체 경로 검증 완료.
4. ✅ **쿠팡 `register()` 본체 구현 완료(2026-10-03, 커밋 전)**:
   - `buildCoupangRegistrationPayload()`(순수 함수, 네트워크 호출 없음) + `register()`(카테고리
     메타데이터 조회 → payload 조립 → 실제 POST, 항목별 독립 처리) — `lib/marketplace/coupang.ts`.
   - 검증 순서: 배송/반품 필수설정 → `validate()`의 필수 구매옵션 속성 → 필수 고시정보 내용 → **대표
     이미지 존재/절대URL 여부**(아래 운영 전제조건) — 하나라도 실패하면 네트워크 호출 자체를 안 한다.
   - `items[]`는 `resolveOptionCombinations()`로 조합마다 생성, `maximumBuyCount`는 상품 전체
     `stock_qty`를 그대로 씀(옵션별 재고를 PTP가 안 쪼개 추적하는 알려진 근사치 — 조합이 여럿이면
     실제보다 많이 팔릴 수 있음, 후속 과제로 남김).
   - **운영 전제조건 발견(실제 product_master로 테스트 중)**: "이미지 호스팅 관리" 메뉴에
     `base_url`이 설정돼 있어야 한다 — 안 하면 `vendorPath`가 `/scraped/...` 같은 상대경로로 나가
     쿠팡이 거부한다. `buildCoupangRegistrationPayload`가 이걸 로컬에서 먼저 막도록 검증 추가함.
   - 실제 product_master 데이터로 payload 조립 확인 + 가짜 키로 `register()` 전체 경로(카테고리
     메타조회→POST)를 실제 네트워크로 호출해 안전하게 실패하는 것까지 확인(401). **실제 발급받은
     키로 성공 응답을 받아본 적은 없음** — 처음 실사용 시 테스트 계정/카테고리 1건으로 먼저 확인할 것.
5. ✅ **등록 실행 화면 완료(2026-10-03, 커밋 전)** — "오픈마켓 등록" 메뉴(마이그레이션 그룹, 엑셀
   내보내기 다음) 신설:
   - `product_channel_listings`에 `external_product_id`/`sync_status`/`last_synced_at`/`error_message`
     추가, 시간순 이력용 `marketplace_sync_log` 테이블 신설(§2 설계 그대로).
   - `lib/marketplace/credentialStore.ts`(`loadClientCredentials`) — 저장된 접속정보 복호화 로딩 공용화.
   - API: `GET /api/marketplace/adapters`(API 등록 가능 마켓 목록), `GET /api/marketplace/[code]/
     category-meta`(카테고리 메타데이터 조회), `POST /api/marketplace/[code]/register`(실제 등록 실행 +
     결과를 product_channel_listings/marketplace_sync_log에 기록).
   - UI(`MarketplaceRegisterPanel.tsx`): 거래처·마켓 선택 → 확정(ready) 상품 다중선택 → 카테고리코드
     입력 후 "카테고리 정보 조회"(필수 구매옵션 속성 안내 + 필수 고시정보 입력폼 동적 생성) → 등록
     실행 → 상품별 성공/실패 결과 표시. 한 번에 한 카테고리코드만 받는다(다른 카테고리 상품을 섞어
     선택하면 검증에서 걸러짐 — [[coupang-category-profile-mapping]]의 "카테고리당 매핑 하나" 전제와
     동일).
   - **검증**: DB 레벨로 새 컬럼/테이블/upsert 로직(product_channel_listings 덮어쓰기, sync_log 적재)을
     실제 DB에 직접 실행해 확인. **브라우저 실클릭 테스트는 완료 못 함** — 로그인 시도 중 실제 사용자가
     동시에 DB를 쓰고 있는 정황(`/api/sites`, `/api/scrape-staging` 동시 호출)과 겹쳐 `Query read
     timeout`이 났고(내 새 마이그레이션 실행과 우연히 겹친 것으로 보임, 재시도 시 정상 로그인 성공해
     스키마 자체 문제는 아님), 실사용자 작업과 충돌을 피하려 그 이상 화면 클릭을 진행하지 않았다 —
     사용자가 여유 있을 때 직접 화면에서 한 번 확인 필요.
6. `update`/`updateStockPrice`/`updateStatus`/`delete`/`checkStatus` 추가
7. 네이버/ESM/11번가 복제

## 6. 주문/배송/상담관리 확장을 위한 설계상 배려 (지금 만들지 않음)

이 프로젝트는 **"설계만 해두고 아무도 안 쓰는 코드"의 위험을 이미 한 번 겪었습니다**
(`reference_products`가 읽기 코드만 있고 채우는 코드가 없어 죽은 채로 방치된 사례, 2026-10-03
`41c549c`에서 뒤늦게 완성). 그래서 주문/배송/상담용 테이블(`orders`/`order_items`/`shipments`/
`inquiries`)은 **그 단계를 실제로 착수할 때 만듭니다** — 지금 미리 빈 테이블을 만들어두지 않습니다.

다만 아래 두 가지는 "지금 설계가 나중을 막지 않는지"만 확인해둔 것 — 추가 작업은 없습니다.

- **인증정보 재사용 가능**: 쿠팡/네이버 등은 보통 판매자 계정 하나의 키가 상품관리 API와 주문관리
  API를 동시에 커버합니다(§1 리서치, 이전 대화 참고). `marketplace_credentials`를 "상품용"으로 좁게
  만들지 않고 client+marketplace 단위로 둔 지금 설계가 그대로 재사용됩니다.
- **인터페이스는 도메인별로 분리**: `MarketplaceProductAdapter`와 별개로, 나중에
  `MarketplaceOrderAdapter`(`fetchOrders`/`fetchOrderDetail`/`pushTrackingInfo` 등)를 **독립된
  인터페이스**로 추가하고 같은 레지스트리 패턴을 공유합니다. 지금의 상품 인터페이스를 주문 개념이
  섞여 오염시키지 않습니다.
- **`external_product_id`가 미래의 연결고리**: 나중에 주문을 조회하면 "이 주문의 이 품목이 어느
  `product_master`인지" 역매핑이 필요한데, 그 매핑 키가 지금 설계된 `product_channel_listings.
  external_product_id`입니다. 지금 단계에서 이 값을 정확히 채워두기만 하면(이미 설계에 포함됨) 나중에
  추가 이관 작업이 필요 없습니다.

## 7. API에 더 포함하면 좋을 기능 — 인사이트

경쟁사 분석(§1)과 이 프로젝트가 이미 겪은 실패 패턴(AGENTS.md "증상 진단 규칙", "조용한 오매핑")을
근거로 우선순위를 매겼습니다.

**필수급(1차 범위에 바로 포함 권장)**
- **재고/가격 경량 동기화**(`PATCH .../stock-price`) — 이미 §3·§4에 반영. 연속관리(`/api/master/changes`)가
  가격/재고 변동을 감지하는 기능이 이미 있으니, "변동 감지 → (사람 확인 후) 이 API로 반영"을 자연스럽게
  이어붙일 수 있습니다. 단, 로드맵 §06 결정1(가격 자동반영 정책)이 아직 미해결이라 — **자동 반영이 아니라
  "제안 → 사람이 누르면 반영"** 원칙을 여기도 그대로 적용해야 합니다.
- **판매상태 변경 전용 엔드포인트**(`PATCH .../status`) — 품절/판매중지/재개는 경쟁사 둘 다 핵심 기능으로
  꼽음.
- **동기화 이력 로그**(`marketplace_sync_log`) — 없으면 장애 시 "왜 실패했는지" 재구성이 불가능. 운영
  단계에서 사실상 필수.
- **반려 사유를 그대로 사람에게 노출** — 쿠팡 승인 거부 시 사유 텍스트를 그대로 화면에 보여주고, "AI가
  반려 사유를 해석해 고칠 필드를 제안"하는 건 로드맵에도 "검증된 사례는 아님"이라고 적어뒀듯 1차 범위에선
  제외 — 사람이 사유를 읽고 직접 고치는 것으로 충분.

**검토 후 포함 여부 결정(2차 이후로 미뤄도 무방)**
- **카테고리 메타데이터 수동 갱신 트리거**(`POST /api/marketplace/{code}/category-meta/refresh`) — 쿠팡이
  카테고리 구조를 바꾸면 캐시가 낡을 수 있음. 캐시 TTL만으로 충분할 수도 있어 1차 범위에선 보류.
- **웹훅 수신 엔드포인트 자리**(`POST /api/marketplace/{code}/webhook`) — 마켓이 상태변경을 푸시해주면
  폴링(`checkStatus`)이 불필요해짐. 지금은 어느 마켓이 웹훅을 지원하는지도 조사 안 됨 — **자리만 비워두고
  실제 구현은 주문단계 착수 시점에.**

**포함하지 않는 게 맞다고 본 것**
- 샵링커/사방넷의 "자동 발송/일괄 발송" 같은 대량 배치 자동화는, 이 프로젝트가 Transform/연속관리에서
  이미 "자동 적용이 아니라 사람 확인 후 적용"을 반복 원칙으로 삼아온 것과 충돌합니다. 배치 처리는
  하되(§4의 bulk 엔드포인트들), 트리거는 항상 사람의 명시적 액션으로 유지합니다.

---

*본 문서는 검토·의사결정용 설계안이며, [[ptp-migration-roadmap]]의 §04 4단계를 구체화한 것입니다.
실제 개발은 이 안에 대한 결정 이후 별도로 진행합니다.*
