'use client'
import { useState, useEffect, useRef, useMemo } from 'react'
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

export function ScraperPanel({ params }: { params?: Record<string, unknown> }) {
  const { openTab, bumpRefresh } = useTabs()
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

  const [categories, setCategories]         = useState<{ href: string; text: string }[]>([])
  const [categoriesLoading, setCategoriesLoading] = useState(false)
  const [detectedPlatform, setDetectedPlatform] = useState<string | null>(null)

  const [previewResult, setPreviewResult]   = useState<{ sourceUrl: string; product: PreviewProduct } | null>(null)
  // 미리보기 결과가 로그인 세션이 끊긴 상태로 얻어진 것 같을 때(창을 닫은 뒤 세션 만료 등) — 자동으로
  // 로그인 창을 다시 띄우고 이 배너로 재확인을 안내한다.
  const [sessionExpiredWarning, setSessionExpiredWarning] = useState(false)
  const [previewTotal, setPreviewTotal]     = useState<number | null>(null)
  const [previewItems, setPreviewItems]     = useState<PreviewItem[]>([])
  const [previewLoading, setPreviewLoading] = useState(false)

  // 개발자모드 "상품 페이지 미리보기"/"스크랩 대상 직접지정" — 일반모드와 같은 카드/상태(previewResult 등)를
  // 그대로 쓰지만, PTP가 그 몰 탭에 직접 접근할 방법이 없어(chrome.debugger 확장 전용 구조) 실제 캡처는
  // 사용자가 몰 탭에서 확장(팝업 또는 우클릭)을 실행해야 일어난다 — 그래서 즉시 fetch 대신 "이전 결과를
  // 비우고 폴링으로 기다리는" 방식을 쓴다.
  const devPreviewPollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const devPreviewTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [devAdjustNewField, setDevAdjustNewField] = useState('')
  const [devAdjustPrompt, setDevAdjustPrompt] = useState('')
  const [devAdjustBusy, setDevAdjustBusy] = useState(false)
  const [devAdjustMessage, setDevAdjustMessage] = useState('')

  const progressSectionRef = useRef<HTMLDivElement>(null)

  const [aiMode, setAiMode]       = useState(true)
  const [status, setStatus]       = useState<Status>('idle')
  const [sessionId, setSessionId] = useState<number | null>(null)
  const [progress, setProgress]   = useState<{ saved: number; total: number; error?: string }>({ saved: 0, total: 0 })
  const [stopping, setStopping]   = useState(false)
  const [itemLog, setItemLog]     = useState<ItemLogRow[]>([])
  const [retrying, setRetrying]   = useState(false)
  const [modeSaving, setModeSaving] = useState(false)
  // 개발자모드는 실제 스크랩이 PTP가 아니라 사용자의 브라우저(확장)에서 일어나 "시작" 버튼이 원래 없었지만,
  // 일반모드와 똑같이 몰을 고른 뒤 명시적으로 "스크래핑 개시"를 눌러야 방법 안내가 뜨도록 통일한다 —
  // 몰만 골랐는데 안내가 바로 튀어나오면 "시작"이라는 행동 없이 화면이 저절로 바뀌어 헷갈릴 수 있다.
  const [devModeStarted, setDevModeStarted] = useState(false)
  const [credCopied, setCredCopied] = useState<'id' | 'pw' | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    fetch('/api/sites').then(r => r.json()).then((d: Site[]) => { if (Array.isArray(d)) setSites(d) }).catch(() => {})
    fetch('/api/clients').then(r => r.json()).then((d: Client[]) => { if (Array.isArray(d)) setClients(d) }).catch(() => {})
  }, [])

  useEffect(() => {
    // Mall 목록/거래처 목록에서 특정 몰(또는 거래처)을 지정해 들어온 경우, 그 선택이 우선이므로 이전 세션 복원은 건너뛴다.
    if (initialSiteId) { selectSite(initialSiteId); return }
    if (initialClientId) return
    const raw = localStorage.getItem(LAST_SESSION_KEY)
    if (raw) {
      try {
        const saved = JSON.parse(raw) as { site: Site; sessionId: number }
        fetch(`/api/scrape/status?sessionId=${saved.sessionId}`).then(r => r.json()).then((d: { status: string; product_count: number; saved_count: number; error?: string }) => {
          setSelectedSite(saved.site)
          setSessionId(saved.sessionId)
          setStatus(d.status as Status)
          setProgress({ saved: Number(d.saved_count) || 0, total: Number(d.product_count) || 0, error: d.error })
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
    const formRaw = localStorage.getItem(FORM_STATE_KEY)
    if (!formRaw) return
    try {
      const saved = JSON.parse(formRaw) as {
        siteId: number; targetUrl: string; categoryUrlsText: string
        previewResult?: { sourceUrl: string; product: PreviewProduct } | null
        previewTotal?: number | null
        previewItems?: PreviewItem[]
        detectedPlatform?: string | null
      }
      selectSite(saved.siteId).then(() => {
        setTargetUrl(saved.targetUrl)
        setCategoryUrlsText(saved.categoryUrlsText)
        if (saved.previewResult) setPreviewResult(saved.previewResult)
        if (saved.previewTotal != null) setPreviewTotal(saved.previewTotal)
        if (saved.previewItems?.length) setPreviewItems(saved.previewItems)
        if (saved.detectedPlatform) setDetectedPlatform(saved.detectedPlatform)
      })
    } catch { /* 손상된 저장값은 무시 */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 마운트 시 1회만: initialSiteId는 탭 생성 시 고정되는 값
  }, [])

  // 위 복원의 짝 — 몰을 고르거나 시작 URL/카테고리 목록을 입력할 때, 그리고 미리보기 결과가 나올 때마다 저장해둔다.
  useEffect(() => {
    if (!selectedSite) return
    localStorage.setItem(FORM_STATE_KEY, JSON.stringify({
      siteId: selectedSite.id, targetUrl, categoryUrlsText,
      previewResult, previewTotal, previewItems, detectedPlatform,
    }))
  }, [selectedSite, targetUrl, categoryUrlsText, previewResult, previewTotal, previewItems, detectedPlatform])

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
      const d = await r.json() as { status: string; product_count: number; saved_count: number; error?: string }
      setProgress({ saved: Number(d.saved_count) || 0, total: Number(d.product_count) || 0, error: d.error })
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
        setProgress({ saved: Number(latest.staged_count) || 0, total: Number(latest.found_count) || 0 })
        localStorage.setItem(LAST_SESSION_KEY, JSON.stringify({ site, sessionId: latest.id }))
      }).catch(() => {})
    }
    checkForRunningSession()
    const timer = setInterval(checkForRunningSession, 5000)
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

  /** 개발자모드 몰 URL을 클립보드로 복사한다 — PTP를 보고 있는 브라우저가 몰 로그인/확장이 있는 그
   *  브라우저와 다를 수 있어(별도 창 자동으로 띄워봐야 로그인 안 된 새 탭이 뜨는 경우가 많음), 새 창을
   *  직접 띄우는 대신 URL만 복사해 사용자가 원하는 브라우저에 직접 붙여넣게 한다. */
  async function handleCopyMallUrl(url: string) {
    try {
      await navigator.clipboard.writeText(url)
    } catch { /* 클립보드 권한이 없으면 조용히 무시 */ }
  }

  /** URL을 복사하는 대신 실제로 열어준다 — CDP(원격 디버깅) 연결이 전혀 없는 진짜 크롬이라("로그인
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
    setDetectedPlatform(null)
    setPreviewResult(null)
    setPreviewTotal(null)
    setPreviewItems([])
    setSessionExpiredWarning(false)
    setDevModeStarted(false)
    // AI모드는 일반모드에선 그냥 로컬 상태(기본 켜짐)지만, 개발자모드는 확장이 실행 시점마다 서버에서
    // 값을 물어봐야 해서 DB에 저장해둔 값을 그대로 복원한다.
    setAiMode(full.manual_login_required === true ? !!full.devmode_ai_preview : true)
    setPickerActive(false)
    if (devPreviewPollRef.current) clearInterval(devPreviewPollRef.current)
    if (devPreviewTimeoutRef.current) clearTimeout(devPreviewTimeoutRef.current)
    setDevAdjustNewField('')
    setDevAdjustPrompt('')
    setDevAdjustMessage('')
    // 다른 몰을 새로 고르는 것이므로, 이전 몰의 진행 상황("수집완료" 등)이 화면에 그대로 남아있으면 안
    // 된다 — LAST_SESSION_KEY 복원(마운트 시 1회)과 별개로, 몰을 바꿀 때마다 항상 초기화한다.
    setStatus('idle')
    setSessionId(null)
    setProgress({ saved: 0, total: 0 })
    setItemLog([])
    setStopping(false)
    setRetrying(false)
    localStorage.removeItem(LAST_SESSION_KEY)
    // 탭 전환 등으로 이 화면이 다시 마운트돼도, 로그인 창이 서버에 실제로 열려있으면 그 상태를 그대로 복원한다
    // (loginStep은 이 컴포넌트의 로컬 상태라 마운트될 때마다 초기화되지만, 실제 브라우저 세션은 서버에 계속 살아있을 수 있다)
    fetch(`/api/scrape/current-url?siteId=${siteId}`).then(r => r.json()).then((d: { url: string | null }) => {
      if (d.url) setLoginStep('confirmed')
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
    const res = await fetch(`/api/scrape/current-url?siteId=${selectedSite.id}`)
    const d = await res.json() as { url: string | null }
    if (d.url) { setTargetUrl(d.url); setCategoryUrlsText('') }
  }

  /** 로그인 창에 새 탭으로 열어 로그인된 상태로 보여준다. 로그인 창이 닫혀있으면 서버가 저장된 로그인
   * 쿠키로 새 창을 띄운다 — 요청이 아예 실패했을 때만 일반 새 탭으로 폴백한다. */
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
    window.open(url, '_blank', 'noreferrer')
  }

  async function handleLoadCategories() {
    if (!selectedSite || !targetUrl) return
    setCategoriesLoading(true)
    try {
      const res = await fetch('/api/scrape/categories', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ siteId: selectedSite.id, url: targetUrl, loginId, loginPw }),
      })
      const d = await res.json() as { links: { href: string; text: string }[]; platform: string }
      setCategories(d.links || [])
      setDetectedPlatform(d.platform || null)
    } finally {
      setCategoriesLoading(false)
    }
  }

  function isCategorySelected(href: string) {
    return categoryUrlsText.split('\n').map(s => s.trim()).includes(href)
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

  function applyCatalogPreview(d: { total: number; platform: string; preview: { sourceUrl: string; product: PreviewProduct } | null; items: PreviewItem[]; needsLogin?: boolean }) {
    setPreviewTotal(d.total)
    setDetectedPlatform(d.platform || null)
    setPreviewItems((d.items || []).slice(d.preview ? 1 : 0)) // 첫 상품은 위 상세 카드에 이미 나오니 그리드에서는 제외
    if (d.preview) setPreviewResult(d.preview)
    setSessionExpiredWarning(!!d.needsLogin)
    if (d.needsLogin) handleOpenLogin()
  }

  /** 개발자모드 공용 — 이전 결과를 비우고 last_adjustment_preview를 폴링만 시작한다. 실제 캡처는 사용자가
   *  몰 탭에서 확장(팝업 또는 우클릭)을 실행해야 일어난다 — "미리보기"뿐 아니라 "스크랩 대상 직접지정"의
   *  adjust/capture도 같은 컬럼에 재추출 결과를 저장하므로 이 폴링 하나로 둘 다 받는다. 채워지면 일반모드와
   *  같은 previewResult로 편입돼 같은 테이블로 보여준다. */
  function startDevResultPoll() {
    if (!selectedSite) return
    if (devPreviewPollRef.current) clearInterval(devPreviewPollRef.current)
    if (devPreviewTimeoutRef.current) clearTimeout(devPreviewTimeoutRef.current)
    setPreviewLoading(true)
    const siteId = selectedSite.id
    devPreviewPollRef.current = setInterval(async () => {
      const res = await fetch(`/api/sites/${siteId}`).catch(() => null)
      if (!res?.ok) return
      const d = await res.json() as { last_adjustment_preview?: PreviewProduct | null }
      if (!d.last_adjustment_preview) return
      setPreviewResult({ sourceUrl: '', product: d.last_adjustment_preview })
      setPreviewLoading(false)
      if (devPreviewPollRef.current) clearInterval(devPreviewPollRef.current)
      if (devPreviewTimeoutRef.current) clearTimeout(devPreviewTimeoutRef.current)
    }, 3000)
    // 2분 안에 캡처가 안 오면(몰 탭에서 실행을 안 했거나 확장이 없거나) 무한 대기하지 않고 포기한다.
    devPreviewTimeoutRef.current = setTimeout(() => {
      if (devPreviewPollRef.current) clearInterval(devPreviewPollRef.current)
      setPreviewLoading(false)
    }, 120_000)
  }

  async function handleDevPreview() {
    if (!selectedSite) return
    setPreviewResult(null)
    await fetch(`/api/sites/${selectedSite.id}/preview-arm`, { method: 'POST' })
    startDevResultPoll()
  }

  useEffect(() => {
    return () => {
      if (devPreviewPollRef.current) clearInterval(devPreviewPollRef.current)
      if (devPreviewTimeoutRef.current) clearTimeout(devPreviewTimeoutRef.current)
    }
  }, [])

  /** 개발자모드 "스크랩 대상 직접지정" — 클릭식 피커 대신, 프롬프트를 저장해두면 사용자가 몰 탭에서
   *  확장(팝업 또는 우클릭)을 실행할 때 반영된다(기존 "스크랩 조정" 1단계 메커니즘 재사용). itemId 없이
   *  저장하면 확장이 테스트할 미확정 상품이 없을 때 지금 보고 있는 페이지를 그대로 쓴다. */
  async function handleDevAdjustSave() {
    if (!selectedSite || !devAdjustPrompt.trim()) return
    setDevAdjustBusy(true)
    setDevAdjustMessage('')
    try {
      const composedPrompt = devAdjustNewField.trim()
        ? `'${devAdjustNewField.trim()}' 필드 추가: ${devAdjustPrompt.trim()}`
        : devAdjustPrompt.trim()
      const res = await fetch(`/api/sites/${selectedSite.id}/adjust/prompt`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: composedPrompt }),
      })
      if (!res.ok) { setDevAdjustMessage('저장에 실패했습니다.'); return }
      setDevAdjustMessage('✓ 저장했습니다 — 이제 몰 탭에서 확장(팝업 "🎯 조정 테스트 실행" 또는 우클릭)을 실행해주세요. 실행되면 아래 미리보기에 자동으로 결과가 나타납니다.')
      setPreviewResult(null)
      startDevResultPoll()
    } finally {
      setDevAdjustBusy(false)
    }
  }

  /** 목록에서 상품 개수를 세는 것과 첫 상품 미리보기를 한 번의 요청(한 브라우저 세션)으로 같이 처리한다
   * — 예전에는 "테스트 실행"과 "미리보기"가 별도 버튼/요청이라 세션을 두 번 열어야 해서 느렸다. 개수는
   * 페이징 끝까지 따라가 실제 전체 개수를 보여주고, 나머지 상품은 (열어보지 않고) 목록 정보만 그리드로
   * 함께 보여준다. 시작 URL이 목록이 아니라 상품 페이지 하나뿐이어도 scrapeCatalogPage가 그 페이지 자체를
   * 상품 1건으로 처리해 그대로 동작한다. */
  async function handlePreview() {
    if (!selectedSite || !canPreview) return
    setPreviewLoading(true)
    setPreviewResult(null)
    setPreviewTotal(null)
    setPreviewItems([])
    try {
      const categoryUrls = categoryUrlsText.split('\n').map(s => s.trim()).filter(Boolean)
      const res = await fetch('/api/scrape/preview-catalog', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: categoryUrls.length ? undefined : (targetUrl || undefined),
          categoryUrls: categoryUrls.length ? categoryUrls : undefined,
          loginId: loginId || undefined, loginPw: loginPw || undefined,
          siteId: selectedSite.id, aiMode,
        }),
      })
      if (!res.ok) { const e = await res.json().catch(() => ({})); alert(`확인 실패: ${e.error || res.status}`); return }
      const d = await res.json() as { total: number; platform: string; preview: { sourceUrl: string; product: PreviewProduct } | null; items: PreviewItem[]; needsLogin?: boolean }
      applyCatalogPreview(d)
    } finally {
      setPreviewLoading(false)
    }
  }

  const needsLogin = !!loginId
  const canStart = !!selectedSite && (!needsLogin || loginStep === 'confirmed')

  function handleBackToSettings() {
    setStatus('idle')
    setSessionId(null)
    setProgress({ saved: 0, total: 0 })
    localStorage.removeItem(LAST_SESSION_KEY)
  }

  async function handleStart() {
    if (!selectedSite || !canStart) return
    const categoryUrls = categoryUrlsText.split('\n').map(s => s.trim()).filter(Boolean)
    setStatus('running')
    setProgress({ saved: 0, total: 0 })
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
        // 페이지당 지연은 몰 차단 방지를 위한 안전값을 그대로 유지한다(예전엔 사용자가 조절할 수 있었지만
        // 실제로 건드릴 필요가 없어 UI에서 제거) — 다음페이지 셀렉터/최대 페이지 수/동시 처리 개수는
        // 플랫폼별 자동 감지(cafe24 등)와 기본값(끝까지 자동, 순차 처리)으로 대체된다.
        delayMs: 1000,
        loginId: loginId || undefined, loginPw: loginPw || undefined,
        mode: 'catalog', siteId: selectedSite.id,
      }),
    })
    const data = await res.json() as { sessionId: number }
    setSessionId(data.sessionId)
    localStorage.setItem(LAST_SESSION_KEY, JSON.stringify({ site: selectedSite, sessionId: data.sessionId }))
  }

  async function handleRetryFailed() {
    if (!selectedSite || failedUrls.length === 0) return
    setRetrying(true)
    setStatus('running')
    setProgress({ saved: 0, total: 0 })
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
        <div className="text-sm font-semibold text-gray-700 mb-2">Mall 선택 *</div>
        {sites.length === 0 ? (
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
                <button onClick={() => setSiteShowFilters(v => !v)}
                  className={`px-3 py-1 text-xs font-semibold rounded-full transition-colors ${siteShowFilters ? 'bg-teal-500 text-white hover:bg-teal-600' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>
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
        )}
      </div>

      {selectedSite && (
        <div className="mb-4 bg-teal-50 rounded-xl px-3 py-2">
          <div className="text-sm font-medium text-gray-800">{selectedSite.name || selectedSite.url}</div>
          <div className="text-xs text-gray-500">{selectedSite.url}</div>
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
          <div className="text-sm font-semibold text-gray-700 mb-3">로그인 정보</div>
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
            <button onClick={handleOpenLogin} disabled={loginBusy}
              className="px-4 py-2 bg-teal-500 hover:bg-teal-600 text-white text-sm font-semibold rounded-full disabled:opacity-50 transition-colors">
              {needsLogin
                ? (loginStep === 'opened' || loginStep === 'confirmed' ? '로그인 창 다시 열기' : '로그인 창 열기')
                : (loginStep === 'opened' || loginStep === 'confirmed' ? '몰 페이지 다시 열기' : '몰 페이지 열기')}
            </button>
            <button onClick={handleConfirmLogin} disabled={loginBusy || loginStep === 'none'}
              className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-semibold rounded-full disabled:opacity-50 disabled:cursor-not-allowed transition-colors">
              {needsLogin ? '로그인 확인' : '확인'}
            </button>
            {loginStep === 'confirmed' && (
              <button onClick={handleProfileMall} disabled={profileLoading}
                className="px-4 py-2 bg-white border border-teal-400 text-teal-600 hover:bg-teal-50 text-sm font-semibold rounded-full disabled:opacity-50 transition-colors">
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
                {profileResult.signals.categoryMenuNames.length > 0 && (
                  <span className="text-[11px] bg-white border border-gray-200 text-gray-500 rounded-full px-2 py-0.5">
                    카테고리 메뉴 {profileResult.signals.categoryMenuNames.length}개: {profileResult.signals.categoryMenuNames.join(', ')}
                  </span>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* 스크랩 대상 */}
      {selectedSite && mallMode === 'normal' && (
        <div className="bg-white rounded-2xl border border-gray-200 p-6 mb-4">
          {loginStep === 'confirmed' && (
            <div className="flex items-center justify-between gap-3 bg-teal-50 border border-teal-100 rounded-xl px-4 py-2.5 mb-2">
              <p className="text-xs text-teal-700">💡 로그인 창에서 원하는 페이지로 이동했다면, 그 페이지를 시작 URL로 바로 가져올 수 있습니다.</p>
              <button onClick={handleRefreshCurrentUrl} title="로그인 창에서 현재 보고 있는 페이지로 시작 URL 갱신"
                className="px-4 py-1.5 bg-teal-500 hover:bg-teal-600 text-white text-xs font-semibold rounded-full transition-colors shrink-0 flex items-center gap-1">
                <span aria-hidden="true">↻</span> 현재 페이지 가져오기
              </button>
            </div>
          )}
          <div className="flex gap-2 mb-1 items-end">
            <label className="flex-1 block">
              <span className="block text-xs text-gray-500 mb-1">시작 URL</span>
              <input value={targetUrl} onChange={e => setTargetUrl(e.target.value)}
                placeholder="https://shop.example.com/products/123"
                disabled={categoryUrlsText.trim().length > 0}
                className="w-full border border-gray-300 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-400 disabled:bg-gray-100 disabled:text-gray-400" />
            </label>
          </div>
          <p className="text-xs text-amber-600 mb-3 min-h-[1em]">
            {categoryUrlsText.trim().length > 0 &&
              '아래 카테고리 URL 목록이 입력되어 있어 위 시작 URL은 무시되고 카테고리 목록만 스크랩됩니다.'}
          </p>

          <>
              <div className="flex items-center justify-between mb-1">
                <label htmlFor="category-urls" className="block text-xs text-gray-500">카테고리 URL 목록 (한 줄에 하나씩, 입력 시 위 시작 URL 대신 각각 스크랩)</label>
                <button type="button" onClick={handleLoadCategories} disabled={categoriesLoading || !targetUrl}
                  className="text-xs text-teal-500 hover:underline disabled:opacity-50 disabled:cursor-not-allowed shrink-0 ml-2">
                  {categoriesLoading ? '불러오는 중...' : '🔍 시작 URL에서 카테고리 불러오기'}
                </button>
              </div>

              {detectedPlatform && (
                <p className="text-xs text-gray-500 mb-2">
                  감지된 몰 유형: <span className="font-medium text-gray-700">{PLATFORM_LABELS[detectedPlatform] || detectedPlatform}</span>
                  {detectedPlatform !== 'unknown' && ' — 해당 플랫폼에 맞는 상품 링크/다음 페이지 방식이 자동으로 적용됩니다.'}
                </p>
              )}

              {categories.length > 0 && (
                <div className="mb-2 border border-gray-200 rounded-xl overflow-hidden">
                  <div className="flex items-center justify-between px-3 py-1.5 bg-gray-50 border-b border-gray-100">
                    <span className="text-xs text-gray-500">발견된 링크 {categories.length}개 — 스크랩할 항목을 선택하세요</span>
                    <button type="button" onClick={toggleAllCategories} className="text-xs text-teal-500 hover:underline shrink-0">
                      {categories.every(c => isCategorySelected(c.href)) ? '전체 해제' : '전체 선택 (몰 전체상품)'}
                    </button>
                  </div>
                  <div className="max-h-40 overflow-y-auto">
                    <table className="w-full text-xs border-collapse">
                      <tbody>
                        {categories.map(c => (
                          <tr key={c.href} onClick={() => toggleCategory(c.href)}
                            className="group border-b border-gray-100 last:border-0 hover:bg-gray-50 cursor-pointer">
                            <td className="px-3 py-1.5 w-6 sticky left-0 z-[1] bg-white group-hover:bg-gray-50">
                              <input type="checkbox" checked={isCategorySelected(c.href)} onChange={() => toggleCategory(c.href)} onClick={e => e.stopPropagation()} />
                            </td>
                            <td className="px-3 py-1.5 text-gray-700 whitespace-nowrap">{c.text}</td>
                            <td className="px-3 py-1.5 text-gray-400 max-w-[320px] truncate" title={c.href}>{c.href}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              <textarea id="category-urls" value={categoryUrlsText} onChange={e => setCategoryUrlsText(e.target.value)} rows={3}
                placeholder={'https://shop.example.com/category/food\nhttps://shop.example.com/category/beauty'}
                className="w-full border border-gray-300 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-400 mb-3" />
            </>
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
                className={`px-3 py-2 rounded-full text-sm font-medium border transition-colors ${aiMode ? 'bg-violet-600 text-white border-violet-600' : 'bg-white text-gray-500 border-gray-300 hover:border-violet-400'}`}>
                {aiMode ? '☑ 🪄 AI모드 켜짐' : '☐ AI모드 꺼짐'}
              </button>
              <button type="button" onClick={mallMode === 'devmode' ? handleDevPreview : handlePreview}
                disabled={previewLoading || (mallMode === 'normal' && !canPreview)}
                className="px-4 py-2 bg-teal-500 hover:bg-teal-600 text-white text-sm font-semibold rounded-full disabled:opacity-50 disabled:cursor-not-allowed transition-colors">
                {previewLoading ? (mallMode === 'devmode' ? '대기 중...' : aiMode ? 'AI 분석 중...' : '확인 중...') : '🔍 스크랩 미리보기'}
              </button>
              {(mallMode === 'devmode' || loginStep === 'confirmed') && (
                mallMode === 'devmode' ? (
                  pickerActive ? (
                    <button onClick={() => setPickerActive(false)} disabled={pickerBusy}
                      className="px-4 py-2 bg-rose-50 border border-rose-300 text-rose-600 hover:bg-rose-100 text-sm font-semibold rounded-full disabled:opacity-50 transition-colors">
                      🎯 스크랩 대상 직접지정 종료
                    </button>
                  ) : (
                    <button onClick={() => setPickerActive(true)} disabled={pickerBusy}
                      className="px-4 py-2 bg-white border border-teal-400 text-teal-600 hover:bg-teal-50 text-sm font-semibold rounded-full disabled:opacity-50 transition-colors">
                      🎯 스크랩 대상 직접지정
                    </button>
                  )
                ) : (
                  // 창을 닫으면(패널의 ✕) 다시 저절로 뜨지 않는다 — 다시 지정하려면 이 버튼을 다시 눌러야
                  // 한다(자동 재주입을 없앤 것과 맞물린 설계, lib/scraper.ts 참고). 그래서 "종료" 버튼이
                  // 따로 없고, 이 버튼 하나로 몇 번이든 다시 열 수 있다.
                  <button onClick={handleStartPicker} disabled={pickerBusy}
                    className="px-4 py-2 bg-white border border-teal-400 text-teal-600 hover:bg-teal-50 text-sm font-semibold rounded-full disabled:opacity-50 transition-colors">
                    🎯 스크랩 대상 직접지정
                  </button>
                )
              )}
            </div>
          </div>

          {sessionExpiredWarning && (
            <p className="text-xs text-amber-600 bg-amber-50 rounded-lg px-3 py-2 mb-3">
              ⚠ 로그인 세션이 끊긴 상태로 미리보기가 된 것 같습니다 — 로그인 창을 다시 열었으니, 그 창에서
              로그인 후 &quot;로그인 확인&quot;을 누르고 미리보기를 다시 시도해주세요.
            </p>
          )}

          {mallMode === 'devmode' && previewLoading && (
            <p className="text-xs text-teal-700 bg-teal-50 rounded-lg px-3 py-2 mb-3">
              🔍 &quot;브라우저에서 바로 열기&quot;로 연 몰 탭의 상품 상세 페이지에서 확장 아이콘(팝업의 &quot;🔍 미리보기 실행&quot;
              또는 &quot;🎯 조정 테스트 실행&quot;) 또는 우클릭 메뉴를 눌러주세요. 실행하면 몇 초 안에 아래에 결과가 나타납니다.
            </p>
          )}

          {mallMode === 'devmode' && pickerActive ? (
            <div className="mb-3">
              <p className="text-xs text-gray-400 mb-2">
                클릭식 피커 대신, 고칠 내용을 아래에 적어 저장한 뒤 몰 탭에서 확장(팝업 &quot;🎯 조정 테스트 실행&quot;
                또는 우클릭 &quot;PTP 조정 테스트 실행&quot;)을 실행하면 반영됩니다
                {Object.keys(pickerRules).length > 0 && ` — 지금까지 ${Object.keys(pickerRules).length}개 지정됨`}.
              </p>
              <input value={devAdjustNewField} onChange={e => setDevAdjustNewField(e.target.value)}
                placeholder="새 컬럼일 때만: 필드 이름 (예: 고시분류)"
                className="w-full border border-gray-300 rounded-xl px-3 py-2 text-sm mb-2 focus:outline-none focus:ring-2 focus:ring-teal-400" />
              <textarea value={devAdjustPrompt} onChange={e => setDevAdjustPrompt(e.target.value)} rows={3}
                placeholder={devAdjustNewField.trim()
                  ? `예: 상품정보고시 표에서 '${devAdjustNewField.trim()}' 라벨의 값을 가져와줘.`
                  : '예: shipping_fee가 비어있어. 배송유형에 배송비가 있으니 그걸로 채워줘.'}
                className="w-full border border-gray-300 rounded-xl px-3 py-2 text-sm mb-2 focus:outline-none focus:ring-2 focus:ring-teal-400" />
              {devAdjustMessage && <p className="text-xs text-gray-600 mb-2">{devAdjustMessage}</p>}
              <button onClick={handleDevAdjustSave} disabled={devAdjustBusy || !devAdjustPrompt.trim()}
                className="px-4 py-2 bg-white border border-teal-400 text-teal-600 hover:bg-teal-50 text-sm font-semibold rounded-full disabled:opacity-50 disabled:cursor-not-allowed transition-colors">
                {devAdjustBusy ? '저장 중...' : '지정 저장'}
              </button>
            </div>
          ) : pickerActive && (
            <p className="text-xs text-teal-700 bg-teal-50 rounded-lg px-3 py-2 mb-3">
              🎯 로그인 창에 뜬 &quot;PTP 스크랩 대상 직접지정&quot; 패널에서 값을 클릭하거나, 패널의 목록에서
              바로 값을 입력해 지정하세요{Object.keys(pickerRules).length > 0 && ` — 지금까지 ${Object.keys(pickerRules).length}개 지정됨`}.
              다 되면 패널의 ✕로 닫으면 되고, 지정한 값은 그대로 저장됩니다. 다시 열려면 위
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
                  <span className="truncate">{previewResult.sourceUrl}</span>
                  <div className="flex items-center gap-3 shrink-0">
                    <button type="button" onClick={() => handleOpenItem(previewResult.sourceUrl)} className="text-teal-500 hover:underline">
                      열기 ↗
                    </button>
                    <button type="button" onClick={handlePreview} disabled={previewLoading || !canPreview}
                      title="다시 미리보기" className="text-teal-500 hover:underline disabled:opacity-50 disabled:cursor-not-allowed">
                      {previewLoading ? '확인 중...' : '🔄 새로고침'}
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
        </div>
      )}

      {/* 실행 버튼 / 개발자모드 안내 */}
      {mallMode === 'devmode' && selectedSite && status === 'running' ? (
        <button onClick={handleStop} disabled={stopping}
          className="w-full py-3 rounded-2xl bg-rose-500 text-white font-semibold text-sm hover:bg-rose-600 disabled:opacity-50 transition-colors">
          {stopping ? '중지 처리 중...' : '⏸ 스크래핑 중지'}
        </button>
      ) : mallMode === 'devmode' && selectedSite && !devModeStarted ? (
        <button onClick={() => { setDevModeStarted(true); handleCopyMallUrl(selectedSite.url) }}
          className="w-full py-3 rounded-2xl bg-teal-500 text-white font-semibold text-sm hover:bg-teal-600 transition-colors">
          🧩 스크래핑 Start (개발자모드 방법 보기 + 몰 URL 복사)
        </button>
      ) : mallMode === 'devmode' && selectedSite ? (
        <>
        <div className="bg-white rounded-2xl border border-gray-200 p-6 mb-4">
          <div className="flex items-start justify-between mb-3 pb-3 border-b border-gray-100 flex-wrap gap-3">
            <div className="text-sm font-semibold text-gray-700">🧩 개발자모드 스크랩 방법</div>
            <div className="flex flex-col items-end gap-1.5">
              <div className="flex items-center gap-3">
                <button onClick={() => handleOpenMallUrlDirect(selectedSite.login_url || selectedSite.url)}
                  className="text-xs text-teal-500 hover:underline shrink-0">🌐 브라우저에서 바로 열기</button>
              </div>
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
          <ol className="list-decimal list-inside text-sm text-gray-600 space-y-1">
            <li>&quot;브라우저에서 바로 열기&quot;로 {selectedSite.name || selectedSite.url}를 열고, 로그인 정보를 붙여넣어 로그인한 상태로 상품 목록(카테고리) 페이지를 여세요(자동입력은 안 됩니다 — 자동 로그인 감지 회피를 위해 진짜 브라우저를 그대로 쓰기 때문).</li>
            <li>크롬 우측 상단의 확장 아이콘을 클릭하면 자동으로 상품을 순회하며 스크랩합니다.</li>
            <li>진행 상황은 아래에 자동으로 나타나며, 완료되면 &quot;스크랩 Raw 확인&quot;으로 바로 이동할 수 있습니다.</li>
          </ol>
          {failedUrls.length > 0 && (
            <p className="text-xs text-rose-500 mt-3 pt-3 border-t border-gray-100">
              ⚠ 아래에 실패한 상품 {failedUrls.length}개가 있습니다 — 이미 성공한 상품은 다시 스크랩하지 않고,
              이 몰의 아무 페이지에서나(로그인된 상태) 마우스 우클릭 → <b className="text-gray-600">PTP 실패 상품 재수집</b>을 실행하면 실패한 것만 다시 시도합니다.
            </p>
          )}
        </div>
        </>
      ) : mallMode !== 'normal' ? null : status === 'running' ? (
        <button onClick={handleStop} disabled={stopping}
          className="w-full py-3 rounded-2xl bg-rose-500 text-white font-semibold text-sm hover:bg-rose-600 disabled:opacity-50 transition-colors">
          {stopping ? '중지 처리 중...' : '⏸ 스크래핑 중지'}
        </button>
      ) : (
        <button onClick={handleStart} disabled={!canStart}
          className="w-full py-3 rounded-2xl bg-teal-500 text-white font-semibold text-sm hover:bg-teal-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors">
          {status === 'stopped' || status === 'error' ? '이어서 스크랩하기 (기존 상품 제외)' : '스크래핑 시작'}
        </button>
      )}

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
            {failedUrls.length > 0 && <span className="text-rose-500"> · 실패 {failedUrls.length}개</span>}
          </p>

          {/* 실패한 상품만 따로 모아, 실패 사유가 (마우스를 올려야 보이는 툴팁이 아니라) 바로 눈에 보이게 표시한다. */}
          {failedItems.length > 0 && (
            <div className="mt-3 border border-rose-200 bg-rose-50 rounded-xl overflow-hidden">
              <div className="px-3 py-2 text-xs font-semibold text-rose-600 border-b border-rose-200">
                ❌ 수집 실패 ({failedItems.length}개) — 사유
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

          {successItems.length > 0 && (
            <div className="mt-3 border border-gray-100 rounded-xl overflow-hidden">
              <div className="px-3 py-2 text-xs font-semibold text-gray-500 border-b border-gray-100">
                ✓ 수집 성공 ({successItems.length}개)
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
