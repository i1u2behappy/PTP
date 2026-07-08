import { NextRequest, NextResponse } from 'next/server'
import pool, { decryptSecret } from '@/lib/db'
import { scrapeSingleProduct } from '@/lib/scraper'
import { upsertMallProduct } from '@/lib/scrape/incremental'
import { downloadProductImages } from '@/lib/images'

/** 개별 상품 상세 화면에서 "재스크랩" — 원본 URL을 다시 열어 mall_products 한 행만 갱신한다. */
export async function POST(_: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params

  const mpRes = await pool.query<{ site_id: number; source_url: string }>(
    `SELECT site_id, source_url FROM mall_products WHERE id=$1`, [id],
  )
  const mallProduct = mpRes.rows[0]
  if (!mallProduct?.source_url) return NextResponse.json({ error: 'not found' }, { status: 404 })

  const siteRes = await pool.query<{ login_id: string | null; login_pw_encrypted: string | null; login_pw_iv: string | null }>(
    `SELECT login_id, login_pw_encrypted, login_pw_iv FROM sites WHERE id=$1`, [mallProduct.site_id],
  )
  const site = siteRes.rows[0]

  const sessionRes = await pool.query<{ id: number }>(
    `INSERT INTO scrape_sessions (url, site_id, login_id, status, scope_type, mode)
     VALUES ($1,$2,$3,'running','products','incremental') RETURNING id`,
    [mallProduct.source_url, mallProduct.site_id, site?.login_id || null],
  )
  const sessionId = sessionRes.rows[0].id

  try {
    const result = await scrapeSingleProduct({
      url: mallProduct.source_url,
      siteId: mallProduct.site_id,
      loginId: site?.login_id || undefined,
      loginPw: site ? decryptSecret(site.login_pw_encrypted, site.login_pw_iv) || undefined : undefined,
    })
    const { id: mallProductId } = await upsertMallProduct({ siteId: mallProduct.site_id, sessionId }, result)
    await downloadProductImages(result.product.thumbnail_url, result.product.detail_image_urls || [], mallProductId, result.product.name)

    await pool.query(`UPDATE scrape_sessions SET status='done', product_count=1 WHERE id=$1`, [sessionId])
    const updated = await pool.query(`SELECT * FROM mall_products WHERE id=$1`, [mallProductId])
    return NextResponse.json(updated.rows[0])
  } catch (err) {
    await pool.query(`UPDATE scrape_sessions SET status='error', error=$1 WHERE id=$2`, [String(err), sessionId])
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}
