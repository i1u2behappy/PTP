import { NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'

/** 상품마스터가 연결된 원천 상품(mall_product)의 가격/재고 변경 이력 */
export async function GET(_: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const master = await pool.query<{ mall_product_id: number | null }>('SELECT mall_product_id FROM product_master WHERE id=$1', [id])
  const mallProductId = master.rows[0]?.mall_product_id
  if (!mallProductId) return NextResponse.json([])

  const res = await pool.query(
    `SELECT stock_status, stock_qty, price, sale_price, captured_at
     FROM stock_snapshots WHERE mall_product_id=$1
     ORDER BY captured_at DESC LIMIT 50`,
    [mallProductId],
  )
  return NextResponse.json(res.rows)
}
