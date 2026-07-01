import { NextRequest, NextResponse } from 'next/server'
import pool, { initDb } from '@/lib/db'
import { scrapeSingleProduct, scrapeCatalogPage, getOpenPageUrl, type ScrapeResult } from '@/lib/scraper'
import { downloadProductImages } from '@/lib/images'

interface ScrapeRequestBody {
  url?: string
  categoryUrls?: string[]
  nextPageSelector?: string
  maxPages?: number
  loginId?: string
  loginPw?: string
  mode: 'single' | 'catalog'
  productLinkSelector?: string
  siteId?: number
}

export async function POST(req: NextRequest) {
  await initDb()
  const body = await req.json() as ScrapeRequestBody

  const resolvedUrl = body.url || body.categoryUrls?.[0] || (body.siteId ? getOpenPageUrl(body.siteId) : null)
  if (!resolvedUrl) return NextResponse.json({ error: 'url required' }, { status: 400 })

  // 세션 생성
  const sessionRes = await pool.query<{ id: number }>(
    `INSERT INTO scrape_sessions (url, login_id, status) VALUES ($1, $2, 'running') RETURNING id`,
    [resolvedUrl, body.loginId || null],
  )
  const sessionId = sessionRes.rows[0].id

  // 비동기로 스크래핑 실행 (응답은 sessionId만 즉시 반환)
  runScraping(sessionId, body).catch(err => {
    pool.query(`UPDATE scrape_sessions SET status='error', error=$1 WHERE id=$2`, [String(err), sessionId])
  })

  return NextResponse.json({ sessionId })
}

async function saveProduct(sessionId: number, r: ScrapeResult) {
  const { product, sourceUrl } = r
  const inserted = await pool.query<{ id: number }>(
    `INSERT INTO products
      (session_id, source_url, name_original, price, sale_price, brand, manufacturer, origin,
       category, description, options, thumbnail_url, detail_images, raw_data)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
    [
      sessionId, sourceUrl,
      product.name, product.price, product.sale_price,
      product.brand, product.manufacturer, product.origin,
      product.category, product.description,
      JSON.stringify(product.options || []),
      product.thumbnail_url,
      JSON.stringify((product.detail_image_urls || []).map(u => ({ url: u, local_path: '' }))),
      JSON.stringify(product),
    ],
  )
  const productId = inserted.rows[0].id

  // 이미지 다운로드
  const imgs = await downloadProductImages(
    product.thumbnail_url,
    product.detail_image_urls || [],
    sessionId,
    productId,
  )
  await pool.query(
    `UPDATE products SET thumbnail_local=$1, detail_images=$2 WHERE id=$3`,
    [
      imgs.thumbnail?.local_path || '',
      JSON.stringify(imgs.details.map((d, i) => ({ url: product.detail_image_urls[i], local_path: d.local_path }))),
      productId,
    ],
  )
}

async function runScraping(sessionId: number, opts: ScrapeRequestBody) {
  // 이미 스크랩된 상품은 목록에서 발견되어도 건너뛴다 (이어서 스크랩하기)
  const excluded = await pool.query<{ source_url: string }>(
    `SELECT DISTINCT source_url FROM products WHERE source_url IS NOT NULL`,
  )

  const scrapeOpts = {
    url: opts.url, categoryUrls: opts.categoryUrls, nextPageSelector: opts.nextPageSelector, maxPages: opts.maxPages,
    loginId: opts.loginId, loginPw: opts.loginPw, productLinkSelector: opts.productLinkSelector, siteId: opts.siteId,
    excludeUrls: excluded.rows.map(r => r.source_url), sessionId,
  }

  if (opts.mode === 'single') {
    const result = await scrapeSingleProduct(scrapeOpts)
    await saveProduct(sessionId, result)
    await pool.query(`UPDATE scrape_sessions SET status='done', product_count=1 WHERE id=$1`, [sessionId])
    return
  }

  const { total, stopped } = await scrapeCatalogPage(scrapeOpts, async ({ total, result }) => {
    // product_count는 발견된 총 상품 수를 담아 진행률 막대의 분모로 쓰인다.
    // saved_count(진행률 분자)는 아래에서 상품을 저장할 때마다 늘어나는 products 테이블 행 수를 그대로 센다.
    await pool.query(`UPDATE scrape_sessions SET product_count=$1 WHERE id=$2`, [total, sessionId])
    if (result) await saveProduct(sessionId, result)
  })

  await pool.query(
    `UPDATE scrape_sessions SET status=$1, product_count=$2 WHERE id=$3`,
    [stopped ? 'stopped' : 'done', total, sessionId],
  )
}
