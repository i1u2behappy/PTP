import pool from '../db'
import { scrapeSingleProduct } from '../scraper'
import type { ExtractionRule } from '../ai'

/**
 * "스크랩 조정"으로 그 몰의 extraction_rules가 갱신된 뒤, 이미 스크랩됐지만 아직 검수 전(pending)인
 * 스테이징 항목들을 실제로 다시 열어 새 규칙으로 재추출하고 그 자리에서 UPDATE한다(새 INSERT가 아니라
 * 제자리 수정 — 같은 세션에 중복 행이 쌓이는 걸 피한다). 일반모드(Playwright) 전용이다 — 개발자모드
 * 몰은 백엔드가 페이지를 스스로 못 열어보므로, 사용자가 확장을 다시 실행해 새 세션으로 재수집해야 한다
 * (components/panels/ProductsListPanel.tsx의 안내 문구 참고).
 */
export async function reExtractStagingItems(ids: number[]): Promise<{ updated: number[]; failed: { id: number; error: string }[] }> {
  const updated: number[] = []
  const failed: { id: number; error: string }[] = []

  for (const id of ids) {
    const res = await pool.query<{ id: number; site_id: number; source_url: string }>(
      `SELECT id, site_id, source_url FROM scrape_staging_items WHERE id=$1 AND status='pending'`, [id],
    )
    const row = res.rows[0]
    if (!row || !row.source_url) continue

    try {
      const siteRes = await pool.query<{ extraction_rules: Record<string, ExtractionRule> | null }>(
        `SELECT extraction_rules FROM sites WHERE id=$1`, [row.site_id],
      )
      const { product } = await scrapeSingleProduct({
        url: row.source_url, siteId: row.site_id,
        extractionRules: siteRes.rows[0]?.extraction_rules || undefined,
      })
      await pool.query(
        `UPDATE scrape_staging_items SET
           name_original=$1, price=$2, sale_price=$3, mall_category=$4, brand=$5, manufacturer=$6, origin=$7,
           description=$8, options=$9, thumbnail_urls=$10, detail_image_urls=$11, stock_status=$12, stock_qty=$13,
           raw_data=$14, updated_at=NOW()
         WHERE id=$15`,
        [
          product.name, product.price, product.sale_price, product.category || null, product.brand, product.manufacturer,
          product.origin, product.description, JSON.stringify(product.options || []),
          JSON.stringify(product.thumbnail_urls || []), JSON.stringify(product.detail_image_urls || []),
          product.stock_status || null, product.stock_qty, JSON.stringify(product), id,
        ],
      )
      updated.push(id)
    } catch (e) {
      failed.push({ id, error: e instanceof Error ? e.message : String(e) })
    }
  }

  return { updated, failed }
}
