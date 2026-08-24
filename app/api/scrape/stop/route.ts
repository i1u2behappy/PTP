import { NextRequest, NextResponse } from 'next/server'
import { requestStop, getSiteLockStatus } from '@/lib/workerClient'
import pool from '@/lib/db'

export async function POST(req: NextRequest) {
  const { sessionId } = await req.json() as { sessionId: number }
  if (!sessionId) return NextResponse.json({ error: 'sessionId required' }, { status: 400 })

  await requestStop(sessionId)
  // 개발자모드는 실제 수집 루프가 사용자 브라우저(확장)에서 돌고 있어, 이 요청은 "멈춰달라"는 신호일
  // 뿐 즉시 멈추는 게 아니다 — 확장은 상품 하나를 처리할 때마다(보통 몇 초~10여 초 주기) 이 신호를
  // 확인하고서야 실제로 멈춘다. 여기서 DB 상태를 곧바로 'stopped'로 확정해버리면 PTP 화면은 "중지됨"을
  // 보여주는데 실제 브라우저 탭은 몇 초간 계속 상품을 순회하는 게 눈에 보이는 불일치가 생긴다. 그래서
  // 확장이 실제로 멈춘 뒤 스스로 보고하는 것(extension-ingest의 done 처리)을 기다리는 게 우선이고, 이
  // 서버는 그 확인이 끝내 오지 않을 때만(탭이 닫히거나 MV3 서비스워커가 죽어버린 좀비 세션) 넉넉한
  // 유예 시간 뒤 강제로 확정한다 — 두 화면이 항상 같은 상태를 가리키게 하면서도, 죽은 세션이 영원히
  // '중지 처리 중'에 멈춰 있지는 않게 한다.
  //
  // 일반모드(서버 자체가 브라우저를 돌림)는 withSiteLock을 시작부터 끝까지 쥐고 있다가 놓아준다 — 놓아준
  // 순간이 바로 "진짜로 멈췄다"는 증거다. 20초가 지났는데도 이 락이 여전히 살아있으면(예: 상품 하나가
  // 재시도 backoff에 걸려 아직 isStopRequested를 다시 확인 못 한 경우) 그건 아직 안 멈춘 것이지 죽은
  // 게 아니므로, 여기서 강제로 'stopped'를 덮어쓰면 GET /api/scrape/status가 이미 겪은 것과 똑같은
  // "DB는 멈췄다는데 실제로는 계속 도는" 불일치를 이 경로에서도 새로 만들어낸다(2026-08-11 실사용
  // 확인·수정). 락이 살아있는 동안은 그 락이 실제로 풀릴 때(run.ts가 최종 상태를 직접 씀)까지 기다린다.
  const site = await pool.query<{ site_id: number }>(`SELECT site_id FROM scrape_sessions WHERE id=$1`, [sessionId])
  const siteId = site.rows[0]?.site_id
  setTimeout(() => {
    (async () => {
      if (siteId != null && await getSiteLockStatus(siteId)) return
      await pool.query(`UPDATE scrape_sessions SET status='stopped' WHERE id=$1 AND status='running'`, [sessionId]).catch(() => {})
    })().catch(() => {})
  }, 20_000)
  return NextResponse.json({ ok: true })
}
