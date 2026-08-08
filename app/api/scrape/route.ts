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

  // 이 몰에 이미 진행 중인 세션이 있으면 새로 만들지 않는다 — 버튼 두 번 클릭, 여러 탭, 예약 스크랩과
  // 수동 시작이 겹치는 경우 등으로 같은 몰에 세션이 두 개 동시에 도는 걸 막는다. withSiteLock(lib/
  // scraper.ts)이 실제 브라우저 자원은 순서대로 쓰게 막아주지만, 그것만 믿으면 두 번째 세션이 화면에는
  // "실행 중"으로 보이면서 실제로는 첫 번째가 끝날 때까지 아무 설명 없이 멈춰있는 것처럼 보인다 —
  // 여기서 미리 걸러 기존 세션에 그대로 연결해준다. (이 SELECT~INSERT 사이에도 이론적으로 아주 짧은
  // 경쟁이 남아있지만, 그래도 만들어지는 세션 row 하나가 더 느는 정도이고 실제 브라우저 작업은
  // withSiteLock이 순서대로 처리해 데이터가 섞이지는 않는다 — 최후 방어선은 그쪽이고 이건 사용자에게
  // 미리 설명해주기 위한 것.)
  const running = await pool.query<{ id: number }>(
    `SELECT id FROM scrape_sessions WHERE site_id=$1 AND status='running' LIMIT 1`, [body.siteId],
  )
  if (running.rows[0]) {
    return NextResponse.json(
      { error: '이 몰은 이미 스크래핑이 진행 중입니다 — 그 진행 상황에 연결합니다.', sessionId: running.rows[0].id },
      { status: 409 },
    )
  }

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
