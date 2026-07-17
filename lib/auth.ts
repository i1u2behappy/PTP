import crypto from 'crypto'

// PTP 앱 자체 로그인(관리자 1계정) — 몰 스크래핑용 로그인(lib/scraper.ts)과는 별개.
// 세션은 별도 라이브러리 없이 기존 CREDENTIALS_ENCRYPTION_KEY로 서명한 쿠키 토큰만 사용한다.
export const SESSION_COOKIE = 'ptp_session'
export const SESSION_MAX_AGE = 60 * 60 * 24 * 7 // 7일 (초)

function getKey(): Buffer {
  const hex = process.env.CREDENTIALS_ENCRYPTION_KEY
  if (!hex) throw new Error('CREDENTIALS_ENCRYPTION_KEY 환경변수가 필요합니다 (openssl rand -hex 32)')
  return Buffer.from(hex, 'hex')
}

export function hashPassword(password: string, saltHex?: string): { hash: string; salt: string } {
  const salt = saltHex ? Buffer.from(saltHex, 'hex') : crypto.randomBytes(16)
  const hash = crypto.scryptSync(password, salt, 64)
  return { hash: hash.toString('hex'), salt: salt.toString('hex') }
}

export function verifyPassword(password: string, hashHex: string, saltHex: string): boolean {
  const a = Buffer.from(hashPassword(password, saltHex).hash, 'hex')
  const b = Buffer.from(hashHex, 'hex')
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

export function signSessionToken(username: string): string {
  const payload = Buffer.from(JSON.stringify({ username, exp: Date.now() + SESSION_MAX_AGE * 1000 })).toString('base64url')
  const sig = crypto.createHmac('sha256', getKey()).update(payload).digest('base64url')
  return `${payload}.${sig}`
}

export function verifySessionToken(token: string | undefined): string | null {
  if (!token) return null
  const [payload, sig] = token.split('.')
  if (!payload || !sig) return null
  const expected = crypto.createHmac('sha256', getKey()).update(payload).digest('base64url')
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null
  try {
    const { username, exp } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { username: string; exp: number }
    return exp > Date.now() ? username : null
  } catch {
    return null
  }
}
