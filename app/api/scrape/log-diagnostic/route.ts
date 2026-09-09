import { NextRequest, NextResponse } from 'next/server'

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
 * 개발자모드 확장(extension-poc/background.js)이 DB 저장 없이 그냥 .dev-server.log에 한 줄 남기고 싶을
 * 때 쓰는 범용 진단용 라우트 — 서버 쪽에서 console.log로 원인을 되짚어봐야 하는데 확장 콘솔(사용자
 * 브라우저 안, 개발자가 못 봄)에만 남는 걸 막는다(예: dialogListener의 "몰이 언제/어디서 alert()를
 * 띄웠는지" 진단, 2026-09-08). DB write가 없어 부작용 걱정 없이 아무 때나 호출해도 안전하다.
 */
export async function POST(req: NextRequest) {
  const body = await req.json() as { detail?: string }
  if (body.detail) console.log(`[extension-diag] ${body.detail}`)
  return NextResponse.json({ ok: true }, { headers: corsHeaders() })
}
