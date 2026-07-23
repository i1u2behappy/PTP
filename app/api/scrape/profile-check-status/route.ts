import { NextRequest, NextResponse } from 'next/server'
import { isProfileCheckInProgress } from '@/lib/scrape/mallProfile'

/** "로그인 확인" 직후 도는 백그라운드 구조 체크가 아직 진행 중인지 — 진행 중엔 "로그인 확인" 버튼을
 *  깜빡여서, 같은 탭을 쓰는 다른 기능과 겹쳐 조용히 결과가 틀어지는 걸 사용자가 피하도록 안내한다. */
export async function GET(req: NextRequest) {
  const siteId = Number(req.nextUrl.searchParams.get('siteId'))
  if (!siteId) return NextResponse.json({ error: 'siteId required' }, { status: 400 })

  return NextResponse.json({ inProgress: isProfileCheckInProgress(siteId) })
}
