'use client'
import { useEffect, useState, useCallback } from 'react'
import { useTabs } from '../shell/TabsContext'

interface Site { id: number; name: string | null; url: string }

interface SessionSummary {
  id: number
  url: string
  site_id: number
  session_status: string
  scope_type: string
  mode: string
  created_at: string
  pending_count: string
  merged_count: string
  skipped_count: string
}

interface StagingItem {
  id: number
  mall_product_code: string
  mall_category: string | null
  name_original: string
  price: number | null
  sale_price: number | null
  brand: string
  thumbnail_url: string
  stock_status: string | null
  stock_qty: number | null
  is_new: boolean
  is_already_migrated: boolean
  changedFields: string[]
}

const FIELD_LABELS: Record<string, string> = {
  name_original: '상품명', price: '정상가', sale_price: '판매가',
  mall_category: '카테고리', brand: '브랜드', stock_status: '재고상태', stock_qty: '재고수량',
}

export function StagingReviewPanel() {
  const { openTab, bumpRefresh, refreshSignals } = useTabs()
  const [sites, setSites] = useState<Site[]>([])
  const [siteId, setSiteId] = useState<number | ''>('')
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [sessionId, setSessionId] = useState<number | ''>('')
  const [items, setItems] = useState<StagingItem[]>([])
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [includeMigrated, setIncludeMigrated] = useState(false)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    fetch('/api/sites').then(r => r.json()).then((d: Site[]) => {
      if (!Array.isArray(d)) return
      setSites(d)
      setSiteId(current => current === '' && d.length ? d[0].id : current)
    }).catch(() => {})
  }, [])

  const loadSessions = useCallback((sid: number) => {
    fetch(`/api/scrape-staging/sessions?siteId=${sid}`).then(r => r.json()).then((d: SessionSummary[]) => {
      if (!Array.isArray(d)) return
      setSessions(d)
      const firstPending = d.find(s => Number(s.pending_count) > 0)
      const next = firstPending || d[0]
      setSessionId(next ? next.id : '')
      if (!next) { setItems([]); setLoading(false) }
    }).catch(() => {})
  }, [])

  useEffect(() => { if (siteId !== '') loadSessions(siteId) }, [siteId, loadSessions, refreshSignals.staging])

  const loadItems = useCallback(() => {
    fetch(`/api/scrape-staging?sessionId=${sessionId}&status=pending`).then(r => r.json()).then((d: StagingItem[]) => {
      setItems(Array.isArray(d) ? d : [])
      setSelected(new Set())
    }).finally(() => setLoading(false))
  }, [sessionId])

  useEffect(() => { if (sessionId !== '') loadItems() }, [sessionId, loadItems])

  function toggleSelect(id: number, disabled: boolean) {
    if (disabled) return
    setSelected(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n })
  }
  const selectableItems = items.filter(i => includeMigrated || !i.is_already_migrated)
  function selectAll() {
    setSelected(selected.size === selectableItems.length ? new Set() : new Set(selectableItems.map(i => i.id)))
  }

  async function handleMerge() {
    if (!selected.size) return
    setBusy(true)
    try {
      const ids = [...selected]
      const res = await fetch('/api/scrape-staging/merge', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids, force: includeMigrated }),
      })
      const d = await res.json() as { merged: number[]; skipped: { id: number; reason: string }[] }
      if (d.skipped?.length) {
        alert(`${d.skipped.length}개는 이미 가공된 상품이라 병합되지 않았습니다. "이미 가공된 상품도 포함"을 켜고 다시 시도하세요.`)
      }
      bumpRefresh('products')
      bumpRefresh('staging')
      loadItems()
      loadSessions(siteId as number)
    } finally {
      setBusy(false)
    }
  }

  async function handleDiscard() {
    if (!selected.size || !confirm(`선택한 ${selected.size}개 항목을 무시할까요? (원본 데이터에는 영향 없음)`)) return
    setBusy(true)
    try {
      await Promise.all([...selected].map(id => fetch(`/api/scrape-staging/${id}`, { method: 'DELETE' })))
      loadItems()
      loadSessions(siteId as number)
    } finally {
      setBusy(false)
    }
  }

  async function saveName(id: number, value: string) {
    await fetch(`/api/scrape-staging/${id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name_original: value }),
    })
  }

  return (
    <div>
      <div className="mb-6">
        <button onClick={() => openTab({ id: 'scraper', type: 'scraper', title: '스크래핑', icon: '🔍', closable: true })}
          className="block text-sm text-gray-500 hover:text-gray-700 hover:underline mb-2">
          ← 스크래핑으로 돌아가기
        </button>
        <h1 className="text-2xl font-bold text-gray-800">🔎 스크랩 검토</h1>
        <p className="text-xs text-gray-400 mt-1">스크랩 결과는 여기서 검토 후 병합해야 수집 확인 목록에 반영됩니다. 이미 상품마스터로 가공된 상품은 기본적으로 덮어쓰지 않습니다.</p>
      </div>

      <div className="bg-white rounded-2xl border border-gray-200 p-4 mb-4 flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-sm text-gray-600">
          몰
          <select value={siteId} onChange={e => setSiteId(Number(e.target.value))}
            className="border border-gray-300 rounded-xl px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-teal-400">
            {sites.map(s => <option key={s.id} value={s.id}>{s.name || s.url}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-2 text-sm text-gray-600">
          세션
          <select value={sessionId} onChange={e => setSessionId(Number(e.target.value))}
            className="border border-gray-300 rounded-xl px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-teal-400 max-w-xs">
            {sessions.map(s => (
              <option key={s.id} value={s.id}>
                {new Date(s.created_at).toLocaleString()} · 대기 {s.pending_count} / 병합 {s.merged_count} / 무시 {s.skipped_count}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 text-sm text-gray-600 ml-auto">
          <input type="checkbox" checked={includeMigrated} onChange={e => setIncludeMigrated(e.target.checked)} />
          이미 가공된 상품도 포함
        </label>
      </div>

      {loading ? (
        <div className="bg-white rounded-2xl border border-gray-200 p-12 text-center text-gray-400 text-sm">불러오는 중...</div>
      ) : items.length === 0 ? (
        <div className="bg-white rounded-2xl border border-gray-200 p-12 text-center text-gray-400">
          <div className="text-4xl mb-3">📭</div>
          <p className="text-sm">이 세션에 검토 대기 중인 스크랩 결과가 없습니다.</p>
        </div>
      ) : (
        <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 bg-gray-50">
            <label className="flex items-center gap-2 text-xs text-gray-600 cursor-pointer">
              <input type="checkbox" checked={selected.size === selectableItems.length && selectableItems.length > 0} onChange={selectAll} />
              전체 선택 ({selectableItems.length}개 선택 가능)
            </label>
            <div className="flex gap-2">
              <button onClick={handleDiscard} disabled={!selected.size || busy}
                className="px-4 py-1.5 bg-rose-50 text-rose-600 text-xs font-semibold rounded-full hover:bg-rose-100 disabled:opacity-40 transition-colors">
                선택 무시 ({selected.size})
              </button>
              <button onClick={handleMerge} disabled={!selected.size || busy}
                className="px-4 py-1.5 bg-teal-500 text-white text-xs font-semibold rounded-full hover:bg-teal-600 disabled:opacity-40 transition-colors">
                {busy ? '처리 중...' : `선택 병합 (${selected.size})`}
              </button>
            </div>
          </div>
          <div className="overflow-auto max-h-[65vh]">
            <table className="w-full text-sm border-collapse">
              <thead className="sticky top-0 z-10 bg-gray-50">
                <tr className="border-b border-gray-200 text-xs font-semibold text-gray-500">
                  <th className="w-10 px-4 py-3"></th>
                  <th className="w-16 px-2 py-3 text-left">이미지</th>
                  <th className="px-2 py-3 text-left">상품명</th>
                  <th className="w-24 px-2 py-3 text-left">판매가</th>
                  <th className="w-32 px-2 py-3 text-left">카테고리</th>
                  <th className="w-24 px-2 py-3 text-left">상태</th>
                  <th className="px-2 py-3 text-left">비고</th>
                </tr>
              </thead>
              <tbody>
                {items.map(item => {
                  const disabled = item.is_already_migrated && !includeMigrated
                  const statusLabel = item.is_new ? { text: '신규', cls: 'text-teal-600' }
                    : item.changedFields.length ? { text: '변경됨', cls: 'text-amber-600' }
                    : { text: '동일', cls: 'text-gray-400' }
                  return (
                    <tr key={item.id} className={`border-b border-gray-100 ${disabled ? 'opacity-50' : 'hover:bg-gray-50'}`}>
                      <td className="px-4 py-2">
                        <input type="checkbox" checked={selected.has(item.id)} disabled={disabled} onChange={() => toggleSelect(item.id, disabled)} />
                      </td>
                      <td className="px-2 py-2">
                        <div className="w-10 h-10 rounded-lg overflow-hidden bg-gray-100">
                          {item.thumbnail_url && (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={item.thumbnail_url} alt="" className="w-full h-full object-cover" />
                          )}
                        </div>
                      </td>
                      <td className="px-2 py-2">
                        <input defaultValue={item.name_original} onBlur={e => e.target.value !== item.name_original && saveName(item.id, e.target.value)}
                          disabled={disabled}
                          className="w-full border border-transparent hover:border-gray-200 focus:border-teal-300 rounded px-1.5 py-1 text-xs focus:outline-none" />
                      </td>
                      <td className="px-2 py-2 text-xs text-gray-700">{item.sale_price ? `₩${item.sale_price.toLocaleString()}` : item.price ? `₩${item.price.toLocaleString()}` : '-'}</td>
                      <td className="px-2 py-2 text-xs text-gray-500 truncate max-w-[128px]" title={item.mall_category || ''}>{item.mall_category || '-'}</td>
                      <td className={`px-2 py-2 text-xs font-medium ${statusLabel.cls}`} title={item.changedFields.map(f => FIELD_LABELS[f] || f).join(', ')}>
                        {statusLabel.text}
                      </td>
                      <td className="px-2 py-2 text-xs">
                        {item.is_already_migrated && <span className="text-amber-600">⚠ 이미 가공됨</span>}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
