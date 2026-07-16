import { NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'
import { getGuidePairs } from '@/lib/transform/matching'

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const res = await pool.query(
    `SELECT id, source_value, target_value FROM transform_lookup_entries WHERE rule_id = $1 ORDER BY source_value`,
    [id],
  )
  return NextResponse.json(res.rows)
}

/** 값매핑 규칙의 조회표 한 행을 저장한다. target_value가 비어있으면 해당 매핑을 삭제한다. */
export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const b = await req.json() as { sourceValue: string; targetValue: string }
  if (!b.sourceValue) return NextResponse.json({ error: 'sourceValue required' }, { status: 400 })

  const ruleRes = await pool.query<{ source_field: string | null }>(
    `SELECT source_field FROM transform_column_rules WHERE id = $1`,
    [id],
  )
  if (!ruleRes.rows.length) return NextResponse.json({ error: 'rule not found' }, { status: 404 })

  if (!b.targetValue) {
    await pool.query(`DELETE FROM transform_lookup_entries WHERE rule_id = $1 AND source_value = $2`, [id, b.sourceValue])
    return NextResponse.json({ ok: true })
  }

  await pool.query(
    `INSERT INTO transform_lookup_entries (rule_id, source_field, source_value, target_value)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (rule_id, source_field, source_value) DO UPDATE SET target_value = $4`,
    [id, ruleRes.rows[0].source_field || '', b.sourceValue, b.targetValue],
  )
  return NextResponse.json({ ok: true })
}

/**
 * 2번의 AS-IS/TO-BE 가이드 쌍에서 (source_field 값 → 이 컬럼의 완성값)을 뽑아 조회표 초안을 채운다.
 * 이미 있는 (rule_id, source_field, source_value) 조합은 사람이 수정했을 수 있어 덮어쓰지 않는다.
 */
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const ruleRes = await pool.query<{ site_id: number; column_name: string; source_field: string | null }>(
    `SELECT site_id, column_name, source_field FROM transform_column_rules WHERE id = $1`,
    [id],
  )
  const rule = ruleRes.rows[0]
  if (!rule?.source_field) return NextResponse.json({ error: 'source_field가 설정된 값 매핑 규칙이 아닙니다' }, { status: 400 })

  const pairs = await getGuidePairs(rule.site_id)
  let filled = 0
  for (const pair of pairs) {
    const sourceValue = (pair.asIs[rule.source_field] || '').trim()
    const targetValue = (pair.toBe[rule.column_name] || '').trim()
    if (!sourceValue || !targetValue) continue
    const res = await pool.query(
      `INSERT INTO transform_lookup_entries (rule_id, source_field, source_value, target_value)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (rule_id, source_field, source_value) DO NOTHING`,
      [id, rule.source_field, sourceValue, targetValue],
    )
    if ((res.rowCount ?? 0) > 0) filled++
  }
  return NextResponse.json({ filled, total: pairs.length })
}
