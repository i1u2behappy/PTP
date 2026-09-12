import { NextResponse } from 'next/server'
import { getSystemHealth } from '@/lib/systemHealth'
import { readRecentRestarts } from '@/lib/restartHistory'

/**
 * 사이드바의 "시스템 상태" 팝업이 쓰는 집계 엔드포인트 — 실제 판정은 lib/systemHealth.ts에 있다(app/api/
 * system/recover/route.ts와 공유). "문제 생겨야 배너로 보이는" 기존 화면들과 달리, 평소에도 열어서
 * 확인하는 상시 대시보드 용도라 GET 한 번에 다 담는다.
 */
export async function GET() {
  const health = await getSystemHealth()
  return NextResponse.json({ ...health, history: readRecentRestarts() })
}
