import pool from '../db'
import type { ScrapeResult } from '../scraper'
import type { ExtractedProduct } from '../ai'
import { upsertMallProduct, markMissingAsDiscontinued } from './incremental'
import { downloadProductImages, resolveScrapeFolderName } from '../images'
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
    cost_price: extra.cost_price ?? null,
    shipping_fee: extra.shipping_fee ?? null,
    brand: row.brand,
    manufacturer: row.manufacturer,
    origin: row.origin,
    category: row.mall_category || '',
    description: row.description,
    options: row.options,
    option_combinations: extra.option_combinations || [],
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
    custom_fields: extra.custom_fields || {},
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

// 한 건씩 순서대로 기다리면(예전 for await) 상품마다 여러 번의 DB 왕복 + 이미지 다운로드가 곱으로 쌓여
// 확정 건수가 많을수록 그만큼 느려진다(실사용 확인: 스크래핑만큼 확정도 오래 걸림) — 서로 다른 상품은
// 독립적인 작업이라 몇 건씩 묶어 동시에 처리한다. 너무 크게 잡으면 DB 커넥션 풀(기본 10개)이 부족해져
// 오히려 대기시간이 늘 수 있어 여유 있게 6으로 제한한다.
const MERGE_CONCURRENCY = 6

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
  // 세션(스크랩 건) 하나 안의 상품 수백 개가 전부 같은 이미지 저장 폴더를 쓰는데, resolveScrapeFolderName은
  // 그 자체로 DB 조회 2번이다 — 상품마다 매번 다시 물어보지 않고 세션당 한 번만 계산해 재사용한다.
  const folderNameCache = new Map<number, Promise<string>>()

  async function clientIdForSite(siteId: number): Promise<number | null> {
    if (siteClientCache.has(siteId)) return siteClientCache.get(siteId)!
    const res = await pool.query<{ client_id: number | null }>('SELECT client_id FROM sites WHERE id=$1', [siteId])
    const clientId = res.rows[0]?.client_id ?? null
    siteClientCache.set(siteId, clientId)
    return clientId
  }

  function folderNameForSession(sessionId: number): Promise<string> {
    let p = folderNameCache.get(sessionId)
    if (!p) { p = resolveScrapeFolderName(sessionId); folderNameCache.set(sessionId, p) }
    return p
  }

  async function mergeOne(id: number) {
    const res = await pool.query<StagingRow>(`SELECT * FROM scrape_staging_items WHERE id=$1 AND status='pending'`, [id])
    const row = res.rows[0]
    if (!row) return
    touchedSessions.add(row.session_id)

    if (row.is_already_migrated && !opts.force) {
      skipped.push({ id, reason: 'already_migrated' })
      if (row.matched_mall_product_id) {
        await pool.query(
          `UPDATE mall_products SET last_seen_session_id=$1, last_scraped_at=NOW() WHERE id=$2`,
          [row.session_id, row.matched_mall_product_id],
        )
      }
      return
    }

    const { id: mallProductId } = await upsertMallProduct({ siteId: row.site_id, sessionId: row.session_id }, toScrapeResult(row))
    const folderName = await folderNameForSession(row.session_id)
    await downloadProductImages(row.thumbnail_urls || [], row.detail_image_urls || [], mallProductId, row.mall_product_code, row.name_original, folderName, row.site_id)
    const clientId = await clientIdForSite(row.site_id)
    if (clientId != null) await migrateToMaster([mallProductId], clientId)
    else noClient.push(id)
    await pool.query(`UPDATE scrape_staging_items SET status='merged', matched_mall_product_id=$2, updated_at=NOW() WHERE id=$1`, [id, mallProductId])
    merged.push(id)
  }

  for (let i = 0; i < ids.length; i += MERGE_CONCURRENCY) {
    await Promise.all(ids.slice(i, i + MERGE_CONCURRENCY).map(mergeOne))
  }

  for (const sid of touchedSessions) await checkSessionCompletion(sid)

  return { merged, skipped, noClient }
}

/** 확정(merged)된 항목을 다시 미확정(pending)으로 되돌린다 — staging 상태만 되돌리고, 이미 만들어진
 *  mall_products/product_master(다운로드된 이미지 포함)는 건드리지 않는다(사용자 선택 — 다른 화면에서
 *  이미 그 데이터를 참조 중일 수 있어 삭제는 위험하고, 나중에 다시 "확정"하면 최신 스크랩값으로 그대로
 *  덮어써지므로 되돌리기도 쉽다). skipped 항목은 대상이 아니다(별도 개념 — discardStagingItems 참고). */
export async function unmergeStagingItems(ids: number[]): Promise<{ reverted: number[] }> {
  const res = await pool.query<{ id: number }>(
    `UPDATE scrape_staging_items SET status='pending', updated_at=NOW() WHERE id = ANY($1::int[]) AND status='merged' RETURNING id`,
    [ids],
  )
  return { reverted: res.rows.map(r => r.id) }
}

export async function discardStagingItems(ids: number[]): Promise<void> {
  const rows = await pool.query<{ session_id: number }>(
    `SELECT DISTINCT session_id FROM scrape_staging_items WHERE id = ANY($1::int[]) AND status='pending'`, [ids],
  )
  await pool.query(`UPDATE scrape_staging_items SET status='skipped', updated_at=NOW() WHERE id = ANY($1::int[]) AND status='pending'`, [ids])
  for (const { session_id } of rows.rows) await checkSessionCompletion(session_id)
}
