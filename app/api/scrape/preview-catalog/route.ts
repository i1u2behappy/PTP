import { NextRequest, NextResponse } from 'next/server'
import { previewCatalog, getOpenPageUrl } from '@/lib/scraper'

/** 카탈로그(목록) 모드용 — 상품 개수 확인과 첫 상품 미리보기를 한 번에 처리한다. */
export async function POST(req: NextRequest) {
  const body = await req.json() as {
    url?: string; categoryUrls?: string[]; nextPageSelector?: string; maxPages?: number
    productLinkSelector?: string; loginId?: string; loginPw?: string; siteId?: number
  }

  const resolvedUrl = body.url || body.categoryUrls?.[0] || (body.siteId ? getOpenPageUrl(body.siteId) : null)
  if (!resolvedUrl) return NextResponse.json({ error: 'url required' }, { status: 400 })

  const result = await previewCatalog(body)
  return NextResponse.json(result)
}
