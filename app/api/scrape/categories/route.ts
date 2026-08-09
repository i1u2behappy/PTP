import { NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'
import { discoverCategoryLinks, type CategoryLink, type MallPlatform } from '@/lib/scraper'

interface CachedProfile {
  platform?: MallPlatform
  categoryLinks?: { name: string; href: string }[]
  excludedCategoryHrefs?: string[]
}

/** 사용자가 "제외"로 표시해둔 카테고리 href 목록(app/api/scrape/categories/exclude가 기록) — force로
 *  다시 훑어도 이 표시는 그대로 유지돼야 하므로 캐시 여부와 무관하게 항상 다시 조회한다. */
async function getExcludedCategoryHrefs(siteId: number): Promise<string[]> {
  const res = await pool.query<{ scrape_profile: CachedProfile | null }>(
    `SELECT scrape_profile FROM sites WHERE id=$1`, [siteId],
  )
  return res.rows[0]?.scrape_profile?.excludedCategoryHrefs || []
}

/** 카테고리 일부만 골라 스크랩하고 나머지는 나중에 나눠서 하는 경우가 있어(사용자 실사용 패턴), 이 몰의
 *  완료된 스크랩 세션들을 훑어 "이미 완료해본 카테고리"를 알려준다 — allScraped가 true면 몰 전체 스크랩을
 *  이미 완료한 적이 있다는 뜻이라 카테고리 구분 없이 전부 완료로 본다. scope_params에 실제 선택했던
 *  카테고리 URL을 담아두는 건 app/api/scrape/route.ts의 세션 생성 부분과 짝이다.
 *  "과거"의 범위는 무제한이 아니라 가장 최근 로그인 확인(sites.last_login_confirmed_at) 이후로 제한한다
 *  — 다시 로그인했다는 건 새 작업 사이클로 본다는 뜻이라, 그 이전 로그인 때 완료한 카테고리까지 "완료"로
 *  보여줄 필요가 없다는 사용자 판단(2026-08-10). 로그인 확인 기록이 아직 없는 몰(이 컬럼 도입 전)은
 *  기준 시점을 모르니 완료 이력을 보여주지 않는다(다음 로그인 확인부터 정상 반영됨). */
async function findScrapedCategoryHrefs(siteId: number): Promise<{ hrefs: string[]; allScraped: boolean }> {
  const siteRes = await pool.query<{ last_login_confirmed_at: string | null }>(
    `SELECT last_login_confirmed_at FROM sites WHERE id=$1`, [siteId],
  )
  const since = siteRes.rows[0]?.last_login_confirmed_at
  if (!since) return { hrefs: [], allScraped: false }

  const res = await pool.query<{ scope_type: string; scope_params: { categoryUrls?: string[] } | null }>(
    `SELECT scope_type, scope_params FROM scrape_sessions WHERE site_id=$1 AND status='done' AND created_at >= $2`,
    [siteId, since],
  )
  const hrefs = new Set<string>()
  for (const row of res.rows) {
    if (row.scope_type === 'all') return { hrefs: [], allScraped: true }
    for (const href of row.scope_params?.categoryUrls || []) hrefs.add(href)
  }
  return { hrefs: [...hrefs], allScraped: false }
}

/** "카테고리 불러오기"는 예전엔 매번 몰을 직접 훑었는데(후보가 많으면 실사용이 어려울 만큼 느림),
 *  "몰 구조 파악"이 이미 같은 방식으로 찾아 sites.scrape_profile에 저장해둔 카테고리 목록이 있으면
 *  그걸 그대로 즉시 돌려준다. 아직 한 번도 분석 안 한 몰이거나 force로 새로고침을 요청하면 그때만
 *  discoverCategoryLinks로 직접 훑고, 다음 번을 위해 결과를 캐시에 반영해둔다. */
export async function POST(req: NextRequest) {
  const { siteId, url, loginId, loginPw, force } = await req.json() as {
    siteId?: number; url: string; loginId?: string; loginPw?: string; force?: boolean
  }
  if (!url) return NextResponse.json({ error: 'url required' }, { status: 400 })

  if (siteId && !force) {
    const cached = await pool.query<{ scrape_profile: CachedProfile | null; scrape_profile_updated_at: string | null }>(
      `SELECT scrape_profile, scrape_profile_updated_at FROM sites WHERE id=$1`, [siteId],
    )
    const profile = cached.rows[0]?.scrape_profile
    if (profile?.categoryLinks?.length) {
      const links: CategoryLink[] = profile.categoryLinks.map(c => ({ href: c.href, text: c.name }))
      const { hrefs: scrapedHrefs, allScraped } = await findScrapedCategoryHrefs(siteId)
      return NextResponse.json({
        platform: profile.platform || 'unknown', links, cached: true,
        updatedAt: cached.rows[0].scrape_profile_updated_at, scrapedHrefs, allScraped,
        excludedCategoryHrefs: profile.excludedCategoryHrefs || [],
      })
    }
  }

  const result = await discoverCategoryLinks({ url, siteId, loginId, loginPw })
  if (siteId && result.links.length) {
    const categoryLinks = result.links.map(l => ({ name: l.text, href: l.href }))
    await pool.query(
      `UPDATE sites SET
         scrape_profile = COALESCE(scrape_profile, '{}'::jsonb)
           || jsonb_build_object('platform', $1::text, 'categoryLinks', $2::jsonb, 'categoryMenuNames', $3::jsonb),
         scrape_profile_updated_at = NOW()
       WHERE id=$4`,
      [result.platform, JSON.stringify(categoryLinks), JSON.stringify(categoryLinks.map(c => c.name)), siteId],
    )
  }
  const { hrefs: scrapedHrefs, allScraped } = siteId ? await findScrapedCategoryHrefs(siteId) : { hrefs: [], allScraped: false }
  const excludedCategoryHrefs = siteId ? await getExcludedCategoryHrefs(siteId) : []
  return NextResponse.json({ ...result, cached: false, scrapedHrefs, allScraped, excludedCategoryHrefs })
}
