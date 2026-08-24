import { NextRequest, NextResponse } from 'next/server'
import { setSiteLockDetail } from '@/lib/workerClient'

// 개발자모드 확장(extension-poc/background.js의 runFullMallProfile)이 chrome-extension:// 출처에서
// 부르므로, 다른 확장 전용 라우트들과 같은 이유로 CORS 프리플라이트와 Private Network Access 헤더가 필요하다.
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
 * "몰 구조분석" 버튼은 항상 오래 걸리는데 진행 상황을 전혀 알 수 없다는 지적(2026-08-22)으로,
 * lib/scraper.ts의 sampleMallProfile(서버 쪽)에는 setSiteLockDetail을 직접 호출하는 단계 표시를
 * 추가했다 — 개발자모드는 그 단계들(카테고리 하위구조 확인/정렬 옵션 감지)이 이 서버가 아니라 사용자
 * 브라우저의 확장에서 도니, 확장이 이 라우트로 대신 알려온다. siteLockStatus에 이미 잠긴 siteId가
 * 아니면(락이 이미 풀렸거나 애초에 없으면) setSiteLockDetail이 조용히 무시한다.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const siteId = Number(id)
  if (!siteId) return NextResponse.json({ error: 'invalid site id' }, { status: 400, headers: corsHeaders() })
  const { detail } = await req.json() as { detail?: string }
  if (detail) await setSiteLockDetail(siteId, detail)
  return NextResponse.json({ ok: true }, { headers: corsHeaders() })
}
