'use client'
import { useEffect, useState, useCallback } from 'react'
import { useTabs } from '../../shell/TabsContext'

interface RawExtra {
  thumbnail_names?: string[]
  detail_image_names?: string[]
  detail_text?: string
  summary_info?: string
  english_name?: string
  extra_info?: { label: string; value: string }[]
  stock_by_option?: { option: string; qty: number }[]
}

interface StagingRow {
  id: number
  mall_product_code: string
  mall_category: string | null
  name_original: string
  price: number | null
  sale_price: number | null
  brand: string
  manufacturer: string | null
  origin: string | null
  description: string | null
  options: { name: string; values: string[] }[] | null
  thumbnail_urls: string[]
  detail_image_urls: string[] | null
  stock_status: string | null
  stock_qty: number | null
  raw_data: RawExtra | null
  source_url: string | null
  status: string
  is_already_migrated: boolean
  matched_mall_product_id: number | null
  created_at: string
}

const STATUS_LABELS: Record<string, { text: string; cls: string }> = {
  pending: { text: '대기(미확정)', cls: 'text-amber-600' },
  merged: { text: '병합됨', cls: 'text-teal-600' },
  skipped: { text: '무시됨', cls: 'text-gray-400' },
}

function missingFields(p: StagingRow): string[] {
  const missing: string[] = []
  if (!p.name_original) missing.push('상품명')
  if (p.price == null && p.sale_price == null) missing.push('가격')
  if (!p.thumbnail_urls?.length) missing.push('대표이미지')
  if (!p.brand) missing.push('브랜드')
  if (!p.mall_category) missing.push('카테고리')
  return missing
}

interface ColumnDef {
  key: string
  label: string
  getValue: (p: StagingRow) => string | number | null
}

const COLUMNS: ColumnDef[] = [
  { key: 'created_at', label: '스크래핑 일시', getValue: p => p.created_at },
  { key: 'thumbnail_img', label: '이미지', getValue: p => p.thumbnail_urls?.length ?? 0 },
  { key: 'mall_product_code', label: '상품코드', getValue: p => p.mall_product_code },
  { key: 'name_original', label: '상품명', getValue: p => p.name_original },
  { key: 'price', label: '정상가', getValue: p => p.price },
  { key: 'sale_price', label: '판매가', getValue: p => p.sale_price },
  { key: 'brand', label: '브랜드', getValue: p => p.brand },
  { key: 'manufacturer', label: '제조사', getValue: p => p.manufacturer },
  { key: 'origin', label: '원산지', getValue: p => p.origin },
  { key: 'mall_category', label: '카테고리', getValue: p => p.mall_category },
  { key: 'description', label: '설명', getValue: p => p.description },
  { key: 'options', label: '옵션', getValue: p => (p.options || []).map(o => `${o.name}: ${o.values.join('/')}`).join('; ') },
  { key: 'thumbnail_names', label: '대표이미지', getValue: p => (p.raw_data?.thumbnail_names || []).join(', ') },
  { key: 'detail_image_urls', label: '상세이미지', getValue: p => (p.raw_data?.detail_image_names || []).join(', ') },
  { key: 'stock_status', label: '재고상태', getValue: p => p.stock_status },
  { key: 'stock_qty', label: '재고수량', getValue: p => p.stock_qty },
  { key: 'stock_by_option', label: '옵션별 재고', getValue: p => (p.raw_data?.stock_by_option || []).map(r => `${r.option}: ${r.qty}개`).join(', ') },
  { key: 'summary_info', label: '상품요약정보', getValue: p => p.raw_data?.summary_info || '' },
  { key: 'english_name', label: '영문상품명', getValue: p => p.raw_data?.english_name || '' },
  { key: 'detail_text', label: '상세페이지 텍스트', getValue: p => p.raw_data?.detail_text || '' },
  { key: 'extra_info', label: '상품정보고시 전체', getValue: p => (p.raw_data?.extra_info || []).map(e => `${e.label}: ${e.value}`).join(' / ') },
  { key: 'source_url', label: 'URL', getValue: p => p.source_url },
  { key: 'missing', label: '누락 데이터', getValue: p => missingFields(p).join(', ') },
  { key: 'migration_status', label: '마이그레이션 상태', getValue: p => STATUS_LABELS[p.status]?.text || p.status },
]

function compareValues(a: string | number | null, b: string | number | null): number {
  if (a == null && b == null) return 0
  if (a == null) return 1
  if (b == null) return -1
  if (typeof a === 'number' && typeof b === 'number') return a - b
  return String(a).localeCompare(String(b), 'ko')
}

type SortDir = 'asc' | 'desc'
interface SortKey { key: string; dir: SortDir }

const DEFAULT_COL_WIDTH: Record<string, number> = {
  created_at: 140, thumbnail_img: 64,
  mall_product_code: 100, name_original: 190, price: 100, sale_price: 100, brand: 90,
  manufacturer: 90, origin: 90, mall_category: 150, description: 180, options: 200,
  thumbnail_names: 180, detail_image_urls: 180, stock_status: 90, stock_qty: 90, stock_by_option: 200,
  summary_info: 160, english_name: 130, detail_text: 220, extra_info: 220,
  source_url: 100, missing: 150, migration_status: 120,
}
const MIN_COL_WIDTH = 50

const COL_ORDER_KEY = 'stagingGrid.colOrder.v2'
const DEFAULT_COL_ORDER = COLUMNS.map(c => c.key)

function loadColOrder(): string[] {
  if (typeof window === 'undefined') return DEFAULT_COL_ORDER
  try {
    const saved = JSON.parse(localStorage.getItem(COL_ORDER_KEY) || 'null') as string[] | null
    if (!Array.isArray(saved)) return DEFAULT_COL_ORDER
    const kept = saved.filter(k => DEFAULT_COL_ORDER.includes(k))
    const added = DEFAULT_COL_ORDER.filter(k => !kept.includes(k))
    return [...kept, ...added]
  } catch { return DEFAULT_COL_ORDER }
}

/** 수집확인/데이터 마이그 목록 등에서 공용으로 쓰는, 스크랩 세션의 전체 컬럼 상세 그리드 (병합 여부 무관 조회용). */
export function StagingItemsGrid({ sessionId }: { sessionId: number | '' }) {
  const { openTab, activeTabId, refreshSignals, bumpRefresh } = useTabs()
  const [items, setItems] = useState<StagingRow[]>([])
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [discarding, setDiscarding] = useState(false)
  const [merging, setMerging] = useState(false)
  const [includeMigrated, setIncludeMigrated] = useState(false)
  const [issuesOnly, setIssuesOnly] = useState(false)
  const [filters, setFilters] = useState<Record<string, string>>({})
  const [sortKeys, setSortKeys] = useState<SortKey[]>([])
  const [showFilters, setShowFilters] = useState(false)
  const [colWidths, setColWidths] = useState<Record<string, number>>({})
  const [colOrder, setColOrder] = useState<string[]>(loadColOrder)
  const [dragKey, setDragKey] = useState<string | null>(null)

  useEffect(() => {
    try { localStorage.setItem(COL_ORDER_KEY, JSON.stringify(colOrder)) } catch {}
  }, [colOrder])

  function handleColDrop(targetKey: string) {
    if (!dragKey || dragKey === targetKey) return
    setColOrder(prev => {
      const next = prev.filter(k => k !== dragKey)
      next.splice(next.indexOf(targetKey), 0, dragKey)
      return next
    })
    setDragKey(null)
  }

  const orderedColumns = colOrder.map(k => COLUMNS.find(c => c.key === k)).filter((c): c is ColumnDef => !!c)

  function startResize(key: string, e: { clientX: number; preventDefault: () => void }) {
    e.preventDefault()
    const startX = e.clientX
    const startWidth = colWidths[key] ?? DEFAULT_COL_WIDTH[key] ?? 120
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

  const loadItems = useCallback(() => {
    if (sessionId === '') return
    fetch(`/api/scrape-staging?sessionId=${sessionId}`).then(r => r.json()).then((d: StagingRow[]) => { if (Array.isArray(d)) setItems(d) }).catch(() => {})
  }, [sessionId])

  useEffect(() => { loadItems() }, [loadItems, refreshSignals.products, refreshSignals.staging])

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => { setSelected(new Set()) }, [sessionId])
  /* eslint-enable react-hooks/set-state-in-effect */

  const issuesFiltered = issuesOnly ? items.filter(p => missingFields(p).length > 0) : items
  const filteredItems = issuesFiltered.filter(p => COLUMNS.every(col => {
    const f = filters[col.key]
    if (!f) return true
    return String(col.getValue(p) ?? '').toLowerCase().includes(f.toLowerCase())
  }))
  const visibleItems = sortKeys.length
    ? [...filteredItems].sort((a, b) => {
        for (const { key, dir } of sortKeys) {
          const col = COLUMNS.find(c => c.key === key)
          if (!col) continue
          const cmp = compareValues(col.getValue(a), col.getValue(b))
          if (cmp !== 0) return dir === 'asc' ? cmp : -cmp
        }
        return 0
      })
    : filteredItems

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
  function clearFiltersAndSort() {
    setFilters({})
    setSortKeys([])
  }

  const tableWidth = 40 + orderedColumns.reduce((sum, col) => sum + (colWidths[col.key] ?? DEFAULT_COL_WIDTH[col.key] ?? 120), 0) + 40

  function isSelectable(p: StagingRow) {
    if (p.status !== 'pending') return false
    if (p.is_already_migrated && !includeMigrated) return false
    return true
  }

  function toggleSelect(id: number) {
    setSelected(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n })
  }
  const selectableItems = visibleItems.filter(isSelectable)
  function selectAll() {
    setSelected(selected.size === selectableItems.length ? new Set() : new Set(selectableItems.map(p => p.id)))
  }

  function openDetail(p: StagingRow) {
    if (!p.matched_mall_product_id) return
    openTab({
      id: activeTabId, type: 'product-detail',
      title: p.name_original?.slice(0, 14) || `상품 #${p.matched_mall_product_id}`, icon: '📦',
      params: { mallProductId: p.matched_mall_product_id }, closable: true,
    })
  }

  async function handleMerge() {
    if (!selected.size) return
    setMerging(true)
    try {
      const ids = [...selected]
      const res = await fetch('/api/scrape-staging/merge', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids, force: includeMigrated }),
      })
      const d = await res.json() as { merged: number[]; skipped: { id: number; reason: string }[] }
      if (d.skipped?.length) {
        alert(`${d.skipped.length}개는 이미 가공된 상품이라 병합되지 않았습니다. "이미 가공된 상품도 포함"을 켜고 다시 시도하세요.`)
      }
      setSelected(new Set())
      bumpRefresh('products')
      bumpRefresh('staging')
      loadItems()
    } finally {
      setMerging(false)
    }
  }

  async function discardSelected() {
    if (!selected.size || !confirm(`선택한 ${selected.size}개 항목을 무시(삭제)할까요? 아직 확정 전인 항목만 대상입니다.`)) return
    setDiscarding(true)
    try {
      await Promise.all([...selected].map(id => fetch(`/api/scrape-staging/${id}`, { method: 'DELETE' })))
      setSelected(new Set())
      bumpRefresh('staging')
      loadItems()
    } finally {
      setDiscarding(false)
    }
  }

  async function handleExport() {
    if (sessionId === '') return
    const res = await fetch(`/api/scrape-staging/export?sessionId=${sessionId}`)
    if (!res.ok) return alert('엑셀 다운로드에 실패했습니다.')
    const blob = await res.blob()
    const cd = res.headers.get('Content-Disposition') || ''
    const match = cd.match(/filename\*=UTF-8''(.+)/)
    const name = match ? decodeURIComponent(match[1]) : '수집확인.xlsx'
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = name
    a.click()
  }

  const totalIssues = items.filter(p => missingFields(p).length > 0).length

  if (items.length === 0) {
    return (
      <div className="bg-white rounded-2xl border border-gray-200 p-12 text-center text-gray-400 shrink-0">
        <div className="text-4xl mb-3">📭</div>
        <p className="text-sm">{sessionId === '' ? '스크래핑 목록에서 항목을 선택하세요.' : '이 스크래핑에 수집된 항목이 없습니다.'}</p>
      </div>
    )
  }

  return (
    <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden flex-1 min-h-0 flex flex-col">
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 bg-gray-50 shrink-0 flex-wrap gap-2">
        <label className="flex items-center gap-3 text-xs text-gray-600 cursor-pointer">
          <span className="flex items-center gap-2">
            <input type="checkbox" checked={selected.size === selectableItems.length && selectableItems.length > 0} onChange={selectAll} />
            전체 선택 ({selectableItems.length}개 선택 가능{(hasFilters || sortKeys.length > 0 || issuesOnly) && ` · 전체 ${items.length}개 중 ${visibleItems.length}개 표시`})
          </span>
          <span className="flex items-center gap-1.5 border-l border-gray-200 pl-3">
            <input type="checkbox" checked={issuesOnly} onChange={e => setIssuesOnly(e.target.checked)} />
            누락된 데이터만 {totalIssues > 0 && `(${totalIssues}개)`}
          </span>
          <span className="flex items-center gap-1.5 border-l border-gray-200 pl-3">
            <input type="checkbox" checked={includeMigrated} onChange={e => setIncludeMigrated(e.target.checked)} />
            이미 가공된 상품도 포함
          </span>
        </label>
        <div className="flex gap-2">
          <button onClick={() => setShowFilters(v => !v)}
            className={`px-4 py-1.5 text-xs font-semibold rounded-full transition-colors ${showFilters ? 'bg-teal-500 text-white hover:bg-teal-600' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>
            🔍 필터
          </button>
          {(hasFilters || sortKeys.length > 0) && (
            <button onClick={clearFiltersAndSort}
              className="px-4 py-1.5 bg-gray-100 text-gray-600 text-xs font-semibold rounded-full hover:bg-gray-200 transition-colors">
              필터/정렬 초기화
            </button>
          )}
          <button onClick={handleExport}
            className="px-4 py-1.5 bg-slate-100 text-slate-700 text-xs font-semibold rounded-full hover:bg-slate-200 transition-colors">
            📥 엑셀 다운로드
          </button>
          {selected.size > 0 && (
            <button onClick={discardSelected} disabled={discarding}
              className="px-4 py-1.5 bg-rose-50 text-rose-600 text-xs font-semibold rounded-full hover:bg-rose-100 disabled:opacity-50 transition-colors">
              🗑 선택 무시 ({selected.size})
            </button>
          )}
          <button onClick={handleMerge} disabled={!selected.size || merging}
            className="px-4 py-1.5 bg-teal-500 text-white text-xs font-semibold rounded-full hover:bg-teal-600 disabled:opacity-40 transition-colors">
            {merging ? '병합 중...' : `선택 병합 (${selected.size})`}
          </button>
        </div>
      </div>
      <div className="overflow-x-auto overflow-y-auto flex-1 min-h-0">
        <table className="text-sm border-collapse" style={{ tableLayout: 'fixed', width: tableWidth }}>
          <colgroup>
            <col style={{ width: 40 }} />
            {orderedColumns.map(col => <col key={col.key} style={{ width: colWidths[col.key] ?? DEFAULT_COL_WIDTH[col.key] ?? 120 }} />)}
            <col style={{ width: 40 }} />
          </colgroup>
          <thead className="sticky top-0 z-10 bg-gray-50">
            <tr className="border-b border-gray-200 text-xs font-semibold text-gray-500 whitespace-nowrap">
              <th className="px-4 py-3"></th>
              {orderedColumns.map(col => {
                const idx = sortKeys.findIndex(s => s.key === col.key)
                const active = idx !== -1
                return (
                  <th key={col.key} draggable
                    onDragStart={() => setDragKey(col.key)}
                    onDragOver={e => e.preventDefault()}
                    onDrop={() => handleColDrop(col.key)}
                    onDragEnd={() => setDragKey(null)}
                    className={`relative px-2 py-3 text-left cursor-pointer select-none hover:bg-gray-100 overflow-hidden ${dragKey === col.key ? 'opacity-40' : ''}`}
                    onClick={e => handleSort(col.key, e)} title="드래그: 컬럼 순서 이동 · 클릭: 정렬 · Shift+클릭: 복합 정렬 추가">
                    <span className={active ? 'text-gray-800' : ''}>{col.label}</span>
                    {active && (
                      <span className="ml-1 text-teal-500">
                        {sortKeys[idx].dir === 'asc' ? '▲' : '▼'}{sortKeys.length > 1 ? idx + 1 : ''}
                      </span>
                    )}
                    <div onMouseDown={e => { e.stopPropagation(); startResize(col.key, e) }} onClick={e => e.stopPropagation()} draggable={false}
                      className="absolute top-0 right-0 bottom-0 w-1.5 cursor-col-resize hover:bg-teal-400 active:bg-teal-500" />
                  </th>
                )
              })}
              <th className="px-2 py-3">상세</th>
            </tr>
            {showFilters && (
              <tr className="border-b border-gray-200 bg-white">
                <th className="px-4 py-1.5"></th>
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
            {visibleItems.map(p => {
              const missing = missingFields(p)
              const optionsText = (p.options || []).map(o => `${o.name}: ${o.values.join('/')}`).join('; ')
              const thumbnailNames = p.raw_data?.thumbnail_names || []
              const detailImages = p.detail_image_urls || []
              const detailImageNames = p.raw_data?.detail_image_names || []
              const stockByOptionText = (p.raw_data?.stock_by_option || []).map(r => `${r.option}: ${r.qty}개`).join(', ')
              const extraInfoText = (p.raw_data?.extra_info || []).map(e => `${e.label}: ${e.value}`).join(' / ')
              const canOpen = !!p.matched_mall_product_id
              const statusLabel = STATUS_LABELS[p.status] || { text: p.status, cls: 'text-gray-400' }
              const selectable = isSelectable(p)

              const cells: Record<string, { node: React.ReactNode; title?: string; className?: string; stop?: boolean }> = {
                created_at: { node: new Date(p.created_at).toLocaleString() },
                thumbnail_img: {
                  node: (
                    <div className="relative w-10 h-10 rounded-lg overflow-hidden bg-gray-100">
                      {p.thumbnail_urls?.[0] ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={p.thumbnail_urls[0]} alt="" className="w-full h-full object-cover" />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center text-gray-300 text-xs">-</div>
                      )}
                      {p.thumbnail_urls?.length > 1 && (
                        <span className="absolute bottom-0 right-0 bg-black/60 text-white text-[9px] leading-none px-1 rounded-tl">+{p.thumbnail_urls.length - 1}</span>
                      )}
                    </div>
                  ),
                  className: 'px-2 py-2',
                },
                mall_product_code: { node: p.mall_product_code },
                name_original: { node: p.name_original, title: p.name_original, className: 'px-2 py-2 text-xs text-gray-700 truncate' },
                price: { node: p.price ? `₩${p.price.toLocaleString()}` : '-', className: 'px-2 py-2 text-xs text-gray-700 truncate' },
                sale_price: { node: p.sale_price ? `₩${p.sale_price.toLocaleString()}` : '-', className: 'px-2 py-2 text-xs text-gray-800 font-semibold truncate' },
                brand: { node: p.brand || '-' },
                manufacturer: { node: p.manufacturer || '-' },
                origin: { node: p.origin || '-' },
                mall_category: { node: p.mall_category || '-', title: p.mall_category || '' },
                description: { node: p.description || '-', title: p.description || '' },
                options: { node: optionsText || '-', title: optionsText },
                thumbnail_names: {
                  node: <>{p.thumbnail_urls?.length ? `${p.thumbnail_urls.length}장` : '-'}{thumbnailNames.length ? ` — ${thumbnailNames.join(', ')}` : ''}</>,
                  title: thumbnailNames.join(', '),
                },
                detail_image_urls: {
                  node: <>{detailImages.length ? `${detailImages.length}장` : '-'}{detailImageNames.length ? ` — ${detailImageNames.join(', ')}` : ''}</>,
                  title: detailImageNames.join(', '),
                },
                stock_status: {
                  node: p.stock_status === '품절' || p.stock_status?.startsWith('단종')
                    ? <span className="text-rose-500">{p.stock_status}</span>
                    : <span className="text-emerald-600">{p.stock_status || '-'}</span>,
                  className: 'px-2 py-2 text-xs truncate',
                },
                stock_qty: { node: p.stock_qty ?? '-' },
                stock_by_option: { node: stockByOptionText || '-', title: stockByOptionText },
                summary_info: { node: p.raw_data?.summary_info || '-', title: p.raw_data?.summary_info || '' },
                english_name: { node: p.raw_data?.english_name || '-', title: p.raw_data?.english_name || '' },
                detail_text: { node: p.raw_data?.detail_text || '-', title: p.raw_data?.detail_text || '' },
                extra_info: { node: extraInfoText || '-', title: extraInfoText },
                source_url: {
                  node: p.source_url ? <a href={p.source_url} target="_blank" rel="noreferrer" className="text-teal-500 hover:underline">열기 ↗</a> : '-',
                  className: 'px-2 py-2 text-xs truncate', stop: true,
                },
                missing: {
                  node: missing.length === 0
                    ? <span className="text-emerald-600">✓ 완전</span>
                    : <span className="text-amber-600" title={missing.join(', ')}>⚠ {missing.join(', ')}</span>,
                  className: 'px-2 py-2 text-xs truncate',
                },
                migration_status: {
                  node: <>{statusLabel.text}{p.is_already_migrated && <span className="text-amber-600"> · 이미가공됨</span>}</>,
                  className: `px-2 py-2 text-xs font-medium truncate ${statusLabel.cls}`,
                },
              }

              return (
              <tr key={p.id} onClick={() => openDetail(p)}
                className={`border-b border-gray-100 hover:bg-gray-50 transition-colors ${canOpen ? 'cursor-pointer' : ''} ${selected.has(p.id) ? 'bg-teal-50' : ''} ${!selectable ? 'opacity-60' : ''}`}>
                <td className="px-4 py-2" onClick={e => e.stopPropagation()}>
                  <input type="checkbox" checked={selected.has(p.id)} disabled={!selectable} onChange={() => selectable && toggleSelect(p.id)} />
                </td>

                {orderedColumns.map(col => {
                  const cell = cells[col.key]
                  return (
                    <td key={col.key} className={cell.className ?? 'px-2 py-2 text-xs text-gray-500 truncate'} title={cell.title}
                      onClick={cell.stop ? e => e.stopPropagation() : undefined}>
                      {cell.node}
                    </td>
                  )
                })}

                <td className="px-2 py-2" onClick={e => e.stopPropagation()}>
                  {canOpen && (
                    <button onClick={() => openDetail(p)} aria-label={`${p.name_original || '상품'} 상세 보기`} title="상세 보기" className="text-teal-500 hover:text-teal-600">🔍</button>
                  )}
                </td>
              </tr>
            )})}
          </tbody>
        </table>
      </div>
    </div>
  )
}
