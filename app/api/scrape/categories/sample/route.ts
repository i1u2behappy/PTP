import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { recordManualCategorySample } from '@/lib/scraper'

const RequestSchema = z.object({
  siteId: z.number(),
  url: z.string(),
})

/** "몰 카테고리 선택 가져오기(반복)"에서 사용자가 카테고리를 하나 가져올 때마다 호출 — 순수 DB 작업이라
 *  (Playwright 불필요) 워커를 거치지 않고 이 라우트가 직접 처리한다(app/api/scrape/categories/route.ts가
 *  이미 scrape_profile을 직접 건드리는 것과 같은 방식). lib/scraper.ts의 recordManualCategorySample
 *  참고 — 이 URL을 scrape_profile.manualCategorySamples에 쌓고 categoryUrlPattern을 다시 역산해,
 *  다음번 자동 탐지(규칙 기반/AI)가 이 사용자 확인 내역을 그대로 참고하게 한다(사용자 요청, 2026-08-26). */
export async function POST(req: NextRequest) {
  const parsed = RequestSchema.safeParse(await req.json())
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message || 'invalid request' }, { status: 400 })
  }
  try {
    await recordManualCategorySample(parsed.data.siteId, parsed.data.url)
    return NextResponse.json({ ok: true })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
}
