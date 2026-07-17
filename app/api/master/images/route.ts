import { NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'

/** sessionId가 있으면 그 스크랩 세션에서 병합된 상품마스터로 범위를 좁힌다. */
export async function GET(req: NextRequest) {
  const sessionId = req.nextUrl.searchParams.get('sessionId')
  const clientId = Number(req.nextUrl.searchParams.get('clientId')) || 1

  const res = sessionId
    ? await pool.query(
        `SELECT pm.id, pm.name_original, pm.name_final,
                COALESCE(
                  (SELECT json_agg(json_build_object('id', pi.id, 'image_type', pi.image_type, 'sort_order', pi.sort_order, 'storage_path', pi.storage_path)
                           ORDER BY pi.image_type, pi.sort_order)
                   FROM product_images pi WHERE pi.product_master_id = pm.id), '[]'
                ) AS images
         FROM product_master pm
         WHERE EXISTS (
           SELECT 1 FROM mall_products mp JOIN scrape_staging_items si ON si.matched_mall_product_id = mp.id
           WHERE mp.id = pm.mall_product_id AND si.session_id = $1
         )
         ORDER BY pm.name_original`,
        [sessionId],
      )
    : await pool.query(
        `SELECT pm.id, pm.name_original, pm.name_final,
                COALESCE(
                  json_agg(json_build_object('id', pi.id, 'image_type', pi.image_type, 'sort_order', pi.sort_order, 'storage_path', pi.storage_path)
                           ORDER BY pi.image_type, pi.sort_order)
                  FILTER (WHERE pi.id IS NOT NULL), '[]'
                ) AS images
         FROM product_master pm
         LEFT JOIN product_images pi ON pi.product_master_id = pm.id
         WHERE pm.client_id = $1
         GROUP BY pm.id
         ORDER BY pm.updated_at DESC`,
        [clientId],
      )
  return NextResponse.json(res.rows)
}
