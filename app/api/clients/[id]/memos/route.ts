import { NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const res = await pool.query(
    `SELECT id, TO_CHAR(memo_date, 'YYYY-MM-DD') AS memo_date, content FROM client_memos WHERE client_id = $1 ORDER BY memo_date DESC, id DESC`,
    [id],
  )
  return NextResponse.json(res.rows)
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const { memoDate, content } = await req.json() as { memoDate?: string; content: string }
  if (!content) return NextResponse.json({ error: 'content required' }, { status: 400 })

  const res = await pool.query<{ id: number }>(
    memoDate
      ? `INSERT INTO client_memos (client_id, memo_date, content) VALUES ($1,$2,$3) RETURNING id`
      : `INSERT INTO client_memos (client_id, content) VALUES ($1,$2) RETURNING id`,
    memoDate ? [id, memoDate, content] : [id, content],
  )
  return NextResponse.json({ id: res.rows[0].id })
}
