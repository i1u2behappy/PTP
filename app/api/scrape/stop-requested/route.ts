import { NextRequest, NextResponse } from 'next/server'
import { isStopRequested } from '@/lib/scraper'

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
 * 개발자모드 확장이 상품을 처리할 때마다 "지금 중지 요청이 들어왔냐"고 물어보는 공개 엔드포인트.
 * 일반모드는 서버가 직접 인메모리 Set(requestStop/isStopRequested)을 들여다보면 되지만, 개발자모드는
 * 루프 자체가 사용자 브라우저에서 돌고 있어 이 경로로만 "스크래핑 중지" 버튼 클릭을 전달할 수 있다.
 */
export async function GET(req: NextRequest) {
  const sessionId = Number(req.nextUrl.searchParams.get('sessionId'))
  const stop = Number.isFinite(sessionId) ? isStopRequested(sessionId) : false
  return NextResponse.json({ stop }, { headers: corsHeaders() })
}
