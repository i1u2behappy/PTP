import { NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'
import { runAdjustment } from '@/lib/scrape/adjustment'
import { extractFromHtml } from '@/lib/scraper'
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

  const siteRes = await pool.query<{ pending_adjustment_prompt: string | null; pending_adjustment_item_id: number | null }>(
    `SELECT pending_adjustment_prompt, pending_adjustment_item_id FROM sites WHERE id=$1`, [siteId],
  )
  const prompt = siteRes.rows[0]?.pending_adjustment_prompt
  const itemId = siteRes.rows[0]?.pending_adjustment_item_id ?? null
  if (!prompt) {
    return NextResponse.json({ error: 'PTP에 먼저 조정 프롬프트를 입력해주세요' }, { status: 400, headers: corsHeaders() })
  }

  // "스크랩 조정 개시" 시점에 저장해둔 상품 id가 있으면 그걸로 정확히 찾는다 — URL만으로 찾으면 같은
  // URL이 여러 세션에 걸쳐 재수집돼 있을 때 어떤 걸 봐야 할지 모호할 수 있다.
  const matchRes = itemId != null
    ? await pool.query<{ raw_data: Partial<ExtractedProduct> | null }>(`SELECT raw_data FROM scrape_staging_items WHERE id=$1 AND site_id=$2`, [itemId, siteId])
    : await pool.query<{ raw_data: Partial<ExtractedProduct> | null }>(
        `SELECT raw_data FROM scrape_staging_items WHERE site_id=$1 AND source_url=$2 ORDER BY created_at DESC LIMIT 1`,
        [siteId, body.url],
      )
  const currentValues: Partial<ExtractedProduct> = matchRes.rows[0]?.raw_data || {}

  let rules, merged
  try {
    ({ rules, merged } = await runAdjustment(siteId, prompt, body.html, currentValues))
  } catch (e) {
    // AI 호출 자체가 실패한 것(크레딧 부족/네트워크 오류 등)이라 프롬프트는 지우지 않는다 — 원인을 해결한
    // 뒤 프롬프트를 다시 입력할 필요 없이 우클릭만 다시 실행하면 되도록.
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500, headers: corsHeaders() })
  }

  // 캡처해온 정적 HTML을 새 규칙 전체로 다시 추출해 미리보기를 만든다 — 백엔드가 이 몰 페이지에 실제로
  // 접속하는 게 아니라, 이미 손에 있는 HTML을 그대로 렌더링만 해서 재추출하는 것이라 안전하다. 실패해도
  // (예: HTML이 예상과 다른 구조) 규칙 저장 자체는 이미 끝났으니 조정 흐름을 막지 않는다.
  const preview = await extractFromHtml(body.html, body.url, merged).catch(() => null)

  await pool.query(
    `UPDATE sites SET pending_adjustment_prompt=NULL, last_adjustment_preview=$1 WHERE id=$2`,
    [preview ? JSON.stringify(preview) : null, siteId],
  )

  return NextResponse.json({ rules, preview }, { headers: corsHeaders() })
}
