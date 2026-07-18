'use client'
import { useEffect, useMemo, useState, useCallback } from 'react'
import { useTabs } from '../shell/TabsContext'
import { NewClientForm } from './shared/NewClientForm'
import { CLIENTS_LIST_TAB } from '../shell/menuTabs'

interface Client {
  id: number
  name: string
  code: string | null
  business_reg_no: string | null
  business_reg_doc_path: string | null
  representative_name: string | null
  business_type: string | null
  business_item: string | null
  business_address: string | null
  contact_name: string | null
  contact_phone: string | null
  contact_email: string | null
  memo: string | null
  created_at: string
}

interface ColumnDef {
  key: string
  label: string
  getValue: (c: Client) => string
  render: (c: Client) => React.ReactNode
  className?: string
}

const COLUMNS: ColumnDef[] = [
  { key: 'name', label: '거래처명', getValue: c => c.name, render: c => c.name, className: 'text-gray-800 font-medium' },
  { key: 'code', label: '거래처코드', getValue: c => c.code || '', render: c => c.code || '-', className: 'font-mono text-teal-600' },
  { key: 'business_reg_no', label: '사업자등록번호', getValue: c => c.business_reg_no || '', render: c => c.business_reg_no || '-', className: 'text-gray-600' },
  { key: 'business_reg_doc_path', label: '사업자등록증', getValue: c => c.business_reg_doc_path ? '첨부' : '미첨부',
    render: c => c.business_reg_doc_path
      ? <a href={c.business_reg_doc_path} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()} className="text-teal-500 hover:underline">첨부</a>
      : <span className="text-gray-300">미첨부</span> },
  { key: 'representative_name', label: '대표자명', getValue: c => c.representative_name || '', render: c => c.representative_name || '-', className: 'text-gray-600' },
  { key: 'business_type', label: '업태', getValue: c => c.business_type || '', render: c => c.business_type || '-', className: 'text-gray-500' },
  { key: 'business_item', label: '종목', getValue: c => c.business_item || '', render: c => c.business_item || '-', className: 'text-gray-500' },
  { key: 'business_address', label: '사업장주소', getValue: c => c.business_address || '', render: c => c.business_address || '-', className: 'text-gray-500 max-w-[220px] truncate' },
  { key: 'contact_name', label: '담당자명', getValue: c => c.contact_name || '', render: c => c.contact_name || '-', className: 'text-gray-600' },
  { key: 'contact_phone', label: '연락처', getValue: c => c.contact_phone || '', render: c => c.contact_phone || '-', className: 'text-gray-500' },
  { key: 'contact_email', label: '이메일', getValue: c => c.contact_email || '', render: c => c.contact_email || '-', className: 'text-gray-500' },
  { key: 'memo', label: '메모', getValue: c => c.memo || '', render: c => c.memo || '-', className: 'text-gray-400 max-w-[160px] truncate' },
  { key: 'created_at', label: '등록일', getValue: c => c.created_at, render: c => new Date(c.created_at).toLocaleDateString(), className: 'text-gray-400' },
]

const DEFAULT_COL_WIDTH: Record<string, number> = {
  name: 140, code: 100, business_reg_no: 130, business_reg_doc_path: 90, representative_name: 100,
  business_type: 90, business_item: 90, business_address: 220, contact_name: 100, contact_phone: 120,
  contact_email: 160, memo: 160, created_at: 100,
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

export function ClientsListPanel() {
  const { openTab, refreshSignals } = useTabs()
  const [clients, setClients] = useState<Client[]>([])
  const [q, setQ] = useState('')
  const [loadError, setLoadError] = useState(false)
  const [sortKeys, setSortKeys] = useState<SortKey[]>([])
  const [filters, setFilters] = useState<Record<string, string>>({})
  const [showFilters, setShowFilters] = useState(false)
  const [colWidths, setColWidths] = useState<Record<string, number>>({})
  const [colOrder, setColOrder] = useState<string[]>([])
  const [dragKey, setDragKey] = useState<string | null>(null)

  const load = useCallback((query: string) => {
    fetch(`/api/clients?q=${encodeURIComponent(query)}`).then(r => {
      if (!r.ok) throw new Error()
      return r.json()
    }).then((d: Client[]) => {
      if (Array.isArray(d)) { setClients(d); setLoadError(false) }
    }).catch(() => setLoadError(true))
  }, [])

  useEffect(() => { load(q) }, [load, q, refreshSignals.clients])

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
  const filteredClients = clients.filter(c => COLUMNS.every(col => {
    const f = filters[col.key]
    if (!f) return true
    return col.getValue(c).toLowerCase().includes(f.toLowerCase())
  }))
  const visibleClients = sortKeys.length
    ? [...filteredClients].sort((a, b) => {
        for (const { key, dir } of sortKeys) {
          const col = COLUMNS.find(c => c.key === key)
          if (!col) continue
          const cmp = compareValues(col.getValue(a), col.getValue(b))
          if (cmp !== 0) return dir === 'asc' ? cmp : -cmp
        }
        return 0
      })
    : filteredClients

  const tableWidth = orderedColumns.reduce((sum, col) => sum + (colWidths[col.key] ?? widthFor(col.key)), 0) + 100

  function openDetail(client: Client) {
    openTab({ ...CLIENTS_LIST_TAB, type: 'client-detail', params: { clientId: client.id } })
  }

  async function handleDelete(id: number) {
    if (!confirm('이 거래처를 삭제할까요? (연결된 Mall은 삭제되지 않고, 거래처 연결만 해제됩니다)')) return
    try {
      const res = await fetch(`/api/clients/${id}`, { method: 'DELETE' })
      if (!res.ok) throw new Error(`서버 오류 (${res.status})`)
      load(q)
    } catch (e) {
      alert(`삭제에 실패했습니다: ${e instanceof Error ? e.message : e}`)
    }
  }

  return (
    <div className="h-full flex flex-col">
      <div className="mb-6 shrink-0">
        <h1 className="text-2xl font-bold text-gray-800">🏢 거래처 관리</h1>
      </div>

      <div className="flex-1 min-h-0 flex flex-col gap-4">
        <div className="flex-[1_1_0%] min-h-0 overflow-y-auto">
          <NewClientForm onCreated={() => load(q)} />
        </div>

        <div className="flex-[2_1_0%] min-h-0 flex flex-col">
          <div className="mb-3 shrink-0">
            <input value={q} onChange={e => setQ(e.target.value)} placeholder="거래처명, 사업자번호, 대표자, 담당자, 연락처, 메모 검색..."
              className="w-full max-w-md border border-gray-300 rounded-full px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-400" />
          </div>

          {loadError ? (
            <div className="bg-white rounded-2xl border border-gray-200 p-8 text-center text-sm text-rose-500">목록을 불러오지 못했습니다. 서버(DB) 연결을 확인해주세요.</div>
          ) : clients.length === 0 ? (
            <div className="bg-white rounded-2xl border border-gray-200 p-8 text-center text-sm text-gray-400">등록된 거래처가 없습니다.</div>
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
                      {orderedColumns.map(col => {
                        const idx = sortKeys.findIndex(s => s.key === col.key)
                        const active = idx !== -1
                        return (
                          <th key={col.key} draggable
                            onDragStart={() => setDragKey(col.key)}
                            onDragOver={e => e.preventDefault()}
                            onDrop={() => handleColDrop(col.key)}
                            onDragEnd={() => setDragKey(null)}
                            className={`relative px-3 py-2 text-left cursor-pointer select-none hover:bg-gray-100 overflow-hidden whitespace-nowrap ${dragKey === col.key ? 'opacity-40' : ''}`}
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
                        {orderedColumns.map(col => (
                          <th key={col.key} className="px-2 py-1.5 font-normal">
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
                    {visibleClients.length === 0 ? (
                      <tr><td colSpan={orderedColumns.length + 1} className="px-3 py-3 text-center text-gray-400">필터에 맞는 거래처가 없습니다.</td></tr>
                    ) : visibleClients.map(c => (
                      <tr key={c.id} onClick={() => openDetail(c)} className="border-b border-gray-100 hover:bg-gray-50 cursor-pointer transition-colors">
                        {orderedColumns.map(col => (
                          <td key={col.key} className={`px-3 py-2 truncate ${col.className ?? ''}`} title={col.key === 'business_address' || col.key === 'memo' ? col.getValue(c) : undefined}>
                            {col.render(c)}
                          </td>
                        ))}
                        <td className="px-3 py-2 whitespace-nowrap" onClick={e => e.stopPropagation()}>
                          <button onClick={() => openDetail(c)} className="text-teal-500 hover:underline mr-2">수정</button>
                          <button onClick={() => handleDelete(c.id)} className="text-rose-500 hover:underline">삭제</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
