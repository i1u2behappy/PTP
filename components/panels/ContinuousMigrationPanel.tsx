'use client'
import { useEffect, useState, useCallback } from 'react'
import { useTabs } from '../shell/TabsContext'
import { MASTER_LIST_TAB } from '../shell/menuTabs'

interface Client { id: number; name: string }
interface Site { id: number; name: string | null; url: string; client_id: number | null }

interface ChangeRow {
  mallProductId: number
  masterId: number
  clientId: number
  nameOriginal: string
  mallProductCode: string
  lastScrapedAt: string | null
  updatedAt: string
  reasons: string[]
  priceOnly: boolean
}

/**
 * 마이그레이션3_연속관리 — 이미 상품마스터로 만들어져 거래처에 제공 중인 상품을, 몰에서 다시 스크랩한
 * 최신 값과 비교해 재고/옵션/이미지/가격이 바뀐 것만 골라 보여주고, 선택한 것만 다시 마이그레이션(상품
 * 마스터 갱신)한다. "1차 스크래핑 → 상품마스터" 절차를 변동분에 한해 반복하는 것과 같다 — 새 상품 자체는
 * 기존 "마이그레이션" 메뉴에서 다루고, 여기는 이미 만들어진 상품마스터의 "변동 감지 → 갱신"만 담당한다.
 */
export function ContinuousMigrationPanel() {
  const { openTab } = useTabs()
  const [clients, setClients] = useState<Client[]>([])
  const [clientId, setClientId] = useState<number | ''>('')
  const [sites, setSites] = useState<Site[]>([])
  const [siteId, setSiteId] = useState<number | ''>('')
  const [changes, setChanges] = useState<ChangeRow[]>([])
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [detecting, setDetecting] = useState(false)
  const [migrating, setMigrating] = useState(false)
  const [searched, setSearched] = useState(false)

  useEffect(() => {
    fetch('/api/clients').then(r => r.json()).then((d: Client[]) => setClients(Array.isArray(d) ? d : [])).catch(() => {})
    fetch('/api/sites').then(r => r.json()).then((d: Site[]) => setSites(Array.isArray(d) ? d : [])).catch(() => {})
  }, [])

  const filteredSites = clientId === '' ? sites : sites.filter(s => s.client_id === clientId)

  const detectChanges = useCallback(async () => {
    if (siteId === '') return
    setDetecting(true)
    try {
      const res = await fetch(`/api/master/changes?siteId=${siteId}`)
      const d = await res.json() as ChangeRow[]
      setChanges(Array.isArray(d) ? d : [])
      setSelected(new Set())
      setSearched(true)
    } finally {
      setDetecting(false)
    }
  }, [siteId])

  function toggleSelect(id: number) {
    setSelected(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n })
  }

  function toggleSelectAll() {
    setSelected(s => s.size === changes.length ? new Set() : new Set(changes.map(c => c.mallProductId)))
  }

  async function migrateSelected() {
    if (!selected.size || siteId === '') return
    setMigrating(true)
    try {
      const rows = changes.filter(c => selected.has(c.mallProductId))
      const clientIdForCall = rows[0]?.clientId || 1
      const res = await fetch('/api/master/reapply', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mallProductIds: rows.map(r => r.mallProductId), clientId: clientIdForCall, siteId }),
      })
      const d = await res.json() as { failed?: { id: number; error: string }[] }
      if (d.failed?.length) alert(`${d.failed.length}건은 컬럼 규칙 반영에 실패했습니다 (상품마스터 기본 갱신은 완료됨).`)
      await detectChanges()
    } finally {
      setMigrating(false)
    }
  }

  return (
    <div className="h-full flex flex-col">
      <div className="mb-6 shrink-0">
        <h1 className="text-2xl font-bold text-gray-800">🔁 마이그레이션3_연속관리</h1>
        <p className="text-xs text-gray-400 mt-1">
          이미 상품마스터로 만들어 거래처에 제공한 몰 품목 중, 몰 쪽에서 재고·옵션·이미지·가격이 바뀐 것을 찾아
          선택적으로 다시 마이그레이션합니다. 신규 상품 자체는 기존 &quot;마이그레이션&quot; 메뉴에서 처리해주세요.
        </p>
      </div>

      <div className="bg-white rounded-2xl border border-gray-200 p-4 mb-4 flex flex-wrap items-center gap-3 shrink-0">
        <label className="flex items-center gap-2 text-sm text-gray-600">
          거래처
          <select value={clientId} onChange={e => { setClientId(e.target.value ? Number(e.target.value) : ''); setSiteId('') }}
            className="border border-gray-300 rounded-xl px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-teal-400">
            <option value="">전체</option>
            {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-2 text-sm text-gray-600">
          몰
          <select value={siteId} onChange={e => setSiteId(e.target.value ? Number(e.target.value) : '')}
            className="border border-gray-300 rounded-xl px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-teal-400">
            <option value="">몰을 선택하세요</option>
            {filteredSites.map(s => <option key={s.id} value={s.id}>{s.name || s.url}</option>)}
          </select>
        </label>
        <button onClick={detectChanges} disabled={siteId === '' || detecting}
          className="px-4 py-1.5 bg-teal-500 text-white text-sm font-semibold rounded-full hover:bg-teal-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
          {detecting ? '감지 중...' : '🔍 변동 감지'}
        </button>
        {searched && changes.length > 0 && (
          <button onClick={migrateSelected} disabled={!selected.size || migrating}
            className="px-4 py-1.5 bg-emerald-600 text-white text-sm font-semibold rounded-full hover:bg-emerald-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
            {migrating ? '반영 중...' : `선택 재마이그레이션 (${selected.size})`}
          </button>
        )}
      </div>

      {!searched ? (
        <div className="bg-white rounded-2xl border border-gray-200 p-12 text-center text-gray-400 flex-1">
          <div className="text-4xl mb-3">🔁</div>
          <p className="text-sm">몰을 선택하고 &quot;변동 감지&quot;를 눌러주세요.</p>
        </div>
      ) : changes.length === 0 ? (
        <div className="bg-white rounded-2xl border border-gray-200 p-12 text-center text-gray-400 flex-1">
          <div className="text-4xl mb-3">✅</div>
          <p className="text-sm">현재 상품마스터와 몰의 최신 스크랩 값이 모두 일치합니다 — 변동된 상품이 없습니다.</p>
        </div>
      ) : (
        <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden flex-1 min-h-0 flex flex-col">
          <div className="overflow-y-auto flex-1 min-h-0">
            <table className="w-full text-sm border-collapse">
              <thead className="sticky top-0 z-10 bg-gray-50">
                <tr className="border-b border-gray-200 text-xs font-semibold text-gray-500">
                  <th className="px-4 py-3 text-left w-10">
                    <input type="checkbox" checked={selected.size > 0 && selected.size === changes.length} onChange={toggleSelectAll} />
                  </th>
                  <th className="px-4 py-3 text-left">몰상품코드</th>
                  <th className="px-4 py-3 text-left">상품명</th>
                  <th className="px-4 py-3 text-left">변동 내역</th>
                  <th className="px-4 py-3 text-left">최근 스크랩</th>
                  <th className="px-4 py-3 text-left">관리</th>
                </tr>
              </thead>
              <tbody>
                {changes.map(c => (
                  <tr key={c.mallProductId} className="border-b border-gray-100 hover:bg-gray-50">
                    <td className="px-4 py-2">
                      <input type="checkbox" checked={selected.has(c.mallProductId)} onChange={() => toggleSelect(c.mallProductId)} />
                    </td>
                    <td className="px-4 py-2 text-xs text-gray-500">{c.mallProductCode}</td>
                    <td className="px-4 py-2 text-xs text-gray-700 max-w-[220px] truncate" title={c.nameOriginal}>{c.nameOriginal}</td>
                    <td className="px-4 py-2 text-xs">
                      <ul className="space-y-0.5">
                        {c.reasons.map((r, i) => (
                          <li key={i} className={r.includes('참고용') ? 'text-gray-400' : 'text-amber-600'}>• {r}</li>
                        ))}
                      </ul>
                    </td>
                    <td className="px-4 py-2 text-xs text-gray-400 whitespace-nowrap">
                      {c.lastScrapedAt ? new Date(c.lastScrapedAt).toLocaleString() : '-'}
                    </td>
                    <td className="px-4 py-2 whitespace-nowrap">
                      <button onClick={() => openTab({ ...MASTER_LIST_TAB, type: 'master-detail', params: { masterId: c.masterId } })}
                        className="text-teal-500 hover:underline text-xs">상세 보기</button>
                    </td>
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
