import { NextRequest, NextResponse } from 'next/server'
import { requestStop } from '@/lib/scraper'
import pool from '@/lib/db'

export async function POST(req: NextRequest) {
  const { sessionId } = await req.json() as { sessionId: number }
  if (!sessionId) return NextResponse.json({ error: 'sessionId required' }, { status: 400 })

  requestStop(sessionId)
  // 개발자모드는 실제 수집 루프가 사용자 브라우저(확장)에서 돌아 위 플래그를 그 쪽이 폴링해줘야만
  // 반영되는데, 탭이 닫히거나 MV3 서비스워커가 중간에 꺼지면 폴링 자체가 끊겨 DB 상태가 영원히
  // 'running'에 멈춘다 — 이 경우 "중지"를 아무리 눌러도 화면이 안 바뀐다. 서버가 직접 DB 상태를
  // 'stopped'로 확정해 살아있는 프로세스가 있든 없든 버튼이 항상 즉시 반영되게 한다(살아있으면 그 쪽도
  // 곧 같은 상태로 재확인만 할 뿐 문제 없음).
  await pool.query(`UPDATE scrape_sessions SET status='stopped' WHERE id=$1 AND status='running'`, [sessionId])
  return NextResponse.json({ ok: true })
}
