import { NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'

// chrome-extension:// 출처에서 오는 fetch라 CORS 프리플라이트(OPTIONS)를 직접 응답해야 하고,
// 로컬(사설망) 주소로 가는 요청이라 Private Network Access 헤더도 같이 내려줘야 브라우저가 막지 않는다.
function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Private-Network': 'true',
  }
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders() })
}

/**
 * 개발자모드 확장 팝업의 "📍 보조 - 현재 카테고리 가져오기" 결과 저장 — 일반모드의 "현재 카테고리
 * 가져오기"(서버가 로그인 창의 현재 URL을 직접 읽음, GET /api/scrape/current-url)와 같은 목적이지만,
 * 개발자모드는 서버가 사용자의 실제 몰 탭에 직접 접근할 수 없어 확장이 지금 탭 URL을 대신 여기 임시
 * 큐(sites.scrape_profile.categoryQueue)에 쌓아둔다. ScraperPanel이 몇 초마다 아래 GET으로 가져가면서
 * 큐를 비우므로(pop), 여러 번 눌러도 중복 전달 없이 계속 쌓인다.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const siteId = Number(id)
  if (!siteId) return NextResponse.json({ error: 'invalid site id' }, { status: 400, headers: corsHeaders() })

  const body = await req.json() as { url?: string }
  if (!body.url) return NextResponse.json({ error: 'url required' }, { status: 400, headers: corsHeaders() })

  await pool.query(
    `UPDATE sites SET
       scrape_profile = COALESCE(scrape_profile, '{}'::jsonb)
         || jsonb_build_object('categoryQueue',
              COALESCE(scrape_profile->'categoryQueue', '[]'::jsonb) || $1::jsonb),
       scrape_profile_updated_at = NOW()
     WHERE id=$2`,
    [JSON.stringify([body.url]), siteId],
  )
  return NextResponse.json({ ok: true }, { headers: corsHeaders() })
}

/** ScraperPanel(개발자모드)이 몇 초마다 폴링해서 가져간다 — 가져가는 즉시 큐를 비워 다음 폴링에 같은
 *  URL이 중복 반영되지 않게 한다. */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const siteId = Number(id)
  if (!siteId) return NextResponse.json({ error: 'invalid site id' }, { status: 400 })

  const res = await pool.query<{ q: string[] | null }>(
    `SELECT scrape_profile->'categoryQueue' AS q FROM sites WHERE id=$1`, [siteId],
  )
  const urls = res.rows[0]?.q || []
  if (urls.length) {
    await pool.query(
      `UPDATE sites SET scrape_profile = COALESCE(scrape_profile, '{}'::jsonb) || '{"categoryQueue":[]}'::jsonb WHERE id=$1`,
      [siteId],
    )
  }
  return NextResponse.json({ urls })
}
