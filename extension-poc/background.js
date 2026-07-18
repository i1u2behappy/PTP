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
const ADJUST_CAPTURE_ENDPOINT_BASE = `${PTP_ORIGIN}/api/sites`
const MAX_PRODUCTS = 300 // 안전장치 — 이 이상은 세션을 나눠서 다시 실행

let siteId = null
let extractionRules = {}
let sessionId = null
let running = false

/** 현재 탭의 도메인으로 PTP에 "이 몰이 몇 번 site냐"고 물어본다 — 몰마다 확장을 새로 만들지 않기 위함.
 * "스크랩 조정" 기능이 그 몰에 대해 학습해둔 추출 규칙(extractionRules)도 같이 받아온다. */
async function resolveSite(hostname) {
  const res = await fetch(`${RESOLVE_ENDPOINT}?host=${encodeURIComponent(hostname)}`)
  if (!res.ok) return null
  const data = await res.json()
  if (data.id == null) return null
  return { id: data.id, extractionRules: data.extractionRules || {} }
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

// 상품 링크/다음페이지 링크 수집 — 페이지 이동 없이 현재 문서만 읽는다. 몰마다 플랫폼이 달라(카페24
// SEO형, 카페24 고전형, 신우 같은 구형 자체 솔루션 등) 여러 패턴을 다 시도한다:
// - 카페24 SEO: /product/상품명/번호/category/분류/display/순서/
// - 카페24 고전: /product/detail.html?product_no=...
// - 구형 자체 솔루션(신우 등): detail.htm?brandcode=... 처럼 detail.htm(l) + 알려진 코드 파라미터
const COLLECT_LINKS_EXPR = `(() => {
  const isProductLink = (href) => {
    if (/\\/product\\/.+\\/\\d+\\/category\\/\\d+\\/display\\/\\d+/.test(href)) return true
    if (/detail\\.html?/i.test(href) && /[?&](product_no|branduid|goodsno|goods_no|brandcode)=/i.test(href)) return true
    return false
  }
  const links = Array.from(document.querySelectorAll('a[href*="/product/"], a[href*="detail.htm"]'))
    .map(a => a.href).filter(href => href && isProductLink(href))
  const uniqueLinks = [...new Set(links)]

  // 다음 페이지 — 카페24 표준 페이지네이션(.ec-base-paginate, 현재 페이지 a.this 다음 번호)을 먼저
  // 시도하고, 없으면 "다음"/"next" 글자가 들어간 링크(신우 등 구형 몰은 화살표 이미지 대신 이 방식)를 찾는다.
  let nextUrl = null
  const pageNumbers = Array.from(document.querySelectorAll('.ec-base-paginate ol li a'))
  const currentIdx = pageNumbers.findIndex(a => a.classList.contains('this'))
  if (currentIdx >= 0 && currentIdx + 1 < pageNumbers.length) nextUrl = pageNumbers[currentIdx + 1].href
  if (!nextUrl) {
    const nextTextLink = Array.from(document.querySelectorAll('a')).find(a => /다음|next/i.test((a.textContent || '').trim()))
    if (nextTextLink) nextUrl = nextTextLink.href
  }

  // 이 목록(카테고리) 페이지의 카테고리 경로(예: "모자 > 귀도리")를 찾는다. .xans-product-headcategory는
  // 카페24 표준 클래스인데 배너 이미지용으로도 같이 쓰여 텍스트가 비어있을 수 있어, 후보 중 텍스트가
  // 있는 걸 찾는다 — lib/scraper.ts의 detectCategoryLabel과 같은 방식.
  let category = ''
  const categorySelectors = ['.xans-product-headcategory', 'nav[aria-label*="breadcrumb" i]', '.breadcrumb', '.location']
  for (const sel of categorySelectors) {
    for (const el of Array.from(document.querySelectorAll(sel))) {
      const text = (el.textContent || '').split('/').map(s => s.trim()).filter(Boolean).join(' > ')
      if (text) { category = text; break }
    }
    if (category) break
  }

  return { links: uniqueLinks, nextUrl, category }
})()`

// 상품 상세 페이지 추출 — lib/extract.ts의 규칙기반 추출과 같은 원칙(ld+json → og 태그 →
// 화면 요소 → hidden input 순 폴백)을 그대로 따른다. 카페24 표준 마크업(#prdDetail 등) 기준.
// 상품코드는 카페24 SEO형 URL(/product/상품명/7111/category/54/display/1/)의 숫자 경로 세그먼트를
// 우선 쓴다 — 상품명(한글) 부분이 나중에 바뀌어도 이 번호로 재매칭되도록.
// 주의: 아래 문자열은 chrome.debugger로 원격 페이지에 그대로 전송되므로 한글 주석을 넣지 않는다
// (전송 과정에서 SyntaxError를 유발하는 것을 실제로 확인함 — 원인 불명, 안전하게 피함).
// rules는 "스크랩 조정" 기능이 이 몰에 대해 학습해둔 영구 추출 규칙(sites.extraction_rules, resolveSite로
// 같이 받아옴) — lib/extract.ts의 규칙 적용과 같은 방식으로 최우선(마지막에 덮어씀) 적용한다.
function buildExtractExpr(rules) {
  return `(async () => {
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
  if (!name) name = ogContent('og:title') || document.querySelector('input[name="brandname"]')?.value || document.title || ''
  if (!mainImages.length) { const ogImg = ogContent('og:image'); if (ogImg) mainImages = [ogImg] }
  if (!mainImages.length) {
    const galleryImgs = Array.from(document.querySelectorAll('.img_small .small img')).map(img => img.src).filter(Boolean)
    if (galleryImgs.length) mainImages = galleryImgs
    else {
      const bigImg = document.querySelector('#bigimage')
      if (bigImg?.src) mainImages = [bigImg.src]
    }
  }
  if (!description) description = ogContent('og:description') || document.querySelector('meta[name="description"]')?.getAttribute('content') || ''

  // 상품정보고시류 라벨-값 쌍 — 카페24는 <table>(th/td), 신우 같은 구형 자체 솔루션은 <dl><dt>/<dd>로
  // 표현하니 둘 다 본다. lib/extract.ts의 같은 스캔과 동일한 방식(dt는 다음 dt를 만나기 전 첫 dd와 짝짓기).
  const infoRows = []
  document.querySelectorAll('table tr').forEach(tr => {
    const cells = Array.from(tr.querySelectorAll('th,td')).map(c => (c.textContent || '').trim())
    if (cells.length === 2 && cells[0] && cells[1]) infoRows.push([cells[0], cells[1]])
  })
  document.querySelectorAll('dl').forEach(dl => {
    Array.from(dl.querySelectorAll('dt')).forEach(dt => {
      let sib = dt.nextElementSibling
      while (sib && sib.tagName !== 'DD' && sib.tagName !== 'DT') sib = sib.nextElementSibling
      if (sib && sib.tagName === 'DD') {
        const label = (dt.textContent || '').trim()
        const value = (sib.textContent || '').trim()
        if (label && value) infoRows.push([label, value])
      }
    })
  })
  const infoValue = (labelPattern) => infoRows.find(([label]) => labelPattern.test(label))?.[1] || ''
  const firstNumber = (text) => { const m = text.match(/[\\d,]{2,}(?=\\s*원)/); return m ? Number(m[0].replace(/,/g, '')) : null }
  const costPrice = firstNumber(infoValue(/도매가|공급가/))
  const shippingFee = firstNumber(infoValue(/배\\s*송\\s*비/))
  const labeledRetailPrice = firstNumber(infoValue(/소비자가|시중가|오픈마켓/))

  if (price == null && labeledRetailPrice != null) price = labeledRetailPrice
  if (price == null) {
    const priceEls = Array.from(document.querySelectorAll('[class*="price" i], [id*="price" i]'))
    for (const el of priceEls) {
      const m = (el.textContent || '').match(/([\\d,]{3,})\\s*원/)
      if (!m) continue
      const candidate = Number(m[1].replace(/,/g, ''))
      if (costPrice != null && candidate === costPrice) continue
      price = candidate
      break
    }
  }

  let categoryFromDetail = ''
  for (const sel of ['.xans-product-headcategory', 'nav[aria-label*="breadcrumb" i]', '.breadcrumb', '.location']) {
    for (const el of Array.from(document.querySelectorAll(sel))) {
      const text = (el.textContent || '').split('/').map(s => s.trim()).filter(Boolean).join(' > ')
      if (text) { categoryFromDetail = text; break }
    }
    if (categoryFromDetail) break
  }

  const detailContainer = document.querySelector('#prdDetail') || document.querySelector('.detail_con')
  const detailImages = Array.from(detailContainer?.querySelectorAll('img') || [])
    .map(img => img.src).filter(src => src && !mainImages.includes(src) && !src.includes('/upload/appfiles/'))

  const selectEls = Array.from(document.querySelectorAll('select'))
  const realValues = (sel) => Array.from(sel.options).filter(o => o.value !== '').map(o => (o.textContent || '').trim()).filter(Boolean)
  const options = selectEls
    .map(sel => ({ name: sel.getAttribute('title') || sel.name || sel.id || '', values: realValues(sel) }))
    .filter(o => o.values.length > 0 && !/수량|콤보|qty/i.test(o.name))

  // 옵션1을 고르면 옵션2가 AJAX로 채워지는 몰(예: 신우) 대응 — 뒤쪽 select가 비어있는데 앞쪽엔 실값이
  // 있으면, 앞쪽 값을 하나씩 실제로 선택(change 이벤트 발생)해보고 그 결과로 채워지는 뒤쪽 옵션을 모은다.
  // 안전상 뒤쪽(둘째) select는 절대 값을 바꾸거나 change를 일으키지 않는다 — 읽기만 한다(장바구니 등
  // 실제 동작으로 이어지는 onChange가 걸려있을 수 있어서).
  let cascadeStockKnown = false
  let cascadeHasStock = false
  for (let i = 0; i < selectEls.length - 1; i++) {
    const first = selectEls[i]
    const second = selectEls[i + 1]
    const firstValues = realValues(first)
    if (firstValues.length === 0 || realValues(second).length > 0) continue
    cascadeStockKnown = true
    const collected = new Set()
    for (const val of firstValues) {
      first.value = val
      first.dispatchEvent(new Event('change', { bubbles: true }))
      const beforeCount = second.options.length
      for (let waited = 0; waited < 2000; waited += 150) {
        await new Promise(r => setTimeout(r, 150))
        if (second.options.length !== beforeCount) break
      }
      const afterValues = realValues(second)
      afterValues.forEach(v => collected.add(v))
      if (afterValues.length > 0) cascadeHasStock = true
    }
    if (collected.size > 0) {
      const secondName = second.getAttribute('title') || second.name || second.id || ''
      const merged = { name: secondName, values: Array.from(collected) }
      const idx = options.findIndex(o => o.name === secondName)
      if (idx >= 0) options[idx] = merged
      else options.push(merged)
    }
    break
  }

  const stockText = document.body.innerText.match(/품절|일시품절|재입고|단종/)?.[0] || ''
  let stockStatus = /품절/.test(stockText) ? '품절' : /단종/.test(stockText) ? '단종' : '판매중'
  if (!stockText && cascadeStockKnown) stockStatus = cascadeHasStock ? '판매중' : '품절'

  const u = new URL(location.href)
  const pathMatch = location.pathname.match(/\\/product\\/[^/]+\\/(\\d+)\\/category\\//)
  const code = pathMatch?.[1] || u.searchParams.get('product_no') || u.searchParams.get('branduid') || u.searchParams.get('goodsno') || u.searchParams.get('brandcode') || location.href

  const result = {
    name, price, sale_price: price, cost_price: costPrice, shipping_fee: shippingFee,
    brand, manufacturer: '', origin: '', category: categoryFromDetail || '', description,
    options, thumbnail_urls: mainImages, thumbnail_names: [], detail_image_urls: detailImages, detail_image_names: [],
    detail_text: (detailContainer?.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 3000),
    summary_info: '', english_name: '', extra_info: [], stock_status: stockStatus, stock_qty: null,
    stock_by_option: [], mall_product_code: code,
  }

  const extractionRules = ${JSON.stringify(rules)}
  for (const [field, rule] of Object.entries(extractionRules)) {
    let text = null
    if (rule.type === 'label') text = infoValue(new RegExp(rule.value)) || null
    else { const el = document.querySelector(rule.value); text = el ? el.textContent : null }
    const trimmed = text ? text.trim() : ''
    if (!trimmed) continue

    if (field === 'price' || field === 'cost_price' || field === 'shipping_fee') {
      const m = trimmed.match(/[\\d,]{2,}/)
      if (!m) continue
      const n = Number(m[0].replace(/,/g, ''))
      if (field === 'price') { result.price = n; result.sale_price = n }
      else if (field === 'cost_price') result.cost_price = n
      else result.shipping_fee = n
    } else if (field === 'name' || field === 'brand' || field === 'manufacturer' || field === 'origin' || field === 'category') {
      result[field] = trimmed
    }
  }

  return result
})()`
}

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
      const { links, nextUrl, category } = await evalInTab(tabId, COLLECT_LINKS_EXPR)
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
          const product = await evalInTab(tabId, buildExtractExpr(extractionRules))
          // 카테고리는 상품 상세페이지가 아니라 방금 있던 목록(카테고리) 페이지에서만 알 수 있으므로,
          // 상세페이지 추출 결과 위에 덮어씌운다.
          if (category) product.category = category
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
  const site = await resolveSite(hostname).catch(() => null)
  if (!site) {
    console.log(`[PTP] "${hostname}"은 PTP Mall 관리에 "크롬익스텐션-개발자모드"로 등록돼 있지 않습니다.`)
    return
  }
  siteId = site.id
  extractionRules = site.extractionRules
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

// "스크랩 조정" 2단계 — 사용자가 PTP에 프롬프트를 먼저 입력해두고(1단계, /api/sites/{id}/adjust/prompt),
// 조정하려는 상품 페이지에서 이 우클릭 메뉴를 실행하면 그 페이지 HTML을 캡처해 PTP로 보낸다. 백엔드가
// 이 몰의 페이지를 스스로 못 열어보는 게 개발자모드의 정의라, 이 캡처가 유일한 통로다.
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: 'ptp-adjust', title: 'PTP 조정 반영 (이 페이지 기준)', contexts: ['page'] }, () => void chrome.runtime.lastError)
})

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== 'ptp-adjust' || !tab?.id || !tab.url) return
  const hostname = new URL(tab.url).hostname
  const site = await resolveSite(hostname).catch(() => null)
  if (!site) {
    console.log(`[PTP] "${hostname}"은 PTP Mall 관리에 "크롬익스텐션-개발자모드"로 등록돼 있지 않습니다.`)
    return
  }
  try {
    await chrome.debugger.attach({ tabId: tab.id }, '1.3')
  } catch (e) {
    console.log('[PTP] 조정 반영 실패(디버거 연결 안 됨):', e.message)
    return
  }
  try {
    const html = await evalInTab(tab.id, '(() => document.documentElement.outerHTML.slice(0, 200000))()')
    const res = await fetch(`${ADJUST_CAPTURE_ENDPOINT_BASE}/${site.id}/adjust/capture`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: tab.url, html }),
    })
    const data = await res.json()
    if (!res.ok) console.log('[PTP] 조정 반영 실패:', data.error || res.status)
    else console.log('[PTP] 조정 반영 완료 — 갱신된 규칙:', data.rules)
  } catch (e) {
    console.log('[PTP] 조정 반영 중 오류:', e.message)
  } finally {
    await chrome.debugger.detach({ tabId: tab.id }).catch(() => {})
  }
})
