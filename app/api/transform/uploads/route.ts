import { NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'
import { parseReferenceWorkbook, guessCodeColumn, type UploadKind } from '@/lib/transform/matching'

const VALID_KINDS = new Set<UploadKind>(['as_is', 'to_be'])

export async function GET(req: NextRequest) {
  const siteId = Number(req.nextUrl.searchParams.get('siteId'))
  if (!siteId) return NextResponse.json({ error: 'siteId required' }, { status: 400 })

  const res = await pool.query(`
    SELECT u.id, u.kind, u.file_name, u.column_headers, u.code_column, u.created_at,
           COUNT(rr.id)::int AS row_count,
           COUNT(rr.matched_mall_product_id)::int AS matched_count
    FROM transform_reference_uploads u
    LEFT JOIN transform_reference_rows rr ON rr.upload_id = u.id
    WHERE u.site_id = $1
    GROUP BY u.id
    ORDER BY u.created_at DESC
  `, [siteId])
  return NextResponse.json(res.rows)
}

export async function POST(req: NextRequest) {
  const form = await req.formData()
  const file = form.get('file')
  const siteId = Number(form.get('siteId'))
  const kind = String(form.get('kind') || '')
  if (!(file instanceof File)) return NextResponse.json({ error: 'file required' }, { status: 400 })
  if (!siteId) return NextResponse.json({ error: 'siteId required' }, { status: 400 })
  if (!VALID_KINDS.has(kind as UploadKind)) return NextResponse.json({ error: 'kind must be as_is or to_be' }, { status: 400 })

  const buffer = Buffer.from(await file.arrayBuffer())
  const { headers, rows } = await parseReferenceWorkbook(buffer)
  if (!headers.length) return NextResponse.json({ error: '엑셀 헤더를 읽지 못했습니다.' }, { status: 400 })

  const uploadRes = await pool.query<{ id: number }>(
    `INSERT INTO transform_reference_uploads (site_id, kind, file_name, column_headers) VALUES ($1, $2, $3, $4) RETURNING id`,
    [siteId, kind, file.name, JSON.stringify(headers)],
  )
  const uploadId = uploadRes.rows[0].id

  for (const row of rows) {
    const code = guessCodeColumn(headers)
    await pool.query(
      `INSERT INTO transform_reference_rows (upload_id, mall_product_code, row_values) VALUES ($1, $2, $3)`,
      [uploadId, code ? row[code] || null : null, JSON.stringify(row)],
    )
  }

  // TO-BE를 새로 올리면 헤더 구성이 바뀔 수 있어, 이미 매핑해둔 규칙 중 새 헤더에 없는 컬럼을 미리 알려준다
  // (그대로 두면 /api/transform/columns가 조용히 그 규칙들을 무시하게 된다).
  let orphanedRules: string[] = []
  if (kind === 'to_be') {
    const rulesRes = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM transform_column_rules WHERE site_id = $1 AND target_field IS NOT NULL`, [siteId],
    )
    orphanedRules = rulesRes.rows.map(r => r.column_name).filter(name => !headers.includes(name))
  }

  return NextResponse.json({
    id: uploadId,
    headers,
    rowCount: rows.length,
    guessedCodeColumn: guessCodeColumn(headers),
    orphanedRules,
  })
}
