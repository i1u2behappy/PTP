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

/** "www.sinwoo.com"과 "sinwoo.com"처럼 www 유무만 다른 같은 사이트를 같은 것으로 취급한다 —
 * Mall 등록 URL과 실제로 사용자가 브라우저에서 열어본 주소가 www 유무만 다를 수 있다. */
function normalizeHost(host: string): string {
  return host.replace(/^www\./i, '')
}

/**
 * 개발자모드(크롬 확장) 몰 공용 조회 — 확장이 지금 보고 있는 탭의 호스트명으로 이 몰이 어느 site_id인지
 * 물어본다. 확장에 몰별 siteId를 하드코딩하지 않아도, Mall 관리에서 체크박스만 켜면 새 몰도 그대로
 * 인식되게 하기 위함(sites.manual_login_required = true인 몰만 대상으로 좁힌다).
 */
export async function GET(req: NextRequest) {
  const host = req.nextUrl.searchParams.get('host')
  if (!host) return NextResponse.json({ error: 'host required' }, { status: 400, headers: corsHeaders() })

  const res = await pool.query<{ id: number; name: string | null; url: string; extraction_rules: unknown }>(
    `SELECT id, name, url, extraction_rules FROM sites WHERE manual_login_required = true`,
  )
  const targetHost = normalizeHost(host)
  const match = res.rows.find(row => {
    try { return normalizeHost(new URL(row.url).hostname) === targetHost } catch { return false }
  })
  if (!match) return NextResponse.json({ error: 'not found' }, { status: 404, headers: corsHeaders() })

  // extractionRules: "스크랩 조정" 기능이 이 몰에 대해 학습해둔 영구 추출 규칙 — 확장이 매번 같이 받아가
  // EXTRACT_PRODUCT_EXPR에 실어 적용한다.
  return NextResponse.json({ id: match.id, name: match.name, extractionRules: match.extraction_rules || {} }, { headers: corsHeaders() })
}
