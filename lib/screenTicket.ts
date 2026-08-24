import crypto from 'crypto'

// 원격 화면공유(worker/screenRelay.ts)용 짧은 유효기간 티켓 — lib/auth.ts의 세션 쿠키(signSessionToken/
// verifySessionToken)와 같은 HMAC 서명 패턴을 그대로 쓰지만, 별도 토큰 타입으로 분리해둔다: 워커의 WS
// 엔드포인트는 Next.js의 쿠키 검증(proxy.ts)을 거치지 않고 직접 접속을 받으므로, 쿠키를 그대로 워커에
// 전달하는 방식은 두 프로세스가 항상 같은 호스트에 있다는 가정에 몰래 의존하게 된다 — 나중에 워커가
// 다른 서브도메인/터널 뒤로 옮겨지면 쿠키 전달이 깨지거나(SameSite/Domain 불일치) 오히려 위험해질 수
// 있다. 서명 티켓은 호스트 구성과 무관하게 동작하고, siteId까지 서명에 포함해 "몰 A용으로 발급된
// 티켓으로 몰 B의 화면을 본다"를 원천적으로 막는다. 유효기간을 30초로 짧게 잡은 이유: 이 티켓은 WS
// 핸드셰이크 한 번만 넘기면 되는 순간용이지, 보고 있는 내내 유효해야 하는 게 아니다(연결이 계속
// 살아있는 동안은 별도 만료 검사가 없다 — 재연결마다 새 티켓을 새로 받는다).
const TICKET_TTL_MS = 30_000

export interface ScreenTicketClaims {
  siteId: number
  username: string
  role: string
}

function getKey(): Buffer {
  const hex = process.env.CREDENTIALS_ENCRYPTION_KEY
  if (!hex) throw new Error('CREDENTIALS_ENCRYPTION_KEY 환경변수가 필요합니다 (openssl rand -hex 32)')
  return Buffer.from(hex, 'hex')
}

export function signScreenTicket(claims: ScreenTicketClaims): string {
  const payload = Buffer.from(JSON.stringify({ ...claims, exp: Date.now() + TICKET_TTL_MS })).toString('base64url')
  const sig = crypto.createHmac('sha256', getKey()).update(payload).digest('base64url')
  return `${payload}.${sig}`
}

/** ticket이 위조되지 않았고, 만료 전이며, expectedSiteId와 일치할 때만 신원을 돌려준다. */
export function verifyScreenTicket(ticket: string | null | undefined, expectedSiteId: number): ScreenTicketClaims | null {
  if (!ticket) return null
  const [payload, sig] = ticket.split('.')
  if (!payload || !sig) return null
  const expected = crypto.createHmac('sha256', getKey()).update(payload).digest('base64url')
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as ScreenTicketClaims & { exp: number }
    if (claims.exp <= Date.now()) return null
    if (claims.siteId !== expectedSiteId) return null
    return { siteId: claims.siteId, username: claims.username, role: claims.role }
  } catch {
    return null
  }
}
