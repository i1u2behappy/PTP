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
 * 개발자모드 확장의 "실패 상품 재수집"이 호출하는 공개 엔드포인트 — 이 몰에서 한 번이라도 실패했지만
 * 그 뒤로 한 번도 성공한 적 없는 URL만 돌려준다(세션 경계 무관 — 재시도 라운드가 여러 번이어도 최종
 * 성공 여부만 본다). 일반모드는 같은 개념을 ScraperPanel의 "실패 재시도" 버튼이 세션 단위로 이미 처리한다.
 */
export async function GET(req: NextRequest) {
  const siteId = Number(req.nextUrl.searchParams.get('siteId'))
  if (!Number.isFinite(siteId)) return NextResponse.json({ error: 'siteId required' }, { status: 400, headers: corsHeaders() })

  const res = await pool.query<{ url: string }>(
    `SELECT DISTINCT sil.url FROM scrape_item_log sil
     JOIN scrape_sessions ss ON ss.id = sil.session_id
     WHERE ss.site_id = $1 AND sil.status = 'failed'
       AND sil.url NOT IN (
         SELECT sil2.url FROM scrape_item_log sil2
         JOIN scrape_sessions ss2 ON ss2.id = sil2.session_id
         WHERE ss2.site_id = $1 AND sil2.status = 'success'
       )`,
    [siteId],
  )
  return NextResponse.json({ urls: res.rows.map(r => r.url) }, { headers: corsHeaders() })
}
