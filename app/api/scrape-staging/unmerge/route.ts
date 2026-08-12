import { NextRequest, NextResponse } from 'next/server'
import { unmergeStagingItems } from '@/lib/scrape/staging'

export async function POST(req: NextRequest) {
  const { ids } = await req.json() as { ids: number[] }
  if (!ids?.length) return NextResponse.json({ error: 'ids required' }, { status: 400 })

  const result = await unmergeStagingItems(ids)
  return NextResponse.json(result)
}
