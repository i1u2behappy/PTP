import { NextRequest, NextResponse } from 'next/server'
import { getOpenPageUrl } from '@/lib/scraper'
import { runMallProfileCheck } from '@/lib/scrape/mallProfile'

// 창은 닫지 않는다 — 사용자가 로그인 확인 후에도 그 창(세션)을 그대로 스크래핑에 재사용한다.
export async function POST(req: NextRequest) {
  const { siteId } = await req.json() as { siteId: number }
  if (!siteId) return NextResponse.json({ error: 'siteId required' }, { status: 400 })

  // 응답을 지연시키지 않도록 백그라운드로 실행 — 최초 1회는 기준정보로 저장하고, 이후엔 구조가 달라졌을
  // 때만 Mall 메모에 알림을 남긴다 (완료까지 몇 초~수십 초 걸릴 수 있음).
  runMallProfileCheck(siteId).catch(err => console.error('[mallProfileCheck]', err))

  return NextResponse.json({ ok: true, currentUrl: getOpenPageUrl(siteId) })
}
