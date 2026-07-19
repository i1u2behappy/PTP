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
 * "스크랩 조정" — 개발자모드 몰 우클릭 메뉴가 실행되는 순간, "지금 테스트해야 할 프롬프트가 있는지"와
 * "어느 상품 페이지로 이동해서 캡처해야 하는지"를 확장에게 알려준다. 사용자가 정확한 상품 페이지를 직접
 * 찾아 들어갈 필요 없이, 그 몰의 아무 페이지에서나 우클릭하면 확장이 여기서 받은 URL로 알아서 이동해
 * 캡처하도록 하기 위함이다(그리드 맨 위 1건을 테스트 대상으로 삼는 일반모드와 같은 원칙).
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const siteId = Number(id)

  const siteRes = await pool.query<{ pending_adjustment_prompt: string | null; pending_adjustment_item_id: number | null }>(
    `SELECT pending_adjustment_prompt, pending_adjustment_item_id FROM sites WHERE id=$1`, [siteId],
  )
  const prompt = siteRes.rows[0]?.pending_adjustment_prompt || null
  const itemId = siteRes.rows[0]?.pending_adjustment_item_id ?? null

  // "스크랩 조정 개시" 시점에 화면에 보이던(방금 스크랩한 세션의) 상품이 저장돼 있으면 그걸 최우선으로
  // 쓴다 — 없을 때만(예전 데이터·직접 API 호출 등) 이 몰에서 가장 최근에 스크랩된 미확정 상품으로 대체한다.
  const itemRes = itemId != null
    ? await pool.query<{ source_url: string }>(`SELECT source_url FROM scrape_staging_items WHERE id=$1 AND site_id=$2`, [itemId, siteId])
    : await pool.query<{ source_url: string }>(
        `SELECT source_url FROM scrape_staging_items WHERE site_id=$1 AND status='pending' ORDER BY created_at DESC LIMIT 1`,
        [siteId],
      )

  return NextResponse.json({ prompt, testUrl: itemRes.rows[0]?.source_url || null }, { headers: corsHeaders() })
}
