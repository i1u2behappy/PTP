'use client'
import { useEffect, useState, useCallback } from 'react'
import Image from 'next/image'
import { useTabs } from '../shell/TabsContext'

interface MasterRow {
  id: number
  mall_product_id: number
  name_original: string
  name_ai: string | null
  name_final: string | null
  mall_category: string
  master_category: string
  brand: string
  manufacturer: string
  origin: string
  description: string
  cost_price: number | null
  list_price: number | null
  sale_price: number | null
  shipping_fee: number | null
  other_cost: number | null
  stock_status: string | null
  stock_qty: number | null
  status: string
  thumbnail_local: string | null
}

const EDITABLE_NUMBER_KEYS = ['cost_price', 'list_price', 'sale_price', 'shipping_fee', 'other_cost'] as const
type EditableKey = typeof EDITABLE_NUMBER_KEYS[number] | 'master_category' | 'brand' | 'manufacturer' | 'origin'

function marginOf(row: MasterRow): number | null {
  if (row.sale_price == null) return null
  const cost = row.cost_price ?? 0
  const other = row.other_cost ?? 0
  return row.sale_price - cost - other
}

export function MasterListPanel() {
  const { openTab, refreshSignals, bumpRefresh } = useTabs()
  const [rows, setRows] = useState<MasterRow[]>([])
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [aiLoading, setAiLoading] = useState<Set<number>>(new Set())
  const [editing, setEditing] = useState<{ id: number; key: EditableKey } | null>(null)
  const [editValue, setEditValue] = useState('')
  const [notReadyOnly, setNotReadyOnly] = useState(false)

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/master?clientId=1')
      const d = await res.json() as MasterRow[]
      setRows(Array.isArray(d) ? d : [])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load, refreshSignals.master])

  function missing(row: MasterRow): string[] {
    const out: string[] = []
    if (!row.name_final && !row.name_ai) out.push('상품명')
    if (row.sale_price == null) out.push('판매가')
    if (!row.master_category && !row.mall_category) out.push('카테고리')
    if (!row.brand) out.push('브랜드')
    return out
  }

  const visibleRows = notReadyOnly ? rows.filter(r => missing(r).length > 0) : rows
  const readyCount = rows.filter(r => missing(r).length === 0).length

  function toggleSelect(id: number) {
    setSelected(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n })
  }
  function selectAll() {
    setSelected(selected.size === visibleRows.length ? new Set() : new Set(visibleRows.map(r => r.id)))
  }

  function openDetail(row: MasterRow) {
    openTab({ id: `master-detail:${row.id}`, type: 'master-detail', title: (row.name_final || row.name_ai || row.name_original)?.slice(0, 14) || `마스터 #${row.id}`, icon: '🗂️', params: { masterId: row.id }, closable: true })
  }

  async function genAiName(id: number) {
    setAiLoading(s => new Set(s).add(id))
    try {
      await fetch(`/api/master/${id}/ai-name`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      await load()
    } finally {
      setAiLoading(s => { const n = new Set(s); n.delete(id); return n })
    }
  }

  async function genAllAiNames() {
    const ids = selected.size > 0 ? [...selected] : rows.filter(r => !r.name_ai).map(r => r.id)
    for (const id of ids) await genAiName(id)
  }

  function startEdit(id: number, key: EditableKey, current: string | number | null) {
    setEditing({ id, key })
    setEditValue(current == null ? '' : String(current))
  }

  async function saveEdit() {
    if (!editing) return
    const { id, key } = editing
    const isNumber = (EDITABLE_NUMBER_KEYS as readonly string[]).includes(key)
    const value = isNumber ? (editValue.trim() === '' ? null : Number(editValue)) : editValue
    await fetch(`/api/master/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [key]: value }),
    })
    setEditing(null)
    load()
  }

  async function saveFinalName(id: number, value: string) {
    await fetch(`/api/master/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name_final: value }),
    })
    load()
  }

  async function markReady() {
    const ids = selected.size > 0 ? [...selected] : visibleRows.filter(r => missing(r).length === 0).map(r => r.id)
    await Promise.all(ids.map(id => fetch(`/api/master/${id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'ready' }),
    })))
    bumpRefresh('master')
    load()
  }

  function EditableCell({ row, k, label }: { row: MasterRow; k: EditableKey; label: string }) {
    const value = row[k] as string | number | null
    const isEditing = editing?.id === row.id && editing.key === k
    return (
      <td className="px-2 py-2 cursor-pointer text-xs" title={label} onClick={() => !isEditing && startEdit(row.id, k, value)}>
        {isEditing ? (
          <input autoFocus value={editValue} onChange={e => setEditValue(e.target.value)}
            onBlur={saveEdit}
            onKeyDown={e => { if (e.key === 'Enter') saveEdit(); if (e.key === 'Escape') setEditing(null) }}
            className="w-20 border border-indigo-300 rounded px-1 py-0.5 text-xs focus:outline-none" />
        ) : value == null || value === '' ? <span className="text-red-400">입력필요</span> : String(value)}
      </td>
    )
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-800">🗂️ 상품마스터</h1>
          <p className="text-xs text-gray-400 mt-1">가공된 영속 상품마스터입니다. 셀을 눌러 빠르게 수정하거나, 🔍 상세로 들어가 전체 항목을 편집합니다.</p>
        </div>
        <div className="flex gap-2">
          <button onClick={genAllAiNames}
            className="px-4 py-2 bg-indigo-600 text-white text-sm rounded-lg hover:bg-indigo-700 transition-colors">
            ✨ AI 상품명 생성 {selected.size > 0 ? `(${selected.size}개 선택)` : '(미생성 전체)'}
          </button>
          <button onClick={markReady}
            className="px-4 py-2 bg-emerald-600 text-white text-sm rounded-lg hover:bg-emerald-700 transition-colors">
            ✅ 선택 확정 (ready)
          </button>
        </div>
      </div>

      {loading ? (
        <div className="bg-white rounded-xl border border-gray-200 p-12 text-center text-gray-400 text-sm">불러오는 중...</div>
      ) : rows.length === 0 ? (
        <div className="bg-white rounded-xl border border-gray-200 p-12 text-center text-gray-400">
          <div className="text-4xl mb-3">📭</div>
          <p className="text-sm">가공된 상품마스터가 없습니다.</p>
          <button onClick={() => openTab({ id: 'products-list', type: 'products-list', title: '수집 확인', icon: '📥', closable: true })}
            className="mt-2 inline-block text-indigo-600 text-sm hover:underline">← 수집 확인에서 가공하기</button>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-3 mb-4">
            <div className="bg-white rounded-xl border border-gray-200 p-4 text-center">
              <div className="text-2xl font-bold text-gray-800">{rows.length}</div>
              <div className="text-xs text-gray-400 mt-1">전체 상품마스터</div>
            </div>
            <div className="bg-white rounded-xl border border-gray-200 p-4 text-center">
              <div className="text-2xl font-bold text-emerald-600">{readyCount}</div>
              <div className="text-xs text-gray-400 mt-1">완성됨 (내보내기 가능)</div>
            </div>
            <div className="bg-white rounded-xl border border-gray-200 p-4 text-center">
              <div className="text-2xl font-bold text-amber-600">{rows.length - readyCount}</div>
              <div className="text-xs text-gray-400 mt-1">미완성 (보완 필요)</div>
            </div>
          </div>

          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 bg-gray-50">
              <label className="flex items-center gap-2 text-xs text-gray-600 cursor-pointer">
                <input type="checkbox" checked={notReadyOnly} onChange={e => setNotReadyOnly(e.target.checked)} />
                보완 필요한 상품만 보기
              </label>
              <span className="text-xs text-gray-400">클릭해서 셀 수정 · 마진 = 판매가 - 매입가 - 기타비용</span>
            </div>
            <div className="overflow-auto max-h-[70vh]">
              <table className="text-xs border-collapse whitespace-nowrap">
                <thead className="sticky top-0 z-10 bg-gray-50">
                  <tr className="border-b border-gray-200 text-gray-500 font-semibold">
                    <th className="w-10 px-3 py-2"><input type="checkbox" checked={selected.size === visibleRows.length && visibleRows.length > 0} onChange={selectAll} /></th>
                    <th className="w-14 px-2 py-2 text-left">이미지</th>
                    <th className="px-3 py-2 text-left sticky left-0 bg-gray-50 z-20">최종상품명</th>
                    <th className="px-3 py-2 text-left">카테고리</th>
                    <th className="px-3 py-2 text-left">브랜드</th>
                    <th className="px-3 py-2 text-left">제조사</th>
                    <th className="px-3 py-2 text-left">원산지</th>
                    <th className="px-3 py-2 text-left">매입가</th>
                    <th className="px-3 py-2 text-left">소비자가</th>
                    <th className="px-3 py-2 text-left">판매가</th>
                    <th className="px-3 py-2 text-left">배송비</th>
                    <th className="px-3 py-2 text-left">기타비용</th>
                    <th className="px-3 py-2 text-left">마진</th>
                    <th className="px-3 py-2 text-left">재고</th>
                    <th className="px-3 py-2 text-left">상태</th>
                    <th className="w-10 px-2 py-2 text-left">상세</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleRows.map(row => {
                    const margin = marginOf(row)
                    return (
                      <tr key={row.id} className="border-b border-gray-100 hover:bg-gray-50">
                        <td className="px-3 py-2"><input type="checkbox" checked={selected.has(row.id)} onChange={() => toggleSelect(row.id)} /></td>
                        <td className="px-2 py-2">
                          <div className="w-10 h-10 relative rounded overflow-hidden bg-gray-100">
                            {row.thumbnail_local && <Image src={row.thumbnail_local} alt="" fill className="object-cover" unoptimized />}
                          </div>
                        </td>
                        <td className="px-3 py-2 sticky left-0 bg-white max-w-[220px]">
                          <input
                            defaultValue={row.name_final || row.name_ai || row.name_original || ''}
                            onBlur={e => e.target.value !== (row.name_final || '') && saveFinalName(row.id, e.target.value)}
                            className="w-full border border-gray-200 rounded px-1.5 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-indigo-400"
                          />
                          <div className="flex items-center gap-1 mt-1">
                            {row.name_ai && <span className="text-indigo-500 text-[10px] truncate">AI: {row.name_ai}</span>}
                            <button onClick={() => genAiName(row.id)} disabled={aiLoading.has(row.id)}
                              className="text-[10px] text-indigo-500 hover:text-indigo-700 disabled:opacity-50 shrink-0">
                              {aiLoading.has(row.id) ? '...' : '✨재생성'}
                            </button>
                          </div>
                        </td>
                        <EditableCell row={row} k="master_category" label="카테고리 (몰 원본: 없으면 자동 대체)" />
                        <EditableCell row={row} k="brand" label="브랜드" />
                        <EditableCell row={row} k="manufacturer" label="제조사" />
                        <EditableCell row={row} k="origin" label="원산지" />
                        <EditableCell row={row} k="cost_price" label="매입가" />
                        <EditableCell row={row} k="list_price" label="소비자가" />
                        <EditableCell row={row} k="sale_price" label="판매가" />
                        <EditableCell row={row} k="shipping_fee" label="배송비" />
                        <EditableCell row={row} k="other_cost" label="기타비용" />
                        <td className="px-3 py-2 text-xs font-medium">
                          {margin == null ? '-' : <span className={margin >= 0 ? 'text-emerald-600' : 'text-red-500'}>₩{margin.toLocaleString()}</span>}
                        </td>
                        <td className="px-3 py-2 text-xs">{row.stock_status || '-'}{row.stock_qty != null && ` (${row.stock_qty})`}</td>
                        <td className="px-3 py-2 text-xs">
                          {row.status === 'ready' ? <span className="text-emerald-600 font-medium">확정됨</span> : <span className="text-gray-400">{row.status}</span>}
                        </td>
                        <td className="px-2 py-2">
                          <button onClick={() => openDetail(row)} title="상세 보기" className="text-indigo-500 hover:text-indigo-700">🔍</button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      <div className="mt-3 flex items-center justify-between text-xs text-gray-400">
        <button onClick={() => openTab({ id: 'products-list', type: 'products-list', title: '수집 확인', icon: '📥', closable: true })}
          className="text-gray-500 hover:underline">← 수집 확인</button>
        <button onClick={() => openTab({ id: 'export', type: 'export', title: '엑셀 내보내기', icon: '📊', closable: true })}
          className="text-indigo-600 hover:underline font-medium">엑셀 내보내기로 →</button>
      </div>
    </div>
  )
}
