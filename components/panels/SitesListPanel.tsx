'use client'
import { useEffect, useState, useCallback } from 'react'
import { useTabs } from '../shell/TabsContext'

interface Site {
  id: number
  name: string | null
  url: string
  login_id: string | null
  created_at: string
}

export function SitesListPanel() {
  const { openTab, refreshSignals } = useTabs()
  const [sites, setSites] = useState<Site[]>([])
  const [q, setQ] = useState('')
  const [loadError, setLoadError] = useState(false)

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
    openTab(site
      ? { id: `site-detail:${site.id}`, type: 'site-detail', title: site.name || site.url, icon: '🏬', params: { siteId: site.id }, closable: true }
      : { id: 'site-detail:new', type: 'site-detail', title: '새 쇼핑몰 등록', icon: '➕', closable: true },
    )
  }

  async function handleDelete(id: number) {
    if (!confirm('이 쇼핑몰 등록 정보를 삭제할까요?')) return
    try {
      const res = await fetch(`/api/sites/${id}`, { method: 'DELETE' })
      if (!res.ok) throw new Error(`서버 오류 (${res.status})`)
      load(q)
    } catch (e) {
      alert(`삭제에 실패했습니다: ${e instanceof Error ? e.message : e}`)
    }
  }

  return (
    <div className="max-w-4xl">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-gray-800">🏬 쇼핑몰 관리</h1>
        <button onClick={() => openDetail()}
          className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-semibold rounded-lg transition-colors">
          ➕ 새 쇼핑몰 등록
        </button>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-100 bg-gray-50">
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="이름 또는 URL 검색..."
            className="w-full border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400" />
        </div>
        {loadError ? (
          <div className="p-8 text-center text-sm text-red-500">목록을 불러오지 못했습니다. 서버(DB) 연결을 확인해주세요.</div>
        ) : sites.length === 0 ? (
          <div className="p-8 text-center text-sm text-gray-400">등록된 쇼핑몰이 없습니다.</div>
        ) : (
          <div className="divide-y divide-gray-100">
            {sites.map(s => (
              <div key={s.id} className="flex items-center gap-3 px-4 py-3 hover:bg-gray-50 transition-colors">
                <button onClick={() => openDetail(s)} className="flex-1 min-w-0 text-left">
                  <div className="text-sm font-medium text-gray-800">{s.name || '(이름 없음)'}</div>
                  <div className="text-xs text-gray-500 truncate">{s.url}</div>
                  {s.login_id && <div className="text-xs text-gray-400">ID: {s.login_id}</div>}
                </button>
                <button onClick={() => openDetail(s)} className="text-xs text-indigo-600 hover:underline shrink-0">수정</button>
                <button onClick={() => handleDelete(s.id)} className="text-xs text-red-500 hover:underline shrink-0">삭제</button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
