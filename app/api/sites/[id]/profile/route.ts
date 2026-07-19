import { NextRequest, NextResponse } from 'next/server'
import { runMallProfileCheck } from '@/lib/scrape/mallProfile'

/**
 * "몰 구조 파악" 버튼 — 로그인 확인 시점마다 조용히 도는 백그라운드 프로파일링(app/api/scrape/login-confirm)과
 * 같은 로직을 그 자리에서 즉시 실행하고 결과를 화면에 보여주기 위한 것. 로그인 창(openSessions)이 열려
 * 있어야 하므로, "로그인 확인" 이후에만 호출 가능하다.
 */
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const siteId = Number(id)
  if (!siteId) return NextResponse.json({ error: 'invalid site id' }, { status: 400 })

  const result = await runMallProfileCheck(siteId)
  if (!result) {
    return NextResponse.json({ error: '로그인 창이 열려있지 않거나, 이 페이지에서 몰 구조를 파악하지 못했습니다' }, { status: 400 })
  }
  return NextResponse.json(result)
}
