import { NextRequest, NextResponse } from 'next/server'
import { openUrlInLoginWindow } from '@/lib/scraper'

/** 로그인 창에 새 탭으로 열어준다. 로그인 창이 닫혀있으면 저장된 로그인 쿠키로 새 창을 띄워서 연다. */
export async function POST(req: NextRequest) {
  const { siteId, url } = await req.json() as { siteId: number; url: string }
  if (!siteId || !url) return NextResponse.json({ error: 'siteId, url required' }, { status: 400 })

  await openUrlInLoginWindow(siteId, url)
  return NextResponse.json({ ok: true })
}
