'use client'
import { useEffect, useState, useCallback } from 'react'
import { useTabs } from '../shell/TabsContext'

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

type Marketplace = 'coupang' | 'naver' | '11st' | 'gmarket' | 'auction' | 'shoplinker' | 'sabangnet' | 'all'

const MARKET_META: { id: Marketplace; color: string }[] = [
  { id: 'all',        color: 'bg-gray-700' },
  { id: 'coupang',    color: 'bg-blue-600' },
  { id: 'naver',      color: 'bg-green-600' },
  { id: '11st',       color: 'bg-red-600' },
  { id: 'gmarket',    color: 'bg-orange-500' },
  { id: 'auction',    color: 'bg-red-700' },
  { id: 'shoplinker', color: 'bg-purple-600' },
  { id: 'sabangnet',  color: 'bg-cyan-600' },
]

export function ExportPanel() {
  const { openTab, refreshSignals } = useTabs()
  const [rows, setRows]             = useState<MasterRow[]>([])
  const [configs, setConfigs]       = useState<MarketplaceConfig[]>([])
  const [selected, setSelected]     = useState<Set<number>>(new Set())
  const [market, setMarket]         = useState<Marketplace>('all')
  const [downloading, setDownloading] = useState(false)

  const load = useCallback(() => {
    fetch('/api/master?clientId=1').then(r => r.json()).then((d: MasterRow[]) => { if (Array.isArray(d)) setRows(d) }).catch(() => {})
    fetch('/api/marketplace-configs').then(r => r.json()).then((d: MarketplaceConfig[]) => { if (Array.isArray(d)) setConfigs(d) }).catch(() => {})
  }, [])

  useEffect(() => { load() }, [load, refreshSignals.master])

  const readyRows = rows.filter(r => r.status === 'ready')

  function toggleSelect(id: number) {
    setSelected(s => {
      const n = new Set(s)
      if (n.has(id)) n.delete(id); else n.add(id)
      return n
    })
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
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-gray-800">📊 엑셀 내보내기</h1>
        <button onClick={handleExport} disabled={downloading || readyRows.length === 0}
          className="px-4 py-2 bg-teal-500 hover:bg-teal-600 text-white text-sm font-semibold rounded-full disabled:opacity-50 disabled:cursor-not-allowed transition-colors shrink-0">
          {downloading ? '생성 중...' : `📥 엑셀 다운로드 (${selectedCount}개)`}
        </button>
      </div>

      <div className="grid grid-cols-[1fr_320px] gap-6">
        {/* 상품 선택 (확정된 상품만) */}
        <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden">
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
              <button onClick={() => openTab({ id: 'master-list', type: 'master-list', title: '상품마스터', icon: '🗂️', closable: true })}
                className="text-teal-500 hover:underline">상품마스터에서 먼저 확정하기 →</button>
            </div>
          ) : (
            <div className="max-h-[600px] overflow-y-auto">
              <table className="w-full text-xs border-collapse">
                <tbody>
                  {readyRows.map(p => (
                    <tr key={p.id} onClick={() => toggleSelect(p.id)}
                      className={`group border-b border-gray-100 last:border-0 cursor-pointer transition-colors ${selected.has(p.id) ? 'bg-teal-50' : 'hover:bg-gray-50'}`}>
                      <td className={`px-4 py-3 w-6 sticky left-0 z-[1] ${selected.has(p.id) ? 'bg-teal-50' : 'bg-white group-hover:bg-gray-50'}`}>
                        <input type="checkbox" checked={selected.has(p.id)} onChange={() => toggleSelect(p.id)} onClick={e => e.stopPropagation()} />
                      </td>
                      <td className="px-4 py-3 text-gray-700 max-w-[400px] truncate">{p.name_final || p.name_ai || p.name_original}</td>
                      <td className="px-4 py-3 text-gray-500 whitespace-nowrap">{p.sale_price ? `₩${p.sale_price.toLocaleString()}` : ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* 내보내기 설정 */}
        <div className="space-y-4">
          <div className="bg-white rounded-2xl border border-gray-200 p-5">
            <h2 className="text-sm font-semibold text-gray-700 mb-4">등록 마켓 선택</h2>
            <div className="space-y-2">
              {MARKET_META.map(m => {
                const c = configs.find(cc => cc.code === m.id)
                return (
                  <button key={m.id} onClick={() => setMarket(m.id)}
                    className={`w-full px-4 py-2.5 rounded-xl text-sm font-medium text-left transition-colors ${market === m.id ? `${m.color} text-white` : 'bg-gray-50 text-gray-700 hover:bg-gray-100'}`}>
                    {m.id === 'all' ? '전체 (마스터 + 전 마켓)' : c?.name || m.id}
                    {c && m.id !== 'all' && <span className="block text-[10px] opacity-70">1회 최대 {c.max_batch_size}개 · 수수료 {(c.default_commission_rate * 100).toFixed(0)}%</span>}
                  </button>
                )
              })}
            </div>
          </div>

          <div className="bg-white rounded-2xl border border-gray-200 p-5">
            <div className="text-sm text-gray-600 mb-1">
              선택된 상품: <strong className="text-gray-800">{selectedCount}개</strong>
            </div>
            {config && batchCount > 1 && (
              <div className="text-sm text-amber-600 mb-1">
                1회 등록 한도({config.max_batch_size}개) 초과 → 워크북 내 {batchCount}개 시트로 분할됩니다.
              </div>
            )}
            <div className="text-sm text-gray-600">
              내보낼 마켓: <strong className="text-gray-800">{market === 'all' ? '전체' : configs.find(c => c.code === market)?.name}</strong>
            </div>
          </div>

          <div className="bg-gray-50 rounded-2xl border border-gray-200 p-4 text-xs text-gray-500 space-y-1">
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
