import type { ProductMasterRow } from '../excel/types'

export interface UploadResult {
  success: number[]
  failed: { id: number; error: string }[]
}

/**
 * 4단계(오픈마켓 API 연동)의 확장 포인트 — 이번 라운드는 설계만, 구현체는 없다.
 * 향후 마켓별 어댑터(lib/marketplace/coupang-api.ts 등)가 이 인터페이스로 registry.ts에 등록된다.
 */
export interface MarketplaceUploader {
  code: string
  validate(products: ProductMasterRow[]): { ok: boolean; errors: string[] }
  upload(products: ProductMasterRow[], credentials: Record<string, unknown>): Promise<UploadResult>
}

// ── 오픈마켓 API 연동 2단계: 인증정보/카테고리 메타데이터 (!specifications/
// marketplace-api-integration.md §3) ─────────────────────────────────────────

/** 화면이 거래처별 접속정보/정책설정 입력폼을 마켓마다 다르게 그리기 위한 필드 정의. options가
 *  있으면 자유 텍스트 대신 드롭다운으로 그려 오타로 인한 enum 값 오류(예: 배송방식 철자 틀림)를
 *  원천 차단한다. */
export interface CredentialField { key: string; label: string; secret?: boolean; options?: string[] }

export interface CredentialVerifyResult { ok: boolean; error?: string }

/** 카테고리 하나의 구매옵션 속성 하나 — 쿠팡 Category Metadata Query 응답의 attributes[] 원소에 대응. */
export interface CategoryAttribute { name: string; required: boolean }

/** 상품정보제공고시 필수 항목 하나 — noticeCategories[].noticeCategoryDetailNames[]에 대응.
 *  categoryName(예: "화장품")까지 같이 들고 있어야 실제 등록 요청의 notices[].noticeCategoryName에
 *  그대로 쓸 수 있다. */
export interface CategoryNoticeItem { categoryName: string; name: string; required: boolean }

export interface CategoryMeta { attributes: CategoryAttribute[]; notices: CategoryNoticeItem[] }

export interface ValidationError { field: string; reason: string }

/**
 * 상품 하나를 등록할 때 필요한 입력 — ProductMasterRow만으로는 부족한 두 가지를 호출부가 채워야 한다.
 * (1) categoryCode: category_channel_mappings의 채널값이 실제 마켓의 숫자 카테고리코드와 같은 보장이
 *     없어(!specifications/marketplace-api-integration.md) 자동 해석하지 않고 명시적으로 받는다.
 * (2) noticeContents: 상품정보제공고시 실제 내용(예: "용량(중량)"→"200ml") — PTP에 이 값의 자동 소스가
 *     아직 없다(쿠팡 카테고리별 슬롯 매핑은 엑셀 양식 전용이라 이 API 경로와 다른 데이터 모양,
 *     !specifications/coupang-category-profile-mapping.md 참고). 호출부가 직접 공급해야 하고, meta의
 *     필수 고시항목이 여기 없으면 register()가 그 상품을 거부한다(조용히 누락시키지 않는다).
 */
export interface RegistrationItem {
  product: ProductMasterRow
  categoryCode: string
  noticeContents: Record<string, string>
}
export interface RegistrationSuccess { productMasterId: number; externalId: string }
export interface RegistrationFailure { productMasterId: number; error: string }
export interface RegistrationResult { success: RegistrationSuccess[]; failed: RegistrationFailure[] }

export interface MarketplaceProductAdapter {
  code: string
  credentialFields(): CredentialField[]
  /** 상품별 데이터가 아니라 거래처(벤더) 단위 배송/반품 정책 — 쿠팡 상품생성 API가 요구하는 필드 상당수가
   *  여기 해당한다(2026-10-03, register() 설계 중 발견한 공백). 비밀값이 아니므로 평문 저장한다. 어댑터가
   *  이 메서드를 안 쓰면(빈 배열) 화면에 이 섹션 자체가 안 뜬다. */
  settingsFields(): CredentialField[]
  verifyCredentials(cred: Record<string, string>): Promise<CredentialVerifyResult>
  fetchCategoryMeta(displayCategoryCode: string, cred: Record<string, string>): Promise<CategoryMeta>
  /** 로컬 1차 검증 — meta의 필수 속성/고시정보 이름이 product의 options/custom_fields 어딘가에
   *  대응값이 있는지만 확인한다(실제 슬롯 매핑은 !specifications/coupang-category-profile-mapping.md가
   *  담당하는 더 큰 작업 — 여기서는 "완전히 빠진 건 없는지"만 거른다). */
  validate(product: ProductMasterRow, meta: CategoryMeta): { ok: boolean; errors: ValidationError[] }
  /** 실제 등록(쿠팡 Product Creation API 호출). 항목별로 독립 처리 — 하나 실패해도 나머지는 계속
   *  진행한다(failed에 담아 호출부가 개별 확인하게 한다). */
  register(items: RegistrationItem[], cred: Record<string, string>, settings: Record<string, string>): Promise<RegistrationResult>
}
