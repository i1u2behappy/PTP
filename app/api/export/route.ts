import { NextRequest, NextResponse } from 'next/server'
import pool, { getProductMasterRows } from '@/lib/db'
import { getImageHostBaseUrl, resolveMasterImages } from '@/lib/images'
import { generateExcel, type Marketplace, type ProductMasterRow, type MarketplaceConfig } from '@/lib/excel'

export async function POST(req: NextRequest) {
  const body = await req.json() as { productIds: number[]; marketplace: Marketplace }
  const { productIds, marketplace } = body

  if (!productIds?.length) return NextResponse.json({ error: 'productIds required' }, { status: 400 })

  const [rawRows, baseUrl, configRes] = await Promise.all([
    getProductMasterRows(productIds),
    getImageHostBaseUrl(),
    pool.query<MarketplaceConfig>(
      `SELECT code, name, max_batch_size, default_commission_rate::float AS default_commission_rate, default_shipping_fee FROM marketplace_configs`,
    ),
  ])

  const products: ProductMasterRow[] = rawRows.map(r => ({
    id: r.id,
    name_original: r.name_original,
    name_ai: r.name_ai,
    name_final: r.name_final,
    category: r.master_category || r.mall_category || '',
    brand: r.brand, manufacturer: r.manufacturer, origin: r.origin, description: r.description,
    options: r.options,
    cost_price: r.cost_price, list_price: r.list_price, sale_price: r.sale_price,
    shipping_fee: r.shipping_fee, other_cost: r.other_cost, target_margin_rate: r.target_margin_rate,
    stock_status: r.stock_status, stock_qty: r.stock_qty,
    ...(() => {
      const { thumbnail_urls, detail_image_urls } = resolveMasterImages(r.images, baseUrl)
      return { thumbnail_url: thumbnail_urls[0] || '', detail_image_urls }
    })(),
  }))

  const configs: Record<string, MarketplaceConfig> = {}
  configRes.rows.forEach(c => { configs[c.code] = c })

  const buf = await generateExcel(products, marketplace, configs)
  const batchCount = configs[marketplace]
    ? Math.max(1, Math.ceil(products.length / configs[marketplace].max_batch_size))
    : 1
  const fileName = `상품데이터_${marketplace}_${Date.now()}.xlsx`

  await pool.query(
    `INSERT INTO exports (product_ids, marketplace, file_name, batch_count) VALUES ($1,$2,$3,$4)`,
    [productIds, marketplace, fileName, batchCount],
  )

  return new NextResponse(buf as BodyInit, {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`,
    },
  })
}
