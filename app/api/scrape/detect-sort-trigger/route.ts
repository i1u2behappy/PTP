import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { detectSortTriggerFromScreenshot } from '@/lib/ai'

// chrome-extension:// 출처에서 오는 fetch라 다른 확장 전용 라우트들과 같은 이유로 CORS 프리플라이트와
// Private Network Access 헤더가 필요하다(app/api/scrape/detect-sort-labels/route.ts와 동일 패턴).
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

const RequestSchema = z.object({
  mallName: z.string().optional(),
  imageBase64: z.string(),
  mimeType: z.string().optional(),
})

/**
 * detect-sort-labels(화면에 이미 보이는 정렬 값 읽기)로 라벨을 하나도 못 찾았을 때만 쓰는 2차 수단 —
 * "정렬방식"처럼 고정 라벨만 있고 지금 값은 화면에 안 보이는 닫힌 트리거의 위치를 찾는다(도매신 실사용
 * 확인, 2026-09-16). 일반모드(lib/scraper.ts의 detectSortOptionsByScreenshot)와 개발자모드
 * (extension-poc/background.js의 runDetectSortOptions) 둘 다 이 위치를 클릭해 다시 스크린샷을 찍고
 * detect-sort-labels를 재호출하는 방식으로 쓴다 — 실제 클릭·재정렬 검증은 각 호출부의 기존 코드
 * (confirmSortCandidatesByClicking / clickCandidatesAndCollectLinks)가 그대로 맡는다.
 */
export async function POST(req: NextRequest) {
  const parsed = RequestSchema.safeParse(await req.json())
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message || 'invalid request' }, { status: 400, headers: corsHeaders() })
  }
  const { mallName, imageBase64, mimeType } = parsed.data
  const trigger = await detectSortTriggerFromScreenshot(mallName || '이 몰', imageBase64, mimeType || 'image/jpeg')
  return NextResponse.json({ trigger: trigger ?? { found: false } }, { headers: corsHeaders() })
}
