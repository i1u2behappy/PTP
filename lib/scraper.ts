/**
 * 가장 중요한 전제조건: 몰마다 상품 페이지 구조가 다르고, 같은 몰 안에서도 상품마다 실제로 노출되는
 * 정보(이미지 수/구성, 옵션 구성, 재고 표기 방식, 상세페이지가 이미지인지 텍스트인지 등)가 달라진다.
 * 따라서 스크랩 로직을 건드리기 전에 먼저 대상 몰의 상품페이지를 직접 열어 구조를 파악해야 하고,
 * 추출 로직은 "이 몰 한 페이지"가 아니라 "이 몰의 상품마다 달라질 수 있는 모든 경우"를 놓치지 않게
 * 짜야 한다. (예: 대표이미지/상세이미지의 개수·파일명, 옵션 값, 재고수량, 상세페이지 내 텍스트 설명 등)
 */
import fs from 'fs'
import path from 'path'
import { execFile, spawn } from 'child_process'
import { promisify } from 'util'
import { chromium, type BrowserContext, type Page } from 'playwright'
import type { ExtractedProduct } from './ai'
import { extractProductFieldsWithAI, generateMallProfileReport, buildHeuristicMallReport, type MallStructureReport } from './ai'
import { extractProductRuleBased, type ExtractSelectorOverrides } from './extract'
import type { ExtractionRule } from './ai'
import { solveRecaptchaV2, solveHCaptcha, solveImageCaptcha } from './captcha'
import pool from './db'

const execFileAsync = promisify(execFile)

/** 사용자의 실제 개인 크롬이 쓰는 프로필 루트 경로 (Windows). manual_login_required 몰은 이 프로필을
 * 로그인뿐 아니라 실제 스크래핑에도 그대로 써야 한다 — 전용 폴더로 분리하고 쿠키만 옮기는 방식은 시도해
 * 봤지만, 이 몰(PC인증 연동 사업자회원전용 도매몰)의 세션이 쿠키만이 아니라 인증을 통과한 그 브라우저
 * 자체에 묶여있어 실패했다(쿠키를 그대로 복사해도 서버가 로그인 안 된 것으로 취급). */
function realChromeUserDataDir(): string {
  return path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'User Data')
}

/** 이 폴더 루트 아래에서 실제로 활성 상태인 프로필 폴더명("Default", "Profile 6" 등)을 Local State에서
 * 읽는다. --profile-directory를 지정하지 않고 크롬을 열면 이 값이 그대로 열리므로, 사본도 같은 프로필을
 * 지정해야 사용자가 실제 로그인해둔 그 프로필과 일치한다. */
function activeProfileDirName(userDataDir: string): string {
  try {
    const localState = JSON.parse(fs.readFileSync(path.join(userDataDir, 'Local State'), 'utf-8'))
    return localState?.profile?.last_used || 'Default'
  } catch {
    return 'Default'
  }
}

const MANUAL_LOGIN_PROFILE_COPY_ROOT = path.join(process.cwd(), '.playwright-profiles', '_manual-login-real-copy')
// 로그인/보안 상태와 무관한 순수 성능 캐시만 제외한다. 설치된 확장프로그램(Extensions)은 용량이 커도 제외
//하지 않는다 — 국내 몰의 PC인증/본인인증이 보안 프로그램 확장의 설치 여부를 확인하는 경우가 흔해서다.
const PROFILE_COPY_CACHE_EXCLUDES = ['Cache', 'Code Cache', 'GPUCache', 'DawnWebGPUCache', 'DawnGraphiteCache']

/**
 * 최신 크롬은 자기 자신의 실제 기본 프로필 경로에는 원격 디버깅(자동화 제어)을 거부한다
 * ("DevTools remote debugging requires a non-default data directory") — 그래서 개인 프로필을 그대로
 * Playwright로 띄우면 크롬 프로세스는 뜨지만 CDP 연결이 끝내 안 되고 결국 타임아웃난다(2026-07-18 확인).
 * 우회: 쿠키만이 아니라 활성 프로필 폴더 전체(확장프로그램·로컬스토리지·Web Data 등 포함, 순수 캐시만 제외)를
 * 별도 경로에 통째로 복사해 그 사본을 띄운다 — robocopy /MIR로 미러링해 최초 1회 이후로는 바뀐 파일만
 * 복사되어 빠르다. 이전에 시도했다가 실패한 "쿠키만 이전" 방식과 달리 프로필 전체를 복사하므로, 세션이
 * 브라우저 자체(로컬스토리지/확장 상태 등)에 묶여있어도 통과할 가능성이 있다 — 다만 WebAuthn이 브라우저
 * 프로필이 아니라 Windows OS/TPM에 바인딩돼 있으면 이 방법으로도 안 될 수 있다(미검증, 실사용하며 확인).
 */
async function syncManualLoginProfileCopy(): Promise<{ userDataDir: string; profileDirName: string }> {
  const srcRoot = realChromeUserDataDir()
  const profileDirName = activeProfileDirName(srcRoot)
  const destRoot = MANUAL_LOGIN_PROFILE_COPY_ROOT
  fs.mkdirSync(destRoot, { recursive: true })

  const excludeArgs = PROFILE_COPY_CACHE_EXCLUDES.flatMap(d => ['/XD', path.join(srcRoot, profileDirName, d)])
  await execFileAsync('robocopy', [
    path.join(srcRoot, profileDirName), path.join(destRoot, profileDirName),
    '/MIR', '/NFL', '/NDL', '/NJH', '/NJS', '/R:1', '/W:1', ...excludeArgs,
  ]).catch(e => {
    // robocopy는 0~7이 정상(파일 복사/스킵 조합), 8 이상은 일부 파일을 못 옮겼다는 뜻 — 대개 개인 크롬이
    // 실행 중이라 Cookies/Login Data 같은 세션 파일이 잠겨있어서다(2026-07-18 확인: 실제로 이 경우였음).
    if (typeof e?.code === 'number' && e.code < 8) return
    throw new Error('개인 크롬이 켜져 있어 프로필 일부 파일(로그인/쿠키 정보)을 복사하지 못했습니다. 크롬을 모두 닫고 다시 시도해주세요.')
  })
  fs.copyFileSync(path.join(srcRoot, 'Local State'), path.join(destRoot, 'Local State'))

  return { userDataDir: destRoot, profileDirName }
}

async function isManualLoginSite(siteId: number): Promise<boolean> {
  const res = await pool.query<{ manual_login_required: boolean }>('SELECT manual_login_required FROM sites WHERE id=$1', [siteId])
  return !!res.rows[0]?.manual_login_required
}

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
  /** "스크랩 조정" 기능이 AI로 학습해 저장한 그 몰 전용 추출 규칙 (sites.extraction_rules) */
  extractionRules?: Record<string, ExtractionRule>
}

export function profileDir(siteId: number) {
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

/** 개발자모드(크롬 확장)는 이 서버가 아니라 사용자 브라우저에서 루프가 돌고 있어, 인메모리 Set을 직접
 *  못 들여다본다 — 확장이 상품마다 이 함수를 거쳐 공개 API로 물어보게 한다(app/api/scrape/stop-requested). */
export function isStopRequested(sessionId?: number) {
  return sessionId !== undefined && stopRequests.has(sessionId)
}

/** 중지 반영이 끝난 뒤 Set에서 지운다 — 안 지우면 세션 id가 계속 쌓여 다음에 같은 id가(이론상) 재사용될 때
 *  엉뚱하게 즉시 중지된 것처럼 보일 수 있다. */
export function clearStopRequest(sessionId: number) {
  stopRequests.delete(sessionId)
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

/** 화면에 보이는(headed) 브라우저 창을 새로 띄우고 openSessions에 등록한다. 프로필 디렉터리가 그대로라
 * 예전에 로그인했던 쿠키가 남아있으면 자동으로 로그인된 상태로 뜬다. */
async function launchVisibleWindow(siteId: number): Promise<BrowserContext> {
  await closeLoginWindow(siteId)
  await killOrphanedProfileProcess(siteId)
  // Playwright 번들 Chromium이 아니라 실제 설치된 크롬(사용자가 평소 로그인 테스트하는 그 브라우저)을
  // 그대로 띄운다 — Windows Hello/WebAuthn 같은 OS 통합 기능은 번들 Chromium엔 없을 수 있다.
  // userAgent도 따로 지정하지 않아 그 크롬이 실제로 쓰는 값과 100% 일치한다 (예전엔 Chrome 버전이
  // 빠진 잘린 UA 문자열을 강제로 넣고 있었는데, 이게 브라우저의 Client Hints 헤더와 안 맞아 몰 쪽
  // 봇 탐지에 자동화로 잡히기 쉬웠다).
  // chromiumSandbox: true를 안 주면 Playwright가 기본으로 --no-sandbox를 붙여, 실제 크롬을 띄워도
  // "지원되지 않는 명령줄 플래그" 경고 배너가 뜨고 일반 크롬과 다르게 보인다.
  const context = await chromium.launchPersistentContext(profileDir(siteId), {
    headless: false, channel: 'chrome', chromiumSandbox: true,
  })
  // navigator.webdriver=true는 Playwright로 띄운 크롬임을 드러내는 가장 흔한 신호라, 로그인 시 본인인증
  // 단계를 건너뛰고 차단하는 몰(예: 카페24 PC인증 연동)에서 이 창만 로그인이 안 되는 원인이 될 수 있다.
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
  })
  openSessions.set(siteId, context)
  // 사용자가 창을 직접 닫거나 브라우저가 죽었을 때도 반영되도록 추적
  context.on('close', () => {
    if (openSessions.get(siteId) === context) openSessions.delete(siteId)
  })
  return context
}

/** 사용자가 직접 로그인을 확인할 수 있도록 화면에 보이는 브라우저 창을 연다 */
export async function openLoginWindow(siteId: number, opts: { url: string; loginId?: string; loginPw?: string }) {
  const context = await launchVisibleWindow(siteId)
  const page = context.pages()[0] || await context.newPage()
  await page.goto(opts.url, { waitUntil: 'networkidle', timeout: 30_000 }).catch(() => {})
  // 아이디/비번만 채워두고 제출은 하지 않는다 — 사용자가 직접 로그인 버튼을 눌러야 이후 "로그인 확인" 흐름과 맞는다.
  await loginIfNeeded(page, { url: opts.url, loginId: opts.loginId, loginPw: opts.loginPw }, { autoSubmit: false })
}

const CHROME_EXE = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'

/**
 * Windows Hello/WebAuthn(PC인증)처럼 CDP로 자동화 제어되는 브라우저에서는 통과할 수 없는 로그인 보안을
 * 쓰는 몰(sites.manual_login_required)용 — 전용 프로필 폴더를 새로 만드는 대신, 사용자의 실제 개인 크롬
 * 프로필을 그대로 띄운다(child_process.spawn, 원격 디버깅 포트/자동화 플래그 전혀 없음, --user-data-dir도
 * 지정하지 않아 평소 더블클릭으로 여는 것과 완전히 동일하다). 전용 폴더는 몰 입장에서 "낯선 기기"로 보여
 * PC인증을 통과해도 로그인 자체가 거부됐는데, 이미 신뢰가 쌓인 개인 프로필은 그대로 통과한다.
 * 주의: 사용자가 이미 크롬을 열어둔 상태면 같은 프로필을 동시에 쓸 수 없어 실패한다 — 먼저 직접 닫아야 한다.
 * (개인 브라우저이므로 여기서 기존 크롬 프로세스를 강제 종료하지 않는다.)
 */
export async function openManualLoginWindow(siteId: number, url: string): Promise<void> {
  await closeLoginWindow(siteId)
  // --no-first-run/--no-default-browser-check가 없으면 실제 크롬이 "Chrome에 로그인" 등 첫 실행 온보딩
  // 화면을 활성 탭으로 띄워버려, 요청한 몰 로그인 URL로 바로 이동하지 않는다.
  const child = spawn(CHROME_EXE, ['--no-first-run', '--no-default-browser-check', url], { detached: true, stdio: 'ignore' })
  child.unref()
}

/** 현재 로그인 창에서 사용자가 보고 있는 페이지 URL (없으면 null) */
export function getOpenPageUrl(siteId: number): string | null {
  const context = openSessions.get(siteId)
  if (!context) return null
  const pages = context.pages()
  return pages.length ? pages[pages.length - 1].url() : null
}

/**
 * 미리보기 화면의 "열기" 버튼처럼, 로그인된 상태로 특정 상품 페이지를 확인하고 싶을 때 쓴다. 로그인 창이
 * 열려있으면 그 창(세션 쿠키를 가진 그 브라우저)에 새 탭을 띄워 이동시킨다. 사용자가 창을 닫아 열려있는
 * 로그인 창이 없어도, 같은 프로필 디렉터리에 남아있는 예전 로그인 쿠키를 그대로 재사용해 새 창을 띄운다
 * (그 쿠키가 만료됐으면 그 사이트 자체가 로그인 페이지로 돌려보낼 뿐 — 이 함수가 할 수 있는 건 여기까지).
 */
export async function openUrlInLoginWindow(siteId: number, url: string): Promise<void> {
  const existing = openSessions.get(siteId)
  if (existing) {
    const page = await existing.newPage()
    await page.goto(url, { waitUntil: 'load', timeout: 30_000 }).catch(() => {})
    await page.bringToFront().catch(() => {})
    return
  }
  const context = await launchVisibleWindow(siteId)
  const page = context.pages()[0] || await context.newPage()
  await page.goto(url, { waitUntil: 'load', timeout: 30_000 }).catch(() => {})
}

/** 사용자가 명시적으로 닫을 때만 호출 — 로그인 확인 시에는 창을 닫지 않는다 */
export async function closeLoginWindow(siteId: number) {
  const context = openSessions.get(siteId)
  if (context) {
    await context.close().catch(() => {})
    openSessions.delete(siteId)
  }
}

// 어디서든 Playwright 번들 Chromium이 아니라 실제 설치된 크롬을 띄운다 — 몰이 자동화 브라우저를
// 감지해 차단/도전과제를 거는 경우(예: manual-login-required 몰의 봇 탐지) 실제 크롬 쪽이 더 정상적으로 통과한다.
async function withContext<T>(opts: ScrapeOptions, fn: (page: Page, context: BrowserContext) => Promise<T>): Promise<T> {
  if (opts.siteId) {
    const openContext = openSessions.get(opts.siteId)
    if (openContext) {
      // 로그인 창이 열려있으면 그대로 재사용 (닫지 않음)
      const pages = openContext.pages()
      const page = pages.length ? pages[pages.length - 1] : await openContext.newPage()
      return await fn(page, openContext)
    }
    if (await isManualLoginSite(opts.siteId)) {
      // 직접로그인 필수 몰은 사용자의 실제 개인 크롬 프로필(활성 프로필 전체)을 사본으로 복제해 그 사본을
      // 헤드리스로 띄운다 — syncManualLoginProfileCopy() 주석 참고. 개인 브라우저 자체를 건드리지 않으므로
      // 여기서 기존 크롬 프로세스를 강제 종료하지 않는다.
      let context: BrowserContext
      try {
        const { userDataDir, profileDirName } = await syncManualLoginProfileCopy()
        context = await chromium.launchPersistentContext(userDataDir, {
          headless: true, channel: 'chrome', chromiumSandbox: true,
          args: profileDirName !== 'Default' ? [`--profile-directory=${profileDirName}`] : [],
        })
      } catch (e) {
        throw new Error(`개인 크롬 프로필 복사본 실행에 실패했습니다: ${e instanceof Error ? e.message : String(e)}`)
      }
      try {
        const page = context.pages()[0] || await context.newPage()
        return await fn(page, context)
      } finally {
        await context.close()
      }
    }

    // 직접로그인 필수 몰은 사용자가 별도로 띄운(추적 안 되는) 크롬 창을 안 닫고 스크랩을 시작할 수 있어,
    // 같은 프로필 폴더를 쓰는 헤드리스 실행이 lock 충돌로 실패하지 않도록 먼저 정리한다.
    await killOrphanedProfileProcess(opts.siteId)
    const context = await chromium.launchPersistentContext(profileDir(opts.siteId), {
      headless: true, channel: 'chrome', chromiumSandbox: true,
    })
    try {
      const page = context.pages()[0] || await context.newPage()
      return await fn(page, context)
    } finally {
      await context.close()
    }
  }

  const browser = await chromium.launch({ headless: true, channel: 'chrome', chromiumSandbox: true })
  try {
    const ctx  = await browser.newContext()
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
    // 로그인 성공 페이지가 뜬 뒤 클라이언트 스크립트가 지연 리다이렉트를 거는 몰이 있다(예: 로그인
    // 처리 화면을 잠깐 보여준 뒤 setTimeout으로 원래 페이지로 이동) — 'load' 이벤트만 보고 함수가
    // 반환되면, 호출한 쪽이 바로 이어서 하는 page.evaluate()가 그 지연 리다이렉트와 겹쳐
    // "Execution context was destroyed" 오류로 죽는 게 실제로 발견됐다(펫투비). 네트워크가 짧게라도
    // 잠잠해질 때까지 한 번 더 기다려 그 지연 리다이렉트가 이 함수 밖으로 나가기 전에 끝나게 한다.
    await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {})
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
// 카페24 실제 상품 옵션(색상/사이즈 등)은 이 컨테이너 안에만 있다. 스코프 없이 document 전체에서 select를
// 찾으면 "함께 구매하면 좋은 상품" 등 같은 페이지의 무관한 위젯(다른 상품의 옵션 select)까지 잡혀
// 존재하지 않는 옵션 컬럼(예: option_26852[])이 생기는 문제가 있었다.
const OPTION_CONTAINER_SELECTOR = '.xans-product-option'

async function scanSelectOptions(page: Page, rootSelector?: string): Promise<DomOption[]> {
  return page.evaluate(({ excludeSrc, placeholderSrc, navOnchangeSrc, rootSelector }) => {
    const excludeRe = new RegExp(excludeSrc, 'i')
    const placeholderRe = new RegExp(placeholderSrc, 'i')
    const navOnchangeRe = new RegExp(navOnchangeSrc, 'i')
    const root = (rootSelector && document.querySelector(rootSelector)) || document
    return Array.from(root.querySelectorAll('select'))
      .filter(sel => !navOnchangeRe.test(sel.getAttribute('onchange') || ''))
      .map(sel => {
        // data-soptionnm은 고도몰(펫투비 등)이 옵션 그룹명을 담아두는 속성 — title/name/id가 다 없는
        // select(예: id="el-sOption")도 이걸로 진짜 이름("옵션")을 얻는다(실제 페이지로 확인).
        const name = sel.getAttribute('title') || sel.getAttribute('data-soptionnm') || sel.name || sel.id || ''
        // value=""인 <option>은 "사이즈"/"색상" 같은 안내용 placeholder인 경우가 흔하다(플레이스홀더
        // 문구가 "선택하세요" 류가 아니어도 마찬가지라 텍스트 패턴만으론 못 걸러낸다) — 실제 선택 가능한
        // 옵션이라면 value가 비어있을 이유가 없으므로 텍스트 패턴 필터와 별개로 항상 제외한다.
        const values = Array.from((sel as HTMLSelectElement).options)
          .filter(o => o.value !== '')
          // 고도몰은 <option> 텍스트에 "민트: 37,810원"처럼 가격까지 같이 넣어두고, 실제 깨끗한 값은
          // data-so_name 속성에 따로 둔다(실제 페이지로 확인) — 있으면 그걸 우선한다.
          .map(o => (o.getAttribute('data-so_name') || o.textContent || '').replace(/\s+/g, ' ').trim())
          // 품절 옵션은 "베이지(카키) -- [일시품절/재입고미정]"처럼 상태 문구가 값 자체에 섞여 들어온다
          // (실제 페이지로 확인, 가방쟁이) — 끝에 붙는 대괄호 상태문구와 그 앞의 "--" 구분자를 걷어내
          // 옵션값을 깨끗하게 만든다.
          .map(v => v.replace(/\s*\[[^\]]*\]\s*$/, '').replace(/\s*--+\s*$/, '').trim())
          .filter(v => v && !placeholderRe.test(v))
        return { name, values }
      })
      .filter(o => o.values.length > 0 && !excludeRe.test(o.name))
  }, { excludeSrc: OPTION_SELECT_EXCLUDE_RE.source, placeholderSrc: OPTION_PLACEHOLDER_RE.source, navOnchangeSrc: OPTION_SELECT_NAV_ONCHANGE_RE.source, rootSelector: rootSelector || '' })
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
 * 색상이 1개뿐인 상품도 그 색상을 선택해야 사이즈 목록이 채워지는 몰이 있어, 값이 1개여도 최소 1회는
 * 선택을 시도한다. 라디오/체크박스·클릭형 스와치 옵션은 보통 처음부터 전부 렌더되어 있어 클릭 없이 바로 읽는다.
 * ponytail: select는 1단계 캐스케이딩·최대 20개 값까지만 순회 — 3단계 이상 중첩 select는 지원하지 않음.
 */
interface DomOptionsResult {
  options: DomOption[]
  /** 옵션1 값마다 옵션2 목록이 다르게 채워지는 몰(예: 신우 — 색상별 구매 가능한 사이즈가 다름)의 실제
   *  유효 조합. [옵션1값, 옵션2값] 쌍의 목록 — options처럼 값을 통째로 합쳐버리면 어느 옵션1에 어느
   *  옵션2가 실제로 딸려 나오는지 알 수 없어 별도로 남긴다. 옵션 그룹이 1개뿐이거나 캐스케이딩이 없는
   *  몰(옵션2가 항상 고정)은 비워둔다. */
  combinations: string[][]
}

async function extractOptionsFromDom(page: Page): Promise<DomOptionsResult> {
  const merged = new Map<string, Set<string>>()
  const mergeIn = (list: DomOption[]) => {
    list.forEach((o, i) => {
      const key = o.name || `옵션${i + 1}`
      if (!merged.has(key)) merged.set(key, new Set())
      o.values.forEach(v => merged.get(key)!.add(v))
    })
  }

  const hasOptionContainer = await page.evaluate(sel => !!document.querySelector(sel), OPTION_CONTAINER_SELECTOR)
  const rootSelector = hasOptionContainer ? OPTION_CONTAINER_SELECTOR : undefined
  const selectLocatorStr = hasOptionContainer ? `${OPTION_CONTAINER_SELECTOR} ${PRODUCT_SELECT_LOCATOR}` : PRODUCT_SELECT_LOCATOR

  const initial = await scanSelectOptions(page, rootSelector)
  mergeIn(initial)

  const combinations: string[][] = []
  if (initial.length > 0) {
    const values = initial[0].values.slice(0, 20)
    for (const value of values) {
      try {
        const firstSelect = page.locator(selectLocatorStr).first()
        if (await firstSelect.count() === 0) break
        // index가 아니라 label(실제 값)로 선택한다 — index는 안내문/구분선까지 포함한 원래 <option> 순서
        // 기준이라, 필터링된 값 목록의 인덱스로 selectOption({index})를 호출하면 엉뚱한(안내문 등) 옵션이
        // 선택되어 사이즈 등 하위 옵션이 채워지는 onchange가 아예 발생하지 않는 문제가 있었다.
        // 기본 30초 대기 없이 짧게 시도하고 넘어간다 — 비활성화된(품절 등) option 하나가 스크랩 전체를 30초씩 붙잡는 것을 방지
        await firstSelect.selectOption({ label: value }, { timeout: 3_000 })
        await page.waitForLoadState('networkidle', { timeout: 3_000 }).catch(() => {})
        const rescanned = await scanSelectOptions(page, rootSelector)
        mergeIn(rescanned)
        // rescanned[1]이 바로 이 옵션1 값을 선택했을 때 AJAX로 채워진 옵션2 목록 — 그 값들을 지금 선택한
        // 옵션1 값과 짝지어 기록한다(캐스케이딩이 없는 몰은 매번 같은 값이 나와 그냥 전체 조합이 되고 만다).
        if (rescanned.length > 1) {
          for (const v2 of rescanned[1].values) combinations.push([value, v2])
        }
      } catch { /* 개별 실패는 skip */ }
    }
  }

  // <select> 기반 옵션을 이미 찾았으면 그게 실제 옵션 UI다 — 스와치 스캔은 select가 없는 몰에서만 쓰는 대체 수단.
  // (같은 페이지에서 무조건 병합하면 "COLOR"/"SIZE" 같은 라벨 텍스트를 별개 옵션으로 잘못 잡아내는 경우가 있었다.)
  if (merged.size === 0) mergeIn(await scanSwatchOptions(page))

  return {
    options: [...merged.entries()].map(([name, values]) => ({ name, values: [...values] })),
    combinations,
  }
}

/**
 * 카페24는 상품정보고시 표의 "재고 수량" 칸에 실제 숫자 대신 "자세히"(.EC-stockdesign) 버튼만 두고,
 * 클릭해야 옵션 조합별(색상/사이즈 등) 재고수량 표(.EC-stockLayer)를 레이어로 띄워준다. 이 정보는 상품마다
 * 값이 다 다르고 옵션 조합 수만큼 늘어나므로, 버튼이 있으면 클릭해서 표를 읽는다. 없으면(다른 플랫폼/스킨
 * 등) 빈 배열.
 */
async function extractStockByOption(page: Page): Promise<{ option: string; qty: number }[]> {
  const stockLink = page.locator('.EC-stockdesign').first()
  if (await stockLink.count() === 0) return []
  try {
    await stockLink.click({ timeout: 3_000 })
    await page.waitForSelector('.EC-stockLayer table tbody tr', { timeout: 5_000 })
    const rows = await page.evaluate(() => {
      const layer = document.querySelector('.EC-stockLayer')
      if (!layer) return []
      return Array.from(layer.querySelectorAll('table tbody tr')).map(tr => {
        const cells = Array.from(tr.querySelectorAll('td')).map(td => (td.textContent || '').trim())
        return { option: cells[0] || '', qtyText: cells[1] || '' }
      })
    })
    return rows.filter(r => r.option).map(r => ({ option: r.option, qty: Number((r.qtyText.match(/-?\d+/) || ['0'])[0]) }))
  } catch {
    return []
  }
}

/** extractStockByOption 결과를 product에 반영한다 — 조합별 재고가 잡히면 전체 재고수량도 그 합으로 갱신한다. */
async function applyStockByOption(page: Page, product: ExtractedProduct): Promise<void> {
  const stockByOption = await extractStockByOption(page)
  if (stockByOption.length) {
    product.stock_by_option = stockByOption
    product.stock_qty = stockByOption.reduce((sum, r) => sum + r.qty, 0)
  }
}

export interface MallProfileSignals {
  sampleCount: number
  /** 카페24/메이크샵/고도몰 등 감지된 구축 플랫폼 — 이후 이 몰을 다시 손볼 때(코드 수정, AI 규칙 생성)
   *  마다 매번 실제 페이지를 다시 열어보지 않고도 참고할 수 있도록 남겨둔다. */
  platform: MallPlatform
  /** 샘플링에 실제로 쓴 상품 URL 1건 — 나중에 이 몰을 디버깅할 때 바로 열어볼 수 있는 참고용. */
  sampleProductUrl: string
  hasMainImages: boolean
  hasDetailImages: boolean
  optionUiTypes: ('select' | 'swatch' | 'none')[]
  hasCascadingOptions: boolean
  hasStockQty: boolean
  hasStockStatusText: boolean
  hasStockByOption: boolean
  hasDetailText: boolean
  infoLabels: string[]
  /** 샘플링한 상품들의 카테고리 경로(목록 페이지 브레드크럼 기준) — 전체 카테고리 트리를 다 훑는 건 아니고
   *  샘플로 실제 확인된 경로만이라, 몰의 카테고리 구조가 몇 단계인지 정도의 근사치로 봐야 한다. */
  categoryPaths: string[]
  categoryMaxDepth: number
  /** 상단 내비게이션 메뉴에 카테고리 전체가 노출되는 플랫폼(현재 고도몰만 지원)에서, 상품을 하나하나
   *  열어보지 않고 메뉴에서 바로 얻은 대분류+중분류 카테고리명 전체. 지원 안 되는 플랫폼은 빈 배열 —
   *  categoryPaths(샘플 기준 근사치)로 대신 가늠해야 한다. */
  categoryMenuNames: string[]
  /** URL 계층/카테고리/결제계좌/택배사/재고관리형태/업체연락처/상품페이지구조/스크래핑 유의사항을 실제로
   *  수집한 원문(홈 하단 회사정보 + 이용안내·공지 등 게시판 + 상품페이지) 기반으로 AI가 요약한 리포트.
   *  ANTHROPIC_API_KEY 미설정이거나 원문을 하나도 못 모았으면 null. */
  report: MallStructureReport | null
}

const MALL_PROFILE_SAMPLE_SIZE = 6

/**
 * 로그인 확인 시점에 몰 내 여러 상품을 훑어 이 몰의 상품페이지 구조적 특성을 파악한다 — 대표/상세이미지
 * 유무, 옵션 UI 형태(select/swatch)와 색상→사이즈 같은 연쇄옵션 여부, 재고 표기 방식(전체 수량/상태문구/
 * "자세히" 클릭형 옵션별 재고), 상세페이지 텍스트 유무, 상품정보고시 표에 실제로 어떤 라벨들이 있는지까지.
 * 새 몰을 처음 스크랩하기 전에 그 몰 상품마다 달라질 수 있는 부분을 미리 다 찾아두기 위한 것으로, 이후
 * 실제 스크랩 코드가 무엇을 놓치고 있는지 새 라벨/구조가 나올 때마다 알 수 있게 한다(사용자 보고에 의존하지
 * 않고 매번 스스로 다시 점검). 로그인 창이 열려있어야 하며(로그인 확인 직후 호출), 항상 이 몰에 등록된
 * 정식 시작 URL(sites.url)로 먼저 이동한 뒤 그 페이지를 목록으로 간주해 상품 몇 개를 샘플링한다 — 사용자가
 * 로그인 확인 시점에 마이페이지 등 다른 화면을 보고 있어도 엉뚱한 페이지가 기준이 되지 않도록 하기 위함
 * (실사용 중 마이페이지가 기준이 돼 platform 오감지→카테고리/상품 스캔이 전부 틀어지는 문제가 실제 발견됨).
 * sites.url이 없으면 지금 열려있는 페이지를 그대로 쓴다. 실패해도 전체 로그인 확인 흐름을 막지 않도록
 * 호출부에서 백그라운드로 실행한다.
 *
 * deep(기본 false)는 "몰 구조 파악" 버튼 전용 — true면 하단 회사정보/이용안내·공지 게시판까지 훑어
 * 결제계좌·택배사·연락처 등을 AI로 분석하는 무거운 작업까지 추가로 한다(MallProfileSignals.report).
 * 로그인 확인/스크랩 시작마다 자동으로 도는 가벼운 구조 변화 감지(false)와는 용도가 다르다 — 사용자가
 * 직접 "이 둘은 서로 다른 용도"라고 확정함: 로그인 확인=구조 변화 감지 전용, 몰 구조 파악=거래정보 분석 전용.
 */
export async function profileMallStructure(siteId: number, deep = false): Promise<MallProfileSignals | null> {
  const context = openSessions.get(siteId)
  if (!context) return null
  const pages = context.pages()
  const page = pages.length ? pages[pages.length - 1] : await context.newPage()
  const site = await siteInfo(siteId)
  if (site.url) {
    await page.goto(site.url, { waitUntil: 'load', timeout: 20_000 }).catch(() => {})
  }
  const startUrl = page.url()
  if (!startUrl || startUrl === 'about:blank') return null
  return sampleMallProfile(page, startUrl, site.name, deep)
}

async function siteInfo(siteId: number): Promise<{ name: string; url: string }> {
  const res = await pool.query<{ name: string; url: string }>('SELECT name, url FROM sites WHERE id = $1', [siteId])
  return { name: res.rows[0]?.name || `site${siteId}`, url: res.rows[0]?.url || '' }
}

// page.exposeFunction은 같은 Page 인스턴스에 같은 이름으로 두 번 부르면 에러가 난다 — "스크랩 대상 직접지정 시작"을
// 여러 번 눌러도 안전하도록 이미 노출한 Page를 기억해둔다.
const pickerExposedPages = new WeakSet<Page>()
// 미리보기 자동 재실행(refreshPreviewSingle)처럼 같은 탭이 다시 navigate되면 주입된 패널/리스너가
// 통째로 사라진다(page.evaluate는 그 문서에만 심어지고, 새 문서로 넘어가면 초기화됨) — 페이지가 새로
// 로드될 때마다 자동으로 다시 주입해, 값 하나 저장한 뒤에도 계속 이어서 지정할 수 있게 한다.
const pickerNavHandlers = new WeakMap<Page, () => void>()

/**
 * "스크랩 대상 직접지정" 기능 — 실제로 열려있는 몰 페이지(로그인 확인된 openSessions 창)에 클릭식 엘리먼트 피커를
 * 주입한다. 사용자가 페이지에서 값을 클릭하면(예: 가격 텍스트) 그 요소가 라벨-값 구조(dt/dd, th/td) 안에
 * 있는지 먼저 확인해 있으면 라벨 텍스트를, 없으면 CSS 셀렉터를 계산해 후보로 보여주고, 컬럼명을 입력해
 * 저장하면 그 자리에서 sites.extraction_rules에 반영된다 — "스크랩 조정"이 AI로 추측해 만들던 것과 같은
 * 데이터(type:'label'|'selector')를 사용자가 직접 클릭으로 확정하는 대체 경로다. 반복 클릭-입력으로 한
 * 페이지에서 여러 컬럼을 계속 지정할 수 있다. 정확도가 더 높은 것이 목적이라, 라벨을 우선하고(같은 몰의
 * 다른 상품에서도 라벨 텍스트는 대체로 그대로라 셀렉터보다 안정적) 라벨 구조가 없을 때만 셀렉터로 대체한다.
 */
export async function startElementPicker(siteId: number, previewProduct?: Record<string, unknown> | null): Promise<boolean> {
  const context = openSessions.get(siteId)
  if (!context) return false
  const pages = context.pages()
  const page = pages.length ? pages[pages.length - 1] : await context.newPage()

  if (!pickerExposedPages.has(page)) {
    // SELECT로 읽어 JS에서 합친 뒤 UPDATE하면, 여러 필드를 빠르게 연달아 지정할 때 SELECT~UPDATE 사이에
    // 다른 저장이 끼어들어 먼저 저장한 필드가 통째로 사라지는 lost-update가 생긴다(신우 몰에서 실제
    // 보고됨: 상품명 등 여러 개를 연속 지정하니 지정한 것들이 사라짐). Postgres의 jsonb `||`(병합)/
    // `-`(키 제거) 연산자로 한 SQL 문 안에서 원자적으로 처리해 이 경쟁을 없앤다.
    await page.exposeFunction('ptpSavePick', async (payload: { field: string; type: 'label' | 'selector' | 'fixed'; value: string }) => {
      if (!payload.field?.trim()) return
      await pool.query(
        `UPDATE sites SET extraction_rules = COALESCE(extraction_rules, '{}'::jsonb) || jsonb_build_object($1::text, $2::jsonb) WHERE id=$3`,
        [payload.field, JSON.stringify({ type: payload.type, value: payload.value }), siteId],
      )
    })
    await page.exposeFunction('ptpDeletePick', async (field: string) => {
      await pool.query(`UPDATE sites SET extraction_rules = COALESCE(extraction_rules, '{}'::jsonb) - $1::text WHERE id=$2`, [field, siteId])
    })
    pickerExposedPages.add(page)
  }

  // 재주입(페이지 리로드) 때마다 최신 extraction_rules를 다시 읽어 넘긴다 — 저장 직후 미리보기 자동
  // 재실행이 이 페이지를 리로드시키므로, 목록의 "등록됨" 표시가 항상 DB 상태와 맞도록.
  // previewProduct(미리보기 값)는 "스크랩 대상 직접지정" 시작 시점의 스냅샷을 그대로 재사용한다 —
  // 다시 최신화하려면 종료 후 다시 시작하면 된다(그때 새 미리보기 값을 다시 넘겨받음).
  async function inject() {
    const res = await pool.query<{ extraction_rules: Record<string, ExtractionRule> | null }>(
      'SELECT extraction_rules FROM sites WHERE id=$1', [siteId],
    )
    await page.evaluate(injectElementPicker, { previewProduct: previewProduct || null, extractionRules: res.rows[0]?.extraction_rules || {} })
  }

  if (!pickerNavHandlers.has(page)) {
    const onLoad = () => { inject().catch(() => {}) }
    page.on('load', onLoad)
    pickerNavHandlers.set(page, onLoad)
  }

  await inject()
  return true
}

/** "완료" — 주입된 피커의 하이라이트/클릭 리스너와 안내 패널을 제거한다. */
export async function stopElementPicker(siteId: number): Promise<boolean> {
  const context = openSessions.get(siteId)
  if (!context) return false
  const pages = context.pages()
  const page = pages[pages.length - 1]
  if (!page) return false
  const onLoad = pickerNavHandlers.get(page)
  if (onLoad) { page.off('load', onLoad); pickerNavHandlers.delete(page) }
  await page.evaluate(() => (window as unknown as { __ptpPickerTeardown?: () => void }).__ptpPickerTeardown?.()).catch(() => {})
  return true
}

/** 실제 몰 페이지 안에서 실행되는 함수 — page.evaluate로 그대로 주입된다(문자열이 아니라 함수 자체를
 *  Playwright가 직렬화). 이미 켜져 있으면 다시 켜지 않는다(같은 페이지에서 "스크랩 대상 직접지정 시작"을 또 눌러도
 *  리스너가 중복 등록되지 않도록). */
function injectElementPicker(seed?: { previewProduct: Record<string, unknown> | null; extractionRules: Record<string, { type: string; value: string }> }) {
  const w = window as unknown as {
    __ptpPickerActive?: boolean
    __ptpPickerTeardown?: () => void
    ptpSavePick: (payload: { field: string; type: 'label' | 'selector' | 'fixed'; value: string }) => Promise<void>
    ptpDeletePick: (field: string) => Promise<void>
  }
  if (w.__ptpPickerActive) return
  w.__ptpPickerActive = true

  const previewProduct = seed?.previewProduct || null
  // 재주입될 때마다 최신값으로 갱신되지만(다음 값들 참고), 저장/삭제 직후에는 로컬에서 즉시 반영해 화면이
  // 리로드를 기다리지 않고 바로 "등록됨" 표시를 보여주도록 한다.
  const rulesLocal: Record<string, { type: string; value: string }> = { ...(seed?.extractionRules || {}) }
  // 지금 "요소로 지정" 모드로 선택해둔 필드 — null이 아니면 다음 클릭이 이 필드에 저장된다. 목록에서
  // 컬럼을 먼저 고르고(선택) 화면에서 요소를 클릭 → 저장하는 순서를 반복할 수 있게 한다.
  let armedField: string | null = null
  // 방금 지정한(클릭했거나 직접 입력한) "실제 값" — 규칙 자체(라벨/셀렉터 패턴)와 달리 화면에 곧바로
  // 보여줄 목적으로만 쓴다. 지정하는 순간 그 자리에서 확인할 수 있어야 한다는 요청으로 추가.
  const lastValueLocal: Record<string, string> = {}
  // "직접 입력" 칸을 펼쳐둔 필드 집합 — 평소엔 접어둬 목록이 덜 복잡해 보이게 한다.
  const expandedInputs = new Set<string>()

  const CANONICAL_FIELDS: [string, string][] = [
    ['name', '상품명'], ['price', '가격(소비자가)'], ['cost_price', '공급가/원가'], ['shipping_fee', '배송비'],
    ['category', '카테고리'], ['brand', '브랜드'], ['manufacturer', '제조사'], ['origin', '원산지'],
    ['stock_status', '재고상태'], ['stock_qty', '재고수량'], ['english_name', '영문상품명'], ['summary_info', '상품요약정보'],
    ['thumbnail_urls', '대표이미지'], ['detail_image_urls', '상세이미지'],
  ]
  // 대표/상세이미지는 이미지가 여러 장이라 클릭한 요소 하나만이 아니라 그 갤러리 전체(같은 부모 아래
  // img들)를 가리키는 셀렉터가 필요하다 — 일반 텍스트 필드와 다른 값 하나=요소 하나 모델이라 별도 취급.
  const IMAGE_FIELDS = new Set(['thumbnail_urls', 'detail_image_urls'])

  function esc(s: unknown): string {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string))
  }

  // 미리보기 그리드에 나온 값을 필드별로 그대로 보여준다 — "스크랩 대상 직접지정" 시작 시점의 스냅샷.
  function currentValue(field: string): string {
    if (!previewProduct) return ''
    const p = previewProduct as Record<string, unknown>
    switch (field) {
      case 'price': return p.price != null ? `₩${Number(p.price).toLocaleString()}` : ''
      case 'cost_price': return p.cost_price != null ? `₩${Number(p.cost_price).toLocaleString()}` : ''
      case 'shipping_fee': return p.shipping_fee != null ? String(p.shipping_fee) : ''
      case 'stock_qty': return p.stock_qty != null ? String(p.stock_qty) : ''
      case 'thumbnail_urls': return Array.isArray(p.thumbnail_urls) && p.thumbnail_urls.length ? `이미지 ${p.thumbnail_urls.length}장` : ''
      case 'detail_image_urls': return Array.isArray(p.detail_image_urls) && p.detail_image_urls.length ? `이미지 ${p.detail_image_urls.length}장` : ''
      case 'name': case 'category': case 'brand': case 'manufacturer': case 'origin':
      case 'stock_status': case 'english_name': case 'summary_info':
        return (p[field] as string) || ''
      default: {
        const custom = p.custom_fields as Record<string, string> | undefined
        return custom?.[field] || ''
      }
    }
  }

  let hovered: HTMLElement | null = null
  const HOVER_OUTLINE = '2px solid #14b8a6'

  function onMouseOver(e: MouseEvent) {
    if (!armedField) return // 필드를 선택해 "지정 모드"일 때만 하이라이트해 무엇을 클릭할지 헷갈리지 않게 한다
    const el = e.target as HTMLElement
    if (el === panel || panel.contains(el)) return
    if (hovered && hovered !== el) hovered.style.outline = ''
    hovered = el
    hovered.style.outline = HOVER_OUTLINE
  }

  // dt/dd, th/td 라벨-값 구조 안에 있으면 라벨 텍스트를 우선 쓴다 — 같은 몰의 다른 상품에서도 텍스트가
  // 대체로 그대로라 CSS 셀렉터보다 안정적이다(실사용 확인된 패턴).
  function detectLabel(target: HTMLElement): string | null {
    let el: HTMLElement | null = target
    for (let i = 0; i < 4 && el; i++, el = el.parentElement) {
      if (el.tagName === 'DD') {
        const dt = el.previousElementSibling
        if (dt && dt.tagName === 'DT') return (dt.textContent || '').trim()
      }
      if (el.tagName === 'TD') {
        const tr = el.closest('tr')
        const th = tr?.querySelector('th')
        if (th) return (th.textContent || '').trim()
      }
    }
    return null
  }

  function computeSelector(target: HTMLElement): string {
    if (target.id) return '#' + CSS.escape(target.id)
    const parts: string[] = []
    let node: HTMLElement | null = target
    let depth = 0
    while (node && node.tagName !== 'BODY' && depth < 6) {
      let sel = node.tagName.toLowerCase()
      if (node.className && typeof node.className === 'string' && node.className.trim()) {
        const cls = node.className.trim().split(/\s+/).filter(Boolean).slice(0, 2)
        if (cls.length) sel += '.' + cls.map(c => CSS.escape(c)).join('.')
      }
      const parent: HTMLElement | null = node.parentElement
      if (parent) {
        const siblings = Array.from(parent.children).filter(s => s.tagName === node!.tagName)
        if (siblings.length > 1) sel += `:nth-of-type(${siblings.indexOf(node) + 1})`
      }
      parts.unshift(sel)
      const candidate = parts.join(' > ')
      if (document.querySelectorAll(candidate).length === 1) return candidate
      node = parent
      depth++
    }
    return parts.join(' > ')
  }

  // 대표/상세이미지 지정용 — 클릭한 게 <img> 자체면 그 부모를(형제 img들도 같이 잡히도록), 이미지를 담은
  // 컨테이너를 클릭했으면 그 컨테이너를 기준으로 "... img"를 셀렉터에 붙여 갤러리 전체를 가리키게 한다.
  function computeGallerySelector(target: HTMLElement): string {
    const container = target.tagName === 'IMG' ? (target.parentElement || target) : target
    return computeSelector(container) + ' img'
  }

  // 안내 패널 — 몰 페이지 자체 CSS와 충돌하지 않도록 인라인 스타일만 쓴다.
  const panel = document.createElement('div')
  panel.id = 'ptp-picker-panel'
  panel.style.cssText = 'position:fixed;top:12px;right:12px;z-index:2147483647;background:#fff;border:2px solid #14b8a6;'
    + 'border-radius:12px;padding:12px;width:320px;font:12px/1.4 -apple-system,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.2);color:#333'
  panel.innerHTML = `
    <div id="ptp-picker-drag" style="margin-bottom:6px;cursor:move;user-select:none">
      <div style="font-size:9px;color:#999;letter-spacing:.02em">PTP 직접지정 패널</div>
      <div style="font-weight:600">⠿ 🎯 스크랩 대상 직접지정</div>
    </div>
    <div style="font-size:10px;color:#888;margin-bottom:6px;line-height:1.5">① 필드 선택 → ② 몰 화면에서 값 클릭 → ③ 자동 저장 — 반복하세요</div>
    <div id="ptp-picker-status" style="color:#2563eb;font-weight:600;margin-bottom:8px;display:none"></div>
    <div id="ptp-picker-fieldlist" style="max-height:320px;overflow-y:auto;border-top:1px solid #eee;border-bottom:1px solid #eee;margin:8px 0;padding:4px 0"></div>
    <div id="ptp-picker-log" style="margin-top:4px;color:#0d9488;max-height:50px;overflow:auto"></div>
    <button id="ptp-picker-close" style="margin-top:8px;width:100%;background:#14b8a6;color:#fff;border:0;border-radius:6px;padding:6px;cursor:pointer">💾 피커 저장</button>
  `
  document.body.appendChild(panel)

  // 패널 위치를 드래그로 옮길 수 있게 한다 — 몰 페이지의 값을 가리는 경우 옆으로 치울 수 있어야 한다.
  // 처음엔 top/right로 고정돼 있으니, 드래그가 시작되는 순간 현재 화면 위치를 left/top 절대값으로
  // 바꿔치기해야 마우스를 따라 자연스럽게 움직인다(right를 그대로 두면 반대 방향으로 계산해야 해서 헷갈림).
  const dragHandle = panel.querySelector('#ptp-picker-drag') as HTMLElement
  let dragOffsetX = 0
  let dragOffsetY = 0
  function onDragMove(e: MouseEvent) {
    const maxLeft = window.innerWidth - panel.offsetWidth
    const maxTop = window.innerHeight - panel.offsetHeight
    panel.style.left = Math.min(Math.max(0, e.clientX - dragOffsetX), Math.max(0, maxLeft)) + 'px'
    panel.style.top = Math.min(Math.max(0, e.clientY - dragOffsetY), Math.max(0, maxTop)) + 'px'
    panel.style.right = 'auto'
  }
  function onDragEnd() {
    document.removeEventListener('mousemove', onDragMove)
    document.removeEventListener('mouseup', onDragEnd)
  }
  dragHandle.addEventListener('mousedown', (e: MouseEvent) => {
    const rect = panel.getBoundingClientRect()
    dragOffsetX = e.clientX - rect.left
    dragOffsetY = e.clientY - rect.top
    document.addEventListener('mousemove', onDragMove)
    document.addEventListener('mouseup', onDragEnd)
    e.preventDefault()
  })

  const statusEl = panel.querySelector('#ptp-picker-status') as HTMLElement
  const logEl = panel.querySelector('#ptp-picker-log') as HTMLElement
  const fieldListEl = panel.querySelector('#ptp-picker-fieldlist') as HTMLElement

  function logLine(field: string) {
    const line = document.createElement('div')
    line.textContent = `✓ ${field}`
    logEl.prepend(line)
  }

  function updateStatus() {
    if (armedField) {
      const label = (CANONICAL_FIELDS.find(([k]) => k === armedField)?.[1]) || armedField
      statusEl.textContent = `👉 "${label}" 지정 중 — 몰 화면에서 값을 클릭하세요`
      statusEl.style.display = 'block'
    } else {
      statusEl.textContent = ''
      statusEl.style.display = 'none'
    }
  }

  function saveField(field: string, type: 'label' | 'selector' | 'fixed', value: string, displayValue: string) {
    rulesLocal[field] = { type, value }
    lastValueLocal[field] = displayValue
    void w.ptpSavePick({ field, type, value })
    logLine(field)
  }

  // 클릭한 요소 자체의 텍스트 — 저장되는 규칙(라벨/셀렉터 패턴)과 별개로, "방금 뭘 지정했는지" 그
  // 자리에서 바로 보여주기 위한 값이다.
  function elementDisplayText(el: HTMLElement): string {
    const clone = el.cloneNode(true) as HTMLElement
    clone.querySelectorAll('.layer_area, [style*="display:none" i], [style*="display: none" i], #ptp-picker-panel').forEach(n => n.remove())
    return (clone.textContent || '').trim().slice(0, 60)
  }

  // 미리보기 그리드에 대응하는 필드들을 세로로 나열 — 컬럼을 먼저 선택("요소로 지정")한 뒤 화면에서
  // 관련 요소를 클릭해 저장하고, 이어서 다음 컬럼도 같은 순서로 반복할 수 있다. 지정한 값은 그 줄에
  // 바로 표시되고(지정 전엔 미리보기 스냅샷을 참고용으로만 흐리게 보여줌), 요소가 화면에 없는 필드는
  // "✏️ 직접 입력"으로 펼쳐지는 입력칸에 값을 타이핑해 저장할 수 있다.
  function renderFieldList() {
    const extraFields = Object.keys(rulesLocal).filter(k => !CANONICAL_FIELDS.some(([key]) => key === k))
    const allFields = [...CANONICAL_FIELDS.map(([k, l]) => ({ key: k, label: l })), ...extraFields.map(k => ({ key: k, label: k }))]
    const rowsHtml = allFields.map(({ key, label }) => {
      const rule = rulesLocal[key]
      const armed = armedField === key
      const expanded = expandedInputs.has(key)
      const rowBg = armed ? '#eff6ff' : rule ? '#f0fdfa' : '#fff'
      const rowBorder = armed ? '#60a5fa' : rule ? '#5eead4' : '#eee'
      const badge = rule
        ? `<span style="font-size:10px;background:#fff;color:#0d9488;border:1px solid #5eead4;border-radius:8px;padding:1px 6px;white-space:nowrap">${rule.type === 'label' ? '📋 라벨' : rule.type === 'fixed' ? '✏️ 고정값' : '🔗 셀렉터'}</span>`
        : ''
      const valueLine = rule
        ? `<div style="font-size:12px;color:#0d9488;font-weight:600;margin:3px 0;word-break:break-all">${esc(lastValueLocal[key] ?? currentValue(key)) || '(값 없음)'}</div>`
        : `<div style="font-size:10px;color:#bbb;margin:3px 0">미지정${currentValue(key) ? ` — 현재 스크랩 값: ${esc(currentValue(key))}` : ''}</div>`
      const delBtn = rule
        ? `<button class="ptp-row-del" data-field="${esc(key)}" title="삭제" style="background:#fff;color:#e11d48;border:1px solid #fca5a5;border-radius:5px;padding:3px 7px;font-size:10px;cursor:pointer">✕</button>`
        : ''
      const armBtnStyle = armed
        ? 'flex:1;background:#2563eb;color:#fff;border:1px solid #2563eb'
        : rule
          ? 'background:#fff;color:#2563eb;border:1px solid #2563eb'
          : 'flex:1;background:#2563eb;color:#fff;border:1px solid #2563eb'
      const inputRow = expanded ? `
          <div style="display:flex;gap:4px;margin-top:5px">
            <input class="ptp-row-input" data-field="${esc(key)}" placeholder="값 입력" style="flex:1;min-width:0;padding:3px 5px;border:1px solid #ccc;border-radius:5px;font-size:11px" />
            <button class="ptp-row-save" data-field="${esc(key)}" style="background:#14b8a6;color:#fff;border:0;border-radius:5px;padding:3px 8px;font-size:11px;cursor:pointer">저장</button>
          </div>` : ''
      return `
        <div style="padding:7px 7px;margin:3px 0;border:1px solid ${rowBorder};background:${rowBg};border-radius:8px">
          <div style="display:flex;justify-content:space-between;gap:4px;align-items:baseline">
            <span style="font-size:11px">${rule ? '✅' : '⬜'} <b style="font-size:11px">${esc(label)}</b></span>
            ${badge}
          </div>
          ${valueLine}
          <div style="display:flex;gap:4px;align-items:center;margin-top:2px">
            <button class="ptp-row-arm" data-field="${esc(key)}"
              style="${armBtnStyle};border-radius:5px;padding:4px 6px;font-size:10px;cursor:pointer">
              ${armed ? '❌ 클릭 대기 취소' : rule ? '🎯 다시 지정' : '🎯 클릭해서 지정하기'}
            </button>
            ${delBtn}
          </div>
          <a class="ptp-row-toggle" data-field="${esc(key)}" style="display:inline-block;margin-top:4px;font-size:10px;color:#888;text-decoration:underline;cursor:pointer">
            ${expanded ? '접기' : '값 직접 입력하기'}
          </a>
          ${inputRow}
        </div>
      `
    }).join('') + `
      <div style="padding:7px 7px;margin:3px 0;border:1px dashed #ccc;border-radius:8px">
        <div style="font-size:10px;color:#888;margin-bottom:4px">새 컬럼 만들기</div>
        <input id="ptp-new-field-name" placeholder="컬럼명 (예: 택배사)" style="width:100%;margin-bottom:4px;padding:3px 5px;border:1px solid #ccc;border-radius:5px;font-size:11px;box-sizing:border-box" />
        <div style="display:flex;gap:4px">
          <button id="ptp-new-field-arm" style="flex:1;background:#2563eb;color:#fff;border:1px solid #2563eb;border-radius:5px;padding:4px 6px;font-size:10px;cursor:pointer">🎯 클릭해서 지정하기</button>
        </div>
        <div style="display:flex;gap:4px;margin-top:4px">
          <input id="ptp-new-field-value" placeholder="또는 값 직접 입력" style="flex:1;min-width:0;padding:3px 5px;border:1px solid #ccc;border-radius:5px;font-size:11px" />
          <button id="ptp-new-field-add" style="background:#14b8a6;color:#fff;border:0;border-radius:5px;padding:3px 8px;font-size:11px;cursor:pointer">저장</button>
        </div>
      </div>
    `
    fieldListEl.innerHTML = rowsHtml

    fieldListEl.querySelectorAll<HTMLButtonElement>('.ptp-row-arm').forEach(btn => {
      btn.addEventListener('click', () => {
        const field = btn.dataset.field!
        armedField = armedField === field ? null : field
        if (hovered) { hovered.style.outline = ''; hovered = null }
        renderFieldList()
        updateStatus()
      })
    })
    fieldListEl.querySelectorAll<HTMLElement>('.ptp-row-toggle').forEach(btn => {
      btn.addEventListener('click', () => {
        const field = btn.dataset.field!
        if (expandedInputs.has(field)) expandedInputs.delete(field); else expandedInputs.add(field)
        renderFieldList()
      })
    })
    fieldListEl.querySelectorAll<HTMLButtonElement>('.ptp-row-save').forEach(btn => {
      btn.addEventListener('click', () => {
        const field = btn.dataset.field!
        const input = fieldListEl.querySelector<HTMLInputElement>(`.ptp-row-input[data-field="${CSS.escape(field)}"]`)
        const value = input?.value.trim()
        if (!value) return
        saveField(field, 'fixed', value, value)
        expandedInputs.delete(field)
        renderFieldList()
      })
    })
    fieldListEl.querySelectorAll<HTMLButtonElement>('.ptp-row-del').forEach(btn => {
      btn.addEventListener('click', () => {
        const field = btn.dataset.field!
        delete rulesLocal[field]
        delete lastValueLocal[field]
        void w.ptpDeletePick(field)
        renderFieldList()
      })
    })
    fieldListEl.querySelector('#ptp-new-field-arm')!.addEventListener('click', () => {
      const nameEl = fieldListEl.querySelector<HTMLInputElement>('#ptp-new-field-name')!
      const field = nameEl.value.trim()
      if (!field) { nameEl.focus(); return }
      armedField = armedField === field ? null : field
      if (hovered) { hovered.style.outline = ''; hovered = null }
      renderFieldList()
      updateStatus()
    })
    fieldListEl.querySelector('#ptp-new-field-add')!.addEventListener('click', () => {
      const nameEl = fieldListEl.querySelector<HTMLInputElement>('#ptp-new-field-name')!
      const valueEl = fieldListEl.querySelector<HTMLInputElement>('#ptp-new-field-value')!
      const field = nameEl.value.trim()
      const value = valueEl.value.trim()
      if (!field || !value) return
      saveField(field, 'fixed', value, value)
      renderFieldList()
    })
  }
  renderFieldList()

  function onClick(e: MouseEvent) {
    const el = e.target as HTMLElement
    if (el === panel || panel.contains(el)) return // 안내 패널 자체 클릭은 무시(버튼 클릭이 정상 동작하도록)
    if (!armedField) return // 아직 목록에서 필드를 선택하지 않았으면 페이지 클릭은 그냥 통과시킨다
    e.preventDefault()
    e.stopPropagation()

    if (IMAGE_FIELDS.has(armedField)) {
      const selector = computeGallerySelector(el)
      const count = document.querySelectorAll(selector).length
      saveField(armedField, 'selector', selector, count ? `이미지 ${count}장` : '(이미지를 찾지 못함)')
    } else {
      const label = detectLabel(el)
      const rule = label ? { type: 'label' as const, value: label } : { type: 'selector' as const, value: computeSelector(el) }
      saveField(armedField, rule.type, rule.value, elementDisplayText(el))
    }
    armedField = null
    renderFieldList()
    updateStatus()
    if (hovered) { hovered.style.outline = ''; hovered = null }
  }

  panel.querySelector('#ptp-picker-close')!.addEventListener('click', () => w.__ptpPickerTeardown?.())

  document.addEventListener('mouseover', onMouseOver, true)
  document.addEventListener('click', onClick, true)

  w.__ptpPickerTeardown = () => {
    // 각 줄에 열어둔 채 저장 버튼을 안 누른 입력값(직접 입력 칸, 새 컬럼 이름/값)이 있으면 닫기 전에
    // 마저 저장한다 — 타이핑만 하고 저장을 안 누른 채 닫아서 값이 유실되는 걸 막는다. 패널의 "피커
    // 저장" 버튼과, PTP 화면의 "스크랩 대상 직접지정 종료"(stopElementPicker가 이 함수를 원격으로
    // 호출) 둘 다 같은 teardown을 타므로, 여기 한 곳에 둬야 어느 쪽으로 끝내도 동일하게 동작한다.
    fieldListEl.querySelectorAll<HTMLInputElement>('.ptp-row-input').forEach(input => {
      const value = input.value.trim()
      if (value) saveField(input.dataset.field!, 'fixed', value, value)
    })
    const newNameEl = fieldListEl.querySelector<HTMLInputElement>('#ptp-new-field-name')
    const newValueEl = fieldListEl.querySelector<HTMLInputElement>('#ptp-new-field-value')
    if (newNameEl?.value.trim() && newValueEl?.value.trim()) {
      saveField(newNameEl.value.trim(), 'fixed', newValueEl.value.trim(), newValueEl.value.trim())
    }
    document.removeEventListener('mouseover', onMouseOver, true)
    document.removeEventListener('click', onClick, true)
    onDragEnd() // 드래그 도중 종료를 눌렀을 수도 있어 남아있을 수 있는 리스너를 정리
    if (hovered) hovered.style.outline = ''
    panel.remove()
    w.__ptpPickerActive = false
    w.__ptpPickerTeardown = undefined
  }
}

/**
 * profileMallStructure와 같은 프로파일링을, "로그인 확인" 시 열려있던 화면(openSessions)이 아니라
 * 실제 스크래핑이 이번에 쓸 브라우저 컨텍스트를 그대로 재사용해 수행한다. 직접로그인 필수 몰처럼
 * openSessions에 추적되는 세션이 없는 경우에도(개인 크롬을 헤드리스로 재사용하는 경로 포함) 스크래핑
 * 시작 시점마다 동작하도록 하기 위한 것 — withContext가 이미 모든 몰 유형을 알아서 처리해준다.
 */
export async function profileMallStructureForScrape(opts: ScrapeOptions): Promise<MallProfileSignals | null> {
  if (!opts.siteId) return null
  // 실패한 상품만 재시도하는 등 productUrls만 있고 url/categoryUrls가 없는 호출도 있어, 새로 여는 빈 탭의
  // about:blank를 그대로 시작점으로 쓰지 않도록 productUrls의 첫 항목을 대신 사용한다.
  const startUrlHint = opts.url || opts.categoryUrls?.[0] || opts.productUrls?.[0]
  if (!startUrlHint) return null
  const site = await siteInfo(opts.siteId)
  // 스크랩 시작 시점의 자동 체크도 로그인 확인과 같은 용도(구조 변화 감지)라 항상 가벼운(deep=false) 쪽만 쓴다.
  return withContext(opts, page => sampleMallProfile(page, startUrlHint, site.name, false))
}

async function sampleMallProfile(page: Page, startUrl: string, mallName: string, deep: boolean): Promise<MallProfileSignals | null> {
  let sampleUrls: string[] = []
  let platform: MallPlatform = 'unknown'
  let categoryByUrl = new Map<string, CategoryLabel>()
  try {
    const collected = await collectProductUrls(page, { maxPages: 1 })
    sampleUrls = collected.urls.slice(0, MALL_PROFILE_SAMPLE_SIZE)
    platform = collected.platform
    categoryByUrl = collected.categoryByUrl
  } catch { /* 카탈로그로 인식되지 않으면 아래에서 현재 페이지를 상품 페이지 1건으로 취급 */ }
  if (!sampleUrls.length) sampleUrls = [startUrl]
  // 카탈로그로 인식되지 않아 platform이 못 잡혔으면(위 예외로 빠진 경우), 지금 보고 있는 페이지 자체에서
  // 다시 감지한다 — 상품 상세페이지도 플랫폼 감지에 필요한 generator/스크립트 태그는 대부분 그대로 갖고 있다.
  if (platform === 'unknown') platform = await detectMallPlatform(page).catch(() => 'unknown' as MallPlatform)
  // 아직 상품 샘플로 이동하기 전(현재 page가 startUrl), 헤더 내비게이션에서 전체 카테고리 메뉴를 스캔한다 —
  // 이동 후엔 이 몰의 헤더가 안 보일 수 있어 반드시 여기서 먼저 해야 한다.
  const categoryMenuNames = await scanCategoryMenu(page)
  // 같은 이유로, 상품 샘플로 이동하기 전에 지금 페이지(홈/목록)의 하단 회사정보와 이용안내·공지 등
  // 게시판 링크를 먼저 훑어 원문을 모아둔다 — 결제계좌/택배사/연락처는 상품페이지가 아니라 이런 정적
  // 페이지에 있다(실사용 몰 확인됨). deep(=="몰 구조 파악" 버튼)에서만 하는 무거운 작업이라 로그인
  // 확인/스크랩 시작마다 도는 가벼운 체크에서는 건너뛴다. 페이지 이동이 있어 시간이 들 수 있어 실패해도
  // 나머지 흐름은 계속한다.
  const contextText = deep ? await gatherMallContextText(page).catch(() => '') : ''

  const signals: MallProfileSignals = {
    sampleCount: 0, platform, sampleProductUrl: sampleUrls[0], hasMainImages: false, hasDetailImages: false,
    optionUiTypes: [], hasCascadingOptions: false, hasStockQty: false, hasStockStatusText: false,
    hasStockByOption: false, hasDetailText: false, infoLabels: [], categoryPaths: [], categoryMaxDepth: 0,
    categoryMenuNames, report: null,
  }
  const optionTypes = new Set<'select' | 'swatch' | 'none'>()
  const infoLabelSet = new Set<string>()
  const categoryPathSet = new Set<string>()
  let productContextText = ''

  for (const url of sampleUrls) {
    const category = categoryByUrl.get(url)?.category
    if (category) categoryPathSet.add(category)
    try {
      await page.goto(url, { waitUntil: 'load', timeout: 20_000 })
      await waitForExtractableContent(page)
      const product = await extractProductRuleBased(page, url)
      const selectOptions = await scanSelectOptions(page)
      const swatchOptions = selectOptions.length ? [] : await scanSwatchOptions(page)
      optionTypes.add(selectOptions.length ? 'select' : swatchOptions.length ? 'swatch' : 'none')

      const domOptions = await extractOptionsFromDom(page)
      if (domOptions.options.length) product.options = domOptions.options
      if (domOptions.combinations.length) product.option_combinations = domOptions.combinations
      await applyStockByOption(page, product)

      signals.sampleCount++
      if (product.thumbnail_urls.length > 0) signals.hasMainImages = true
      if (product.detail_image_urls.length > 0) signals.hasDetailImages = true
      if (product.detail_text) signals.hasDetailText = true
      if (product.stock_qty != null) signals.hasStockQty = true
      if (product.stock_status && product.stock_status !== '판매중') signals.hasStockStatusText = true
      if (product.stock_by_option.length > 0) signals.hasStockByOption = true
      if (product.options.length > 1) signals.hasCascadingOptions = true
      product.extra_info.forEach(({ label }) => infoLabelSet.add(label))
      // AI 리포트용 원문은 상품 1건만 있으면 충분해(토큰 절약) 첫 성공 샘플에서만 모은다. deep 전용.
      if (deep && !productContextText) {
        const bodyText = await page.evaluate(() => document.body.innerText).catch(() => '')
        productContextText = `[샘플 상품페이지: ${url}]\n${bodyText.replace(/\s+/g, ' ').trim().slice(0, 4_000)}`
      }
    } catch { /* 개별 샘플 실패는 건너뛰고 다음 샘플로 */ }
  }
  signals.optionUiTypes = [...optionTypes]
  signals.infoLabels = [...infoLabelSet].sort()
  signals.categoryPaths = [...categoryPathSet].sort()
  signals.categoryMaxDepth = signals.categoryPaths.reduce((max, p) => Math.max(max, p.split(' > ').length), 0)

  if (deep) {
    const combinedContext = [contextText, productContextText].filter(Boolean).join('\n\n')
    const categoryHints = categoryMenuNames.length ? categoryMenuNames : signals.categoryPaths
    // ANTHROPIC_API_KEY 크레딧이 없어 AI 호출이 안 되는 경우(월 정액 구독으로는 대체 불가 — API 과금과는
    // 별개)에도 "몰 구조 파악"이 결과 없이 끝나지 않도록, AI 실패 시 규칙 기반 리포트로 대체한다.
    signals.report = await generateMallProfileReport(mallName, platform, categoryHints, signals.sampleProductUrl, combinedContext).catch(() => null)
      ?? buildHeuristicMallReport({
        platform, categoryHints, sampleProductUrl: signals.sampleProductUrl, contextText: combinedContext,
        optionUiTypes: signals.optionUiTypes, hasCascadingOptions: signals.hasCascadingOptions,
        hasMainImages: signals.hasMainImages, hasDetailImages: signals.hasDetailImages, hasDetailText: signals.hasDetailText,
        hasStockQty: signals.hasStockQty, hasStockStatusText: signals.hasStockStatusText, hasStockByOption: signals.hasStockByOption,
      })
  }

  await page.goto(startUrl, { waitUntil: 'load', timeout: 20_000 }).catch(() => {})
  return signals.sampleCount > 0 ? signals : null
}

/** 고도몰 등에서 결제계좌/택배사/업체연락처가 있는 곳은 상품페이지가 아니라 하단 회사정보와 이용안내·
 *  공지사항 같은 정적 게시판이다(실사용 몰 확인됨). 지금 페이지의 footer와, 안내성 키워드가 붙은 링크
 *  몇 개를 실제로 열어 텍스트를 모아온다 — "몰 구조 파악"의 AI 리포트가 근거로 삼을 원문. */
async function gatherMallContextText(page: Page): Promise<string> {
  const sections: string[] = []
  const footerText = await page.evaluate(() => {
    const el = document.querySelector('footer, #footer, .footer, .company_info, .footer_info')
    return (el?.textContent || '').replace(/\s+/g, ' ').trim()
  }).catch(() => '')
  if (footerText) sections.push(`[하단 회사정보]\n${footerText.slice(0, 1_500)}`)

  const baseUrl = new URL(page.url()).origin
  const links = await findInfoPageLinks(page)
  for (const link of links) {
    if (!link.href.startsWith(baseUrl)) continue
    try {
      await page.goto(link.href, { waitUntil: 'load', timeout: 15_000 })
      const text = await page.evaluate(() => document.body.innerText).catch(() => '')
      if (text.trim()) sections.push(`[${link.text}]\n${text.replace(/\s+/g, ' ').trim().slice(0, 2_500)}`)
    } catch { /* 게시판 접근 실패(로그인 필요 등)는 건너뛰고 다음 링크로 */ }
  }
  return sections.join('\n\n')
}

const INFO_PAGE_KEYWORDS = /배송|반품|교환|환불|이용안내|이용약관|회사소개|공지|고객센터|무통장|계좌|입금안내/
// 메뉴/푸터의 안내 링크는 보통 짧은 라벨("이용안내", "배송/교환/환불")이다 — 길이 제한 없이 매칭하면
// "GE_5645 28인치캐리어/배송비별도"처럼 "배송"을 우연히 포함한 홈페이지 추천상품 링크가 걸려, 그 4개
// 한도를 상품 링크가 다 채워버려 정작 진짜 안내 페이지(이용안내 등)를 못 찾는 문제가 실제 발견됐다
// (가방쟁이). 안내 링크 라벨은 길어야 15자 안팎이라 그보다 긴 텍스트는 제외한다.
const INFO_PAGE_MAX_TEXT_LEN = 15

/** 현재 페이지의 링크 중 배송/결제/공지 등 안내성 키워드가 붙은 것만 최대 4개 골라온다. */
async function findInfoPageLinks(page: Page): Promise<{ text: string; href: string }[]> {
  return page.evaluate(({ pattern, maxLen }: { pattern: string; maxLen: number }) => {
    const re = new RegExp(pattern)
    const seen = new Set<string>()
    const result: { text: string; href: string }[] = []
    document.querySelectorAll('a[href]').forEach(a => {
      const text = (a.textContent || '').trim()
      const href = (a as HTMLAnchorElement).href
      if (!text || text.length > maxLen || !href.startsWith('http') || !re.test(text) || seen.has(href)) return
      seen.add(href)
      result.push({ text, href })
    })
    return result.slice(0, 4)
  }, { pattern: INFO_PAGE_KEYWORDS.source, maxLen: INFO_PAGE_MAX_TEXT_LEN }).catch(() => [])
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
        const product = await extractProductRuleBased(page, sourceUrl, selectorOverrides(opts), opts.extractionRules)
        const domOptions = await extractOptionsFromDom(page)
        if (domOptions.options.length) product.options = domOptions.options
        if (domOptions.combinations.length) product.option_combinations = domOptions.combinations
        await applyStockByOption(page, product)
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

/** "스크랩 조정" 기능(일반모드)이 AI에게 실제 페이지를 보여주기 위해 원문을 그대로 가져온다. */
export async function fetchPageText(opts: ScrapeOptions & { url: string }): Promise<string> {
  return withContext(opts, async page => {
    await page.goto(opts.url, { waitUntil: 'load', timeout: 30_000 })
    await loginIfNeeded(page, opts)
    return page.content()
  })
}

/**
 * "스크랩 조정" 기능(개발자모드)이 확장으로 캡처해온 HTML 문자열을 새 규칙으로 재추출해 미리보기를
 * 만든다. 개발자모드 몰은 PC인증 등으로 Playwright가 직접 로그인/탐색을 못 해(withContext의
 * isManualLoginSite 분기는 이 몰에서 이미 죽은 방식이라 쓸 수 없다) siteId 없이 완전히 새 헤드리스
 * 브라우저를 하나 띄워, 이미 손에 있는 정적 HTML을 page.setContent로 그대로 렌더링만 시켜서 기존
 * 규칙기반 추출 로직(extractProductRuleBased)을 그대로 재사용한다 — 실제 사이트 접속은 전혀 없다.
 */
export async function extractFromHtml(
  html: string, url: string, extractionRules?: Record<string, ExtractionRule>,
): Promise<ExtractedProduct> {
  const browser = await chromium.launch({ headless: true, channel: 'chrome', chromiumSandbox: true })
  try {
    const context = await browser.newContext()
    const page = await context.newPage()
    await page.setContent(html, { waitUntil: 'domcontentloaded' })
    return await extractProductRuleBased(page, url, undefined, extractionRules)
  } finally {
    await browser.close()
  }
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
    // 홈/목록 페이지는 자기 자신의 URL이 상품 상세 패턴과 무관해 generator 메타/호스트 단서가 전혀 없는
    // 몰(펫투비 실사용 확인됨 — 커스텀 스킨이라 generator 태그도, godomall 관련 호스트 문자열도 없음)에서
    // platform을 못 잡는다. 페이지 안 링크들의 href도 같이 훑어 상품 상세 URL 패턴이 하나라도 있으면
    // 그걸로 판정한다 — 홈페이지에도 베스트/신상품 위젯 등으로 실제 상품 링크는 대부분 존재한다.
    const linkHrefs = Array.from(document.querySelectorAll('a[href]')).map(a => (a as HTMLAnchorElement).href.toLowerCase())
    const anyLinkMatches = (re: RegExp) => linkHrefs.some(h => re.test(h))

    if (generator.includes('cafe24') || hasHost('cafe24.com') || /\/product\/(list|detail)\.html/.test(url) || anyLinkMatches(/\/product\/detail\.html/)) return 'cafe24'
    if (generator.includes('makeshop') || hasHost('makeshop.co.kr') || /shopdetail\.html\?branduid=/.test(url) || anyLinkMatches(/shopdetail\.html\?branduid=/)) return 'makeshop'
    if (generator.includes('godo') || hasHost('godomall') || /goods_view\.php\?goodsno=/.test(url) || anyLinkMatches(/goods_view\.php\?goodsno=/)) return 'godomall'
    return 'unknown'
  })
}

/** 헤더 내비게이션(GNB/LNB)의 카테고리 메뉴를 부모>자식 계층 그대로 스캔한다. 예전엔 고도몰의 몇 가지
 *  스킨(.cate/.ovmenu/.lnb)에서 링크 텍스트를 전부 모아 "이름들의 뭉치"만 만들었는데, 그러면 실제
 *  트리 구조(같은 레벨의 카테고리들, 그 아래 하위 카테고리)가 사라져 "카테고리 구조" 보고서 항목이
 *  상품 몇 개 샘플의 브레드크럼에만 의존하게 되고, 카페24/메이크샵/미확인 플랫폼에서는 아예 빈 배열이라
 *  "확인 안됨"으로만 나오는 문제가 있었다(사용자 보고: "몰구조파악 할 때, 왜 파악한 값이 계속 안나와?").
 *  실제 상품이 들어있는 카테고리는 대개 <ul><li> 중첩 메뉴로 표현되므로, 플랫폼을 가리지 않고 흔한 메뉴
 *  컨테이너 후보를 순서대로 시도해 <li>의 중첩 구조를 그대로 따라가며 "대분류 > 중분류" 경로 문자열을
 *  만든다 — 하위 메뉴가 없는 li는 그 자체가 리프(= 상품이 바로 들어있는 카테고리)로 본다. */
async function scanCategoryMenu(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const ROOT_SELECTORS = [
      '.gnb', '#gnb', '.category', '#category', '.cate', '.ovmenu', '.lnb', '.snb', '.nav_category', 'nav',
    ]
    const isMeaningful = (s: string) => !!s && /[가-힣a-zA-Z0-9]/.test(s)
    // li 자신의 라벨만 읽는다 — 하위 <ul>(다음 레벨 카테고리들) 텍스트가 그대로 섞여 들어가지 않도록
    // 사본에서 중첩 목록을 먼저 제거하고 읽는다(cleanText와 같은 패턴).
    function ownText(li: Element): string {
      const clone = li.cloneNode(true) as Element
      clone.querySelectorAll('ul, ol').forEach(n => n.remove())
      return (clone.textContent || '').trim()
    }
    function buildPaths(li: Element, prefix: string[], depth: number, out: string[]) {
      if (depth > 3 || out.length > 200) return
      const name = ownText(li)
      if (!isMeaningful(name)) return
      const path = [...prefix, name]
      const childLis = Array.from(li.querySelectorAll(':scope > ul > li, :scope > div > ul > li'))
      if (childLis.length) {
        childLis.forEach(sub => buildPaths(sub, path, depth + 1, out))
      } else {
        out.push(path.join(' > '))
      }
    }
    for (const rootSel of ROOT_SELECTORS) {
      const root = document.querySelector(rootSel)
      if (!root) continue
      const topLis = Array.from(root.querySelectorAll(':scope > ul > li, :scope > li'))
      if (!topLis.length) continue
      const out: string[] = []
      topLis.forEach(li => buildPaths(li, [], 0, out))
      // 후보 하나가 우연히 매칭됐을 뿐(카테고리 메뉴가 아닌 다른 위젯)일 위험을 줄이기 위해, 최소 2개
      // 이상 나온 후보만 채택한다.
      if (out.length >= 2) return [...new Set(out)]
    }
    return []
  }).catch(() => [])
}

interface CategoryLabel {
  category: string
  /** 브레드크럼에 "브랜드"라는 카테고리 노드가 있으면(예: 브랜드 > 나이키), 그 바로 아래 항목은 상품
   *  종류 구분이 아니라 실제 브랜드명이다 — 그 값을 따로 뽑아 카테고리에서는 뺀다. */
  brand: string
}

/** 목록 페이지 브레드크럼에서 뽑은 카테고리/브랜드를 상품 상세페이지 추출 결과에 덮어쓴다 — 상세페이지
 *  자체엔 카테고리가 없는 몰이 많아 기본은 이 폴백이 맞다. 다만 "스크랩 대상 직접지정"으로 그 필드를
 *  이미 명시적으로 등록해뒀으면 사용자가 직접 고른 값이 항상 이겨야 하므로 덮어쓰지 않는다 — 이 체크가
 *  없으면 피커로 카테고리/브랜드를 지정해도 다음 스크랩/미리보기에서 자동 감지값으로 되돌아간다. */
function applyCategoryOverride(
  product: ExtractedProduct, category: CategoryLabel | undefined, extractionRules?: Record<string, ExtractionRule>,
) {
  if (category?.category && !extractionRules?.category) product.category = category.category
  if (category?.brand && !extractionRules?.brand) product.brand = category.brand
}

// 목록 페이지의 카테고리 경로(예: "백팩 > 여행용 백팩")를 찾는다. .xans-product-headcategory는 카페24 표준 클래스인데,
// 같은 클래스가 배너 이미지용으로도 쓰여 텍스트가 비어있을 수 있어 모든 매칭 요소 중 텍스트가 있는 것을 찾는다.
async function detectCategoryLabel(page: Page): Promise<CategoryLabel> {
  // .location_wrap 브레드크럼(가방쟁이 등)은 페이지 로드 직후엔 비어있다가 JS로 뒤늦게 채워진다(실제
  // 페이지로 확인 — 채워지기 전에 읽으면 빈 배열이 나와 카테고리를 통째로 놓친다). 이 위젯이 있는
  // 페이지에서만 짧게 기다리고, 없는 몰은 곧장 진행해 불필요한 지연이 없게 한다.
  await page.waitForFunction(() => {
    const wrap = document.querySelector('.location_wrap')
    if (!wrap) return true
    return !!wrap.querySelector('.location_select > .location_tit')?.textContent?.trim()
  }, { timeout: 3_000 }).catch(() => {})

  return page.evaluate(() => {
    // 고도몰의 또 다른 스킨(가방쟁이, 실제 페이지로 확인)은 브레드크럼 각 단계를 .location_select로 감싸,
    // 그 안에 "현재 선택된 이름"(.location_tit)과 그 옆 다른 카테고리로 바로 갈 수 있는 숨겨진 <ul> 드롭다운을
    // 같이 둔다. 아래 범용 로직처럼 <li>를 그대로 다 훑으면 그 드롭다운 대안 목록까지 섞여 카테고리가
    // 완전히 틀어지므로, 이 구조는 .location_tit만 콕 집어 먼저 처리한다.
    const locationTits = Array.from(document.querySelectorAll('.location_wrap .location_select > .location_tit'))
      .map(el => (el.textContent || '').trim()).filter(Boolean)
    if (locationTits.length) return { category: locationTits.join(' > '), brand: '' }

    // .path는 고도몰(펫투비 등) 표준 브레드크럼 클래스 — <li> 없이 "HOME &gt; 강아지 &gt; 간식 &gt; 덴탈껌"
    // 처럼 평문 텍스트+구분자로만 되어 있다(실제 페이지로 확인).
    const candidates = ['.xans-product-headcategory', 'nav[aria-label*="breadcrumb" i]', '.breadcrumb', '.location', '.path']
    for (const sel of candidates) {
      for (const el of Array.from(document.querySelectorAll(sel))) {
        // <li>로 계층이 명확히 나뉘어 있으면 그 경계를 그대로 쓴다 — "/" 기준으로 통째로 쪼개면
        // "SANDAL/MULE"처럼 카테고리명 자체에 "/"가 들어있는 경우까지 잘못 쪼개진다(실제 발견된 사례).
        // <li> 구조가 없는 단순 텍스트 브레드크럼만 예전처럼 "/" 기준으로 나눈다. 각 <li> 자체가 "/ 라벨"
        // 처럼 구분자를 텍스트 안에 그대로 갖고 있는 몰도 있어(실제 발견된 사례) 앞뒤의 "/"·공백은 벗겨낸다.
        const items = Array.from(el.querySelectorAll('li'))
          .map(li => (li.textContent || '').replace(/^[\s/]+|[\s/]+$/g, '').trim())
          .filter(Boolean)
        if (!items.length) {
          // 고도몰의 .path는 <li> 없이 "HOME > 강아지 > 간식"처럼 ">" 구분자를 쓴다 — "/"만 보고 쪼개면
          // 아예 안 쪼개져 "HOME > 강아지 > 간식" 전체가 카테고리명 한 덩어리로 잘못 들어간다. ">"가 있으면
          // 그걸로, 없으면 기존처럼 "/"로 나누고, 맨 앞의 "HOME/홈" 같은 루트 라벨은 카테고리가 아니라 뺀다.
          const raw = (el.textContent || '').trim()
          const parts = (raw.includes('>') ? raw.split('>') : raw.split('/')).map(s => s.trim()).filter(Boolean)
          const text = parts.filter(p => !/^(home|홈)$/i.test(p)).join(' > ')
          if (text) return { category: text, brand: '' }
          continue
        }
        const brandIdx = items.findIndex(t => t === '브랜드')
        if (brandIdx !== -1 && brandIdx + 1 < items.length) {
          return { category: items.slice(0, brandIdx).join(' > '), brand: items[brandIdx + 1] }
        }
        return { category: items.join(' > '), brand: '' }
      }
    }
    return { category: '', brand: '' }
  })
}

interface CollectedLinks {
  urls: string[]
  platform: MallPlatform
  /** 각 상품 URL이 발견된 목록 페이지의 카테고리 경로(및 "브랜드" 카테고리 노드 아래서 뽑은 브랜드명) */
  categoryByUrl: Map<string, CategoryLabel>
  /** 목록 페이지에서 바로 얻을 수 있는 상품명/썸네일 (실제 상품 페이지를 열지 않아 빠른 미리보기용) */
  linkInfo: Map<string, { name: string; thumbnail: string }>
}

// 사용자가 최대 페이지 수를 지정하지 않으면 "다음 페이지" 링크가 더 이상 없을 때까지 끝까지 따라간다 —
// 카테고리가 몇 페이지인지 미리 알 수 없는 게 보통이라 매번 페이지 수를 추측해 입력하게 하지 않는다.
// 이 숫자는 페이지네이션이 무한 루프에 빠지는 몰을 대비한 안전장치용 상한일 뿐, 실제로는 다음 페이지
// 링크가 사라지는 순간(아래 반복문의 break) 그보다 훨씬 먼저 끝난다.
const AUTO_PAGINATION_CAP = 50

/**
 * 카테고리 URL을 그 카테고리의 중간 페이지(예: "...?cate_no=67&page=5")로 입력해도, 페이지네이션은
 * 항상 1페이지부터 끝까지 훑어야 그 페이지 이전에 있던 상품들을 놓치지 않는다 — "다음 페이지" 링크를
 * 따라가는 방식만으로는 중간 페이지에서 시작하면 그 이전 페이지들을 영영 못 본다.
 */
function resetToFirstPage(url: string): string {
  try {
    const u = new URL(url)
    if (u.searchParams.has('page')) {
      u.searchParams.delete('page')
      return u.toString()
    }
    return url
  } catch { return url }
}

/**
 * URL의 page 쿼리파라미터를 지정한 값으로 바꾼다(없으면 추가). 카페24 등은 페이지 번호가 눈에 보이는
 * 링크(1 2 3 ...)로만 제공되고 "다음" 화살표가 없는 경우가 흔한데(보여줄 페이지 수가 적을 때), 그런
 * 스킨에서도 이 파라미터로 직접 이동하면 다음 페이지를 안정적으로 가져올 수 있다.
 */
function withPageParam(url: string, pageNum: number): string {
  try {
    const u = new URL(url)
    u.searchParams.set('page', String(pageNum))
    return u.toString()
  } catch { return url }
}

/** 목록 페이지(들)을 순회하며 제품 URL 후보를 모은다. 실제 상품 추출은 하지 않는다(테스트/실행 공용 로직). */
async function collectProductUrls(page: Page, opts: ScrapeOptions): Promise<CollectedLinks> {
  if (opts.productUrls?.length) {
    return { urls: opts.productUrls, platform: 'unknown', categoryByUrl: new Map(), linkInfo: new Map() }
  }

  const listingUrls = (opts.categoryUrls?.length ? opts.categoryUrls : (opts.url ? [opts.url] : [page.url()])).map(resetToFirstPage)
  const maxPages = Math.max(1, opts.maxPages || AUTO_PAGINATION_CAP)

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
  const categoryByUrl = new Map<string, CategoryLabel>()
  const linkInfo = new Map<string, { name: string; thumbnail: string }>()

  async function scanCurrentPage(): Promise<{ href: string; name: string; thumbnail: string }[]> {
    const items: { href: string; name: string; thumbnail: string }[] = await page.evaluate(({ userSel, platformSel, detailPatternSrc }) => {
      // 대소문자 무시 — 같은 고도몰이라도 몰마다 실제 URL의 쿼리파라미터 표기가 "goodsno"/"goodsNo"처럼
      // 다를 수 있다(실제 발견된 사례: 가방쟁이는 goodsNo). 대소문자를 그대로 두면 이 필터에 상품 링크가
      // 전부 걸러져 카테고리에서 상품을 하나도 못 찾는 문제가 있었다.
      const detailRe = detailPatternSrc ? new RegExp(detailPatternSrc, 'i') : null
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
    return items.filter(item => item.href.startsWith(baseUrl))
  }

  for (const listingUrl of listingUrls) {
    if (page.url() !== listingUrl) {
      await page.goto(listingUrl, { waitUntil: 'load', timeout: 30_000 }).catch(() => {})
    }

    const categoryLabel = await detectCategoryLabel(page)
    let prevHrefs: Set<string> | null = null

    for (let p = 0; p < maxPages; p++) {
      let matched = await scanCurrentPage()
      let hrefsThisPage = new Set(matched.map(m => m.href))
      const isDeadEnd = (hrefs: Set<string>) => hrefs.size === 0 || (prevHrefs !== null && [...hrefs].every(h => prevHrefs!.has(h)))

      // page 파라미터로 다음 페이지 이동을 시도했는데도 상품 목록이 그대로거나 비었으면(그 파라미터를 안 쓰는
      // 몰이거나 스킨 구조가 다른 경우), "다음" 버튼 클릭 방식으로 한 번 더 시도해본다.
      if (isDeadEnd(hrefsThisPage) && p > 0 && nextPageSelector) {
        const nextBtn = page.locator(nextPageSelector).first()
        if (await nextBtn.isVisible({ timeout: 2_000 }).catch(() => false)) {
          await nextBtn.click()
          await page.waitForLoadState('load', { timeout: 15_000 }).catch(() => {})
          matched = await scanCurrentPage()
          hrefsThisPage = new Set(matched.map(m => m.href))
        }
      }
      if (isDeadEnd(hrefsThisPage)) break
      prevHrefs = hrefsThisPage

      matched.forEach(item => {
        productUrlSet.add(item.href)
        if (categoryLabel.category && !categoryByUrl.has(item.href)) categoryByUrl.set(item.href, categoryLabel)
        if (!linkInfo.has(item.href) && (item.name || item.thumbnail)) linkInfo.set(item.href, { name: item.name, thumbnail: item.thumbnail })
      })

      if (p >= maxPages - 1) break
      // 스킨마다 다른 "다음" 버튼 클래스에 기대는 대신, page 쿼리파라미터를 다음 번호로 바꿔 직접 이동한다 —
      // cafe24 등 대부분의 몰이 페이지 번호 링크 없이도(숫자가 안 보여도) 이 파라미터로 페이지를 넘겨준다.
      await page.goto(withPageParam(page.url(), p + 2), { waitUntil: 'load', timeout: 15_000 }).catch(() => {})
    }
  }

  // 목록 페이지 자체와 이미 스크랩된 상품은 제외
  const listingSet = new Set(listingUrls)
  const excludeSet  = new Set(opts.excludeUrls || [])
  const urls = [...productUrlSet].filter(h => !listingSet.has(h) && !excludeSet.has(h))

  return { urls, platform, categoryByUrl, linkInfo }
}

/**
 * '단일 상품 페이지' 모드로 스크랩을 시작해도, 실제로는 상품이 여럿 있는 카테고리(목록) URL을 넣는
 * 실수가 흔하다. 시작 URL에서 자기 자신이 아닌 다른 상품 링크가 여럿 발견되면 목록으로 판단해, 실제
 * 스크랩을 개별 상품 추출이 아니라 카탈로그(전체 순회) 방식으로 자동 전환할 수 있게 한다.
 */
export async function detectIsListingPage(opts: ScrapeOptions): Promise<boolean> {
  return withContext(opts, async page => {
    const { urls } = await collectProductUrls(page, opts)
    const currentUrl = opts.url || page.url()
    return urls.filter(u => u !== currentUrl).length > 1
  })
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

/**
 * 카탈로그(목록) 모드 전용 — 목록에서 상품 링크를 모아 개수를 확인하고, 첫 번째 상품을 곧바로 열어
 * 미리보기까지 한 번의 브라우저 세션으로 처리한다. 목록 수집과 미리보기를 별도 요청으로 나누면
 * 매번 새 세션을 여느라 느려지므로, 하나로 합쳐 빠르게 확인할 수 있게 한다.
 * 미리보기는 정확한 총 개수를 보여줘야 하므로 maxPages를 지정해도 무시하고 항상 끝까지 페이징을 따라간다.
 * ponytail: 미리보기 전용이라 재시도/AI폴백 없이 1회만 시도한다 — 실패하면 버튼을 다시 누르면 됨.
 */
export async function previewCatalog(opts: ScrapeOptions): Promise<CatalogPreviewResult> {
  return withContext(opts, async page => {
    const { urls, platform, linkInfo, categoryByUrl } = await collectProductUrls(page, { ...opts, maxPages: undefined })
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
    const product = await extractProductRuleBased(page, firstUrl, selectorOverrides(opts), opts.extractionRules)
    const domOptions = await extractOptionsFromDom(page)
    if (domOptions.options.length) product.options = domOptions.options
    if (domOptions.combinations.length) product.option_combinations = domOptions.combinations
    await applyStockByOption(page, product)
    applyCategoryOverride(product, categoryByUrl.get(firstUrl), opts.extractionRules)

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

    // 목록에서 상품 링크를 하나도 찾지 못했다 — 카테고리가 아니라 개별 상품 URL을 잘못 카탈로그 모드로
    // 넣었을 수 있으니, 이미 열려있는 이 페이지 자체를 상품 1건으로 보고 스크랩한다.
    if (productUrls.length === 0) {
      const singleUrl = opts.url || page.url()
      await waitForExtractableContent(page)
      const product = await extractProductRuleBased(page, singleUrl, selectorOverrides(opts), opts.extractionRules)
      const domOptions = await extractOptionsFromDom(page)
      if (domOptions.options.length) product.options = domOptions.options
      if (domOptions.combinations.length) product.option_combinations = domOptions.combinations
      await applyStockByOption(page, product)
      if (product.price == null && !product.thumbnail_urls.length) {
        await onItem({ done: 0, total: 0, url: singleUrl, result: null, error: '상품 링크를 찾지 못함 (카테고리도 개별 상품도 아닌 것으로 추정)' })
        return { total: 0, saved: 0, stopped: false }
      }
      const result: ScrapeResult = { sourceUrl: singleUrl, product }
      await onItem({ done: 1, total: 1, url: singleUrl, result })
      return { total: 1, saved: 1, stopped: false }
    }

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
          const product = await extractProductRuleBased(workerPage, pUrl, selectorOverrides(opts), opts.extractionRules)
          const domOptions = await extractOptionsFromDom(workerPage)
          if (domOptions.options.length) product.options = domOptions.options
          if (domOptions.combinations.length) product.option_combinations = domOptions.combinations
          await applyStockByOption(workerPage, product)
          lastProduct = product
          // 가격과 이미지가 둘 다 없으면 실제 상품 페이지가 아니라 봇 차단/오류 안내 페이지를 받았을 가능성이
          // 높다 (빠른 연속 요청을 감지해 안내 페이지로 대신 응답하는 몰이 있음) — 그대로 저장하지 않고 재시도한다.
          if (product.price == null && product.cost_price == null && !product.thumbnail_urls.length) {
            throw new Error('가격/이미지를 모두 찾지 못함 (차단 또는 일시 오류로 추정)')
          }
          applyCategoryOverride(product, categoryByUrl.get(pUrl), opts.extractionRules)
          return { sourceUrl: pUrl, product }
        } catch (err) {
          lastError = err
          if (attempt < RETRY_COUNT) await sleep(2_000 * (attempt + 1) + Math.random() * 2_000)
        }
      }
      if (lastProduct) {
        const aiProduct = await tryAiFallback(workerPage, lastProduct)
        if (aiProduct) {
          applyCategoryOverride(aiProduct, categoryByUrl.get(pUrl), opts.extractionRules)
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
