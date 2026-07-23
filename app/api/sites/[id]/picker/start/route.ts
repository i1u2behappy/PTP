import { NextRequest, NextResponse } from 'next/server'
import { startElementPicker } from '@/lib/scraper'

/**
 * "스크랩 대상 직접지정" 버튼 — 로그인 창(openSessions)이 열려있는 실제 몰 페이지에 클릭식 엘리먼트 피커를
 * 주입한다. "로그인 확인" 이후에만 호출 가능하다(로그인 창이 없으면 false).
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const siteId = Number(id)
  if (!siteId) return NextResponse.json({ error: 'invalid site id' }, { status: 400 })
  const { previewProduct, targetUrl } = await req.json().catch(() => ({})) as {
    previewProduct?: Record<string, unknown> | null; targetUrl?: string
  }

  const ok = await startElementPicker(siteId, previewProduct, targetUrl)
  if (!ok) return NextResponse.json({ error: '로그인 창이 열려있지 않습니다' }, { status: 400 })
  return NextResponse.json({ ok: true })
}
