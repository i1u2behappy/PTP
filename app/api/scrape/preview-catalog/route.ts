import { NextRequest, NextResponse } from 'next/server'
import { previewCatalog, getOpenPageUrl } from '@/lib/scraper'
import pool from '@/lib/db'
import type { ExtractionRule } from '@/lib/ai'

/** 카탈로그(목록) 모드용 — 상품 개수 확인과 첫 상품 미리보기를 한 번에 처리한다. */
export async function POST(req: NextRequest) {
  const body = await req.json() as {
    url?: string; categoryUrls?: string[]; nextPageSelector?: string; maxPages?: number
    productLinkSelector?: string; loginId?: string; loginPw?: string; siteId?: number
  }

  const resolvedUrl = body.url || body.categoryUrls?.[0] || (body.siteId ? getOpenPageUrl(body.siteId) : null)
  if (!resolvedUrl) return NextResponse.json({ error: 'url required' }, { status: 400 })

  try {
    // "요소 지정"으로 저장한 그 몰 전용 규칙을 미리보기에도 동일하게 적용한다 (app/api/scrape/preview 참고).
    let extractionRules: Record<string, ExtractionRule> | undefined
    if (body.siteId) {
      const res = await pool.query<{ extraction_rules: Record<string, ExtractionRule> | null }>(
        'SELECT extraction_rules FROM sites WHERE id=$1', [body.siteId],
      )
      extractionRules = res.rows[0]?.extraction_rules || undefined
    }
    const result = await previewCatalog({ ...body, extractionRules })
    return NextResponse.json(result)
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
}
