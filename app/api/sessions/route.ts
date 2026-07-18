import { NextResponse } from 'next/server'
import pool from '@/lib/db'

/** 세션별로 원 상품페이지에서 찾은 개수(product_count) 대비 실제 저장된 상품 수를 비교한다. */
export async function GET() {
  const res = await pool.query(`
    SELECT s.id, s.site_id, s.url, s.status, s.scope_type, s.mode, s.product_count AS found_count,
           COUNT(p.id) AS saved_count, s.created_at, s.merge_group_id, s.merged_at,
           site.name AS site_name, client.name AS client_name,
           (SELECT COUNT(*) FROM scrape_staging_items si WHERE si.session_id = s.id) AS staged_count,
           (SELECT COUNT(*) FROM scrape_staging_items si WHERE si.session_id = s.id AND si.status = 'pending') AS pending_count,
           (SELECT COUNT(*) FROM scrape_staging_items si WHERE si.session_id = s.id AND si.status = 'merged')  AS merged_count,
           (SELECT COUNT(*) FROM scrape_staging_items si WHERE si.session_id = s.id AND si.status = 'skipped') AS skipped_count
    FROM scrape_sessions s
    LEFT JOIN mall_products p ON p.last_seen_session_id = s.id
    LEFT JOIN sites site ON site.id = s.site_id
    LEFT JOIN supply_clients client ON client.id = site.client_id
    GROUP BY s.id, s.merge_group_id, s.merged_at, site.name, client.name
    ORDER BY s.created_at DESC
  `)
  return NextResponse.json(res.rows)
}
