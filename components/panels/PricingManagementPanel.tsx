'use client'
import { useEffect, useState, useCallback, useMemo } from 'react'
import { ScrapeScopePicker, type ScrapeScope } from './shared/ScrapeScopePicker'
import { useRegisteredFieldKeys } from './shared/useRegisteredFieldKeys'
import { FIXED_FIELD_INFO } from '../../lib/master/schema'

interface MasterRow {
  id: number; name_original: string; name_ai: string | null; name_final: string | null
  cost_price: number | null; list_price: number | null; sale_price: number | null
  shipping_fee: number | null; other_cost: number | null; target_margin_rate: number | null
}

const ALL_NUMBER_KEYS = ['cost_price', 'list_price', 'sale_price', 'shipping_fee', 'other_cost'] as const
type NumberKey = typeof ALL_NUMBER_KEYS[number]
const DEFAULT_FIELD_LABEL = new Map(FIXED_FIELD_INFO.map(f => [f.key, f.label]))

function marginOf(row: MasterRow): number | null {
  if (row.sale_price == null) return null
  return row.sale_price - (row.cost_price ?? 0) - (row.other_cost ?? 0)
}

export function PricingManagementPanel({ params }: { params?: Record<string, unknown> }) {
  const [scope, setScope] = useState<ScrapeScope>({ clientId: '', siteId: '', sessionId: '' })
  const { keys: registeredKeys, labels: registryLabels, loaded: registryLoaded } = useRegisteredFieldKeys()
  // 기준 Master 테이블에서 뺀 가격 컬럼은 여기서도 컬럼이 사라진다(목표 마진율은 기준 테이블 대상이 아닌
  // 별도 정책값이라 항상 보여준다). 로딩 전엔 깜빡임 방지로 전체를 보여준다. 순서도 기준 마스터테이블의
  // sort_order를 따라간다(등록 안 된 키만 원래 순서로 맨 뒤에 남는다).
  const numberKeys = useMemo(() => {
    const visible = registryLoaded ? ALL_NUMBER_KEYS.filter(k => registeredKeys.has(k)) : [...ALL_NUMBER_KEYS]
    const order = Array.from(registryLabels.keys())
    return visible.sort((a, b) => {
      const ia = order.indexOf(a), ib = order.indexOf(b)
      if (ia === -1 && ib === -1) return 0
      if (ia === -1) return 1
      if (ib === -1) return -1
      return ia - ib
    })
  }, [registryLoaded, registeredKeys, registryLabels])
  // 라벨도 기준 마스터테이블관리에서 사용자가 직접 바꾼 실제 값을 우선한다(코드에 박아둔 기본값이 아님).
  const columnLabels = useMemo(() => {
    const m = new Map(DEFAULT_FIELD_LABEL)
    registryLabels.forEach((v, k) => m.set(k, v))
    return m
  }, [registryLabels])
  const [rows, setRows] = useState<MasterRow[]>([])
  const [search, setSearch] = useState('')
  const [editing, setEditing] = useState<{ id: number; key: NumberKey | 'target_margin_rate' } | null>(null)
  const [editValue, setEditValue] = useState('')
  // "✨ AI 목표마진율 추천" — target_margin_rate는 몰 소스가 없는 순수 정책값이라 다른 가격 필드와 달리
  // 사람이 이미 입력해둔 값을 예시로 학습해 추천한다(lib/ai.ts의 suggestMarginRates 참고). 제안만 받고
  // 사람이 "적용"을 눌러야 저장 — 다른 AI 버튼들과 같은 원칙.
  const [suggesting, setSuggesting] = useState(false)
  const [marginSuggestions, setMarginSuggestions] = useState<Map<number, number>>(new Map())
  const [applyingMargin, setApplyingMargin] = useState<number | null>(null)

  const load = useCallback(() => {
    if (scope.sessionId === '') { setRows([]); return }
    fetch(`/api/master?sessionId=${scope.sessionId}`).then(r => r.json()).then((d: MasterRow[]) => setRows(Array.isArray(d) ? d : [])).catch(() => {})
  }, [scope.sessionId])

  /* eslint-disable-next-line react-hooks/set-state-in-effect */
  useEffect(() => { load() }, [load])
  // 세션을 바꾸면 이전 세션의 제안이 그대로 남아 엉뚱한 상품에 적용되는 사고를 막기 위해 비운다.
  /* eslint-disable-next-line react-hooks/set-state-in-effect */
  useEffect(() => { setMarginSuggestions(new Map()) }, [scope.sessionId])

  async function runMarginSuggest() {
    if (scope.sessionId === '') return
    setSuggesting(true)
    try {
      const res = await fetch('/api/master/pricing/suggest-margin', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: scope.sessionId }),
      })
      const data = await res.json().catch(() => null) as { id: number; marginRate: number }[] | null
      if (!Array.isArray(data)) { alert('마진율 추천을 받아오지 못했습니다'); return }
      if (data.length === 0) { alert('추천할 만한 상품이 없습니다(참고할 기존 설정값이 2개 미만이거나, 비어있는 상품이 없습니다)'); return }
      setMarginSuggestions(new Map(data.map(s => [s.id, s.marginRate])))
    } finally {
      setSuggesting(false)
    }
  }

  async function applyMarginSuggestion(id: number) {
    const marginRate = marginSuggestions.get(id)
    if (marginRate == null) return
    setApplyingMargin(id)
    try {
      await fetch(`/api/master/${id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target_margin_rate: marginRate / 100 }),
      })
      setMarginSuggestions(prev => { const n = new Map(prev); n.delete(id); return n })
      load()
    } finally {
      setApplyingMargin(null)
    }
  }

  function startEdit(id: number, key: NumberKey | 'target_margin_rate', current: number | null) {
    setEditing({ id, key })
    setEditValue(current == null ? '' : key === 'target_margin_rate' ? String(Math.round(current * 100)) : String(current))
  }

  async function commitEdit() {
    if (!editing) return
    const { id, key } = editing
    const raw = editValue.trim()
    const value = raw === '' ? null : key === 'target_margin_rate' ? Number(raw) / 100 : Number(raw)
    await fetch(`/api/master/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ [key]: value }) })
    setEditing(null)
    load()
  }

  const q = search.trim().toLowerCase()
  const visibleRows = q ? rows.filter(r => (r.name_final || r.name_ai || r.name_original || '').toLowerCase().includes(q)) : rows

  function Cell({ row, k }: { row: MasterRow; k: NumberKey | 'target_margin_rate' }) {
    const value = k === 'target_margin_rate' ? row.target_margin_rate : row[k]
    const isEditing = editing?.id === row.id && editing.key === k
    const display = value == null ? null : k === 'target_margin_rate' ? `${Math.round(value * 100)}%` : `₩${value.toLocaleString()}`
    const suggestion = k === 'target_margin_rate' && value == null ? marginSuggestions.get(row.id) : undefined
    if (!isEditing && suggestion != null) {
      return (
        <td className="px-3 py-2 text-xs">
          <span className="inline-flex items-center gap-1.5 bg-violet-50 text-violet-700 rounded-full pl-2 pr-1 py-0.5">
            제안 {suggestion}%
            <button onClick={() => applyMarginSuggestion(row.id)} disabled={applyingMargin === row.id}
              className="px-1.5 py-0.5 rounded-full bg-violet-600 text-white hover:bg-violet-700 disabled:opacity-50 text-[10px] font-semibold">
              {applyingMargin === row.id ? '...' : '적용'}
            </button>
          </span>
        </td>
      )
    }
    return (
      <td className="px-3 py-2 cursor-pointer text-xs" onClick={() => !isEditing && startEdit(row.id, k, value)}>
        {isEditing ? (
          <input autoFocus value={editValue} onChange={e => setEditValue(e.target.value)}
            onBlur={commitEdit} onKeyDown={e => { if (e.key === 'Enter') commitEdit(); if (e.key === 'Escape') setEditing(null) }}
            className="w-20 border border-teal-300 rounded px-1 py-0.5 text-xs focus:outline-none" />
        ) : display ?? <span className="text-rose-400">입력필요</span>}
      </td>
    )
  }

  return (
    <div className="h-full flex flex-col">
      <div className="mb-6 shrink-0">
        <h1 className="text-2xl font-bold text-gray-800">💰 가격 및 이익 관리</h1>
        <p className="text-xs text-gray-400 mt-1">셀을 눌러 {columnLabels.get('cost_price')}·{columnLabels.get('sale_price')}·목표 마진율을 빠르게 수정합니다. 마켓별 상세 마진은 상품마스터 상세에서 확인하세요.</p>
      </div>

      <ScrapeScopePicker initialSiteId={params?.siteId as number | undefined} initialSessionId={params?.sessionId as number | undefined} onScopeChange={setScope} />

      {scope.sessionId === '' ? null : (
        <>
          <div className="mb-4 shrink-0 flex items-center gap-3">
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="상품명 검색..."
              className="w-full max-w-sm border border-gray-300 rounded-full px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-400" />
            <button onClick={runMarginSuggest} disabled={suggesting || rows.length === 0}
              title="이미 설정해둔 목표 마진율을 예시로 학습해, 비어있는 상품에 추천값을 제안합니다. 제안만 받을 뿐 DB는 바로 안 바뀝니다."
              className="shrink-0 px-4 py-1.5 rounded-full text-sm font-semibold bg-violet-50 text-violet-600 hover:bg-violet-100 disabled:opacity-50 disabled:cursor-not-allowed transition-colors">
              {suggesting ? '분석 중...' : '✨ AI 목표마진율 추천'}
            </button>
          </div>

          {rows.length === 0 ? (
            <div className="bg-white rounded-2xl border border-gray-200 p-12 text-center text-gray-400">
              <div className="text-4xl mb-3">💰</div>
              <p className="text-sm">이 세션에 병합된 상품마스터가 없습니다.</p>
            </div>
          ) : (
            <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden flex-1 min-h-0 flex flex-col">
              <div className="overflow-auto flex-1 min-h-0">
                <table className="text-xs border-collapse whitespace-nowrap">
                  <thead className="sticky top-0 z-10 bg-gray-50">
                    <tr className="border-b border-gray-200 text-gray-500 font-semibold">
                      <th className="px-3 py-2 text-left sticky left-0 bg-gray-50 z-20">상품명</th>
                      {numberKeys.map(k => <th key={k} className="px-3 py-2 text-left">{columnLabels.get(k)}</th>)}
                      <th className="px-3 py-2 text-left">목표 마진율</th>
                      <th className="px-3 py-2 text-left">예상 마진</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleRows.map(row => {
                      const margin = marginOf(row)
                      return (
                        <tr key={row.id} className="border-b border-gray-100 hover:bg-gray-50">
                          <td className="px-3 py-2 text-xs text-gray-700 sticky left-0 bg-white max-w-[220px] truncate">{row.name_final || row.name_ai || row.name_original}</td>
                          {numberKeys.map(k => <Cell key={k} row={row} k={k} />)}
                          <Cell row={row} k="target_margin_rate" />
                          <td className="px-3 py-2 text-xs font-medium">
                            {margin == null ? '-' : <span className={margin >= 0 ? 'text-emerald-600' : 'text-rose-500'}>₩{margin.toLocaleString()}</span>}
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
