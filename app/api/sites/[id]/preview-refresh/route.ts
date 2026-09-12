import { NextRequest, NextResponse } from 'next/server'
import { reExtractPreviewProduct } from '@/lib/workerClient'

/**
 * "스크랩 대상 직접지정" 패널에서 방금 컬럼을 저장한 뒤, PTP 화면의 미리보기 그리드도 그 결과를 바로
 * 보여주기 위해 부른다 — 이미 미리보기한 상품 1건만 가볍게 다시 추출한다(전체 "스크랩 미리보기"처럼
 * 카테고리 개수를 다시 세지 않는다 — lib/scraper.ts의 reExtractPreviewProduct 참고). 로그인 창이 없으면
 * (세션이 이미 닫힘 등) null.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const siteId = Number(id)
  if (!siteId) return NextResponse.json({ error: 'invalid site id' }, { status: 400 })
  const { url } = await req.json().catch(() => ({})) as { url?: string }
  if (!url) return NextResponse.json({ error: 'url required' }, { status: 400 })

  const preview = await reExtractPreviewProduct(siteId, url)
  return NextResponse.json({ preview })
}
