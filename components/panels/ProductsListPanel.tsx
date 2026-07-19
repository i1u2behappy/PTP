'use client'
import { useEffect, useState, useCallback } from 'react'
import { useTabs } from '../shell/TabsContext'
import { StagingItemsGrid } from './shared/StagingItemsGrid'
import { ScrapeSessionGrid } from './shared/ScrapeSessionGrid'

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
  site_manual_login_required: boolean | null
}

export function ProductsListPanel() {
  const { openTab, refreshSignals } = useTabs()
  const [sessions, setSessions] = useState<Session[]>([])
  const [sessionSearch, setSessionSearch] = useState('')
  const [selectedSessionId, setSelectedSessionId] = useState<number | ''>('')
  const [checkedSessionIds, setCheckedSessionIds] = useState<Set<number>>(new Set())
  const [deleting, setDeleting] = useState(false)

  const loadSessions = useCallback(() => {
    fetch('/api/sessions').then(r => r.json()).then((d: Session[]) => {
      if (!Array.isArray(d)) return
      setSessions(d)
      setSelectedSessionId(current => current === '' && d.length ? d[0].id : current)
    }).catch(() => {})
  }, [])

  useEffect(() => { loadSessions() }, [loadSessions, refreshSignals.products, refreshSignals.staging])

  const filteredSessions = sessions.filter(s => {
    const q = sessionSearch.trim().toLowerCase()
    if (!q) return true
    return s.url.toLowerCase().includes(q) || s.status.toLowerCase().includes(q) || new Date(s.created_at).toLocaleString().toLowerCase().includes(q)
      || (s.client_name || '').toLowerCase().includes(q) || (s.site_name || '').toLowerCase().includes(q)
  })

  const selectedSession = sessions.find(s => s.id === selectedSessionId)

  async function handleDeleteSession(id: number) {
    if (!confirm('이 스크래핑 세션을 삭제할까요? 수집된 상세내역이 모두 삭제되며 되돌릴 수 없습니다. (이미 마이그레이션된 상품 데이터는 영향받지 않습니다)')) return
    try {
      const res = await fetch(`/api/sessions/${id}`, { method: 'DELETE' })
      if (!res.ok) throw new Error(`서버 오류 (${res.status})`)
      if (selectedSessionId === id) setSelectedSessionId('')
      loadSessions()
    } catch (e) {
      alert(`삭제에 실패했습니다: ${e instanceof Error ? e.message : e}`)
    }
  }

  function toggleCheckSession(id: number) {
    setCheckedSessionIds(prev => {
      const n = new Set(prev)
      n.has(id) ? n.delete(id) : n.add(id)
      return n
    })
  }

  async function handleDeleteChecked() {
    if (!checkedSessionIds.size) return
    if (!confirm(`선택한 ${checkedSessionIds.size}개 스크래핑 세션을 삭제할까요? 수집된 상세내역이 모두 삭제되며 되돌릴 수 없습니다. (이미 마이그레이션된 상품 데이터는 영향받지 않습니다)`)) return
    setDeleting(true)
    try {
      const ids = [...checkedSessionIds]
      await Promise.all(ids.map(id => fetch(`/api/sessions/${id}`, { method: 'DELETE' })))
      if (selectedSessionId !== '' && checkedSessionIds.has(selectedSessionId)) setSelectedSessionId('')
      setCheckedSessionIds(new Set())
      loadSessions()
    } catch (e) {
      alert(`삭제에 실패했습니다: ${e instanceof Error ? e.message : e}`)
    } finally {
      setDeleting(false)
    }
  }

  function openMigration() {
    openTab({
      id: 'migration-dashboard', type: 'migration-dashboard', title: '데이터 마이그 목록', icon: '📊', closable: true,
      params: selectedSession ? { siteId: selectedSession.site_id, sessionId: selectedSession.id } : undefined,
    })
  }

  return (
    <div className="h-full min-h-0 flex flex-col">
      <div className="flex items-center justify-between mb-6 shrink-0">
        <div>
          <h1 className="text-2xl font-bold text-gray-800">📥 스크랩 Raw 확인</h1>
          <p className="text-xs text-gray-400 mt-1">
            사용 절차: ① 스크래핑 실행 → ② <b className="text-gray-500">여기서 수집 내용이 잘 스크랩됐는지 확인/검증</b> (확정 전=미확정) → ③ 마이그레이션으로 넘겨 병합 → ④ 상품마스터로 가공.
            아래 표는 병합 여부와 상관없이 이 스크래핑에서 수집된 모든 항목을 보여줍니다.
          </p>
        </div>
        <button onClick={openMigration}
          className="px-4 py-2 bg-teal-500 text-white text-sm font-semibold rounded-full hover:bg-teal-600 transition-colors shrink-0">
          확인 완료 → 마이그레이션으로 →
        </button>
      </div>

      {/* 상단: 검색 가능한 스크래핑 목록 (클릭 시 하단 그리드가 해당 세션으로 전환) */}
      {sessions.length === 0 ? (
        <div className="bg-white rounded-2xl border border-gray-200 p-12 text-center text-gray-400 mb-4 shrink-0">
          <div className="text-4xl mb-3">📭</div>
          <p className="text-sm">수집된 스크래핑이 없습니다.</p>
          <button onClick={() => openTab({ id: 'scraper', type: 'scraper', title: '스크래핑', icon: '🔍', closable: true })}
            className="mt-2 inline-block text-teal-500 text-sm hover:underline">스크래핑 시작하기 →</button>
        </div>
      ) : (
        <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden mb-4 shrink-0">
          <div className="px-4 py-3 border-b border-gray-100 bg-gray-50 flex items-center gap-3 flex-wrap">
            <span className="text-xs font-semibold text-gray-500 shrink-0">스크래핑 목록</span>
            <input value={sessionSearch} onChange={e => setSessionSearch(e.target.value)} placeholder="거래처·몰·URL·상태·일시 검색..."
              className="flex-1 min-w-[200px] border border-gray-300 rounded-full px-3 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-teal-400" />
            {checkedSessionIds.size > 0 && (
              <button onClick={handleDeleteChecked} disabled={deleting}
                className="px-3 py-1.5 bg-rose-50 text-rose-600 text-xs font-semibold rounded-full hover:bg-rose-100 disabled:opacity-50 transition-colors shrink-0">
                🗑 선택 삭제 ({checkedSessionIds.size})
              </button>
            )}
          </div>
          <ScrapeSessionGrid sessions={filteredSessions} selectedId={selectedSessionId} onSelect={setSelectedSessionId}
            onDelete={handleDeleteSession} maxHeightClassName="max-h-48" showClientMall
            checkedIds={checkedSessionIds} onToggleCheck={toggleCheckSession} />
        </div>
      )}

      {/* 하단: 선택한 스크래핑의 전체 컬럼 상세 그리드 (병합 여부 무관, 확인/검증용) — "스크랩 조정"도 여기,
          실제 확정(병합) 버튼 옆에 있다: 스크랩된 데이터를 확정하기 전에 미흡한 부분을 조정하는 흐름이라서. */}
      <StagingItemsGrid sessionId={selectedSessionId}
        siteId={selectedSession?.site_id} siteName={selectedSession?.site_name}
        manualLoginRequired={selectedSession?.site_manual_login_required} />

      <div className="mt-3 flex items-center justify-between text-xs text-gray-400 shrink-0">
        <p>선택한 세션: {selectedSession ? new Date(selectedSession.created_at).toLocaleString() : '-'}</p>
        <button onClick={openMigration}
          className="text-teal-500 hover:underline font-medium">다음 단계: 마이그레이션 →</button>
      </div>
    </div>
  )
}
