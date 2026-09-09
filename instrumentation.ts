import { ensureStartedOnce } from './lib/onceGlobally'

// Next.js가 서버 시작 시 한 번만 불러주는 표준 훅(instrumentation.ts, 15.0.0부터 안정화 — 별도 플래그
// 불필요). console.log/warn/error에 타임스탬프를 붙여, .dev-server.log를 나중에 grep해서 "이 로그가
// 정확히 몇 시에 찍혔나"를 바로 알 수 있게 한다(2026-08-23 — "10초 전에 로고가 보였다"처럼 상대 시간을
// 물어봤을 때, 로그에 시각이 전혀 없어 앞뒤 요청 순서로만 추론해야 했던 게 계기). 기존 수백 곳의
// console.log 호출부를 하나하나 고치는 대신 여기서 한 번만 감싼다.
function timestamp(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

// register()는 Next.js가 서버 시작 시 "한 번만" 불러준다는 게 공식 계약이지만, lib/scheduler.ts에서
// 실측으로 확인한 것과 같은 이유(dev 서버가 라우트를 온디맨드로 컴파일하며 이 모듈이 서로 다른 번들
// 인스턴스로 여러 번 새로 평가될 수 있음, 2026-09-07)로 이 파일도 안전하지 않다 — register()가 두 번
// 이상 불리면 아래 setInterval(30초 워커 감시)이 그만큼 쌓여 워커 재기동 시도가 중복되고(예전에 겪은
// EADDRINUSE 충돌의 원인 후보), lastSpawnAt 쿨다운도 인스턴스마다 따로 놀아 무의미해진다. 원인/일반
// 해법은 lib/onceGlobally.ts 참고 — 같은 클래스의 사고가 이 프로젝트에서 반복돼 그 파일 하나로 통일했다.
export function register() {
  ensureStartedOnce('instrumentation-register', () => {
    const wrap = (orig: (...args: unknown[]) => void) => (...args: unknown[]) => orig(`[${timestamp()}]`, ...args)
    console.log = wrap(console.log.bind(console))
    console.warn = wrap(console.warn.bind(console))
    console.error = wrap(console.error.bind(console))

    // Playwright/로컬 Ollama 작업을 이 Next.js 프로세스와 분리된 워커 프로세스로 옮겼다(2026-08-23,
    // 사용자 요청 — "로고 화면이 계속 나오는" 원인이었던 Fast Refresh 강제 새로고침을 근본적으로 없애기
    // 위해서다. 원인: 이 프로세스가 스크래핑/AI로 CPU를 많이 쓰면 Next.js가 자기 빌드 매니페스트를
    // 순간적으로 깨진 상태로 읽어 "Error: Manifest file is empty"가 나고, Fast Refresh가 브라우저 탭을
    // 강제로 통째로 새로고침시켰다). 개발자가 `npm run worker`를 별도 터미널에서 매번 띄우게 하는 대신,
    // 이 서버가 시작될 때 워커가 이미 떠 있는지 확인하고 없으면 자동으로 띄운다 — "그냥 npm run dev만
    // 실행하면 된다"는 기존 경험을 그대로 유지하기 위함.
    ensureWorkerRunning().catch(e => console.error('[worker] 자동 기동 실패 — npm run worker로 직접 띄워주세요:', e))

    // dev:clean이 재시작마다 .next 캐시를 통째로 지우고 시작하다 보니(taskkill로 강제종료되면 캐시가
    // 손상되는 문제, 2c9c703의 대응) 재부팅 직후 사용자가 처음 여는 화면/API마다 webpack이 그 자리에서
    // 컴파일하느라 매번 10초 넘게 걸린다(실사용 확인, 2026-08-31 — /api/auth/me, /api/products 등이 각각
    // 10~14초). 서버가 뜨자마자 백그라운드로 같은 라우트들을 미리 한 번 불러 컴파일을 끝내두면, 사용자가
    // 실제로 브라우저를 열 때는 이미 컴파일이 끝나있어 체감 대기시간이 크게 줄어든다.
    warmUpRoutes().catch(e => console.error('[warmup] 예열 실패(치명적이지 않음 — 사용자가 처음 열 때 그만큼 느릴 뿐):', e))

    // 워커가 "운영 중에" 죽는 경우(예상 못한 크래시, DB 8분 재시도도 다 실패 등)를 아무도 못 살려주는
    // 공백이 있었다(2026-08-30 실사용 확인 — lib/workerRestart.ts의 자동재시작은 워커 자신의 setInterval에
    // 기대는데, 워커가 완전히 죽으면 그 감시 코드도 같이 죽어 스스로는 못 살아난다). 이 dev 서버 프로세스는
    // 워커와 별개 프로세스라 워커가 죽어도 계속 살아있으니, 여기서 30초마다 다시 확인해 죽어있으면
    // 되살리는 감시자 역할까지 겸한다 — ensureWorkerRunning 자체가 이미 "떠 있으면 그냥 둔다"는 멱등
    // 로직이라 그대로 반복 호출하면 된다.
    setInterval(() => {
      ensureWorkerRunning().catch(e => console.error('[worker] 주기 확인 중 재기동 실패:', e))
    }, 30_000)
  })
}

// 워커 자신의 DB 연결 재시도가 최대 8분까지 걸릴 수 있다(worker/index.ts의 initDbWithRetry) — 그동안은
// /health가 응답하지 않으므로, 그 8분 내내 30초마다 "아직도 안 떴네" 하고 또 다른 워커를 새로 띄우면
// 같은 포트를 두고 여러 프로세스가 경쟁하는 낭비가 생긴다. 마지막으로 새로 띄운 시각을 기억해뒀다가,
// 워커의 최대 재시도 시간보다 넉넉히 긴 쿨다운(10분) 안에는 재시도하지 않는다.
let lastSpawnAt = 0
const SPAWN_COOLDOWN_MS = 10 * 60 * 1000

async function ensureWorkerRunning() {
  if (process.env.NEXT_RUNTIME === 'edge') return
  const port = Number(process.env.WORKER_PORT) || 4801
  // 30초마다 반복 호출되므로, 정상일 때마다("이미 실행 중") 매번 로그를 남기면 .dev-server.log가
  // 이 문구로만 가득 찬다 — 실제로 다시 띄워야 했을 때(아래)만 로그를 남기고, 정상 확인은 조용히 넘어간다.
  const alreadyRunning = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(5_000) }).then(r => r.ok).catch(() => false)
  if (alreadyRunning) return
  if (Date.now() - lastSpawnAt < SPAWN_COOLDOWN_MS) return
  lastSpawnAt = Date.now()
  // instrumentation.ts는 webpack이 "instrument" 레이어(엣지 런타임과 호환되게 리졸브 규칙을 제한한
  // 특수 레이어)로 번들링해서, import('child_process')처럼 정적으로 보이는 요청은 위의 edge 체크로
  // 걸러내도(코드 자체는 살아있는 채로 번들에 들어가) "Module not found: Can't resolve 'child_process'"로
  // 빌드가 깨진다(실사용 확인, 2026-08-23). eval('require')는 webpack이 정적으로 분석할 수 없는
  // "불투명한" require라 이 레이어의 리졸브 규칙을 그냥 건너뛰고 실제 Node.js require로 넘어간다 —
  // Node 전용 내장 모듈을 이 파일에서 쓰려면 이 우회가 필요하다.
  const nodeRequire = eval('require') as NodeJS.Require
  const { spawn } = nodeRequire('child_process')
  const fs = nodeRequire('fs')
  const path = nodeRequire('path')
  // 워커 자신의 콘솔 출력(몰 구조분석 단계별 소요시간 등)을 이 프로세스의 .dev-server.log와 뒤섞으면
  // 어느 프로세스가 낸 로그인지 헷갈린다 — 별도 파일로 분리한다.
  const logPath = path.join(process.cwd(), '.worker.log')
  const logFd = fs.openSync(logPath, 'a')
  const workerEntry = path.join(process.cwd(), 'worker', 'index.ts')
  // --env-file=.env.local: env:process.env로 이 프로세스의 (이미 로드된) 환경변수를 넘겨주지만, 그것과
  // 무관하게 워커 스스로도 독립 실행(npm run worker, lib/workerRestart.ts의 재시작)에서 항상 같은 값을
  // 읽도록 맞춰둔다(같은 값이 이미 있으면 --env-file 쪽은 무시된다 — Node 공식 동작).
  // detached:true — 이 Next.js 프로세스가 재시작(수동 재시작 버튼, Fast Refresh 등)돼도 워커는 별개
  // 프로세스라 영향받지 않고 계속 산다. 그게 이 분리의 핵심 목적이다.
  const child = spawn(process.execPath, ['--env-file=.env.local', '--import', 'tsx', workerEntry], {
    cwd: process.cwd(),
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: process.env,
  })
  child.unref()
  console.log(`[worker] 새로 시작함 (pid=${child.pid}) — 로그: .worker.log`)
}

const WARMUP_TOTAL_TIMEOUT_MS = 30_000

/** 로그인이 있어야만 실제 코드에 닿는 화면/API('/', '/api/auth/me' 등)는 proxy.ts가 세션 쿠키 없이는
 *  라우트 코드를 아예 실행하지 않고 리다이렉트/401만 돌려준다 — 그러면 컴파일도 안 일어나 예열 효과가
 *  없다. 그래서 이 프로세스 안에서만 쓰고 버리는 내부 전용 세션 쿠키를 lib/auth.ts의 signSessionToken과
 *  똑같은 방식(HMAC-SHA256)으로 직접 만든다. lib/auth.ts를 그대로 import하지 않고 로직을 복사한 이유는
 *  위 ensureWorkerRunning 주석과 같다 — 이 파일은 webpack의 "instrument" 레이어로 번들링돼 상대경로
 *  모듈 import가 이 레이어의 제한된 리졸브 규칙에 걸릴 수 있고, crypto 같은 Node 내장 모듈만
 *  eval('require')로 안전하게 우회되는 게 이미 검증돼 있어 그 방식만 재사용한다. */
function buildWarmupSessionCookie(nodeRequire: NodeJS.Require): string | null {
  const key = process.env.CREDENTIALS_ENCRYPTION_KEY
  if (!key) return null
  const crypto = nodeRequire('crypto') as typeof import('crypto')
  // lib/auth.ts의 SESSION_COOKIE('ptp_session')와 페이로드 형태(username/role/exp)를 그대로 맞춰야
  // verifySessionToken이 유효한 토큰으로 인정한다 — role이 없으면 옛 토큰으로 보고 무효 처리하므로
  // (lib/auth.ts 주석 참고) 반드시 role까지 채워 보낸다.
  const payload = Buffer.from(JSON.stringify({ username: '__warmup__', role: 'admin', exp: Date.now() + 60_000 })).toString('base64url')
  const sig = crypto.createHmac('sha256', Buffer.from(key, 'hex')).update(payload).digest('base64url')
  return `ptp_session=${payload}.${sig}`
}

async function warmUpRoutes() {
  if (process.env.NEXT_RUNTIME === 'edge' || process.env.NODE_ENV === 'production') return
  const nodeRequire = eval('require') as NodeJS.Require
  const base = process.env.PTP_BASE_URL || 'http://localhost:3000'
  const startedAt = Date.now()

  // register()가 이 프로세스 자신의 HTTP 리스너가 열리기 전에 불릴 수 있다 — 열릴 때까지 짧게 재시도한다.
  while (Date.now() - startedAt < WARMUP_TOTAL_TIMEOUT_MS) {
    const up = await fetch(`${base}/api/health/db`, { signal: AbortSignal.timeout(2_000) }).then(() => true).catch(() => false)
    if (up) break
    await new Promise(r => setTimeout(r, 500))
  }

  const cookie = buildWarmupSessionCookie(nodeRequire)
  // 재부팅 직후 실사용에서 10초 넘게 걸린 걸로 확인된 화면/API만 우선 예열한다(2026-08-31) — 앱의 모든
  // 라우트를 다 도는 건 아니라서, 다른 화면에서 같은 콜드 컴파일 지연이 새로 확인되면 여기 추가한다.
  // clientId=1은 실사용 확인 당시의 실제 값 — 다르더라도 컴파일 자체는 똑같이 예열된다.
  const routes = ['/', '/api/health/db', '/api/health/worker-boot', '/api/auth/me', '/api/products', '/api/scrape-staging?status=pending', '/api/master?clientId=1']
  const results = await Promise.allSettled(routes.map(path =>
    fetch(`${base}${path}`, { headers: cookie ? { Cookie: cookie } : {}, signal: AbortSignal.timeout(60_000) }),
  ))
  const failed = results.filter(r => r.status === 'rejected').length
  console.log(`[warmup] 주요 화면/API ${routes.length}개 예열 완료(${failed > 0 ? `${failed}개 실패, ` : ''}${Date.now() - startedAt}ms)`)
}
