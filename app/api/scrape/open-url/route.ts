import { NextRequest, NextResponse } from 'next/server'
import { openUrlInLoginWindow, openUrlInManualLoginChrome } from '@/lib/workerClient'
import pool from '@/lib/db'

/** 로그인 창에 새 탭으로 열어준다. 로그인 창이 닫혀있으면 저장된 로그인 쿠키로 새 창을 띄워서 연다.
 *  siteId를 모르는 호출부(스크랩 검토 그리드 등, 세션 단위로만 데이터를 다룸)를 위해 sessionId로도
 *  받을 수 있게 하고, 그 경우 세션이 속한 site_id를 여기서 찾는다.
 *
 *  manual_login_required 몰(PC인증 등, 개발자모드)은 openUrlInLoginWindow(Playwright 자동화 창)로 열면
 *  안 된다 — 그 창은 이 몰들의 로그인 자체가 구조적으로 안 되는 창이라(!specifications/
 *  manual-login-required-malls.md), 열어봐야 로그인 안 된 화면만 뜬다. 대신 이미 로그인해둔 사용자의
 *  실제 개인 크롬(openUrlInManualLoginChrome)에 새 탭으로 연다(사용자 요청, 2026-09-09 — "나머지 상품
 *  '열기'가 기존 로그인해둔 브라우저 창에서 열리게 해줘"). */
export async function POST(req: NextRequest) {
  const { siteId, sessionId, url } = await req.json() as { siteId?: number; sessionId?: number; url: string }
  if (!url || (!siteId && !sessionId)) return NextResponse.json({ error: 'siteId 또는 sessionId, url required' }, { status: 400 })

  let resolvedSiteId = siteId
  if (!resolvedSiteId) {
    const res = await pool.query<{ site_id: number }>(`SELECT site_id FROM scrape_sessions WHERE id=$1`, [sessionId])
    resolvedSiteId = res.rows[0]?.site_id
    if (!resolvedSiteId) return NextResponse.json({ error: 'session not found' }, { status: 404 })
  }

  const siteRes = await pool.query<{ manual_login_required: boolean | null }>(`SELECT manual_login_required FROM sites WHERE id=$1`, [resolvedSiteId])
  if (siteRes.rows[0]?.manual_login_required) {
    openUrlInManualLoginChrome(url)
  } else {
    await openUrlInLoginWindow(resolvedSiteId, url)
  }
  return NextResponse.json({ ok: true })
}
