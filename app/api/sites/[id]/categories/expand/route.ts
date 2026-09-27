import { NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'
import { deriveCategoryUrlPattern } from '@/lib/scraper'
import { shouldKeepPreviousCategoryLinks } from '@/lib/scrape/categoryCachePolicy'

// chrome-extension:// 출처에서 오는 fetch라 CORS 프리플라이트(OPTIONS)를 직접 응답해야 하고,
// 로컬(사설망) 주소로 가는 요청이라 Private Network Access 헤더도 같이 내려줘야 브라우저가 막지 않는다.
function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Private-Network': 'true',
  }
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders() })
}

interface CachedProfile {
  categoryLinks?: { name: string; href: string }[]
  categoryLinksAiUsed?: boolean
  categoryUrlPattern?: string | null
}

/**
 * 개발자모드 확장 팝업의 "🧭 카테고리 하위구조 자동확인" 결과 저장. 회원전용 도매몰(모자사러 등)은
 * 서버가 개인 크롬 프로필을 통째로 복사해도 로그인 세션이 넘어오지 않아(!specifications/
 * manual-login-required-malls.md 2026-07-18/2026-08-18 항목), lib/scraper.ts의 discoverCategoryLinks
 * 하위 카테고리 자동 펼치기가 로그인 페이지에 막혀 항상 실패한다 — 대신 확장이 실제 로그인된 탭에서
 * 대분류마다 직접 방문해 상품 유무/하위메뉴를 확인(background.js의 runExpandCategories)하고 그 결과를
 * 여기로 보낸다. discoverCategoryLinks가 스스로 찾았을 때와 같은 자리(sites.scrape_profile.categoryLinks)에
 * 덮어써, "카테고리 불러오기"(app/api/scrape/categories/route.ts)가 다음 조회부터 캐시로 그대로 돌려준다.
 *
 * 2026-09-05 전수조사로 발견 — 이 라우트만 그 자매 라우트(app/api/scrape/categories/route.ts)에 있는
 * 두 가지 보호가 빠져 있었다:
 * 1. shouldKeepPreviousCategoryLinks 가드가 없어서, 이번 실행이 접속 차단으로 하위구조를 못 펼친 채
 *    끝나도(body.blocked) 그 부실한 결과로 예전에 잘 확인해둔 categoryLinks를 그냥 덮어썼다.
 * 2. categoryLinks를 바꿀 때마다 같이 갱신해야 하는 newCategoryHrefs/categoryUrlPattern을 이 라우트만
 *    안 건드려서, "새 카테고리 M개" 배지와 "기억해둔 URL 패턴" 재검증이 이 경로로 갱신된 카테고리에는
 *    계속 예전 값(또는 없음)으로 남아있었다.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const siteId = Number(id)
  if (!siteId) return NextResponse.json({ error: 'invalid site id' }, { status: 400, headers: corsHeaders() })

  const body = await req.json() as { links?: { name: string; href: string }[]; blocked?: boolean }
  if (!body.links?.length) return NextResponse.json({ error: 'links required' }, { status: 400, headers: corsHeaders() })

  const prevRes = await pool.query<{ scrape_profile: CachedProfile | null }>(
    `SELECT scrape_profile FROM sites WHERE id=$1`, [siteId],
  )
  const prevProfile = prevRes.rows[0]?.scrape_profile
  const prevCategoryLinks = prevProfile?.categoryLinks

  // 이 확장 경로는 AI를 전혀 안 쓰므로 freshAiUsed는 항상 false — "예전엔 AI가 성공해뒀는데 이번엔
  // 규칙(확장)만으로 떨어졌으면 지킨다"는 첫 번째 보호가 여기서도 그대로 의미가 있다(예전에 서버의
  // AI 기반 탐지가 성공해둔 결과를 확장의 순수 DOM 탐색 결과로 덮어쓰지 않음).
  const keepPrevious = shouldKeepPreviousCategoryLinks({
    freshAiUsed: false,
    freshLoginBlockedExpansion: !!body.blocked,
    freshCategoryLinksCount: body.links.length,
    prevAiUsed: !!prevProfile?.categoryLinksAiUsed,
    prevCategoryLinksCount: prevCategoryLinks?.length ?? 0,
    freshCategoryLinks: body.links,
    prevCategoryLinks,
  })
  if (keepPrevious) {
    return NextResponse.json({ ok: true, count: prevCategoryLinks?.length ?? 0, kept: true }, { headers: corsHeaders() })
  }

  const prevHrefSet = new Set((prevCategoryLinks || []).map(c => c.href))
  const newCategoryHrefs = body.links.filter(c => !prevHrefSet.has(c.href)).map(c => c.href)
  const categoryUrlPattern = deriveCategoryUrlPattern(body.links.map(l => l.href)) ?? prevProfile?.categoryUrlPattern ?? null

  await pool.query(
    `UPDATE sites SET
       scrape_profile = COALESCE(scrape_profile, '{}'::jsonb)
         || jsonb_build_object('categoryLinks', $1::jsonb, 'categoryLinksAiUsed', false,
              'categoryUrlPattern', $2::jsonb, 'newCategoryHrefs', $3::jsonb),
       scrape_profile_updated_at = NOW()
     WHERE id=$4`,
    [JSON.stringify(body.links), JSON.stringify(categoryUrlPattern), JSON.stringify(newCategoryHrefs), siteId],
  )
  return NextResponse.json({ ok: true, count: body.links.length }, { headers: corsHeaders() })
}
