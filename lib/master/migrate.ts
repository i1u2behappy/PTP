import pool from '../db'

export interface MigrateResult {
  migrated: number
  masterIds: number[]
}

function normalizeName(name: string): string {
  return (name || '').replace(/\s+/g, '').toLowerCase()
}

async function findReferenceFallback(siteId: number, mallProductCode: string, normalizedName: string) {
  const res = await pool.query(
    `SELECT brand, manufacturer, origin, category, description FROM reference_products
     WHERE (site_id=$1 OR site_id IS NULL) AND (mall_product_code=$2 OR match_key=$3)
     ORDER BY site_id NULLS LAST, mall_product_code NULLS LAST LIMIT 1`,
    [siteId, mallProductCode, normalizedName],
  )
  return res.rows[0] as { brand: string; manufacturer: string; origin: string; category: string; description: string } | undefined
}

/**
 * 원천 스크랩 데이터(mall_products)를 영속 '상품마스터'(product_master)로 옮긴다.
 * 비어있는 필드만 reference_products(이전 완료 데이터)로 채우고, 이미 사용자가 편집한 마스터 값은 덮어쓰지 않는다.
 */
export async function migrateToMaster(mallProductIds: number[], clientId: number): Promise<MigrateResult> {
  const masterIds: number[] = []

  for (const mallProductId of mallProductIds) {
    const mpRes = await pool.query(
      `SELECT * FROM mall_products WHERE id=$1`,
      [mallProductId],
    )
    const mp = mpRes.rows[0]
    if (!mp) continue

    const ref = await findReferenceFallback(mp.site_id, mp.mall_product_code, normalizeName(mp.name_original))

    const brand = mp.brand || ref?.brand || ''
    const manufacturer = mp.manufacturer || ref?.manufacturer || ''
    const origin = mp.origin || ref?.origin || '국내산'
    const category = mp.mall_category || ref?.category || ''
    const description = mp.description || ref?.description || ''
    const salePrice = mp.sale_price ?? mp.price

    const upsert = await pool.query<{ id: number }>(
      `INSERT INTO product_master
        (mall_product_id, client_id, name_original, mall_category, master_category,
         brand, manufacturer, origin, description, options,
         sale_price, list_price, stock_status, stock_qty, status)
       VALUES ($1,$2,$3,$4,$4,$5,$6,$7,$8,$9,$10,$10,$11,$12,'draft')
       ON CONFLICT (mall_product_id, client_id) DO UPDATE SET
         name_original = $3,
         mall_category = $4,
         brand         = COALESCE(NULLIF(product_master.brand, ''), $5),
         manufacturer  = COALESCE(NULLIF(product_master.manufacturer, ''), $6),
         origin        = COALESCE(NULLIF(product_master.origin, ''), $7),
         description   = COALESCE(NULLIF(product_master.description, ''), $8),
         options       = $9,
         sale_price    = COALESCE(product_master.sale_price, $10),
         list_price    = COALESCE(product_master.list_price, $10),
         stock_status  = $11,
         stock_qty     = $12,
         updated_at    = NOW()
       RETURNING id`,
      [mallProductId, clientId, mp.name_original, category, brand, manufacturer, origin, description,
        JSON.stringify(mp.options || []), salePrice, mp.stock_status, mp.stock_qty],
    )
    const masterId = upsert.rows[0].id
    masterIds.push(masterId)

    await pool.query(`UPDATE mall_products SET master_product_id=$1 WHERE id=$2`, [masterId, mallProductId])
    await pool.query(`UPDATE product_images SET product_master_id=$1 WHERE mall_product_id=$2`, [masterId, mallProductId])
  }

  return { migrated: masterIds.length, masterIds }
}
