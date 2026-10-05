'use client'
import { useCallback, useEffect, useState } from 'react'
import { ScrapeSessionGrid } from './shared/ScrapeSessionGrid'
import { FIXED_FIELD_INFO } from '../../lib/master/schema'

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
  merged_at: string | null
}
type UploadKind = 'as_is' | 'to_be'
interface UploadSummary { id: number; file_name: string; column_headers: string[]; code_column: string | null; row_count: number; matched_count: number }
interface GuidePair { code: string; asIs: Record<string, string>; toBe: Record<string, string> }
type RuleMode = 'ai' | 'lookup' | 'copy' | 'composite'
interface ColumnRule {
  id: number | null
  column_name: string
  target_field: string | null
  mode: RuleMode
  ai_instruction: string
  source_field: string | null
  composite_config: { fields?: string[]; template?: string; op?: 'concat' | 'multiply' | 'add'; factor?: number }
}
interface LookupEntry { id: number; source_value: string; target_value: string }
interface MallProduct { id: number; mall_product_code: string; name_original: string; master_product_id: number | null }
interface GeneratedRow { id: number; mall_product_id: number; product_master_id: number | null; generated_values: Record<string, string>; status: string; mall_product_code: string; name_original: string }

// 기준 Master 테이블 관리 화면과 라벨을 통일하기 위해 FIXED_FIELD_INFO(기준 컬럼 15개)를 그대로 재사용한다.
const TARGET_FIELDS: { value: string; label: string }[] = FIXED_FIELD_INFO.map(f => ({ value: f.key, label: f.label }))
const SOURCE_FIELDS: { value: string; label: string }[] = [
  { value: 'name_original', label: '원본상품명' }, { value: 'price', label: '가격' }, { value: 'sale_price', label: '할인가' },
  { value: 'brand', label: '브랜드(원본)' }, { value: 'manufacturer', label: '제조사(원본)' }, { value: 'origin', label: '원산지(원본)' },
  { value: 'description', label: '설명(원본)' }, { value: 'mall_category', label: '몰카테고리' },
  { value: 'stock_status', label: '재고상태(원본)' }, { value: 'stock_qty', label: '재고수량(원본)' },
]

/** 지금 몇 단계인지, 이전 단계가 끝났는지, 아직 진행할 수 없는 단계인지 한눈에 보이도록 하는 번호 배지. */
function StepHeader({ n, title, done, locked }: { n: number; title: string; done: boolean; locked?: boolean }) {
  return (
    <div className="flex items-center gap-2 mb-2">
      <div className={`w-6 h-6 shrink-0 rounded-full flex items-center justify-center text-xs font-bold ${
        done ? 'bg-emerald-500 text-white' : locked ? 'bg-gray-200 text-gray-400' : 'bg-teal-500 text-white'}`}>
        {done ? '✓' : n}
      </div>
      <span className={`text-sm font-semibold ${locked ? 'text-gray-400' : 'text-gray-700'}`}>{title}</span>
    </div>
  )
}

/** 아직 진행할 수 없는 단계 자리에 보여주는 잠금 안내 — 단계 전체가 뭔지 미리 보이도록 항상 렌더링한다. */
function LockedNotice({ text }: { text: string }) {
  return (
    <div className="bg-gray-50 rounded-2xl border border-dashed border-gray-200 p-8 text-center text-gray-400 text-xs mb-8">
      🔒 {text}
    </div>
  )
}

/** AS-IS/TO-BE 업로드 카드 — 둘의 UI가 완전히 동일해 kind만 다르게 재사용한다. */
function UploadCard({ label, upload, uploading, onUpload, pending, codeColumn, onCodeColumnChange, onConfirm }: {
  label: string
  upload: UploadSummary | null
  uploading: boolean
  onUpload: (file: File) => void
  pending: { headers: string[] } | null
  codeColumn: string
  onCodeColumnChange: (v: string) => void
  onConfirm: () => void
}) {
  return (
    <div className="bg-white rounded-2xl border border-gray-200 p-6">
      <div className="flex items-center gap-2 mb-3">
        <span className="text-xs font-semibold text-gray-500">{label}</span>
        {upload && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-50 text-emerald-600 font-semibold">업로드됨</span>}
      </div>
      {upload && (
        <p className="mb-3 text-xs text-gray-600">
          📄 {upload.file_name} — {upload.row_count}행 {upload.code_column && `(코드컬럼: ${upload.code_column})`}
        </p>
      )}
      {pending ? (
        <div className="bg-amber-50 rounded-xl p-3">
          <p className="text-xs text-gray-600 mb-2">몰 상품코드에 해당하는 컬럼을 선택하세요.</p>
          <div className="flex items-center gap-2">
            <select value={codeColumn} onChange={e => onCodeColumnChange(e.target.value)}
              className="border border-gray-300 rounded-lg px-2 py-1.5 text-sm">
              {pending.headers.map(h => <option key={h} value={h}>{h}</option>)}
            </select>
            <button onClick={onConfirm} className="px-3 py-1.5 bg-teal-500 hover:bg-teal-600 text-white text-xs font-semibold rounded-full">
              확정 & 매칭
            </button>
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          {/* 파일을 고르는 즉시 업로드한다 — 예전엔 "파일 선택" 뒤에 "업로드" 버튼을 따로 눌러야 했는데
              (사용자 지적, 2026-10-05: "파일선택과 업로드를 한 버튼으로 해도 되지 않아?"), 이 업로드는
              그 자리에서 바로 커밋되는 게 아니라 헤더만 읽어 "코드컬럼 선택" 대기 상태로 넘어갈 뿐이라
              — 잘못 고른 파일이어도 위 "다시 업로드"(이 input을 다시 눌러 새 파일을 고르는 것)로 바로
              바로잡을 수 있어 확인 버튼을 한 번 더 둘 필요가 약하다. */}
          {/* .xls(예전 바이너리 형식)는 accept에서 뺐다 — exceljs가 zip 기반 .xlsx만 읽을 수 있어
              .xls를 골라도 항상 "Can't find end of central directory" 파싱 실패로 끝난다(실사용 확인,
              2026-10-05 — "업로드 실패: 500"만 뜨고 이유를 알 수 없었음). */}
          <input type="file" accept=".xlsx" disabled={uploading}
            onChange={e => { const f = e.target.files?.[0]; if (f) onUpload(f) }}
            className="text-xs text-gray-600 file:mr-2 file:px-2 file:py-1 file:rounded-full file:border-0 file:bg-teal-50 file:text-teal-600 file:text-xs file:font-semibold hover:file:bg-teal-100 disabled:opacity-50" />
          {uploading && <span className="text-xs text-gray-400">업로드 중...</span>}
        </div>
      )}
    </div>
  )
}

/** AS-IS/TO-BE 쌍을 필드명 기준으로 나란히 비교할 수 있게 정리한다 — 값이 다르면 TO-BE 쪽을 강조 표시. */
function diffFields(pair: GuidePair, toBeHeaders: string[]): { key: string; asIs: string; toBe: string; changed: boolean }[] {
  const keys = [...new Set([...toBeHeaders, ...Object.keys(pair.asIs), ...Object.keys(pair.toBe)])]
  return keys
    .map(key => ({ key, asIs: pair.asIs[key] || '', toBe: pair.toBe[key] || '', changed: (pair.asIs[key] || '') !== (pair.toBe[key] || '') }))
    .filter(f => f.asIs || f.toBe)
}

export function TransformPanel({ params }: { params?: Record<string, unknown> }) {
  const [clients, setClients] = useState<Client[]>([])
  const [clientId, setClientId] = useState<number | ''>((params?.clientId as number | undefined) ?? '')
  const [sites, setSites] = useState<Site[]>([])
  const [siteFilterId, setSiteFilterId] = useState<number | ''>('')
  const [sessions, setSessions] = useState<Session[]>([])
  const [sessionSearch, setSessionSearch] = useState('')
  const [selectedSessionId, setSelectedSessionId] = useState<number | ''>('')
  const [queryClientId, setQueryClientId] = useState<number | ''>('')
  const [querySiteId, setQuerySiteId] = useState<number | ''>('')
  const [searched, setSearched] = useState(false)
  const [selectedSite, setSelectedSite] = useState<Site | null>(null)

  const [asIsUpload, setAsIsUpload] = useState<UploadSummary | null>(null)
  const [toBeUpload, setToBeUpload] = useState<UploadSummary | null>(null)
  const [guidePairs, setGuidePairs] = useState<GuidePair[]>([])
  // AS-IS/TO-BE 업로드 진행상태(uploading)·업로드 직후 "코드컬럼 선택" 대기 상태(pending)·그 선택값
  // (codeColumn)을 kind 하나로 공유하는 변수로 두면, 한쪽을 업로드하는 동안 다른 쪽을 클릭하는 순간
  // handleUpload(그 다른 kind)가 이 공유 변수들을 그대로 덮어써 먼저 클릭한 쪽의 화면이 업로드 전 상태로
  // "원복"돼 보인다(사용자 지적, 2026-10-04 — 둘을 동시에 못 올리고 하나가 되돌아감). kind별로 완전히
  // 분리해 둘이 동시에 진행돼도 서로 안 건드리게 한다.
  const [uploadingAsIs, setUploadingAsIs] = useState(false)
  const [uploadingToBe, setUploadingToBe] = useState(false)
  const [pendingAsIsUpload, setPendingAsIsUpload] = useState<{ id: number; headers: string[]; guessedCodeColumn: string | null } | null>(null)
  const [pendingToBeUpload, setPendingToBeUpload] = useState<{ id: number; headers: string[]; guessedCodeColumn: string | null } | null>(null)
  const [asIsCodeColumn, setAsIsCodeColumn] = useState('')
  const [toBeCodeColumn, setToBeCodeColumn] = useState('')

  const [rules, setRules] = useState<ColumnRule[]>([])
  const [customFields, setCustomFields] = useState<{ field_key: string; field_label: string }[]>([])
  const [lookupEntries, setLookupEntries] = useState<Record<number, LookupEntry[]>>({})

  const [products, setProducts] = useState<MallProduct[]>([])
  const [selectedProductIds, setSelectedProductIds] = useState<Set<number>>(new Set())
  const [generating, setGenerating] = useState(false)

  const [generatedRows, setGeneratedRows] = useState<GeneratedRow[]>([])
  const [committing, setCommitting] = useState<number | null>(null)
  const [discarding, setDiscarding] = useState<number | null>(null)
  const [bulkCommitting, setBulkCommitting] = useState(false)

  const loadGuide = useCallback((siteId: number) => {
    fetch(`/api/transform/guide?siteId=${siteId}`).then(r => r.json())
      .then((d: { asIsUpload: UploadSummary | null; toBeUpload: UploadSummary | null; pairs: GuidePair[] }) => {
        setAsIsUpload(d.asIsUpload || null)
        setToBeUpload(d.toBeUpload || null)
        setGuidePairs(Array.isArray(d.pairs) ? d.pairs : [])
      }).catch(() => {})
  }, [])
  const loadRules = useCallback((siteId: number) => {
    fetch(`/api/transform/columns?siteId=${siteId}`).then(r => r.json())
      .then((d: { rows: ColumnRule[]; customFields?: { field_key: string; field_label: string }[] }) => {
        setRules(d.rows || [])
        setCustomFields(d.customFields || [])
      })
  }, [])
  const loadProducts = useCallback((siteId: number, sessionId: number | '') => {
    const qs = new URLSearchParams({ siteId: String(siteId) })
    if (sessionId !== '') qs.set('sessionId', String(sessionId))
    fetch(`/api/products?${qs}`).then(r => r.json())
      .then((d: MallProduct[]) => setProducts(Array.isArray(d) ? d.filter(p => !p.master_product_id) : []))
  }, [])
  const loadGeneratedRows = useCallback((siteId: number) => {
    fetch(`/api/transform/results?siteId=${siteId}`).then(r => r.json()).then((d: GeneratedRow[]) => setGeneratedRows(Array.isArray(d) ? d : []))
  }, [])

  useEffect(() => {
    fetch('/api/clients').then(r => r.json()).then((d: Client[]) => { if (Array.isArray(d)) setClients(d) }).catch(() => {})
    fetch('/api/sites').then(r => r.json()).then((d: Site[]) => { if (Array.isArray(d)) setSites(d) }).catch(() => {})
    fetch('/api/sessions').then(r => r.json()).then((d: Session[]) => { if (Array.isArray(d)) setSessions(d) }).catch(() => {})
  }, [])

  function selectSite(site: Site, sessionId: number | '') {
    setSelectedSite(site)
    setPendingAsIsUpload(null)
    setPendingToBeUpload(null)
    setSelectedProductIds(new Set())
    loadGuide(site.id)
    loadRules(site.id)
    loadProducts(site.id, sessionId)
    loadGeneratedRows(site.id)
  }

  // 2번(AS-IS/TO-BE 샘플 가이드)은 1번의 세션 선택과 무관하게 몰 단위로 미리 등록/관리할 수 있어야 하므로,
  // 여기서 직접 몰을 골라도 selectedSite가 잡히도록 별도 진입점을 둔다. 세션 스코프는 없으니 초기화한다.
  function selectSiteDirect(site: Site) {
    setSelectedSessionId('')
    selectSite(site, '')
  }

  // 스크래핑 목록에서 세션을 고르면(마이그레이션 화면과 동일한 검색·선택 방식), 그 세션이 속한 몰을 선택하고
  // 3단계 대상 상품도 이 세션 기준으로 좁힌다.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (selectedSessionId === '') return
    const session = sessions.find(s => s.id === selectedSessionId)
    const site = session && sites.find(s => s.id === session.site_id)
    if (site) selectSite(site, selectedSessionId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSessionId])
  /* eslint-enable react-hooks/set-state-in-effect */

  const siteClientMap = new Map(sites.map(s => [s.id, s.client_id]))
  const filteredSitesForSelect = clientId === '' ? sites : sites.filter(s => s.client_id === clientId)
  const filteredSessions = sessions.filter(s => {
    if (querySiteId !== '' && s.site_id !== querySiteId) return false
    if (querySiteId === '' && queryClientId !== '' && siteClientMap.get(s.site_id) !== queryClientId) return false
    const q = sessionSearch.trim().toLowerCase()
    if (!q) return true
    // 그리드(ScrapeSessionGrid)가 항상 보여주는 "병합 일시"(merged_at)가 검색에서 빠져있었다(사용자
    // 지적, 2026-08-17 — 다른 메뉴의 검색도 그리드에 보이는 컬럼 전부를 대상으로 해달라는 요청).
    return s.url.toLowerCase().includes(q) || s.status.toLowerCase().includes(q) || new Date(s.created_at).toLocaleString().toLowerCase().includes(q)
      || (s.merged_at ? new Date(s.merged_at).toLocaleString() : '').toLowerCase().includes(q)
  })

  function selectClient(id: number | '') {
    setClientId(id)
    setSiteFilterId('')
  }

  function handleSearch() {
    if (clientId === '' && siteFilterId === '') { alert('거래처 또는 몰을 하나 이상 선택해주세요.'); return }
    setQueryClientId(clientId)
    setQuerySiteId(siteFilterId)
    setSearched(true)
  }

  async function handleUpload(kind: UploadKind, file: File) {
    if (!selectedSite) return
    const setUploading = kind === 'as_is' ? setUploadingAsIs : setUploadingToBe
    const setPending = kind === 'as_is' ? setPendingAsIsUpload : setPendingToBeUpload
    const setCodeColumn = kind === 'as_is' ? setAsIsCodeColumn : setToBeCodeColumn
    setUploading(true)
    try {
      const fd = new FormData()
      fd.append('file', file)
      fd.append('siteId', String(selectedSite.id))
      fd.append('kind', kind)
      const res = await fetch('/api/transform/uploads', { method: 'POST', body: fd })
      if (!res.ok) { const e = await res.json().catch(() => ({})); alert(`업로드 실패: ${e.error || res.status}`); return }
      const d = await res.json() as { id: number; headers: string[]; guessedCodeColumn: string | null; orphanedRules?: string[] }
      setPending({ id: d.id, headers: d.headers, guessedCodeColumn: d.guessedCodeColumn })
      setCodeColumn(d.guessedCodeColumn || d.headers[0] || '')
      if (d.orphanedRules?.length) {
        alert(`⚠ 새 TO-BE 헤더에 없는 기존 매핑 규칙이 ${d.orphanedRules.length}개 있습니다: ${d.orphanedRules.join(', ')}\n컬럼별 생성 규칙에서 다시 확인해주세요.`)
      }
    } finally {
      setUploading(false)
    }
  }

  async function confirmCodeColumn(kind: UploadKind) {
    const pendingUpload = kind === 'as_is' ? pendingAsIsUpload : pendingToBeUpload
    const codeColumn = kind === 'as_is' ? asIsCodeColumn : toBeCodeColumn
    if (!selectedSite || !pendingUpload || !codeColumn) return
    const res = await fetch(`/api/transform/uploads/${pendingUpload.id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ codeColumn }),
    })
    const stats = await res.json() as { total: number; matched: number }
    const kindLabel = kind === 'as_is' ? 'AS-IS' : 'TO-BE'
    alert(`${kindLabel} 매칭 완료: 총 ${stats.total}행 중 ${stats.matched}개가 현재 mall_products와 일치`)
    if (kind === 'as_is') setPendingAsIsUpload(null); else setPendingToBeUpload(null)
    loadGuide(selectedSite.id)
    if (kind === 'to_be') loadRules(selectedSite.id)
  }

  async function saveRule(rule: ColumnRule) {
    if (!selectedSite) return
    setRules(v => v.map(r => r.column_name === rule.column_name ? rule : r))
    await fetch('/api/transform/columns', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        siteId: selectedSite.id, columnName: rule.column_name, targetField: rule.target_field, mode: rule.mode,
        aiInstruction: rule.ai_instruction, sourceField: rule.source_field, compositeConfig: rule.composite_config,
      }),
    })
    loadRules(selectedSite.id)
  }

  function loadLookupEntries(ruleId: number) {
    fetch(`/api/transform/columns/${ruleId}/lookup`).then(r => r.json())
      .then((d: LookupEntry[]) => setLookupEntries(v => ({ ...v, [ruleId]: Array.isArray(d) ? d : [] })))
  }

  async function saveLookupEntry(ruleId: number, sourceValue: string, targetValue: string) {
    await fetch(`/api/transform/columns/${ruleId}/lookup`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sourceValue, targetValue }),
    })
    loadLookupEntries(ruleId)
  }

  /** 2번의 AS-IS/TO-BE 가이드 쌍에서 조회표 초안을 자동으로 채운다 — 이미 있는 항목은 덮어쓰지 않는다. */
  async function autoFillLookup(ruleId: number) {
    const res = await fetch(`/api/transform/columns/${ruleId}/lookup`, { method: 'POST' })
    if (!res.ok) { const e = await res.json().catch(() => ({})); alert(`자동 채우기 실패: ${e.error || res.status}`); return }
    const d = await res.json() as { filled: number; total: number }
    alert(`가이드 ${d.total}쌍 중 ${d.filled}개를 새로 채웠습니다 (이미 있던 항목은 그대로 둠).`)
    loadLookupEntries(ruleId)
  }

  function toggleProduct(id: number) {
    setSelectedProductIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  // ContinuousMigrationPanel의 같은 이름 상수와 같은 이유(Groq 무료 등급 분당 한도 ITPM 7,000/OTPM
  // 1,000) — generateForProducts를 부르는 진입점이 이 화면과 연속관리 재마이그레이션 둘이라, 한쪽만
  // 경고를 달면 다른 쪽에서 그대로 재발한다(PTP 마이그레이션 로드맵 §04).
  const BATCH_WARN_THRESHOLD = 100

  async function handleGenerate() {
    if (!selectedSite || selectedProductIds.size === 0) return
    if (selectedProductIds.size > BATCH_WARN_THRESHOLD) {
      const proceed = confirm(
        `${selectedProductIds.size}개를 한 번에 생성합니다. ai 규칙이 있는 컬럼은 상품마다 AI를 호출하는데, ` +
        `한꺼번에 몰리면 공급자(특히 Groq 무료 등급)의 분당 한도에 걸려 평소보다 오래 걸리거나 일부가 다음 ` +
        `공급자로 넘어갈 수 있습니다. 계속할까요?\n\n(나눠서 진행하려면 취소 후 일부만 선택해 주세요)`,
      )
      if (!proceed) return
    }
    setGenerating(true)
    try {
      const res = await fetch('/api/transform/generate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ siteId: selectedSite.id, mallProductIds: [...selectedProductIds] }),
      })
      if (!res.ok) { const e = await res.json().catch(() => ({})); alert(`생성 실패: ${e.error || res.status}`); return }
      loadGeneratedRows(selectedSite.id)
    } finally {
      setGenerating(false)
    }
  }

  async function saveGeneratedCell(id: number, columnName: string, value: string) {
    setGeneratedRows(v => v.map(r => r.id === id ? { ...r, generated_values: { ...r.generated_values, [columnName]: value } } : r))
    await fetch('/api/transform/results', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, columnName, value }),
    })
  }

  async function handleCommit(row: GeneratedRow) {
    if (!selectedSite?.client_id) { alert('이 Mall에 연결된 거래처가 없습니다.'); return }
    setCommitting(row.id)
    try {
      const res = await fetch('/api/transform/results', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: row.id, clientId: selectedSite.client_id }),
      })
      if (!res.ok) { const e = await res.json().catch(() => ({})); alert(`반영 실패: ${e.error || res.status}`); return }
      loadGeneratedRows(selectedSite.id)
    } finally {
      setCommitting(null)
    }
  }

  /** 일괄 반영: 아직 확정 전(draft)인 검토 결과를 한 번에 전부 반영한다. */
  async function handleBulkCommit() {
    if (!selectedSite?.client_id) { alert('이 Mall에 연결된 거래처가 없습니다.'); return }
    const draftIds = generatedRows.filter(r => r.status !== 'committed').map(r => r.id)
    if (!draftIds.length) return
    setBulkCommitting(true)
    try {
      const res = await fetch('/api/transform/results/bulk', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ siteId: selectedSite.id, clientId: selectedSite.client_id, ids: draftIds }),
      })
      const d = await res.json() as { committed: number[]; failed: { id: number; error: string }[] }
      if (d.failed?.length) alert(`${d.failed.length}건은 반영에 실패했습니다 (${d.committed.length}건 성공).`)
      loadGeneratedRows(selectedSite.id)
    } finally {
      setBulkCommitting(false)
    }
  }

  /** 취소: 확정 전 생성 결과를 지우고 되돌린다 — 필요하면 대상 상품에서 다시 생성할 수 있다. */
  async function handleDiscard(row: GeneratedRow) {
    if (!selectedSite) return
    if (!confirm(`${row.name_original || row.mall_product_code} 항목의 생성 결과를 취소할까요? 되돌린 뒤 다시 생성해야 합니다.`)) return
    setDiscarding(row.id)
    try {
      const res = await fetch(`/api/transform/results?id=${row.id}`, { method: 'DELETE' })
      if (!res.ok) { alert('취소에 실패했습니다.'); return }
      loadGeneratedRows(selectedSite.id)
    } finally {
      setDiscarding(null)
    }
  }

  const columnHeaders = toBeUpload?.column_headers || []
  const rulesByColumn = new Map(rules.map(r => [r.column_name, r]))

  /** 2차 검증 시 이 값이 어떤 기준으로 생성됐는지 컬럼마다 다시 보여준다. */
  function ruleSummary(rule?: ColumnRule): string {
    if (!rule) return ''
    if (rule.mode === 'ai') return `AI 생성 — ${rule.ai_instruction || '예시 패턴 기반 자동 생성'}`
    if (rule.mode === 'copy') return `그대로 복사 — ${SOURCE_FIELDS.find(f => f.value === rule.source_field)?.label || rule.source_field || '(미지정)'}`
    if (rule.mode === 'lookup') return `값 매핑 — ${SOURCE_FIELDS.find(f => f.value === rule.source_field)?.label || rule.source_field || '(미지정)'} 기준`
    const cfg = rule.composite_config
    if (cfg.op === 'multiply' || cfg.op === 'add') return `${cfg.op === 'multiply' ? '배율' : '가산'} ${cfg.factor ?? ''} — ${(cfg.fields || [])[0] || '(미지정)'}`
    return `문자열 합성 — ${cfg.template || (cfg.fields || []).map(f => `{${f}}`).join(' ')}`
  }

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-800">🧬 마이그레이션2_Transform</h1>
        <p className="text-xs text-gray-400 mt-1">
          ① 스크랩한 데이터를 조회·선택 → ② 기존 AS-IS/TO-BE 샘플로 마이그레이션 기준을 파악 → ③ 그 기준대로 선택한 데이터를 마이그레이션합니다.
        </p>
      </div>

      {/* 1. 스크랩한 데이터 조회 및 선택 */}
      <StepHeader n={1} title="스크랩한 데이터 조회 및 선택" done={!!selectedSite} />
      <div className="bg-white rounded-2xl border border-gray-200 p-4 mb-4 flex flex-wrap items-center gap-3">
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
          <select value={siteFilterId} onChange={e => setSiteFilterId(e.target.value ? Number(e.target.value) : '')}
            className="border border-gray-300 rounded-xl px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-teal-400">
            <option value="">전체</option>
            {filteredSitesForSelect.map(s => <option key={s.id} value={s.id}>{s.name || s.url}</option>)}
          </select>
        </label>
        <button onClick={handleSearch} disabled={clientId === '' && siteFilterId === ''}
          className="px-4 py-1.5 bg-teal-500 text-white text-sm font-semibold rounded-full hover:bg-teal-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
          🔍 조회
        </button>
      </div>

      {!searched ? (
        <div className="bg-white rounded-2xl border border-gray-200 p-12 text-center text-gray-400 mb-4">
          <div className="text-4xl mb-3">🔍</div>
          <p className="text-sm">거래처 또는 몰을 하나 이상 선택하고 조회 버튼을 눌러주세요.</p>
        </div>
      ) : filteredSessions.length === 0 ? (
        <div className="bg-white rounded-2xl border border-gray-200 p-12 text-center text-gray-400 mb-4">
          <div className="text-4xl mb-3">📭</div>
          <p className="text-sm">수집된 스크래핑이 없습니다.</p>
        </div>
      ) : (
        <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden mb-4">
          <div className="px-4 py-3 border-b border-gray-100 bg-gray-50 flex items-center gap-3">
            <span className="text-xs font-semibold text-gray-500 shrink-0">스크래핑 목록</span>
            <input value={sessionSearch} onChange={e => setSessionSearch(e.target.value)} placeholder="URL·상태·일시 검색..."
              className="flex-1 border border-gray-300 rounded-full px-3 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-teal-400" />
          </div>
          <ScrapeSessionGrid sessions={filteredSessions} selectedId={selectedSessionId} onSelect={setSelectedSessionId} />
        </div>
      )}

      {selectedSite && (
        <div className="flex items-center justify-between bg-teal-50 rounded-xl px-4 py-2 mb-8 text-sm">
          <span>선택된 Mall: <strong className="text-gray-800">{selectedSite.name || selectedSite.url}</strong></span>
          <button onClick={() => { setSelectedSite(null); setSelectedSessionId('') }} className="text-xs text-gray-500 hover:underline">선택 해제</button>
        </div>
      )}

      {/* 2. AS-IS / TO-BE 샘플 가이드 — 몰 단위 등록·관리 기능이라 1번(세션 선택)과 무관하게 바로 작업할 수 있다 */}
      <StepHeader n={2} title="AS-IS / TO-BE 샘플 가이드" done={!!toBeUpload} />
      <p className="text-xs text-gray-400 mb-3">엑셀 .xlsx 파일로 업로드해주세요(예전 .xls 형식은 지원하지 않습니다).</p>
      {!selectedSite ? (
        <div className="bg-white rounded-2xl border border-gray-200 p-6 mb-8">
          <div className="text-xs font-semibold text-gray-500 mb-3">관리할 몰을 선택하세요 (1번의 세션 선택과 별개로, 가이드만 먼저 등록·관리할 수 있습니다)</div>
          <select defaultValue="" onChange={e => { const s = sites.find(x => x.id === Number(e.target.value)); if (s) selectSiteDirect(s) }}
            className="border border-gray-300 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-400">
            <option value="" disabled>몰 선택...</option>
            {sites.map(s => <option key={s.id} value={s.id}>{s.name || s.url}</option>)}
          </select>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-4 mb-4">
            <UploadCard label="AS-IS (스크래핑본) 엑셀" upload={asIsUpload}
              uploading={uploadingAsIs} onUpload={file => handleUpload('as_is', file)}
              pending={pendingAsIsUpload}
              codeColumn={asIsCodeColumn} onCodeColumnChange={setAsIsCodeColumn} onConfirm={() => confirmCodeColumn('as_is')} />
            <UploadCard label="TO-BE (상품마스터본) 엑셀" upload={toBeUpload}
              uploading={uploadingToBe} onUpload={file => handleUpload('to_be', file)}
              pending={pendingToBeUpload}
              codeColumn={toBeCodeColumn} onCodeColumnChange={setToBeCodeColumn} onConfirm={() => confirmCodeColumn('to_be')} />
          </div>

          {guidePairs.length > 0 && (
            <div className="bg-white rounded-2xl border border-gray-200 p-6 mb-4">
              <div className="text-xs font-semibold text-gray-500 mb-3">어떻게 마이그레이션 되었는지 ({guidePairs.length}개 상품코드 매칭됨) — 상품코드를 눌러 펼쳐보세요</div>
              <div className="max-h-96 overflow-y-auto space-y-2">
                {guidePairs.map(pair => {
                  const fields = diffFields(pair, columnHeaders)
                  return (
                    <details key={pair.code} className="border border-gray-100 rounded-xl overflow-hidden group">
                      <summary className="px-3 py-2 bg-gray-50 text-xs font-mono text-gray-600 cursor-pointer select-none flex items-center justify-between hover:bg-gray-100">
                        <span>{pair.code}</span>
                        <span className="text-gray-400 transition-transform group-open:rotate-90">›</span>
                      </summary>
                      <table className="w-full text-xs border-collapse">
                        <thead>
                          <tr className="text-left text-gray-400 border-b border-gray-100">
                            <th className="px-3 py-1.5 font-normal w-1/4 sticky left-0 z-10 bg-white">필드</th>
                            <th className="px-3 py-1.5 font-normal w-1/3">AS-IS</th>
                            <th className="px-3 py-1.5 font-normal w-1/3">TO-BE</th>
                          </tr>
                        </thead>
                        <tbody>
                          {fields.map(f => (
                            <tr key={f.key} className="border-b border-gray-50 last:border-0">
                              <td className="px-3 py-1.5 text-gray-400 whitespace-nowrap sticky left-0 z-[1] bg-white">{f.key}</td>
                              <td className="px-3 py-1.5 text-gray-500">{f.asIs || '-'}</td>
                              <td className={`px-3 py-1.5 ${f.changed ? 'text-teal-700 font-semibold bg-teal-50/60' : 'text-gray-700'}`}>{f.toBe || '-'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </details>
                  )
                })}
              </div>
            </div>
          )}
          {asIsUpload && toBeUpload && guidePairs.length === 0 && (
            <div className="bg-white rounded-2xl border border-gray-200 p-6 mb-4 text-xs text-gray-400">
              AS-IS와 TO-BE 업로드 간에 코드가 일치하는 행이 없습니다. 두 파일의 상품코드 컬럼과 값을 확인해주세요.
            </div>
          )}

          {columnHeaders.length > 0 && (
            <div className="bg-white rounded-2xl border border-gray-200 p-6 mb-8">
              <div className="text-xs font-semibold text-gray-500 mb-3">
                컬럼별 생성 규칙 (TO-BE 컬럼 기준) — {rules.filter(r => r.target_field).length}/{rules.length}개 매핑됨
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-xs border-collapse">
                  <thead>
                    <tr className="text-left text-gray-500 border-b border-gray-200">
                      <th className="px-2 py-2 sticky left-0 z-10 bg-white">TO-BE(완성본)</th>
                      <th className="px-2 py-2">상품마스터 대상 필드</th>
                      <th className="px-2 py-2">생성 방식</th>
                      <th className="px-2 py-2">설정</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rules.map(rule => (
                      <tr key={rule.column_name} className="border-b border-gray-100 align-top">
                        <td className="px-2 py-2 font-medium text-gray-800 whitespace-nowrap sticky left-0 z-[1] bg-white">{rule.column_name}</td>
                        <td className="px-2 py-2">
                          <select value={rule.target_field || ''} onChange={e => saveRule({ ...rule, target_field: e.target.value || null })}
                            className="border border-gray-300 rounded-lg px-2 py-1 text-xs">
                            <option value="">(미매핑)</option>
                            {TARGET_FIELDS.map(f => <option key={f.value} value={f.value}>{f.label}</option>)}
                            {customFields.length > 0 && (
                              <optgroup label="거래처 커스텀 필드">
                                {customFields.map(f => <option key={f.field_key} value={f.field_key}>{f.field_label}</option>)}
                              </optgroup>
                            )}
                          </select>
                        </td>
                        <td className="px-2 py-2">
                          <select value={rule.mode} onChange={e => saveRule({ ...rule, mode: e.target.value as RuleMode })}
                            className="border border-gray-300 rounded-lg px-2 py-1 text-xs">
                            <option value="ai">AI 생성</option>
                            <option value="copy">그대로 복사</option>
                            <option value="lookup">값 매핑</option>
                            <option value="composite">복합(조합)</option>
                          </select>
                        </td>
                        <td className="px-2 py-2 min-w-[220px]">
                          {rule.mode === 'ai' && (
                            <textarea defaultValue={rule.ai_instruction} rows={2} placeholder="예: 원본 카테고리를 보고 내부 표준 카테고리로 바꿔줘"
                              onBlur={e => saveRule({ ...rule, ai_instruction: e.target.value })}
                              className="w-full border border-gray-300 rounded-lg px-2 py-1 text-xs" />
                          )}
                          {rule.mode === 'copy' && (
                            <select value={rule.source_field || ''} onChange={e => saveRule({ ...rule, source_field: e.target.value || null })}
                              className="border border-gray-300 rounded-lg px-2 py-1 text-xs">
                              <option value="">원본 필드 선택</option>
                              {SOURCE_FIELDS.map(f => <option key={f.value} value={f.value}>{f.label}</option>)}
                            </select>
                          )}
                          {rule.mode === 'lookup' && rule.id && (
                            <div>
                              <select value={rule.source_field || ''} onChange={e => saveRule({ ...rule, source_field: e.target.value || null })}
                                className="border border-gray-300 rounded-lg px-2 py-1 text-xs mb-1">
                                <option value="">원본 필드 선택</option>
                                {SOURCE_FIELDS.map(f => <option key={f.value} value={f.value}>{f.label}</option>)}
                              </select>
                              <button onClick={() => loadLookupEntries(rule.id!)} className="ml-2 text-teal-600 hover:underline">조회표 편집</button>
                              <button onClick={() => autoFillLookup(rule.id!)} disabled={!rule.source_field}
                                className="ml-2 text-teal-600 hover:underline disabled:text-gray-300 disabled:no-underline" title="2번의 AS-IS/TO-BE 가이드 쌍에서 자동으로 채웁니다">
                                가이드에서 자동 채우기
                              </button>
                              {lookupEntries[rule.id] && (
                                <div className="mt-1 border border-gray-200 rounded-lg p-2 space-y-1 max-h-40 overflow-y-auto">
                                  {[...lookupEntries[rule.id], { id: -1, source_value: '', target_value: '' }].map((e, i) => (
                                    <div key={e.id ?? i} className="flex gap-1">
                                      <input defaultValue={e.source_value} placeholder="원본값"
                                        onBlur={ev => ev.target.value && saveLookupEntry(rule.id!, ev.target.value, (ev.target.nextElementSibling as HTMLInputElement)?.value || '')}
                                        className="w-20 border border-gray-200 rounded px-1 py-0.5" />
                                      <input defaultValue={e.target_value} placeholder="완성값"
                                        onBlur={ev => e.source_value && saveLookupEntry(rule.id!, e.source_value, ev.target.value)}
                                        className="w-20 border border-gray-200 rounded px-1 py-0.5" />
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>
                          )}
                          {rule.mode === 'composite' && (
                            <div className="flex flex-col gap-1">
                              <input defaultValue={(rule.composite_config.fields || []).join(',')} placeholder="원본필드1,원본필드2"
                                onBlur={e => saveRule({ ...rule, composite_config: { ...rule.composite_config, fields: e.target.value.split(',').map(s => s.trim()).filter(Boolean) } })}
                                className="border border-gray-300 rounded-lg px-2 py-1" />
                              <select value={rule.composite_config.op || 'concat'}
                                onChange={e => saveRule({ ...rule, composite_config: { ...rule.composite_config, op: e.target.value as 'concat' | 'multiply' | 'add' } })}
                                className="border border-gray-300 rounded-lg px-2 py-1">
                                <option value="concat">문자열 합성(템플릿)</option>
                                <option value="multiply">숫자 배율</option>
                                <option value="add">숫자 가산</option>
                              </select>
                              {rule.composite_config.op === 'concat' ? (
                                <input defaultValue={rule.composite_config.template || ''} placeholder="{brand} {mall_category}"
                                  onBlur={e => saveRule({ ...rule, composite_config: { ...rule.composite_config, template: e.target.value } })}
                                  className="border border-gray-300 rounded-lg px-2 py-1" />
                              ) : (
                                <input type="number" defaultValue={rule.composite_config.factor ?? ''} placeholder="배율/가산값"
                                  onBlur={e => saveRule({ ...rule, composite_config: { ...rule.composite_config, factor: Number(e.target.value) || 0 } })}
                                  className="border border-gray-300 rounded-lg px-2 py-1" />
                              )}
                            </div>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}

      {/* 3. 마이그레이션 진행 */}
      <StepHeader n={3} title="마이그레이션 진행"
        done={generatedRows.length > 0 && generatedRows.every(r => r.status === 'committed')}
        locked={!selectedSite || columnHeaders.length === 0} />
      {!selectedSite ? (
        <LockedNotice text="1번에서 스크랩 세션을 선택하면 진행할 수 있습니다." />
      ) : columnHeaders.length === 0 ? (
        <LockedNotice text="2번에서 TO-BE 샘플을 업로드하면 진행할 수 있습니다." />
      ) : (
        <>
              <div className="bg-white rounded-2xl border border-gray-200 p-6 mb-4">
                <div className="flex items-center justify-between mb-3">
                  <div className="text-xs font-semibold text-gray-500">대상 상품 (선택한 세션 · 아직 상품마스터에 없는 상품)</div>
                  <button onClick={handleGenerate} disabled={generating || selectedProductIds.size === 0}
                    className="px-4 py-1.5 bg-teal-500 hover:bg-teal-600 text-white text-xs font-semibold rounded-full disabled:opacity-50">
                    {generating ? '마이그레이션 진행 중...' : `선택 ${selectedProductIds.size}개 마이그레이션 진행`}
                  </button>
                </div>
                {products.length === 0 ? (
                  <p className="text-xs text-gray-400">이 세션에는 대상 상품이 없습니다.</p>
                ) : (
                  <div className="border border-gray-100 rounded-xl overflow-hidden">
                    <label className="flex items-center gap-2 px-3 py-1.5 text-xs bg-gray-50 border-b border-gray-100 cursor-pointer">
                      <input type="checkbox" checked={selectedProductIds.size === products.length}
                        onChange={() => setSelectedProductIds(selectedProductIds.size === products.length ? new Set() : new Set(products.map(p => p.id)))} />
                      <span className="font-semibold text-gray-500">전체 선택 ({products.length}개)</span>
                    </label>
                    <div className="max-h-48 overflow-y-auto">
                      {products.map(p => (
                        <label key={p.id} className="flex items-center gap-2 px-3 py-1.5 text-xs border-b border-gray-100 last:border-0 hover:bg-gray-50 cursor-pointer">
                          <input type="checkbox" checked={selectedProductIds.has(p.id)} onChange={() => toggleProduct(p.id)} />
                          <span className="text-gray-500 font-mono">{p.mall_product_code}</span>
                          <span className="text-gray-700 truncate">{p.name_original}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {generatedRows.length > 0 && (
                <div className="bg-white rounded-2xl border border-gray-200 p-6 mb-4">
                  <div className="flex items-center justify-between mb-1">
                    <div className="text-xs font-semibold text-gray-500">2차 검증 — 생성 결과 검토 & 반영</div>
                    {generatedRows.some(r => r.status !== 'committed') && (
                      <button onClick={handleBulkCommit} disabled={bulkCommitting}
                        className="px-4 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-semibold rounded-full disabled:opacity-50 transition-colors">
                        {bulkCommitting ? '일괄 반영 중...' : `전체 반영 (${generatedRows.filter(r => r.status !== 'committed').length})`}
                      </button>
                    )}
                  </div>
                  <p className="text-[11px] text-gray-400 mb-3">컬럼마다 어떤 기준으로 생성됐는지 다시 표시했습니다. 값을 확인·수정한 뒤 행마다 반영하거나, 마음에 안 들면 취소해 되돌리세요. 규칙을 믿고 한 번에 처리하려면 &quot;전체 반영&quot;을 누르세요.</p>
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs border-collapse">
                      <thead>
                        <tr className="text-left text-gray-500 border-b border-gray-200">
                          <th className="px-2 py-2 align-top sticky left-0 z-10 bg-white">상품</th>
                          {columnHeaders.map(h => (
                            <th key={h} className="px-2 py-2 align-top">
                              <div>{h}</div>
                              <div className="text-[10px] font-normal text-gray-400 mt-0.5 max-w-[140px] truncate" title={ruleSummary(rulesByColumn.get(h))}>
                                {ruleSummary(rulesByColumn.get(h)) || '규칙 미설정'}
                              </div>
                            </th>
                          ))}
                          <th className="px-2 py-2 align-top">상태</th>
                          <th className="px-2 py-2 align-top">반영 / 취소</th>
                        </tr>
                      </thead>
                      <tbody>
                        {generatedRows.map(row => {
                          const locked = row.status === 'committed' || committing === row.id || discarding === row.id
                          return (
                          <tr key={row.id} className="border-b border-gray-100">
                            <td className="px-2 py-2 whitespace-nowrap sticky left-0 z-[1] bg-white">
                              <div className="font-mono text-gray-500">{row.mall_product_code}</div>
                              <div className="text-gray-700 truncate max-w-[160px]">{row.name_original}</div>
                            </td>
                            {columnHeaders.map(h => (
                              <td key={h} className="px-2 py-2">
                                <div className="relative inline-block">
                                  {rulesByColumn.get(h)?.mode === 'ai' && (
                                    <span className="absolute -top-1.5 -right-1.5 text-[10px] leading-none" title="AI 생성 — 2차 검증 시 더 꼼꼼히 확인하세요">✨</span>
                                  )}
                                  <input defaultValue={row.generated_values[h] ?? ''} onBlur={e => saveGeneratedCell(row.id, h, e.target.value)}
                                    disabled={row.status === 'committed'}
                                    className="w-28 border border-gray-200 rounded px-1.5 py-1 focus:outline-none focus:ring-1 focus:ring-teal-300 disabled:bg-gray-50 disabled:text-gray-400" />
                                </div>
                              </td>
                            ))}
                            <td className="px-2 py-2">
                              {row.status === 'committed' ? <span className="text-emerald-600 font-semibold">반영됨</span> : <span className="text-gray-400">검토중</span>}
                            </td>
                            <td className="px-2 py-2">
                              <div className="flex gap-1">
                                <button onClick={() => handleCommit(row)} disabled={locked}
                                  className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-semibold rounded-full disabled:opacity-50 transition-colors">
                                  {committing === row.id ? '처리중...' : '반영'}
                                </button>
                                <button onClick={() => handleDiscard(row)} disabled={locked}
                                  className="px-3 py-1.5 bg-gray-100 hover:bg-gray-200 text-gray-600 text-xs font-semibold rounded-full disabled:opacity-50 transition-colors">
                                  {discarding === row.id ? '취소 중...' : '취소'}
                                </button>
                              </div>
                            </td>
                          </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </>
          )}
    </div>
  )
}
