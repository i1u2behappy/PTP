'use client'
import { useCallback, useEffect, useState } from 'react'
import { useTabs } from '../shell/TabsContext'

interface Client { id: number; name: string }
interface SchemaField { field_key: string; field_label: string; is_custom: boolean }

/**
 * 마이그레이션 하위 메뉴 첫 번째 — 거래처가 원하는 "기준 Master 테이블"의 컬럼 구성을 등록·편집한다.
 * 컬럼별 실제 마이그레이션 방식(AI 생성/값 매핑/그대로 복사/합성)은 몰마다 원본 데이터가 달라
 * 마이그레이션2_Transform에서 몰을 고른 뒤 설정한다 — 여기서는 스키마(컬럼 목록) 자체만 관리한다.
 */
export function MasterSchemaPanel({ params }: { params?: Record<string, unknown> }) {
  const { openTab } = useTabs()
  const [clients, setClients] = useState<Client[]>([])
  const [clientId, setClientId] = useState<number | ''>((params?.clientId as number | undefined) ?? '')
  const [fields, setFields] = useState<SchemaField[]>([])
  const [file, setFile] = useState<File | null>(null)
  const [uploading, setUploading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    fetch('/api/clients').then(r => r.json()).then((d: Client[]) => setClients(Array.isArray(d) ? d : [])).catch(() => {})
  }, [])

  const loadFields = useCallback(() => {
    const result = clientId === ''
      ? Promise.resolve([])
      : fetch(`/api/master/schema?clientId=${clientId}`).then(r => r.json())
    result.then((d: SchemaField[]) => setFields(Array.isArray(d) ? d : [])).catch(() => {})
  }, [clientId])

  useEffect(() => { loadFields() }, [loadFields])

  async function handleUpload() {
    if (!file) return
    setUploading(true)
    try {
      const fd = new FormData()
      fd.append('file', file)
      const res = await fetch('/api/master/schema/upload', { method: 'POST', body: fd })
      if (!res.ok) { const e = await res.json().catch(() => ({})); alert(`업로드 실패: ${e.error || res.status}`); return }
      const d = await res.json() as { fields: SchemaField[] }
      setFields(d.fields)
      setFile(null)
    } finally {
      setUploading(false)
    }
  }

  function updateField(i: number, patch: Partial<SchemaField>) {
    setFields(prev => prev.map((f, idx) => idx === i ? { ...f, ...patch } : f))
  }
  function removeField(i: number) {
    setFields(prev => prev.filter((_, idx) => idx !== i))
  }
  function addField() {
    setFields(prev => [...prev, { field_key: `custom_${prev.length + 1}`, field_label: '', is_custom: true }])
  }

  async function saveFields() {
    if (clientId === '') return
    setSaving(true)
    try {
      await fetch('/api/master/schema', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId, fields }),
      })
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } finally {
      setSaving(false)
    }
  }

  function goToTransform() {
    openTab({ id: 'transform', type: 'transform', title: '마이그레이션2_Transform', icon: '🧬', closable: true, ...(clientId !== '' ? { params: { clientId } } : {}) })
  }

  return (
    <div className="max-w-3xl">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-800">🧱 기준 Master 테이블 관리</h1>
        <p className="text-xs text-gray-400 mt-1">
          거래처가 원하는 최종 &quot;기준 Master DB&quot; 컬럼 구성을 여기서 등록·편집합니다. 엑셀 샘플을 업로드하면
          기존 상품마스터 컬럼과 자동 매칭을 시도하고, 매칭 안 된 항목은 커스텀 필드로 남습니다. 컬럼별로 몰의
          원본 데이터를 어떤 기준으로 채울지는 마이그레이션2_Transform에서 몰을 선택한 뒤 설정합니다.
        </p>
      </div>

      <div className="bg-white rounded-2xl border border-gray-200 p-4 mb-4 flex items-center gap-3">
        <label className="flex items-center gap-2 text-sm text-gray-600">
          거래처
          <select value={clientId} onChange={e => setClientId(e.target.value ? Number(e.target.value) : '')}
            className="border border-gray-300 rounded-xl px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-teal-400">
            <option value="">거래처를 선택하세요</option>
            {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
      </div>

      {clientId === '' ? (
        <div className="bg-white rounded-2xl border border-gray-200 p-12 text-center text-gray-400">
          <div className="text-4xl mb-3">🧱</div>
          <p className="text-sm">거래처를 선택해주세요.</p>
        </div>
      ) : (
        <div className="bg-white rounded-2xl border border-gray-200 p-6">
          <div className="flex items-center gap-2 mb-3">
            <input type="file" accept=".xlsx,.xls" onChange={e => setFile(e.target.files?.[0] || null)}
              className="text-xs text-gray-600 file:mr-2 file:px-2 file:py-1 file:rounded-full file:border-0 file:bg-teal-50 file:text-teal-600 file:text-xs file:font-semibold hover:file:bg-teal-100" />
            <button onClick={handleUpload} disabled={!file || uploading}
              className="px-3 py-1.5 bg-teal-500 hover:bg-teal-600 text-white text-xs font-semibold rounded-full disabled:opacity-50 transition-colors shrink-0">
              {uploading ? '불러오는 중...' : '엑셀에서 불러오기'}
            </button>
          </div>

          {fields.length === 0 ? (
            <p className="text-xs text-gray-400 mb-3">등록된 필드가 없습니다. 엑셀을 업로드하거나 직접 추가해주세요.</p>
          ) : (
            <div className="border border-gray-100 rounded-xl overflow-hidden mb-3">
              <table className="w-full text-xs border-collapse">
                <thead className="bg-gray-50">
                  <tr className="border-b border-gray-200 text-gray-500 font-semibold">
                    <th className="px-3 py-2 text-left sticky left-0 z-10 bg-gray-50">라벨(엑셀 헤더)</th>
                    <th className="px-3 py-2 text-left">필드 키</th>
                    <th className="px-3 py-2 text-left">종류</th>
                    <th className="px-3 py-2 text-left">관리</th>
                  </tr>
                </thead>
                <tbody>
                  {fields.map((f, i) => (
                    <tr key={i} className="border-b border-gray-100 last:border-0">
                      <td className="px-3 py-2 sticky left-0 z-[1] bg-white">
                        <input value={f.field_label} onChange={e => updateField(i, { field_label: e.target.value })}
                          className="w-full border border-gray-200 rounded px-2 py-1 text-xs" />
                      </td>
                      <td className="px-3 py-2">
                        <input value={f.field_key} onChange={e => updateField(i, { field_key: e.target.value })}
                          className="w-full border border-gray-200 rounded px-2 py-1 text-xs font-mono" />
                      </td>
                      <td className="px-3 py-2">
                        <select value={f.is_custom ? 'custom' : 'fixed'} onChange={e => updateField(i, { is_custom: e.target.value === 'custom' })}
                          className="border border-gray-200 rounded px-2 py-1 text-xs">
                          <option value="fixed">기존 컬럼</option>
                          <option value="custom">커스텀 필드</option>
                        </select>
                      </td>
                      <td className="px-3 py-2">
                        <button onClick={() => removeField(i)} className="text-rose-500 hover:underline">삭제</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="flex items-center gap-2 mb-4">
            <button onClick={addField} className="px-3 py-1.5 bg-gray-100 hover:bg-gray-200 text-gray-600 text-xs font-semibold rounded-full transition-colors">
              ➕ 필드 추가
            </button>
            <button onClick={saveFields} disabled={saving}
              className="px-4 py-1.5 bg-teal-500 hover:bg-teal-600 text-white text-xs font-semibold rounded-full disabled:opacity-50 transition-colors">
              {saving ? '저장 중...' : saved ? '✓ 저장됨' : '필드 목록 저장'}
            </button>
          </div>

          <div className="flex items-center justify-between bg-teal-50 rounded-xl px-4 py-2.5 text-xs text-gray-600">
            <span>컬럼별 마이그 기준(AI 생성/값 매핑/그대로 복사/합성)은 몰마다 원본 데이터가 달라 몰을 고른 뒤 설정합니다.</span>
            <button onClick={goToTransform} className="text-teal-600 font-semibold hover:underline shrink-0 ml-3">
              마이그레이션2_Transform에서 설정하기 →
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
