import { NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'
import { ALLOWED_TARGET_FIELDS, type RuleMode } from '@/lib/transform/generate'

const VALID_MODES = new Set<RuleMode>(['ai', 'lookup', 'copy', 'composite'])

/** siteId의 최신 업로드 헤더 기준으로, 헤더마다 한 행씩(기존 규칙 있으면 그 값, 없으면 기본값) 반환한다. */
export async function GET(req: NextRequest) {
  const siteId = Number(req.nextUrl.searchParams.get('siteId'))
  if (!siteId) return NextResponse.json({ error: 'siteId required' }, { status: 400 })

  const uploadRes = await pool.query<{ column_headers: string[] }>(
    `SELECT column_headers FROM transform_reference_uploads WHERE site_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [siteId],
  )
  const headers = uploadRes.rows[0]?.column_headers || []

  const rulesRes = await pool.query(
    `SELECT id, column_name, target_field, mode, ai_instruction, source_field, composite_config
     FROM transform_column_rules WHERE site_id = $1`,
    [siteId],
  )
  const ruleByName = new Map(rulesRes.rows.map(r => [r.column_name, r]))

  const rows = headers.map(name => ruleByName.get(name) || {
    id: null, column_name: name, target_field: null, mode: 'ai' as RuleMode,
    ai_instruction: '', source_field: null, composite_config: {},
  })
  return NextResponse.json({ rows, allowedTargetFields: [...ALLOWED_TARGET_FIELDS] })
}

interface ColumnRuleBody {
  siteId: number
  columnName: string
  targetField?: string | null
  mode: RuleMode
  aiInstruction?: string
  sourceField?: string | null
  compositeConfig?: Record<string, unknown>
}

export async function PUT(req: NextRequest) {
  const b = await req.json() as ColumnRuleBody
  if (!b.siteId || !b.columnName) return NextResponse.json({ error: 'siteId, columnName required' }, { status: 400 })
  if (!VALID_MODES.has(b.mode)) return NextResponse.json({ error: 'invalid mode' }, { status: 400 })
  if (b.targetField && !ALLOWED_TARGET_FIELDS.has(b.targetField)) {
    return NextResponse.json({ error: 'invalid targetField' }, { status: 400 })
  }

  const res = await pool.query<{ id: number }>(
    `INSERT INTO transform_column_rules (site_id, column_name, target_field, mode, ai_instruction, source_field, composite_config)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (site_id, column_name) DO UPDATE SET
       target_field = $3, mode = $4, ai_instruction = $5, source_field = $6, composite_config = $7
     RETURNING id`,
    [b.siteId, b.columnName, b.targetField || null, b.mode, b.aiInstruction || null, b.sourceField || null,
      JSON.stringify(b.compositeConfig || {})],
  )
  return NextResponse.json({ id: res.rows[0].id })
}
