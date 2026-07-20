import { NextRequest, NextResponse } from 'next/server'
import { runMallStructureReport } from '@/lib/scrape/mallProfile'

/**
 * "몰 구조 파악" 버튼 — 로그인 확인마다 조용히 도는 백그라운드 체크(app/api/scrape/login-confirm,
 * 구조 변화 감지 전용)와는 용도가 다르다. 이 버튼은 결제계좌/택배사/업체연락처/URL 계층 등 거래정보를
 * AI로 분석하는 무거운 작업(runMallStructureReport)을 그 자리에서 즉시 실행하고 결과를 화면에 보여준다.
 * 로그인 창(openSessions)이 열려있어야 하므로, "로그인 확인" 이후에만 호출 가능하다.
 */
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const siteId = Number(id)
  if (!siteId) return NextResponse.json({ error: 'invalid site id' }, { status: 400 })

  const result = await runMallStructureReport(siteId)
  if (!result) {
    return NextResponse.json({ error: '로그인 창이 열려있지 않거나, 이 페이지에서 몰 구조를 파악하지 못했습니다' }, { status: 400 })
  }
  return NextResponse.json(result)
}
