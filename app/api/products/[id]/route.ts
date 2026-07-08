import { NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'

export async function GET(_: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const res = await pool.query(
    `SELECT mp.*,
            (SELECT storage_path FROM product_images pi WHERE pi.mall_product_id = mp.id AND pi.image_type = 'thumbnail' LIMIT 1) AS thumbnail_local,
            COALESCE(
              (SELECT json_agg(pi.storage_path ORDER BY pi.sort_order) FROM product_images pi WHERE pi.mall_product_id = mp.id AND pi.image_type = 'detail'),
              '[]'
            ) AS detail_image_local
     FROM mall_products mp WHERE mp.id = $1`,
    [id],
  )
  if (!res.rows.length) return NextResponse.json({ error: 'not found' }, { status: 404 })
  return NextResponse.json(res.rows[0])
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const body = await req.json() as Record<string, unknown>
  const allowed = ['name_original', 'price', 'sale_price', 'brand', 'manufacturer', 'origin', 'mall_category', 'description']
  const sets: string[] = []
  const vals: unknown[] = []
  for (const key of allowed) {
    if (key in body) { vals.push(body[key]); sets.push(`${key}=$${vals.length}`) }
  }
  if (!sets.length) return NextResponse.json({ error: 'no fields' }, { status: 400 })
  vals.push(id)
  await pool.query(`UPDATE mall_products SET ${sets.join(',')}, updated_at=NOW() WHERE id=$${vals.length}`, vals)
  return NextResponse.json({ ok: true })
}

export async function DELETE(_: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  await pool.query('DELETE FROM mall_products WHERE id=$1', [id])
  return NextResponse.json({ ok: true })
}
