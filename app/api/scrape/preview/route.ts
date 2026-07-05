import { NextRequest, NextResponse } from 'next/server'
import { scrapeSingleProduct } from '@/lib/scraper'

/** 실제로 상품 페이지 하나를 열어 추출 결과만 보여준다 (DB 저장 없음). */
export async function POST(req: NextRequest) {
  const body = await req.json() as {
    url: string; siteId?: number; loginId?: string; loginPw?: string
  }
  if (!body.url) return NextResponse.json({ error: 'url required' }, { status: 400 })

  const result = await scrapeSingleProduct(body)
  return NextResponse.json(result)
}
