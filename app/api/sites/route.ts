import { NextRequest, NextResponse } from 'next/server'
import pool, { initDb, encryptSecret } from '@/lib/db'

export async function GET(req: NextRequest) {
  await initDb()
  const q = req.nextUrl.searchParams.get('q') || ''
  const res = await pool.query(
    `SELECT s.id, s.name, s.url, s.login_id, s.client_id, c.name AS client_name, s.created_at
     FROM sites s LEFT JOIN supply_clients c ON c.id = s.client_id
     WHERE s.name ILIKE $1 OR s.url ILIKE $1
     ORDER BY s.created_at DESC`,
    [`%${q}%`],
  )
  return NextResponse.json(res.rows)
}

export async function POST(req: NextRequest) {
  await initDb()
  const { name, url, loginId, loginPw, clientId } = await req.json() as
    { name?: string; url: string; loginId?: string; loginPw?: string; clientId?: number | null }
  if (!url) return NextResponse.json({ error: 'url required' }, { status: 400 })

  const { encrypted, iv } = loginPw ? encryptSecret(loginPw) : { encrypted: null, iv: null }
  const res = await pool.query<{ id: number }>(
    `INSERT INTO sites (name, url, login_id, login_pw_encrypted, login_pw_iv, client_id)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [name || null, url, loginId || null, encrypted, iv, clientId || null],
  )
  return NextResponse.json({ id: res.rows[0].id })
}
