'use client'
import { useEffect, useState, useCallback, useMemo } from 'react'
import { useTabs } from '../../shell/TabsContext'

interface RawExtra {
  thumbnail_names?: string[]
  detail_image_names?: string[]
  detail_text?: string
  summary_info?: string
  english_name?: string
  extra_info?: { label: string; value: string }[]
  stock_by_option?: { option: string; qty: number }[]
  cost_price?: number | null
  shipping_fee?: number | null
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

/** 이미지 링크가 여러 개면 한 줄씩 세로로 나열한다 (대표이미지/상세이미지 컬럼 공용). */
function ImageLinkList({ urls }: { urls: string[] }) {
  if (!urls.length) return <>-</>
  return (
    <div className="flex flex-col gap-0.5">
      {urls.map((url, i) => (
        <a key={i} href={url} target="_blank" rel="noreferrer" title={url}
          className="block truncate text-teal-500 hover:underline" onClick={e => e.stopPropagation()}>
          {url}
        </a>
      ))}
    </div>
  )
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

/** 옵션(옵션1/옵션2/...)은 상품마다 개수가 달라 고정 컬럼이 아니라, 로드된 데이터 중 실제 값이 있는 최대
 *  옵션 개수만큼만 상세이미지 뒤에 동적으로 끼워 넣는다 (컴포넌트 내부의 `columns` 계산 참고). */
const COLUMNS_BEFORE_OPTIONS: ColumnDef[] = [
  { key: 'created_at', label: '스크래핑 일시', getValue: p => p.created_at },
  { key: 'source_url', label: 'URL', getValue: p => p.source_url },
  { key: 'thumbnail_img', label: '이미지', getValue: p => p.thumbnail_urls?.length ?? 0 },
  { key: 'mall_product_code', label: '상품코드', getValue: p => p.mall_product_code },
  { key: 'name_original', label: '상품명', getValue: p => p.name_original },
  { key: 'mall_category', label: '카테고리', getValue: p => p.mall_category },
  { key: 'price', label: '소비자판가', getValue: p => p.price },
  { key: 'sale_price', label: '공급가', getValue: p => p.sale_price },
  { key: 'brand', label: '브랜드', getValue: p => p.brand },
  { key: 'manufacturer', label: '제조사', getValue: p => p.manufacturer },
  { key: 'origin', label: '원산지', getValue: p => p.origin },
  { key: 'description', label: '설명', getValue: p => p.description },
  { key: 'thumbnail_names', label: '대표이미지', getValue: p => (p.thumbnail_urls || []).join(', ') },
  { key: 'detail_image_urls', label: '상세이미지', getValue: p => (p.detail_image_urls || []).join(', ') },
]
const COLUMNS_AFTER_OPTIONS: ColumnDef[] = [
  { key: 'stock_status', label: '재고상태', getValue: p => p.stock_status },
  { key: 'stock_qty', label: '재고수량', getValue: p => p.stock_qty },
  { key: 'stock_by_option', label: '옵션별 재고', getValue: p => (p.raw_data?.stock_by_option || []).map(r => `${r.option}: ${r.qty}개`).join(', ') },
  { key: 'summary_info', label: '상품요약정보', getValue: p => p.raw_data?.summary_info || '' },
  { key: 'english_name', label: '영문상품명', getValue: p => p.raw_data?.english_name || '' },
  { key: 'detail_text', label: '상세페이지 텍스트', getValue: p => p.raw_data?.detail_text || '' },
  { key: 'extra_info', label: '상품정보고시 전체', getValue: p => (p.raw_data?.extra_info || []).map(e => `${e.label}: ${e.value}`).join(' / ') },
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
  manufacturer: 90, origin: 90, mall_category: 150, description: 180,
  thumbnail_names: 260, detail_image_urls: 260, stock_status: 90, stock_qty: 90, stock_by_option: 200,
  summary_info: 160, english_name: 130, detail_text: 220, extra_info: 220,
  source_url: 100, missing: 150, migration_status: 120,
}
const MIN_COL_WIDTH = 50
function widthFor(key: string): number {
  return DEFAULT_COL_WIDTH[key] ?? (key.startsWith('option_') ? 180 : 120)
}

const COL_ORDER_KEY = 'stagingGrid.colOrder.v7'
const DEFAULT_COL_ORDER = [...COLUMNS_BEFORE_OPTIONS, ...COLUMNS_AFTER_OPTIONS].map(c => c.key)

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

/** 수집확인/데이터 마이그 목록 등에서 공용으로 쓰는, 스크랩 세션의 전체 컬럼 상세 그리드 (병합 여부 무관 조회용).
 *  sessionId가 "선택 병합"된 세션이면 서버(/api/scrape-staging)가 그 그룹 전체를 함께 내려준다.
 *  siteId/manualLoginRequired/siteName은 "스크랩 조정" 기능용 — 셋 다 있어야(호출부가 몰 정보를 알 때만)
 *  그 버튼이 보인다(예: 데이터 마이그 목록 화면은 아직 안 넘겨줘서 자연히 숨겨짐). */
export function StagingItemsGrid({ sessionId, siteId, manualLoginRequired, siteName }: {
  sessionId: number | ''
  siteId?: number
  manualLoginRequired?: boolean | null
  siteName?: string | null
}) {
  const scopeQuery = sessionId ? `sessionId=${sessionId}` : ''
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

  const [showAdjust, setShowAdjust] = useState(false)
  const [adjustPrompt, setAdjustPrompt] = useState('')
  const [adjustBusy, setAdjustBusy] = useState(false)
  const [adjustMessage, setAdjustMessage] = useState<string | null>(null)
  const [adjustStarted, setAdjustStarted] = useState(false)
  const [adjustDevPromptSaved, setAdjustDevPromptSaved] = useState(false)

  // 옵션1/옵션2/... 컬럼은 실제 값(values)이 있는 항목만 세고, 빈 옵션 슬롯만으로는 컬럼을 만들지 않는다.
  const maxOptionCount = items.reduce((max, p) => {
    const opts = p.options || []
    let last = 0
    opts.forEach((o, i) => { if (o?.values?.length) last = i + 1 })
    return Math.max(max, last)
  }, 0)
  const columns = useMemo<ColumnDef[]>(() => {
    const optionColumns: ColumnDef[] = Array.from({ length: maxOptionCount }, (_, i) => ({
      key: `option_${i}`,
      label: `옵션${i + 1}`,
      getValue: p => { const o = p.options?.[i]; return o?.values?.length ? `${o.name}: ${o.values.join('/')}` : '' },
    }))
    return [...COLUMNS_BEFORE_OPTIONS, ...optionColumns, ...COLUMNS_AFTER_OPTIONS]
  }, [maxOptionCount])

  useEffect(() => {
    try { localStorage.setItem(COL_ORDER_KEY, JSON.stringify(colOrder)) } catch {}
  }, [colOrder])

  // 옵션 개수가 늘어나 새 옵션 컬럼이 생기면(또는 컬럼 구성이 바뀌면) colOrder에 없는 키를 뒤에 추가한다.
  useEffect(() => {
    const allKeys = columns.map(c => c.key)
    setColOrder(prev => {
      const kept = prev.filter(k => allKeys.includes(k))
      const added = allKeys.filter(k => !kept.includes(k))
      if (!added.length && kept.length === prev.length) return prev
      return [...kept, ...added]
    })
  }, [columns])

  function handleColDrop(targetKey: string) {
    if (!dragKey || dragKey === targetKey) return
    setColOrder(prev => {
      const next = prev.filter(k => k !== dragKey)
      next.splice(next.indexOf(targetKey), 0, dragKey)
      return next
    })
    setDragKey(null)
  }

  // 옵션1/옵션2/... 컬럼은 사용자가 드래그로 순서를 바꿔도 항상 상세이미지 컬럼 바로 뒤에 위치하도록 강제한다.
  const orderedColumnsRaw = colOrder.map(k => columns.find(c => c.key === k)).filter((c): c is ColumnDef => !!c)
  const orderedColumns = (() => {
    const optionCols = orderedColumnsRaw.filter(c => c.key.startsWith('option_'))
    if (!optionCols.length) return orderedColumnsRaw
    const rest = orderedColumnsRaw.filter(c => !c.key.startsWith('option_'))
    const insertAt = rest.findIndex(c => c.key === 'detail_image_urls')
    const idx = insertAt === -1 ? rest.length : insertAt + 1
    return [...rest.slice(0, idx), ...optionCols, ...rest.slice(idx)]
  })()

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

  const loadItems = useCallback(() => {
    if (!scopeQuery) return
    fetch(`/api/scrape-staging?${scopeQuery}`).then(r => r.json()).then((d: StagingRow[]) => { if (Array.isArray(d)) setItems(d) }).catch(() => {})
  }, [scopeQuery])

  useEffect(() => { loadItems() }, [loadItems, refreshSignals.products, refreshSignals.staging])

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => { setSelected(new Set()) }, [scopeQuery])
  /* eslint-enable react-hooks/set-state-in-effect */

  const issuesFiltered = issuesOnly ? items.filter(p => missingFields(p).length > 0) : items
  const filteredItems = issuesFiltered.filter(p => columns.every(col => {
    const f = filters[col.key]
    if (!f) return true
    return String(col.getValue(p) ?? '').toLowerCase().includes(f.toLowerCase())
  }))
  const visibleItems = sortKeys.length
    ? [...filteredItems].sort((a, b) => {
        for (const { key, dir } of sortKeys) {
          const col = columns.find(c => c.key === key)
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

  const tableWidth = 40 + orderedColumns.reduce((sum, col) => sum + (colWidths[col.key] ?? widthFor(col.key)), 0) + 40

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
      const d = await res.json() as { merged: number[]; skipped: { id: number; reason: string }[]; noClient?: number[] }
      if (d.skipped?.length) {
        alert(`${d.skipped.length}개는 이미 가공된 상품이라 확정되지 않았습니다. "이미 가공된 상품도 포함"을 켜고 다시 시도하세요.`)
      }
      if (d.noClient?.length) {
        alert(`${d.noClient.length}개는 몰에 거래처가 연결되어 있지 않아 상품마스터로 반영되지 않았습니다. Mall 상세관리에서 거래처를 먼저 지정해주세요.`)
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

  function openAdjust() {
    setShowAdjust(true)
    setAdjustPrompt('')
    setAdjustMessage(null)
    setAdjustStarted(false)
    setAdjustDevPromptSaved(false)
  }

  /** "스크랩 조정 개시" — 속도를 위해 지금 그리드 맨 위에 보이는 상품 1건만 대상으로 규칙을 만들고
   *  테스트해본다(일반모드). 개발자모드는 백엔드가 페이지를 못 열어보니 프롬프트만 저장해두고 사용자가
   *  실제 상품 페이지에서 확장 우클릭 메뉴를 실행해야 한다. */
  async function handleAdjustStart() {
    if (!siteId || !adjustPrompt.trim()) return
    const target = visibleItems[0]
    setAdjustBusy(true)
    setAdjustMessage(null)
    try {
      if (manualLoginRequired) {
        const res = await fetch(`/api/sites/${siteId}/adjust/prompt`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt: adjustPrompt }),
        })
        if (!res.ok) throw new Error(`서버 오류 (${res.status})`)
        setAdjustDevPromptSaved(true)
      } else {
        if (!target) { setAdjustMessage('테스트할 상품이 없습니다.'); return }
        const res = await fetch(`/api/sites/${siteId}/adjust`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ itemId: target.id, prompt: adjustPrompt }),
        })
        const data = await res.json() as { updated?: number; failed?: { error: string }[]; error?: string }
        if (!res.ok) throw new Error(data.error || `서버 오류 (${res.status})`)
        if (data.failed?.length) throw new Error(data.failed[0].error)
        setAdjustMessage('✓ 1개 상품에 테스트 적용했습니다 — 그리드 첫 줄에서 결과를 확인해보세요.')
        setAdjustStarted(true)
        loadItems()
      }
    } catch (e) {
      setAdjustMessage(`실패: ${e instanceof Error ? e.message : e}`)
    } finally {
      setAdjustBusy(false)
    }
  }

  /** "조정 확정" — 테스트해본 규칙을 이 세션의 미확정 상품 전체에 적용한다(일반모드). 개발자모드는
   *  PTP가 그 결과(확장 캡처가 실제로 규칙을 만들었는지)를 알 방법이 없으니, 사용자가 우클릭 캡처를
   *  실제로 마쳤는지 먼저 확인한 뒤 다음 단계(재스크랩)를 안내한다 — 안 했는데 눌러 헷갈리지 않도록. */
  async function handleAdjustConfirm() {
    if (!siteId) return
    if (manualLoginRequired) {
      const done = confirm(`${siteName || '이 몰'} 상품 페이지에서 마우스 우클릭 → "PTP 조정 반영"을 이미 실행하셨나요?\n\n아직이라면 취소를 누르고 먼저 그 단계를 진행해주세요.`)
      if (!done) return
      setAdjustMessage('좋습니다. 이제 카테고리 페이지에서 확장 아이콘을 다시 눌러 전체를 재스크랩해주세요 — 개발자모드는 기존 항목을 그 자리에서 못 고치고 새 세션으로 다시 수집합니다.')
      return
    }
    if (!sessionId) return
    setAdjustBusy(true)
    setAdjustMessage(null)
    try {
      const res = await fetch(`/api/sites/${siteId}/adjust/confirm`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      })
      const data = await res.json() as { updated?: number; error?: string }
      if (!res.ok) throw new Error(data.error || `서버 오류 (${res.status})`)
      setAdjustMessage(`✓ 전체 ${data.updated ?? 0}개 항목을 재추출했습니다.`)
      bumpRefresh('staging')
      loadItems()
    } catch (e) {
      setAdjustMessage(`실패: ${e instanceof Error ? e.message : e}`)
    } finally {
      setAdjustBusy(false)
    }
  }

  async function handleExport() {
    if (!scopeQuery) return
    // 그리드에 실제로 보이는 것(현재 컬럼 순서·필터·정렬 결과) 그대로 내보낸다 — 서버가 별도 컬럼 구성을
    // 갖고 있으면 화면과 엑셀 내용이 어긋나므로, 화면과 같은 columns/getValue를 그대로 재사용한다.
    const headers = orderedColumns.map(c => c.label)
    const rows = visibleItems.map(p => orderedColumns.map(c => c.getValue(p) ?? ''))
    const res = await fetch(`/api/scrape-staging/export?${scopeQuery}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ headers, rows }),
    })
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
        <p className="text-sm">{!scopeQuery ? '스크래핑 목록에서 항목을 선택하세요.' : '이 스크래핑에 수집된 항목이 없습니다.'}</p>
      </div>
    )
  }

  return (
    <>
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
            className="px-4 py-1.5 bg-gray-100 text-gray-600 text-xs font-semibold rounded-full hover:bg-gray-200 transition-colors">
            📥 엑셀 다운로드
          </button>
          {selected.size > 0 && (
            <button onClick={discardSelected} disabled={discarding}
              className="px-4 py-1.5 bg-rose-50 text-rose-600 text-xs font-semibold rounded-full hover:bg-rose-100 disabled:opacity-50 transition-colors">
              🗑 선택 무시 ({selected.size})
            </button>
          )}
          {siteId != null && (
            <button onClick={openAdjust}
              className="px-4 py-1.5 bg-white border border-gray-300 text-gray-600 text-xs font-semibold rounded-full hover:border-teal-400 transition-colors">
              🔧 스크랩 조정
            </button>
          )}
          <button onClick={handleMerge} disabled={!selected.size || merging}
            className="px-4 py-1.5 bg-teal-500 text-white text-xs font-semibold rounded-full hover:bg-teal-600 disabled:opacity-40 transition-colors">
            {merging ? '확정 중...' : `확정 (스크랩검수 후) (${selected.size})`}
          </button>
        </div>
      </div>
      <div className="overflow-x-auto overflow-y-auto flex-1 min-h-0">
        <table className="text-sm border-collapse" style={{ tableLayout: 'fixed', width: tableWidth }}>
          <colgroup>
            <col style={{ width: 40 }} />
            {orderedColumns.map(col => <col key={col.key} style={{ width: colWidths[col.key] ?? widthFor(col.key) }} />)}
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
                ...Object.fromEntries(Array.from({ length: maxOptionCount }, (_, i) => {
                  const o = p.options?.[i]
                  const text = o?.values?.length ? `${o.name}: ${o.values.join('/')}` : ''
                  return [`option_${i}`, { node: text || '-', title: text }]
                })),
                thumbnail_names: {
                  node: <ImageLinkList urls={p.thumbnail_urls || []} />,
                  className: 'px-2 py-2 text-xs text-gray-500', stop: true,
                },
                detail_image_urls: {
                  node: <ImageLinkList urls={p.detail_image_urls || []} />,
                  className: 'px-2 py-2 text-xs text-gray-500', stop: true,
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

    {showAdjust && siteId != null && (
      <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50 p-4" onClick={() => setShowAdjust(false)}>
        <div className="bg-white rounded-2xl border border-gray-200 p-6 w-full max-w-lg" onClick={e => e.stopPropagation()}>
          <div className="flex items-center gap-2 mb-1">
            <h2 className="text-lg font-bold text-gray-800">🔧 스크랩 조정</h2>
            <span className={`px-2 py-0.5 rounded-full text-[11px] font-semibold ${manualLoginRequired ? 'bg-amber-100 text-amber-700' : 'bg-teal-100 text-teal-700'}`}>
              {manualLoginRequired ? '🧩 개발자모드' : '🤖 일반모드'}
            </span>
            <button onClick={() => setShowAdjust(false)} className="ml-auto text-gray-400 hover:text-gray-600 text-sm">닫기</button>
          </div>

          {/* 모드마다 절차가 완전히 다르므로(일반모드=자동, 개발자모드=브라우저 수동 조작 필요),
              헷갈리지 않게 지금 몰의 모드에 맞는 안내만 번호 순서로 보여준다. */}
          {manualLoginRequired ? (
            <ol className="text-xs text-gray-500 list-decimal list-inside space-y-1 mb-3">
              <li>아래에 조정 내용을 입력하고 <b className="text-gray-600">스크랩 조정 개시</b>를 누르면 프롬프트가 저장됩니다 (이 몰은 개발자모드라 PTP가 페이지를 직접 열어볼 수 없어요).</li>
              <li><b className="text-gray-600">{siteName || '이 몰'}</b> 상품 페이지(맨 위 상품 페이지 권장)를 열고 마우스 우클릭 → <b className="text-gray-600">PTP 조정 반영</b>을 눌러 규칙을 만드세요.</li>
              <li>규칙을 만들었으면 <b className="text-gray-600">조정 확정</b>을 눌러, 안내에 따라 카테고리 페이지에서 확장 아이콘을 다시 실행해 전체를 재스크랩하세요.</li>
            </ol>
          ) : (
            <ol className="text-xs text-gray-500 list-decimal list-inside space-y-1 mb-3">
              <li>아래에 조정 내용을 입력하고 <b className="text-gray-600">스크랩 조정 개시</b>를 누르면, 맨 위 상품 1건으로 자동 테스트합니다.</li>
              <li>그리드 첫 줄에서 결과가 맞는지 확인하세요.</li>
              <li>맞으면 <b className="text-gray-600">조정 확정</b>을 눌러 이 세션의 전체 상품에 반영하세요.</li>
            </ol>
          )}
          <p className="text-[11px] text-gray-400 mb-4">확정한 내용은 앞으로 이 몰을 스크랩할 때도 계속 적용되는 규칙으로 저장됩니다.</p>

          {visibleItems[0] && (
            <div className="bg-gray-50 rounded-xl p-3 mb-4 text-xs text-gray-600 space-y-1">
              <div className="flex items-center justify-between">
                <span className="font-semibold text-gray-700">현재 추출된 값 (맨 위 1건)</span>
                {visibleItems[0].source_url && (
                  <a href={visibleItems[0].source_url} target="_blank" rel="noreferrer" className="text-teal-500 hover:underline">몰 상품 페이지 열기 ↗</a>
                )}
              </div>
              <p>상품명: {visibleItems[0].name_original || '-'}</p>
              <p>가격: {visibleItems[0].price != null ? `₩${visibleItems[0].price.toLocaleString()}` : '-'}</p>
              <p>공급가(도매가): {visibleItems[0].raw_data?.cost_price != null ? `₩${visibleItems[0].raw_data.cost_price.toLocaleString()}` : '-'}</p>
              <p>배송비: {visibleItems[0].raw_data?.shipping_fee != null ? `₩${visibleItems[0].raw_data.shipping_fee.toLocaleString()}` : '-'}</p>
              <p>카테고리: {visibleItems[0].mall_category || '-'}</p>
            </div>
          )}

          {manualLoginRequired && adjustDevPromptSaved ? (
            <p className="text-sm text-gray-700 bg-teal-50 border border-teal-200 rounded-xl px-3 py-3 mb-3">
              ✓ 1단계 완료(프롬프트 저장됨). 이제 2단계 — {siteName || '이 몰'} 상품 페이지(맨 위 상품 페이지
              권장)를 열고 마우스 우클릭 → &quot;PTP 조정 반영&quot;을 눌러주세요. 끝나면 아래
              &quot;조정 확정&quot;을 눌러 3단계로 넘어가세요.
            </p>
          ) : (
            <textarea value={adjustPrompt} onChange={e => setAdjustPrompt(e.target.value)} rows={4}
              placeholder="예: 가격은 도매가격이 아니라 소비자가에서 가져와야 해. 배송비도 배송비 라벨에서 가져와줘."
              className="w-full border border-gray-300 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-400 mb-3" />
          )}

          {adjustMessage && <p className="text-xs text-gray-600 mb-3">{adjustMessage}</p>}

          <div className="flex gap-2">
            <button onClick={handleAdjustStart} disabled={adjustBusy || !adjustPrompt.trim() || (manualLoginRequired ? adjustDevPromptSaved : false)}
              className="flex-1 py-2.5 rounded-xl bg-teal-500 text-white text-sm font-semibold hover:bg-teal-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors">
              {adjustBusy ? '처리 중...' : '스크랩 조정 개시'}
            </button>
            <button onClick={handleAdjustConfirm}
              disabled={adjustBusy || (manualLoginRequired ? !adjustDevPromptSaved : !adjustStarted)}
              title={manualLoginRequired && !adjustDevPromptSaved ? '먼저 "스크랩 조정 개시"로 프롬프트를 저장해주세요' : !manualLoginRequired && !adjustStarted ? '먼저 "스크랩 조정 개시"로 1건 테스트를 해주세요' : undefined}
              className="flex-1 py-2.5 rounded-xl bg-white border border-gray-300 text-gray-700 text-sm font-semibold hover:border-teal-400 disabled:opacity-50 disabled:cursor-not-allowed transition-colors">
              조정 확정
            </button>
          </div>
        </div>
      </div>
    )}
    </>
  )
}
