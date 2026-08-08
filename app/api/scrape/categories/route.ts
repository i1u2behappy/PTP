import { NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'
import { discoverCategoryLinks, type CategoryLink, type MallPlatform } from '@/lib/scraper'

interface CachedProfile {
  platform?: MallPlatform
  categoryLinks?: { name: string; href: string }[]
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
      return NextResponse.json({
        platform: profile.platform || 'unknown', links, cached: true,
        updatedAt: cached.rows[0].scrape_profile_updated_at,
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
  return NextResponse.json({ ...result, cached: false })
}
