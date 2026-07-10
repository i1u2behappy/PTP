import { NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'

/** 카탈로그 스크랩 세션의 상품별 성공/실패 로그 (진행 화면의 실시간 로그 + 실패 재시도 큐용). */
export async function GET(req: NextRequest) {
  const sessionId = req.nextUrl.searchParams.get('sessionId')
  if (!sessionId) return NextResponse.json({ error: 'sessionId required' }, { status: 400 })

  const res = await pool.query(
    `SELECT id, url, status, error, created_at FROM scrape_item_log WHERE session_id=$1 ORDER BY id DESC LIMIT 200`,
    [sessionId],
  )
  return NextResponse.json(res.rows)
}
