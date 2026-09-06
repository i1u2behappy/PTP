'use client'
import { useEffect, useRef, useState } from 'react'
import { setSystemOutageActive } from './GlobalErrorNet'

const NORMAL_POLL_MS = 20_000
const RESTARTING_POLL_MS = 4_000
const COUNTDOWN_TICK_MS = 1_000
// 워커 재시작 버튼을 누르면 실제로는 곧바로 안 끝난다 — 열려있던 로그인 세션을 정상 종료하고
// (closeAllOpenSessionsGracefully) 프로세스를 새로 띄우는 데 보통 10~30초, 세션이 여러 개 열려있으면
// 1분 넘게 걸리기도 한다(이번 세션 실측). 그런데 handleRestart의 POST 자체는 스케줄러 작업만 등록하고
// 금방(1~2초) 끝나버려서, 그 응답이 오는 순간 "재시작 중..." 표시가 풀리고 배너가 원래의 "⚠ 워커가
// 최신 코드를 반영 못했습니다 — 재시작해주세요"로 돌아간다 — 사용자 입장에선 방금 누른 걸 또 누르라는
// 것처럼 보여 헷갈린다(사용자 지적, 2026-09-06). 실제로 워커가 새로 뜨는 데 걸리는 시간(길게는 1분+)
// 동안은 결과가 뭐든(성공/아직 반영 전) "재시작 진행 중" 문구를 유지해 이 혼란을 없앤다 — 확정적인
// 에러 응답(스케줄러 등록 실패 등)이 오면 이 유예기간 중이라도 즉시 진짜 에러를 보여준다.
const WORKER_RESTART_GRACE_MS = 90_000

type Health = 'ok' | 'db-down' | 'server-down' | 'worker-booting' | 'worker-stale'

type WorkerBootStatus =
  | { status: 'unknown' | 'ready' | 'failed' }
  | { status: 'connecting-db'; attempt: number; maxAttempts: number; nextRetryAt: number }

type WorkerFreshness = { stale: boolean; staleFileCount?: number; staleFiles?: string[] }

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
  const [workerBoot, setWorkerBoot] = useState<WorkerBootStatus>({ status: 'unknown' })
  const [workerFreshness, setWorkerFreshness] = useState<WorkerFreshness>({ stale: false })
  const [restarting, setRestarting] = useState(false)
  const [restartError, setRestartError] = useState('')
  const [now, setNow] = useState(() => Date.now())
  // "워커 재시작" 버튼을 누른 시각 — restarting(POST 요청 자체의 진행 여부)과 달리, 실제 워커가 다시
  // 뜰 때까지의 유예기간을 재는 용도라 별도로 둔다(WORKER_RESTART_GRACE_MS 주석 참고).
  const [workerRestartRequestedAt, setWorkerRestartRequestedAt] = useState<number | null>(null)
  // 개발자모드는 3초 주기 폴링이 여러 개(미리보기 진행상황, 카테고리 큐 등) 동시에 돌아 pg Pool의 커넥션을
  // 순간적으로 다 써버릴 수 있다 — 그 사이 이 배너의 SELECT 1이 커넥션을 못 받아 3초 안에 응답 못 하면
  // Docker/Postgres는 멀쩡한데도 "DB 연결 실패"로 오탐한다(2026-09-05, 스크랩 미리보기 중 실사용 확인 —
  // 그 순간 이 요청과 무관한 다른 라우트들도 같이 지연되고 있었다, 즉 DB 자체 장애가 아니라 커넥션 경합).
  // 한 번의 실패로 바로 배너를 띄우지 않고 연속 2회(이 폴링 주기로 최소 20초) 실패해야 진짜 장애로 본다 —
  // 진짜 Docker/WSL 다운은 다음 주기에도 계속 실패하므로 여전히 잡아내고, 순간적인 경합은 다음 폴링 때
  // 이미 풀려 있어 걸러진다.
  const consecutiveDbDownRef = useRef(0)

  useEffect(() => {
    let cancelled = false
    async function check() {
      let next: Health = 'ok'
      try {
        const d = await fetch('/api/health/db').then(r => r.json())
        if (d.ok) {
          consecutiveDbDownRef.current = 0
          next = 'ok'
        } else {
          consecutiveDbDownRef.current++
          next = consecutiveDbDownRef.current >= 2 ? 'db-down' : 'ok'
        }
      } catch {
        next = 'server-down'
      }
      // PTP 서버 자체가 죽은 경우(server-down)엔 이 요청도 어차피 안 닿으므로 건너뛴다.
      let boot: WorkerBootStatus = { status: 'unknown' }
      let freshness: WorkerFreshness = { stale: false }
      if (next !== 'server-down') {
        try {
          boot = await fetch('/api/health/worker-boot').then(r => r.json())
        } catch { /* 워커 상태를 못 읽어도 기존 db/server 판단은 그대로 쓴다 */ }
        try {
          freshness = await fetch('/api/health/worker-freshness').then(r => r.json())
        } catch { /* 못 읽어도 기존 판단에 영향 없음 — 순수 부가 정보 */ }
      }
      if (cancelled) return
      // 워커가 DB 재연결을 자동으로 시도 중이면(재부팅 직후 최대 8분) — 사용자가 할 수 있는 일이 없는
      // 상태이므로, "재시작해주세요" 버튼 대신 진행 상황과 대략의 대기시간을 보여주는 쪽이 더 정확하다.
      // worker-stale은 db/server/booting보다 우선순위가 낮다 — 그쪽들이 이미 더 급한 문제를 설명 중이면
      // 굳이 겹쳐 보여주지 않는다.
      const effective: Health =
        boot.status === 'connecting-db' && next !== 'server-down' ? 'worker-booting'
        : next === 'ok' && freshness.stale ? 'worker-stale'
        : next
      setHealth(effective)
      setWorkerBoot(boot)
      setWorkerFreshness(freshness)
      // worker-stale은 실제 요청이 실패하는 상황이 아니다(그냥 예전 코드가 조용히 계속 도는 것) — 다른
      // 화면의 에러 토스트를 억누르는 setSystemOutageActive 대상에서는 뺀다(진짜 장애만 대상으로 유지).
      setSystemOutageActive(effective !== 'ok' && effective !== 'worker-stale')
      if (effective === 'ok' && restarting) setRestarting(false)
      // 워커가 실제로 다시 신선해졌으면(재시작 성공) 유예기간 표시도 같이 끝낸다 — 다음에 또 stale이
      // 감지됐을 때 이전 클릭 시각이 남아있어 엉뚱하게 "재시작 중"으로 잠깐 보이는 일이 없게 한다.
      if (effective === 'ok') setWorkerRestartRequestedAt(null)
    }
    check()
    const id = setInterval(check, restarting ? RESTARTING_POLL_MS : NORMAL_POLL_MS)
    return () => { cancelled = true; clearInterval(id) }
  }, [restarting])

  // "다음 시도까지 M초"를 실시간으로 줄어들게 보여주기 위한 1초 틱 — 실제 재시도는 위 폴링과 무관하게
  // 워커가 스스로의 일정대로 하고, 이건 어디까지나 화면에 보여줄 대략의 카운트다운일 뿐이다. 워커 재시작
  // 유예기간(WORKER_RESTART_GRACE_MS) 경과 여부도 같은 now로 판단하므로 그 동안에도 틱이 돌아야 한다.
  useEffect(() => {
    if (health !== 'worker-booting' && workerRestartRequestedAt == null) return
    const id = setInterval(() => setNow(Date.now()), COUNTDOWN_TICK_MS)
    return () => clearInterval(id)
  }, [health, workerRestartRequestedAt])

  // PTP 서버가 완전히 멈춘 상태(이벤트 루프 자체가 멈춘 경우 — 2026-08-07 Turbopack FATAL panic 실사례)라면
  // 이 재시작 요청도 결국 같은 죽은 프로세스가 처리해야 하므로 응답이 영영 오지 않는다 — fetch 자체엔 기본
  // 타임아웃이 없어 버튼이 "재시작 중..."에서 무한정 멈춰있게 된다. 몇 초 안에 응답이 없으면 요청이 서버에
  // 닿지 못한 것으로 보고, 브라우저로는 더 이상 해볼 수 있는 게 없다는 걸 바로 알려준다.
  //
  // 다만 이 "완전히 멈췄다" 진단은 PTP 서버 재시작 버튼에만 맞는 말이다 — 이 요청 자체를 그 죽었다는
  // 프로세스가 받아 처리해야 하니까. 워커/Docker 재시작은 다르다: 이 POST는 PTP 서버(지금 이 배너를
  // 그리고 있는 바로 그 프로세스)가 받아서 처리하므로, 그 서버는 멀쩡히 살아있고 그저 뒷단 작업(열려있는
  // 로그인 세션들을 정상 종료하는 등)이 6초보다 오래 걸렸을 뿐일 수 있다(2026-09-06 실사용 확인 —
  // 대량 스크랩이 돌던 중 워커 재시작을 눌렀더니 "서버가 완전히 멈췄다"는 문구가 떴는데, 실제로는 PTP
  // 서버도 화면도 멀쩡했고 워커 재시작 자체는 뒤에서 계속 진행 중이었다). timeoutMessage로 버튼마다 맞는
  // 문구를 받고, suppressTimeoutError면(워커 전용) 타임아웃을 아예 에러로 안 띄운다 — 위 유예기간
  // 배너(workerRestartRequestedAt)가 이미 "진행 중" 표시를 맡고 있고, 다음 상태 확인 때 진짜 끝났는지
  // 저절로 드러나기 때문이다.
  async function handleRestart(
    endpoint: string,
    opts: { timeoutMessage?: string; suppressTimeoutError?: boolean } = {},
  ) {
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
      if (!(isTimeout && opts.suppressTimeoutError)) {
        setRestartError(
          isTimeout
            ? opts.timeoutMessage
              ?? '서버가 요청조차 받지 못할 만큼 완전히 멈춘 것으로 보입니다 — 브라우저에서는 더 재시도할 수 없습니다. 매일 새벽 4시 자동 재시작을 기다리거나, PC에서 직접 서버를 재기동해주세요.'
            : '재시작 요청에 실패했습니다 (서버가 응답하지 않습니다)',
        )
      }
      setRestarting(false)
    }
  }

  if (health === 'ok') return null

  const remainingSec = workerBoot.status === 'connecting-db' ? Math.max(0, Math.round((workerBoot.nextRetryAt - now) / 1000)) : 0

  // worker-booting은 고장이 아니라 자동으로 알아서 풀리는 중이라는 걸 색으로도 구분한다. worker-stale도
  // 당장 뭔가 못 쓰게 막힌 건 아니라(그냥 예전 코드가 도는 것) 같은 amber로 — 나머지(db-down,
  // server-down)는 실제 조치(버튼)가 필요할 수 있는 상태라 기존대로 경고색(rose)을 유지한다.
  const bannerColor = health === 'worker-booting' || health === 'worker-stale' ? 'bg-amber-600' : 'bg-rose-600'

  return (
    <div className={`fixed top-0 inset-x-0 z-[60] ${bannerColor} text-white text-sm px-4 py-2 flex items-center justify-center gap-3 shadow-md`}>
      {health === 'worker-booting' && workerBoot.status === 'connecting-db' ? (
        <span>
          🔄 워커(스크래핑 작업 프로세스)가 재부팅 직후라 DB에 재연결 중입니다 — 자동으로 진행되니 잠시만
          기다려주세요. (재연결 시도 {workerBoot.attempt}/{workerBoot.maxAttempts}회, 다음 시도까지 약 {remainingSec}초 —
          준비되면 이 화면은 자동으로 사라집니다)
        </span>
      ) : health === 'worker-stale' ? (
        // 워커(tsx로 뜨는 별도 프로세스)는 파일 변경을 감지해 스스로 재시작하지 않는다 — lib/scraper.ts 등
        // 워커가 실행하는 코드를 고쳐도 재시작 전까지는 예전 코드가 그대로 계속 돈다(app/api/health/
        // worker-freshness 참고, 2026-09-05 — 이 사실을 두 번이나 깜빡해 "고쳤는데 왜 반영이 안 되냐"는
        // 문제로 이어져 배너로 자동 감지하게 만들었다).
        workerRestartRequestedAt != null && !restartError && now - workerRestartRequestedAt < WORKER_RESTART_GRACE_MS ? (
          // 버튼을 누른 뒤 워커가 실제로 다시 뜰 때까지(길면 1분 이상)는, POST 자체는 금방 끝나도(스케줄러
          // 작업만 등록) 이 화면 그대로 "재시작해주세요"로 되돌아가지 않고 진행 중 문구를 유지한다(위
          // WORKER_RESTART_GRACE_MS 주석 참고, 사용자 지적 — "또 재시작을 누르라고 나와서 헷갈려").
          <span>🔄 워커를 재시작하는 중입니다 — 완료되면 이 배너가 자동으로 사라집니다 (보통 10~30초, 길면 1분 이상 걸릴 수 있습니다).</span>
        ) : (
          <>
            <span>
              ⚠ 워커가 최신 코드를 반영하지 못했을 수 있습니다 — 재시작 이후 파일 {workerFreshness.staleFileCount}개가
              수정됐습니다{workerFreshness.staleFiles?.length ? ` (${workerFreshness.staleFiles.slice(0, 3).join(', ')}${workerFreshness.staleFiles.length > 3 ? ' 등' : ''})` : ''}.
            </span>
            {restartError && <span className="text-rose-100">({restartError})</span>}
            <button onClick={() => {
              setWorkerRestartRequestedAt(Date.now())
              handleRestart('/api/system/restart-worker', { suppressTimeoutError: true })
            }} disabled={restarting}
              title="워커 프로세스만 재시작합니다 — 열려있는 몰 로그인 세션은 정상 종료 처리 후 다시 로그인해야 할 수 있습니다."
              className="px-3 py-1 bg-white text-amber-700 rounded-full text-xs font-semibold hover:bg-amber-50 disabled:opacity-60 transition-colors">
              {restarting ? '워커 재시작 중...' : '🔄 워커 재시작'}
            </button>
          </>
        )
      ) : health === 'db-down' ? (
        <>
          {/* 실사용 확인(2026-08-31): 이 배너가 뜬 순간에도 postgres 컨테이너는 재시작된 적 없이(RestartCount:0)
              계속 떠있던 경우가 실제로 있었다 — "Docker가 꺼짐"은 재현되는 원인이 아니라, 버튼 옆 주석에
              적힌 진짜 흔한 원인(Docker Desktop은 떠 있는데 WSL2 네트워킹만 일시적으로 끊김)이 더 정확하다.
              사용자가 "Docker를 왜 꺼놨지?" 하고 엉뚱한 데서 원인을 찾지 않도록, 확인된 두 원인을 함께
              보여주고 버튼이 실제로 뭘 하는지·얼마나 걸리는지까지 미리 알려준다. */}
          <span>⚠ DB 연결 실패 — Docker Desktop이 꺼져있거나, WSL2 네트워킹이 일시적으로 끊겼을 수 있습니다.</span>
          {restartError && <span className="text-rose-200">({restartError})</span>}
          <button onClick={() => handleRestart('/api/system/restart-docker', {
            timeoutMessage: 'PTP 서버는 정상이지만, 6초 안에 응답이 없었습니다 — Docker/WSL 재시작 자체는 뒤에서 계속 진행 중일 수 있습니다. 잠시 후 배너가 사라지는지 확인해주세요.',
          })} disabled={restarting}
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
