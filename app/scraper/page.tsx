'use client'
import { useState, useEffect, useRef, useMemo } from 'react'
import Link from 'next/link'

type Status = 'idle' | 'running' | 'done' | 'error' | 'stopped'
type LoginStep = 'none' | 'opened' | 'confirmed'

interface Site {
  id: number
  name: string | null
  url: string
  login_id: string | null
}

const PLATFORM_LABELS: Record<string, string> = {
  cafe24: '카페24', makeshop: '메이크샵', godomall: '고도몰', unknown: '알 수 없음 (범용 방식 사용)',
}

interface PreviewProduct {
  name: string
  price: number | null
  sale_price: number | null
  brand: string
  manufacturer: string
  origin: string
  description: string
  options: { name: string; values: string[] }[]
  thumbnail_url: string
  detail_image_urls: string[]
}

export default function ScraperPage() {
  const [sites, setSites]         = useState<Site[]>([])
  const [siteQuery, setSiteQuery] = useState('')
  const [selectedSite, setSelectedSite] = useState<Site | null>(null)

  const [loginId, setLoginId]     = useState('')
  const [loginPw, setLoginPw]     = useState('')
  const [loginStep, setLoginStep] = useState<LoginStep>('none')
  const [loginBusy, setLoginBusy] = useState(false)

  const [targetUrl, setTargetUrl]           = useState('')
  const [categoryUrlsText, setCategoryUrlsText] = useState('')
  const [nextPageSelector, setNextPageSelector] = useState('')
  const [maxPages, setMaxPages]             = useState(1)
  const [delayMs, setDelayMs]               = useState(1000)

  const [categories, setCategories]         = useState<{ href: string; text: string }[]>([])
  const [categoriesLoading, setCategoriesLoading] = useState(false)
  const [detectedPlatform, setDetectedPlatform] = useState<string | null>(null)

  const [testResult, setTestResult]   = useState<{ total: number; samples: string[]; platform: string } | null>(null)
  const [testLoading, setTestLoading] = useState(false)

  const [previewResult, setPreviewResult]   = useState<{ sourceUrl: string; product: PreviewProduct } | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)

  const [mode, setMode]           = useState<'single' | 'catalog'>('single')
  const [scrapeMode, setScrapeMode] = useState<'full' | 'incremental'>('full')
  const [hasPriorSession, setHasPriorSession] = useState(false)
  const [linkSel, setLinkSel]     = useState('')
  const [status, setStatus]       = useState<Status>('idle')
  const [sessionId, setSessionId] = useState<number | null>(null)
  const [progress, setProgress]   = useState<{ saved: number; total: number; error?: string }>({ saved: 0, total: 0 })
  const [stopping, setStopping]   = useState(false)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    fetch('/api/sites').then(r => r.json()).then((d: Site[]) => { if (Array.isArray(d)) setSites(d) }).catch(() => {})
  }, [])

  const filteredSites = useMemo(() => {
    const q = siteQuery.trim().toLowerCase()
    if (!q) return sites
    return sites.filter(s => (s.name || '').toLowerCase().includes(q) || s.url.toLowerCase().includes(q))
  }, [sites, siteQuery])

  useEffect(() => {
    if (!sessionId || status !== 'running') return
    pollRef.current = setInterval(async () => {
      const r = await fetch(`/api/scrape/status?sessionId=${sessionId}`)
      const d = await r.json() as { status: string; product_count: number; saved_count: number; error?: string }
      setProgress({ saved: Number(d.saved_count) || 0, total: Number(d.product_count) || 0, error: d.error })
      if (d.status === 'done' || d.status === 'error' || d.status === 'stopped') {
        setStatus(d.status as Status)
        setStopping(false)
        if (pollRef.current) clearInterval(pollRef.current)
      }
    }, 2000)
    return () => { if (pollRef.current) clearInterval(pollRef.current) }
  }, [sessionId, status])

  async function selectSite(site: Site) {
    const res = await fetch(`/api/sites/${site.id}`)
    const full = await res.json() as Site & { login_pw: string | null }
    setSelectedSite(site)
    setLoginId(full.login_id || '')
    setLoginPw(full.login_pw || '')
    setLoginStep('none')
    setSiteQuery('')
    setTargetUrl(full.url)
    setCategoryUrlsText('') // 이전 사이트의 카테고리 목록이 남아 시작 URL을 무시하는 것을 방지
    setCategories([])
    setDetectedPlatform(null)
    setTestResult(null)
    setPreviewResult(null)
    setScrapeMode('full')
    fetch(`/api/products?siteId=${site.id}`).then(r => r.json()).then((d: unknown[]) => setHasPriorSession(Array.isArray(d) && d.length > 0)).catch(() => setHasPriorSession(false))
  }

  async function handleOpenLogin() {
    if (!selectedSite) return
    setLoginBusy(true)
    try {
      await fetch('/api/scrape/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ siteId: selectedSite.id, url: selectedSite.url, loginId, loginPw }),
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

  async function handleTest() {
    if (!selectedSite) return
    const categoryUrls = categoryUrlsText.split('\n').map(s => s.trim()).filter(Boolean)
    setTestLoading(true)
    setTestResult(null)
    setPreviewResult(null)
    try {
      const res = await fetch('/api/scrape/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: categoryUrls.length ? undefined : (targetUrl || undefined),
          categoryUrls: categoryUrls.length ? categoryUrls : undefined,
          nextPageSelector: nextPageSelector || undefined,
          maxPages,
          loginId: loginId || undefined, loginPw: loginPw || undefined,
          productLinkSelector: linkSel || undefined, siteId: selectedSite.id,
        }),
      })
      if (!res.ok) { const e = await res.json().catch(() => ({})); alert(`테스트 실패: ${e.error || res.status}`); return }
      const d = await res.json() as { total: number; samples: string[]; platform: string }
      setTestResult(d)
      setDetectedPlatform(d.platform || null)
    } finally {
      setTestLoading(false)
    }
  }

  const previewCandidateUrl = mode === 'catalog' ? (testResult?.samples[0] || '') : targetUrl

  async function handlePreview() {
    if (!selectedSite || !previewCandidateUrl) return
    setPreviewLoading(true)
    setPreviewResult(null)
    try {
      const res = await fetch('/api/scrape/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: previewCandidateUrl, siteId: selectedSite.id, loginId: loginId || undefined, loginPw: loginPw || undefined }),
      })
      if (!res.ok) { const e = await res.json().catch(() => ({})); alert(`미리보기 실패: ${e.error || res.status}`); return }
      const d = await res.json() as { sourceUrl: string; product: PreviewProduct }
      setPreviewResult(d)
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
  }

  async function handleStart() {
    if (!selectedSite || !canStart) return
    const categoryUrls = categoryUrlsText.split('\n').map(s => s.trim()).filter(Boolean)
    setStatus('running')
    setProgress({ saved: 0, total: 0 })
    const res = await fetch('/api/scrape', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: categoryUrls.length ? undefined : (targetUrl || undefined),
        categoryUrls: categoryUrls.length ? categoryUrls : undefined,
        nextPageSelector: mode === 'catalog' ? (nextPageSelector || undefined) : undefined,
        maxPages: mode === 'catalog' ? maxPages : undefined,
        delayMs: mode === 'catalog' ? delayMs : undefined,
        loginId: loginId || undefined, loginPw: loginPw || undefined,
        mode, scrapeMode, productLinkSelector: linkSel || undefined, siteId: selectedSite.id,
      }),
    })
    const data = await res.json() as { sessionId: number }
    setSessionId(data.sessionId)
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

  const statusColor = { idle: 'text-gray-500', running: 'text-indigo-600', done: 'text-emerald-600', error: 'text-red-600', stopped: 'text-amber-600' }
  const statusLabel = { idle: '대기 중', running: '스크래핑 중...', done: '완료', error: '오류 발생', stopped: '중지됨' }

  return (
    <div className="max-w-2xl">
      <h1 className="text-2xl font-bold text-gray-800 mb-6">🔍 스크래핑 설정</h1>

      {/* 쇼핑몰 선택 */}
      <div className="bg-white rounded-xl border border-gray-200 p-6 mb-4">
        <label className="block text-sm font-semibold text-gray-700 mb-2">쇼핑몰 선택 *</label>
        {sites.length === 0 ? (
          <div className="text-sm text-gray-400">
            등록된 쇼핑몰이 없습니다. <Link href="/sites" className="text-indigo-600 hover:underline">쇼핑몰 등록관리에서 추가하기 →</Link>
          </div>
        ) : selectedSite ? (
          <div className="flex items-center justify-between bg-indigo-50 rounded-lg px-3 py-2">
            <div>
              <div className="text-sm font-medium text-gray-800">{selectedSite.name || selectedSite.url}</div>
              <div className="text-xs text-gray-500">{selectedSite.url}</div>
            </div>
            <button onClick={() => { setSelectedSite(null); setLoginStep('none') }} className="text-xs text-gray-500 hover:underline">
              변경
            </button>
          </div>
        ) : (
          <div>
            <input value={siteQuery} onChange={e => setSiteQuery(e.target.value)} placeholder="이름 또는 URL 검색..."
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400" />
            <div className="mt-2 border border-gray-100 rounded-lg divide-y divide-gray-100 max-h-52 overflow-y-auto">
              {filteredSites.map(s => (
                <button key={s.id} onClick={() => selectSite(s)}
                  className="w-full text-left px-3 py-2 hover:bg-gray-50 transition-colors">
                  <div className="text-sm text-gray-800">{s.name || '(이름 없음)'}</div>
                  <div className="text-xs text-gray-500 truncate">{s.url}</div>
                </button>
              ))}
              {filteredSites.length === 0 && <div className="px-3 py-2 text-xs text-gray-400">검색 결과가 없습니다.</div>}
            </div>
          </div>
        )}
      </div>

      {/* 로그인 */}
      {selectedSite && (
        <div className="bg-white rounded-xl border border-gray-200 p-6 mb-4">
          <label className="block text-sm font-semibold text-gray-700 mb-3">로그인 정보</label>
          <div className="grid grid-cols-2 gap-3 mb-4">
            <div>
              <label className="block text-xs text-gray-500 mb-1">아이디 / 이메일</label>
              <input type="text" value={loginId} onChange={e => { setLoginId(e.target.value); setLoginStep('none') }}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400" />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">비밀번호</label>
              <input type="password" value={loginPw} onChange={e => { setLoginPw(e.target.value); setLoginStep('none') }}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400" />
            </div>
          </div>

          {needsLogin ? (
            <div className="flex items-center gap-3 flex-wrap">
              <button onClick={handleOpenLogin} disabled={loginBusy}
                className="px-4 py-2 bg-slate-600 hover:bg-slate-700 text-white text-sm font-semibold rounded-lg disabled:opacity-50 transition-colors">
                {loginStep === 'opened' || loginStep === 'confirmed' ? '로그인 창 다시 열기' : '로그인 창 열기'}
              </button>
              <button onClick={handleConfirmLogin} disabled={loginBusy || loginStep === 'none'}
                className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-semibold rounded-lg disabled:opacity-50 disabled:cursor-not-allowed transition-colors">
                로그인 확인
              </button>
              {loginStep === 'confirmed' && <span className="text-xs text-emerald-600 font-medium">✓ 로그인 확인됨 (스크래핑 시작 시 창은 자동으로 닫히고 백그라운드에서 진행됩니다)</span>}
              {loginStep === 'opened' && <span className="text-xs text-gray-500">브라우저 창에서 로그인을 완료한 뒤 확인을 눌러주세요.</span>}
            </div>
          ) : (
            <p className="text-xs text-gray-400">아이디를 입력하지 않으면 로그인 없이 바로 스크래핑을 시작할 수 있습니다.</p>
          )}
        </div>
      )}

      {/* 스크랩 대상 */}
      {selectedSite && (
        <div className="bg-white rounded-xl border border-gray-200 p-6 mb-4">
          {hasPriorSession && (
            <>
              <label className="block text-sm font-semibold text-gray-700 mb-2">재스크랩 방식</label>
              <div className="flex gap-3 mb-4">
                {([
                  { id: 'full' as const, label: '전체 재스크랩' },
                  { id: 'incremental' as const, label: '증분 (변동사항만)' },
                ]).map(m => (
                  <button key={m.id} onClick={() => setScrapeMode(m.id)}
                    className={`px-4 py-2 rounded-lg text-sm font-medium border transition-colors ${scrapeMode === m.id ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-white text-gray-600 border-gray-300 hover:border-emerald-400'}`}>
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
          <label className="block text-sm font-semibold text-gray-700 mb-2">스크랩 모드</label>
          <div className="flex gap-3 mb-4">
            {(['single', 'catalog'] as const).map(m => (
              <button key={m} onClick={() => { setMode(m); setPreviewResult(null) }}
                className={`px-4 py-2 rounded-lg text-sm font-medium border transition-colors ${mode === m ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white text-gray-600 border-gray-300 hover:border-indigo-400'}`}>
                {m === 'single' ? '단일 상품 페이지' : '목록/카탈로그 페이지'}
              </button>
            ))}
          </div>

          <label className="block text-xs text-gray-500 mb-1">
            시작 URL {loginStep === 'confirmed' && '(로그인 창에서 이동한 페이지를 그대로 사용할 수 있습니다)'}
          </label>
          <div className="flex gap-2 mb-1">
            <input value={targetUrl} onChange={e => setTargetUrl(e.target.value)}
              placeholder="https://shop.example.com/products/123"
              disabled={mode === 'catalog' && categoryUrlsText.trim().length > 0}
              className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400 disabled:bg-gray-100 disabled:text-gray-400" />
            {loginStep === 'confirmed' && (
              <button onClick={handleRefreshCurrentUrl} title="로그인 창에서 현재 보고 있는 페이지로 갱신"
                className="px-3 py-2 bg-gray-100 hover:bg-gray-200 text-gray-600 text-xs font-medium rounded-lg transition-colors shrink-0">
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
              <label className="block text-xs text-gray-500 mb-1">제품 링크 CSS 셀렉터 (비워두면 이미지가 있는 링크만 자동으로 제품으로 인식)</label>
              <input value={linkSel} onChange={e => setLinkSel(e.target.value)}
                placeholder=".product-list a, .item-card a"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400 mb-3" />

              <div className="flex items-center justify-between mb-1">
                <label className="block text-xs text-gray-500">카테고리 URL 목록 (한 줄에 하나씩, 입력 시 위 시작 URL 대신 각각 스크랩)</label>
                <button type="button" onClick={handleLoadCategories} disabled={categoriesLoading || !targetUrl}
                  className="text-xs text-indigo-600 hover:underline disabled:opacity-50 disabled:cursor-not-allowed shrink-0 ml-2">
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
                <div className="mb-2 border border-gray-200 rounded-lg overflow-hidden">
                  <div className="flex items-center justify-between px-3 py-1.5 bg-gray-50 border-b border-gray-100">
                    <span className="text-xs text-gray-500">발견된 링크 {categories.length}개 — 스크랩할 항목을 선택하세요</span>
                    <button type="button" onClick={toggleAllCategories} className="text-xs text-indigo-600 hover:underline shrink-0">
                      {categories.every(c => isCategorySelected(c.href)) ? '전체 해제' : '전체 선택 (몰 전체상품)'}
                    </button>
                  </div>
                  <div className="max-h-40 overflow-y-auto divide-y divide-gray-100">
                    {categories.map(c => (
                      <label key={c.href} className="flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-gray-50 cursor-pointer">
                        <input type="checkbox" checked={isCategorySelected(c.href)} onChange={() => toggleCategory(c.href)} className="shrink-0" />
                        <span className="text-gray-700 shrink-0">{c.text}</span>
                        <span className="text-gray-400 truncate">{c.href}</span>
                      </label>
                    ))}
                  </div>
                </div>
              )}

              <textarea value={categoryUrlsText} onChange={e => setCategoryUrlsText(e.target.value)} rows={3}
                placeholder={'https://shop.example.com/category/food\nhttps://shop.example.com/category/beauty'}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400 mb-3" />

              <div className="grid grid-cols-3 gap-3 mb-4">
                <div>
                  <label className="block text-xs text-gray-500 mb-1">다음 페이지 셀렉터 (페이지네이션, 선택)</label>
                  <input value={nextPageSelector} onChange={e => setNextPageSelector(e.target.value)}
                    placeholder=".pagination .next"
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400" />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">최대 페이지 수</label>
                  <input type="number" min={1} value={maxPages} onChange={e => setMaxPages(Math.max(1, Number(e.target.value) || 1))}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400" />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">상품 페이지 간 지연 (ms, 차단 방지)</label>
                  <input type="number" min={0} step={100} value={delayMs} onChange={e => setDelayMs(Math.max(0, Number(e.target.value) || 0))}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400" />
                </div>
              </div>

              <button type="button" onClick={handleTest} disabled={testLoading || (!targetUrl && !categoryUrlsText.trim())}
                className="w-full py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 text-sm font-semibold rounded-lg disabled:opacity-50 disabled:cursor-not-allowed transition-colors">
                {testLoading ? '테스트 중...' : '🧪 테스트 실행 (실제로 저장하지 않고 몇 개 잡히는지만 확인)'}
              </button>

              {testResult && (
                <div className="mt-3 border border-gray-200 rounded-lg overflow-hidden">
                  <div className="px-3 py-2 bg-gray-50 border-b border-gray-100 text-xs text-gray-600">
                    상품 링크 <strong>{testResult.total}</strong>개 발견 — 감지된 몰 유형: {PLATFORM_LABELS[testResult.platform] || testResult.platform}
                  </div>
                  {testResult.samples.length > 0 && (
                    <div className="max-h-32 overflow-y-auto divide-y divide-gray-100">
                      {testResult.samples.map(url => (
                        <div key={url} className="px-3 py-1.5 text-xs text-gray-500 truncate">{url}</div>
                      ))}
                    </div>
                  )}
                  {testResult.total === 0 && (
                    <p className="px-3 py-2 text-xs text-red-500">매칭되는 상품 링크가 없습니다. 셀렉터나 시작 URL을 확인해주세요.</p>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* 상품 페이지 미리보기 */}
      {selectedSite && (
        <div className="bg-white rounded-xl border border-gray-200 p-6 mb-4">
          <div className="flex items-center justify-between mb-2">
            <label className="block text-sm font-semibold text-gray-700">상품 페이지 미리보기</label>
            <button type="button" onClick={handlePreview} disabled={previewLoading || !previewCandidateUrl}
              className="text-xs text-indigo-600 hover:underline disabled:opacity-50 disabled:cursor-not-allowed shrink-0">
              {previewLoading ? '불러오는 중...' : '🔍 상품 페이지 열어서 확인'}
            </button>
          </div>

          {mode === 'catalog' && !previewCandidateUrl && (
            <p className="text-xs text-gray-400">먼저 위에서 &quot;테스트 실행&quot;으로 상품 링크를 찾아야 미리볼 수 있습니다.</p>
          )}
          {mode === 'single' && !previewCandidateUrl && (
            <p className="text-xs text-gray-400">시작 URL을 입력하면 실제로 열어서 추출될 내용을 미리 확인할 수 있습니다.</p>
          )}

          {previewResult && (
            <div className="mt-2 border border-gray-200 rounded-lg overflow-hidden">
              <div className="px-3 py-2 bg-gray-50 border-b border-gray-100 text-xs text-gray-500 truncate">{previewResult.sourceUrl}</div>
              <div className="p-3 flex gap-3">
                {previewResult.product.thumbnail_url && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={previewResult.product.thumbnail_url} alt="" className="w-20 h-20 object-cover rounded-lg border border-gray-100 shrink-0" />
                )}
                <div className="flex-1 min-w-0 text-xs space-y-1">
                  <div className="font-semibold text-gray-800 text-sm truncate">
                    {previewResult.product.name || <span className="text-red-500">상품명을 찾지 못했습니다</span>}
                  </div>
                  <div className="text-gray-600">
                    가격: {previewResult.product.price != null ? `₩${previewResult.product.price.toLocaleString()}` : <span className="text-red-500">찾지 못함</span>}
                  </div>
                  <div className="text-gray-500">
                    브랜드: {previewResult.product.brand || '-'} · 제조사: {previewResult.product.manufacturer || '-'} · 원산지: {previewResult.product.origin || '-'}
                  </div>
                  {previewResult.product.options.length > 0 && (
                    <div className="text-gray-500">
                      옵션: {previewResult.product.options.map(o => `${o.name}(${o.values.length}개)`).join(', ')}
                    </div>
                  )}
                  {previewResult.product.description && (
                    <div className="text-gray-400 line-clamp-2">{previewResult.product.description}</div>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* 실행 버튼 */}
      {status === 'running' ? (
        <button onClick={handleStop} disabled={stopping}
          className="w-full py-3 rounded-xl bg-red-500 text-white font-semibold text-sm hover:bg-red-600 disabled:opacity-50 transition-colors">
          {stopping ? '중지 처리 중...' : '⏸ 스크래핑 중지'}
        </button>
      ) : (
        <button onClick={handleStart} disabled={!canStart}
          className="w-full py-3 rounded-xl bg-indigo-600 text-white font-semibold text-sm hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors">
          {status === 'stopped' || status === 'error' ? '이어서 스크랩하기 (기존 상품 제외)' : '스크래핑 시작'}
        </button>
      )}

      {/* 진행 상황 */}
      {status !== 'idle' && (
        <div className="mt-4 bg-white rounded-xl border border-gray-200 p-5">
          <div className="flex items-center justify-between mb-3">
            <span className="text-sm font-semibold text-gray-700">진행 상황</span>
            <span className={`text-sm font-semibold ${statusColor[status]}`}>{statusLabel[status]}</span>
          </div>
          {status === 'running' && (
            <div className="w-full bg-gray-100 rounded-full h-2 mb-3">
              <div className="bg-indigo-500 h-2 rounded-full transition-all"
                style={{ width: progress.total > 0 ? `${Math.round(progress.saved / progress.total * 100)}%` : '10%' }} />
            </div>
          )}
          <p className="text-sm text-gray-600">
            수집 완료: <strong>{progress.saved}</strong>개 {progress.total > 0 && `/ ${progress.total}개`}
          </p>
          {(status === 'error' || status === 'stopped') && (
            <>
              {progress.error && <p className="mt-2 text-xs text-red-500 break-all">{progress.error}</p>}
              <button onClick={handleBackToSettings}
                className="mt-3 px-4 py-2 bg-gray-100 hover:bg-gray-200 text-gray-700 text-sm font-medium rounded-lg transition-colors">
                ← 설정 화면으로 돌아가기
              </button>
            </>
          )}
          {status === 'done' && (
            <a href="/products" className="mt-3 inline-block text-sm text-indigo-600 font-medium hover:underline">
              → 상품 목록 확인
            </a>
          )}
        </div>
      )}
    </div>
  )
}
