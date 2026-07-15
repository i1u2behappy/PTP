import { NextRequest, NextResponse } from 'next/server'
import { generateForProducts } from '@/lib/transform/generate'

export async function POST(req: NextRequest) {
  const b = await req.json() as { siteId: number; mallProductIds: number[] }
  if (!b.siteId || !b.mallProductIds?.length) {
    return NextResponse.json({ error: 'siteId, mallProductIds required' }, { status: 400 })
  }
  const results = await generateForProducts(b.siteId, b.mallProductIds)
  return NextResponse.json(results)
}
