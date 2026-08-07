import { NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'
import { runAutoAnalysis } from '@/lib/scrape/adjustment'
import { extractFromHtml } from '@/lib/scraper'
import type { ExtractionRule } from '@/lib/ai'

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

interface CapturedPreviewItem { url: string; name: string; thumbnail: string }

/**
 * 개발자모드 "스크랩 미리보기 실행" — 확장이 지금 보고 있는 페이지가 카테고리(목록)면 링크를 끝까지
 * 페이징해 모은 뒤 첫 상품 페이지의 HTML을, 이미 상품 상세 페이지 그 자체면 그 페이지 HTML을 그대로
 * 캡처해 보낸다(어느 쪽이든 확장이 판단해서 보냄, 이 라우트는 항상 "상품 1건의 HTML"만 받는다). 목록
 * 모드면 total/items도 같이 실어 보낸다 — 결과를 일반모드의 "스크랩 미리보기"(previewCatalog)와 같은
 * 모양(total/platform/preview/items)으로 last_adjustment_preview에 저장해두면, PTP 화면이 폴링으로
 * 읽어가 같은 applyCatalogPreview로 보여준다(두 모드가 같은 UI 하나를 공유).
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const siteId = Number(id)
  const body = await req.json() as {
    url: string; html: string; aiMode?: boolean
    total?: number; items?: CapturedPreviewItem[]; category?: string; brandFromCategory?: string
  }
  if (!body.url || !body.html) return NextResponse.json({ error: 'url과 html이 필요합니다' }, { status: 400, headers: corsHeaders() })

  const siteRes = await pool.query<{ extraction_rules: Record<string, ExtractionRule> | null }>(
    `SELECT extraction_rules FROM sites WHERE id=$1`, [siteId],
  )
  if (!siteRes.rows.length) return NextResponse.json({ error: 'mall not found' }, { status: 404, headers: corsHeaders() })

  let rules = siteRes.rows[0].extraction_rules || {}
  if (body.aiMode) {
    try {
      ({ merged: rules } = await runAutoAnalysis(siteId, body.html))
    } catch (e) {
      // AI 호출 실패(크레딧 부족 등)여도 기존 규칙기반 추출은 그대로 보여준다 — 미리보기 자체가 막히면 안 된다.
      return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500, headers: corsHeaders() })
    }
  }

  const product = await extractFromHtml(body.html, body.url, rules).catch(() => null)
  // 목록(카테고리) 페이지에서 얻은 카테고리/브랜드가 상품 상세페이지 자체보다 믿을만하다(lib/scraper.ts의
  // applyCategoryOverride와 같은 원칙) — 다만 "스크랩 대상 직접지정"으로 이미 직접 확정해둔 필드는
  // 덮어쓰지 않는다.
  if (product) {
    if (body.category && !rules.category) product.category = body.category
    if (body.brandFromCategory && !rules.brand) product.brand = body.brandFromCategory
  }
  const preview = product ? { sourceUrl: body.url, product } : null
  const total = body.total ?? (preview ? 1 : 0)
  const items = body.items || []
  await pool.query(
    `UPDATE sites SET last_adjustment_preview=$1 WHERE id=$2`,
    [JSON.stringify({ total, platform: 'unknown', preview, items }), siteId],
  )

  return NextResponse.json({ preview }, { headers: corsHeaders() })
}
