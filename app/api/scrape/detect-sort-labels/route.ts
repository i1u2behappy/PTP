import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { detectSortOptionsFromScreenshot } from '@/lib/ai'

// chrome-extension:// 출처에서 오는 fetch라 다른 확장 전용 라우트들과 같은 이유로 CORS 프리플라이트와
// Private Network Access 헤더가 필요하다(app/api/scrape/detect-sub-categories/route.ts와 동일 패턴).
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
 * 정렬 UI 탐지의 1차 수단(스크린샷 → 비전 AI) 공용 진입점 — 일반모드(lib/scraper.ts의 sampleMallProfile/
 * detectSortOptionsForCategory)와 개발자모드(extension-poc/background.js의 runDetectSortOptions) 둘 다
 * 카테고리 페이지 스크린샷만 여기로 보내고, 화면에 보이는 정렬 라벨 텍스트만 돌려받는다 — 실제 클릭·
 * URL 검증·DB 저장은 각 호출부가 기존 코드(confirmSortCandidatesByClicking / buildClickTextExpr +
 * diffQueryParams)를 그대로 재사용한다(lib/ai.ts의 detectSortOptionsFromScreenshot 주석 참고).
 */
export async function POST(req: NextRequest) {
  const parsed = RequestSchema.safeParse(await req.json())
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message || 'invalid request' }, { status: 400, headers: corsHeaders() })
  }
  const { mallName, imageBase64, mimeType } = parsed.data
  const labels = await detectSortOptionsFromScreenshot(mallName || '이 몰', imageBase64, mimeType || 'image/jpeg')
  return NextResponse.json({ labels }, { headers: corsHeaders() })
}
