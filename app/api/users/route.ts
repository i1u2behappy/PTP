import { NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'
import { hashPassword, isAdminRequest } from '@/lib/auth'

/** 설정 > 권한관리 — 사용자 목록/등록. admin만 접근 가능(등록은 물론 목록 조회도) — 일반 사용자는 다른
 * 계정 존재 여부조차 몰라도 된다. */
export async function GET(req: NextRequest) {
  if (!isAdminRequest(req)) return NextResponse.json({ error: '관리자 권한이 필요합니다.' }, { status: 403 })
  const res = await pool.query('SELECT id, username, role, created_at FROM users ORDER BY created_at')
  return NextResponse.json(res.rows)
}

interface NewUserBody { username: string; password: string }

/** 새 사용자는 항상 role='user'로만 생성된다 — admin은 최초 시드 계정 하나뿐이라는 전제라, 이 화면
 * 자체에 role 선택 UI가 없다("admin 권한을 제외한 나머지 권한만 부여"). */
export async function POST(req: NextRequest) {
  if (!isAdminRequest(req)) return NextResponse.json({ error: '관리자 권한이 필요합니다.' }, { status: 403 })
  const { username, password } = await req.json() as NewUserBody
  if (!username?.trim() || !password) return NextResponse.json({ error: '아이디와 비밀번호를 입력해주세요.' }, { status: 400 })

  const dup = await pool.query('SELECT id FROM users WHERE username=$1', [username.trim()])
  if (dup.rows.length) return NextResponse.json({ error: '이미 존재하는 아이디입니다.' }, { status: 409 })

  const { hash, salt } = hashPassword(password)
  const res = await pool.query<{ id: number }>(
    "INSERT INTO users (username, password_hash, password_salt, role) VALUES ($1,$2,$3,'user') RETURNING id",
    [username.trim(), hash, salt],
  )
  return NextResponse.json({ id: res.rows[0].id })
}
