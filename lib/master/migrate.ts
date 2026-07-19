import pool from '../db'

export interface MigrateResult {
  migrated: number
  masterIds: number[]
}

function normalizeName(name: string): string {
  return (name || '').replace(/\s+/g, '').toLowerCase()
}

/** 거래처 코드(prefix)가 설정돼 있으면 "코드_000001" 형태의 사내 관리코드를 순번대로 발급한다. 코드가 없으면 발급하지 않는다. */
async function nextInternalCode(clientId: number): Promise<string | null> {
  const client = await pool.query<{ code: string | null }>('SELECT code FROM supply_clients WHERE id=$1', [clientId])
  const code = client.rows[0]?.code
  if (!code) return null
  const seq = await pool.query<{ next_internal_seq: number }>(
    'UPDATE supply_clients SET next_internal_seq = next_internal_seq + 1 WHERE id=$1 RETURNING next_internal_seq',
    [clientId],
  )
  return `${code}_${String(seq.rows[0].next_internal_seq).padStart(6, '0')}`
}

export async function assignInternalCodeIfMissing(masterId: number, clientId: number): Promise<void> {
  const existing = await pool.query<{ internal_code: string | null }>('SELECT internal_code FROM product_master WHERE id=$1', [masterId])
  if (existing.rows[0]?.internal_code) return
  const code = await nextInternalCode(clientId)
  if (code) await pool.query('UPDATE product_master SET internal_code=$1 WHERE id=$2', [code, masterId])
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
  const clientRow = await pool.query<{ auto_internal_code: boolean }>('SELECT auto_internal_code FROM supply_clients WHERE id=$1', [clientId])
  const autoInternalCode = clientRow.rows[0]?.auto_internal_code ?? true

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
    // cost_price(공급가)/shipping_fee는 mall_products에 전용 컬럼이 없어, 스크랩 당시 전체를 담아둔
    // raw_data에서 꺼낸다(lib/scrape/incremental.ts의 upsertMallProduct가 저장해둔 것).
    const rawData = (mp.raw_data || {}) as { cost_price?: number | null; shipping_fee?: number | string | null; custom_fields?: Record<string, string> }
    const costPrice = rawData.cost_price ?? null
    // shipping_fee는 Raw 데이터엔 "3000~4000"처럼 범위 문자열로 남아있을 수 있다(신우 등) — product_master는
    // 가격 계산에 쓰이는 숫자 컬럼이라 범위의 최저값만 취한다.
    const shippingFee = typeof rawData.shipping_fee === 'string'
      ? Number(rawData.shipping_fee.split('~')[0]) || null
      : rawData.shipping_fee ?? null
    // "스크랩 조정"으로 새로 추가된 컬럼들 — Transform 등이 이미 써둔 custom_fields를 덮어쓰지 않도록 병합한다.
    const scrapedCustomFields = rawData.custom_fields || {}

    const upsert = await pool.query<{ id: number }>(
      `INSERT INTO product_master
        (mall_product_id, client_id, name_original, mall_category, master_category,
         brand, manufacturer, origin, description, options,
         sale_price, list_price, cost_price, shipping_fee, stock_status, stock_qty, custom_fields, status)
       VALUES ($1,$2,$3,$4,$4,$5,$6,$7,$8,$9,$10,$10,$11,$12,$13,$14,$15,'draft')
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
         cost_price    = COALESCE(product_master.cost_price, $11),
         shipping_fee  = COALESCE(product_master.shipping_fee, $12),
         stock_status  = $13,
         stock_qty     = $14,
         custom_fields = COALESCE(product_master.custom_fields, '{}'::jsonb) || $15::jsonb,
         updated_at    = NOW()
       RETURNING id`,
      [mallProductId, clientId, mp.name_original, category, brand, manufacturer, origin, description,
        JSON.stringify(mp.options || []), salePrice, costPrice, shippingFee, mp.stock_status, mp.stock_qty,
        JSON.stringify(scrapedCustomFields)],
    )
    const masterId = upsert.rows[0].id
    masterIds.push(masterId)
    if (autoInternalCode) await assignInternalCodeIfMissing(masterId, clientId)

    await pool.query(`UPDATE mall_products SET master_product_id=$1 WHERE id=$2`, [masterId, mallProductId])
    await pool.query(`UPDATE product_images SET product_master_id=$1 WHERE mall_product_id=$2`, [masterId, mallProductId])
  }

  return { migrated: masterIds.length, masterIds }
}
