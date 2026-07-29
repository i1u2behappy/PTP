'use client'
import { useEffect, useMemo, useState, useCallback } from 'react'
import { useTabs } from '../shell/TabsContext'
import { useCurrentUser } from '../shell/CurrentUserContext'
import { ClientMallFilterBar } from './shared/ClientMallFilterBar'
import { SITES_LIST_TAB } from '../shell/menuTabs'

interface Site {
  id: number
  name: string | null
  url: string
  login_id: string | null
  login_pw_masked: string | null
  client_id: number | null
  client_name: string | null
  blocked: boolean
  manual_login_required: boolean | null
  main_items: string | null
  latest_memo: string | null
  created_at: string
  mall_platform: string | null
}

/** 로그인 확인/스크랩 시작마다 자동 감지되는 몰 구축 플랫폼(lib/scraper.ts의 MallPlatform) 표시용 —
 *  ScraperPanel.tsx의 감지 결과 표시와 동일한 라벨을 쓴다. */
const PLATFORM_LABELS: Record<string, string> = {
  cafe24: '카페24', makeshop: '메이크샵', godomall: '고도몰', domesin: '도매의신', unknown: '알 수 없음',
}

/** name 컬럼의 ❔ 미정 배지와 같은 기준(manual_login_required)의 텍스트 버전. */
function loginModeLabel(s: Site): string {
  if (s.manual_login_required === true) return '개발자모드'
  if (s.manual_login_required === false) return '일반모드'
  return '미정'
}

/** 몰 유형 컬럼에서 로그인 방식을 색으로 바로 구분: 일반모드=초록, 개발자모드=노랑, 미정=회색. */
const LOGIN_MODE_BADGE_CLASS: Record<string, string> = {
  '일반모드': 'bg-emerald-100 text-emerald-700',
  '개발자모드': 'bg-amber-100 text-amber-700',
  '미정': 'bg-gray-100 text-gray-500',
}

interface ColumnDef {
  key: string
  label: string
  getValue: (s: Site) => string
  render: (s: Site) => React.ReactNode
  className?: string
}

const COLUMNS: ColumnDef[] = [
  { key: 'name', label: 'Mall 이름', getValue: s => s.name || '', className: 'text-gray-800 font-medium', render: s => (
    <>
      {s.name || '(이름 없음)'}
      {s.manual_login_required === null && (
        <span className="ml-1.5 px-1.5 py-0.5 rounded-full bg-gray-100 text-gray-500 text-[10px] font-semibold whitespace-nowrap" title="아직 스크랩 방식이 정해지지 않았습니다 — 스크래핑 화면에서 처음 스크랩할 때 선택하세요">
          ❔ 미정
        </span>
      )}
    </>
  ) },
  { key: 'main_items', label: '메인 품목', getValue: s => s.main_items || '', render: s => s.main_items || '-', className: 'text-gray-500' },
  { key: 'url', label: 'URL', getValue: s => s.url, render: s => s.url, className: 'text-gray-500' },
  { key: 'mall_platform', label: '몰 유형',
    getValue: s => `${s.mall_platform ? (PLATFORM_LABELS[s.mall_platform] || s.mall_platform) : '-'} (${loginModeLabel(s)})`,
    render: s => (
      <>
        {s.mall_platform ? (PLATFORM_LABELS[s.mall_platform] || s.mall_platform) : '-'}{' '}
        <span className={`px-1.5 py-0.5 rounded-full text-[10px] font-semibold whitespace-nowrap ${LOGIN_MODE_BADGE_CLASS[loginModeLabel(s)]}`}>
          {loginModeLabel(s)}
        </span>
      </>
    ),
    className: 'text-gray-500' },
  { key: 'login_id', label: '로그인ID', getValue: s => s.login_id || '', render: s => s.login_id || '-', className: 'text-gray-500' },
  { key: 'login_pw_masked', label: '비밀번호', getValue: s => s.login_pw_masked || '', render: s => s.login_pw_masked || '-', className: 'text-gray-500 font-mono' },
  { key: 'client_name', label: '거래처', getValue: s => s.client_name || '', render: s => s.client_name || '-', className: 'text-teal-600' },
  { key: 'blocked', label: '상태', getValue: s => s.blocked ? '차단' : '정상',
    render: s => s.blocked ? <span className="font-semibold text-rose-500">차단</span> : <span className="text-emerald-600">정상</span> },
  { key: 'latest_memo', label: '메모', getValue: s => s.latest_memo || '', render: s => s.latest_memo || '-', className: 'text-gray-500 max-w-xs' },
  { key: 'created_at', label: '등록일', getValue: s => s.created_at, render: s => new Date(s.created_at).toLocaleDateString(), className: 'text-gray-400' },
]

const DEFAULT_COL_WIDTH: Record<string, number> = {
  name: 160, main_items: 140, url: 220, mall_platform: 130, login_id: 110, login_pw_masked: 100,
  client_name: 110, blocked: 70, latest_memo: 220, created_at: 100,
}
const MIN_COL_WIDTH = 50
function widthFor(key: string): number {
  return DEFAULT_COL_WIDTH[key] ?? 120
}

function compareValues(a: string, b: string): number {
  return a.localeCompare(b, 'ko')
}

type SortDir = 'asc' | 'desc'
interface SortKey { key: string; dir: SortDir }

export function SitesListPanel() {
  const { openTab, refreshSignals } = useTabs()
  const { isAdmin } = useCurrentUser()
  const [sites, setSites] = useState<Site[]>([])
  const [q, setQ] = useState('')
  const [clientFilter, setClientFilter] = useState<number | ''>('')
  const [loadError, setLoadError] = useState(false)
  const [sortKeys, setSortKeys] = useState<SortKey[]>([])
  const [filters, setFilters] = useState<Record<string, string>>({})
  const [showFilters, setShowFilters] = useState(false)
  const [colWidths, setColWidths] = useState<Record<string, number>>({})
  const [colOrder, setColOrder] = useState<string[]>([])
  const [dragKey, setDragKey] = useState<string | null>(null)

  const load = useCallback((query: string) => {
    fetch(`/api/sites?q=${encodeURIComponent(query)}`).then(r => {
      if (!r.ok) throw new Error()
      return r.json()
    }).then((d: Site[]) => {
      if (Array.isArray(d)) { setSites(d); setLoadError(false) }
    }).catch(() => setLoadError(true))
  }, [])

  useEffect(() => { load(q) }, [load, q, refreshSignals.sites])

  // 컬럼 구성은 고정이지만, 렌더링 시점에 "기존 순서 + 아직 안 담긴 새 키"를 계산해 useEffect로 state를
  // 동기화하지 않는다 (state-sync 이펙트 없이 항상 최신 컬럼 목록과 일치시키기 위함).
  const effectiveOrder = useMemo(() => {
    const keys = COLUMNS.map(c => c.key)
    const known = colOrder.filter(k => keys.includes(k))
    const missing = keys.filter(k => !known.includes(k))
    return [...known, ...missing]
  }, [colOrder])
  const orderedColumns = effectiveOrder.map(k => COLUMNS.find(c => c.key === k)).filter((c): c is ColumnDef => !!c)

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

  const hasFilters = Object.values(filters).some(Boolean)
  const filteredSites = sites.filter(s => {
    if (clientFilter !== '' && s.client_id !== clientFilter) return false
    return COLUMNS.every(col => {
      const f = filters[col.key]
      if (!f) return true
      return col.getValue(s).toLowerCase().includes(f.toLowerCase())
    })
  })
  const visibleSites = sortKeys.length
    ? [...filteredSites].sort((a, b) => {
        for (const { key, dir } of sortKeys) {
          const col = COLUMNS.find(c => c.key === key)
          if (!col) continue
          const cmp = compareValues(col.getValue(a), col.getValue(b))
          if (cmp !== 0) return dir === 'asc' ? cmp : -cmp
        }
        return 0
      })
    : filteredSites

  const tableWidth = orderedColumns.reduce((sum, col) => sum + (colWidths[col.key] ?? widthFor(col.key)), 0) + 100

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

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center justify-between mb-6 shrink-0">
        <h1 className="text-2xl font-bold text-gray-800">🏬 Mall 관리</h1>
        <div className="flex gap-2">
          <button onClick={() => openDetail()}
            className="px-4 py-2 bg-teal-500 hover:bg-teal-600 text-white text-sm font-semibold rounded-full transition-colors">
            ➕ 새 Mall 등록
          </button>
        </div>
      </div>

      <ClientMallFilterBar showMallFilter={false} searchPlaceholder="이름 또는 URL 검색..."
        onChange={f => { setClientFilter(f.clientId); setQ(f.search) }} />

      {loadError ? (
        <div className="bg-white rounded-2xl border border-gray-200 p-8 text-center text-sm text-rose-500">목록을 불러오지 못했습니다. 서버(DB) 연결을 확인해주세요.</div>
      ) : sites.length === 0 ? (
        <div className="bg-white rounded-2xl border border-gray-200 p-8 text-center text-sm text-gray-400">등록된 Mall이 없습니다.</div>
      ) : (
        <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden flex-1 min-h-0 flex flex-col">
          <div className="flex items-center justify-end gap-2 px-4 py-2 border-b border-gray-100 bg-gray-50 shrink-0">
            <button onClick={() => setShowFilters(v => !v)}
              className={`px-3 py-1 text-xs font-semibold rounded-full transition-colors ${showFilters ? 'bg-teal-500 text-white hover:bg-teal-600' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>
              🔍 필터
            </button>
            {(hasFilters || sortKeys.length > 0) && (
              <button onClick={() => { setFilters({}); setSortKeys([]) }}
                className="px-3 py-1 bg-gray-100 text-gray-600 text-xs font-semibold rounded-full hover:bg-gray-200 transition-colors">
                필터/정렬 초기화
              </button>
            )}
          </div>
          <div className="overflow-auto flex-1 min-h-0">
            <table className="text-xs border-collapse" style={{ tableLayout: 'fixed', width: tableWidth }}>
              <colgroup>
                {orderedColumns.map(col => <col key={col.key} style={{ width: colWidths[col.key] ?? widthFor(col.key) }} />)}
                <col style={{ width: 100 }} />
              </colgroup>
              <thead className="sticky top-0 z-10 bg-gray-50">
                <tr className="border-b border-gray-200 text-gray-500 font-semibold">
                  {orderedColumns.map((col, colIdx) => {
                    const idx = sortKeys.findIndex(s => s.key === col.key)
                    const active = idx !== -1
                    return (
                      <th key={col.key} draggable
                        onDragStart={() => setDragKey(col.key)}
                        onDragOver={e => e.preventDefault()}
                        onDrop={() => handleColDrop(col.key)}
                        onDragEnd={() => setDragKey(null)}
                        className={`relative px-3 py-2 text-left cursor-pointer select-none hover:bg-gray-100 overflow-hidden whitespace-nowrap ${dragKey === col.key ? 'opacity-40' : ''} ${colIdx === 0 ? 'sticky left-0 z-20 bg-gray-50' : ''}`}
                        onClick={e => handleSort(col.key, e)} title="드래그: 컬럼 순서 이동 · 클릭: 정렬 · Shift+클릭: 복합 정렬 추가">
                        <span className={active ? 'text-gray-800' : ''}>{col.label}</span>
                        {active && <span className="ml-1 text-teal-500">{sortKeys[idx].dir === 'asc' ? '▲' : '▼'}{sortKeys.length > 1 ? idx + 1 : ''}</span>}
                        <div onMouseDown={e => { e.stopPropagation(); startResize(col.key, e) }} onClick={e => e.stopPropagation()} draggable={false}
                          className="absolute top-0 right-0 bottom-0 w-1.5 cursor-col-resize hover:bg-teal-400 active:bg-teal-500" />
                      </th>
                    )
                  })}
                  <th className="px-3 py-2 text-left whitespace-nowrap">관리</th>
                </tr>
                {showFilters && (
                  <tr className="border-b border-gray-200 bg-white">
                    {orderedColumns.map((col, colIdx) => (
                      <th key={col.key} className={`px-2 py-1.5 font-normal ${colIdx === 0 ? 'sticky left-0 z-20 bg-white' : ''}`}>
                        <input value={filters[col.key] || ''} onChange={e => setFilters(f => ({ ...f, [col.key]: e.target.value }))}
                          placeholder="필터..." onClick={e => e.stopPropagation()}
                          className="w-full border border-gray-200 rounded px-1.5 py-1 text-xs font-normal focus:outline-none focus:ring-1 focus:ring-teal-300" />
                      </th>
                    ))}
                    <th className="px-2 py-1.5"></th>
                  </tr>
                )}
              </thead>
              <tbody>
                {visibleSites.length === 0 ? (
                  <tr><td colSpan={orderedColumns.length + 1} className="px-3 py-3 text-center text-gray-400">필터에 맞는 Mall이 없습니다.</td></tr>
                ) : visibleSites.map(s => (
                  <tr key={s.id} onClick={() => openScraper(s)} className="group border-b border-gray-100 hover:bg-gray-50 cursor-pointer transition-colors">
                    {orderedColumns.map((col, colIdx) => (
                      <td key={col.key} className={`px-3 py-2 truncate ${col.className ?? ''} ${colIdx === 0 ? 'sticky left-0 z-10 bg-white group-hover:bg-gray-50' : ''}`} title={col.key === 'url' || col.key === 'latest_memo' || col.key === 'main_items' ? col.getValue(s) : undefined}>
                        {col.render(s)}
                      </td>
                    ))}
                    <td className="px-3 py-2 whitespace-nowrap" onClick={e => e.stopPropagation()}>
                      <button onClick={() => openDetail(s)} className="text-teal-500 hover:underline mr-2">수정</button>
                      {isAdmin && <button onClick={() => handleDelete(s.id)} className="text-rose-500 hover:underline">삭제</button>}
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
