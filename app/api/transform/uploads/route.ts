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
  // exceljs는 최신 .xlsx(zip 기반)만 읽는다 — 예전 바이너리 .xls나 손상된 파일을 올리면 "Can't find end
  // of central directory" 같은 jszip 내부 에러를 그대로 던지는데, 이걸 안 잡으면 라우트가 빈 응답으로
  // 500만 내려줘 화면엔 "업로드 실패: 500"만 보이고 왜 실패했는지 전혀 알 수 없다(사용자 지적, 2026-10-05
  // — "업로드 실패는 뭐야?"). 원인을 구분할 방법이 없으니(exceljs가 에러 종류를 코드로 안 줌) 파싱
  // 실패는 전부 "포맷이 안 맞다"는 같은 이유로 보고 안내한다.
  let headers: string[], rows: Record<string, string>[]
  try {
    ({ headers, rows } = await parseReferenceWorkbook(buffer))
  } catch {
    return NextResponse.json({ error: '엑셀 파일을 읽을 수 없습니다 — 예전 .xls 형식이거나 손상된 파일일 수 있습니다. 엑셀에서 "다른 이름으로 저장 → Excel 통합 문서(.xlsx)"로 저장한 뒤 다시 올려주세요.' }, { status: 400 })
  }
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
