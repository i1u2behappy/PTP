import { NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'
import { getCategoryScrapeHistory, deriveCategoryUrlPattern, type CategoryLink, type MallPlatform } from '@/lib/scraper'
import { discoverCategoryLinks } from '@/lib/workerClient'

interface CachedCategoryCount { count: number; truncated?: boolean; label: string; checkedAt: string }

interface CachedProfile {
  platform?: MallPlatform
  categoryLinks?: { name: string; href: string }[]
  /** categoryLinks를 찾을 때 AI(detectCategoryLinksWithAI)가 실제로 기여했는지 — 캐시된 결과를 다시
   *  내려줄 때도 화면에 표시할 수 있도록 discoverCategoryLinks의 결과(aiUsed)를 그대로 같이 저장한다
   *  (사용자 요청, 2026-08-18). */
  categoryLinksAiUsed?: boolean
  /** deriveCategoryUrlPattern이 역산해둔 "이 몰의 카테고리 URL 패턴" — 다음 탐지 때 즉시 재확인하는
   *  "기억" 용도(사용자 요청, 2026-08-26). */
  categoryUrlPattern?: string | null
  excludedCategoryHrefs?: string[]
  categoryCounts?: Record<string, CachedCategoryCount>
}

/** 체크리스트의 "상품개수"/"확인일시"/"최근 스크랩"/"업체" 컬럼용 — previewCatalog가 저장해둔
 *  카테고리별 개수(href 기준)와, 그 라벨로 매칭한 스크랩/마이그레이션 이력을 함께 내려준다
 *  (lib/scraper.ts의 persistCategoryCounts/getCategoryScrapeHistory 참고, 사용자 요청 2026-08-17). */
async function getCategoryCountInfo(siteId: number): Promise<{
  categoryCounts: Record<string, CachedCategoryCount>
  categoryScrapeHistory: Record<string, { lastScrapedAt: string | null; clientName: string | null }>
}> {
  const res = await pool.query<{ scrape_profile: CachedProfile | null }>(
    `SELECT scrape_profile FROM sites WHERE id=$1`, [siteId],
  )
  const categoryCounts = res.rows[0]?.scrape_profile?.categoryCounts || {}
  const labels = [...new Set(Object.values(categoryCounts).map(c => c.label))]
  const categoryScrapeHistory = await getCategoryScrapeHistory(siteId, labels)
  return { categoryCounts, categoryScrapeHistory }
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
 *  "몰 구조분석"이 이미 같은 방식으로 찾아 sites.scrape_profile에 저장해둔 카테고리 목록이 있으면
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
      const { categoryCounts, categoryScrapeHistory } = await getCategoryCountInfo(siteId)
      return NextResponse.json({
        platform: profile.platform || 'unknown', links, cached: true,
        updatedAt: cached.rows[0].scrape_profile_updated_at, scrapedHrefs, allScraped,
        excludedCategoryHrefs: profile.excludedCategoryHrefs || [],
        categoryCounts, categoryScrapeHistory,
        aiUsed: !!profile.categoryLinksAiUsed,
      })
    }
  }

  // allowStaleManualLoginProfile: 개발자모드는 실제 크롬을 켜둔 채 쓰는 게 정상 상태라(예: 스크랩
  // 미리보기 직후 이어서 이 버튼을 누르는 경우), 그 크롬의 세션 파일이 잠긴 채 복사돼도(robocopy 일부
  // 실패) 진행한다 — 안 그러면 개발자모드에서는 캐시가 없는 몰/"다시 확인"이 사실상 항상 실패한다
  // (몰 구조분석에서 이미 같은 이유로 적용한 것과 동일, 2026-08-16).
  const result = await discoverCategoryLinks({ url, siteId, loginId, loginPw, allowStaleManualLoginProfile: true })
  // "다시 확인"(force)이 이번엔 AI(로컬 Ollama) 없이 규칙 기반으로만 카테고리를 찾았는데, 예전엔 AI가
  // 성공해 정확한 카테고리를 캐시해뒀다면 그 결과를 덮어쓰지 않는다 — lib/scrape/mallProfile.ts의
  // applyProfileResult가 "몰 구조분석"에 거는 것과 같은 보호(신우 몰 실사용 확인, 2026-08-25: "다시
  // 확인"을 눌렀더니 무관한 카테고리로 캐시가 덮어써짐). 둘 다 같은 sites.scrape_profile.categoryLinks를
  // 쓰므로 이 보호도 똑같이 필요하다.
  let responseLinks = result.links
  let responseAiUsed = result.aiUsed
  if (siteId && result.links.length) {
    const prevRes = await pool.query<{ scrape_profile: CachedProfile | null }>(
      `SELECT scrape_profile FROM sites WHERE id=$1`, [siteId],
    )
    const prevProfile = prevRes.rows[0]?.scrape_profile
    if (!result.aiUsed && prevProfile?.categoryLinksAiUsed && prevProfile.categoryLinks?.length) {
      responseLinks = prevProfile.categoryLinks.map(c => ({ href: c.href, text: c.name }))
      responseAiUsed = true
    } else {
      const categoryLinks = result.links.map(l => ({ name: l.text, href: l.href }))
      // 이번에 찾은 카테고리로 URL 패턴도 다시 역산해 "기억"을 갱신한다(사용자 요청, 2026-08-26) —
      // 다음 탐지(규칙 기반이든 AI든) 때 discoverTopLevelCategoryLinks가 이 패턴으로 즉시 재확인한다.
      const categoryUrlPattern = deriveCategoryUrlPattern(result.links.map(l => l.href))
        ?? prevProfile?.categoryUrlPattern ?? null
      await pool.query(
        `UPDATE sites SET
           scrape_profile = COALESCE(scrape_profile, '{}'::jsonb)
             || jsonb_build_object(
                  'platform', $1::text, 'categoryLinks', $2::jsonb, 'categoryMenuNames', $3::jsonb,
                  'categoryLinksAiUsed', $4::boolean, 'categoryUrlPattern', $5::jsonb),
           scrape_profile_updated_at = NOW()
         WHERE id=$6`,
        [result.platform, JSON.stringify(categoryLinks), JSON.stringify(categoryLinks.map(c => c.name)), !!result.aiUsed, JSON.stringify(categoryUrlPattern), siteId],
      )
    }
  }
  const { hrefs: scrapedHrefs, allScraped } = siteId ? await findScrapedCategoryHrefs(siteId) : { hrefs: [], allScraped: false }
  const excludedCategoryHrefs = siteId ? await getExcludedCategoryHrefs(siteId) : []
  const { categoryCounts, categoryScrapeHistory } = siteId
    ? await getCategoryCountInfo(siteId) : { categoryCounts: {}, categoryScrapeHistory: {} }
  return NextResponse.json({
    ...result, links: responseLinks, aiUsed: responseAiUsed, cached: false,
    scrapedHrefs, allScraped, excludedCategoryHrefs, categoryCounts, categoryScrapeHistory,
    loginBlockedExpansion: !!result.loginBlockedExpansion,
  })
}
