import { NextRequest, NextResponse } from 'next/server'
import { testCatalogSelectors, getOpenPageUrl } from '@/lib/scraper'

export async function POST(req: NextRequest) {
  const body = await req.json() as {
    url?: string; categoryUrls?: string[]; nextPageSelector?: string; maxPages?: number
    productLinkSelector?: string; loginId?: string; loginPw?: string; siteId?: number
  }

  const resolvedUrl = body.url || body.categoryUrls?.[0] || (body.siteId ? getOpenPageUrl(body.siteId) : null)
  if (!resolvedUrl) return NextResponse.json({ error: 'url required' }, { status: 400 })

  const result = await testCatalogSelectors(body)
  return NextResponse.json(result)
}
