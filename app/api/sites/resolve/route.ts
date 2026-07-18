import { NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'

// chrome-extension:// 출처에서 오는 fetch라 CORS 프리플라이트(OPTIONS)를 직접 응답해야 하고,
// 로컬(사설망) 주소로 가는 요청이라 Private Network Access 헤더도 같이 내려줘야 브라우저가 막지 않는다.
function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Private-Network': 'true',
  }
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders() })
}

/**
 * 개발자모드(크롬 확장) 몰 공용 조회 — 확장이 지금 보고 있는 탭의 호스트명으로 이 몰이 어느 site_id인지
 * 물어본다. 확장에 몰별 siteId를 하드코딩하지 않아도, Mall 관리에서 체크박스만 켜면 새 몰도 그대로
 * 인식되게 하기 위함(sites.manual_login_required = true인 몰만 대상으로 좁힌다).
 */
export async function GET(req: NextRequest) {
  const host = req.nextUrl.searchParams.get('host')
  if (!host) return NextResponse.json({ error: 'host required' }, { status: 400, headers: corsHeaders() })

  const res = await pool.query<{ id: number; name: string | null; url: string }>(
    `SELECT id, name, url FROM sites WHERE manual_login_required = true`,
  )
  const match = res.rows.find(row => {
    try { return new URL(row.url).hostname === host } catch { return false }
  })
  if (!match) return NextResponse.json({ error: 'not found' }, { status: 404, headers: corsHeaders() })

  return NextResponse.json({ id: match.id, name: match.name }, { headers: corsHeaders() })
}
