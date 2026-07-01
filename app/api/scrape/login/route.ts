import { NextRequest, NextResponse } from 'next/server'
import { openLoginWindow } from '@/lib/scraper'

export async function POST(req: NextRequest) {
  const { siteId, url, loginId, loginPw } = await req.json() as {
    siteId: number; url: string; loginId?: string; loginPw?: string
  }
  if (!siteId || !url) return NextResponse.json({ error: 'siteId, url required' }, { status: 400 })

  await openLoginWindow(siteId, { url, loginId, loginPw })
  return NextResponse.json({ ok: true })
}
