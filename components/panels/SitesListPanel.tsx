'use client'
import { useEffect, useState, useCallback } from 'react'
import { useTabs } from '../shell/TabsContext'
import { SITES_LIST_TAB } from '../shell/menuTabs'

interface Site {
  id: number
  name: string | null
  url: string
  login_id: string | null
  login_pw_masked: string | null
  client_name: string | null
  blocked: boolean
  manual_login_required: boolean
  latest_memo: string | null
  created_at: string
}

export function SitesListPanel() {
  const { openTab, refreshSignals, bumpRefresh } = useTabs()
  const [sites, setSites] = useState<Site[]>([])
  const [q, setQ] = useState('')
  const [loadError, setLoadError] = useState(false)
  const [rescrapingAll, setRescrapingAll] = useState(false)

  const load = useCallback((query: string) => {
    fetch(`/api/sites?q=${encodeURIComponent(query)}`).then(r => {
      if (!r.ok) throw new Error()
      return r.json()
    }).then((d: Site[]) => {
      if (Array.isArray(d)) { setSites(d); setLoadError(false) }
    }).catch(() => setLoadError(true))
  }, [])

  useEffect(() => { load(q) }, [load, q, refreshSignals.sites])

  function openDetail(site?: Site) {
    openTab({ ...SITES_LIST_TAB, type: 'site-detail', params: site ? { siteId: site.id } : undefined })
  }

  function openScraper(site: Site) {
    openTab({ id: 'scraper', type: 'scraper', title: '스크래핑', icon: '🔍', params: { siteId: site.id }, closable: true })
  }

  async function handleDelete(id: number) {
    if (!confirm('이 Mall 등록 정보를 삭제할까요?')) return
    try {
      const res = await fetch(`/api/sites/${id}`, { method: 'DELETE' })
      if (!res.ok) throw new Error(`서버 오류 (${res.status})`)
      load(q)
    } catch (e) {
      alert(`삭제에 실패했습니다: ${e instanceof Error ? e.message : e}`)
    }
  }

  async function handleRescrapeAll() {
    if (!confirm('마지막으로 스크랩 설정이 저장된 모든 Mall을 증분 재스크랩할까요? 각 Mall은 백그라운드에서 실행됩니다.')) return
    setRescrapingAll(true)
    try {
      const res = await fetch('/api/scrape/all', { method: 'POST' })
      const d = await res.json() as { started: number; skipped: number }
      alert(`${d.started}개 Mall 재스크랩을 시작했습니다${d.skipped > 0 ? ` (스크랩 설정이 없어 ${d.skipped}개는 건너뜀)` : ''}. 스크랩 검토 화면에서 결과를 확인하세요.`)
      bumpRefresh('staging')
    } catch (e) {
      alert(`전체 재스크랩 실행에 실패했습니다: ${e instanceof Error ? e.message : e}`)
    } finally {
      setRescrapingAll(false)
    }
  }

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center justify-between mb-6 shrink-0">
        <h1 className="text-2xl font-bold text-gray-800">🏬 Mall 관리</h1>
        <div className="flex gap-2">
          <button onClick={handleRescrapeAll} disabled={rescrapingAll}
            className="px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 text-sm font-semibold rounded-full disabled:opacity-50 transition-colors">
            {rescrapingAll ? '실행 중...' : '🔄 전체 Mall 재스크랩'}
          </button>
          <button onClick={() => openDetail()}
            className="px-4 py-2 bg-teal-500 hover:bg-teal-600 text-white text-sm font-semibold rounded-full transition-colors">
            ➕ 새 Mall 등록
          </button>
        </div>
      </div>

      <div className="mb-4 shrink-0">
        <input value={q} onChange={e => setQ(e.target.value)} placeholder="이름 또는 URL 검색..."
          className="w-full max-w-md border border-gray-300 rounded-full px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-400" />
      </div>

      {loadError ? (
        <div className="bg-white rounded-2xl border border-gray-200 p-8 text-center text-sm text-rose-500">목록을 불러오지 못했습니다. 서버(DB) 연결을 확인해주세요.</div>
      ) : sites.length === 0 ? (
        <div className="bg-white rounded-2xl border border-gray-200 p-8 text-center text-sm text-gray-400">등록된 Mall이 없습니다.</div>
      ) : (
        <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden flex-1 min-h-0 flex flex-col">
          <div className="overflow-auto flex-1 min-h-0">
            <table className="text-xs border-collapse whitespace-nowrap">
              <thead className="sticky top-0 z-10 bg-gray-50">
                <tr className="border-b border-gray-200 text-gray-500 font-semibold">
                  <th className="px-3 py-2 text-left sticky left-0 bg-gray-50 z-20">이름</th>
                  <th className="px-3 py-2 text-left">URL</th>
                  <th className="px-3 py-2 text-left">로그인ID</th>
                  <th className="px-3 py-2 text-left">비밀번호</th>
                  <th className="px-3 py-2 text-left">거래처</th>
                  <th className="px-3 py-2 text-left">상태</th>
                  <th className="px-3 py-2 text-left">메모</th>
                  <th className="px-3 py-2 text-left">등록일</th>
                  <th className="px-3 py-2 text-left">관리</th>
                </tr>
              </thead>
              <tbody>
                {sites.map(s => (
                  <tr key={s.id} onClick={() => openScraper(s)} className="border-b border-gray-100 hover:bg-gray-50 cursor-pointer transition-colors">
                    <td className="px-3 py-2 text-gray-800 font-medium sticky left-0 bg-white">
                      {s.name || '(이름 없음)'}
                      {s.manual_login_required && (
                        <span className="ml-1.5 px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700 text-[10px] font-semibold whitespace-nowrap" title="Windows Hello/WebAuthn 등으로 자동 로그인이 안 되는 몰 — 직접 로그인 필요">
                          🔒 직접로그인 필수
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-gray-500 max-w-[280px] truncate" title={s.url}>{s.url}</td>
                    <td className="px-3 py-2 text-gray-500">{s.login_id || '-'}</td>
                    <td className="px-3 py-2 text-gray-500 font-mono">{s.login_pw_masked || '-'}</td>
                    <td className="px-3 py-2 text-teal-600">{s.client_name || '-'}</td>
                    <td className="px-3 py-2">{s.blocked ? <span className="font-semibold text-rose-500">차단</span> : <span className="text-emerald-600">정상</span>}</td>
                    <td className="px-3 py-2 text-gray-500 max-w-xl whitespace-normal break-words">{s.latest_memo || '-'}</td>
                    <td className="px-3 py-2 text-gray-400">{new Date(s.created_at).toLocaleDateString()}</td>
                    <td className="px-3 py-2" onClick={e => e.stopPropagation()}>
                      <button onClick={() => openDetail(s)} className="text-teal-500 hover:underline mr-2">수정</button>
                      <button onClick={() => handleDelete(s.id)} className="text-rose-500 hover:underline">삭제</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
