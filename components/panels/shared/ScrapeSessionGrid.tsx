'use client'

interface SessionLike {
  id: number
  url: string
  found_count: number
  staged_count: number
  pending_count: number
  created_at: string
}

export function ScrapeSessionGrid<T extends SessionLike>({ sessions, selectedId, onSelect, onDelete, maxHeightClassName = 'max-h-52' }: {
  sessions: T[]
  selectedId: number | ''
  onSelect: (id: number) => void
  onDelete?: (id: number) => void
  maxHeightClassName?: string
}) {
  if (sessions.length === 0) return <p className="px-4 py-3 text-xs text-gray-400">검색 결과가 없습니다.</p>

  return (
    <div className={`${maxHeightClassName} overflow-y-auto`}>
      <table className="w-full text-xs border-collapse">
        <tbody>
          {sessions.map(s => {
            const confirmed = Number(s.staged_count) > 0 && Number(s.pending_count) === 0
            return (
              <tr key={s.id} onClick={() => onSelect(s.id)}
                className={`border-b border-gray-100 last:border-0 cursor-pointer transition-colors ${
                  s.id === selectedId ? 'bg-teal-50' : 'hover:bg-gray-50'}`}>
                <td className="px-4 py-2 text-gray-400 whitespace-nowrap">{new Date(s.created_at).toLocaleString()}</td>
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
