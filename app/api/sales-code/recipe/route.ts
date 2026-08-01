import { NextRequest, NextResponse } from 'next/server'
import { getRecipe, saveRecipe, type RecipeStep } from '@/lib/salesCode/generate'

/** 몰×거래처 조합 하나에 저장된 판매관리코드 생성 레시피(순차 스텝) */
export async function GET(req: NextRequest) {
  const siteId = Number(req.nextUrl.searchParams.get('siteId'))
  const clientId = Number(req.nextUrl.searchParams.get('clientId'))
  if (!siteId || !clientId) return NextResponse.json({ error: 'siteId/clientId required' }, { status: 400 })

  return NextResponse.json(await getRecipe(siteId, clientId))
}

export async function PUT(req: NextRequest) {
  const { siteId, clientId, steps } = await req.json() as { siteId?: number; clientId?: number; steps?: RecipeStep[] }
  if (!siteId || !clientId || !steps) return NextResponse.json({ error: 'siteId/clientId/steps required' }, { status: 400 })

  await saveRecipe(siteId, clientId, steps)
  return NextResponse.json({ ok: true })
}
