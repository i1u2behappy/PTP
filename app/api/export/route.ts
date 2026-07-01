import { NextRequest, NextResponse } from 'next/server'
import pool, { getProductsByIds } from '@/lib/db'
import { generateExcel, type Marketplace } from '@/lib/excel'

export async function POST(req: NextRequest) {
  const body = await req.json() as { productIds: number[]; marketplace: Marketplace }
  const { productIds, marketplace } = body

  if (!productIds?.length) return NextResponse.json({ error: 'productIds required' }, { status: 400 })

  const products = await getProductsByIds(productIds)

  const buf = await generateExcel(products, marketplace)
  const fileName = `상품데이터_${marketplace}_${Date.now()}.xlsx`

  await pool.query(
    `INSERT INTO exports (product_ids, marketplace, file_name) VALUES ($1,$2,$3)`,
    [productIds, marketplace, fileName],
  )

  return new NextResponse(buf, {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`,
    },
  })
}
