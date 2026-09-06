import { NextRequest, NextResponse } from 'next/server'
import { mergeStagingItems } from '@/lib/scrape/staging'
import { ensureDevKeepAwakeWatcherStarted } from '@/lib/devKeepAwake'

export async function POST(req: NextRequest) {
  const { ids, force } = await req.json() as { ids: number[]; force?: boolean }
  if (!ids?.length) return NextResponse.json({ error: 'ids required' }, { status: 400 })

  // "확정"은 항목이 많으면(이미지 다운로드 등) 몇 시간씩 걸릴 수 있는데 withSiteLock을 안 거쳐 절전방지가
  // 안 걸려 있었다(lib/devKeepAwake.ts 주석 참고, 사용자 지적 2026-09-06) — 시작 전에 감시를 깨워둔다.
  ensureDevKeepAwakeWatcherStarted()
  const result = await mergeStagingItems(ids, { force })
  return NextResponse.json(result)
}
