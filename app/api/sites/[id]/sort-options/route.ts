import { NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'
import { diffQueryParams, type MallSortOption } from '@/lib/scraper'
import { detectSortOptionsWithAI } from '@/lib/ai'
import { mergeSortOptions } from '@/lib/scrape/categoryCachePolicy'

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
 * 로그인된 탭에서 카테고리 페이지의 링크를 모아 여기로 보내고, 서버가 diffQueryParams로 최종 판정해
 * scrape_profile.sortOptions에 저장한다 — 일반모드 sampleMallProfile이 같은 곳에 쓰는 것과 동일한 자리.
 *
 * body.verified(확장의 화면 인식(비전 AI)+실제 클릭으로 이미 검증된 후보인지)에 따라 detectSortOptionsWithAI
 * (Gemini/Groq, "이 중 뭐가 정렬 링크로 보이니") 재분류를 거칠지 결정한다 — 처음엔 항상 이 AI 재분류를
 * 거쳤는데, 모자사러 실사용 확인(2026-09-09): 화면에서 6개를 정확히 인식하고 그중 4개(상품명/낮은가격/
 * 높은가격/제조사)를 실제 클릭까지 해서 "같은 목록, sort_method 파라미터만 다름"으로 이미 구조적으로
 * 확정해뒀는데, 이 AI 재분류가 그중 "상품명" 하나만 남기고 나머지 3개를 근거 없이 걸러버렸다. 화면+클릭
 * 이라는 훨씬 강한 두 증거가 이미 있는데 신뢰도 낮은 세 번째 신호(AI)를 또 거치는 게 오히려 품질을
 * 떨어뜨린 것 — 일반모드 sampleMallProfile의 화면 인식 경로(lib/scraper.ts의 confirmSortCandidatesByClicking)
 * 도 원래부터 AI 재분류 없이 클릭 확인 결과를 그대로 diffQueryParams에만 넘기므로, 이쪽도 검증된 후보일
 * 때는 그와 똑같이 맞춘다. verified가 없거나 false인 경우(화면 인식이 실패해 href/select 전체 스캔을
 * 그대로 보낸 2차 폴백 — 최대 120개, 상품/공지 등 무관한 링크가 섞여 있어 AI 분류가 여전히 필요함)만
 * 기존처럼 AI 재분류를 거친다.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const siteId = Number(id)
  if (!siteId) return NextResponse.json({ error: 'invalid site id' }, { status: 400, headers: corsHeaders() })

  const body = await req.json() as { links?: { text: string; href: string }[]; baseUrl?: string; verified?: boolean }
  if (!body.links?.length || !body.baseUrl) {
    return NextResponse.json({ error: 'links, baseUrl required' }, { status: 400, headers: corsHeaders() })
  }

  const baseUrl = body.baseUrl
  let candidates: { label: string; href: string }[]
  if (body.verified) {
    candidates = body.links.map(l => ({ label: l.text, href: l.href }))
  } else {
    const siteRes = await pool.query<{ name: string | null }>('SELECT name FROM sites WHERE id=$1', [siteId])
    candidates = await detectSortOptionsWithAI(siteRes.rows[0]?.name || '', body.links, baseUrl).catch(() => [])
  }
  const sortOptions = candidates
    .map(c => ({ label: c.label, paramsToAdd: diffQueryParams(baseUrl, c.href) }))
    .filter((o): o is { label: string; paramsToAdd: Record<string, string> } => !!o.paramsToAdd)

  if (sortOptions.length) {
    // 서버 쪽 sampleMallProfile(/api/sites/[id]/profile)이 "몰 구조분석" 한 번에 이 라우트와 병렬로 돌며
    // 독립적으로 정렬 옵션을 찾아 같은 자리에 쓸 수 있다 — 로그인 없이도 서버가 카테고리 페이지를 열어볼
    // 수 있는 몰에서는 둘 다 진짜로 뭔가를 찾아내는데, 서로 다른 부분집합을 그대로 REPLACE해버리면 나중에
    // 쓰는 쪽이 이기면서 "정렬 구조"가 실행마다 무작위로 바뀌어 보였다(모자사러 실사용 확인, 2026-09-09).
    // 덮어쓰기 전에 지금 DB에 있는 값을 다시 읽어 label 기준으로 합친다(mergeSortOptions 참고, lib/scrape/
    // mallProfile.ts의 applyProfileResult도 반대 방향으로 같은 병합을 한다).
    const prevRes = await pool.query<{ sort: MallSortOption[] | null }>(
      `SELECT scrape_profile->'sortOptions' AS sort FROM sites WHERE id=$1`, [siteId],
    )
    const merged = mergeSortOptions(prevRes.rows[0]?.sort ?? undefined, sortOptions)
    // report.sortStructure(몰 구조분석 결과 카드의 "↕️ 정렬 구조" 문장)도 같이 맞춘다 — 개발자모드는
    // "몰 구조분석"(AI 리포트, runProfile)과 "정렬 옵션 감지"(이 라우트)가 확장 안에서 서로 병렬로
    // 실행돼(runFullMallProfile), 리포트 문장이 만들어지는 시점엔 아직 이 라우트의 정렬 결과가 없어
    // "확인 안됨"으로 굳어진 채 남는다 — 실제 정렬 지정 기능(카테고리별 정렬 드롭다운, scrape_profile.
    // sortOptions)은 정상인데 화면 문구만 안 맞아 "정렬이 왜 안 나오냐"는 혼란을 반복해서 일으켰다
    // (2026-09-08 실사용 확인, 소꿉노리). AI를 다시 부를 필요 없이 방금 확정된(합쳐진) 라벨을 그대로
    // 문장으로 옮겨 적는다 — 일반모드 sampleMallProfile이 sortHints를 리포트 프롬프트에 그대로 얹어 쓰는
    // 것과 같은 값·같은 형식(buildMallReportPrompt 참고).
    const sortStructureText = merged.map(o => o.label).join(', ')
    await pool.query(
      `UPDATE sites SET
         scrape_profile = (COALESCE(scrape_profile, '{}'::jsonb) || jsonb_build_object('sortOptions', $1::jsonb))
           || jsonb_build_object('report', COALESCE(scrape_profile->'report', '{}'::jsonb) || jsonb_build_object('sortStructure', $2::text)),
         scrape_profile_updated_at = NOW()
       WHERE id=$3`,
      [JSON.stringify(merged), sortStructureText, siteId],
    )
  }
  return NextResponse.json({ ok: true, count: sortOptions.length }, { headers: corsHeaders() })
}
