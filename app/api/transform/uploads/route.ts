import { NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'
import { parseReferenceWorkbook, guessCodeColumn } from '@/lib/transform/matching'

export async function GET(req: NextRequest) {
  const siteId = Number(req.nextUrl.searchParams.get('siteId'))
  if (!siteId) return NextResponse.json({ error: 'siteId required' }, { status: 400 })

  const res = await pool.query(`
    SELECT u.id, u.file_name, u.column_headers, u.code_column, u.created_at,
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
  if (!(file instanceof File)) return NextResponse.json({ error: 'file required' }, { status: 400 })
  if (!siteId) return NextResponse.json({ error: 'siteId required' }, { status: 400 })

  const buffer = Buffer.from(await file.arrayBuffer())
  const { headers, rows } = await parseReferenceWorkbook(buffer)
  if (!headers.length) return NextResponse.json({ error: '엑셀 헤더를 읽지 못했습니다.' }, { status: 400 })

  const uploadRes = await pool.query<{ id: number }>(
    `INSERT INTO transform_reference_uploads (site_id, file_name, column_headers) VALUES ($1, $2, $3) RETURNING id`,
    [siteId, file.name, JSON.stringify(headers)],
  )
  const uploadId = uploadRes.rows[0].id

  for (const row of rows) {
    const code = guessCodeColumn(headers)
    await pool.query(
      `INSERT INTO transform_reference_rows (upload_id, mall_product_code, row_values) VALUES ($1, $2, $3)`,
      [uploadId, code ? row[code] || null : null, JSON.stringify(row)],
    )
  }

  return NextResponse.json({
    id: uploadId,
    headers,
    rowCount: rows.length,
    guessedCodeColumn: guessCodeColumn(headers),
  })
}
