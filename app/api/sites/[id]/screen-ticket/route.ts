import { NextRequest, NextResponse } from 'next/server'
import { REQUEST_USERNAME_HEADER, REQUEST_ROLE_HEADER } from '@/lib/auth'
import { signScreenTicket } from '@/lib/screenTicket'

/**
 * "원격으로 보기"가 워커의 WS 화면중계 엔드포인트에 접속하기 직전에 매번 새로 받는 짧은 티켓 —
 * proxy.ts를 거치므로 로그인 안 한 상태면 이 라우트 자체가 401로 막힌다(그게 이 라우트가 존재하는
 * 이유 — 로그인 검증이 없는 워커 프로세스 쪽에 검증을 옮겨주는 다리 역할).
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const siteId = Number(id)
  if (!siteId) return NextResponse.json({ error: 'invalid site id' }, { status: 400 })

  const username = req.headers.get(REQUEST_USERNAME_HEADER)
  const role = req.headers.get(REQUEST_ROLE_HEADER)
  if (!username || !role) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const ticket = signScreenTicket({ siteId, username, role })
  const port = process.env.WORKER_SCREEN_PORT || 4802
  // WORKER_PUBLIC_WS_URL: 나중에 워커가 다른 호스트/터널 뒤로 옮겨지면 이 환경변수만 바꾸면 되게 —
  // 프론트엔드를 다시 빌드할 필요 없이 서버 쪽에서 주소를 결정해 내려준다.
  const wsUrl = process.env.WORKER_PUBLIC_WS_URL || `ws://127.0.0.1:${port}`
  return NextResponse.json({ ticket, wsUrl, expiresAt: Date.now() + 30_000 })
}
