import { NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'

export async function GET(req: NextRequest) {
  const siteId    = req.nextUrl.searchParams.get('siteId')
  const sessionId = req.nextUrl.searchParams.get('sessionId')

  let query = `SELECT mp.id, mp.site_id, mp.mall_product_code, mp.source_url, mp.mall_category,
                      mp.name_original, mp.price, mp.sale_price, mp.brand, mp.manufacturer, mp.origin,
                      mp.description, mp.options, mp.thumbnail_url, mp.detail_image_urls,
                      mp.stock_status, mp.stock_qty, mp.last_scraped_at, mp.master_product_id,
                      (SELECT storage_path FROM product_images pi WHERE pi.mall_product_id = mp.id AND pi.image_type = 'thumbnail' LIMIT 1) AS thumbnail_local
               FROM mall_products mp WHERE 1=1`
  const params: (string | number)[] = []
  if (siteId)    { params.push(siteId);    query += ` AND mp.site_id=$${params.length}` }
  if (sessionId) { params.push(sessionId); query += ` AND mp.last_seen_session_id=$${params.length}` }
  query += ' ORDER BY mp.updated_at DESC'

  const res = await pool.query(query, params)
  return NextResponse.json(res.rows)
}
