import { NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'

export async function GET(req: NextRequest) {
  const sessionId = req.nextUrl.searchParams.get('sessionId')
  if (!sessionId) return NextResponse.json({ error: 'sessionId required' }, { status: 400 })

  const res = await pool.query(
    `SELECT s.id, s.status, s.product_count, s.error, s.created_at, s.concurrency_log,
            (SELECT COUNT(*) FROM scrape_staging_items si WHERE si.session_id = s.id) AS saved_count,
            -- 진행 화면의 "수집 성공/실패" 개수 표시용 — /api/scrape/log는 화면에 다 그리기엔 너무 많을 수
            -- 있어 최근 200건만 돌려주는데(성능), 그 캡 걸린 목록의 length를 그대로 개수로 쓰면 실제로는
            -- 200건 넘게 처리됐어도 화면엔 항상 최대 200개로만 보인다(실사용 확인: 총 323개 수집완료인데
            -- "수집 성공"은 200개로 표시됨) — 개수는 캡 없이 정확히 세고, 목록 표시만 따로 캡을 건다.
            (SELECT COUNT(*) FROM scrape_item_log l WHERE l.session_id = s.id AND l.status = 'success') AS success_count,
            (SELECT COUNT(*) FROM scrape_item_log l WHERE l.session_id = s.id AND l.status = 'failed') AS failed_count,
            (SELECT MAX(created_at) FROM scrape_item_log l WHERE l.session_id = s.id) AS last_activity
     FROM scrape_sessions s
     WHERE s.id = $1`,
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
