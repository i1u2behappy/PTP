import { NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'

/** "스크랩 대상 직접지정"으로 저장한 컬럼 하나를 지운다 — 나머지 규칙은 그대로 둔다. */
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const siteId = Number(id)
  if (!siteId) return NextResponse.json({ error: 'invalid site id' }, { status: 400 })
  const { field } = await req.json() as { field?: string }
  if (!field) return NextResponse.json({ error: 'field required' }, { status: 400 })

  const res = await pool.query<{ extraction_rules: Record<string, unknown> | null }>(
    'SELECT extraction_rules FROM sites WHERE id=$1', [siteId],
  )
  const rules = { ...(res.rows[0]?.extraction_rules || {}) }
  delete rules[field]
  await pool.query('UPDATE sites SET extraction_rules=$1 WHERE id=$2', [JSON.stringify(rules), siteId])
  return NextResponse.json({ ok: true })
}
