import { NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'

/** scrape_sessions 삭제 시 scrape_staging_items/scrape_item_log는 FK ON DELETE CASCADE로 함께 삭제된다.
 *  이미 병합되어 mall_products/product_master로 넘어간 상품(및 그 이미지)은 세션과 독립된 데이터라 건드리지 않는다. */
export async function DELETE(_: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  await pool.query('DELETE FROM scrape_sessions WHERE id=$1', [id])
  return NextResponse.json({ ok: true })
}
