import { NextRequest, NextResponse } from 'next/server'
import { requestStop } from '@/lib/scraper'
import pool from '@/lib/db'

export async function POST(req: NextRequest) {
  const { sessionId } = await req.json() as { sessionId: number }
  if (!sessionId) return NextResponse.json({ error: 'sessionId required' }, { status: 400 })

  requestStop(sessionId)
  // 개발자모드는 실제 수집 루프가 사용자 브라우저(확장)에서 돌고 있어, 이 요청은 "멈춰달라"는 신호일
  // 뿐 즉시 멈추는 게 아니다 — 확장은 상품 하나를 처리할 때마다(보통 몇 초~10여 초 주기) 이 신호를
  // 확인하고서야 실제로 멈춘다. 여기서 DB 상태를 곧바로 'stopped'로 확정해버리면 PTP 화면은 "중지됨"을
  // 보여주는데 실제 브라우저 탭은 몇 초간 계속 상품을 순회하는 게 눈에 보이는 불일치가 생긴다. 그래서
  // 확장이 실제로 멈춘 뒤 스스로 보고하는 것(extension-ingest의 done 처리)을 기다리는 게 우선이고, 이
  // 서버는 그 확인이 끝내 오지 않을 때만(탭이 닫히거나 MV3 서비스워커가 죽어버린 좀비 세션) 넉넉한
  // 유예 시간 뒤 강제로 확정한다 — 두 화면이 항상 같은 상태를 가리키게 하면서도, 죽은 세션이 영원히
  // '중지 처리 중'에 멈춰 있지는 않게 한다.
  setTimeout(() => {
    pool.query(`UPDATE scrape_sessions SET status='stopped' WHERE id=$1 AND status='running'`, [sessionId]).catch(() => {})
  }, 20_000)
  return NextResponse.json({ ok: true })
}
