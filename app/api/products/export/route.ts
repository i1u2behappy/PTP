import { NextRequest, NextResponse } from 'next/server'
import ExcelJS from 'exceljs'
import pool from '@/lib/db'

interface MallProductRow {
  mall_name: string | null
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
  master_product_id: number | null
  last_scraped_at: string | null
  source_url: string | null
}

const HEADERS = [
  '몰', '몰상품코드', '카테고리', '상품명', '정상가', '판매가', '브랜드', '제조사', '원산지',
  '설명', '옵션', '썸네일URL', '상세이미지URL', '재고상태', '재고수량', '가공상태', '마지막스크랩', '원본URL',
]

export async function POST(req: NextRequest) {
  const body = await req.json() as { productIds: number[] }
  const productIds = body.productIds
  if (!productIds?.length) return NextResponse.json({ error: 'productIds required' }, { status: 400 })

  const res = await pool.query<MallProductRow>(
    `SELECT s.name AS mall_name, mp.mall_product_code, mp.mall_category, mp.name_original, mp.price, mp.sale_price,
       mp.brand, mp.manufacturer, mp.origin, mp.description, mp.options, mp.thumbnail_urls, mp.detail_image_urls,
       mp.stock_status, mp.stock_qty, mp.master_product_id, mp.last_scraped_at, mp.source_url
     FROM mall_products mp LEFT JOIN sites s ON s.id = mp.site_id
     WHERE mp.id = ANY($1::int[]) ORDER BY mp.id`,
    [productIds],
  )

  const wb = new ExcelJS.Workbook()
  wb.creator = 'Products Transformation Platform (PTP)'
  wb.created = new Date()
  const sheet = wb.addWorksheet('수집확인')
  const header = sheet.addRow(HEADERS)
  header.eachCell(cell => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF334155' } }
    cell.font = { color: { argb: 'FFFFFFFF' }, bold: true, size: 10 }
  })
  res.rows.forEach(r => {
    sheet.addRow([
      r.mall_name || '', r.mall_product_code, r.mall_category || '', r.name_original || '', r.price ?? '', r.sale_price ?? '',
      r.brand || '', r.manufacturer || '', r.origin || '', r.description || '',
      (r.options || []).map(o => `${o.name}: ${o.values.join('/')}`).join('; '),
      (r.thumbnail_urls || []).join(', '), (r.detail_image_urls || []).join(', '),
      r.stock_status || '', r.stock_qty ?? '', r.master_product_id ? '가공됨' : '미가공',
      r.last_scraped_at ? new Date(r.last_scraped_at).toLocaleString() : '', r.source_url || '',
    ])
  })
  sheet.columns.forEach(col => { col.width = 18 })
  sheet.getColumn(4).width = 30
  sheet.getColumn(10).width = 30
  sheet.getColumn(11).width = 30
  sheet.getColumn(12).width = 40
  sheet.getColumn(13).width = 40

  const buf = await wb.xlsx.writeBuffer()
  const fileName = `수집확인_${Date.now()}.xlsx`

  return new NextResponse(Buffer.from(buf) as BodyInit, {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`,
    },
  })
}
