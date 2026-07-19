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
const STOP_REQUESTED_ENDPOINT = `${PTP_ORIGIN}/api/scrape/stop-requested`
const FAILED_URLS_ENDPOINT = `${PTP_ORIGIN}/api/scrape/failed-urls`
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

/** PTP의 "스크래핑 중지" 버튼은 서버 인메모리 Set에 요청만 남겨둔다(일반모드는 서버 자신이 그 루프를
 * 돌고 있어 바로 확인 가능) — 개발자모드는 루프가 이 확장(사용자 브라우저) 안에서 돌고 있어, 상품마다
 * 이 엔드포인트로 직접 물어봐야 중지 요청을 알 수 있다. */
async function checkStopRequested(sid) {
  if (!sid) return false
  try {
    const res = await fetch(`${STOP_REQUESTED_ENDPOINT}?sessionId=${sid}`)
    const data = await res.json()
    return !!data.stop
  } catch {
    return false
  }
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
// SEO형, 카페24 고전형, 신우 같은 구형 자체 솔루션, 고도몰 등) 여러 패턴을 다 시도한다(lib/scraper.ts의
// PLATFORM_PROFILES와 같은 패턴을 씀 — 두 구현이 갈라지지 않도록 플랫폼이 추가되면 항상 같이 반영):
// - 카페24 SEO: /product/상품명/번호/category/분류/display/순서/
// - 카페24 고전: /product/detail.html?product_no=...
// - 구형 자체 솔루션(신우 등): detail.htm?brandcode=... 처럼 detail.htm(l) + 알려진 코드 파라미터
// - 고도몰(펫투비 등): goods_view.php?goodsno=...
const COLLECT_LINKS_EXPR = `(() => {
  const isProductLink = (href) => {
    if (/\\/product\\/.+\\/\\d+\\/category\\/\\d+\\/display\\/\\d+/.test(href)) return true
    if (/detail\\.html?/i.test(href) && /[?&](product_no|branduid|goodsno|goods_no|brandcode)=/i.test(href)) return true
    if (/goods_view\\.php/i.test(href) && /[?&]goodsno=/i.test(href)) return true
    return false
  }
  const links = Array.from(document.querySelectorAll('a[href*="/product/"], a[href*="detail.htm"], a[href*="goods_view"]'))
    .map(a => a.href).filter(href => href && isProductLink(href))
  const uniqueLinks = [...new Set(links)]

  // 다음 페이지 — 카페24 표준 페이지네이션(.ec-base-paginate, 현재 페이지 a.this 다음 번호)을 먼저
  // 시도하고, 없으면 고도몰 표준(.paginate a.next), 그래도 없으면 "다음"/"next" 글자가 들어간 링크
  // (신우 등 구형 몰은 화살표 이미지 대신 이 방식)를 찾는다.
  let nextUrl = null
  const pageNumbers = Array.from(document.querySelectorAll('.ec-base-paginate ol li a'))
  const currentIdx = pageNumbers.findIndex(a => a.classList.contains('this'))
  if (currentIdx >= 0 && currentIdx + 1 < pageNumbers.length) nextUrl = pageNumbers[currentIdx + 1].href
  if (!nextUrl) {
    const godoNext = document.querySelector('.paginate a.next')
    if (godoNext) nextUrl = godoNext.href
  }
  if (!nextUrl) {
    const nextTextLink = Array.from(document.querySelectorAll('a')).find(a => /다음|next/i.test((a.textContent || '').trim()))
    if (nextTextLink) nextUrl = nextTextLink.href
  }

  // 이 목록(카테고리) 페이지의 카테고리 경로(예: "모자 > 귀도리")를 찾는다. .xans-product-headcategory는
  // 카페24 표준 클래스인데 배너 이미지용으로도 같이 쓰여 텍스트가 비어있을 수 있어, 후보 중 텍스트가
  // 있는 걸 찾는다 — lib/scraper.ts의 detectCategoryLabel과 같은 방식.
  let category = ''
  let brandFromCategory = ''
  const categorySelectors = ['.xans-product-headcategory', 'nav[aria-label*="breadcrumb" i]', '.breadcrumb', '.location']
  for (const sel of categorySelectors) {
    for (const el of Array.from(document.querySelectorAll(sel))) {
      // <li>로 계층이 명확히 나뉘어 있으면 그 경계를 그대로 쓴다 — "/" 기준으로 통째로 쪼개면
      // "SANDAL/MULE"처럼 카테고리명 자체에 "/"가 들어있는 경우까지 잘못 쪼개진다(실제 발견된 사례).
      // 각 <li> 자체가 "/ 라벨"처럼 구분자를 텍스트 안에 그대로 갖고 있는 몰도 있어(실제 발견된 사례)
      // 앞뒤의 "/"·공백은 벗겨낸다.
      const liItems = Array.from(el.querySelectorAll('li'))
        .map(li => (li.textContent || '').replace(/^[\s/]+|[\s/]+$/g, '').trim())
        .filter(Boolean)
      if (!liItems.length) {
        const text = (el.textContent || '').split('/').map(s => s.trim()).filter(Boolean).join(' > ')
        if (text) { category = text; break }
        continue
      }
      // "브랜드"라는 카테고리 노드 바로 아래는 상품 종류 구분이 아니라 실제 브랜드명이다(예: 브랜드 > 나이키).
      const brandIdx = liItems.findIndex(t => t === '브랜드')
      if (brandIdx !== -1 && brandIdx + 1 < liItems.length) {
        category = liItems.slice(0, brandIdx).join(' > ')
        brandFromCategory = liItems[brandIdx + 1]
      } else {
        category = liItems.join(' > ')
      }
      break
    }
    if (category || brandFromCategory) break
  }

  return { links: uniqueLinks, nextUrl, category, brandFromCategory }
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
  // "3,000 ~ 4,000원"처럼 범위로 적힌 값은 최저값을 쓴다(배송비가 흔히 이렇게 표기된다) — 범위가 아니면
  // 예전처럼 숫자 바로 뒤에 "원"이 오는 걸 찾는다. 범위 표기를 못 가려내면 "원" 바로 앞의 숫자(범위의
  // 마지막 값)만 잡혀 최저값이 아니라 최고값이 들어가는 문제가 있었다(실제 발견된 사례: 배송비 3,000~
  // 4,000원인데 4,000원이 저장됨).
  const firstNumber = (text) => {
    const range = text.match(/([\\d,]{2,})\\s*~\\s*[\\d,]{2,}\\s*(?=원)/)
    if (range) return Number(range[1].replace(/,/g, ''))
    const m = text.match(/[\\d,]{2,}(?=\\s*원)/)
    return m ? Number(m[0].replace(/,/g, '')) : null
  }
  // 배송비는 범위 자체가 실제 정보(무게/지역별 차등)라 Raw 데이터에는 원문 그대로 "3000~4000"으로
  // 남겨 사용자가 검수 화면에서 실제 페이지와 비교할 수 있게 한다 — product_master로 옮길 때만 계산
  // 가능하도록 최저값 숫자로 바뀐다(lib/master/migrate.ts).
  const firstNumberOrRange = (text) => {
    const range = text.match(/([\\d,]{2,})\\s*~\\s*([\\d,]{2,})\\s*(?=원)/)
    if (range) return range[1].replace(/,/g, '') + '~' + range[2].replace(/,/g, '')
    return firstNumber(text)
  }
  let costPrice = firstNumber(infoValue(/도매가|공급가/))
  const shippingFee = firstNumberOrRange(infoValue(/배\\s*송\\s*비/))
  const labeledRetailPrice = firstNumber(infoValue(/소비자가|시중가|오픈마켓|정상\\s*판매\\s*가|정상가/))

  // 라벨로 명시된 소비자가/정상판매가는 ld+json이 이미 값을 채워놨어도 항상 우선한다 — 사람이 페이지에
  // 직접 적어둔 라벨이 구조화 메타데이터(할인 중인 실제 판매가 등 다른 값을 가리킬 수 있음)보다 확실하다.
  if (labeledRetailPrice != null) price = labeledRetailPrice
  // 이 시스템이 스크랩하는 몰은 대부분 거래처가 사입하는 도매/공급 전용몰이다 — "소비자가/시중가/
  // 오픈마켓"이라고 명시적으로 라벨링된 값이 없다면, 화면의 다른 "price" 클래스 요소도 공급가(거래처
  // 매입가)로 봐야 한다. 오픈마켓 노출가(소비자판가)는 이후 가격이익관리 단계에서 정하는 값이다.
  if (price == null && costPrice == null) {
    const priceEls = Array.from(document.querySelectorAll('[class*="price" i], [id*="price" i]'))
    for (const el of priceEls) {
      const m = (el.textContent || '').match(/([\\d,]{3,})\\s*원/)
      if (!m) continue
      costPrice = Number(m[1].replace(/,/g, ''))
      break
    }
  }

  let categoryFromDetail = ''
  let brandFromCategoryDetail = ''
  for (const sel of ['.xans-product-headcategory', 'nav[aria-label*="breadcrumb" i]', '.breadcrumb', '.location']) {
    for (const el of Array.from(document.querySelectorAll(sel))) {
      const liItems2 = Array.from(el.querySelectorAll('li'))
        .map(li => (li.textContent || '').replace(/^[\s/]+|[\s/]+$/g, '').trim())
        .filter(Boolean)
      if (!liItems2.length) {
        const text = (el.textContent || '').split('/').map(s => s.trim()).filter(Boolean).join(' > ')
        if (text) { categoryFromDetail = text; break }
        continue
      }
      // "브랜드"라는 카테고리 노드 바로 아래는 상품 종류 구분이 아니라 실제 브랜드명이다(예: 브랜드 > 나이키).
      const brandIdx2 = liItems2.findIndex(t => t === '브랜드')
      if (brandIdx2 !== -1 && brandIdx2 + 1 < liItems2.length) {
        categoryFromDetail = liItems2.slice(0, brandIdx2).join(' > ')
        brandFromCategoryDetail = liItems2[brandIdx2 + 1]
      } else {
        categoryFromDetail = liItems2.join(' > ')
      }
      break
    }
    if (categoryFromDetail || brandFromCategoryDetail) break
  }

  // 브레드크럼이 아예 없는 구형몰(신우 등)은 상세페이지 자체의 카테고리 표시 영역에서 상위 카테고리명을
  // 가져오고, 그 하위 목록 중 지금 이 상품의 URL과 카테고리코드(cat_code)가 정확히 일치하는 링크가
  // 있으면 그 텍스트를 하위 카테고리로 붙인다. 이름 자체에 "/"가 들어있는 경우가 있어(예: "뷰티＆샵
  // /노을,누리,아름") 위 로직처럼 계층 구분자로 잘못 쪼개지 않도록 통째로 쓴다.
  if (!categoryFromDetail) {
    const parentName = (document.querySelector('.productCategory .state h3')?.textContent || '').trim()
    if (parentName) {
      let subName = ''
      try {
        const myCode = new URL(location.href).searchParams.get('cat_code')
        if (myCode) {
          const subLink = Array.from(document.querySelectorAll('.productCategory .detailCate a[href*="cat_code="]'))
            .find(a => new URL(a.getAttribute('href') || '', location.href).searchParams.get('cat_code') === myCode)
          subName = (subLink?.textContent || '').trim()
        }
      } catch {}
      categoryFromDetail = subName ? (parentName + ' > ' + subName) : parentName
    }
  }

  const detailContainer = document.querySelector('#prdDetail') || document.querySelector('.detail_con')
  const detailImages = Array.from(detailContainer?.querySelectorAll('img') || [])
    .map(img => img.src).filter(src => src && !mainImages.includes(src) && !src.includes('/upload/appfiles/'))

  // 신우는 상품 상세페이지 안에 "추가 구성 상품(연관 상품)"이라는, 완전히 다른 상품의 미니 주문폼을
  // 그대로 끼워 넣는다(자기 코드/사이즈/색상 select까지 별도로 있음) — 이 블록은 항상 .item_option_2에,
  // 지금 보고 있는 실제 상품의 옵션은 항상 .item_option에 들어있다. 컨테이너 없이 전체 문서에서 select를
  // 찾으면 연관 상품의 옵션까지 섞여 들어와(옵션이 size/size_0처럼 중복되고 조합도 엉뚱하게 섞인다).
  const optionRoot = document.querySelector('.item_option') || document
  const selectEls = Array.from(optionRoot.querySelectorAll('select'))
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
  // 옵션1 값마다 옵션2 목록이 실제로 다른 몰(신우 등 — 색상별 구매 가능한 사이즈가 다름)을 위해, 합쳐진
  // options와 별개로 [옵션1값, 옵션2값] 쌍을 그대로 남긴다 — collected(Set)로 합치면 어느 옵션1에 어느
  // 옵션2가 실제로 딸려 나오는지 사라진다.
  let optionCombinations = []
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
      afterValues.forEach(v => optionCombinations.push([val, v]))
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

  // 캐스케이드(옵션1→옵션2 AJAX) 재고 판정이 가능하면 그게 최우선이다 — 신우처럼 "선택(1),(2)에 옵션이
  // 없으면 품절"이라는 안내 문구 자체가 모든 상품 페이지에 고정으로 박혀있는 몰이 있어(실제 발견된 사례:
  // "상세정보에는 있으나 선택(1), (2)에 사이즈,색상 등이 선택이 되지 않는 것은 품절입니다."라는 일반
  // 안내문이 매 상품마다 "품절" 텍스트로 잡혀 실제 재고와 무관하게 전부 품절로 오판정됐다), 페이지 전체
  // 텍스트에서 "품절"을 찾는 방식은 이런 안내문과 실제 재고 배지를 구분 못 한다.
  const stockText = document.body.innerText.match(/품절|일시품절|재입고|단종/)?.[0] || ''
  let stockStatus = '판매중'
  if (cascadeStockKnown) stockStatus = cascadeHasStock ? '판매중' : '품절'
  else if (/품절/.test(stockText)) stockStatus = '품절'
  else if (/단종/.test(stockText)) stockStatus = '단종'

  const u = new URL(location.href)
  const pathMatch = location.pathname.match(/\\/product\\/[^/]+\\/(\\d+)\\/category\\//)
  const code = pathMatch?.[1] || u.searchParams.get('product_no') || u.searchParams.get('branduid') || u.searchParams.get('goodsno') || u.searchParams.get('brandcode') || location.href

  const result = {
    name, price, sale_price: price, cost_price: costPrice, shipping_fee: shippingFee,
    // "브랜드" 카테고리 노드에서 뽑은 값이 가장 확실하다 — ld+json의 brand는 상품별 브랜드를 안 채운
    // 몰이 자기 몰 이름을 기본값으로 넣어두는 경우가 흔해 그보다 우선한다.
    brand: brandFromCategoryDetail || brand, manufacturer: '', origin: '', category: categoryFromDetail || '', description,
    options, option_combinations: optionCombinations, thumbnail_urls: mainImages, thumbnail_names: [], detail_image_urls: detailImages, detail_image_names: [],
    detail_text: (detailContainer?.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 3000),
    summary_info: '', english_name: '', extra_info: [], stock_status: stockStatus, stock_qty: null,
    stock_by_option: [], mall_product_code: code, custom_fields: {},
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
    } else {
      result.custom_fields[field] = trimmed
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

// 추출이 실패한 상품도 PTP에 알려야, 진행상황 화면의 "수집 실패" 목록과 "실패만 재시도"가 개발자모드에서도
// 동작한다 — 예전에는 콘솔에만 찍고 끝나서 PTP는 어떤 상품이 왜 실패했는지 전혀 알 방법이 없었다.
async function reportFailure(url, errorMessage) {
  const res = await fetch(INGEST_ENDPOINT, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ siteId, sessionId, url, error: String(errorMessage || '알 수 없는 오류').slice(0, 500) }),
  })
  const data = await res.json().catch(() => ({}))
  if (data.sessionId) sessionId = data.sessionId
}

async function reportDone(stopped) {
  if (!sessionId) return
  await fetch(INGEST_ENDPOINT, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ siteId, sessionId, done: true, stopped: !!stopped }),
  }).catch(() => {})
}

async function run(tabId, startUrl) {
  running = true
  let processed = 0
  let stoppedByUser = false
  try {
    outer:
    while (processed < MAX_PRODUCTS) {
      const { links, nextUrl, category, brandFromCategory } = await evalInTab(tabId, COLLECT_LINKS_EXPR)
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
        // PTP의 "스크래핑 중지" 버튼이 눌렸는지 상품마다 확인한다 — 다음 상품으로 넘어가기 전에 반영된다.
        if (await checkStopRequested(sessionId)) {
          console.log('[PTP] 중지 요청을 확인해 스크래핑을 멈춥니다.')
          stoppedByUser = true
          break outer
        }
        await navigate(tabId, link)
        try {
          const product = await evalInTab(tabId, buildExtractExpr(extractionRules))
          // 카테고리는 상품 상세페이지가 아니라 방금 있던 목록(카테고리) 페이지에서만 알 수 있으므로,
          // 상세페이지 추출 결과 위에 덮어씌운다.
          if (category) product.category = category
          if (brandFromCategory) product.brand = brandFromCategory
          const result = await report(link, product)
          console.log(`[PTP] ${processed + 1}/${links.length} 저장:`, product.name, result)
        } catch (e) {
          console.log('[PTP] 추출 실패:', link, e.message)
          await reportFailure(link, e.message).catch(() => {})
        }
        processed++
        await throttle()
      }

      if (!nextUrl) break
      await navigate(tabId, nextUrl)
      await throttle()
    }
    console.log(stoppedByUser ? `[PTP] 중지됨 — 총 ${processed}개 처리` : `[PTP] 완료 — 총 ${processed}개 처리`)
  } finally {
    await reportDone(stoppedByUser)
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
// 이 몰의 아무 페이지에서나(로그인된 상태) 이 우클릭 메뉴를 실행하면, 확장이 PTP에 "지금 테스트해야 할
// 상품 페이지가 어디냐"고 물어본 뒤 그 URL로 직접 이동해 캡처한다 — 정확한 상품 페이지를 사용자가 직접
// 찾아 들어갈 필요가 없다(일반모드가 그리드 맨 위 1건을 자동으로 테스트하는 것과 같은 원칙).
// 백엔드가 이 몰의 페이지를 스스로 못 열어보는 게 개발자모드의 정의라, 이 캡처가 유일한 통로다.
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: 'ptp-adjust', title: 'PTP 조정 테스트 실행', contexts: ['page'] }, () => void chrome.runtime.lastError)
  chrome.contextMenus.create({ id: 'ptp-retry-failed', title: 'PTP 실패 상품 재수집', contexts: ['page'] }, () => void chrome.runtime.lastError)
})

// "실패 상품만 재수집" — 일반모드의 "실패 재시도" 버튼과 같은 목적이지만, 개발자모드는 PTP 백엔드가
// 스스로 재시도를 못 돌리므로 이 몰의 아무 페이지에서 우클릭하면 실행되는 형태로 만들었다. 실패했다가
// 그 뒤로 한 번도 성공 못 한 URL만(PTP가 계산) 새 세션으로 다시 방문한다 — 이미 성공한 상품은 다시
// 스크랩하지 않는다.
async function retryFailed(tab) {
  const hostname = new URL(tab.url).hostname
  const site = await resolveSite(hostname).catch(() => null)
  if (!site) {
    console.log(`[PTP] "${hostname}"은 PTP Mall 관리에 "크롬익스텐션-개발자모드"로 등록돼 있지 않습니다.`)
    return
  }
  const data = await fetch(`${FAILED_URLS_ENDPOINT}?siteId=${site.id}`).then(r => r.json()).catch(() => null)
  const urls = data?.urls || []
  if (!urls.length) {
    console.log('[PTP] 재수집할 실패 상품이 없습니다.')
    return
  }
  console.log(`[PTP] 실패 상품 재수집 시작 — ${urls.length}개`)

  siteId = site.id
  extractionRules = site.extractionRules
  sessionId = null // 재시도는 새 세션으로 기록한다 — 예전 실패 기록과 섞이지 않도록.

  try {
    await chrome.debugger.attach({ tabId: tab.id }, '1.3')
  } catch (e) {
    console.log('[PTP] 재수집 실패(디버거 연결 안 됨):', e.message)
    return
  }
  try {
    let processed = 0
    for (const url of urls) {
      if (await checkStopRequested(sessionId)) {
        console.log('[PTP] 중지 요청을 확인해 재수집을 멈춥니다.')
        break
      }
      await navigate(tab.id, url)
      try {
        const product = await evalInTab(tab.id, buildExtractExpr(extractionRules))
        const result = await report(url, product)
        console.log(`[PTP] 재수집 ${++processed}/${urls.length} 저장:`, product.name, result)
      } catch (e) {
        console.log('[PTP] 재수집 실패:', url, e.message)
        await reportFailure(url, e.message).catch(() => {})
      }
      await throttle()
    }
    console.log(`[PTP] 실패 상품 재수집 완료 — 총 ${urls.length}개 시도`)
  } finally {
    await reportDone()
    await navigate(tab.id, tab.url).catch(() => {})
    await chrome.debugger.detach({ tabId: tab.id }).catch(() => {})
  }
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'ptp-retry-failed') {
    if (tab?.id && tab.url) await retryFailed(tab)
    return
  }
  if (info.menuItemId !== 'ptp-adjust' || !tab?.id || !tab.url) return
  const hostname = new URL(tab.url).hostname
  const site = await resolveSite(hostname).catch(() => null)
  if (!site) {
    console.log(`[PTP] "${hostname}"은 PTP Mall 관리에 "크롬익스텐션-개발자모드"로 등록돼 있지 않습니다.`)
    return
  }

  const target = await fetch(`${ADJUST_CAPTURE_ENDPOINT_BASE}/${site.id}/adjust/target`).then(r => r.json()).catch(() => null)
  if (!target?.prompt) {
    console.log('[PTP] 먼저 PTP 스크랩 조정 화면에서 프롬프트를 입력하고 "스크랩 조정 개시"를 눌러주세요.')
    return
  }
  if (!target.testUrl) {
    console.log('[PTP] 테스트할 미확정 상품이 없습니다 — 이 몰을 먼저 한 번 스크랩해주세요.')
    return
  }

  try {
    await chrome.debugger.attach({ tabId: tab.id }, '1.3')
  } catch (e) {
    console.log('[PTP] 조정 테스트 실패(디버거 연결 안 됨):', e.message)
    return
  }
  try {
    await navigate(tab.id, target.testUrl)
    const html = await evalInTab(tab.id, '(() => document.documentElement.outerHTML.slice(0, 200000))()')
    const res = await fetch(`${ADJUST_CAPTURE_ENDPOINT_BASE}/${site.id}/adjust/capture`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: target.testUrl, html }),
    })
    const data = await res.json()
    if (!res.ok) console.log('[PTP] 조정 테스트 실패:', data.error || res.status)
    else console.log('[PTP] 조정 테스트 완료 — 갱신된 규칙:', data.rules, '(PTP로 돌아가 "개발자모드 재기동"을 눌러 확인하세요)')
    await navigate(tab.id, tab.url).catch(() => {}) // 원래 있던 페이지로 되돌려놓는다
  } catch (e) {
    console.log('[PTP] 조정 테스트 중 오류:', e.message)
  } finally {
    await chrome.debugger.detach({ tabId: tab.id }).catch(() => {})
  }
})
