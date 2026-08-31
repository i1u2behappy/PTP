'use client'
import { useEffect, useState } from 'react'

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
 *  죽은 경우는 이미 열려 있던 탭에서만 감지/재시도가 가능하다는 한계가 있다.
 *
 *  2026-08-07 실제 원인 사례: Turbopack(next dev 기본 컴파일러) 내부 워커 프로세스 통신이 타임아웃되며
 *  FATAL panic 후 이벤트 루프 자체가 완전히 멈췄다(CPU 0%, 어떤 요청에도 응답 없음 — 재시작해도 첫
 *  컴파일에서 곧바로 재발). 원인은 "알약"(AhnLab) 실시간 검사가 Turbopack의 대량 소파일 I/O를 가로채며
 *  지연시켜 내부 IPC 데드라인을 넘기는 것으로 진단(!specifications/dev-server-autostart-on-logon.md 참고).
 *  근본 조치로 package.json의 dev/dev:clean을 `next dev --webpack`으로 바꿔 Turbopack 자체를 우회했다 —
 *  이 배너의 "서버 응답 없음"이 이 특정 원인으로 다시 재발할 가능성은 낮아졌지만, 프로세스가 죽는 다른
 *  원인(PC 재부팅, 미처리 예외 등)은 여전히 남아있어 문구는 일반적인 표현을 유지한다. */
export function DbHealthBanner() {
  const [health, setHealth] = useState<Health>('ok')
  const [restarting, setRestarting] = useState(false)
  const [restartError, setRestartError] = useState('')

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
      if (next === 'ok' && restarting) setRestarting(false)
    }
    check()
    const id = setInterval(check, restarting ? RESTARTING_POLL_MS : NORMAL_POLL_MS)
    return () => { cancelled = true; clearInterval(id) }
  }, [restarting])

  // PTP 서버가 완전히 멈춘 상태(이벤트 루프 자체가 멈춘 경우 — 2026-08-07 Turbopack FATAL panic 실사례)라면
  // 이 재시작 요청도 결국 같은 죽은 프로세스가 처리해야 하므로 응답이 영영 오지 않는다 — fetch 자체엔 기본
  // 타임아웃이 없어 버튼이 "재시작 중..."에서 무한정 멈춰있게 된다. 몇 초 안에 응답이 없으면 요청이 서버에
  // 닿지 못한 것으로 보고, 브라우저로는 더 이상 해볼 수 있는 게 없다는 걸 바로 알려준다.
  async function handleRestart(endpoint: string) {
    setRestarting(true)
    setRestartError('')
    const timeoutMs = 6_000
    try {
      const res = await fetch(endpoint, { method: 'POST', signal: AbortSignal.timeout(timeoutMs) })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        setRestartError(d.error || '재시작 요청에 실패했습니다')
        setRestarting(false)
      }
    } catch (err) {
      const isTimeout = err instanceof Error && err.name === 'TimeoutError'
      setRestartError(
        isTimeout
          ? '서버가 요청조차 받지 못할 만큼 완전히 멈춘 것으로 보입니다 — 브라우저에서는 더 재시도할 수 없습니다. 매일 새벽 4시 자동 재시작을 기다리거나, PC에서 직접 서버를 재기동해주세요.'
          : '재시작 요청에 실패했습니다 (서버가 응답하지 않습니다)',
      )
      setRestarting(false)
    }
  }

  if (health === 'ok') return null

  return (
    <div className="fixed top-0 inset-x-0 z-[60] bg-rose-600 text-white text-sm px-4 py-2 flex items-center justify-center gap-3 shadow-md">
      {health === 'db-down' ? (
        <>
          {/* 실사용 확인(2026-08-31): 이 배너가 뜬 순간에도 postgres 컨테이너는 재시작된 적 없이(RestartCount:0)
              계속 떠있던 경우가 실제로 있었다 — "Docker가 꺼짐"은 재현되는 원인이 아니라, 버튼 옆 주석에
              적힌 진짜 흔한 원인(Docker Desktop은 떠 있는데 WSL2 네트워킹만 일시적으로 끊김)이 더 정확하다.
              사용자가 "Docker를 왜 꺼놨지?" 하고 엉뚱한 데서 원인을 찾지 않도록, 확인된 두 원인을 함께
              보여주고 버튼이 실제로 뭘 하는지·얼마나 걸리는지까지 미리 알려준다. */}
          <span>⚠ DB 연결 실패 — Docker Desktop이 꺼져있거나, WSL2 네트워킹이 일시적으로 끊겼을 수 있습니다.</span>
          {restartError && <span className="text-rose-200">({restartError})</span>}
          <button onClick={() => handleRestart('/api/system/restart-docker')} disabled={restarting}
            title="WSL2를 재시작해 Docker 백엔드를 다시 띄웁니다 — 보통 몇 초 안에, 길면 최대 60초까지 걸릴 수 있습니다. 끝나면 이 배너는 자동으로 사라집니다."
            className="px-3 py-1 bg-white text-rose-600 rounded-full text-xs font-semibold hover:bg-rose-50 disabled:opacity-60 transition-colors">
            {restarting ? 'WSL 재시작 중... (보통 수 초, 길면 최대 60초 — 끝나면 자동으로 사라집니다)' : '🐳 Docker/WSL 재시작'}
          </button>
        </>
      ) : (
        <>
          <span>⚠ PTP 서버 응답 없음 — 개발 서버 프로세스가 멈췄거나 죽은 것으로 보입니다.</span>
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
