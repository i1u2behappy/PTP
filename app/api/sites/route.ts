import { NextRequest, NextResponse } from 'next/server'
import pool, { initDb } from '@/lib/db'

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

  const res = await pool.query<{ id: number }>(
    `INSERT INTO sites (name, url, login_id, login_pw) VALUES ($1,$2,$3,$4) RETURNING id`,
    [name || null, url, loginId || null, loginPw || null],
  )
  return NextResponse.json({ id: res.rows[0].id })
}
