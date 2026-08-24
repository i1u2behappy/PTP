import { NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'
import { getOpenPageUrl, navigateOpenPageTo } from '@/lib/workerClient'

// 창은 닫지 않는다 — 사용자가 로그인 확인 후에도 그 창(세션)을 그대로 스크래핑에 재사용한다.
// 몰 구조 변경 감지는 여기서 하지 않는다 — '마이그레이션3_연속관리'로 옮겼다(app/api/master/mall-structure-check).
export async function POST(req: NextRequest) {
  const { siteId } = await req.json() as { siteId: number }
  if (!siteId) return NextResponse.json({ error: 'siteId required' }, { status: 400 })

  // 로그인 URL로 로그인한 뒤라 로그인 창이 지금 등록해둔 몰 URL이 아닌 곳(마이페이지 등)에 있을 수 있다 —
  // 로그인 확인 시점에 등록해둔 몰 URL로 이동시켜, 이후 미리보기/스크랩 대상 지정이 그 페이지 기준으로 되게 한다.
  const site = await pool.query<{ url: string }>(`SELECT url FROM sites WHERE id=$1`, [siteId])
  const mallUrl = site.rows[0]?.url
  const currentUrl = mallUrl ? await navigateOpenPageTo(siteId, mallUrl) : await getOpenPageUrl(siteId)

  // 카테고리 목록의 "이미 스크랩함" 표시(app/api/scrape/categories)가 이 시각 이후의 완료 세션만 보게
  // 한다 — 다시 로그인했다는 건 새 작업 사이클로 본다는 뜻이라, 이전 로그인 때 완료한 카테고리까지
  // "완료"로 보여줄 필요가 없다는 사용자 판단(2026-08-10).
  await pool.query(`UPDATE sites SET last_login_confirmed_at = NOW() WHERE id=$1`, [siteId])

  return NextResponse.json({ ok: true, currentUrl })
}
