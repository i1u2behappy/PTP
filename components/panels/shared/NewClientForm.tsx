'use client'
import { useState } from 'react'

const FIELDS: { key: string; label: string }[] = [
  { key: 'name', label: '거래처명 *' },
  { key: 'business_reg_no', label: '사업자등록번호' },
  { key: 'representative_name', label: '대표자명' },
  { key: 'business_type', label: '업태' },
  { key: 'business_item', label: '종목' },
  { key: 'business_address', label: '사업장주소' },
  { key: 'contact_name', label: '담당자명' },
  { key: 'contact_phone', label: '연락처' },
  { key: 'contact_email', label: '이메일' },
  { key: 'memo', label: '메모' },
]

const EMPTY_FORM = { auto_internal_code: 'true' }

export function NewClientForm({ onCreated }: { onCreated: () => void }) {
  const [form, setForm] = useState<Record<string, string>>(EMPTY_FORM)
  const [docFile, setDocFile] = useState<File | null>(null)
  const [saving, setSaving] = useState(false)

  async function handleSave() {
    if (!form.name) return alert('거래처명을 입력하세요.')
    setSaving(true)
    try {
      const body = JSON.stringify({
        name: form.name, autoInternalCode: form.auto_internal_code !== 'false', memo: form.memo,
        businessRegNo: form.business_reg_no, representativeName: form.representative_name,
        businessAddress: form.business_address, businessType: form.business_type, businessItem: form.business_item,
        contactName: form.contact_name, contactPhone: form.contact_phone, contactEmail: form.contact_email,
      })
      const res = await fetch('/api/clients', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })
      if (!res.ok) throw new Error(`서버 오류 (${res.status})`)
      const { id } = await res.json() as { id: number }
      if (docFile) {
        const fd = new FormData()
        fd.append('file', docFile)
        const upRes = await fetch(`/api/clients/${id}/upload`, { method: 'POST', body: fd })
        if (!upRes.ok) {
          const e = await upRes.json().catch(() => ({}))
          alert(`거래처는 등록됐지만, 사업자등록증 파일 업로드는 실패했습니다: ${e.error || upRes.status}`)
        }
      }
      setForm(EMPTY_FORM)
      setDocFile(null)
      onCreated()
    } catch (e) {
      alert(`등록에 실패했습니다: ${e instanceof Error ? e.message : e}`)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="bg-white rounded-2xl border border-gray-200 p-4 h-full flex flex-col">
      <div className="flex items-center justify-between mb-3 shrink-0">
        <h2 className="text-sm font-semibold text-gray-700">➕ 새 거래처 등록</h2>
        <button onClick={handleSave} disabled={saving}
          className="px-4 py-1.5 bg-teal-500 hover:bg-teal-600 text-white text-sm font-semibold rounded-full disabled:opacity-50 transition-colors shrink-0">
          {saving ? '등록 중...' : '등록'}
        </button>
      </div>

      <div className="grid grid-cols-5 gap-2 mb-2 shrink-0">
        {FIELDS.map(f => (
          <label key={f.key} className="block">
            <span className="block text-[11px] text-gray-500 mb-0.5">{f.label}</span>
            <input value={form[f.key] ?? ''} onChange={e => setForm(v => ({ ...v, [f.key]: e.target.value }))}
              className="w-full border border-gray-300 rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-teal-400" />
          </label>
        ))}
      </div>

      <div className="flex items-stretch gap-3 flex-wrap shrink-0">
        <div className="flex items-center gap-3 bg-gray-50 border border-gray-200 rounded-xl px-3 py-2">
          <span className="text-[11px] text-gray-500 shrink-0">📎 사업자등록증 사본<br />(PDF/이미지, 최대 10MB)</span>
          <label className="shrink-0">
            <span className="sr-only">사업자등록증 사본 선택</span>
            <input type="file" accept=".pdf,.jpg,.jpeg,.png,.webp"
              onChange={e => setDocFile(e.target.files?.[0] || null)}
              className="text-xs text-gray-600 file:mr-2 file:px-2 file:py-1 file:rounded-full file:border-0 file:bg-teal-50 file:text-teal-600 file:text-[11px] file:font-semibold hover:file:bg-teal-100" />
          </label>
          {docFile && <span className="text-[11px] text-teal-600 truncate max-w-[160px]">✓ {docFile.name}</span>}
        </div>

        <label className="flex items-center gap-1.5 text-xs text-gray-600 bg-gray-50 border border-gray-200 rounded-xl px-3 py-2">
          <input type="checkbox" checked={form.auto_internal_code !== 'false'}
            onChange={e => setForm(v => ({ ...v, auto_internal_code: String(e.target.checked) }))} />
          <span>
            관리코드 자동 발급
            <span className="block text-[10px] text-gray-400">상품마스터 가공 시 거래처 코드 기반 사내 관리코드를 자동으로 발급합니다</span>
          </span>
        </label>
      </div>
    </div>
  )
}
