import { NextRequest, NextResponse } from 'next/server'
import { migrateToMaster } from '@/lib/master/migrate'

export async function POST(req: NextRequest) {
  const { mallProductIds, clientId } = await req.json() as { mallProductIds: number[]; clientId?: number }
  if (!mallProductIds?.length) return NextResponse.json({ error: 'mallProductIds required' }, { status: 400 })

  const result = await migrateToMaster(mallProductIds, clientId || 1)
  return NextResponse.json(result)
}
