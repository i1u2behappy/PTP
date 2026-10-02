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

// 상품마다 DB 왕복 5회 안팎인데(mall_products 조회, reference_products 조회, upsert, 사내코드 발급,
// mall_products/product_images 갱신) 서로 다른 상품은 완전히 독립적이라(각자 자기 행만 건드림) 순차
// 대신 몇 건씩 묶어 동시에 처리한다 — lib/scrape/staging.ts의 MERGE_CONCURRENCY와 같은 이유
// (2026-08-22, 사용자 요청). nextInternalCode의 UPDATE...RETURNING은 원자적이라 동시 호출에도 사내
// 관리코드 번호가 겹치지 않는다.
const MIGRATE_CONCURRENCY = 6

/**
 * 원천 스크랩 데이터(mall_products)를 영속 '상품마스터'(product_master)로 옮긴다.
 * 비어있는 필드만 reference_products(이전 완료 데이터)로 채우고, 이미 사용자가 편집한 마스터 값은 덮어쓰지 않는다.
 */
export async function migrateToMaster(mallProductIds: number[], clientId: number): Promise<MigrateResult> {
  const masterIds: number[] = []
  const clientRow = await pool.query<{ auto_internal_code: boolean }>('SELECT auto_internal_code FROM supply_clients WHERE id=$1', [clientId])
  const autoInternalCode = clientRow.rows[0]?.auto_internal_code ?? true

  async function migrateOne(mallProductId: number) {
    const mpRes = await pool.query(
      `SELECT * FROM mall_products WHERE id=$1`,
      [mallProductId],
    )
    const mp = mpRes.rows[0]
    if (!mp) return

    const ref = await findReferenceFallback(mp.site_id, mp.mall_product_code, normalizeName(mp.name_original))

    const brand = mp.brand || ref?.brand || ''
    const manufacturer = mp.manufacturer || ref?.manufacturer || ''
    const origin = mp.origin || ref?.origin || '국내산'
    const category = mp.mall_category || ref?.category || ''
    // cost_price(공급가)/shipping_fee/detail_text는 mall_products에 전용 컬럼이 없어, 스크랩 당시 전체를
    // 담아둔 raw_data에서 꺼낸다(lib/scrape/incremental.ts의 upsertMallProduct가 저장해둔 것).
    const rawData = (mp.raw_data || {}) as { cost_price?: number | null; shipping_fee?: number | string | null; detail_text?: string; custom_fields?: Record<string, string> }
    // mp.description은 og:description/meta description까지 폴백한 SEO 문구라(lib/extract.ts) "상세설명"
    // 라벨과 안 맞을 수 있다는 지적으로, 실제 상세페이지 본문(detail_text)을 우선 쓰도록 바꿨다(2026-08).
    // detail_text가 비어있는 몰(설명이 이미지로만 된 경우 등)은 예전처럼 SEO 문구로 폴백한다.
    const description = rawData.detail_text || mp.description || ref?.description || ''
    // list_price(정상가)는 몰의 "소비자판가"(mp.price) — 할인 전 정가다. sale_price(판매가)는 실제 결제가
    // (mp.sale_price, 할인 없으면 price와 같음). 예전엔 둘 다 salePrice 하나로 채워서 할인 중인 상품은
    // list_price에 정상가 아닌 판매가가 잘못 들어갔다(2026-08 사용자 지적으로 발견).
    const listPrice = mp.price ?? mp.sale_price
    const salePrice = mp.sale_price ?? mp.price
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
       VALUES ($1,$2,$3,$4,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'draft')
       ON CONFLICT (mall_product_id, client_id) DO UPDATE SET
         name_original = $3,
         mall_category = $4,
         brand         = COALESCE(NULLIF(product_master.brand, ''), $5),
         manufacturer  = COALESCE(NULLIF(product_master.manufacturer, ''), $6),
         origin        = COALESCE(NULLIF(product_master.origin, ''), $7),
         description   = COALESCE(NULLIF(product_master.description, ''), $8),
         options       = $9,
         sale_price    = COALESCE(product_master.sale_price, $10),
         list_price    = COALESCE(product_master.list_price, $11),
         cost_price    = COALESCE(product_master.cost_price, $12),
         shipping_fee  = COALESCE(product_master.shipping_fee, $13),
         stock_status  = $14,
         stock_qty     = $15,
         custom_fields = COALESCE(product_master.custom_fields, '{}'::jsonb) || $16::jsonb,
         updated_at    = NOW()
       RETURNING id`,
      [mallProductId, clientId, mp.name_original, category, brand, manufacturer, origin, description,
        JSON.stringify(mp.options || []), salePrice, listPrice, costPrice, shippingFee, mp.stock_status, mp.stock_qty,
        JSON.stringify(scrapedCustomFields)],
    )
    const masterId = upsert.rows[0].id
    masterIds.push(masterId)
    if (autoInternalCode) await assignInternalCodeIfMissing(masterId, clientId)

    await pool.query(`UPDATE mall_products SET master_product_id=$1 WHERE id=$2`, [masterId, mallProductId])
    await pool.query(`UPDATE product_images SET product_master_id=$1 WHERE mall_product_id=$2`, [masterId, mallProductId])
  }

  for (let i = 0; i < mallProductIds.length; i += MIGRATE_CONCURRENCY) {
    await Promise.all(mallProductIds.slice(i, i + MIGRATE_CONCURRENCY).map(migrateOne))
  }

  return { migrated: masterIds.length, masterIds }
}

/**
 * product_master가 "확정"(status='ready')되는 순간, 그 값을 reference_products에 저장해둔다 — 이후 같은
 * 몰의 같은 mall_product_code 상품이 재마이그레이션(재스크랩 뒤 다시 확정 등)될 때 findReferenceFallback이
 * "사람이 실제로 확인한 값"으로 빈 칸을 채울 수 있게 한다(2026-10-03, PTP 마이그레이션 로드맵 §04 —
 * 테이블/조회 로직은 처음부터 있었는데 채우는 쪽이 없어 영원히 안 쓰이던 죽은 코드였다). 확정 때마다
 * 매번 불러도 안전하도록 UNIQUE(site_id, mall_product_code) 위에서 upsert한다 — 사람이 "확정"을 취소하고
 * 값을 고쳐 다시 확정해도 최신값으로 갱신될 뿐 중복 행이 쌓이지 않는다.
 *
 * brand/manufacturer/origin/description 넷만 저장한다 — findReferenceFallback이 실제로 읽는 컬럼과
 * 정확히 같다(category는 master_category가 아니라 mall_category 기준으로 맞춘다: migrateToMaster가
 * reference의 category를 mall_category 자리에 폴백으로 쓰고 있어, 분류된 master_category를 여기 저장하면
 * 다음 몰 구조가 바뀐 재스크랩 때 엉뚱한 "표준분류"가 mall_category 칸에 들어가 버린다). 값이 전부
 * 비어있으면(아직 아무것도 채워지지 않은 draft를 실수로 확정한 경우 등) 저장할 게 없으니 건너뛴다.
 */
export async function saveAsReferenceProduct(masterId: number): Promise<void> {
  const res = await pool.query<{
    site_id: number | null; mall_product_code: string | null; name_original: string | null
    brand: string | null; manufacturer: string | null; origin: string | null; mall_category: string | null; description: string | null
  }>(
    `SELECT mp.site_id, mp.mall_product_code, pm.name_original, pm.brand, pm.manufacturer, pm.origin, pm.mall_category, pm.description
     FROM product_master pm JOIN mall_products mp ON mp.id = pm.mall_product_id
     WHERE pm.id=$1`,
    [masterId],
  )
  const row = res.rows[0]
  if (!row || row.site_id == null || !row.mall_product_code) return
  if (!row.brand && !row.manufacturer && !row.origin && !row.description) return

  await pool.query(
    `INSERT INTO reference_products (site_id, mall_product_code, match_key, brand, manufacturer, origin, category, description, source, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'confirmed_master',NOW())
     ON CONFLICT (site_id, mall_product_code) WHERE mall_product_code IS NOT NULL DO UPDATE SET
       match_key = $3, brand = $4, manufacturer = $5, origin = $6, category = $7, description = $8,
       source = 'confirmed_master', updated_at = NOW()`,
    [row.site_id, row.mall_product_code, normalizeName(row.name_original || ''),
      row.brand || '', row.manufacturer || '', row.origin || '', row.mall_category || '', row.description || ''],
  )
}

/** siteId에 아직 거래처가 없을 때 "확정"(mergeStagingItems)이 상품마스터 반영을 건너뛴 mall_products —
 *  master_product_id가 비어있는 것으로 판별한다(사용자 요청, 2026-08-27: "거래처가 나중에 지정되면
 *  소급 반영"). Mall 상세관리(SiteDetailPanel)가 거래처 옆에 이 개수를 보여주는 데 쓴다. */
export async function countUnmigratedForSite(siteId: number): Promise<number> {
  const res = await pool.query<{ count: string }>(
    `SELECT COUNT(*) FROM mall_products WHERE site_id=$1 AND master_product_id IS NULL`, [siteId],
  )
  return Number(res.rows[0].count)
}

/** countUnmigratedForSite가 찾아낸 항목 전부를 한꺼번에 migrateToMaster에 넘긴다 — 거래처를 나중에
 *  지정한 뒤(또는 저장 시 자동으로) 소급 반영하는 통로. migrateToMaster는 이미 ON CONFLICT 업서트라
 *  여러 번 불러도 안전하므로, 여기서는 "아직 master_product_id가 없는 것"만 골라 그대로 넘기면 된다 —
 *  재스크랩 등으로 이미 반영된 상품이 섞여 있어도 애초에 대상에서 빠진다. */
export async function migrateUnmigratedForSite(siteId: number, clientId: number): Promise<MigrateResult> {
  const res = await pool.query<{ id: number }>(
    `SELECT id FROM mall_products WHERE site_id=$1 AND master_product_id IS NULL`, [siteId],
  )
  if (!res.rows.length) return { migrated: 0, masterIds: [] }
  return migrateToMaster(res.rows.map(r => r.id), clientId)
}
