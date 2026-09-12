import pool, { decryptSecret } from './db'
import { runScraping, isAnySiteBusy } from './workerClient'
import { restartPtpServer, isRestartInFlight } from './systemRestart'
import { ensureStartedOnce } from './onceGlobally'

// ponytail: 단일 프로세스 in-memory 스케줄러. 여러 서버 인스턴스로 스케일하면 각자 따로 돌아 중복 실행될 수 있음.
//
// 예전엔 이 중복 실행 방지를 일반 모듈 스코프 변수(`let started`)로 짰다가 실사용에서 사고가 났다
// (2026-09-07 실측 — pg_stat_activity에 auto_scrape_hour 조회가 동시에 7~8개씩 떠 있는 걸 발견,
// checkSchedules() 하나가 60초마다 한 번씩만 돌아야 정상인데 매번 여러 번 겹쳐 돌고 있었다). 원인/일반
// 해법은 lib/onceGlobally.ts 참고 — 이 프로젝트에서 같은 클래스의 사고가 반복돼(siteLocks/keepAwake/
// devPreviewStatus/profileAbortControllers 등) 그 파일 하나로 통일했다.
export function startScheduler() {
  ensureStartedOnce('scheduler', () => {
    setInterval(() => { checkSchedules().catch(() => {}) }, 60_000)
    setInterval(() => { checkMemoryAndAutoRestart().catch(() => {}) }, 60_000)
  })
}

// ponytail: 2026-08-09 실사용 확인 — 평소엔 300~700MB인 이 서버 프로세스가, 스크랩/미리보기를 많이
// 반복한 하루 뒤 3.65GB까지 불어난 채 안 줄어들어(V8이 한 번 늘린 힙을 스스로 OS에 안 돌려줌) 미리보기가
// 멈추고 화면 진행상황이 사라지는 사고로 이어졌다(메모리 부족 → dev 서버 불안정 → Fast Refresh 강제
// 새로고침으로 React 상태 초기화, [[scrape-preview-catalog-count-and-target-ui]] 스펙에 이미 기록된
// 증상). 사용자가 눈치채고 수동으로 재시작 버튼을 누르기 전에, 조용히 스스로 정리한다.
// 2026-08-20 PC 업그레이드(8코어16스레드/28GB)로 1536MB는 지나치게 보수적이라 6144MB로 상향.
export const MEMORY_RESTART_THRESHOLD_MB = 6144

/** 이 서버 프로세스 자신의 메모리(RSS)가 임계치를 넘었고, 지금 어떤 몰이든 브라우저 세션을 쓰는 작업이
 *  진행 중이 아니면(isAnySiteBusy) 조용히 재시작한다 — 작업 중간에 끼어들어 진행상황을 날리는 걸
 *  막는 게 최우선이라, "지금 당장은 아니어도 다음 유휴 순간에" 정리되는 것으로 충분하다고 판단했다.
 *  재시작 자체가 이 프로세스를 죽이므로, 재시작 뒤 새 프로세스는 낮은 메모리로 다시 시작해 당장 또
 *  걸릴 일이 없다 — 그래서 "얼마 전에 이미 재시작했다"를 따로 기억해두는 코드가 필요 없다. */
async function checkMemoryAndAutoRestart() {
  if (isRestartInFlight()) return
  const rssMB = process.memoryUsage().rss / 1024 / 1024
  if (rssMB < MEMORY_RESTART_THRESHOLD_MB) return
  if (await isAnySiteBusy()) {
    console.log(`[autoRestart] 메모리 ${Math.round(rssMB)}MB로 임계치(${MEMORY_RESTART_THRESHOLD_MB}MB) 초과했지만, 진행 중인 몰 작업이 있어 이번엔 건너뜀`)
    return
  }
  console.log(`[autoRestart] 메모리 ${Math.round(rssMB)}MB로 임계치(${MEMORY_RESTART_THRESHOLD_MB}MB) 초과 + 유휴 상태 확인 — 자동 재시작`)
  await restartPtpServer('auto')
}

interface DueSite {
  id: number
  login_id: string | null
  login_pw_encrypted: string | null
  login_pw_iv: string | null
  last_scrape_config: {
    mode: 'single' | 'catalog'; url?: string; categoryUrls?: string[]; productLinkSelector?: string; nextPageSelector?: string; maxPages?: number; delayMs?: number
    concurrencyMode?: 'auto' | 'manual'; concurrency?: number
  } | null
}

async function checkSchedules() {
  const now = new Date()
  const hour = now.getHours()
  const today = now.toISOString().slice(0, 10)

  const due = await pool.query<DueSite>(
    `SELECT id, login_id, login_pw_encrypted, login_pw_iv, last_scrape_config FROM sites
     WHERE auto_scrape_enabled = true AND auto_scrape_hour = $1
       AND (last_auto_scrape_date IS DISTINCT FROM $2::date)
       AND last_scrape_config IS NOT NULL`,
    [hour, today],
  )
  for (const site of due.rows) {
    await pool.query(`UPDATE sites SET last_auto_scrape_date=$1 WHERE id=$2`, [today, site.id])
    triggerScheduledScrape(site).catch(() => {})
  }
}

async function triggerScheduledScrape(site: DueSite) {
  const config = site.last_scrape_config!
  const sessionRes = await pool.query<{ id: number }>(
    `INSERT INTO scrape_sessions (url, site_id, login_id, status, scope_type, mode)
     VALUES ($1,$2,$3,'running',$4,'incremental') RETURNING id`,
    [config.url || config.categoryUrls?.[0] || '', site.id, site.login_id, config.categoryUrls?.length ? 'category' : 'all'],
  )
  const sessionId = sessionRes.rows[0].id

  await runScraping(sessionId, {
    mode: config.mode, url: config.url, categoryUrls: config.categoryUrls,
    productLinkSelector: config.productLinkSelector, nextPageSelector: config.nextPageSelector,
    maxPages: config.maxPages, delayMs: config.delayMs,
    concurrencyMode: config.concurrencyMode, concurrency: config.concurrency,
    loginId: site.login_id || undefined,
    loginPw: decryptSecret(site.login_pw_encrypted, site.login_pw_iv) || undefined,
    scrapeMode: 'incremental',
    siteId: site.id,
  }).catch(err => {
    pool.query(`UPDATE scrape_sessions SET status='error', error=$1 WHERE id=$2`, [String(err), sessionId])
  })
}
