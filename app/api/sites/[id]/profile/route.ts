import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { runMallStructureReport, stopProfileAnalysis } from '@/lib/workerClient'

// 개발자모드 확장은 이 라우트를 바디 없이 POST하므로(기존 동작), aiProviders는 항상 optional — 없으면
// 기본 공급자 목록을 쓴다. 2026-09-02: 단일 "AI 사용" 켬/끔에서 공급자별(Anthropic/Gemini/Groq/Ollama)
// 체크로 확장 — enum에 'groq'가 빠져 있으면 일반모드 화면이 aiProviders에 'groq'를 넣어 보내도 zod
// 검증에서 통째로 실패해(safeParse가 실패로 처리) 조용히 아래 기본값으로 되돌아가는 버그가 있었다
// (실사용 확인, 2026-09-02 — 화면 체크박스로 Groq를 골라도 실제로는 안 쓰이고 있었음).
const AiProviderIdSchema = z.enum(['anthropic', 'gemini', 'groq', 'ollama'])
const RequestSchema = z.object({ aiProviders: z.array(AiProviderIdSchema).optional() })
// 기본값(바디 없음 — 개발자모드 확장 / aiProviders 생략)엔 Ollama를 안 넣는다 — CPU 전용이라 리포트
// 하나에 5~8분씩 걸리고, 그동안 이 PC의 Next.js dev 서버까지 CPU를 못 받아 "로고 화면(강제 새로고침)"
// 으로 이어지는 게 실측으로 확인됐다(components/panels/ScraperPanel.tsx의 profileAiProviders 기본값
// 주석과 같은 이유 — 일반모드 화면 체크박스 기본값과 이 서버 쪽 기본값을 반드시 맞춰야, 개발자모드도
// 같은 보호를 받는다).
const DEFAULT_AI_PROVIDERS = ['anthropic', 'gemini', 'groq'] as const

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
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const siteId = Number(id)
  if (!siteId) return NextResponse.json({ error: 'invalid site id' }, { status: 400, headers: corsHeaders() })

  // 개발자모드 확장은 바디 없이 POST한다 — 빈 바디의 req.json()은 예외를 던지므로 그 경우 {}로 본다.
  const parsed = RequestSchema.safeParse(await req.json().catch(() => ({})))
  const aiProviders = parsed.success ? (parsed.data.aiProviders ?? DEFAULT_AI_PROVIDERS) : DEFAULT_AI_PROVIDERS

  // 이 요청을 보낸 PTP 탭을 사용자가 닫으면(또는 브라우저/네트워크가 끊기면) req.signal이 abort된다 —
  // "몰 구조분석 중지" 버튼이 호출하는 것과 같은 stopProfileAnalysis를 그대로 재사용해, 탭을 닫는 것도
  // 그 버튼을 누른 것과 동일하게 취급한다. 이 몰이 진행 중인 분석이 없으면(이미 끝났거나 애초에 없음)
  // stopProfileAnalysis 자체가 조용히 아무 일도 안 하므로 안전하다(2026-09-06, 사용자 지적 — "PTP를
  // 닫으면 불필요한 진행 작업은 당연히 멈춰야지, 그냥 돌고 있는 게 이상하다").
  req.signal.addEventListener('abort', () => { stopProfileAnalysis(siteId).catch(() => {}) })
  const result = await runMallStructureReport(siteId, [...aiProviders])
  if (!result) {
    // "중지" 버튼(stopProfileAnalysis)이 눌려도 profileMallStructure가 조용히 null을 반환하므로
    // (2026-08-22) 이 메시지가 "실패"만이 아니라 "중지됨"일 수도 있다는 걸 같이 알려준다.
    return NextResponse.json({ error: '이 몰에 등록된 URL이 없거나, 몰 구조를 파악하지 못했습니다(중지를 눌렀다면 정상입니다)' }, { status: 400, headers: corsHeaders() })
  }
  return NextResponse.json(result, { headers: corsHeaders() })
}
