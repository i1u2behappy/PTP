'use client'
import { useEffect, useState, useCallback } from 'react'

interface MasterFieldValue { original: string | number | null; value: string | number | null; filled: boolean }
interface FieldMeta { key: string; label: string; meaning: string }
interface MasterRow { id: number; name: string; fields: Record<string, MasterFieldValue> }
interface Product { id: number; status: string }

interface Combined {
  id: number
  name: string
  status: string
  missing: string[]
}

export default function FinalizePage() {
  const [rows, setRows]         = useState<Combined[]>([])
  const [loading, setLoading]   = useState(true)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [saving, setSaving]     = useState(false)

  const load = useCallback(async () => {
    try {
      const productsRes = await fetch('/api/products')
      const products = await productsRes.json() as Product[]
      if (!Array.isArray(products) || !products.length) { setRows([]); return }

      const previewRes = await fetch('/api/master-preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productIds: products.map(p => p.id) }),
      })
      const preview = await previewRes.json() as { fields: FieldMeta[]; rows: MasterRow[] }
      const statusById = new Map(products.map(p => [p.id, p.status]))

      setRows((preview.rows || []).map((r): Combined => ({
        id: r.id,
        name: r.name,
        status: statusById.get(r.id) || 'draft',
        missing: (preview.fields || [])
          .filter(f => r.fields[f.key]?.value === null || r.fields[f.key]?.value === '')
          .map(f => f.label),
      })))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const readyRows = rows.filter(r => r.missing.length === 0)
  const notReadyRows = rows.filter(r => r.missing.length > 0)

  function toggleSelect(id: number) {
    setSelected(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n })
  }
  function selectAllReady() {
    setSelected(selected.size === readyRows.length ? new Set() : new Set(readyRows.map(r => r.id)))
  }

  async function finalizeSelected() {
    if (!selected.size) return
    setSaving(true)
    try {
      await Promise.all([...selected].map(id =>
        fetch(`/api/products/${id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'ready' }),
        }),
      ))
      setSelected(new Set())
      await load()
    } finally {
      setSaving(false)
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-800">3️⃣ 최종 완성</h1>
          <p className="text-xs text-gray-400 mt-1">오픈마켓 대량등록양식에 필요한 값이 모두 채워졌는지 확인하고 최종 확정합니다.</p>
        </div>
        <button onClick={finalizeSelected} disabled={!selected.size || saving}
          className="px-4 py-2 bg-emerald-600 text-white text-sm rounded-lg hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors">
          {saving ? '처리 중...' : `✅ 선택 상품 최종 확정 (${selected.size})`}
        </button>
      </div>

      {loading ? (
        <div className="bg-white rounded-xl border border-gray-200 p-12 text-center text-gray-400 text-sm">불러오는 중...</div>
      ) : rows.length === 0 ? (
        <div className="bg-white rounded-xl border border-gray-200 p-12 text-center text-gray-400">
          <div className="text-4xl mb-3">📭</div>
          <p className="text-sm">수집된 상품이 없습니다.</p>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-3 mb-4">
            <div className="bg-white rounded-xl border border-gray-200 p-4 text-center">
              <div className="text-2xl font-bold text-gray-800">{rows.length}</div>
              <div className="text-xs text-gray-400 mt-1">전체 상품</div>
            </div>
            <div className="bg-white rounded-xl border border-gray-200 p-4 text-center">
              <div className="text-2xl font-bold text-emerald-600">{readyRows.length}</div>
              <div className="text-xs text-gray-400 mt-1">완성됨 (확정 가능)</div>
            </div>
            <div className="bg-white rounded-xl border border-gray-200 p-4 text-center">
              <div className="text-2xl font-bold text-amber-600">{notReadyRows.length}</div>
              <div className="text-xs text-gray-400 mt-1">미완성 (보완 필요)</div>
            </div>
          </div>

          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            <div className="overflow-y-auto max-h-[65vh]">
              <table className="w-full text-sm border-collapse">
                <thead className="sticky top-0 z-10">
                  <tr className="bg-gray-50 border-b border-gray-200 text-xs font-semibold text-gray-500">
                    <th className="w-10 px-4 py-3 text-left">
                      <input type="checkbox" checked={selected.size === readyRows.length && readyRows.length > 0} onChange={selectAllReady} />
                    </th>
                    <th className="px-2 py-3 text-left">상품명</th>
                    <th className="w-28 px-2 py-3 text-left">확정 상태</th>
                    <th className="px-2 py-3 text-left">완성 여부</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(r => (
                    <tr key={r.id} className={`border-b border-gray-100 hover:bg-gray-50 ${selected.has(r.id) ? 'bg-indigo-50' : ''}`}>
                      <td className="px-4 py-3">
                        <input type="checkbox" checked={selected.has(r.id)} disabled={r.missing.length > 0} onChange={() => toggleSelect(r.id)} />
                      </td>
                      <td className="px-2 py-3 text-gray-700 text-xs truncate max-w-xs">{r.name}</td>
                      <td className="px-2 py-3 text-xs">
                        {r.status === 'ready' ? <span className="text-emerald-600 font-medium">확정됨</span> : <span className="text-gray-400">미확정</span>}
                      </td>
                      <td className="px-2 py-3 text-xs">
                        {r.missing.length === 0 ? (
                          <span className="text-emerald-600">✓ 완성</span>
                        ) : (
                          <span className="text-amber-600">⚠ 부족: {r.missing.join(', ')}</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      <div className="mt-3 flex items-center justify-between text-xs text-gray-400">
        <a href="/products/complete" className="text-gray-500 hover:underline">← 데이터 보완</a>
        <a href="/export" className="text-indigo-600 hover:underline font-medium">엑셀 내보내기로 →</a>
      </div>
    </div>
  )
}
