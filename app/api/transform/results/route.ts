import { NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'
import { commitGeneratedRow } from '@/lib/transform/generate'

export async function GET(req: NextRequest) {
  const siteId = Number(req.nextUrl.searchParams.get('siteId'))
  if (!siteId) return NextResponse.json({ error: 'siteId required' }, { status: 400 })

  const res = await pool.query(`
    SELECT gr.id, gr.mall_product_id, gr.product_master_id, gr.generated_values, gr.status, gr.updated_at,
           mp.mall_product_code, mp.name_original
    FROM transform_generated_rows gr
    JOIN mall_products mp ON mp.id = gr.mall_product_id
    WHERE gr.site_id = $1
    ORDER BY gr.updated_at DESC
  `, [siteId])
  return NextResponse.json(res.rows)
}

/** 검토 그리드에서 셀 하나를 수정한다. */
export async function PUT(req: NextRequest) {
  const b = await req.json() as { id: number; columnName: string; value: string }
  if (!b.id || !b.columnName) return NextResponse.json({ error: 'id, columnName required' }, { status: 400 })

  await pool.query(
    `UPDATE transform_generated_rows SET generated_values = jsonb_set(generated_values, $1, to_jsonb($2::text)), updated_at = NOW() WHERE id = $3`,
    [`{${b.columnName}}`, b.value, b.id],
  )
  return NextResponse.json({ ok: true })
}

/** 확정: product_master에 매핑된 컬럼 값을 반영한다. */
export async function POST(req: NextRequest) {
  const b = await req.json() as { id: number; clientId: number }
  if (!b.id || !b.clientId) return NextResponse.json({ error: 'id, clientId required' }, { status: 400 })

  const productMasterId = await commitGeneratedRow(b.id, b.clientId)
  return NextResponse.json({ productMasterId })
}
