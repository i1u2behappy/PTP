import type { Page } from 'playwright'
import type { ExtractedProduct, ExtractionRule } from './ai'

interface RawPageData {
  name: string
  price: number | null
  costPrice: number | null
  shippingFee: number | string | null
  categoryFromDetail: string
  /** 상세페이지 브레드크럼에 "브랜드" 카테고리 노드가 있어(예: 브랜드 > 나이키) 그 아래 항목을 브랜드로 뽑아낸 값 */
  brandFromCategoryDetail: string
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
  /** "한 묶음(8개)", "한 박스(40개)"처럼 도매몰이 묶음/박스 단위로 주문 수량을 정하는 버튼 텍스트를
   *  쉼표로 이어붙인 것(예: 펫투비) — 없는 몰은 빈 문자열. */
  orderUnit: string
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

    // 일부 몰은 상품명을 표준 위치(ld+json/og:title)에 안 두고, 장바구니 제출용 hidden input에만
    // 실제 상품명을 담아둔다(예: 신우) — document.title(사이트 공통 타이틀)보다 우선한다.
    // 고도몰(펫투비 등)은 og:title/ld+json이 아예 없는 스킨이 있어(실제 페이지로 확인), 그런 경우
    // document.title(사이트 전체에 공통인 "OO 도매 플랫폼" 같은 문구)로 잘못 빠지는 문제가 실제 발견됨 —
    // .info_name(상품 폼 안의 실제 상품명 div)을 document.title보다 먼저 시도한다.
    // 본문에서 "상품명처럼 이름 붙은" 요소를 찾는다 — og:title보다 먼저 본다.
    // 이유: og:title/<title>을 **사이트 공통 문구**로 두는 몰이 있다(투비즈온 실사용 확인, 2026-09-13:
    // 상품 상세페이지인데도 둘 다 "투비즈온(코워크몰) - 도매 B2B 배송대행"이라, 미리보기 상품명이
    // 몰 이름으로 나왔다). 정작 본문에는 `<h3 class="product-name">여성 오버핏 …</h3>`처럼 아주 표준적인
    // 마크업이 있었다 — 메타태그를 먼저 믿는 순서 자체가 문제였다.
    const nameFromBody = (): string => {
      const direct = document.querySelector<HTMLElement>(
        '[class*="product-name" i],[class*="product_name" i],[class*="goods-name" i],[class*="goods_name" i],'
        + '[class*="item-name" i],[class*="item_name" i],[class*="prd-name" i],[class*="prd_name" i],'
        + '[id*="goodsnm" i],[id*="goodsname" i],.info_name',
      )
      if (direct?.textContent?.trim()) return direct.textContent.trim()
      for (const h of Array.from(document.querySelectorAll<HTMLElement>('h1,h2,h3'))) {
        const key = `${h.className} ${h.id}`.toLowerCase()
        const looksLikeName = /(product|goods|item|prd)[^a-z]*(name|title|subject)|(name|title|subject)[^a-z]*(product|goods|item|prd)/.test(key)
        if (looksLikeName && h.textContent?.trim()) return h.textContent.trim()
      }
      return ''
    }
    if (!name) {
      const ogTitle = ogContent('og:title').trim()
      // og:title이 문서 타이틀과 똑같으면 그건 사이트 공통 문구지 상품명이 아니다.
      const ogTitleUsable = !!ogTitle && ogTitle !== document.title.trim()
      name = nameFromBody() || (ogTitleUsable ? ogTitle : '')
        || document.querySelector<HTMLInputElement>('input[name="brandname"]')?.value
        || document.title || ''
    }
    if (!mainImages.length) {
      // 대표이미지가 여러 장인 갤러리형 UI(예: 신우의 .img_small 썸네일 목록)를 먼저 시도한다.
      const galleryImgs = Array.from(document.querySelectorAll<HTMLImageElement>('.img_small .small img')).map(img => img.src).filter(Boolean)
      if (galleryImgs.length) mainImages = galleryImgs
      else {
        // 고도몰(펫투비 등)은 .view_img 안 .imgs 썸네일 목록이 실제 갤러리다(옵션이 없어도 여러 장일
        // 수 있음 — 실제 페이지로 확인). src의 "?rsz=50"은 표시용 리사이즈 파라미터일 뿐이라 떼어내면
        // #objImg가 쓰는 것과 같은 원본 크기 이미지 URL이 된다.
        const godoGalleryImgs = [...new Set(
          Array.from(document.querySelectorAll<HTMLImageElement>('.view_img .imgs')).map(img => img.src.replace(/\?rsz=\d+$/, '')).filter(Boolean),
        )]
        if (godoGalleryImgs.length) mainImages = godoGalleryImgs
        else {
          // 갤러리가 없으면 큰 대표이미지 하나(#bigimage 신우, #objImg/.img_big 고도몰)만이라도 쓴다.
          const bigImg = document.querySelector<HTMLImageElement>('#bigimage, #objImg, .img_big img')
          if (bigImg?.src) mainImages = [bigImg.src]
        }
      }
    }
    if (!mainImages.length) {
      // 위 몰별 셀렉터가 다 안 맞는 스킨 — 본문에서 "상품 이미지처럼 생긴" <img>를 크기 순으로 고른다.
      // 경로에 goods/product/item/upfile 같은 조각이 있고(상품 이미지 저장소), 로고/아이콘이 아니며,
      // 실제로 화면에서 큰 것만 인정한다.
      // 크기를 **조건으로 쓰지 않는다** — 아직 로딩 안 된 이미지는 naturalWidth가 0이라, 크기를 필수로
      // 걸면 "언제 실행됐는지"에 따라 결과가 달라진다(회귀 테스트가 이 불안정성을 바로 잡아냈다).
      // 경로 모양으로 상품 이미지를 고르고, 크기는 알 수 있을 때만 정렬에 쓴다(큰 것 우선).
      const sizeOf = (img: HTMLImageElement) => Math.max(img.naturalWidth || 0, img.width || 0)
      const productish = Array.from(document.querySelectorAll<HTMLImageElement>('img'))
        .filter(img => /\/(goods|product|item|upfile|prd)[\W_]/i.test(img.src) && !/logo|icon|btn|banner/i.test(img.src))
        .sort((a, b) => sizeOf(b) - sizeOf(a))
        .map(img => img.src)
      if (productish.length) mainImages = [...new Set(productish)].slice(0, 5)
    }
    if (!mainImages.length) {
      // og:image는 **마지막 수단**이다 — 상품 상세페이지인데도 이 값을 사이트 로고로 두는 몰이 있다
      // (투비즈온 실사용 확인, 2026-09-13: 미리보기 대표이미지가 로고(og_image.jpg)로 나왔다).
      const ogImg = ogContent('og:image')
      if (ogImg) mainImages = [ogImg]
    }

    // ld+json/og 이미지는 URL만 있고 alt 텍스트가 없으니, 페이지의 실제 <img> 태그에서 src 기준으로 alt를 찾아 붙인다.
    // 상세설명 에디터(Froala 등, 고도몰 계열에서 흔함)는 alt 대신 data-fileorinm에 업로드 당시 원본
    // 파일명(예: "벨버드 초대형.jpg")을 남겨두는 경우가 있어(실제 페이지로 확인) alt 다음으로 시도한다.
    // 둘 다 없는 이미지는 파일명(URL 마지막 경로, 보통 의미 없는 해시)을 이름으로 대신 쓴다.
    const imgAltBySrc = new Map<string, string>()
    document.querySelectorAll('img').forEach(img => {
      const alt = img.getAttribute('alt')?.trim() || img.getAttribute('data-fileorinm')?.trim()
      if (alt && img.src) imgAltBySrc.set(img.src, alt)
    })
    const nameForImage = (src: string) => {
      const alt = imgAltBySrc.get(src)
      if (alt) return alt
      try { return decodeURIComponent(new URL(src, location.href).pathname.split('/').pop() || '') } catch { return '' }
    }
    const mainImageNames = mainImages.map(nameForImage)

    // 배송비 dt/dd 안에 "지역별 추가배송비" 클릭 시 뜨는 숨겨진 팝업 레이어(도서산간 등 지역별 추가금액
    // 목록)가 같이 들어있는 경우가 있다(실제 페이지로 확인, 가방쟁이) — textContent는 display:none이어도
    // 그대로 다 이어붙여, 값이 그 지역 목록으로 오염된다(예: "3,500원 지역별배송비 전라남도... 7,000원...").
    // <script>/<style> 태그도 textContent에는 그 소스 코드가 그대로 문자열로 들어있다(브라우저가 렌더링만
    // 안 할 뿐 텍스트 노드로 취급) — 상세페이지 안에 탭 전환/팝업 열기 같은 JS가 박혀있으면(실제 확인,
    // 신우) 그 함수 코드 전체가 "상세페이지 텍스트"에 그대로 섞여 나온다. 읽기 전에 숨긴 조상/스크립트/
    // 스타일 태그를 걷어낸 사본에서 읽어 이런 오염을 제외한다.
    const cleanText = (el: Element) => {
      const clone = el.cloneNode(true) as Element
      clone.querySelectorAll('script, style, .layer_area, [style*="display:none" i], [style*="display: none" i]').forEach(n => n.remove())
      return (clone.textContent || '').trim()
    }

    // ld+json/og의 대표 이미지 갤러리(여러 장일 수 있음)와는 별개로, 상세설명 영역에 판매자가 직접
    // 올린 상품별 상세 이미지(사이즈/소재 등 텍스트로는 안 남는 구분 정보)를 모은다. 카페24는 #prdDetail을
    // 쓰고, 그게 없으면 다른 자체 제작 몰에서 흔한 .detail_con(예: 신우), .view_detail(예: 고도몰,
    // 펫투비 — 실제 페이지로 확인), .detail_cont/#detail(예: 고도몰 다른 스킨, 가방쟁이 — 실제 페이지로
    // 확인. 같은 페이지의 "관련상품" 탭과는 별개 컨테이너라 관련상품 이미지가 섞여 들어오지 않는다)을
    // 대신 시도한다.
    // /upload/appfiles/ 경로는 카페24 앱스토어 위젯이 심는 몰 공통 배너로, 상품마다 똑같이 끼어들어오므로 제외한다.
    const detailContainer = document.querySelector('#prdDetail') || document.querySelector('.detail_con')
      || document.querySelector('.view_detail') || document.querySelector('.detail_cont') || document.querySelector('#detail')
    const detailImageEls = Array.from(detailContainer?.querySelectorAll<HTMLImageElement>('img') || [])
      .filter(img => img.src && !mainImages.includes(img.src) && !img.src.includes('/upload/appfiles/'))
    const detailImages = detailImageEls.map(img => img.src)
    const detailImageNames = detailImageEls.map(img => nameForImage(img.src))

    // 상세페이지에 이미지가 아니라 텍스트로 직접 박혀 있는 설명 내용 (소재/사이즈 안내 등)
    const detailText = (detailContainer ? cleanText(detailContainer) : '').replace(/\s+/g, ' ').trim().slice(0, 3000)

    if (!description) {
      // 상세페이지 본문 텍스트를 먼저 쓴다 — og:description/meta description을 **사이트 공통 소개 문구**로
      // 두는 몰이 있어(투비즈온 실사용 확인, 2026-09-13: 모든 상품의 추가설명이 "도매,B2B,배송대행,
      // 도매쇼핑몰,온라인유통,판촉물,생활잡화,온라인창업" — 이건 메타 키워드지 상품 설명이 아니다),
      // 메타를 먼저 믿으면 모든 상품이 같은 설명을 갖게 된다. og:title/og:image와 같은 부류의 함정이다.
      const metaDesc = ogContent('og:description') || document.querySelector('meta[name="description"]')?.getAttribute('content') || ''
      const metaKeywords = document.querySelector('meta[name="keywords"]')?.getAttribute('content')?.trim() || ''
      // 메타 설명이 키워드 목록과 같거나(키워드를 그대로 description에 넣은 몰), 쉼표로만 나열된
      // 형태면 상품 설명으로 쓰지 않는다.
      const metaLooksLikeKeywords = !!metaDesc && (metaDesc.trim() === metaKeywords
        || (metaDesc.split(',').length >= 4 && !/[.!?]/.test(metaDesc)))
      description = detailText || (metaLooksLikeKeywords ? '' : metaDesc)
    }

    // document 전체에서 table/dl을 훑다 보면 이 상품과 무관한 표까지 섞여 들어간다 — 사이트 공통 영역
    // (header/footer/nav — 회사정보, 관련상품 배너 등)이나 완전히 숨겨진 조상 안의 표가 대표적이다
    // (cleanText는 셀 "안쪽"의 숨은 자손만 걷어내므로, 행/목록 자체가 숨은 조상 안에 있는 경우는 따로
    // 걸러야 한다). 상품마다 실제 정보제공고시 표 위치가 달라 특정 컨테이너로 좁히긴 어렵지만, 이 두
    // 경우는 어떤 몰이든 "이 상품 자체의 정보"가 아니라고 안전하게 판단할 수 있다.
    const isIrrelevantRegion = (el: Element) =>
      !!el.closest('header, footer, nav, [style*="display:none" i], [style*="display: none" i], [hidden]')

    // 국내 쇼핑몰은 전자상거래법상 "상품정보제공고시" 표를 의무 게시하므로, 라벨-값 쌍에서 부가 정보를 찾는다.
    // 카페24 등은 <table>(th/td)로, 신우 같은 구형 자체 솔루션은 <dl><dt>/<dd>로 같은 걸 표현하니 둘 다 본다.
    // 옵션(색상/사이즈 등) 선택 위젯을 <table><tr><th>/<td> 정렬로 배치하는 카페24 구형 테마가 있다
    // (시즌백 실사용 확인, 2026-09-27 — <select>의 <option> 목록 전체 텍스트("- [필수] 옵션을 선택해
    // 주세요 --------------------블랙그레이")가 "값"으로, 그 옵션 그룹 내부 이름(하필 상품 자체 스타일
    // 코드와 같아 "BG-7868" 등)이 "라벨"로 잡혀 custom_fields에 그대로 섞여 들어갔다 — 상품마다 라벨이
    // 전부 달라, 스크랩 Raw 확인 화면에 상품 수만큼 거의 빈 컬럼이 하나씩 생겨났다). <select>/<input>
    // 같은 상호작용 위젯이 든 행은 애초에 "상품정보제공고시" 정적 텍스트가 아니므로 통째로 제외한다 —
    // 이 구조를 쓰는 다른 몰에도 똑같이 적용되는 일반적인 신호다(특정 라벨/코드 패턴 추측이 아님).
    const looksLikeOptionWidget = (el: Element) => !!el.querySelector('select, input')
    const infoRows: [string, string][] = []
    document.querySelectorAll('table tr').forEach(tr => {
      if (isIrrelevantRegion(tr) || looksLikeOptionWidget(tr)) return
      const cells = Array.from(tr.querySelectorAll('th,td')).map(cleanText)
      if (cells.length === 2 && cells[0] && cells[1]) infoRows.push([cells[0], cells[1]])
    })
    document.querySelectorAll('dl').forEach(dl => {
      if (isIrrelevantRegion(dl)) return
      Array.from(dl.querySelectorAll('dt')).forEach(dt => {
        // 인덱스로 dt[i]/dd[i]를 짝짓지 않는다 — 중간에 짝 없는 dd가 끼면 그 뒤로 전부 밀린다.
        // 대신 각 dt에서 다음 dt를 만나기 전 첫 dd를 직접 찾는다.
        let sib = dt.nextElementSibling
        while (sib && sib.tagName !== 'DD' && sib.tagName !== 'DT') sib = sib.nextElementSibling
        if (sib && sib.tagName === 'DD' && !looksLikeOptionWidget(dt) && !looksLikeOptionWidget(sib)) {
          const label = cleanText(dt)
          const value = cleanText(sib)
          if (label && value) infoRows.push([label, value])
        }
      })
    })

    // 소비자가/도매가(공급가)/배송비를 라벨로 찾는다 — "회원공개"처럼 로그인 전에는 가려지는 값도 있어
    // 숫자가 실제로 있을 때만 채택한다. (page.evaluate 콜백은 브라우저에서 실행되므로 바깥의
    // findInfoValue 헬퍼를 못 쓴다 — 여기서 바로 같은 로직을 인라인으로 둔다.)
    const infoValue = (labelPattern: RegExp) => infoRows.find(([label]) => labelPattern.test(label))?.[1] || ''
    // "3,000 ~ 4,000원"처럼 범위로 적힌 값은 최저값을 쓴다(배송비가 흔히 이렇게 표기된다) — 범위 표기를
    // 못 가려내면 "원" 바로 앞 숫자(범위의 마지막 값)만 잡혀 최저값 대신 최고값이 들어가는 문제가 있었다
    // (실제 발견된 사례: 배송비 3,000~4,000원인데 4,000원이 저장됨).
    const firstNumber = (text: string): number | null => {
      const range = text.match(/([\d,]{2,})\s*~\s*[\d,]{2,}\s*(?=원)/)
      if (range) return Number(range[1].replace(/,/g, ''))
      const m = text.match(/[\d,]{2,}(?=\s*원)/)
      return m ? Number(m[0].replace(/,/g, '')) : null
    }
    // 배송비는 범위 자체가 실제 정보(무게/지역별 차등)라 Raw 데이터에는 원문 그대로 "3000~4000"으로
    // 남겨 사용자가 검수 화면에서 실제 페이지와 비교할 수 있게 한다 — product_master로 옮길 때만
    // (lib/master/migrate.ts) 계산 가능하도록 최저값 숫자로 바꾼다.
    const firstNumberOrRange = (text: string): number | string | null => {
      const range = text.match(/([\d,]{2,})\s*~\s*([\d,]{2,})\s*(?=원)/)
      if (range) return `${range[1].replace(/,/g, '')}~${range[2].replace(/,/g, '')}`
      return firstNumber(text)
    }
    let costPrice = firstNumber(infoValue(/도매가|공급가/))
    const shippingFee = firstNumberOrRange(infoValue(/배\s*송\s*비/))
    const labeledRetailPrice = firstNumber(infoValue(/소비자가|시중가|오픈마켓|정상\s*판매\s*가|정상가/))

    // 라벨로 명시된 소비자가/정상판매가는 ld+json이 이미 값을 채워놨어도 항상 우선한다 — 사람이 페이지에
    // 직접 적어둔 라벨이 구조화 메타데이터(할인 중인 실제 판매가 등 다른 값을 가리킬 수 있음)보다 확실하다.
    if (labeledRetailPrice != null) price = labeledRetailPrice
    // 이 시스템이 스크랩하는 몰은 대부분 거래처가 사입하는 도매/공급 전용몰이다 — 페이지에 "소비자가/
    // 시중가/오픈마켓"이라고 명시적으로 라벨링된 값이 없다면, 화면에 보이는 유일한 가격 표시나 숨은
    // 입력값은 사실 공급가(거래처가 매입하는 값)로 봐야 한다. 오픈마켓 노출가(소비자판가)는 스크랩
    // 시점에 알 수 있는 값이 아니라 이후 가격이익관리 단계에서 공급가에 마진을 붙여 정하는 값이다.
    if (price == null && costPrice == null) {
      // 가격 표시 요소(class/id에 price 포함)에서 "숫자,콤마 + 원" 패턴을 찾는다.
      const priceEls = Array.from(document.querySelectorAll('[class*="price" i], [id*="price" i]'))
      for (const el of priceEls) {
        const m = (el.textContent || '').match(/([\d,]{3,})\s*원/)
        if (!m) continue
        costPrice = Number(m[1].replace(/,/g, ''))
        break
      }
    }
    if (price == null && costPrice == null) {
      // 로그인 전에는 "회원공개" 같은 문구로 화면 표시만 가려두고, 장바구니 제출용 hidden input에는
      // 실제 가격이 그대로 남아있는 몰이 있다 — 로그인 여부와 무관하게 이 값을 폴백으로 쓴다.
      const priceInput = document.querySelector<HTMLInputElement>('input[name="price"], input#price')
      const v = priceInput ? Number(priceInput.value) : NaN
      if (Number.isFinite(v) && v > 0) costPrice = v
    }

    // 목록(카테고리) 페이지의 브레드크럼에서 카테고리를 못 찾은 경우(예: 상품 페이지를 단건으로 바로
    // 스크랩)를 대비해, 상세페이지 자체에도 같은 후보 셀렉터로 한 번 더 시도해둔다 — 실제 사용 여부는
    // 호출부(스크랩 오케스트레이션)가 목록 기반 카테고리 유무에 따라 결정한다.
    let categoryFromDetail = ''
    let brandFromCategoryDetail = ''

    // 고도몰의 또 다른 스킨(가방쟁이, 실제 페이지로 확인)은 브레드크럼 각 단계를 .location_select로 감싸,
    // 그 안에 "현재 선택된 이름"(.location_tit)과 그 옆 다른 카테고리로 바로 갈 수 있는 숨겨진 <ul> 드롭다운을
    // 같이 둔다. 아래 범용 로직처럼 <li>를 그대로 다 훑으면 그 드롭다운 대안 목록까지 섞여 카테고리가
    // 완전히 틀어지므로, 이 구조는 .location_tit만 콕 집어 먼저 처리한다.
    const locationTits = Array.from(document.querySelectorAll('.location_wrap .location_select > .location_tit'))
      .map(el => (el.textContent || '').trim()).filter(Boolean)
    if (locationTits.length) categoryFromDetail = locationTits.join(' > ')

    for (const sel of categoryFromDetail ? [] : ['.xans-product-headcategory', 'nav[aria-label*="breadcrumb" i]', '.breadcrumb', '.location']) {
      for (const el of Array.from(document.querySelectorAll(sel))) {
        // <li>로 계층이 명확히 나뉘어 있으면 그 경계를 그대로 쓴다 — "/" 기준으로 통째로 쪼개면
        // "SANDAL/MULE"처럼 카테고리명 자체에 "/"가 들어있는 경우까지 잘못 쪼개진다(실제 발견된 사례).
        // 각 <li> 자체가 "/ 라벨"처럼 구분자를 텍스트 안에 그대로 갖고 있는 몰도 있어(실제 발견된 사례)
        // 앞뒤의 "/"·공백은 벗겨낸다.
        // <li> 안에 **하위 카테고리 드롭다운 메뉴가 통째로 중첩**돼 있는 몰이 있다(투비즈온 실사용
        // 확인, 2026-09-13: 몰카테고리가 "Home > 패션의류/잡화/뷰티  여성의류  남성의류  언더웨어 …"로
        // 메뉴 전체가 들어왔다). li.textContent는 그 중첩 메뉴까지 다 긁으므로, 중첩된 목록/폼 요소를
        // 떼어낸 "그 항목 자신의 이름"만 읽는다. 그래도 비정상적으로 긴 항목은 메뉴 덩어리로 보고 버린다.
        const items = Array.from(el.querySelectorAll('li'))
          // 드롭다운 카테고리 메뉴가 브레드크럼과 **같은 컨테이너 안에 형제 <li>로** 들어있는 몰이 있다
          // (투비즈온 실사용 확인, 2026-09-13: 몰카테고리가 "Home > 패션의류/잡화/뷰티 > 여성의류 >
          // 남성의류 > 언더웨어 > …"로 메뉴 전체가 들어왔다). 그 메뉴는 평소 화면에 안 보이고(hover 시
          // 노출) 브레드크럼은 보이므로, **화면에 실제로 보이는 항목만** 쓰면 깔끔하게 갈린다.
          .filter(li => {
            const withCheck = li as HTMLElement & { checkVisibility?: () => boolean }
            return withCheck.checkVisibility ? withCheck.checkVisibility() : !!li.getClientRects().length
          })
          .map(li => {
            const clone = li.cloneNode(true) as HTMLElement
            clone.querySelectorAll('ul,ol,select,nav,table').forEach(n => n.remove())
            return (clone.textContent || '').replace(/\s+/g, ' ').replace(/^[\s/]+|[\s/]+$/g, '').trim()
          })
          .filter(t => t && t.length <= 40)
          // 브레드크럼이 <select> 드롭다운으로 된 몰은 아직 안 고른 단계가 "중분류 선택 / 소분류 선택"
          // 같은 플레이스홀더로 보인다(투비즈온 실사용 확인, 2026-09-13) — 카테고리 경로가 아니므로 뺀다.
          .filter(t => !/(선택(하세요)?|선택해\s*주세요)$/.test(t) && t !== '전체')
        if (!items.length) {
          const text = (el.textContent || '').split('/').map(s => s.trim()).filter(Boolean).join(' > ')
          if (text) { categoryFromDetail = text; break }
          continue
        }
        // "브랜드"라는 카테고리 노드 바로 아래는 상품 종류 구분이 아니라 실제 브랜드명이다(예: 브랜드 > 나이키).
        const brandIdx = items.findIndex(t => t === '브랜드')
        if (brandIdx !== -1 && brandIdx + 1 < items.length) {
          categoryFromDetail = items.slice(0, brandIdx).join(' > ')
          brandFromCategoryDetail = items[brandIdx + 1]
        } else {
          categoryFromDetail = items.join(' > ')
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
        } catch { /* URL 파싱 실패 시 상위 카테고리명만 사용 */ }
        categoryFromDetail = subName ? `${parentName} > ${subName}` : parentName
      }
    }

    // 품절/재입고/단종 배지 텍스트 및 재고수량 문구를 탐색 (ld+json availability/상품정보고시 표가 없는 사이트 대비).
    // display:none인 요소는 건너뛴다 — 사이트 전역 카테고리 드롭다운 메뉴가 흔히 "item_stock" 같은
    // class를 그대로 갖고 있어(항상 숨김 상태), 걸러내지 않으면 지금 상품과 무관한 다른 카테고리의
    // "품절" 문구를 이 상품 재고 상태로 잘못 집어온다(실제 발견된 사례).
    let stockText = ''
    let stockQtyText = ''
    const stockEls = Array.from(document.querySelectorAll(
      '[class*="soldout" i], [class*="sold-out" i], [class*="stock" i], [class*="status" i]',
    )).filter(el => (el as HTMLElement).offsetParent !== null)
    for (const el of stockEls) {
      const t = (el.textContent || '').trim()
      if (!stockText && /품절|재입고|단종|일시품절/.test(t)) stockText = t
      if (!stockQtyText && /재고\s*(?:수량)?\s*[:：]?\s*\d+\s*개?/.test(t)) stockQtyText = t
      if (stockText && stockQtyText) break
    }

    // 고도몰 도매몰(펫투비 등)은 "한 묶음(8개)"/"한 박스(40개)"처럼 버튼(.btn_set_ea)으로 주문 단위를
    // 고르게 한다(실제 페이지로 확인, data-ea-unit 속성에 개수가 숫자로도 들어있음). 옵션 select와는
    // 별개의 위젯이라 scanSelectOptions로는 안 잡힌다.
    const orderUnit = Array.from(document.querySelectorAll('.btn_set_ea'))
      .map(el => (el.textContent || '').replace(/\s+/g, ' ').trim())
      .filter(Boolean).join(', ')

    return {
      name, price, costPrice, shippingFee, categoryFromDetail, brandFromCategoryDetail,
      brand, description, mainImages, mainImageNames, detailImages, detailImageNames, detailText,
      infoRows, sku, availability, stockText, stockQtyText, orderUnit,
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
    // 알려진 파라미터 이름부터 — 없으면 "상품코드처럼 생긴" 파라미터를 이름 규칙으로 찾는다.
    // 이름을 하나씩 늘리는 방식은 몰이 늘어날 때마다 또 빠진다(투비즈온의 `goodscd`가 이 목록에 없어
    // 코드 칸에 URL 전체가 그대로 들어갔다, 2026-09-13 실사용 확인).
    for (const key of ['branduid', 'brandcode', 'goodsno', 'goods_no', 'goodscd', 'goods_cd', 'product_no', 'productNo', 'idx', 'no']) {
      const v = u.searchParams.get(key)
      if (v) return v
    }
    for (const [key, value] of u.searchParams) {
      if (!value) continue
      // goods/product/item/prd + no/cd/code/id/seq 조합이면 상품 식별자로 본다.
      if (/(goods|product|item|prd|gds)[_-]?(no|cd|code|id|idx|seq|num)$/i.test(key)) return value
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

/** 라벨(dt/dd, th/td) 또는 셀렉터 하나를 실제 값 텍스트로 풀어낸다 — 단일 규칙과 'multi' 규칙의 각
 *  조각이 공유하는 로직이라 하나로 뺐다. */
async function resolveLabelOrSelector(
  page: Page, infoRows: [string, string][], part: { type: 'label' | 'selector' | 'fixed'; value: string },
): Promise<string | null> {
  if (part.type === 'fixed') return part.value
  if (part.type === 'label') {
    try { return findInfoValue(infoRows, new RegExp(part.value)) || null } catch { return null }
  }
  // textContent를 그대로 읽으면 가방쟁이 배송비처럼 display:none 팝업(지역별 추가배송비 목록 등)이
  // 값에 섞여든다 — 라벨 방식(infoRows)이 이미 받는 cleanText 처리를 셀렉터 방식에도 동일하게 적용.
  // <select>는 예외 — "스크랩 대상 직접지정"에서 옵션1~3 같은 필드를 <select> 자체에 클릭 지정하면
  // (lib/scraper.ts의 selectOptionsDisplayText와 항상 같이 반영) 그 셀렉터가 여기 저장되는데, 그대로
  // textContent를 읽으면 안내문+모든 <option>이 구분자 없이 뭉쳐 나온다(도매신 실사용 확인, 2026-09-17) —
  // 실제 선택 가능한 옵션 값만 쉼표로 구분해 합친다(scanSelectOptions와 같은 규칙).
  return page.locator(part.value).first().evaluate((el: Element) => {
    if (el.tagName === 'SELECT') {
      return Array.from((el as HTMLSelectElement).options)
        .filter(o => o.value)
        .map(o => (o.textContent || '').trim())
        .filter(Boolean)
        .join(', ')
    }
    const clone = el.cloneNode(true) as Element
    clone.querySelectorAll('.layer_area, [style*="display:none" i], [style*="display: none" i]').forEach(n => n.remove())
    return (clone.textContent || '').trim()
  }, null, { timeout: 3_000 }).catch(() => null)
}

/**
 * AI 호출 없이 페이지의 구조화 데이터(schema.org, og 메타태그)와 상품정보고시 표를 읽어 상품 정보를 추출한다.
 * ld+json Product가 없는 사이트에서는 og 메타태그/가격 텍스트 패턴으로 대체하지만, brand/manufacturer/origin/category처럼
 * 표에 없으면 알아낼 방법이 없는 필드는 빈 값으로 남는다 — AI 추측 대신 정직하게 비워두는 쪽을 택했다.
 * overrides로 몰별 수동 CSS 셀렉터가 지정되면(Mall 상세관리에서 설정), 자동 추출 결과보다 우선한다.
 * extractionRules는 "스크랩 조정" 기능이 AI로 학습해 저장한 그 몰 전용 규칙(sites.extraction_rules)으로,
 * overrides보다도 나중에(더 우선순위 높게) 적용된다 — 사용자가 프롬프트로 직접 고친 규칙이 항상 이긴다.
 */
export async function extractProductRuleBased(
  page: Page, url: string, overrides?: ExtractSelectorOverrides, extractionRules?: Record<string, ExtractionRule>,
): Promise<ExtractedProduct> {
  // .location_wrap 브레드크럼(가방쟁이 등)은 페이지 로드 직후엔 비어있다가 JS로 뒤늦게 채워진다(실제
  // 페이지로 확인) — scrapePageData가 안의 categoryFromDetail을 읽기 전에 짧게 기다린다. 이 위젯이 없는
  // 몰은 즉시 통과해 지연이 없다.
  await page.waitForFunction(() => {
    const wrap = document.querySelector('.location_wrap')
    if (!wrap) return true
    return !!wrap.querySelector('.location_select > .location_tit')?.textContent?.trim()
  }, { timeout: 3_000 }).catch(() => {})

  const raw = await scrapePageData(page)

  const result: ExtractedProduct = {
    name: raw.name || url,
    price: raw.price,
    sale_price: raw.price,
    cost_price: raw.costPrice,
    shipping_fee: raw.shippingFee,
    // "브랜드" 카테고리 노드에서 뽑은 값이 가장 확실하다(예: 브랜드 > 나이키) — ld+json의 brand는 상품별
    // 브랜드를 안 채운 몰이 자기 몰 이름을 기본값으로 넣어두는 경우가 흔해 그보다 우선한다.
    brand: raw.brandFromCategoryDetail || raw.brand || findInfoValue(raw.infoRows, /브랜드/i),
    manufacturer: findInfoValue(raw.infoRows, /제조사|제조자/i),
    origin: findInfoValue(raw.infoRows, /원산지|제조국/i),
    // 목록 페이지 브레드크럼 기반 카테고리는 lib/scraper.ts 오케스트레이션이 나중에 덮어쓴다
    // (categoryByUrl이 있으면 그쪽 우선) — 여기 값은 그게 없을 때(단건 스크랩 등)의 폴백이다.
    category: raw.categoryFromDetail || '',
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
    custom_fields: {},
  }

  // 유통기한은 "상품정보제공고시" 표에 실려있으면 라벨이 어느 몰이든 거의 항상 "유통기한"/"소비기한"이라
  // brand/manufacturer처럼 몰별 규칙 없이도 일반화해 뽑을 수 있다. 없는 상품(식품이 아닌 경우 등)은 빈 값.
  const expiry = findInfoValue(raw.infoRows, /유통기한|소비기한/i)
  if (expiry) result.custom_fields['유통기한'] = expiry
  // 주문단위(묶음/박스 단위 구매 버튼)는 몰마다 마크업이 다를 수 있어 아직 고도몰(.btn_set_ea)만 지원.
  if (raw.orderUnit) result.custom_fields['주문단위'] = raw.orderUnit

  // "상품필수정보"(상품정보제공고시) 표에는 브랜드/제조사/원산지처럼 이미 전용 필드로 뽑아낸 라벨 외에도
  // 몰·카테고리마다 소재/색상/치수/무게 등 다른 라벨이 계속 나온다(실제 페이지로 확인 — 가방쟁이는 제품
  // 소재/색상/수입여부/종류/KC안전인증/가로세로높이/무게 등). 이런 나머지 라벨을 하나의 뭉친 extra_info로만
  // 두지 않고 라벨마다 별도 컬럼(custom_fields)으로도 정리해, 스크랩 Raw 확인 화면에서 바로 구분해 볼 수
  // 있게 한다(사용자 요청). 이미 전용 필드로 뽑은 라벨과, 몰마다 표기가 달라 site별 extraction_rules로
  // 처리하는 상품코드/가격/배송비류 라벨은 중복 노출을 피하기 위해 제외한다.
  const CLAIMED_INFO_LABEL_RE = /브랜드|제조사|제조자|원산지|제조국|상품요약정보|영문상품명|유통기한|소비기한|상품코드|정가|판매가|소비자가|시중가|정상가|공급가|도매가|배송비|택배비/i
  raw.infoRows.forEach(([label, value]) => {
    if (value && !CLAIMED_INFO_LABEL_RE.test(label)) result.custom_fields[label] = value
  })

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

  if (extractionRules) {
    for (const [field, rule] of Object.entries(extractionRules)) {
      // "스크랩 대상 직접지정"에서 ✕(삭제)를 누르면 규칙을 아예 없애는 대신 빈 고정값을 남겨둔다(lib/scraper.ts
      // 참고) — 사용자가 "이 필드는 값이 없어야 한다"고 명시적으로 확정한 것이므로, 위에서 이미 채워둔
      // 자동/휴리스틱 추출값을 여기서 강제로 지운다. 그냥 스킵(continue)하면 예전 값이 그대로 남아 미리보기에
      // 계속 나타나던 문제가 있었다(사용자 지적으로 추가, 2026-08).
      if (rule.type === 'fixed' && rule.value === '') {
        if (field === 'price') { result.price = null; result.sale_price = null }
        else if (field === 'cost_price') result.cost_price = null
        else if (field === 'shipping_fee') result.shipping_fee = null
        else if (field === 'stock_qty') result.stock_qty = null
        else if (field === 'thumbnail_urls') { result.thumbnail_urls = []; result.thumbnail_names = [] }
        else if (field === 'detail_image_urls') { result.detail_image_urls = []; result.detail_image_names = [] }
        else if (field === 'name' || field === 'brand' || field === 'manufacturer' || field === 'origin' || field === 'category'
          || field === 'stock_status' || field === 'english_name' || field === 'summary_info') {
          result[field] = ''
        } else {
          delete result.custom_fields[field]
        }
        continue
      }
      // 대표/상세이미지는 값 하나가 아니라 URL 배열이라 텍스트 기반 나머지 필드와 다르게 다룬다 —
      // 셀렉터는 갤러리 전체를 가리키는 컨테이너(예: ".thumb_area img")로 저장돼 있어 매칭되는 모든
      // img의 src를 모으고, 고정값은 쉼표/줄바꿈으로 구분한 URL 목록으로 취급한다.
      if (field === 'thumbnail_urls' || field === 'detail_image_urls') {
        let urls: string[] = []
        if (rule.type === 'fixed') {
          urls = rule.value.split(/[,\n]/).map(s => s.trim()).filter(Boolean)
        } else if (rule.type === 'multi') {
          // 이미지가 하나의 공통 컨테이너에 다 있지 않아 갤러리 셀렉터 하나로 전체를 못 잡을 때, "이미지
          // 추가"로 여러 번 누적한 조각들 — 각 조각이 매칭하는 img들의 src를 전부 모아 합친다(중복 제거).
          let parts: { type: 'label' | 'selector' | 'fixed'; value: string }[] = []
          try { parts = JSON.parse(rule.value) } catch { parts = [] }
          const collected: string[] = []
          for (const part of parts) {
            if (part.type === 'fixed') {
              collected.push(...part.value.split(/[,\n]/).map(s => s.trim()).filter(Boolean))
            } else {
              const partUrls = await page.locator(part.value).evaluateAll(
                (els: HTMLImageElement[]) => els.map(el => el.src).filter(Boolean),
              ).catch(() => [])
              collected.push(...partUrls)
            }
          }
          urls = [...new Set(collected)]
        } else {
          urls = await page.locator(rule.value).evaluateAll(
            (els: HTMLImageElement[]) => els.map(el => el.src).filter(Boolean),
          ).catch(() => [])
        }
        if (!urls.length) continue
        const names = urls.map(u => { try { return decodeURIComponent(u.split('/').pop() || '') } catch { return u } })
        if (field === 'thumbnail_urls') { result.thumbnail_urls = urls; result.thumbnail_names = names }
        else { result.detail_image_urls = urls; result.detail_image_names = names }
        continue
      }

      let text: string | null = null
      if (rule.type === 'fixed') {
        text = rule.value
      } else if (rule.type === 'multi') {
        // 한 컬럼 값이 페이지 여러 곳에 나뉘어 있는 경우(예: 브랜드+모델명 두 요소가 합쳐져 상품명이
        // 되는 몰) — 저장된 조각들을 순서대로 각각 풀어낸 뒤 공백으로 이어붙인다.
        let parts: { type: 'label' | 'selector' | 'fixed'; value: string }[] = []
        try { parts = JSON.parse(rule.value) } catch { parts = [] }
        const resolved: string[] = []
        for (const part of parts) {
          const t = await resolveLabelOrSelector(page, raw.infoRows, part)
          if (t) resolved.push(t)
        }
        text = resolved.length ? resolved.join(' ') : null
      } else {
        text = await resolveLabelOrSelector(page, raw.infoRows, rule as { type: 'label' | 'selector'; value: string })
      }
      const trimmed = text?.trim()
      if (!trimmed) continue

      if (field === 'price' || field === 'cost_price' || field === 'shipping_fee') {
        const m = trimmed.match(/[\d,]{2,}/)
        if (!m) continue
        const n = Number(m[0].replace(/,/g, ''))
        if (field === 'price') { result.price = n; result.sale_price = n }
        else if (field === 'cost_price') result.cost_price = n
        else result.shipping_fee = n
      } else if (field === 'stock_qty') {
        const m = trimmed.match(/[\d,]+/)
        if (m) result.stock_qty = Number(m[0].replace(/,/g, ''))
      } else if (field === 'name' || field === 'brand' || field === 'manufacturer' || field === 'origin' || field === 'category'
        || field === 'stock_status' || field === 'english_name' || field === 'summary_info') {
        result[field] = trimmed
      } else {
        // 8개 고정 필드 밖의 새 컬럼(사용자가 "스크랩 조정"으로 추가 요청한 것) — custom_fields에 담는다.
        result.custom_fields[field] = trimmed
      }
    }
  }

  return result
}
