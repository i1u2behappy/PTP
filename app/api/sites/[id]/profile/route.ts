import { NextRequest, NextResponse } from 'next/server'
import { runMallStructureReport } from '@/lib/workerClient'

// 개발자모드 확장(extension-poc/background.js의 runProfile)도 chrome-extension:// 출처에서 이 라우트를
// 그대로 호출한다 — CORS 프리플라이트(OPTIONS) 응답과 Private Network Access 헤더가 필요하다(다른
// 확장 전용 라우트들과 같은 이유).
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
 * "몰 구조분석" 버튼(PTP 화면) / "몰 구조분석" 버튼(개발자모드 확장 팝업) 공용 — 로그인 확인마다 조용히
 * 도는 백그라운드 체크(app/api/scrape/login-confirm, 구조 변화 감지 전용)와는 용도가 다르다. 이 버튼은
 * 결제계좌/택배사/업체연락처/URL 계층 등 거래정보를 AI로 분석하는 무거운 작업(runMallStructureReport)을
 * 그 자리에서 즉시 실행하고 결과를 화면에 보여준다. profileMallStructure가 withContext로 브라우저
 * 컨텍스트를 얻으므로 로그인 창이 열려있을 필요는 없다 — 직접로그인 필수 몰은 신뢰가 쌓인 사용자의 개인
 * 크롬 프로필 사본을 서버가 알아서 헤드리스로 띄운다(2026-08-15).
 */
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const siteId = Number(id)
  if (!siteId) return NextResponse.json({ error: 'invalid site id' }, { status: 400, headers: corsHeaders() })

  const result = await runMallStructureReport(siteId)
  if (!result) {
    // "중지" 버튼(stopProfileAnalysis)이 눌려도 profileMallStructure가 조용히 null을 반환하므로
    // (2026-08-22) 이 메시지가 "실패"만이 아니라 "중지됨"일 수도 있다는 걸 같이 알려준다.
    return NextResponse.json({ error: '이 몰에 등록된 URL이 없거나, 몰 구조를 파악하지 못했습니다(중지를 눌렀다면 정상입니다)' }, { status: 400, headers: corsHeaders() })
  }
  return NextResponse.json(result, { headers: corsHeaders() })
}
