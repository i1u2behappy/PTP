'use client'
import { useEffect, useState, useCallback } from 'react'

interface MasterRow {
  id: number
  name_original: string
  name_ai: string | null
  name_final: string | null
  sale_price: number | null
  status: string
}

interface MarketplaceConfig {
  code: string
  name: string
  max_batch_size: number
  default_commission_rate: number
  default_shipping_fee: number
}

type Marketplace = 'coupang' | 'naver' | '11st' | 'gmarket' | 'auction' | 'all'

const MARKET_META: { id: Marketplace; color: string }[] = [
  { id: 'all',     color: 'bg-gray-700' },
  { id: 'coupang', color: 'bg-blue-600' },
  { id: 'naver',   color: 'bg-green-600' },
  { id: '11st',    color: 'bg-red-600' },
  { id: 'gmarket', color: 'bg-orange-500' },
  { id: 'auction', color: 'bg-red-700' },
]

export default function ExportPage() {
  const [rows, setRows]             = useState<MasterRow[]>([])
  const [configs, setConfigs]       = useState<MarketplaceConfig[]>([])
  const [selected, setSelected]     = useState<Set<number>>(new Set())
  const [market, setMarket]         = useState<Marketplace>('all')
  const [downloading, setDownloading] = useState(false)

  const load = useCallback(() => {
    fetch('/api/master?clientId=1').then(r => r.json()).then((d: MasterRow[]) => { if (Array.isArray(d)) setRows(d) }).catch(() => {})
    fetch('/api/marketplace-configs').then(r => r.json()).then((d: MarketplaceConfig[]) => { if (Array.isArray(d)) setConfigs(d) }).catch(() => {})
  }, [])

  useEffect(() => { load() }, [load])

  const readyRows = rows.filter(r => r.status === 'ready')

  function toggleSelect(id: number) {
    setSelected(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n })
  }
  function selectAll() {
    setSelected(selected.size === readyRows.length ? new Set() : new Set(readyRows.map(r => r.id)))
  }

  const selectedCount = selected.size > 0 ? selected.size : readyRows.length
  const config = configs.find(c => c.code === market)
  const batchCount = config ? Math.max(1, Math.ceil(selectedCount / config.max_batch_size)) : 1

  async function handleExport() {
    const ids = selected.size > 0 ? [...selected] : readyRows.map(r => r.id)
    if (!ids.length) return alert('확정(ready)된 상품이 없습니다. 상품마스터 화면에서 먼저 확정하세요.')
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
        {/* 상품 선택 (확정된 상품만) */}
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 bg-gray-50">
            <span className="text-sm font-semibold text-gray-700">확정(ready)된 상품 선택</span>
            <label className="flex items-center gap-2 text-xs text-gray-500 cursor-pointer">
              <input type="checkbox" checked={selected.size === readyRows.length && readyRows.length > 0} onChange={selectAll} />
              전체 선택
            </label>
          </div>

          {readyRows.length === 0 ? (
            <div className="p-8 text-center text-sm text-gray-400">
              <div className="text-3xl mb-2">📭</div>
              <a href="/products/master" className="text-indigo-600 hover:underline">상품마스터에서 먼저 확정하기 →</a>
            </div>
          ) : (
            <div className="divide-y divide-gray-100 max-h-[600px] overflow-y-auto">
              {readyRows.map(p => (
                <label key={p.id} className={`flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-gray-50 transition-colors ${selected.has(p.id) ? 'bg-indigo-50' : ''}`}>
                  <input type="checkbox" checked={selected.has(p.id)} onChange={() => toggleSelect(p.id)} />
                  <div className="flex-1 min-w-0 text-xs text-gray-700 truncate">
                    {p.name_final || p.name_ai || p.name_original}
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
              {MARKET_META.map(m => {
                const c = configs.find(cc => cc.code === m.id)
                return (
                  <button key={m.id} onClick={() => setMarket(m.id)}
                    className={`w-full px-4 py-2.5 rounded-lg text-sm font-medium text-left transition-colors ${market === m.id ? `${m.color} text-white` : 'bg-gray-50 text-gray-700 hover:bg-gray-100'}`}>
                    {m.id === 'all' ? '전체 (마스터 + 전 마켓)' : c?.name || m.id}
                    {c && m.id !== 'all' && <span className="block text-[10px] opacity-70">1회 최대 {c.max_batch_size}개 · 수수료 {(c.default_commission_rate * 100).toFixed(0)}%</span>}
                  </button>
                )
              })}
            </div>
          </div>

          <div className="bg-white rounded-xl border border-gray-200 p-5">
            <div className="text-sm text-gray-600 mb-1">
              선택된 상품: <strong className="text-gray-800">{selectedCount}개</strong>
            </div>
            {config && batchCount > 1 && (
              <div className="text-sm text-amber-600 mb-1">
                1회 등록 한도({config.max_batch_size}개) 초과 → 워크북 내 {batchCount}개 시트로 분할됩니다.
              </div>
            )}
            <div className="text-sm text-gray-600 mb-4">
              내보낼 마켓: <strong className="text-gray-800">{market === 'all' ? '전체' : configs.find(c => c.code === market)?.name}</strong>
            </div>
            <button onClick={handleExport} disabled={downloading || readyRows.length === 0}
              className="w-full py-3 bg-amber-500 hover:bg-amber-600 text-white text-sm font-semibold rounded-xl disabled:opacity-50 disabled:cursor-not-allowed transition-colors">
              {downloading ? '생성 중...' : '📥 엑셀 다운로드'}
            </button>
          </div>

          <div className="bg-gray-50 rounded-xl border border-gray-200 p-4 text-xs text-gray-500 space-y-1">
            <p className="font-semibold text-gray-600">포함되는 시트</p>
            <p>• 마스터데이터 (항상 포함)</p>
            <p>• 선택 마켓 대량등록 양식 (한도 초과 시 시트 분할)</p>
            <p>• 이미지 URL은 설정 → 이미지 호스팅 기준으로 조립</p>
          </div>
        </div>
      </div>
    </div>
  )
}
