import { NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'

export async function DELETE(_: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  await pool.query('DELETE FROM product_images WHERE id=$1', [id])
  return NextResponse.json({ ok: true })
}

/** 이미지의 대표/상세 구분을 변경한다. 대표이미지는 여러 장 허용되므로 기존 대표이미지를 내리지 않고, 이동한
 *  이미지를 새 구분의 맨 뒤(sort_order 최대값+1)에 붙인다. */
export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const body = await req.json() as { imageType?: string }
  if (body.imageType !== 'thumbnail' && body.imageType !== 'detail') return NextResponse.json({ error: 'unsupported imageType' }, { status: 400 })

  const cur = await pool.query<{ product_master_id: number | null }>('SELECT product_master_id FROM product_images WHERE id=$1', [id])
  const masterId = cur.rows[0]?.product_master_id
  if (!masterId) return NextResponse.json({ error: 'not found' }, { status: 404 })

  await pool.query(
    `UPDATE product_images SET image_type=$1,
       sort_order = (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM product_images WHERE product_master_id=$2 AND image_type=$1)
     WHERE id=$3`,
    [body.imageType, masterId, id],
  )
  return NextResponse.json({ ok: true })
}
