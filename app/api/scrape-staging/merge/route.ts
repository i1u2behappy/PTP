import { NextRequest, NextResponse } from 'next/server'
import { mergeStagingItems } from '@/lib/scrape/staging'

export async function POST(req: NextRequest) {
  const { ids, force } = await req.json() as { ids: number[]; force?: boolean }
  if (!ids?.length) return NextResponse.json({ error: 'ids required' }, { status: 400 })

  const result = await mergeStagingItems(ids, { force })
  return NextResponse.json(result)
}
