import { NextResponse } from 'next/server'
import pool from '@/lib/db'
import { getActiveMergeBatch } from '@/lib/scrape/staging'

/**
 * StagingItemsGrid가 마운트될 때(새로고침 포함) 지금 서버에서 진행 중인 "확정" 배치가 있는지 확인해
 * 진행률 폴링을 이어 붙이기 위한 용도 — mergeStagingItems 자체는 서버에서 계속 실행되는데 화면(React
 * state)만 새로고침으로 사라져 "5분 넘게 0%"처럼 보이던 문제를 고친다(사용자 실사용 확인, 2026-08-27).
 * /merge/progress와 같은 방식(주어진 ids 중 status<>'pending' 개수)으로 done을 센다.
 */
export async function GET() {
  const batch = getActiveMergeBatch()
  if (!batch) return NextResponse.json({ active: false })

  const res = await pool.query<{ count: string }>(
    `SELECT COUNT(*) FROM scrape_staging_items WHERE id = ANY($1) AND status <> 'pending'`,
    [batch.ids],
  )
  return NextResponse.json({
    active: true, ids: batch.ids, total: batch.ids.length, done: Number(res.rows[0].count), startedAtMs: batch.startedAt,
  })
}
