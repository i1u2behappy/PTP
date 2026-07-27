import { NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'
import { verifyPassword, hashPassword, REQUEST_USERNAME_HEADER } from '@/lib/auth'

/** 로그인 세션이 있는 "나 자신"의 계정 — 이전엔 /api/auth/admin이 관리자 단일 계정을 id 순으로 무조건
 * 하나 가져왔는데, 다중 사용자가 생기면서 그 방식은 로그인한 사람과 무관하게 항상 관리자 계정을 노출/
 * 변경할 수 있게 되는 보안 구멍이었다 — 그래서 proxy.ts가 넣어주는 x-ptp-username 헤더로 "지금 로그인한
 * 그 사람"의 행만 조회/수정하도록 바꿨다. */
export async function GET(req: NextRequest) {
  const username = req.headers.get(REQUEST_USERNAME_HEADER)
  if (!username) return NextResponse.json(null, { status: 401 })
  const res = await pool.query<{ id: number; username: string; role: string }>(
    'SELECT id, username, role FROM users WHERE username=$1', [username],
  )
  return NextResponse.json(res.rows[0] || null)
}

interface MeUpdateBody {
  currentPassword: string
  newUsername?: string
  newPassword?: string
}

export async function PUT(req: NextRequest) {
  const username = req.headers.get(REQUEST_USERNAME_HEADER)
  if (!username) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const { currentPassword, newUsername, newPassword } = await req.json() as MeUpdateBody
  if (!currentPassword) return NextResponse.json({ error: 'currentPassword required' }, { status: 400 })

  const res = await pool.query<{ id: number; password_hash: string; password_salt: string }>(
    'SELECT id, password_hash, password_salt FROM users WHERE username=$1', [username],
  )
  const account = res.rows[0]
  if (!account || !verifyPassword(currentPassword, account.password_hash, account.password_salt)) {
    return NextResponse.json({ error: '현재 비밀번호가 올바르지 않습니다.' }, { status: 401 })
  }

  if (newPassword) {
    const { hash, salt } = hashPassword(newPassword)
    await pool.query(
      'UPDATE users SET username=COALESCE($1,username), password_hash=$2, password_salt=$3, updated_at=NOW() WHERE id=$4',
      [newUsername || null, hash, salt, account.id],
    )
  } else if (newUsername) {
    await pool.query('UPDATE users SET username=$1, updated_at=NOW() WHERE id=$2', [newUsername, account.id])
  }
  return NextResponse.json({ ok: true })
}
