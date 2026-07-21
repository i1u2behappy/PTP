import { NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'
import type { ExtractionRule } from '@/lib/ai'

/** 화면에 클릭할 요소가 없는 값(예: 택배사)을 모든 상품에 그대로 채울 고정값 컬럼으로 등록한다 —
 *  페이지를 읽지 않고 value를 그대로 쓰는 type:'fixed' 규칙. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const siteId = Number(id)
  if (!siteId) return NextResponse.json({ error: 'invalid site id' }, { status: 400 })
  const { field, value } = await req.json() as { field?: string; value?: string }
  if (!field?.trim() || !value?.trim()) return NextResponse.json({ error: 'field, value required' }, { status: 400 })

  const res = await pool.query<{ extraction_rules: Record<string, ExtractionRule> | null }>(
    'SELECT extraction_rules FROM sites WHERE id=$1', [siteId],
  )
  const merged = { ...(res.rows[0]?.extraction_rules || {}), [field.trim()]: { type: 'fixed' as const, value: value.trim() } }
  await pool.query('UPDATE sites SET extraction_rules=$1 WHERE id=$2', [JSON.stringify(merged), siteId])
  return NextResponse.json({ ok: true })
}

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
