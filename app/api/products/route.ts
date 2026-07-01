import { NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'

export async function GET(req: NextRequest) {
  const sessionId = req.nextUrl.searchParams.get('sessionId')
  const status    = req.nextUrl.searchParams.get('status')

  let query = `SELECT id, session_id, source_url, name_original, name_ai,
                      price, sale_price, brand, manufacturer, origin, category,
                      thumbnail_local, thumbnail_url, detail_images, options,
                      description, status, created_at
               FROM products WHERE 1=1`
  const params: (string | number)[] = []
  if (sessionId) { params.push(sessionId); query += ` AND session_id=$${params.length}` }
  if (status)    { params.push(status);    query += ` AND status=$${params.length}` }
  query += ' ORDER BY created_at DESC'

  const res = await pool.query(query, params)
  return NextResponse.json(res.rows)
}
