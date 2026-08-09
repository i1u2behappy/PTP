'use client'
import { useMemo, useState } from 'react'

interface SessionLike {
  id: number
  url: string
  found_count: number
  staged_count: number
  pending_count: number
  created_at: string
  client_name?: string | null
  site_name?: string | null
  /** "선택 병합"으로 다른 세션들과 하나로 묶여있으면 그 그룹 식별자 — 다른 메뉴에서 이 중 아무 세션이나 조회해도 그룹 전체가 함께 조회된다. */
  merge_group_id?: number | null
  /** 병합된 시각 — 병합 안 된 세션이면 null. */
  merged_at?: string | null
}

interface ColumnDef<T> {
  key: string
  label: string
  getValue: (s: T) => string | number
  render: (s: T) => React.ReactNode
  className?: string
}

function compareValues(a: string | number, b: string | number): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b
  return String(a).localeCompare(String(b), 'ko')
}

type SortDir = 'asc' | 'desc'
interface SortKey { key: string; dir: SortDir }

const DEFAULT_COL_WIDTH: Record<string, number> = {
  created_at: 140, client_name: 110, site_name: 110, url: 280, staged_count: 150, pending_count: 170, merged_at: 140,
}
const MIN_COL_WIDTH = 50
function widthFor(key: string): number {
  return DEFAULT_COL_WIDTH[key] ?? 120
}

/** 스크랩 세션 목록 그리드 — 데이터 마이그 목록 상단 조회와 마이그레이션 하위 메뉴들(ScrapeScopePicker)이
 *  공유한다. 컬럼 클릭 정렬(Shift+클릭 복합 정렬), 컬럼별 필터, 컬럼 폭 조절·드래그 순서 변경까지
 *  StagingItemsGrid와 동일한 조작 방식을 제공한다. */
export function ScrapeSessionGrid<T extends SessionLike>({ sessions, selectedId, onSelect, onDelete, maxHeightClassName = 'max-h-52', showClientMall, checkedIds, onToggleCheck }: {
  sessions: T[]
  selectedId: number | ''
  onSelect: (id: number) => void
  onDelete?: (id: number) => void
  maxHeightClassName?: string
  /** 거래처/몰이 뒤섞여 나오는 조회(예: 데이터 마이그 목록의 전체 조회)에서만 거래처명/몰명 컬럼을 보여준다. */
  showClientMall?: boolean
  /** 세션 여러 개를 동시에 체크할 수 있게 한다 — "선택 병합"처럼 세션 단위 다중 선택이 필요한 화면에서만 전달. */
  checkedIds?: Set<number>
  onToggleCheck?: (id: number) => void
}) {
  const [sortKeys, setSortKeys] = useState<SortKey[]>([])
  const [filters, setFilters] = useState<Record<string, string>>({})
  const [showFilters, setShowFilters] = useState(false)
  const [colWidths, setColWidths] = useState<Record<string, number>>({})
  const [colOrder, setColOrder] = useState<string[]>([])
  const [dragKey, setDragKey] = useState<string | null>(null)

  const columns = useMemo<ColumnDef<T>[]>(() => {
    const cols: ColumnDef<T>[] = [
      { key: 'created_at', label: '스크래핑 일시', getValue: s => s.created_at,
        render: s => new Date(s.created_at).toLocaleString(undefined, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }),
        className: 'text-gray-400 whitespace-nowrap' },
    ]
    if (showClientMall) {
      cols.push(
        { key: 'client_name', label: '거래처', getValue: s => s.client_name || '', render: s => s.client_name || '-', className: 'text-gray-700 whitespace-nowrap' },
        { key: 'site_name', label: '몰', getValue: s => s.site_name || '', render: s => s.site_name || '-', className: 'text-gray-700 whitespace-nowrap' },
      )
    }
    cols.push(
      { key: 'url', label: 'URL', getValue: s => s.url, render: s => s.url, className: 'text-gray-500 max-w-[320px] truncate' },
      { key: 'staged_count', label: '수집 현황', getValue: s => Number(s.staged_count),
        render: s => `발견 ${s.found_count} / 수집 ${s.staged_count}`, className: 'text-gray-400 whitespace-nowrap' },
      { key: 'pending_count', label: '상태', getValue: s => Number(s.pending_count),
        render: s => {
          const confirmed = Number(s.staged_count) > 0 && Number(s.pending_count) === 0
          return (
            <>
              <span className={confirmed ? 'text-emerald-600' : 'text-amber-600'}>{confirmed ? '✓ 확정 - 데이터 검수 완' : `⚠ 미확정 ${s.pending_count}개`}</span>
              {s.merge_group_id != null && (
                <span title="다른 세션과 병합된 상태입니다" className="ml-1.5 px-1.5 py-0.5 rounded-full bg-cyan-50 text-cyan-600 text-[10px] font-semibold">🔗 병합</span>
              )}
            </>
          )
        },
        className: 'font-medium whitespace-nowrap' },
      { key: 'merged_at', label: '병합 일시', getValue: s => s.merged_at || '',
        render: s => s.merged_at ? new Date(s.merged_at).toLocaleString() : '-', className: 'text-gray-400 whitespace-nowrap' },
    )
    return cols
  }, [showClientMall])

  // 컬럼 구성이 바뀌어도(showClientMall 전환 등) colOrder state를 별도로 동기화하지 않고, 렌더링 시점에
  // "기존 순서 + 아직 안 담긴 새 키"를 매번 계산한다 — state-sync용 useEffect 없이 항상 최신 컬럼 목록과
  // 일치시키기 위함.
  const effectiveOrder = useMemo(() => {
    const keys = columns.map(c => c.key)
    const known = colOrder.filter(k => keys.includes(k))
    const missing = keys.filter(k => !known.includes(k))
    return [...known, ...missing]
  }, [colOrder, columns])

  const orderedColumns = effectiveOrder.map(k => columns.find(c => c.key === k)).filter((c): c is ColumnDef<T> => !!c)

  function handleColDrop(targetKey: string) {
    if (!dragKey || dragKey === targetKey) return
    const next = effectiveOrder.filter(k => k !== dragKey)
    next.splice(next.indexOf(targetKey), 0, dragKey)
    setColOrder(next)
    setDragKey(null)
  }

  function startResize(key: string, e: { clientX: number; preventDefault: () => void }) {
    e.preventDefault()
    const startX = e.clientX
    const startWidth = colWidths[key] ?? widthFor(key)
    function onMove(ev: MouseEvent) {
      setColWidths(w => ({ ...w, [key]: Math.max(MIN_COL_WIDTH, startWidth + (ev.clientX - startX)) }))
    }
    function onUp() {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  const hasFilters = Object.values(filters).some(Boolean)

  const filteredSessions = sessions.filter(s => columns.every(col => {
    const f = filters[col.key]
    if (!f) return true
    return String(col.getValue(s)).toLowerCase().includes(f.toLowerCase())
  }))

  const visibleSessions = sortKeys.length
    ? [...filteredSessions].sort((a, b) => {
        for (const { key, dir } of sortKeys) {
          const col = columns.find(c => c.key === key)
          if (!col) continue
          const cmp = compareValues(col.getValue(a), col.getValue(b))
          if (cmp !== 0) return dir === 'asc' ? cmp : -cmp
        }
        return 0
      })
    : filteredSessions

  // 지금 필터/정렬로 보이는 세션들만 대상으로 전체 선택/해제한다 — 이미 체크된 게 전부면 끄고, 아니면 켠다.
  function handleSelectAll() {
    if (!onToggleCheck) return
    const allChecked = visibleSessions.length > 0 && visibleSessions.every(s => checkedIds?.has(s.id))
    visibleSessions.forEach(s => {
      const checked = checkedIds?.has(s.id) ?? false
      if (allChecked ? checked : !checked) onToggleCheck(s.id)
    })
  }

  function handleSort(key: string, e: { shiftKey: boolean }) {
    setSortKeys(prev => {
      const idx = prev.findIndex(s => s.key === key)
      if (e.shiftKey) {
        if (idx === -1) return [...prev, { key, dir: 'asc' }]
        const next = [...prev]
        next[idx] = { key, dir: next[idx].dir === 'asc' ? 'desc' : 'asc' }
        return next
      }
      if (prev.length === 1 && prev[0].key === key) {
        return [{ key, dir: prev[0].dir === 'asc' ? 'desc' : 'asc' }]
      }
      return [{ key, dir: 'asc' }]
    })
  }

  if (sessions.length === 0) return <p className="px-4 py-3 text-xs text-gray-400">검색 결과가 없습니다.</p>

  const tableWidth = (onToggleCheck ? 40 : 0) + orderedColumns.reduce((sum, col) => sum + (colWidths[col.key] ?? widthFor(col.key)), 0) + (onDelete ? 80 : 0)

  return (
    <div>
      <div className="flex items-center justify-end gap-2 px-4 py-2 border-b border-gray-100 bg-gray-50">
        {/* 보조 기능 토글은 rounded-md의 각진 모양으로, 클릭 한 번짜리 액션 버튼(rounded-full)과 구분한다. */}
        <button onClick={() => setShowFilters(v => !v)}
          className={`px-3 py-0.5 text-xs font-semibold rounded-md transition-colors ${showFilters ? 'bg-teal-100 text-teal-700 hover:bg-teal-200' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>
          🔍 필터
        </button>
        {(hasFilters || sortKeys.length > 0) && (
          <button onClick={() => { setFilters({}); setSortKeys([]) }}
            className="px-3 py-1 bg-gray-100 text-gray-600 text-xs font-semibold rounded-full hover:bg-gray-200 transition-colors">
            필터/정렬 초기화
          </button>
        )}
      </div>
      <div className={`${maxHeightClassName} overflow-auto`}>
        <table className="text-xs border-collapse" style={{ tableLayout: 'fixed', width: tableWidth }}>
          <colgroup>
            {onToggleCheck && <col style={{ width: 40 }} />}
            {orderedColumns.map(col => <col key={col.key} style={{ width: colWidths[col.key] ?? widthFor(col.key) }} />)}
            {onDelete && <col style={{ width: 80 }} />}
          </colgroup>
          <thead className="sticky top-0 z-10 bg-gray-50">
            <tr className="border-b border-gray-200 text-gray-500 font-semibold">
              {onToggleCheck && (
                <th className="px-4 py-2 text-left sticky left-0 z-20 bg-gray-50">
                  <input type="checkbox" checked={visibleSessions.length > 0 && visibleSessions.every(s => checkedIds?.has(s.id))} onChange={handleSelectAll} />
                </th>
              )}
              {orderedColumns.map((col, colIdx) => {
                const idx = sortKeys.findIndex(s => s.key === col.key)
                const active = idx !== -1
                return (
                  <th key={col.key} draggable
                    onDragStart={() => setDragKey(col.key)}
                    onDragOver={e => e.preventDefault()}
                    onDrop={() => handleColDrop(col.key)}
                    onDragEnd={() => setDragKey(null)}
                    className={`relative px-4 py-2 text-left cursor-pointer select-none hover:bg-gray-100 overflow-hidden whitespace-nowrap ${dragKey === col.key ? 'opacity-40' : ''} ${colIdx === 0 ? `sticky z-20 bg-gray-50 ${onToggleCheck ? 'left-10' : 'left-0'}` : ''}`}
                    onClick={e => handleSort(col.key, e)} title="드래그: 컬럼 순서 이동 · 클릭: 정렬 · Shift+클릭: 복합 정렬 추가">
                    <span className={active ? 'text-gray-800' : ''}>{col.label}</span>
                    {active && <span className="ml-1 text-teal-500">{sortKeys[idx].dir === 'asc' ? '▲' : '▼'}{sortKeys.length > 1 ? idx + 1 : ''}</span>}
                    <div onMouseDown={e => { e.stopPropagation(); startResize(col.key, e) }} onClick={e => e.stopPropagation()} draggable={false}
                      className="absolute top-0 right-0 bottom-0 w-1.5 cursor-col-resize hover:bg-teal-400 active:bg-teal-500" />
                  </th>
                )
              })}
              {onDelete && <th className="px-4 py-2 text-left whitespace-nowrap">관리</th>}
            </tr>
            {showFilters && (
              <tr className="border-b border-gray-200 bg-white">
                {onToggleCheck && <th className="px-4 py-1.5 sticky left-0 z-20 bg-white"></th>}
                {orderedColumns.map((col, colIdx) => (
                  <th key={col.key} className={`px-2 py-1.5 font-normal ${colIdx === 0 ? `sticky z-20 bg-white ${onToggleCheck ? 'left-10' : 'left-0'}` : ''}`}>
                    <input value={filters[col.key] || ''} onChange={e => setFilters(f => ({ ...f, [col.key]: e.target.value }))}
                      placeholder="필터..." onClick={e => e.stopPropagation()}
                      className="w-full border border-gray-200 rounded px-1.5 py-1 text-xs font-normal focus:outline-none focus:ring-1 focus:ring-teal-300" />
                  </th>
                ))}
                {onDelete && <th className="px-4 py-1.5"></th>}
              </tr>
            )}
          </thead>
          <tbody>
            {visibleSessions.length === 0 ? (
              <tr><td colSpan={orderedColumns.length + (onToggleCheck ? 1 : 0) + (onDelete ? 1 : 0)} className="px-4 py-3 text-xs text-gray-400 text-center">필터에 맞는 세션이 없습니다.</td></tr>
            ) : visibleSessions.map(s => {
              const rowStickyBg = s.id === selectedId ? 'bg-teal-50' : 'bg-white group-hover:bg-gray-50'
              return (
              <tr key={s.id} onClick={() => onSelect(s.id)}
                className={`group border-b border-gray-100 last:border-0 cursor-pointer transition-colors ${
                  s.id === selectedId ? 'bg-teal-50' : 'hover:bg-gray-50'}`}>
                {onToggleCheck && (
                  <td className={`px-4 py-2 sticky left-0 z-10 ${rowStickyBg}`} onClick={e => e.stopPropagation()}>
                    <input type="checkbox" checked={checkedIds?.has(s.id) ?? false} onChange={() => onToggleCheck(s.id)} />
                  </td>
                )}
                {orderedColumns.map((col, colIdx) => (
                  <td key={col.key} className={`px-4 py-2 truncate ${col.className ?? ''} ${colIdx === 0 ? `sticky z-10 ${rowStickyBg} ${onToggleCheck ? 'left-10' : 'left-0'}` : ''}`} title={col.key === 'url' ? s.url : undefined}>
                    {col.render(s)}
                  </td>
                ))}
                {onDelete && (
                  <td className="px-4 py-2 whitespace-nowrap">
                    <button onClick={e => { e.stopPropagation(); onDelete(s.id) }} className="text-rose-500 hover:underline">삭제</button>
                  </td>
                )}
              </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
