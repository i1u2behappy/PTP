import { NextRequest, NextResponse } from 'next/server'
import pool, { initDb } from '@/lib/db'
import { getOpenPageUrl } from '@/lib/scraper'
import { runScraping } from '@/lib/scrape/run'
import { clearStalePendingIfConfigChanged } from '@/lib/scrape/staging'
import type { ExtractionRule } from '@/lib/ai'

type ScopeType = 'all' | 'category' | 'products' | 'page_range'

type ExtractionRules = Record<string, ExtractionRule>

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
  concurrencyMode?: 'auto' | 'manual'
  concurrency?: number
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

  const siteRow = await pool.query<{ extraction_rules: ExtractionRules | null }>(
    `SELECT extraction_rules FROM sites WHERE id=$1`, [body.siteId],
  )
  const currentRules = siteRow.rows[0]?.extraction_rules || {}

  // "이어서 스크랩하기"(중지/오류 세션 재시작)는 그 세션이 멈춘 시점의 카테고리/추출 규칙과 지금 설정이
  // 같을 때만 진짜 "이어서"다 — 그 사이 카테고리를 바꾸거나 "스크랩 대상 직접지정"/AI모드로 추출 규칙을
  // 고쳤다면, 중지 전 미검토 결과는 옛 규칙으로 뽑힌 것이라 그대로 이어가면 같은 몰 안에 옛 규칙/새 규칙
  // 데이터가 섞인다. productUrls 지정 스크랩(실패 재시도)은 이 판단과 무관한 별개 용도라 제외한다
  // (사용자 확인, 2026-08-15 — 설정이 바뀌면 자동으로 "새로 시작" 취급하고, 그 중지된 세션이 만들어둔
  // 미검토(pending) staging 결과만 지운다. 이미 확정/병합된 결과나 다른 세션 결과는 건드리지 않는다).
  // 개발자모드(extension-ingest)도 같은 함수를 공유한다.
  if (!body.productUrls?.length) {
    await clearStalePendingIfConfigChanged(body.siteId, { categoryUrls: body.categoryUrls || [], url: resolvedUrl, extractionRules: currentRules })
  }

  // scope_params에 실제 선택된 카테고리 URL 목록/그 시점 추출 규칙을 남겨둔다 — 나중에 "이 몰에서 어떤
  // 카테고리를 이미 스크랩했는지"를 세션 기록에서 되짚어보는 데(부분적으로 나눠 스크랩하는 경우,
  // /api/scrape/categories가 이 값을 모아 카테고리 목록에 "완료" 표시를 붙이는 데 씀), 그리고 다음
  // 재시작 때 위 "설정이 바뀌었는지" 판단의 기준으로 쓴다.
  const sessionRes = await pool.query<{ id: number }>(
    `INSERT INTO scrape_sessions (url, site_id, login_id, status, scope_type, mode, scope_params)
     VALUES ($1,$2,$3,'running',$4,$5,$6) RETURNING id`,
    [resolvedUrl, body.siteId, body.loginId || null, scopeType, scrapeMode,
     JSON.stringify({ categoryUrls: body.categoryUrls || [], extractionRules: currentRules })],
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
        concurrencyMode: body.concurrencyMode, concurrency: body.concurrency,
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
