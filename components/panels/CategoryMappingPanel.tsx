'use client'
import { useEffect, useState, useCallback } from 'react'
import { ScrapeScopePicker, type ScrapeScope } from './shared/ScrapeScopePicker'

interface FieldValue { value: string; count: string }
interface Marketplace { code: string; name: string }
interface Mapping { master_category: string; marketplace_code: string; channel_category_value: string | null }

export function CategoryMappingPanel({ params }: { params?: Record<string, unknown> }) {
  const [scope, setScope] = useState<ScrapeScope>({ clientId: '', siteId: '', sessionId: '' })
  const [categories, setCategories] = useState<FieldValue[]>([])
  const [marketplaces, setMarketplaces] = useState<Marketplace[]>([])
  const [mappings, setMappings] = useState<Record<string, string>>({})
  const [search, setSearch] = useState('')

  const load = useCallback(() => {
    if (scope.sessionId === '') { setCategories([]); return }
    fetch(`/api/master/field-values?field=master_category&sessionId=${scope.sessionId}`).then(r => r.json()).then((d: FieldValue[]) => setCategories(Array.isArray(d) ? d : [])).catch(() => {})
    fetch('/api/marketplace-configs').then(r => r.json()).then((d: Marketplace[]) => setMarketplaces(Array.isArray(d) ? d : [])).catch(() => {})
    fetch('/api/category-mappings').then(r => r.json()).then((d: Mapping[]) => {
      if (!Array.isArray(d)) return
      setMappings(Object.fromEntries(d.map(m => [`${m.master_category}::${m.marketplace_code}`, m.channel_category_value || ''])))
    }).catch(() => {})
  }, [scope.sessionId])

  useEffect(() => { load() }, [load])

  async function saveCell(masterCategory: string, marketplaceCode: string, value: string) {
    setMappings(v => ({ ...v, [`${masterCategory}::${marketplaceCode}`]: value }))
    await fetch('/api/category-mappings', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ masterCategory, marketplaceCode, channelCategoryValue: value }),
    })
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
          <div className="mb-4 shrink-0">
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="카테고리 검색..."
              className="w-full max-w-sm border border-gray-300 rounded-full px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-400" />
          </div>

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
                          return (
                            <td key={mc.code} className="px-2 py-2">
                              <input defaultValue={mappings[key] ?? ''} placeholder="미매핑"
                                onBlur={e => e.target.value !== (mappings[key] ?? '') && saveCell(cat.value, mc.code, e.target.value)}
                                className="w-36 border border-gray-200 rounded px-1.5 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-teal-300" />
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
    </div>
  )
}
