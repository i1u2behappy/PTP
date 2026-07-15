'use client'
import { useEffect, useState, useCallback, useRef } from 'react'
import { useTabs, type Tab } from '../shell/TabsContext'
import { StagingItemsGrid } from './shared/StagingItemsGrid'
import { ScrapeSessionGrid } from './shared/ScrapeSessionGrid'

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
  merged_count: number
  skipped_count: number
  created_at: string
}

interface MasterRow {
  id: number
  name_original: string
  name_ai: string | null
  name_final: string | null
  master_category: string | null
  brand: string | null
  manufacturer: string | null
  origin: string | null
  options: { name: string; values: string[] }[] | null
  cost_price: number | null
  sale_price: number | null
  target_margin_rate: number | null
  internal_code: string | null
  sales_code: string | null
  thumbnail_locals: string[]
}

type StageStatus = '미시작' | '진행중' | '완료'

interface TaskDef {
  key: string
  label: string
  compute: (r: MasterRow) => StageStatus
  tab: Tab
}

const TASKS: TaskDef[] = [
  { key: 'sales_code', label: '판매관리코드', compute: r => r.sales_code ? '완료' : '미시작',
    tab: { id: 'sales-code', type: 'sales-code', title: '판매관리코드 관리', icon: '💳', closable: true } },
  { key: 'category', label: '카테고리', compute: r => r.master_category ? '완료' : '미시작',
    tab: { id: 'category-mapping', type: 'category-mapping', title: '카테고리 관리', icon: '🗺️', closable: true } },
  { key: 'internal_code', label: '업체/내부코드', compute: r => r.internal_code ? '완료' : '미시작',
    tab: { id: 'internal-codes', type: 'internal-codes', title: '업체코드-상품내부코드 생성', icon: '🏷️', closable: true } },
  { key: 'name', label: '상품명', compute: r => r.name_final ? '완료' : r.name_ai ? '진행중' : '미시작',
    tab: { id: 'name-management', type: 'name-management', title: '상품명 관리', icon: '✏️', closable: true } },
  { key: 'options', label: '옵션', compute: r => (r.options && r.options.length > 0) ? '완료' : '미시작',
    tab: { id: 'option-management', type: 'option-management', title: '옵션 관리', icon: '🎛️', closable: true } },
  { key: 'brand_origin', label: '브랜드/제조사/원산지', compute: r => {
      const filled = [r.brand, r.manufacturer, r.origin].filter(Boolean).length
      return filled === 3 ? '완료' : filled === 0 ? '미시작' : '진행중'
    },
    tab: { id: 'brand-origin-management', type: 'brand-origin-management', title: '브랜드,제조사,원산지 관리', icon: '🏭', closable: true } },
  { key: 'image', label: '이미지', compute: r => r.thumbnail_locals?.length ? '완료' : '미시작',
    tab: { id: 'image-edit', type: 'image-edit', title: '이미지 관리', icon: '🖼️', closable: true } },
  { key: 'pricing', label: '가격/이익', compute: r => {
      const hasCost = r.cost_price != null, hasSale = r.sale_price != null, hasTarget = r.target_margin_rate != null
      if (hasCost && hasSale && hasTarget) return '완료'
      if (hasCost || hasSale) return '진행중'
      return '미시작'
    },
    tab: { id: 'pricing-management', type: 'pricing-management', title: '가격및이익관리', icon: '💰', closable: true } },
]

export function MigrationDashboardPanel({ params }: { params?: Record<string, unknown> }) {
  const { openTab } = useTabs()
  const wantedSessionId = useRef(params?.sessionId as number | undefined)
  const [clients, setClients] = useState<Client[]>([])
  const [clientId, setClientId] = useState<number | ''>('')
  const [sites, setSites] = useState<Site[]>([])
  const [siteId, setSiteId] = useState<number | ''>('')
  const [sessions, setSessions] = useState<Session[]>([])
  const [sessionSearch, setSessionSearch] = useState('')
  const [selectedSessionId, setSelectedSessionId] = useState<number | ''>('')
  const [masterRows, setMasterRows] = useState<MasterRow[]>([])
  const [queryClientId, setQueryClientId] = useState<number | ''>('')
  const [querySiteId, setQuerySiteId] = useState<number | ''>('')
  const [searched, setSearched] = useState(false)

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
      } else {
        setSelectedSessionId(current => current === '' && d.length ? d[0].id : current)
      }
    }).catch(() => {})
  }, [])

  // 수집확인 등 다른 화면에서 특정 몰/세션을 지정해 넘어온 경우 — 거래처/몰 조건을 채우고 곧바로 조회 상태로 만든다.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    const wantedSite = params?.siteId as number | undefined
    if (wantedSite == null) return
    setSiteId(wantedSite)
    setQueryClientId('')
    setQuerySiteId(wantedSite)
    setSearched(true)
  }, [params?.siteId])
  /* eslint-enable react-hooks/set-state-in-effect */

  const loadMasterRows = useCallback(() => {
    if (selectedSessionId === '') return
    fetch(`/api/master/by-session?sessionId=${selectedSessionId}`).then(r => r.json()).then((d: MasterRow[]) => setMasterRows(Array.isArray(d) ? d : [])).catch(() => {})
  }, [selectedSessionId])

  useEffect(() => { loadMasterRows() }, [loadMasterRows])

  const siteClientMap = new Map(sites.map(s => [s.id, s.client_id]))
  const filteredSites = clientId === '' ? sites : sites.filter(s => s.client_id === clientId)
  const filteredSessions = sessions.filter(s => {
    if (querySiteId !== '' && s.site_id !== querySiteId) return false
    if (querySiteId === '' && queryClientId !== '' && siteClientMap.get(s.site_id) !== queryClientId) return false
    const q = sessionSearch.trim().toLowerCase()
    if (!q) return true
    return s.url.toLowerCase().includes(q) || s.status.toLowerCase().includes(q) || new Date(s.created_at).toLocaleString().toLowerCase().includes(q)
  })

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

  function counts(task: TaskDef) {
    const c: Record<StageStatus, number> = { '미시작': 0, '진행중': 0, '완료': 0 }
    masterRows.forEach(r => { c[task.compute(r)]++ })
    return c
  }

  return (
    <div className="h-full flex flex-col">
      <div className="mb-6 shrink-0">
        <h1 className="text-2xl font-bold text-gray-800">📊 데이터 마이그 목록</h1>
        <p className="text-xs text-gray-400 mt-1">스크래핑 목록에서 세션을 검색·선택하면, 그 세션 기준으로 마이그레이션 하위 작업 진행현황과 스크랩 상세내역을 확인할 수 있습니다.</p>
      </div>

      {/* 상단: 거래처/몰/일시로 검색하는 스크래핑 목록 */}
      <div className="bg-white rounded-2xl border border-gray-200 p-4 mb-4 flex flex-wrap items-center gap-3 shrink-0">
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
      </div>

      {!searched ? (
        <div className="bg-white rounded-2xl border border-gray-200 p-12 text-center text-gray-400 mb-4 shrink-0">
          <div className="text-4xl mb-3">🔍</div>
          <p className="text-sm">거래처 또는 몰을 하나 이상 선택하고 조회 버튼을 눌러주세요.</p>
        </div>
      ) : sessions.length === 0 ? (
        <div className="bg-white rounded-2xl border border-gray-200 p-12 text-center text-gray-400 mb-4 shrink-0">
          <div className="text-4xl mb-3">📭</div>
          <p className="text-sm">수집된 스크래핑이 없습니다.</p>
        </div>
      ) : (
        <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden mb-4 shrink-0">
          <div className="px-4 py-3 border-b border-gray-100 bg-gray-50 flex items-center gap-3">
            <span className="text-xs font-semibold text-gray-500 shrink-0">스크래핑 목록</span>
            <input value={sessionSearch} onChange={e => setSessionSearch(e.target.value)} placeholder="URL·상태·일시 검색..."
              className="flex-1 border border-gray-300 rounded-full px-3 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-teal-400" />
          </div>
          <ScrapeSessionGrid sessions={filteredSessions} selectedId={selectedSessionId} onSelect={setSelectedSessionId} />
        </div>
      )}

      {searched && (
        <>
          {/* 중단: 선택한 세션 기준 하위 작업 진행현황 */}
          {selectedSessionId === '' ? (
            <div className="bg-white rounded-2xl border border-gray-200 p-8 text-center text-gray-400 mb-4 shrink-0 text-sm">
              위 스크래핑 목록에서 세션을 선택하면 진행현황이 표시됩니다.
            </div>
          ) : masterRows.length === 0 ? (
            <div className="bg-white rounded-2xl border border-gray-200 p-8 text-center text-gray-400 mb-4 shrink-0 text-sm">
              이 세션은 아직 마이그레이션(병합)되지 않아 진행현황을 계산할 상품마스터가 없습니다.
            </div>
          ) : (
            <div className="grid grid-cols-4 gap-3 mb-4 shrink-0">
              {TASKS.map(task => {
                const c = counts(task)
                const total = masterRows.length || 1
                return (
                  <button key={task.key} onClick={() => openTab(task.tab)}
                    className="bg-white rounded-2xl border border-gray-200 p-4 text-left hover:border-teal-300 transition-colors">
                    <p className="text-xs font-semibold text-gray-600 mb-2">{task.label}</p>
                    <div className="flex h-2 rounded-full overflow-hidden bg-gray-100 mb-2">
                      <div className="bg-emerald-400" style={{ width: `${(c['완료'] / total) * 100}%` }} />
                      <div className="bg-amber-400" style={{ width: `${(c['진행중'] / total) * 100}%` }} />
                    </div>
                    <p className="text-xs text-gray-400">완료 {c['완료']} · 진행중 {c['진행중']} · 미시작 {c['미시작']}</p>
                  </button>
                )
              })}
            </div>
          )}

          {/* 하단: 수집확인과 동일한 스크랩 상세 그리드 (작업진행사항 없이 조회된 건 전체를 그대로 표시) */}
          <StagingItemsGrid sessionId={selectedSessionId} />
        </>
      )}
    </div>
  )
}
