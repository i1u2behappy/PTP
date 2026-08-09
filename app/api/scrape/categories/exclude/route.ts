import { NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'

/** "카테고리 불러오기" 결과 중 실제로는 상품이 없는 항목(예: 메뉴 구조상 카테고리처럼 보이지만 실제로는
 *  안내/문의성 페이지)을 자동 판별만으로 완전히 걸러낼 수는 없다(몰마다 메뉴 구조가 제각각이라 scanCategoryMenu
 *  의 NON_CATEGORY_TEXT_RE 같은 텍스트 블록리스트로는 새 몰마다 새 예외가 계속 나옴, 2026-08-10 검토) —
 *  그래서 사용자가 직접 열어보고 "이건 상품 카테고리가 아니다"로 표시해둘 수 있는 보조 수단을 둔다.
 *  표시는 사이트별로 sites.scrape_profile.excludedCategoryHrefs(카테고리 href 목록)에 누적된다. */
export async function POST(req: NextRequest) {
  const { siteId, href, excluded } = await req.json() as { siteId?: number; href?: string; excluded?: boolean }
  if (!siteId || !href || typeof excluded !== 'boolean') {
    return NextResponse.json({ error: 'siteId, href, excluded required' }, { status: 400 })
  }

  const res = await pool.query<{ scrape_profile: { excludedCategoryHrefs?: string[] } | null }>(
    `SELECT scrape_profile FROM sites WHERE id=$1`, [siteId],
  )
  const current = new Set(res.rows[0]?.scrape_profile?.excludedCategoryHrefs || [])
  if (excluded) current.add(href)
  else current.delete(href)

  await pool.query(
    `UPDATE sites SET scrape_profile = COALESCE(scrape_profile, '{}'::jsonb) || jsonb_build_object('excludedCategoryHrefs', $1::jsonb)
     WHERE id=$2`,
    [JSON.stringify([...current]), siteId],
  )
  return NextResponse.json({ ok: true, excludedCategoryHrefs: [...current] })
}
