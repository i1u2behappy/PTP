import { NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'
import { stageScrapedProduct } from '@/lib/scrape/staging'
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

interface IngestBody {
  siteId: number
  sessionId?: number
  url?: string
  product?: Partial<ExtractedProduct>
  done?: boolean
}

const EMPTY_PRODUCT: ExtractedProduct = {
  name: '', price: null, sale_price: null, brand: '', manufacturer: '', origin: '', category: '',
  description: '', options: [], thumbnail_urls: [], thumbnail_names: [], detail_image_urls: [],
  detail_image_names: [], detail_text: '', summary_info: '', english_name: '', extra_info: [],
  stock_status: '판매중', stock_qty: null, stock_by_option: [], mall_product_code: '',
}

/**
 * 로그인 필수 몰(WebAuthn/PC인증 등, Playwright/CDP로 실제 세션을 못 흉내내는 곳)을 위한 입력 경로.
 * 사용자가 실제로 로그인해둔 진짜 브라우저에서 크롬 확장(chrome.debugger)이 긁은 상품 데이터를 받아,
 * 일반 스크랩과 동일한 스테이징 파이프라인(scrape_staging_items)에 그대로 태운다 — 몰 접근 자체는
 * 전부 사용자의 실제 브라우저 쪽에서 일어나고, 여기서는 그 결과만 받는다.
 */
export async function POST(req: NextRequest) {
  const body = await req.json() as IngestBody
  if (!body.siteId) {
    return NextResponse.json({ error: 'siteId required' }, { status: 400, headers: corsHeaders() })
  }

  let sessionId = body.sessionId
  if (!sessionId) {
    const res = await pool.query<{ id: number }>(
      `INSERT INTO scrape_sessions (url, site_id, status, scope_type, mode)
       VALUES ($1,$2,'running','products','full') RETURNING id`,
      [body.url || '', body.siteId],
    )
    sessionId = res.rows[0].id
  }

  if (body.done) {
    await pool.query(`UPDATE scrape_sessions SET status='done' WHERE id=$1`, [sessionId])
    return NextResponse.json({ sessionId }, { headers: corsHeaders() })
  }

  if (!body.url || !body.product) {
    return NextResponse.json({ error: 'url and product required unless done=true', sessionId }, { status: 400, headers: corsHeaders() })
  }

  const product: ExtractedProduct = { ...EMPTY_PRODUCT, mall_product_code: body.url, ...body.product }
  await stageScrapedProduct({ siteId: body.siteId, sessionId }, { sourceUrl: body.url, product })

  return NextResponse.json({ sessionId }, { headers: corsHeaders() })
}
