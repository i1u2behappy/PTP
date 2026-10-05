import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import pool, { getProductMasterRows } from '@/lib/db'
import { getImageHostBaseUrl, resolveMasterImages } from '@/lib/images'
import { generateExcel, type Marketplace, type ProductMasterRow, type MarketplaceConfig } from '@/lib/excel'

const MARKETPLACES = ['coupang', 'naver', '11st', 'gmarket', 'auction', 'shoplinker', 'sabangnet', 'all'] as const satisfies readonly Marketplace[]
const RequestSchema = z.object({
  productIds: z.array(z.number()).min(1),
  marketplace: z.enum(MARKETPLACES),
})

export async function POST(req: NextRequest) {
  const parsed = RequestSchema.safeParse(await req.json())
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message || 'invalid request' }, { status: 400 })
  }
  const { productIds, marketplace } = parsed.data

  const [rawRows, baseUrl, configRes, categoryMapRes, listingsRes] = await Promise.all([
    getProductMasterRows(productIds),
    getImageHostBaseUrl(),
    pool.query<MarketplaceConfig>(
      `SELECT code, name, max_batch_size, default_commission_rate::float AS default_commission_rate, default_shipping_fee FROM marketplace_configs`,
    ),
    // "카테고리 매핑" 화면(category_channel_mappings)에서 이 마켓에 대해 입력해둔 값이 있으면 그걸
    // 우선 쓴다 — 예전엔 마켓이 뭐든 상관없이 PTP 내부 라벨(master_category)만 그대로 나가서, 받는
    // 사람이 매번 수작업으로 마켓 실제 카테고리값으로 고쳐야 했다(2026-10-05 사용자 확인 — 실무 불편
    // 체감함). 매핑이 없는 카테고리는 기존처럼 내부 라벨로 폴백.
    pool.query<{ master_category: string; channel_category_value: string }>(
      `SELECT master_category, channel_category_value FROM category_channel_mappings WHERE marketplace_code = $1`,
      [marketplace],
    ),
    // 채널(마켓)별 override — 상품마다 이 마켓에서만 다르게 낼 이름/검색어/가격
    // (!specifications/product-master-architecture-redesign.md §4). 없으면 아래에서 상품마스터 공통값으로 폴백한다.
    pool.query<{ product_master_id: number; channel_name: string | null; search_tags_override: string | null; price_override: { sale_price?: number; list_price?: number } | null }>(
      `SELECT product_master_id, channel_name, search_tags_override, price_override
       FROM product_channel_listings WHERE marketplace_code = $1 AND product_master_id = ANY($2::int[])`,
      [marketplace, productIds],
    ),
  ])
  const categoryMap = new Map(categoryMapRes.rows.map(r => [r.master_category, r.channel_category_value]))
  const listingMap = new Map(listingsRes.rows.map(r => [r.product_master_id, r]))

  const products: ProductMasterRow[] = rawRows.map(r => {
    const listing = listingMap.get(r.id)
    const nameOverride = listing?.channel_name?.trim()
    const priceOverride = listing?.price_override
    return {
      id: r.id,
      name_original: r.name_original,
      name_ai: r.name_ai,
      name_final: nameOverride || r.name_final,
      category: (r.master_category ? categoryMap.get(r.master_category) : undefined) || r.master_category || r.mall_category || '',
      search_tags: listing?.search_tags_override?.trim() || r.search_tags || '',
      brand: r.brand, manufacturer: r.manufacturer, origin: r.origin, description: r.description,
      options: r.options,
      option_combinations: r.option_combinations,
      cost_price: r.cost_price,
      list_price: priceOverride?.list_price ?? r.list_price,
      sale_price: priceOverride?.sale_price ?? r.sale_price,
      shipping_fee: r.shipping_fee, other_cost: r.other_cost, target_margin_rate: r.target_margin_rate,
      stock_status: r.stock_status, stock_qty: r.stock_qty,
      ...(() => {
        const { thumbnail_urls, detail_image_urls } = resolveMasterImages(r.images, baseUrl)
        return { thumbnail_url: thumbnail_urls[0] || '', detail_image_urls }
      })(),
    }
  })

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
