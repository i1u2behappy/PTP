'use client'
import { useState, useEffect, useRef, useMemo } from 'react'
import { useTabs } from '../shell/TabsContext'
import { PRODUCTS_LIST_TAB } from '../shell/menuTabs'

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

// lib/scraper.ts의 injectElementPicker 안 CANONICAL_FIELDS와 같은 목록 — 그쪽은 브라우저에 그대로
// 주입되는 함수라 이 모듈과 상수를 공유할 수 없어 따로 둔다.
const FIXED_VALUE_FIELDS: [string, string][] = [
  ['name', '상품명'], ['price', '가격(소비자가)'], ['cost_price', '공급가/원가'], ['shipping_fee', '배송비'],
  ['category', '카테고리'], ['brand', '브랜드'], ['manufacturer', '제조사'], ['origin', '원산지'],
  ['stock_status', '재고상태'], ['stock_qty', '재고수량'], ['english_name', '영문상품명'], ['summary_info', '상품요약정보'],
]

// 스크랩 검토 탭으로 넘어갔다 돌아와도(탭 전환 시 이 패널은 언마운트된다) 방금 진행/완료한 세션 정보가
// 유지되도록 site+sessionId만 남겨두고, 되돌아왔을 때 서버에서 최신 상태를 다시 조회해 복원한다.
const LAST_SESSION_KEY = 'scrape.scraper.lastSession'

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
  const pickerRulesJsonRef = useRef('')
  const [fixedField, setFixedField] = useState(FIXED_VALUE_FIELDS[0][0])
  const [fixedCustomField, setFixedCustomField] = useState('')
  const [fixedValue, setFixedValue] = useState('')
  const [fixedSaving, setFixedSaving] = useState(false)

  const [targetUrl, setTargetUrl]           = useState('')
  const [categoryUrlsText, setCategoryUrlsText] = useState('')
  const [nextPageSelector, setNextPageSelector] = useState('')
  const [maxPages, setMaxPages]             = useState<number | ''>('')
  const [delayMs, setDelayMs]               = useState(1000)
  const [concurrency, setConcurrency]       = useState(1)

  const [categories, setCategories]         = useState<{ href: string; text: string }[]>([])
  const [categoriesLoading, setCategoriesLoading] = useState(false)
  const [detectedPlatform, setDetectedPlatform] = useState<string | null>(null)

  const [previewResult, setPreviewResult]   = useState<{ sourceUrl: string; product: PreviewProduct } | null>(null)
  const previewResultRef = useRef(previewResult)
  useEffect(() => { previewResultRef.current = previewResult }, [previewResult])
  const [previewTotal, setPreviewTotal]     = useState<number | null>(null)
  const [previewItems, setPreviewItems]     = useState<PreviewItem[]>([])
  const [previewLoading, setPreviewLoading] = useState(false)

  const [mode, setMode]           = useState<'single' | 'catalog'>('catalog')
  const [scrapeMode, setScrapeMode] = useState<'full' | 'incremental'>('full')
  const [linkSel, setLinkSel]     = useState('')
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
  const [urlCopied, setUrlCopied] = useState(false)
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
    if (!raw) return
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
    } catch { /* 손상된 저장값은 무시 */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 마운트 시 1회만: initialSiteId는 탭 생성 시 고정되는 값
  }, [])

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
  // 실제로 겪어보기 전엔 알 수 없어(이미 여러 번 확인된 사실), 최초 스크랩 시점에 사용자가 한 번 고르게
  // 한다. 아래 재스크랩 "전체/증분" 선택과는 별개 개념이라 이름을 다르게 둔다(scrapeMode는 이미 그 용도로 씀).
  const mallMode = !selectedSite ? null
    : selectedSite.manual_login_required === null ? 'undetermined'
    : selectedSite.manual_login_required ? 'devmode' : 'normal'

  /** 개발자모드 몰 URL을 클립보드로 복사한다 — PTP를 보고 있는 브라우저가 몰 로그인/확장이 있는 그
   *  브라우저와 다를 수 있어(별도 창 자동으로 띄워봐야 로그인 안 된 새 탭이 뜨는 경우가 많음), 새 창을
   *  직접 띄우는 대신 URL만 복사해 사용자가 원하는 브라우저에 직접 붙여넣게 한다. */
  async function handleCopyMallUrl(url: string) {
    try {
      await navigator.clipboard.writeText(url)
      setUrlCopied(true)
      setTimeout(() => setUrlCopied(false), 1500)
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
    const full = await res.json() as Site & { login_pw: string | null; extraction_rules?: Record<string, { type: string; value: string }> }
    setSelectedSite({
      id: full.id, name: full.name, url: full.url, login_url: full.login_url, login_id: full.login_id,
      manual_login_required: full.manual_login_required, profile_dir: full.profile_dir,
    })
    setLoginId(full.login_id || '')
    setLoginPw(full.login_pw || '')
    setLoginStep('none')
    // 이 몰에 예전에 "스크랩 대상 직접지정"으로 등록해둔 컬럼이 있으면, 피커를 켜지 않은 채 바로 미리보기만
    // 해도 그리드에 컬럼으로 나오도록 미리 채워둔다(그리드는 이 목록에 있는 필드만 컬럼으로 보여준다).
    const rules = full.extraction_rules || {}
    setPickerRules(rules)
    pickerRulesJsonRef.current = JSON.stringify(rules)
    setSiteQuery('')
    setTargetUrl(full.url)
    setCategoryUrlsText('') // 이전 사이트의 카테고리 목록이 남아 시작 URL을 무시하는 것을 방지
    setCategories([])
    setDetectedPlatform(null)
    setPreviewResult(null)
    setPreviewTotal(null)
    setPreviewItems([])
    setScrapeMode('full')
    setDevModeStarted(false)
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
      await refreshPickerRules()
    } finally {
      setLoginBusy(false)
    }
  }

  /** "몰 구조 파악" — 로그인 확인 시마다 조용히 도는 백그라운드 프로파일링을 그 자리에서 즉시 실행해
   *  결과를 화면에 보여준다(같은 로직, app/api/sites/[id]/profile이 lib/scrape/mallProfile.ts의
   *  runMallProfileCheck를 그대로 재사용). 새 몰을 등록한 직후 카테고리/상품 구조가 어떤지 바로 확인하고
   *  싶을 때 로그인 확인마다의 자동 체크를 기다리지 않아도 되도록. */
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
      if (previewResult) await handleOpenItem(previewResult.sourceUrl)
      const res = await fetch(`/api/sites/${selectedSite.id}/picker/start`, { method: 'POST' })
      const d = await res.json()
      if (!res.ok) { alert(d.error || '스크랩 대상 직접지정을 시작하지 못했습니다'); return }
      setPickerActive(true)
      await refreshPickerRules()
    } finally {
      setPickerBusy(false)
    }
  }

  /** 미리보기로 열어본 그 상품 하나만 다시 추출해 previewResult를 갱신한다 — 스크랩 대상 직접지정으로 규칙을 새로
   *  저장했을 때, 고친 값이 미리보기 테이블에 곧바로 반영되도록. */
  async function refreshPreviewSingle() {
    if (!selectedSite || !previewResultRef.current) return
    const res = await fetch('/api/scrape/preview', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: previewResultRef.current.sourceUrl, siteId: selectedSite.id,
        loginId: loginId || undefined, loginPw: loginPw || undefined,
      }),
    })
    if (!res.ok) return
    const d = await res.json() as { sourceUrl: string; product: PreviewProduct }
    setPreviewResult(d)
  }

  async function handleStopPicker() {
    if (!selectedSite) return
    setPickerBusy(true)
    try {
      await fetch(`/api/sites/${selectedSite.id}/picker/stop`, { method: 'POST' })
      setPickerActive(false)
    } finally {
      setPickerBusy(false)
    }
  }

  async function refreshPickerRules() {
    if (!selectedSite) return
    const res = await fetch(`/api/sites/${selectedSite.id}`)
    const d = await res.json() as { extraction_rules?: Record<string, { type: string; value: string }> }
    const rules = d.extraction_rules || {}
    const json = JSON.stringify(rules)
    const changed = pickerRulesJsonRef.current !== '' && json !== pickerRulesJsonRef.current
    pickerRulesJsonRef.current = json
    setPickerRules(rules)
    if (changed) await refreshPreviewSingle()
  }

  async function handleDeleteRule(field: string) {
    if (!selectedSite) return
    await fetch(`/api/sites/${selectedSite.id}/picker/rule`, {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ field }),
    })
    refreshPickerRules()
  }

  /** 택배사처럼 페이지 어디에도 값이 없는 필드를 위한 등록 — 요소를 클릭하는 대신 컬럼명과 고정 값을
   *  직접 입력해 모든 상품에 그대로 채워 넣는다. */
  async function handleAddFixedRule() {
    if (!selectedSite) return
    const field = fixedField === '__custom__' ? fixedCustomField.trim() : fixedField
    if (!field || !fixedValue.trim()) return
    setFixedSaving(true)
    try {
      await fetch(`/api/sites/${selectedSite.id}/picker/rule`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ field, value: fixedValue.trim() }),
      })
      setFixedValue('')
      setFixedCustomField('')
      await refreshPickerRules()
    } finally {
      setFixedSaving(false)
    }
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

  const canPreview = mode === 'catalog'
    ? (!!targetUrl.trim() || categoryUrlsText.trim().length > 0)
    : !!targetUrl.trim()

  function applyCatalogPreview(d: { total: number; platform: string; preview: { sourceUrl: string; product: PreviewProduct } | null; items: PreviewItem[] }) {
    setPreviewTotal(d.total)
    setDetectedPlatform(d.platform || null)
    setPreviewItems((d.items || []).slice(d.preview ? 1 : 0)) // 첫 상품은 위 상세 카드에 이미 나오니 그리드에서는 제외
    if (d.preview) setPreviewResult(d.preview)
  }

  /** 주어진 url을 목록 페이지로 간주해 상품 개수 + 첫 상품을 찾아본다. 찾으면 true. */
  async function tryPreviewAsListing(url: string): Promise<boolean> {
    if (!selectedSite) return false
    const res = await fetch('/api/scrape/preview-catalog', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, loginId: loginId || undefined, loginPw: loginPw || undefined, siteId: selectedSite.id }),
    })
    if (!res.ok) return false
    const d = await res.json() as { total: number; platform: string; preview: { sourceUrl: string; product: PreviewProduct } | null; items: PreviewItem[] }
    applyCatalogPreview(d)
    return !!d.preview
  }

  /**
   * 단일 상품 모드: 시작 URL을 상품 페이지로 보고 바로 미리본다. 실패하면(목록/로그인 페이지 등 상품 페이지가
   * 아니었을 수 있음) 그 URL을 목록 페이지로 다시 간주해 첫 상품을 찾아본다 — 어떤 URL을 넣어도 직접 하나하나
   * 열어보지 않고 빠르게 확인할 수 있도록 자동으로 폴백한다.
   * 카탈로그(목록) 모드: 목록에서 상품 개수를 세는 것과 첫 상품 미리보기를 한 번의 요청(한 브라우저 세션)으로 같이 처리한다
   * — 예전에는 "테스트 실행"과 "미리보기"가 별도 버튼/요청이라 세션을 두 번 열어야 해서 느렸다. 개수는 페이징 끝까지
   * 따라가 실제 전체 개수를 보여주고, 나머지 상품은 (열어보지 않고) 목록 정보만 그리드로 함께 보여준다.
   */
  async function handlePreview() {
    if (!selectedSite || !canPreview) return
    setPreviewLoading(true)
    setPreviewResult(null)
    setPreviewTotal(null)
    setPreviewItems([])
    try {
      if (mode === 'catalog') {
        const categoryUrls = categoryUrlsText.split('\n').map(s => s.trim()).filter(Boolean)
        const res = await fetch('/api/scrape/preview-catalog', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            url: categoryUrls.length ? undefined : (targetUrl || undefined),
            categoryUrls: categoryUrls.length ? categoryUrls : undefined,
            nextPageSelector: nextPageSelector || undefined,
            loginId: loginId || undefined, loginPw: loginPw || undefined,
            productLinkSelector: linkSel || undefined, siteId: selectedSite.id,
          }),
        })
        if (!res.ok) { const e = await res.json().catch(() => ({})); alert(`확인 실패: ${e.error || res.status}`); return }
        const d = await res.json() as { total: number; platform: string; preview: { sourceUrl: string; product: PreviewProduct } | null; items: PreviewItem[] }
        applyCatalogPreview(d)
      } else {
        const res = await fetch('/api/scrape/preview', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: targetUrl, siteId: selectedSite.id, loginId: loginId || undefined, loginPw: loginPw || undefined }),
        })
        if (res.ok) {
          const d = await res.json() as { sourceUrl: string; product: PreviewProduct }
          setPreviewResult(d)
        } else if (!(await tryPreviewAsListing(targetUrl))) {
          alert('상품 정보를 찾지 못했습니다. 시작 URL을 확인해주세요.')
        }
      }
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
    const res = await fetch('/api/scrape', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: categoryUrls.length ? undefined : (targetUrl || undefined),
        categoryUrls: categoryUrls.length ? categoryUrls : undefined,
        nextPageSelector: mode === 'catalog' ? (nextPageSelector || undefined) : undefined,
        maxPages: mode === 'catalog' && maxPages !== '' ? maxPages : undefined,
        delayMs: mode === 'catalog' ? delayMs : undefined,
        concurrency: mode === 'catalog' ? concurrency : undefined,
        loginId: loginId || undefined, loginPw: loginPw || undefined,
        mode, scrapeMode, productLinkSelector: linkSel || undefined, siteId: selectedSite.id,
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
              <div className="max-h-64 overflow-y-auto">
                {visibleSites.length === 0 ? (
                  <div className="px-3 py-3 text-xs text-gray-400 text-center">검색 결과가 없습니다.</div>
                ) : (
                  <table className="text-xs border-collapse" style={{ tableLayout: 'fixed', width: siteTableWidth }}>
                    <colgroup>
                      {siteOrderedColumns.map(col => <col key={col.key} style={{ width: siteColWidths[col.key] ?? sitePickerWidthFor(col.key) }} />)}
                    </colgroup>
                    <thead className="sticky top-0 z-10 bg-gray-50">
                      <tr className="border-b border-gray-200 text-gray-500 font-semibold">
                        {siteOrderedColumns.map(col => {
                          const idx = siteSortKeys.findIndex(s => s.key === col.key)
                          const active = idx !== -1
                          return (
                            <th key={col.key} draggable
                              onDragStart={() => setSiteDragKey(col.key)}
                              onDragOver={e => e.preventDefault()}
                              onDrop={() => handleSiteColDrop(col.key)}
                              onDragEnd={() => setSiteDragKey(null)}
                              className={`relative px-3 py-2 text-left cursor-pointer select-none hover:bg-gray-100 overflow-hidden whitespace-nowrap ${siteDragKey === col.key ? 'opacity-40' : ''}`}
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
                          {siteOrderedColumns.map(col => (
                            <th key={col.key} className="px-2 py-1.5 font-normal">
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
                          className="border-b border-gray-100 last:border-0 hover:bg-gray-50 cursor-pointer transition-colors">
                          {siteOrderedColumns.map(col => (
                            <td key={col.key} className={`px-3 py-2 truncate ${col.className ?? ''}`} title={col.key === 'url' || col.key === 'main_items' ? col.getValue(s) : undefined}>
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
          <div className="flex flex-wrap items-start justify-between gap-6 mb-1">
            <div>
              <div className="text-sm font-semibold text-gray-700 mb-2">스크랩 모드</div>
              <div className="flex gap-3">
                {(['catalog', 'single'] as const).map(m => (
                  <button key={m} onClick={() => { setMode(m); setPreviewResult(null); setPreviewTotal(null); setPreviewItems([]) }}
                    className={`px-4 py-2 rounded-full text-sm font-medium border transition-colors ${mode === m ? 'bg-teal-500 text-white border-teal-500' : 'bg-white text-gray-600 border-gray-300 hover:border-teal-400'}`}>
                    {m === 'single' ? '단일 상품 페이지' : '카테고리/목록 페이지'}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <div className="text-sm font-semibold text-gray-700 mb-2">재스크랩 방식</div>
              <div className="flex gap-3">
                {([
                  { id: 'full' as const, label: '전체 재스크랩' },
                  { id: 'incremental' as const, label: '증분 (변동사항만)' },
                ]).map(m => (
                  <button key={m.id} onClick={() => setScrapeMode(m.id)}
                    className={`px-4 py-2 rounded-full text-sm font-medium border transition-colors ${scrapeMode === m.id ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-white text-gray-600 border-gray-300 hover:border-emerald-400'}`}>
                    {m.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
          {scrapeMode === 'incremental' && (
            <p className="text-xs text-gray-500 mb-3">
              이전에 스크랩된 상품 중 재고/가격이 바뀐 것만 이력에 남기고, 이번 회차에 안 보이는 기존 상품은 단종 추정으로 표시합니다.
            </p>
          )}
          <div className="flex gap-2 mb-1 items-end">
            <label className="flex-1 block">
              <span className="block text-xs text-gray-500 mb-1">
                시작 URL {loginStep === 'confirmed' && '(로그인 창에서 이동한 페이지를 그대로 사용할 수 있습니다)'}
              </span>
              <input value={targetUrl} onChange={e => setTargetUrl(e.target.value)}
                placeholder="https://shop.example.com/products/123"
                disabled={mode === 'catalog' && categoryUrlsText.trim().length > 0}
                className="w-full border border-gray-300 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-400 disabled:bg-gray-100 disabled:text-gray-400" />
            </label>
            {loginStep === 'confirmed' && (
              <button onClick={handleRefreshCurrentUrl} title="로그인 창에서 현재 보고 있는 페이지로 갱신"
                className="px-3 py-1.5 bg-gray-100 hover:bg-gray-200 text-gray-600 text-xs font-semibold rounded-full transition-colors shrink-0">
                현재 페이지로
              </button>
            )}
          </div>
          {mode === 'catalog' ? (
            <p className="text-xs text-amber-600 mb-3 min-h-[1em]">
              {categoryUrlsText.trim().length > 0 &&
                '아래 카테고리 URL 목록이 입력되어 있어 위 시작 URL은 무시되고 카테고리 목록만 스크랩됩니다.'}
            </p>
          ) : <div className="mb-3" />}

          {mode === 'catalog' && (
            <>
              <label className="block">
                <span className="block text-xs text-gray-500 mb-1">제품 링크 CSS 셀렉터 (비워두면 이미지가 있는 링크만 자동으로 제품으로 인식)</span>
                <input value={linkSel} onChange={e => setLinkSel(e.target.value)}
                  placeholder=".product-list a, .item-card a"
                  className="w-full border border-gray-300 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-400 mb-3" />
              </label>

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
                            className="border-b border-gray-100 last:border-0 hover:bg-gray-50 cursor-pointer">
                            <td className="px-3 py-1.5 w-6">
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

              <div className="grid grid-cols-4 gap-3 mb-4">
                <label className="block">
                  <span className="block text-xs text-gray-500 mb-1">다음 페이지 셀렉터 (페이지네이션, 선택)</span>
                  <input value={nextPageSelector} onChange={e => setNextPageSelector(e.target.value)}
                    placeholder=".pagination .next"
                    className="w-full border border-gray-300 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-400" />
                </label>
                <label className="block">
                  <span className="block text-xs text-gray-500 mb-1">최대 페이지 수 (비워두면 끝까지 자동)</span>
                  <input type="number" min={1} placeholder="자동" value={maxPages}
                    onChange={e => setMaxPages(e.target.value === '' ? '' : Math.max(1, Number(e.target.value) || 1))}
                    className="w-full border border-gray-300 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-400" />
                </label>
                <label className="block">
                  <span className="block text-xs text-gray-500 mb-1">상품 페이지 간 지연 (ms, 차단 방지)</span>
                  <input type="number" min={0} step={100} value={delayMs} onChange={e => setDelayMs(Math.max(0, Number(e.target.value) || 0))}
                    className="w-full border border-gray-300 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-400" />
                </label>
                <label className="block">
                  <span className="block text-xs text-gray-500 mb-1">동시 처리 개수 (빠르지만 차단 위험↑)</span>
                  <input type="number" min={1} max={8} value={concurrency} onChange={e => setConcurrency(Math.max(1, Math.min(8, Number(e.target.value) || 1)))}
                    className="w-full border border-gray-300 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-400" />
                </label>
              </div>

            </>
          )}
        </div>
      )}

      {/* 상품 페이지 미리보기 */}
      {selectedSite && mallMode === 'normal' && (
        <div className="bg-white rounded-2xl border border-gray-200 p-6 mb-4">
          <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
            <label className="block text-sm font-semibold text-gray-700">상품 페이지 미리보기</label>
            <div className="flex items-center gap-2 shrink-0">
              <button type="button" onClick={handlePreview} disabled={previewLoading || !canPreview}
                className="px-4 py-2 bg-teal-500 hover:bg-teal-600 text-white text-sm font-semibold rounded-full disabled:opacity-50 disabled:cursor-not-allowed transition-colors">
                {previewLoading ? '확인 중...' : '🔍 스크랩 미리보기'}
              </button>
              {loginStep === 'confirmed' && (
                pickerActive ? (
                  <button onClick={handleStopPicker} disabled={pickerBusy}
                    className="px-4 py-2 bg-rose-50 border border-rose-300 text-rose-600 hover:bg-rose-100 text-sm font-semibold rounded-full disabled:opacity-50 transition-colors">
                    🎯 스크랩 대상 직접지정 종료
                  </button>
                ) : (
                  <button onClick={handleStartPicker} disabled={pickerBusy}
                    className="px-4 py-2 bg-white border border-teal-400 text-teal-600 hover:bg-teal-50 text-sm font-semibold rounded-full disabled:opacity-50 transition-colors">
                    🎯 스크랩 대상 직접지정
                  </button>
                )
              )}
            </div>
          </div>

          {pickerActive && (
            <div className="mb-3">
              <p className="text-xs text-teal-700 bg-teal-50 rounded-lg px-3 py-2 mb-2">
                🎯 로그인 창에서 원하는 값을 클릭하고 컬럼명을 입력해 저장하세요 — 여러 개를 계속 지정할 수 있습니다. 화면에 클릭할 값이 없으면 아래에서 직접 등록할 수도 있습니다. 다 되면 위 &quot;스크랩 대상 직접지정 종료&quot;를 누르세요.
              </p>
              <div className="flex flex-wrap gap-1.5">
                {Object.keys(pickerRules).length === 0 ? (
                  <span className="text-xs text-gray-400">아직 지정된 컬럼이 없습니다.</span>
                ) : Object.entries(pickerRules).map(([field, rule]) => (
                  <span key={field} className="inline-flex items-center gap-1 text-xs bg-white border border-gray-200 rounded-full pl-2.5 pr-1 py-1">
                    <span className="font-medium text-gray-700">{field}</span>
                    <span className="text-gray-400 max-w-[160px] truncate" title={rule.value}>
                      ({rule.type === 'label' ? '라벨' : rule.type === 'fixed' ? '고정값' : '셀렉터'}: {rule.value})
                    </span>
                    <button onClick={() => handleDeleteRule(field)} className="text-rose-400 hover:text-rose-600 px-1">✕</button>
                  </span>
                ))}
              </div>

              <div className="mt-2 pt-2 border-t border-gray-100 flex items-center gap-2 flex-wrap">
                <span className="text-xs text-gray-500 shrink-0">화면에 클릭할 값이 없으면 직접 등록:</span>
                <select value={fixedField} onChange={e => setFixedField(e.target.value)}
                  className="border border-gray-300 rounded-lg px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-teal-400">
                  {FIXED_VALUE_FIELDS.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
                  <option value="__custom__">직접 입력...</option>
                </select>
                {fixedField === '__custom__' && (
                  <input value={fixedCustomField} onChange={e => setFixedCustomField(e.target.value)} placeholder="컬럼명"
                    className="border border-gray-300 rounded-lg px-2 py-1 text-xs w-24 focus:outline-none focus:ring-2 focus:ring-teal-400" />
                )}
                <input value={fixedValue} onChange={e => setFixedValue(e.target.value)} placeholder="고정 값 (예: CJ대한통운)"
                  className="border border-gray-300 rounded-lg px-2 py-1 text-xs w-36 focus:outline-none focus:ring-2 focus:ring-teal-400" />
                <button onClick={handleAddFixedRule} disabled={fixedSaving || !fixedValue.trim() || (fixedField === '__custom__' && !fixedCustomField.trim())}
                  className="px-3 py-1 bg-teal-500 hover:bg-teal-600 text-white text-xs font-semibold rounded-full disabled:opacity-50 transition-colors">
                  추가
                </button>
              </div>
            </div>
          )}

          {mode === 'catalog' && !canPreview && (
            <p className="text-xs text-gray-400">시작 URL 또는 카테고리 목록을 입력하면 카테고리 내 상품 개수와 첫 상품 페이지를 바로 확인할 수 있습니다.</p>
          )}
          {mode === 'single' && !canPreview && (
            <p className="text-xs text-gray-400">시작 URL을 입력하면 실제로 열어서 추출될 내용을 미리 확인할 수 있습니다.</p>
          )}

          {previewTotal !== null && (
            <p className="text-xs text-gray-600 mb-2">
              {mode === 'single' && '(입력한 URL이 상품 페이지가 아니라 목록으로 인식됨) '}
              스크랩 대상 상품 <strong>{previewTotal}</strong>개 발견
              {detectedPlatform && ` — 감지된 몰 유형: ${PLATFORM_LABELS[detectedPlatform] || detectedPlatform}`}
              {previewTotal === 0 && <span className="text-rose-500"> (매칭되는 상품 링크가 없습니다. 셀렉터나 시작 URL을 확인해주세요.)</span>}
            </p>
          )}

          {previewResult && (
            <div className="mt-2 border border-gray-200 rounded-xl overflow-hidden">
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
              <div className="p-3 flex gap-3 border-b border-gray-100">
                {previewResult.product.thumbnail_urls.length > 0 && (
                  <div className="flex gap-1 shrink-0">
                    {previewResult.product.thumbnail_urls.slice(0, 3).map((src, i) => (
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
                  <thead className="bg-gray-50">
                    <tr className="border-b border-gray-200 text-gray-500 font-semibold">
                      <th className="px-3 py-2 text-left">카테고리</th>
                      <th className="px-3 py-2 text-left">가격</th>
                      <th className="px-3 py-2 text-left">브랜드</th>
                      <th className="px-3 py-2 text-left">제조사</th>
                      <th className="px-3 py-2 text-left">원산지</th>
                      <th className="px-3 py-2 text-left">재고</th>
                      <th className="px-3 py-2 text-left">옵션별 재고</th>
                      <th className="px-3 py-2 text-left">상품요약정보</th>
                      <th className="px-3 py-2 text-left">영문상품명</th>
                      <th className="px-3 py-2 text-left">대표이미지</th>
                      <th className="px-3 py-2 text-left">상세이미지</th>
                      {previewResult.product.options.map(o => (
                        <th key={o.name} className="px-3 py-2 text-left">{o.name}</th>
                      ))}
                      {Object.keys(previewResult.product.custom_fields || {})
                        .filter(label => label in pickerRules)
                        .map(label => <th key={label} className="px-3 py-2 text-left">🎯 {label}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td className="px-3 py-2 text-gray-700 max-w-[200px] truncate" title={previewResult.product.category}>
                        {previewResult.product.category || '-'}
                      </td>
                      <td className="px-3 py-2 text-gray-700">
                        {previewResult.product.price != null ? `₩${previewResult.product.price.toLocaleString()}` : <span className="text-rose-500">찾지 못함</span>}
                      </td>
                      <td className="px-3 py-2 text-gray-700">{previewResult.product.brand || '-'}</td>
                      <td className="px-3 py-2 text-gray-700">{previewResult.product.manufacturer || '-'}</td>
                      <td className="px-3 py-2 text-gray-700">{previewResult.product.origin || '-'}</td>
                      <td className="px-3 py-2 text-gray-700">
                        {previewResult.product.stock_status || '-'}{previewResult.product.stock_qty != null && ` (${previewResult.product.stock_qty}개)`}
                      </td>
                      <td className="px-3 py-2 text-gray-700 max-w-[280px] truncate"
                        title={previewResult.product.stock_by_option.map(r => `${r.option}: ${r.qty}개`).join(', ')}>
                        {previewResult.product.stock_by_option.length > 0
                          ? previewResult.product.stock_by_option.map(r => `${r.option}: ${r.qty}개`).join(', ')
                          : '-'}
                      </td>
                      <td className="px-3 py-2 text-gray-700 max-w-[200px] truncate" title={previewResult.product.summary_info}>
                        {previewResult.product.summary_info || '-'}
                      </td>
                      <td className="px-3 py-2 text-gray-700 max-w-[160px] truncate" title={previewResult.product.english_name}>
                        {previewResult.product.english_name || '-'}
                      </td>
                      <td className="px-3 py-2 text-gray-700 max-w-[240px] truncate" title={previewResult.product.thumbnail_names.join(', ')}>
                        {previewResult.product.thumbnail_urls.length}장 — {previewResult.product.thumbnail_names.join(', ') || '-'}
                      </td>
                      <td className="px-3 py-2 text-gray-700 max-w-[240px] truncate" title={previewResult.product.detail_image_names.join(', ')}>
                        {previewResult.product.detail_image_urls.length}장 — {previewResult.product.detail_image_names.join(', ') || '-'}
                      </td>
                      {previewResult.product.options.map(o => (
                        <td key={o.name} className="px-3 py-2 text-gray-700 max-w-[240px] truncate" title={o.values.join(', ')}>
                          {o.values.join(', ')}
                        </td>
                      ))}
                      {Object.entries(previewResult.product.custom_fields || {})
                        .filter(([label]) => label in pickerRules)
                        .map(([label, value]) => (
                          <td key={label} className="px-3 py-2 text-gray-700 max-w-[240px] truncate" title={value}>
                            {value}
                          </td>
                        ))}
                    </tr>
                  </tbody>
                </table>
              </div>
              {previewResult.product.detail_text && (
                <div className="px-3 py-2 border-t border-gray-100 text-xs text-gray-500">
                  <span className="text-gray-400">상세페이지 텍스트: </span>
                  <span className="line-clamp-3">{previewResult.product.detail_text}</span>
                </div>
              )}
              {previewResult.product.extra_info.length > 0 && (
                <div className="px-3 py-2 border-t border-gray-100 text-xs text-gray-500">
                  <span className="text-gray-400">상품정보고시 전체: </span>
                  {previewResult.product.extra_info.map(({ label, value }) => `${label}: ${value}`).join(' / ')}
                </div>
              )}
              {Object.entries(previewResult.product.custom_fields || {}).filter(([label]) => !(label in pickerRules)).length > 0 && (
                <div className="px-3 py-2 border-t border-gray-100 text-xs text-gray-500">
                  <span className="text-gray-400">그 외 자동 스캔된 정보: </span>
                  {Object.entries(previewResult.product.custom_fields)
                    .filter(([label]) => !(label in pickerRules))
                    .map(([label, value]) => `${label}: ${value}`).join(' / ')}
                </div>
              )}
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
                      <th className="px-2 py-2 text-left w-14">이미지</th>
                      <th className="px-2 py-2 text-left">상품명</th>
                      <th className="px-2 py-2 text-left w-20">링크</th>
                    </tr>
                  </thead>
                  <tbody>
                    {previewItems.map(item => (
                      <tr key={item.url} className="border-b border-gray-100 last:border-0 hover:bg-gray-50">
                        <td className="px-2 py-1.5">
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
        <div className="bg-white rounded-2xl border border-gray-200 p-6 mb-4">
          <div className="flex items-center justify-between mb-3">
            <div className="text-sm font-semibold text-gray-700">🧩 개발자모드 스크랩 방법</div>
            <button onClick={() => handleCopyMallUrl(selectedSite.url)}
              className="text-xs text-teal-500 hover:underline shrink-0">{urlCopied ? '✓ 복사됨' : '몰 URL 복사'}</button>
          </div>
          <ol className="list-decimal list-inside text-sm text-gray-600 space-y-1">
            <li>{selectedSite.name || selectedSite.url}에 평소 쓰는 크롬으로 로그인한 상태로 상품 목록(카테고리) 페이지를 여세요.</li>
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
        <div className="mt-4 bg-white rounded-2xl border border-gray-200 p-5">
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
