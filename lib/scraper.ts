import path from 'path'
import { chromium, type BrowserContext, type Page } from 'playwright'
import type { ExtractedProduct } from './ai'
import { extractProductRuleBased } from './extract'
import { solveRecaptchaV2, solveHCaptcha, solveImageCaptcha } from './captcha'

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
  /** 상품 페이지 방문 사이 최소 지연(ms). 실제 지연은 이 값~2배 사이 랜덤 (차단 방지) */
  delayMs?: number
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

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** delayMs ~ 2*delayMs 사이 랜덤 대기 (요청 간격을 일정하게 만들지 않기 위한 지터) */
async function throttle(delayMs?: number) {
  if (!delayMs || delayMs <= 0) return
  await sleep(delayMs + Math.random() * delayMs)
}

// 개별 상품 추출 실패 시 재시도 횟수 (일시적 네트워크/타임아웃 오류 대비). ponytail: 고정값, 설정 불가.
const RETRY_COUNT = 2

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

interface CaptchaInfo {
  type: 'recaptcha2' | 'hcaptcha' | 'image'
  sitekey?: string
  imageSelector?: string
  inputSelector?: string
}

async function detectCaptcha(page: Page): Promise<CaptchaInfo | null> {
  return page.evaluate(() => {
    const recaptchaEl = document.querySelector('.g-recaptcha[data-sitekey]')
    const recaptchaIframe = document.querySelector('iframe[src*="recaptcha"]') as HTMLIFrameElement | null
    const recaptchaSitekey = recaptchaEl?.getAttribute('data-sitekey') || recaptchaIframe?.src.match(/[?&]k=([^&]+)/)?.[1]
    if (recaptchaSitekey) return { type: 'recaptcha2' as const, sitekey: recaptchaSitekey }

    const hcaptchaEl = document.querySelector('.h-captcha[data-sitekey]')
    const hcaptchaIframe = document.querySelector('iframe[src*="hcaptcha"]') as HTMLIFrameElement | null
    const hcaptchaSitekey = hcaptchaEl?.getAttribute('data-sitekey') || hcaptchaIframe?.src.match(/[?&]sitekey=([^&]+)/)?.[1]
    if (hcaptchaSitekey) return { type: 'hcaptcha' as const, sitekey: hcaptchaSitekey }

    const img = document.querySelector('img[src*="captcha" i], img[id*="captcha" i], img[class*="captcha" i]') as HTMLImageElement | null
    const input = document.querySelector('input[name*="captcha" i], input[id*="captcha" i]') as HTMLInputElement | null
    if (img && input) {
      return {
        type: 'image' as const,
        imageSelector: img.id ? `#${img.id}` : 'img[src*="captcha" i], img[id*="captcha" i], img[class*="captcha" i]',
        inputSelector: input.name ? `input[name="${input.name}"]` : (input.id ? `#${input.id}` : 'input[name*="captcha" i]'),
      }
    }
    return null
  })
}

async function injectCaptchaToken(page: Page, kind: 'recaptcha2' | 'hcaptcha', token: string) {
  const responseSelector = kind === 'recaptcha2'
    ? '#g-recaptcha-response, textarea[name="g-recaptcha-response"]'
    : 'textarea[name="h-captcha-response"], #h-captcha-response'
  const widgetSelector = kind === 'recaptcha2' ? '.g-recaptcha[data-callback]' : '.h-captcha[data-callback]'

  await page.evaluate(({ responseSelector, widgetSelector, token }) => {
    const el = document.querySelector(responseSelector) as HTMLTextAreaElement | null
    if (el) { el.style.display = 'block'; el.value = token; el.innerHTML = token }
    const widget = document.querySelector(widgetSelector)
    const cbName = widget?.getAttribute('data-callback')
    const cb = cbName ? (window as unknown as Record<string, unknown>)[cbName] : undefined
    if (typeof cb === 'function') (cb as (t: string) => void)(token)
  }, { responseSelector, widgetSelector, token })
}

/**
 * 로그인 폼에 캡차가 있으면 2Captcha로 자동 풀이해 제출 가능하게 만든다.
 * TWOCAPTCHA_API_KEY가 없거나 캡차가 없으면 조용히 넘어간다 (기존 로그인 흐름을 막지 않음).
 */
async function solveCaptchaIfPresent(page: Page) {
  if (!process.env.TWOCAPTCHA_API_KEY) return
  const captcha = await detectCaptcha(page)
  if (!captcha) return

  try {
    if (captcha.type === 'recaptcha2' && captcha.sitekey) {
      const token = await solveRecaptchaV2(captcha.sitekey, page.url())
      await injectCaptchaToken(page, 'recaptcha2', token)
    } else if (captcha.type === 'hcaptcha' && captcha.sitekey) {
      const token = await solveHCaptcha(captcha.sitekey, page.url())
      await injectCaptchaToken(page, 'hcaptcha', token)
    } else if (captcha.type === 'image' && captcha.imageSelector && captcha.inputSelector) {
      const base64 = await page.locator(captcha.imageSelector).first().screenshot({ timeout: 5_000 })
        .then(buf => buf.toString('base64')).catch(() => null)
      if (base64) {
        const text = await solveImageCaptcha(base64)
        await page.locator(captcha.inputSelector).first().fill(text)
      }
    }
  } catch { /* 캡차 풀이 실패는 로그인 실패로 이어질 뿐, 스크래핑 전체를 죽이지 않는다 */ }
}

async function loginIfNeeded(page: import('playwright').Page, opts: { url: string; loginId?: string; loginPw?: string; loginIdSelector?: string; loginPwSelector?: string; loginBtnSelector?: string }) {
  if (!opts.loginId || !opts.loginPw) return

  // name*="id" 등은 hidden/checkbox 필드(예: SNS연동용 hidden input, "아이디 저장" 체크박스)도 함께 매칭될 수 있어
  // type="text"/"email"로 좁혀서 실제 입력 가능한 필드만 고른다.
  const idSel = opts.loginIdSelector || 'input[type="email"], input[type="text"][name*="id" i], input[type="text"][name*="email" i], input[type="text"][name*="user" i]'
  const pwSel = opts.loginPwSelector || 'input[type="password"]'
  // 로그인 "버튼"이 실제로는 onclick 달린 <a> 태그인 사이트가 흔해 후보를 순서대로 시도하고,
  // 아무것도 안 잡히면 비밀번호 필드에서 Enter로 폼 제출을 시도한다.
  const btnSelectors = opts.loginBtnSelector
    ? [opts.loginBtnSelector]
    : ['button[type="submit"]', 'input[type="submit"]', 'a[onclick*="login" i]', 'button']

  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {})
  const idEl = page.locator(idSel).first()
  if (await idEl.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await idEl.fill(opts.loginId)
    const pwEl = page.locator(pwSel).first()
    await pwEl.fill(opts.loginPw)

    await solveCaptchaIfPresent(page)

    let clicked = false
    for (const sel of btnSelectors) {
      const btn = page.locator(sel).first()
      if (await btn.isVisible({ timeout: 2_000 }).catch(() => false)) {
        await btn.click()
        clicked = true
        break
      }
    }
    if (!clicked) await pwEl.press('Enter')

    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {})
  }
}

interface DomOption { name: string; values: string[] }

const OPTION_SELECT_EXCLUDE_RE = /수량|qty|quantity|정렬|sort|perpage|page/i
const OPTION_PLACEHOLDER_RE = /^(선택|선택하세요|choose|please select)/i

async function scanSelectOptions(page: Page): Promise<DomOption[]> {
  return page.evaluate(({ excludeSrc, placeholderSrc }) => {
    const excludeRe = new RegExp(excludeSrc, 'i')
    const placeholderRe = new RegExp(placeholderSrc, 'i')
    return Array.from(document.querySelectorAll('select'))
      .map(sel => {
        const name = sel.getAttribute('title') || sel.name || sel.id || ''
        const values = Array.from((sel as HTMLSelectElement).options)
          .map(o => (o.textContent || '').trim())
          .filter(v => v && !placeholderRe.test(v))
        return { name, values }
      })
      .filter(o => o.values.length > 0 && !excludeRe.test(o.name))
  }, { excludeSrc: OPTION_SELECT_EXCLUDE_RE.source, placeholderSrc: OPTION_PLACEHOLDER_RE.source })
}

/** <select>가 아니라 라디오/체크박스 또는 색상·옵션 스와치(li/button/a)로 렌더되는 옵션 UI를 읽는다. */
async function scanSwatchOptions(page: Page): Promise<DomOption[]> {
  return page.evaluate(() => {
    const groups = new Map<string, Set<string>>()
    const add = (key: string, value: string) => {
      const v = value.trim()
      if (!v || v.length > 20) return
      if (!groups.has(key)) groups.set(key, new Set())
      groups.get(key)!.add(v)
    }

    // 라디오/체크박스로 구현된 옵션 (겉보기엔 버튼처럼 스타일링되어 있어도 실제로는 input)
    document.querySelectorAll('input[type=radio], input[type=checkbox]').forEach(el => {
      const input = el as HTMLInputElement
      if (!input.name) return
      const label = input.id ? document.querySelector(`label[for="${input.id}"]`) : input.closest('label')
      add(input.name, (label?.textContent || input.value || ''))
    })

    // 클릭형 스와치 (div/li/button/a 등, 옵션·스와치·색상 관련 클래스명으로 추정)
    const containers = document.querySelectorAll(
      '[class*="option" i] ul, [class*="option" i] ol, [class*="swatch" i], .xans-product-option, [class*="color" i] ul',
    )
    containers.forEach((container, idx) => {
      const items = Array.from(container.querySelectorAll('li, button, a')) as HTMLElement[]
      const texts = items
        .map(el => el.getAttribute('data-value') || el.getAttribute('title') || el.textContent || '')
        .map(t => t.trim())
        .filter(Boolean)
      if (texts.length >= 2) texts.forEach(t => add(`옵션(스와치)${idx + 1}`, t))
    })

    return Array.from(groups.entries()).map(([name, values]) => ({ name, values: [...values] }))
  })
}

/**
 * 상품 옵션이 AJAX로 갱신되는 경우(예: 색상 선택 시 사이즈 목록이 뒤늦게 채워짐)를 대비해
 * 첫 번째 옵션 셀렉트의 각 값을 순서대로 선택하며 그때마다 나타나는 옵션까지 모아 병합한다.
 * 라디오/체크박스·클릭형 스와치 옵션은 보통 처음부터 전부 렌더되어 있어 클릭 없이 바로 읽는다.
 * ponytail: select는 1단계 캐스케이딩·최대 20개 값까지만 순회 — 3단계 이상 중첩 select는 지원하지 않음.
 */
async function extractOptionsFromDom(page: Page): Promise<DomOption[]> {
  const merged = new Map<string, Set<string>>()
  const mergeIn = (list: DomOption[]) => {
    list.forEach((o, i) => {
      const key = o.name || `옵션${i + 1}`
      if (!merged.has(key)) merged.set(key, new Set())
      o.values.forEach(v => merged.get(key)!.add(v))
    })
  }

  const initial = await scanSelectOptions(page)
  mergeIn(initial)

  if (initial.length > 0 && initial[0].values.length > 1) {
    const optionCount = Math.min(initial[0].values.length, 20)
    for (let i = 0; i < optionCount; i++) {
      try {
        const firstSelect = (await page.$$('select'))[0]
        if (!firstSelect) break
        await firstSelect.selectOption({ index: i })
        await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {})
        mergeIn(await scanSelectOptions(page))
      } catch { /* 개별 실패는 skip */ }
    }
  }

  mergeIn(await scanSwatchOptions(page))

  return [...merged.entries()].map(([name, values]) => ({ name, values: [...values] }))
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
    const sourceUrl = opts.url || page.url()
    const product = await extractProductRuleBased(page, sourceUrl)
    const domOptions = await extractOptionsFromDom(page)
    if (domOptions.length) product.options = domOptions
    return { sourceUrl, product }
  })
}

export type MallPlatform = 'cafe24' | 'makeshop' | 'godomall' | 'unknown'

interface PlatformProfile {
  productLinkSelector: string | null
  nextPageSelector: string | null
}

// 국내 대표 쇼핑몰 구축 플랫폼별로 알려진 상품링크/다음페이지 셀렉터 기본값.
// 스킨(테마)마다 클래스명이 달라질 수 있어 100% 보장되진 않으며, 사용자가 직접 입력하면 항상 그게 우선한다.
const PLATFORM_PROFILES: Record<MallPlatform, PlatformProfile> = {
  cafe24:   { productLinkSelector: '.xans-product-listmain a, ul.prdList li a, .prdList .thumbnail a', nextPageSelector: '.xans-product-listpagination a.next' },
  makeshop: { productLinkSelector: '.item_gallery_type a, .prd_list_wrap a', nextPageSelector: '.paging a.next' },
  godomall: { productLinkSelector: '.item_cont a, .goods_list a', nextPageSelector: '.paginate a.next' },
  unknown:  { productLinkSelector: null, nextPageSelector: null },
}

/** 페이지의 meta/스크립트/URL 패턴을 보고 어떤 쇼핑몰 구축 플랫폼인지 추정한다. */
export async function detectMallPlatform(page: Page): Promise<MallPlatform> {
  return page.evaluate(() => {
    const generator = (document.querySelector('meta[name="generator"]')?.getAttribute('content') || '').toLowerCase()
    const hosts = Array.from(document.querySelectorAll('script[src], link[href]'))
      .map(el => (el.getAttribute('src') || el.getAttribute('href') || '').toLowerCase())
    const hasHost = (h: string) => hosts.some(s => s.includes(h))
    const url = location.href.toLowerCase()

    if (generator.includes('cafe24') || hasHost('cafe24.com') || /\/product\/(list|detail)\.html/.test(url)) return 'cafe24'
    if (generator.includes('makeshop') || hasHost('makeshop.co.kr') || /shopdetail\.html\?branduid=/.test(url)) return 'makeshop'
    if (generator.includes('godo') || hasHost('godomall') || /goods_view\.php\?goodsno=/.test(url)) return 'godomall'
    return 'unknown'
  })
}

// 목록 페이지의 카테고리 경로(예: "백팩 > 여행용 백팩")를 찾는다. .xans-product-headcategory는 카페24 표준 클래스인데,
// 같은 클래스가 배너 이미지용으로도 쓰여 텍스트가 비어있을 수 있어 모든 매칭 요소 중 텍스트가 있는 것을 찾는다.
async function detectCategoryLabel(page: Page): Promise<string> {
  return page.evaluate(() => {
    const candidates = ['.xans-product-headcategory', 'nav[aria-label*="breadcrumb" i]', '.breadcrumb', '.location']
    for (const sel of candidates) {
      for (const el of Array.from(document.querySelectorAll(sel))) {
        const text = (el.textContent || '').split('/').map(s => s.trim()).filter(Boolean).join(' > ')
        if (text) return text
      }
    }
    return ''
  })
}

interface CollectedLinks {
  urls: string[]
  platform: MallPlatform
  /** 각 상품 URL이 발견된 목록 페이지의 카테고리 경로 */
  categoryByUrl: Map<string, string>
}

/** 목록 페이지(들)을 순회하며 제품 URL 후보를 모은다. 실제 상품 추출은 하지 않는다(테스트/실행 공용 로직). */
async function collectProductUrls(page: Page, opts: ScrapeOptions): Promise<CollectedLinks> {
  const listingUrls = opts.categoryUrls?.length ? opts.categoryUrls : (opts.url ? [opts.url] : [page.url()])
  const maxPages = Math.max(1, opts.maxPages || 1)

  if (opts.url || opts.categoryUrls?.length) {
    await page.goto(listingUrls[0], { waitUntil: 'networkidle', timeout: 30_000 })
    await loginIfNeeded(page, { url: listingUrls[0], ...opts })
    // 로그인 필수 페이지는 로그인 폼으로 리다이렉트되므로, 로그인 시도 후 원래 목표 페이지로 다시 이동한다.
    if (opts.loginId && page.url() !== listingUrls[0]) {
      await page.goto(listingUrls[0], { waitUntil: 'networkidle', timeout: 30_000 }).catch(() => {})
    }
  }

  // 몰 플랫폼을 감지해 알려진 셀렉터를 우선 시도하되, 스킨이 달라 매칭이 0개면 범용 방식으로 자동 폴백한다.
  // (사용자가 직접 셀렉터를 입력하면 그것만 그대로 쓰고 폴백하지 않는다 — 결과가 0개여도 사용자 의도를 존중)
  const platform = await detectMallPlatform(page)
  const profile = PLATFORM_PROFILES[platform]
  const userSel = opts.productLinkSelector || null
  const platformSel = profile.productLinkSelector
  const nextPageSelector = opts.nextPageSelector || profile.nextPageSelector || undefined

  const baseUrl = new URL(listingUrls[0]).origin
  const productUrlSet = new Set<string>()
  const categoryByUrl = new Map<string, string>()

  for (const listingUrl of listingUrls) {
    if (page.url() !== listingUrl) {
      await page.goto(listingUrl, { waitUntil: 'networkidle', timeout: 30_000 }).catch(() => {})
    }

    const categoryLabel = await detectCategoryLabel(page)

    for (let p = 0; p < maxPages; p++) {
      const hrefs: string[] = await page.evaluate(({ userSel, platformSel }) => {
        const pick = (sel: string, requireImg: boolean) => Array.from(document.querySelectorAll(sel))
          .filter(a => !requireImg || a.querySelector('img'))
          .map(a => (a as HTMLAnchorElement).href)
          .filter(h => h && h.startsWith('http'))

        if (userSel) return pick(userSel, false)
        if (platformSel) {
          const viaProfile = pick(platformSel, false)
          if (viaProfile.length > 0) return viaProfile
        }
        return pick('a', true) // 범용 폴백: 썸네일 이미지를 감싼 링크만 제품으로 인식
      }, { userSel, platformSel })
      hrefs.filter(h => h.startsWith(baseUrl)).forEach(h => {
        productUrlSet.add(h)
        if (categoryLabel && !categoryByUrl.has(h)) categoryByUrl.set(h, categoryLabel)
      })

      if (p >= maxPages - 1 || !nextPageSelector) break
      const nextBtn = page.locator(nextPageSelector).first()
      if (!(await nextBtn.isVisible({ timeout: 3_000 }).catch(() => false))) break
      await nextBtn.click()
      await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {})
    }
  }

  // 목록 페이지 자체와 이미 스크랩된 상품은 제외
  const listingSet = new Set(listingUrls)
  const excludeSet  = new Set(opts.excludeUrls || [])
  const urls = [...productUrlSet].filter(h => !listingSet.has(h) && !excludeSet.has(h))

  return { urls, platform, categoryByUrl }
}

export interface TestCatalogResult {
  total: number
  samples: string[]
  platform: MallPlatform
}

/** 실제로 상품을 스크랩하지 않고, 지금 설정(셀렉터/페이지네이션)으로 몇 개가 잡히는지만 미리 확인한다. */
export async function testCatalogSelectors(opts: ScrapeOptions): Promise<TestCatalogResult> {
  return withContext(opts, async page => {
    const { urls, platform } = await collectProductUrls(page, opts)
    return { total: urls.length, samples: urls.slice(0, 10), platform }
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
    const { urls: productUrls, categoryByUrl } = await collectProductUrls(page, opts)

    let saved = 0
    let stopped = false
    let lastError: unknown = null

    for (let i = 0; i < productUrls.length; i++) {
      if (isStopRequested(opts.sessionId)) { stopped = true; break }
      if (i > 0) await throttle(opts.delayMs)

      const pUrl = productUrls[i]
      let result: ScrapeResult | null = null
      for (let attempt = 0; attempt <= RETRY_COUNT; attempt++) {
        try {
          await page.goto(pUrl, { waitUntil: 'networkidle', timeout: 30_000 })
          const product = await extractProductRuleBased(page, pUrl)
          const domOptions = await extractOptionsFromDom(page)
          if (domOptions.length) product.options = domOptions
          const category = categoryByUrl.get(pUrl)
          if (category) product.category = category
          result = { sourceUrl: pUrl, product }
          break
        } catch (err) {
          lastError = err
          if (attempt < RETRY_COUNT) await sleep(1_000 * (attempt + 1))
        }
      }
      if (result) saved++
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

export interface CategoryLink {
  href: string
  text: string
}

const CATEGORY_EXCLUDE_TEXT_RE = /로그인|회원가입|로그아웃|장바구니|마이페이지|고객센터|검색|주문|배송조회|결제|cart|login|logout|mypage|search|sitemap/i

export interface CategoryDiscoveryResult {
  platform: MallPlatform
  links: CategoryLink[]
}

/** 시작 URL 페이지에서 카테고리/메뉴로 추정되는 링크 후보를 찾아 사용자가 고를 수 있도록 목록으로 반환한다. */
export async function discoverCategoryLinks(opts: ScrapeOptions): Promise<CategoryDiscoveryResult> {
  return withContext(opts, async page => {
    const url = opts.url || page.url()
    if (opts.url) {
      await page.goto(opts.url, { waitUntil: 'networkidle', timeout: 30_000 })
      await loginIfNeeded(page, { url: opts.url, ...opts })
      // 로그인 필수 페이지는 로그인 폼으로 리다이렉트되므로, 로그인 시도 후 원래 목표 페이지로 다시 이동한다.
      if (opts.loginId && page.url() !== opts.url) {
        await page.goto(opts.url, { waitUntil: 'networkidle', timeout: 30_000 }).catch(() => {})
      }
    }

    const platform = await detectMallPlatform(page)
    const baseUrl = new URL(url).origin
    const links: CategoryLink[] = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('a'))
        // 썸네일 이미지를 감싼 링크는 상품 카드일 가능성이 높으므로 카테고리 후보에서 제외
        .filter(a => !a.querySelector('img'))
        .map(a => ({ href: (a as HTMLAnchorElement).href, text: (a.textContent || '').trim() }))
        .filter(l => l.text && l.href.startsWith('http'))
    })

    const seen = new Set<string>()
    const filtered = links.filter(l => {
      if (!l.href.startsWith(baseUrl)) return false
      if (l.text.length > 20) return false // 메뉴/카테고리 라벨은 보통 짧다
      if (CATEGORY_EXCLUDE_TEXT_RE.test(l.text)) return false
      if (seen.has(l.href)) return false
      seen.add(l.href)
      return true
    })

    return { platform, links: filtered }
  })
}
