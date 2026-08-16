import { NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'
import { stageScrapedProduct, clearStalePendingIfConfigChanged } from '@/lib/scrape/staging'
import { clearStopRequest } from '@/lib/scraper'
import type { ExtractedProduct, ExtractionRule } from '@/lib/ai'

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
  stopped?: boolean
  /** 이 URL의 추출이 실패했을 때만 채워 보낸다 — product는 안 보낸다. */
  error?: string
}

const EMPTY_PRODUCT: ExtractedProduct = {
  name: '', price: null, sale_price: null, cost_price: null, shipping_fee: null, brand: '', manufacturer: '', origin: '', category: '',
  description: '', options: [], thumbnail_urls: [], thumbnail_names: [], detail_image_urls: [],
  detail_image_names: [], detail_text: '', summary_info: '', english_name: '', extra_info: [],
  stock_status: '판매중', stock_qty: null, stock_by_option: [], mall_product_code: '', custom_fields: {},
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
    const siteRow = await pool.query<{ extraction_rules: Record<string, ExtractionRule> | null }>(
      `SELECT extraction_rules FROM sites WHERE id=$1`, [body.siteId],
    )
    const currentRules = siteRow.rows[0]?.extraction_rules || {}
    // 개발자모드는 카테고리 선택 개념이 없어(지금 활성 탭 기준) categoryUrls를 안 넘긴다 — 추출규칙만
    // 비교해 "이어서"가 실은 설정이 바뀐 "새로 시작"인지 판단한다(일반모드와 같은 함수 공유, 2026-08-15).
    await clearStalePendingIfConfigChanged(body.siteId, { extractionRules: currentRules })

    const res = await pool.query<{ id: number }>(
      `INSERT INTO scrape_sessions (url, site_id, status, scope_type, mode, scope_params)
       VALUES ($1,$2,'running','products','full',$3) RETURNING id`,
      [body.url || '', body.siteId, JSON.stringify({ extractionRules: currentRules })],
    )
    sessionId = res.rows[0].id
  }

  if (body.done) {
    // "스크래핑 중지"로 도중에 끝난 것과 정상 완료를 구분해야 PTP 진행상황 화면이 올바른 상태를 보여준다
    // (일반모드는 이미 'stopped' 상태를 쓰고 있다 — 개발자모드도 같은 상태값으로 맞춘다). finished_at도
    // 일반모드(lib/scrape/run.ts)와 같은 기준으로 남겨 "소요시간" 표시가 개발자모드 세션에도 나오게 한다.
    await pool.query(`UPDATE scrape_sessions SET status=$2, finished_at=NOW() WHERE id=$1`, [sessionId, body.stopped ? 'stopped' : 'done'])
    clearStopRequest(sessionId)
    return NextResponse.json({ sessionId }, { headers: corsHeaders() })
  }

  // 일반모드(lib/scrape/run.ts)와 같은 scrape_item_log 테이블에 남겨서, 진행상황 화면의 "수집 실패" 표시와
  // 재시도 큐가 모드와 무관하게 같은 데이터를 보게 한다 — 개발자모드는 이 실패 보고가 없으면 어떤 상품이
  // 왜 실패했는지 PTP에서 전혀 알 방법이 없었다.
  if (body.error) {
    if (!body.url) return NextResponse.json({ error: 'url required' }, { status: 400, headers: corsHeaders() })
    await pool.query(
      `INSERT INTO scrape_item_log (session_id, url, status, error) VALUES ($1,$2,'failed',$3)`,
      [sessionId, body.url, body.error],
    )
    return NextResponse.json({ sessionId }, { headers: corsHeaders() })
  }

  if (!body.url || !body.product) {
    return NextResponse.json({ error: 'url and product required unless done=true', sessionId }, { status: 400, headers: corsHeaders() })
  }

  const product: ExtractedProduct = { ...EMPTY_PRODUCT, mall_product_code: body.url, ...body.product }
  await stageScrapedProduct({ siteId: body.siteId, sessionId }, { sourceUrl: body.url, product })
  await pool.query(`INSERT INTO scrape_item_log (session_id, url, status) VALUES ($1,$2,'success')`, [sessionId, body.url])

  return NextResponse.json({ sessionId }, { headers: corsHeaders() })
}
