import { NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'
import { matchReferenceRows } from '@/lib/transform/matching'

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const uploadRes = await pool.query(
    `SELECT id, site_id, kind, file_name, column_headers, code_column, created_at FROM transform_reference_uploads WHERE id = $1`,
    [id],
  )
  if (!uploadRes.rows.length) return NextResponse.json({ error: 'not found' }, { status: 404 })

  const statsRes = await pool.query<{ total: string; matched: string }>(
    `SELECT COUNT(*) AS total, COUNT(matched_mall_product_id) AS matched FROM transform_reference_rows WHERE upload_id = $1`,
    [id],
  )
  return NextResponse.json({
    ...uploadRes.rows[0],
    total: Number(statsRes.rows[0].total),
    matched: Number(statsRes.rows[0].matched),
  })
}

/** 몰상품코드 컬럼을 확정하고, mall_products와 즉시 매칭한다. */
export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const b = await req.json() as { codeColumn: string }
  if (!b.codeColumn) return NextResponse.json({ error: 'codeColumn required' }, { status: 400 })

  await pool.query(`UPDATE transform_reference_uploads SET code_column = $1 WHERE id = $2`, [b.codeColumn, id])
  const stats = await matchReferenceRows(Number(id))
  return NextResponse.json(stats)
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  await pool.query(`DELETE FROM transform_reference_uploads WHERE id = $1`, [id])
  return NextResponse.json({ ok: true })
}
