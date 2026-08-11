'use client'
import { useEffect, useState, useCallback } from 'react'
import { useTabs } from '../shell/TabsContext'
import { useCurrentUser } from '../shell/CurrentUserContext'
import { StagingItemsGrid } from './shared/StagingItemsGrid'
import { ScrapeSessionGrid } from './shared/ScrapeSessionGrid'
import { ClientMallFilterBar } from './shared/ClientMallFilterBar'

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
  const { isAdmin } = useCurrentUser()
  const [sessions, setSessions] = useState<Session[]>([])
  const [sessionSearch, setSessionSearch] = useState('')
  const [clientFilter, setClientFilter] = useState('')
  const [siteFilter, setSiteFilter] = useState<number | ''>('')
  const [selectedSessionId, setSelectedSessionId] = useState<number | ''>('')
  const [checkedSessionIds, setCheckedSessionIds] = useState<Set<number>>(new Set())
  const [deleting, setDeleting] = useState(false)
  // 검색/스크래핑 목록이 화면 공간을 많이 차지해 아래 스크랩 상세 그리드를 보기 어렵다는 요청 — 접으면
  // 한 줄 요약 바로 줄어들고, 세션 선택은 접기 전 상태 그대로 유지된다.
  const [topCollapsed, setTopCollapsed] = useState(false)

  const loadSessions = useCallback(() => {
    fetch('/api/sessions').then(r => r.json()).then((d: Session[]) => {
      if (!Array.isArray(d)) return
      setSessions(d)
      setSelectedSessionId(current => current === '' && d.length ? d[0].id : current)
    }).catch(() => {})
  }, [])

  useEffect(() => { loadSessions() }, [loadSessions, refreshSignals.products, refreshSignals.staging])

  const filteredSessions = sessions.filter(s => {
    if (siteFilter !== '' && s.site_id !== siteFilter) return false
    if (siteFilter === '' && clientFilter !== '' && s.client_name !== clientFilter) return false
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

  /** "상태" 컬럼(ScrapeSessionGrid)이 "✓ 확정 - 데이터 검수 완"으로 보여주는 것과 같은 기준 —
   *  아직 미확정 항목이 남은 세션은 병합 대상이 아니다. staged_count/pending_count는 서버의
   *  COUNT(*)(bigint) 결과라 pg 드라이버가 문자열로 내려준다 — Number()로 감싸지 않으면
   *  "0" === 0이 항상 false가 되어 모든 세션이 미확정으로 오판된다(ScrapeSessionGrid의 같은 판정과
   *  동일하게 Number()로 변환). */
  function isConfirmed(s: Session): boolean {
    return Number(s.staged_count) > 0 && Number(s.pending_count) === 0
  }

  function toggleCheckSession(id: number) {
    const target = sessions.find(s => s.id === id)
    if (!target) return
    setCheckedSessionIds(prev => {
      if (prev.has(id)) {
        const n = new Set(prev); n.delete(id); return n
      }
      if (!isConfirmed(target)) {
        alert('확정(데이터 검수 완료)되지 않은 세션은 병합할 수 없습니다.')
        return prev
      }
      // 병합은 같은 몰의 세션끼리만 가능하다(서버도 검증하지만, 체크하는 즉시 바로 알려준다).
      const firstChecked = prev.size > 0 ? sessions.find(s => s.id === [...prev][0]) : undefined
      if (firstChecked && firstChecked.site_id !== target.site_id) {
        alert('이미 체크한 세션들과 몰이 다릅니다. 같은 몰의 세션만 함께 선택할 수 있습니다.')
        return prev
      }
      return new Set(prev).add(id)
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

  /** 각각 스크랩된 세션 여러 개를 하나로 묶는다 — 다른 메뉴(데이터 마이그 목록 등)에서 이 중 아무
   *  세션이나 조회해도 그룹 전체가 함께 조회된다(lib/scrape/mergeGroup.ts). 상품마스터는 만들지
   *  않는다 — 그건 "확정" 버튼이 이미 끝낸 별개의 단계. */
  async function handleMergeSessions() {
    const sessionIds = [...checkedSessionIds]
    const res = await fetch('/api/sessions/merge', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionIds }),
    })
    if (!res.ok) { alert('병합에 실패했습니다.'); return }
    setCheckedSessionIds(new Set())
    setSelectedSessionId(Math.min(...sessionIds))
    loadSessions()
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

      {/* 상단: 검색 가능한 스크래핑 목록 (클릭 시 하단 그리드가 해당 세션으로 전환) — 아래 상세 그리드를
          볼 공간이 부족하다는 요청으로 접기/펼치기를 넣었다. 접기/펼치기 버튼은 상태와 무관하게 항상
          같은 자리(맨 위 줄 우측 끝)에 고정 — 펼쳤을 때만 버튼 위치가 바뀌면 매번 찾기 불편하다는 요청. */}
      {sessions.length === 0 ? (
        <div className="bg-white rounded-2xl border border-gray-200 p-12 text-center text-gray-400 mb-4 shrink-0">
          <div className="text-4xl mb-3">📭</div>
          <p className="text-sm">수집된 스크래핑이 없습니다.</p>
          <button onClick={() => openTab({ id: 'scraper', type: 'scraper', title: '스크래핑', icon: '🔍', closable: true })}
            className="mt-2 inline-block text-teal-500 text-sm hover:underline">스크래핑 시작하기 →</button>
        </div>
      ) : (
        <>
          <div className="bg-white rounded-2xl border border-gray-200 px-4 py-2 mb-3 shrink-0 flex items-center gap-3">
            {topCollapsed ? (
              <span className="text-xs text-gray-400 truncate">
                {selectedSession
                  ? `선택된 세션: ${selectedSession.client_name || '-'} · ${selectedSession.site_name || selectedSession.url} · ${new Date(selectedSession.created_at).toLocaleString()}`
                  : '선택된 세션이 없습니다.'}
              </span>
            ) : (
              <span className="text-xs font-semibold text-gray-500 shrink-0">스크래핑 목록</span>
            )}
            <button onClick={() => setTopCollapsed(v => !v)}
              className="ml-auto px-3 py-1 bg-gray-100 hover:bg-gray-200 text-gray-600 text-xs font-semibold rounded-full transition-colors shrink-0">
              {topCollapsed ? '▼ 검색·목록 펼치기' : '▲ 검색·목록 접기'}
            </button>
          </div>

          {!topCollapsed && (
            <>
              <ClientMallFilterBar searchPlaceholder="URL·상태·일시 검색..."
                onChange={f => { setClientFilter(f.clientName); setSiteFilter(f.siteId); setSessionSearch(f.search) }} />
              <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden mb-4 shrink-0">
                <ScrapeSessionGrid sessions={filteredSessions} selectedId={selectedSessionId} onSelect={setSelectedSessionId}
                  onDelete={isAdmin ? handleDeleteSession : undefined} maxHeightClassName="max-h-48" showClientMall
                  checkedIds={checkedSessionIds} onToggleCheck={toggleCheckSession} isRowCheckable={isConfirmed}
                  extraActions={<>
                    {checkedSessionIds.size >= 2 && (
                      <button onClick={handleMergeSessions}
                        className="px-4 py-1.5 bg-gray-100 text-gray-600 text-xs font-semibold rounded-full hover:bg-gray-200 transition-colors shrink-0">
                        🔗 선택 병합 ({checkedSessionIds.size})
                      </button>
                    )}
                    {isAdmin && checkedSessionIds.size > 0 && (
                      <button onClick={handleDeleteChecked} disabled={deleting}
                        className="px-4 py-1.5 bg-gray-100 text-gray-600 text-xs font-semibold rounded-full hover:bg-gray-200 disabled:opacity-50 transition-colors shrink-0">
                        🗑 선택 삭제 ({checkedSessionIds.size})
                      </button>
                    )}
                  </>} />
              </div>
            </>
          )}
        </>
      )}

      {/* 하단: 선택한 스크래핑의 전체 컬럼 상세 그리드 (병합 여부 무관, 확인/검증용) */}
      <StagingItemsGrid sessionId={selectedSessionId} />

      <div className="mt-3 flex items-center justify-between text-xs text-gray-400 shrink-0">
        <p>선택한 세션: {selectedSession ? new Date(selectedSession.created_at).toLocaleString() : '-'}</p>
        <button onClick={openMigration}
          className="text-teal-500 hover:underline font-medium">다음 단계: 마이그레이션 →</button>
      </div>
    </div>
  )
}
