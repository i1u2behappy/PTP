import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getEnabledAiProviders, setEnabledAiProviders } from '@/lib/aiProviderConfig'

/**
 * "어떤 AI를 쓸지"를 앱 전체 설정으로 읽고 쓴다(2026-09-12).
 *
 * 예전엔 이 선택이 ScraperPanel의 React state로만 존재해 "몰 구조분석" 요청 하나에만 실려 갔고, 다른
 * 경로(카테고리 불러오기·개발자모드 확장·스케줄러)는 사용자의 선택을 알 수 없었다. 이 라우트가 저장한
 * 값을 lib/aiProviderGate.ts의 관문이 직접 읽으므로, 한 번 저장하면 모든 경로에 적용된다.
 */
const AiProviderIdSchema = z.enum(['anthropic', 'gemini', 'groq', 'ollama'])
const RequestSchema = z.object({ providers: z.array(AiProviderIdSchema) })

export async function GET() {
  try {
    return NextResponse.json({ providers: await getEnabledAiProviders() })
  } catch {
    // DB가 잠깐 안 되는 상황에서 화면이 통째로 깨지지 않게 — 관문도 같은 상황에서 전부 허용으로 동작한다.
    return NextResponse.json({ providers: null, error: '설정을 읽지 못했습니다' }, { status: 200 })
  }
}

export async function POST(req: NextRequest) {
  const parsed = RequestSchema.safeParse(await req.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message || 'invalid request' }, { status: 400 })
  }
  try {
    return NextResponse.json({ providers: await setEnabledAiProviders(parsed.data.providers) })
  } catch {
    return NextResponse.json({ error: '설정을 저장하지 못했습니다' }, { status: 500 })
  }
}
