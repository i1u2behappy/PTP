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

  const [mode, setMode]           = useState<'single' | 'catalog'>('single')
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
        loginId: loginId || undefined, loginPw: loginPw || undefined,
        mode, productLinkSelector: linkSel || undefined, siteId: selectedSite.id,
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
              {loginStep === 'confirmed' && <span className="text-xs text-emerald-600 font-medium">✓ 로그인 확인됨 (창은 열린 채로 유지됩니다)</span>}
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
          <label className="block text-sm font-semibold text-gray-700 mb-2">스크랩 모드</label>
          <div className="flex gap-3 mb-4">
            {(['single', 'catalog'] as const).map(m => (
              <button key={m} onClick={() => setMode(m)}
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

              <label className="block text-xs text-gray-500 mb-1">카테고리 URL 목록 (한 줄에 하나씩, 입력 시 위 시작 URL 대신 각각 스크랩)</label>
              <textarea value={categoryUrlsText} onChange={e => setCategoryUrlsText(e.target.value)} rows={3}
                placeholder={'https://shop.example.com/category/food\nhttps://shop.example.com/category/beauty'}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400 mb-3" />

              <div className="grid grid-cols-2 gap-3">
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
              </div>
            </>
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
