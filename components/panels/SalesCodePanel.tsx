'use client'
import { useEffect, useState, useCallback } from 'react'
import { ScrapeScopePicker, type ScrapeScope } from './shared/ScrapeScopePicker'

interface StagingRow {
  id: number
  matched_mall_product_id: number | null
  mall_product_code: string
  mp_name_original: string | null
  mp_price: number | null
  mp_sale_price: number | null
  mp_brand: string | null
  mp_manufacturer: string | null
  mp_origin: string | null
  mp_mall_category: string | null
  mp_stock_status: string | null
}
interface MasterInfo { id: number; sales_code: string | null }
type StepMode = 'rename' | 'combine' | 'ai'
interface RecipeStep { mode: StepMode; sourceField?: string; entries?: { from: string; to: string }[]; template?: string; instruction?: string }

// value = 스텝 엔진(lib/salesCode/generate.ts)이 읽는 필드명, displayKey = /api/scrape-staging 응답에서
// 그 필드의 "현재 몰 상품 데이터" 값(mp_ 접두어) — 그리드에 보여주는 값과 실제 생성에 쓰이는 값을 일치시킨다.
const SOURCE_FIELD_OPTIONS: { value: string; label: string; displayKey: keyof StagingRow }[] = [
  { value: 'name_original', label: '상품명', displayKey: 'mp_name_original' },
  { value: 'price', label: '가격', displayKey: 'mp_price' },
  { value: 'sale_price', label: '할인가', displayKey: 'mp_sale_price' },
  { value: 'brand', label: '브랜드', displayKey: 'mp_brand' },
  { value: 'manufacturer', label: '제조사', displayKey: 'mp_manufacturer' },
  { value: 'origin', label: '원산지', displayKey: 'mp_origin' },
  { value: 'mall_category', label: '카테고리', displayKey: 'mp_mall_category' },
  { value: 'stock_status', label: '재고상태', displayKey: 'mp_stock_status' },
]
const PREV_OPTION = { value: '', label: '(이전 단계 결과)' }
const labelOf = (value: string) => SOURCE_FIELD_OPTIONS.find(f => f.value === value)?.label || value

function emptyStep(mode: StepMode, selectedColumn: string | null): RecipeStep {
  if (mode === 'rename') return { mode, sourceField: selectedColumn || '', entries: [{ from: '', to: '' }] }
  if (mode === 'combine') return { mode, template: selectedColumn ? `{${selectedColumn}}` : '{_prev}' }
  return { mode, instruction: selectedColumn ? `${labelOf(selectedColumn)} 값을 참고해서 ` : '' }
}

function StepEditor({ step, onChange }: { step: RecipeStep; onChange: (s: RecipeStep) => void }) {
  if (step.mode === 'rename') {
    const entries = step.entries || []
    return (
      <div className="space-y-2">
        <label className="flex items-center gap-2 text-xs text-gray-600">
          <span className="w-16 shrink-0">입력값</span>
          <select value={step.sourceField || ''} onChange={e => onChange({ ...step, sourceField: e.target.value })}
            className="flex-1 border border-gray-200 rounded px-2 py-1 text-xs">
            {[PREV_OPTION, ...SOURCE_FIELD_OPTIONS].map(f => <option key={f.value} value={f.value}>{f.label}</option>)}
          </select>
        </label>
        {entries.map((en, i) => (
          <div key={i} className="flex items-center gap-2">
            <input value={en.from} onChange={e => { const next = [...entries]; next[i] = { ...en, from: e.target.value }; onChange({ ...step, entries: next }) }}
              placeholder="원본값" className="flex-1 border border-gray-200 rounded px-2 py-1 text-xs" />
            <span className="text-gray-300">→</span>
            <input value={en.to} onChange={e => { const next = [...entries]; next[i] = { ...en, to: e.target.value }; onChange({ ...step, entries: next }) }}
              placeholder="변경값" className="flex-1 border border-gray-200 rounded px-2 py-1 text-xs" />
            <button onClick={() => onChange({ ...step, entries: entries.filter((_, j) => j !== i) })} className="text-gray-300 hover:text-red-400 text-xs">✕</button>
          </div>
        ))}
        <button onClick={() => onChange({ ...step, entries: [...entries, { from: '', to: '' }] })}
          className="text-xs text-teal-600 hover:text-teal-700">+ 값 매핑 추가</button>
        <p className="text-[11px] text-gray-400">표에 없는 값은 그대로 통과합니다.</p>
      </div>
    )
  }
  if (step.mode === 'combine') {
    return (
      <div className="space-y-1">
        <input value={step.template || ''} onChange={e => onChange({ ...step, template: e.target.value })}
          placeholder="예: {_prev}-{brand}" className="w-full border border-gray-200 rounded px-2 py-1 text-xs font-mono" />
        <p className="text-[11px] text-gray-400">
          {'{_prev}'} = 이전 단계 결과, 그 외 {'{'}필드명{'}'} 사용 가능: {SOURCE_FIELD_OPTIONS.map(f => f.value).join(', ')}
        </p>
      </div>
    )
  }
  return (
    <div className="space-y-1">
      <textarea value={step.instruction || ''} onChange={e => onChange({ ...step, instruction: e.target.value })}
        placeholder="예: 브랜드 앞 3글자와 상품명 핵심 키워드를 조합해서 만들어줘"
        rows={2} className="w-full border border-gray-200 rounded px-2 py-1 text-xs" />
      <p className="text-[11px] text-gray-400">원본 필드값 + 이전 단계 결과를 참고 자료로 AI에게 함께 전달합니다.</p>
    </div>
  )
}

const STEP_LABELS: Record<StepMode, string> = { rename: '값 변경', combine: '조합', ai: 'AI 생성' }

export function SalesCodePanel({ params }: { params?: Record<string, unknown> }) {
  const [scope, setScope] = useState<ScrapeScope>({ clientId: '', siteId: '', sessionId: '' })
  const [stagingRows, setStagingRows] = useState<StagingRow[]>([])
  const [masterByMallProductId, setMasterByMallProductId] = useState<Map<number, MasterInfo>>(new Map())
  const [steps, setSteps] = useState<RecipeStep[]>([])
  const [selectedColumn, setSelectedColumn] = useState<string | null>(null)
  const [previews, setPreviews] = useState<Record<number, string>>({})
  const [search, setSearch] = useState('')
  const [applying, setApplying] = useState(false)
  const [savingRecipe, setSavingRecipe] = useState(false)
  const [savingId, setSavingId] = useState<number | null>(null)

  // 그리드는 "몰 기본 스크래핑 컬럼"을 원본 그대로 보여준다 — /api/scrape-staging의 mp_* 필드는
  // 스텝 엔진(lib/salesCode/generate.ts)이 실제로 읽는 mall_products 테이블과 같은 값이라, 그리드에서
  // 보이는 값과 미리보기 결과가 항상 일치한다. product_master 쪽 판매관리코드 저장값만 별도로 합친다.
  const loadRows = useCallback(() => {
    const request = scope.sessionId === ''
      ? Promise.resolve([[], []] as [StagingRow[], { id: number; mall_product_id: number; sales_code: string | null }[]])
      : Promise.all([
          fetch(`/api/scrape-staging?sessionId=${scope.sessionId}`).then(r => r.json()),
          fetch(`/api/master?sessionId=${scope.sessionId}`).then(r => r.json()),
        ]).catch(() => [[], []] as [StagingRow[], { id: number; mall_product_id: number; sales_code: string | null }[]])
    request.then(([staging, master]) => {
      setStagingRows(Array.isArray(staging) ? staging.filter(s => s.matched_mall_product_id != null) : [])
      setMasterByMallProductId(new Map(Array.isArray(master) ? master.map(m => [m.mall_product_id, { id: m.id, sales_code: m.sales_code }]) : []))
    })
  }, [scope.sessionId])

  useEffect(() => { loadRows() }, [loadRows])

  // 이 몰×거래처 조합에 저장된 레시피가 있으면 그대로 불러온다 — "다음에도 동일하게 진행" 요구사항
  useEffect(() => {
    const request = scope.siteId === '' || scope.clientId === ''
      ? Promise.resolve([])
      : fetch(`/api/sales-code/recipe?siteId=${scope.siteId}&clientId=${scope.clientId}`).then(r => r.json()).catch(() => [])
    request.then((d: RecipeStep[]) => {
      setSteps(Array.isArray(d) ? d : [])
      setPreviews({})
      setSelectedColumn(null)
    })
  }, [scope.siteId, scope.clientId])

  async function saveRecipe() {
    if (scope.siteId === '' || scope.clientId === '') return
    setSavingRecipe(true)
    try {
      await fetch('/api/sales-code/recipe', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ siteId: scope.siteId, clientId: scope.clientId, steps }),
      })
    } finally {
      setSavingRecipe(false)
    }
  }

  async function runPreview() {
    const mallProductIds = stagingRows.map(r => r.matched_mall_product_id!)
    if (scope.siteId === '' || scope.clientId === '' || !mallProductIds.length) return
    setApplying(true)
    try {
      await saveRecipe()
      const res = await fetch('/api/sales-code/preview', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ siteId: scope.siteId, clientId: scope.clientId, mallProductIds }),
      })
      const data = await res.json() as { mallProductId: number; code: string }[]
      setPreviews(Object.fromEntries(data.map(d => [d.mallProductId, d.code])))
    } finally {
      setApplying(false)
    }
  }

  async function saveSalesCode(masterId: number, value: string): Promise<boolean> {
    const res = await fetch(`/api/master/${masterId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sales_code: value || null }) })
    if (!res.ok) {
      const e = await res.json().catch(() => ({}))
      alert(e.error || '저장에 실패했습니다.')
      return false
    }
    return true
  }

  async function applyOne(row: StagingRow) {
    const master = masterByMallProductId.get(row.matched_mall_product_id!)
    const code = previews[row.matched_mall_product_id!]
    if (!master || !code) return
    setSavingId(master.id)
    try {
      if (await saveSalesCode(master.id, code)) loadRows()
    } finally {
      setSavingId(null)
    }
  }

  async function applyAllMissing() {
    setApplying(true)
    try {
      for (const row of stagingRows) {
        const master = masterByMallProductId.get(row.matched_mall_product_id!)
        const code = previews[row.matched_mall_product_id!]
        if (master && !master.sales_code && code) await saveSalesCode(master.id, code)
      }
      loadRows()
    } finally {
      setApplying(false)
    }
  }

  const q = search.trim().toLowerCase()
  // 그리드가 SOURCE_FIELD_OPTIONS 컬럼(상품명/브랜드/제조사/원산지/카테고리/재고상태) 전부를 보여주는데
  // 검색은 상품명·몰상품코드·판매관리코드만 봐서, 다른 컬럼에 보이는 값으로는 검색이 안 됐다(가격·할인가는
  // 숫자라 텍스트 검색 대상에서 제외, 사용자 지적 2026-08-17).
  const visibleRows = q
    ? stagingRows.filter(r => {
        const master = masterByMallProductId.get(r.matched_mall_product_id!)
        return (r.mp_name_original || '').toLowerCase().includes(q) || (r.mall_product_code || '').toLowerCase().includes(q) || (master?.sales_code || '').toLowerCase().includes(q)
          || (r.mp_brand || '').toLowerCase().includes(q) || (r.mp_manufacturer || '').toLowerCase().includes(q) || (r.mp_origin || '').toLowerCase().includes(q)
          || (r.mp_mall_category || '').toLowerCase().includes(q) || (r.mp_stock_status || '').toLowerCase().includes(q)
      })
    : stagingRows
  const missingCount = stagingRows.filter(r => {
    const master = masterByMallProductId.get(r.matched_mall_product_id!)
    return master && !master.sales_code && previews[r.matched_mall_product_id!]
  }).length

  return (
    <div className="h-full flex flex-col">
      <div className="mb-6 shrink-0">
        <h1 className="text-2xl font-bold text-gray-800">💳 판매관리코드 관리</h1>
        <p className="text-xs text-gray-400 mt-1">
          이 시스템에서 상품을 관리하는 고유 키값입니다. ① 아래 그리드에서 컬럼을 선택 → ② 오른쪽에서 그 컬럼으로 단계를 추가 →
          ③ 필요하면 단계를 더 쌓고(조합·AI) → ④ 미리보기로 확인 후 적용. 구성해둔 단계는 같은 몰×거래처 조합에 다음에도 그대로 재사용됩니다.
        </p>
      </div>

      <ScrapeScopePicker initialSiteId={params?.siteId as number | undefined} initialSessionId={params?.sessionId as number | undefined} onScopeChange={setScope} />

      {scope.sessionId === '' ? null : (
        <div className="flex-1 min-h-0 flex gap-4 mt-4">
          <div className="flex-1 min-w-0 flex flex-col">
            <div className="bg-white rounded-2xl border border-gray-200 p-4 mb-4 flex flex-wrap items-center gap-3 shrink-0">
              <input value={search} onChange={e => setSearch(e.target.value)} placeholder="상품명·판매관리코드·몰상품코드 검색..."
                className="flex-1 min-w-[160px] border border-gray-300 rounded-full px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-teal-400" />
              <button onClick={runPreview} disabled={applying || steps.length === 0 || stagingRows.length === 0}
                className="px-4 py-2 bg-gray-100 text-gray-600 text-sm font-semibold rounded-full hover:bg-gray-200 disabled:opacity-50 transition-colors">
                {applying ? '생성 중...' : '미리보기 생성'}
              </button>
              <button onClick={applyAllMissing} disabled={applying || missingCount === 0}
                className="px-4 py-2 bg-teal-500 text-white text-sm font-semibold rounded-full hover:bg-teal-600 disabled:opacity-50 transition-colors">
                미입력분 전체 적용 ({missingCount})
              </button>
            </div>

            {stagingRows.length === 0 ? (
              <div className="bg-white rounded-2xl border border-gray-200 p-12 text-center text-gray-400">
                <div className="text-4xl mb-3">💳</div>
                <p className="text-sm">이 세션에 병합된 상품이 없습니다.</p>
              </div>
            ) : (
              <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden flex-1 min-h-0 flex flex-col">
                <div className="overflow-auto flex-1 min-h-0">
                  <table className="w-full text-sm border-collapse whitespace-nowrap">
                    <thead className="sticky top-0 z-10 bg-gray-50">
                      <tr className="border-b border-gray-200 text-xs font-semibold text-gray-500">
                        {SOURCE_FIELD_OPTIONS.map((f, i) => (
                          <th key={f.value} onClick={() => setSelectedColumn(selectedColumn === f.value ? null : f.value)}
                            className={`px-4 py-3 text-left cursor-pointer select-none transition-colors ${i === 0 ? 'sticky left-0 z-20' : ''}
                              ${selectedColumn === f.value ? 'bg-teal-100 text-teal-700' : 'bg-gray-50 hover:bg-gray-100'}`}>
                            {f.label} {selectedColumn === f.value && '✓'}
                          </th>
                        ))}
                        <th className="px-4 py-3 text-left">몰 상품코드</th>
                        <th className="px-4 py-3 text-left">미리보기</th>
                        <th className="px-4 py-3 text-left">판매관리코드 (저장값)</th>
                        <th className="px-4 py-3 text-left">적용</th>
                      </tr>
                    </thead>
                    <tbody>
                      {visibleRows.map(row => {
                        const mpId = row.matched_mall_product_id!
                        const master = masterByMallProductId.get(mpId)
                        const preview = previews[mpId]
                        const isApplied = !!master?.sales_code && master.sales_code === preview
                        return (
                          <tr key={row.id} className="group border-b border-gray-100 hover:bg-gray-50">
                            {SOURCE_FIELD_OPTIONS.map((f, i) => (
                              <td key={f.value}
                                className={`px-4 py-2 text-xs text-gray-700 truncate max-w-[200px] ${i === 0 ? 'sticky left-0 z-10 bg-white group-hover:bg-gray-50' : ''} ${selectedColumn === f.value ? 'bg-teal-50/60' : ''}`}>
                                {String(row[f.displayKey] ?? '-')}
                              </td>
                            ))}
                            <td className="px-4 py-2 text-xs font-mono text-gray-500">{row.mall_product_code || '-'}</td>
                            <td className="px-4 py-2 text-xs font-mono text-gray-400">{preview || '-'}</td>
                            <td className="px-4 py-2">
                              {master ? (
                                <input defaultValue={master.sales_code || ''} placeholder="미입력"
                                  onBlur={e => e.target.value !== (master.sales_code || '') && saveSalesCode(master.id, e.target.value).then(ok => ok && loadRows())}
                                  className="w-40 border border-gray-200 rounded px-1.5 py-1 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-teal-300" />
                              ) : <span className="text-xs text-amber-500">미병합</span>}
                            </td>
                            <td className="px-4 py-2">
                              <button onClick={() => applyOne(row)} disabled={!master || !preview || isApplied || savingId === master?.id}
                                className="px-3 py-1.5 bg-gray-100 hover:bg-gray-200 text-gray-600 text-xs font-semibold rounded-full disabled:opacity-40 transition-colors">
                                {isApplied ? '적용됨' : savingId === master?.id ? '적용 중...' : '적용'}
                              </button>
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>

          <div className="w-96 shrink-0 bg-white rounded-2xl border border-gray-200 p-4 overflow-y-auto">
            <div className="flex items-center justify-between mb-1">
              <h2 className="text-sm font-bold text-gray-700">생성 단계 (레시피)</h2>
              <button onClick={saveRecipe} disabled={savingRecipe}
                className="px-3 py-1.5 text-xs font-semibold rounded-full bg-gray-100 text-gray-600 hover:bg-gray-200 disabled:opacity-50">
                {savingRecipe ? '저장 중...' : '레시피 저장'}
              </button>
            </div>
            <p className="text-xs mb-3">
              선택된 컬럼: {selectedColumn ? <b className="text-teal-600">{labelOf(selectedColumn)}</b> : <span className="text-gray-400">왼쪽 그리드에서 컬럼 헤더를 클릭하세요</span>}
            </p>

            {steps.length === 0 && <p className="text-xs text-gray-400 mb-2">아직 단계가 없습니다. 아래 버튼으로 추가하세요.</p>}

            <div className="space-y-3">
              {steps.map((step, i) => (
                <div key={i} className="border border-gray-100 rounded-xl p-3 bg-gray-50/50">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs font-semibold text-gray-500">#{i + 1} {STEP_LABELS[step.mode]}</span>
                    <div className="flex items-center gap-1">
                      <button disabled={i === 0} onClick={() => { const next = [...steps]; [next[i - 1], next[i]] = [next[i], next[i - 1]]; setSteps(next) }}
                        className="text-xs text-gray-400 hover:text-gray-600 disabled:opacity-30">↑</button>
                      <button disabled={i === steps.length - 1} onClick={() => { const next = [...steps]; [next[i + 1], next[i]] = [next[i], next[i + 1]]; setSteps(next) }}
                        className="text-xs text-gray-400 hover:text-gray-600 disabled:opacity-30">↓</button>
                      <button onClick={() => setSteps(steps.filter((_, j) => j !== i))} className="text-xs text-gray-400 hover:text-red-400 ml-1">삭제</button>
                    </div>
                  </div>
                  <StepEditor step={step} onChange={s => { const next = [...steps]; next[i] = s; setSteps(next) }} />
                </div>
              ))}
            </div>

            <div className="flex flex-wrap items-center gap-2 mt-3">
              {(Object.keys(STEP_LABELS) as StepMode[]).map(mode => (
                <button key={mode} onClick={() => setSteps([...steps, emptyStep(mode, selectedColumn)])}
                  className="px-3 py-1 text-xs rounded-full border border-gray-200 text-gray-500 hover:border-teal-300 hover:text-teal-600">
                  + {STEP_LABELS[mode]} 단계
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
