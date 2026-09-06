import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { countDedupedProductUrls } from '@/lib/workerClient'

// as {...} 캐스팅은 타입 체커만 안심시킬 뿐 실제 요청 바디가 그 모양인지는 전혀 검증하지 않는다 —
// Zod로 바꿔 잘못된 타입(예: siteId가 문자열로 옴)이나 url/categoryUrls 둘 다 없는 요청을 "u가
// undefined인데 왜 실패했지" 대신 바로 원인이 보이는 400 에러로 걸러낸다(2026-08-23, 이 프로젝트에
// Zod를 처음 들여오며 만든 예시 — 나머지 라우트로 넓히는 건 별도 작업).
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
  // "카테고리별 정렬기준 설정" 기능용 — 카테고리마다 상한이 걸려있으면 "정확한 총 개수"도 그 상한을
  // 반영해서 보여준다(예: 3페이지까지만 담기로 했으면 그 3페이지 기준 정확한 개수).
  categoryLimits: z.record(z.string(), z.object({ mode: z.enum(['count', 'pages']), value: z.number() })).optional(),
  // AJAX(클릭) 방식 정렬용 — ScrapeOptions.categorySortClicks 참고
  categorySortClicks: z.record(z.string(), z.string()).optional(),
}).refine(b => !!b.url || !!b.categoryUrls?.length, { message: 'url required' })

/** "정확한 총 개수 확인" — previewCatalog의 카테고리별 빠른 합계와 달리, 선택한 모든 카테고리의 상품
 *  URL을 실제로 모아(실제 스크랩과 같은 방식) 중복 제거된 정확한 개수를 돌려준다. lib/scraper.ts의
 *  countDedupedProductUrls 주석 참고. */
export async function POST(req: NextRequest) {
  const parsed = RequestSchema.safeParse(await req.json())
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message || 'invalid request' }, { status: 400 })
  }

  try {
    // 미리보기 "중지"와 같은 방식 — 클라이언트가 이 요청을 abort하거나(중지 버튼) PTP 탭을 닫으면(연결
    // 종료) 그 신호를 두 번째 인자(signal)로 넘겨야 callWorker가 워커로 보낸 fetch도 같이 끊는다 —
    // opts 안에 stopSignal로 얹으면 AbortSignal이 JSON 직렬화가 안 돼 아무 효과가 없다(preview-catalog/
    // route.ts와 같은 버그, 2026-09-06 발견).
    const result = await countDedupedProductUrls(parsed.data, req.signal)
    return NextResponse.json(result)
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
}
