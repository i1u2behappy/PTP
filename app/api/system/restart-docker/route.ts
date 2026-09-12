import { NextResponse } from 'next/server'
import { restartDockerAndCascade } from '@/lib/dockerRestart'

/** DB 연결 실패를 화면(DbHealthBanner)에서 감지했을 때, 버튼 한 번으로 Docker를 다시 띄울 수 있게
 *  하는 수동 버튼 — 실제 로직/설계 이유는 lib/dockerRestart.ts에 있다(app/api/system/recover/route.ts와
 *  공유 — 그쪽은 "진짜 인프라 문제로 판정됐을 때"만 같은 처방을 재사용한다). */
export async function POST() {
  const result = await restartDockerAndCascade()
  if ('error' in result) return NextResponse.json(result, { status: 500 })
  return NextResponse.json(result)
}
