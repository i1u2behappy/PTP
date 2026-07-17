import { NextRequest, NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import pool, { initDb } from '@/lib/db'
import { verifyPassword, signSessionToken, SESSION_COOKIE, SESSION_MAX_AGE } from '@/lib/auth'

export async function POST(req: NextRequest) {
  await initDb()
  const { username, password } = await req.json() as { username?: string; password?: string }
  if (!username || !password) return NextResponse.json({ error: 'username/password required' }, { status: 400 })

  const res = await pool.query<{ username: string; password_hash: string; password_salt: string }>(
    'SELECT username, password_hash, password_salt FROM admin_accounts WHERE username=$1',
    [username],
  )
  const account = res.rows[0]
  if (!account || !verifyPassword(password, account.password_hash, account.password_salt)) {
    return NextResponse.json({ error: '아이디 또는 비밀번호가 올바르지 않습니다.' }, { status: 401 })
  }

  const cookieStore = await cookies()
  cookieStore.set(SESSION_COOKIE, signSessionToken(account.username), {
    httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/', maxAge: SESSION_MAX_AGE,
  })
  return NextResponse.json({ ok: true })
}
