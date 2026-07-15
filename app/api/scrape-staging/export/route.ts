import { NextRequest, NextResponse } from 'next/server'
import ExcelJS from 'exceljs'
import pool from '@/lib/db'

interface StagingRow {
  mall_product_code: string
  mall_category: string | null
  name_original: string | null
  price: number | null
  sale_price: number | null
  brand: string | null
  manufacturer: string | null
  origin: string | null
  description: string | null
  options: { name: string; values: string[] }[] | null
  thumbnail_urls: string[] | null
  detail_image_urls: string[] | null
  stock_status: string | null
  stock_qty: number | null
  source_url: string | null
}

const HEADERS = [
  '몰상품코드', '카테고리', '상품명', '정상가', '판매가', '브랜드', '제조사', '원산지',
  '설명', '옵션', '썸네일URL', '상세이미지URL', '재고상태', '재고수량', '원본URL',
]

export async function GET(req: NextRequest) {
  const sessionId = req.nextUrl.searchParams.get('sessionId')
  const status = req.nextUrl.searchParams.get('status')
  if (!sessionId) return NextResponse.json({ error: 'sessionId required' }, { status: 400 })

  const params: (string | number)[] = [sessionId]
  let query = `SELECT mall_product_code, mall_category, name_original, price, sale_price, brand, manufacturer,
    origin, description, options, thumbnail_urls, detail_image_urls, stock_status, stock_qty, source_url
    FROM scrape_staging_items WHERE session_id=$1`
  if (status) { params.push(status); query += ` AND status=$${params.length}` }
  query += ' ORDER BY id'

  const res = await pool.query<StagingRow>(query, params)

  const wb = new ExcelJS.Workbook()
  wb.creator = 'Products Transformation Platform (PTP)'
  wb.created = new Date()
  const sheet = wb.addWorksheet('스크랩결과')
  const header = sheet.addRow(HEADERS)
  header.eachCell(cell => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF334155' } }
    cell.font = { color: { argb: 'FFFFFFFF' }, bold: true, size: 10 }
  })
  res.rows.forEach(r => {
    sheet.addRow([
      r.mall_product_code, r.mall_category || '', r.name_original || '', r.price ?? '', r.sale_price ?? '',
      r.brand || '', r.manufacturer || '', r.origin || '', r.description || '',
      (r.options || []).map(o => `${o.name}: ${o.values.join('/')}`).join('; '),
      (r.thumbnail_urls || []).join(', '), (r.detail_image_urls || []).join(', '),
      r.stock_status || '', r.stock_qty ?? '', r.source_url || '',
    ])
  })
  sheet.columns.forEach(col => { col.width = 18 })
  sheet.getColumn(3).width = 30
  sheet.getColumn(9).width = 30
  sheet.getColumn(10).width = 40
  sheet.getColumn(11).width = 40
  sheet.getColumn(12).width = 40

  const buf = await wb.xlsx.writeBuffer()
  const fileName = `스크랩결과_session${sessionId}_${Date.now()}.xlsx`

  return new NextResponse(Buffer.from(buf) as BodyInit, {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`,
    },
  })
}
