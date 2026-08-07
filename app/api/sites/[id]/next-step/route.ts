import { NextRequest, NextResponse } from 'next/server'
import { getNextStepForSite } from '@/lib/scrape/nextStep'

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const siteId = Number(id)
  if (!siteId) return NextResponse.json({ error: 'invalid site id' }, { status: 400 })

  const nextStep = await getNextStepForSite(siteId)
  return NextResponse.json({ nextStep })
}
