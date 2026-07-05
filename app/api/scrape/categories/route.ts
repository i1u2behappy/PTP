import { NextRequest, NextResponse } from 'next/server'
import { discoverCategoryLinks } from '@/lib/scraper'

export async function POST(req: NextRequest) {
  const { siteId, url, loginId, loginPw } = await req.json() as {
    siteId?: number; url: string; loginId?: string; loginPw?: string
  }
  if (!url) return NextResponse.json({ error: 'url required' }, { status: 400 })

  const result = await discoverCategoryLinks({ url, siteId, loginId, loginPw })
  return NextResponse.json(result)
}
