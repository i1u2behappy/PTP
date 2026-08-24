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
  site_name: string | null
  client_name: string | null
  merge_group_id: number | null
  merged_at: string | null
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
    tab: { id: 'category-mapping', type: 'category-mapping', title: '카테고리 매핑', icon: '🗺️', closable: true } },
  { key: 'internal_code', label: '업체/내부코드', compute: r => r.internal_code ? '완료' : '미시작',
    tab: { id: 'internal-codes', type: 'internal-codes', title: '관리코드 생성', icon: '🏷️', closable: true } },
  { key: 'name', label: '상품명', compute: r => r.name_final ? '완료' : r.name_ai ? '진행중' : '미시작',
    tab: { id: 'name-management', type: 'name-management', title: '상품명 관리', icon: '✏️', closable: true } },
  { key: 'options', label: '옵션', compute: r => (r.options && r.options.length > 0) ? '완료' : '미시작',
    tab: { id: 'option-management', type: 'option-management', title: '옵션 관리', icon: '🎛️', closable: true } },
  { key: 'brand_origin', label: '브랜드/제조사/원산지', compute: r => {
      const filled = [r.brand, r.manufacturer, r.origin].filter(Boolean).length
      return filled === 3 ? '완료' : filled === 0 ? '미시작' : '진행중'
    },
    tab: { id: 'brand-origin-management', type: 'brand-origin-management', title: '브랜드·제조사·원산지 관리', icon: '🏭', closable: true } },
  { key: 'image', label: '이미지', compute: r => r.thumbnail_locals?.length ? '완료' : '미시작',
    tab: { id: 'image-edit', type: 'image-edit', title: '이미지 편집', icon: '🖼️', closable: true } },
  { key: 'pricing', label: '가격/이익', compute: r => {
      const hasCost = r.cost_price != null, hasSale = r.sale_price != null, hasTarget = r.target_margin_rate != null
      if (hasCost && hasSale && hasTarget) return '완료'
      if (hasCost || hasSale) return '진행중'
      return '미시작'
    },
    tab: { id: 'pricing-management', type: 'pricing-management', title: '가격 및 이익 관리', icon: '💰', closable: true } },
]

export function MigrationDashboardPanel({ params }: { params?: Record<string, unknown> }) {
  const { openTab, refreshSignals } = useTabs()
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
  const [checkedSessionIds, setCheckedSessionIds] = useState<Set<number>>(new Set())

  const loadSessions = useCallback((onDone?: (d: Session[]) => void) => {
    fetch('/api/sessions').then(r => r.json()).then((d: Session[]) => {
      if (!Array.isArray(d)) return
      setSessions(d)
      onDone?.(d)
    }).catch(() => {})
  }, [])

  useEffect(() => {
    fetch('/api/clients').then(r => r.json()).then((d: Client[]) => setClients(Array.isArray(d) ? d : [])).catch(() => {})
    fetch('/api/sites').then(r => r.json()).then((d: Site[]) => setSites(Array.isArray(d) ? d : [])).catch(() => {})
    loadSessions(d => {
      // 다른 화면에서 특정 세션을 지정해 넘어온 경우에만 자동 선택한다 — 지정된 게 없는데 아무 세션이나
      // (그것도 확정 여부와 무관하게 가장 최근 것을) 미리 골라두면, 사용자가 조회하기도 전에 아래
      // 그리드에 엉뚱한(심지어 미확정일 수도 있는) 세션의 내용이 떠 있게 된다.
      const wantedMatch = wantedSessionId.current != null ? d.find(s => s.id === wantedSessionId.current) : undefined
      if (wantedMatch) {
        wantedSessionId.current = undefined
        setSelectedSessionId(wantedMatch.id)
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 마운트 시 1회만
  }, [])

  // 하단 StagingItemsGrid에서 "확정"하면 그 세션의 미확정/확정 개수가 바뀌므로, 위 스크래핑 목록의 상태값도 바로 갱신한다.
  useEffect(() => {
    if (searched) loadSessions()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- loadSessions/searched는 의존성에서 제외(매 렌더 재생성/조회 전 상태라 무한루프 방지)
  }, [refreshSignals.staging, refreshSignals.products])

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
    // 선택한 세션이 "선택 병합"된 세션이면 서버가 그 그룹 전체의 상품마스터를 함께 내려준다.
    fetch(`/api/master?sessionId=${selectedSessionId}`).then(r => r.json()).then((d: MasterRow[]) => setMasterRows(Array.isArray(d) ? d : [])).catch(() => {})
  }, [selectedSessionId])

  useEffect(() => { loadMasterRows() }, [loadMasterRows])

  const siteClientMap = new Map(sites.map(s => [s.id, s.client_id]))
  const filteredSites = clientId === '' ? sites : sites.filter(s => s.client_id === clientId)
  const filteredSessions = sessions.filter(s => {
    // 이 메뉴는 전단계("스크랩Raw확인")에서 확정까지 끝난 세션만 다룬다 — 미확정 항목이 남아있으면
    // 아직 상품마스터가 없어 이 화면의 하위 작업(판매관리코드/카테고리/...)을 진행할 수 없다.
    // ScrapeSessionGrid의 "✓ 확정 - 데이터 검수 완" 판정과 동일한 기준을 쓴다. staged_count/pending_count는
    // Postgres COUNT(*)가 내려준 값이라 JSON에서도 문자열("0")로 온다 — Number()로 변환해야 비교가 된다
    // (안 그러면 "0" === 0 이 항상 false라 모든 세션이 걸러져 목록이 텅 비어버린다).
    if (!(Number(s.staged_count) > 0 && Number(s.pending_count) === 0)) return false
    if (querySiteId !== '' && s.site_id !== querySiteId) return false
    if (querySiteId === '' && queryClientId !== '' && siteClientMap.get(s.site_id) !== queryClientId) return false
    const q = sessionSearch.trim().toLowerCase()
    if (!q) return true
    // 그리드(ScrapeSessionGrid)가 실제로 보여주는 컬럼 중 "병합 일시"(merged_at)가 검색에서 빠져있었다
    // (사용자 지적, 2026-08-17 — 다른 메뉴의 검색도 그리드에 보이는 컬럼 전부를 대상으로 해달라는 요청).
    return s.url.toLowerCase().includes(q) || s.status.toLowerCase().includes(q) || new Date(s.created_at).toLocaleString().toLowerCase().includes(q)
      || (s.client_name || '').toLowerCase().includes(q) || (s.site_name || '').toLowerCase().includes(q)
      || (s.merged_at ? new Date(s.merged_at).toLocaleString() : '').toLowerCase().includes(q)
  })

  function selectClient(id: number | '') {
    setClientId(id)
    setSiteId('')
  }

  function handleSearch() {
    setQueryClientId(clientId)
    setQuerySiteId(siteId)
    setSearched(true)
    setCheckedSessionIds(new Set())
    // 조회 조건이 바뀌면 목록에 안 보일 수도 있는 이전 선택 세션을 그대로 들고 있으면 안 된다 —
    // 아래 진행상황 카드/StagingItemsGrid가 목록에도 없는 세션 데이터를 계속 보여주게 된다.
    setSelectedSessionId('')
  }

  function toggleCheckSession(id: number) {
    const target = sessions.find(s => s.id === id)
    if (!target) return
    setCheckedSessionIds(prev => {
      if (prev.has(id)) {
        const n = new Set(prev); n.delete(id); return n
      }
      // 체크하는 즉시 거래처·몰이 다르면 바로 알리고 선택에 넣지 않는다 — "선택 병합" 클릭까지 기다리지 않는다.
      const firstChecked = prev.size > 0 ? sessions.find(s => s.id === [...prev][0]) : undefined
      if (firstChecked && firstChecked.site_id !== target.site_id) {
        alert('이미 체크한 세션들과 거래처·몰이 다릅니다. 같은 거래처·몰의 세션만 함께 선택할 수 있습니다.')
        return prev
      }
      return new Set(prev).add(id)
    })
  }

  const checkedSessions = sessions.filter(s => checkedSessionIds.has(s.id))
  const canSplit = checkedSessions.some(s => s.merge_group_id != null)
  const selectedSession = sessions.find(s => s.id === selectedSessionId)
  const mergedSiblingCount = selectedSession?.merge_group_id != null
    ? sessions.filter(s => s.merge_group_id === selectedSession.merge_group_id && s.id !== selectedSession.id).length
    : 0

  async function handleMergeSessions() {
    const sessionIds = [...checkedSessionIds]
    const res = await fetch('/api/sessions/merge', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionIds }),
    })
    if (!res.ok) { alert('병합에 실패했습니다.'); return }
    setCheckedSessionIds(new Set())
    loadSessions()
    setSelectedSessionId(Math.min(...sessionIds))
  }

  async function handleSplitSessions() {
    const sessionIds = [...checkedSessionIds]
    await fetch('/api/sessions/split', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionIds }),
    })
    setCheckedSessionIds(new Set())
    loadSessions()
  }

  function counts(task: TaskDef) {
    const c: Record<StageStatus, number> = { '미시작': 0, '진행중': 0, '완료': 0 }
    masterRows.forEach(r => { c[task.compute(r)]++ })
    return c
  }

  return (
    <div className="h-full flex flex-col">
      <div className="mb-3 shrink-0">
        <h1 className="text-2xl font-bold text-gray-800">📊 데이터 마이그 목록</h1>
        <p className="text-xs text-gray-400 mt-1">전단계(스크랩Raw확인)에서 확정한 세션만 검색·선택하면, 그 세션 기준으로 마이그레이션 하위 작업 진행현황과 스크랩 상세내역을 확인할 수 있습니다.</p>
      </div>

      {/* 상단: 거래처/몰/일시로 검색하는 스크래핑 목록 */}
      <div className="bg-white rounded-2xl border border-gray-200 p-3 mb-3 flex flex-wrap items-center gap-3 shrink-0">
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
        <button onClick={handleSearch}
          className="px-4 py-1.5 bg-teal-500 text-white text-sm font-semibold rounded-full hover:bg-teal-600 transition-colors">
          🔍 조회 {clientId === '' && siteId === '' && '(전체)'}
        </button>
      </div>

      {!searched ? (
        <div className="bg-white rounded-2xl border border-gray-200 p-6 text-center text-gray-400 mb-3 shrink-0">
          <div className="text-2xl mb-2">🔍</div>
          <p className="text-sm">조회 버튼을 눌러주세요 — 거래처/몰을 고르면 그 범위만, 그대로 두면 확정된 전체 내역이 나옵니다.</p>
        </div>
      ) : sessions.length === 0 ? (
        <div className="bg-white rounded-2xl border border-gray-200 p-6 text-center text-gray-400 mb-3 shrink-0">
          <div className="text-2xl mb-2">📭</div>
          <p className="text-sm">수집된 스크래핑이 없습니다.</p>
        </div>
      ) : (
        <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden mb-3 shrink-0">
          <div className="px-4 py-2 border-b border-gray-100 bg-gray-50 flex items-center gap-3 flex-wrap">
            <span className="text-xs font-semibold text-gray-500 shrink-0">스크래핑 목록 (확정 완료분)</span>
            <input value={sessionSearch} onChange={e => setSessionSearch(e.target.value)} placeholder="거래처·몰·URL·상태·일시 검색..."
              className="flex-1 min-w-[200px] border border-gray-300 rounded-full px-3 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-teal-400" />
            {checkedSessionIds.size >= 2 && (
              <button onClick={handleMergeSessions}
                className="px-3 py-1.5 bg-teal-500 hover:bg-teal-600 text-white text-xs font-semibold rounded-full transition-colors shrink-0">
                🔗 선택 병합 ({checkedSessionIds.size})
              </button>
            )}
            {canSplit && (
              <button onClick={handleSplitSessions}
                className="px-3 py-1.5 bg-gray-100 hover:bg-gray-200 text-gray-600 text-xs font-semibold rounded-full transition-colors shrink-0">
                🔓 선택 분할 ({checkedSessionIds.size})
              </button>
            )}
          </div>
          <ScrapeSessionGrid sessions={filteredSessions} selectedId={selectedSessionId} onSelect={setSelectedSessionId} showClientMall
            checkedIds={checkedSessionIds} onToggleCheck={toggleCheckSession} maxHeightClassName="max-h-40" />
        </div>
      )}

      {searched && (
        <>
          {selectedSession?.merge_group_id != null && (
            <div className="bg-cyan-50 border border-cyan-200 rounded-2xl px-4 py-2 mb-3 shrink-0 text-xs text-cyan-700">
              🔗 이 세션은 다른 {mergedSiblingCount}개 세션과 병합되어 있어, 아래 진행현황·상세 그리드에 그 세션들의 스크랩 항목이 함께 표시됩니다. 스크래핑한 일자는 각 상품 행에 그대로 남아있습니다.
            </div>
          )}

          {/* 중단: 선택한 세션(병합된 경우 그 그룹 전체) 기준 하위 작업 진행현황 */}
          {selectedSessionId === '' ? (
            <div className="bg-white rounded-2xl border border-gray-200 p-4 text-center text-gray-400 mb-3 shrink-0 text-sm">
              위 스크래핑 목록에서 세션을 선택하면 진행현황이 표시됩니다.
            </div>
          ) : masterRows.length === 0 ? (
            <div className="bg-white rounded-2xl border border-gray-200 p-4 text-center text-gray-400 mb-3 shrink-0 text-sm">
              이 세션은 아직 마이그레이션(병합)되지 않아 진행현황을 계산할 상품마스터가 없습니다.
            </div>
          ) : (
            <div className="grid grid-cols-4 gap-2 mb-3 shrink-0">
              {TASKS.map(task => {
                const c = counts(task)
                const total = masterRows.length || 1
                const taskSiteId = selectedSession?.site_id
                return (
                  <button key={task.key}
                    onClick={() => openTab({ ...task.tab, params: { siteId: taskSiteId, sessionId: selectedSessionId } })}
                    className="bg-white rounded-2xl border border-gray-200 p-3 text-left hover:border-teal-300 transition-colors">
                    <p className="text-xs font-semibold text-gray-600 mb-1.5">{task.label}</p>
                    <div className="flex h-2 rounded-full overflow-hidden bg-gray-100 mb-1.5">
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
