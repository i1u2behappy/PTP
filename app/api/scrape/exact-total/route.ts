import { NextRequest, NextResponse } from 'next/server'
import { countDedupedProductUrls } from '@/lib/scraper'

/** "정확한 총 개수 확인" — previewCatalog의 카테고리별 빠른 합계와 달리, 선택한 모든 카테고리의 상품
 *  URL을 실제로 모아(실제 스크랩과 같은 방식) 중복 제거된 정확한 개수를 돌려준다. lib/scraper.ts의
 *  countDedupedProductUrls 주석 참고. */
export async function POST(req: NextRequest) {
  const body = await req.json() as {
    url?: string; categoryUrls?: string[]; nextPageSelector?: string
    productLinkSelector?: string; loginId?: string; loginPw?: string; siteId?: number
    concurrencyMode?: 'auto' | 'manual'; concurrency?: number
  }
  if (!body.url && !body.categoryUrls?.length) return NextResponse.json({ error: 'url required' }, { status: 400 })

  try {
    // 미리보기 "중지"와 같은 방식 — 클라이언트가 이 요청을 abort하면 그 신호를 그대로 넘겨 목록 수집이
    // 다음 페이지를 열기 전에 스스로 멈추게 한다.
    const result = await countDedupedProductUrls({ ...body, stopSignal: req.signal })
    return NextResponse.json(result)
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
}
