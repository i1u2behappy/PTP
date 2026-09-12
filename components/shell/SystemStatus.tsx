'use client'
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTabs } from './TabsContext'

interface RestartHistoryEntry { at: number; target: 'worker' | 'server' | 'docker'; trigger: 'manual' | 'auto' | 'cascade' }

interface SystemStatus {
  db: { ok: boolean; latencyMs: number | null }
  worker: { ok: boolean; pid?: number; bootedAt?: number; stale: boolean; staleFileCount: number; restartInFlight: boolean }
  server: { pid: number; uptimeSec: number; rssMb: number; restartThresholdMb: number; restartInFlight: boolean }
  history: RestartHistoryEntry[]
}

// 모달이 닫혀있을 때는 사이드바 점 색깔만 맞으면 되므로 느슨하게, 열려있을 때는 재시작 진행상황을
// 실시간으로 보여줘야 하니 빠르게 — DbHealthBanner의 NORMAL_POLL_MS/RESTARTING_POLL_MS와 같은 이유.
const IDLE_POLL_MS = 20_000
const OPEN_POLL_MS = 4_000

const TARGET_LABEL: Record<RestartHistoryEntry['target'], string> = { worker: '워커', server: 'PTP 서버', docker: 'Docker/WSL' }
const TRIGGER_LABEL: Record<RestartHistoryEntry['trigger'], string> = { manual: '수동', auto: '자동(메모리)', cascade: '연쇄재시작' }

function formatDuration(sec: number): string {
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  if (h > 0) return `${h}시간 ${m}분`
  if (m > 0) return `${m}분`
  return `${sec}초`
}

function formatClock(at: number): string {
  const d = new Date(at)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 전체적으로 "지금 조치가 필요해 보이는지"를 하나의 색으로 요약한다 — 개별 카드 안에서는 각자 더
 *  자세히 보여주고, 이 점은 팝업을 열어보지 않아도 사이드바에서 감이 오게 하는 용도. */
function overallSeverity(s: SystemStatus | null): 'ok' | 'warn' | 'down' {
  if (!s) return 'warn'
  if (!s.db.ok) return 'down'
  if (s.worker.stale || s.worker.restartInFlight || s.server.restartInFlight || !s.worker.ok) return 'warn'
  return 'ok'
}

async function postRestart(endpoint: string): Promise<string | null> {
  try {
    const res = await fetch(endpoint, { method: 'POST' })
    if (res.ok) return null
    const d = await res.json().catch(() => ({}))
    return d.error || '재시작 요청에 실패했습니다'
  } catch {
    return '서버에 연결할 수 없습니다'
  }
}

/**
 * Sidebar 하단에 상시 떠 있는 상태 인디케이터 + 클릭하면 열리는 상세 팝업. DbHealthBanner/GlobalErrorNet은
 * "문제가 생겼을 때만" 보이는 반면, 이건 평소에도 "지금 다 괜찮은지" 스스로 확인할 수 있는 상시 진입점이다
 * (2026-09-11 설계/사용자 요청 — 재시작 관련 디버깅을 여러 차례 거치며 "지금 상태를 한눈에 보는 화면"이
 * 없다는 게 반복적으로 드러났다). 새 판정 로직은 없고, app/api/system/status/route.ts가 이미 있는 조각들
 * (health/db, worker-freshness, 재시작 in-flight 플래그, 메모리 임계치)을 모아 보여줄 뿐이다.
 */
export function SystemStatus() {
  const { sidebarCollapsed } = useTabs()
  const [open, setOpen] = useState(false)
  const [status, setStatus] = useState<SystemStatus | null>(null)
  const [restarting, setRestarting] = useState<'worker' | 'server' | 'docker' | null>(null)
  const [actionError, setActionError] = useState('')

  useEffect(() => {
    let cancelled = false
    async function poll() {
      const data = await fetch('/api/system/status').then(r => r.json()).catch(() => null)
      if (!cancelled && data) setStatus(data)
    }
    poll()
    const id = setInterval(poll, open ? OPEN_POLL_MS : IDLE_POLL_MS)
    return () => { cancelled = true; clearInterval(id) }
  }, [open])

  async function handleRestart(target: 'worker' | 'server' | 'docker', endpoint: string) {
    setRestarting(target)
    setActionError('')
    const err = await postRestart(endpoint)
    if (err) setActionError(err)
    setRestarting(null)
  }

  const severity = overallSeverity(status)
  const dotColor = severity === 'down' ? 'bg-rose-500' : severity === 'warn' ? 'bg-amber-500' : 'bg-emerald-500'
  const label = severity === 'down' ? '장애' : severity === 'warn' ? '확인 필요' : '정상'

  return (
    <>
      <button onClick={() => setOpen(true)} title={sidebarCollapsed ? `시스템 상태: ${label}` : undefined}
        className={`w-full flex items-center gap-2 py-1.5 text-sm rounded-full text-slate-500 hover:bg-slate-50 hover:text-slate-700 transition-colors text-left
          ${sidebarCollapsed ? 'justify-center px-0' : 'px-3'}`}>
        <span className={`inline-block w-2 h-2 rounded-full shrink-0 ${dotColor}`} aria-hidden="true" />
        {!sidebarCollapsed && <span>시스템 상태 {label}</span>}
      </button>

      {open && typeof document !== 'undefined' && createPortal(
        // Sidebar(<aside>)가 모바일 슬라이드 애니메이션용 translate 유틸(-translate-x-full md:translate-x-0)을
        // 쓰는데, 이 컴포넌트가 그 <aside> 안에 그대로 있으면 이 fixed 오버레이의 containing block이
        // 뷰포트가 아니라 그 <aside>가 돼버린다(transform이 있는 조상은 값이 항등이어도 fixed 자손을
        // 자기 기준으로 가둔다 — 2026-09-11 실사용 확인: 팝업이 전체화면이 아니라 사이드바 폭 안에 눌려
        // 보였다). document.body에 포탈로 그려 이 문제를 원천적으로 피한다(DetailModal.tsx는 애초에
        // <aside> 밖, AppShell 최상단에 있어서 이 문제가 없다).
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4" onClick={() => setOpen(false)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md max-h-[85vh] overflow-y-auto relative" onClick={e => e.stopPropagation()}>
            <button onClick={() => setOpen(false)} aria-label="닫기"
              className="absolute top-3 right-3 z-10 w-8 h-8 flex items-center justify-center rounded-full bg-gray-100 hover:bg-gray-200 text-gray-500 hover:text-gray-700 transition-colors">
              ×
            </button>
            <div className="p-5 space-y-4">
              <h2 className="text-base font-bold text-slate-800">시스템 상태</h2>

              {!status ? (
                <p className="text-sm text-slate-400">불러오는 중...</p>
              ) : (
                <>
                  {/* Docker/DB */}
                  <div className="border border-slate-200 rounded-xl p-3">
                    <p className="text-sm font-semibold text-slate-700 flex items-center gap-1.5">
                      <span className={`inline-block w-2 h-2 rounded-full ${status.db.ok ? 'bg-emerald-500' : 'bg-rose-500'}`} />
                      🐘 Postgres (Docker)
                    </p>
                    <p className="text-xs text-slate-500 mt-1">
                      {status.db.ok ? `정상 · 응답시간 ${status.db.latencyMs}ms` : '연결 실패 — Docker Desktop이 꺼져있거나 WSL2 네트워킹이 끊겼을 수 있습니다'}
                    </p>
                    <button onClick={() => handleRestart('docker', '/api/system/restart-docker')} disabled={restarting !== null}
                      className="mt-2 px-3 py-1 bg-rose-600 text-white rounded-full text-xs font-semibold hover:bg-rose-700 disabled:opacity-50 transition-colors">
                      {restarting === 'docker' ? '재시작 요청 중...' : '🐳 Docker/WSL 재기동'}
                    </button>
                  </div>

                  {/* 워커 */}
                  <div className="border border-slate-200 rounded-xl p-3">
                    <p className="text-sm font-semibold text-slate-700 flex items-center gap-1.5">
                      <span className={`inline-block w-2 h-2 rounded-full ${!status.worker.ok ? 'bg-rose-500' : status.worker.stale ? 'bg-amber-500' : 'bg-emerald-500'}`} />
                      ⚙️ 워커 (스크래핑 프로세스)
                    </p>
                    <p className="text-xs text-slate-500 mt-1">
                      {!status.worker.ok ? '응답 없음 — 재부팅 직후 DB 재연결 중이거나 죽어있을 수 있습니다'
                        : status.worker.restartInFlight ? '재시작 진행 중...'
                        : `정상 · PID ${status.worker.pid} ${status.worker.stale ? `· 최신 코드 미반영(${status.worker.staleFileCount}개 파일)` : '· 최신 코드 반영됨'}`}
                    </p>
                    <button onClick={() => handleRestart('worker', '/api/system/restart-worker')} disabled={restarting !== null}
                      className="mt-2 px-3 py-1 bg-amber-600 text-white rounded-full text-xs font-semibold hover:bg-amber-700 disabled:opacity-50 transition-colors">
                      {restarting === 'worker' ? '재시작 요청 중...' : '🔄 워커 재시작'}
                    </button>
                  </div>

                  {/* PTP 서버 */}
                  <div className="border border-slate-200 rounded-xl p-3">
                    <p className="text-sm font-semibold text-slate-700 flex items-center gap-1.5">
                      <span className={`inline-block w-2 h-2 rounded-full ${status.server.restartInFlight ? 'bg-amber-500' : 'bg-emerald-500'}`} />
                      🖥️ PTP 서버 (Next.js)
                    </p>
                    <p className="text-xs text-slate-500 mt-1">
                      {status.server.restartInFlight ? '재시작 진행 중...' : `정상 · PID ${status.server.pid} · 가동 ${formatDuration(status.server.uptimeSec)}`}
                    </p>
                    <p className="text-xs text-slate-400 mt-0.5">
                      메모리 {status.server.rssMb}MB (자동재시작 임계치 {status.server.restartThresholdMb}MB의 {Math.round(status.server.rssMb / status.server.restartThresholdMb * 100)}%)
                    </p>
                    <button onClick={() => handleRestart('server', '/api/system/restart-server')} disabled={restarting !== null}
                      className="mt-2 px-3 py-1 bg-amber-600 text-white rounded-full text-xs font-semibold hover:bg-amber-700 disabled:opacity-50 transition-colors">
                      {restarting === 'server' ? '재시작 요청 중...' : '🔄 PTP 서버 재시작'}
                    </button>
                  </div>

                  {actionError && <p className="text-xs text-rose-600">{actionError}</p>}

                  {/* 최근 재시작 이력 */}
                  {status.history.length > 0 && (
                    <div>
                      <p className="text-xs font-semibold text-slate-500 mb-1">최근 재시작 이력</p>
                      <ul className="text-xs text-slate-500 space-y-0.5 max-h-32 overflow-y-auto">
                        {status.history.map((h, i) => (
                          <li key={i}>{formatClock(h.at)} · {TARGET_LABEL[h.target]} 재시작 ({TRIGGER_LABEL[h.trigger]})</li>
                        ))}
                      </ul>
                    </div>
                  )}

                  <p className="text-[11px] text-slate-400">
                    재시작 버튼 중 어느 것을 눌러도 워커/PTP 서버는 항상 같이 재시작됩니다(서로 독립된 DB
                    연결을 갖고 있어 한쪽만 재시작하면 다른 쪽에 문제가 남을 수 있음).
                  </p>
                </>
              )}
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
  )
}
