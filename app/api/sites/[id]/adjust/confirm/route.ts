import { NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'
import { reExtractStagingItems } from '@/lib/scrape/reextract'

interface ConfirmBody {
  sessionId: number
}

/**
 * "조정 확정" — 일반모드 몰 전용. "스크랩 조정 개시"로 이미 저장된 sites.extraction_rules를 그대로 이
 * 세션의 미확정 항목 전체에 적용한다(AI를 다시 부르지 않는다 — 규칙은 이미 만들어져 있다).
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const siteId = Number(id)
  const body = await req.json() as ConfirmBody
  if (!body.sessionId) return NextResponse.json({ error: 'sessionId가 필요합니다' }, { status: 400 })

  const res = await pool.query<{ id: number }>(
    `SELECT id FROM scrape_staging_items WHERE session_id=$1 AND site_id=$2 AND status='pending'`,
    [body.sessionId, siteId],
  )
  if (!res.rows.length) return NextResponse.json({ error: '적용할 대상(미확정 항목)이 이 세션에 없습니다' }, { status: 400 })

  const { updated, failed } = await reExtractStagingItems(res.rows.map(r => r.id))
  return NextResponse.json({ updated: updated.length, failed })
}
