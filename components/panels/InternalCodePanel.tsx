'use client'
import { useCallback, useEffect, useState } from 'react'
import { useTabs } from '../shell/TabsContext'
import { CLIENTS_LIST_TAB } from '../shell/menuTabs'
import { ScrapeScopePicker, type ScrapeScope } from './shared/ScrapeScopePicker'

interface Client { id: number; name: string; code: string | null; auto_internal_code?: boolean }
interface CodeRow { id: number; internal_code: string | null; name_final: string | null; name_ai: string | null; name_original: string; mall_product_code: string | null }

export function InternalCodePanel({ params }: { params?: Record<string, unknown> }) {
  const { openTab, openDetailModal, refreshSignals, bumpRefresh } = useTabs()
  const [scope, setScope] = useState<ScrapeScope>({ clientId: '', siteId: '', sessionId: '' })
  const [client, setClient] = useState<Client | null>(null)
  const [rows, setRows] = useState<CodeRow[]>([])
  const [search, setSearch] = useState('')
  const [generating, setGenerating] = useState(false)

  const load = useCallback(() => {
    const result = scope.sessionId === ''
      ? Promise.resolve({ client: null, rows: [] })
      : fetch(`/api/master/internal-codes?sessionId=${scope.sessionId}`).then(r => r.json())
    result.then((d: { client: Client | null; rows: CodeRow[] }) => {
      setClient(d.client)
      setRows(Array.isArray(d.rows) ? d.rows : [])
    }).catch(() => {})
  }, [scope.sessionId])

  useEffect(() => { load() }, [load, refreshSignals.master])

  async function generateMissing() {
    if (scope.sessionId === '') return
    setGenerating(true)
    try {
      await fetch('/api/master/internal-codes', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: scope.sessionId }),
      })
      bumpRefresh('master')
      load()
    } finally {
      setGenerating(false)
    }
  }

  function openMaster(row: CodeRow) {
    openDetailModal('master-detail', { masterId: row.id })
  }

  function openClient() {
    if (scope.clientId === '') return
    openTab({ ...CLIENTS_LIST_TAB, type: 'client-detail', params: { clientId: scope.clientId } })
  }

  const q = search.trim().toLowerCase()
  const visibleRows = q
    ? rows.filter(r => (r.mall_product_code || '').toLowerCase().includes(q) || (r.name_final || r.name_ai || r.name_original || '').toLowerCase().includes(q) || (r.internal_code || '').toLowerCase().includes(q))
    : rows
  const missingCount = rows.filter(r => !r.internal_code).length

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center justify-between mb-6 shrink-0">
        <div>
          <h1 className="text-2xl font-bold text-gray-800">🏷️ 관리코드 생성</h1>
          <p className="text-xs text-gray-400 mt-1">몰 상품코드를 거래처 코드 기반의 사내 관리코드(예: 2B_000001)로 변환합니다. 거래처 코드를 설정하고 자동생성을 켜두면 상품마스터 가공 시 자동으로 발급됩니다.</p>
        </div>
        <div className="flex gap-2">
          <button onClick={generateMissing} disabled={generating || !client?.code || missingCount === 0}
            className="px-4 py-2 bg-teal-500 text-white text-sm font-semibold rounded-full hover:bg-teal-600 disabled:opacity-50 transition-colors">
            {generating ? '발급 중...' : `미발급 전체 발급 (${missingCount})`}
          </button>
        </div>
      </div>

      <ScrapeScopePicker initialSiteId={params?.siteId as number | undefined} initialSessionId={params?.sessionId as number | undefined} onScopeChange={setScope} />

      {scope.sessionId === '' ? null : (
        <>
          <div className="bg-white rounded-2xl border border-gray-200 p-4 mb-4 flex flex-wrap items-center gap-3 shrink-0">
            {client && (
              client.code ? (
                <span className="text-sm text-gray-600">
                  코드 접두어: <b className="text-teal-600">{client.code}</b>
                  {' · '}자동생성:{' '}
                  {client.auto_internal_code === false ? <span className="text-amber-600 font-medium">꺼짐</span> : <span className="text-emerald-600 font-medium">사용 중</span>}
                  {' '}<button onClick={openClient} className="text-gray-400 underline hover:text-gray-600">(변경)</button>
                </span>
              ) : (
                <span className="text-sm text-amber-600">
                  이 거래처에 코드가 설정되지 않아 자동 발급이 꺼져 있습니다.{' '}
                  <button onClick={openClient} className="underline hover:text-amber-700">거래처 상세에서 설정하기 →</button>
                </span>
              )
            )}
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="상품코드·상품명·관리코드 검색..."
              className="flex-1 min-w-[160px] border border-gray-300 rounded-full px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-teal-400" />
          </div>

          {rows.length === 0 ? (
            <div className="bg-white rounded-2xl border border-gray-200 p-12 text-center text-gray-400">
              <div className="text-4xl mb-3">🏷️</div>
              <p className="text-sm">이 세션에 병합된 상품마스터가 없습니다.</p>
            </div>
          ) : (
            <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden flex-1 min-h-0 flex flex-col">
              <div className="overflow-y-auto flex-1 min-h-0">
                <table className="w-full text-sm border-collapse">
                  <thead className="sticky top-0 z-10 bg-gray-50">
                    <tr className="border-b border-gray-200 text-xs font-semibold text-gray-500">
                      <th className="px-4 py-3 text-left sticky left-0 z-20 bg-gray-50">몰 상품코드</th>
                      <th className="px-4 py-3 text-left">상품명</th>
                      <th className="px-4 py-3 text-left">관리코드</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleRows.map(row => (
                      <tr key={row.id} onClick={() => openMaster(row)}
                        className="group border-b border-gray-100 hover:bg-gray-50 cursor-pointer transition-colors">
                        <td className="px-4 py-2 text-xs text-gray-500 sticky left-0 z-10 bg-white group-hover:bg-gray-50">{row.mall_product_code || '-'}</td>
                        <td className="px-4 py-2 text-xs text-gray-700 truncate max-w-[320px]">{row.name_final || row.name_ai || row.name_original}</td>
                        <td className="px-4 py-2 text-xs">
                          {row.internal_code ? <span className="font-mono text-teal-600">{row.internal_code}</span> : <span className="text-rose-400">미발급</span>}
                        </td>
                      </tr>
                    ))}
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
