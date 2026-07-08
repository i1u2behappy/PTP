import { NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'

export async function GET() {
  const res = await pool.query(`SELECT id, name, memo, created_at FROM supply_clients ORDER BY created_at`)
  return NextResponse.json(res.rows)
}

export async function POST(req: NextRequest) {
  const { name, memo } = await req.json() as { name: string; memo?: string }
  if (!name) return NextResponse.json({ error: 'name required' }, { status: 400 })

  const res = await pool.query<{ id: number }>(
    `INSERT INTO supply_clients (name, memo) VALUES ($1,$2) RETURNING id`,
    [name, memo || null],
  )
  return NextResponse.json({ id: res.rows[0].id })
}
