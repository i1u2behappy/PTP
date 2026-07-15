import { NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'

/** 특정 스크래핑 세션에서 병합된 상품마스터만 골라 (진행현황 대시보드용) */
export async function GET(req: NextRequest) {
  const sessionId = req.nextUrl.searchParams.get('sessionId')
  if (!sessionId) return NextResponse.json([])

  const res = await pool.query(
    `SELECT DISTINCT pm.id, pm.name_original, pm.name_ai, pm.name_final, pm.master_category,
            pm.brand, pm.manufacturer, pm.origin, pm.options, pm.cost_price, pm.sale_price, pm.target_margin_rate,
            pm.internal_code, pm.sales_code,
            (SELECT COALESCE(jsonb_agg(storage_path ORDER BY sort_order), '[]') FROM product_images pi WHERE pi.product_master_id = pm.id AND pi.image_type = 'thumbnail') AS thumbnail_locals
     FROM product_master pm
     JOIN mall_products mp ON mp.id = pm.mall_product_id
     JOIN scrape_staging_items si ON si.matched_mall_product_id = mp.id
     WHERE si.session_id = $1`,
    [sessionId],
  )
  return NextResponse.json(res.rows)
}
