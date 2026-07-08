import { NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'

const ALLOWED = [
  'name_final', 'master_category', 'brand', 'manufacturer', 'origin', 'description',
  'cost_price', 'list_price', 'sale_price', 'shipping_fee', 'other_cost', 'target_margin_rate', 'status',
]

export async function GET(_: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const res = await pool.query(
    `SELECT pm.*, mp.id AS mall_product_id_ref, mp.source_url, mp.mall_product_code,
            (SELECT storage_path FROM product_images pi WHERE pi.product_master_id = pm.id AND pi.image_type = 'thumbnail' LIMIT 1) AS thumbnail_local,
            COALESCE(
              (SELECT json_agg(pi.storage_path ORDER BY pi.sort_order) FROM product_images pi WHERE pi.product_master_id = pm.id AND pi.image_type = 'detail'),
              '[]'
            ) AS detail_image_local
     FROM product_master pm
     LEFT JOIN mall_products mp ON mp.id = pm.mall_product_id
     WHERE pm.id = $1`,
    [id],
  )
  if (!res.rows.length) return NextResponse.json({ error: 'not found' }, { status: 404 })
  return NextResponse.json(res.rows[0])
}

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
