import { NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const res = await pool.query(
    `SELECT id, memo_at, content FROM client_memos WHERE client_id = $1 ORDER BY memo_at DESC, id DESC`,
    [id],
  )
  return NextResponse.json(res.rows)
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const { memoAt, content } = await req.json() as { memoAt?: string; content: string }
  if (!content) return NextResponse.json({ error: 'content required' }, { status: 400 })

  const res = await pool.query<{ id: number }>(
    memoAt
      ? `INSERT INTO client_memos (client_id, memo_at, content) VALUES ($1,$2,$3) RETURNING id`
      : `INSERT INTO client_memos (client_id, content) VALUES ($1,$2) RETURNING id`,
    memoAt ? [id, memoAt, content] : [id, content],
  )
  return NextResponse.json({ id: res.rows[0].id })
}
