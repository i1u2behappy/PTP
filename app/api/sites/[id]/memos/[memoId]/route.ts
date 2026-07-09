import { NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'

export async function PUT(req: NextRequest, { params }: { params: Promise<{ memoId: string }> }) {
  const { memoId } = await params
  const { memoAt, content } = await req.json() as { memoAt: string; content: string }
  if (!content) return NextResponse.json({ error: 'content required' }, { status: 400 })

  await pool.query(`UPDATE site_memos SET memo_at=$1, content=$2 WHERE id=$3`, [memoAt, content, memoId])
  return NextResponse.json({ ok: true })
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ memoId: string }> }) {
  const { memoId } = await params
  await pool.query(`DELETE FROM site_memos WHERE id = $1`, [memoId])
  return NextResponse.json({ ok: true })
}
