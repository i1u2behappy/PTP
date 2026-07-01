'use client'
import { useEffect, useState, useCallback } from 'react'

interface Site {
  id: number
  name: string | null
  url: string
  login_id: string | null
  created_at: string
}

export default function SitesPage() {
  const [sites, setSites]   = useState<Site[]>([])
  const [q, setQ]           = useState('')
  const [name, setName]     = useState('')
  const [url, setUrl]       = useState('')
  const [loginId, setLoginId] = useState('')
  const [loginPw, setLoginPw] = useState('')
  const [editingId, setEditingId] = useState<number | null>(null)

  const load = useCallback((query: string) => {
    fetch(`/api/sites?q=${encodeURIComponent(query)}`).then(r => r.json()).then((d: Site[]) => {
      if (Array.isArray(d)) setSites(d)
    }).catch(() => {})
  }, [])

  useEffect(() => { load(q) }, [load, q])

  function resetForm() {
    setEditingId(null); setName(''); setUrl(''); setLoginId(''); setLoginPw('')
  }

  async function handleSubmit() {
    if (!url) return alert('URL을 입력하세요.')
    const body = JSON.stringify({ name, url, loginId, loginPw })
    if (editingId) {
      await fetch(`/api/sites/${editingId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body })
    } else {
      await fetch('/api/sites', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })
    }
    resetForm()
    load(q)
  }

  async function handleEdit(site: Site) {
    const res = await fetch(`/api/sites/${site.id}`)
    const full = await res.json() as Site & { login_pw: string | null }
    setEditingId(site.id)
    setName(full.name || '')
    setUrl(full.url)
    setLoginId(full.login_id || '')
    setLoginPw(full.login_pw || '')
  }

  async function handleDelete(id: number) {
    if (!confirm('이 쇼핑몰 등록 정보를 삭제할까요?')) return
    await fetch(`/api/sites/${id}`, { method: 'DELETE' })
    if (editingId === id) resetForm()
    load(q)
  }

  return (
    <div className="max-w-3xl">
      <h1 className="text-2xl font-bold text-gray-800 mb-6">🏬 쇼핑몰 등록관리</h1>

      <div className="bg-white rounded-xl border border-gray-200 p-6 mb-6">
        <h2 className="text-sm font-semibold text-gray-700 mb-3">{editingId ? '쇼핑몰 정보 수정' : '새 쇼핑몰 등록'}</h2>
        <div className="grid grid-cols-2 gap-3 mb-3">
          <div className="col-span-2">
            <label className="block text-xs text-gray-500 mb-1">이름 (선택)</label>
            <input value={name} onChange={e => setName(e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400" />
          </div>
          <div className="col-span-2">
            <label className="block text-xs text-gray-500 mb-1">URL *</label>
            <input type="url" value={url} onChange={e => setUrl(e.target.value)} placeholder="https://shop.example.com"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400" />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">아이디 / 이메일</label>
            <input value={loginId} onChange={e => setLoginId(e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400" />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">비밀번호</label>
            <input type="password" value={loginPw} onChange={e => setLoginPw(e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400" />
          </div>
        </div>
        <div className="flex gap-2">
          <button onClick={handleSubmit}
            className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-semibold rounded-lg transition-colors">
            {editingId ? '수정 저장' : '등록'}
          </button>
          {editingId && (
            <button onClick={resetForm} className="px-4 py-2 bg-gray-100 hover:bg-gray-200 text-gray-600 text-sm font-medium rounded-lg transition-colors">
              취소
            </button>
          )}
        </div>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-100 bg-gray-50">
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="이름 또는 URL 검색..."
            className="w-full border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400" />
        </div>
        {sites.length === 0 ? (
          <div className="p-8 text-center text-sm text-gray-400">등록된 쇼핑몰이 없습니다.</div>
        ) : (
          <div className="divide-y divide-gray-100">
            {sites.map(s => (
              <div key={s.id} className="flex items-center gap-3 px-4 py-3">
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-gray-800">{s.name || '(이름 없음)'}</div>
                  <div className="text-xs text-gray-500 truncate">{s.url}</div>
                  {s.login_id && <div className="text-xs text-gray-400">ID: {s.login_id}</div>}
                </div>
                <button onClick={() => handleEdit(s)} className="text-xs text-indigo-600 hover:underline shrink-0">수정</button>
                <button onClick={() => handleDelete(s.id)} className="text-xs text-red-500 hover:underline shrink-0">삭제</button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
