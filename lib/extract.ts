import type { Page } from 'playwright'
import type { ExtractedProduct } from './ai'

interface RawPageData {
  name: string
  price: number | null
  brand: string
  description: string
  images: string[]
  infoRows: [string, string][]
}

async function scrapePageData(page: Page): Promise<RawPageData> {
  return page.evaluate(() => {
    // 대부분의 쇼핑몰(카페24 포함)은 SEO를 위해 schema.org Product 구조화 데이터를 상품 페이지에 심어둔다.
    let product: Record<string, unknown> | null = null
    for (const script of Array.from(document.querySelectorAll('script[type="application/ld+json"]'))) {
      try {
        const parsed = JSON.parse(script.textContent || '')
        const candidates = Array.isArray(parsed) ? parsed : [parsed]
        const found = candidates.find((c: Record<string, unknown>) => {
          const t = c['@type']
          return t === 'Product' || (Array.isArray(t) && t.includes('Product'))
        })
        if (found) { product = found as Record<string, unknown>; break }
      } catch { /* JSON 파싱 실패는 건너뜀 */ }
    }

    const ogContent = (prop: string) => document.querySelector(`meta[property="${prop}"]`)?.getAttribute('content') || ''

    let name = ''
    let price: number | null = null
    let brand = ''
    let description = ''
    let images: string[] = []

    if (product) {
      name = (product.name as string) || ''
      const brandField = product.brand as { name?: string } | string | undefined
      brand = (typeof brandField === 'string' ? brandField : brandField?.name) || ''
      description = (product.description as string) || ''
      const imgField = product.image
      images = Array.isArray(imgField) ? imgField as string[] : (imgField ? [imgField as string] : [])
      const offersField = product.offers
      const offers = Array.isArray(offersField) ? offersField : (offersField ? [offersField] : [])
      const firstOffer = offers[0] as { price?: number | string } | undefined
      if (firstOffer?.price != null) price = Number(firstOffer.price)
    }

    if (!name) name = ogContent('og:title') || document.title || ''
    if (!images.length) {
      const ogImg = ogContent('og:image')
      if (ogImg) images = [ogImg]
    }
    if (!description) {
      description = ogContent('og:description') || document.querySelector('meta[name="description"]')?.getAttribute('content') || ''
    }
    if (price == null) {
      // 가격 표시 요소(class/id에 price 포함)에서 "숫자,콤마 + 원" 패턴을 찾는다
      const priceEls = Array.from(document.querySelectorAll('[class*="price" i], [id*="price" i]'))
      for (const el of priceEls) {
        const m = (el.textContent || '').match(/([\d,]{3,})\s*원/)
        if (m) { price = Number(m[1].replace(/,/g, '')); break }
      }
    }

    // 국내 쇼핑몰은 전자상거래법상 "상품정보제공고시" 표를 의무 게시하므로, 라벨-값 테이블에서 부가 정보를 찾는다
    const infoRows: [string, string][] = []
    document.querySelectorAll('table tr').forEach(tr => {
      const cells = Array.from(tr.querySelectorAll('th,td')).map(c => (c.textContent || '').trim())
      if (cells.length === 2 && cells[0] && cells[1]) infoRows.push([cells[0], cells[1]])
    })

    return { name, price, brand, description, images, infoRows }
  })
}

function findInfoValue(rows: [string, string][], labelPattern: RegExp): string {
  return rows.find(([label]) => labelPattern.test(label))?.[1] || ''
}

/**
 * AI 호출 없이 페이지의 구조화 데이터(schema.org, og 메타태그)와 상품정보고시 표를 읽어 상품 정보를 추출한다.
 * ld+json Product가 없는 사이트에서는 og 메타태그/가격 텍스트 패턴으로 대체하지만, brand/manufacturer/origin/category처럼
 * 표에 없으면 알아낼 방법이 없는 필드는 빈 값으로 남는다 — AI 추측 대신 정직하게 비워두는 쪽을 택했다.
 */
export async function extractProductRuleBased(page: Page, url: string): Promise<ExtractedProduct> {
  const raw = await scrapePageData(page)

  return {
    name: raw.name || url,
    price: raw.price,
    sale_price: raw.price,
    brand: raw.brand || findInfoValue(raw.infoRows, /브랜드/i),
    manufacturer: findInfoValue(raw.infoRows, /제조사|제조자/i),
    origin: findInfoValue(raw.infoRows, /원산지|제조국/i),
    category: '',
    description: raw.description,
    options: [], // extractOptionsFromDom이 별도로 채운다
    thumbnail_url: raw.images[0] || '',
    detail_image_urls: raw.images.slice(1),
  }
}
