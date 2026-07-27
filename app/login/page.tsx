'use client'
import { useState } from 'react'
import Image from 'next/image'
import { useRouter } from 'next/navigation'

export default function LoginPage() {
  const router = useRouter()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        setError(d.error || '로그인에 실패했습니다.')
        return
      }
      router.push('/')
      router.refresh()
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 px-4">
      <form onSubmit={handleSubmit} className="w-full max-w-sm bg-white border border-slate-200 rounded-2xl shadow-sm p-8">
        <div className="flex flex-col items-center mb-6">
          <Image src="/logo.jpg" alt="ILDA:Bridge" width={600} height={566} className="h-16 w-auto mb-2" priority />
          <p className="text-sm font-bold text-slate-700">PTP</p>
          <p className="text-xs text-slate-400 mt-1">(Product Transformation Platform)</p>
        </div>

        <label className="block mb-3">
          <span className="block text-xs font-semibold text-slate-500 mb-1">아이디</span>
          <input value={username} onChange={e => setUsername(e.target.value)} autoFocus required
            className="w-full border border-slate-300 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-400" />
        </label>
        <label className="block mb-4">
          <span className="block text-xs font-semibold text-slate-500 mb-1">비밀번호</span>
          <input type="password" value={password} onChange={e => setPassword(e.target.value)} required
            className="w-full border border-slate-300 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-400" />
        </label>

        {error && <p className="text-xs text-rose-500 mb-3">{error}</p>}

        <button type="submit" disabled={loading}
          className="w-full px-4 py-2 bg-teal-500 hover:bg-teal-600 text-white text-sm font-semibold rounded-full transition-colors disabled:opacity-50">
          {loading ? '로그인 중...' : '로그인'}
        </button>
      </form>
    </div>
  )
}
