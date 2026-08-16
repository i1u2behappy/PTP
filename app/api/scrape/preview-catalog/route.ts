import { NextRequest, NextResponse } from 'next/server'
import { previewCatalog, getOpenPageUrl } from '@/lib/scraper'
import pool from '@/lib/db'
import type { ExtractionRule } from '@/lib/ai'

/** 카탈로그(목록) 모드용 — 상품 개수 확인과 첫 상품 미리보기를 한 번에 처리한다. */
export async function POST(req: NextRequest) {
  const body = await req.json() as {
    url?: string; categoryUrls?: string[]; nextPageSelector?: string; maxPages?: number
    productLinkSelector?: string; loginId?: string; loginPw?: string; siteId?: number; aiMode?: boolean
    concurrencyMode?: 'auto' | 'manual'; concurrency?: number
  }

  const resolvedUrl = body.url || body.categoryUrls?.[0] || (body.siteId ? getOpenPageUrl(body.siteId) : null)
  if (!resolvedUrl) return NextResponse.json({ error: 'url required' }, { status: 400 })

  try {
    // "스크랩 대상 직접지정"으로 저장한 그 몰 전용 규칙을 미리보기에도 동일하게 적용한다 (app/api/scrape/preview 참고).
    let extractionRules: Record<string, ExtractionRule> | undefined
    // "몰 구조분석"이 이미 이 몰엔 읽을 수 있는 페이지네이션 위젯이 없다고 확인해뒀으면, 카테고리별
    // 개수 집계가 매번 같은 확인을 반복하지 않고 곧장 지수+이분 탐색으로 넘어가게 한다(knownNoPaginationWidget
    // 참고) — "몰구조파악 한 내용은 미리보기/스크래핑 때 반드시 참조돼야 한다"는 기존 원칙과 동일.
    let knownNoPaginationWidget = false
    if (body.siteId) {
      const res = await pool.query<{ extraction_rules: Record<string, ExtractionRule> | null, scrape_profile: { hasPaginationWidget?: boolean } | null }>(
        'SELECT extraction_rules, scrape_profile FROM sites WHERE id=$1', [body.siteId],
      )
      extractionRules = res.rows[0]?.extraction_rules || undefined
      knownNoPaginationWidget = res.rows[0]?.scrape_profile?.hasPaginationWidget === false
    }
    // 사용자가 미리보기 도중 "중지"를 누르면 클라이언트가 이 요청 자체를 abort한다 — 그 신호를 그대로
    // previewCatalog에 넘겨 카테고리 개수 집계 루프가 다음 페이지를 열기 전에 스스로 멈추게 한다.
    const result = await previewCatalog({ ...body, extractionRules, knownNoPaginationWidget, stopSignal: req.signal })
    return NextResponse.json(result)
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
}
