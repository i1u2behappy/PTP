import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import pool from '@/lib/db'
import { detectSortOptionsForCategory } from '@/lib/workerClient'

const RequestSchema = z.object({
  siteId: z.number(),
  url: z.string(),
})

/** "몰 카테고리 선택 가져오기(반복)" 탭 — 사용자가 카테고리를 가져오면 그 즉시 정렬 옵션을 확인해
 *  sites.scrape_profile.sortOptions에 저장한다(app/api/sites/[id]/sort-options/route.ts가 개발자모드
 *  확장에서 이미 쓰는 것과 같은 자리 — "몰 구조분석"을 따로 돌리지 않아도 이 저장 위치 하나로
 *  "정렬" 드롭다운이 채워진다). 이미 정렬 옵션이 저장돼 있으면(몰 구조분석이든 이 라우트든 먼저
 *  찾아둔 게 있으면) 다시 확인하지 않는다 — 몰 전체가 같은 정렬 메커니즘을 쓴다고 보므로 한 번이면
 *  충분하다(사용자 요청, 2026-08-26: "한번만 해주면 되겠지"). */
export async function POST(req: NextRequest) {
  const parsed = RequestSchema.safeParse(await req.json())
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message || 'invalid request' }, { status: 400 })
  }
  const { siteId, url } = parsed.data

  const cached = await pool.query<{ scrape_profile: { sortOptions?: unknown[] } | null }>(
    `SELECT scrape_profile FROM sites WHERE id=$1`, [siteId],
  )
  const existing = cached.rows[0]?.scrape_profile?.sortOptions
  if (existing?.length) return NextResponse.json({ sortOptions: existing, cached: true })

  try {
    // allowStaleManualLoginProfile: 바로 위 app/api/scrape/categories/expand/route.ts와 같은 이유(같은
    // "카테고리 선택 가져오기(반복)" 탭이 부르는 자매 라우트라 같은 개발자모드 몰에서 같은 방식으로
    // 500이 난다) — !specifications/manual-login-required-malls.md "버그 2" 패턴의 또 다른 누락 지점.
    const sortOptions = await detectSortOptionsForCategory({ siteId, allowStaleManualLoginProfile: true }, url)
    if (sortOptions.length) {
      // report.sortStructure도 같이 맞춘다 — app/api/sites/[id]/sort-options/route.ts와 같은 이유(이전에
      // "몰 구조분석"이 정렬을 못 찾아 report.sortStructure="확인 안됨"으로 저장해뒀다면, 이 라우트가
      // 나중에 따로 찾아낸 sortOptions와 화면 문구가 서로 안 맞는 채로 남는다).
      const sortStructureText = sortOptions.map(o => o.label).join(', ')
      await pool.query(
        `UPDATE sites SET
           scrape_profile = (COALESCE(scrape_profile, '{}'::jsonb) || jsonb_build_object('sortOptions', $1::jsonb))
             || jsonb_build_object('report', COALESCE(scrape_profile->'report', '{}'::jsonb) || jsonb_build_object('sortStructure', $2::text)),
           scrape_profile_updated_at = NOW()
         WHERE id=$3`,
        [JSON.stringify(sortOptions), sortStructureText, siteId],
      )
    }
    return NextResponse.json({ sortOptions, cached: false })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
}
