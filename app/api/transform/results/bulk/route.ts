import { NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'
import { commitGeneratedRows } from '@/lib/transform/generate'

/** 여러 draft 검토 결과를 한 번에 확정(반영)한다. ids를 생략하면 그 site의 draft 전체가 대상. */
export async function POST(req: NextRequest) {
  const b = await req.json() as { siteId: number; clientId: number; ids?: number[] }
  if (!b.siteId || !b.clientId) return NextResponse.json({ error: 'siteId, clientId required' }, { status: 400 })

  let ids = b.ids
  if (!ids) {
    const res = await pool.query<{ id: number }>(
      `SELECT id FROM transform_generated_rows WHERE site_id=$1 AND status='draft'`, [b.siteId],
    )
    ids = res.rows.map(r => r.id)
  }
  if (!ids.length) return NextResponse.json({ committed: [], failed: [] })

  const result = await commitGeneratedRows(ids, b.clientId)
  return NextResponse.json(result)
}
