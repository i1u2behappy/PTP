'use client'
import { useEffect, useRef, useState } from 'react'

const NORMAL_POLL_MS = 20_000
const RESTARTING_POLL_MS = 4_000

type Health = 'ok' | 'db-down' | 'server-down'

/** 로컬 Docker(Postgres 컨테이너)가 죽어있으면 로그인부터 모든 기능이 알 수 없는 "확인 실패: 500"으로
 *  실패한다 — 주기적으로 DB 연결을 확인해 죽어있으면 배너로 바로 알리고, 버튼 한 번으로 Docker Desktop을
 *  재시작할 수 있게 한다.
 *
 *  fetch 자체가 실패하는 경우(네트워크 에러)는 PTP 서버(Next.js) 프로세스 자체가 죽었거나 응답이 없는
 *  상황 — DB만 죽은 경우(fetch는 성공하고 { ok:false }만 옴)와는 원인이 다르므로 구분해서 안내한다. 단,
 *  이 배너 자체가 서버가 준 페이지 위에서 동작하므로, 페이지를 아예 새로 열 수 없을 만큼 서버가 완전히
 *  죽은 경우는 이미 열려 있던 탭에서만 감지/재시도가 가능하다는 한계가 있다. */
export function DbHealthBanner() {
  const [health, setHealth] = useState<Health>('ok')
  const [restarting, setRestarting] = useState(false)
  const [restartError, setRestartError] = useState('')
  const restartingRef = useRef(restarting)
  restartingRef.current = restarting

  useEffect(() => {
    let cancelled = false
    async function check() {
      let next: Health = 'ok'
      try {
        const d = await fetch('/api/health/db').then(r => r.json())
        next = d.ok ? 'ok' : 'db-down'
      } catch {
        next = 'server-down'
      }
      if (cancelled) return
      setHealth(next)
      if (next === 'ok' && restartingRef.current) setRestarting(false)
    }
    check()
    const id = setInterval(check, restarting ? RESTARTING_POLL_MS : NORMAL_POLL_MS)
    return () => { cancelled = true; clearInterval(id) }
  }, [restarting])

  async function handleRestart(endpoint: string) {
    setRestarting(true)
    setRestartError('')
    try {
      const res = await fetch(endpoint, { method: 'POST' })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        setRestartError(d.error || '재시작 요청에 실패했습니다')
        setRestarting(false)
      }
    } catch {
      setRestartError('재시작 요청에 실패했습니다 (서버가 응답하지 않습니다)')
      setRestarting(false)
    }
  }

  if (health === 'ok') return null

  return (
    <div className="fixed top-0 inset-x-0 z-[60] bg-rose-600 text-white text-sm px-4 py-2 flex items-center justify-center gap-3 shadow-md">
      {health === 'db-down' ? (
        <>
          <span>⚠ DB 연결 실패 — Docker가 꺼져있을 수 있습니다.</span>
          {restartError && <span className="text-rose-200">({restartError})</span>}
          <button onClick={() => handleRestart('/api/system/restart-docker')} disabled={restarting}
            className="px-3 py-1 bg-white text-rose-600 rounded-full text-xs font-semibold hover:bg-rose-50 disabled:opacity-60 transition-colors">
            {restarting ? '재시작 중... (20~60초 소요)' : '🐳 도커 재시작'}
          </button>
        </>
      ) : (
        <>
          <span>⚠ PTP 서버 응답 없음 — 서버가 다운되었을 수 있습니다.</span>
          {restartError && <span className="text-rose-200">({restartError})</span>}
          <button onClick={() => handleRestart('/api/system/restart-server')} disabled={restarting}
            className="px-3 py-1 bg-white text-rose-600 rounded-full text-xs font-semibold hover:bg-rose-50 disabled:opacity-60 transition-colors">
            {restarting ? '재시작 중... (10~20초 소요)' : '🔄 PTP 서버 재시작'}
          </button>
        </>
      )}
    </div>
  )
}
