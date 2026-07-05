'use client'
import { useEffect, useState, useCallback } from 'react'

interface MasterFieldValue { original: string | number | null; value: string | number | null; filled: boolean }
interface FieldMeta { key: string; label: string; meaning: string }
interface Row { id: number; name: string; fields: Record<string, MasterFieldValue> }

// thumbnail_local은 파일 경로라 텍스트로 직접 편집하지 않고 미리보기만 보여준다.
const EDITABLE_KEYS = ['name_original', 'name_ai', 'price', 'sale_price', 'brand', 'manufacturer', 'origin', 'category', 'description']
const NUMBER_KEYS = new Set(['price', 'sale_price'])

export default function CompletePage() {
  const [fields, setFields]     = useState<FieldMeta[]>([])
  const [rows, setRows]         = useState<Row[]>([])
  const [loading, setLoading]   = useState(true)
  const [gapsOnly, setGapsOnly] = useState(true)
  const [editing, setEditing]   = useState<{ id: number; key: string } | null>(null)
  const [editValue, setEditValue] = useState('')

  const load = useCallback(async () => {
    try {
      const listRes = await fetch('/api/products')
      const products = await listRes.json() as { id: number }[]
      if (!Array.isArray(products) || !products.length) { setRows([]); setFields([]); return }
      const res = await fetch('/api/master-preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productIds: products.map(p => p.id) }),
      })
      const d = await res.json() as { fields: FieldMeta[]; rows: Row[] }
      setFields(d.fields || [])
      setRows(d.rows || [])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const editableFields = fields.filter(f => EDITABLE_KEYS.includes(f.key))

  function isEmpty(row: Row, key: string) {
    const v = row.fields[key]?.value
    return v === null || v === ''
  }
  function rowGapCount(row: Row) {
    return editableFields.filter(f => isEmpty(row, f.key)).length
  }

  const visibleRows = gapsOnly ? rows.filter(r => rowGapCount(r) > 0) : rows
  const totalGapRows = rows.filter(r => rowGapCount(r) > 0).length

  function startEdit(id: number, key: string, current: string | number | null) {
    setEditing({ id, key })
    setEditValue(current == null ? '' : String(current))
  }

  async function saveEdit() {
    if (!editing) return
    const { id, key } = editing
    const value = NUMBER_KEYS.has(key) ? (editValue.trim() === '' ? null : Number(editValue)) : editValue
    await fetch(`/api/products/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [key]: value }),
    })
    setEditing(null)
    load()
  }

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-800">2️⃣ 데이터 보완</h1>
        <p className="text-xs text-gray-400 mt-1">
          최종 엑셀 양식 기준으로 부족한 값이 무엇인지 확인하고, 채워지지 않은 값을 직접 입력해 채웁니다.
        </p>
      </div>

      {loading ? (
        <div className="bg-white rounded-xl border border-gray-200 p-12 text-center text-gray-400 text-sm">불러오는 중...</div>
      ) : rows.length === 0 ? (
        <div className="bg-white rounded-xl border border-gray-200 p-12 text-center text-gray-400">
          <div className="text-4xl mb-3">📭</div>
          <p className="text-sm">수집된 상품이 없습니다.</p>
          <a href="/products" className="mt-2 inline-block text-indigo-600 text-sm hover:underline">← 수집 확인으로</a>
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 bg-gray-50">
            <label className="flex items-center gap-2 text-xs text-gray-600 cursor-pointer">
              <input type="checkbox" checked={gapsOnly} onChange={e => setGapsOnly(e.target.checked)} />
              보완 필요한 상품만 보기 {totalGapRows > 0 && `(${totalGapRows}개)`}
            </label>
            <span className="text-xs text-gray-400">노란 배경 = 규칙으로 자동 채움 · 빨간 테두리 = 직접 입력 필요 · 클릭해서 수정</span>
          </div>
          <div className="overflow-auto max-h-[70vh]">
            <table className="text-xs border-collapse whitespace-nowrap">
              <thead className="sticky top-0 z-10 bg-gray-50">
                <tr className="border-b border-gray-200 text-gray-500 font-semibold">
                  <th className="px-3 py-2 text-left sticky left-0 bg-gray-50 z-20">상품</th>
                  {editableFields.map(f => (
                    <th key={f.key} className="px-3 py-2 text-left" title={f.meaning}>{f.label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {visibleRows.map(row => (
                  <tr key={row.id} className="border-b border-gray-100 hover:bg-gray-50">
                    <td className="px-3 py-2 text-gray-700 max-w-[180px] truncate sticky left-0 bg-white">{row.name}</td>
                    {editableFields.map(f => {
                      const cell = row.fields[f.key]
                      const empty = cell.value === null || cell.value === ''
                      const isEditingThis = editing?.id === row.id && editing.key === f.key
                      return (
                        <td key={f.key}
                          className={`px-3 py-2 cursor-pointer ${empty ? 'border border-red-300 bg-red-50 text-red-400' : cell.filled ? 'bg-amber-100 text-amber-800' : 'text-gray-700'}`}
                          title={f.meaning}
                          onClick={() => !isEditingThis && startEdit(row.id, f.key, cell.value)}>
                          {isEditingThis ? (
                            <input autoFocus value={editValue} onChange={e => setEditValue(e.target.value)}
                              onBlur={saveEdit}
                              onKeyDown={e => { if (e.key === 'Enter') saveEdit(); if (e.key === 'Escape') setEditing(null) }}
                              className="w-28 border border-indigo-300 rounded px-1 py-0.5 text-xs focus:outline-none"
                            />
                          ) : empty ? '입력 필요' : String(cell.value)}
                        </td>
                      )
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="mt-3 flex items-center justify-between text-xs text-gray-400">
        <a href="/products" className="text-gray-500 hover:underline">← 수집 확인</a>
        <a href="/products/finalize" className="text-indigo-600 hover:underline font-medium">다음: 최종 완성 →</a>
      </div>
    </div>
  )
}
