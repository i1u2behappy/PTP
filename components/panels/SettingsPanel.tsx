'use client'
import { useEffect, useState, useCallback } from 'react'
import { useCurrentUser } from '../shell/CurrentUserContext'

interface MyAccount { id: number; username: string; role: string }
interface AppUser { id: number; username: string; role: string; created_at: string }

export function SettingsPanel() {
  const { isAdmin } = useCurrentUser()
  const [admin, setAdmin]             = useState<MyAccount | null>(null)
  const [newUsername, setNewUsername] = useState('')
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [adminError, setAdminError]   = useState('')
  const [adminSaved, setAdminSaved]   = useState(false)

  const [users, setUsers]             = useState<AppUser[]>([])
  const [newUserId, setNewUserId]     = useState('')
  const [newUserPw, setNewUserPw]     = useState('')
  const [userError, setUserError]     = useState('')

  const load = useCallback(() => {
    fetch('/api/auth/me').then(r => r.json()).then((d: MyAccount | null) => { setAdmin(d); setNewUsername(d?.username || '') })
  }, [])

  const loadUsers = useCallback(() => {
    fetch('/api/users').then(r => r.json()).then((d: AppUser[]) => setUsers(Array.isArray(d) ? d : []))
  }, [])

  useEffect(() => { load() }, [load])
  useEffect(() => { if (isAdmin) loadUsers() }, [isAdmin, loadUsers])

  async function registerUser() {
    setUserError('')
    if (!newUserId.trim() || !newUserPw) { setUserError('아이디와 비밀번호를 입력해주세요.'); return }
    const res = await fetch('/api/users', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: newUserId.trim(), password: newUserPw }),
    })
    if (!res.ok) {
      const d = await res.json().catch(() => ({}))
      setUserError(d.error || '등록에 실패했습니다.')
      return
    }
    setNewUserId('')
    setNewUserPw('')
    loadUsers()
  }

  async function deleteUser(id: number) {
    if (!confirm('이 사용자 계정을 삭제할까요?')) return
    await fetch(`/api/users/${id}`, { method: 'DELETE' })
    loadUsers()
  }

  async function saveAdmin() {
    setAdminError('')
    setAdminSaved(false)
    if (!currentPassword) { setAdminError('현재 비밀번호를 입력해주세요.'); return }
    const res = await fetch('/api/auth/me', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        currentPassword,
        newUsername: newUsername !== admin?.username ? newUsername : undefined,
        newPassword: newPassword || undefined,
      }),
    })
    if (!res.ok) {
      const d = await res.json().catch(() => ({}))
      setAdminError(d.error || '변경에 실패했습니다.')
      return
    }
    setCurrentPassword('')
    setNewPassword('')
    setAdminSaved(true)
    load()
  }

  return (
    <div className="max-w-4xl space-y-6">
      <h1 className="text-2xl font-bold text-gray-800">⚙️ 시스템관리</h1>

      {/* 내 계정 — 예전엔 "관리자 계정"이라 부르며 항상 admin 행 하나만 다뤘지만, 다중 사용자가 생기면서
          지금 로그인한 사람 본인의 계정을 조회/변경하는 카드로 바뀌었다(/api/auth/me). */}
      <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden">
        <div className="px-6 py-3 border-b border-gray-100 bg-gray-50">
          <h2 className="text-sm font-semibold text-gray-700">내 계정 (PTP 로그인){admin?.role === 'admin' && ' — 관리자'}</h2>
        </div>
        <div className="p-6 space-y-3 max-w-md">
          <label className="block">
            <span className="block text-xs font-semibold text-gray-500 mb-1">아이디</span>
            <input value={newUsername} onChange={e => setNewUsername(e.target.value)}
              className="w-full border border-gray-300 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-400" />
          </label>
          <label className="block">
            <span className="block text-xs font-semibold text-gray-500 mb-1">새 비밀번호 (변경하지 않으려면 비워두세요)</span>
            <input type="password" value={newPassword} onChange={e => setNewPassword(e.target.value)}
              className="w-full border border-gray-300 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-400" />
          </label>
          <label className="block">
            <span className="block text-xs font-semibold text-gray-500 mb-1">현재 비밀번호 (확인용, 필수)</span>
            <input type="password" value={currentPassword} onChange={e => setCurrentPassword(e.target.value)}
              className="w-full border border-gray-300 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-400" />
          </label>
          {adminError && <p className="text-xs text-rose-500">{adminError}</p>}
          {adminSaved && <p className="text-xs text-emerald-600">저장되었습니다.</p>}
          <button onClick={saveAdmin} className="px-4 py-2 bg-teal-500 hover:bg-teal-600 text-white text-sm font-semibold rounded-full transition-colors">저장</button>
        </div>
      </div>

      {/* 권한관리 — admin에게만 보인다. 신규 사용자는 항상 'user' role로만 등록되고(거래처/Mall 삭제,
          스크랩 데이터 삭제 불가, 그 외 전부 가능 — 거래처/Mall 등록은 가능), admin 승격 UI는 없다(admin은
          최초 시드 계정 하나뿐). */}
      {isAdmin && (
        <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden">
          <div className="px-6 py-3 border-b border-gray-100 bg-gray-50">
            <h2 className="text-sm font-semibold text-gray-700">권한관리</h2>
          </div>
          <div className="overflow-auto">
            <table className="w-full text-xs border-collapse">
              <thead className="bg-gray-50">
                <tr className="border-b border-gray-200 text-gray-500 font-semibold">
                  <th className="px-4 py-2 text-left">아이디</th>
                  <th className="px-4 py-2 text-left">권한</th>
                  <th className="px-4 py-2 text-left">등록일</th>
                  <th className="px-4 py-2 text-left w-20">관리</th>
                </tr>
              </thead>
              <tbody>
                {users.map(u => (
                  <tr key={u.id} className="border-b border-gray-100">
                    <td className="px-4 py-2 text-gray-700 font-medium">{u.username}</td>
                    <td className="px-4 py-2">
                      {u.role === 'admin'
                        ? <span className="text-violet-600 font-semibold">관리자 (전체 권한)</span>
                        : <span className="text-gray-500">일반사용자 (거래처·Mall 삭제, 스크랩 데이터 삭제 권한 제외)</span>}
                    </td>
                    <td className="px-4 py-2 text-gray-400">{new Date(u.created_at).toLocaleDateString()}</td>
                    <td className="px-4 py-2">
                      {u.role !== 'admin' && (
                        <button onClick={() => deleteUser(u.id)} className="text-rose-500 hover:underline">삭제</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="p-6 space-y-2 border-t border-gray-100 max-w-md">
            <p className="text-xs text-gray-400 mb-1">
              관리자 외의 사용자는 [거래처·Mall 삭제, 스크랩 데이터 삭제] 권한 제외.
            </p>
            <label className="block">
              <span className="sr-only">새 사용자 아이디</span>
              <input value={newUserId} onChange={e => setNewUserId(e.target.value)} placeholder="아이디"
                className="w-full border border-gray-300 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-400" />
            </label>
            <label className="block">
              <span className="sr-only">새 사용자 비밀번호</span>
              <input type="password" value={newUserPw} onChange={e => setNewUserPw(e.target.value)} placeholder="비밀번호"
                className="w-full border border-gray-300 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-400" />
            </label>
            {userError && <p className="text-xs text-rose-500">{userError}</p>}
            <button onClick={registerUser} className="px-4 py-2 bg-teal-500 hover:bg-teal-600 text-white text-sm font-semibold rounded-full transition-colors">사용자 등록</button>
          </div>
        </div>
      )}
    </div>
  )
}
