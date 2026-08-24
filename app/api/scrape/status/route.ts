import { NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'
import { getSiteLockStatus, getCollectProgress } from '@/lib/workerClient'

export async function GET(req: NextRequest) {
  const sessionId = req.nextUrl.searchParams.get('sessionId')
  if (!sessionId) return NextResponse.json({ error: 'sessionId required' }, { status: 400 })

  const res = await pool.query(
    `SELECT s.id, s.site_id, s.status, s.product_count, s.error, s.created_at, s.finished_at, s.concurrency_log,
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
  // 단, 일반모드는 서버(withContext→withSiteLock)가 시작부터 끝까지 이 몰의 락을 쥐고 있다 — 상품 하나가
  // 느리거나(재시도 backoff, 차단 감지 후 대기) 90초를 넘기면 이 체크가 아직 멀쩡히 도는 세션을 죽은
  // 걸로 오판해 DB만 'stopped'로 확정해버렸다(실제 스크랩 루프는 isStopRequested만 보고 계속 돌아
  // 상품을 계속 쌓는데 화면은 "중지됨"으로 보이는 불일치, 2026-08-11 실사용 확인). 락이 살아있으면(=
  // 이 프로세스가 지금 이 몰 작업을 실제로 하고 있다는 직접 증거) 로그 정체와 무관하게 죽은 게 아니다.
  const lastActivity = row.last_activity || row.created_at
  const staleMs = Date.now() - new Date(lastActivity).getTime()
  if (row.status === 'running' && staleMs > 90_000 && !(await getSiteLockStatus(row.site_id))) {
    await pool.query(`UPDATE scrape_sessions SET status='stopped' WHERE id=$1 AND status='running'`, [sessionId])
    row.status = 'stopped'
  }

  // 상품 URL 수집(카테고리 목록 순회) 단계는 product_count/saved_count가 아직 0이라, 화면이 오래 멈춘
  // 것처럼 보인다(실사용 확인: "수집 진행상황은 왜 안보여주는 거야?") — 그 단계 진행률을 같이 실어보낸다.
  const collectProgress = row.status === 'running' ? await getCollectProgress(row.id) : null

  return NextResponse.json({ ...row, collect_progress: collectProgress })
}
