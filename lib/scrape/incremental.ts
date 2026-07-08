import pool from '../db'
import type { ScrapeResult } from '../scraper'

export interface UpsertOptions {
  siteId: number
  sessionId: number
}

export interface UpsertedMallProduct {
  id: number
  isNew: boolean
  stockChanged: boolean
}

/**
 * 스크랩 결과 1건을 mall_products에 upsert한다 (site_id + mall_product_code 기준).
 * 재고/가격이 이전 값과 달라진 경우에만 stock_snapshots에 이력을 남긴다.
 */
export async function upsertMallProduct(opts: UpsertOptions, result: ScrapeResult): Promise<UpsertedMallProduct> {
  const { product, sourceUrl } = result
  const code = product.mall_product_code || sourceUrl

  const existing = await pool.query<{ id: number; stock_status: string | null; stock_qty: number | null; price: number | null; sale_price: number | null }>(
    `SELECT id, stock_status, stock_qty, price, sale_price FROM mall_products WHERE site_id=$1 AND mall_product_code=$2`,
    [opts.siteId, code],
  )
  const prev = existing.rows[0]

  const upsert = await pool.query<{ id: number }>(
    `INSERT INTO mall_products
      (site_id, mall_product_code, source_url, mall_category, name_original, price, sale_price,
       brand, manufacturer, origin, description, options, thumbnail_url, detail_image_urls,
       stock_status, stock_qty, raw_data, first_seen_session_id, last_seen_session_id, last_scraped_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$18,NOW())
     ON CONFLICT (site_id, mall_product_code) DO UPDATE SET
       source_url=$3, mall_category=$4, name_original=$5, price=$6, sale_price=$7,
       brand=$8, manufacturer=$9, origin=$10, description=$11, options=$12,
       thumbnail_url=$13, detail_image_urls=$14, stock_status=$15, stock_qty=$16,
       raw_data=$17, last_seen_session_id=$18, last_scraped_at=NOW(), updated_at=NOW()
     RETURNING id`,
    [
      opts.siteId, code, sourceUrl, product.category || null, product.name,
      product.price, product.sale_price, product.brand, product.manufacturer, product.origin,
      product.description, JSON.stringify(product.options || []),
      product.thumbnail_url, JSON.stringify(product.detail_image_urls || []),
      product.stock_status || null, product.stock_qty,
      JSON.stringify(product), opts.sessionId,
    ],
  )
  const id = upsert.rows[0].id

  const stockChanged = !prev
    || prev.stock_status !== (product.stock_status || null)
    || prev.stock_qty !== product.stock_qty
    || prev.price !== product.price
    || prev.sale_price !== product.sale_price

  if (stockChanged) {
    await pool.query(
      `INSERT INTO stock_snapshots (mall_product_id, session_id, stock_status, stock_qty, price, sale_price)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [id, opts.sessionId, product.stock_status || null, product.stock_qty, product.price, product.sale_price],
    )
  }

  return { id, isNew: !prev, stockChanged }
}

/**
 * 증분 스크랩(몰 전체 재방문) 종료 후, 이번 회차에 보이지 않은 기존 상품을 '단종(추정)'으로 표시한다.
 * 카테고리/상품 지정 스크랩처럼 몰 일부만 훑은 경우는 안 보였다고 단종이라 확신할 수 없으므로 호출하지 않는다.
 */
export async function markMissingAsDiscontinued(siteId: number, sessionId: number) {
  await pool.query(
    `UPDATE mall_products
     SET stock_status='단종(추정)', updated_at=NOW()
     WHERE site_id=$1 AND last_seen_session_id <> $2 AND stock_status IS DISTINCT FROM '단종(추정)'`,
    [siteId, sessionId],
  )
}
