import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { expandCategoryChildren } from '@/lib/workerClient'

// 이 프로젝트의 Zod 도입 예시(app/api/scrape/exact-total/route.ts)와 같은 이유로 외부 요청 바디를 검증한다.
const RequestSchema = z.object({
  siteId: z.number(),
  url: z.string(),
  name: z.string().optional(),
})

/** "몰 카테고리 선택 가져오기(반복)" 탭 — 사용자가 직접 가져온 카테고리 하나를 "하위 카테고리 있음"으로
 *  체크하고 눌렀을 때, 그 카테고리 페이지만 열어 하위 메뉴를 찾아 반환한다. lib/scraper.ts의
 *  expandCategoryChildren 참고 — 자동 최상위 탐지 없이 이 URL 하나만 대상으로 하므로, 최상위 탐지
 *  자체가 실패하는 몰에서도 쓸 수 있다(신우 실사용 확인, 2026-08-26). */
export async function POST(req: NextRequest) {
  const parsed = RequestSchema.safeParse(await req.json())
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message || 'invalid request' }, { status: 400 })
  }
  const { siteId, url, name } = parsed.data
  try {
    // allowStaleManualLoginProfile: 개발자모드(직접로그인 필수) 몰은 사용자가 실제 크롬을 켜둔 채 쓰는 게
    // 정상 상태라, 프로필 복사 시 세션 파일 잠금으로 완전한 복사가 실패하는 게 흔하다 — 이 플래그가 없으면
    // withContext가 그 실패를 그대로 던져 이 라우트가 500을 낸다. 같은 이유로 이미 고친 4곳(!specifications/
    // manual-login-required-malls.md "버그 2" 참고: categories/route.ts, mall-structure-check/route.ts,
    // recheck/route.ts, products/[id]/rescrape/route.ts)과 같은 패턴인데 이 라우트("카테고리 선택
    // 가져오기(반복)"의 하위 카테고리 확인)만 빠져 있었다(펫토리 실사용 확인, 2026-09-19 — 시스템 상태는
    // 전부 정상인데 이 라우트만 500이 나던 원인).
    const result = await expandCategoryChildren({ siteId, url, allowStaleManualLoginProfile: true }, url, name || '')
    return NextResponse.json(result)
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
}
