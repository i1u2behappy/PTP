'use client'
import { useCallback, useEffect, useState } from 'react'
import { useTabs } from '../shell/TabsContext'

interface ClientOption { id: number; name: string }
interface MasterRow { id: number; name_original: string; name_ai: string | null; name_final: string | null; sale_price: number | null; status: string }
interface MarketOption { code: string; name: string }
interface CategoryAttribute { name: string; required: boolean }
interface CategoryNoticeItem { categoryName: string; name: string; required: boolean }
interface CategoryMeta { attributes: CategoryAttribute[]; notices: CategoryNoticeItem[] }
interface RegisterResult {
  success: { productMasterId: number; externalId: string }[]
  failed: { productMasterId: number; error: string }[]
}

/**
 * "오픈마켓 등록" — 확정(ready)된 상품을 API 어댑터가 있는 마켓(지금은 쿠팡)에 실제로 등록한다
 * (!specifications/marketplace-api-integration.md). 한 번에 한 카테고리코드로만 등록한다 — 서로 다른
 * 카테고리 상품을 섞어 선택하면 그 카테고리에 안 맞는 속성/고시정보 검증에서 걸러진다(엑셀 내보내기의
 * "선택 상품 → 마켓 선택 → 실행" 흐름과 동일한 패턴, ExportPanel.tsx 참고).
 */
export function MarketplaceRegisterPanel() {
  const { openTab } = useTabs()
  const [clients, setClients] = useState<ClientOption[]>([])
  const [clientId, setClientId] = useState<number | ''>('')
  const [markets, setMarkets] = useState<MarketOption[]>([])
  const [marketCode, setMarketCode] = useState('')
  const [rows, setRows] = useState<MasterRow[]>([])
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [categoryCode, setCategoryCode] = useState('')
  const [meta, setMeta] = useState<CategoryMeta | null>(null)
  const [loadingMeta, setLoadingMeta] = useState(false)
  const [metaError, setMetaError] = useState('')
  const [noticeContents, setNoticeContents] = useState<Record<string, string>>({})
  const [registering, setRegistering] = useState(false)
  const [result, setResult] = useState<RegisterResult | null>(null)

  useEffect(() => {
    fetch('/api/clients').then(r => r.json()).then((d: ClientOption[]) => setClients(Array.isArray(d) ? d : [])).catch(() => {})
    fetch('/api/marketplace/adapters').then(r => r.json()).then((d: MarketOption[]) => setMarkets(Array.isArray(d) ? d : [])).catch(() => {})
  }, [])

  const loadRows = useCallback(() => {
    if (clientId === '') { setRows([]); return }
    fetch(`/api/master?clientId=${clientId}`).then(r => r.json()).then((d: MasterRow[]) => setRows(Array.isArray(d) ? d : [])).catch(() => {})
  }, [clientId])

  /* eslint-disable-next-line react-hooks/set-state-in-effect */
  useEffect(() => { loadRows() }, [loadRows])
  // 거래처를 바꾸면 이전 거래처의 선택/결과가 새 거래처에 잘못 적용되는 걸 막기 위해 비운다.
  /* eslint-disable-next-line react-hooks/set-state-in-effect */
  useEffect(() => { setSelected(new Set()); setResult(null); setMeta(null); setMetaError('') }, [clientId, marketCode])

  const readyRows = rows.filter(r => r.status === 'ready')

  function toggleSelect(id: number) {
    setSelected(s => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n })
  }
  function selectAll() {
    setSelected(selected.size === readyRows.length ? new Set() : new Set(readyRows.map(r => r.id)))
  }

  async function fetchCategoryMeta() {
    if (!marketCode || !categoryCode.trim() || clientId === '') return
    setLoadingMeta(true); setMetaError(''); setMeta(null)
    try {
      const res = await fetch(`/api/marketplace/${marketCode}/category-meta?clientId=${clientId}&categoryCode=${encodeURIComponent(categoryCode.trim())}`)
      const data = await res.json().catch(() => null)
      if (!res.ok) { setMetaError(data?.error || `조회 실패 (${res.status})`); return }
      setMeta(data as CategoryMeta)
      setNoticeContents({})
    } finally {
      setLoadingMeta(false)
    }
  }

  async function handleRegister() {
    if (!marketCode || clientId === '' || selected.size === 0 || !categoryCode.trim()) return
    setRegistering(true); setResult(null)
    try {
      const res = await fetch(`/api/marketplace/${marketCode}/register`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId, categoryCode: categoryCode.trim(), noticeContents, productMasterIds: [...selected] }),
      })
      const data = await res.json().catch(() => null)
      if (!res.ok) { alert(`등록 요청 실패: ${data?.error || res.status}`); return }
      setResult(data as RegisterResult)
    } finally {
      setRegistering(false)
    }
  }

  const requiredNotices = meta?.notices.filter(n => n.required) ?? []
  const canRegister = marketCode && clientId !== '' && selected.size > 0 && categoryCode.trim() && !registering

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-gray-800">🛒 오픈마켓 등록</h1>
        <button onClick={handleRegister} disabled={!canRegister}
          className="px-4 py-2 bg-teal-500 hover:bg-teal-600 text-white text-sm font-semibold rounded-full disabled:opacity-50 disabled:cursor-not-allowed transition-colors shrink-0">
          {registering ? '등록 중...' : `📤 등록 실행 (${selected.size}개)`}
        </button>
      </div>

      {markets.length === 0 && (
        <div className="bg-amber-50 border border-amber-200 text-amber-700 text-sm rounded-xl px-4 py-3 mb-4">
          API로 직접 등록 가능한 마켓이 아직 없습니다(지금은 쿠팡만 지원). 엑셀 내보내기는 기존 메뉴를 이용하세요.
        </div>
      )}

      <div className="flex items-center gap-3 mb-4">
        <select value={clientId} onChange={e => setClientId(e.target.value ? Number(e.target.value) : '')}
          className="border border-gray-300 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-400">
          <option value="">거래처 선택</option>
          {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <select value={marketCode} onChange={e => setMarketCode(e.target.value)}
          className="border border-gray-300 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-400">
          <option value="">마켓 선택</option>
          {markets.map(m => <option key={m.code} value={m.code}>{m.name}</option>)}
        </select>
        <input value={categoryCode} onChange={e => setCategoryCode(e.target.value)} placeholder="카테고리 코드 (예: 78877)"
          className="border border-gray-300 rounded-xl px-3 py-2 text-sm w-52 focus:outline-none focus:ring-2 focus:ring-teal-400" />
        <button onClick={fetchCategoryMeta} disabled={loadingMeta || !marketCode || !categoryCode.trim() || clientId === ''}
          className="px-4 py-2 bg-violet-50 hover:bg-violet-100 text-violet-600 text-sm font-semibold rounded-xl disabled:opacity-50">
          {loadingMeta ? '조회 중...' : '카테고리 정보 조회'}
        </button>
      </div>

      {metaError && <div className="bg-rose-50 border border-rose-200 text-rose-600 text-sm rounded-xl px-4 py-3 mb-4">{metaError}</div>}

      {meta && (
        <div className="bg-white rounded-2xl border border-gray-200 p-5 mb-4">
          <p className="text-xs text-gray-500 mb-3">
            이 카테고리의 필수 구매옵션 속성은 선택한 상품의 옵션명과 자동 대조됩니다(일치 안 하면 등록 시 거부).
            {meta.attributes.filter(a => a.required).length > 0 && (
              <> 필수 속성: {meta.attributes.filter(a => a.required).map(a => a.name).join(', ')}</>
            )}
          </p>
          {requiredNotices.length > 0 ? (
            <div className="space-y-2">
              <p className="text-xs font-semibold text-gray-600">필수 상품정보제공고시 — 실제 내용을 입력하세요(선택한 상품 전체에 같은 내용이 적용됩니다)</p>
              {requiredNotices.map(n => (
                <label key={n.name} className="block">
                  <span className="block text-xs text-gray-500 mb-1">{n.categoryName} · {n.name}</span>
                  <input value={noticeContents[n.name] || ''} onChange={e => setNoticeContents(v => ({ ...v, [n.name]: e.target.value }))}
                    className="w-full border border-gray-300 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-400" />
                </label>
              ))}
            </div>
          ) : (
            <p className="text-xs text-gray-400">이 카테고리는 필수 고시정보가 없습니다.</p>
          )}
        </div>
      )}

      {result && (
        <div className="bg-white rounded-2xl border border-gray-200 p-5 mb-4 text-sm">
          <p className="text-emerald-600 font-semibold mb-1">성공 {result.success.length}건</p>
          <p className="text-rose-500 font-semibold mb-2">실패 {result.failed.length}건</p>
          {result.failed.length > 0 && (
            <ul className="text-xs text-gray-500 space-y-1 max-h-40 overflow-y-auto">
              {result.failed.map(f => <li key={f.productMasterId}>상품 #{f.productMasterId}: {f.error}</li>)}
            </ul>
          )}
        </div>
      )}

      <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 bg-gray-50">
          <span className="text-sm font-semibold text-gray-700">확정(ready)된 상품 선택</span>
          <label className="flex items-center gap-2 text-xs text-gray-500 cursor-pointer">
            <input type="checkbox" checked={selected.size === readyRows.length && readyRows.length > 0} onChange={selectAll} />
            전체 선택
          </label>
        </div>
        {clientId === '' ? (
          <div className="p-8 text-center text-sm text-gray-400">거래처를 먼저 선택하세요.</div>
        ) : readyRows.length === 0 ? (
          <div className="p-8 text-center text-sm text-gray-400">
            <div className="text-3xl mb-2">📭</div>
            <button onClick={() => openTab({ id: 'master-list', type: 'master-list', title: '상품마스터', icon: '🗂️', closable: true })}
              className="text-teal-500 hover:underline">상품마스터에서 먼저 확정하기 →</button>
          </div>
        ) : (
          <div className="max-h-[480px] overflow-y-auto">
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
    </div>
  )
}
