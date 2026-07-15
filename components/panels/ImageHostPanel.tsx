'use client'
import { useEffect, useState, useCallback } from 'react'

export function ImageHostPanel() {
  const [baseUrl, setBaseUrl] = useState('')
  const [baseUrlInput, setBaseUrlInput] = useState('')
  const [saving, setSaving] = useState(false)

  const load = useCallback(() => {
    fetch('/api/settings/image-host').then(r => r.json()).then((d: { baseUrl: string }) => { setBaseUrl(d.baseUrl); setBaseUrlInput(d.baseUrl) })
  }, [])

  useEffect(() => { load() }, [load])

  async function saveBaseUrl() {
    setSaving(true)
    try {
      await fetch('/api/settings/image-host', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ baseUrl: baseUrlInput }) })
      load()
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="max-w-2xl">
      <h1 className="text-2xl font-bold text-gray-800 mb-6">🌐 이미지 호스팅 관리</h1>

      <div className="bg-white rounded-2xl border border-gray-200 p-6">
        <h2 className="text-sm font-semibold text-gray-700 mb-1">이미지 호스팅 base URL</h2>
        <p className="text-xs text-gray-400 mb-3">
          여기서 값을 바꾸면 모든 상품 이미지 URL이 즉시 새 도메인 기준으로 조립됩니다 (개별 상품·이미지 수정 불필요). 현재값: <code className="text-gray-600">{baseUrl || '(비어있음 — 상대경로 그대로 사용)'}</code>
        </p>
        <div className="flex gap-2">
          <label className="flex-1 block">
            <span className="sr-only">이미지 호스팅 base URL</span>
            <input value={baseUrlInput} onChange={e => setBaseUrlInput(e.target.value)} placeholder="https://cdn.example.com"
              className="w-full border border-gray-300 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-400" />
          </label>
          <button onClick={saveBaseUrl} disabled={saving}
            className="px-4 py-2 bg-teal-500 hover:bg-teal-600 text-white text-sm font-semibold rounded-full disabled:opacity-50 transition-colors">
            {saving ? '저장 중...' : '저장'}
          </button>
        </div>
      </div>
    </div>
  )
}
