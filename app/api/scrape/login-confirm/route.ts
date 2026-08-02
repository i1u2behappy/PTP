import { NextRequest, NextResponse } from 'next/server'
import { getOpenPageUrl } from '@/lib/scraper'

// 창은 닫지 않는다 — 사용자가 로그인 확인 후에도 그 창(세션)을 그대로 스크래핑에 재사용한다.
// 몰 구조 변경 감지는 여기서 하지 않는다 — '마이그레이션3_연속관리'로 옮겼다(app/api/master/mall-structure-check).
export async function POST(req: NextRequest) {
  const { siteId } = await req.json() as { siteId: number }
  if (!siteId) return NextResponse.json({ error: 'siteId required' }, { status: 400 })

  return NextResponse.json({ ok: true, currentUrl: getOpenPageUrl(siteId) })
}
