/**
 * 가장 중요한 전제조건: 몰마다 상품 페이지 구조가 다르고, 같은 몰 안에서도 상품마다 실제로 노출되는
 * 정보(이미지 수/구성, 옵션 구성, 재고 표기 방식, 상세페이지가 이미지인지 텍스트인지 등)가 달라진다.
 * 따라서 스크랩 로직을 건드리기 전에 먼저 대상 몰의 상품페이지를 직접 열어 구조를 파악해야 하고,
 * 추출 로직은 "이 몰 한 페이지"가 아니라 "이 몰의 상품마다 달라질 수 있는 모든 경우"를 놓치지 않게
 * 짜야 한다. (예: 대표이미지/상세이미지의 개수·파일명, 옵션 값, 재고수량, 상세페이지 내 텍스트 설명 등)
 */
import path from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { chromium, type BrowserContext, type Page } from 'playwright'
import type { ExtractedProduct } from './ai'
import { extractProductFieldsWithAI } from './ai'
import { extractProductRuleBased, type ExtractSelectorOverrides } from './extract'
import { solveRecaptchaV2, solveHCaptcha, solveImageCaptcha } from './captcha'

const execFileAsync = promisify(execFile)

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
  /** 카탈로그 모드에서 동시에 처리할 상품 페이지 수 (기본 1 = 순차 처리, 최대 8) */
  concurrency?: number
  loginId?: string
  loginPw?: string
  loginIdSelector?: string    // 기본: input[type=email], input[name*=id], input[name*=email]
  loginPwSelector?: string    // 기본: input[type=password]
  loginBtnSelector?: string   // 기본: button[type=submit]
  /** 카탈로그 페이지인 경우 제품 링크 셀렉터 (없으면 단일 상품 페이지로 간주) */
  productLinkSelector?: string
  /** 특정 상품만 지정해서 스크랩 (지정하면 목록 페이지 탐색을 건너뛰고 이 URL들만 스크랩) */
  productUrls?: string[]
  /** 등록된 쇼핑몰 ID — 지정하면 해당 사이트 전용 로그인 세션(프로필)을 재사용 */
  siteId?: number
  /** 스크랩 세션 ID — 중지 요청 확인용 */
  sessionId?: number
  /** Mall별 수동 추출 셀렉터 (자동 감지가 실패하는 테마용, Mall 상세관리에서 설정) */
  nameSelector?: string
  priceSelector?: string
  thumbnailSelector?: string
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

declare global {
  var __scrapeOpenSessions: Map<number, BrowserContext> | undefined
  var __scrapeStopRequests: Set<number> | undefined
}

// 로컬 단일 사용자 도구 기준의 인메모리 상태. 여러 사용자가 동시에 쓰면 충돌한다(ponytail: 감수함).
// globalThis에 저장하는 이유: 개발서버(Turbopack)는 코드 파일이 바뀔 때마다 이 모듈을 다시 평가해
// top-level 변수를 초기화한다 — 로그인 창을 열어둔 채로 다른 스크래핑 코드를 고치면 그 순간 이 Map이
// 통째로 새로 만들어져 열려있던 로그인 세션(BrowserContext) 참조를 잃어버리는 문제가 계속 반복됐다.
// globalThis는 모듈이 재평가돼도 같은 Node 프로세스 안에서는 그대로 유지되므로(Prisma 클라이언트 등
// Next.js 개발모드 싱글턴에 흔히 쓰이는 패턴과 동일), 여기 저장하면 코드를 수정해도 세션이 살아남는다.
const openSessions = globalThis.__scrapeOpenSessions ?? (globalThis.__scrapeOpenSessions = new Map<number, BrowserContext>())
const stopRequests = globalThis.__scrapeStopRequests ?? (globalThis.__scrapeStopRequests = new Set<number>())

/** 실행 중인 스크래핑 세션에 중지를 요청한다 (다음 상품 처리 전에 반영됨) */
export function requestStop(sessionId: number) {
  stopRequests.add(sessionId)
}

function isStopRequested(sessionId?: number) {
  return sessionId !== undefined && stopRequests.has(sessionId)
}

/**
 * 이 siteId의 프로필 폴더를 이미 점유 중인 Chrome 프로세스가 있으면 강제 종료한다.
 * 코드 수정으로 서버가 핫리로드되면 openSessions(메모리) 참조는 끊기지만 실제 Chrome 창은 그대로 떠서
 * 프로필 폴더를 계속 잠그고 있을 수 있다 — 메모리 상태를 믿지 않고 매번 OS 프로세스 목록에서 직접 찾아
 * 정리해야 새 로그인 창이 확실히 열린다.
 * ponytail: Windows 전용(taskkill/PowerShell) — 이 도구는 사용자 로컬 Windows 환경 전용이라 충분하다.
 */
async function killOrphanedProfileProcess(siteId: number): Promise<void> {
  if (process.platform !== 'win32') return
  const dir = profileDir(siteId)
  const script = `Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | ` +
    `Where-Object { $_.CommandLine -like '*${dir}*' -and $_.CommandLine -notlike '*--type=*' } | ` +
    `ForEach-Object { taskkill /PID $_.ProcessId /F /T }`
  await execFileAsync('powershell.exe', ['-NoProfile', '-Command', script]).catch(() => {})
}

/** 사용자가 직접 로그인을 확인할 수 있도록 화면에 보이는 브라우저 창을 연다 */
export async function openLoginWindow(siteId: number, opts: { url: string; loginId?: string; loginPw?: string }) {
  await closeLoginWindow(siteId)
  await killOrphanedProfileProcess(siteId)
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
  // 아이디/비번만 채워두고 제출은 하지 않는다 — 사용자가 직접 로그인 버튼을 눌러야 이후 "로그인 확인" 흐름과 맞는다.
  await loginIfNeeded(page, { url: opts.url, loginId: opts.loginId, loginPw: opts.loginPw }, { autoSubmit: false })
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

async function withContext<T>(opts: ScrapeOptions, fn: (page: Page, context: BrowserContext) => Promise<T>): Promise<T> {
  const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'

  if (opts.siteId) {
    const openContext = openSessions.get(opts.siteId)
    if (openContext) {
      // 로그인 창이 열려있으면 그대로 재사용 (닫지 않음)
      const pages = openContext.pages()
      const page = pages.length ? pages[pages.length - 1] : await openContext.newPage()
      return await fn(page, openContext)
    }
    const context = await chromium.launchPersistentContext(profileDir(opts.siteId), { headless: true, userAgent })
    try {
      const page = context.pages()[0] || await context.newPage()
      return await fn(page, context)
    } finally {
      await context.close()
    }
  }

  const browser = await chromium.launch({ headless: true })
  try {
    const ctx  = await browser.newContext({ userAgent })
    const page = await ctx.newPage()
    return await fn(page, ctx)
  } finally {
    await browser.close()
  }
}

function selectorOverrides(opts: ScrapeOptions): ExtractSelectorOverrides {
  return { nameSelector: opts.nameSelector, priceSelector: opts.priceSelector, thumbnailSelector: opts.thumbnailSelector }
}

/**
 * 'load' 이후 실제 추출 대상(가격/이름 신호)이 이미 나타나 있으면 즉시 진행하고, 없으면 짧게 추가로 기다린다.
 * networkidle처럼 무조건 오래 기다리지 않고, 콘텐츠가 실제로 준비됐는지로 판단해 빠른 사이트는 즉시 다음으로 넘어간다.
 */
async function waitForExtractableContent(page: Page, timeoutMs = 2_500) {
  await page.waitForFunction(() => {
    const hasLdJsonProduct = Array.from(document.querySelectorAll('script[type="application/ld+json"]'))
      .some(s => (s.textContent || '').includes('"Product"'))
    const hasOgTitle = !!document.querySelector('meta[property="og:title"]')
    const hasPriceText = Array.from(document.querySelectorAll('[class*="price" i], [id*="price" i]'))
      .some(el => /[\d,]{3,}\s*원/.test(el.textContent || ''))
    return hasLdJsonProduct || hasOgTitle || hasPriceText
  }, { timeout: timeoutMs }).catch(() => { /* 타임아웃까지도 안 나타나면 그냥 진행 — 이후 재시도/AI 폴백이 처리 */ })
}

/**
 * 규칙 기반 추출이 재시도까지 다 실패했을 때 마지막 수단: 페이지의 눈에 보이는 텍스트를 AI에 보여줘
 * 상품명/가격만 보정한다. AI도 가격을 못 찾으면 null을 반환해 호출부가 최종 실패로 처리하게 한다.
 */
async function tryAiFallback(page: Page, product: ExtractedProduct): Promise<ExtractedProduct | null> {
  const text = await page.evaluate(() => document.body.innerText).catch(() => '')
  if (!text) return null
  const ai = await extractProductFieldsWithAI(text)
  if (ai.price == null) return null
  return { ...product, name: ai.name || product.name, price: ai.price, sale_price: ai.price }
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

async function loginIfNeeded(
  page: import('playwright').Page,
  opts: { url: string; loginId?: string; loginPw?: string; loginIdSelector?: string; loginPwSelector?: string; loginBtnSelector?: string },
  { autoSubmit = true }: { autoSubmit?: boolean } = {},
) {
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

  // networkidle은 채팅위젯/분석 스크립트의 지속 연결 때문에 타임아웃까지 다 채우고 넘어가는 사이트가 많아 'load'로 대체
  await page.waitForLoadState('load', { timeout: 15_000 }).catch(() => {})
  const idEl = page.locator(idSel).first()
  if (await idEl.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await idEl.fill(opts.loginId)
    const pwEl = page.locator(pwSel).first()
    await pwEl.fill(opts.loginPw)

    await solveCaptchaIfPresent(page)

    // autoSubmit=false(로그인 창을 직접 여는 경우)는 아이디/비번만 채워두고, 실제 로그인 버튼 클릭은 사용자가 직접 한다.
    if (!autoSubmit) return

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

    await page.waitForLoadState('load', { timeout: 15_000 }).catch(() => {})
  }
}

interface DomOption { name: string; values: string[] }

const OPTION_SELECT_EXCLUDE_RE = /수량|qty|quantity|정렬|sort|perpage|page/i
// 실제 선택 가능한 값이 아닌 안내문("- [필수] 옵션을 선택해 주세요 -")과 구분선("-----")을 걸러낸다.
const OPTION_PLACEHOLDER_RE = /선택.*(주세요|하세요)|필수|choose|please select|^[-=_*·.\s]+$/i

// 은행/언어/빠른 카테고리 이동 등 헤더·푸터의 바로가기 <select>는 onchange에서 즉시 페이지 이동을 일으켜
// 상품 옵션과 혼동하면 안 된다 (선택할 때마다 새 창이 열리거나 페이지가 이동해 옵션 스캔이 멈추거나 지연됨).
const OPTION_SELECT_NAV_ONCHANGE_RE = /location|window\.open|\.href/i
// 위 정규식과 같은 기준으로 실제 상호작용(selectOption) 대상을 고를 때 쓰는 CSS 셀렉터
const PRODUCT_SELECT_LOCATOR = 'select:not([onchange*="location" i]):not([onchange*="window.open" i]):not([onchange*=".href" i])'

async function scanSelectOptions(page: Page): Promise<DomOption[]> {
  return page.evaluate(({ excludeSrc, placeholderSrc, navOnchangeSrc }) => {
    const excludeRe = new RegExp(excludeSrc, 'i')
    const placeholderRe = new RegExp(placeholderSrc, 'i')
    const navOnchangeRe = new RegExp(navOnchangeSrc, 'i')
    return Array.from(document.querySelectorAll('select'))
      .filter(sel => !navOnchangeRe.test(sel.getAttribute('onchange') || ''))
      .map(sel => {
        const name = sel.getAttribute('title') || sel.name || sel.id || ''
        const values = Array.from((sel as HTMLSelectElement).options)
          .map(o => (o.textContent || '').trim())
          .filter(v => v && !placeholderRe.test(v))
        return { name, values }
      })
      .filter(o => o.values.length > 0 && !excludeRe.test(o.name))
  }, { excludeSrc: OPTION_SELECT_EXCLUDE_RE.source, placeholderSrc: OPTION_PLACEHOLDER_RE.source, navOnchangeSrc: OPTION_SELECT_NAV_ONCHANGE_RE.source })
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
        const firstSelect = page.locator(PRODUCT_SELECT_LOCATOR).first()
        if (await firstSelect.count() === 0) break
        // 기본 30초 대기 없이 짧게 시도하고 넘어간다 — 비활성화된(품절 등) option 하나가 스크랩 전체를 30초씩 붙잡는 것을 방지
        await firstSelect.selectOption({ index: i }, { timeout: 3_000 })
        await page.waitForLoadState('networkidle', { timeout: 3_000 }).catch(() => {})
        mergeIn(await scanSelectOptions(page))
      } catch { /* 개별 실패는 skip */ }
    }
  }

  // <select> 기반 옵션을 이미 찾았으면 그게 실제 옵션 UI다 — 스와치 스캔은 select가 없는 몰에서만 쓰는 대체 수단.
  // (같은 페이지에서 무조건 병합하면 "COLOR"/"SIZE" 같은 라벨 텍스트를 별개 옵션으로 잘못 잡아내는 경우가 있었다.)
  if (merged.size === 0) mergeIn(await scanSwatchOptions(page))

  return [...merged.entries()].map(([name, values]) => ({ name, values: [...values] }))
}

export interface MallProfileSignals {
  sampleCount: number
  hasMainImages: boolean
  hasDetailImages: boolean
  optionUiTypes: ('select' | 'swatch' | 'none')[]
  hasStockQty: boolean
  hasStockStatusText: boolean
  hasDetailText: boolean
}

const MALL_PROFILE_SAMPLE_SIZE = 6

/**
 * 로그인 확인 시점에 몰 내 여러 상품을 훑어 이 몰의 상품페이지 구조적 특성(대표/상세이미지 유무, 옵션 UI
 * 형태, 재고 표기 방식, 상세페이지 텍스트 유무)을 파악한다. 로그인 창이 열려있어야 하며(로그인 확인 직후
 * 호출), 현재 보고 있는 페이지를 목록으로 간주해 상품 몇 개를 샘플링하고, 목록이 아니면 그 페이지 자체를
 * 상품 1건으로 취급한다. 실패해도 전체 로그인 확인 흐름을 막지 않도록 호출부에서 백그라운드로 실행한다.
 */
export async function profileMallStructure(siteId: number): Promise<MallProfileSignals | null> {
  const context = openSessions.get(siteId)
  if (!context) return null
  const pages = context.pages()
  const page = pages.length ? pages[pages.length - 1] : await context.newPage()
  const startUrl = page.url()
  if (!startUrl || startUrl === 'about:blank') return null

  let sampleUrls: string[] = []
  try {
    const { urls } = await collectProductUrls(page, { maxPages: 1 })
    sampleUrls = urls.slice(0, MALL_PROFILE_SAMPLE_SIZE)
  } catch { /* 카탈로그로 인식되지 않으면 아래에서 현재 페이지를 상품 페이지 1건으로 취급 */ }
  if (!sampleUrls.length) sampleUrls = [startUrl]

  const signals: MallProfileSignals = {
    sampleCount: 0, hasMainImages: false, hasDetailImages: false,
    optionUiTypes: [], hasStockQty: false, hasStockStatusText: false, hasDetailText: false,
  }
  const optionTypes = new Set<'select' | 'swatch' | 'none'>()

  for (const url of sampleUrls) {
    try {
      await page.goto(url, { waitUntil: 'load', timeout: 20_000 })
      await waitForExtractableContent(page)
      const product = await extractProductRuleBased(page, url)
      const selectOptions = await scanSelectOptions(page)
      const swatchOptions = selectOptions.length ? [] : await scanSwatchOptions(page)
      optionTypes.add(selectOptions.length ? 'select' : swatchOptions.length ? 'swatch' : 'none')

      signals.sampleCount++
      if (product.thumbnail_urls.length > 0) signals.hasMainImages = true
      if (product.detail_image_urls.length > 0) signals.hasDetailImages = true
      if (product.detail_text) signals.hasDetailText = true
      if (product.stock_qty != null) signals.hasStockQty = true
      if (product.stock_status && product.stock_status !== '판매중') signals.hasStockStatusText = true
    } catch { /* 개별 샘플 실패는 건너뛰고 다음 샘플로 */ }
  }
  signals.optionUiTypes = [...optionTypes]

  await page.goto(startUrl, { waitUntil: 'load', timeout: 20_000 }).catch(() => {})
  return signals.sampleCount > 0 ? signals : null
}

/** 단일 상품 페이지 스크랩 (url 생략 시 현재 열려있는 페이지를 그대로 사용) */
export async function scrapeSingleProduct(opts: ScrapeOptions): Promise<ScrapeResult> {
  return withContext(opts, async page => {
    let lastError: unknown = null
    let lastProduct: ExtractedProduct | null = null
    let lastUrl = opts.url || ''
    for (let attempt = 0; attempt <= RETRY_COUNT; attempt++) {
      try {
        if (opts.url) {
          await page.goto(opts.url, { waitUntil: 'load', timeout: 30_000 })
          await loginIfNeeded(page, { url: opts.url, ...opts })
          if (opts.loginId) {
            await page.goto(opts.url, { waitUntil: 'load', timeout: 30_000 })
          }
        }
        await waitForExtractableContent(page)
        const sourceUrl = opts.url || page.url()
        lastUrl = sourceUrl
        const product = await extractProductRuleBased(page, sourceUrl, selectorOverrides(opts))
        const domOptions = await extractOptionsFromDom(page)
        if (domOptions.length) product.options = domOptions
        lastProduct = product
        // 가격과 이미지가 둘 다 없으면 실제 상품 페이지가 아니라 봇 차단/오류 안내 페이지를 받았을 가능성이
        // 높다 (빠른 연속 요청을 감지해 안내 페이지로 대신 응답하는 몰이 있음) — 그대로 반환하지 않고 재시도한다.
        if (product.price == null && !product.thumbnail_urls.length) {
          throw new Error('가격/이미지를 모두 찾지 못함 (차단 또는 일시 오류로 추정)')
        }
        return { sourceUrl, product }
      } catch (err) {
        lastError = err
        if (attempt < RETRY_COUNT) await sleep(2_000 * (attempt + 1) + Math.random() * 2_000)
      }
    }

    if (lastProduct) {
      const aiProduct = await tryAiFallback(page, lastProduct)
      if (aiProduct) return { sourceUrl: lastUrl, product: aiProduct }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError))
  })
}

export type MallPlatform = 'cafe24' | 'makeshop' | 'godomall' | 'unknown'

interface PlatformProfile {
  productLinkSelector: string | null
  nextPageSelector: string | null
  /** 실제 상품 상세페이지 URL 패턴. 목록 컨테이너 셀렉터가 로고/검색/카테고리 배너 등 상품이 아닌
   *  링크까지 함께 잡아내는 스킨이 있어, 이 패턴에 맞는 URL만 상품으로 인정해 걸러낸다. */
  detailUrlPattern: RegExp | null
}

// 국내 대표 쇼핑몰 구축 플랫폼별로 알려진 상품링크/다음페이지 셀렉터 기본값.
// 스킨(테마)마다 클래스명이 달라질 수 있어 100% 보장되진 않으며, 사용자가 직접 입력하면 항상 그게 우선한다.
const PLATFORM_PROFILES: Record<MallPlatform, PlatformProfile> = {
  cafe24:   { productLinkSelector: '.xans-product-listmain a, ul.prdList li a, .prdList .thumbnail a', nextPageSelector: '.xans-product-listpagination a.next', detailUrlPattern: /\/product\/detail\.html/ },
  makeshop: { productLinkSelector: '.item_gallery_type a, .prd_list_wrap a', nextPageSelector: '.paging a.next', detailUrlPattern: /shopdetail\.html\?branduid=/ },
  godomall: { productLinkSelector: '.item_cont a, .goods_list a', nextPageSelector: '.paginate a.next', detailUrlPattern: /goods_view\.php\?goodsno=/ },
  unknown:  { productLinkSelector: null, nextPageSelector: null, detailUrlPattern: null },
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
  /** 목록 페이지에서 바로 얻을 수 있는 상품명/썸네일 (실제 상품 페이지를 열지 않아 빠른 미리보기용) */
  linkInfo: Map<string, { name: string; thumbnail: string }>
}

/** 목록 페이지(들)을 순회하며 제품 URL 후보를 모은다. 실제 상품 추출은 하지 않는다(테스트/실행 공용 로직). */
async function collectProductUrls(page: Page, opts: ScrapeOptions): Promise<CollectedLinks> {
  if (opts.productUrls?.length) {
    return { urls: opts.productUrls, platform: 'unknown', categoryByUrl: new Map(), linkInfo: new Map() }
  }

  const listingUrls = opts.categoryUrls?.length ? opts.categoryUrls : (opts.url ? [opts.url] : [page.url()])
  const maxPages = Math.max(1, opts.maxPages || 1)

  if (opts.url || opts.categoryUrls?.length) {
    await page.goto(listingUrls[0], { waitUntil: 'load', timeout: 30_000 })
    await loginIfNeeded(page, { url: listingUrls[0], ...opts })
    // 로그인 필수 페이지는 로그인 폼으로 리다이렉트되므로, 로그인 시도 후 원래 목표 페이지로 다시 이동한다.
    if (opts.loginId && page.url() !== listingUrls[0]) {
      await page.goto(listingUrls[0], { waitUntil: 'load', timeout: 30_000 }).catch(() => {})
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
  const linkInfo = new Map<string, { name: string; thumbnail: string }>()

  for (const listingUrl of listingUrls) {
    if (page.url() !== listingUrl) {
      await page.goto(listingUrl, { waitUntil: 'load', timeout: 30_000 }).catch(() => {})
    }

    const categoryLabel = await detectCategoryLabel(page)

    for (let p = 0; p < maxPages; p++) {
      const items: { href: string; name: string; thumbnail: string }[] = await page.evaluate(({ userSel, platformSel, detailPatternSrc }) => {
        const detailRe = detailPatternSrc ? new RegExp(detailPatternSrc) : null
        const pick = (sel: string, requireImg: boolean, applyDetailFilter: boolean) => Array.from(document.querySelectorAll(sel))
          .filter(a => !requireImg || a.querySelector('img'))
          .map(a => {
            const img = a.querySelector('img') as HTMLImageElement | null
            return { href: (a as HTMLAnchorElement).href, name: (img?.alt || a.textContent || '').trim(), thumbnail: img?.src || '' }
          })
          .filter(item => item.href && item.href.startsWith('http'))
          // 목록 컨테이너 셀렉터가 로고/검색/카테고리 배너 등 상품이 아닌 링크까지 잡아내는 스킨 대비 —
          // 상품 상세 URL 패턴을 아는 플랫폼이면 그 패턴에 맞는 것만 상품으로 인정한다. 사용자가 직접 지정한
          // 셀렉터는 의도를 존중해 이 필터를 적용하지 않는다.
          .filter(item => !applyDetailFilter || !detailRe || detailRe.test(item.href))

        if (userSel) return pick(userSel, false, false)
        if (platformSel) {
          const viaProfile = pick(platformSel, false, true)
          if (viaProfile.length > 0) return viaProfile
        }
        return pick('a', true, true) // 범용 폴백: 썸네일 이미지를 감싼 링크만 제품으로 인식
      }, { userSel, platformSel, detailPatternSrc: profile.detailUrlPattern?.source })
      items.filter(item => item.href.startsWith(baseUrl)).forEach(item => {
        productUrlSet.add(item.href)
        if (categoryLabel && !categoryByUrl.has(item.href)) categoryByUrl.set(item.href, categoryLabel)
        if (!linkInfo.has(item.href) && (item.name || item.thumbnail)) linkInfo.set(item.href, { name: item.name, thumbnail: item.thumbnail })
      })

      if (p >= maxPages - 1 || !nextPageSelector) break
      const nextBtn = page.locator(nextPageSelector).first()
      if (!(await nextBtn.isVisible({ timeout: 3_000 }).catch(() => false))) break
      await nextBtn.click()
      await page.waitForLoadState('load', { timeout: 15_000 }).catch(() => {})
    }
  }

  // 목록 페이지 자체와 이미 스크랩된 상품은 제외
  const listingSet = new Set(listingUrls)
  const excludeSet  = new Set(opts.excludeUrls || [])
  const urls = [...productUrlSet].filter(h => !listingSet.has(h) && !excludeSet.has(h))

  return { urls, platform, categoryByUrl, linkInfo }
}

export interface CatalogPreviewItem {
  url: string
  name: string
  thumbnail: string
}

export interface CatalogPreviewResult {
  /** 지금 설정(셀렉터/카테고리)으로 목록에서 찾은 전체 상품 수 (페이징 끝까지 확인) */
  total: number
  platform: MallPlatform
  /** 그중 첫 번째 상품을 실제로 열어 추출한 결과 (찾은 상품이 없으면 null) */
  preview: ScrapeResult | null
  /** 나머지 상품들의 목록 페이지 기준 정보(상품명/썸네일) — 실제로 열어보지 않아 빠르다 */
  items: CatalogPreviewItem[]
}

// 미리보기는 실제 스크랩(maxPages 설정)과 무관하게 페이징 끝까지 따라가 정확한 총 개수를 보여준다.
// 페이지네이션이 무한 루프에 빠지는 몰을 대비한 안전장치용 상한일 뿐, 일반적인 카테고리는 이 안에서 다 끝난다.
const PREVIEW_MAX_PAGES = 50

/**
 * 카탈로그(목록) 모드 전용 — 목록에서 상품 링크를 모아 개수를 확인하고, 첫 번째 상품을 곧바로 열어
 * 미리보기까지 한 번의 브라우저 세션으로 처리한다. 목록 수집과 미리보기를 별도 요청으로 나누면
 * 매번 새 세션을 여느라 느려지므로, 하나로 합쳐 빠르게 확인할 수 있게 한다.
 * ponytail: 미리보기 전용이라 재시도/AI폴백 없이 1회만 시도한다 — 실패하면 버튼을 다시 누르면 됨.
 */
export async function previewCatalog(opts: ScrapeOptions): Promise<CatalogPreviewResult> {
  return withContext(opts, async page => {
    const { urls, platform, linkInfo } = await collectProductUrls(page, { ...opts, maxPages: PREVIEW_MAX_PAGES })
    const items: CatalogPreviewItem[] = urls.map(url => ({
      url, name: linkInfo.get(url)?.name || '', thumbnail: linkInfo.get(url)?.thumbnail || '',
    }))
    if (!urls.length) return { total: 0, platform, preview: null, items: [] }

    const firstUrl = urls[0]
    await page.goto(firstUrl, { waitUntil: 'load', timeout: 30_000 })
    await loginIfNeeded(page, { url: firstUrl, ...opts })
    if (opts.loginId && page.url() !== firstUrl) {
      await page.goto(firstUrl, { waitUntil: 'load', timeout: 30_000 }).catch(() => {})
    }
    await waitForExtractableContent(page)
    const product = await extractProductRuleBased(page, firstUrl, selectorOverrides(opts))
    const domOptions = await extractOptionsFromDom(page)
    if (domOptions.length) product.options = domOptions

    return { total: urls.length, platform, preview: { sourceUrl: firstUrl, product }, items }
  })
}

export interface CatalogItemEvent {
  done: number
  total: number
  url: string
  result: ScrapeResult | null
  error?: string
}

export interface CatalogScrapeSummary {
  total: number
  saved: number
  stopped: boolean
}

/** 목록 페이지(들)에서 제품 URL 수집 후 각각 스크랩. 카테고리 여러 개 + 페이지네이션 + 중지 + 이미 스크랩한 상품 제외 + 동시 처리 지원 */
export async function scrapeCatalogPage(
  opts: ScrapeOptions,
  onItem: (event: CatalogItemEvent) => Promise<void> | void,
): Promise<CatalogScrapeSummary> {
  return withContext(opts, async (page, context) => {
    const { urls: productUrls, categoryByUrl } = await collectProductUrls(page, opts)

    let saved = 0
    let done = 0
    let stopped = false
    let lastError: unknown = null
    let cursor = 0
    const concurrency = Math.max(1, Math.min(opts.concurrency || 1, 8))

    async function scrapeOne(workerPage: Page, pUrl: string): Promise<ScrapeResult | null> {
      let lastProduct: ExtractedProduct | null = null
      for (let attempt = 0; attempt <= RETRY_COUNT; attempt++) {
        try {
          await workerPage.goto(pUrl, { waitUntil: 'load', timeout: 30_000 })
          // 장시간 카탈로그 스크랩 중 세션이 만료되면 로그인 페이지로 리다이렉트되는 몰이 있다 — 매 상품마다
          // 재로그인을 시도해 세션을 회복하고(이미 로그인돼 있으면 아이디 필드가 없어 즉시 지나간다), 원래 상품 페이지로 되돌아간다.
          await loginIfNeeded(workerPage, { url: pUrl, ...opts })
          if (opts.loginId && workerPage.url() !== pUrl) {
            await workerPage.goto(pUrl, { waitUntil: 'load', timeout: 30_000 }).catch(() => {})
          }
          await waitForExtractableContent(workerPage)
          const product = await extractProductRuleBased(workerPage, pUrl, selectorOverrides(opts))
          const domOptions = await extractOptionsFromDom(workerPage)
          if (domOptions.length) product.options = domOptions
          lastProduct = product
          // 가격과 이미지가 둘 다 없으면 실제 상품 페이지가 아니라 봇 차단/오류 안내 페이지를 받았을 가능성이
          // 높다 (빠른 연속 요청을 감지해 안내 페이지로 대신 응답하는 몰이 있음) — 그대로 저장하지 않고 재시도한다.
          if (product.price == null && !product.thumbnail_urls.length) {
            throw new Error('가격/이미지를 모두 찾지 못함 (차단 또는 일시 오류로 추정)')
          }
          const category = categoryByUrl.get(pUrl)
          if (category) product.category = category
          return { sourceUrl: pUrl, product }
        } catch (err) {
          lastError = err
          if (attempt < RETRY_COUNT) await sleep(2_000 * (attempt + 1) + Math.random() * 2_000)
        }
      }
      if (lastProduct) {
        const aiProduct = await tryAiFallback(workerPage, lastProduct)
        if (aiProduct) {
          const category = categoryByUrl.get(pUrl)
          if (category) aiProduct.category = category
          return { sourceUrl: pUrl, product: aiProduct }
        }
      }
      return null
    }

    async function worker(workerPage: Page) {
      while (true) {
        if (isStopRequested(opts.sessionId)) { stopped = true; return }
        const i = cursor++
        if (i >= productUrls.length) return
        if (i > 0) await throttle(opts.delayMs)

        const pUrl = productUrls[i]
        const result = await scrapeOne(workerPage, pUrl)
        if (result) saved++
        done++
        await onItem({
          done, total: productUrls.length, url: pUrl, result,
          error: result ? undefined : (lastError instanceof Error ? lastError.message : String(lastError)),
        })
      }
    }

    const workerCount = Math.min(concurrency, productUrls.length || 1)
    const workerPages = await Promise.all(
      Array.from({ length: workerCount }, (_, idx) => (idx === 0 ? page : context.newPage())),
    )
    await Promise.all(workerPages.map(p => worker(p)))
    await Promise.all(workerPages.slice(1).map(p => p.close().catch(() => {})))

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
      await page.goto(opts.url, { waitUntil: 'load', timeout: 30_000 })
      await loginIfNeeded(page, { url: opts.url, ...opts })
      // 로그인 필수 페이지는 로그인 폼으로 리다이렉트되므로, 로그인 시도 후 원래 목표 페이지로 다시 이동한다.
      if (opts.loginId && page.url() !== opts.url) {
        await page.goto(opts.url, { waitUntil: 'load', timeout: 30_000 }).catch(() => {})
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
