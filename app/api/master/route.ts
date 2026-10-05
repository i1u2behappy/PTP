import { NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'
import { resolveSessionGroup } from '@/lib/scrape/mergeGroup'

/** sessionId가 있으면 그 스크랩 세션(또는 "선택 병합"된 경우 그 그룹 전체)에서 병합된 상품마스터로 범위를 좁힌다(마이그레이션 하위 메뉴 공용). */
export async function GET(req: NextRequest) {
  const sessionId = req.nextUrl.searchParams.get('sessionId')
  const clientId = Number(req.nextUrl.searchParams.get('clientId')) || 1

  const res = sessionId
    ? await pool.query(
        `SELECT DISTINCT pm.id, pm.mall_product_id, pm.name_original, pm.name_ai, pm.name_final,
                pm.mall_category, pm.master_category, pm.master_category_id, pm.brand, pm.manufacturer, pm.origin, pm.description,
                pm.options, pm.cost_price, pm.list_price, pm.sale_price, pm.shipping_fee, pm.other_cost,
                pm.target_margin_rate, pm.stock_status, pm.stock_qty, pm.status, pm.updated_at,
                pm.internal_code, pm.sales_code, mp.mall_product_code,
                (SELECT COALESCE(jsonb_agg(storage_path ORDER BY sort_order), '[]') FROM product_images pi WHERE pi.product_master_id = pm.id AND pi.image_type = 'thumbnail') AS thumbnail_locals
         FROM product_master pm
         JOIN mall_products mp ON mp.id = pm.mall_product_id
         JOIN scrape_staging_items si ON si.matched_mall_product_id = mp.id
         WHERE si.session_id = ANY($1)
         ORDER BY pm.updated_at DESC`,
        [await resolveSessionGroup(Number(sessionId))],
      )
    : await pool.query(
        `SELECT pm.id, pm.mall_product_id, pm.name_original, pm.name_ai, pm.name_final,
                pm.mall_category, pm.master_category, pm.master_category_id, pm.brand, pm.manufacturer, pm.origin, pm.description,
                pm.options, pm.cost_price, pm.list_price, pm.sale_price, pm.shipping_fee, pm.other_cost,
                pm.target_margin_rate, pm.stock_status, pm.stock_qty, pm.status, pm.updated_at,
                pm.internal_code, pm.sales_code, mp.mall_product_code,
                (SELECT COALESCE(jsonb_agg(storage_path ORDER BY sort_order), '[]') FROM product_images pi WHERE pi.product_master_id = pm.id AND pi.image_type = 'thumbnail') AS thumbnail_locals
         FROM product_master pm
         LEFT JOIN mall_products mp ON mp.id = pm.mall_product_id
         WHERE pm.client_id = $1
         ORDER BY pm.updated_at DESC`,
        [clientId],
      )
  return NextResponse.json(res.rows)
}
