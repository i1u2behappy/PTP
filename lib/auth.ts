import crypto from 'crypto'
import type { NextRequest } from 'next/server'

// PTP 앱 자체 로그인 — 몰 스크래핑용 로그인(lib/scraper.ts)과는 별개.
// 세션은 별도 라이브러리 없이 기존 CREDENTIALS_ENCRYPTION_KEY로 서명한 쿠키 토큰만 사용한다.
export const SESSION_COOKIE = 'ptp_session'
export const SESSION_MAX_AGE = 60 * 60 * 24 * 7 // 7일 (초)

// proxy.ts가 세션 쿠키를 검증한 뒤 이 헤더로 신원을 실어 API 라우트에 넘겨준다 — 라우트마다 DB를
// 재조회하지 않고도 role을 확인할 수 있다(proxy를 거치지 않고는 도달할 수 없는 경로라 위조 불가).
export const REQUEST_USERNAME_HEADER = 'x-ptp-username'
export const REQUEST_ROLE_HEADER = 'x-ptp-role'

/** 거래처/Mall 등록·삭제, 스크랩 데이터 삭제처럼 admin 전용인 라우트에서 쓴다. */
export function isAdminRequest(req: NextRequest): boolean {
  return req.headers.get(REQUEST_ROLE_HEADER) === 'admin'
}

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

export interface SessionUser { username: string; role: string }

// role을 서명된 토큰 안에 같이 실어둔다 — 권한관리 도입(2026-07-27) 이후 매 요청마다 role 확인이
// 필요해졌는데, 토큰 자체가 HMAC 서명돼 있어(위조 불가) DB 재조회 없이 안전하게 꺼내 쓸 수 있다.
export function signSessionToken(username: string, role: string): string {
  const payload = Buffer.from(JSON.stringify({ username, role, exp: Date.now() + SESSION_MAX_AGE * 1000 })).toString('base64url')
  const sig = crypto.createHmac('sha256', getKey()).update(payload).digest('base64url')
  return `${payload}.${sig}`
}

export function verifySessionToken(token: string | undefined): SessionUser | null {
  if (!token) return null
  const [payload, sig] = token.split('.')
  if (!payload || !sig) return null
  const expected = crypto.createHmac('sha256', getKey()).update(payload).digest('base64url')
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null
  try {
    const { username, role, exp } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { username: string; role?: string; exp: number }
    if (exp <= Date.now()) return null
    // 권한관리(role) 도입 이전(2026-07-27 이전)에 발급된 세션 쿠키는 role 클레임이 아예 없다 — 이런
    // 토큰을 그냥 통과시키면 실제로는 admin인 사람도 role이 undefined가 돼 모든 admin 전용 기능(사용자
    // 등록 등)이 이유도 없이 조용히 403으로 막힌다(실제로 겪은 버그). role이 없는 옛 토큰은 무효 처리해
    // 재로그인을 유도한다 — 재로그인하면 signSessionToken이 항상 role을 채운 새 토큰을 발급한다.
    if (!role) return null
    return { username, role }
  } catch {
    return null
  }
}
