import { NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const res = await pool.query(
    `SELECT id, name, url, login_id, login_pw FROM sites WHERE id = $1`,
    [id],
  )
  if (!res.rows.length) return NextResponse.json({ error: 'not found' }, { status: 404 })
  return NextResponse.json(res.rows[0])
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const { name, url, loginId, loginPw } = await req.json() as { name?: string; url: string; loginId?: string; loginPw?: string }
  if (!url) return NextResponse.json({ error: 'url required' }, { status: 400 })

  await pool.query(
    `UPDATE sites SET name=$1, url=$2, login_id=$3, login_pw=$4 WHERE id=$5`,
    [name || null, url, loginId || null, loginPw || null, id],
  )
  return NextResponse.json({ ok: true })
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  await pool.query(`DELETE FROM sites WHERE id = $1`, [id])
  return NextResponse.json({ ok: true })
}
