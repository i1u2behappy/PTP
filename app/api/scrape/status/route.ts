import { NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'

export async function GET(req: NextRequest) {
  const sessionId = req.nextUrl.searchParams.get('sessionId')
  if (!sessionId) return NextResponse.json({ error: 'sessionId required' }, { status: 400 })

  const res = await pool.query(
    `SELECT s.id, s.status, s.product_count, s.error, s.created_at,
            COUNT(si.id) AS saved_count,
            MAX(l.created_at) AS last_activity
     FROM scrape_sessions s
     LEFT JOIN scrape_staging_items si ON si.session_id = s.id
     LEFT JOIN scrape_item_log l ON l.session_id = s.id
     WHERE s.id = $1
     GROUP BY s.id`,
    [sessionId],
  )
  const row = res.rows[0]
  if (!row) return NextResponse.json({ error: 'not found' }, { status: 404 })

  // 개발자모드 확장은 사용자가 "중지"를 누르지 않아도 조용히 죽을 수 있다(MV3 서비스워커 종료,
  // chrome.debugger 분리, 탭 새로고침 등) — 그러면 아무도 이 세션을 갱신해주지 않아 'running'에 영원히
  // 멈춘다. PTP는 이 상태를 2초마다 폴링하니, 마지막 활동(상품 로그)으로부터 일반적인 상품 처리 주기보다
  // 훨씬 긴 시간이 지나도록 'running'이면 죽은 것으로 보고 자동으로 확정한다.
  const lastActivity = row.last_activity || row.created_at
  const staleMs = Date.now() - new Date(lastActivity).getTime()
  if (row.status === 'running' && staleMs > 90_000) {
    await pool.query(`UPDATE scrape_sessions SET status='stopped' WHERE id=$1 AND status='running'`, [sessionId])
    row.status = 'stopped'
  }

  return NextResponse.json(row)
}
