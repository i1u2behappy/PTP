import { NextResponse } from 'next/server'
import { restartPtpServer } from '@/lib/systemRestart'
import { restartWorker } from '@/lib/workerRestart'

/** PTP 서버(Next dev) 자체를 강제 재시작하는 수동 버튼 — 실제 재시작 로직/설계 이유는
 *  lib/systemRestart.ts에 있다(lib/scheduler.ts의 메모리 임계치 자동 재시작과 공유).
 *
 *  워커도 같이 재시작한다 — 이유는 app/api/system/restart-worker/route.ts의 주석 참고(2026-09-11
 *  사용자 지시, 워커/PTP 서버 각자의 DB 커넥션 풀이 서로 독립적이라 한쪽만 재시작하면 다른 쪽 좀비
 *  커넥션이 남을 수 있다). PTP 서버 재시작은 이 요청을 처리 중인 프로세스 자신을 잠시 뒤 죽이므로,
 *  워커 재시작을 먼저 끝내고 나서 마지막에만 시도한다 — 순서를 바꾸면 이 프로세스가 먼저 죽어
 *  워커 재시작(closeAllOpenSessionsGracefully 등 비동기 작업 포함)이 끝까지 못 갈 수 있다. */
export async function POST() {
  await restartWorker('cascade').catch(() => {}) // 이미 재시작 진행 중이면 조용히 무시 — PTP 서버 재시작은 아래에서 별도로 판단
  try {
    await restartPtpServer()
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 409 })
  }
  return NextResponse.json({ ok: true })
}
