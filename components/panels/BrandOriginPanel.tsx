'use client'
import { useEffect, useState, useCallback, useMemo } from 'react'
import { ScrapeScopePicker, type ScrapeScope } from './shared/ScrapeScopePicker'
import { useRegisteredFieldKeys } from './shared/useRegisteredFieldKeys'

interface FieldValue { value: string; count: string }
type Field = 'brand' | 'manufacturer' | 'origin'
/** app/api/master/field-values/merge-suggest/route.ts의 ValueMergeGroup과 같은 모양. */
interface MergeGroup { canonical: string; variants: string[] }

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
  // "✨ AI로 중복값 정리" — CategoryMappingPanel의 분류 제안과 같은 원칙(제안만 받고 사람이 "적용"해야
  // 반영)이지만, 여기는 "기존 기준값에 맞추기"가 아니라 "현재 목록 안에서 서로 같은 걸 찾아 묶기"라
  // 제안 하나가 값 여러 개(variants)를 대표값(canonical) 하나로 한꺼번에 합친다.
  const [merging, setMerging] = useState(false)
  const [mergeGroups, setMergeGroups] = useState<MergeGroup[] | null>(null)
  const [applyingGroup, setApplyingGroup] = useState<number | null>(null)

  const load = useCallback(() => {
    const result = scope.sessionId === ''
      ? Promise.resolve([])
      : fetch(`/api/master/field-values?field=${effectiveField}&sessionId=${scope.sessionId}`).then(r => r.json())
    result.then((d: FieldValue[]) => setValues(Array.isArray(d) ? d : [])).catch(() => {})
  }, [effectiveField, scope.sessionId])

  useEffect(() => { load() }, [load])
  // 필드를 바꾸면 이전 필드의 제안이 그대로 남아 엉뚱한 필드에 적용되는 사고를 막기 위해 비운다.
  /* eslint-disable-next-line react-hooks/set-state-in-effect */
  useEffect(() => { setMergeGroups(null) }, [effectiveField])

  async function runMerge() {
    if (scope.sessionId === '') return
    setMerging(true)
    try {
      const res = await fetch('/api/master/field-values/merge-suggest', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ field: effectiveField, sessionId: scope.sessionId }),
      })
      const data = await res.json().catch(() => null) as MergeGroup[] | null
      if (!Array.isArray(data)) { alert('중복값 제안을 받아오지 못했습니다'); return }
      if (data.length === 0) { alert('묶을 만한 중복 표기를 찾지 못했습니다'); return }
      setMergeGroups(data)
    } finally {
      setMerging(false)
    }
  }

  function editGroupCanonical(idx: number, canonical: string) {
    setMergeGroups(prev => (prev ? prev.map((g, i) => (i === idx ? { ...g, canonical } : g)) : prev))
  }

  /** 그룹 하나를 적용한다 — canonical 자신을 뺀 나머지 variants 전부를 편집된 대표값으로 일괄 변경한다.
   *  기존 브랜드/원산지 일괄변경(PUT /api/master/field-values)을 variants 개수만큼 반복 호출한다. */
  async function applyMergeGroup(idx: number) {
    const group = mergeGroups?.[idx]
    const to = group?.canonical.trim()
    if (!group || !to || scope.sessionId === '') return
    setApplyingGroup(idx)
    try {
      const froms = group.variants.filter(v => v !== to)
      await Promise.all(froms.map(from => fetch('/api/master/field-values', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ field: effectiveField, sessionId: scope.sessionId, from, to }),
      })))
      setMergeGroups(prev => (prev ? prev.filter((_, i) => i !== idx) : prev))
      load()
    } finally {
      setApplyingGroup(null)
    }
  }

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
            <button onClick={runMerge} disabled={merging || values.length === 0}
              title="같은 실제 대상을 표기만 다르게 쓴 값들(공백 차이, (주)/주식회사 접두어 등)을 찾아 묶을 대표값을 제안합니다. 제안만 받을 뿐 DB는 바로 안 바뀝니다."
              className="shrink-0 px-4 py-1.5 rounded-full text-sm font-semibold bg-violet-50 text-violet-600 hover:bg-violet-100 disabled:opacity-50 disabled:cursor-not-allowed transition-colors">
              {merging ? '분석 중...' : '✨ AI로 중복값 정리'}
            </button>
          </div>

          {mergeGroups && mergeGroups.length > 0 && (
            <div className="mb-4 shrink-0 bg-violet-50 border border-violet-100 rounded-2xl p-4">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-semibold text-violet-700">✨ 중복값 제안 ({mergeGroups.length}개) — 대표값을 확인/수정하고 &quot;적용&quot;을 눌러야 반영됩니다</span>
                <button onClick={() => setMergeGroups(null)} className="text-xs text-gray-400 hover:text-gray-600">닫기</button>
              </div>
              <div className="max-h-64 overflow-y-auto space-y-1.5">
                {mergeGroups.map((g, idx) => (
                  <div key={g.variants.join('|')} className="flex items-center gap-2 bg-white rounded-xl px-3 py-2 border border-violet-100">
                    <div className="flex-1 min-w-0 text-xs text-gray-500 truncate" title={g.variants.join(', ')}>{g.variants.join(', ')}</div>
                    <span className="text-gray-300">→</span>
                    <input value={g.canonical} onChange={e => editGroupCanonical(idx, e.target.value)}
                      className="flex-1 min-w-0 border border-gray-200 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-teal-300" />
                    <button onClick={() => applyMergeGroup(idx)} disabled={applyingGroup === idx}
                      className="shrink-0 px-3 py-1 rounded-full text-xs font-semibold bg-teal-500 text-white hover:bg-teal-600 disabled:opacity-50">
                      {applyingGroup === idx ? '적용 중...' : '적용'}
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {availableFields.length === 0 ? (
            <div className="bg-white rounded-2xl border border-gray-200 p-12 text-center text-gray-400">
              <div className="text-4xl mb-3">🏭</div>
              <p className="text-sm">기준 Master 테이블에 브랜드·제조사·원산지 컬럼이 등록되어 있지 않습니다. 기준 마스터테이블 관리에서 먼저 추가해주세요.</p>
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
