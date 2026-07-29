'use client'
import { useEffect, useState, useCallback } from 'react'
import { ScrapeScopePicker, type ScrapeScope } from './shared/ScrapeScopePicker'

interface MasterRow { id: number; name_original: string; name_ai: string | null; name_final: string | null }
interface NamingTemplate { id: number; name: string; is_default: boolean }

export function ProductNamePanel({ params }: { params?: Record<string, unknown> }) {
  const [scope, setScope] = useState<ScrapeScope>({ clientId: '', siteId: '', sessionId: '' })
  const [rows, setRows] = useState<MasterRow[]>([])
  const [templates, setTemplates] = useState<NamingTemplate[]>([])
  const [templateId, setTemplateId] = useState<number | ''>('')
  const [search, setSearch] = useState('')
  const [aiLoading, setAiLoading] = useState<Set<number>>(new Set())
  const [bulkLoading, setBulkLoading] = useState(false)

  const load = useCallback(() => {
    const result = scope.sessionId === ''
      ? Promise.resolve([])
      : fetch(`/api/master?sessionId=${scope.sessionId}`).then(r => r.json())
    result.then((d: MasterRow[]) => setRows(Array.isArray(d) ? d : [])).catch(() => {})
  }, [scope.sessionId])

  useEffect(() => { load() }, [load])
  useEffect(() => {
    fetch('/api/naming-templates').then(r => r.json()).then((d: NamingTemplate[]) => {
      setTemplates(Array.isArray(d) ? d : [])
      const def = d.find(t => t.is_default)
      if (def) setTemplateId(def.id)
    }).catch(() => {})
  }, [])

  async function saveFinalName(id: number, value: string) {
    await fetch(`/api/master/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name_final: value }) })
  }

  async function genAiName(id: number) {
    setAiLoading(s => new Set(s).add(id))
    try {
      await fetch(`/api/master/${id}/ai-name`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(templateId ? { templateId } : {}),
      })
      await load()
    } finally {
      setAiLoading(s => { const n = new Set(s); n.delete(id); return n })
    }
  }

  async function genAllMissing() {
    setBulkLoading(true)
    try {
      for (const row of rows.filter(r => !r.name_ai)) await genAiName(row.id)
    } finally {
      setBulkLoading(false)
    }
  }

  const q = search.trim().toLowerCase()
  const visibleRows = q ? rows.filter(r => (r.name_final || r.name_ai || r.name_original || '').toLowerCase().includes(q)) : rows
  const missingCount = rows.filter(r => !r.name_ai).length

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center justify-between mb-6 shrink-0">
        <div>
          <h1 className="text-2xl font-bold text-gray-800">✏️ 상품명 관리</h1>
          <p className="text-xs text-gray-400 mt-1">원본 상품명을 AI로 등록용 상품명으로 변환하고, 최종 상품명을 확정합니다.</p>
        </div>
        <div className="flex items-center gap-2">
          <select value={templateId} onChange={e => setTemplateId(e.target.value ? Number(e.target.value) : '')}
            className="border border-gray-300 rounded-xl px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-teal-400">
            {templates.map(t => <option key={t.id} value={t.id}>{t.name}{t.is_default ? ' (기본)' : ''}</option>)}
          </select>
          <button onClick={genAllMissing} disabled={bulkLoading || missingCount === 0}
            className="px-4 py-2 bg-teal-500 text-white text-sm font-semibold rounded-full hover:bg-teal-600 disabled:opacity-50 transition-colors">
            {bulkLoading ? '생성 중...' : `미생성 전체 AI 생성 (${missingCount})`}
          </button>
        </div>
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
              <div className="text-4xl mb-3">✏️</div>
              <p className="text-sm">이 세션에 병합된 상품마스터가 없습니다.</p>
            </div>
          ) : (
            <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden flex-1 min-h-0 flex flex-col">
              <div className="overflow-y-auto flex-1 min-h-0">
                <table className="w-full text-sm border-collapse">
                  <thead className="sticky top-0 z-10 bg-gray-50">
                    <tr className="border-b border-gray-200 text-xs font-semibold text-gray-500">
                      <th className="px-4 py-3 text-left sticky left-0 z-20 bg-gray-50">원본 상품명</th>
                      <th className="px-4 py-3 text-left">AI 생성명</th>
                      <th className="px-4 py-3 text-left">최종 상품명</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleRows.map(row => (
                      <tr key={row.id} className="group border-b border-gray-100 hover:bg-gray-50">
                        <td className="px-4 py-2 text-xs text-gray-500 truncate max-w-[240px] sticky left-0 z-10 bg-white group-hover:bg-gray-50" title={row.name_original}>{row.name_original}</td>
                        <td className="px-4 py-2 text-xs">
                          <div className="flex items-center gap-1.5">
                            <span className="text-teal-600 truncate max-w-[200px]">{row.name_ai || '-'}</span>
                            <button onClick={() => genAiName(row.id)} disabled={aiLoading.has(row.id)}
                              className="text-[10px] text-teal-500 hover:text-teal-600 disabled:opacity-50 shrink-0">
                              {aiLoading.has(row.id) ? '...' : '✨재생성'}
                            </button>
                          </div>
                        </td>
                        <td className="px-4 py-2">
                          <input defaultValue={row.name_final || ''} placeholder={row.name_ai || row.name_original}
                            onBlur={e => e.target.value !== (row.name_final || '') && saveFinalName(row.id, e.target.value)}
                            className="w-full max-w-[260px] border border-gray-200 rounded px-1.5 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-teal-300" />
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
