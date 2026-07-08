import { NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'

/** 스크랩 검토 화면의 세션 선택기 — 세션별 대기중/병합됨/무시됨 건수를 함께 보여준다. */
export async function GET(req: NextRequest) {
  const siteId = req.nextUrl.searchParams.get('siteId')

  let query = `
    SELECT s.id, s.url, s.site_id, s.status AS session_status, s.scope_type, s.mode, s.created_at,
           COUNT(si.id) FILTER (WHERE si.status='pending') AS pending_count,
           COUNT(si.id) FILTER (WHERE si.status='merged')  AS merged_count,
           COUNT(si.id) FILTER (WHERE si.status='skipped') AS skipped_count
    FROM scrape_sessions s
    JOIN scrape_staging_items si ON si.session_id = s.id
    WHERE 1=1`
  const params: string[] = []
  if (siteId) { params.push(siteId); query += ` AND s.site_id=$${params.length}` }
  query += ' GROUP BY s.id ORDER BY s.created_at DESC'

  const res = await pool.query(query, params)
  return NextResponse.json(res.rows)
}
