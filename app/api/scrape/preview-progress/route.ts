import { NextRequest, NextResponse } from 'next/server'
import { getPreviewProgress } from '@/lib/scraper'

/** "🔍 스크랩 미리보기"가 도는 동안 화면이 폴링해 "카테고리 N/M 확인 중"을 보여준다 — 카테고리별
 *  개수 집계가 몰에 따라 오래 걸릴 수 있어(대형 카테고리가 많은 몰), 진행이 되고 있는지 최소한
 *  보이게 하기 위함. */
export async function GET(req: NextRequest) {
  const siteId = Number(req.nextUrl.searchParams.get('siteId'))
  if (!siteId) return NextResponse.json({ error: 'siteId required' }, { status: 400 })
  return NextResponse.json(getPreviewProgress(siteId) || { done: 0, total: 0 })
}
