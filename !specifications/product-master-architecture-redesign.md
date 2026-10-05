# 상품마스터 아키텍처 재설계 — "최적의 방법"으로 처음부터 재구성

상태: **§7 스키마 마이그레이션 1~5단계 + §8의 화면/API 4종(카테고리 트리 관리/다중계정/고시 템플릿/
export·register override 적용) 전부 구현·실DB 검증 완료(2026-10-05, §11 참고)**. **이 문서는
[[product-master-column-management]] §3/§4와 [[marketplace-channel-overrides]]를 대체한다**(사용자 지시,
2026-10-05: "전체 설계는 기존 설계를 무시해도 좋으니 '상품마스터'를 만드는데 최적의 방법을 재고민해서
설계해봐"). 기존 두 문서는 히스토리로 남겨두되, 실제 구현은 이 문서를 기준으로 진행한다.

## 0. 이 재설계가 필요해진 이유

앞선 두 라운드(상품마스터 컬럼 관리, 채널별 오버라이드)에서 설계를 "기존 테이블에 컬럼만 덧붙이는" 방식으로
점진적으로 짰는데, 사용자가 확인해준 두 가지 사실이 그 전제를 깬다:

1. **거래처가 한 마켓에 계정을 여러 개 쓰는 경우가 실제로 있다** — `marketplace_credentials`가
   `UNIQUE(client_id, marketplace_code)`라 지금은 구조적으로 불가능하다. 이건 "나중에 필요해지면"이 아니라
   **지금 바로 반영해야 하는 확정 요구사항**이다.
2. **고시정보 구조가 아직 정해지지 않았다** — 사용자가 "효율적인 방법으로 네가 결정해"라고 위임했다(§3에서
   결정하고 근거를 남긴다).

이 두 가지를 반영하려면 "컬럼 추가"로는 부족하고 — **카테고리(평문 텍스트 → 계층 구조)와 마켓 계정(단일 →
다중)이라는 두 기준 축 자체를 다시 잡아야** 나머지(오버라이드/고시정보/검색어)가 그 위에 자연스럽게 얹힌다.
그래서 처음부터 다시 설계한다.

## 1. 설계 원칙 (이번 재설계에서 지킨 것)

- **소스 오브 트루스는 테이블당 하나.** "읽을 때 여러 테이블을 폴백 체인으로 조회"는 허용하되(이미 §6
  Option B로 검증된 패턴), "같은 개념을 두 테이블에 각자 저장"은 금지 — 이 프로젝트가 과거 카테고리 캐시
  덮어쓰기류 사고를 여러 번 겪은 것과 같은 클래스의 위험이기 때문.
- **기존 데이터를 깨뜨리지 않는 추가형 마이그레이션.** "기존 설계를 무시해도 된다"는 지시는 "설계 사상"에
  대한 것이지 "운영 중인 데이터"에 대한 것이 아니다 — 모든 변경은 기존 컬럼을 유지한 채 새 컬럼/테이블을
  얹고, 전환이 끝나면 옛 컬럼을 제거하는 2단계로 간다.
- **조용한 자동매핑 금지 원칙은 유지.** (`lib/marketplace/types.ts:40-53`, [[marketplace-api-integration]])
- **세 솔루션에서 2개 이상이 독립적으로 쓰는 패턴만 구조로 채택**하고, 1개 솔루션만의 특이사례는 "참고만
  하고 지금은 안 만든다"로 명시한다(과잉설계 방지).

## 2. 핵심 변경 — 두 기준 축을 다시 잡는다

### 2.1 카테고리: 평문 텍스트 → 계층 트리 (`master_categories`, 신규 테이블)

```sql
CREATE TABLE master_categories (
  id          SERIAL PRIMARY KEY,
  parent_id   INT REFERENCES master_categories(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  depth       INT NOT NULL DEFAULT 0,
  sort_order  INT DEFAULT 0,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX master_categories_root_name_idx ON master_categories(name) WHERE parent_id IS NULL;
CREATE UNIQUE INDEX master_categories_child_name_idx ON master_categories(parent_id, name) WHERE parent_id IS NOT NULL;
```

- 세 솔루션 모두(샵링커 4단 드롭다운, 사방넷 분류코드, 플레이오토 카테고리템플릿) 계층형이었다 — PTP의
  평문 텍스트 하나가 유일하게 "업계 표준과 어긋나는" 지점이었다(참고: [[marketplace-formats/reference-oms-product-master-formats]]).
  이번에 바로잡는다.
- 자기참조(adjacency list)로 충분 — 깊이 제한 없이 자유롭게 늘릴 수 있고, PostgreSQL `WITH RECURSIVE`로
  트리 조회가 쉽다. 굳이 `path` 문자열을 따로 관리하지 않는다(쓰기 시점 동기화 부담만 늘고, 조회는
  재귀 CTE로 충분히 빠르다 — PTP 규모에서 과한 최적화).
- **마이그레이션(1단계, 추가형)**: 기존 `product_master.master_category`(TEXT)의 distinct 값마다
  `parent_id=NULL`인 루트 노드를 하나씩 만들고, `product_master`/`category_channel_mappings`에 새
  `master_category_id` 컬럼을 추가해 채운다. 기존 `master_category` TEXT 컬럼은 **당분간 유지**(화면
  하위호환, 데이터 유실 방지) — 계층을 실제로 나누는 건(예: "상의"를 "의류" 밑으로 옮기는 것) 이 마이그레이션의
  범위가 아니라 **새로 만들 "카테고리 트리 관리" 화면에서 사용자가 점진적으로 정리하는 후속 작업**이다.
- "AI로 분류 정리" 제안·적용 로직(`CategoryMappingPanel.tsx`, `classify/route.ts`)은 지금 "문자열 rename"으로
  동작하는데, ID 기반으로 바뀌면 **"두 노드를 하나로 합치기"**(A id → B id로 재배정, A 삭제)로 의미가
  바뀐다 — 로직 자체는 단순해지지만(문자열 비교 대신 FK 재배정) 구현 지점이 바뀐다는 걸 적어둔다.

### 2.2 마켓 계정: 거래처당 1개 → 거래처당 여러 개 (`marketplace_credentials` 확장)

```sql
ALTER TABLE marketplace_credentials ADD COLUMN IF NOT EXISTS account_label TEXT NOT NULL DEFAULT 'default';
-- 기존 UNIQUE(client_id, marketplace_code) 제거, 아래로 교체
DROP INDEX IF EXISTS marketplace_credentials_client_market_idx;
CREATE UNIQUE INDEX marketplace_credentials_client_market_account_idx
  ON marketplace_credentials(client_id, marketplace_code, account_label);
```

- 기존 행은 `account_label='default'`로 자동 채워져 **데이터 변경 없이 그대로 유효** — 지금처럼 계정이
  1개인 거래처는 아무 것도 안 바뀐 것처럼 동작한다.
- 새 테이블을 만들지 않고 기존 테이블을 확장한 이유: 인증정보(`credential_data_encrypted`)·거래처 단위
  배송설정(`settings`)이 이미 이 테이블에 있고, "계정"이라는 개념이 정확히 "그 인증정보 묶음 자체"이기
  때문 — 새 테이블을 만들면 "계정 1개 = credential 1행"이라는 자연스러운 1:1을 억지로 쪼개게 된다.
- **영향 범위(코드)**: `lib/marketplace/credentialStore.ts`(조회 함수가 `client_id+marketplace_code`로
  "그 거래처의 그 마켓 인증정보"를 1개로 가정하고 있다면 `account_label` 또는 `credential_id`를 받는
  시그니처로 변경 필요), `MarketplaceRegisterPanel.tsx`(계정이 여러 개면 등록 전에 "어느 계정으로 등록할지"
  선택 UI 필요 — 지금은 마켓만 고르면 끝이었음), `app/api/marketplace/[code]/register/route.ts`(credential
  조회에 account 특정 필요). **이 부분이 이번 재설계에서 가장 큰 코드 변경 블라스트 레이디어스다** — 구현
  단계에서 별도로 꼼꼼히 훑어야 한다.

## 3. 고시정보(§2의 "효율적인 방법" 결정) — 카테고리×마켓 템플릿 + 상품×채널 예외 오버라이드, 2계층

**결정**: 쿠팡 전용으로 흩어져 있던 두 개념(①등록 시점 라이브 조회 `CategoryNoticeItem`, ②엑셀 양식용
슬롯-라벨 매핑 `CoupangCategoryProfileEditor`/`categoryProfiles` JSONB)을 **하나의 범마켓(汎marketplace)
테이블로 통합**한다. 이유: `categoryProfiles`는 로드맵 문서(`!specifications/ptp-migration-roadmap.md:141`)에
"구조만 완료, 실데이터 라벨 입력 대기 중"이라고 적혀 있어 — **아직 실 운영 데이터가 없다**. 즉 지금
통합해도 마이그레이션 리스크가 없는, 손 대기 가장 안전한 시점이다.

```sql
CREATE TABLE notice_templates (
  id                   SERIAL PRIMARY KEY,
  marketplace_code     TEXT NOT NULL REFERENCES marketplace_configs(code),
  master_category_id   INT NOT NULL REFERENCES master_categories(id),
  field_key            TEXT NOT NULL,
  field_label          TEXT,
  default_value        TEXT,
  source_product_field TEXT,  -- 예: 'origin' — 있으면 product_master의 이 필드 값으로 기본값을 자동 채움
                               -- (categoryProfiles의 "슬롯↔필드 매핑" 역할을 그대로 흡수)
  sort_order           INT DEFAULT 0,
  updated_at           TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (marketplace_code, master_category_id, field_key)
);
```

- **왜 카테고리×마켓 단위(계정 단위 아님)인가**: 법정 고시항목은 "이 카테고리에 뭘 표시해야 하는가"라는
  법률/마켓 룰 문제라 계정(누가 파는지)과 무관하다 — 세 솔루션 다 이 지점은 계정이 아니라 카테고리 기준이었다.
- **상품별 예외**(예: 식품의 소비기한처럼 같은 카테고리라도 상품마다 다른 값)는 템플릿이 아니라
  `product_channel_listings.notice_field_overrides`(JSONB, §4)에 저장 — "이 상품만 이 마켓에선 이 값으로"의
  드문 예외 케이스를 템플릿 테이블에 행으로 안 섞는다.
- **해석 순서**(등록/엑셀 양쪽 다 동일): `product_channel_listings.notice_field_overrides[field_key]`가
  있으면 그 값 → 없으면 `notice_templates.default_value`(또는 `source_product_field`로 상품마스터 값 자동
  참조) → 둘 다 없으면 빈 값(쿠팡은 지금처럼 등록 화면에서 사람이 채움).
- **쿠팡의 기존 라이브 `CategoryNoticeItem` 조회는 유지**한다 — "이 카테고리에 무슨 필드가 필수인지"는
  마켓 API가 제일 정확하므로, `notice_templates`는 그 필드들의 **기본값을 채워두는 곳**이지 필드 정의 자체의
  소스는 아니다(필드 정의 소스 = 마켓 API, 기본값 저장소 = `notice_templates`, 역할 분리).

## 4. 채널별 실제 값 — 기존 `product_channel_listings` 확장 (신규 테이블 안 만듦)

[[marketplace-channel-overrides]]에서 제안했던 신규 `channel_overrides` 테이블은 **철회한다** — 이미
"채널(마켓)별 등록용 상품명/URL을 상품마다 저장"하는 `product_channel_listings` 테이블이 있다는 걸
재설계 과정에서 다시 확인했고(`lib/db.ts:638-652`), 여기에 컬럼만 더하는 게 "같은 개념, 두 테이블"을
피하는 더 효율적인 방법이다.

```sql
ALTER TABLE product_channel_listings ADD COLUMN IF NOT EXISTS marketplace_credential_id INT REFERENCES marketplace_credentials(id);
ALTER TABLE product_channel_listings ADD COLUMN IF NOT EXISTS search_tags_override TEXT;
ALTER TABLE product_channel_listings ADD COLUMN IF NOT EXISTS price_override JSONB;
ALTER TABLE product_channel_listings ADD COLUMN IF NOT EXISTS notice_field_overrides JSONB DEFAULT '{}';
-- channel_name 컬럼이 이미 "이 채널 전용 상품명" 역할 — 새 컬럼 불필요, 그대로 재사용
```

- `channel_name`이 이미 샵링커의 "쇼핑몰 상품 조회·수정"(개별 override)에 해당하는 개념이었다 — 이번에
  발견한 건 "이름만 되고 가격/검색어/고시는 안 됐다"는 것뿐이라, 테이블을 새로 만들 이유가 없었다.
- **다중 계정 대응**: `marketplace_credential_id`를 추가하고 UNIQUE를 `(product_master_id, marketplace_code)`
  에서 **`(product_master_id, marketplace_credential_id)`**로 바꾼다 — 같은 상품을 같은 마켓의 계정 A/B에
  각각 다른 조건으로 등록하는 걸 지원하려면 이게 필수다(현재는 마켓당 1행만 가능해 다중 계정을 못 담는다).
  `marketplace_code`는 조회 편의상(계정 없이 "이 상품, 이 마켓의 대표 리스팅"을 빠르게 보고 싶을 때) 그대로
  남겨두되, 유일성 보장은 `marketplace_credential_id` 쪽으로 옮긴다.
- **해석 순서**(검색어/가격): `product_master`의 공통값(§5) → `product_channel_listings`의 override가
  있으면 그걸로 대체. 신규 테이블/신규 폴백 체인 없이, 이미 §6 Option B에서 검증한 "LEFT JOIN + 폴백" 패턴을
  그대로 한 번 더 쓴다(`app/api/export/route.ts`, `app/api/marketplace/[code]/register/route.ts` 양쪽에
  동일 패턴 적용).

## 5. `product_master` 자체 — 거의 그대로, 두 가지만 변경

- `master_category`(TEXT) → `master_category_id`(INT FK, §2.1). TEXT 컬럼은 과도기 동안 유지.
- `search_tags`(TEXT, 신규) 추가 — [[product-master-column-management]] §3.3에서 이미 확정한 필드,
  이번 재설계에도 그대로 편입(마켓별 override는 §4에서 흡수했으니 `search_filter_values`는 당장 보류 —
  §3.3의 두 필드 중 하나는 이번에 흡수, 나머지 하나는 실사용 수요가 더 뚜렷해지면 추가).
- 그 외 15개 고정 필드(name/brand/manufacturer/origin/description/가격3종/배송비/기타비용/재고2종/내부코드/
  판매관리코드)는 **그대로 둔다** — 세 솔루션 조사에서도 이 필드들은 전부 "공통값"으로 수렴했고(§2 결론
  유지), 바꿀 근거가 없다. "전체 재설계"라고 해서 안 바뀐 부분까지 억지로 바꾸지 않는다.

## 6. 전체 그림 (ER 요약)

```
master_categories (신규, 트리)
   ├─ product_master.master_category_id ──┐
   └─ category_channel_mappings.master_category_id   (대체: master_category TEXT)

marketplace_credentials (확장: account_label 추가, 거래처당 마켓당 N개)
   └─ product_channel_listings.marketplace_credential_id (신규 FK)

notice_templates (신규: marketplace_code × master_category_id × field_key → 기본값)
   └─ product_channel_listings.notice_field_overrides (JSONB, 상품별 예외만)

product_channel_listings (확장: search_tags_override / price_override / notice_field_overrides)
   = "이 상품을, 이 마켓 계정으로 낼 때의 실제 값" — 유일한 쓰기 대상(런타임 소스 오브 트루스)

product_master (거의 그대로 + master_category_id + search_tags)
   = "공통값" — 오버라이드가 없으면 이 값이 그대로 나간다
```

읽기 시 해석 순서(엑셀 내보내기·오픈마켓 등록 양쪽 공통): **`product_channel_listings`(이 상품×이 계정
전용값) → 없으면 `notice_templates`(고시만, 카테고리×마켓 기본값) → 없으면 `product_master`(공통값) →
없으면 빈 값(사람이 채움, 조용한 추정 금지).**

## 7. 마이그레이션 순서 (안전한 추가형, 단계별)

1. `master_categories` 테이블 생성 + 기존 `master_category` distinct 값을 루트 노드로 이관 + 양쪽 테이블에
   `master_category_id` 컬럼 추가·백필(기존 TEXT 컬럼 유지, 삭제 안 함).
2. `marketplace_credentials`에 `account_label` 추가(`DEFAULT 'default'`로 기존 행 자동 호환) + UNIQUE 교체.
3. `notice_templates` 테이블 생성(빈 상태로 시작 — 기존 `categoryProfiles`는 실데이터 없다고 확인했으니
   마이그레이션 불필요, `CoupangCategoryProfileEditor`를 이 테이블을 읽도록 다시 연결만 하면 됨).
4. `product_channel_listings`에 `marketplace_credential_id`/override 3종 컬럼 추가 + 기존 행의
   `marketplace_credential_id`를 `(product_master_id의 client_id, marketplace_code, account_label='default')`로
   백필 + UNIQUE를 `(product_master_id, marketplace_credential_id)`로 교체.
5. `product_master`에 `search_tags` 컬럼 추가.
6. (이후 별도 작업) 화면 구현 — 카테고리 트리 관리, 계정 선택 UI, 고시 템플릿 관리, 채널별 override 입력.

1~5는 전부 "컬럼/테이블 추가 + 백필"이라 기존 기능을 끊지 않고 적용 가능 — 각 단계마다 기존 TEXT
컬럼/단일-계정 가정 코드가 당장 깨지지 않는지 확인하며 순서대로 진행한다.

## 8. 영향받는 코드 (구현 착수 전 훑어야 할 목록)

- `lib/db.ts` — 테이블 정의/마이그레이션 추가.
- `lib/master/migrate.ts` — `master_category` 대신 `master_category_id` 배정 로직.
- `components/panels/CategoryMappingPanel.tsx`, `app/api/category-mappings/*` — ID 기반으로 전환, "AI 분류
  정리"가 "rename"에서 "노드 병합"으로 의미 변경.
- `app/api/export/route.ts`, `app/api/marketplace/[code]/register/route.ts` — §6 해석순서(폴백 체인) 적용.
- `lib/marketplace/credentialStore.ts`, `components/panels/MarketplaceRegisterPanel.tsx` — 다중 계정 선택 UI/조회.
- `components/panels/CoupangCategoryProfileEditor.tsx`, `app/api/marketplace-configs/[code]/category-profile/route.ts`
  — `notice_templates` 테이블로 재연결(기존 JSONB 저장 폐기).
- 신규: 카테고리 트리 관리 화면(루트 노드들을 실제 계층으로 정리하는 UI) — 이번 마이그레이션(1단계)이
  "전부 루트 노드"로 시작하므로, 이 화면 없이는 계층화 효과가 없다. 구현 우선순위 1순위.

## 9. 구현 완료 기록 (2026-10-05)

§7의 1~5단계를 전부 적용했다 — `tsc --noEmit`/`lint`/`test:unit`(457개) 전부 통과 확인 후, **실제 로컬
Postgres(`scrape-postgres` 컨테이너)에 직접 적용해 결과까지 검증**했다(자기테스트 — 사용자가 화면으로
확인하기 전에 직접 돌려봄):

- `master_categories`: 기존 `product_master`/`category_channel_mappings`의 distinct 평문 카테고리에서
  **루트 노드 52개**가 정확히 생성됨, 중복 이름 0건(부분 유니크 인덱스 정상 동작).
- `product_master` 백필: 전체 2,443행 중 2,392행에 `master_category_id`가 채워짐 — 나머지 51행은
  `master_category`가 애초에 비어있는 행(draft 등)이라 "채워야 하는데 놓친" 행은 **0건**.
- `category_channel_mappings`, `marketplace_credentials`(account_label + 신규 UNIQUE), `product_channel_listings`
  (신규 컬럼 4종 + FK), `notice_templates` 전부 실제 컬럼/제약조건까지 `\d` 명령으로 직접 확인.
- `product_channel_listings`의 기존 UNIQUE(product_master_id, marketplace_code)는 **의도대로 그대로
  보존**됨(§7에서 계획한 대로 — 계정 선택 UI가 생기기 전까진 안 건드림, register 라우트의 기존
  ON CONFLICT가 깨지지 않음을 직접 확인).

**부수 발견(다음 단계에 유용)**: 백필된 기존 카테고리 평문 값 상당수가 이미 `"강아지 > 장난감/훈련용품"`,
`"홈 > 스페셜분류 2 > ♥ 국내제작 ♥"`처럼 **" > " 구분자로 계층을 암시하는 문자열**이었다 — §8의 "카테고리
트리 관리" 화면을 만들 때, 전부 수작업으로 계층을 나눌 필요 없이 **이 구분자를 기준으로 자동 분할하는
1차 제안 기능**을 먼저 넣으면 상당수가 자동으로 정리될 것으로 보인다(루트 노드 52개 중 다수가 이 패턴).

## 11. §8 구현 완료 기록 (2026-10-05, 순차 진행 — "순차적으로 진행해")

### 11.1 카테고리 트리 관리 화면

- 신규: `lib/master/categories.ts`(get-or-create/트리조회/순환참조 체크 공용 함수, `migrate.ts`도 이걸 재사용하도록 리팩터링), `app/api/master/categories/route.ts`(GET 트리 전체·POST 노드 생성), `app/api/master/categories/[id]/route.ts`(PUT 이름변경·이동, DELETE), `app/api/master/categories/auto-split/route.ts`(GET 미리보기·POST 적용 — "부수 발견"의 `" > "` 자동분할), `components/panels/CategoryTreePanel.tsx`, Sidebar/Workspace/TabsContext 배선.
- **실DB 라이브 테스트**: 자동분할 제안 40건 중 39건 적용 성공, 1건은 진짜 중복이름 충돌로 정상 실패(에러 메시지 확인) — 순환참조 이동 시도(400)와 상품이 걸려있는 카테고리 삭제 시도(409, FK 보호) 둘 다 의도대로 막히고 트리 데이터는 그대로 보존됨을 확인.

### 11.2 다중 계정 선택 UI

- `ClientDetailPanel.tsx`에 "계정 구분" 입력란 추가(기본 `default`), `MarketplaceRegisterPanel.tsx`는 거래처가 그 마켓에 계정이 2개 이상일 때만 선택 드롭다운을 보여줌(1개뿐인 절대다수는 화면 그대로).
- `credentialStore.loadClientCredentials`/저장-조회 라우트 전부 `account_label`까지 조건에 넣도록 수정.
- **실DB 라이브 테스트**: 테스트 거래처에 쿠팡 계정 2개(`default`/`second`) 저장 → `accountLabel`별로 각각 다른 자격정보가 정확히 로드됨을 등록 API 호출로 확인, 존재하지 않는 accountLabel은 "접속정보가 없습니다"로 올바르게 거부됨을 확인. 테스트 데이터 삭제로 정리.

### 11.3 고시 템플릿 관리 — 설계 수정 사항 발견

**중요 정정**: 당초 "`CoupangCategoryProfileEditor`/`categoryProfiles`를 `notice_templates`로 통합"하려 했으나, 실제 컴포넌트를 읽어보니 **둘은 서로 다른 파이프라인을 위한 것**이었다 — `categoryProfiles`는 쿠팡 **엑셀 대량등록 양식**의 슬롯(옵션/고시 컬럼) ↔ product_master 필드 매핑(`!specifications/coupang-category-profile-mapping.md`, 로드맵상 "실데이터 없음"으로 확인되긴 했으나 애초에 역할이 다름)이고, 이번에 만든 `notice_templates`는 **API 등록 화면의 `noticeContents` 기본값**이다. 둘 다 "쿠팡 고시정보"라는 단어가 겹쳐 같은 것으로 오인했던 설계 실수 — **`CoupangCategoryProfileEditor`는 그대로 둔다(손 안 댐).**
- 대신 실제로 쓸모 있는 통합 지점을 새로 구현: `MarketplaceRegisterPanel`의 "카테고리 정보 조회" 직후, 선택한 상품들이 전부 같은 내부 카테고리면 `notice_templates`에서 저장된 기본값을 자동으로 채우고, 입력 필드 옆에 "기본값으로 저장" 버튼을 둬서 다음에 재사용할 수 있게 했다.
- 신규: `app/api/notice-templates/route.ts`(GET/PUT), `app/api/master/route.ts`에 `master_category_id` 추가(선택된 상품들이 같은 카테고리인지 판단하는 데 필요).
- **실DB 라이브 테스트**: PUT→GET 왕복, 같은 필드 재저장 시 덮어쓰기(새 행 안 생김) 확인.

### 11.4 export/register 라우트에 override 폴백 체인 적용

- `app/api/export/route.ts`: `product_channel_listings`(채널별 override)를 조회해 `name_final`/`sale_price`/`list_price`/`search_tags`에 override 우선 적용 — §6 Option B와 동일한 LEFT JOIN + 폴백 패턴.
- **부수 발견**: `lib/excel/coupang.ts`·`lib/excel/naver.ts`의 "검색태그" 컬럼과 `lib/excel/naver.ts`·`lib/excel/eleven.ts`(11번가/G마켓/옥션)의 "카테고리ID/카테고리코드" 컬럼이 **이미 양식엔 있었지만 전부 하드코딩된 빈 문자열이었다** — `p.search_tags`/`p.category`를 실제로 안 읽고 있었던 기존 버그성 공백. 이번에 전부 실제 값을 읽도록 고쳤다(4개 마켓 엑셀 전부 영향 — Option B가 쿠팡/샵링커·사방넷에만 효과가 있었던 것도 이번에 같이 해소됨).
- `app/api/marketplace/[code]/register/route.ts`: 같은 패턴으로 이름/가격 override 적용(검색어는 쿠팡 API 페이로드에 실을 자리가 없어 제외 — `lib/marketplace/coupang.ts` 확인 결과 search_tags를 쓰는 필드가 없음).
- **실DB 라이브 테스트(가장 철저하게 검증)**: 테스트 상품에 쿠팡 전용 override(상품명/판매가/검색어)를 걸어두고 실제로 `/api/export`를 쿠팡·네이버 두 마켓으로 호출 → 생성된 xlsx를 직접 파싱해 셀 값까지 확인. 쿠팡 시트는 override 값이, 네이버 시트는 override가 해당 마켓 전용이라 적용 안 되고 상품마스터 공통값으로 정확히 폴백되는 것까지 확인. 테스트 데이터/산출물 전부 정리.

### 11.5 전체 검증

매 단계마다 `tsc --noEmit`/`eslint`/`test:unit`(462개) 통과 확인. 최종적으로 스키마 변경 5개 + 화면/API
4종 전체가 끝난 뒤 다시 한 번 전체 통과 확인.
