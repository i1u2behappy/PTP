import { NextRequest, NextResponse } from 'next/server'
import pool, { initDb } from '@/lib/db'
import { scrapeSingleProduct, scrapeCatalogPage, getOpenPageUrl, closeLoginWindow, type ScrapeResult } from '@/lib/scraper'
import { downloadProductImages } from '@/lib/images'
import { upsertMallProduct, markMissingAsDiscontinued } from '@/lib/scrape/incremental'

type ScopeType = 'all' | 'category' | 'products' | 'page_range'

interface ScrapeRequestBody {
  url?: string
  categoryUrls?: string[]
  productUrls?: string[]
  nextPageSelector?: string
  maxPages?: number
  delayMs?: number
  loginId?: string
  loginPw?: string
  mode: 'single' | 'catalog'
  scrapeMode?: 'full' | 'incremental'
  scopeType?: ScopeType
  productLinkSelector?: string
  siteId?: number
}

export async function POST(req: NextRequest) {
  await initDb()
  const body = await req.json() as ScrapeRequestBody

  if (!body.siteId) return NextResponse.json({ error: 'siteId required' }, { status: 400 })

  const resolvedUrl = body.url || body.categoryUrls?.[0] || body.productUrls?.[0] || getOpenPageUrl(body.siteId)
  if (!resolvedUrl) return NextResponse.json({ error: 'url required' }, { status: 400 })

  const scopeType = body.scopeType || (body.productUrls?.length ? 'products' : body.categoryUrls?.length ? 'category' : 'all')
  const scrapeMode = body.scrapeMode || 'full'

  const sessionRes = await pool.query<{ id: number }>(
    `INSERT INTO scrape_sessions (url, site_id, login_id, status, scope_type, mode)
     VALUES ($1,$2,$3,'running',$4,$5) RETURNING id`,
    [resolvedUrl, body.siteId, body.loginId || null, scopeType, scrapeMode],
  )
  const sessionId = sessionRes.rows[0].id

  // 비동기로 스크래핑 실행 (응답은 sessionId만 즉시 반환)
  runScraping(sessionId, body, scopeType, scrapeMode).catch(err => {
    pool.query(`UPDATE scrape_sessions SET status='error', error=$1 WHERE id=$2`, [String(err), sessionId])
  })

  return NextResponse.json({ sessionId })
}

async function saveProduct(siteId: number, sessionId: number, r: ScrapeResult) {
  const { id: mallProductId } = await upsertMallProduct({ siteId, sessionId }, r)
  await downloadProductImages(
    r.product.thumbnail_url,
    r.product.detail_image_urls || [],
    mallProductId,
    r.product.name,
  )
}

async function runScraping(sessionId: number, opts: ScrapeRequestBody, scopeType: ScopeType, scrapeMode: 'full' | 'incremental') {
  const siteId = opts.siteId!

  // 로그인 확인용으로 열어둔 화면은 여기서 닫는다 — 실제 스크래핑은 화면에 상품을 하나씩 띄우지 않고
  // 백그라운드(헤드리스)로 진행한다. 로그인 세션(쿠키)은 프로필 디렉터리에 저장되어 그대로 재사용된다.
  await closeLoginWindow(siteId)

  // 이미 스크랩된 상품(같은 몰)은 목록에서 발견되어도 건너뛴다 (이어서 스크랩하기)
  const excluded = await pool.query<{ source_url: string }>(
    `SELECT DISTINCT source_url FROM mall_products WHERE site_id=$1 AND source_url IS NOT NULL`,
    [siteId],
  )

  const scrapeOpts = {
    url: opts.url, categoryUrls: opts.categoryUrls, productUrls: opts.productUrls,
    nextPageSelector: opts.nextPageSelector, maxPages: opts.maxPages, delayMs: opts.delayMs,
    loginId: opts.loginId, loginPw: opts.loginPw, productLinkSelector: opts.productLinkSelector, siteId,
    excludeUrls: scrapeMode === 'incremental' ? [] : excluded.rows.map(r => r.source_url), sessionId,
  }

  if (opts.mode === 'single') {
    const result = await scrapeSingleProduct(scrapeOpts)
    await saveProduct(siteId, sessionId, result)
    await pool.query(`UPDATE scrape_sessions SET status='done', product_count=1 WHERE id=$1`, [sessionId])
    return
  }

  const { total, stopped } = await scrapeCatalogPage(scrapeOpts, async ({ total, result }) => {
    await pool.query(`UPDATE scrape_sessions SET product_count=$1 WHERE id=$2`, [total, sessionId])
    if (result) await saveProduct(siteId, sessionId, result)
  })

  if (!stopped && scrapeMode === 'incremental' && scopeType === 'all') {
    // 몰 전체를 다시 훑은 경우에만, 이번 회차에 없던 기존 상품을 단종 추정으로 표시한다.
    await markMissingAsDiscontinued(siteId, sessionId)
  }

  await pool.query(
    `UPDATE scrape_sessions SET status=$1, product_count=$2 WHERE id=$3`,
    [stopped ? 'stopped' : 'done', total, sessionId],
  )
}
