'use client'
import { useCallback, useEffect, useState } from 'react'
import { useTabs } from '../shell/TabsContext'

interface Props {
  tabId: string
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
  memo: string | null
  business_reg_no: string | null
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

export function ClientDetailPanel({ tabId, params }: Props) {
  const { closeTab, bumpRefresh, openTab } = useTabs()
  const clientId = params?.clientId as number | undefined
  const isNew = clientId == null

  const [form, setForm] = useState<Record<string, string>>({})
  const [malls, setMalls] = useState<Mall[]>([])
  const [loading, setLoading] = useState(!isNew)
  const [saving, setSaving] = useState(false)

  const load = useCallback(() => {
    if (isNew) return
    fetch(`/api/clients/${clientId}`).then(r => r.json()).then((d: ClientDetail) => {
      setForm(Object.fromEntries(FIELDS.map(f => [f.key, d[f.key] == null ? '' : String(d[f.key])])))
      setMalls(d.malls || [])
    }).finally(() => setLoading(false))
  }, [clientId, isNew])

  useEffect(() => { load() }, [load])

  async function handleSave() {
    if (!form.name) return alert('거래처명을 입력하세요.')
    setSaving(true)
    const body = JSON.stringify({
      name: form.name, memo: form.memo, businessRegNo: form.business_reg_no, representativeName: form.representative_name,
      businessAddress: form.business_address, businessType: form.business_type, businessItem: form.business_item,
      contactName: form.contact_name, contactPhone: form.contact_phone, contactEmail: form.contact_email,
    })
    try {
      const res = isNew
        ? await fetch('/api/clients', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })
        : await fetch(`/api/clients/${clientId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body })
      if (!res.ok) throw new Error(`서버 오류 (${res.status})`)
      bumpRefresh('clients')
      closeTab(tabId)
    } catch (e) {
      alert(`저장에 실패했습니다: ${e instanceof Error ? e.message : e}`)
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete() {
    if (isNew || !confirm('이 거래처를 삭제할까요? (연결된 Mall은 삭제되지 않고, 거래처 연결만 해제됩니다)')) return
    await fetch(`/api/clients/${clientId}`, { method: 'DELETE' })
    bumpRefresh('clients')
    closeTab(tabId)
  }

  function openMall(mall?: Mall) {
    openTab(mall
      ? { id: `site-detail:${mall.id}`, type: 'site-detail', title: mall.name || mall.url, icon: '🏬', params: { siteId: mall.id }, closable: true }
      : { id: `site-detail:new:client${clientId}`, type: 'site-detail', title: '새 Mall 등록', icon: '➕', params: { clientId }, closable: true },
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
      <h1 className="text-2xl font-bold text-gray-800 mb-6">{isNew ? '➕ 새 거래처 등록' : `🏢 ${form.name} 수정`}</h1>

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
        <div className="flex items-center justify-between">
          <div className="flex gap-2">
            <button onClick={handleSave} disabled={saving}
              className="px-4 py-2 bg-teal-500 hover:bg-teal-600 text-white text-sm font-semibold rounded-full disabled:opacity-50 transition-colors">
              {saving ? '저장 중...' : isNew ? '등록' : '수정 저장'}
            </button>
            <button onClick={() => closeTab(tabId)} className="px-4 py-2 bg-gray-100 hover:bg-gray-200 text-gray-600 text-sm font-medium rounded-full transition-colors">
              취소
            </button>
          </div>
          {!isNew && (
            <button onClick={handleDelete} className="text-xs text-rose-500 hover:underline">🗑 이 거래처 삭제</button>
          )}
        </div>
      </div>

      {!isNew && (
        <div className="bg-white rounded-2xl border border-gray-200 p-6">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-gray-700">등록된 Mall ({malls.length})</h2>
            <button onClick={() => openMall()} className="text-xs text-teal-600 hover:underline shrink-0">➕ Mall 추가</button>
          </div>
          {malls.length === 0 ? (
            <p className="text-xs text-gray-400">이 거래처에 등록된 Mall이 없습니다.</p>
          ) : (
            <div className="divide-y divide-gray-100">
              {malls.map(m => (
                <div key={m.id} className="flex items-center gap-3 py-2">
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-gray-800">{m.name || '(이름 없음)'}</div>
                    <div className="text-xs text-gray-500 truncate">{m.url}{m.login_id && ` · ID: ${m.login_id}`}</div>
                  </div>
                  <button onClick={() => openMall(m)} className="text-xs text-teal-500 hover:underline shrink-0">수정</button>
                  <button onClick={() => deleteMall(m.id)} className="text-xs text-rose-500 hover:underline shrink-0">삭제</button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
