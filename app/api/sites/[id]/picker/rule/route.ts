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
 * 개발자모드 "스크랩 대상 직접지정" 저장 — 일반모드는 Playwright의 page.exposeFunction으로 몰 페이지
 * 안에서 곧바로 이 UPDATE를 실행하지만(lib/scraper.ts의 ptpSavePick), 개발자모드는 크롬 확장이 CDP의
 * Runtime.addBinding으로 같은 이름의 함수를 페이지에 심어두고, 그 호출을 받아 여기로 HTTP 요청을 보낸다
 * — 둘 다 결과적으로 sites.extraction_rules에 같은 모양(jsonb)으로 저장된다.
 * Postgres의 jsonb `||`(병합) 연산자로 한 SQL 문 안에서 원자적으로 처리해, 여러 필드를 빠르게 연달아
 * 지정해도 SELECT~UPDATE 사이에 다른 저장이 끼어들어 먼저 저장한 필드가 사라지는 lost-update가 없다.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const siteId = Number(id)
  if (!siteId) return NextResponse.json({ error: 'invalid site id' }, { status: 400, headers: corsHeaders() })
  const body = await req.json().catch(() => ({})) as { field?: string; type?: 'label' | 'selector' | 'fixed' | 'multi'; value?: string }
  if (!body.field?.trim() || !body.type) return NextResponse.json({ error: 'field, type이 필요합니다' }, { status: 400, headers: corsHeaders() })

  await pool.query(
    `UPDATE sites SET extraction_rules = COALESCE(extraction_rules, '{}'::jsonb) || jsonb_build_object($1::text, $2::jsonb) WHERE id=$3`,
    [body.field, JSON.stringify({ type: body.type, value: body.value ?? '' }), siteId],
  )
  return NextResponse.json({ ok: true }, { headers: corsHeaders() })
}
