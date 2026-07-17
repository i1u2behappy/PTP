import { NextRequest, NextResponse } from 'next/server'
import pool, { initDb } from '@/lib/db'
import { verifyPassword, hashPassword } from '@/lib/auth'

// 관리자 계정은 단일 계정 — 설정 메뉴에서 ID/PW를 조회/변경하는 용도.
export async function GET() {
  await initDb()
  const res = await pool.query<{ id: number; username: string }>('SELECT id, username FROM admin_accounts ORDER BY id LIMIT 1')
  return NextResponse.json(res.rows[0] || null)
}

interface AdminUpdateBody {
  currentPassword: string
  newUsername?: string
  newPassword?: string
}

export async function PUT(req: NextRequest) {
  await initDb()
  const { currentPassword, newUsername, newPassword } = await req.json() as AdminUpdateBody
  if (!currentPassword) return NextResponse.json({ error: 'currentPassword required' }, { status: 400 })

  const res = await pool.query<{ id: number; password_hash: string; password_salt: string }>(
    'SELECT id, password_hash, password_salt FROM admin_accounts ORDER BY id LIMIT 1',
  )
  const account = res.rows[0]
  if (!account || !verifyPassword(currentPassword, account.password_hash, account.password_salt)) {
    return NextResponse.json({ error: '현재 비밀번호가 올바르지 않습니다.' }, { status: 401 })
  }

  if (newPassword) {
    const { hash, salt } = hashPassword(newPassword)
    await pool.query(
      'UPDATE admin_accounts SET username=COALESCE($1,username), password_hash=$2, password_salt=$3, updated_at=NOW() WHERE id=$4',
      [newUsername || null, hash, salt, account.id],
    )
  } else if (newUsername) {
    await pool.query('UPDATE admin_accounts SET username=$1, updated_at=NOW() WHERE id=$2', [newUsername, account.id])
  }
  return NextResponse.json({ ok: true })
}
