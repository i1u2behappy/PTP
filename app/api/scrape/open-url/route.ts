import { NextRequest, NextResponse } from 'next/server'
import { openUrlInLoginWindow } from '@/lib/scraper'

/** 로그인 창(있으면)에 새 탭으로 열어준다. 로그인 창이 없으면 opened:false — 호출부가 일반 새 탭으로 폴백한다. */
export async function POST(req: NextRequest) {
  const { siteId, url } = await req.json() as { siteId: number; url: string }
  if (!siteId || !url) return NextResponse.json({ error: 'siteId, url required' }, { status: 400 })

  const opened = await openUrlInLoginWindow(siteId, url)
  return NextResponse.json({ opened })
}
