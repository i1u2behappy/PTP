import { NextRequest, NextResponse } from 'next/server'
import { openLoginWindow, openManualLoginWindow } from '@/lib/workerClient'

export async function POST(req: NextRequest) {
  const { siteId, url, loginId, loginPw, manualLogin } = await req.json() as {
    siteId: number; url: string; loginId?: string; loginPw?: string; manualLogin?: boolean
  }
  if (!siteId || !url) return NextResponse.json({ error: 'siteId, url required' }, { status: 400 })

  if (manualLogin) {
    await openManualLoginWindow(siteId, url)
  } else {
    await openLoginWindow(siteId, { url, loginId, loginPw })
  }
  return NextResponse.json({ ok: true })
}
