import pool from '../db'
import type { ScrapeResult } from '../scraper'
import type { ExtractedProduct } from '../ai'
import { upsertMallProduct, markMissingAsDiscontinued } from './incremental'
import { downloadProductImages } from '../images'
import { migrateToMaster } from '../master/migrate'

export interface StageOptions {
  siteId: number
  sessionId: number
}

/**
 * 스크랩 결과 1건을 mall_products에 바로 반영하지 않고 scrape_staging_items에 쌓아둔다.
 * 사용자가 스크랩 검토 화면에서 확인 후 병합(mergeStagingItems)할 때까지 대기 상태로 남는다.
 */
export async function stageScrapedProduct(opts: StageOptions, result: ScrapeResult): Promise<{ id: number }> {
  const { product, sourceUrl } = result
  const code = product.mall_product_code || sourceUrl

  const existing = await pool.query<{ id: number; master_product_id: number | null }>(
    `SELECT id, master_product_id FROM mall_products WHERE site_id=$1 AND mall_product_code=$2`,
    [opts.siteId, code],
  )
  const matched = existing.rows[0]

  const inserted = await pool.query<{ id: number }>(
    `INSERT INTO scrape_staging_items
      (session_id, site_id, mall_product_code, source_url, mall_category, name_original, price, sale_price,
       brand, manufacturer, origin, description, options, thumbnail_urls, detail_image_urls,
       stock_status, stock_qty, raw_data, matched_mall_product_id, is_new, is_already_migrated)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
     RETURNING id`,
    [
      opts.sessionId, opts.siteId, code, sourceUrl, product.category || null, product.name,
      product.price, product.sale_price, product.brand, product.manufacturer, product.origin,
      product.description, JSON.stringify(product.options || []),
      JSON.stringify(product.thumbnail_urls || []), JSON.stringify(product.detail_image_urls || []),
      product.stock_status || null, product.stock_qty,
      JSON.stringify(product),
      matched?.id ?? null, !matched, !!matched?.master_product_id,
    ],
  )
  return { id: inserted.rows[0].id }
}

interface StagingRow {
  id: number
  session_id: number
  site_id: number
  mall_product_code: string
  source_url: string
  mall_category: string | null
  name_original: string
  price: number | null
  sale_price: number | null
  brand: string
  manufacturer: string
  origin: string
  description: string
  options: { name: string; values: string[] }[]
  thumbnail_urls: string[]
  detail_image_urls: string[]
  stock_status: string | null
  stock_qty: number | null
  raw_data: Partial<ExtractedProduct> | null
  matched_mall_product_id: number | null
  is_already_migrated: boolean
  status: string
}

function toScrapeResult(row: StagingRow): ScrapeResult {
  // raw_data는 스크랩 당시 ExtractedProduct 전체를 그대로 담아둔 것 — 개별 컬럼이 없는
  // 부가 필드(이미지명, 상세 텍스트 등)는 여기서 복원한다. 개별 컬럼이 있는 필드는 그쪽이 우선(최신 검토값).
  const extra = row.raw_data || {}
  const product: ExtractedProduct = {
    name: row.name_original,
    price: row.price,
    sale_price: row.sale_price,
    brand: row.brand,
    manufacturer: row.manufacturer,
    origin: row.origin,
    category: row.mall_category || '',
    description: row.description,
    options: row.options,
    thumbnail_urls: row.thumbnail_urls,
    thumbnail_names: extra.thumbnail_names || [],
    detail_image_urls: row.detail_image_urls,
    detail_image_names: extra.detail_image_names || [],
    detail_text: extra.detail_text || '',
    summary_info: extra.summary_info || '',
    english_name: extra.english_name || '',
    extra_info: extra.extra_info || [],
    stock_status: row.stock_status || '',
    stock_qty: row.stock_qty,
    stock_by_option: extra.stock_by_option || [],
    mall_product_code: row.mall_product_code,
  }
  return { sourceUrl: row.source_url, product }
}

export interface MergeResult {
  merged: number[]
  skipped: { id: number; reason: string }[]
  noClient: number[]
}

/**
 * 세션의 pending 스테이징이 0개가 됐는지(병합이든 무시든 전부 처리됐는지) 확인하고, 몰 전체 증분
 * 스크랩 세션이었다면 그 시점에 단종 추정 판정을 수행한다. 병합/무시가 한 번에 몰아서 일어나든
 * 여러 차례에 걸쳐 나뉘어 일어나든, 마지막으로 큐를 비운 호출에서 정확히 한 번만 실행된다.
 */
async function checkSessionCompletion(sessionId: number) {
  const remaining = await pool.query<{ count: string }>(
    `SELECT COUNT(*) FROM scrape_staging_items WHERE session_id=$1 AND status='pending'`, [sessionId],
  )
  if (Number(remaining.rows[0].count) > 0) return

  const session = await pool.query<{ site_id: number; scope_type: string; mode: string }>(
    `SELECT site_id, scope_type, mode FROM scrape_sessions WHERE id=$1`, [sessionId],
  )
  const s = session.rows[0]
  if (s && s.scope_type === 'all' && s.mode === 'incremental') {
    await markMissingAsDiscontinued(s.site_id, sessionId)
  }
}

/**
 * 스테이징 항목을 실제 mall_products에 반영한다. 이미 상품마스터로 가공된 상품(is_already_migrated)은
 * force가 아닌 한 데이터를 덮어쓰지 않는다 — 대신 "이번 세션에도 보였다"는 사실만 반영해 단종 판정을
 * 오작동시키지 않는다.
 */
export async function mergeStagingItems(ids: number[], opts: { force?: boolean } = {}): Promise<MergeResult> {
  const merged: number[] = []
  const skipped: { id: number; reason: string }[] = []
  const noClient: number[] = []
  const touchedSessions = new Set<number>()
  const siteClientCache = new Map<number, number | null>()

  async function clientIdForSite(siteId: number): Promise<number | null> {
    if (siteClientCache.has(siteId)) return siteClientCache.get(siteId)!
    const res = await pool.query<{ client_id: number | null }>('SELECT client_id FROM sites WHERE id=$1', [siteId])
    const clientId = res.rows[0]?.client_id ?? null
    siteClientCache.set(siteId, clientId)
    return clientId
  }

  for (const id of ids) {
    const res = await pool.query<StagingRow>(`SELECT * FROM scrape_staging_items WHERE id=$1 AND status='pending'`, [id])
    const row = res.rows[0]
    if (!row) continue
    touchedSessions.add(row.session_id)

    if (row.is_already_migrated && !opts.force) {
      skipped.push({ id, reason: 'already_migrated' })
      if (row.matched_mall_product_id) {
        await pool.query(
          `UPDATE mall_products SET last_seen_session_id=$1, last_scraped_at=NOW() WHERE id=$2`,
          [row.session_id, row.matched_mall_product_id],
        )
      }
      continue
    }

    const { id: mallProductId } = await upsertMallProduct({ siteId: row.site_id, sessionId: row.session_id }, toScrapeResult(row))
    await downloadProductImages(row.thumbnail_urls || [], row.detail_image_urls || [], mallProductId, row.mall_product_code, row.name_original, row.session_id)
    const clientId = await clientIdForSite(row.site_id)
    if (clientId != null) await migrateToMaster([mallProductId], clientId)
    else noClient.push(id)
    await pool.query(`UPDATE scrape_staging_items SET status='merged', matched_mall_product_id=$2, updated_at=NOW() WHERE id=$1`, [id, mallProductId])
    merged.push(id)
  }

  for (const sid of touchedSessions) await checkSessionCompletion(sid)

  return { merged, skipped, noClient }
}

export async function discardStagingItems(ids: number[]): Promise<void> {
  const rows = await pool.query<{ session_id: number }>(
    `SELECT DISTINCT session_id FROM scrape_staging_items WHERE id = ANY($1::int[]) AND status='pending'`, [ids],
  )
  await pool.query(`UPDATE scrape_staging_items SET status='skipped', updated_at=NOW() WHERE id = ANY($1::int[]) AND status='pending'`, [ids])
  for (const { session_id } of rows.rows) await checkSessionCompletion(session_id)
}
