import { NextRequest, NextResponse } from 'next/server'
import { detectLastPageLinkWithAI } from '@/lib/ai'

// chrome-extension:// 출처에서 오는 fetch라 다른 확장 전용 라우트들과 같은 이유로 CORS 프리플라이트와
// Private Network Access 헤더가 필요하다.
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
 * 개발자모드 확장의 규칙 기반 페이지네이션 지름길 3개가 전부 실패했을 때(buildPaginationSignalExpr 참고)
 * 최후수단(150페이지 완전탐색)으로 떨어지기 전에 호출한다 — lib/ai.ts의 detectLastPageLinkWithAI 참고.
 * 실패/확신 없음이면 { href: null }을 그대로 돌려주고, 호출부(collectCategoryLinks)가 기존 완전탐색으로
 * 폴백한다.
 */
export async function POST(req: NextRequest) {
  const body = await req.json() as { mallName?: string; candidates?: { text: string; href: string }[]; baseUrl?: string }
  if (!body.candidates?.length || !body.baseUrl) return NextResponse.json({ href: null }, { headers: corsHeaders() })
  const result = await detectLastPageLinkWithAI(body.mallName || '이 몰', body.candidates, body.baseUrl).catch(() => null)
  return NextResponse.json({ href: result?.href ?? null }, { headers: corsHeaders() })
}
