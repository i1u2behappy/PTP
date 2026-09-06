import { NextRequest, NextResponse } from 'next/server'
import { requestDevPreviewStop } from '@/lib/devPreviewStatus'

/**
 * PTP 화면의 "⏹ 중지"가 개발자모드 미리보기에 대해서도 실제로 순회를 멈추게 한다(2026-09-06, 사용자
 * 요청: "중지를 클릭하면 그 순간 중지하라고" — 예전엔 화면만 멈추고 몰 탭의 실제 순회는 안 끊겨, 몰
 * 탭을 강제로 닫아야만 진짜로 멈췄다). 이 라우트는 인증된 PTP 화면만 부르므로(공개 경로 아님) 신호만
 * 남기고, 실제로 순회를 끊는 건 확장이 카테고리/페이지를 확인할 때마다 preview-progress에서 이 신호를
 * 직접 물어봐서 스스로 멈추는 방식이다(run()의 requestStop/checkStopRequested와 같은 구조 — 서버가
 * 확장을 원격으로 끊을 방법이 없어 폴링으로만 전달 가능).
 */
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const siteId = Number(id)
  if (!siteId) return NextResponse.json({ error: 'invalid site id' }, { status: 400 })
  requestDevPreviewStop(siteId)
  return NextResponse.json({ ok: true })
}
