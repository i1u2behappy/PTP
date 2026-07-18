import { NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'
import { runAdjustment } from '@/lib/scrape/adjustment'
import type { ExtractedProduct } from '@/lib/ai'

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
 * "스크랩 조정" — 개발자모드 몰 2단계. 사용자가 실제 상품 페이지에서 크롬 확장 우클릭 메뉴("PTP 조정
 * 반영")를 실행하면 확장이 그 페이지의 HTML을 캡처해 여기로 보낸다. 1단계(app/api/sites/[id]/adjust/prompt)
 * 에서 저장해둔 프롬프트를 소비해 규칙을 만들고, 그 즉시 비운다. 백엔드가 이 몰의 페이지를 스스로 못
 * 열어보는 게 개발자모드의 정의라, 이 라우트는 확장이 보내주는 캡처에만 의존한다.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const siteId = Number(id)
  const body = await req.json() as { url: string; html: string }
  if (!body.url || !body.html) return NextResponse.json({ error: 'url과 html이 필요합니다' }, { status: 400, headers: corsHeaders() })

  const siteRes = await pool.query<{ pending_adjustment_prompt: string | null }>(
    `SELECT pending_adjustment_prompt FROM sites WHERE id=$1`, [siteId],
  )
  const prompt = siteRes.rows[0]?.pending_adjustment_prompt
  if (!prompt) {
    return NextResponse.json({ error: 'PTP에 먼저 조정 프롬프트를 입력해주세요' }, { status: 400, headers: corsHeaders() })
  }

  const matchRes = await pool.query<{
    name_original: string; price: number | null; mall_category: string | null
    brand: string; manufacturer: string; origin: string; raw_data: Partial<ExtractedProduct> | null
  }>(
    `SELECT name_original, price, mall_category, brand, manufacturer, origin, raw_data
     FROM scrape_staging_items WHERE site_id=$1 AND source_url=$2 ORDER BY created_at DESC LIMIT 1`,
    [siteId, body.url],
  )
  const match = matchRes.rows[0]
  const currentValues: Partial<ExtractedProduct> = match ? {
    name: match.name_original, price: match.price, category: match.mall_category || '',
    brand: match.brand, manufacturer: match.manufacturer, origin: match.origin,
    cost_price: match.raw_data?.cost_price ?? null, shipping_fee: match.raw_data?.shipping_fee ?? null,
  } : {}

  const rules = await runAdjustment(siteId, prompt, body.html, currentValues)
  await pool.query(`UPDATE sites SET pending_adjustment_prompt=NULL WHERE id=$1`, [siteId])

  return NextResponse.json({ rules }, { headers: corsHeaders() })
}
