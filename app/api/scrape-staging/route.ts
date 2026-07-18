import { NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'
import { resolveSessionGroup } from '@/lib/scrape/mergeGroup'

const COMPARE_FIELDS = [
  ['name_original', 'mp_name_original'],
  ['price', 'mp_price'],
  ['sale_price', 'mp_sale_price'],
  ['mall_category', 'mp_mall_category'],
  ['brand', 'mp_brand'],
  ['manufacturer', 'mp_manufacturer'],
  ['origin', 'mp_origin'],
  ['description', 'mp_description'],
  ['stock_status', 'mp_stock_status'],
  ['stock_qty', 'mp_stock_qty'],
] as const

export async function GET(req: NextRequest) {
  const sessionId = req.nextUrl.searchParams.get('sessionId')
  const siteId    = req.nextUrl.searchParams.get('siteId')
  const status    = req.nextUrl.searchParams.get('status')

  let query = `
    SELECT si.*,
           mp.name_original AS mp_name_original, mp.price AS mp_price, mp.sale_price AS mp_sale_price,
           mp.mall_category AS mp_mall_category, mp.brand AS mp_brand,
           mp.manufacturer AS mp_manufacturer, mp.origin AS mp_origin, mp.description AS mp_description,
           mp.stock_status AS mp_stock_status, mp.stock_qty AS mp_stock_qty
    FROM scrape_staging_items si
    LEFT JOIN mall_products mp ON mp.id = si.matched_mall_product_id
    WHERE 1=1`
  const params: (string | number | number[])[] = []
  // sessionId 하나만 넘어와도, 그 세션이 "선택 병합"된 그룹의 일원이면 그룹 전체를 함께 보여준다.
  if (sessionId) { params.push(await resolveSessionGroup(Number(sessionId))); query += ` AND si.session_id=ANY($${params.length})` }
  if (siteId)    { params.push(siteId);    query += ` AND si.site_id=$${params.length}` }
  if (status)    { params.push(status);    query += ` AND si.status=$${params.length}` }
  query += ' ORDER BY si.created_at DESC'

  const res = await pool.query(query, params)
  const rows = res.rows.map(r => ({
    ...r,
    changedFields: r.is_new ? [] : COMPARE_FIELDS.filter(([a, b]) => String(r[a] ?? '') !== String(r[b] ?? '')).map(([a]) => a),
  }))
  return NextResponse.json(rows)
}
