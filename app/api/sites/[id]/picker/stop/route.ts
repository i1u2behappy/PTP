import { NextRequest, NextResponse } from 'next/server'
import { stopElementPicker } from '@/lib/scraper'

/** "완료" — 주입된 피커의 하이라이트/클릭 리스너와 안내 패널을 제거한다. */
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const siteId = Number(id)
  if (!siteId) return NextResponse.json({ error: 'invalid site id' }, { status: 400 })

  await stopElementPicker(siteId)
  return NextResponse.json({ ok: true })
}
