'use client'
import { useEffect, useState } from 'react'
import { useTabs } from '../shell/TabsContext'

interface Props {
  tabId: string
  params?: Record<string, unknown>
}

interface ClientOption { id: number; name: string }

export function SiteDetailPanel({ tabId, params }: Props) {
  const { closeTab, bumpRefresh } = useTabs()
  const siteId = params?.siteId as number | undefined
  const isNew = siteId == null

  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [loginId, setLoginId] = useState('')
  const [loginPw, setLoginPw] = useState('')
  const [clientId, setClientId] = useState<number | ''>((params?.clientId as number | undefined) ?? '')
  const [clients, setClients] = useState<ClientOption[]>([])
  const [loading, setLoading] = useState(!isNew)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    fetch('/api/clients').then(r => r.json()).then((d: ClientOption[]) => { if (Array.isArray(d)) setClients(d) }).catch(() => {})
  }, [])

  useEffect(() => {
    if (isNew) return
    fetch(`/api/sites/${siteId}`).then(r => r.json()).then((d: { name: string | null; url: string; login_id: string | null; login_pw: string | null; client_id: number | null }) => {
      setName(d.name || ''); setUrl(d.url); setLoginId(d.login_id || ''); setLoginPw(d.login_pw || '')
      setClientId(d.client_id ?? '')
    }).finally(() => setLoading(false))
  }, [siteId, isNew])

  async function handleSave() {
    if (!url) return alert('URL을 입력하세요.')
    setSaving(true)
    const body = JSON.stringify({ name, url, loginId, loginPw, clientId: clientId === '' ? null : clientId })
    try {
      const res = isNew
        ? await fetch('/api/sites', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })
        : await fetch(`/api/sites/${siteId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body })
      if (!res.ok) throw new Error(`서버 오류 (${res.status})`)
      bumpRefresh('sites')
      closeTab(tabId)
    } catch (e) {
      alert(`저장에 실패했습니다: ${e instanceof Error ? e.message : e}\nDB 연결 상태를 확인해주세요.`)
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete() {
    if (isNew || !confirm('이 Mall 등록 정보를 삭제할까요?')) return
    try {
      const res = await fetch(`/api/sites/${siteId}`, { method: 'DELETE' })
      if (!res.ok) throw new Error(`서버 오류 (${res.status})`)
      bumpRefresh('sites')
      closeTab(tabId)
    } catch (e) {
      alert(`삭제에 실패했습니다: ${e instanceof Error ? e.message : e}`)
    }
  }

  if (loading) return <div className="text-center text-sm text-gray-400 py-12">불러오는 중...</div>

  return (
    <div className="max-w-2xl">
      <h1 className="text-2xl font-bold text-gray-800 mb-6">{isNew ? '➕ 새 Mall 등록' : `🏬 ${name || url} 수정`}</h1>

      <div className="bg-white rounded-2xl border border-gray-200 p-6 mb-4">
        <div className="grid grid-cols-2 gap-3 mb-3">
          <label className="col-span-2 block">
            <span className="block text-xs text-gray-500 mb-1">이름 (선택)</span>
            <input value={name} onChange={e => setName(e.target.value)}
              className="w-full border border-gray-300 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-400" />
          </label>
          <label className="col-span-2 block">
            <span className="block text-xs text-gray-500 mb-1">URL *</span>
            <input type="url" value={url} onChange={e => setUrl(e.target.value)} placeholder="https://shop.example.com"
              className="w-full border border-gray-300 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-400" />
          </label>
          <label className="block">
            <span className="block text-xs text-gray-500 mb-1">아이디 / 이메일</span>
            <input value={loginId} onChange={e => setLoginId(e.target.value)}
              className="w-full border border-gray-300 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-400" />
          </label>
          <label className="block">
            <span className="block text-xs text-gray-500 mb-1">비밀번호</span>
            <input type="password" value={loginPw} onChange={e => setLoginPw(e.target.value)}
              className="w-full border border-gray-300 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-400" />
          </label>
          <label className="col-span-2 block">
            <span className="block text-xs text-gray-500 mb-1">거래처</span>
            <select value={clientId} onChange={e => setClientId(e.target.value === '' ? '' : Number(e.target.value))}
              className="w-full border border-gray-300 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-400">
              <option value="">(선택 안 함)</option>
              {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
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
            <button onClick={handleDelete} className="text-xs text-rose-500 hover:underline">🗑 이 Mall 삭제</button>
          )}
        </div>
      </div>
    </div>
  )
}
