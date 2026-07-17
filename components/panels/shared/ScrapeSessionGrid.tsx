'use client'

interface SessionLike {
  id: number
  url: string
  found_count: number
  staged_count: number
  pending_count: number
  created_at: string
  client_name?: string | null
  site_name?: string | null
}

export function ScrapeSessionGrid<T extends SessionLike>({ sessions, selectedId, onSelect, onDelete, maxHeightClassName = 'max-h-52', showClientMall }: {
  sessions: T[]
  selectedId: number | ''
  onSelect: (id: number) => void
  onDelete?: (id: number) => void
  maxHeightClassName?: string
  /** 거래처/몰이 뒤섞여 나오는 조회(예: 데이터 마이그 목록의 전체 조회)에서만 거래처명/몰명 컬럼을 보여준다. */
  showClientMall?: boolean
}) {
  if (sessions.length === 0) return <p className="px-4 py-3 text-xs text-gray-400">검색 결과가 없습니다.</p>

  return (
    <div className={`${maxHeightClassName} overflow-y-auto`}>
      <table className="w-full text-xs border-collapse">
        {showClientMall && (
          <thead>
            <tr className="border-b border-gray-200 text-gray-500 font-semibold">
              <th className="px-4 py-2 text-left whitespace-nowrap">스크래핑 일시</th>
              <th className="px-4 py-2 text-left whitespace-nowrap">거래처</th>
              <th className="px-4 py-2 text-left whitespace-nowrap">몰</th>
              <th className="px-4 py-2 text-left">URL</th>
              <th className="px-4 py-2 text-left whitespace-nowrap">수집 현황</th>
              <th className="px-4 py-2 text-left whitespace-nowrap">상태</th>
              {onDelete && <th className="px-4 py-2 text-left whitespace-nowrap">관리</th>}
            </tr>
          </thead>
        )}
        <tbody>
          {sessions.map(s => {
            const confirmed = Number(s.staged_count) > 0 && Number(s.pending_count) === 0
            return (
              <tr key={s.id} onClick={() => onSelect(s.id)}
                className={`border-b border-gray-100 last:border-0 cursor-pointer transition-colors ${
                  s.id === selectedId ? 'bg-teal-50' : 'hover:bg-gray-50'}`}>
                <td className="px-4 py-2 text-gray-400 whitespace-nowrap">{new Date(s.created_at).toLocaleString()}</td>
                {showClientMall && (
                  <>
                    <td className="px-4 py-2 text-gray-700 whitespace-nowrap">{s.client_name || '-'}</td>
                    <td className="px-4 py-2 text-gray-700 whitespace-nowrap">{s.site_name || '-'}</td>
                  </>
                )}
                <td className="px-4 py-2 text-gray-500 max-w-[320px] truncate" title={s.url}>{s.url}</td>
                <td className="px-4 py-2 text-gray-400 whitespace-nowrap">발견 {s.found_count} / 수집 {s.staged_count}</td>
                <td className={`px-4 py-2 font-medium whitespace-nowrap ${confirmed ? 'text-emerald-600' : 'text-amber-600'}`}>
                  {confirmed ? '✓ 마이그레이션 완료' : `⚠ 미확정 ${s.pending_count}개`}
                </td>
                {onDelete && (
                  <td className="px-4 py-2 whitespace-nowrap">
                    <button onClick={e => { e.stopPropagation(); onDelete(s.id) }} className="text-rose-500 hover:underline">삭제</button>
                  </td>
                )}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
