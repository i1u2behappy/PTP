import { NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'

/** "실패 N개 재시도" 전용 — /api/scrape/log는 화면 표시용이라 200건으로 잘려 있어(성능 목적), 실패가
 *  200건을 넘는 세션(예: 몰 탭이 닫혀 나머지 전부가 실패한 경우)은 그 버튼이 진짜로는 앞쪽 200건만
 *  재시도하고 나머지는 조용히 빠지는 문제가 있었다(사용자 지적, 2026-09-06 — "실패 1835개인데 왜
 *  재시도는 200개라고 나오냐"). 재시도는 URL만 있으면 되니, 다른 컬럼 없이 url만 뽑아 상한 없이
 *  전부 돌려준다. */
export async function GET(req: NextRequest) {
  const sessionId = req.nextUrl.searchParams.get('sessionId')
  if (!sessionId) return NextResponse.json({ error: 'sessionId required' }, { status: 400 })

  const res = await pool.query<{ url: string }>(
    `SELECT DISTINCT url FROM scrape_item_log WHERE session_id=$1 AND status='failed' ORDER BY url`,
    [sessionId],
  )
  return NextResponse.json(res.rows.map(r => r.url))
}
