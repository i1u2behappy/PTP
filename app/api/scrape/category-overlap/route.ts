import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { countCategoryOverlap } from '@/lib/workerClient'

// exact-total/route.ts와 같은 이유(2026-08-23, 이 프로젝트에 Zod를 처음 들여오며 만든 예시)로 외부에서
// 오는 요청 바디를 그대로 신뢰하지 않고 검증한다.
const RequestSchema = z.object({
  url: z.string().optional(),
  categoryUrls: z.array(z.string()).optional(),
  nextPageSelector: z.string().optional(),
  productLinkSelector: z.string().optional(),
  loginId: z.string().optional(),
  loginPw: z.string().optional(),
  siteId: z.number().optional(),
  concurrencyMode: z.enum(['auto', 'manual']).optional(),
  concurrency: z.number().optional(),
  categoryLimits: z.record(z.string(), z.object({ mode: z.enum(['count', 'pages']), value: z.number() })).optional(),
  categorySortClicks: z.record(z.string(), z.string()).optional(),
}).refine(b => !!b.url || !!b.categoryUrls?.length, { message: 'url required' })

/** "카테고리별 중복 개수 확인" — exact-total과 같은 실제 수집을 하되, 총합 하나가 아니라 카테고리별로
 *  "몇 개 찾았고 그중 몇 개가 다른 카테고리와 겹쳐서 실제로는 몇 개만 새로 스크랩되는지" breakdown을
 *  돌려준다. lib/scraper.ts의 countCategoryOverlap 주석 참고. */
export async function POST(req: NextRequest) {
  const parsed = RequestSchema.safeParse(await req.json())
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message || 'invalid request' }, { status: 400 })
  }

  try {
    // exact-total/route.ts와 같은 이유로 signal은 두 번째 인자로 넘긴다(opts.stopSignal은 효과 없음,
    // 2026-09-06 발견).
    const result = await countCategoryOverlap(parsed.data, req.signal)
    return NextResponse.json(result)
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
}
