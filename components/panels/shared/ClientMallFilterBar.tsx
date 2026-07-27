'use client'
import { useEffect, useState } from 'react'

interface Client { id: number; name: string }
interface Site { id: number; name: string | null; url: string; client_id: number | null }

export interface ClientMallFilterValue { clientId: number | ''; clientName: string; siteId: number | ''; search: string }

/** 거래처/Mall 관련 그리드 상단 공통 필터 바 — "스크래핑 설정"(ScraperPanel) 화면의 거래처▸몰 캐스케이딩
 *  드롭다운 + 검색 형태를 다른 그리드에도 그대로 쓰기 위해 뽑아낸 공용 컴포넌트. 조회 버튼 없이 값이
 *  바뀌는 즉시 onChange로 알린다(그 화면 스타일 그대로). 화면 성격에 따라 어느 드롭다운을 보여줄지는
 *  showClientFilter/showMallFilter로 끈다 — 예: Mall 관리 화면은 행 자체가 몰이라 몰 드롭다운은 의미가
 *  없어 거래처만, 거래처 관리 화면은 행 자체가 거래처라 둘 다 뺀다(스타일만 통일).
 */
export function ClientMallFilterBar({
  showClientFilter = true,
  showMallFilter = true,
  searchPlaceholder,
  onChange,
}: {
  showClientFilter?: boolean
  showMallFilter?: boolean
  searchPlaceholder: string
  onChange: (v: ClientMallFilterValue) => void
}) {
  const [clients, setClients] = useState<Client[]>([])
  const [sites, setSites] = useState<Site[]>([])
  const [clientId, setClientId] = useState<number | ''>('')
  const [siteId, setSiteId] = useState<number | ''>('')
  const [search, setSearch] = useState('')

  useEffect(() => {
    if (!showClientFilter && !showMallFilter) return
    fetch('/api/clients').then(r => r.json()).then((d: Client[]) => setClients(Array.isArray(d) ? d : [])).catch(() => {})
    if (showMallFilter) {
      fetch('/api/sites').then(r => r.json()).then((d: Site[]) => setSites(Array.isArray(d) ? d : [])).catch(() => {})
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 마운트 시 1회만
  }, [])

  useEffect(() => {
    onChange({ clientId, clientName: clients.find(c => c.id === clientId)?.name ?? '', siteId, search })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onChange는 매 렌더 새로 생성되는 콜백이라 의존성에서 제외
  }, [clientId, clients, siteId, search])

  const filteredSites = clientId === '' ? sites : sites.filter(s => s.client_id === clientId)

  return (
    <div className="bg-white rounded-2xl border border-gray-200 p-4 mb-3 flex flex-wrap items-center gap-3 shrink-0">
      {showClientFilter && (
        <label className="flex items-center gap-2 text-sm text-gray-600">
          거래처
          <select value={clientId} onChange={e => { setClientId(e.target.value ? Number(e.target.value) : ''); setSiteId('') }}
            className="border border-gray-300 rounded-xl px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-teal-400">
            <option value="">전체</option>
            {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
      )}
      {showMallFilter && (
        <label className="flex items-center gap-2 text-sm text-gray-600">
          몰
          <select value={siteId} onChange={e => setSiteId(e.target.value ? Number(e.target.value) : '')}
            className="border border-gray-300 rounded-xl px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-teal-400 min-w-[180px]">
            <option value="">전체</option>
            {filteredSites.map(s => <option key={s.id} value={s.id}>{s.name || s.url}</option>)}
          </select>
        </label>
      )}
      <input value={search} onChange={e => setSearch(e.target.value)} placeholder={searchPlaceholder}
        className="flex-1 min-w-[200px] border border-gray-300 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-400" />
    </div>
  )
}
