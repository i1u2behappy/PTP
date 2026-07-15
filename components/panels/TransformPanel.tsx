'use client'
import { useCallback, useEffect, useState } from 'react'
import { ScrapeSessionGrid } from './shared/ScrapeSessionGrid'

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
}
interface Upload { id: number; file_name: string; column_headers: string[]; code_column: string | null; row_count: number; matched_count: number }
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

const TARGET_FIELDS: { value: string; label: string }[] = [
  { value: 'name_final', label: '최종상품명' }, { value: 'master_category', label: '카테고리' },
  { value: 'brand', label: '브랜드' }, { value: 'manufacturer', label: '제조사' }, { value: 'origin', label: '원산지' },
  { value: 'description', label: '설명' }, { value: 'cost_price', label: '매입가' }, { value: 'list_price', label: '소비자가' },
  { value: 'sale_price', label: '판매가' }, { value: 'shipping_fee', label: '배송비' }, { value: 'other_cost', label: '기타비용' },
  { value: 'stock_status', label: '재고상태' }, { value: 'stock_qty', label: '재고수량' },
  { value: 'internal_code', label: '관리코드' }, { value: 'sales_code', label: '판매관리코드' },
]
const SOURCE_FIELDS: { value: string; label: string }[] = [
  { value: 'name_original', label: '원본상품명' }, { value: 'price', label: '가격' }, { value: 'sale_price', label: '할인가' },
  { value: 'brand', label: '브랜드(원본)' }, { value: 'manufacturer', label: '제조사(원본)' }, { value: 'origin', label: '원산지(원본)' },
  { value: 'description', label: '설명(원본)' }, { value: 'mall_category', label: '몰카테고리' },
  { value: 'stock_status', label: '재고상태(원본)' }, { value: 'stock_qty', label: '재고수량(원본)' },
]

export function TransformPanel() {
  const [clients, setClients] = useState<Client[]>([])
  const [clientId, setClientId] = useState<number | ''>('')
  const [sites, setSites] = useState<Site[]>([])
  const [siteFilterId, setSiteFilterId] = useState<number | ''>('')
  const [sessions, setSessions] = useState<Session[]>([])
  const [sessionSearch, setSessionSearch] = useState('')
  const [selectedSessionId, setSelectedSessionId] = useState<number | ''>('')
  const [queryClientId, setQueryClientId] = useState<number | ''>('')
  const [querySiteId, setQuerySiteId] = useState<number | ''>('')
  const [searched, setSearched] = useState(false)
  const [selectedSite, setSelectedSite] = useState<Site | null>(null)

  const [uploads, setUploads] = useState<Upload[]>([])
  const [uploadFile, setUploadFile] = useState<File | null>(null)
  const [uploading, setUploading] = useState(false)
  const [pendingUpload, setPendingUpload] = useState<{ id: number; headers: string[]; guessedCodeColumn: string | null } | null>(null)
  const [codeColumn, setCodeColumn] = useState('')

  const [rules, setRules] = useState<ColumnRule[]>([])
  const [lookupEntries, setLookupEntries] = useState<Record<number, LookupEntry[]>>({})

  const [products, setProducts] = useState<MallProduct[]>([])
  const [selectedProductIds, setSelectedProductIds] = useState<Set<number>>(new Set())
  const [generating, setGenerating] = useState(false)

  const [generatedRows, setGeneratedRows] = useState<GeneratedRow[]>([])
  const [committing, setCommitting] = useState<number | null>(null)

  const loadUploads = useCallback((siteId: number) => {
    fetch(`/api/transform/uploads?siteId=${siteId}`).then(r => r.json()).then((d: Upload[]) => setUploads(Array.isArray(d) ? d : []))
  }, [])
  const loadRules = useCallback((siteId: number) => {
    fetch(`/api/transform/columns?siteId=${siteId}`).then(r => r.json())
      .then((d: { rows: ColumnRule[] }) => setRules(d.rows || []))
  }, [])
  const loadProducts = useCallback((siteId: number) => {
    fetch(`/api/products?siteId=${siteId}`).then(r => r.json())
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

  function selectSite(site: Site) {
    setSelectedSite(site)
    setPendingUpload(null)
    setSelectedProductIds(new Set())
    loadUploads(site.id)
    loadRules(site.id)
    loadProducts(site.id)
    loadGeneratedRows(site.id)
  }

  // 스크래핑 목록에서 세션을 고르면(마이그레이션 화면과 동일한 검색·선택 방식), 그 세션이 속한 몰을 선택한다.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (selectedSessionId === '') return
    const session = sessions.find(s => s.id === selectedSessionId)
    const site = session && sites.find(s => s.id === session.site_id)
    if (site) selectSite(site)
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
    return s.url.toLowerCase().includes(q) || s.status.toLowerCase().includes(q) || new Date(s.created_at).toLocaleString().toLowerCase().includes(q)
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

  async function handleUpload() {
    if (!selectedSite || !uploadFile) return
    setUploading(true)
    try {
      const fd = new FormData()
      fd.append('file', uploadFile)
      fd.append('siteId', String(selectedSite.id))
      const res = await fetch('/api/transform/uploads', { method: 'POST', body: fd })
      if (!res.ok) { const e = await res.json().catch(() => ({})); alert(`업로드 실패: ${e.error || res.status}`); return }
      const d = await res.json() as { id: number; headers: string[]; guessedCodeColumn: string | null }
      setPendingUpload(d)
      setCodeColumn(d.guessedCodeColumn || d.headers[0] || '')
      setUploadFile(null)
    } finally {
      setUploading(false)
    }
  }

  async function confirmCodeColumn() {
    if (!selectedSite || !pendingUpload || !codeColumn) return
    const res = await fetch(`/api/transform/uploads/${pendingUpload.id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ codeColumn }),
    })
    const stats = await res.json() as { total: number; matched: number }
    alert(`매칭 완료: 총 ${stats.total}개 중 ${stats.matched}개 매칭됨`)
    setPendingUpload(null)
    loadUploads(selectedSite.id)
    loadRules(selectedSite.id)
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

  function toggleProduct(id: number) {
    setSelectedProductIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  async function handleGenerate() {
    if (!selectedSite || selectedProductIds.size === 0) return
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
      if (!res.ok) { const e = await res.json().catch(() => ({})); alert(`확정 실패: ${e.error || res.status}`); return }
      loadGeneratedRows(selectedSite.id)
    } finally {
      setCommitting(null)
    }
  }

  const columnHeaders = uploads[0]?.column_headers || []

  return (
    <div className="max-w-4xl">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-800">🧬 마이그레이션2_Transform</h1>
        <p className="text-xs text-gray-400 mt-1">스크래핑 목록에서 세션을 검색·선택하면, 그 세션이 속한 몰 기준으로 완성본 업로드·컬럼 규칙·생성을 진행할 수 있습니다.</p>
      </div>

      {/* 상단: 거래처/몰/일시로 검색하는 스크래핑 목록 (마이그레이션 화면과 동일한 검색·선택 방식) */}
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
        <div className="flex items-center justify-between bg-teal-50 rounded-xl px-4 py-2 mb-4 text-sm">
          <span>선택된 Mall: <strong className="text-gray-800">{selectedSite.name || selectedSite.url}</strong></span>
          <button onClick={() => { setSelectedSite(null); setSelectedSessionId('') }} className="text-xs text-gray-500 hover:underline">선택 해제</button>
        </div>
      )}

      {selectedSite && (
        <>
          {/* 1단계: 완성본 업로드 */}
          <div className="bg-white rounded-2xl border border-gray-200 p-6 mb-4">
            <div className="text-sm font-semibold text-gray-700 mb-3">1. 기존 작업내역 완성본 업로드</div>

            {uploads.length > 0 && (
              <ul className="mb-3 text-xs text-gray-600 space-y-1">
                {uploads.map(u => (
                  <li key={u.id}>
                    📄 {u.file_name} — {u.row_count}행 중 {u.matched_count}개 매칭 {u.code_column && `(코드컬럼: ${u.code_column})`}
                  </li>
                ))}
              </ul>
            )}

            {pendingUpload ? (
              <div className="bg-amber-50 rounded-xl p-3">
                <p className="text-xs text-gray-600 mb-2">몰 상품코드에 해당하는 컬럼을 선택하세요.</p>
                <div className="flex items-center gap-2">
                  <select value={codeColumn} onChange={e => setCodeColumn(e.target.value)}
                    className="border border-gray-300 rounded-lg px-2 py-1.5 text-sm">
                    {pendingUpload.headers.map(h => <option key={h} value={h}>{h}</option>)}
                  </select>
                  <button onClick={confirmCodeColumn} className="px-3 py-1.5 bg-teal-500 hover:bg-teal-600 text-white text-xs font-semibold rounded-full">
                    확정 & 매칭
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <input type="file" accept=".xlsx,.xls" onChange={e => setUploadFile(e.target.files?.[0] || null)}
                  className="text-xs text-gray-600 file:mr-2 file:px-2 file:py-1 file:rounded-full file:border-0 file:bg-teal-50 file:text-teal-600 file:text-xs file:font-semibold hover:file:bg-teal-100" />
                <button onClick={handleUpload} disabled={!uploadFile || uploading}
                  className="px-3 py-1.5 bg-teal-500 hover:bg-teal-600 text-white text-xs font-semibold rounded-full disabled:opacity-50">
                  {uploading ? '업로드 중...' : '업로드'}
                </button>
              </div>
            )}
          </div>

          {/* 2단계: 컬럼 규칙 */}
          {columnHeaders.length > 0 && (
            <div className="bg-white rounded-2xl border border-gray-200 p-6 mb-4">
              <div className="text-sm font-semibold text-gray-700 mb-3">2. 컬럼별 생성 규칙</div>
              <div className="overflow-x-auto">
                <table className="w-full text-xs border-collapse">
                  <thead>
                    <tr className="text-left text-gray-500 border-b border-gray-200">
                      <th className="px-2 py-2">완성본 컬럼</th>
                      <th className="px-2 py-2">상품마스터 대상 필드</th>
                      <th className="px-2 py-2">생성 방식</th>
                      <th className="px-2 py-2">설정</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rules.map(rule => (
                      <tr key={rule.column_name} className="border-b border-gray-100 align-top">
                        <td className="px-2 py-2 font-medium text-gray-800 whitespace-nowrap">{rule.column_name}</td>
                        <td className="px-2 py-2">
                          <select value={rule.target_field || ''} onChange={e => saveRule({ ...rule, target_field: e.target.value || null })}
                            className="border border-gray-300 rounded-lg px-2 py-1 text-xs">
                            <option value="">(미매핑)</option>
                            {TARGET_FIELDS.map(f => <option key={f.value} value={f.value}>{f.label}</option>)}
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

          {/* 3단계: 생성 대상 선택 */}
          {columnHeaders.length > 0 && (
            <div className="bg-white rounded-2xl border border-gray-200 p-6 mb-4">
              <div className="flex items-center justify-between mb-3">
                <div className="text-sm font-semibold text-gray-700">3. 생성 대상 선택 (아직 상품마스터에 없는 상품)</div>
                <button onClick={handleGenerate} disabled={generating || selectedProductIds.size === 0}
                  className="px-4 py-1.5 bg-teal-500 hover:bg-teal-600 text-white text-xs font-semibold rounded-full disabled:opacity-50">
                  {generating ? '생성 중...' : `선택 ${selectedProductIds.size}개 생성`}
                </button>
              </div>
              {products.length === 0 ? (
                <p className="text-xs text-gray-400">대상 상품이 없습니다.</p>
              ) : (
                <div className="max-h-48 overflow-y-auto border border-gray-100 rounded-xl">
                  {products.map(p => (
                    <label key={p.id} className="flex items-center gap-2 px-3 py-1.5 text-xs border-b border-gray-100 last:border-0 hover:bg-gray-50 cursor-pointer">
                      <input type="checkbox" checked={selectedProductIds.has(p.id)} onChange={() => toggleProduct(p.id)} />
                      <span className="text-gray-500 font-mono">{p.mall_product_code}</span>
                      <span className="text-gray-700 truncate">{p.name_original}</span>
                    </label>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* 4단계: 검토 & 확정 */}
          {generatedRows.length > 0 && (
            <div className="bg-white rounded-2xl border border-gray-200 p-6 mb-4">
              <div className="text-sm font-semibold text-gray-700 mb-3">4. 생성 결과 검토 & 확정</div>
              <div className="overflow-x-auto">
                <table className="w-full text-xs border-collapse">
                  <thead>
                    <tr className="text-left text-gray-500 border-b border-gray-200">
                      <th className="px-2 py-2">상품</th>
                      {columnHeaders.map(h => <th key={h} className="px-2 py-2">{h}</th>)}
                      <th className="px-2 py-2">상태</th>
                      <th className="px-2 py-2">확정</th>
                    </tr>
                  </thead>
                  <tbody>
                    {generatedRows.map(row => (
                      <tr key={row.id} className="border-b border-gray-100">
                        <td className="px-2 py-2 whitespace-nowrap">
                          <div className="font-mono text-gray-500">{row.mall_product_code}</div>
                          <div className="text-gray-700 truncate max-w-[160px]">{row.name_original}</div>
                        </td>
                        {columnHeaders.map(h => (
                          <td key={h} className="px-2 py-2">
                            <input defaultValue={row.generated_values[h] ?? ''} onBlur={e => saveGeneratedCell(row.id, h, e.target.value)}
                              className="w-28 border border-gray-200 rounded px-1.5 py-1 focus:outline-none focus:ring-1 focus:ring-teal-300" />
                          </td>
                        ))}
                        <td className="px-2 py-2">
                          {row.status === 'committed' ? <span className="text-emerald-600 font-semibold">확정됨</span> : <span className="text-gray-400">검토중</span>}
                        </td>
                        <td className="px-2 py-2">
                          <button onClick={() => handleCommit(row)} disabled={committing === row.id}
                            className="px-3 py-1 bg-emerald-500 hover:bg-emerald-600 text-white rounded-full disabled:opacity-50">
                            {committing === row.id ? '처리중...' : '확정'}
                          </button>
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
    </div>
  )
}
