import { NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'
import { diffQueryParams } from '@/lib/scraper'
import { detectSortOptionsWithAI } from '@/lib/ai'

// chrome-extension:// 출처에서 오는 fetch라 CORS 프리플라이트(OPTIONS)를 직접 응답해야 하고,
// 로컬(사설망) 주소로 가는 요청이라 Private Network Access 헤더도 같이 내려줘야 브라우저가 막지 않는다.
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
 * 개발자모드 확장 팝업의 "🧭 정렬 옵션 감지" 결과 판정. 로그인 필요 몰은 서버(sampleMallProfile)가
 * 정렬 옵션이 있는 카테고리 페이지를 열어볼 수 없으므로(runExpandCategories와 같은 이유), 확장이 실제
 * 로그인된 탭에서 카테고리 페이지의 링크 전체를 모아 여기로 보내고, 서버가 detectSortOptionsWithAI(Gemini,
 * 로그인 불필요) + diffQueryParams로 판정해 scrape_profile.sortOptions에 저장한다 — 일반모드
 * sampleMallProfile이 같은 곳에 쓰는 것과 동일한 자리.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const siteId = Number(id)
  if (!siteId) return NextResponse.json({ error: 'invalid site id' }, { status: 400, headers: corsHeaders() })

  const body = await req.json() as { links?: { text: string; href: string }[]; baseUrl?: string }
  if (!body.links?.length || !body.baseUrl) {
    return NextResponse.json({ error: 'links, baseUrl required' }, { status: 400, headers: corsHeaders() })
  }

  const siteRes = await pool.query<{ name: string | null }>('SELECT name FROM sites WHERE id=$1', [siteId])
  const baseUrl = body.baseUrl
  const detected = await detectSortOptionsWithAI(siteRes.rows[0]?.name || '', body.links, baseUrl).catch(() => [])
  const sortOptions = detected
    .map(c => ({ label: c.label, paramsToAdd: diffQueryParams(baseUrl, c.href) }))
    .filter((o): o is { label: string; paramsToAdd: Record<string, string> } => !!o.paramsToAdd)

  if (sortOptions.length) {
    await pool.query(
      `UPDATE sites SET
         scrape_profile = COALESCE(scrape_profile, '{}'::jsonb) || jsonb_build_object('sortOptions', $1::jsonb),
         scrape_profile_updated_at = NOW()
       WHERE id=$2`,
      [JSON.stringify(sortOptions), siteId],
    )
  }
  return NextResponse.json({ ok: true, count: sortOptions.length }, { headers: corsHeaders() })
}
