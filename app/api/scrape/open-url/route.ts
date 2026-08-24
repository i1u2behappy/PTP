import { NextRequest, NextResponse } from 'next/server'
import { openUrlInLoginWindow } from '@/lib/workerClient'
import pool from '@/lib/db'

/** 로그인 창에 새 탭으로 열어준다. 로그인 창이 닫혀있으면 저장된 로그인 쿠키로 새 창을 띄워서 연다.
 *  siteId를 모르는 호출부(스크랩 검토 그리드 등, 세션 단위로만 데이터를 다룸)를 위해 sessionId로도
 *  받을 수 있게 하고, 그 경우 세션이 속한 site_id를 여기서 찾는다. */
export async function POST(req: NextRequest) {
  const { siteId, sessionId, url } = await req.json() as { siteId?: number; sessionId?: number; url: string }
  if (!url || (!siteId && !sessionId)) return NextResponse.json({ error: 'siteId 또는 sessionId, url required' }, { status: 400 })

  let resolvedSiteId = siteId
  if (!resolvedSiteId) {
    const res = await pool.query<{ site_id: number }>(`SELECT site_id FROM scrape_sessions WHERE id=$1`, [sessionId])
    resolvedSiteId = res.rows[0]?.site_id
    if (!resolvedSiteId) return NextResponse.json({ error: 'session not found' }, { status: 404 })
  }

  await openUrlInLoginWindow(resolvedSiteId, url)
  return NextResponse.json({ ok: true })
}
