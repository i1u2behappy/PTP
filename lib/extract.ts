import type { Page } from 'playwright'
import type { ExtractedProduct } from './ai'

interface RawPageData {
  name: string
  price: number | null
  brand: string
  description: string
  mainImages: string[]
  mainImageNames: string[]
  detailImages: string[]
  detailImageNames: string[]
  detailText: string
  infoRows: [string, string][]
  sku: string
  availability: string
  stockText: string
  stockQtyText: string
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
    let mainImages: string[] = []
    let sku = ''
    let availability = ''

    if (product) {
      name = (product.name as string) || ''
      const brandField = product.brand as { name?: string } | string | undefined
      brand = (typeof brandField === 'string' ? brandField : brandField?.name) || ''
      description = (product.description as string) || ''
      const imgField = product.image
      mainImages = Array.isArray(imgField) ? imgField as string[] : (imgField ? [imgField as string] : [])
      sku = (product.sku as string) || (product.productID as string) || (product.mpn as string) || ''
      const offersField = product.offers
      const offers = Array.isArray(offersField) ? offersField : (offersField ? [offersField] : [])
      const firstOffer = offers[0] as { price?: number | string; availability?: string } | undefined
      if (firstOffer?.price != null) price = Number(firstOffer.price)
      availability = firstOffer?.availability || ''
    }

    if (!name) name = ogContent('og:title') || document.title || ''
    if (!mainImages.length) {
      const ogImg = ogContent('og:image')
      if (ogImg) mainImages = [ogImg]
    }

    // ld+json/og 이미지는 URL만 있고 alt 텍스트가 없으니, 페이지의 실제 <img> 태그에서 src 기준으로 alt를 찾아 붙인다.
    // alt가 없는 이미지는 파일명(URL 마지막 경로)을 이름으로 대신 쓴다.
    const imgAltBySrc = new Map<string, string>()
    document.querySelectorAll('img').forEach(img => {
      const alt = img.getAttribute('alt')?.trim()
      if (alt && img.src) imgAltBySrc.set(img.src, alt)
    })
    const nameForImage = (src: string) => {
      const alt = imgAltBySrc.get(src)
      if (alt) return alt
      try { return decodeURIComponent(new URL(src, location.href).pathname.split('/').pop() || '') } catch { return '' }
    }
    const mainImageNames = mainImages.map(nameForImage)

    // ld+json/og의 대표 이미지 갤러리(여러 장일 수 있음)와는 별개로, 카페24 표준 상세설명 영역(#prdDetail)에
    // 판매자가 직접 올린 상품별 상세 이미지(사이즈/소재 등 텍스트로는 안 남는 구분 정보)를 모은다
    const detailImageEls = Array.from(document.querySelectorAll<HTMLImageElement>('#prdDetail img'))
      .filter(img => img.src && !mainImages.includes(img.src))
    const detailImages = detailImageEls.map(img => img.src)
    const detailImageNames = detailImageEls.map(img => nameForImage(img.src))

    // 상세페이지에 이미지가 아니라 텍스트로 직접 박혀 있는 설명 내용 (소재/사이즈 안내 등)
    const detailText = (document.querySelector('#prdDetail')?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 3000)

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

    // 품절/재입고/단종 배지 텍스트 및 재고수량 문구를 탐색 (ld+json availability/상품정보고시 표가 없는 사이트 대비)
    let stockText = ''
    let stockQtyText = ''
    const stockEls = Array.from(document.querySelectorAll(
      '[class*="soldout" i], [class*="sold-out" i], [class*="stock" i], [class*="status" i]',
    ))
    for (const el of stockEls) {
      const t = (el.textContent || '').trim()
      if (!stockText && /품절|재입고|단종|일시품절/.test(t)) stockText = t
      if (!stockQtyText && /재고\s*(?:수량)?\s*[:：]?\s*\d+\s*개?/.test(t)) stockQtyText = t
      if (stockText && stockQtyText) break
    }

    // 국내 쇼핑몰은 전자상거래법상 "상품정보제공고시" 표를 의무 게시하므로, 라벨-값 테이블에서 부가 정보를 찾는다
    const infoRows: [string, string][] = []
    document.querySelectorAll('table tr').forEach(tr => {
      const cells = Array.from(tr.querySelectorAll('th,td')).map(c => (c.textContent || '').trim())
      if (cells.length === 2 && cells[0] && cells[1]) infoRows.push([cells[0], cells[1]])
    })

    return {
      name, price, brand, description, mainImages, mainImageNames, detailImages, detailImageNames, detailText,
      infoRows, sku, availability, stockText, stockQtyText,
    }
  })
}

function findInfoValue(rows: [string, string][], labelPattern: RegExp): string {
  return rows.find(([label]) => labelPattern.test(label))?.[1] || ''
}

/** ld+json offers.availability 또는 페이지 내 품절/단종 배지 텍스트로 재고 상태를 판정한다. */
export function extractStockStatus(availability: string, stockText: string): string {
  if (/discontinued/i.test(availability)) return '단종'
  if (/outofstock|soldout/i.test(availability)) return '품절'
  if (/instock|limitedavailability/i.test(availability)) return '판매중'
  if (/단종/.test(stockText)) return '단종'
  if (/품절/.test(stockText)) return '품절'
  return '판매중' // 명시적 신호가 없으면 판매중으로 간주
}

/** 상품정보고시 "재고" 행에서 숫자를 뽑는다. 표에 없으면 페이지 내 "재고 N개" 류 문구로 대체한다. 그마저 없으면 null. */
function resolveStockQty(rows: [string, string][], stockQtyText: string): number | null {
  const fromTable = findInfoValue(rows, /재고/i).match(/(\d+)/)
  if (fromTable) return Number(fromTable[1])
  const fromText = stockQtyText.match(/(\d+)/)
  return fromText ? Number(fromText[1]) : null
}

/** ld+json sku가 없으면 URL 쿼리파라미터/경로에서 몰 상품코드를 추정한다. 그마저 없으면 URL 자체를 코드로 쓴다. */
function extractMallProductCodeFromUrl(url: string): string {
  try {
    const u = new URL(url)
    for (const key of ['branduid', 'goodsno', 'goods_no', 'product_no', 'productNo', 'idx', 'no']) {
      const v = u.searchParams.get(key)
      if (v) return v
    }
    const m = u.pathname.match(/(\d{3,})/)
    if (m) return m[1]
  } catch { /* URL 파싱 실패 시 아래 폴백으로 */ }
  return url
}

export function extractMallProductCode(url: string, sku: string): string {
  return sku || extractMallProductCodeFromUrl(url)
}

export interface ExtractSelectorOverrides {
  nameSelector?: string
  priceSelector?: string
  thumbnailSelector?: string
}

/**
 * AI 호출 없이 페이지의 구조화 데이터(schema.org, og 메타태그)와 상품정보고시 표를 읽어 상품 정보를 추출한다.
 * ld+json Product가 없는 사이트에서는 og 메타태그/가격 텍스트 패턴으로 대체하지만, brand/manufacturer/origin/category처럼
 * 표에 없으면 알아낼 방법이 없는 필드는 빈 값으로 남는다 — AI 추측 대신 정직하게 비워두는 쪽을 택했다.
 * overrides로 몰별 수동 CSS 셀렉터가 지정되면(Mall 상세관리에서 설정), 자동 추출 결과보다 우선한다.
 */
export async function extractProductRuleBased(page: Page, url: string, overrides?: ExtractSelectorOverrides): Promise<ExtractedProduct> {
  const raw = await scrapePageData(page)

  const result: ExtractedProduct = {
    name: raw.name || url,
    price: raw.price,
    sale_price: raw.price,
    brand: raw.brand || findInfoValue(raw.infoRows, /브랜드/i),
    manufacturer: findInfoValue(raw.infoRows, /제조사|제조자/i),
    origin: findInfoValue(raw.infoRows, /원산지|제조국/i),
    category: '',
    description: raw.description,
    options: [], // extractOptionsFromDom이 별도로 채운다
    thumbnail_urls: raw.mainImages,
    thumbnail_names: raw.mainImageNames,
    detail_image_urls: raw.detailImages,
    detail_image_names: raw.detailImageNames,
    detail_text: raw.detailText,
    summary_info: findInfoValue(raw.infoRows, /상품요약정보/i),
    english_name: findInfoValue(raw.infoRows, /영문상품명/i),
    // 몰마다, 카테고리마다 상품정보고시 표에 다른 라벨(세탁방법/소재/취급주의 등)이 들어갈 수 있어 미리 다
    // 알 수 없다 — 알려진 라벨(브랜드/제조사/원산지/상품요약정보/영문상품명)로 못 옮긴 값까지 포함해 표
    // 전체를 그대로 들고 있어야 어떤 몰이든 나중에 필요한 값을 놓치지 않는다.
    extra_info: raw.infoRows.filter(([, value]) => value).map(([label, value]) => ({ label, value })),
    stock_status: extractStockStatus(raw.availability, raw.stockText),
    stock_qty: resolveStockQty(raw.infoRows, raw.stockQtyText),
    stock_by_option: [], // scraper.ts의 extractStockByOption이 별도로 채운다 (클릭이 필요한 위젯이라 이 함수 범위 밖)
    mall_product_code: extractMallProductCode(url, raw.sku),
  }

  if (overrides?.nameSelector) {
    const text = await page.locator(overrides.nameSelector).first().textContent({ timeout: 3_000 }).catch(() => null)
    if (text?.trim()) result.name = text.trim()
  }
  if (overrides?.priceSelector) {
    const text = await page.locator(overrides.priceSelector).first().textContent({ timeout: 3_000 }).catch(() => null)
    const m = text?.match(/[\d,]{2,}/)
    if (m) {
      const n = Number(m[0].replace(/,/g, ''))
      result.price = n
      result.sale_price = n
    }
  }
  if (overrides?.thumbnailSelector) {
    const srcs = await page.locator(overrides.thumbnailSelector).evaluateAll(
      (els: HTMLImageElement[]) => els.map(el => el.src).filter(Boolean),
    ).catch(() => [])
    if (srcs.length) result.thumbnail_urls = srcs
  }

  return result
}
