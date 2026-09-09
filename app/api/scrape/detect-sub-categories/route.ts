import { NextRequest, NextResponse } from 'next/server'
import { detectCategoryLinksWithAI } from '@/lib/ai'

// chrome-extension:// 출처에서 오는 fetch라 다른 확장 전용 라우트들과 같은 이유로 CORS 프리플라이트와
// Private Network Access 헤더가 필요하다(app/api/scrape/detect-last-page/route.ts와 동일 패턴).
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
 * 개발자모드 확장의 카테고리 하위구조 자동확인(runExpandCategories의 buildScanSubmenuExpr)이 규칙 기반
 * <ul>/<li> 메뉴 트리를 못 찾았을 때 폴백으로 호출한다 — 펫토리 실사용 확인(2026-09-06): 이 몰은 대분류
 * 페이지 본문에 사이드바 메뉴가 아니라 브랜드/재료별 세부 분류를 4열 그리드(일반 <div>/<table> 콘텐츠,
 * cat/lnb/gnb류 class가 없는 레이아웃)로 나열하는데, 규칙 기반 메뉴 트리 스캔으로는 이런 구조를 원천적으로
 * 못 찾는다. Qwen(Groq)에게 그 페이지의 링크 후보를 넘겨 실제로 진짜 하위 카테고리인지 판단시켜본 결과
 * 정확히 골라내는 것을 직접 확인했다 — lib/ai.ts의 detectCategoryLinksWithAI(discoverCategoryLinks의 허브
 * 확장이 서버 쪽에서 이미 쓰는 것과 같은 함수)를 그대로 재사용한다.
 */
export async function POST(req: NextRequest) {
  const body = await req.json() as {
    mallName?: string; parentCategoryName?: string; candidates?: { text: string; href: string }[]
  }
  if (!body.candidates?.length) return NextResponse.json({ links: [] }, { headers: corsHeaders() })
  const links = await detectCategoryLinksWithAI(body.mallName || '이 몰', body.candidates, body.parentCategoryName).catch(() => [])
  return NextResponse.json({ links }, { headers: corsHeaders() })
}
