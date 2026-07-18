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
  manual_login_required?: boolean
  profile_dir?: string
  client_id?: number | null
  client_name?: string | null
  main_items?: string | null
}

interface Client { id: number; name: string }

const PLATFORM_LABELS: Record<string, string> = {
  cafe24: '카페24', makeshop: '메이크샵', godomall: '고도몰', unknown: '알 수 없음 (범용 방식 사용)',
}

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
}

interface PreviewItem {
  url: string
  name: string
  thumbnail: string
}

/** 값을 클립보드에 복사하는 작은 버튼 — 직접로그인 필수 몰에서 별도로 뜬 크롬 창에 아이디/비번을 옮겨 붙일 때 씀. */
function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false)
  if (!value) return null
  return (
    <button type="button" onClick={() => navigator.clipboard.writeText(value).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200) }).catch(() => {})}
      className="text-[11px] text-teal-500 hover:text-teal-600 shrink-0" tabIndex={-1}>
      {copied ? '✓ 복사됨' : '복사'}
    </button>
  )
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

  const [loginId, setLoginId]     = useState('')
  const [loginPw, setLoginPw]     = useState('')
  const [loginStep, setLoginStep] = useState<LoginStep>('none')
  const [loginBusy, setLoginBusy] = useState(false)

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
  const [previewTotal, setPreviewTotal]     = useState<number | null>(null)
  const [previewItems, setPreviewItems]     = useState<PreviewItem[]>([])
  const [previewLoading, setPreviewLoading] = useState(false)

  const [mode, setMode]           = useState<'single' | 'catalog'>('catalog')
  const [scrapeMode, setScrapeMode] = useState<'full' | 'incremental'>('full')
  const [hasPriorSession, setHasPriorSession] = useState(false)
  const [linkSel, setLinkSel]     = useState('')
  const [status, setStatus]       = useState<Status>('idle')
  const [sessionId, setSessionId] = useState<number | null>(null)
  const [progress, setProgress]   = useState<{ saved: number; total: number; error?: string }>({ saved: 0, total: 0 })
  const [stopping, setStopping]   = useState(false)
  const [itemLog, setItemLog]     = useState<ItemLogRow[]>([])
  const [retrying, setRetrying]   = useState(false)
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

  const failedUrls = itemLog.filter(r => r.status === 'failed').map(r => r.url)

  async function selectSite(siteId: number) {
    const res = await fetch(`/api/sites/${siteId}`)
    if (!res.ok) { alert(`Mall 정보를 불러오지 못했습니다 (${res.status})`); return }
    const full = await res.json() as Site & { login_pw: string | null }
    setSelectedSite({
      id: full.id, name: full.name, url: full.url, login_url: full.login_url, login_id: full.login_id,
      manual_login_required: full.manual_login_required, profile_dir: full.profile_dir,
    })
    setLoginId(full.login_id || '')
    setLoginPw(full.login_pw || '')
    setLoginStep('none')
    setSiteQuery('')
    setTargetUrl(full.url)
    setCategoryUrlsText('') // 이전 사이트의 카테고리 목록이 남아 시작 URL을 무시하는 것을 방지
    setCategories([])
    setDetectedPlatform(null)
    setPreviewResult(null)
    setPreviewTotal(null)
    setPreviewItems([])
    setScrapeMode('full')
    fetch(`/api/products?siteId=${siteId}`).then(r => r.json()).then((d: unknown[]) => setHasPriorSession(Array.isArray(d) && d.length > 0)).catch(() => setHasPriorSession(false))
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
    } finally {
      setLoginBusy(false)
    }
  }

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
            {selectedSite && (
              <div className="mb-3 bg-teal-50 rounded-xl px-3 py-2">
                <div className="text-sm font-medium text-gray-800">{selectedSite.name || selectedSite.url}</div>
                <div className="text-xs text-gray-500">{selectedSite.url}</div>
              </div>
            )}
            <div className="border border-gray-100 rounded-xl max-h-64 overflow-y-auto">
              {filteredSites.length === 0 ? (
                <div className="px-3 py-3 text-xs text-gray-400 text-center">검색 결과가 없습니다.</div>
              ) : (
                <table className="w-full text-xs border-collapse">
                  <thead className="sticky top-0 z-10 bg-gray-50">
                    <tr className="border-b border-gray-200 text-gray-500 font-semibold">
                      <th className="px-3 py-2 text-left whitespace-nowrap">Mall 이름</th>
                      <th className="px-3 py-2 text-left whitespace-nowrap">메인 품목</th>
                      <th className="px-3 py-2 text-left whitespace-nowrap">거래처</th>
                      <th className="px-3 py-2 text-left">URL</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredSites.map(s => (
                      <tr key={s.id} onClick={() => selectSite(s.id)}
                        className="border-b border-gray-100 last:border-0 hover:bg-gray-50 cursor-pointer transition-colors">
                        <td className="px-3 py-2 text-gray-800 font-medium whitespace-nowrap">{s.name || '(이름 없음)'}</td>
                        <td className="px-3 py-2 text-gray-500 max-w-[160px] truncate" title={s.main_items || ''}>{s.main_items || '-'}</td>
                        <td className="px-3 py-2 text-teal-600 whitespace-nowrap">{s.client_name || '-'}</td>
                        <td className="px-3 py-2 text-gray-500 max-w-[240px] truncate" title={s.url}>{s.url}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        )}
      </div>

      {/* 로그인 */}
      {selectedSite && (
        <div className="bg-white rounded-2xl border border-gray-200 p-6 mb-4">
          <div className="text-sm font-semibold text-gray-700 mb-3">로그인 정보</div>
          {selectedSite.manual_login_required && (
            <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2 mb-3">
              🔒 이 몰은 윈도우 인증(PC인증) 등의 필요로 &quot;직접 로그인&quot;이 필요합니다. 평소 쓰는 크롬 창을 먼저
              닫고 &quot;로그인 창 열기&quot;를 누르면 본인 크롬 프로필이 뜹니다 — 로그인(필요시 PC인증)까지 마친 뒤
              창을 닫고 &quot;로그인 확인&quot;을 눌러주세요. 스크랩하는 동안에도 같은 프로필을 쓰므로, 그동안은
              크롬을 닫아둬야 합니다(다른 브라우저는 자유롭게 사용 가능).
            </p>
          )}
          <div className="grid grid-cols-2 gap-3 mb-4">
            <label className="block">
              <span className="flex items-center justify-between text-xs text-gray-500 mb-1">
                아이디 / 이메일
                {selectedSite.manual_login_required && <CopyButton value={loginId} />}
              </span>
              <input type="text" value={loginId} onChange={e => { setLoginId(e.target.value); setLoginStep('none') }}
                className="w-full border border-gray-300 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-400" />
            </label>
            <label className="block">
              <span className="flex items-center justify-between text-xs text-gray-500 mb-1">
                비밀번호
                {selectedSite.manual_login_required && <CopyButton value={loginPw} />}
              </span>
              <input type="password" value={loginPw} onChange={e => { setLoginPw(e.target.value); setLoginStep('none') }}
                className="w-full border border-gray-300 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-400" />
            </label>
          </div>

          {needsLogin ? (
            <div className="flex items-center gap-3 flex-wrap">
              <button onClick={handleOpenLogin} disabled={loginBusy}
                className="px-4 py-2 bg-teal-500 hover:bg-teal-600 text-white text-sm font-semibold rounded-full disabled:opacity-50 transition-colors">
                {loginStep === 'opened' || loginStep === 'confirmed' ? '로그인 창 다시 열기' : '로그인 창 열기'}
              </button>
              <button onClick={handleConfirmLogin} disabled={loginBusy || loginStep === 'none'}
                className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-semibold rounded-full disabled:opacity-50 disabled:cursor-not-allowed transition-colors">
                로그인 확인
              </button>
              {loginStep === 'confirmed' && <span className="text-xs text-emerald-600 font-medium">✓ 로그인 확인됨 (스크래핑 시작 시 창은 자동으로 닫히고 백그라운드에서 진행됩니다)</span>}
              {loginStep === 'opened' && (
                <span className="text-xs text-gray-500">
                  {selectedSite.manual_login_required ? '뜬 창에서 직접 로그인(PC인증 포함)을 완료한 뒤 확인을 눌러주세요.' : '브라우저 창에서 로그인을 완료한 뒤 확인을 눌러주세요.'}
                </span>
              )}
            </div>
          ) : (
            <p className="text-xs text-gray-400">아이디를 입력하지 않으면 로그인 없이 바로 스크래핑을 시작할 수 있습니다.</p>
          )}
        </div>
      )}

      {/* 스크랩 대상 */}
      {selectedSite && (
        <div className="bg-white rounded-2xl border border-gray-200 p-6 mb-4">
          {hasPriorSession && (
            <>
              <div className="text-sm font-semibold text-gray-700 mb-2">재스크랩 방식</div>
              <div className="flex gap-3 mb-4">
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
              {scrapeMode === 'incremental' && (
                <p className="text-xs text-gray-500 mb-4">
                  이전에 스크랩된 상품 중 재고/가격이 바뀐 것만 이력에 남기고, 이번 회차에 안 보이는 기존 상품은 단종 추정으로 표시합니다.
                </p>
              )}
            </>
          )}
          <div className="text-sm font-semibold text-gray-700 mb-2">스크랩 모드</div>
          <div className="flex gap-3 mb-4">
            {(['catalog', 'single'] as const).map(m => (
              <button key={m} onClick={() => { setMode(m); setPreviewResult(null); setPreviewTotal(null); setPreviewItems([]) }}
                className={`px-4 py-2 rounded-full text-sm font-medium border transition-colors ${mode === m ? 'bg-teal-500 text-white border-teal-500' : 'bg-white text-gray-600 border-gray-300 hover:border-teal-400'}`}>
                {m === 'single' ? '단일 상품 페이지' : '카테고리/목록 페이지'}
              </button>
            ))}
          </div>

          <div className="flex gap-2 mb-1 items-end">
            <label className="flex-1 block">
              <span className="block text-xs text-gray-500 mb-1">
                시작 URL {loginStep === 'confirmed' && !selectedSite.manual_login_required && '(로그인 창에서 이동한 페이지를 그대로 사용할 수 있습니다)'}
              </span>
              <input value={targetUrl} onChange={e => setTargetUrl(e.target.value)}
                placeholder="https://shop.example.com/products/123"
                disabled={mode === 'catalog' && categoryUrlsText.trim().length > 0}
                className="w-full border border-gray-300 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-400 disabled:bg-gray-100 disabled:text-gray-400" />
            </label>
            {selectedSite.manual_login_required ? (
              <span className="px-3 py-2 text-xs text-gray-400 shrink-0">이 몰은 직접로그인 몰이라 시작페이지를 직접 입력해 주세요</span>
            ) : loginStep === 'confirmed' && (
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
      {selectedSite && (
        <div className="bg-white rounded-2xl border border-gray-200 p-6 mb-4">
          <div className="flex items-center justify-between mb-2">
            <label className="block text-sm font-semibold text-gray-700">상품 페이지 미리보기</label>
            <button type="button" onClick={handlePreview} disabled={previewLoading || !canPreview}
              className="px-4 py-2 bg-teal-500 hover:bg-teal-600 text-white text-sm font-semibold rounded-full disabled:opacity-50 disabled:cursor-not-allowed transition-colors shrink-0">
              {previewLoading ? '확인 중...' : '🔍 스크랩 미리보기'}
            </button>
          </div>

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
            </div>
          )}

          {previewItems.length > 0 && (
            <div className="mt-2 border border-gray-200 rounded-xl overflow-hidden">
              <div className="px-3 py-2 bg-gray-50 border-b border-gray-100 text-xs text-gray-500">
                나머지 {previewItems.length}개 (목록 페이지 기준 정보만 — 직접 열어보지 않아 빠릅니다)
              </div>
              <div className="max-h-72 overflow-y-auto">
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

      {/* 실행 버튼 */}
      {status === 'running' ? (
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

          {itemLog.length > 0 && (
            <div className="mt-3 border border-gray-100 rounded-xl overflow-hidden">
              <div className="max-h-40 overflow-y-auto divide-y divide-gray-100">
                {itemLog.map(row => (
                  <div key={row.id} className="flex items-center gap-2 px-3 py-1.5 text-xs">
                    <span className={row.status === 'success' ? 'text-emerald-600' : 'text-rose-500'}>
                      {row.status === 'success' ? '✓' : '✗'}
                    </span>
                    <span className="text-gray-500 truncate flex-1" title={row.error || undefined}>{row.url}</span>
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
