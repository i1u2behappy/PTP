'use client'
import { useEffect, useState, useRef } from 'react'
import { ScrapeSessionGrid } from './ScrapeSessionGrid'

interface Client { id: number; name: string }
interface Site { id: number; name: string | null; url: string; client_id: number | null }
interface Session {
  id: number
  site_id: number
  url: string
  status: string
  found_count: number
  staged_count: number
  pending_count: number
  created_at: string
  merged_at: string | null
}

export interface ScrapeScope { clientId: number | ''; siteId: number | ''; sessionId: number | '' }

/**
 * 마이그레이션 하위 메뉴 공용 상단 바 — 거래처/몰 조회 + 세션 검색·선택. MigrationDashboardPanel의 상단
 * 조회 UI와 동일한 패턴을 공유해, 각 하위 메뉴가 독립적으로 스크랩 세션을 골라 그 범위로 작업할 수 있게 한다.
 * 세션을 고르면 그 세션이 속한 몰/거래처까지 함께 onScopeChange로 알려준다.
 */
export function ScrapeScopePicker({ initialSiteId, initialSessionId, onScopeChange }: {
  initialSiteId?: number
  initialSessionId?: number
  onScopeChange: (scope: ScrapeScope) => void
}) {
  const wantedSessionId = useRef(initialSessionId)
  const [clients, setClients] = useState<Client[]>([])
  const [clientId, setClientId] = useState<number | ''>('')
  const [sites, setSites] = useState<Site[]>([])
  const [siteId, setSiteId] = useState<number | ''>(initialSiteId ?? '')
  const [sessions, setSessions] = useState<Session[]>([])
  const [sessionSearch, setSessionSearch] = useState('')
  const [selectedSessionId, setSelectedSessionId] = useState<number | ''>('')
  const [queryClientId, setQueryClientId] = useState<number | ''>('')
  const [querySiteId, setQuerySiteId] = useState<number | ''>(initialSiteId ?? '')
  const [searched, setSearched] = useState(!!initialSiteId)
  // 스크래핑 목록이 화면 공간을 많이 차지한다는 다른 메뉴(ProductsListPanel)와 같은 요청 — 접으면
  // 한 줄 요약으로 줄고, 세션 선택은 접기 전 상태 그대로 유지된다. 버튼은 항상 같은 자리(우측 끝)에 고정.
  const [collapsed, setCollapsed] = useState(false)

  useEffect(() => {
    fetch('/api/clients').then(r => r.json()).then((d: Client[]) => setClients(Array.isArray(d) ? d : [])).catch(() => {})
    fetch('/api/sites').then(r => r.json()).then((d: Site[]) => setSites(Array.isArray(d) ? d : [])).catch(() => {})
    fetch('/api/sessions').then(r => r.json()).then((d: Session[]) => {
      if (!Array.isArray(d)) return
      setSessions(d)
      const wantedMatch = wantedSessionId.current != null ? d.find(s => s.id === wantedSessionId.current) : undefined
      if (wantedMatch) {
        wantedSessionId.current = undefined
        setSelectedSessionId(wantedMatch.id)
      }
    }).catch(() => {})
  }, [])

  useEffect(() => {
    if (selectedSessionId === '') { onScopeChange({ clientId: '', siteId: '', sessionId: '' }); return }
    const session = sessions.find(s => s.id === selectedSessionId)
    const site = session ? sites.find(s => s.id === session.site_id) : undefined
    onScopeChange({ clientId: site?.client_id ?? '', siteId: session?.site_id ?? '', sessionId: selectedSessionId })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onScopeChange는 매 렌더 새로 생성되는 콜백이라 의존성에서 제외
  }, [selectedSessionId, sessions, sites])

  const siteClientMap = new Map(sites.map(s => [s.id, s.client_id]))
  const filteredSites = clientId === '' ? sites : sites.filter(s => s.client_id === clientId)
  const filteredSessions = sessions.filter(s => {
    if (querySiteId !== '' && s.site_id !== querySiteId) return false
    if (querySiteId === '' && queryClientId !== '' && siteClientMap.get(s.site_id) !== queryClientId) return false
    const q = sessionSearch.trim().toLowerCase()
    if (!q) return true
    // 그리드(ScrapeSessionGrid)가 항상 보여주는 "병합 일시"(merged_at)가 검색에서 빠져있었다(사용자
    // 지적, 2026-08-17 — 다른 메뉴의 검색도 그리드에 보이는 컬럼 전부를 대상으로 해달라는 요청). 이
    // 화면은 showClientMall을 안 켜서 거래처/몰 컬럼 자체가 안 보이므로 그 둘은 검색 대상에서 뺀다.
    return s.url.toLowerCase().includes(q) || s.status.toLowerCase().includes(q) || new Date(s.created_at).toLocaleString().toLowerCase().includes(q)
      || (s.merged_at ? new Date(s.merged_at).toLocaleString() : '').toLowerCase().includes(q)
  })

  const selectedSession = sessions.find(s => s.id === selectedSessionId)
  const selectedSite = selectedSession ? sites.find(s => s.id === selectedSession.site_id) : undefined
  const selectedClient = selectedSite ? clients.find(c => c.id === selectedSite.client_id) : undefined

  function selectClient(id: number | '') {
    setClientId(id)
    setSiteId('')
  }

  function handleSearch() {
    if (clientId === '' && siteId === '') { alert('거래처 또는 몰을 하나 이상 선택해주세요.'); return }
    setQueryClientId(clientId)
    setQuerySiteId(siteId)
    setSearched(true)
  }

  return (
    <div className="mb-4 shrink-0">
      <div className="bg-white rounded-2xl border border-gray-200 p-4 mb-3 flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-sm text-gray-600">
          거래처
          <select value={clientId} onChange={e => selectClient(e.target.value ? Number(e.target.value) : '')}
            className="border border-gray-300 rounded-xl px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-teal-400">
            <option value="">전체</option>
            {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-2 text-sm text-gray-600">
          몰
          <select value={siteId} onChange={e => setSiteId(e.target.value ? Number(e.target.value) : '')}
            className="border border-gray-300 rounded-xl px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-teal-400">
            <option value="">전체</option>
            {filteredSites.map(s => <option key={s.id} value={s.id}>{s.name || s.url}</option>)}
          </select>
        </label>
        <button onClick={handleSearch} disabled={clientId === '' && siteId === ''}
          className="px-4 py-1.5 bg-teal-500 text-white text-sm font-semibold rounded-full hover:bg-teal-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
          🔍 조회
        </button>
        <button onClick={() => setCollapsed(v => !v)}
          className="ml-auto px-3 py-1 bg-gray-100 hover:bg-gray-200 text-gray-600 text-xs font-semibold rounded-full transition-colors shrink-0">
          {collapsed ? '▼ 목록 펼치기' : '▲ 목록 접기'}
        </button>
      </div>

      {!searched ? (
        <div className="bg-white rounded-2xl border border-gray-200 p-8 text-center text-gray-400">
          <p className="text-sm">거래처 또는 몰을 하나 이상 선택하고 조회 버튼을 눌러 작업할 스크랩 세션을 선택해주세요.</p>
        </div>
      ) : filteredSessions.length === 0 ? (
        <div className="bg-white rounded-2xl border border-gray-200 p-8 text-center text-gray-400">
          <p className="text-sm">조건에 맞는 스크랩 세션이 없습니다.</p>
        </div>
      ) : (
        <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-100 bg-gray-50 flex items-center gap-3">
            {collapsed ? (
              <span className="text-xs text-gray-400 truncate">
                {selectedSession
                  ? `선택된 세션: ${selectedClient?.name || '-'} · ${selectedSite?.name || selectedSession.url} · ${new Date(selectedSession.created_at).toLocaleString()}`
                  : '선택된 세션이 없습니다.'}
              </span>
            ) : (
              <>
                <span className="text-xs font-semibold text-gray-500 shrink-0">스크래핑 목록</span>
                <input value={sessionSearch} onChange={e => setSessionSearch(e.target.value)} placeholder="URL·상태·일시 검색..."
                  className="flex-1 border border-gray-300 rounded-full px-3 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-teal-400" />
              </>
            )}
          </div>
          {!collapsed && <ScrapeSessionGrid sessions={filteredSessions} selectedId={selectedSessionId} onSelect={setSelectedSessionId} />}
        </div>
      )}
    </div>
  )
}
