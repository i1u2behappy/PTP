import type { ProductMasterRow } from '../excel/types'
import { resolveOptionCombinations } from './optionCombinations'
import type {
  CategoryMeta, CredentialField, CredentialVerifyResult, MarketplaceProductAdapter,
  RegistrationItem, RegistrationResult, ValidationError,
} from './types'
import { coupangAuthorizationHeader, signCoupangRequest } from './coupangSign'

const BASE_URL = 'https://api-gateway.coupang.com'

/**
 * 쿠팡 Wing Open API 어댑터.
 *
 * **중요(미검증 고지)**: 서명 로직(lib/marketplace/coupangSign.ts)은 공식 문서(developers.coupang.com)를
 * 그대로 옮긴 것이지만, 이 환경에 실제 쿠팡 벤더 키가 없어 **실제 호출로 성공 응답을 받아본 적은 없다**.
 * 처음 실사용할 때 반드시 쿠팡이 내려준 테스트 계정으로 verifyCredentials()부터 확인할 것 — register()도
 * 실제 상품이 생성되는 고위험 동작이라, 처음 쓸 때는 테스트 계정/카테고리로 1건만 먼저 해볼 것.
 */

interface CoupangApiResponse<T> { code: string; message: string; data: T }
interface CoupangCategoryAttribute { attributeTypeName: string; required: 'MANDATORY' | 'OPTIONAL' }
interface CoupangNoticeDetail { noticeCategoryDetailName: string; required: 'MANDATORY' | 'OPTIONAL' }
interface CoupangNoticeCategory { noticeCategoryName: string; noticeCategoryDetailNames: CoupangNoticeDetail[] }
interface CoupangCategoryMetaResponse {
  attributes: CoupangCategoryAttribute[]
  noticeCategories: CoupangNoticeCategory[]
}

async function coupangRequest<T>(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  query: string,
  cred: Record<string, string>,
  body?: unknown,
): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  const { vendorId, accessKey, secretKey } = cred
  if (!vendorId || !accessKey || !secretKey) return { ok: false, error: '필수 인증정보(vendorId/accessKey/secretKey)가 없습니다' }

  // 서명 메시지는 datetime+method+path+query뿐이고 요청 바디는 포함되지 않는다(공식 문서 확인,
  // lib/marketplace/coupangSign.ts 주석 참고) — POST/PUT도 같은 서명식을 그대로 쓴다.
  const sig = signCoupangRequest(method, path, query, secretKey, new Date())
  const url = `${BASE_URL}${path}${query ? `?${query}` : ''}`
  try {
    const res = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json;charset=UTF-8',
        Authorization: coupangAuthorizationHeader(accessKey, sig),
        'X-Requested-By': vendorId,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
    const resBody = await res.json().catch(() => null) as CoupangApiResponse<T> | null
    if (!res.ok || !resBody) return { ok: false, error: `HTTP ${res.status}${resBody?.message ? `: ${resBody.message}` : ''}` }
    if (resBody.code && resBody.code !== '200' && resBody.code !== 'SUCCESS') return { ok: false, error: resBody.message || `code=${resBody.code}` }
    return { ok: true, data: resBody.data }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) }
  }
}

function coupangCredentialFields(): CredentialField[] {
  return [
    { key: 'vendorId', label: '벤더 ID (예: A00012345)' },
    { key: 'accessKey', label: 'Access Key', secret: true },
    { key: 'secretKey', label: 'Secret Key', secret: true },
  ]
}

/**
 * 쿠팡 상품생성 API가 요구하는 배송/반품 정책 필드 — 상품마다 다른 값이 아니라 이 거래처가 쿠팡에서
 * 쓰는 고정 정책이라 여기서 한 번만 입력받아 등록할 때마다 재사용한다(2026-10-03, register() 설계
 * 중 발견한 공백 — 공식 문서 developers.coupang.com/en/api/products/product-creation 기준).
 * - returnCenterCode: WING에서 반품지를 사전 등록해야 나오는 값 — 모르면 "NO_RETURN_CENTERCODE"를
 *   넣고 아래 반품주소를 직접 입력하면 된다(공식 문서가 명시한 대체 경로).
 * - outboundShippingPlaceCode: "묶음 배송"을 쓸 때만 필수(공식 문서 "묶음 배송 선택 시 필수") —
 *   안 쓰면 비워둬도 된다.
 * - deliveryCompanyCode: 택배사 코드 목록이 꽤 많아(공식 문서 /en/api/logistics/courier-code) 일부만
 *   드롭다운에 넣으면 오히려 "이 택배사는 지원 안 되나?"는 오해를 만든다 — 자유 텍스트로 받는다.
 */
function coupangSettingsFields(): CredentialField[] {
  return [
    { key: 'deliveryMethod', label: '배송방식', options: ['SEQUENCIAL', 'COLD_FRESH', 'MAKE_ORDER', 'AGENT_BUY', 'VENDOR_DIRECT'] },
    { key: 'deliveryCompanyCode', label: '택배사 코드 (예: CJGLS, HANJIN — 공식 문서 "courier-code" 목록 참고)' },
    { key: 'deliveryChargeType', label: '배송비 유형', options: ['FREE', 'NOT_FREE', 'CHARGE_RECEIVED', 'CONDITIONAL_FREE'] },
    { key: 'deliveryCharge', label: '표준 배송료(원) — 유료배송(NOT_FREE)일 때' },
    { key: 'freeShipOverAmount', label: '무료배송 기준금액(원) — 조건부무료(CONDITIONAL_FREE)일 때' },
    { key: 'deliveryChargeOnReturn', label: '반품 편도 배송료(원) — 무료배송(FREE)일 때 필수' },
    { key: 'remoteAreaDeliverable', label: '도서산간 배송 가능 여부', options: ['Y', 'N'] },
    { key: 'returnCenterCode', label: '반품지 센터코드 (모르면 NO_RETURN_CENTERCODE 입력)' },
    { key: 'outboundShippingPlaceCode', label: '출고지 코드 (묶음배송 쓸 때만 필수, 그 외 비워둠)' },
    { key: 'returnChargeName', label: '반품배송비 명칭' },
    { key: 'companyContactNumber', label: '고객센터 연락처' },
    { key: 'returnZipCode', label: '반품지 우편번호' },
    { key: 'returnAddress', label: '반품지 주소' },
    { key: 'returnAddressDetail', label: '반품지 상세주소' },
    { key: 'returnCharge', label: '반품배송료(원) — 초기 반품배송료의 100~150% 범위' },
  ]
}

/** 부작용 없는 조회 1건으로 인증정보가 맞는지만 확인한다 — 전체 카테고리 목록 조회는 파라미터가
 *  필요 없는 가장 가벼운 GET이라 "ping"용으로 적합하다. */
async function coupangVerifyCredentials(cred: Record<string, string>): Promise<CredentialVerifyResult> {
  const res = await coupangRequest('GET', '/v2/providers/seller_api/apis/api/v1/marketplace/meta/display-categories', '', cred)
  return res.ok ? { ok: true } : { ok: false, error: res.error }
}

async function coupangFetchCategoryMeta(displayCategoryCode: string, cred: Record<string, string>): Promise<CategoryMeta> {
  const res = await coupangRequest<CoupangCategoryMetaResponse>(
    'GET',
    `/v2/providers/seller_api/apis/api/v1/marketplace/meta/category-related-metas/display-category-codes/${encodeURIComponent(displayCategoryCode)}`,
    '',
    cred,
  )
  if (!res.ok) throw new Error(res.error)
  return {
    attributes: (res.data.attributes || []).map(a => ({ name: a.attributeTypeName, required: a.required === 'MANDATORY' })),
    notices: (res.data.noticeCategories || []).flatMap(c => c.noticeCategoryDetailNames.map(d => (
      { categoryName: c.noticeCategoryName, name: d.noticeCategoryDetailName, required: d.required === 'MANDATORY' }
    ))),
  }
}

/**
 * 필수 구매옵션 속성이 product.options 어딘가에 실제로 있는지만 확인한다(이름 완전일치). 고시정보
 * (notices)는 여기서 검증하지 않는다 — 어떤 상품마스터 필드/커스텀필드가 어느 고시항목에 대응하는지는
 * 이미 별도 설계(!specifications/coupang-category-profile-mapping.md, 카테고리별 슬롯 매핑)가 담당하는
 * 영역이라, 데이터 근거 없이 "통과"로 단정하면 조용한 오매핑이 된다 — required notice 목록은 errors가
 * 아니라 개수만 반환해 화면에서 "이 카테고리는 필수 고시정보 N개가 있다"는 안내로만 쓰게 한다.
 */
function coupangValidate(product: ProductMasterRow, meta: CategoryMeta): { ok: boolean; errors: ValidationError[] } {
  const optionNames = new Set(product.options.map(o => o.name))
  const errors: ValidationError[] = meta.attributes
    .filter(a => a.required && !optionNames.has(a.name))
    .map(a => ({ field: a.name, reason: '필수 구매옵션 속성인데 상품 옵션에서 찾을 수 없습니다' }))
  return { ok: errors.length === 0, errors }
}

// ── register() ──────────────────────────────────────────────────────────────

interface CoupangItemImage { imageOrder: number; imageType: 'REPRESENTATION' | 'DETAIL'; vendorPath: string }
interface CoupangItemAttribute { attributeTypeName: string; attributeValueName: string }
interface CoupangItemNotice { noticeCategoryName: string; noticeCategoryDetailName: string; content: string }
interface CoupangItemPayload {
  itemName: string
  originalPrice: number
  salePrice: number
  maximumBuyCount: number
  images: CoupangItemImage[]
  attributes: CoupangItemAttribute[]
  notices: CoupangItemNotice[]
}
export interface CoupangCreatePayload {
  displayCategoryCode: number
  sellerProductName: string
  vendorId: string
  saleStartedAt: string
  saleEndedAt: string
  deliveryMethod: string
  deliveryCompanyCode: string
  deliveryChargeType: string
  deliveryCharge?: number
  freeShipOverAmount?: number
  deliveryChargeOnReturn?: number
  remoteAreaDeliverable: string
  returnCenterCode: string
  outboundShippingPlaceCode?: string
  returnChargeName?: string
  companyContactNumber: string
  returnZipCode?: string
  returnAddress?: string
  returnAddressDetail?: string
  returnCharge: number
  items: CoupangItemPayload[]
}

/** settings에 반드시 있어야 하는 키 — 조건부 필수(예: deliveryCharge는 NOT_FREE일 때만)까지는 로컬에서
 *  전부 재현하지 않는다, 쿠팡 서버 응답의 실제 에러 메시지가 더 정확하다. 여기서는 "마켓과 무관하게
 *  항상 필요한" 것만 막는다. */
const REQUIRED_SETTINGS_KEYS = ['deliveryMethod', 'deliveryCompanyCode', 'deliveryChargeType', 'remoteAreaDeliverable', 'returnCenterCode', 'companyContactNumber', 'returnCharge'] as const

/** 한국 시간(UTC+9, 서머타임 없음) 기준 "yyyy-MM-ddTHH:mm:ss" — 공식 문서는 타임존을 명시하지 않지만
 *  국내 플랫폼이라 KST로 해석됨을 전제한다(HMAC 서명용 datetime이 GMT+0로 명시된 것과는 별개 — 그건
 *  서명 메시지 포맷이고 이건 판매기간 값이다). */
function toCoupangDateTime(utcNow: Date): string {
  const kst = new Date(utcNow.getTime() + 9 * 60 * 60 * 1000)
  return kst.toISOString().slice(0, 19)
}

function buildImages(product: ProductMasterRow): CoupangItemImage[] {
  const images: CoupangItemImage[] = []
  if (product.thumbnail_url) images.push({ imageOrder: 0, imageType: 'REPRESENTATION', vendorPath: product.thumbnail_url })
  product.detail_image_urls.forEach((url, i) => images.push({ imageOrder: i + 1, imageType: 'DETAIL', vendorPath: url }))
  return images
}

/**
 * 쿠팡 상품생성 요청 바디를 조립한다(네트워크 호출 없는 순수 함수 — 단위테스트 대상). 필수 설정/필수
 * 구매옵션속성/필수 고시정보 중 하나라도 비어있으면 요청을 만들지 않고 에러 목록을 그대로 반환한다 —
 * "그럴듯한 값을 채워 일단 보내본다"는 이 프로젝트가 반복 경고해온 실패모드를 피한다.
 */
export function buildCoupangRegistrationPayload(
  item: RegistrationItem,
  vendorId: string,
  settings: Record<string, string>,
  meta: CategoryMeta,
): { ok: true; payload: CoupangCreatePayload } | { ok: false; errors: ValidationError[] } {
  const errors: ValidationError[] = []
  for (const key of REQUIRED_SETTINGS_KEYS) {
    if (!settings[key]?.trim()) errors.push({ field: key, reason: '배송/반품 설정에 이 값이 설정돼 있지 않습니다' })
  }
  errors.push(...coupangValidate(item.product, meta).errors)
  for (const notice of meta.notices) {
    if (notice.required && !item.noticeContents[notice.name]?.trim()) {
      errors.push({ field: notice.name, reason: '필수 고시정보 내용이 공급되지 않았습니다' })
    }
  }
  const images = buildImages(item.product)
  // 쿠팡은 vendorPath를 절대 URL로 요구한다(실제로 그 주소에서 이미지를 가져감) — "이미지 호스팅 관리"
  // 메뉴에 base_url을 안 정해두면 storage_path가 "/scraped/..." 같은 상대경로 그대로 나온다(2026-10-03,
  // 실제 product_master로 테스트하다 발견). 여기서 걸러야지, 쿠팡 쪽 모호한 거부 메시지로 뒤늦게 알면 안 된다.
  if (images.length === 0) errors.push({ field: 'images', reason: '대표이미지가 없습니다(상품 이미지 등록 필요)' })
  else if (!/^https?:\/\//i.test(images[0].vendorPath)) {
    errors.push({ field: 'images', reason: `이미지 경로가 절대 URL이 아닙니다 — "이미지 호스팅 관리" 메뉴에서 base_url을 설정하세요: ${images[0].vendorPath}` })
  }
  if (errors.length > 0) return { ok: false, errors }

  const name = (item.product.name_final || item.product.name_ai || item.product.name_original).slice(0, 100)
  const notices: CoupangItemNotice[] = meta.notices
    .filter(n => item.noticeContents[n.name]?.trim())
    .map(n => ({ noticeCategoryName: n.categoryName, noticeCategoryDetailName: n.name, content: item.noticeContents[n.name] }))

  // 옵션 조합(색상×사이즈 등)마다 하나씩 item을 만든다 — 실제 조합 데이터가 없으면 카티전 곱으로
  // 근사된다는 걸 알고 써야 한다(lib/marketplace/optionCombinations.ts의 approximated 플래그 참고,
  // 여기서는 등록 자체를 막지는 않는다 — 캐스케이드 없는 몰은 근사가 곧 정확한 값이기도 하다).
  // maximumBuyCount는 옵션별 재고가 아니라 상품 전체 재고(product.stock_qty)를 그대로 쓴다 — PTP가
  // 옵션별 재고를 따로 추적하지 않는 한계(알려진 근사치, 조합이 여럿이면 실제보다 많이 팔릴 수 있음).
  const { combinations } = resolveOptionCombinations(item.product.options, item.product.option_combinations)
  const items: CoupangItemPayload[] = (combinations.length ? combinations : [{}]).map(combo => ({
    itemName: Object.keys(combo).length ? Object.values(combo).join('/') : name,
    originalPrice: item.product.list_price ?? item.product.sale_price ?? 0,
    salePrice: item.product.sale_price ?? 0,
    maximumBuyCount: item.product.stock_qty ?? 0,
    images,
    attributes: Object.entries(combo).map(([attributeTypeName, attributeValueName]) => ({ attributeTypeName, attributeValueName })),
    notices,
  }))

  const now = new Date()
  const saleEnd = new Date(now)
  saleEnd.setFullYear(saleEnd.getFullYear() + 3)

  const payload: CoupangCreatePayload = {
    displayCategoryCode: Number(item.categoryCode),
    sellerProductName: name,
    vendorId,
    saleStartedAt: toCoupangDateTime(now),
    saleEndedAt: toCoupangDateTime(saleEnd),
    deliveryMethod: settings.deliveryMethod,
    deliveryCompanyCode: settings.deliveryCompanyCode,
    deliveryChargeType: settings.deliveryChargeType,
    ...(settings.deliveryCharge?.trim() ? { deliveryCharge: Number(settings.deliveryCharge) } : {}),
    ...(settings.freeShipOverAmount?.trim() ? { freeShipOverAmount: Number(settings.freeShipOverAmount) } : {}),
    ...(settings.deliveryChargeOnReturn?.trim() ? { deliveryChargeOnReturn: Number(settings.deliveryChargeOnReturn) } : {}),
    remoteAreaDeliverable: settings.remoteAreaDeliverable,
    returnCenterCode: settings.returnCenterCode,
    ...(settings.outboundShippingPlaceCode?.trim() ? { outboundShippingPlaceCode: settings.outboundShippingPlaceCode } : {}),
    ...(settings.returnChargeName?.trim() ? { returnChargeName: settings.returnChargeName } : {}),
    companyContactNumber: settings.companyContactNumber,
    ...(settings.returnZipCode?.trim() ? { returnZipCode: settings.returnZipCode } : {}),
    ...(settings.returnAddress?.trim() ? { returnAddress: settings.returnAddress } : {}),
    ...(settings.returnAddressDetail?.trim() ? { returnAddressDetail: settings.returnAddressDetail } : {}),
    returnCharge: Number(settings.returnCharge),
    items,
  }
  return { ok: true, payload }
}

/**
 * 항목별로 독립 처리한다 — 카테고리 메타데이터 조회부터 매번 새로 하는 이유는 카테고리가 상품마다 다를
 * 수 있기 때문(배치 전체에 같은 카테고리 메타를 캐싱하는 최적화는 호출 빈도가 실제로 문제될 때 추가).
 * 하나가 실패해도(네트워크/검증/쿠팡 거부 어느 단계든) 나머지는 계속 진행한다.
 */
async function coupangRegister(items: RegistrationItem[], cred: Record<string, string>, settings: Record<string, string>): Promise<RegistrationResult> {
  const success: RegistrationResult['success'] = []
  const failed: RegistrationResult['failed'] = []

  for (const item of items) {
    let meta: CategoryMeta
    try {
      meta = await coupangFetchCategoryMeta(item.categoryCode, cred)
    } catch (e) {
      failed.push({ productMasterId: item.product.id, error: `카테고리 메타데이터 조회 실패: ${e instanceof Error ? e.message : String(e)}` })
      continue
    }

    const built = buildCoupangRegistrationPayload(item, cred.vendorId, settings, meta)
    if (!built.ok) {
      failed.push({ productMasterId: item.product.id, error: built.errors.map(e => `${e.field}: ${e.reason}`).join('; ') })
      continue
    }

    const res = await coupangRequest<{ code: string; data: number }>(
      'POST', '/v2/providers/seller_api/apis/api/v1/marketplace/seller-products', '', cred, built.payload,
    )
    if (!res.ok) { failed.push({ productMasterId: item.product.id, error: res.error }); continue }
    if (res.data.code !== 'SUCCESS') { failed.push({ productMasterId: item.product.id, error: `쿠팡 거부: code=${res.data.code}` }); continue }
    success.push({ productMasterId: item.product.id, externalId: String(res.data.data) })
  }

  return { success, failed }
}

export const coupangAdapter: MarketplaceProductAdapter = {
  code: 'coupang',
  credentialFields: coupangCredentialFields,
  settingsFields: coupangSettingsFields,
  verifyCredentials: coupangVerifyCredentials,
  fetchCategoryMeta: coupangFetchCategoryMeta,
  validate: coupangValidate,
  register: coupangRegister,
}
