import { NextRequest, NextResponse } from 'next/server'
import { requestStop } from '@/lib/scraper'

export async function POST(req: NextRequest) {
  const { sessionId } = await req.json() as { sessionId: number }
  if (!sessionId) return NextResponse.json({ error: 'sessionId required' }, { status: 400 })

  requestStop(sessionId)
  return NextResponse.json({ ok: true })
}
