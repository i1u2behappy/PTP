# 채널(마켓)별 오버라이드 설정 — 설계

> **⚠ 대체됨(2026-10-05)**: 이 문서의 설계는 [[product-master-architecture-redesign]]으로 대체됐다
> (사용자가 거래처당 마켓 계정이 여러 개인 경우를 확인해줘서, 신규 `channel_overrides` 테이블 대신 기존
> `product_channel_listings`를 확장하는 쪽으로 더 효율적인 설계가 나왔다). 아래 내용은 그 전까지의 사고
> 과정 기록으로 남겨둔다 — 구현은 새 문서 기준으로 진행할 것.

상태: 설계만 완료, 구현 전. [[product-master-column-management]] §7-3①("마켓별 override 값 분리")의
후속 설계 라운드로, 세 솔루션(샵링커/사방넷/플레이오토) 심층조사에서 가장 강하게 수렴한 공백을 다룬다
(근거: [[marketplace-formats/reference-oms-product-master-formats]] "교차 검증" 절).

## 0. 배경 — 왜 필요한가

PTP의 상품마스터(`product_master`)는 "여러 마켓에 공용으로 쓰는 1벌"이라는 전제로 설계됐다(§0 참고).
그런데 실제로는 상품명/가격/검색어/고시정보 중 상당수가 **"마켓마다 다르게 내야 하는" 값**이다 — 지금
PTP는 이걸 전혀 지원하지 않아 모든 마켓에 상품마스터 값을 그대로 복제해서 쓴다.

세 솔루션을 각각 독립적으로 조사했는데도 전부 이 문제를 풀기 위한 장치를 갖고 있었다(사실상 짠 것처럼
수렴 — 자세한 근거는 참고 문서):

- **샵링커**: "그룹"(카테고리+배송정책 묶음) + 등록 시점 추가 override. 가격은 자체3종+몰별3종+시작가
  총 7종이 공존.
- **사방넷**: "쇼핑몰부가정보코드"(배송 템플릿)와 "상품정보고시템플릿관리"(고시 템플릿) — 둘 다 "한 번
  만들고 여러 상품에 재사용"하는 독립 메뉴.
- **플레이오토(EMP)**: "세트"(판매기간/배송정보/할인율/부가서비스 override 묶음, 겹치면 세트가 우선),
  "품목정보2~5"(몰마다 다른 고시값을 최대 5세트까지).

공통 패턴: **"상품마다 값을 다시 입력"하지 않고, "마켓(또는 마켓+카테고리) 단위의 재사용 가능한 override
템플릿"을 먼저 만들어두고, 상품은 그 템플릿을 참조한다.**

## 1. PTP 설계안

### 1.1 데이터 모델

새 테이블 `channel_overrides`(안):

```sql
CREATE TABLE channel_overrides (
  id                  SERIAL PRIMARY KEY,
  client_id           INT REFERENCES supply_clients(id) ON DELETE CASCADE,
  marketplace_code     TEXT REFERENCES marketplace_configs(code),
  master_category      TEXT,          -- NULL이면 "이 거래처×마켓 전체"에 적용되는 기본 템플릿
  override_name        TEXT NOT NULL, -- 사람이 구분하는 이름, 예: "의류 쿠팡 기본"
  name_prefix          TEXT,          -- 상품명 앞 추가문구(override, 샵링커의 override 패턴)
  name_suffix          TEXT,
  search_tags_override TEXT,          -- 이 마켓 전용 검색어(쉼표구분) — §3.3 search_tags를 덮어씀
  notice_values        JSONB DEFAULT '{}', -- 고시 템플릿 값 {필드명: 값}, 카테고리 메타(CategoryNoticeItem)와 매칭
  price_adjustment     JSONB,         -- {"type":"percent"|"fixed", "value": number} 같은 간단한 조정식(1차는 이 정도로 충분, 복잡한 공식은 범위 밖)
  created_at           TIMESTAMPTZ DEFAULT NOW(),
  updated_at           TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (client_id, marketplace_code, master_category)
);
```

- 샵링커 "그룹", 사방넷 "템플릿", 플레이오토 "세트" 세 가지 다른 이름의 개념을 하나로 통합한 것.
- `master_category`가 NULL인 행 = "이 마켓에 대한 기본값"(카테고리 무관 공통 override), 특정값이 있으면
  그 카테고리 전용 override — 조회 시 "카테고리 전용 → 없으면 기본값 → 없으면 상품마스터 원값" 순 폴백.
- 배송/반품은 포함하지 않는다 — 그건 이미 `marketplace_credentials.settings`(거래처×마켓 공통설정)로
  풀려 있고 세 솔루션도 "보통 공급사 단위 공통 1개면 충분"이라는 쪽이 다수였다(§2 결론 유지).

### 1.2 product_master와의 연결 — "자동매칭 + 사람 확인" 패턴 재사용

연결 방식에 세 가지 선택지가 있었다:

- (a) `product_master`에 override FK 컬럼 추가 — 상품마다 수동 지정, 가장 명시적이지만 상품 수만큼 매번
  지정해야 해서 "템플릿 재사용"이라는 원래 목적과 어긋난다.
- (b) 완전 자동 — `master_category`가 일치하면 무조건 적용 — 빠르지만 "조용한 오매핑 금지" 원칙
  (`lib/marketplace/types.ts:40-53`, [[marketplace-api-integration]])과 충돌할 소지가 있다.
- **(c, 채택) `master_category` 기준으로 자동 매칭해 "미리보기"로 보여주고, 등록/엑셀 실행 시점에 사람이
  한 번 확인하게 한다** — 이미 카테고리 매핑의 "AI 분류 제안 → 적용" 패턴(`CategoryMappingPanel.tsx`)과
  Option B(엑셀 카테고리 연결, `app/api/export/route.ts`)에서 쓴 "자동 조회값 + 폴백" 패턴을 그대로
  확장하는 것이라 이 프로젝트의 기존 관례와 가장 잘 맞는다. 별도 매핑 테이블을 새로 만들 필요도 없다 —
  `channel_overrides` 자체가 이미 `(client_id, marketplace_code, master_category)` 키로 조회 가능하다.

### 1.3 파이프라인 적용 지점

§6 Option B와 완전히 같은 모양으로 확장한다:

- **엑셀 내보내기**(`app/api/export/route.ts`): 지금 `categoryMap`을 조회하는 것과 같은 자리에
  `channel_overrides`도 함께 조회해, `name`/`search_tags`/가격 필드에 override가 있으면 우선 적용하고
  없으면 기존 상품마스터 값으로 폴백.
- **쿠팡 등록**(`app/api/marketplace/[code]/register/route.ts`): `RegistrationItem` 생성 시 같은 방식으로
  override를 조회해 `noticeContents`(이미 있는 필드)와 상품명/검색어에 반영. `categoryCode`는 여전히
  사람이 확인하는 현재 흐름을 유지(§6의 "자동 해석 금지" 원칙은 그대로).

### 1.4 UI — 신규 메뉴 "채널별 상품정보 설정"(가칭)

- 위치: Sidebar "마이그레이션" 그룹, "카테고리 매핑" 바로 다음(카테고리 매핑과 마찬가지로 "상품마스터
  → 마켓"을 잇는 성격이라 옆에 두는 게 자연스럽다).
- 화면: 마켓 선택 → 이 마켓의 override 템플릿 목록(이름/적용 카테고리/수정일) → [신규] 또는 [수정]으로
  템플릿 편집 폼(검색어/상품명 접두·접미/가격조정/고시값) 진입.
- 고시값 입력은 쿠팡의 경우 이미 있는 category-meta 조회(`CoupangCategoryProfileEditor`가 쓰는
  `CategoryNoticeItem` 목록)를 그대로 재사용해 "이 카테고리에 필요한 고시 항목"을 보여주고 값만 입력받는다
  — 새로 만들지 않는다.

## 2. 이번 조사로 "같이" 발견됐지만 범위가 다른 것 — 복수 판매계정

메뉴 수준 재점검(`[[marketplace-formats/reference-oms-product-master-formats]]` 참고) 중 이 설계와는
별개로 진짜 공백 하나가 추가로 드러났다: **PTP는 거래처 하나당 마켓 하나당 계정을 1개만 등록할 수 있다**
(`marketplace_credentials`의 `UNIQUE(client_id, marketplace_code)`, `lib/db.ts:699-700`). 샵링커(한 몰에
로그인ID 여러 개)와 플레이오토(ESM 계정 묶음)는 이걸 지원한다 — 거래처가 쿠팡 판매자 계정을 2개 이상
운영하면 PTP로는 둘 다 못 돌린다.

이건 이 문서(override 값)와는 다른 종류의 변경(스키마 UNIQUE 제약 자체를 바꿔야 함, 인증 관리 전체에
영향)이라 **별도 설계 라운드로 분리**해둔다 — 지금 당장 거래처가 복수 계정을 실제로 쓰고 있는지부터
확인이 필요한 사안.

## 3. 1차 구현 범위 제안

- **1단계(가장 간단, 가장 많이 확인된 패턴)**: `search_tags_override`만 먼저 — §3.3에서 이미 설계된
  `search_tags` 컬럼에 "마켓별로 다른 값"을 낼 수 있게 하는 것부터. 스키마도 작고 영향 범위(엑셀 export)도
  작다.
- **2단계**: `name_prefix`/`name_suffix`, `price_adjustment`.
- **3단계(가장 복잡)**: `notice_values` — 쿠팡의 기존 `CoupangCategoryProfileEditor`/`categoryProfiles`
  구조와 겹치는 부분이 있어(둘 다 "카테고리별 고시 항목" 개념), 통합할지 분리 유지할지 먼저 결정 필요.
  `categoryProfiles`는 "슬롯 라벨 ↔ product_master 필드" 매핑(엑셀 대량등록 양식 전용, §5 코드 참고)이고
  이 문서의 `notice_values`는 "실제 입력값 저장"이라 역할이 다르지만, 사용자 입장에선 "고시정보 관리"가
  두 군데로 쪼개져 보일 위험이 있다 — 3단계 착수 전에 통합 여부를 확인한다.

## 4. 다음 단계

1단계(`search_tags_override`)부터 스키마+API+UI 구현에 들어갈지, 아니면 전체(1~3단계) 설계를 먼저 더
다듬을지 확인 후 진행.
