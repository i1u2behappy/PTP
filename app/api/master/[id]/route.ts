import { NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'

const ALLOWED = [
  'name_final', 'master_category', 'brand', 'manufacturer', 'origin', 'description', 'options', 'sales_code',
  'internal_code', 'stock_status', 'stock_qty',
  'cost_price', 'list_price', 'sale_price', 'shipping_fee', 'other_cost', 'target_margin_rate', 'status',
]

export async function GET(_: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const res = await pool.query(
    `SELECT pm.*, mp.id AS mall_product_id_ref, mp.source_url, mp.mall_product_code,
            COALESCE(
              (SELECT json_agg(pi.storage_path ORDER BY pi.sort_order) FROM product_images pi WHERE pi.product_master_id = pm.id AND pi.image_type = 'thumbnail'),
              '[]'
            ) AS thumbnail_locals,
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
    if (key in body) { vals.push(key === 'options' ? JSON.stringify(body[key]) : body[key]); sets.push(`${key}=$${vals.length}`) }
  }
  // 기준 마스터테이블관리에서 등록한 커스텀 필드(전용 컬럼이 없는 값)는 product_master.custom_fields
  // JSONB에 담는다 — 통째로 갈아끼우면 여기서 안 보낸 다른 커스텀 값(스크랩 시 자동으로 채워진 값 등)이
  // 지워지므로, 기존 값 위에 병합한다.
  if (body.custom_fields && typeof body.custom_fields === 'object') {
    vals.push(JSON.stringify(body.custom_fields))
    sets.push(`custom_fields = COALESCE(custom_fields, '{}'::jsonb) || $${vals.length}::jsonb`)
  }
  if (!sets.length) return NextResponse.json({ error: 'no fields' }, { status: 400 })
  vals.push(id)
  try {
    await pool.query(`UPDATE product_master SET ${sets.join(',')}, updated_at=NOW() WHERE id=$${vals.length}`, vals)
  } catch (e) {
    if (e instanceof Error && 'code' in e && e.code === '23505') {
      return NextResponse.json({ error: '이미 다른 상품에 사용 중인 값입니다 (판매관리코드 등은 상품마다 고유해야 합니다).' }, { status: 409 })
    }
    throw e
  }
  return NextResponse.json({ ok: true })
}

export async function DELETE(_: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  await pool.query('DELETE FROM product_master WHERE id=$1', [id])
  return NextResponse.json({ ok: true })
}
