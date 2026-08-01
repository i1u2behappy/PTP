'use client'
import { useEffect, useState, useCallback, useMemo } from 'react'
import { ScrapeScopePicker, type ScrapeScope } from './shared/ScrapeScopePicker'
import { useRegisteredFieldKeys } from './shared/useRegisteredFieldKeys'

interface FieldValue { value: string; count: string }
type Field = 'brand' | 'manufacturer' | 'origin'

const ALL_FIELDS: Field[] = ['brand', 'manufacturer', 'origin']
const FIELD_LABELS: Record<Field, string> = { brand: '브랜드', manufacturer: '제조사', origin: '원산지' }

export function BrandOriginPanel({ params }: { params?: Record<string, unknown> }) {
  const [scope, setScope] = useState<ScrapeScope>({ clientId: '', siteId: '', sessionId: '' })
  const { keys: registeredKeys, loaded: registryLoaded } = useRegisteredFieldKeys()
  // 기준 Master 테이블에서 뺀 컬럼은 여기서도 탭이 사라진다 — 로딩 전엔 깜빡임 방지로 전체를 보여준다.
  const availableFields = useMemo(
    () => registryLoaded ? ALL_FIELDS.filter(f => registeredKeys.has(f)) : ALL_FIELDS,
    [registryLoaded, registeredKeys],
  )
  const [field, setField] = useState<Field>('brand')
  // 선택해둔 필드가 방금 기준 테이블에서 빠졌으면(예: 다른 탭에서 삭제) 조용히 첫 번째 사용 가능한 필드로 대체
  const effectiveField = availableFields.includes(field) ? field : (availableFields[0] ?? 'brand')
  const [values, setValues] = useState<FieldValue[]>([])
  const [search, setSearch] = useState('')
  const [editing, setEditing] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')

  const load = useCallback(() => {
    const result = scope.sessionId === ''
      ? Promise.resolve([])
      : fetch(`/api/master/field-values?field=${effectiveField}&sessionId=${scope.sessionId}`).then(r => r.json())
    result.then((d: FieldValue[]) => setValues(Array.isArray(d) ? d : [])).catch(() => {})
  }, [effectiveField, scope.sessionId])

  useEffect(() => { load() }, [load])

  function startEdit(value: string) {
    setEditing(value)
    setEditValue(value)
  }

  async function commitEdit() {
    if (editing == null) return
    if (editValue.trim() && editValue !== editing) {
      await fetch('/api/master/field-values', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: scope.sessionId, field: effectiveField, from: editing, to: editValue.trim() }),
      })
      load()
    }
    setEditing(null)
  }

  const q = search.trim().toLowerCase()
  const visibleValues = q ? values.filter(v => v.value.toLowerCase().includes(q)) : values

  return (
    <div className="h-full flex flex-col">
      <div className="mb-6 shrink-0">
        <h1 className="text-2xl font-bold text-gray-800">🏭 브랜드·제조사·원산지 관리</h1>
        <p className="text-xs text-gray-400 mt-1">스크랩된 값이 공백·표기 차이로 중복되는 경우, 값을 클릭해 수정하면 같은 값을 쓰는 모든 상품에 한꺼번에 반영됩니다.</p>
      </div>

      <ScrapeScopePicker initialSiteId={params?.siteId as number | undefined} initialSessionId={params?.sessionId as number | undefined} onScopeChange={setScope} />

      {scope.sessionId === '' ? null : (
        <>
          <div className="flex items-center gap-2 mb-4 shrink-0">
            {availableFields.map(f => (
              <button key={f} onClick={() => setField(f)}
                className={`px-4 py-1.5 text-sm font-semibold rounded-full transition-colors ${effectiveField === f ? 'bg-teal-500 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>
                {FIELD_LABELS[f]}
              </button>
            ))}
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="값 검색..."
              className="flex-1 max-w-xs border border-gray-300 rounded-full px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-teal-400" />
          </div>

          {availableFields.length === 0 ? (
            <div className="bg-white rounded-2xl border border-gray-200 p-12 text-center text-gray-400">
              <div className="text-4xl mb-3">🏭</div>
              <p className="text-sm">기준 Master 테이블에 브랜드·제조사·원산지 컬럼이 등록되어 있지 않습니다. 기준 Master 테이블 관리에서 먼저 추가해주세요.</p>
            </div>
          ) : values.length === 0 ? (
            <div className="bg-white rounded-2xl border border-gray-200 p-12 text-center text-gray-400">
              <div className="text-4xl mb-3">🏭</div>
              <p className="text-sm">이 세션에 등록된 {FIELD_LABELS[effectiveField]} 값이 없습니다.</p>
            </div>
          ) : (
            <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden flex-1 min-h-0 flex flex-col">
              <div className="overflow-y-auto flex-1 min-h-0">
                <table className="w-full text-sm border-collapse">
                  <thead className="sticky top-0 z-10 bg-gray-50">
                    <tr className="border-b border-gray-200 text-xs font-semibold text-gray-500">
                      <th className="px-4 py-3 text-left sticky left-0 z-20 bg-gray-50">{FIELD_LABELS[effectiveField]}</th>
                      <th className="px-4 py-3 text-left w-24">상품 수</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleValues.map(v => (
                      <tr key={v.value} className="group border-b border-gray-100 hover:bg-gray-50">
                        <td className="px-4 py-2 text-xs text-gray-700 cursor-pointer sticky left-0 z-10 bg-white group-hover:bg-gray-50" onClick={() => editing !== v.value && startEdit(v.value)}>
                          {editing === v.value ? (
                            <input autoFocus value={editValue} onChange={e => setEditValue(e.target.value)}
                              onBlur={commitEdit} onKeyDown={e => { if (e.key === 'Enter') commitEdit(); if (e.key === 'Escape') setEditing(null) }}
                              className="w-full border border-teal-300 rounded px-1.5 py-1 text-xs focus:outline-none" />
                          ) : v.value}
                        </td>
                        <td className="px-4 py-2 text-xs text-gray-400">{v.count}개</td>
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
