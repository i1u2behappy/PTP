'use client'
import { useEffect, useState, useCallback } from 'react'
import { ScrapeScopePicker, type ScrapeScope } from './shared/ScrapeScopePicker'

interface OptionGroup { name: string; values: string[] }
interface MasterRow { id: number; name_original: string; name_ai: string | null; name_final: string | null; options: OptionGroup[] | null }

function optionsToText(groups: OptionGroup[]): string {
  return groups.map(g => `${g.name}: ${g.values.join(', ')}`).join('\n')
}

function textToOptions(text: string): OptionGroup[] {
  return text.split('\n').map(line => line.trim()).filter(Boolean).map(line => {
    const [name, valuesPart] = line.split(':')
    return { name: (name || '').trim(), values: (valuesPart || '').split(',').map(v => v.trim()).filter(Boolean) }
  }).filter(g => g.name)
}

export function OptionManagementPanel({ params }: { params?: Record<string, unknown> }) {
  const [scope, setScope] = useState<ScrapeScope>({ clientId: '', siteId: '', sessionId: '' })
  const [rows, setRows] = useState<MasterRow[]>([])
  const [search, setSearch] = useState('')
  const [drafts, setDrafts] = useState<Record<number, string>>({})
  const [saving, setSaving] = useState<Set<number>>(new Set())

  const load = useCallback(() => {
    if (scope.sessionId === '') { setRows([]); return }
    fetch(`/api/master?sessionId=${scope.sessionId}`).then(r => r.json()).then((d: MasterRow[]) => {
      if (!Array.isArray(d)) return
      setRows(d)
      setDrafts(Object.fromEntries(d.map(r => [r.id, optionsToText(r.options || [])])))
    }).catch(() => {})
  }, [scope.sessionId])

  useEffect(() => { load() }, [load])

  async function save(id: number) {
    setSaving(s => new Set(s).add(id))
    try {
      const options = textToOptions(drafts[id] || '')
      await fetch(`/api/master/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ options }) })
    } finally {
      setSaving(s => { const n = new Set(s); n.delete(id); return n })
    }
  }

  const q = search.trim().toLowerCase()
  const visibleRows = q ? rows.filter(r => (r.name_final || r.name_ai || r.name_original || '').toLowerCase().includes(q)) : rows

  return (
    <div className="h-full flex flex-col">
      <div className="mb-6 shrink-0">
        <h1 className="text-2xl font-bold text-gray-800">🎛️ 옵션 관리</h1>
        <p className="text-xs text-gray-400 mt-1">상품별 옵션(색상/사이즈 등)을 확인하고 수정합니다. 한 줄에 &quot;옵션명: 값1, 값2&quot; 형식으로 입력하세요.</p>
      </div>

      <ScrapeScopePicker initialSiteId={params?.siteId as number | undefined} initialSessionId={params?.sessionId as number | undefined} onScopeChange={setScope} />

      {scope.sessionId === '' ? null : (
        <>
          <div className="mb-4 shrink-0">
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="상품명 검색..."
              className="w-full max-w-sm border border-gray-300 rounded-full px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-400" />
          </div>

          {rows.length === 0 ? (
            <div className="bg-white rounded-2xl border border-gray-200 p-12 text-center text-gray-400">
              <div className="text-4xl mb-3">🎛️</div>
              <p className="text-sm">이 세션에 병합된 상품마스터가 없습니다.</p>
            </div>
          ) : (
            <div className="flex-1 min-h-0 overflow-y-auto space-y-3">
              {visibleRows.map(row => (
                <div key={row.id} className="bg-white rounded-2xl border border-gray-200 p-4">
                  <div className="flex items-start justify-between gap-3 mb-2">
                    <p className="text-sm font-semibold text-gray-700 truncate">{row.name_final || row.name_ai || row.name_original}</p>
                    <button onClick={() => save(row.id)} disabled={saving.has(row.id)}
                      className="px-3 py-1 bg-teal-500 hover:bg-teal-600 text-white text-xs font-semibold rounded-full disabled:opacity-50 transition-colors shrink-0">
                      {saving.has(row.id) ? '저장 중...' : '저장'}
                    </button>
                  </div>
                  <textarea value={drafts[row.id] ?? ''} onChange={e => setDrafts(v => ({ ...v, [row.id]: e.target.value }))}
                    placeholder="예) 색상: 빨강, 파랑, 검정&#10;사이즈: S, M, L" rows={3}
                    className="w-full border border-gray-200 rounded-xl px-3 py-2 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-teal-400" />
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}
