'use client'
import { useEffect, useState, useCallback, useMemo, useRef } from 'react'
import { useTabs } from '../../shell/TabsContext'
import { useRegisteredFieldKeys } from './useRegisteredFieldKeys'
import { FIXED_FIELD_INFO } from '../../../lib/master/schema'

// 기준 Master 테이블 관리와 같은 라벨을 쓴다 — 사용자가 그 화면에서 라벨을 직접 바꿔둔 경우(예: cost_price를
// "원가" 대신 "공급가"로) 있으므로 FIXED_FIELD_INFO는 로딩 전/미등록 키의 기본값일 뿐, 실제 라벨은
// useRegisteredFieldKeys가 돌려주는 DB 값을 우선한다 (컴포넌트 내부 fixedFieldLabel 계산 참고).
const DEFAULT_FIELD_LABEL = new Map(FIXED_FIELD_INFO.map(f => [f.key, f.label]))
// lib/extract.ts의 CLAIMED_INFO_LABEL_RE와 같은 목록 — 그 파일은 Playwright 등 서버 전용 코드를 담고 있어
// 클라이언트 컴포넌트에서 import하지 않고 복제해 둔다(ScraperPanel.tsx와 동일한 패턴). 하나를 고치면 셋 다
// 맞춰야 한다.
const CLAIMED_INFO_LABEL_RE = /브랜드|제조사|제조자|원산지|제조국|상품요약정보|영문상품명|유통기한|소비기한|상품코드|정가|판매가|소비자가|시중가|정상가|공급가|도매가|배송비|택배비/i
/** ColumnDef.key(그리드 내부 컬럼명) -> master_schema_fields.field_key(라벨/정렬 기준 조회 키) —
 *  라벨뿐 아니라 기본 컬럼 순서도 이 매핑을 통해 기준 마스터테이블의 sort_order를 따라간다(아래
 *  reorderByMaster 참고). 그리드 전용 운영 컬럼(스크래핑 일시/URL/누락 데이터/마이그레이션 상태 등,
 *  기준 테이블에 대응 필드가 없는 것)은 매핑하지 않고 원래 상대 위치에 그대로 둔다. */
const COLUMN_TO_MASTER_KEY: Record<string, string> = {
  name_original: 'name_final', mall_category: 'master_category', price: 'list_price', cost_price: 'cost_price',
  shipping_fee: 'shipping_fee', brand: 'brand', manufacturer: 'manufacturer', origin: 'origin', description: 'description',
  thumbnail_names: 'top_img', detail_image_urls: 'detail_img', stock_status: 'stock_status', stock_qty: 'stock_qty',
  source_url: 'product_url',
}

/** colOrder 중 기준 마스터테이블에 대응 필드가 있는 것만 그 sort_order대로 서로 재배치한다 — 대응이
 *  없는(그리드 전용) 컬럼은 원래 있던 자리에 그대로 남는다. 사용자가 드래그로 이미 순서를 바꿔둔 뒤에는
 *  호출하지 않는다(개인화 유지, 컴포넌트 내부 호출부 참고). */
function reorderByMaster(order: string[], masterOrder: string[]): string[] {
  const positions = order.map((k, i) => (COLUMN_TO_MASTER_KEY[k] ? i : -1)).filter(i => i !== -1)
  if (!positions.length) return order
  const sortedKeys = positions.map(i => order[i])
    .sort((a, b) => masterOrder.indexOf(COLUMN_TO_MASTER_KEY[a]) - masterOrder.indexOf(COLUMN_TO_MASTER_KEY[b]))
  const next = [...order]
  positions.forEach((pos, idx) => { next[pos] = sortedKeys[idx] })
  return next
}

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
  // 체크박스 바로 옆(맨 앞)에 고정 — 확정/미확정이 뒤쪽에 있으면(예전엔 맨 끝) 찾기 어렵고, 이 값으로
  // 정렬·필터하려는 요청이 실사용 중 있었다(2026-08-13). colIdx===0 sticky 처리가 위치 기반이라 이
  // 컬럼을 맨 앞에 두는 것만으로 자동으로 고정된다.
  { key: 'migration_status', label: '확정여부', getValue: p => STATUS_LABELS[p.status]?.text || p.status },
  { key: 'created_at', label: '스크래핑 일시', getValue: p => p.created_at },
  { key: 'source_url', label: 'URL', getValue: p => p.source_url },
  { key: 'file', label: '파일', getValue: () => '' },
  { key: 'thumbnail_img', label: '이미지', getValue: p => p.thumbnail_urls?.length ?? 0 },
  { key: 'mall_product_code', label: '상품코드', getValue: p => p.mall_product_code },
  { key: 'name_original', label: '상품명', getValue: p => p.name_original },
  { key: 'mall_category', label: '카테고리', getValue: p => p.mall_category },
  { key: 'price', label: DEFAULT_FIELD_LABEL.get('list_price')!, getValue: p => p.price },
  // 공급가(거래처가 받는 도매가, 기준 테이블의 "원가")는 정상가(오픈마켓 노출 판매가)와 다른 값이다 —
  // mall_products의 sale_price 컬럼은 항상 price와 같은 값이라(실제 공급가가 아님) 여기 쓰면 안 되고,
  // 몰 페이지에서 "도매가/공급가" 라벨로 별도 추출한 raw_data.cost_price를 써야 한다(lib/extract.ts 참고).
  { key: 'cost_price', label: DEFAULT_FIELD_LABEL.get('cost_price')!, getValue: p => p.raw_data?.cost_price ?? null },
  { key: 'shipping_fee', label: DEFAULT_FIELD_LABEL.get('shipping_fee')!, getValue: p => p.raw_data?.shipping_fee ?? null },
  { key: 'brand', label: '브랜드', getValue: p => p.brand },
  { key: 'manufacturer', label: '제조사', getValue: p => p.manufacturer },
  { key: 'origin', label: '원산지', getValue: p => p.origin },
  { key: 'description', label: DEFAULT_FIELD_LABEL.get('description')!, getValue: p => p.description },
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

// v10: '확정여부'(migration_status)를 맨 끝에서 맨 앞으로 옮겼다 — 저장된 옛 순서에서는 그냥 유지될 뿐이라
// (loadColOrder는 새로 추가된 키만 뒤에 붙인다, 기존 키의 위치 이동은 반영 안 함) 버전을 올려 한 번 리셋한다.
const COL_ORDER_KEY = 'stagingGrid.colOrder.v10'
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
 *  sessionId가 "선택 병합"된 세션이면 서버(/api/scrape-staging)가 그 그룹 전체를 함께 내려준다. */
export function StagingItemsGrid({ sessionId }: {
  sessionId: number | ''
}) {
  const scopeQuery = sessionId ? `sessionId=${sessionId}` : ''
  const { openDetailModal, refreshSignals, bumpRefresh } = useTabs()
  const { customKeys: registeredCustomKeys, labels: registryLabels } = useRegisteredFieldKeys()
  const [items, setItems] = useState<StagingRow[]>([])
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [merging, setMerging] = useState(false)
  // "확정" 진행률/경과시간 표시용 — total 0이면 아직 폴링 시작 전(또는 서버가 이 batchId를 아직 못 받음).
  const [mergeProgress, setMergeProgress] = useState<{ total: number; done: number; elapsedSec: number } | null>(null)
  const mergeProgressPollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const mergeStartedAtRef = useRef(0)
  useEffect(() => () => { if (mergeProgressPollRef.current) clearInterval(mergeProgressPollRef.current) }, [])
  const [unmerging, setUnmerging] = useState(false)
  // "확정" 결과 중 거래처 미연결로 상품마스터 반영을 건너뛴 건수 — 거래처는 나중에 지정해도 되는 선택
  // 항목이라(Mall 상세관리에서 언제든 연결 가능) 브라우저 네이티브 alert()로 막아서는 대신, 화면 안에
  // 조용히 배너로 알리고 사용자가 직접 닫을 때까지 남겨둔다(사용자 지적, 2026-09-09 — "이 부분은 PTP의
  // 메시지로 띄워줘야 하는 거 아니야?", "몰에 거래처 지정은 나중에 할 수 있게 했잖아").
  const [noClientWarning, setNoClientWarning] = useState<string | null>(null)
  const [filters, setFilters] = useState<Record<string, string>>({})
  const [sortKeys, setSortKeys] = useState<SortKey[]>([])
  const [showFilters, setShowFilters] = useState(false)
  const [colWidths, setColWidths] = useState<Record<string, number>>({})
  const [colOrder, setColOrder] = useState<string[]>(loadColOrder)
  const [dragKey, setDragKey] = useState<string | null>(null)
  // 사용자가 드래그로 순서를 바꾼 적이 없으면(저장된 값 없음) 기준 마스터테이블 순서가 로드되는 대로
  // 그 순서를 기본값으로 한 번 반영한다 — 이미 순서를 바꿔둔 사용자의 개인화는 그대로 유지한다.
  const hadSavedOrderRef = useRef(typeof window !== 'undefined' && localStorage.getItem(COL_ORDER_KEY) !== null)
  useEffect(() => {
    if (hadSavedOrderRef.current || registryLabels.size === 0) return
    setColOrder(prev => reorderByMaster(prev, Array.from(registryLabels.keys())))
  }, [registryLabels])

  // 옵션1/옵션2/... 컬럼은 실제 값(values)이 있는 항목만 세고, 빈 옵션 슬롯만으로는 컬럼을 만들지 않는다.
  const maxOptionCount = items.reduce((max, p) => {
    const opts = p.options || []
    let last = 0
    opts.forEach((o, i) => { if (o?.values?.length) last = i + 1 })
    return Math.max(max, last)
  }, 0)
  // 스크랩 시 실제로 값이 있는 커스텀 필드명에 더해, 기준 Master
  // 테이블 관리에 등록된 커스텀 필드도 함께 포함한다 — 아직 스크랩 데이터에 값이 하나도 없어도(등록만
  // 해두고 값은 나중에 채우는 경우) 빈 컬럼으로라도 미리 보여야 기준 테이블과 그리드가 어긋나지 않는다.
  // 이미 전용 컬럼(위 COLUMN_TO_MASTER_KEY)이나 동적 옵션 컬럼이 보여주는 것과 같은 개념의 마스터
  // 필드는 커스텀 컬럼으로 또 만들지 않는다 — 예: product_url은 URL 컬럼(source_url)과, 1_option~
  // 3_option은 실제 옵션명 기준 동적 컬럼과 중복이라 여기서 제외한다.
  const claimedMasterKeys = useMemo(() => new Set([
    ...Object.values(COLUMN_TO_MASTER_KEY),
    ...Array.from({ length: maxOptionCount }, (_, i) => `${i + 1}_option`),
  ]), [maxOptionCount])

  const customFieldKeys = useMemo(() => {
    const keys = new Set<string>(registeredCustomKeys)
    items.forEach(p => Object.keys(p.raw_data?.custom_fields || {}).forEach(k => keys.add(k)))
    return Array.from(keys).filter(k => !claimedMasterKeys.has(k))
  }, [items, registeredCustomKeys, claimedMasterKeys])

  const columns = useMemo<ColumnDef[]>(() => {
    const optionColumns: ColumnDef[] = Array.from({ length: maxOptionCount }, (_, i) => ({
      key: `option_${i}`,
      label: `옵션${i + 1}`,
      getValue: p => { const o = p.options?.[i]; return o?.values?.length ? `${o.name}: ${o.values.join('/')}` : '' },
    }))
    const customColumns: ColumnDef[] = customFieldKeys.map(key => ({
      key: `custom_${key}`,
      label: registryLabels.get(key) ?? key,
      getValue: p => p.raw_data?.custom_fields?.[key] ?? '',
    }))
    const merged = [...COLUMNS_BEFORE_OPTIONS, ...optionColumns, ...COLUMNS_AFTER_OPTIONS, ...customColumns]
    const labeled = merged.map(c => {
      const masterKey = COLUMN_TO_MASTER_KEY[c.key]
      const liveLabel = masterKey ? registryLabels.get(masterKey) : undefined
      return liveLabel ? { ...c, label: liveLabel } : c
    })
    // "상품정보고시 전체"(extra_info)는 이미 다른 컬럼(전용 필드든, 커스텀 필드로 자동 추가된 컬럼이든)으로
    // 보여주는 라벨과 겹치면 그 라벨은 빼고 보여준다 — 스크랩 미리보기(ScraperPanel.tsx)와 같은 기준
    // (다른 컬럼 라벨과 완전히 같거나 CLAIMED_INFO_LABEL_RE 동의어에 걸리면 제외)을 그대로 적용한다.
    const shownLabels = new Set(labeled.filter(c => c.key !== 'extra_info').map(c => c.label))
    return labeled.map(c => c.key === 'extra_info'
      ? {
          ...c,
          getValue: (p: StagingRow) => (p.raw_data?.extra_info || [])
            .filter(e => !shownLabels.has(e.label) && !CLAIMED_INFO_LABEL_RE.test(e.label))
            .map(e => `${e.label}: ${e.value}`).join(' / '),
        }
      : c)
  }, [maxOptionCount, customFieldKeys, registryLabels])

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
  useEffect(() => { setSelected(new Set()) }, [scopeQuery])
  /* eslint-enable react-hooks/set-state-in-effect */

  /** 확정 진행률 폴링 — handleMerge(이 화면이 직접 보낸 POST)와, 마운트 시 이어받는 재연결 두 경우 모두
   *  이 함수 하나를 쓴다. selfManaged가 true면(재연결 — 이 화면엔 기다릴 원본 POST가 없음) 배치가 끝나는
   *  순간(active:false) 스스로 폴링을 멈추고 화면을 정리한다. false면(직접 보낸 경우) handleMerge의 원래
   *  POST가 끝날 때 자기 finally에서 정리하므로 여기서는 진행률 갱신만 한다(기존 동작 그대로 유지).
   *
   *  ids를 쿼리스트링으로 보내던 예전 방식(/merge/progress?ids=...)은 선택한 상품이 수천 개면 URL
   *  길이가 2만 자를 넘어 Node가 요청 자체를 431(Request Header Fields Too Large)로 거절했다 — 화면은
   *  이 실패를 조용히 삼켜서(catch(() => null)) 진행률이 0%에서 안 움직이는 것처럼 보였다(사용자 실사용
   *  확인, 2026-09-06 — 확정 자체는 서버에서 정상 진행 중이었는데 화면만 그렇게 보였음). /merge/active는
   *  ids를 요청에 실을 필요 없이 서버가 기억해둔 진행 중인 배치(getActiveMergeBatch)를 그대로 돌려주므로
   *  이 문제 자체가 생기지 않는다 — 재연결 경로가 이미 이 라우트를 쓰고 있던 것과 같은 이유. */
  function pollMergeProgress(total: number, startedAtMs: number, opts: { selfManaged: boolean }) {
    mergeStartedAtRef.current = startedAtMs
    setMerging(true)
    setMergeProgress({ total, done: 0, elapsedSec: Math.floor((Date.now() - startedAtMs) / 1000) })
    if (mergeProgressPollRef.current) clearInterval(mergeProgressPollRef.current)
    mergeProgressPollRef.current = setInterval(async () => {
      const res = await fetch('/api/scrape-staging/merge/active').catch(() => null)
      const d = await res?.json().catch(() => null) as { active: boolean; total?: number; done?: number } | null
      const elapsedSec = Math.floor((Date.now() - mergeStartedAtRef.current) / 1000)
      setMergeProgress(d?.active
        ? { total: d.total ?? total, done: d.done ?? 0, elapsedSec }
        : prev => prev && { ...prev, elapsedSec })
      if (opts.selfManaged && d && !d.active) {
        if (mergeProgressPollRef.current) { clearInterval(mergeProgressPollRef.current); mergeProgressPollRef.current = null }
        setMerging(false)
        setMergeProgress(null)
        bumpRefresh('products')
        bumpRefresh('staging')
        loadItems()
      }
    }, 800)
  }

  // 마운트 시(새로고침 포함) 다른 데서(또는 새로고침 전 이 화면 자신이) 이미 시작해둔 확정 배치가 서버에서
  // 여전히 진행 중인지 확인한다 — "5분 넘게 진행률이 0%"로 보이던 문제(실사용 확인, 2026-08-27)는 실제로는
  // 서버가 계속 일하고 있는데 화면(React state)만 새로고침으로 사라졌던 것이라, 여기서 이어붙인다.
  useEffect(() => {
    fetch('/api/scrape-staging/merge/active').then(r => r.json()).then((d: {
      active: boolean; ids?: number[]; total?: number; startedAtMs?: number
    }) => {
      if (d.active && d.ids?.length) {
        pollMergeProgress(d.ids.length, d.startedAtMs ?? Date.now(), { selfManaged: true })
      }
    }).catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const filteredItems = items.filter(p => columns.every(col => {
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

  // 예전엔 이미 상품마스터로 확정된 적 있는 상품(is_already_migrated)을 선택 대상에서 뺐는데, 사용자
  // 지시로 뒤집었다 — "스크랩 Raw 확인"은 세션(스크랩 건)별로 확정하는 화면이라, 이번에 새로 스크랩한
  // 내용이면 예전에 확정된 적이 있어도 그 내용 기준으로 다시 확정할 수 있어야 한다(최신 스크랩값으로
  // 덮어쓰는 것이 오히려 의도된 동작). "예전 확정 이력 대비 신규/변경분만" 판단은 이 화면이 아니라
  // 별도 메뉴(연속관리 등)에서 필요할 때 다루기로 함 — is_already_migrated 데이터 자체는 그대로 남겨
  // 참고용 배지(아래 "이미가공됨" 표시)로만 계속 보여준다.
  // merged 행도 선택 가능해졌다(2026-08-13) — "미확정으로 되돌리기"의 대상이라 확정 대상(pending)과는
  // 별개로 선택할 수 있어야 한다. skipped(건너뛴) 행은 둘 중 어느 액션의 대상도 아니라 여전히 제외한다.
  function isSelectable(p: StagingRow) {
    return p.status === 'pending' || p.status === 'merged'
  }

  function toggleSelect(id: number) {
    setSelected(s => {
      const n = new Set(s)
      if (n.has(id)) n.delete(id); else n.add(id)
      return n
    })
  }
  // 확정(merged)/미확정(pending) 각각 따로 일괄선택할 수 있어야 한다는 요청 — 하나의 selected Set을
  // 공유하되, 그룹별로 "이 그룹 전체가 이미 선택돼 있는지"만 따로 판정해 체크박스 두 개로 나눈다.
  const pendingItems = visibleItems.filter(p => p.status === 'pending')
  const mergedItems = visibleItems.filter(p => p.status === 'merged')
  function toggleSelectGroup(group: StagingRow[]) {
    const ids = group.map(p => p.id)
    const allSelected = ids.length > 0 && ids.every(id => selected.has(id))
    setSelected(prev => {
      const next = new Set(prev)
      ids.forEach(id => (allSelected ? next.delete(id) : next.add(id)))
      return next
    })
  }
  const selectedPendingIds = pendingItems.filter(p => selected.has(p.id)).map(p => p.id)
  const selectedMergedIds = mergedItems.filter(p => selected.has(p.id)).map(p => p.id)

  // 팝업으로 띄운다(탭을 재사용하지 않는다) — 예전엔 지금 탭을 상품 상세로 바꿔치기해서, 하단 탭
  // 이름이 "스크랩 Raw 확인" 같은 메뉴명 대신 상품명으로 보여 혼란스럽다는 지적이 있었다(2026-08-13).
  function openDetail(p: StagingRow) {
    if (!p.matched_mall_product_id) return
    openDetailModal('product-detail', { mallProductId: p.matched_mall_product_id })
  }

  /** 로그인 창(그 몰의 로그인 쿠키 재사용)으로 먼저 열어 로그인된 상태로 보여준다 — ScraperPanel의
   *  handleOpenItem과 같은 우선순위(1순위 로그인 재사용, 2순위 Chrome/Edge, 3순위 일반 새 탭). */
  async function handleOpenSourceUrl(url: string, rowSessionId: number) {
    try {
      const res = await fetch('/api/scrape/open-url', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: rowSessionId, url }),
      })
      if (res.ok) return
    } catch { /* 폴백으로 진행 */ }
    try {
      const res = await fetch('/api/system/open-in-browser', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      })
      if (res.ok) return
    } catch { /* 폴백으로 진행 */ }
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
    if (!selectedPendingIds.length) return
    setNoClientWarning(null)
    // 경과시간 표시용 타이머 — setInterval로 주기적으로 다시 계산해 state에 반영하는 것 자체는 React가
    // 공식적으로 안내하는 시계/타이머 패턴이지만, react-hooks/purity가 Date.now() 값이 결국 state로
    // 흘러간다는 이유만으로 오탐한다.
    /* eslint-disable-next-line react-hooks/purity */
    pollMergeProgress(selectedPendingIds.length, Date.now(), { selfManaged: false })
    try {
      // force: true — 이 화면은 스크랩 건(세션) 단위로 확정하는 화면이라, 예전에 이미 상품마스터로
      // 확정된 적 있는 상품(is_already_migrated)이라도 이번에 새로 스크랩한 값 기준으로 다시 확정한다.
      // selected에는 (되돌리기 대상인) merged 행도 섞여 있을 수 있어 pending만 골라 보낸다.
      const res = await fetch('/api/scrape-staging/merge', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: selectedPendingIds, force: true }),
      })
      const d = await res.json() as { merged: number[]; skipped: { id: number; reason: string }[]; noClient?: number[] }
      if (d.noClient?.length) {
        setNoClientWarning(`${d.noClient.length}개는 몰에 거래처가 연결되어 있지 않습니다. 상품마스터로 반영되려면 Mall 상세관리에서 거래처를 지정하세요.`)
      }
      setSelected(new Set())
      bumpRefresh('products')
      bumpRefresh('staging')
      loadItems()
    } finally {
      if (mergeProgressPollRef.current) { clearInterval(mergeProgressPollRef.current); mergeProgressPollRef.current = null }
      setMerging(false)
      setMergeProgress(null)
    }
  }

  /** 확정을 다시 미확정으로 되돌린다 — staging 상태만 되돌리고, 이미 만들어진 mall_products/
   *  product_master는 그대로 둔다(unmergeStagingItems 주석 참고: 사용자가 "그대로 두고 되돌리기"를
   *  선택함, 2026-08-13). */
  async function handleUnmerge() {
    if (!selectedMergedIds.length) return
    setUnmerging(true)
    try {
      const res = await fetch('/api/scrape-staging/unmerge', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: selectedMergedIds }),
      })
      if (!res.ok) { alert('되돌리기에 실패했습니다.'); return }
      setSelected(new Set())
      bumpRefresh('staging')
      loadItems()
    } finally {
      setUnmerging(false)
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

  if (items.length === 0) {
    return (
      <div className="bg-white rounded-2xl border border-gray-200 p-12 text-center text-gray-400 shrink-0">
        <div className="text-4xl mb-3">📭</div>
        <p className="text-sm">{!scopeQuery ? '스크래핑 목록에서 항목을 선택하세요.' : '이 스크래핑에 수집된 항목이 없습니다.'}</p>
      </div>
    )
  }

  return (
    <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden flex-1 min-h-[160px] flex flex-col resize-y">
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 bg-gray-50 shrink-0 flex-wrap gap-2">
        <div className="flex items-center gap-4 text-xs text-gray-600 flex-wrap">
          {/* 체크박스 두 개를 하나의 <label>에 같이 넣지 않는다 — 라벨 텍스트를 클릭하면 그 라벨 안의
              "첫 번째" 체크박스가 토글돼, 두 번째 체크박스 옆 텍스트를 눌러도 첫 번째가 반응하는 사고가
              있었다(과거 실사용 확인). 그룹마다 독립된 <label>로 감싼다. */}
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={pendingItems.length > 0 && pendingItems.every(p => selected.has(p.id))}
              onChange={() => toggleSelectGroup(pendingItems)} />
            미확정 전체선택 ({pendingItems.length}개)
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={mergedItems.length > 0 && mergedItems.every(p => selected.has(p.id))}
              onChange={() => toggleSelectGroup(mergedItems)} />
            확정됨 전체선택 ({mergedItems.length}개)
          </label>
          {(hasFilters || sortKeys.length > 0) && <span>전체 {items.length}개 중 {visibleItems.length}개 표시</span>}
        </div>
        <div className="flex gap-2">
          {/* 보조 기능 토글은 rounded-md의 각진 모양으로, 클릭 한 번짜리 액션 버튼(rounded-full)과 구분한다. */}
          <button onClick={() => setShowFilters(v => !v)}
            className={`px-4 py-1 text-xs font-semibold rounded-md transition-colors ${showFilters ? 'bg-teal-100 text-teal-700 hover:bg-teal-200' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>
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
          {selectedMergedIds.length > 0 && (
            <button onClick={handleUnmerge} disabled={unmerging}
              title="mall_products/상품마스터 데이터는 그대로 두고, 이 스크랩 검토 화면에서만 다시 미확정으로 되돌립니다."
              className="px-4 py-1.5 bg-gray-100 text-gray-600 text-xs font-semibold rounded-full hover:bg-gray-200 disabled:opacity-40 transition-colors">
              {unmerging ? '되돌리는 중...' : `↩️ 미확정으로 되돌리기 (${selectedMergedIds.length})`}
            </button>
          )}
          {merging && mergeProgress && (
            <span className="flex items-center px-3 py-1 bg-teal-50 text-teal-700 text-xs font-semibold rounded-full whitespace-nowrap">
              {mergeProgress.total > 0
                ? `${Math.round(mergeProgress.done / mergeProgress.total * 100)}% (${mergeProgress.done}/${mergeProgress.total}) · ${mergeProgress.elapsedSec}초`
                : `준비 중... · ${mergeProgress.elapsedSec}초`}
            </span>
          )}
          <button onClick={handleMerge} disabled={!selectedPendingIds.length || merging}
            title="확정 시: 이미지 다운로드 + 원본 데이터(mall_products) 반영 + (거래처 연결된 몰이면) 상품마스터 자동 변환까지 처리됩니다."
            className="px-4 py-1.5 bg-teal-500 text-white text-xs font-semibold rounded-full hover:bg-teal-600 disabled:opacity-40 transition-colors">
            {merging ? '확정 중...' : `확정 (스크랩검수 후) (${selectedPendingIds.length})`}
          </button>
        </div>
      </div>
      {noClientWarning && (
        <div className="mx-4 mb-2 flex items-start gap-2 bg-amber-50 border border-amber-200 text-amber-700 text-xs rounded-xl px-3 py-2">
          <p className="flex-1">⚠ {noClientWarning}</p>
          <button onClick={() => setNoClientWarning(null)} aria-label="닫기" className="text-amber-400 hover:text-amber-600 shrink-0">✕</button>
        </div>
      )}
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
            {(() => { const extraInfoCol = columns.find(c => c.key === 'extra_info'); return visibleItems.map(p => {
              const missing = missingFields(p)
              const stockByOptionText = (p.raw_data?.stock_by_option || []).map(r => `${r.option}: ${r.qty}개`).join(', ')
              const optionCombinationsText = formatOptionCombinations(p.raw_data?.option_combinations)
              const extraInfoText = String(extraInfoCol?.getValue(p) ?? '')
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
                    ? <button type="button" onClick={() => handleOpenSourceUrl(p.source_url!, p.session_id)} className="text-teal-500 hover:underline">열기 ↗</button>
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
            )})})()}
          </tbody>
        </table>
      </div>
    </div>
  )
}
