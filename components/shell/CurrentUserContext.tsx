'use client'
import { createContext, useContext, useEffect, useState } from 'react'

interface CurrentUser { username: string; role: string }

const CurrentUserCtx = createContext<{ user: CurrentUser | null; isAdmin: boolean }>({ user: null, isAdmin: false })

/** 권한관리 도입(2026-07-27) — 거래처/Mall 등록·삭제, 스크랩 데이터 삭제 버튼을 admin에게만 보여주려면
 * 로그인한 사람의 role을 여러 화면(거래처 관리/Mall 관리/스크랩 Raw 확인/설정)이 공통으로 알아야 한다.
 * 실제 차단은 각 API 라우트(lib/auth.ts의 isAdminRequest)가 하므로, 여기서는 UI를 맞게 보여주는
 * 용도일 뿐 — 이 컨텍스트 값을 신뢰해 서버 쪽 검사를 생략하면 안 된다. */
export function CurrentUserProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<CurrentUser | null>(null)

  useEffect(() => {
    fetch('/api/auth/me').then(r => r.json()).then((d: CurrentUser | null) => setUser(d)).catch(() => {})
  }, [])

  return <CurrentUserCtx.Provider value={{ user, isAdmin: user?.role === 'admin' }}>{children}</CurrentUserCtx.Provider>
}

export function useCurrentUser() {
  return useContext(CurrentUserCtx)
}
