import { NextResponse } from 'next/server'
import pool from '@/lib/db'

/** 세션별로 원 상품페이지에서 찾은 개수(product_count) 대비 실제 저장된 상품 수를 비교한다. */
export async function GET() {
  const res = await pool.query(`
    SELECT s.id, s.url, s.status, s.scope_type, s.mode, s.product_count AS found_count,
           COUNT(p.id) AS saved_count, s.created_at
    FROM scrape_sessions s
    LEFT JOIN mall_products p ON p.last_seen_session_id = s.id
    GROUP BY s.id
    ORDER BY s.created_at DESC
  `)
  return NextResponse.json(res.rows)
}
