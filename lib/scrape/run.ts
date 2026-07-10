import pool from '../db'
import { scrapeSingleProduct, scrapeCatalogPage, closeLoginWindow } from '../scraper'
import { stageScrapedProduct } from './staging'
import type { ScrapeResult } from '../scraper'

export interface RunScrapingOpts {
  url?: string
  categoryUrls?: string[]
  productUrls?: string[]
  nextPageSelector?: string
  maxPages?: number
  delayMs?: number
  concurrency?: number
  loginId?: string
  loginPw?: string
  productLinkSelector?: string
  mode: 'single' | 'catalog'
  scrapeMode?: 'full' | 'incremental'
  siteId: number
}

async function saveProduct(siteId: number, sessionId: number, r: ScrapeResult) {
  // mall_products는 여기서 바로 갱신하지 않는다 — 결과는 scrape_staging_items에 대기하고,
  // 사용자가 "스크랩 검토" 화면에서 확인 후 병합해야 반영된다.
  await stageScrapedProduct({ siteId, sessionId }, r)
}

/** 스크랩 세션 하나를 실제로 실행한다. API 라우트와 예약/일괄 재스크랩 스케줄러가 공유한다. */
export async function runScraping(sessionId: number, opts: RunScrapingOpts) {
  const siteId = opts.siteId
  const scrapeMode = opts.scrapeMode || 'full'

  // 로그인 확인용으로 열어둔 화면은 여기서 닫는다 — 실제 스크래핑은 화면에 상품을 하나씩 띄우지 않고
  // 백그라운드(헤드리스)로 진행한다. 로그인 세션(쿠키)은 프로필 디렉터리에 저장되어 그대로 재사용된다.
  await closeLoginWindow(siteId)

  // 이미 스크랩된 상품(같은 몰)은 목록에서 발견되어도 건너뛴다 (이어서 스크랩하기)
  const excluded = await pool.query<{ source_url: string }>(
    `SELECT DISTINCT source_url FROM mall_products WHERE site_id=$1 AND source_url IS NOT NULL`,
    [siteId],
  )

  const siteRes = await pool.query<{ custom_name_selector: string | null; custom_price_selector: string | null; custom_thumbnail_selector: string | null }>(
    `SELECT custom_name_selector, custom_price_selector, custom_thumbnail_selector FROM sites WHERE id=$1`,
    [siteId],
  )
  const site = siteRes.rows[0]

  const scrapeOpts = {
    url: opts.url, categoryUrls: opts.categoryUrls, productUrls: opts.productUrls,
    nextPageSelector: opts.nextPageSelector, maxPages: opts.maxPages, delayMs: opts.delayMs,
    concurrency: opts.concurrency,
    loginId: opts.loginId, loginPw: opts.loginPw, productLinkSelector: opts.productLinkSelector, siteId,
    excludeUrls: scrapeMode === 'incremental' ? [] : excluded.rows.map(r => r.source_url), sessionId,
    nameSelector: site?.custom_name_selector || undefined,
    priceSelector: site?.custom_price_selector || undefined,
    thumbnailSelector: site?.custom_thumbnail_selector || undefined,
  }

  if (opts.mode === 'single') {
    const result = await scrapeSingleProduct(scrapeOpts)
    await saveProduct(siteId, sessionId, result)
    await pool.query(`UPDATE scrape_sessions SET status='done', product_count=1 WHERE id=$1`, [sessionId])
    return
  }

  const { total, stopped } = await scrapeCatalogPage(scrapeOpts, async ({ total, url, result, error }) => {
    await pool.query(`UPDATE scrape_sessions SET product_count=$1 WHERE id=$2`, [total, sessionId])
    await pool.query(
      `INSERT INTO scrape_item_log (session_id, url, status, error) VALUES ($1,$2,$3,$4)`,
      [sessionId, url, result ? 'success' : 'failed', error || null],
    )
    if (result) await saveProduct(siteId, sessionId, result)
  })

  // 단종 추정 판정은 스테이징 결과가 실제 병합된 뒤에만 의미가 있으므로 여기서 하지 않는다
  // (lib/scrape/staging.ts의 mergeSessionStaging에서 병합 시점에 수행).
  await pool.query(
    `UPDATE scrape_sessions SET status=$1, product_count=$2 WHERE id=$3`,
    [stopped ? 'stopped' : 'done', total, sessionId],
  )
}
