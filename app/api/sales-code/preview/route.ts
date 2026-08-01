import { NextRequest, NextResponse } from 'next/server'
import { previewRecipe } from '@/lib/salesCode/generate'

/** 저장된 레시피를 선택된 상품들에 적용해 코드 draft를 만든다(아직 product_master에 저장하지 않음) */
export async function POST(req: NextRequest) {
  const { siteId, clientId, mallProductIds } = await req.json() as { siteId?: number; clientId?: number; mallProductIds?: number[] }
  if (!siteId || !clientId || !mallProductIds?.length) return NextResponse.json({ error: 'siteId/clientId/mallProductIds required' }, { status: 400 })

  return NextResponse.json(await previewRecipe(siteId, clientId, mallProductIds))
}
