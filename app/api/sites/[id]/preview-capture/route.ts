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

/**
 * 개발자모드 "스크래핑 전 단건 미리보기" — 사용자가 실제 상품 페이지에서 크롬 확장 우클릭 메뉴("PTP
 * 미리보기 실행")를 실행하면 확장이 지금 보고 있는 그 페이지의 HTML을 캡처해 여기로 보낸다. "스크랩
 * 조정"과 달리 프롬프트/기존 스크랩 세션이 필요 없다 — 그 자리에서 바로 규칙기반(+선택적으로 AI모드)
 * 추출만 해서 last_adjustment_preview에 저장해두면, PTP 화면이 폴링으로 읽어간다.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const siteId = Number(id)
  const body = await req.json() as { url: string; html: string; aiMode?: boolean }
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

  const preview = await extractFromHtml(body.html, body.url, rules).catch(() => null)
  await pool.query(`UPDATE sites SET last_adjustment_preview=$1 WHERE id=$2`, [preview ? JSON.stringify(preview) : null, siteId])

  return NextResponse.json({ preview }, { headers: corsHeaders() })
}
