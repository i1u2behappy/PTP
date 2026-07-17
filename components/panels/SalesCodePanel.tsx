'use client'
import { useEffect, useState, useCallback } from 'react'
import { ScrapeScopePicker, type ScrapeScope } from './shared/ScrapeScopePicker'

interface Client { id: number; name: string; code: string | null }
interface MasterRow {
  id: number; name_original: string; name_ai: string | null; name_final: string | null
  internal_code: string | null; sales_code: string | null; mall_product_code: string | null
}

export function SalesCodePanel({ params }: { params?: Record<string, unknown> }) {
  const [scope, setScope] = useState<ScrapeScope>({ clientId: '', siteId: '', sessionId: '' })
  const [clients, setClients] = useState<Client[]>([])
  const [rows, setRows] = useState<MasterRow[]>([])
  const [search, setSearch] = useState('')
  const [combining, setCombining] = useState(false)
  const [savingId, setSavingId] = useState<number | null>(null)

  useEffect(() => {
    fetch('/api/clients').then(r => r.json()).then((d: Client[]) => setClients(Array.isArray(d) ? d : [])).catch(() => {})
  }, [])

  const loadRows = useCallback(() => {
    if (scope.sessionId === '') { setRows([]); return }
    fetch(`/api/master?sessionId=${scope.sessionId}`).then(r => r.json()).then((d: MasterRow[]) => setRows(Array.isArray(d) ? d : [])).catch(() => {})
  }, [scope.sessionId])

  useEffect(() => { loadRows() }, [loadRows])

  const client = clients.find(c => c.id === scope.clientId)
  const clientPrefix = client?.code ? client.code.split('-')[0] : null

  /** 거래처 코드 앞 2자리 + 몰 자체 상품코드 조합 — 판매관리코드는 이 시스템에서 상품을 관리하는 키값이다. */
  function combine(row: MasterRow): string | null {
    if (!clientPrefix) return null
    const own = row.mall_product_code || String(row.id).padStart(6, '0')
    return `${clientPrefix}-${own}`
  }

  async function saveSalesCode(id: number, value: string): Promise<boolean> {
    const res = await fetch(`/api/master/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sales_code: value || null }) })
    if (!res.ok) {
      const e = await res.json().catch(() => ({}))
      alert(e.error || '저장에 실패했습니다.')
      return false
    }
    return true
  }

  async function applyOne(row: MasterRow) {
    const code = combine(row)
    if (!code) return
    setSavingId(row.id)
    try {
      if (await saveSalesCode(row.id, code)) loadRows()
    } finally {
      setSavingId(null)
    }
  }

  async function applyAllMissing() {
    if (!clientPrefix) return
    setCombining(true)
    try {
      const targets = rows.filter(r => !r.sales_code)
      for (const r of targets) {
        const code = combine(r)
        if (code) await saveSalesCode(r.id, code)
      }
      loadRows()
    } finally {
      setCombining(false)
    }
  }

  const q = search.trim().toLowerCase()
  const visibleRows = q
    ? rows.filter(r => (r.name_final || r.name_ai || r.name_original || '').toLowerCase().includes(q) || (r.sales_code || '').toLowerCase().includes(q)
        || (r.internal_code || '').toLowerCase().includes(q) || (r.mall_product_code || '').toLowerCase().includes(q))
    : rows
  const missingCount = rows.filter(r => !r.sales_code).length

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center justify-between mb-6 shrink-0">
        <div>
          <h1 className="text-2xl font-bold text-gray-800">💳 판매관리코드 관리</h1>
          <p className="text-xs text-gray-400 mt-1">
            <b className="text-gray-600">판매관리코드 = 거래처 코드 앞 2자리 + 몰 자체 상품코드</b>를 조합한, 이 시스템에서 상품을 관리하는 키값입니다. 상품마다 고유해야 합니다.
          </p>
        </div>
        <button onClick={applyAllMissing} disabled={combining || missingCount === 0 || !clientPrefix}
          className="px-4 py-2 bg-teal-500 text-white text-sm font-semibold rounded-full hover:bg-teal-600 disabled:opacity-50 transition-colors">
          {combining ? '조합 중...' : `미입력분 전체 조합 적용 (${missingCount})`}
        </button>
      </div>

      <ScrapeScopePicker initialSiteId={params?.siteId as number | undefined} initialSessionId={params?.sessionId as number | undefined} onScopeChange={setScope} />

      {scope.sessionId === '' ? null : (
        <>
          <div className="bg-white rounded-2xl border border-gray-200 p-4 mb-4 flex flex-wrap items-center gap-3 shrink-0">
            {client && (
              client.code ? (
                <span className="text-sm text-gray-600">거래처 코드 앞 2자리: <b className="text-teal-600">{clientPrefix}</b></span>
              ) : (
                <span className="text-sm text-amber-600">이 거래처에 코드가 없어 조합할 수 없습니다. 거래처 상세에서 코드를 먼저 확인하세요.</span>
              )
            )}
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="상품명·판매관리코드·내부코드·몰상품코드 검색..."
              className="flex-1 min-w-[160px] border border-gray-300 rounded-full px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-teal-400" />
          </div>

          {rows.length === 0 ? (
            <div className="bg-white rounded-2xl border border-gray-200 p-12 text-center text-gray-400">
              <div className="text-4xl mb-3">💳</div>
              <p className="text-sm">이 세션에 병합된 상품마스터가 없습니다.</p>
            </div>
          ) : (
            <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden flex-1 min-h-0 flex flex-col">
              <div className="overflow-y-auto flex-1 min-h-0">
                <table className="w-full text-sm border-collapse">
                  <thead className="sticky top-0 z-10 bg-gray-50">
                    <tr className="border-b border-gray-200 text-xs font-semibold text-gray-500">
                      <th className="px-4 py-3 text-left">상품명</th>
                      <th className="px-4 py-3 text-left">거래처코드 접두어</th>
                      <th className="px-4 py-3 text-left">몰 상품코드</th>
                      <th className="px-4 py-3 text-left">조합 미리보기</th>
                      <th className="px-4 py-3 text-left">판매관리코드 (저장값)</th>
                      <th className="px-4 py-3 text-left">적용</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleRows.map(row => {
                      const preview = combine(row)
                      const isApplied = !!row.sales_code && row.sales_code === preview
                      return (
                        <tr key={row.id} className="border-b border-gray-100 hover:bg-gray-50">
                          <td className="px-4 py-2 text-xs text-gray-700 truncate max-w-[260px]">{row.name_final || row.name_ai || row.name_original}</td>
                          <td className="px-4 py-2 text-xs font-mono text-teal-600">{clientPrefix || '-'}</td>
                          <td className="px-4 py-2 text-xs font-mono text-gray-500">{row.mall_product_code || '-'}</td>
                          <td className="px-4 py-2 text-xs font-mono text-gray-400">{preview || '-'}</td>
                          <td className="px-4 py-2">
                            <input defaultValue={row.sales_code || ''} placeholder="미입력"
                              onBlur={e => e.target.value !== (row.sales_code || '') && saveSalesCode(row.id, e.target.value).then(ok => ok && loadRows())}
                              className="w-40 border border-gray-200 rounded px-1.5 py-1 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-teal-300" />
                          </td>
                          <td className="px-4 py-2">
                            <button onClick={() => applyOne(row)} disabled={!preview || isApplied || savingId === row.id}
                              className="px-3 py-1 bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-semibold rounded-full disabled:opacity-40 transition-colors">
                              {isApplied ? '적용됨' : savingId === row.id ? '적용 중...' : '조합 적용'}
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
        </>
      )}
    </div>
  )
}
