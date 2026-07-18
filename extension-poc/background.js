// PTP Mall 관리에서 "크롬익스텐션-개발자모드"로 등록된 몰(PC인증 등으로 자동 로그인이 안 되는 몰)을
// 실제 로그인된 브라우저 안에서 자동으로 순회하며 스크랩한다. 특정 몰 전용이 아니라, 그렇게 등록된
// 몰이면 어디서든(도메인만 보고 PTP에 물어봐서) 그대로 동작하는 공용 확장이다.
// chrome.debugger는 --remote-debugging-* 명령줄 플래그와 달리 크롬의 "기본 프로필 금지" 제한을
// 받지 않아, 사용자가 실제로 로그인해둔 이 브라우저에서 그대로 동작한다.
//
// 사용법: 로그인된 상태로 상품 목록(카테고리) 페이지를 열고 이 확장 아이콘을 클릭하면,
// 그 페이지의 상품 링크를 전부 찾아 하나씩 방문 → 추출 → 서버로 전송 → 다음 페이지로 자동 진행한다.

const PTP_ORIGIN = 'http://127.0.0.1:3000'
const INGEST_ENDPOINT = `${PTP_ORIGIN}/api/scrape/extension-ingest`
const RESOLVE_ENDPOINT = `${PTP_ORIGIN}/api/sites/resolve`
const MAX_PRODUCTS = 300 // 안전장치 — 이 이상은 세션을 나눠서 다시 실행

let siteId = null
let sessionId = null
let running = false

/** 현재 탭의 도메인으로 PTP에 "이 몰이 몇 번 site냐"고 물어본다 — 몰마다 확장을 새로 만들지 않기 위함. */
async function resolveSiteId(hostname) {
  const res = await fetch(`${RESOLVE_ENDPOINT}?host=${encodeURIComponent(hostname)}`)
  if (!res.ok) return null
  const data = await res.json()
  return data.id ?? null
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)) }
function throttle() { return delay(1200 + Math.random() * 1200) }

async function evalInTab(tabId, expression) {
  const res = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (res.exceptionDetails) {
    // exceptionDetails.text는 보통 "Uncaught" 같은 분류명일 뿐이고, 실제 메시지는 exception 쪽에 있다.
    const detail = res.exceptionDetails.exception?.description || res.exceptionDetails.exception?.value || res.exceptionDetails.text || 'evaluate failed'
    throw new Error(detail)
  }
  return res.result.value
}

async function navigate(tabId, url) {
  await chrome.tabs.update(tabId, { url })
  await new Promise(resolve => {
    function onUpdated(id, info) {
      if (id === tabId && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(onUpdated)
        resolve()
      }
    }
    chrome.tabs.onUpdated.addListener(onUpdated)
  })
  await delay(500) // 로딩 완료 이벤트 이후 스크립트 초기화 여유
}

// 상품 링크/다음페이지 링크 수집 — 페이지 이동 없이 현재 문서만 읽는다.
// 모자사러는 카테고리 목록에서 SEO용 URL(/product/상품명/번호/category/분류/display/순서/)을 쓰고,
// 홈 추천상품 위젯 등 일부는 고전 방식(/product/detail.html?product_no=...)을 쓴다 — 둘 다 인식한다.
// 다음 페이지는 카페24 표준 페이지네이션(.ec-base-paginate)에서 "현재 페이지(a.this)" 바로 다음
// 번호의 링크를 찾는다 — 다음/화살표 버튼은 스킨마다 텍스트 없이 이미지만 있어 이름표로 못 찾는다.
const COLLECT_LINKS_EXPR = `(() => {
  const isProductLink = (href) => /\\/product\\/.+\\/\\d+\\/category\\/\\d+\\/display\\/\\d+/.test(href) || href.includes('/product/detail.html')
  const links = Array.from(document.querySelectorAll('a[href*="/product/"]'))
    .map(a => a.href).filter(href => href && isProductLink(href))
  const uniqueLinks = [...new Set(links)]

  let nextUrl = null
  const pageNumbers = Array.from(document.querySelectorAll('.ec-base-paginate ol li a'))
  const currentIdx = pageNumbers.findIndex(a => a.classList.contains('this'))
  if (currentIdx >= 0 && currentIdx + 1 < pageNumbers.length) nextUrl = pageNumbers[currentIdx + 1].href

  return { links: uniqueLinks, nextUrl }
})()`

// 상품 상세 페이지 추출 — lib/extract.ts의 규칙기반 추출과 같은 원칙(ld+json → og 태그 →
// 화면 요소 → hidden input 순 폴백)을 그대로 따른다. 카페24 표준 마크업(#prdDetail 등) 기준.
// 상품코드는 카페24 SEO형 URL(/product/상품명/7111/category/54/display/1/)의 숫자 경로 세그먼트를
// 우선 쓴다 — 상품명(한글) 부분이 나중에 바뀌어도 이 번호로 재매칭되도록.
// 주의: 아래 문자열은 chrome.debugger로 원격 페이지에 그대로 전송되므로 한글 주석을 넣지 않는다
// (전송 과정에서 SyntaxError를 유발하는 것을 실제로 확인함 — 원인 불명, 안전하게 피함).
const EXTRACT_PRODUCT_EXPR = `(() => {
  let product = null
  for (const script of Array.from(document.querySelectorAll('script[type="application/ld+json"]'))) {
    try {
      const parsed = JSON.parse(script.textContent || '')
      const candidates = Array.isArray(parsed) ? parsed : [parsed]
      const found = candidates.find(c => { const t = c['@type']; return t === 'Product' || (Array.isArray(t) && t.includes('Product')) })
      if (found) { product = found; break }
    } catch {}
  }
  const ogContent = (prop) => document.querySelector('meta[property="' + prop + '"]')?.getAttribute('content') || ''

  let name = '', price = null, brand = '', description = '', mainImages = []
  if (product) {
    name = product.name || ''
    brand = (typeof product.brand === 'string' ? product.brand : product.brand?.name) || ''
    description = product.description || ''
    const imgField = product.image
    mainImages = Array.isArray(imgField) ? imgField : (imgField ? [imgField] : [])
    const offers = Array.isArray(product.offers) ? product.offers : (product.offers ? [product.offers] : [])
    if (offers[0]?.price != null) price = Number(offers[0].price)
  }
  if (!name) name = ogContent('og:title') || document.title || ''
  if (!mainImages.length) { const ogImg = ogContent('og:image'); if (ogImg) mainImages = [ogImg] }
  if (!description) description = ogContent('og:description') || document.querySelector('meta[name="description"]')?.getAttribute('content') || ''
  if (price == null) {
    const priceEls = Array.from(document.querySelectorAll('[class*="price" i], [id*="price" i]'))
    for (const el of priceEls) {
      const m = (el.textContent || '').match(/([\\d,]{3,})\\s*원/)
      if (m) { price = Number(m[1].replace(/,/g, '')); break }
    }
  }

  const detailContainer = document.querySelector('#prdDetail') || document.querySelector('.detail_con')
  const detailImages = Array.from(detailContainer?.querySelectorAll('img') || [])
    .map(img => img.src).filter(src => src && !mainImages.includes(src) && !src.includes('/upload/appfiles/'))

  const options = Array.from(document.querySelectorAll('select'))
    .map(sel => ({
      name: sel.getAttribute('title') || sel.name || sel.id || '',
      values: Array.from(sel.options).filter(o => o.value !== '').map(o => (o.textContent || '').trim()).filter(Boolean),
    }))
    .filter(o => o.values.length > 0 && !/수량|콤보|qty/i.test(o.name))

  const stockText = document.body.innerText.match(/품절|일시품절|재입고|단종/)?.[0] || ''
  const stockStatus = /품절/.test(stockText) ? '품절' : /단종/.test(stockText) ? '단종' : '판매중'

  const u = new URL(location.href)
  const pathMatch = location.pathname.match(/\\/product\\/[^/]+\\/(\\d+)\\/category\\//)
  const code = pathMatch?.[1] || u.searchParams.get('product_no') || u.searchParams.get('branduid') || u.searchParams.get('goodsno') || location.href

  return {
    name, price, sale_price: price, brand, manufacturer: '', origin: '', category: '', description,
    options, thumbnail_urls: mainImages, thumbnail_names: [], detail_image_urls: detailImages, detail_image_names: [],
    detail_text: (detailContainer?.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 3000),
    summary_info: '', english_name: '', extra_info: [], stock_status: stockStatus, stock_qty: null,
    stock_by_option: [], mall_product_code: code,
  }
})()`

async function report(url, product) {
  const res = await fetch(INGEST_ENDPOINT, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ siteId, sessionId, url, product }),
  })
  const data = await res.json()
  if (data.sessionId) sessionId = data.sessionId
  return data
}

async function reportDone() {
  if (!sessionId) return
  await fetch(INGEST_ENDPOINT, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ siteId, sessionId, done: true }),
  }).catch(() => {})
}

async function run(tabId, startUrl) {
  running = true
  let processed = 0
  try {
    while (processed < MAX_PRODUCTS) {
      const { links, nextUrl } = await evalInTab(tabId, COLLECT_LINKS_EXPR)
      console.log(`[PTP] 이 페이지에서 상품 ${links.length}개 발견`)
      if (links.length === 0) {
        const diag = await evalInTab(tabId, `({
          title: document.title,
          url: location.href,
          totalLinks: document.querySelectorAll('a').length,
          totalImgs: document.querySelectorAll('img').length,
          productDetailLinks: Array.from(document.querySelectorAll('a[href*="detail.html"], a[href*="product_no"]')).map(a => a.getAttribute('href')).slice(0, 10),
          linksContainingProduct: [...new Set(Array.from(document.querySelectorAll('a[href*="/product/"]')).map(a => a.getAttribute('href')))].slice(0, 15),
          onclickWithProduct: Array.from(document.querySelectorAll('[onclick]'))
            .map(el => el.getAttribute('onclick')).filter(v => /product|detail|prdNo|prd_no/i.test(v)).slice(0, 10),
          classesLikePrd: [...new Set(Array.from(document.querySelectorAll('[class*="prd" i], [class*="item" i], [class*="goods" i]')).map(el => el.className))].slice(0, 15),
          firstPrdListItemHtml: document.querySelector('.prdList_normal li, .prdList_normal > *')?.outerHTML.slice(0, 2000) || null,
          bodyTextSample: document.body.innerText.replace(/\\s+/g, ' ').trim().slice(0, 300),
        })`)
        console.log('[PTP] 진단 정보:', JSON.stringify(diag, null, 2))
      }
      for (const link of links) {
        if (processed >= MAX_PRODUCTS) break
        await navigate(tabId, link)
        try {
          const product = await evalInTab(tabId, EXTRACT_PRODUCT_EXPR)
          const result = await report(link, product)
          console.log(`[PTP] ${processed + 1}/${links.length} 저장:`, product.name, result)
        } catch (e) {
          console.log('[PTP] 추출 실패:', link, e.message)
        }
        processed++
        await throttle()
      }

      if (!nextUrl) break
      await navigate(tabId, nextUrl)
      await throttle()
    }
    console.log(`[PTP] 완료 — 총 ${processed}개 처리`)
  } finally {
    await reportDone()
    // 목록 페이지로 되돌려놔야 다음 클릭 때 다시 상품 페이지로 오인하지 않는다.
    if (startUrl) await navigate(tabId, startUrl).catch(() => {})
    running = false
  }
}

chrome.action.onClicked.addListener(async (tab) => {
  if (running) { console.log('[PTP] 이미 실행 중입니다.'); return }
  if (!tab.id || !tab.url) return

  const hostname = new URL(tab.url).hostname
  siteId = await resolveSiteId(hostname).catch(() => null)
  if (!siteId) {
    console.log(`[PTP] "${hostname}"은 PTP Mall 관리에 "크롬익스텐션-개발자모드"로 등록돼 있지 않습니다.`)
    return
  }
  sessionId = null

  try {
    await chrome.debugger.attach({ tabId: tab.id }, '1.3')
  } catch (e) {
    console.log('[PTP] debugger attach 실패:', e.message)
    return
  }
  try {
    await run(tab.id, tab.url)
  } finally {
    await chrome.debugger.detach({ tabId: tab.id }).catch(() => {})
  }
})
