import { NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'

/** 선택한 세션들을 병합 그룹에서 뺀다. 그 결과 어떤 그룹에 멤버가 1명 이하만 남으면(더 이상 "병합"이라
 * 부를 게 없으므로) 그 남은 멤버도 그룹에서 마저 빼서 완전히 해체한다. */
export async function POST(req: NextRequest) {
  const { sessionIds } = await req.json() as { sessionIds: number[] }
  if (!Array.isArray(sessionIds) || !sessionIds.length) {
    return NextResponse.json({ error: 'sessionIds required' }, { status: 400 })
  }

  const affected = await pool.query<{ merge_group_id: number }>(
    'SELECT DISTINCT merge_group_id FROM scrape_sessions WHERE id = ANY($1) AND merge_group_id IS NOT NULL', [sessionIds],
  )
  await pool.query('UPDATE scrape_sessions SET merge_group_id=NULL, merged_at=NULL WHERE id = ANY($1)', [sessionIds])

  for (const { merge_group_id } of affected.rows) {
    const remaining = await pool.query('SELECT id FROM scrape_sessions WHERE merge_group_id=$1', [merge_group_id])
    if (remaining.rows.length <= 1) {
      await pool.query('UPDATE scrape_sessions SET merge_group_id=NULL, merged_at=NULL WHERE merge_group_id=$1', [merge_group_id])
    }
  }
  return NextResponse.json({ ok: true })
}
