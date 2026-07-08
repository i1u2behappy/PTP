import { NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'

const ALLOWED = [
  'name_final', 'master_category', 'brand', 'manufacturer', 'origin', 'description',
  'cost_price', 'list_price', 'sale_price', 'shipping_fee', 'other_cost', 'target_margin_rate', 'status',
]

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const body = await req.json() as Record<string, unknown>
  const sets: string[] = []
  const vals: unknown[] = []
  for (const key of ALLOWED) {
    if (key in body) { vals.push(body[key]); sets.push(`${key}=$${vals.length}`) }
  }
  if (!sets.length) return NextResponse.json({ error: 'no fields' }, { status: 400 })
  vals.push(id)
  await pool.query(`UPDATE product_master SET ${sets.join(',')}, updated_at=NOW() WHERE id=$${vals.length}`, vals)
  return NextResponse.json({ ok: true })
}

export async function DELETE(_: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  await pool.query('DELETE FROM product_master WHERE id=$1', [id])
  return NextResponse.json({ ok: true })
}
