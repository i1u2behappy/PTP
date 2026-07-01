import path from 'path'
import { chromium, type BrowserContext, type Page } from 'playwright'
import { extractProductFromHtml, type ExtractedProduct } from './ai'

export interface ScrapeOptions {
  /** 시작 URL. 생략하면 로그인 창에서 현재 열려있는 페이지를 그대로 사용 */
  url?: string
  /** 카테고리별로 각각 스크랩할 목록 페이지 URL들 (지정하면 url 대신 이 목록을 순회) */
  categoryUrls?: string[]
  /** 페이지네이션: 다음 페이지로 넘어가는 버튼/링크 셀렉터 */
  nextPageSelector?: string
  /** 목록 페이지당 최대 페이지 수 (기본 1 = 페이지네이션 없음) */
  maxPages?: number
  /** 이미 스크랩된 상품 URL — 목록에서 발견해도 건너뛴다 */
  excludeUrls?: string[]
  loginId?: string
  loginPw?: string
  loginIdSelector?: string    // 기본: input[type=email], input[name*=id], input[name*=email]
  loginPwSelector?: string    // 기본: input[type=password]
  loginBtnSelector?: string   // 기본: button[type=submit]
  /** 카탈로그 페이지인 경우 제품 링크 셀렉터 (없으면 단일 상품 페이지로 간주) */
  productLinkSelector?: string
  /** 등록된 쇼핑몰 ID — 지정하면 해당 사이트 전용 로그인 세션(프로필)을 재사용 */
  siteId?: number
  /** 스크랩 세션 ID — 중지 요청 확인용 */
  sessionId?: number
}

function profileDir(siteId: number) {
  return path.join(process.cwd(), '.playwright-profiles', String(siteId))
}

// ponytail: 로컬 단일 사용자 도구 기준의 인메모리 상태. 여러 사용자가 동시에 쓰면 충돌.
const openSessions = new Map<number, BrowserContext>()
const stopRequests  = new Set<number>()

/** 실행 중인 스크래핑 세션에 중지를 요청한다 (다음 상품 처리 전에 반영됨) */
export function requestStop(sessionId: number) {
  stopRequests.add(sessionId)
}

function isStopRequested(sessionId?: number) {
  return sessionId !== undefined && stopRequests.has(sessionId)
}

/** 사용자가 직접 로그인을 확인할 수 있도록 화면에 보이는 브라우저 창을 연다 */
export async function openLoginWindow(siteId: number, opts: { url: string; loginId?: string; loginPw?: string }) {
  await closeLoginWindow(siteId)
  const context = await chromium.launchPersistentContext(profileDir(siteId), {
    headless: false,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  })
  openSessions.set(siteId, context)
  // 사용자가 창을 직접 닫거나 브라우저가 죽었을 때도 반영되도록 추적
  context.on('close', () => {
    if (openSessions.get(siteId) === context) openSessions.delete(siteId)
  })
  const page = context.pages()[0] || await context.newPage()
  await page.goto(opts.url, { waitUntil: 'networkidle', timeout: 30_000 }).catch(() => {})
  await loginIfNeeded(page, { url: opts.url, loginId: opts.loginId, loginPw: opts.loginPw })
}

/** 현재 로그인 창에서 사용자가 보고 있는 페이지 URL (없으면 null) */
export function getOpenPageUrl(siteId: number): string | null {
  const context = openSessions.get(siteId)
  if (!context) return null
  const pages = context.pages()
  return pages.length ? pages[pages.length - 1].url() : null
}

/** 사용자가 명시적으로 닫을 때만 호출 — 로그인 확인 시에는 창을 닫지 않는다 */
export async function closeLoginWindow(siteId: number) {
  const context = openSessions.get(siteId)
  if (context) {
    await context.close().catch(() => {})
    openSessions.delete(siteId)
  }
}

async function withContext<T>(opts: ScrapeOptions, fn: (page: Page) => Promise<T>): Promise<T> {
  const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'

  if (opts.siteId) {
    const openContext = openSessions.get(opts.siteId)
    if (openContext) {
      // 로그인 창이 열려있으면 그대로 재사용 (닫지 않음)
      const pages = openContext.pages()
      const page = pages.length ? pages[pages.length - 1] : await openContext.newPage()
      return await fn(page)
    }
    const context = await chromium.launchPersistentContext(profileDir(opts.siteId), { headless: true, userAgent })
    try {
      const page = context.pages()[0] || await context.newPage()
      return await fn(page)
    } finally {
      await context.close()
    }
  }

  const browser = await chromium.launch({ headless: true })
  try {
    const ctx  = await browser.newContext({ userAgent })
    const page = await ctx.newPage()
    return await fn(page)
  } finally {
    await browser.close()
  }
}

export interface ScrapeResult {
  sourceUrl: string
  product: ExtractedProduct
}

async function loginIfNeeded(page: import('playwright').Page, opts: { url: string; loginId?: string; loginPw?: string; loginIdSelector?: string; loginPwSelector?: string; loginBtnSelector?: string }) {
  if (!opts.loginId || !opts.loginPw) return

  const idSel  = opts.loginIdSelector  || 'input[type="email"], input[name*="id"], input[name*="email"], input[name*="user"]'
  const pwSel  = opts.loginPwSelector  || 'input[type="password"]'
  const btnSel = opts.loginBtnSelector || 'button[type="submit"], input[type="submit"]'

  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {})
  const idEl = page.locator(idSel).first()
  if (await idEl.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await idEl.fill(opts.loginId)
    await page.locator(pwSel).first().fill(opts.loginPw)
    await page.locator(btnSel).first().click()
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {})
  }
}

/** 단일 상품 페이지 스크랩 (url 생략 시 현재 열려있는 페이지를 그대로 사용) */
export async function scrapeSingleProduct(opts: ScrapeOptions): Promise<ScrapeResult> {
  return withContext(opts, async page => {
    if (opts.url) {
      await page.goto(opts.url, { waitUntil: 'networkidle', timeout: 30_000 })
      await loginIfNeeded(page, { url: opts.url, ...opts })
      if (opts.loginId) {
        await page.goto(opts.url, { waitUntil: 'networkidle', timeout: 30_000 })
      }
    }
    const html = await page.content()
    const sourceUrl = opts.url || page.url()
    const product = await extractProductFromHtml(html, sourceUrl)
    return { sourceUrl, product }
  })
}

export interface CatalogItemEvent {
  done: number
  total: number
  result: ScrapeResult | null
}

export interface CatalogScrapeSummary {
  total: number
  saved: number
  stopped: boolean
}

/** 목록 페이지(들)에서 제품 URL 수집 후 각각 스크랩. 카테고리 여러 개 + 페이지네이션 + 중지 + 이미 스크랩한 상품 제외 지원 */
export async function scrapeCatalogPage(
  opts: ScrapeOptions,
  onItem: (event: CatalogItemEvent) => Promise<void> | void,
): Promise<CatalogScrapeSummary> {
  return withContext(opts, async page => {
    const listingUrls = opts.categoryUrls?.length ? opts.categoryUrls : (opts.url ? [opts.url] : [page.url()])
    const maxPages = Math.max(1, opts.maxPages || 1)
    const linkSel = opts.productLinkSelector || 'a'
    // 셀렉터를 지정하지 않으면 화면 내 모든 링크가 아니라, 썸네일 이미지를 감싼 링크(=제품 카드)만 제품으로 간주
    const autoDetect = !opts.productLinkSelector

    if (opts.url || opts.categoryUrls?.length) {
      await page.goto(listingUrls[0], { waitUntil: 'networkidle', timeout: 30_000 })
      await loginIfNeeded(page, { url: listingUrls[0], ...opts })
    }

    const baseUrl = new URL(listingUrls[0]).origin
    const productUrlSet = new Set<string>()

    for (const listingUrl of listingUrls) {
      if (page.url() !== listingUrl) {
        await page.goto(listingUrl, { waitUntil: 'networkidle', timeout: 30_000 }).catch(() => {})
      }

      for (let p = 0; p < maxPages; p++) {
        const hrefs: string[] = await page.evaluate(({ sel, autoDetect }) => {
          return Array.from(document.querySelectorAll(sel))
            .filter(a => !autoDetect || a.querySelector('img'))
            .map(a => (a as HTMLAnchorElement).href)
            .filter(h => h && h.startsWith('http'))
        }, { sel: linkSel, autoDetect })
        hrefs.filter(h => h.startsWith(baseUrl)).forEach(h => productUrlSet.add(h))

        if (p >= maxPages - 1 || !opts.nextPageSelector) break
        const nextBtn = page.locator(opts.nextPageSelector).first()
        if (!(await nextBtn.isVisible({ timeout: 3_000 }).catch(() => false))) break
        await nextBtn.click()
        await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {})
      }
    }

    // 목록 페이지 자체와 이미 스크랩된 상품은 제외
    const listingSet = new Set(listingUrls)
    const excludeSet  = new Set(opts.excludeUrls || [])
    const productUrls = [...productUrlSet].filter(h => !listingSet.has(h) && !excludeSet.has(h))

    let saved = 0
    let stopped = false
    let lastError: unknown = null

    for (let i = 0; i < productUrls.length; i++) {
      if (isStopRequested(opts.sessionId)) { stopped = true; break }

      const pUrl = productUrls[i]
      let result: ScrapeResult | null = null
      try {
        await page.goto(pUrl, { waitUntil: 'networkidle', timeout: 30_000 })
        const html = await page.content()
        const product = await extractProductFromHtml(html, pUrl)
        result = { sourceUrl: pUrl, product }
        saved++
      } catch (err) {
        lastError = err
      }
      await onItem({ done: i + 1, total: productUrls.length, result })
    }

    if (opts.sessionId !== undefined) stopRequests.delete(opts.sessionId)

    if (!stopped && saved === 0 && productUrls.length > 0) {
      const reason = lastError instanceof Error ? lastError.message : String(lastError)
      throw new Error(`상품 링크 ${productUrls.length}개를 찾았지만 모두 추출에 실패했습니다: ${reason}`)
    }

    return { total: productUrls.length, saved, stopped }
  })
}
