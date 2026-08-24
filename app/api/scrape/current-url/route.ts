import { NextRequest, NextResponse } from 'next/server'
import { getOpenPageUrl } from '@/lib/workerClient'

export async function GET(req: NextRequest) {
  const siteId = Number(req.nextUrl.searchParams.get('siteId'))
  if (!siteId) return NextResponse.json({ error: 'siteId required' }, { status: 400 })

  return NextResponse.json({ url: await getOpenPageUrl(siteId) })
}
