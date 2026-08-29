import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { stopCategoryDiscovery } from '@/lib/workerClient'

const RequestSchema = z.object({ siteId: z.number() })

/**
 * "몰 카테고리 전체 가져오기" 진행 중 "중지" 버튼 — /api/sites/[id]/profile/stop(몰 구조분석 중지)과
 * 같은 패턴이다. lib/scraper.ts의 categoryDiscoveryAbortControllers에서 이 siteId의 AbortController를
 * 찾아 abort()한다 — 허브 펼치기 루프(expandWorker)가 새 카테고리를 더 꺼내지 않고, 지금까지 확인된
 * 부분 결과로 곧장 끝난다(사용자 요청, 2026-08-26).
 */
export async function POST(req: NextRequest) {
  const parsed = RequestSchema.safeParse(await req.json())
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message || 'invalid request' }, { status: 400 })
  }
  const stopped = await stopCategoryDiscovery(parsed.data.siteId)
  return NextResponse.json({ ok: true, stopped })
}
