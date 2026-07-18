import { NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'

/** 같은 몰(site_id)의 스크랩 세션 여러 개를 하나의 병합 그룹으로 묶는다 — 기존 소속 그룹은 무시하고
 * 매번 새 그룹을 발급해 선택한 세션 전체를 그 그룹의 멤버로 만든다. */
export async function POST(req: NextRequest) {
  const { sessionIds } = await req.json() as { sessionIds: number[] }
  if (!Array.isArray(sessionIds) || sessionIds.length < 2) {
    return NextResponse.json({ error: 'sessionIds must have at least 2 items' }, { status: 400 })
  }

  const siteRes = await pool.query<{ site_id: number }>(
    'SELECT DISTINCT site_id FROM scrape_sessions WHERE id = ANY($1)', [sessionIds],
  )
  if (siteRes.rows.length !== 1) {
    return NextResponse.json({ error: '선택한 세션들의 거래처·몰이 서로 다릅니다.' }, { status: 400 })
  }

  const seq = await pool.query<{ nextval: string }>(`SELECT nextval('scrape_session_merge_seq') AS nextval`)
  const groupId = Number(seq.rows[0].nextval)
  await pool.query('UPDATE scrape_sessions SET merge_group_id=$1 WHERE id = ANY($2)', [groupId, sessionIds])
  return NextResponse.json({ groupId })
}
