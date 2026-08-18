import { NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'

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

/**
 * 개발자모드 확장 팝업의 "🧭 카테고리 하위구조 자동확인" 결과 저장. 회원전용 도매몰(모자사러 등)은
 * 서버가 개인 크롬 프로필을 통째로 복사해도 로그인 세션이 넘어오지 않아(!specifications/
 * manual-login-required-malls.md 2026-07-18/2026-08-18 항목), lib/scraper.ts의 discoverCategoryLinks
 * 하위 카테고리 자동 펼치기가 로그인 페이지에 막혀 항상 실패한다 — 대신 확장이 실제 로그인된 탭에서
 * 대분류마다 직접 방문해 상품 유무/하위메뉴를 확인(background.js의 runExpandCategories)하고 그 결과를
 * 여기로 보낸다. discoverCategoryLinks가 스스로 찾았을 때와 같은 자리(sites.scrape_profile.categoryLinks)에
 * 덮어써, "카테고리 불러오기"(app/api/scrape/categories/route.ts)가 다음 조회부터 캐시로 그대로 돌려준다.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const siteId = Number(id)
  if (!siteId) return NextResponse.json({ error: 'invalid site id' }, { status: 400, headers: corsHeaders() })

  const body = await req.json() as { links?: { name: string; href: string }[] }
  if (!body.links?.length) return NextResponse.json({ error: 'links required' }, { status: 400, headers: corsHeaders() })

  await pool.query(
    `UPDATE sites SET
       scrape_profile = COALESCE(scrape_profile, '{}'::jsonb) || jsonb_build_object('categoryLinks', $1::jsonb),
       scrape_profile_updated_at = NOW()
     WHERE id=$2`,
    [JSON.stringify(body.links), siteId],
  )
  return NextResponse.json({ ok: true, count: body.links.length }, { headers: corsHeaders() })
}
