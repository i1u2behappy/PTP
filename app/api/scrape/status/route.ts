import { NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'

export async function GET(req: NextRequest) {
  const sessionId = req.nextUrl.searchParams.get('sessionId')
  if (!sessionId) return NextResponse.json({ error: 'sessionId required' }, { status: 400 })

  const res = await pool.query(
    `SELECT s.id, s.status, s.product_count, s.error,
            COUNT(si.id) AS saved_count
     FROM scrape_sessions s
     LEFT JOIN scrape_staging_items si ON si.session_id = s.id
     WHERE s.id = $1
     GROUP BY s.id`,
    [sessionId],
  )
  if (!res.rows[0]) return NextResponse.json({ error: 'not found' }, { status: 404 })
  return NextResponse.json(res.rows[0])
}
