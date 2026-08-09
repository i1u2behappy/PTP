'use client'
import { useState, useEffect, useRef, useMemo } from 'react'
import Image from 'next/image'
import { useTabs } from '../shell/TabsContext'
import { PRODUCTS_LIST_TAB } from '../shell/menuTabs'
import { FIXED_FIELD_INFO } from '../../lib/master/schema'
import { useRegisteredFieldKeys } from './shared/useRegisteredFieldKeys'

// lib/extract.ts의 CLAIMED_INFO_LABEL_RE와 같은 목록 — 이 파일은 Playwright 등 서버 전용 코드를 담고
// 있어 클라이언트 컴포넌트에서 직접 import하지 않고 그대로 복제해 둔다(둘 중 하나를 고치면 같이 맞출 것).
const CLAIMED_INFO_LABEL_RE = /브랜드|제조사|제조자|원산지|제조국|상품요약정보|영문상품명|유통기한|소비기한|상품코드|정가|판매가|소비자가|시중가|정상가|공급가|도매가|배송비|택배비/i

// 기준 Master 테이블 관리 화면과 같은 라벨을 쓰기 위해 거기서 쓰는 이름을 그대로 가져온다 — 예전엔 이 표만
// "소비자판가"/"공급가"라고 따로 부르고 있어서 기준 테이블의 "정상가"/"원가"와 같은 값인데 다르게 보였다.
// FIXED_FIELD_INFO는 로딩 전/미등록 키의 기본값일 뿐, 사용자가 기준 마스터테이블관리에서 라벨을 직접
// 바꿔둔 경우(예: "원가"→"공급가") 실제로는 useRegisteredFieldKeys가 돌려주는 DB 값이 우선해야 한다.
const DEFAULT_FIELD_LABEL = new Map(FIXED_FIELD_INFO.map(f => [f.key, f.label]))

// 한글 등 비ASCII 문자가 들어간 URL은 퍼센트 인코딩(%ED%94%84...)된 채로 저장/전달되는 게 맞다(URL 표준) —
// 다만 사람이 읽기엔 원래 글자로 보여주는 게 낫다(브라우저 주소창도 그렇게 보여준다). 실제 이동/클릭은
// 원본 인코딩 문자열을 그대로 쓰고, 화면 표시에만 디코딩한다. 디코딩 실패(잘못된 %-시퀀스)는 원본 그대로.
function decodeUrlForDisplay(url: string): string {
  try { return decodeURIComponent(url) } catch { return url }
}

type Status = 'idle' | 'running' | 'done' | 'error' | 'stopped'
type LoginStep = 'none' | 'opened' | 'confirmed'

interface Site {
  id: number
  name: string | null
  url: string
  login_url: string | null
  login_id: string | null
  manual_login_required?: boolean | null
  profile_dir?: string
  client_id?: number | null
  client_name?: string | null
  main_items?: string | null
}

interface Client { id: number; name: string }

interface SitePickerColumnDef {
  key: string
  label: string
  getValue: (s: Site) => string
  render: (s: Site) => React.ReactNode
  className?: string
}

// Mall 관리(SitesListPanel) 그리드와 같은 정렬/필터/너비조절/순서변경을 이 Mall 선택 그리드에도 맞춰
// 넣은 것 — 컬럼 구성만 다르고 나머지 로직은 그대로 포팅.
const SITE_PICKER_COLUMNS: SitePickerColumnDef[] = [
  { key: 'name', label: 'Mall 이름', getValue: s => s.name || '', className: 'text-gray-800 font-medium whitespace-nowrap', render: s => (
    <>
      {s.name || '(이름 없음)'}
      {s.manual_login_required === true && (
        <span className="ml-1.5 px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700 text-[10px] font-semibold whitespace-nowrap" title="Windows Hello/WebAuthn(PC인증) 등으로 자동 로그인이 안 되는 몰 — 크롬 확장(개발자모드)으로 스크랩">
          🧩 개발자모드
        </span>
      )}
      {s.manual_login_required === null && (
        <span className="ml-1.5 px-1.5 py-0.5 rounded-full bg-gray-100 text-gray-500 text-[10px] font-semibold whitespace-nowrap" title="아직 스크랩 방식이 정해지지 않았습니다 — 선택하면 처음 스크랩할 때 물어봅니다">
          ❔ 미정
        </span>
      )}
    </>
  ) },
  { key: 'main_items', label: '메인 품목', getValue: s => s.main_items || '', render: s => s.main_items || '-', className: 'text-gray-500' },
  { key: 'client_name', label: '거래처', getValue: s => s.client_name || '', render: s => s.client_name || '-', className: 'text-teal-600 whitespace-nowrap' },
  { key: 'url', label: 'URL', getValue: s => s.url, render: s => s.url, className: 'text-gray-500' },
]

const SITE_PICKER_DEFAULT_COL_WIDTH: Record<string, number> = { name: 160, main_items: 140, client_name: 110, url: 260 }
const SITE_PICKER_MIN_COL_WIDTH = 50
function sitePickerWidthFor(key: string): number {
  return SITE_PICKER_DEFAULT_COL_WIDTH[key] ?? 120
}
function compareSitePickerValues(a: string, b: string): number {
  return a.localeCompare(b, 'ko')
}
type SitePickerSortDir = 'asc' | 'desc'
interface SitePickerSortKey { key: string; dir: SitePickerSortDir }

const PLATFORM_LABELS: Record<string, string> = {
  cafe24: '카페24', makeshop: '메이크샵', godomall: '고도몰', unknown: '알 수 없음 (범용 방식 사용)',
}

// 스크랩 검토 탭으로 넘어갔다 돌아와도(탭 전환 시 이 패널은 언마운트된다) 방금 진행/완료한 세션 정보가
// 유지되도록 site+sessionId만 남겨두고, 되돌아왔을 때 서버에서 최신 상태를 다시 조회해 복원한다.
const LAST_SESSION_KEY = 'scrape.scraper.lastSession'

// 스크랩을 아직 시작하지 않은 단계(몰 선택/시작 URL/카테고리 목록 입력, 미리보기 전)도 다른 메뉴에 갔다
// 오면 언마운트로 사라지는 건 마찬가지다(사용자 실측 발견) — LAST_SESSION_KEY는 "스크랩이 실제로
// 시작된 뒤"에만 채워지므로 그 전 단계는 별도로 남겨둔다. 미리보기 결과도 다른 메뉴 갔다 돌아오면
// 사라져 있다는 지적으로(재조회하려면 다시 몰 페이지에 접속해야 해 느리다) 폼 값과 함께 그대로 남겨둔다.
const FORM_STATE_KEY = 'scrape.scraper.formState'
// 몰(site)과 무관하게 항상 같은 값을 쓰는 전역 선호값이라 FORM_STATE_KEY(몰별 작업 상태)와 분리한다 —
// 메모리/CPU 이슈 진단 중 "수동/2개"로 낮춰두면 몰을 바꿔도 그 설정이 그대로 유지되길 원할 것이라는 판단.
// 기본값을 자동/4 → 수동/2로 바꾸면서 키 이름도 바꿨다(.v2) — 안 바꾸면 예전에 이미 저장된 자동/4 값이
// 그대로 읽혀 새 기본값이 적용되지 않는다(로컬 도구라 기존 저장값을 서버에서 강제로 덮어쓸 방법이 없음).
const CONCURRENCY_PREF_KEY = 'scrape.scraper.concurrencyPref.v2'
function readConcurrencyPref(): { mode: 'auto' | 'manual'; value: number } {
  if (typeof window === 'undefined') return { mode: 'manual', value: 2 }
  try {
    const saved = JSON.parse(localStorage.getItem(CONCURRENCY_PREF_KEY) || '{}') as { mode?: 'auto' | 'manual'; value?: number }
    return { mode: saved.mode === 'auto' ? 'auto' : 'manual', value: saved.value ? Math.max(1, Math.min(8, saved.value)) : 2 }
  } catch {
    return { mode: 'manual', value: 2 }
  }
}

interface ItemLogRow {
  id: number
  url: string
  status: 'success' | 'failed'
  error: string | null
}

interface PreviewProduct {
  name: string
  category: string
  price: number | null
  sale_price: number | null
  cost_price: number | null
  shipping_fee: number | string | null
  brand: string
  manufacturer: string
  origin: string
  description: string
  options: { name: string; values: string[] }[]
  thumbnail_urls: string[]
  thumbnail_names: string[]
  detail_image_urls: string[]
  detail_image_names: string[]
  detail_text: string
  summary_info: string
  english_name: string
  stock_status: string
  stock_qty: number | null
  stock_by_option: { option: string; qty: number }[]
  extra_info: { label: string; value: string }[]
  custom_fields: Record<string, string>
}

interface PreviewItem {
  url: string
  name: string
  thumbnail: string
}

interface CategoryCountItem {
  url: string
  label: string
  count: number
}

/** 기준 마스터테이블 필드 키 하나를 미리보기의 실제 스크랩 값으로 풀어낸다 — 표에 보여줄 값이 없는
 *  컬럼(내부관리코드/판매관리코드/마켓별카테고리 등, 스크랩 시점엔 절대 채워지지 않고 후속 절차에서
 *  채워지는 값)은 '-'로 비워둔다(사용자 정책: "값이 없는 컬럼은 비워둘 것"). */
function previewValueFor(product: PreviewProduct, sourceUrl: string, fieldKey: string, registryLabels: Map<string, string>): string {
  const money = (n: number | string | null) => n == null ? '-' : typeof n === 'number' ? `₩${n.toLocaleString()}` : n
  switch (fieldKey) {
    case 'name_final': return product.name || '-'
    case 'product_url': return sourceUrl || '-'
    case 'master_category': return product.category || '-'
    case 'cost_price': return money(product.cost_price)
    case 'list_price': return money(product.price)
    case 'sale_price': return money(product.sale_price)
    case 'brand': return product.brand || '-'
    case 'manufacturer': return product.manufacturer || '-'
    case 'origin': return product.origin || '-'
    case '1_option': return product.options[0]?.values.join(', ') || '-'
    case '2_option': return product.options[1]?.values.join(', ') || '-'
    case '3_option': return product.options[2]?.values.join(', ') || '-'
    case 'top_img': return product.thumbnail_urls.length ? `${product.thumbnail_urls.length}장 — ${product.thumbnail_names.join(', ')}` : '-'
    case 'detail_img': return product.detail_image_urls.length ? `${product.detail_image_urls.length}장 — ${product.detail_image_names.join(', ')}` : '-'
    case 'description': return product.description || '-'
    case 'shipping_fee': return money(product.shipping_fee)
    case 'stock_status': return product.stock_status || '-'
    case 'stock_qty': return product.stock_qty != null ? `${product.stock_qty}개` : '-'
    // 내부관리코드/판매관리코드/마켓별카테고리 등은 스크랩 시점엔 값이 없는 후속 절차용 컬럼 — 기본값 '-'로 빠진다.
    default: {
      const label = registryLabels.get(fieldKey) || fieldKey
      return product.custom_fields?.[fieldKey] ?? product.custom_fields?.[label] ?? '-'
    }
  }
}

/** lib/ai.ts의 MallStructureReport와 같은 모양. */
interface MallStructureReport {
  urlHierarchy: string
  categoryStructure: string
  bankName: string
  accountNumber: string
  shippingCourier: string
  shippingFeeInfo: string
  returnAddress: string
  stockManagementType: string
  companyContact: string
  productPageStructure: string
  scrapingNeeds: string
  generatedBy: 'ai' | 'heuristic'
}

/** lib/scraper.ts의 MallProfileSignals와 같은 모양 — "몰 구조 파악" 버튼 결과 표시용. */
interface MallProfileSignals {
  sampleCount: number
  platform: string
  sampleProductUrl: string
  hasMainImages: boolean
  hasDetailImages: boolean
  optionUiTypes: string[]
  hasCascadingOptions: boolean
  hasStockQty: boolean
  hasStockStatusText: boolean
  hasStockByOption: boolean
  hasDetailText: boolean
  infoLabels: string[]
  categoryPaths: string[]
  categoryMaxDepth: number
  categoryMenuNames: string[]
  report: MallStructureReport | null
}
interface ProfileCheckResult {
  signals: MallProfileSignals
  diffs: string[]
  isFirstTime: boolean
  autoRuleFields: string[]
}

/** 개발자모드(크롬 확장) 몰의 새 세션 감지용 — /api/sessions?siteId= 응답 중 필요한 필드만. */
interface DevModeSession {
  id: number
  url: string
  status: string
  found_count: number
  staged_count: number
  pending_count: number
  created_at: string
}

/** "스크랩 대상" 카드의 "URL 불러오기"/"카테고리 불러오기" — 둘 다 같은 레벨의 대체 선택지라 같은
 *  틀(설명 + 버튼)을 강제로 공유하게 한다(따로 두면 스타일이 조금씩 어긋나기 쉽다는 게 실제로 확인된
 *  문제). 색(진한 teal → 흰 테두리형+✓)은 "스크랩 대상이 정해졌는지"라는 두 버튼 공통의 신호
 *  (`colorDone`)로 함께 바뀌게 하고, 라벨 텍스트만 각자 실제로 그 버튼을 눌러 성공했는지(`done`)로
 *  따로 바뀐다 — 하나만 성공했다고 색까지 서로 달라지던 문제(둘이 다른 버튼처럼 보임)를 막으면서도,
 *  누르지도 않은 버튼에 "불러옴"이라고 거짓 라벨을 붙이지 않는다. */
function ScrapeStepBox({ description, primary, secondary, children }: {
  description: string
  primary: { label: string; doneLabel: string; icon: string; loading?: boolean; loadingLabel?: string; done: boolean; colorDone?: boolean; onClick: () => void; disabled?: boolean }
  secondary?: { label: string; title?: string; onClick: () => void; disabled?: boolean }
  children?: React.ReactNode
}) {
  const showDoneColor = primary.colorDone ?? primary.done
  return (
    <div className="bg-teal-50 border border-teal-100 rounded-xl px-4 py-2.5 mb-2">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-teal-700">{description}</p>
        <div className="flex items-center gap-2 shrink-0">
          {secondary && (
            <button type="button" onClick={secondary.onClick} disabled={secondary.disabled} title={secondary.title}
              className="px-3 py-1.5 bg-white border border-gray-300 hover:bg-gray-50 text-gray-600 text-xs font-semibold rounded-full transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
              {secondary.label}
            </button>
          )}
          <button type="button" onClick={primary.onClick} disabled={primary.disabled}
            className={`px-4 py-1.5 text-xs font-semibold rounded-full transition-colors shrink-0 flex items-center gap-1 disabled:opacity-50 disabled:cursor-not-allowed ${
              showDoneColor
                ? 'bg-white border-2 border-teal-500 text-teal-600 hover:bg-teal-50'
                : 'bg-teal-500 hover:bg-teal-600 text-white'}`}>
            <span aria-hidden="true">{showDoneColor ? '✓' : primary.icon}</span>
            {primary.loading ? (primary.loadingLabel || '처리 중...') : primary.done ? primary.doneLabel : primary.label}
          </button>
        </div>
      </div>
      {children}
    </div>
  )
}

export function ScraperPanel({ params }: { params?: Record<string, unknown> }) {
  const { openTab, bumpRefresh, setGuidance, refreshSignals } = useTabs()
  const { labels: registryLabels } = useRegisteredFieldKeys()
  const fixedFieldLabel = useMemo(() => {
    const m = new Map(DEFAULT_FIELD_LABEL)
    registryLabels.forEach((v, k) => m.set(k, v))
    return m
  }, [registryLabels])
  // 미리보기 표의 컬럼 구성/순서는 기준 마스터테이블관리(master_schema_fields)를 그대로 따라간다 —
  // 등록 순서(sort_order)대로 보여주고, 아직 레지스트리가 안 불러와졌으면 기본 15개 순서로 잠깐 대체한다.
  const masterOrderedKeys = useMemo(
    () => registryLabels.size > 0 ? Array.from(registryLabels.keys()) : FIXED_FIELD_INFO.map(f => f.key),
    [registryLabels],
  )
  const initialSiteId = params?.siteId as number | undefined
  const initialClientId = params?.clientId as number | undefined
  const [sites, setSites]         = useState<Site[]>([])
  const [clients, setClients]     = useState<Client[]>([])
  const [clientFilter, setClientFilter] = useState<number | ''>(initialClientId ?? '')
  const [siteQuery, setSiteQuery] = useState('')
  const [selectedSite, setSelectedSite] = useState<Site | null>(null)
  const [siteSortKeys, setSiteSortKeys] = useState<SitePickerSortKey[]>([])
  const [siteColFilters, setSiteColFilters] = useState<Record<string, string>>({})
  const [siteShowFilters, setSiteShowFilters] = useState(false)
  const [mallSelectCollapsed, setMallSelectCollapsed] = useState(false)
  const [devModeGuideCollapsed, setDevModeGuideCollapsed] = useState(false)
  // 위 단계를 끝내고 아래 단계로 넘어갈 때, 끝난 위 카드들을 접어서 지금 진행 중인 아래 내용이 화면에
  // 더 잘 보이게 한다(Mall 선택/개발자모드 안내와 같은 패턴) — 순차 작업 중 스크롤을 덜 하게 하려는 것.
  const [loginCardCollapsed, setLoginCardCollapsed] = useState(false)
  const [scrapeTargetCollapsed, setScrapeTargetCollapsed] = useState(false)
  const [previewCardCollapsed, setPreviewCardCollapsed] = useState(false)
  const [siteColWidths, setSiteColWidths] = useState<Record<string, number>>({})
  const [siteColOrder, setSiteColOrder] = useState<string[]>([])
  const [siteDragKey, setSiteDragKey] = useState<string | null>(null)

  const [loginId, setLoginId]     = useState('')
  const [loginPw, setLoginPw]     = useState('')
  const [loginStep, setLoginStep] = useState<LoginStep>('none')
  const [loginBusy, setLoginBusy] = useState(false)

  const [profileResult, setProfileResult] = useState<ProfileCheckResult | null>(null)
  const [profileLoading, setProfileLoading] = useState(false)
  const [profileError, setProfileError] = useState('')

  const [pickerActive, setPickerActive] = useState(false)
  const [pickerBusy, setPickerBusy] = useState(false)
  const [pickerRules, setPickerRules] = useState<Record<string, { type: string; value: string }>>({})

  const [targetUrl, setTargetUrl]           = useState('')
  const [categoryUrlsText, setCategoryUrlsText] = useState('')
  const [currentUrlLoading, setCurrentUrlLoading] = useState(false)
  // "URL 불러오기"를 한 번이라도 성공하면 true — "카테고리 불러오기"와 같은 레벨의 액션이라 완료
  // 여부를 같은 방식(✓ + 옅은 테두리)으로 보여준다. 시작 URL을 직접 고치면(로그인/카테고리와 같은
  // 패턴) 다시 안 가져온 상태로 되돌린다.
  const [currentUrlFetched, setCurrentUrlFetched] = useState(false)

  const [categories, setCategories]         = useState<{ href: string; text: string }[]>([])
  const [categoriesLoading, setCategoriesLoading] = useState(false)
  // 몰 구조분석이 이미 찾아둔 카테고리 목록을 재사용했으면(cached) 즉시 뜨고, 한 번도 분석 안 한 몰이라
  // 지금 막 새로 훑었으면(false) 시간이 걸린다 — 사용자가 그 차이를 알 수 있도록 상태만 같이 보여준다.
  const [categoriesCached, setCategoriesCached] = useState<{ cached: boolean; updatedAt: string | null } | null>(null)
  const [detectedPlatform, setDetectedPlatform] = useState<string | null>(null)
  // 카테고리를 나눠서(오늘 일부, 나중에 나머지) 스크랩하는 경우가 있어, 이 몰의 과거 완료 세션들을 훑어
  // "이미 스크랩해본 카테고리"를 체크박스 목록에 표시한다(app/api/scrape/categories가 계산해 내려줌).
  // allCategoriesScraped=true면 몰 전체 스크랩을 완료한 적이 있다는 뜻이라 개별 목록과 무관하게 전부 완료로 본다.
  const [scrapedCategoryHrefs, setScrapedCategoryHrefs] = useState<string[]>([])
  const [allCategoriesScraped, setAllCategoriesScraped] = useState(false)
  // 메뉴 구조상 카테고리처럼 보이지만 실제 상품이 없는 항목(안내/문의 페이지 등)은 자동 판별만으로 완전히
  // 걸러낼 수 없어(몰마다 메뉴 구조가 제각각), 사용자가 직접 "제외"로 표시해둘 수 있게 한다(사이트별로
  // 서버에 저장돼 다음에 카테고리를 다시 불러와도 유지됨).
  const [excludedCategoryHrefs, setExcludedCategoryHrefs] = useState<string[]>([])

  const [previewResult, setPreviewResult]   = useState<{ sourceUrl: string; product: PreviewProduct } | null>(null)
  // 미리보기 결과가 로그인 세션이 끊긴 상태로 얻어진 것 같을 때(창을 닫은 뒤 세션 만료 등) — 자동으로
  // 로그인 창을 다시 띄우고 이 배너로 재확인을 안내한다.
  const [sessionExpiredWarning, setSessionExpiredWarning] = useState(false)
  const [previewTotal, setPreviewTotal]     = useState<number | null>(null)
  const [previewItems, setPreviewItems]     = useState<PreviewItem[]>([])
  // 일반모드 카탈로그 미리보기 전용 — 카테고리별 상품 개수만(이름/썸네일 없이). 개발자모드는 이 필드를
  // 채우지 않으므로(확장이 previewItems 쪽만 보냄) 항상 빈 배열로 남아 기존 표시와 자연히 구분된다.
  const [categoryCounts, setCategoryCounts] = useState<CategoryCountItem[]>([])
  const [previewLoading, setPreviewLoading] = useState(false)
  // "미리보기 중지" — fetch를 abort하면 서버(previewCatalog)도 opts.stopSignal로 같은 신호를 받아
  // 카테고리 개수 집계를 스스로 멈춘다(lib/scraper.ts 참고). 일반모드 전용(개발자모드는 서버가 아니라
  // 사용자 브라우저의 확장이 도는 것이라 이 fetch로 막을 수 있는 작업이 없다).
  const previewAbortRef = useRef<AbortController | null>(null)
  // 카테고리가 많거나 큰 몰은 미리보기가 몇 분씩 걸릴 수 있어, 진행 중임을 알 수 있게 서버가 세는
  // "카테고리 N/M" 진행 상황을 짧은 주기로 폴링해 보여준다(끝없이 도는 것처럼 보인다는 피드백).
  const [previewProgress, setPreviewProgress] = useState<{ done: number; total: number } | null>(null)
  const previewProgressPollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  // dev 서버가 불안정해 화면이 강제로 새로고침되면(Fast Refresh, 실사용 중 확인된 문제) 미리보기가
  // "그냥 멈춘 것"처럼 보이지만 서버는 계속 돌고 있을 수 있다 — 화면이 다시 뜰 때 이 몰에 아직 도는
  // 미리보기가 있으면 로딩 상태를 이어서 보여주고, 그 사이 끝나면 이 안내를 띄운다(원래 요청의 결과는
  // 새로고침으로 끊긴 그 브라우저 탭 안에서만 받을 수 있어 그대로 복구할 방법은 없다 — 다시 눌러야 함).
  const [previewResumeNotice, setPreviewResumeNotice] = useState<string | null>(null)

  // 이 몰의 로그인 창 탭/프로필을 다른 스크랩 작업(스크래핑 시작/몰 구조 파악/미리보기 등)이 지금 쓰고
  // 있으면, 여기서 누르는 버튼도 그게 끝날 때까지 순서를 기다린다(lib/scraper.ts의 withSiteLock 참고) —
  // 예전엔 이걸 알 방법이 없어 "왜 이렇게 오래 걸리냐"는 질문으로 매번 서버 로그를 뒤져야 했다. 몰을
  // 선택해두는 동안 짧은 주기로 폴링해, 대기 중이면 화면에 바로 보여준다.
  const [siteLockStatus, setSiteLockStatus] = useState<{ busy: boolean; label?: string; sinceMs?: number } | null>(null)

  // 개발자모드 "상품 페이지 미리보기"/"스크랩 대상 직접지정" — 일반모드와 같은 카드/상태(previewResult 등)를
  // 그대로 쓰지만, PTP가 그 몰 탭에 직접 접근할 방법이 없어(chrome.debugger 확장 전용 구조) 실제 캡처는
  // 사용자가 몰 탭에서 확장(팝업 또는 우클릭)을 실행해야 일어난다 — 그래서 즉시 fetch 대신 폴링으로
  // 기다리는 방식을 쓴다. 이 폴링은 "스크랩 미리보기" 버튼을 누르는 것과 무관하게 이 몰이 선택돼 있는
  // 동안 항상 돌아간다(아래 useEffect) — PTP 버튼을 먼저 누르지 않고 몰 탭에서 확장의 "스크랩 미리보기
  // 실행"만 눌러도 결과가 그대로 반영되게 하기 위함(2026-08, 순서를 강제하던 예전 설계는 오히려 먼저
  // 캡처해둔 결과를 "스크랩 미리보기"의 초기화(preview-arm)가 지워버리는 부작용이 있었다).
  const devPreviewTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const progressSectionRef = useRef<HTMLDivElement>(null)

  const [aiMode, setAiMode]       = useState(true)
  // 카테고리/상품 목록을 동시에 몇 개까지 열지 — 'auto'는 기존 동작(스크래핑은 1~8 적응형, 미리보기/카테고리
  // 목록 수집은 4 고정), 'manual'이면 concurrency 값으로 항상 고정한다. 열린 탭이 많을수록(이미지까지
  // 로드) 메모리를 더 쓰므로, 메모리 이슈를 진단/완화할 때 1로 낮춰볼 수 있게 한다.
  const [concurrencyMode, setConcurrencyMode] = useState<'auto' | 'manual'>(() => readConcurrencyPref().mode)
  const [concurrency, setConcurrency] = useState<number>(() => readConcurrencyPref().value)
  const [status, setStatus]       = useState<Status>('idle')
  const [sessionId, setSessionId] = useState<number | null>(null)
  const [progress, setProgress]   = useState<{ saved: number; total: number; error?: string; successCount: number; failedCount: number }>({ saved: 0, total: 0, successCount: 0, failedCount: 0 })
  const [stopping, setStopping]   = useState(false)
  const [itemLog, setItemLog]     = useState<ItemLogRow[]>([])
  // 적응형 동시성이 이번 회차에 언제 올리고(연속 성공) 언제 차단 감지로 다시 낮췄는지 — 스크래핑 후 간략히 확인용
  const [concurrencyLog, setConcurrencyLog] = useState<{ at: string; level: number; reason: 'ramp_up' | 'block_detected' }[]>([])
  const [concurrencyLogOpen, setConcurrencyLogOpen] = useState(false)
  const [retrying, setRetrying]   = useState(false)
  const [modeSaving, setModeSaving] = useState(false)
  const [credCopied, setCredCopied] = useState<'id' | 'pw' | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    fetch('/api/sites').then(r => r.json()).then((d: Site[]) => { if (Array.isArray(d)) setSites(d) }).catch(() => {})
    fetch('/api/clients').then(r => r.json()).then((d: Client[]) => { if (Array.isArray(d)) setClients(d) }).catch(() => {})
  }, [])

  // 동시 처리 자동/수동 선호값 — 몰별 상태(FORM_STATE_KEY)와 무관하게 하나만 저장해 몰을 바꿔도 유지한다.
  useEffect(() => {
    localStorage.setItem(CONCURRENCY_PREF_KEY, JSON.stringify({ mode: concurrencyMode, value: concurrency }))
  }, [concurrencyMode, concurrency])

  // LAST_SESSION_KEY(스크랩 진행/완료 상태)와 FORM_STATE_KEY(몰 선택/카테고리 목록 등)는 서로 독립적으로
  // 복원돼야 한다 — 아래 마운트 effect에서 둘 다 적용한다.
  interface ScraperFormSavedState {
    siteId: number; targetUrl: string; categoryUrlsText: string
    previewResult?: { sourceUrl: string; product: PreviewProduct } | null
    previewTotal?: number | null
    previewItems?: PreviewItem[]
    categoryCounts?: CategoryCountItem[]
    detectedPlatform?: string | null
    loginStep?: LoginStep
    categories?: { href: string; text: string }[]
    categoriesCached?: { cached: boolean; updatedAt: string | null } | null
    profileResult?: ProfileCheckResult | null
    scrapedCategoryHrefs?: string[]
    allCategoriesScraped?: boolean
    excludedCategoryHrefs?: string[]
  }

  function applyFormState(saved: ScraperFormSavedState) {
    setTargetUrl(saved.targetUrl)
    setCategoryUrlsText(saved.categoryUrlsText)
    if (saved.previewResult) setPreviewResult(saved.previewResult)
    if (saved.previewTotal != null) setPreviewTotal(saved.previewTotal)
    if (saved.previewItems?.length) setPreviewItems(saved.previewItems)
    if (saved.categoryCounts?.length) setCategoryCounts(saved.categoryCounts)
    if (saved.detectedPlatform) setDetectedPlatform(saved.detectedPlatform)
    // 로그인 확인 상태/발견된 카테고리/몰 구조 파악 결과는 dev 서버가 Fast Refresh로 화면을 강제
    // 새로고침시켜도(실사용 중 확인된 문제) 사라진 것처럼 보이지 않게 여기서 되살린다. openSessions
    // (로그인 창)는 브라우저만 새로고침됐을 뿐인 같은 서버 프로세스에 그대로 남아있어 loginStep 복원이
    // 실제 상태와 어긋나지 않는다.
    if (saved.loginStep) setLoginStep(saved.loginStep)
    if (saved.categories?.length) setCategories(saved.categories)
    if (saved.categoriesCached) setCategoriesCached(saved.categoriesCached)
    if (saved.profileResult) setProfileResult(saved.profileResult)
    if (saved.scrapedCategoryHrefs?.length) setScrapedCategoryHrefs(saved.scrapedCategoryHrefs)
    if (saved.allCategoriesScraped) setAllCategoriesScraped(true)
    if (saved.excludedCategoryHrefs?.length) setExcludedCategoryHrefs(saved.excludedCategoryHrefs)
  }

  useEffect(() => {
    // Mall 목록/거래처 목록에서 특정 몰(또는 거래처)을 지정해 들어온 경우, 그 선택이 우선이므로 이전 세션 복원은 건너뛴다.
    if (initialSiteId) { selectSite(initialSiteId); return }
    if (initialClientId) return

    const formRaw = localStorage.getItem(FORM_STATE_KEY)
    let savedForm: ScraperFormSavedState | null = null
    if (formRaw) {
      try { savedForm = JSON.parse(formRaw) as ScraperFormSavedState } catch { /* 손상된 저장값은 무시 */ }
    }

    const raw = localStorage.getItem(LAST_SESSION_KEY)
    if (raw) {
      try {
        const saved = JSON.parse(raw) as { site: Site; sessionId: number }
        fetch(`/api/scrape/status?sessionId=${saved.sessionId}`).then(r => r.json()).then((d: { status: string; product_count: number; saved_count: number; success_count: number; failed_count: number; error?: string }) => {
          setSelectedSite(saved.site)
          setSessionId(saved.sessionId)
          setStatus(d.status as Status)
          setProgress({
            saved: Number(d.saved_count) || 0, total: Number(d.product_count) || 0, error: d.error,
            successCount: Number(d.success_count) || 0, failedCount: Number(d.failed_count) || 0,
          })
          // 세션 복원과 별개로, 같은 몰의 카테고리 목록 등 폼 상태도 함께 복원한다 — 예전엔 여기서 그대로
          // return해버려 "스크랩 완료" 상태는 보이는데 그 위 카테고리 선택 목록은 사라져 보이는 문제가
          // 있었다(2026-08-10 실사용 확인). selectSite()는 카테고리/진행상황을 전부 초기화하는 함수라
          // (사용자가 다른 몰을 새로 고를 때 쓰는 용도) 여기서 그대로 쓰면 방금 복원한 세션까지 같이
          // 지워버리므로 쓰지 않고, 저장해둔 값을 직접 적용한다.
          if (savedForm && savedForm.siteId === saved.site.id) applyFormState(savedForm)
        }).catch(() => {})
        // 진행 로그(URL별 성공/실패)는 탭 전환으로 언마운트됐다 돌아와도 그대로 보여야 하므로 같이 복원한다.
        fetch(`/api/scrape/log?sessionId=${saved.sessionId}`).then(r => r.json()).then((rows: ItemLogRow[]) => {
          if (Array.isArray(rows)) setItemLog(rows)
        }).catch(() => {})
        return
      } catch { /* 손상된 저장값은 무시하고 아래 폼 상태 복원으로 진행 */ }
    }
    // 아직 스크랩을 시작하지 않은 단계(위 세션 복원 대상이 없음)라도, 몰 선택/시작 URL/카테고리 목록만은
    // 그대로 이어서 볼 수 있도록 복원한다. selectSite가 site.url로 targetUrl을 기본값으로 초기화해버리므로,
    // 그 뒤에 저장해둔 실제 값으로 다시 덮어쓴다.
    if (!savedForm) return
    const siteId = savedForm.siteId
    selectSite(siteId).then(() => {
      applyFormState(savedForm!)
      // dev 서버 불안정으로 화면이 강제 새로고침되면(Fast Refresh) 미리보기가 서버에서는 계속 돌고
      // 있는데 화면만 "아무 일도 없었던 것"처럼 보인다 — 마운트 시점에 이 몰에 아직 도는 미리보기가
      // 있는지 한 번 확인해, 있으면 로딩 상태를 이어서 보여준다(resumePreviewProgressPolling 참고).
      fetch(`/api/scrape/preview-progress?siteId=${siteId}`).then(r => r.json()).then((d: {
        done: number; total: number
        result?: { total: number; platform: string; preview: { sourceUrl: string; product: PreviewProduct } | null; items: PreviewItem[]; categoryCounts?: CategoryCountItem[]; needsLogin?: boolean }
      }) => {
        // 마운트되는 바로 그 순간 이미 완료돼 있었으면(폴링 시작 전) 1초 기다리지 않고 바로 반영한다.
        if (d.result) { applyCatalogPreview(d.result); return }
        if (!d.total) return
        setPreviewLoading(true)
        setPreviewProgress(d)
        resumePreviewProgressPolling(siteId)
      }).catch(() => {})
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 마운트 시 1회만: initialSiteId는 탭 생성 시 고정되는 값
  }, [])

  // 위 복원의 짝 — 몰을 고르거나 시작 URL/카테고리 목록을 입력할 때, 그리고 미리보기 결과가 나올 때마다 저장해둔다.
  useEffect(() => {
    if (!selectedSite) return
    localStorage.setItem(FORM_STATE_KEY, JSON.stringify({
      siteId: selectedSite.id, targetUrl, categoryUrlsText,
      previewResult, previewTotal, previewItems, categoryCounts, detectedPlatform,
      loginStep, categories, categoriesCached, profileResult, scrapedCategoryHrefs, allCategoriesScraped, excludedCategoryHrefs,
    }))
  }, [selectedSite, targetUrl, categoryUrlsText, previewResult, previewTotal, previewItems, categoryCounts, detectedPlatform,
    loginStep, categories, categoriesCached, profileResult, scrapedCategoryHrefs, allCategoriesScraped, excludedCategoryHrefs])

  const filteredSites = useMemo(() => {
    const q = siteQuery.trim().toLowerCase()
    return sites.filter(s => {
      if (clientFilter !== '' && s.client_id !== clientFilter) return false
      if (!q) return true
      return (s.name || '').toLowerCase().includes(q) || s.url.toLowerCase().includes(q) || (s.main_items || '').toLowerCase().includes(q)
    })
  }, [sites, siteQuery, clientFilter])

  // 컬럼 구성은 고정이지만, 렌더링 시점에 "기존 순서 + 아직 안 담긴 새 키"를 계산해 useEffect로 state를
  // 동기화하지 않는다 (state-sync 이펙트 없이 항상 최신 컬럼 목록과 일치시키기 위함).
  const siteEffectiveOrder = useMemo(() => {
    const keys = SITE_PICKER_COLUMNS.map(c => c.key)
    const known = siteColOrder.filter(k => keys.includes(k))
    const missing = keys.filter(k => !known.includes(k))
    return [...known, ...missing]
  }, [siteColOrder])
  const siteOrderedColumns = siteEffectiveOrder.map(k => SITE_PICKER_COLUMNS.find(c => c.key === k)).filter((c): c is SitePickerColumnDef => !!c)

  function handleSiteColDrop(targetKey: string) {
    if (!siteDragKey || siteDragKey === targetKey) return
    const next = siteEffectiveOrder.filter(k => k !== siteDragKey)
    next.splice(next.indexOf(targetKey), 0, siteDragKey)
    setSiteColOrder(next)
    setSiteDragKey(null)
  }

  function startSiteResize(key: string, e: { clientX: number; preventDefault: () => void }) {
    e.preventDefault()
    const startX = e.clientX
    const startWidth = siteColWidths[key] ?? sitePickerWidthFor(key)
    function onMove(ev: MouseEvent) {
      setSiteColWidths(w => ({ ...w, [key]: Math.max(SITE_PICKER_MIN_COL_WIDTH, startWidth + (ev.clientX - startX)) }))
    }
    function onUp() {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  function handleSiteSort(key: string, e: { shiftKey: boolean }) {
    setSiteSortKeys(prev => {
      const idx = prev.findIndex(s => s.key === key)
      if (e.shiftKey) {
        if (idx === -1) return [...prev, { key, dir: 'asc' }]
        const next = [...prev]
        next[idx] = { key, dir: next[idx].dir === 'asc' ? 'desc' : 'asc' }
        return next
      }
      if (prev.length === 1 && prev[0].key === key) {
        return [{ key, dir: prev[0].dir === 'asc' ? 'desc' : 'asc' }]
      }
      return [{ key, dir: 'asc' }]
    })
  }

  const siteHasColFilters = Object.values(siteColFilters).some(Boolean)
  const colFilteredSites = filteredSites.filter(s => SITE_PICKER_COLUMNS.every(col => {
    const f = siteColFilters[col.key]
    if (!f) return true
    return col.getValue(s).toLowerCase().includes(f.toLowerCase())
  }))
  const visibleSites = siteSortKeys.length
    ? [...colFilteredSites].sort((a, b) => {
        for (const { key, dir } of siteSortKeys) {
          const col = SITE_PICKER_COLUMNS.find(c => c.key === key)
          if (!col) continue
          const cmp = compareSitePickerValues(col.getValue(a), col.getValue(b))
          if (cmp !== 0) return dir === 'asc' ? cmp : -cmp
        }
        return 0
      })
    : colFilteredSites
  const siteTableWidth = siteOrderedColumns.reduce((sum, col) => sum + (siteColWidths[col.key] ?? sitePickerWidthFor(col.key)), 0)

  useEffect(() => {
    if (!sessionId || status !== 'running') return
    pollRef.current = setInterval(async () => {
      const r = await fetch(`/api/scrape/status?sessionId=${sessionId}`)
      const d = await r.json() as { status: string; product_count: number; saved_count: number; success_count: number; failed_count: number; error?: string; concurrency_log?: { at: string; level: number; reason: 'ramp_up' | 'block_detected' }[] }
      setProgress({
        saved: Number(d.saved_count) || 0, total: Number(d.product_count) || 0, error: d.error,
        successCount: Number(d.success_count) || 0, failedCount: Number(d.failed_count) || 0,
      })
      if (Array.isArray(d.concurrency_log)) setConcurrencyLog(d.concurrency_log)
      fetch(`/api/scrape/log?sessionId=${sessionId}`).then(r => r.json()).then((rows: ItemLogRow[]) => {
        if (Array.isArray(rows)) setItemLog(rows)
      }).catch(() => {})
      if (d.status === 'done' || d.status === 'error' || d.status === 'stopped') {
        setStatus(d.status as Status)
        setStopping(false)
        if (pollRef.current) clearInterval(pollRef.current)
        if (d.status === 'done') bumpRefresh('staging')
      }
    }, 2000)
    return () => { if (pollRef.current) clearInterval(pollRef.current) }
  }, [sessionId, status, bumpRefresh])

  // 개발자모드(크롬 확장) 몰은 PTP가 아니라 사용자의 실제 브라우저에서 확장이 직접 세션을 만들고 채운다
  // (POST /api/scrape/extension-ingest) — "스크래핑 시작" 버튼이 없으니, 이 몰이 선택된 동안 새로 생긴
  // 세션이 있는지 주기적으로 확인하다가 발견되면 sessionId/status에 그대로 편입시킨다. 이후로는 위
  // 표준 진행상황 폴링(직접 시작했을 때와 동일한 로직)이 이어받아 진행률을 갱신하고 완료 시 "→ 스크랩
  // Raw 확인" 버튼까지 똑같이 띄운다.
  useEffect(() => {
    if (selectedSite?.manual_login_required !== true) return
    const site = selectedSite
    function checkForRunningSession() {
      fetch(`/api/sessions?siteId=${site.id}`).then(r => r.json()).then((d: DevModeSession[]) => {
        const latest = Array.isArray(d) ? d[0] : undefined
        if (!latest || latest.status !== 'running') return
        setSessionId(latest.id)
        setStatus('running')
        setProgress({ saved: Number(latest.staged_count) || 0, total: Number(latest.found_count) || 0, successCount: 0, failedCount: 0 })
        localStorage.setItem(LAST_SESSION_KEY, JSON.stringify({ site, sessionId: latest.id }))
      }).catch(() => {})
    }
    checkForRunningSession()
    const timer = setInterval(checkForRunningSession, 5000)
    return () => clearInterval(timer)
  }, [selectedSite])

  // 이 몰의 로그인 창/프로필을 지금 다른 스크랩 작업이 쓰고 있어 순서를 기다리는 중인지(withSiteLock)
  // 화면에 보여준다 — 몰이 선택돼 있는 동안 항상 가볍게 폴링한다(버튼을 누르기 전에도 "이 몰은 지금
  // 바쁩니다"를 미리 알 수 있게).
  useEffect(() => {
    // selectedSite가 없으면 그냥 폴링을 안 시작한다 — 아래 배너는 selectedSite도 같이 확인하니
    // stale한 이전 값이 남아있어도 안 보인다(여기서 굳이 setSiteLockStatus(null)로 지울 필요 없음).
    if (!selectedSite) return
    const siteId = selectedSite.id
    function poll() {
      fetch(`/api/scrape/site-lock-status?siteId=${siteId}`).then(r => r.json())
        .then((d: { busy: boolean; label?: string; sinceMs?: number }) => setSiteLockStatus(d))
        .catch(() => {})
    }
    poll()
    const timer = setInterval(poll, 1500)
    return () => clearInterval(timer)
  }, [selectedSite])

  const failedItems = itemLog.filter(r => r.status === 'failed')
  const successItems = itemLog.filter(r => r.status === 'success')
  const failedUrls = failedItems.map(r => r.url)

  // 이 몰이 "일반모드"(PTP 자동화) / "개발자모드"(크롬 확장) 중 무엇인지 — 아직 정해지지 않았으면(null)
  // 어느 흐름도 보여주지 않고 선택부터 받는다. PC인증 등으로 자동 로그인이 근본적으로 안 되는 몰인지는
  // 실제로 겪어보기 전엔 알 수 없어(이미 여러 번 확인된 사실), 최초 스크랩 시점에 사용자가 한 번 고르게 한다.
  const mallMode = !selectedSite ? null
    : selectedSite.manual_login_required === null ? 'undetermined'
    : selectedSite.manual_login_required ? 'devmode' : 'normal'

  /** 로그인확인 이후 단계(몰구조파악/추출규칙/스크랩)의 안내 문구를 정하는 데 쓰는 서버 판정 —
   *  undefined=조회 전, null=이 화면에서 더 안내할 게 없음(스크랩까지 이미 끝남), 그 외엔
   *  lib/scrape/nextStep.ts의 key('profile'|'rules'|'scrape'|'confirm'). */
  const [dbStepKey, setDbStepKey] = useState<string | null | undefined>(undefined)
  /* eslint-disable react-hooks/set-state-in-effect -- siteId 변경 시 이전 안내를 즉시 지워야 함(비동기 fetch 응답 전까지 낡은 안내가 남는 것 방지) */
  useEffect(() => {
    const siteId = selectedSite?.id
    if (!siteId) { setDbStepKey(undefined); return }
    setDbStepKey(undefined)
    fetch(`/api/sites/${siteId}/next-step`).then(r => r.json()).then(d => setDbStepKey(d.nextStep?.key ?? null)).catch(() => setDbStepKey(null))
  }, [selectedSite, refreshSignals.sites])
  /* eslint-enable react-hooks/set-state-in-effect */

  // 지금 이 화면(스크래핑)에서 "다음에 뭘 눌러야 하는지"를 전체 과정 순서대로 안내한다 — 몰 선택 →
  // 스크랩 방식 선택 → (일반모드: 로그인 창 열기 → 로그인 확인 → 몰 구조 파악 → 스크랩 미리보기 →
  // 스크래핑 시작 / 개발자모드: 브라우저에서 열기+로그인 → 확장으로 미리보기 → 확장으로 스크랩 시작) →
  // 진행 중 대기 → 완료 후 스크랩 Raw 확인으로 이동, 또는 실패/중지 시 이어서 진행.
  //
  // status/progress는 개발자모드도 확장이 실제 세션을 만들면(위 checkForRunningSession 폴링) 일반모드와
  // 완전히 같은 값으로 채워지므로, 스크랩이 실제로 시작된 뒤부터는 두 모드가 같은 안내를 그대로 쓴다.
  // 시작 전 단계만 모드별로 갈린다 — 개발자모드는 로그인/몰구조파악처럼 PTP가 직접 감지하는 단계가 없어
  // (사용자가 크롬 확장으로 진행) previewResult 유무 정도로만 두 단계(로그인+열기 / 확장으로 시작)를
  // 구분한다. 탭을 벗어나면(언마운트) 안내를 지워 다른 화면까지 따라오지 않게 한다.
  useEffect(() => {
    let text: string | null = null
    if (!selectedSite) text = '"Mall 선택" - 먼저 스크랩할 몰을 선택합니다.'
    else if (mallMode === 'undetermined') text = '"스크랩 방식 선택" - 일반모드 또는 개발자모드를 선택합니다.'
    else if (status === 'running') text = '스크래핑 진행 중 - 완료될 때까지 기다립니다. (중지하려면 "스크래핑 중지" 버튼을 클릭합니다.)'
    else if (status === 'done') text = '"스크랩 Raw 확인" - 수집된 상품을 확인하러 이동합니다.'
    else if (status === 'error' || status === 'stopped') {
      text = mallMode === 'normal'
        ? '"이어서 스크랩하기" - 실패/중지된 지점부터 이어서 스크랩합니다.'
        : '몰 탭 확장 아이콘에서 "🔄 스크랩 시작"을 다시 눌러 이어서 진행합니다.'
    } else if (mallMode === 'normal') {
      if (loginStep === 'none') text = '"로그인 창 열기" - 몰 로그인 창에서 로그인합니다.'
      else if (loginStep === 'opened') text = '"로그인 확인" - 몰에서 로그인하셨다면 로그인확인 버튼을 클릭합니다.'
      else if (dbStepKey === 'profile') text = '"몰 구조 파악" - 몰 구조 파악 버튼을 클릭합니다.'
      else if (dbStepKey === 'rules') text = '"몰 구조 파악" - 다시 클릭해 추출규칙을 생성합니다.'
      else if (dbStepKey === 'scrape') {
        text = previewResult
          ? '"스크래핑 시작" - 확인이 끝났다면 스크래핑 시작 버튼을 클릭합니다.'
          : '"스크랩 미리보기" - 스크랩 미리보기 버튼을 클릭해 수집 결과를 확인합니다.'
      }
    } else if (mallMode === 'devmode') {
      text = previewResult
        ? '몰 탭 확장 아이콘에서 "🔄 스크랩 시작"을 눌러 스크랩을 시작합니다.'
        : '"브라우저에서 바로 열기" - 몰을 열어 로그인한 뒤, 몰 탭 확장 아이콘에서 "🔍 스크랩 미리보기 실행"을 누릅니다.'
    }
    setGuidance(text)
    return () => setGuidance(null)
  }, [selectedSite, mallMode, loginStep, dbStepKey, status, previewResult, setGuidance])

  /** 개발자모드 몰 URL을 실제로 열어준다 — CDP(원격 디버깅) 연결이 전혀 없는 진짜 크롬이라("로그인
   *  확인"의 openManualLoginWindow와 동일한 방식) 개발자모드 몰의 자동화 감지에 걸리지 않는다. ID/PW는
   *  이 방식으로는 자동 입력할 수 없다 — 입력하려면 CDP가 있어야 하는데, 그게 바로 이 몰들이 차단하는
   *  신호라 "자동 로그인까지"는 이 방식과 모순된다. 대신 아래에 복사 버튼으로만 제공한다. */
  async function handleOpenMallUrlDirect(url: string) {
    if (!selectedSite) return
    await fetch('/api/scrape/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ siteId: selectedSite.id, url, manualLogin: true }),
    })
  }

  async function handleCopyCred(which: 'id' | 'pw', value: string) {
    try {
      await navigator.clipboard.writeText(value)
      setCredCopied(which)
      setTimeout(() => setCredCopied(null), 1500)
    } catch { /* 클립보드 권한이 없으면 조용히 무시 */ }
  }

  async function handleChooseScrapeMode(devMode: boolean) {
    if (!selectedSite) return
    setModeSaving(true)
    try {
      await fetch(`/api/sites/${selectedSite.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ manualLoginRequired: devMode }),
      })
      setSelectedSite(prev => prev && { ...prev, manual_login_required: devMode })
      bumpRefresh('sites')
    } finally {
      setModeSaving(false)
    }
  }

  async function selectSite(siteId: number) {
    const res = await fetch(`/api/sites/${siteId}`)
    if (!res.ok) { alert(`Mall 정보를 불러오지 못했습니다 (${res.status})`); return }
    const full = await res.json() as Site & {
      login_pw: string | null
      extraction_rules?: Record<string, { type: string; value: string }>
      devmode_ai_preview?: boolean
    }
    setSelectedSite({
      id: full.id, name: full.name, url: full.url, login_url: full.login_url, login_id: full.login_id,
      manual_login_required: full.manual_login_required, profile_dir: full.profile_dir,
    })
    setLoginId(full.login_id || '')
    setLoginPw(full.login_pw || '')
    setLoginStep('none')
    // 이 몰에 예전에 "스크랩 대상 직접지정"으로 등록해둔 컬럼이 있으면, 피커를 켜지 않은 채 바로 미리보기만
    // 해도 그리드에 컬럼으로 나오도록 미리 채워둔다(그리드는 이 목록에 있는 필드만 컬럼으로 보여준다).
    setPickerRules(full.extraction_rules || {})
    setSiteQuery('')
    setTargetUrl(full.url)
    setCategoryUrlsText('') // 이전 사이트의 카테고리 목록이 남아 시작 URL을 무시하는 것을 방지
    setCategories([])
    setCategoriesCached(null)
    setDetectedPlatform(null)
    setPreviewResult(null)
    setPreviewTotal(null)
    setPreviewItems([]); setCategoryCounts([])
    setSessionExpiredWarning(false)
    // AI모드는 일반모드에선 그냥 로컬 상태(기본 켜짐)지만, 개발자모드는 확장이 실행 시점마다 서버에서
    // 값을 물어봐야 해서 DB에 저장해둔 값을 그대로 복원한다.
    setAiMode(full.manual_login_required === true ? !!full.devmode_ai_preview : true)
    setPickerActive(false)
    if (devPreviewTimeoutRef.current) clearTimeout(devPreviewTimeoutRef.current)
    // 다른 몰을 새로 고르는 것이므로, 이전 몰의 진행 상황("수집완료" 등)이 화면에 그대로 남아있으면 안
    // 된다 — LAST_SESSION_KEY 복원(마운트 시 1회)과 별개로, 몰을 바꿀 때마다 항상 초기화한다.
    setStatus('idle')
    setSessionId(null)
    setProgress({ saved: 0, total: 0, successCount: 0, failedCount: 0 }); setConcurrencyLog([])
    setItemLog([])
    setStopping(false)
    setRetrying(false)
    localStorage.removeItem(LAST_SESSION_KEY)
    // 탭 전환 등으로 이 화면이 다시 마운트돼도, 로그인 창이 서버에 실제로 열려있으면 그 상태를 그대로 복원한다
    // (loginStep은 이 컴포넌트의 로컬 상태라 마운트될 때마다 초기화되지만, 실제 브라우저 세션은 서버에 계속 살아있을 수 있다).
    // 반대로 서버에 열려있는 게 없으면 명시적으로 'none'으로 되돌린다 — 안 그러면 아래 FORM_STATE_KEY
    // 복원(localStorage에 남아있던 예전 loginStep='confirmed')이 이 값을 덮어써도 아무도 고쳐주지 않아,
    // PTP 서버를 재시작해 실제 로그인 창이 사라진 뒤에도 화면은 계속 "확인됨"으로 남는 문제가 있었다.
    fetch(`/api/scrape/current-url?siteId=${siteId}`).then(r => r.json()).then((d: { url: string | null }) => {
      setLoginStep(d.url ? 'confirmed' : 'none')
    }).catch(() => {})
  }

  async function handleOpenLogin() {
    if (!selectedSite) return
    setLoginBusy(true)
    try {
      await fetch('/api/scrape/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          siteId: selectedSite.id, url: selectedSite.login_url || selectedSite.url, loginId, loginPw,
          manualLogin: selectedSite.manual_login_required,
        }),
      })
      setLoginStep('opened')
    } finally {
      setLoginBusy(false)
    }
  }

  async function handleConfirmLogin() {
    if (!selectedSite) return
    setLoginBusy(true)
    try {
      const res = await fetch('/api/scrape/login-confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ siteId: selectedSite.id }),
      })
      const d = await res.json() as { ok: boolean; currentUrl: string | null }
      if (d.currentUrl) { setTargetUrl(d.currentUrl); setCategoryUrlsText('') }
      setLoginStep('confirmed')
      setProfileResult(null)
      setProfileError('')
      setPickerActive(false)
      setSessionExpiredWarning(false)
      await refreshPickerRules()
    } finally {
      setLoginBusy(false)
    }
  }

  /** "몰 구조 파악" — 결제계좌/택배사 등 거래정보를 AI로 분석해(app/api/sites/[id]/profile →
   *  runMallStructureReport) 그 자리에서 즉시 결과를 보여준다. 몰 구조 "변경 감지"는 이 메뉴가 아니라
   *  '마이그레이션3_연속관리'에서 한다(2026-08 이전). */
  async function handleProfileMall() {
    if (!selectedSite) return
    setProfileLoading(true)
    setProfileError('')
    try {
      const res = await fetch(`/api/sites/${selectedSite.id}/profile`, { method: 'POST' })
      const d = await res.json()
      if (!res.ok) { setProfileError(d.error || '몰 구조 파악에 실패했습니다'); return }
      setProfileResult(d as ProfileCheckResult)
      bumpRefresh('sites')
    } catch {
      setProfileError('몰 구조 파악에 실패했습니다')
    } finally {
      setProfileLoading(false)
    }
  }

  /** "스크랩 대상 직접지정" — 로그인 창에 클릭식 엘리먼트 피커를 주입한다. 사용자가 실제 몰 페이지에서 값을 클릭하고
   *  컬럼명을 입력하면 그 자리에서 sites.extraction_rules에 저장되므로, 여기서는 시작/종료와 "지금까지
   *  지정된 컬럼" 목록 표시만 맡는다(폴링으로 갱신 — 몰 페이지 안에서 저장하는 거라 이 화면과 직접 연결돼
   *  있지 않음). 미리보기를 이미 돌려본 상태면, 그 미리보기가 열어본 바로 그 상품 페이지를 로그인 창에
   *  먼저 띄운다 — 화면에 보이는 미리보기 값과 로그인 창에서 클릭할 요소가 같은 상품이어야 의미가 있다. */
  async function handleStartPicker() {
    if (!selectedSite) return
    setPickerBusy(true)
    try {
      // 미리보기 상품 페이지로 이동하는 것까지 서버 쪽(startElementPicker)에서 같은 탭에 대해 한 번에
      // 처리한다 — 예전엔 여기서 새 탭을 먼저 열고 서버가 "마지막 탭"을 다시 골랐는데, 이 버튼을 다시
      // 누를 때마다(예: 다른 메뉴 갔다 돌아와서) 매번 탭이 하나씩 쌓이며 예전 탭의 피커가 안 닫힌 채
      // 방치돼 최신 탭과 서로 저장을 경쟁하는 문제가 있었다.
      const res = await fetch(`/api/sites/${selectedSite.id}/picker/start`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ previewProduct: previewResult?.product ?? null, targetUrl: previewResult?.sourceUrl ?? null }),
      })
      const d = await res.json()
      if (!res.ok) { alert(d.error || '스크랩 대상 직접지정을 시작하지 못했습니다'); return }
      setPickerActive(true)
      await refreshPickerRules()
    } finally {
      setPickerBusy(false)
    }
  }

  async function refreshPickerRules() {
    if (!selectedSite) return
    const res = await fetch(`/api/sites/${selectedSite.id}`)
    const d = await res.json() as { extraction_rules?: Record<string, { type: string; value: string }> }
    setPickerRules(d.extraction_rules || {})
  }

  // 피커가 켜져있는 동안 몰 페이지에서 저장한 컬럼이 이 화면에도 곧바로 보이도록 짧게 폴링한다.
  useEffect(() => {
    if (!pickerActive) return
    const id = setInterval(refreshPickerRules, 2_000)
    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refreshPickerRules는 selectedSite를 클로저로 참조, 매번 새로 만들어도 되는 인터벌 콜백이라 의존성 경고는 무시
  }, [pickerActive, selectedSite])

  async function handleRefreshCurrentUrl() {
    if (!selectedSite) return
    setCurrentUrlLoading(true)
    try {
      const res = await fetch(`/api/scrape/current-url?siteId=${selectedSite.id}`)
      const d = await res.json() as { url: string | null }
      if (d.url) { setTargetUrl(d.url); setCategoryUrlsText(''); setCurrentUrlFetched(true) }
    } finally {
      setCurrentUrlLoading(false)
    }
  }

  /** 로그인 창에 새 탭으로 열어 로그인된 상태로 보여준다. 로그인 창이 닫혀있으면 서버가 저장된 로그인
   * 쿠키로 새 창을 띄운다 — 그것도 안 되면 Chrome(없으면 Edge)으로 열고, 그마저 안 되면(설치된 브라우저를
   * 못 찾음 등) 일반 새 탭(=PTP를 띄운 브라우저)으로 최후 폴백한다. */
  async function handleOpenItem(url: string) {
    if (selectedSite) {
      try {
        const res = await fetch('/api/scrape/open-url', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ siteId: selectedSite.id, url }),
        })
        if (res.ok) return
      } catch { /* 폴백으로 진행 */ }
    }
    try {
      const res = await fetch('/api/system/open-in-browser', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      })
      if (res.ok) return
    } catch { /* 폴백으로 진행 */ }
    window.open(url, '_blank', 'noreferrer')
  }

  async function handleLoadCategories(force = false) {
    if (!selectedSite || !targetUrl) return
    setCategoriesLoading(true)
    try {
      const res = await fetch('/api/scrape/categories', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ siteId: selectedSite.id, url: targetUrl, loginId, loginPw, force }),
      })
      const d = await res.json() as {
        links: { href: string; text: string }[]; platform: string; cached: boolean; updatedAt: string | null
        scrapedHrefs?: string[]; allScraped?: boolean; excludedCategoryHrefs?: string[]
      }
      setCategories(d.links || [])
      setDetectedPlatform(d.platform || null)
      setCategoriesCached({ cached: d.cached, updatedAt: d.updatedAt ?? null })
      setScrapedCategoryHrefs(d.scrapedHrefs || [])
      setAllCategoriesScraped(!!d.allScraped)
      setExcludedCategoryHrefs(d.excludedCategoryHrefs || [])
    } finally {
      setCategoriesLoading(false)
    }
  }

  function isCategorySelected(href: string) {
    return categoryUrlsText.split('\n').map(s => s.trim()).includes(href)
  }
  function isCategoryScraped(href: string) {
    return allCategoriesScraped || scrapedCategoryHrefs.includes(href)
  }
  function isCategoryExcluded(href: string) {
    return excludedCategoryHrefs.includes(href)
  }
  /** 실제 상품이 없는 카테고리(안내/문의 페이지 등)를 사용자가 직접 열어보고 "이건 아니다"로 표시한다 —
   *  화면엔 바로 반영하고(목록 맨 아래로 정리), 서버에도 남겨 다음에 카테고리를 다시 불러와도 유지되게
   *  한다. 서버 저장이 실패해도 화면 표시는 그대로 두고 조용히 넘어간다 — 실패해도 이번 화면에서 목록을
   *  정리하는 데는 지장이 없고, 다음에 다시 불러오면 서버 값 기준으로 다시 맞춰진다. */
  async function toggleCategoryExcluded(href: string) {
    if (!selectedSite) return
    const nextExcluded = !isCategoryExcluded(href)
    setExcludedCategoryHrefs(prev => (nextExcluded ? [...prev, href] : prev.filter(h => h !== href)))
    try {
      await fetch('/api/scrape/categories/exclude', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ siteId: selectedSite.id, href, excluded: nextExcluded }),
      })
    } catch { /* 화면 표시는 이미 반영했으니 조용히 넘어간다 */ }
  }
  function toggleCategory(href: string) {
    const lines = categoryUrlsText.split('\n').map(s => s.trim()).filter(Boolean)
    const next = lines.includes(href) ? lines.filter(l => l !== href) : [...lines, href]
    setCategoryUrlsText(next.join('\n'))
  }
  function toggleAllCategories() {
    const allSelected = categories.length > 0 && categories.every(c => isCategorySelected(c.href))
    setCategoryUrlsText(allSelected ? '' : categories.map(c => c.href).join('\n'))
  }

  const canPreview = !!targetUrl.trim() || categoryUrlsText.trim().length > 0

  function applyCatalogPreview(d: { total: number; platform: string; preview: { sourceUrl: string; product: PreviewProduct } | null; items: PreviewItem[]; categoryCounts?: CategoryCountItem[]; needsLogin?: boolean }) {
    setPreviewTotal(d.total)
    setDetectedPlatform(d.platform || null)
    setPreviewItems((d.items || []).slice(d.preview ? 1 : 0)) // 첫 상품은 위 상세 카드에 이미 나오니 그리드에서는 제외
    setCategoryCounts(d.categoryCounts || [])
    if (d.preview) setPreviewResult(d.preview)
    setSessionExpiredWarning(!!d.needsLogin)
    if (d.needsLogin) handleOpenLogin()
  }

  // 개발자모드 미리보기 결과 폴링 — 이 몰이 선택돼 devmode인 동안 항상 돌아간다("스크랩 미리보기" 버튼과
  // 무관). 몰 탭에서 확장의 "스크랩 미리보기 실행"만 눌러도(PTP 버튼을 먼저 누르지 않아도) 몇 초 안에
  // 여기서 그 결과를 발견해 반영한다. last_adjustment_preview는 이제 일반모드의 previewCatalog와 같은
  // 모양(total/platform/preview/items)이라 applyCatalogPreview를 그대로 재사용한다 — 카테고리 페이지를
  // 캡처했으면 첫 상품 상세+나머지 목록이, 상품 상세 페이지 하나만 캡처했으면 그 1건만 채워진다. 값이
  // 실제로 바뀐 경우만 반영해 불필요한 리렌더를 피한다.
  const devLastPreviewKeyRef = useRef<string | null>(null)
  useEffect(() => {
    if (mallMode !== 'devmode' || !selectedSite) return
    const siteId = selectedSite.id
    const id = setInterval(async () => {
      const res = await fetch(`/api/sites/${siteId}`).catch(() => null)
      if (!res?.ok) return
      const d = await res.json() as {
        last_adjustment_preview?: { total: number; platform: string; preview: { sourceUrl: string; product: PreviewProduct } | null; items: PreviewItem[] } | null
      }
      const captured = d.last_adjustment_preview
      if (!captured) return
      const key = JSON.stringify(captured)
      if (key === devLastPreviewKeyRef.current) return
      devLastPreviewKeyRef.current = key
      applyCatalogPreview(captured)
      setPreviewLoading(false)
      if (devPreviewTimeoutRef.current) { clearTimeout(devPreviewTimeoutRef.current); devPreviewTimeoutRef.current = null }
    }, 3000)
    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- selectedSite 객체 자체가 갱신마다 새로 생성돼도 siteId만 같으면 재구독할 필요 없음
  }, [mallMode, selectedSite?.id])

  /** "스크랩 미리보기" 버튼 — 이전 결과를 비우고 "대기 중" 표시를 켠다. 실제 결과 반영은 위 폴링이
   *  전담한다(이 버튼을 누르지 않고 몰 탭에서 확장만 실행해도 동일하게 반영됨) — 여기서는 예전 결과를
   *  지워 헷갈리지 않게 하고, 2분 안에 응답이 없으면 "대기 중" 표시만 스스로 풀어준다. */
  async function handleDevPreview() {
    if (!selectedSite) return
    setPreviewResult(null)
    setPreviewTotal(null)
    setPreviewItems([]); setCategoryCounts([])
    setPreviewLoading(true)
    devLastPreviewKeyRef.current = null // 재캡처 결과가 이전과 완전히 같아도 새 결과로 인식해 반영하도록
    await fetch(`/api/sites/${selectedSite.id}/preview-arm`, { method: 'POST' })
    if (devPreviewTimeoutRef.current) clearTimeout(devPreviewTimeoutRef.current)
    devPreviewTimeoutRef.current = setTimeout(() => setPreviewLoading(false), 120_000)
  }

  useEffect(() => {
    return () => {
      if (devPreviewTimeoutRef.current) clearTimeout(devPreviewTimeoutRef.current)
    }
  }, [])

  /** 화면이 새로고침돼 이 몰에 이미 진행 중인 미리보기가 있는 걸 뒤늦게 발견했을 때만 쓴다(아래 마운트
   *  복원 로직 참고) — 그 요청을 이 탭이 다시 받을 방법은 없으니, 끝날 때까지 진행률만 이어서 보여주다가
   *  끝나면 다시 눌러달라고 안내한다. */
  function resumePreviewProgressPolling(siteId: number) {
    if (previewProgressPollRef.current) clearInterval(previewProgressPollRef.current)
    previewProgressPollRef.current = setInterval(async () => {
      const res = await fetch(`/api/scrape/preview-progress?siteId=${siteId}`).catch(() => null)
      const d = await res?.json().catch(() => null) as {
        done: number; total: number
        result?: { total: number; platform: string; preview: { sourceUrl: string; product: PreviewProduct } | null; items: PreviewItem[]; categoryCounts?: CategoryCountItem[]; needsLogin?: boolean }
      } | null
      // 서버(lib/scraper.ts의 endPreviewRun)가 정상 완료된 결과를 잠시 남겨두므로, 있으면 그대로
      // 받아 적용한다 — 새로고침으로 끊긴 원래 요청의 결과를 이 탭이 자동으로 이어받는 경로.
      if (d?.result) {
        if (previewProgressPollRef.current) { clearInterval(previewProgressPollRef.current); previewProgressPollRef.current = null }
        applyCatalogPreview(d.result)
        setPreviewLoading(false)
        setPreviewProgress(null)
        return
      }
      if (d?.total) { setPreviewProgress(d); return }
      // total도 result도 없다는 건 중지/밀려남/에러 등으로 남길 결과 없이 끝났다는 뜻 — 자동으로
      // 이어받을 게 없으니 다시 눌러달라고 안내한다.
      if (previewProgressPollRef.current) { clearInterval(previewProgressPollRef.current); previewProgressPollRef.current = null }
      setPreviewLoading(false)
      setPreviewProgress(null)
      setPreviewResumeNotice('새로고침 전 진행 중이던 미리보기가 결과 없이 끝난 것 같습니다 — "🔍 스크랩 미리보기"를 다시 눌러 확인해주세요.')
    }, 1000)
  }

  /** 목록에서 상품 개수를 세는 것과 첫 상품 미리보기를 한 번의 요청(한 브라우저 세션)으로 같이 처리한다
   * — 예전에는 "테스트 실행"과 "미리보기"가 별도 버튼/요청이라 세션을 두 번 열어야 해서 느렸다. 개수는
   * 페이징 끝까지 따라가 실제 전체 개수를 보여주고, 나머지 상품은 (열어보지 않고) 목록 정보만 그리드로
   * 함께 보여준다. 시작 URL이 목록이 아니라 상품 페이지 하나뿐이어도 scrapeCatalogPage가 그 페이지 자체를
   * 상품 1건으로 처리해 그대로 동작한다. */
  async function handlePreview() {
    if (!selectedSite || !canPreview) return
    setPreviewResumeNotice(null)
    setPreviewLoading(true)
    setPreviewResult(null)
    setPreviewTotal(null)
    setPreviewItems([]); setCategoryCounts([])
    setPreviewProgress(null)
    // 새 미리보기는 새 스크랩 대상을 정하는 것이므로, 아래 "진행 상황"에 이전 스크랩의 "완료" 기록이
    // 그대로 남아있으면 새로 스크래핑을 시작하려는 건지 이전 결과를 보는 건지 헷갈린다 — handleBackToSettings와
    // 같은 방식으로 초기화한다.
    setStatus('idle')
    setSessionId(null)
    setProgress({ saved: 0, total: 0, successCount: 0, failedCount: 0 }); setConcurrencyLog([])
    localStorage.removeItem(LAST_SESSION_KEY)
    const controller = new AbortController()
    previewAbortRef.current = controller
    // 카테고리가 많은/큰 몰은 몇 분씩 걸릴 수 있어 진행 중임을 보여준다 — 서버(previewCatalog)가
    // 세는 "카테고리 N/M"을 짧은 주기로 폴링한다. 새로고침 복구 중 관찰용 폴링(resumePreviewProgressPolling)이
    // 이미 돌고 있었을 수 있어(사용자가 그 안내를 기다리지 않고 바로 다시 누른 경우) 먼저 정리한다 —
    // 안 그러면 그 인터벌이 ref에서 밀려나 멈출 방법 없이 계속 도는(누수) 채로 남는다.
    if (previewProgressPollRef.current) clearInterval(previewProgressPollRef.current)
    const siteId = selectedSite.id
    previewProgressPollRef.current = setInterval(async () => {
      const res = await fetch(`/api/scrape/preview-progress?siteId=${siteId}`).catch(() => null)
      if (!res?.ok) return
      const d = await res.json() as { done: number; total: number }
      if (d.total > 0) setPreviewProgress(d)
    }, 1000)
    try {
      const categoryUrls = categoryUrlsText.split('\n').map(s => s.trim()).filter(Boolean)
      const res = await fetch('/api/scrape/preview-catalog', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          url: categoryUrls.length ? undefined : (targetUrl || undefined),
          categoryUrls: categoryUrls.length ? categoryUrls : undefined,
          loginId: loginId || undefined, loginPw: loginPw || undefined,
          siteId: selectedSite.id, aiMode, concurrencyMode, concurrency,
        }),
      })
      if (!res.ok) { const e = await res.json().catch(() => ({})); alert(`확인 실패: ${e.error || res.status}`); return }
      const d = await res.json() as { total: number; platform: string; preview: { sourceUrl: string; product: PreviewProduct } | null; items: PreviewItem[]; categoryCounts?: CategoryCountItem[]; needsLogin?: boolean; superseded?: boolean }
      // 같은 몰에 대해 다른 탭/요청이 더 뒤에 미리보기를 시작해 이 실행이 서버에서 중간에 밀려난
      // 경우(lib/scraper.ts의 beginPreviewRun 참고) — 이 응답은 불완전하니 화면에 반영하지 않는다.
      // 밀어낸 쪽(진짜 최신 요청)의 응답이 곧 따로 온다.
      if (d.superseded) return
      applyCatalogPreview(d)
    } catch (err) {
      // 사용자가 "중지"를 눌러 스스로 취소한 요청은 에러로 취급하지 않는다(handleStopPreview 참고).
      if (!(err instanceof DOMException && err.name === 'AbortError')) throw err
    } finally {
      setPreviewLoading(false)
      previewAbortRef.current = null
      if (previewProgressPollRef.current) { clearInterval(previewProgressPollRef.current); previewProgressPollRef.current = null }
      setPreviewProgress(null)
    }
  }

  /** "🔍 스크랩 미리보기"가 도는 동안(일반모드) 누르면 그 fetch를 abort한다 — 서버(previewCatalog)도
   *  같은 신호를 받아 진행 중이던 카테고리 개수 집계를 멈추므로, 중지 후 위 스크랩 대상을 다시 조정해
   *  바로 새 미리보기를 시작할 수 있다(같은 로그인 세션/탭을 그대로 재사용, 별도 정리 불필요). */
  function handleStopPreview() {
    if (previewAbortRef.current) { previewAbortRef.current.abort(); return }
    // 새로고침 뒤 서버에 아직 도는 미리보기를 관찰만 하던 중이면(resumePreviewProgressPolling) 이
    // 탭엔 취소할 실제 요청이 없다 — 폴링만 멈추고 화면을 초기 상태로 되돌린다(서버 쪽 작업 자체는
    // 계속 돈다 — 그 요청을 시작한 예전 탭이 없어졌을 뿐).
    if (previewProgressPollRef.current) { clearInterval(previewProgressPollRef.current); previewProgressPollRef.current = null }
    setPreviewLoading(false)
    setPreviewProgress(null)
  }

  const needsLogin = !!loginId
  const canStart = !!selectedSite && (!needsLogin || loginStep === 'confirmed')

  function handleBackToSettings() {
    setStatus('idle')
    setSessionId(null)
    setProgress({ saved: 0, total: 0, successCount: 0, failedCount: 0 }); setConcurrencyLog([])
    localStorage.removeItem(LAST_SESSION_KEY)
  }

  async function handleStart() {
    if (!selectedSite || !canStart) return
    const categoryUrls = categoryUrlsText.split('\n').map(s => s.trim()).filter(Boolean)
    setStatus('running')
    setProgress({ saved: 0, total: 0, successCount: 0, failedCount: 0 }); setConcurrencyLog([])
    setItemLog([])
    // 시작 버튼을 누르면 그 아래 "진행 상황" 섹션으로 자동 스크롤해, 화면을 따로 내리지 않아도 바로 보이게 한다.
    // 이 시점엔 아직 리렌더 전이라 섹션이 DOM에 없을 수 있어(status는 방금 막 바뀜) 다음 페인트 이후로 미룬다.
    requestAnimationFrame(() => progressSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
    const res = await fetch('/api/scrape', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: categoryUrls.length ? undefined : (targetUrl || undefined),
        categoryUrls: categoryUrls.length ? categoryUrls : undefined,
        // 페이지당 지연은 몰 차단 방지를 위한 안전값을 그대로 유지한다(사용자가 조절할 필요가 없어 UI에서
        // 제거) — 다음페이지 셀렉터/최대 페이지 수는 플랫폼별 자동 감지(cafe24 등)로 대체된다. 동시 처리
        // 개수는 기본적으로 scrapeCatalogPage가 몰의 반응을 보며 스스로 조절한다(적응형 동시성) — 아래
        // concurrencyMode가 'manual'이면 그 대신 concurrency 값으로 고정한다(메모리 이슈 진단/완화용).
        delayMs: 1000,
        loginId: loginId || undefined, loginPw: loginPw || undefined,
        mode: 'catalog', siteId: selectedSite.id, concurrencyMode, concurrency,
      }),
    })
    // 이 몰에 이미 진행 중인 세션이 있으면(app/api/scrape/route.ts) 새로 시작하는 대신 그 세션에
    // 그대로 연결한다 — 아무 설명 없이 "실행 중"만 뜬 채 멈춰있는 것처럼 보이지 않게 한다.
    if (!res.ok) {
      const e = await res.json().catch(() => ({})) as { error?: string; sessionId?: number }
      if (e.sessionId) {
        alert(e.error || '이미 진행 중인 스크래핑에 연결합니다.')
        setSessionId(e.sessionId)
        localStorage.setItem(LAST_SESSION_KEY, JSON.stringify({ site: selectedSite, sessionId: e.sessionId }))
      } else {
        alert(e.error || '스크래핑 시작에 실패했습니다')
        setStatus('idle')
      }
      return
    }
    const data = await res.json() as { sessionId: number }
    setSessionId(data.sessionId)
    localStorage.setItem(LAST_SESSION_KEY, JSON.stringify({ site: selectedSite, sessionId: data.sessionId }))
  }

  async function handleRetryFailed() {
    if (!selectedSite || failedUrls.length === 0) return
    setRetrying(true)
    setStatus('running')
    setProgress({ saved: 0, total: 0, successCount: 0, failedCount: 0 }); setConcurrencyLog([])
    setItemLog([])
    try {
      const res = await fetch('/api/scrape', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          productUrls: failedUrls, mode: 'catalog', scrapeMode: 'incremental',
          loginId: loginId || undefined, loginPw: loginPw || undefined, siteId: selectedSite.id,
        }),
      })
      const data = await res.json() as { sessionId: number }
      setSessionId(data.sessionId)
      localStorage.setItem(LAST_SESSION_KEY, JSON.stringify({ site: selectedSite, sessionId: data.sessionId }))
    } finally {
      setRetrying(false)
    }
  }

  async function handleStop() {
    if (!sessionId) return
    setStopping(true)
    await fetch('/api/scrape/stop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    })
  }

  const statusColor = { idle: 'text-gray-500', running: 'text-teal-500', done: 'text-emerald-600', error: 'text-rose-600', stopped: 'text-amber-600' }
  const statusLabel = { idle: '대기 중', running: '스크래핑 중...', done: '완료', error: '오류 발생', stopped: '중지됨' }

  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-800 mb-6">🔍 스크래핑 설정</h1>

      {/* Mall 선택 */}
      <div className="bg-white rounded-2xl border border-gray-200 p-6 mb-4">
        <div className="flex items-center justify-between mb-2 gap-3">
          <div className="text-sm font-semibold text-gray-700">
            Mall 선택 *
            {mallSelectCollapsed && (
              <span className="ml-2 font-normal text-gray-400">
                {selectedSite ? `— ${selectedSite.name || selectedSite.url}` : '— 선택 안 됨'}
              </span>
            )}
          </div>
          <button onClick={() => setMallSelectCollapsed(v => !v)}
            className="px-3 py-1 bg-gray-100 hover:bg-gray-200 text-gray-600 text-xs font-semibold rounded-full transition-colors shrink-0">
            {mallSelectCollapsed ? '▼ 펼치기' : '▲ 접기'}
          </button>
        </div>
        {!mallSelectCollapsed && (sites.length === 0 ? (
          <div className="text-sm text-gray-400">
            등록된 Mall이 없습니다.{' '}
            <button onClick={() => openTab({ id: 'sites-list', type: 'sites-list', title: 'Mall 상세관리', icon: '📋', closable: true })}
              className="text-teal-500 hover:underline">Mall 등록관리에서 추가하기 →</button>
          </div>
        ) : (
          <div>
            <div className="flex flex-wrap items-center gap-3 mb-3">
              <label className="flex items-center gap-2 text-sm text-gray-600">
                거래처
                <select value={clientFilter} onChange={e => setClientFilter(e.target.value ? Number(e.target.value) : '')}
                  className="border border-gray-300 rounded-xl px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-teal-400">
                  <option value="">전체</option>
                  {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </label>
              <label className="flex items-center gap-2 text-sm text-gray-600">
                몰
                <select value={selectedSite?.id ?? ''}
                  onChange={e => { if (e.target.value) selectSite(Number(e.target.value)); else { setSelectedSite(null); setLoginStep('none') } }}
                  className="border border-gray-300 rounded-xl px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-teal-400 min-w-[180px]">
                  <option value="">몰을 선택하세요</option>
                  {filteredSites.map(s => <option key={s.id} value={s.id}>{s.name || s.url}</option>)}
                </select>
              </label>
              <label className="flex-1 min-w-[200px] block">
                <span className="sr-only">Mall 이름 · 메인 품목 · URL 검색</span>
                <input value={siteQuery} onChange={e => setSiteQuery(e.target.value)} placeholder="Mall 이름·메인 품목·URL 검색..."
                  className="w-full border border-gray-300 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-400" />
              </label>
            </div>
            <div className="border border-gray-100 rounded-xl overflow-hidden">
              <div className="flex items-center justify-end gap-2 px-3 py-1.5 border-b border-gray-100 bg-gray-50">
                {/* 보조 기능 토글(켜짐/꺼짐)은 클릭 한 번짜리 액션 버튼(rounded-full 알약 모양)과 모양부터
                    다르게 — 사각형에 가까운 rounded-md로 "체크박스형 스위치"라는 걸 한눈에 구분되게 한다. */}
                <button onClick={() => setSiteShowFilters(v => !v)}
                  className={`px-3 py-0.5 text-xs font-semibold rounded-md transition-colors ${siteShowFilters ? 'bg-teal-100 text-teal-700 hover:bg-teal-200' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>
                  🔍 필터
                </button>
                {(siteHasColFilters || siteSortKeys.length > 0) && (
                  <button onClick={() => { setSiteColFilters({}); setSiteSortKeys([]) }}
                    className="px-3 py-1 bg-gray-100 text-gray-600 text-xs font-semibold rounded-full hover:bg-gray-200 transition-colors">
                    필터/정렬 초기화
                  </button>
                )}
              </div>
              <div className="max-h-48 overflow-y-auto">
                {visibleSites.length === 0 ? (
                  <div className="px-3 py-3 text-xs text-gray-400 text-center">검색 결과가 없습니다.</div>
                ) : (
                  <table className="text-xs border-collapse" style={{ tableLayout: 'fixed', width: siteTableWidth }}>
                    <colgroup>
                      {siteOrderedColumns.map(col => <col key={col.key} style={{ width: siteColWidths[col.key] ?? sitePickerWidthFor(col.key) }} />)}
                    </colgroup>
                    <thead className="sticky top-0 z-10 bg-gray-50">
                      <tr className="border-b border-gray-200 text-gray-500 font-semibold">
                        {siteOrderedColumns.map((col, colIdx) => {
                          const idx = siteSortKeys.findIndex(s => s.key === col.key)
                          const active = idx !== -1
                          return (
                            <th key={col.key} draggable
                              onDragStart={() => setSiteDragKey(col.key)}
                              onDragOver={e => e.preventDefault()}
                              onDrop={() => handleSiteColDrop(col.key)}
                              onDragEnd={() => setSiteDragKey(null)}
                              className={`relative px-3 py-2 text-left cursor-pointer select-none hover:bg-gray-100 overflow-hidden whitespace-nowrap ${siteDragKey === col.key ? 'opacity-40' : ''} ${colIdx === 0 ? 'sticky left-0 z-20 bg-gray-50' : ''}`}
                              onClick={e => handleSiteSort(col.key, e)} title="드래그: 컬럼 순서 이동 · 클릭: 정렬 · Shift+클릭: 복합 정렬 추가">
                              <span className={active ? 'text-gray-800' : ''}>{col.label}</span>
                              {active && <span className="ml-1 text-teal-500">{siteSortKeys[idx].dir === 'asc' ? '▲' : '▼'}{siteSortKeys.length > 1 ? idx + 1 : ''}</span>}
                              <div onMouseDown={e => { e.stopPropagation(); startSiteResize(col.key, e) }} onClick={e => e.stopPropagation()} draggable={false}
                                className="absolute top-0 right-0 bottom-0 w-1.5 cursor-col-resize hover:bg-teal-400 active:bg-teal-500" />
                            </th>
                          )
                        })}
                      </tr>
                      {siteShowFilters && (
                        <tr className="border-b border-gray-200 bg-white">
                          {siteOrderedColumns.map((col, colIdx) => (
                            <th key={col.key} className={`px-2 py-1.5 font-normal ${colIdx === 0 ? 'sticky left-0 z-20 bg-white' : ''}`}>
                              <input value={siteColFilters[col.key] || ''} onChange={e => setSiteColFilters(f => ({ ...f, [col.key]: e.target.value }))}
                                placeholder="필터..." onClick={e => e.stopPropagation()}
                                className="w-full border border-gray-200 rounded px-1.5 py-1 text-xs font-normal focus:outline-none focus:ring-1 focus:ring-teal-300" />
                            </th>
                          ))}
                        </tr>
                      )}
                    </thead>
                    <tbody>
                      {visibleSites.map(s => (
                        <tr key={s.id} onClick={() => selectSite(s.id)}
                          className="group border-b border-gray-100 last:border-0 hover:bg-gray-50 cursor-pointer transition-colors">
                          {siteOrderedColumns.map((col, colIdx) => (
                            <td key={col.key} className={`px-3 py-2 truncate ${col.className ?? ''} ${colIdx === 0 ? 'sticky left-0 z-10 bg-white group-hover:bg-gray-50' : ''}`} title={col.key === 'url' || col.key === 'main_items' ? col.getValue(s) : undefined}>
                              {col.render(s)}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>

      {selectedSite && (
        <div className="mb-4 bg-teal-50 rounded-xl px-3 py-2">
          <div className="text-sm font-medium text-gray-800">{selectedSite.name || selectedSite.url}</div>
          <div className="text-xs text-gray-500">{selectedSite.url}</div>
        </div>
      )}

      {/* 이 몰의 로그인 창/프로필을 다른 스크랩 작업이 쓰고 있어 순서를 기다리는 중이면 알려준다
          (withSiteLock 참고) — 안 그러면 지금 누른 버튼이 왜 응답이 없는지 알 방법이 없다. */}
      {selectedSite && siteLockStatus?.busy && (
        <div className="mb-4 bg-amber-50 border border-amber-200 rounded-xl px-4 py-2.5 text-xs text-amber-700 flex items-center gap-2">
          <span>⏳</span>
          <span>
            이 몰은 지금 다른 작업(<b>{siteLockStatus.label}</b>)이 진행 중입니다
            {siteLockStatus.sinceMs != null && ` — ${Math.round(siteLockStatus.sinceMs / 1000)}초째`} —
            끝나면 방금 누른 작업이 이어서 진행됩니다.
          </span>
        </div>
      )}

      {/* 스크랩 방식 선택 (최초 스크랩 — 아직 정해지지 않은 몰만) */}
      {mallMode === 'undetermined' && (
        <div className="bg-white rounded-2xl border border-gray-200 p-6 mb-4">
          <div className="text-sm font-semibold text-gray-700 mb-1">이 몰은 스크랩 방식이 아직 정해지지 않았습니다</div>
          <p className="text-xs text-gray-400 mb-4">처음 스크랩할 때 한 번만 선택하면 됩니다 — 나중에 Mall 상세관리에서 다시 바꿀 수 있습니다.</p>
          <div className="flex gap-3">
            <button type="button" onClick={() => handleChooseScrapeMode(false)} disabled={modeSaving}
              className="flex-1 text-left px-4 py-3 rounded-xl border border-gray-300 hover:border-teal-400 disabled:opacity-50 transition-colors">
              <div className="text-sm font-semibold text-gray-800">🤖 일반모드</div>
              <div className="text-xs text-gray-400 mt-0.5">PTP가 자동으로 로그인하고 스크랩합니다. 대부분의 몰은 이 방식이면 충분합니다.</div>
            </button>
            <button type="button" onClick={() => handleChooseScrapeMode(true)} disabled={modeSaving}
              className="flex-1 text-left px-4 py-3 rounded-xl border border-gray-300 hover:border-teal-400 disabled:opacity-50 transition-colors">
              <div className="text-sm font-semibold text-gray-800">🧩 개발자모드</div>
              <div className="text-xs text-gray-400 mt-0.5">PC인증(윈도우 보안) 등으로 자동 로그인이 안 되는 몰입니다. 크롬 확장으로 직접 스크랩합니다.</div>
            </button>
          </div>
        </div>
      )}

      {/* 로그인 */}
      {selectedSite && mallMode === 'normal' && (
        <div className="bg-white rounded-2xl border border-gray-200 p-6 mb-4">
          <div className="flex items-center justify-between mb-3 gap-3">
            <div className="text-sm font-semibold text-gray-700">
              로그인 정보
              {loginCardCollapsed && (
                <span className="ml-2 font-normal text-gray-400">
                  {loginStep === 'confirmed' ? '— ✓ 확인됨' : loginStep === 'opened' ? '— 확인 대기 중' : '— 아직 확인 안 함'}
                </span>
              )}
            </div>
            <button onClick={() => setLoginCardCollapsed(v => !v)}
              className="px-3 py-1 bg-gray-100 hover:bg-gray-200 text-gray-600 text-xs font-semibold rounded-full transition-colors shrink-0">
              {loginCardCollapsed ? '▼ 펼치기' : '▲ 접기'}
            </button>
          </div>
          {!loginCardCollapsed && <>
          <div className="grid grid-cols-2 gap-3 mb-4">
            <label className="block">
              <span className="block text-xs text-gray-500 mb-1">아이디 / 이메일</span>
              <input type="text" value={loginId} onChange={e => { setLoginId(e.target.value); setLoginStep('none') }}
                className="w-full border border-gray-300 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-400" />
            </label>
            <label className="block">
              <span className="block text-xs text-gray-500 mb-1">비밀번호</span>
              <input type="password" value={loginPw} onChange={e => { setLoginPw(e.target.value); setLoginStep('none') }}
                className="w-full border border-gray-300 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-400" />
            </label>
          </div>

          <div className="flex items-center gap-3 flex-wrap">
            {/* 한 번이라도 눌러 완료된 단계는 진한 색(누르세요) 대신 옅은 테두리형 + 앞에 체크(✓)를 붙여,
                이미 지나온 단계와 다음에 눌러야 할 단계가 (색 대비만으론 헷갈릴 수 있어) 아이콘으로도 확실히
                구분되게 한다(보조 버튼인 몰 구조파악/직접지정 등은 그대로 둔다). */}
            <button onClick={handleOpenLogin} disabled={loginBusy}
              className={`px-4 py-2 text-sm font-semibold rounded-full disabled:opacity-50 transition-colors ${
                loginStep === 'opened' || loginStep === 'confirmed'
                  ? 'bg-white border-2 border-teal-500 text-teal-600 hover:bg-teal-50'
                  : 'bg-teal-500 hover:bg-teal-600 text-white'}`}>
              {needsLogin
                ? (loginStep === 'opened' || loginStep === 'confirmed' ? '✓ 로그인 창 다시 열기' : '로그인 창 열기')
                : (loginStep === 'opened' || loginStep === 'confirmed' ? '✓ 몰 페이지 다시 열기' : '몰 페이지 열기')}
            </button>
            <button onClick={handleConfirmLogin} disabled={loginBusy || loginStep === 'none'}
              className={`px-4 py-2 text-sm font-semibold rounded-full disabled:opacity-50 disabled:cursor-not-allowed transition-colors ${
                loginStep === 'confirmed'
                  ? 'bg-white border-2 border-emerald-500 text-emerald-600 hover:bg-emerald-50'
                  : 'bg-emerald-600 hover:bg-emerald-700 text-white'}`}>
              {loginStep === 'confirmed' ? '✓ 확인됨' : needsLogin ? '로그인 확인' : '확인'}
            </button>
            {loginStep === 'confirmed' && (
              <button onClick={handleProfileMall} disabled={profileLoading}
                className="px-4 py-2 bg-white border border-gray-300 text-gray-600 hover:bg-gray-50 text-sm font-semibold rounded-full disabled:opacity-50 transition-colors">
                {profileLoading ? '몰 구조 파악 중...' : '🔍 몰 구조 파악'}
              </button>
            )}
            {loginStep === 'confirmed' && (
              <span className="text-xs text-emerald-600 font-medium">
                {needsLogin
                  ? '✓ 로그인 확인됨 (이 창을 열어두면 스크래핑도 이 창에서 이어서 진행되고, 닫으면 백그라운드에서 진행됩니다)'
                  : '✓ 확인됨 (이 창을 열어두면 스크래핑도 이 창에서 이어서 진행되고, 닫으면 백그라운드에서 진행됩니다)'}
              </span>
            )}
            {loginStep === 'opened' && (
              <span className="text-xs text-gray-500">
                {needsLogin ? '브라우저 창에서 로그인을 완료한 뒤 확인을 눌러주세요.' : '브라우저 창이 열리면 확인을 눌러주세요.'}
              </span>
            )}
          </div>
          {!needsLogin && (
            <p className="text-xs text-gray-400 mt-2">아이디를 입력하지 않으면 로그인 없이 바로 스크래핑을 시작할 수 있습니다. 몰 구조 파악을 쓰려면 위에서 몰 페이지를 먼저 열고 확인을 눌러주세요.</p>
          )}

          {profileError && <p className="text-xs text-rose-500 mt-3">{profileError}</p>}
          {profileResult && (
            <div className="mt-4 pt-4 border-t border-gray-100">
              <div className="flex items-center gap-2 mb-3">
                <span className={`text-xs font-semibold px-2.5 py-1 rounded-full ${
                  profileResult.isFirstTime ? 'bg-teal-100 text-teal-700'
                  : profileResult.diffs.length ? 'bg-amber-100 text-amber-700' : 'bg-gray-100 text-gray-600'
                }`}>
                  {profileResult.isFirstTime ? '🔍 몰 구조 파악 완료' : profileResult.diffs.length ? '⚠ 이전과 구조가 달라짐' : '✓ 이전과 구조 동일'}
                </span>
                <span className="text-xs text-gray-400">상품 {profileResult.signals.sampleCount}건 샘플 기준</span>
                {profileResult.signals.report && (
                  profileResult.signals.report.generatedBy === 'heuristic' ? (
                    <span className="text-xs font-semibold px-2.5 py-1 rounded-full bg-amber-100 text-amber-700"
                      title="AI 호출이 실패해(크레딧 부족 등) 정규식/키워드 매칭으로 대신 채운 결과입니다 — AI 분석보다 정확도가 낮을 수 있습니다.">
                      ⚠ 규칙 기반 (AI 아님)
                    </span>
                  ) : (
                    <span className="text-xs font-semibold px-2.5 py-1 rounded-full bg-teal-100 text-teal-700">🤖 AI 분석</span>
                  )
                )}
              </div>
              {profileResult.diffs.length > 0 && (
                <ul className="mb-3 text-xs text-amber-700 bg-amber-50 rounded-lg px-3 py-2 space-y-0.5">
                  {profileResult.diffs.map(d => <li key={d}>· {d}</li>)}
                </ul>
              )}
              {profileResult.autoRuleFields.length > 0 && (
                <p className="mb-3 text-xs text-teal-700 bg-teal-50 rounded-lg px-3 py-2">
                  ✓ 이 결과로 추출규칙 자동 생성됨: {profileResult.autoRuleFields.join(', ')} — 이후 미리보기/스크랩부터 바로 적용됩니다.
                </p>
              )}
              {profileResult.signals.report ? (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                  {([
                    ['🔗', 'URL 계층', profileResult.signals.report.urlHierarchy],
                    ['🗂️', '카테고리 구조', profileResult.signals.report.categoryStructure],
                    ['🏦', '은행명', profileResult.signals.report.bankName],
                    ['🔢', '계좌번호', profileResult.signals.report.accountNumber],
                    ['🚚', '배송 택배사', profileResult.signals.report.shippingCourier],
                    ['💰', '택배비/배송비', profileResult.signals.report.shippingFeeInfo],
                    ['📮', '배송/반품 주소지', profileResult.signals.report.returnAddress],
                    ['📦', '재고 관리 형태', profileResult.signals.report.stockManagementType],
                    ['☎️', '업체 연락처', profileResult.signals.report.companyContact],
                    ['🧩', '상품페이지 구조', profileResult.signals.report.productPageStructure],
                    ['⚠️', '스크래핑 유의사항', profileResult.signals.report.scrapingNeeds],
                  ] as const).map(([icon, label, value]) => {
                    const notFound = !value || value === '확인 안됨'
                    return (
                      <div key={label} className="bg-gray-50 rounded-xl px-3 py-2.5 border border-gray-100">
                        <p className="text-[11px] font-semibold text-gray-500 tracking-wide mb-0.5">{icon} {label}</p>
                        <p className={`text-xs leading-relaxed ${notFound ? 'text-gray-400 italic' : 'text-gray-700'}`}>
                          {value || '확인 안됨'}
                        </p>
                      </div>
                    )
                  })}
                </div>
              ) : (
                <p className="text-xs text-amber-600">AI 리포트를 만들지 못했습니다 (ANTHROPIC_API_KEY 미설정·크레딧 부족 등 API 호출 실패이거나 홈/게시판 원문을 못 모았습니다 — 서버 콘솔 로그 확인) — 아래 참고정보만 확인됩니다.</p>
              )}
              <div className="flex flex-wrap gap-1.5 mt-3">
                <span className="text-[11px] bg-white border border-gray-200 text-gray-500 rounded-full px-2 py-0.5">플랫폼 {profileResult.signals.platform}</span>
                {profileResult.signals.optionUiTypes.length > 0 && (
                  <span className="text-[11px] bg-white border border-gray-200 text-gray-500 rounded-full px-2 py-0.5">
                    옵션 UI {profileResult.signals.optionUiTypes.join('/')}{profileResult.signals.hasCascadingOptions && ' (연쇄옵션)'}
                  </span>
                )}
                {/* AI 리포트의 "카테고리 구조"가 이미 이 목록을 정리해서 보여주므로, 리포트가 없을 때만
                    (위 "AI 리포트를 만들지 못했습니다 — 아래 참고정보만 확인됩니다"의 그 참고정보로) 원본
                    목록을 그대로 보여준다 — 둘 다 있으면 같은 내용이 중복 표시된다(사용자 보고로 발견). */}
                {!profileResult.signals.report && profileResult.signals.categoryMenuNames.length > 0 && (
                  <span className="text-[11px] bg-white border border-gray-200 text-gray-500 rounded-full px-2 py-0.5">
                    카테고리 메뉴 {profileResult.signals.categoryMenuNames.length}개: {profileResult.signals.categoryMenuNames.join(', ')}
                  </span>
                )}
              </div>
            </div>
          )}
          </>}
        </div>
      )}

      {/* 스크랩 대상 */}
      {selectedSite && mallMode === 'normal' && (
        <div className="bg-white rounded-2xl border border-gray-200 p-6 mb-4">
          <div className="flex items-center justify-between mb-2 gap-3">
            <div className="text-sm font-semibold text-gray-700">
              스크랩 대상
              {scrapeTargetCollapsed && (
                <span className="ml-2 font-normal text-gray-400">
                  {categoryUrlsText.trim() ? `— 카테고리 ${categoryUrlsText.trim().split('\n').filter(Boolean).length}개` : targetUrl ? `— ${targetUrl}` : '— 미지정'}
                </span>
              )}
            </div>
            <button onClick={() => setScrapeTargetCollapsed(v => !v)}
              className="px-3 py-1 bg-gray-100 hover:bg-gray-200 text-gray-600 text-xs font-semibold rounded-full transition-colors shrink-0">
              {scrapeTargetCollapsed ? '▼ 펼치기' : '▲ 접기'}
            </button>
          </div>
          {!scrapeTargetCollapsed && <>
          {/* 이 URL 자체를 그대로 스크랩할지, 이 URL에서 카테고리 여러 개를 찾아 그중 골라 스크랩할지는
              서로 대체 관계인 선택지다(하나를 채우면 다른 하나는 무시됨, 아래 경고문 참고) — 그래서
              입력칸부터 그 아래 버튼까지 통째로 좌우로 나란히 두고 가운데에 "또는"을 넣어, 위→아래로
              밟아야 하는 단계가 아니라 대등한 두 선택지로 보이게 한다. */}
          <p className="text-xs text-gray-400 mb-2">아래 둘 중 하나를 고르세요 — 이 URL 하나만 그대로 쓰거나, 카테고리를 자동으로 찾아 여러 개를 한 번에 지정할 수 있습니다.</p>
          <div className="flex flex-col sm:flex-row items-stretch gap-2 mb-2">
            <div className="flex-1 flex flex-col gap-1">
              <ScrapeStepBox
                description="💡 로그인 창에서 원하는 페이지로 이동했다면, 그 페이지를 현재 페이지 URL로 바로 가져와 그대로 스크랩할 수 있습니다."
                primary={{
                  label: '현재 페이지 가져오기', doneLabel: '현재 페이지 가져옴', icon: '↻',
                  loading: currentUrlLoading, loadingLabel: '가져오는 중...',
                  done: currentUrlFetched, colorDone: !!previewResult, disabled: loginStep === 'none',
                  onClick: handleRefreshCurrentUrl,
                }} />
              {/* '모든 카테고리 불러오기'와 같은 레벨로 항상 같은 틀(ScrapeStepBox)을 보여준다 — 로그인
                  확인 전에는 아직 열린 창이 없어 disabled로만 막아둔다("카테고리 불러오기"가
                  targetUrl 없을 때 disabled인 것과 같은 패턴). */}
              {/* 버튼으로 가져온(또는 직접 입력한) 실제 URL 값은 결과로서 버튼 아래에 보여준다. */}
              <label className="block">
                <span className="block text-xs text-gray-500 mb-1">현재 페이지 URL</span>
                <input value={targetUrl} onChange={e => { setTargetUrl(e.target.value); setCurrentUrlFetched(false) }}
                  placeholder="https://shop.example.com/products/123"
                  disabled={categoryUrlsText.trim().length > 0}
                  className="w-full border border-gray-300 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-400 disabled:bg-gray-100 disabled:text-gray-400" />
              </label>
              <p className="text-xs text-amber-600 min-h-[1em]">
                {categoryUrlsText.trim().length > 0 &&
                  '오른쪽 카테고리 URL 목록이 입력되어 있어 이 현재 페이지 URL은 무시되고 카테고리 목록만 스크랩됩니다.'}
              </p>
            </div>
            <div className="flex items-center justify-center text-xs text-gray-400 font-semibold px-1">또는</div>
            <div className="flex-1 flex flex-col gap-1">
              <ScrapeStepBox
                description="💡 몰에 있는 카테고리들을 자동으로 찾아옵니다 — 시작 URL을 하나하나 알아낼 필요 없이 원하는 카테고리를 바로 불러올 수 있습니다."
                primary={{
                  label: '모든 카테고리 불러오기', doneLabel: '카테고리 불러옴', icon: '↻',
                  loading: categoriesLoading, loadingLabel: '불러오는 중...',
                  done: categories.length > 0, colorDone: !!previewResult, disabled: categoriesLoading || !targetUrl,
                  onClick: () => handleLoadCategories(false),
                }}
                secondary={categories.length > 0 ? {
                  label: '↻ 다시 확인', title: '몰 메뉴가 바뀌었을 수 있으면 직접 다시 훑어서 최신 목록으로 갱신합니다',
                  disabled: categoriesLoading || !targetUrl, onClick: () => handleLoadCategories(true),
                } : undefined} />
              {/* 불러온(또는 직접 입력한) 카테고리 URL 목록도 마찬가지로 버튼 아래에 결과로 보여준다. */}
              <label htmlFor="category-urls" className="block">
                <span className="block text-xs text-gray-500 mb-1">선택 - 카테고리 URL 목록</span>
                <textarea id="category-urls" value={categoryUrlsText} onChange={e => setCategoryUrlsText(e.target.value)} rows={3}
                  placeholder={'https://shop.example.com/category/food\nhttps://shop.example.com/category/beauty'}
                  className="w-full border border-gray-300 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-400" />
              </label>
            </div>
          </div>

          {/* 카테고리 불러오기 결과(캐시 안내/감지된 플랫폼/체크리스트)는 위 선택 카드와 달리 폭이 넓게
              필요해 2단 배치 밖에, 전체 너비로 따로 보여준다. */}
          {(categoriesCached?.cached || detectedPlatform || categories.length > 0) && (
            <div className="bg-teal-50 border border-teal-100 rounded-xl px-4 py-2.5 mb-3">
              {/* "몰 구조 파악"이 이미 찾아둔 목록을 재사용했으면 즉시 뜨고 그 사실을 알려준다. */}
              {categoriesCached?.cached && (
                <p className="text-[11px] text-teal-600" title={categoriesCached.updatedAt ? new Date(categoriesCached.updatedAt).toLocaleString() : undefined}>
                  📋 저장된 몰 구조 기준으로 즉시 불러왔습니다 — 몰 메뉴가 바뀐 것 같으면 &quot;다시 확인&quot;을 눌러주세요.
                </p>
              )}

              {detectedPlatform && (
                <p className="text-xs text-teal-600 mt-1">
                  감지된 몰 유형: <span className="font-medium">{PLATFORM_LABELS[detectedPlatform] || detectedPlatform}</span>
                  {detectedPlatform !== 'unknown' && ' — 해당 플랫폼에 맞는 상품 링크/다음 페이지 방식이 자동으로 적용됩니다.'}
                </p>
              )}

              {categories.length > 0 && (
                <>
                  <p className="text-xs text-teal-700 mt-1">💡 아래에서 여러 카테고리를 체크하면, 체크한 카테고리들을 한 번에 스크랩 대상으로 지정할 수 있습니다.</p>
                  <div className="mt-1.5 border border-teal-200 bg-white rounded-xl overflow-hidden">
                    <div className="max-h-40 overflow-y-auto">
                      <table className="w-full text-xs border-collapse">
                        <thead>
                          {/* 전체선택 체크박스를 우측 텍스트 링크 대신 아래 행 체크박스와 같은 왼쪽 칸에
                              둔다 — 실제 <thead>/<tbody>로 같은 표에 넣어야 폭이 항상 정확히 맞는다. */}
                          <tr className="sticky top-0 z-[2] bg-teal-50 border-b border-teal-100">
                            <th className="px-3 py-1.5 w-6 sticky left-0 z-[1] bg-teal-50 font-normal text-left">
                              <input type="checkbox" title="전체 선택/해제 (몰 전체상품)"
                                checked={categories.every(c => isCategorySelected(c.href))}
                                ref={el => { if (el) el.indeterminate = categories.some(c => isCategorySelected(c.href)) && !categories.every(c => isCategorySelected(c.href)) }}
                                onChange={toggleAllCategories} />
                            </th>
                            <th colSpan={3} className="px-3 py-1.5 text-gray-500 font-normal text-left">
                              발견된 카테고리 {categories.length}개
                              {categories.some(c => isCategoryScraped(c.href)) &&
                                ` (완료 ${categories.filter(c => isCategoryScraped(c.href)).length}개)`} — 스크랩할 항목을 선택하세요
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {/* 실제 상품이 없는 항목(안내/문의 페이지 등)을 "제외"로 표시해두면 눈에 잘 안 띄게
                              맨 아래로 정리한다 — Array.sort는 안정 정렬이라 같은 그룹(제외/비제외) 안에서는
                              원래 발견 순서가 그대로 유지된다. */}
                          {[...categories].sort((a, b) => Number(isCategoryExcluded(a.href)) - Number(isCategoryExcluded(b.href))).map(c => (
                            <tr key={c.href} onClick={() => toggleCategory(c.href)}
                              className={`group border-b border-gray-100 last:border-0 hover:bg-gray-50 cursor-pointer ${isCategoryExcluded(c.href) ? 'opacity-50' : ''}`}>
                              <td className="px-3 py-1.5 w-6 sticky left-0 z-[1] bg-white group-hover:bg-gray-50">
                                <input type="checkbox" checked={isCategorySelected(c.href)} onChange={() => toggleCategory(c.href)} onClick={e => e.stopPropagation()} />
                              </td>
                              <td className="px-3 py-1.5 text-gray-700 whitespace-nowrap">
                                <span className={isCategoryExcluded(c.href) ? 'line-through' : ''}>{c.text}</span>
                                {isCategoryScraped(c.href) && (
                                  <span className="ml-1.5 text-[10px] font-semibold text-teal-600" title="이 카테고리는 이전에 스크래핑을 완료한 적이 있습니다">✓ 완료</span>
                                )}
                                {isCategoryExcluded(c.href) && (
                                  <span className="ml-1.5 text-[10px] font-semibold text-gray-400" title="상품 카테고리가 아닌 것으로 표시해뒀습니다">제외됨</span>
                                )}
                              </td>
                              <td className="px-3 py-1.5 text-gray-400 max-w-[320px] truncate" title={c.href}>{c.href}</td>
                              <td className="px-3 py-1.5 w-12 text-right sticky right-0 bg-white group-hover:bg-gray-50">
                                <button type="button" onClick={e => { e.stopPropagation(); toggleCategoryExcluded(c.href) }}
                                  title={isCategoryExcluded(c.href) ? '다시 카테고리로 복원합니다' : '상품이 없는 카테고리라 목록 아래로 정리합니다'}
                                  className="text-[10px] text-gray-400 hover:text-rose-500 hover:underline whitespace-nowrap">
                                  {isCategoryExcluded(c.href) ? '복원' : '제외'}
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </>
              )}
            </div>
          )}
          </>}
        </div>
      )}

      {/* 개발자모드 안내 — 일반모드의 "로그인 정보"/"스크랩 대상" 카드에 대응하는, 개발자모드가 실제로
          해야 하는 1단계(자기 브라우저를 직접 열고 로그인)다. 아래 "상품 페이지 미리보기"의 미리보기/피커
          버튼은 이 단계를 먼저 마쳐야 의미가 있어 작업 순서대로 이 카드를 위에 둔다 — 예전엔 이 안내가
          맨 아래 "스크래핑 Start" 버튼을 눌러야만 나타나서, 먼저 해야 할 일(브라우저 열기)이 나중에,
          나중에 눌러야 할 버튼(미리보기)이 먼저 보이는 순서로 헷갈렸다(사용자 피드백으로 재설계). */}
      {selectedSite && mallMode === 'devmode' && (
        <div className="bg-white rounded-2xl border border-gray-200 p-6 mb-4">
          <div className="flex items-start justify-between mb-3 pb-3 border-b border-gray-100 flex-wrap gap-3">
            <div className="flex items-center gap-2">
              <div className="text-sm font-semibold text-gray-700">🧩 개발자모드 스크랩 방법</div>
              <button onClick={() => setDevModeGuideCollapsed(v => !v)}
                className="px-3 py-1 bg-gray-100 hover:bg-gray-200 text-gray-600 text-xs font-semibold rounded-full transition-colors shrink-0">
                {devModeGuideCollapsed ? '▼ 펼치기' : '▲ 접기'}
              </button>
            </div>
            <div className="flex flex-col items-end gap-1.5">
              <button onClick={() => handleOpenMallUrlDirect(selectedSite.login_url || selectedSite.url)}
                className="px-4 py-2 bg-teal-500 hover:bg-teal-600 text-white text-sm font-semibold rounded-full transition-colors shrink-0">
                🌐 브라우저에서 바로 열기
              </button>
              {(loginId || loginPw) && (
                <div className="flex items-center gap-3 text-xs text-gray-500">
                  {loginId && (
                    <span>아이디: <b className="text-gray-700">{loginId}</b>{' '}
                      <button onClick={() => handleCopyCred('id', loginId)} className="text-teal-500 hover:underline">
                        {credCopied === 'id' ? '✓ 복사됨' : '복사'}
                      </button>
                    </span>
                  )}
                  {loginPw && (
                    <span>비밀번호: <b className="text-gray-700">{'•'.repeat(Math.min(loginPw.length, 10))}</b>{' '}
                      <button onClick={() => handleCopyCred('pw', loginPw)} className="text-teal-500 hover:underline">
                        {credCopied === 'pw' ? '✓ 복사됨' : '복사'}
                      </button>
                    </span>
                  )}
                </div>
              )}
            </div>
          </div>
          {!devModeGuideCollapsed && (
          <ol className="list-decimal list-inside text-sm text-gray-600 space-y-2.5">
            <li>
              <b className="text-gray-700">&quot;🌐 브라우저에서 바로 열기&quot;</b>로 {selectedSite.name || selectedSite.url}를 엽니다.
            </li>
            <li>
              위에 복사해둔 아이디/비밀번호를 <b className="text-gray-700">직접 입력</b>해 로그인합니다(자동입력은 안 됩니다 — 자동 로그인 감지 회피를 위해 방금 연 진짜 브라우저 창을 그대로 쓰기 때문입니다).
            </li>
            <li>
              로그인 후 상품이 나열된 <b className="text-gray-700">목록(카테고리) 페이지</b>를 엽니다.
            </li>
            <li>
              <b className="text-gray-700">방금 로그인한 그 브라우저 창</b>의 주소창 오른쪽 위를 보면 확장 프로그램 아이콘들이 있습니다 — 그중{' '}
              <b className="text-gray-700">&quot;PTP 개발자모드 몰 자동 스크랩&quot;</b> 아이콘을 클릭합니다. 안 보이면 퍼즐 조각(🧩) 모양의
              &quot;확장 프로그램&quot; 아이콘을 먼저 눌러 목록에서 찾으세요(자주 쓴다면 그 옆 핀 아이콘으로 고정해두면 편합니다). PTP 화면이 아니라{' '}
              <u>지금 로그인한 몰 탭 쪽</u>에서 열어야 합니다.
            </li>
            <li>
              열린 작은 팝업 창에서 원하는 버튼을 클릭합니다:
              <ul className="list-disc list-inside ml-4 mt-1 space-y-1 text-gray-500">
                <li>상품 1건만 먼저 확인 → <b className="text-gray-700">&quot;🔍 스크랩 미리보기 실행&quot;</b> (아래 PTP의 &quot;스크랩 미리보기&quot;는 안 눌러도 결과가 자동으로 반영됩니다 — 먼저 눌러두면 이전 결과를 지우고 대기 상태로 바꿔줄 뿐입니다.)</li>
                <li>특정 항목을 직접 클릭해서 컬럼을 지정 → 먼저 아래 PTP 화면에서 &quot;스크랩 대상 직접지정&quot;을 누른 뒤, 팝업에서 <b className="text-gray-700">&quot;🎯 스크랩 대상 직접지정&quot;</b></li>
                <li>확인 없이 바로 전체 스크랩 → <b className="text-gray-700">&quot;🔄 스크랩 시작&quot;</b></li>
              </ul>
              {/* unoptimized — 이 dev 환경의 Next 이미지 최적화가 PNG를 처리 못해(실측: 새로 만든 PNG도
                  전부 400, JPG는 정상) /_next/image 경유 없이 public 정적 파일을 그대로 서빙한다. */}
              <div className="mt-2 inline-block border border-gray-200 rounded-lg overflow-hidden">
                <Image src="/devmode-extension-popup.png" alt="실제 확장 프로그램 팝업 화면 — 스크랩 미리보기 실행/스크랩 시작/스크랩 대상 직접지정 버튼"
                  width={377} height={307} unoptimized className="block" />
              </div>
            </li>
            <li>
              진행 상황은 아래에 자동으로 나타나며, 완료되면 &quot;스크랩 Raw 확인&quot;으로 바로 이동할 수 있습니다.
            </li>
          </ol>
          )}
        </div>
      )}

      {/* 상품 페이지 미리보기 — 일반모드/개발자모드 공용 카드(2026-07-27 통합). 개발자모드는 PTP가 그 몰
          탭에 직접 접근할 수 없어(chrome.debugger 확장 전용 구조) 버튼을 눌러도 즉시 결과가 나오지 않고,
          사용자가 몰 탭에서 확장(팝업 또는 우클릭)을 실행해야 채워진다 — 그 차이만 빼면 이 카드를 그대로
          공유해 두 모드를 한 곳에서 관리한다. */}
      {selectedSite && (mallMode === 'normal' || mallMode === 'devmode') && (
        <div className="bg-white rounded-2xl border border-gray-200 p-6 mb-4">
          <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
            <label className="block text-sm font-semibold text-gray-700">상품 페이지 미리보기</label>
            <div className="flex items-center gap-2 shrink-0">
              {/* 미리보기(카테고리별 개수 집계)와 아래 "스크래핑 시작" 둘 다 이 값을 그대로 쓴다(handlePreview/
                  handleStart) — 여기 한 곳에서만 조절하면 된다. 열린 탭 수가 메모리 사용량에 직결되므로
                  (각 탭이 이미지까지 로드) 메모리가 부족하면 수동으로 낮춰본다. */}
              <div className="flex items-center gap-1 shrink-0"
                title="카테고리/상품 페이지를 동시에 몇 개까지 열지 정합니다. 자동은 몰 반응을 보며 스스로 조절하고(스크래핑 시작 시 1~8, 미리보기는 4), 수동은 지정한 개수로 항상 고정합니다 — 메모리가 부족하면 수동으로 1~2개까지 낮춰보세요.">
                {/* 보조 기능(켜짐/꺼짐) 토글은 옆의 주 액션 버튼(rounded-full 알약 모양)과 모양부터 다르게
                    — rounded-md의 각진 "체크박스형 스위치"로 둬서 누르면 바로 실행되는 버튼이 아니라는 걸
                    형태만으로도 구분되게 한다. */}
                <button type="button" onClick={() => setConcurrencyMode(m => m === 'manual' ? 'auto' : 'manual')}
                  aria-pressed={concurrencyMode === 'manual'}
                  className={`px-3 py-1 rounded-md text-sm font-medium border transition-colors ${concurrencyMode === 'manual' ? 'bg-amber-100 text-amber-700 border-amber-300' : 'bg-white text-gray-500 border-gray-300 hover:border-amber-300'}`}>
                  {concurrencyMode === 'manual' ? '☑ 동시 처리 수동' : '☐ 동시 처리 자동'}
                </button>
                {concurrencyMode === 'manual' && (
                  <input type="number" min={1} max={8} value={concurrency}
                    onChange={e => setConcurrency(Math.max(1, Math.min(8, Number(e.target.value) || 1)))}
                    className="w-14 px-2 py-1 border border-gray-300 rounded-lg text-sm text-center" />
                )}
              </div>
              <button type="button"
                onClick={() => {
                  const next = !aiMode
                  setAiMode(next)
                  if (mallMode === 'devmode' && selectedSite) {
                    fetch(`/api/sites/${selectedSite.id}`, {
                      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ devmodeAiPreview: next }),
                    })
                  }
                }}
                aria-pressed={aiMode}
                title="켜두면 미리보기 시점에 AI가 이 몰의 상품 페이지 구조를 분석해 컬럼별 추출 규칙을 자동으로 만들어 저장합니다. 미리보기로 결과를 확인하고, 부족한 부분은 '스크랩 대상 직접지정'으로 보완하세요."
                className={`px-3 py-1 rounded-md text-sm font-medium border transition-colors ${aiMode ? 'bg-violet-100 text-violet-700 border-violet-300' : 'bg-white text-gray-500 border-gray-300 hover:border-violet-300'}`}>
                {aiMode ? '☑ 🪄 AI모드 켜짐' : '☐ AI모드 꺼짐'}
              </button>
              <button type="button" onClick={mallMode === 'devmode' ? handleDevPreview : handlePreview}
                disabled={previewLoading || (mallMode === 'normal' && !canPreview)}
                className={`px-4 py-2 text-sm font-semibold rounded-full disabled:opacity-50 disabled:cursor-not-allowed transition-colors ${
                  previewResult
                    ? 'bg-white border-2 border-teal-500 text-teal-600 hover:bg-teal-50'
                    : 'bg-teal-500 hover:bg-teal-600 text-white'}`}>
                {previewLoading
                  ? (mallMode === 'devmode' ? '대기 중...' : previewProgress ? `카테고리 확인 중... (${previewProgress.done}/${previewProgress.total})` : aiMode ? 'AI 분석 중...' : '확인 중...')
                  : previewResult ? '✓ 스크랩 미리보기' : '🔍 스크랩 미리보기'}
              </button>
              {/* 개발자모드는 서버가 아니라 사용자 브라우저의 확장이 도는 것이라 이 fetch로 중지시킬
                  작업이 없다(위 devPreviewTimeoutRef의 2분 자동 해제만 있음) — 일반모드 전용. 진행
                  중이라는 걸 알 수 있게 서버가 세는 카테고리 개수 기준 진행률도 폴링해서 같이 보여준다
                  (끝없이 도는 것처럼 보인다는 피드백 — lib/scraper.ts의 getPreviewProgress 참고). */}
              {mallMode === 'normal' && previewLoading && (
                <button type="button" onClick={handleStopPreview}
                  className="px-4 py-2 bg-rose-50 border border-rose-300 text-rose-600 hover:bg-rose-100 text-sm font-semibold rounded-full transition-colors">
                  ⏹ 중지
                </button>
              )}
              {(mallMode === 'devmode' || loginStep === 'confirmed') && (
                mallMode === 'devmode' ? (
                  pickerActive ? (
                    <button onClick={() => setPickerActive(false)} disabled={pickerBusy}
                      className="px-4 py-2 bg-rose-50 border border-rose-300 text-rose-600 hover:bg-rose-100 text-sm font-semibold rounded-full disabled:opacity-50 transition-colors">
                      🎯 스크랩 대상 직접지정 종료
                    </button>
                  ) : (
                    <button onClick={() => setPickerActive(true)} disabled={pickerBusy}
                      className="px-4 py-2 bg-white border border-gray-300 text-gray-600 hover:bg-gray-50 text-sm font-semibold rounded-full disabled:opacity-50 transition-colors">
                      🎯 스크랩 대상 직접지정
                    </button>
                  )
                ) : (
                  // 창을 닫으면(패널의 ✕) 다시 저절로 뜨지 않는다 — 다시 지정하려면 이 버튼을 다시 눌러야
                  // 한다(자동 재주입을 없앤 것과 맞물린 설계, lib/scraper.ts 참고). 그래서 "종료" 버튼이
                  // 따로 없고, 이 버튼 하나로 몇 번이든 다시 열 수 있다.
                  <button onClick={handleStartPicker} disabled={pickerBusy}
                    className="px-4 py-2 bg-white border border-gray-300 text-gray-600 hover:bg-gray-50 text-sm font-semibold rounded-full disabled:opacity-50 transition-colors">
                    🎯 스크랩 대상 직접지정
                  </button>
                )
              )}
              {/* 위 버튼들(AI모드/미리보기/직접지정)은 항상 눌러야 하니 그대로 두고, 아래 결과 내용만
                  접는다 — Mall 선택 등과 달리 이 카드는 "실행"과 "결과 보기"가 한 카드에 같이 있다. */}
              <button onClick={() => setPreviewCardCollapsed(v => !v)}
                className="px-3 py-1 bg-gray-100 hover:bg-gray-200 text-gray-600 text-xs font-semibold rounded-full transition-colors shrink-0">
                {previewCardCollapsed ? '▼ 펼치기' : '▲ 접기'}
              </button>
            </div>
          </div>

          {previewResumeNotice && (
            <p className="text-xs text-amber-600 bg-amber-50 rounded-lg px-3 py-2 mb-3">⚠ {previewResumeNotice}</p>
          )}

          {!previewCardCollapsed && <>
          {mallMode === 'devmode' && (
            <p className="text-xs text-amber-600 bg-amber-50 rounded-lg px-3 py-2 mb-3">
              ⚠ 개발자모드에서는 이 버튼들이 결과를 바로 가져오지 않습니다 — 아래 버튼은 준비만 하고,{' '}
              실제 실행은 &quot;브라우저에서 바로 열기&quot;로 연 몰 탭의 확장 프로그램에서 해야 합니다(위 &quot;🧩 개발자모드
              스크랩 방법&quot; 참고).
            </p>
          )}

          {sessionExpiredWarning && (
            <p className="text-xs text-amber-600 bg-amber-50 rounded-lg px-3 py-2 mb-3">
              ⚠ 로그인 세션이 끊긴 상태로 미리보기가 된 것 같습니다 — 로그인 창을 다시 열었으니, 그 창에서
              로그인 후 &quot;로그인 확인&quot;을 누르고 미리보기를 다시 시도해주세요.
            </p>
          )}

          {mallMode === 'devmode' && previewLoading && (
            <p className="text-xs text-teal-700 bg-teal-50 rounded-lg px-3 py-2 mb-3">
              🔍 &quot;브라우저에서 바로 열기&quot;로 연 몰 탭의 상품 상세 페이지에서 확장 아이콘(팝업의 &quot;🔍 스크랩 미리보기 실행&quot;)
              또는 우클릭 메뉴를 눌러주세요. 실행하면 몇 초 안에 아래에 결과가 나타납니다.
            </p>
          )}

          {pickerActive && (
            <p className="text-xs text-teal-700 bg-teal-50 rounded-lg px-3 py-2 mb-3">
              {mallMode === 'devmode'
                ? <>🎯 &quot;브라우저에서 바로 열기&quot;로 연 몰 탭에서 확장 아이콘(팝업의 &quot;🎯 스크랩 대상 직접지정&quot; 또는
                    우클릭 &quot;PTP 스크랩 대상 직접지정&quot;)을 눌러 그 탭에 뜨는 패널에서 값을 클릭해 지정하세요.</>
                : <>🎯 로그인 창에 뜬 &quot;PTP 스크랩 대상 직접지정&quot; 패널에서 값을 클릭하거나, 패널의 목록에서
                    바로 값을 입력해 지정하세요.</>}
              {Object.keys(pickerRules).length > 0 && ` — 지금까지 ${Object.keys(pickerRules).length}개 지정됨`}.
              다 되면 (몰 탭에 뜬) 패널의 ✕로 닫으면 되고, 지정한 값은 그대로 저장됩니다. 다시 열려면 위
              &quot;스크랩 대상 직접지정&quot; 버튼을 다시 누르세요.
            </p>
          )}

          {mallMode === 'normal' && !canPreview && (
            <p className="text-xs text-gray-400">시작 URL 또는 카테고리 목록을 입력하면 카테고리 내 상품 개수와 첫 상품 페이지를 바로 확인할 수 있습니다.</p>
          )}

          {previewTotal !== null && (
            <p className="text-xs text-gray-600 mb-2">
              스크랩 대상 상품 <strong>{previewTotal}</strong>개 발견
              {detectedPlatform && ` — 감지된 몰 유형: ${PLATFORM_LABELS[detectedPlatform] || detectedPlatform}`}
              {previewTotal === 0 && <span className="text-rose-500"> (매칭되는 상품 링크가 없습니다. 셀렉터나 시작 URL을 확인해주세요.)</span>}
            </p>
          )}

          {previewResult && (
            <div className="mt-2 border border-gray-200 rounded-xl overflow-hidden">
              {mallMode === 'normal' && (
                <div className="px-3 py-2 bg-gray-50 border-b border-gray-100 text-xs text-gray-500 flex items-center justify-between gap-2">
                  <span className="truncate" title={previewResult.sourceUrl}>{decodeUrlForDisplay(previewResult.sourceUrl)}</span>
                  <div className="flex items-center gap-3 shrink-0">
                    <button type="button" onClick={() => handleOpenItem(previewResult.sourceUrl)} className="text-teal-500 hover:underline">
                      열기 ↗
                    </button>
                  </div>
                </div>
              )}
              <div className="p-3 flex gap-3 border-b border-gray-100">
                {previewResult.product.thumbnail_urls.length > 0 && (
                  <div className="flex gap-1 shrink-0 max-w-[280px] overflow-x-auto">
                    {previewResult.product.thumbnail_urls.map((src, i) => (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img key={i} src={src} alt="" className="w-20 h-20 object-cover rounded-xl border border-gray-100" />
                    ))}
                  </div>
                )}
                <div className="flex-1 min-w-0 text-xs space-y-1">
                  <div className="font-semibold text-gray-800 text-sm truncate">
                    {previewResult.product.name || <span className="text-rose-500">상품명을 찾지 못했습니다</span>}
                  </div>
                  {previewResult.product.description && (
                    <div className="text-gray-400 line-clamp-2">{previewResult.product.description}</div>
                  )}
                </div>
              </div>
              <div className="overflow-x-auto">
                <table className="text-xs border-collapse whitespace-nowrap">
                  {(() => {
                    // 옵션1~3은 기준 테이블 컬럼으로 이미 다뤄지니(위 masterOrderedKeys), 그 뒤에 남는
                    // 옵션(4번째부터)만 별도 컬럼으로 덧붙인다.
                    const extraOptions = previewResult.product.options.slice(3)
                    const registeredLabelSet = new Set(masterOrderedKeys.map(k => registryLabels.get(k)).filter(Boolean))
                    const extraCustom = Object.entries(previewResult.product.custom_fields || {})
                      .filter(([label]) => label in pickerRules && !masterOrderedKeys.includes(label) && !registeredLabelSet.has(label))
                    return (
                      <>
                        <thead className="bg-gray-50">
                          <tr className="border-b border-gray-200 text-gray-500 font-semibold">
                            {masterOrderedKeys.map((key, i) => (
                              <th key={key} className={`px-3 py-2 text-left ${i === 0 ? 'sticky left-0 z-10 bg-gray-50' : ''}`}>
                                {registryLabels.get(key) || fixedFieldLabel.get(key) || key}
                              </th>
                            ))}
                            {extraOptions.map((o, i) => <th key={`opt-${i}`} className="px-3 py-2 text-left">{o.name}</th>)}
                            <th className="px-3 py-2 text-left">상품요약정보</th>
                            <th className="px-3 py-2 text-left">영문상품명</th>
                            {extraCustom.map(([label]) => <th key={label} className="px-3 py-2 text-left">🎯 {label}</th>)}
                          </tr>
                        </thead>
                        <tbody>
                          <tr>
                            {masterOrderedKeys.map((key, i) => {
                              const value = previewValueFor(previewResult.product, previewResult.sourceUrl, key, registryLabels)
                              return (
                                <td key={key}
                                  className={`px-3 py-2 text-gray-700 max-w-[200px] truncate ${i === 0 ? 'sticky left-0 z-[1] bg-white' : ''}`}
                                  title={value}>
                                  {value}
                                </td>
                              )
                            })}
                            {extraOptions.map((o, i) => (
                              <td key={`opt-${i}`} className="px-3 py-2 text-gray-700 max-w-[240px] truncate" title={o.values.join(', ')}>
                                {o.values.join(', ')}
                              </td>
                            ))}
                            <td className="px-3 py-2 text-gray-700 max-w-[200px] truncate" title={previewResult.product.summary_info}>
                              {previewResult.product.summary_info || '-'}
                            </td>
                            <td className="px-3 py-2 text-gray-700 max-w-[160px] truncate" title={previewResult.product.english_name}>
                              {previewResult.product.english_name || '-'}
                            </td>
                            {extraCustom.map(([label, value]) => (
                              <td key={label} className="px-3 py-2 text-gray-700 max-w-[240px] truncate" title={value}>
                                {value}
                              </td>
                            ))}
                          </tr>
                        </tbody>
                      </>
                    )
                  })()}
                </table>
              </div>
              {previewResult.product.detail_text && (
                <div className="px-3 py-2 border-t border-gray-100 text-xs text-gray-500">
                  <span className="text-gray-400">상세페이지 텍스트: </span>
                  <span className="line-clamp-3">{previewResult.product.detail_text}</span>
                </div>
              )}
              {(() => {
                // 위 컬럼(기준 마스터테이블 순서로 이미 보여준 것들)에 이미 나온 라벨은 여기서 또
                // 보여주지 않는다 — 라벨 문구가 완전히 같은 경우(카테고리/상품명 등)뿐 아니라, 몰 페이지
                // 원문 라벨이 컬럼 라벨과 다르게 적혀 있어도(예: "판매가" vs "규제판가") 같은 개념이면
                // CLAIMED_INFO_LABEL_RE로 함께 걸러낸다.
                const shownColumnLabels = new Set([
                  ...masterOrderedKeys.map(k => registryLabels.get(k) ?? fixedFieldLabel.get(k)).filter(Boolean),
                  '상품요약정보', '영문상품명',
                ])
                const remainingInfo = previewResult.product.extra_info
                  .filter(({ label }) => !shownColumnLabels.has(label) && !CLAIMED_INFO_LABEL_RE.test(label))
                return remainingInfo.length > 0 && (
                  <div className="px-3 py-2 border-t border-gray-100 text-xs text-gray-500">
                    <span className="text-gray-400">상품정보고시 전체: </span>
                    {remainingInfo.map(({ label, value }) => `${label}: ${value}`).join(' / ')}
                  </div>
                )
              })()}
              {(() => {
                // "상품정보고시 전체"가 이미 모든 라벨:값을 보여주므로, 거기 없는 라벨만 여기 추가로 보여준다
                // (안 그러면 커스텀 필드로 자동 저장된 값이 위 전체 목록과 그대로 겹쳐 중복 표시됐다).
                const extraInfoLabels = new Set(previewResult.product.extra_info.map(e => e.label))
                const otherCustom = Object.entries(previewResult.product.custom_fields || {})
                  .filter(([label]) => !(label in pickerRules) && !extraInfoLabels.has(label))
                return otherCustom.length > 0 && (
                  <div className="px-3 py-2 border-t border-gray-100 text-xs text-gray-500">
                    <span className="text-gray-400">그 외 자동 스캔된 정보: </span>
                    {otherCustom.map(([label, value]) => `${label}: ${value}`).join(' / ')}
                  </div>
                )
              })()}
            </div>
          )}

          {previewItems.length > 0 && (
            <div className="mt-2 border border-gray-200 rounded-xl overflow-hidden">
              <div className="px-3 py-2 bg-gray-50 border-b border-gray-100 text-xs text-gray-500">
                나머지 {previewItems.length}개 (목록 페이지 기준 정보만 — 직접 열어보지 않아 빠릅니다)
              </div>
              {/* 아래 내용(상세 정보 등)이 더 잘 보이도록 목록은 2개 높이만 보여주고 나머지는 스크롤 처리 */}
              <div className="max-h-[124px] overflow-y-auto">
                <table className="w-full text-xs border-collapse">
                  <thead className="sticky top-0 z-10 bg-gray-50">
                    <tr className="border-b border-gray-200 text-gray-500 font-semibold">
                      <th className="px-2 py-2 text-left w-14 sticky left-0 z-20 bg-gray-50">이미지</th>
                      <th className="px-2 py-2 text-left">상품명</th>
                      <th className="px-2 py-2 text-left w-20">링크</th>
                    </tr>
                  </thead>
                  <tbody>
                    {previewItems.map(item => (
                      <tr key={item.url} className="group border-b border-gray-100 last:border-0 hover:bg-gray-50">
                        <td className="px-2 py-1.5 sticky left-0 z-10 bg-white group-hover:bg-gray-50">
                          <div className="w-10 h-10 rounded-lg overflow-hidden bg-gray-100">
                            {item.thumbnail ? (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img src={item.thumbnail} alt="" className="w-full h-full object-cover" />
                            ) : (
                              <div className="w-full h-full flex items-center justify-center text-gray-300">-</div>
                            )}
                          </div>
                        </td>
                        <td className="px-2 py-1.5 text-gray-700 truncate max-w-[320px]" title={item.name}>{item.name || '-'}</td>
                        <td className="px-2 py-1.5">
                          <button type="button" onClick={() => handleOpenItem(item.url)} className="text-teal-500 hover:underline">열기 ↗</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* 일반모드 카탈로그 미리보기 전용 — 상품 1건만 위에서 상세 확인하고, 나머지는 이름/썸네일
              없이 카테고리별 "개수"만 보여준다(어차피 "스크래핑 시작"이 전체를 다시 훑으므로 미리보기는
              개수 확인만 하면 된다는 판단). */}
          {categoryCounts.length > 0 && (
            <div className="mt-2 border border-gray-200 rounded-xl overflow-hidden">
              <div className="px-3 py-2 bg-gray-50 border-b border-gray-100 text-xs text-gray-500">
                카테고리별 상품 개수 (목록 페이지 기준 — 상세페이지는 열어보지 않아 빠릅니다)
              </div>
              <div className="max-h-[124px] overflow-y-auto">
                <table className="w-full text-xs border-collapse">
                  <thead className="sticky top-0 z-10 bg-gray-50">
                    <tr className="border-b border-gray-200 text-gray-500 font-semibold">
                      <th className="px-3 py-2 text-left">카테고리</th>
                      <th className="px-3 py-2 text-right w-20">개수</th>
                    </tr>
                  </thead>
                  <tbody>
                    {categoryCounts.map(c => (
                      <tr key={c.url} className="border-b border-gray-100 last:border-0 hover:bg-gray-50">
                        <td className="px-3 py-1.5 text-gray-700 truncate max-w-[320px]" title={c.url}>{c.label}</td>
                        <td className="px-3 py-1.5 text-right text-gray-700">{c.count.toLocaleString()}개</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
          </>}
        </div>
      )}

      {/* 실행 버튼 — 개발자모드는 위 안내대로 사용자가 직접 브라우저/확장으로 시작하므로 "시작" 버튼이
          없고, 진행 중일 때 "중지"만 제공한다(일반모드와 동일한 버튼을 공유). */}
      {selectedSite && status === 'running' ? (
        <button onClick={handleStop} disabled={stopping}
          className="w-full py-3 rounded-2xl bg-rose-500 text-white font-semibold text-sm hover:bg-rose-600 disabled:opacity-50 transition-colors">
          {stopping ? '중지 처리 중...' : '⏸ 스크래핑 중지'}
        </button>
      ) : mallMode === 'normal' ? (
        <>
          {/* canStart가 false인 이유(로그인 미확인)를 버튼 비활성화만으로 두면 "눌러도 반응이 없다"로만
              보인다 — 특히 loginStep은 이 컴포넌트가 새로 마운트될 때마다(탭 전환, 서버 재시작 등)
              초기화되는 로컬 상태라, 이전에 실제로 로그인해뒀어도 다시 확인 없이는 버튼이 계속 막혀있다.
              카테고리/미리보기까지는 로그인 없이도 동작해(withContext가 필요하면 알아서 헤드리스로 새
              세션을 연다) 여기까지 온 뒤에야 막히는 경우가 흔해, 버튼 바로 위에 이유를 명시한다. */}
          {!canStart && needsLogin && (
            <p className="text-xs text-amber-600 text-center mb-2">
              ⚠ 로그인 확인이 필요합니다 — 위 &quot;로그인 창 열기&quot; → &quot;로그인 확인&quot;을 먼저 진행해주세요.
            </p>
          )}
          <button onClick={handleStart} disabled={!canStart}
            title={!canStart && needsLogin ? '로그인 확인이 필요합니다' : undefined}
            className={`w-full py-3 rounded-2xl font-semibold text-sm disabled:opacity-50 disabled:cursor-not-allowed transition-colors ${
              status === 'done'
                ? 'bg-white border-2 border-teal-500 text-teal-600 hover:bg-teal-50'
                : 'bg-teal-500 text-white hover:bg-teal-600'}`}>
            {status === 'stopped' || status === 'error' ? '이어서 스크랩하기 (기존 상품 제외)' : status === 'done' ? '✓ 스크래핑 완료 (다시 시작)' : '스크래핑 시작'}
          </button>
        </>
      ) : null}

      {/* 진행 상황 */}
      {status !== 'idle' && (
        <div ref={progressSectionRef} className="mt-4 bg-white rounded-2xl border border-gray-200 p-5">
          <div className="flex items-center justify-between mb-3">
            <span className="text-sm font-semibold text-gray-700">진행 상황</span>
            <div className="flex items-center gap-3">
              <span className={`text-sm font-semibold ${statusColor[status]}`}>{statusLabel[status]}</span>
              {status === 'done' && (
                <button onClick={() => openTab(PRODUCTS_LIST_TAB)}
                  className="px-4 py-1.5 bg-teal-500 hover:bg-teal-600 text-white text-xs font-semibold rounded-full transition-colors">
                  → 스크랩 Raw 확인
                </button>
              )}
            </div>
          </div>
          {status === 'running' && (
            <div className="w-full bg-gray-100 rounded-full h-2 mb-3">
              <div className="bg-teal-500 h-2 rounded-full transition-all"
                style={{ width: progress.total > 0 ? `${Math.round(progress.saved / progress.total * 100)}%` : '10%' }} />
            </div>
          )}
          <p className="text-sm text-gray-600">
            수집 완료: <strong>{progress.saved}</strong>개 {progress.total > 0 && `/ ${progress.total}개`}
            {progress.failedCount > 0 && <span className="text-rose-500"> · 실패 {progress.failedCount}개</span>}
          </p>

          {/* 적응형 동시성이 실제로 조정된 적이 있을 때만 보여준다 — 계속 1로 순차 처리됐다면(가장 흔한 경우)
              보여줄 내용이 없어 아예 렌더링하지 않는다("간략히" 확인 목적이라 평소엔 화면을 차지하지 않음). */}
          {concurrencyLog.length > 0 && (
            <div className="mt-2 text-xs text-gray-500">
              <button type="button" onClick={() => setConcurrencyLogOpen(v => !v)} className="hover:underline">
                ⚡ 동시 처리 최고 {Math.max(1, ...concurrencyLog.filter(e => e.reason === 'ramp_up').map(e => e.level))}개까지 사용
                {concurrencyLog.some(e => e.reason === 'block_detected') &&
                  ` · 차단 감지로 ${concurrencyLog.filter(e => e.reason === 'block_detected').length}회 낮춤`}
                {' '}{concurrencyLogOpen ? '▲' : '▼'}
              </button>
              {concurrencyLogOpen && (
                <ul className="mt-1 pl-4 space-y-0.5 max-h-32 overflow-y-auto">
                  {concurrencyLog.map((e, i) => (
                    <li key={i} className={e.reason === 'block_detected' ? 'text-amber-600' : 'text-gray-400'}>
                      {new Date(e.at).toLocaleTimeString()} — {e.reason === 'block_detected' ? `차단 감지 → 1개로 낮춤` : `${e.level}개로 상향`}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {/* 실패한 상품만 따로 모아, 실패 사유가 (마우스를 올려야 보이는 툴팁이 아니라) 바로 눈에 보이게 표시한다.
              개수(progress.failedCount)는 /api/scrape/status의 정확한 COUNT — 목록(failedItems)은
              /api/scrape/log가 최대 200건까지만 돌려주므로(성능), 총량이 그보다 많으면 개수만 맞고 목록은
              일부만 보일 수 있다(실패 건은 그 200건 안에 항상 먼저 채워지도록 이미 우선순위를 둠). */}
          {progress.failedCount > 0 && (
            <div className="mt-3 border border-rose-200 bg-rose-50 rounded-xl overflow-hidden">
              <div className="px-3 py-2 text-xs font-semibold text-rose-600 border-b border-rose-200">
                ❌ 수집 실패 ({progress.failedCount}개) — 사유
              </div>
              <div className="max-h-40 overflow-y-auto divide-y divide-rose-100">
                {failedItems.map(row => (
                  <div key={row.id} className="px-3 py-1.5 text-xs">
                    <p className="text-gray-600 truncate">{row.url}</p>
                    <p className="text-rose-500 truncate">{row.error || '알 수 없는 오류'}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {progress.successCount > 0 && (
            <div className="mt-3 border border-gray-100 rounded-xl overflow-hidden">
              <div className="px-3 py-2 text-xs font-semibold text-gray-500 border-b border-gray-100">
                ✓ 수집 성공 ({progress.successCount}개{progress.successCount > successItems.length && `, 최근 ${successItems.length}건 표시`})
              </div>
              <div className="max-h-40 overflow-y-auto divide-y divide-gray-100">
                {successItems.map(row => (
                  <div key={row.id} className="flex items-center gap-2 px-3 py-1.5 text-xs">
                    <span className="text-emerald-600">✓</span>
                    <span className="text-gray-500 truncate flex-1">{row.url}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {(status === 'error' || status === 'stopped') && (
            <>
              {progress.error && <p className="mt-2 text-xs text-rose-500 break-all">{progress.error}</p>}
              <button onClick={handleBackToSettings}
                className="mt-3 px-4 py-2 bg-gray-100 hover:bg-gray-200 text-gray-600 text-sm font-semibold rounded-full transition-colors">
                ← 설정 화면으로 돌아가기
              </button>
            </>
          )}
          {status === 'done' && failedUrls.length > 0 && (
            <div className="mt-3">
              <button onClick={handleRetryFailed} disabled={retrying}
                className="px-3 py-1.5 bg-gray-100 hover:bg-gray-200 text-gray-600 text-xs font-semibold rounded-full disabled:opacity-50 transition-colors">
                {retrying ? '재시도 중...' : `실패 ${failedUrls.length}개 재시도`}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
