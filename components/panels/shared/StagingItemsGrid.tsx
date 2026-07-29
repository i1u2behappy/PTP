'use client'
import { useEffect, useState, useCallback, useMemo, useRef } from 'react'
import { useTabs } from '../../shell/TabsContext'
import { useCurrentUser } from '../../shell/CurrentUserContext'
import type { ExtractedProduct } from '@/lib/ai'

interface RawExtra {
  thumbnail_names?: string[]
  detail_image_names?: string[]
  detail_text?: string
  summary_info?: string
  english_name?: string
  extra_info?: { label: string; value: string }[]
  stock_by_option?: { option: string; qty: number }[]
  /** [옵션1값, 옵션2값] 쌍 목록 — 옵션1마다 옵션2가 다르게 채워지는 몰(신우 등)의 실제 유효 조합 */
  option_combinations?: string[][]
  cost_price?: number | null
  /** "3000~4000"처럼 범위 문자열로 올 수 있다(신우 등, 배송비가 무게/지역별로 차등) */
  shipping_fee?: number | string | null
  custom_fields?: Record<string, string>
}

interface StagingRow {
  id: number
  session_id: number
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
  // 도매/공급 전용몰은 price/sale_price가 아니라 raw_data.cost_price(공급가)에만 값이 있는 게 정상이라,
  // 그 경우까지 "가격 누락"으로 잘못 표시하지 않는다.
  if (p.price == null && p.sale_price == null && p.raw_data?.cost_price == null) missing.push('가격')
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

/** 배송비는 "3000~4000"처럼 범위 문자열일 수 있다(신우 등) — 양쪽 다 콤마 포맷해 "₩3,000~₩4,000"으로 보여준다. */
function formatMoneyOrRange(v: number | string): string {
  if (typeof v === 'number') return `₩${v.toLocaleString()}`
  const [lo, hi] = v.split('~')
  return hi ? `₩${Number(lo).toLocaleString()}~₩${Number(hi).toLocaleString()}` : `₩${Number(lo).toLocaleString()}`
}

/** [옵션1값, 옵션2값] 쌍을 옵션1별로 묶어 "레드: 100/105, 블루: 100" 형태로 보여준다. */
function formatOptionCombinations(combos: string[][] | undefined): string {
  if (!combos?.length) return ''
  const byFirst = new Map<string, string[]>()
  combos.forEach(([v1, v2]) => {
    if (!byFirst.has(v1)) byFirst.set(v1, [])
    byFirst.get(v1)!.push(v2)
  })
  return [...byFirst.entries()].map(([v1, v2s]) => `${v1}: ${v2s.join('/')}`).join(', ')
}

/** 옵션(옵션1/옵션2/...)은 상품마다 개수가 달라 고정 컬럼이 아니라, 로드된 데이터 중 실제 값이 있는 최대
 *  옵션 개수만큼만 상세이미지 뒤에 동적으로 끼워 넣는다 (컴포넌트 내부의 `columns` 계산 참고). */
const COLUMNS_BEFORE_OPTIONS: ColumnDef[] = [
  { key: 'created_at', label: '스크래핑 일시', getValue: p => p.created_at },
  { key: 'source_url', label: 'URL', getValue: p => p.source_url },
  { key: 'file', label: '파일', getValue: () => '' },
  { key: 'thumbnail_img', label: '이미지', getValue: p => p.thumbnail_urls?.length ?? 0 },
  { key: 'mall_product_code', label: '상품코드', getValue: p => p.mall_product_code },
  { key: 'name_original', label: '상품명', getValue: p => p.name_original },
  { key: 'mall_category', label: '카테고리', getValue: p => p.mall_category },
  { key: 'price', label: '소비자판가', getValue: p => p.price },
  // 공급가(거래처가 받는 도매가)는 소비자판가(오픈마켓 노출 판매가)와 다른 값이다 — mall_products의
  // sale_price 컬럼은 항상 price와 같은 값이라(실제 공급가가 아님) 여기 쓰면 안 되고, 몰 페이지에서
  // "도매가/공급가" 라벨로 별도 추출한 raw_data.cost_price를 써야 한다(lib/extract.ts 참고).
  { key: 'cost_price', label: '공급가', getValue: p => p.raw_data?.cost_price ?? null },
  { key: 'shipping_fee', label: '배송비', getValue: p => p.raw_data?.shipping_fee ?? null },
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
  // 옵션1 값마다 옵션2가 다르게 채워지는 몰(신우 등)의 실제 조합 — [옵션1값, 옵션2값] 쌍을 옵션1별로 묶어
  // "레드: 100/105, 블루: 100" 형태로 보여준다(합쳐진 options 컬럼만으론 이 매칭이 안 보인다).
  { key: 'option_combinations', label: '옵션 조합(옵션1별 옵션2)', getValue: p => formatOptionCombinations(p.raw_data?.option_combinations) },
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
  mall_product_code: 100, name_original: 190, price: 100, cost_price: 100, shipping_fee: 90, brand: 90,
  manufacturer: 90, origin: 90, mall_category: 150, description: 180,
  thumbnail_names: 260, detail_image_urls: 260, stock_status: 90, stock_qty: 90, stock_by_option: 200,
  summary_info: 160, english_name: 130, detail_text: 220, extra_info: 220,
  source_url: 100, file: 60, missing: 150, migration_status: 120,
}
const MIN_COL_WIDTH = 50
function widthFor(key: string): number {
  return DEFAULT_COL_WIDTH[key] ?? (key.startsWith('option_') ? 180 : key.startsWith('custom_') ? 160 : 120)
}

// v9: 새로 추가한 '파일' 컬럼이 저장된 옛 순서에서는 그냥 맨 뒤로 붙어버려 URL 옆이라는 의도한 위치가
// 아니게 된다 — 버전을 올려 기본 순서(URL 바로 옆)로 한 번 리셋한다.
const COL_ORDER_KEY = 'stagingGrid.colOrder.v9'
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
  const { isAdmin } = useCurrentUser()
  const [items, setItems] = useState<StagingRow[]>([])
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [discarding, setDiscarding] = useState(false)
  const [merging, setMerging] = useState(false)
  const [includeMigrated, setIncludeMigrated] = useState(false)
  const [issuesOnly, setIssuesOnly] = useState(false)
  // 선택한 상품이 몇 개 안 되는데 그리드 전체(수십~수백 건)가 화면을 다 차지해, 그 아래(비교 카드 등)가
  // 안 보인다는 요청 — 켜면 선택된 행만 남기고 나머지는 숨긴다. 끄면 즉시 원래대로 전체가 다시 보인다.
  // 선택이 전부 풀리는 지점(선택 해제/선택 무시/확정)마다 같이 꺼서, 그리드가 텅 빈 채 남지 않게 한다.
  const [showOnlySelected, setShowOnlySelected] = useState(false)
  const [filters, setFilters] = useState<Record<string, string>>({})
  const [sortKeys, setSortKeys] = useState<SortKey[]>([])
  const [showFilters, setShowFilters] = useState(false)
  const [colWidths, setColWidths] = useState<Record<string, number>>({})
  const [colOrder, setColOrder] = useState<string[]>(loadColOrder)
  const [dragKey, setDragKey] = useState<string | null>(null)

  const [showAdjust, setShowAdjust] = useState(false)
  const [adjustPrompt, setAdjustPrompt] = useState('')
  // 비워두면 기존 컬럼 조정, 채우면 그 이름으로 완전히 새로운 컬럼을 추가해달라는 요청이 된다.
  const [adjustNewField, setAdjustNewField] = useState('')
  const [adjustBusy, setAdjustBusy] = useState(false)
  const [adjustMessage, setAdjustMessage] = useState<string | null>(null)
  // 몇 번이든 반복해서 조정할 수 있다 — 이 카운트가 1 이상이면(정상모드=최소 1건 테스트 성공,
  // 개발자모드=최소 1번 재기동으로 규칙 확인 성공) "조정 확정"이 활성화된다.
  const [adjustRoundCount, setAdjustRoundCount] = useState(0)
  // 개발자모드는 백엔드가 재추출을 못 하니, "개발자모드 재기동"으로 확인한 최신 학습 규칙을 대신 보여준다.
  const [adjustRules, setAdjustRules] = useState<Record<string, { type: string; value: string }> | null>(null)
  // 확장이 캡처한 페이지를 새 규칙으로 재추출한 미리보기 — 규칙 텍스트가 아니라 실제 값으로 확인하고 싶다는
  // 요청 반영. 서버가 캡처 시점에 만들어 sites.last_adjustment_preview에 저장해둔 걸 재기동이 읽어온다.
  const [adjustPreview, setAdjustPreview] = useState<ExtractedProduct | null>(null)
  // 뒤 화면(그리드)을 참조하면서 조정할 수 있게, 모달을 드래그로 옮길 수 있게 한다 — null이면 기본
  // 위치(가운데)에 두고, 한 번이라도 드래그하면 그 좌표를 그대로 기억한다.
  const [adjustPos, setAdjustPos] = useState<{ left: number; top: number } | null>(null)
  const adjustDragRef = useRef<{ offsetX: number; offsetY: number } | null>(null)

  // 옵션1/옵션2/... 컬럼은 실제 값(values)이 있는 항목만 세고, 빈 옵션 슬롯만으로는 컬럼을 만들지 않는다.
  const maxOptionCount = items.reduce((max, p) => {
    const opts = p.options || []
    let last = 0
    opts.forEach((o, i) => { if (o?.values?.length) last = i + 1 })
    return Math.max(max, last)
  }, 0)
  // "스크랩 조정"으로 추가된 커스텀 컬럼들 — 정해진 스키마가 없어, 로드된 데이터에 실제로 값이 있는
  // 필드명을 모아 옵션 컬럼과 같은 방식으로 동적으로 추가한다.
  const customFieldKeys = useMemo(() => {
    const keys = new Set<string>()
    items.forEach(p => Object.keys(p.raw_data?.custom_fields || {}).forEach(k => keys.add(k)))
    return Array.from(keys)
  }, [items])

  const columns = useMemo<ColumnDef[]>(() => {
    const optionColumns: ColumnDef[] = Array.from({ length: maxOptionCount }, (_, i) => ({
      key: `option_${i}`,
      label: `옵션${i + 1}`,
      getValue: p => { const o = p.options?.[i]; return o?.values?.length ? `${o.name}: ${o.values.join('/')}` : '' },
    }))
    const customColumns: ColumnDef[] = customFieldKeys.map(key => ({
      key: `custom_${key}`,
      label: key,
      getValue: p => p.raw_data?.custom_fields?.[key] ?? '',
    }))
    return [...COLUMNS_BEFORE_OPTIONS, ...optionColumns, ...COLUMNS_AFTER_OPTIONS, ...customColumns]
  }, [maxOptionCount, customFieldKeys])

  useEffect(() => {
    try { localStorage.setItem(COL_ORDER_KEY, JSON.stringify(colOrder)) } catch {}
  }, [colOrder])

  // 옵션 개수가 늘어나 새 옵션 컬럼이 생기면(또는 컬럼 구성이 바뀌면) colOrder에 없는 키를 뒤에 추가한다.
  // (렌더링 중 state를 조정하는 React 공식 패턴 — effect 안에서 setState하지 않도록 prevColumns로 비교)
  const [prevColumns, setPrevColumns] = useState(columns)
  if (columns !== prevColumns) {
    setPrevColumns(columns)
    const allKeys = columns.map(c => c.key)
    setColOrder(prev => {
      const kept = prev.filter(k => allKeys.includes(k))
      const added = allKeys.filter(k => !kept.includes(k))
      if (!added.length && kept.length === prev.length) return prev
      return [...kept, ...added]
    })
  }

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
  useEffect(() => { setSelected(new Set()); setShowOnlySelected(false) }, [scopeQuery])
  // "스크랩 조정" 모달은 백드롭이 없어 열어둔 채로 뒤 그리드에서 다른 세션/몰을 고를 수 있다 — 그대로 두면
  // siteId가 바뀌어도 모달은 이전 몰의 메시지/학습된 규칙/미리보기를 계속 보여줘 헷갈린다. 범위가 바뀌면
  // 모달을 닫고 상태를 비워, 다시 열 때(openAdjust) 새 몰 기준으로 시작하게 한다.
  useEffect(() => {
    setShowAdjust(false)
    setAdjustMessage(null)
    setAdjustRoundCount(0)
    setAdjustRules(null)
    setAdjustPreview(null)
  }, [siteId, sessionId])
  /* eslint-enable react-hooks/set-state-in-effect */

  const issuesFiltered = issuesOnly ? items.filter(p => missingFields(p).length > 0) : items
  const filteredItems = issuesFiltered.filter(p => columns.every(col => {
    const f = filters[col.key]
    if (!f) return true
    return String(col.getValue(p) ?? '').toLowerCase().includes(f.toLowerCase())
  }))
  const selectionFiltered = showOnlySelected ? filteredItems.filter(p => selected.has(p.id)) : filteredItems
  const visibleItems = sortKeys.length
    ? [...selectionFiltered].sort((a, b) => {
        for (const { key, dir } of sortKeys) {
          const col = columns.find(c => c.key === key)
          if (!col) continue
          const cmp = compareValues(col.getValue(a), col.getValue(b))
          if (cmp !== 0) return dir === 'asc' ? cmp : -cmp
        }
        return 0
      })
    : selectionFiltered

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

  // "스크랩 조정" 모달에서 실제 몰 페이지와 컬럼별로 비교할 목록 — 그리드에 실제 보이는 데이터 컬럼을
  // 그대로 재사용한다(아이콘/상태 등 데이터가 아닌 컬럼만 제외). 커스텀 컬럼이 추가되면 자동으로 같이 뜬다.
  const compareColumns = orderedColumns.filter(c => !['thumbnail_img', 'file', 'created_at', 'missing', 'migration_status'].includes(c.key))
  function formatCompareValue(col: ColumnDef, p: StagingRow): string {
    const v = col.getValue(p)
    if (v == null || v === '') return '-'
    if (col.key === 'price' || col.key === 'cost_price' || col.key === 'shipping_fee') {
      if (typeof v === 'number' || (col.key === 'shipping_fee' && typeof v === 'string')) return formatMoneyOrRange(v)
    }
    return String(v)
  }

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
    const turningOff = selected.size === selectableItems.length
    setSelected(turningOff ? new Set() : new Set(selectableItems.map(p => p.id)))
    if (turningOff) setShowOnlySelected(false)
  }

  function openDetail(p: StagingRow) {
    if (!p.matched_mall_product_id) return
    openTab({
      id: activeTabId, type: 'product-detail',
      title: p.name_original?.slice(0, 14) || `상품 #${p.matched_mall_product_id}`, icon: '📦',
      params: { mallProductId: p.matched_mall_product_id }, closable: true,
    })
  }

  function handleOpenSourceUrl(url: string) {
    window.open(url, '_blank', 'noreferrer')
  }

  /** 그 상품이 속한 세션의 이미지 저장 폴더(대표/상세이미지 상위)를 탐색기로 연다. */
  async function handleOpenImageFolder(rowSessionId: number) {
    const res = await fetch('/api/scrape/open-image-folder', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: rowSessionId }),
    })
    if (!res.ok) {
      const d = await res.json().catch(() => ({}))
      alert(d.error || '폴더를 열지 못했습니다')
    }
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
      setShowOnlySelected(false)
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
      setShowOnlySelected(false)
      bumpRefresh('staging')
      loadItems()
    } finally {
      setDiscarding(false)
    }
  }

  function openAdjust() {
    setShowAdjust(true)
    setAdjustPrompt('')
    setAdjustNewField('')
    setAdjustMessage(null)
    setAdjustRoundCount(0)
    setAdjustRules(null)
    setAdjustPreview(null)
    setAdjustPos(null)
  }

  /** 조정 모달 제목 표시줄을 눌러서 끄는 드래그 — 컬럼 폭 조절(startResize)과 같은 방식(마우스 이동/뗌을
   *  document에 직접 붙였다 뗀다). 뒤에 있는 그리드 내용을 보면서 조정할 수 있도록 위치를 옮길 수 있게 한다. */
  function startAdjustDrag(e: React.MouseEvent) {
    const panel = (e.currentTarget as HTMLElement).closest('[data-adjust-panel]') as HTMLElement | null
    if (!panel) return
    const rect = panel.getBoundingClientRect()
    adjustDragRef.current = { offsetX: e.clientX - rect.left, offsetY: e.clientY - rect.top }
    function onMove(ev: MouseEvent) {
      if (!adjustDragRef.current) return
      setAdjustPos({ left: ev.clientX - adjustDragRef.current.offsetX, top: ev.clientY - adjustDragRef.current.offsetY })
    }
    function onUp() {
      adjustDragRef.current = null
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  /** "스크랩 조정 개시" — 몇 번이든 반복 가능하다. 속도를 위해 지금 그리드 맨 위에 보이는 상품 1건만
   *  대상으로 규칙을 만들고 테스트해본다(일반모드, 매번 실제로 재추출해 그리드에 반영). 개발자모드는
   *  백엔드가 페이지를 못 열어보니 프롬프트만 저장해두고, 사용자가 실제 상품 페이지에서 확장 우클릭
   *  메뉴를 실행한 뒤 "개발자모드 재기동"으로 결과를 확인해야 한다. */
  async function handleAdjustStart() {
    if (!siteId || !adjustPrompt.trim()) return
    setAdjustBusy(true)
    setAdjustMessage(null)
    // 새 컬럼명을 지정했으면 작은따옴표로 감싸 프롬프트에 명시한다 — AI가 그 이름 그대로 필드명(key)을
    // 쓰도록 lib/ai.ts의 generateExtractionRules 프롬프트가 이 표기를 인식한다.
    const composedPrompt = adjustNewField.trim()
      ? `'${adjustNewField.trim()}' 필드 추가: ${adjustPrompt.trim()}`
      : adjustPrompt.trim()
    try {
      if (manualLoginRequired) {
        // 지금 화면에 보이는(방금 스크랩한 세션의) 맨 위 상품 id를 같이 보낸다 — 안 그러면 확장이 우클릭
        // 시 "이 몰에서 가장 최근에 스크랩된 미확정 상품"을 대신 골라서, 사용자가 지금 보고 있는 세션이
        // 아니라 다른 세션의 상품을 테스트해버릴 수 있었다.
        const res = await fetch(`/api/sites/${siteId}/adjust/prompt`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt: composedPrompt, itemId: visibleItems[0]?.id }),
        })
        if (!res.ok) throw new Error(`서버 오류 (${res.status})`)
        setAdjustMessage(`✓ 프롬프트를 저장했습니다. 이제 ${siteName || '이 몰'}의 아무 페이지에서나(로그인된 상태) 마우스 우클릭 → "PTP 조정 테스트 실행"을 실행한 뒤, 아래 "개발자모드 재기동"을 눌러 결과를 확인하세요.`)
        setAdjustPreview(null) // 새 라운드 — 이전 미리보기는 지금 프롬프트와 무관해졌으니 지운다
      } else {
        const target = visibleItems[0]
        if (!target) { setAdjustMessage('테스트할 상품이 없습니다.'); return }
        const res = await fetch(`/api/sites/${siteId}/adjust`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ itemId: target.id, prompt: composedPrompt }),
        })
        const data = await res.json() as { updated?: number; failed?: { error: string }[]; error?: string }
        if (!res.ok) throw new Error(data.error || `서버 오류 (${res.status})`)
        if (data.failed?.length) throw new Error(data.failed[0].error)
        setAdjustRoundCount(c => c + 1)
        setAdjustMessage(`✓ ${adjustRoundCount + 1}번째 테스트 완료 — 아래 "현재 추출된 값"에서 확인하고, 더 고칠 부분이 있으면 다시 입력해 계속 조정하세요.`)
        loadItems()
      }
    } catch (e) {
      setAdjustMessage(`실패: ${e instanceof Error ? e.message : e}`)
    } finally {
      setAdjustBusy(false)
    }
  }

  /** "개발자모드 재기동" — 사용자가 실제 브라우저에서 확장 우클릭("PTP 조정 테스트 실행")을 실행한 뒤
   *  여기로 돌아와 누른다. PTP는 그 캡처가 실제로 언제 끝났는지 알 방법이 없어서(백엔드가 그 몰 페이지를
   *  스스로 못 열어보는 게 개발자모드의 정의), 사용자가 명시적으로 "지금 확인해줘"라고 하는 이 버튼이
   *  유일한 체크포인트다 — 그 몰의 최신 학습 규칙과, 캡처한 페이지를 그 규칙으로 재추출한 미리보기 값을
   *  함께 불러와 보여준다. */
  async function handleDevRestart() {
    if (!siteId) return
    setAdjustBusy(true)
    setAdjustMessage(null)
    try {
      const res = await fetch(`/api/sites/${siteId}`)
      if (!res.ok) throw new Error(`서버 오류 (${res.status})`)
      const data = await res.json() as {
        extraction_rules?: Record<string, { type: string; value: string }>
        last_adjustment_preview?: ExtractedProduct | null
      }
      setAdjustRules(data.extraction_rules || {})
      setAdjustPreview(data.last_adjustment_preview || null)
      setAdjustRoundCount(c => c + 1)
      setAdjustMessage(data.last_adjustment_preview
        ? '✓ 캡처한 페이지를 새 규칙으로 재추출한 미리보기 값을 확인했습니다 — 아래에서 확인하고, 더 고칠 부분이 있으면 다시 입력해 계속 조정하세요.'
        : '아직 캡처된 미리보기가 없습니다 — 2단계(실제 페이지에서 "PTP 조정 테스트 실행")를 먼저 실행했는지 확인하세요.')
    } catch (e) {
      setAdjustMessage(`실패: ${e instanceof Error ? e.message : e}`)
    } finally {
      setAdjustBusy(false)
    }
  }

  /** "조정 확정" — 지금까지 반복한 조정 결과를, 이 세션뿐 아니라 이 몰에서 기 스크랩했지만 아직 미확정인
   *  전체 상품(다른 세션 포함)에 적용한다(일반모드). 개발자모드는 백엔드가 전체를 다시 스크랩할 수 없으니
   *  확장을 다시 실행하라는 안내만 보여준다("개발자모드 재기동"으로 이미 규칙 확인을 거쳤으므로 여기서
   *  다시 물어보지 않는다). */
  async function handleAdjustConfirm() {
    if (!siteId) return
    if (manualLoginRequired) {
      setAdjustMessage('카테고리 페이지에서 확장 아이콘을 다시 눌러 전체를 재스크랩해주세요 — 개발자모드는 기존 항목을 그 자리에서 못 고치고 새 세션으로 다시 수집합니다.')
      return
    }
    setAdjustBusy(true)
    setAdjustMessage(null)
    try {
      const res = await fetch(`/api/sites/${siteId}/adjust/confirm`, { method: 'POST' })
      const data = await res.json() as { updated?: number; error?: string }
      if (!res.ok) throw new Error(data.error || `서버 오류 (${res.status})`)
      setAdjustMessage(`✓ 이 몰의 미확정 상품 전체 ${data.updated ?? 0}개 항목을 재추출했습니다.`)
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
        <div className="flex items-center gap-3 text-xs text-gray-600">
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={selected.size === selectableItems.length && selectableItems.length > 0} onChange={selectAll} />
            전체 선택 ({selectableItems.length}개 선택 가능{(hasFilters || sortKeys.length > 0 || issuesOnly || showOnlySelected) && ` · 전체 ${items.length}개 중 ${visibleItems.length}개 표시`})
          </label>
          <label className="flex items-center gap-1.5 border-l border-gray-200 pl-3 cursor-pointer">
            <input type="checkbox" checked={issuesOnly} onChange={e => setIssuesOnly(e.target.checked)} />
            누락된 데이터만 {totalIssues > 0 && `(${totalIssues}개)`}
          </label>
          <label className="flex items-center gap-1.5 border-l border-gray-200 pl-3 cursor-pointer">
            <input type="checkbox" checked={includeMigrated} onChange={e => setIncludeMigrated(e.target.checked)} />
            이미 가공된 상품도 포함
          </label>
          <label className="flex items-center gap-1.5 border-l border-gray-200 pl-3 cursor-pointer">
            <input type="checkbox" checked={showOnlySelected} disabled={!selected.size} onChange={e => setShowOnlySelected(e.target.checked)} />
            선택한 것만 보기{selected.size > 0 && ` (${selected.size}개)`}
          </label>
        </div>
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
          {isAdmin && selected.size > 0 && (
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
              <th className="px-4 py-3 sticky left-0 z-20 bg-gray-50"></th>
              {orderedColumns.map((col, colIdx) => {
                const idx = sortKeys.findIndex(s => s.key === col.key)
                const active = idx !== -1
                return (
                  <th key={col.key} draggable
                    onDragStart={() => setDragKey(col.key)}
                    onDragOver={e => e.preventDefault()}
                    onDrop={() => handleColDrop(col.key)}
                    onDragEnd={() => setDragKey(null)}
                    className={`relative px-2 py-3 text-left cursor-pointer select-none hover:bg-gray-100 overflow-hidden ${dragKey === col.key ? 'opacity-40' : ''} ${colIdx === 0 ? 'sticky left-10 z-20 bg-gray-50' : ''}`}
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
                <th className="px-4 py-1.5 sticky left-0 z-20 bg-white"></th>
                {orderedColumns.map((col, colIdx) => (
                  <th key={col.key} className={`px-2 py-1.5 font-normal ${colIdx === 0 ? 'sticky left-10 z-20 bg-white' : ''}`}>
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
              const optionCombinationsText = formatOptionCombinations(p.raw_data?.option_combinations)
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
                cost_price: { node: p.raw_data?.cost_price ? `₩${p.raw_data.cost_price.toLocaleString()}` : '-', className: 'px-2 py-2 text-xs text-gray-800 font-semibold truncate' },
                shipping_fee: { node: p.raw_data?.shipping_fee != null ? formatMoneyOrRange(p.raw_data.shipping_fee) : '-', className: 'px-2 py-2 text-xs text-gray-700 truncate' },
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
                ...Object.fromEntries(customFieldKeys.map(key => {
                  const text = p.raw_data?.custom_fields?.[key] || ''
                  return [`custom_${key}`, { node: text || '-', title: text }]
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
                option_combinations: { node: optionCombinationsText || '-', title: optionCombinationsText },
                summary_info: { node: p.raw_data?.summary_info || '-', title: p.raw_data?.summary_info || '' },
                english_name: { node: p.raw_data?.english_name || '-', title: p.raw_data?.english_name || '' },
                detail_text: { node: p.raw_data?.detail_text || '-', title: p.raw_data?.detail_text || '' },
                extra_info: { node: extraInfoText || '-', title: extraInfoText },
                source_url: {
                  node: p.source_url
                    ? <button type="button" onClick={() => handleOpenSourceUrl(p.source_url!)} className="text-teal-500 hover:underline">열기 ↗</button>
                    : '-',
                  className: 'px-2 py-2 text-xs truncate', stop: true,
                },
                file: {
                  node: <button type="button" onClick={() => handleOpenImageFolder(p.session_id)} className="text-teal-500 hover:underline">열기 ↗</button>,
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

              const rowStickyBg = selected.has(p.id) ? 'bg-teal-50' : 'bg-white group-hover:bg-gray-50'
              return (
              <tr key={p.id} onClick={() => openDetail(p)}
                className={`group border-b border-gray-100 hover:bg-gray-50 transition-colors ${canOpen ? 'cursor-pointer' : ''} ${selected.has(p.id) ? 'bg-teal-50' : ''} ${!selectable ? 'opacity-60' : ''}`}>
                <td className={`px-4 py-2 sticky left-0 z-10 ${rowStickyBg}`} onClick={e => e.stopPropagation()}>
                  <input type="checkbox" checked={selected.has(p.id)} disabled={!selectable} onChange={() => selectable && toggleSelect(p.id)} />
                </td>

                {orderedColumns.map((col, colIdx) => {
                  const cell = cells[col.key]
                  return (
                    <td key={col.key} className={`${cell.className ?? 'px-2 py-2 text-xs text-gray-500 truncate'} ${colIdx === 0 ? `sticky left-10 z-10 ${rowStickyBg}` : ''}`} title={cell.title}
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
      <div className="fixed z-50"
        style={adjustPos ? { left: adjustPos.left, top: adjustPos.top } : { left: '50%', top: '50%', transform: 'translate(-50%, -50%)' }}>
        <div data-adjust-panel className="bg-white rounded-2xl border border-gray-200 shadow-2xl p-6 w-[32rem] max-w-[calc(100vw-2rem)] max-h-[85vh] overflow-y-auto">
          <div className="flex items-center gap-2 mb-1">
            <div className="flex items-center gap-2 flex-1 cursor-move select-none" onMouseDown={startAdjustDrag} title="여기를 눌러 드래그하면 위치를 옮길 수 있습니다">
              <h2 className="text-lg font-bold text-gray-800">🔧 스크랩 조정</h2>
              <span className={`px-2 py-0.5 rounded-full text-[11px] font-semibold ${manualLoginRequired ? 'bg-amber-100 text-amber-700' : 'bg-teal-100 text-teal-700'}`}>
                {manualLoginRequired ? '🧩 개발자모드' : '🤖 일반모드'}
              </span>
              <span className="text-gray-300 text-xs">✥ 드래그해서 옮기기</span>
            </div>
            <button onClick={() => setShowAdjust(false)} className="text-gray-400 hover:text-gray-600 text-sm shrink-0">닫기</button>
          </div>

          {/* 모드마다 절차가 완전히 다르므로(일반모드=자동, 개발자모드=브라우저 수동 조작 필요),
              헷갈리지 않게 지금 몰의 모드에 맞는 안내만 번호 순서로 보여준다. 만족할 때까지 몇 번이든
              반복해도 되고, 확정은 그 다음이라는 걸 명확히 한다. */}
          {manualLoginRequired ? (
            <ol className="text-xs text-gray-500 list-decimal list-inside space-y-1 mb-3">
              <li>비교·입력 — 아래 값을 몰 페이지와 비교하고 프롬프트 입력(새 컬럼은 이름도 입력) 후 <b className="text-gray-600">스크랩 조정 개시</b>(프롬프트 저장만).</li>
              <li>반영 — 이 몰 아무 페이지에서나 우클릭 → <b className="text-gray-600">PTP 조정 테스트 실행</b>.</li>
              <li>확인 — <b className="text-gray-600">개발자모드 재기동</b>으로 미리보기 값 확인, 만족할 때까지 1~2 반복.</li>
              <li>확정 — <b className="text-gray-600">조정 확정</b> 후 안내대로 확장으로 전체 재스크랩.</li>
            </ol>
          ) : (
            <ol className="text-xs text-gray-500 list-decimal list-inside space-y-1 mb-3">
              <li>비교·입력 — 아래 값을 몰 페이지와 비교하고 프롬프트 입력(새 컬럼은 이름도 입력).</li>
              <li>테스트 — <b className="text-gray-600">스크랩 조정 개시</b>로 맨 위 상품 1건 재추출해 값 확인.</li>
              <li>반복 — 원하는 값이 나올 때까지 1~2 반복.</li>
              <li>확정 — <b className="text-gray-600">조정 확정</b>으로 이 몰의 미확정 상품 전체에 반영.</li>
            </ol>
          )}
          <p className="text-[11px] text-gray-400 mb-4">확정한 내용은 앞으로 이 몰을 스크랩할 때도 계속 적용되는 규칙으로 저장됩니다.</p>

          <label className="block text-xs text-gray-500 mb-1">새 컬럼 추가 (선택 — 기존 컬럼을 고칠 때는 비워두세요)</label>
          <input value={adjustNewField} onChange={e => setAdjustNewField(e.target.value)}
            placeholder="예: 소재, 세탁방법"
            className="w-full border border-gray-300 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-400 mb-2" />

          <textarea value={adjustPrompt} onChange={e => setAdjustPrompt(e.target.value)} rows={4}
            placeholder={adjustNewField.trim()
              ? `예: 상품정보고시 표에서 '${adjustNewField.trim()}' 라벨의 값을 가져와줘.`
              : '예: 가격은 도매가격이 아니라 소비자가에서 가져와야 해. 배송비도 배송비 라벨에서 가져와줘.'}
            className="w-full border border-gray-300 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-400 mb-3" />

          {adjustMessage && <p className="text-xs text-gray-600 mb-3">{adjustMessage}</p>}

          <div className="flex gap-2 mb-4">
            <button onClick={handleAdjustStart} disabled={adjustBusy || !adjustPrompt.trim()}
              className="flex-1 py-2.5 rounded-xl bg-teal-500 text-white text-sm font-semibold hover:bg-teal-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors">
              {adjustBusy ? '처리 중...' : '스크랩 조정 개시'}
            </button>
            {manualLoginRequired && (
              <button onClick={handleDevRestart} disabled={adjustBusy}
                className="flex-1 py-2.5 rounded-xl bg-white border border-gray-300 text-gray-700 text-sm font-semibold hover:border-teal-400 disabled:opacity-50 disabled:cursor-not-allowed transition-colors">
                개발자모드 재기동
              </button>
            )}
          </div>

          {visibleItems[0] && (
            <div className="bg-gray-50 rounded-xl p-3 mb-4 text-xs text-gray-600 space-y-1 max-h-56 overflow-y-auto">
              <div className="flex items-center justify-between sticky -top-3 bg-gray-50 pb-1">
                <span className="font-semibold text-gray-700">현재 추출된 값 (맨 위 1건 · 미리보기)</span>
                {visibleItems[0].source_url && (
                  <button type="button" onClick={() => handleOpenSourceUrl(visibleItems[0].source_url!)} className="text-teal-500 hover:underline">
                    몰 상품 페이지 열기 ↗
                  </button>
                )}
              </div>
              {compareColumns.map(col => (
                <p key={col.key} className="truncate" title={formatCompareValue(col, visibleItems[0])}>
                  <span className="text-gray-400">{col.label}:</span> {formatCompareValue(col, visibleItems[0])}
                </p>
              ))}
            </div>
          )}

          {manualLoginRequired && adjustRoundCount > 0 && (
            <div className="bg-teal-50 rounded-xl p-3 mb-4 text-xs text-gray-600 space-y-1">
              <span className="font-semibold text-gray-700">미리보기 (캡처한 페이지를 새 규칙으로 재추출)</span>
              {!adjustPreview ? (
                <p className="text-gray-400">아직 캡처된 미리보기가 없습니다 — 2단계(실제 페이지에서 &quot;PTP 조정 테스트 실행&quot;)를 먼저 실행하세요.</p>
              ) : (
                <>
                  <p>상품명: {adjustPreview.name || '-'}</p>
                  <p>가격: {adjustPreview.price != null ? `₩${adjustPreview.price.toLocaleString()}` : '-'}</p>
                  <p>공급가(도매가): {adjustPreview.cost_price != null ? `₩${adjustPreview.cost_price.toLocaleString()}` : '-'}</p>
                  <p>배송비: {adjustPreview.shipping_fee != null ? formatMoneyOrRange(adjustPreview.shipping_fee) : '-'}</p>
                  <p>카테고리: {adjustPreview.category || '-'}</p>
                  <p>브랜드/제조사/원산지: {[adjustPreview.brand, adjustPreview.manufacturer, adjustPreview.origin].filter(Boolean).join(' / ') || '-'}</p>
                  {Object.entries(adjustPreview.custom_fields || {}).map(([field, value]) => (
                    <p key={field}>{field}: {value}</p>
                  ))}
                </>
              )}
            </div>
          )}

          {manualLoginRequired && adjustRules && (
            <div className="bg-gray-50 rounded-xl p-3 mb-4 text-xs text-gray-600 space-y-1">
              <span className="font-semibold text-gray-700">지금까지 학습된 규칙 (참고용)</span>
              {Object.keys(adjustRules).length === 0 ? (
                <p className="text-gray-400">아직 만들어진 규칙이 없습니다.</p>
              ) : (
                Object.entries(adjustRules).map(([field, rule]) => (
                  <p key={field}>{field}: {rule.type === 'label' ? `라벨 "${rule.value}"` : `셀렉터 "${rule.value}"`}</p>
                ))
              )}
            </div>
          )}

          <button onClick={handleAdjustConfirm}
            disabled={adjustBusy || adjustRoundCount === 0}
            title={adjustRoundCount === 0 ? '먼저 "스크랩 조정 개시"로 최소 1번 조정해보세요' : undefined}
            className="w-full py-2.5 rounded-xl bg-gray-800 text-white text-sm font-semibold hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors">
            조정 확정 (만족스러우면)
          </button>
        </div>
      </div>
    )}
    </>
  )
}
