import { NextRequest, NextResponse } from 'next/server'
import pool, { decryptSecret } from '@/lib/db'
import { recheckMallProducts, type RecheckTarget } from '@/lib/scraper'
import { upsertMallProduct } from '@/lib/scrape/incremental'
import type { ExtractionRule } from '@/lib/ai'

export type RecheckField = 'code' | 'price' | 'cost_price' | 'stock' | 'options' | 'images'

interface MallProductRow {
  id: number
  source_url: string
  mall_product_code: string
  price: number | null
  sale_price: number | null
  stock_status: string | null
  stock_qty: number | null
  options: { name: string; values: string[] }[] | null
  thumbnail_urls: string[] | null
  detail_image_urls: string[] | null
  raw_data: { cost_price?: number | null } | null
}

/**
 * "마이그레이션3_연속관리"의 컬럼별 재수집(현재 상태 체킹) — 이미 확정된(product_master로 마이그레이션된)
 * 상품을 대상으로 몰에 다시 방문해, 사용자가 고른 컬럼만 이전 값과 비교해 변경 사유를 돌려준다.
 * 'code'(상품코드)를 골랐는데 페이지 자체가 사라졌으면 "단종(추정)"으로 표시한다.
 */
export async function POST(req: NextRequest) {
  const { siteId, fields, mallProductIds } = await req.json() as { siteId: number; fields: RecheckField[]; mallProductIds?: number[] }
  if (!siteId || !fields?.length) return NextResponse.json({ error: 'siteId, fields required' }, { status: 400 })

  const targetsRes = await pool.query<MallProductRow>(
    `SELECT id, source_url, mall_product_code, price, sale_price, stock_status, stock_qty, options,
            thumbnail_urls, detail_image_urls, raw_data
     FROM mall_products
     WHERE site_id=$1 AND master_product_id IS NOT NULL AND source_url IS NOT NULL
       ${mallProductIds?.length ? 'AND id = ANY($2::int[])' : ''}`,
    mallProductIds?.length ? [siteId, mallProductIds] : [siteId],
  )
  if (!targetsRes.rows.length) return NextResponse.json({ error: '확인할 확정 상품이 없습니다' }, { status: 400 })
  const before = new Map(targetsRes.rows.map(r => [r.id, r]))

  const siteRes = await pool.query<{
    login_id: string | null; login_pw_encrypted: string | null; login_pw_iv: string | null
    extraction_rules: Record<string, ExtractionRule> | null
  }>(`SELECT login_id, login_pw_encrypted, login_pw_iv, extraction_rules FROM sites WHERE id=$1`, [siteId])
  const site = siteRes.rows[0]

  const sessionRes = await pool.query<{ id: number }>(
    `INSERT INTO scrape_sessions (url, site_id, login_id, status, scope_type, mode)
     VALUES ($1,$2,$3,'running','products','incremental') RETURNING id`,
    [targetsRes.rows[0].source_url, siteId, site?.login_id || null],
  )
  const sessionId = sessionRes.rows[0].id

  const targets: RecheckTarget[] = targetsRes.rows.map(r => ({ id: r.id, sourceUrl: r.source_url, mallProductCode: r.mall_product_code }))
  const checkCode = fields.includes('code')
  const results: { mallProductId: number; mallProductCode: string; reasons: string[] }[] = []

  try {
    const recheckResults = await recheckMallProducts({
      siteId,
      loginId: site?.login_id || undefined,
      loginPw: site ? decryptSecret(site.login_pw_encrypted, site.login_pw_iv) || undefined : undefined,
      extractionRules: site?.extraction_rules || undefined,
    }, targets)

    for (const r of recheckResults) {
      const prev = before.get(r.mallProductId)
      if (!prev) continue
      const reasons: string[] = []

      if (!r.product) {
        // 재시도까지 다 실패 — 'code'를 고른 경우만 품목삭제로 간주(고르지 않았으면 그냥 일시 오류일 수 있어
        // 함부로 단종 처리하지 않는다).
        if (checkCode) {
          await pool.query(`UPDATE mall_products SET stock_status='단종(추정)', updated_at=NOW() WHERE id=$1`, [r.mallProductId])
          reasons.push(`단종 (상품코드: ${r.mallProductCode})`)
        }
        if (reasons.length) results.push({ mallProductId: r.mallProductId, mallProductCode: r.mallProductCode, reasons })
        continue
      }

      const product = r.product
      await upsertMallProduct({ siteId, sessionId }, { sourceUrl: prev.source_url, product })

      if (fields.includes('price')) {
        const beforePrice = prev.sale_price ?? prev.price
        const afterPrice = product.sale_price ?? product.price
        if (beforePrice !== afterPrice) reasons.push(`가격: ${beforePrice?.toLocaleString() ?? '-'}원 → ${afterPrice?.toLocaleString() ?? '-'}원`)
      }
      if (fields.includes('cost_price')) {
        const beforeCost = prev.raw_data?.cost_price ?? null
        const afterCost = product.cost_price ?? null
        if (beforeCost !== afterCost) reasons.push(`공급가: ${beforeCost?.toLocaleString() ?? '-'}원 → ${afterCost?.toLocaleString() ?? '-'}원`)
      }
      if (fields.includes('stock')) {
        if ((prev.stock_status || '') !== (product.stock_status || '') || (prev.stock_qty ?? null) !== (product.stock_qty ?? null)) {
          reasons.push(`재고: ${prev.stock_status || '-'}(${prev.stock_qty ?? '-'}) → ${product.stock_status || '-'}(${product.stock_qty ?? '-'})`)
        }
      }
      if (fields.includes('options')) {
        if (JSON.stringify(prev.options || []) !== JSON.stringify(product.options || [])) reasons.push('옵션 구성 변경')
      }
      if (fields.includes('images')) {
        const beforeCount = (prev.thumbnail_urls?.length || 0) + (prev.detail_image_urls?.length || 0)
        const afterCount = product.thumbnail_urls.length + product.detail_image_urls.length
        if (beforeCount !== afterCount) reasons.push(`이미지 개수: ${beforeCount}개 → ${afterCount}개`)
      }

      if (reasons.length) results.push({ mallProductId: r.mallProductId, mallProductCode: r.mallProductCode, reasons })
    }

    await pool.query(`UPDATE scrape_sessions SET status='done', product_count=$1 WHERE id=$2`, [targets.length, sessionId])
  } catch (err) {
    await pool.query(`UPDATE scrape_sessions SET status='error', error=$1 WHERE id=$2`, [String(err), sessionId])
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }

  return NextResponse.json({ results, checked: targets.length })
}
