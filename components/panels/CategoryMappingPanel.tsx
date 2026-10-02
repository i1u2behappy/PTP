'use client'
import { useEffect, useState, useCallback } from 'react'
import { ScrapeScopePicker, type ScrapeScope } from './shared/ScrapeScopePicker'
import { CoupangCategoryProfileEditor } from './shared/CoupangCategoryProfileEditor'

interface FieldValue { value: string; count: string }
interface Marketplace { code: string; name: string }
interface Mapping { master_category: string; marketplace_code: string; channel_category_value: string | null }
/** app/api/category-mappings/classify/route.ts의 CategoryClassifySuggestion과 같은 모양. */
interface ClassifySuggestion { raw: string; count: string; suggestion: { action: 'reuse' | 'new'; category: string } | null }

export function CategoryMappingPanel({ params }: { params?: Record<string, unknown> }) {
  const [scope, setScope] = useState<ScrapeScope>({ clientId: '', siteId: '', sessionId: '' })
  const [categories, setCategories] = useState<FieldValue[]>([])
  const [marketplaces, setMarketplaces] = useState<Marketplace[]>([])
  const [mappings, setMappings] = useState<Record<string, string>>({})
  const [search, setSearch] = useState('')
  const [coupangProfileTarget, setCoupangProfileTarget] = useState<string | null>(null)
  // "✨ AI로 분류 정리" — 원문 카테고리마다 기존에 이미 마켓 매핑까지 해둔 내부 카테고리 중 같은 뜻이
  // 있으면 재사용을, 없으면 새 이름을 제안받는다(PTP 마이그레이션 로드맵 §04). 제안을 받은 즉시 DB를
  // 바꾸지 않고, 이 화면에서 검토/수정한 뒤 "적용"을 눌러야만 기존 일괄변경(PUT /api/master/field-values)
  // 으로 반영한다 — "조용한 오매핑"을 피하려면 자동 적용이 아니라 사람 확인이 반드시 있어야 한다는
  // 이 프로젝트의 반복된 원칙.
  const [classifying, setClassifying] = useState(false)
  const [suggestions, setSuggestions] = useState<ClassifySuggestion[] | null>(null)
  const [suggestionEdits, setSuggestionEdits] = useState<Record<string, string>>({})
  const [applyingRaw, setApplyingRaw] = useState<string | null>(null)

  const load = useCallback(() => {
    if (scope.sessionId === '') { setCategories([]); return }
    fetch(`/api/master/field-values?field=master_category&sessionId=${scope.sessionId}`).then(r => r.json()).then((d: FieldValue[]) => setCategories(Array.isArray(d) ? d : [])).catch(() => {})
    fetch('/api/marketplace-configs').then(r => r.json()).then((d: Marketplace[]) => setMarketplaces(Array.isArray(d) ? d : [])).catch(() => {})
    fetch('/api/category-mappings').then(r => r.json()).then((d: Mapping[]) => {
      if (!Array.isArray(d)) return
      setMappings(Object.fromEntries(d.map(m => [`${m.master_category}::${m.marketplace_code}`, m.channel_category_value || ''])))
    }).catch(() => {})
  }, [scope.sessionId])

  /* eslint-disable-next-line react-hooks/set-state-in-effect */
  useEffect(() => { load() }, [load])

  async function saveCell(masterCategory: string, marketplaceCode: string, value: string) {
    setMappings(v => ({ ...v, [`${masterCategory}::${marketplaceCode}`]: value }))
    await fetch('/api/category-mappings', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ masterCategory, marketplaceCode, channelCategoryValue: value }),
    })
  }

  async function runClassify() {
    if (scope.sessionId === '') return
    setClassifying(true)
    try {
      const res = await fetch('/api/category-mappings/classify', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: scope.sessionId }),
      })
      const data = await res.json().catch(() => null) as ClassifySuggestion[] | null
      if (!Array.isArray(data)) { alert('분류 제안을 받아오지 못했습니다'); return }
      setSuggestions(data)
      setSuggestionEdits(Object.fromEntries(data.map(s => [s.raw, s.suggestion?.category ?? ''])))
    } finally {
      setClassifying(false)
    }
  }

  /** 원문(raw) 하나를 편집된 최종값으로 일괄 변경한다 — 기존 브랜드/원산지 일괄변경과 같은 엔드포인트를
   *  그대로 재사용한다(새 변경 로직을 따로 안 만듦). 성공하면 그 원문을 제안 목록에서 지우고 카테고리
   *  목록을 새로 불러온다. */
  async function applySuggestion(raw: string) {
    const to = (suggestionEdits[raw] ?? '').trim()
    if (!to || scope.sessionId === '') return
    setApplyingRaw(raw)
    try {
      await fetch('/api/master/field-values', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ field: 'master_category', sessionId: scope.sessionId, from: raw, to }),
      })
      setSuggestions(prev => (prev ? prev.filter(s => s.raw !== raw) : prev))
      load()
    } finally {
      setApplyingRaw(null)
    }
  }

  const q = search.trim().toLowerCase()
  const visibleCategories = q ? categories.filter(c => c.value.toLowerCase().includes(q)) : categories

  return (
    <div className="h-full flex flex-col">
      <div className="mb-6 shrink-0">
        <h1 className="text-2xl font-bold text-gray-800">🗺️ 카테고리 매핑</h1>
        <p className="text-xs text-gray-400 mt-1">상품마스터의 내부 카테고리를 마켓별로 어떤 카테고리 값으로 등록할지 매핑합니다. 비워두면 해당 마켓에는 매핑이 적용되지 않습니다.</p>
      </div>

      <ScrapeScopePicker initialSiteId={params?.siteId as number | undefined} initialSessionId={params?.sessionId as number | undefined} onScopeChange={setScope} />

      {scope.sessionId === '' ? null : (
        <>
          <div className="mb-4 shrink-0 flex items-center gap-2">
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="카테고리 검색..."
              className="w-full max-w-sm border border-gray-300 rounded-full px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-400" />
            <button onClick={runClassify} disabled={classifying || categories.length === 0}
              title="원문 카테고리마다 기존에 이미 마켓 매핑까지 해둔 내부 카테고리 중 같은 뜻이 있으면 재사용을, 없으면 새 이름을 제안합니다. 제안만 받을 뿐 DB는 바로 안 바뀝니다."
              className="shrink-0 px-4 py-2 rounded-full text-sm font-semibold bg-violet-50 text-violet-600 hover:bg-violet-100 disabled:opacity-50 disabled:cursor-not-allowed transition-colors">
              {classifying ? '분류 중...' : '✨ AI로 분류 정리'}
            </button>
          </div>

          {suggestions && suggestions.length > 0 && (
            <div className="mb-4 shrink-0 bg-violet-50 border border-violet-100 rounded-2xl p-4">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-semibold text-violet-700">✨ 분류 제안 ({suggestions.length}개) — 값을 확인/수정하고 &quot;적용&quot;을 눌러야 반영됩니다</span>
                <button onClick={() => setSuggestions(null)} className="text-xs text-gray-400 hover:text-gray-600">닫기</button>
              </div>
              <div className="max-h-64 overflow-y-auto space-y-1.5">
                {suggestions.map(s => (
                  <div key={s.raw} className="flex items-center gap-2 bg-white rounded-xl px-3 py-2 border border-violet-100">
                    <div className="flex-1 min-w-0 text-xs text-gray-500 truncate" title={s.raw}>{s.raw} <span className="text-gray-300">({s.count})</span></div>
                    <span className="text-gray-300">→</span>
                    {s.suggestion ? (
                      <>
                        <span className={`shrink-0 text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${
                          s.suggestion.action === 'reuse' ? 'bg-teal-50 text-teal-600' : 'bg-amber-50 text-amber-600'}`}>
                          {s.suggestion.action === 'reuse' ? '기존 재사용' : '신규'}
                        </span>
                        <input value={suggestionEdits[s.raw] ?? ''} onChange={e => setSuggestionEdits(v => ({ ...v, [s.raw]: e.target.value }))}
                          className="flex-1 min-w-0 border border-gray-200 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-teal-300" />
                        <button onClick={() => applySuggestion(s.raw)} disabled={applyingRaw === s.raw}
                          className="shrink-0 px-3 py-1 rounded-full text-xs font-semibold bg-teal-500 text-white hover:bg-teal-600 disabled:opacity-50">
                          {applyingRaw === s.raw ? '적용 중...' : '적용'}
                        </button>
                      </>
                    ) : (
                      <span className="text-xs text-rose-500">분류 실패</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {categories.length === 0 ? (
            <div className="bg-white rounded-2xl border border-gray-200 p-12 text-center text-gray-400">
              <div className="text-4xl mb-3">🗺️</div>
              <p className="text-sm">이 세션에서 병합된 상품마스터에 등록된 카테고리가 없습니다.</p>
            </div>
          ) : (
            <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden flex-1 min-h-0 flex flex-col">
              <div className="overflow-auto flex-1 min-h-0">
                <table className="text-sm border-collapse whitespace-nowrap">
                  <thead className="sticky top-0 z-10 bg-gray-50">
                    <tr className="border-b border-gray-200 text-xs font-semibold text-gray-500">
                      <th className="px-4 py-3 text-left sticky left-0 bg-gray-50 z-20">내부 카테고리</th>
                      {marketplaces.map(mc => <th key={mc.code} className="px-3 py-3 text-left">{mc.name}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {visibleCategories.map(cat => (
                      <tr key={cat.value} className="border-b border-gray-100 hover:bg-gray-50">
                        <td className="px-4 py-2 text-xs text-gray-700 sticky left-0 bg-white">{cat.value} <span className="text-gray-300">({cat.count})</span></td>
                        {marketplaces.map(mc => {
                          const key = `${cat.value}::${mc.code}`
                          const value = mappings[key] ?? ''
                          return (
                            <td key={mc.code} className="px-2 py-2">
                              <div className="flex items-center gap-1">
                                <input defaultValue={value} placeholder="미매핑"
                                  onBlur={e => e.target.value !== value && saveCell(cat.value, mc.code, e.target.value)}
                                  className="w-36 border border-gray-200 rounded px-1.5 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-teal-300" />
                                {mc.code === 'coupang' && value && (
                                  <button onClick={() => setCoupangProfileTarget(value)} title="옵션·고시정보 슬롯 매핑"
                                    className="text-xs text-gray-400 hover:text-teal-500 shrink-0">🎛️</button>
                                )}
                              </div>
                            </td>
                          )
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}

      {coupangProfileTarget && (
        <CoupangCategoryProfileEditor channelCategoryValue={coupangProfileTarget} onClose={() => setCoupangProfileTarget(null)} />
      )}
    </div>
  )
}
