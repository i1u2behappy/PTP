import pool, { decryptSecret } from './db'
import { runScraping } from './scrape/run'

// ponytail: 단일 프로세스 in-memory 스케줄러. 여러 서버 인스턴스로 스케일하면 각자 따로 돌아 중복 실행될 수 있음.
let started = false

/** initDb()에서 호출된다 — 이미 시작됐으면 아무것도 하지 않아 여러 번 호출해도 안전하다. */
export function startScheduler() {
  if (started) return
  started = true
  setInterval(() => { checkSchedules().catch(() => {}) }, 60_000)
}

interface DueSite {
  id: number
  login_id: string | null
  login_pw_encrypted: string | null
  login_pw_iv: string | null
  last_scrape_config: { mode: 'single' | 'catalog'; url?: string; categoryUrls?: string[]; productLinkSelector?: string; nextPageSelector?: string; maxPages?: number; delayMs?: number; concurrency?: number } | null
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
    maxPages: config.maxPages, delayMs: config.delayMs, concurrency: config.concurrency,
    loginId: site.login_id || undefined,
    loginPw: decryptSecret(site.login_pw_encrypted, site.login_pw_iv) || undefined,
    scrapeMode: 'incremental',
    siteId: site.id,
  }).catch(err => {
    pool.query(`UPDATE scrape_sessions SET status='error', error=$1 WHERE id=$2`, [String(err), sessionId])
  })
}

/** "전체 Mall 재스크랩" — 마지막으로 사용한 스크랩 설정이 저장된 Mall을 전부 증분 재스크랩한다. */
export async function scrapeAllSites(): Promise<{ started: number; skipped: number }> {
  const sites = await pool.query<DueSite>(
    `SELECT id, login_id, login_pw_encrypted, login_pw_iv, last_scrape_config FROM sites WHERE last_scrape_config IS NOT NULL`,
  )
  for (const site of sites.rows) {
    triggerScheduledScrape(site).catch(() => {})
  }
  const totalRes = await pool.query(`SELECT COUNT(*) FROM sites`)
  return { started: sites.rows.length, skipped: Number(totalRes.rows[0].count) - sites.rows.length }
}
