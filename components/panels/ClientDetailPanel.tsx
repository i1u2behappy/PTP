'use client'
import { useCallback, useEffect, useState } from 'react'
import { useTabs } from '../shell/TabsContext'
import { MemoLog } from './MemoLog'
import { CLIENTS_LIST_TAB, SITES_LIST_TAB } from '../shell/menuTabs'

interface Props {
  params?: Record<string, unknown>
}

interface Mall {
  id: number
  name: string | null
  url: string
  login_id: string | null
}

interface ClientDetail {
  id: number
  name: string
  code: string | null
  auto_internal_code: boolean
  memo: string | null
  business_reg_no: string | null
  business_reg_doc_path: string | null
  business_reg_doc_name: string | null
  representative_name: string | null
  business_address: string | null
  business_type: string | null
  business_item: string | null
  contact_name: string | null
  contact_phone: string | null
  contact_email: string | null
  malls: Mall[]
}

const FIELDS: { key: keyof ClientDetail; label: string }[] = [
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

export function ClientDetailPanel({ params }: Props) {
  const { bumpRefresh, openTab } = useTabs()
  const clientId = params?.clientId as number

  function backToList() { openTab(CLIENTS_LIST_TAB) }

  const [form, setForm] = useState<Record<string, string>>({ auto_internal_code: 'true' })
  const [malls, setMalls] = useState<Mall[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [existingDoc, setExistingDoc] = useState<{ path: string; name: string } | null>(null)
  const [docFile, setDocFile] = useState<File | null>(null)
  const [existingCode, setExistingCode] = useState<string | null>(null)

  const load = useCallback(() => {
    fetch(`/api/clients/${clientId}`).then(r => r.json()).then((d: ClientDetail) => {
      setForm({
        ...Object.fromEntries(FIELDS.map(f => [f.key, d[f.key] == null ? '' : String(d[f.key])])),
        auto_internal_code: String(d.auto_internal_code ?? true),
      })
      setMalls(d.malls || [])
      setExistingDoc(d.business_reg_doc_path ? { path: d.business_reg_doc_path, name: d.business_reg_doc_name || '사업자등록증' } : null)
      setExistingCode(d.code)
    }).finally(() => setLoading(false))
  }, [clientId])

  useEffect(() => { load() }, [load])

  async function handleSave() {
    if (!form.name) return alert('거래처명을 입력하세요.')
    setSaving(true)
    const body = JSON.stringify({
      name: form.name, code: existingCode, autoInternalCode: form.auto_internal_code !== 'false', memo: form.memo,
      businessRegNo: form.business_reg_no, representativeName: form.representative_name,
      businessAddress: form.business_address, businessType: form.business_type, businessItem: form.business_item,
      contactName: form.contact_name, contactPhone: form.contact_phone, contactEmail: form.contact_email,
    })
    try {
      const res = await fetch(`/api/clients/${clientId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body })
      if (!res.ok) throw new Error(`서버 오류 (${res.status})`)
      if (docFile) {
        const fd = new FormData()
        fd.append('file', docFile)
        const upRes = await fetch(`/api/clients/${clientId}/upload`, { method: 'POST', body: fd })
        if (!upRes.ok) {
          const e = await upRes.json().catch(() => ({}))
          alert(`거래처 정보는 저장됐지만, 사업자등록증 파일 업로드는 실패했습니다: ${e.error || upRes.status}`)
        }
      }
      bumpRefresh('clients')
      backToList()
    } catch (e) {
      alert(`저장에 실패했습니다: ${e instanceof Error ? e.message : e}`)
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete() {
    if (!confirm('이 거래처를 삭제할까요? (연결된 Mall은 삭제되지 않고, 거래처 연결만 해제됩니다)')) return
    await fetch(`/api/clients/${clientId}`, { method: 'DELETE' })
    bumpRefresh('clients')
    backToList()
  }

  function openMall(mall?: Mall) {
    openTab(mall
      ? { ...SITES_LIST_TAB, type: 'site-detail', params: { siteId: mall.id } }
      : { ...SITES_LIST_TAB, type: 'site-detail', params: { clientId } },
    )
  }

  async function deleteMall(id: number) {
    if (!confirm('이 Mall 등록 정보를 삭제할까요?')) return
    await fetch(`/api/sites/${id}`, { method: 'DELETE' })
    setMalls(prev => prev.filter(m => m.id !== id))
    bumpRefresh('sites')
  }

  if (loading) return <div className="text-center text-sm text-gray-400 py-12">불러오는 중...</div>

  return (
    <div className="max-w-3xl">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-gray-800">🏢 {form.name} 수정</h1>
        <div className="flex items-center gap-2 shrink-0">
          <button onClick={handleDelete} className="text-xs text-rose-500 hover:underline mr-2">🗑 이 거래처 삭제</button>
          <button onClick={backToList} className="px-4 py-2 bg-gray-100 hover:bg-gray-200 text-gray-600 text-sm font-medium rounded-full transition-colors">
            취소
          </button>
          <button onClick={handleSave} disabled={saving}
            className="px-4 py-2 bg-teal-500 hover:bg-teal-600 text-white text-sm font-semibold rounded-full disabled:opacity-50 transition-colors">
            {saving ? '저장 중...' : '수정 저장'}
          </button>
        </div>
      </div>

      <div className="bg-white rounded-2xl border border-gray-200 p-6 mb-4">
        <div className="grid grid-cols-2 gap-3 mb-3">
          {FIELDS.map(f => (
            <label key={f.key} className={f.key === 'business_address' || f.key === 'memo' ? 'col-span-2 block' : 'block'}>
              <span className="block text-xs text-gray-500 mb-1">{f.label}</span>
              <input value={form[f.key] ?? ''} onChange={e => setForm(v => ({ ...v, [f.key]: e.target.value }))}
                className="w-full border border-gray-300 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-400" />
            </label>
          ))}
        </div>

        <p className="text-xs text-gray-500 mb-3">
          거래처 코드: <span className="font-mono text-teal-600">{existingCode || '-'}</span>
        </p>

        <label className="block mb-3">
          <span className="block text-xs text-gray-500 mb-1">사업자등록증 사본 (PDF 또는 이미지, 최대 10MB)</span>
          <input type="file" accept=".pdf,.jpg,.jpeg,.png,.webp"
            onChange={e => setDocFile(e.target.files?.[0] || null)}
            className="w-full text-sm text-gray-600 file:mr-3 file:px-3 file:py-1.5 file:rounded-full file:border-0 file:bg-teal-50 file:text-teal-600 file:text-xs file:font-semibold hover:file:bg-teal-100" />
          {docFile ? (
            <p className="text-xs text-gray-500 mt-1">선택됨: {docFile.name} (저장 시 업로드됩니다)</p>
          ) : existingDoc ? (
            <p className="text-xs text-gray-500 mt-1">
              등록된 파일: <a href={existingDoc.path} target="_blank" rel="noreferrer" className="text-teal-600 hover:underline">{existingDoc.name}</a>
            </p>
          ) : (
            <p className="text-xs text-gray-300 mt-1">등록된 파일이 없습니다.</p>
          )}
        </label>

        <label className="flex items-center gap-2 text-sm text-gray-600 mb-3">
          <input type="checkbox" checked={form.auto_internal_code !== 'false'}
            onChange={e => setForm(v => ({ ...v, auto_internal_code: String(e.target.checked) }))} />
          상품마스터 가공 시 관리코드 자동 발급 (거래처 코드가 설정된 경우)
        </label>
      </div>

      <div className="bg-white rounded-2xl border border-gray-200 p-6 mb-4">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-gray-700">등록된 Mall ({malls.length})</h2>
          <button onClick={() => openMall()} className="text-xs text-teal-600 hover:underline shrink-0">➕ Mall 추가</button>
        </div>
        {malls.length === 0 ? (
          <p className="text-xs text-gray-400">이 거래처에 등록된 Mall이 없습니다.</p>
        ) : (
          <div className="overflow-auto">
            <table className="w-full text-xs border-collapse">
              <thead>
                <tr className="border-b border-gray-200 text-gray-500 font-semibold">
                  <th className="px-3 py-2 text-left">이름</th>
                  <th className="px-3 py-2 text-left">URL</th>
                  <th className="px-3 py-2 text-left">로그인ID</th>
                  <th className="px-3 py-2 text-left">관리</th>
                </tr>
              </thead>
              <tbody>
                {malls.map(m => (
                  <tr key={m.id} className="border-b border-gray-100 last:border-0">
                    <td className="px-3 py-2 text-gray-800">{m.name || '(이름 없음)'}</td>
                    <td className="px-3 py-2 text-gray-500 max-w-[280px] truncate" title={m.url}>{m.url}</td>
                    <td className="px-3 py-2 text-gray-500">{m.login_id || '-'}</td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      <button onClick={() => openMall(m)} className="text-teal-500 hover:underline mr-2">수정</button>
                      <button onClick={() => deleteMall(m.id)} className="text-rose-500 hover:underline">삭제</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <MemoLog baseUrl={`/api/clients/${clientId}/memos`} />
    </div>
  )
}
