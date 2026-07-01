import { NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const body = await req.json() as Record<string, unknown>
  const allowed = ['name_original','name_ai','price','sale_price','brand','manufacturer','origin','category','description','status']
  const sets: string[] = []
  const vals: unknown[] = []
  for (const key of allowed) {
    if (key in body) { vals.push(body[key]); sets.push(`${key}=$${vals.length}`) }
  }
  if (!sets.length) return NextResponse.json({ error: 'no fields' }, { status: 400 })
  vals.push(id)
  await pool.query(`UPDATE products SET ${sets.join(',')}, updated_at=NOW() WHERE id=$${vals.length}`, vals)
  return NextResponse.json({ ok: true })
}

export async function DELETE(_: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  await pool.query('DELETE FROM products WHERE id=$1', [id])
  return NextResponse.json({ ok: true })
}
