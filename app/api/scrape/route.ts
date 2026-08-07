import { NextRequest, NextResponse } from 'next/server'
import pool, { initDb } from '@/lib/db'
import { getOpenPageUrl } from '@/lib/scraper'
import { runScraping } from '@/lib/scrape/run'

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

  // 예약/일괄 재스크랩이 그대로 재현할 수 있도록 이번 설정을 저장해둔다 (로그인 정보는 site에 이미 있으니 제외).
  // productUrls 지정 스크랩(실패 재시도 등)은 일회성이라 평소 설정을 덮어쓰지 않는다.
  if (!body.productUrls?.length) {
    await pool.query(`UPDATE sites SET last_scrape_config=$1 WHERE id=$2`, [
      JSON.stringify({
        mode: body.mode, url: body.url, categoryUrls: body.categoryUrls,
        productLinkSelector: body.productLinkSelector, nextPageSelector: body.nextPageSelector,
        maxPages: body.maxPages, delayMs: body.delayMs,
      }),
      body.siteId,
    ])
  }

  // 비동기로 스크래핑 실행 (응답은 sessionId만 즉시 반환)
  runScraping(sessionId, { ...body, siteId: body.siteId }).catch(err => {
    pool.query(`UPDATE scrape_sessions SET status='error', error=$1 WHERE id=$2`, [String(err), sessionId])
  })

  return NextResponse.json({ sessionId })
}
