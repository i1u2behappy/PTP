import { NextResponse } from 'next/server'
import pool from '@/lib/db'
import { getActiveMergeBatch } from '@/lib/scrape/staging'

/**
 * StagingItemsGrid가 마운트될 때(새로고침 포함) 지금 서버에서 진행 중인 "확정" 배치가 있는지 확인해
 * 진행률 폴링을 이어 붙이기 위한 용도 — mergeStagingItems 자체는 서버에서 계속 실행되는데 화면(React
 * state)만 새로고침으로 사라져 "5분 넘게 0%"처럼 보이던 문제를 고친다(사용자 실사용 확인, 2026-08-27).
 * 주어진 ids 중 status<>'pending' 개수로 done을 센다 — ids를 요청 쪽에서 실어보낼 필요가 없어(서버가
 * getActiveMergeBatch로 이미 기억함), 선택 개수가 수천 개라도 URL/헤더 크기 문제가 생기지 않는다
 * (예전엔 폴링 자체가 ids를 쿼리스트링으로 보내는 별도 라우트(/merge/progress)를 썼는데, 그 URL이
 * 선택 개수만큼 길어져 수천 개를 선택하면 Node가 431으로 요청을 거절했다 — 2026-09-06 실사용 확인,
 * 화면은 이 실패를 조용히 삼켜 진행률이 0%에 멈춘 것처럼 보였다. 이 라우트로 통합해 문제 자체를 없앴다). */
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
