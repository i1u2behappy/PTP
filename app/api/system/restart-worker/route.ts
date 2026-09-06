import { NextResponse } from 'next/server'
import { restartWorker } from '@/lib/workerRestart'

/** 워커(worker/index.ts) 프로세스만 재시작하는 수동 버튼 — PTP 서버(Next dev) 자체를 재시작하는
 *  /api/system/restart-server와 달리, 워커가 낡은 코드를 계속 실행 중일 때(app/api/health/
 *  worker-freshness가 감지) 쓴다. 실제 재시작 로직/설계 이유는 lib/workerRestart.ts에 있다
 *  (메모리 임계치 자동 재시작과 공유). */
export async function POST() {
  try {
    await restartWorker()
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 409 })
  }
  return NextResponse.json({ ok: true })
}
