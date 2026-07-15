import ExcelJS from 'exceljs'
import pool from '../db'

export interface ParsedReferenceSheet {
  headers: string[]
  rows: Record<string, string>[]
}

/** 완성본 xlsx의 첫 시트를 읽어 헤더 행 + 데이터 행(헤더명 → 셀 텍스트값)으로 반환한다. */
export async function parseReferenceWorkbook(buffer: Buffer): Promise<ParsedReferenceSheet> {
  const wb = new ExcelJS.Workbook()
  // ponytail: exceljs의 타입 선언이 이 프로젝트의 @types/node Buffer 제네릭과 구조적으로 안 맞아 any로 우회
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await wb.xlsx.load(buffer as any)
  const sheet = wb.worksheets[0]
  if (!sheet) return { headers: [], rows: [] }

  const headerRow = sheet.getRow(1)
  const headers: string[] = []
  headerRow.eachCell({ includeEmpty: false }, cell => {
    headers.push(String(cell.value ?? '').trim())
  })

  const rows: Record<string, string>[] = []
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return
    const values: Record<string, string> = {}
    let hasValue = false
    headers.forEach((header, i) => {
      const cell = row.getCell(i + 1)
      const text = cell.value == null ? '' : String(cell.value).trim()
      if (text) hasValue = true
      values[header] = text
    })
    if (hasValue) rows.push(values)
  })

  return { headers, rows }
}

const CODE_HEADER_RE = /상품\s*코드|품번|product.?no|product.?code/i

/** 헤더 목록에서 몰 상품코드로 보이는 컬럼을 추정한다 (사용자가 업로드 확정 화면에서 바꿀 수 있는 기본값). */
export function guessCodeColumn(headers: string[]): string | null {
  return headers.find(h => CODE_HEADER_RE.test(h)) || null
}

export type UploadKind = 'as_is' | 'to_be'

export interface UploadSummary {
  id: number
  file_name: string
  column_headers: string[]
  code_column: string | null
  row_count: number
  matched_count: number
}

/** siteId의 특정 종류(AS-IS/TO-BE) 최신 업로드 1건을 요약과 함께 가져온다. */
export async function getLatestUpload(siteId: number, kind: UploadKind): Promise<UploadSummary | null> {
  const res = await pool.query<UploadSummary>(`
    SELECT u.id, u.file_name, u.column_headers, u.code_column,
           COUNT(rr.id)::int AS row_count, COUNT(rr.matched_mall_product_id)::int AS matched_count
    FROM transform_reference_uploads u
    LEFT JOIN transform_reference_rows rr ON rr.upload_id = u.id
    WHERE u.site_id = $1 AND u.kind = $2
    GROUP BY u.id
    ORDER BY u.created_at DESC
    LIMIT 1
  `, [siteId, kind])
  return res.rows[0] || null
}

export interface GuidePair {
  code: string
  asIs: Record<string, string>
  toBe: Record<string, string>
}

/**
 * 몰의 최신 AS-IS 업로드와 최신 TO-BE 업로드를 각 행의 몰상품코드(code_column에서 추출한 값)로 매칭해,
 * "이 상품이 이렇게 마이그레이션 되었다"는 예시 쌍을 만든다. 어느 한쪽이라도 없으면 빈 배열.
 */
export async function getGuidePairs(siteId: number): Promise<GuidePair[]> {
  const [asIs, toBe] = await Promise.all([getLatestUpload(siteId, 'as_is'), getLatestUpload(siteId, 'to_be')])
  if (!asIs || !toBe) return []

  const [asIsRows, toBeRows] = await Promise.all([
    pool.query<{ mall_product_code: string | null; row_values: Record<string, string> }>(
      'SELECT mall_product_code, row_values FROM transform_reference_rows WHERE upload_id = $1', [asIs.id]),
    pool.query<{ mall_product_code: string | null; row_values: Record<string, string> }>(
      'SELECT mall_product_code, row_values FROM transform_reference_rows WHERE upload_id = $1', [toBe.id]),
  ])
  const toBeByCode = new Map(toBeRows.rows.filter(r => r.mall_product_code).map(r => [r.mall_product_code!, r.row_values]))

  return asIsRows.rows
    .filter(r => r.mall_product_code && toBeByCode.has(r.mall_product_code))
    .map(r => ({ code: r.mall_product_code!, asIs: r.row_values, toBe: toBeByCode.get(r.mall_product_code!)! }))
}

/**
 * upload의 code_column을 기준으로 각 참조 행의 mall_product_code를 다시 뽑고,
 * 같은 site의 mall_products와 코드로 매칭한다. { total, matched }를 반환한다.
 */
export async function matchReferenceRows(uploadId: number): Promise<{ total: number; matched: number }> {
  const uploadRes = await pool.query<{ site_id: number; code_column: string | null }>(
    'SELECT site_id, code_column FROM transform_reference_uploads WHERE id = $1',
    [uploadId],
  )
  const upload = uploadRes.rows[0]
  if (!upload?.code_column) return { total: 0, matched: 0 }

  const rowsRes = await pool.query<{ id: number; row_values: Record<string, string> }>(
    'SELECT id, row_values FROM transform_reference_rows WHERE upload_id = $1',
    [uploadId],
  )

  let matched = 0
  for (const row of rowsRes.rows) {
    const code = (row.row_values[upload.code_column] || '').trim()
    const mpRes = code
      ? await pool.query<{ id: number }>(
          'SELECT id FROM mall_products WHERE site_id = $1 AND mall_product_code = $2 LIMIT 1',
          [upload.site_id, code],
        )
      : { rows: [] }
    const matchedId = mpRes.rows[0]?.id ?? null
    if (matchedId) matched++
    await pool.query(
      'UPDATE transform_reference_rows SET mall_product_code = $1, matched_mall_product_id = $2 WHERE id = $3',
      [code || null, matchedId, row.id],
    )
  }

  return { total: rowsRes.rows.length, matched }
}
