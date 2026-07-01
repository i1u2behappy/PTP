'use client'
import { useEffect, useState, useCallback } from 'react'

interface Product {
  id: number
  name_original: string
  name_ai: string | null
  sale_price: number | null
  thumbnail_local: string | null
}

type Marketplace = 'coupang' | 'naver' | '11st' | 'gmarket' | 'auction' | 'all'

interface MasterFieldValue { original: string | number | null; value: string | number | null; filled: boolean }
interface PreviewRow { id: number; name: string; fields: Record<string, MasterFieldValue> }
interface PreviewData { fields: { key: string; label: string; meaning: string }[]; rows: PreviewRow[] }

const MARKETS: { id: Marketplace; label: string; color: string }[] = [
  { id: 'all',     label: '전체 (마스터 + 전 마켓)', color: 'bg-gray-700' },
  { id: 'coupang', label: '쿠팡 Wing',               color: 'bg-blue-600' },
  { id: 'naver',   label: '네이버 스마트스토어',      color: 'bg-green-600' },
  { id: '11st',    label: '11번가',                  color: 'bg-red-600' },
  { id: 'gmarket', label: 'G마켓',                   color: 'bg-orange-500' },
  { id: 'auction', label: '옥션',                    color: 'bg-red-700' },
]

export default function ExportPage() {
  const [products, setProducts]     = useState<Product[]>([])
  const [selected, setSelected]     = useState<Set<number>>(new Set())
  const [market, setMarket]         = useState<Marketplace>('all')
  const [downloading, setDownloading] = useState(false)
  const [preview, setPreview]       = useState<PreviewData | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)

  const load = useCallback(() => {
    fetch('/api/products').then(r => r.json()).then((d: Product[]) => {
      if (Array.isArray(d)) setProducts(d)
    }).catch(() => {})
  }, [])

  useEffect(() => { load() }, [load])

  function toggleSelect(id: number) {
    setSelected(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n })
  }
  function selectAll() {
    setSelected(selected.size === products.length ? new Set() : new Set(products.map(p => p.id)))
  }

  async function handlePreview() {
    const ids = selected.size > 0 ? [...selected] : products.map(p => p.id)
    if (!ids.length) return alert('상품을 선택하세요.')
    setPreviewLoading(true)
    try {
      const res = await fetch('/api/master-preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productIds: ids }),
      })
      if (!res.ok) throw new Error('미리보기 실패')
      setPreview(await res.json())
    } finally {
      setPreviewLoading(false)
    }
  }

  async function handleExport() {
    const ids = selected.size > 0 ? [...selected] : products.map(p => p.id)
    if (!ids.length) return alert('상품을 선택하세요.')
    setDownloading(true)
    try {
      const res = await fetch('/api/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productIds: ids, marketplace: market }),
      })
      if (!res.ok) throw new Error('내보내기 실패')
      const blob = await res.blob()
      const cd = res.headers.get('Content-Disposition') || ''
      const match = cd.match(/filename\*=UTF-8''(.+)/)
      const name = match ? decodeURIComponent(match[1]) : `상품데이터_${market}.xlsx`
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = name
      a.click()
    } finally {
      setDownloading(false)
    }
  }

  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-800 mb-6">📊 엑셀 내보내기</h1>

      <div className="grid grid-cols-[1fr_320px] gap-6">
        {/* 상품 선택 */}
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 bg-gray-50">
            <span className="text-sm font-semibold text-gray-700">상품 선택</span>
            <label className="flex items-center gap-2 text-xs text-gray-500 cursor-pointer">
              <input type="checkbox" checked={selected.size === products.length && products.length > 0} onChange={selectAll} />
              전체 선택
            </label>
          </div>

          {products.length === 0 ? (
            <div className="p-8 text-center text-sm text-gray-400">
              <div className="text-3xl mb-2">📭</div>
              <a href="/scraper" className="text-indigo-600 hover:underline">스크래핑 먼저 실행하기 →</a>
            </div>
          ) : (
            <div className="divide-y divide-gray-100 max-h-[600px] overflow-y-auto">
              {products.map(p => (
                <label key={p.id} className={`flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-gray-50 transition-colors ${selected.has(p.id) ? 'bg-indigo-50' : ''}`}>
                  <input type="checkbox" checked={selected.has(p.id)} onChange={() => toggleSelect(p.id)} />
                  <div className="flex-1 min-w-0">
                    <div className="text-xs text-gray-700 truncate">{p.name_original}</div>
                    {p.name_ai && <div className="text-xs text-indigo-600 font-medium mt-0.5">{p.name_ai}</div>}
                  </div>
                  <div className="text-xs text-gray-500 shrink-0">
                    {p.sale_price ? `₩${p.sale_price.toLocaleString()}` : ''}
                  </div>
                </label>
              ))}
            </div>
          )}
        </div>

        {/* 내보내기 설정 */}
        <div className="space-y-4">
          <div className="bg-white rounded-xl border border-gray-200 p-5">
            <h2 className="text-sm font-semibold text-gray-700 mb-4">등록 마켓 선택</h2>
            <div className="space-y-2">
              {MARKETS.map(m => (
                <button key={m.id} onClick={() => setMarket(m.id)}
                  className={`w-full px-4 py-2.5 rounded-lg text-sm font-medium text-left transition-colors ${market === m.id ? `${m.color} text-white` : 'bg-gray-50 text-gray-700 hover:bg-gray-100'}`}>
                  {m.label}
                </button>
              ))}
            </div>
          </div>

          <div className="bg-white rounded-xl border border-gray-200 p-5">
            <div className="text-sm text-gray-600 mb-1">
              선택된 상품: <strong className="text-gray-800">{selected.size > 0 ? selected.size : products.length}개</strong>
            </div>
            <div className="text-sm text-gray-600 mb-4">
              내보낼 마켓: <strong className="text-gray-800">{MARKETS.find(m => m.id === market)?.label}</strong>
            </div>
            <button onClick={handlePreview} disabled={previewLoading || products.length === 0}
              className="w-full mb-2 py-2.5 bg-slate-600 hover:bg-slate-700 text-white text-sm font-semibold rounded-xl disabled:opacity-50 disabled:cursor-not-allowed transition-colors">
              {previewLoading ? '분석 중...' : '🔍 마스터 데이터 미리보기'}
            </button>
            <button onClick={handleExport} disabled={downloading || products.length === 0}
              className="w-full py-3 bg-amber-500 hover:bg-amber-600 text-white text-sm font-semibold rounded-xl disabled:opacity-50 disabled:cursor-not-allowed transition-colors">
              {downloading ? '생성 중...' : '📥 엑셀 다운로드'}
            </button>
          </div>

          <div className="bg-gray-50 rounded-xl border border-gray-200 p-4 text-xs text-gray-500 space-y-1">
            <p className="font-semibold text-gray-600">포함되는 시트</p>
            <p>• 마스터데이터 (항상 포함)</p>
            <p>• 선택 마켓 대량등록 양식</p>
            <p>• 이미지 경로는 로컬 백업 기준</p>
          </div>
        </div>
      </div>

      {preview && (
        <div className="mt-6 bg-white rounded-xl border border-gray-200 overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 bg-gray-50">
            <span className="text-sm font-semibold text-gray-700">A(원본) → B(마스터데이터) 변환 미리보기</span>
            <span className="text-xs text-gray-400">노란 배경 = 원본이 비어있어 규칙으로 채워진 값</span>
          </div>
          <div className="overflow-x-auto max-h-[500px]">
            <table className="text-xs whitespace-nowrap">
              <thead className="bg-gray-50 sticky top-0">
                <tr>
                  <th className="px-3 py-2 text-left font-semibold text-gray-600 border-b border-gray-200">상품</th>
                  {preview.fields.map(f => (
                    <th key={f.key} className="px-3 py-2 text-left font-semibold text-gray-600 border-b border-gray-200" title={f.meaning}>
                      {f.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {preview.rows.map(row => (
                  <tr key={row.id} className="border-b border-gray-100">
                    <td className="px-3 py-2 text-gray-700 max-w-[200px] truncate">{row.name}</td>
                    {preview.fields.map(f => {
                      const cell = row.fields[f.key]
                      return (
                        <td key={f.key}
                          className={`px-3 py-2 ${cell.filled ? 'bg-amber-100 text-amber-800' : 'text-gray-700'}`}
                          title={cell.filled ? `${f.meaning} (원본: 공란)` : f.meaning}>
                          {cell.value === null || cell.value === '' ? <span className="text-gray-300">—</span> : String(cell.value)}
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
    </div>
  )
}
