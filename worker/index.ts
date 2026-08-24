import { initDb } from '../lib/db'
import { isAnySiteBusy } from '../lib/scraper'
import { restartWorker, isWorkerRestartInFlight } from '../lib/workerRestart'
import { startRpcServer } from './rpc-server'
import { startScreenRelayServer } from './screenRelay'
import { registerAll } from './registry'

// lib/scheduler.ts가 Next.js 프로세스 자신의 메모리(RSS)를 보고 자동 재시작하던 것과 같은 이유
// (Playwright를 오래 반복해서 쓰면 메모리가 계속 불어나며 안 줄어듦) — 워커 분리(2026-08-23) 이후로는
// Playwright/Ollama가 실제로 이 프로세스에서 도니, 감시 대상도 여기로 옮겨야 한다. 8코어16스레드/28GB
// 기준 임계치는 lib/scheduler.ts와 동일하게 6144MB로 맞춘다.
const MEMORY_RESTART_THRESHOLD_MB = 6144

function startMemoryWatch() {
  setInterval(() => { checkMemoryAndAutoRestart().catch(() => {}) }, 60_000)
}

async function checkMemoryAndAutoRestart() {
  if (isWorkerRestartInFlight()) return
  const rssMB = process.memoryUsage().rss / 1024 / 1024
  if (rssMB < MEMORY_RESTART_THRESHOLD_MB) return
  if (isAnySiteBusy()) {
    console.log(`[worker][autoRestart] 메모리 ${Math.round(rssMB)}MB로 임계치(${MEMORY_RESTART_THRESHOLD_MB}MB) 초과했지만, 진행 중인 몰 작업이 있어 이번엔 건너뜀`)
    return
  }
  console.log(`[worker][autoRestart] 메모리 ${Math.round(rssMB)}MB로 임계치(${MEMORY_RESTART_THRESHOLD_MB}MB) 초과 + 유휴 상태 확인 — 자동 재시작`)
  await restartWorker()
}

// Docker의 postgres 컨테이너가 재시작되는 순간과 이 워커의 기동이 겹치면(Docker Desktop 자체 재시작
// 등) initDb()가 ECONNREFUSED로 실패해 그대로 process.exit(1)— 누가 다시 띄워주지 않는 한 이후로
// "로그인 창 열기"를 포함한 모든 기능이 "워커 프로세스에 연결할 수 없습니다"로 계속 실패한다(실사용
// 확인, 2026-08-24 — DB는 몇 초 뒤 정상이었는데 워커만 그 짧은 창에 걸려 죽은 채로 남아있었다).
// initDb() 자체는 실패하면 캐시를 비워 재호출 시 처음부터 다시 시도하게 돼 있으므로(lib/db.ts 주석
// 참고), 여기서 몇 번 더 불러주기만 하면 된다 — Docker 컨테이너가 보통 몇 초 안에 다시 응답하는 걸
// 감안해 2초부터 시작해 매번 두 배로 늘려가며 5번(총 최대 62초) 시도하고, 그래도 안 되면 진짜 DB
// 문제로 보고 포기한다(무한 재시도로 조용히 멈춰있는 것보다 로그로 드러나는 게 낫다).
async function initDbWithRetry() {
  const maxAttempts = 5
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await initDb()
      return
    } catch (e) {
      if (attempt === maxAttempts) throw e
      const delayMs = 2_000 * 2 ** (attempt - 1)
      console.error(`[worker] DB 연결 실패(${attempt}/${maxAttempts}) — ${delayMs / 1000}초 뒤 재시도:`, e instanceof Error ? e.message : e)
      await new Promise(resolve => setTimeout(resolve, delayMs))
    }
  }
}

// PTP의 Playwright/로컬 Ollama 작업 전용 워커 프로세스 — Next.js 개발서버와 분리된 이유는
// instrumentation.ts 주석 참고. lib/db.ts를 이 프로세스에서도 그대로 쓰므로(자체 Postgres 연결 풀),
// DB 스키마 마이그레이션(initDb)도 이 프로세스 시작 시 한 번 돌려야 한다 — Next.js 서버가 이미 돌려둔
// 뒤에 이 워커가 뜨는 게 보통이라 대개는 아무 일도 안 하는 멱등 호출이지만(runMigrations은 이미
// CREATE TABLE IF NOT EXISTS/ADD COLUMN IF NOT EXISTS라 매번 실행해도 안전), 워커가 Next.js보다
// 먼저 뜨는 경우(수동 재시작 등)에도 스스로 준비를 끝낼 수 있게 한다.
async function main() {
  await initDbWithRetry()
  registerAll()
  const port = Number(process.env.WORKER_PORT) || 4801
  startRpcServer(port)
  // "원격으로 보기" 화면중계 — RPC 제어채널과 별도 포트에 둔다(worker/screenRelay.ts 주석 참고).
  // WORKER_SCREEN_HOST 기본값은 127.0.0.1(로컬 전용) — 실제로 원격/인터넷에 열 때만 ops가 바꾼다.
  startScreenRelayServer(Number(process.env.WORKER_SCREEN_PORT) || 4802, process.env.WORKER_SCREEN_HOST || '127.0.0.1')
  startMemoryWatch()
}

main().catch(e => {
  console.error('[worker] 시작 실패:', e)
  process.exit(1)
})
