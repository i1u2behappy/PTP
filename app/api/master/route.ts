import { NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'

export async function GET(req: NextRequest) {
  const clientId = Number(req.nextUrl.searchParams.get('clientId')) || 1

  const res = await pool.query(
    `SELECT pm.id, pm.mall_product_id, pm.name_original, pm.name_ai, pm.name_final,
            pm.mall_category, pm.master_category, pm.brand, pm.manufacturer, pm.origin, pm.description,
            pm.options, pm.cost_price, pm.list_price, pm.sale_price, pm.shipping_fee, pm.other_cost,
            pm.target_margin_rate, pm.stock_status, pm.stock_qty, pm.status, pm.updated_at,
            (SELECT storage_path FROM product_images pi WHERE pi.product_master_id = pm.id AND pi.image_type = 'thumbnail' LIMIT 1) AS thumbnail_local
     FROM product_master pm
     WHERE pm.client_id = $1
     ORDER BY pm.updated_at DESC`,
    [clientId],
  )
  return NextResponse.json(res.rows)
}
