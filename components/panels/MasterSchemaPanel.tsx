'use client'
import { useEffect, useRef, useState } from 'react'
import { useTabs } from '../shell/TabsContext'
import { useCurrentUser } from '../shell/CurrentUserContext'
import { FIXED_FIELD_INFO } from '../../lib/master/schema'

interface SchemaField { field_key: string; field_label: string; is_custom: boolean }

const fixedInfoByKey = new Map(FIXED_FIELD_INFO.map(f => [f.key, f]))
/** 커스텀 필드는 스크래핑 원본에 대응 컬럼이 있을 수 없다(정의상 새로 만든 값) — 고정 필드만
 *  FIXED_FIELD_INFO.mallSource로 스크래핑 자동 매칭 여부를 판정한다. */
function matchInfo(f: SchemaField): { matched: boolean; label: string } {
  if (f.is_custom) return { matched: false, label: '커스텀 · 직접 입력 필요' }
  const info = fixedInfoByKey.get(f.field_key)
  return info?.mallSource
    ? { matched: true, label: `자동 매칭 · mall_products.${info.mallSource}` }
    : { matched: false, label: '스크래핑에 없음 · 직접 입력 필요' }
}

/**
 * 마이그레이션 하위 메뉴 첫 번째 — "기준 Master 테이블"의 컬럼 구성을 등록·편집한다. 거래처별로 따로
 * 가져가지 않는 시스템 전체 단일 기준 테이블이다(master_schema_fields, 거래처 구분 없음).
 * 기준(product_master) 고정 컬럼 중 스크래핑 원본(mall_products)에 그대로 대응되는 건 자동 매칭 배지로,
 * 대응이 없는 건("직접 입력 필요") 후속 절차(Transform/연속관리 등)에서 채워야 함을 한눈에 보여준다.
 * 컬럼별 실제 마이그레이션 방식(AI 생성/값 매핑/그대로 복사/합성)은 몰마다 원본 데이터가 달라
 * 마이그레이션2_Transform에서 몰을 고른 뒤 설정한다 — 여기서는 스키마(컬럼 목록) 자체만 관리한다.
 */
export function MasterSchemaPanel() {
  const { openTab } = useTabs()
  const { isAdmin } = useCurrentUser()
  const [fields, setFields] = useState<SchemaField[]>([])
  const [dragKey, setDragKey] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const lastRowRef = useRef<HTMLTableRowElement | null>(null)
  const pendingScroll = useRef(false)

  // 방금 추가한 커스텀 필드가 목록 맨 아래로 들어가면 안 보일 수 있어, 렌더된 직후 그 행으로 스크롤한다.
  useEffect(() => {
    if (pendingScroll.current && lastRowRef.current) {
      lastRowRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' })
      pendingScroll.current = false
    }
  }, [fields])

  useEffect(() => {
    fetch('/api/master/schema').then(r => r.json()).then((d: SchemaField[]) => setFields(Array.isArray(d) ? d : [])).catch(() => {})
  }, [])

  function updateField(i: number, patch: Partial<SchemaField>) {
    setFields(prev => prev.map((f, idx) => idx === i ? { ...f, ...patch } : f))
  }
  function removeField(i: number) {
    setFields(prev => prev.filter((_, idx) => idx !== i))
  }
  function handleDrop(targetKey: string) {
    if (!dragKey || dragKey === targetKey) return
    setFields(prev => {
      const dragIdx = prev.findIndex(f => f.field_key === dragKey)
      const targetIdx = prev.findIndex(f => f.field_key === targetKey)
      if (dragIdx === -1 || targetIdx === -1) return prev
      const next = [...prev]
      const [moved] = next.splice(dragIdx, 1)
      next.splice(targetIdx, 0, moved)
      return next
    })
    setDragKey(null)
  }
  function addCustomField() {
    setFields(prev => [...prev, { field_key: `custom_${prev.length + 1}`, field_label: '', is_custom: true }])
    pendingScroll.current = true
  }
  function addAllFixedFields() {
    const existingKeys = new Set(fields.map(f => f.field_key))
    const toAdd = FIXED_FIELD_INFO.filter(f => !existingKeys.has(f.key))
      .map(f => ({ field_key: f.key, field_label: f.label, is_custom: false }))
    setFields(prev => [...prev, ...toAdd])
  }

  async function saveFields() {
    setSaving(true)
    try {
      await fetch('/api/master/schema', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields }),
      })
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } finally {
      setSaving(false)
    }
  }

  function goToTransform() {
    openTab({ id: 'transform', type: 'transform', title: '마이그레이션2_Transform', icon: '🧬', closable: true })
  }

  // Sidebar에서 메뉴 자체를 admin에게만 보여주지만, 이미 열려 있던 탭으로 남아있을 수 있어 한 번 더 막는다
  // (실제 저장 차단은 /api/master/schema PUT이 서버에서 한다).
  if (!isAdmin) {
    return (
      <div className="bg-white rounded-2xl border border-gray-200 p-12 text-center text-gray-400">
        <div className="text-4xl mb-3">🔒</div>
        <p className="text-sm">관리자만 접근할 수 있는 메뉴입니다.</p>
      </div>
    )
  }

  return (
    <div className="h-full max-w-4xl flex flex-col">
      <div className="mb-6 shrink-0">
        <h1 className="text-2xl font-bold text-gray-800">🧱 기준 Master 테이블 관리</h1>
        <p className="text-xs text-gray-400 mt-1">
          거래처 구분 없이 시스템 전체가 공유하는 단일 &quot;기준 Master DB&quot; 컬럼 구성을 여기서 등록·편집합니다.
          각 컬럼이 스크래핑 원본에서 자동으로 채워지는지, 아니면 후속 절차(Transform 등)로 직접 채워야 하는지
          매칭 배지로 바로 확인할 수 있습니다.
        </p>
      </div>

      <div className="bg-white rounded-2xl border border-gray-200 p-6 flex-1 min-h-0 flex flex-col">
        <div className="flex flex-wrap items-center gap-2 mb-4 shrink-0">
          <button onClick={addAllFixedFields}
            className="px-3 py-1.5 bg-teal-50 hover:bg-teal-100 text-teal-700 text-xs font-semibold rounded-full transition-colors">
            📋 기본 컬럼 전체 추가
          </button>
          <button onClick={addCustomField} className="px-3 py-1.5 bg-gray-100 hover:bg-gray-200 text-gray-600 text-xs font-semibold rounded-full transition-colors">
            ➕ 커스텀 필드 추가
          </button>
          <button onClick={saveFields} disabled={saving}
            className="ml-auto px-4 py-1.5 bg-teal-500 hover:bg-teal-600 text-white text-xs font-semibold rounded-full disabled:opacity-50 transition-colors">
            {saving ? '저장 중...' : saved ? '✓ 저장됨' : '필드 목록 저장'}
          </button>
        </div>

        {fields.length === 0 ? (
          <p className="text-xs text-gray-400 mb-3">등록된 필드가 없습니다. 위 버튼으로 기본 컬럼을 채우거나 커스텀 필드를 추가해보세요.</p>
        ) : (
          <div className="border border-gray-100 rounded-xl overflow-hidden mb-3 flex-1 min-h-0 flex flex-col">
            <p className="text-[11px] text-gray-400 bg-gray-50 px-3 py-1.5 border-b border-gray-100 shrink-0">⠿ 아이콘을 드래그하면 필드 순서를 바꿀 수 있습니다.</p>
            <div className="overflow-auto flex-1 min-h-0">
              <table className="w-full text-xs border-collapse">
                <thead className="sticky top-0 z-10 bg-gray-50">
                  <tr className="border-b border-gray-200 text-gray-500 font-semibold">
                    <th className="px-2 py-2 text-left w-8" title="드래그해서 순서 이동">⠿</th>
                    <th className="px-3 py-2 text-left">라벨</th>
                    <th className="px-3 py-2 text-left">필드 키</th>
                    <th className="px-3 py-2 text-left">종류</th>
                    <th className="px-3 py-2 text-left">스크래핑 매칭</th>
                    <th className="px-3 py-2 text-left w-12">삭제</th>
                  </tr>
                </thead>
                <tbody>
                  {fields.map((f, i) => {
                    const info = matchInfo(f)
                    return (
                      <tr key={i} ref={i === fields.length - 1 ? lastRowRef : undefined}
                        onDragOver={e => e.preventDefault()}
                        onDrop={() => handleDrop(f.field_key)}
                        className={`border-b border-gray-100 last:border-0 hover:bg-gray-50 ${dragKey === f.field_key ? 'opacity-40' : ''}`}>
                        <td className="px-2 py-2">
                          <span draggable
                            onDragStart={() => setDragKey(f.field_key)}
                            onDragEnd={() => setDragKey(null)}
                            title="드래그해서 순서 이동"
                            className="cursor-grab active:cursor-grabbing text-gray-400 hover:text-teal-500 select-none text-sm">⠿</span>
                        </td>
                        <td className="px-3 py-2">
                          <input value={f.field_label} onChange={e => updateField(i, { field_label: e.target.value })}
                            className="w-full border border-gray-200 rounded px-2 py-1 text-xs" />
                        </td>
                        <td className="px-3 py-2">
                          <input value={f.field_key} onChange={e => updateField(i, { field_key: e.target.value })}
                            disabled={!f.is_custom}
                            className="w-full border border-gray-200 rounded px-2 py-1 text-xs font-mono disabled:bg-gray-50 disabled:text-gray-400" />
                        </td>
                        <td className="px-3 py-2">
                          <span className={`px-2 py-0.5 rounded-full text-[11px] font-semibold ${f.is_custom ? 'bg-violet-50 text-violet-600' : 'bg-sky-50 text-sky-600'}`}>
                            {f.is_custom ? '커스텀' : '고정 컬럼'}
                          </span>
                        </td>
                        <td className="px-3 py-2">
                          <span className={`px-2 py-0.5 rounded-full text-[11px] font-semibold ${info.matched ? 'bg-emerald-50 text-emerald-600' : 'bg-amber-50 text-amber-600'}`}>
                            {info.label}
                          </span>
                        </td>
                        <td className="px-3 py-2">
                          <button onClick={() => removeField(i)} className="text-rose-500 hover:underline">삭제</button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        <div className="flex items-center justify-between bg-teal-50 rounded-xl px-4 py-2.5 text-xs text-gray-600 shrink-0">
          <span>컬럼별 마이그 기준(AI 생성/값 매핑/그대로 복사/합성)은 몰마다 원본 데이터가 달라 몰을 고른 뒤 설정합니다.</span>
          <button onClick={goToTransform} className="text-teal-600 font-semibold hover:underline shrink-0 ml-3">
            마이그레이션2_Transform에서 설정하기 →
          </button>
        </div>
      </div>
    </div>
  )
}
