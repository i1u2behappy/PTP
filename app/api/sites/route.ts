import { NextRequest, NextResponse } from 'next/server'
import pool, { initDb, encryptSecret } from '@/lib/db'

export async function GET(req: NextRequest) {
  await initDb()
  const q = req.nextUrl.searchParams.get('q') || ''
  const res = await pool.query(
    `SELECT id, name, url, login_id, created_at FROM sites
     WHERE name ILIKE $1 OR url ILIKE $1
     ORDER BY created_at DESC`,
    [`%${q}%`],
  )
  return NextResponse.json(res.rows)
}

export async function POST(req: NextRequest) {
  await initDb()
  const { name, url, loginId, loginPw } = await req.json() as { name?: string; url: string; loginId?: string; loginPw?: string }
  if (!url) return NextResponse.json({ error: 'url required' }, { status: 400 })

  const { encrypted, iv } = loginPw ? encryptSecret(loginPw) : { encrypted: null, iv: null }
  const res = await pool.query<{ id: number }>(
    `INSERT INTO sites (name, url, login_id, login_pw_encrypted, login_pw_iv) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [name || null, url, loginId || null, encrypted, iv],
  )
  return NextResponse.json({ id: res.rows[0].id })
}
