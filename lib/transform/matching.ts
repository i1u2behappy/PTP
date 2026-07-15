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
