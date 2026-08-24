import { NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'
import { reExtractStagingItems } from '@/lib/workerClient'

/**
 * "조정 확정" — 일반모드 몰 전용. "스크랩 조정 개시"로 이미 저장된 sites.extraction_rules를 그대로,
 * 이 몰의 세션 구분 없이 아직 미확정(pending)인 상품 전체 — "기 스크랩했던 전체 상품" — 에 적용한다
 * (AI를 다시 부르지 않는다 — 규칙은 이미 만들어져 있다). 이미 확정(merged)된 상품은 건드리지 않는다.
 */
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const siteId = Number(id)

  const res = await pool.query<{ id: number }>(
    `SELECT id FROM scrape_staging_items WHERE site_id=$1 AND status='pending'`,
    [siteId],
  )
  if (!res.rows.length) return NextResponse.json({ error: '적용할 대상(미확정 항목)이 이 몰에 없습니다' }, { status: 400 })

  const { updated, failed } = await reExtractStagingItems(res.rows.map(r => r.id))
  return NextResponse.json({ updated: updated.length, failed })
}
