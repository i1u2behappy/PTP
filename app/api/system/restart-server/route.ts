import { NextResponse } from 'next/server'
import { restartPtpServer } from '@/lib/systemRestart'

/** PTP 서버(Next dev) 자체를 강제 재시작하는 수동 버튼 — 실제 재시작 로직/설계 이유는
 *  lib/systemRestart.ts에 있다(lib/scheduler.ts의 메모리 임계치 자동 재시작과 공유). */
export async function POST() {
  try {
    await restartPtpServer()
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 409 })
  }
  return NextResponse.json({ ok: true })
}
