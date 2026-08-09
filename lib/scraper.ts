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
import { extractProductFieldsWithAI, generateMallProfileReport, buildHeuristicMallReport, filterRealProductOptions, type MallStructureReport, type OptionCandidate } from './ai'
import { extractProductRuleBased, type ExtractSelectorOverrides } from './extract'
import type { ExtractionRule } from './ai'
import { solveRecaptchaV2, solveHCaptcha, solveImageCaptcha } from './captcha'
import { runAutoAnalysis } from './scrape/adjustment'
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
// 이 사본은 siteId별이 아니라 이 경로 하나뿐이다(사용자의 개인 크롬 프로필 하나를 그대로 미러링하는
// 것이라 몰마다 다를 이유가 없다) — 그래서 서로 다른 manual_login_required 몰 두 곳을 동시에 다뤄도
// 이 물리 폴더 하나를 두고 경쟁한다. siteId별 락(withSiteLock)과 별개로, 이 전역 자원 전용 락 키로
// 한 번에 하나의 manual-login 작업만 돌게 한다(withContext 참고).
const MANUAL_LOGIN_LOCK_KEY = 'manual-login-profile-copy'
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
  /** 'manual'이면 아래 concurrency 값을 카테고리/상품 동시 처리 개수로 고정해서 쓴다(1~8). 생략 또는
   *  'auto'면 기존 동작 그대로 — scrapeCatalogPage는 몰 반응을 보며 1에서 최대 8까지 스스로 올리고(적응형
   *  동시성), previewCatalog/collectProductUrls의 카테고리 집계는 4로 고정된다. 동시에 여는 탭 수가
   *  메모리 사용량에 직결돼(각 탭이 이미지까지 로드) 메모리 이슈를 진단/완화하려면 수동으로 낮춰본다. */
  concurrencyMode?: 'auto' | 'manual'
  /** concurrencyMode가 'manual'일 때만 쓰이는 동시 처리 개수(1~8, 범위 밖 값은 안전하게 clamp됨).
   *  recheckMallProducts(연속관리 재체크)는 concurrencyMode와 무관하게 항상 이 값을 그대로 쓴다(기존 동작,
   *  적응형 동시성이 없는 기능이라 auto/manual 구분이 의미 없음). */
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
  /** "AI모드 스크래핑" — 켜져 있으면(미리보기 시점) 이 페이지를 AI로 분석해 이 몰의 추출 규칙을 새로
   *  만들어 저장하고, 그 규칙으로 다시 추출한 값을 돌려준다. siteId 없이는 저장할 곳이 없어 무시된다. */
  aiMode?: boolean
  /** previewCatalog 전용 중지 신호 — 실제 스크랩(sessionId+isStopRequested)과 달리 미리보기는 DB
   *  세션이 없는 단발 요청이라, 클라이언트가 fetch를 abort하면 그 요청의 AbortSignal을 그대로 여기
   *  꽂아 카테고리별 개수 집계 루프가 다음 네트워크 왕복 전에 스스로 멈추게 한다. */
  stopSignal?: AbortSignal
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

/** concurrencyMode==='manual'이면 opts.concurrency를 1~8로 clamp해서 쓰고, 아니면(생략/'auto') autoDefault를
 *  쓴다 — collectProductUrls/previewCatalog의 카테고리 동시 집계 개수에 쓴다(둘 다 자체 ramp 로직이 없어
 *  "auto"가 사실상 고정값 하나뿐이라 이 헬퍼로 충분하다). scrapeCatalogPage는 적응형 동시성(ramp-up)이
 *  있어 이 헬퍼 대신 MAX_CONCURRENCY/activeLimit 시작값을 직접 조정한다. */
function resolveConcurrency(opts: ScrapeOptions, autoDefault: number): number {
  if (opts.concurrencyMode !== 'manual') return autoDefault
  return Math.max(1, Math.min(opts.concurrency || 1, 8))
}

// 개별 상품 추출 실패 시 재시도 횟수 (일시적 네트워크/타임아웃 오류 대비). ponytail: 고정값, 설정 불가.
const RETRY_COUNT = 2

declare global {
  var __scrapeOpenSessions: Map<number, BrowserContext> | undefined
  var __scrapeStopRequests: Set<number> | undefined
  var __previewRuns: Map<number, PreviewRunState> | undefined
  var __scrapeSiteLocks: Map<number | string, Promise<void>> | undefined
  var __scrapeSiteLockStatus: Map<number | string, { label: string; since: number }> | undefined
}

interface PreviewRunState {
  /** 이 몰(siteId)에 대해 더 최근 미리보기 요청이 새로 들어왔다는 뜻 — 다음 stop() 체크에서 스스로
   *  멈춘다(아래 beginPreviewRun 참고). */
  superseded: boolean
  done: number
  total: number
  /** 정상적으로 끝까지 완료된 결과 — 화면이 dev 서버 불안정 등으로 강제 새로고침돼 원래 fetch를
   *  받을 JS 컨텍스트 자체가 사라져도, 다시 뜬 화면이 이 값을 폴링으로 가져가 그대로 보여줄 수 있게
   *  잠시 남겨둔다(endPreviewRun 참고). 중지/밀려남/에러로 끝난 경우는 채우지 않는다 — 보여줄 만한
   *  완성된 결과가 아니므로. */
  result?: CatalogPreviewResult
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

const siteLocks = globalThis.__scrapeSiteLocks ?? (globalThis.__scrapeSiteLocks = new Map<number | string, Promise<void>>())

/**
 * 이 파일의 여러 함수가 openSessions(로그인 창의 공유 탭)를 잠금 없이 그대로 꺼내 page.goto()를 걸거나,
 * profileDir(siteId) 같은 몰 전용 디스크 자원(브라우저 프로필 폴더)에 launchPersistentContext를 건다 —
 * 로그인 창 열기/로그인 확인/몰 구조 파악/스크랩 대상 직접지정/미리보기/스크래핑 시작 등 거의 모든 스크랩
 * 관련 기능이 여기 해당한다. 같은 몰(key=siteId)에 대해 이런 함수가 동시에 두 번 불리면(같은 화면을 두
 * 탭에서 열거나, 버튼을 빠르게 두 번 누르거나, 예약 스크랩과 수동 클릭이 겹치는 등) 두 실행이 같은 탭에서
 * 서로의 네비게이션을 밟고 지나가 결과가 뒤섞이거나(에러 없이 조용히 틀린 데이터가 나옴 — 가장 위험한
 * 형태), 한쪽이 다른 쪽의 살아있는 크롬 프로세스를 강제 종료시킬 수 있다(killOrphanedProfileProcess가
 * "그 프로필 폴더를 쓰는 크롬"을 전부 대상으로 하기 때문).
 *
 * ## 언제 이걸 써야 하는가
 * 이 파일에 함수를 새로 추가하거나 기존 함수를 고칠 때, 그 함수가 (a) openSessions.get(siteId)로 얻은
 * 페이지에 goto/evaluate를 걸거나, (b) profileDir(siteId)/MANUAL_LOGIN_PROFILE_COPY_ROOT에
 * launchPersistentContext를 건다면 — 같은 key로 동시에 두 번 불릴 수 있는지 먼저 따져보고, 가능하면
 * 그 작업 전체(또는 최소한 실제로 공유 자원을 건드리는 부분)를 `withSiteLock(key, label, fn)`으로
 * 감싼다. `label`은 사람이 읽을 짧은 한국어 이름("몰 구조 파악" 등) — 대기 중인 다른 요청이
 * `getSiteLockStatus`로 "지금 무엇 때문에 기다리는지"를 화면에 보여줄 때 쓴다. `withContext()`를
 * 거치는 함수는 이미 자동으로 보호된다 — 이 파일에 새 스크랩 기능을 추가한다면 대부분 `withContext`를
 * 재사용하는 것만으로 충분하고, 그럴 수 없는 특수한 경우(로그인 창 관련 함수들처럼 openSessions를
 * 직접 만지는 경우)에만 이 함수를 직접 쓰면 된다.
 *
 * ## 왜 취소(supersede)가 아니라 줄서기(큐)인가
 * 브라우저 탭 네비게이션은 이미 시작한 뒤엔 안전하게 취소할 방법이 없다 — 그래서 뒤에 온 실행을
 * 취소시키는 대신, 앞의 실행이 완전히 끝날 때까지 기다리게 한다. 반대로 "화면에 최신 결과만 보여주면
 * 충분하고, 오래된 요청은 그냥 버려도 되는" 경우(예: 미리보기 — previewRuns/beginPreviewRun 참고)는
 * 이것과 다른 문제라 다른 해법(밀어내기)을 쓴다 — 그건 "사용자가 보는 결과"를 최신 것으로 덮어쓰는
 * 문제고, 이건 "브라우저 자원 자체를 안전하게 나눠 쓰는" 문제다. 같은 몰에 대한 서로 다른 기능(예:
 * 스크래핑 시작 도중의 몰 구조 파악)도 이 큐를 공유해 순서대로만 실행된다 — 오래 걸리는 작업(전체
 * 스크래핑) 중에는 그 몰의 다른 작업이 끝날 때까지 기다리게 되는데, 애초에 같은 로그인 세션으로 두
 * 자동화를 동시에 돌리면 안 되므로 이건 감수하는 트레이드오프다.
 */
/** 지금 그 락을 실제로 쥐고 있는 작업이 뭔지(사람이 읽을 라벨)와 언제부터인지 — 화면에 "다른 작업이
 *  끝나길 기다리는 중"을 보여주는 용도로만 쓴다(getSiteLockStatus 참고). 대기열 자체(순서 보장)는
 *  siteLocks가 담당하고, 이건 그 위에 얹은 순수 표시용 정보라 없어도 잠금 로직 자체는 정확하다. */
const siteLockStatus = globalThis.__scrapeSiteLockStatus ?? (globalThis.__scrapeSiteLockStatus = new Map<number | string, { label: string; since: number }>())

export async function withSiteLock<T>(key: number | string | undefined, label: string, fn: () => Promise<T>): Promise<T> {
  if (key === undefined) return fn()
  const prevTail = siteLocks.get(key) ?? Promise.resolve()
  let releaseTail!: () => void
  const myTail = new Promise<void>(resolve => { releaseTail = resolve })
  siteLocks.set(key, myTail)
  try {
    await prevTail
    siteLockStatus.set(key, { label, since: Date.now() })
    return await fn()
  } finally {
    siteLockStatus.delete(key)
    releaseTail()
    if (siteLocks.get(key) === myTail) siteLocks.delete(key)
  }
}

/** 화면(ScraperPanel)이 폴링해서 "⏳ 다른 작업(${label}) 완료를 기다리는 중"을 보여주는 데 쓴다 —
 *  사용자가 버튼을 눌렀는데 응답이 안 오면 그게 이 함수 자체가 느린 건지, 같은 몰의 다른 작업이
 *  끝나길 줄서서 기다리는 중인지 구분할 방법이 없었다(실사용 중 "왜 이렇게 오래 걸리냐"는 질문으로
 *  발견). `sinceMs`가 아주 크면(예: 수 분) 대기가 아니라 그 작업 자체가 오래 걸리고 있다는 뜻이다. */
export function getSiteLockStatus(siteId: number): { label: string; sinceMs: number } | null {
  const entry = siteLockStatus.get(siteId)
  return entry ? { label: entry.label, sinceMs: Date.now() - entry.since } : null
}

const previewRuns = globalThis.__previewRuns ?? (globalThis.__previewRuns = new Map<number, PreviewRunState>())

/** previewCatalog 진행률 표시 + 같은 몰에 대한 중복 실행 방지용. 실사용 중 확인된 문제: 미리보기가
 *  오래 걸리는 동안 사용자가 중지 없이 다시 누르거나 브라우저를 새로고침하면, 서버에서는 예전 실행이
 *  끝나지 않은 채 새 실행이 또 시작돼 같은 몰에 Playwright 탭 여러 벌이 동시에 돌며 서로 CPU를
 *  나눠 먹어 둘 다 끝없이 느려졌다. 새 요청이 오면 그 몰의 이전 실행에 superseded 표시를 해 다음
 *  stop() 체크 때 스스로 멈추게 하고, 이번 실행용 진행 상황 칸을 새로 만든다. */
function beginPreviewRun(siteId: number | undefined): PreviewRunState | null {
  if (siteId === undefined) return null
  const prev = previewRuns.get(siteId)
  if (prev) prev.superseded = true
  const entry: PreviewRunState = { superseded: false, done: 0, total: 0 }
  previewRuns.set(siteId, entry)
  return entry
}

/** 이 실행이 그 사이 새 요청에 밀려났으면 자기 자신의 진행 상황 칸을 지우지 않는다(새 실행 것을
 *  실수로 지우면 안 됨) — siteId의 현재 칸이 여전히 자기 자신일 때만 처리한다. `result`가 있으면
 *  (정상 완료) 칸을 바로 지우지 않고 그 결과를 담아 남겨둔다 — 화면이 강제 새로고침돼도 다시 뜬 뒤
 *  폴링으로 이 결과를 그대로 가져갈 수 있게 하기 위함(재관찰 탭이 없으면 다음 미리보기가 시작될 때
 *  beginPreviewRun이 이 칸을 덮어쓰면서 자연히 정리된다 — 별도 TTL/정리 타이머 없이도 충분하다).
 *  중지/밀려남/에러로 끝나 남길 결과가 없으면(result 없음) 그대로 지운다. */
function endPreviewRun(siteId: number | undefined, entry: PreviewRunState | null, result: CatalogPreviewResult | null) {
  if (siteId === undefined || !entry) return
  if (previewRuns.get(siteId) !== entry) return
  if (result) { entry.result = result; return }
  previewRuns.delete(siteId)
}

/** app/api/scrape/preview-progress가 폴링해서 화면에 "카테고리 N/M 확인 중"을 보여주거나(진행 중),
 *  화면이 강제 새로고침된 뒤 재관찰 중 정상 완료된 `result`를 그대로 받아가는 데(완료 후) 쓴다. */
export function getPreviewProgress(siteId: number): { done: number; total: number; result?: CatalogPreviewResult } | null {
  const entry = previewRuns.get(siteId)
  return entry ? { done: entry.done, total: entry.total, result: entry.result } : null
}

/** 중지 반영이 끝난 뒤 Set에서 지운다 — 안 지우면 세션 id가 계속 쌓여 다음에 같은 id가(이론상) 재사용될 때
 *  엉뚱하게 즉시 중지된 것처럼 보일 수 있다. */
export function clearStopRequest(sessionId: number) {
  stopRequests.delete(sessionId)
}

/** Chrome 프로세스 중 커맨드라인에 pathFilter가 포함된 것만 골라 강제 종료하는 PowerShell 조각.
 *  `--type=*`(렌더러/GPU 등 자식 프로세스)는 매칭에서 빼 메인 브라우저 프로세스만 잡는다 — 그래야 `/T`가
 *  그 프로세스의 자식(자기 자신의 렌더러 등)까지 트리째 한 번에 정리해준다. */
function killChromeByPathScript(pathFilter: string): string {
  return `Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | ` +
    `Where-Object { $_.CommandLine -like '*${pathFilter}*' -and $_.CommandLine -notlike '*--type=*' } | ` +
    `ForEach-Object { taskkill /PID $_.ProcessId /F /T }`
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
  await execFileAsync('powershell.exe', ['-NoProfile', '-Command', killChromeByPathScript(profileDir(siteId))]).catch(() => {})
}

/** `app/api/system/restart-server`가 재시작 스크립트에 이어붙여 쓰는 PowerShell 조각(문자열만 돌려주고
 *  실행은 안 함) — killOrphanedProfileProcess는 siteId 하나만 정리해서, 그 몰을 재시작 후 다시 쓰기
 *  전까지는 이전에 죽지 않고 남은 orphan chrome.exe가 그대로 메모리를 붙들고 있다(서버를 재시작해도
 *  메모리가 안 줄어드는 것처럼 보이는 원인 중 하나 — 헤드리스 컨텍스트는 정상 종료 시 `context.close()`로
 *  정리되지만, 서버 프로세스가 강제 종료되면 그 `finally`가 실행될 기회 자체가 없다). 재시작 시점엔 특정
 *  siteId를 몰라도 되니 이 프로젝트가 띄운 프로필(`.playwright-profiles` 아래 전부, manual-login
 *  사본 포함) 전체를 한 번에 정리한다. */
export function orphanedChromeCleanupScript(): string {
  return killChromeByPathScript(path.join(process.cwd(), '.playwright-profiles'))
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
  // withContext와 같은 락 키(siteId)를 공유한다 — 이 함수도 launchVisibleWindow로 openSessions를
  // 새로 채우고 그 탭에 곧바로 goto를 거는, withSiteLock 주석이 설명하는 바로 그 패턴이다. 같은 몰에
  // 다른 작업(스크래핑 시작 등)이 이미 진행 중이면 그게 끝난 뒤 순서대로 실행된다.
  return withSiteLock(siteId, '로그인 창 열기', async () => {
    const context = await launchVisibleWindow(siteId)
    const page = context.pages()[0] || await context.newPage()
    await page.goto(opts.url, { waitUntil: 'networkidle', timeout: 30_000 }).catch(() => {})
    // 아이디/비번만 채워두고 제출은 하지 않는다 — 사용자가 직접 로그인 버튼을 눌러야 이후 "로그인 확인" 흐름과 맞는다.
    await loginIfNeeded(page, { url: opts.url, loginId: opts.loginId, loginPw: opts.loginPw }, { autoSubmit: false })
  })
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
  // closeLoginWindow가 openSessions를 만지므로 같은 락 키를 공유한다(withSiteLock 주석 참고) — 실제
  // 브라우저 자체는 추적 밖의 개인 크롬이라 락이 끝난 뒤에는 이 함수가 더 할 일이 없다.
  return withSiteLock(siteId, '로그인 창 열기(직접로그인)', async () => {
    await closeLoginWindow(siteId)
    // --no-first-run/--no-default-browser-check가 없으면 실제 크롬이 "Chrome에 로그인" 등 첫 실행 온보딩
    // 화면을 활성 탭으로 띄워버려, 요청한 몰 로그인 URL로 바로 이동하지 않는다.
    const child = spawn(CHROME_EXE, ['--no-first-run', '--no-default-browser-check', url], { detached: true, stdio: 'ignore' })
    child.unref()
  })
}

/** 현재 로그인 창에서 사용자가 보고 있는 페이지 URL (없으면 null) */
export function getOpenPageUrl(siteId: number): string | null {
  const context = openSessions.get(siteId)
  if (!context) return null
  const pages = context.pages()
  return pages.length ? pages[pages.length - 1].url() : null
}

/**
 * "로그인 확인" 시 로그인 창을 등록해둔 몰 URL로 이동시킨다 — 로그인 후 랜딩된 페이지(마이페이지 등)가
 * 로그인 URL과 다른 몰(예: 시즌백)에서는 로그인 확인 후에도 스크랩 대상 페이지가 아닌 곳에 머물러 있었다.
 * 새 탭을 열지 않고 기존 탭을 재사용한다(startElementPicker와 동일한 이유 — 탭이 계속 쌓이는 문제 방지).
 */
export async function navigateOpenPageTo(siteId: number, url: string): Promise<string | null> {
  // withContext와 같은 락 키(siteId) — 공유 탭에 직접 goto를 거는 함수라 withSiteLock 주석이 설명하는
  // 패턴 그대로다.
  return withSiteLock(siteId, '로그인 확인', async () => {
    const context = openSessions.get(siteId)
    if (!context) return null
    const pages = context.pages()
    const page = pages.length ? pages[pages.length - 1] : await context.newPage()
    if (page.url() !== url) {
      await page.goto(url, { waitUntil: 'load', timeout: 30_000 }).catch(() => {})
    }
    await page.bringToFront().catch(() => {})
    return page.url()
  })
}

/**
 * 미리보기 화면의 "열기" 버튼처럼, 로그인된 상태로 특정 상품 페이지를 확인하고 싶을 때 쓴다. 로그인 창이
 * 열려있으면 그 창(세션 쿠키를 가진 그 브라우저)에 새 탭을 띄워 이동시킨다. 사용자가 창을 닫아 열려있는
 * 로그인 창이 없어도, 같은 프로필 디렉터리에 남아있는 예전 로그인 쿠키를 그대로 재사용해 새 창을 띄운다
 * (그 쿠키가 만료됐으면 그 사이트 자체가 로그인 페이지로 돌려보낼 뿐 — 이 함수가 할 수 있는 건 여기까지).
 */
export async function openUrlInLoginWindow(siteId: number, url: string): Promise<void> {
  // 이미 열린 세션에 새 탭을 여는 것은 공유 탭을 건드리지 않아 그 자체로 안전하다 — 락 없이 바로
  // 처리한다(다른 무거운 작업이 같은 몰에서 진행 중이어도 미리보기 "열기"가 그것 때문에 기다릴
  // 필요는 없다).
  const existing = openSessions.get(siteId)
  if (existing) {
    const page = await existing.newPage()
    await page.goto(url, { waitUntil: 'load', timeout: 30_000 }).catch(() => {})
    await page.bringToFront().catch(() => {})
    return
  }
  // 세션이 없으면 새로 띄워야 하는데, launchVisibleWindow는 같은 몰의 다른 작업(withContext 등)과
  // 충돌할 수 있는 close+kill+launch 절차라 withSiteLock으로 감싼다(withContext와 같은 락 키).
  return withSiteLock(siteId, '로그인 창 열기', async () => {
    // 락을 기다리는 사이 다른 실행이 이미 로그인 창을 열어뒀을 수 있다 — 다시 확인한다.
    const nowExisting = openSessions.get(siteId)
    if (nowExisting) {
      const page = await nowExisting.newPage()
      await page.goto(url, { waitUntil: 'load', timeout: 30_000 }).catch(() => {})
      await page.bringToFront().catch(() => {})
      return
    }
    const context = await launchVisibleWindow(siteId)
    const page = context.pages()[0] || await context.newPage()
    await page.goto(url, { waitUntil: 'load', timeout: 30_000 }).catch(() => {})
  })
}

/** 새 로그인 창을 열기 전 기존 창을 정리할 때만 내부적으로 쓴다(openLoginWindow/openManualLoginWindow 참고) —
 *  이 함수를 직접 호출하는 API 라우트는 없다. */
async function closeLoginWindow(siteId: number) {
  const context = openSessions.get(siteId)
  if (context) {
    await context.close().catch(() => {})
    openSessions.delete(siteId)
  }
}

// 어디서든 Playwright 번들 Chromium이 아니라 실제 설치된 크롬을 띄운다 — 몰이 자동화 브라우저를
// 감지해 차단/도전과제를 거는 경우(예: manual-login-required 몰의 봇 탐지) 실제 크롬 쪽이 더 정상적으로 통과한다.
export async function withContext<T>(
  opts: ScrapeOptions, fn: (page: Page, context: BrowserContext) => Promise<T>, label = '스크랩 작업',
): Promise<T> {
  if (opts.siteId) {
    const siteId = opts.siteId
    // 이 몰(siteId)에 대한 다른 withContext 호출(또는 openSessions를 직접 만지는 로그인 창 관련
    // 함수들 — withSiteLock 주석 참고)이 끝날 때까지 기다렸다가 실행한다. 같은 몰에 두 작업이 동시에
    // 뜨면(두 탭에서 같은 화면을 열거나, 예약 스크랩과 수동 클릭이 겹치는 등) 아래 두 경로 다 실제로
    // 사고로 이어지는 게 확인됐다: 로그인 창 재사용 경로는 같은 탭에 서로 다른 goto를 걸어 결과가
    // 뒤섞이고, 헤드리스 실행 경로는 killOrphanedProfileProcess가 상대방의 살아있는 크롬을 죽인다.
    return withSiteLock(siteId, label, async () => {
      const openContext = openSessions.get(siteId)
      if (openContext) {
        // 로그인 창이 열려있으면 그대로 재사용 (닫지 않음)
        const pages = openContext.pages()
        const page = pages.length ? pages[pages.length - 1] : await openContext.newPage()
        return await fn(page, openContext)
      }
      if (await isManualLoginSite(siteId)) {
        // 직접로그인 필수 몰은 사용자의 실제 개인 크롬 프로필(활성 프로필 전체)을 사본으로 복제해 그 사본을
        // 헤드리스로 띄운다 — syncManualLoginProfileCopy() 주석 참고. 개인 브라우저 자체를 건드리지 않으므로
        // 여기서 기존 크롬 프로세스를 강제 종료하지 않는다. 이 사본 폴더는 siteId 전용이 아니라 전역
        // 하나뿐이라(MANUAL_LOGIN_LOCK_KEY 주석 참고) 위 siteId 락과 별개로 그 전역 자원 락도 같이 건다
        // — robocopy부터 이 컨텍스트를 다 쓰고 닫을 때까지 통째로, 그래야 다른 manual-login 몰이 그 사이
        // 같은 폴더에 launchPersistentContext를 걸어 충돌하지 않는다.
        return withSiteLock(MANUAL_LOGIN_LOCK_KEY, label, async () => {
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
        })
      }

      // 직접로그인 필수 몰은 사용자가 별도로 띄운(추적 안 되는) 크롬 창을 안 닫고 스크랩을 시작할 수 있어,
      // 같은 프로필 폴더를 쓰는 헤드리스 실행이 lock 충돌로 실패하지 않도록 먼저 정리한다.
      await killOrphanedProfileProcess(siteId)
      const context = await chromium.launchPersistentContext(profileDir(siteId), {
        headless: true, channel: 'chrome', chromiumSandbox: true,
      })
      try {
        const page = context.pages()[0] || await context.newPage()
        return await fn(page, context)
      } finally {
        await context.close()
      }
    })
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

/**
 * "AI모드 스크래핑" — 지금 열려있는 이 상품 페이지를 AI로 분석해 이 몰의 추출 규칙(8개 필드: 이름/가격/
 * 원가/배송비/카테고리/브랜드/제조사/원산지)을 새로 만들어 sites.extraction_rules에 저장하고, 그 규칙으로
 * 다시 추출한 값을 돌려준다. 몰은 자주 안 바뀌니 매 상품마다 AI를 부르지 않고 이 미리보기 시점에만
 * 호출해 규칙을 재사용 가능하게 만드는 게 목적이다(runAutoAnalysis 참고).
 *
 * domOptions는 호출부가 이미 스캔해둔 결과를 그대로 받는다 — select 옵션 스캔은 실제로 값을 선택해보는
 * 상태 변경 동작이라(scanSelectOptions), 여기서 다시 스캔하면 같은 페이지에 두 번 개입해 결과가 달라질
 * 위험이 있다. 대신 AI모드에서는 그 결과가 진짜 구매 옵션인지 AI로 한 번 더 검증한다 — 실제로 도매의신
 * 같은(카페24 등 알려진 플랫폼이 아닌) 몰은 옵션 컨테이너 셀렉터가 없어 document 전체에서 select를
 * 찾다가 "검색범위"/카테고리 필터 같은 사이트 UI를 상품 옵션으로 잘못 잡는 것을 실제로 확인했다.
 *
 * AI 호출/분석 실패는 조용히 삼켜 null을 돌려준다 — 이미 규칙 기반으로 뽑은 결과가 있으니 미리보기
 * 자체가 막히면 안 된다.
 */
async function applyAiModeRules(
  page: Page, siteId: number, sourceUrl: string, opts: ScrapeOptions, domOptions: DomOptionsResult,
): Promise<{ product: ExtractedProduct; rules: Record<string, ExtractionRule> } | null> {
  try {
    const pageText = await page.evaluate(() => document.body.innerText).catch(() => '')
    if (!pageText) return null
    const { merged } = await runAutoAnalysis(siteId, pageText)
    const product = await extractProductRuleBased(page, sourceUrl, selectorOverrides(opts), merged)

    let options = domOptions.options
    let combinations = domOptions.combinations
    if (options.length) {
      const { name: mallName } = await siteInfo(siteId)
      const candidates: OptionCandidate[] = options.map(o => ({ name: o.name, values: o.values }))
      const realNames = await filterRealProductOptions(mallName, candidates, pageText)
      if (realNames.length < options.length) {
        options = options.filter(o => realNames.includes(o.name))
        // 제외된 옵션이 있으면 그걸로 만들어진 캐스케이딩 조합도 더는 신뢰할 수 없다 — 조합 없이 옵션
        // 목록만 남긴다(신우처럼 진짜 캐스케이딩 몰은 애초에 필터링될 옵션이 없어 이 분기를 안 탄다).
        combinations = []
      }
    }
    if (options.length) product.options = options
    if (combinations.length) product.option_combinations = combinations

    await applyStockByOption(page, product)
    return { product, rules: merged }
  } catch {
    return null
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

/** 반환값 true = 이 시도가 끝난 뒤에도 로그인폼이 여전히 보임(세션이 끊겼는데 자동으로 못 고쳤다는 뜻) —
 *  호출부가 "로그인이 필요한 상태로 스크랩되고 있다"를 감지하는 데 쓴다(아이디/비번이 없어 애초에 시도조차
 *  안 한 경우도 true — 둘 다 "이 스크랩 결과가 비로그인 상태일 수 있다"는 같은 의미이기 때문). */
async function loginIfNeeded(
  page: import('playwright').Page,
  opts: { url: string; loginId?: string; loginPw?: string; loginIdSelector?: string; loginPwSelector?: string; loginBtnSelector?: string },
  { autoSubmit = true }: { autoSubmit?: boolean } = {},
): Promise<boolean> {
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
  if (!(await idEl.isVisible({ timeout: 5_000 }).catch(() => false))) return false // 로그인폼 자체가 안 보임 = 이미 로그인된 상태

  // 아이디/비번을 안 맡겨둔 몰(직접로그인 필수 등)은 여기서 자동으로 고칠 수 없다 — 로그인폼이 보인다는
  // 사실 자체가 "지금 로그아웃 상태"라는 신호이므로, 시도 없이도 true를 돌려줘 호출부가 알아채게 한다.
  if (!opts.loginId || !opts.loginPw) return true

  await idEl.fill(opts.loginId)
  const pwEl = page.locator(pwSel).first()
  await pwEl.fill(opts.loginPw)

  await solveCaptchaIfPresent(page)

  // autoSubmit=false(로그인 창을 직접 여는 경우)는 아이디/비번만 채워두고, 실제 로그인 버튼 클릭은 사용자가 직접 한다.
  if (!autoSubmit) return true

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

  // 제출 후에도 로그인폼이 여전히 보이면 재로그인 실패(비번 변경/캡차/계정 잠김 등)로 본다.
  return await idEl.isVisible({ timeout: 3_000 }).catch(() => false)
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
  /** categoryMenuNames와 같은 카테고리를 이름+실제 이동 링크(href) 쌍으로 — "카테고리 불러오기"가 이
   *  몰 구조분석 결과를 그대로 재사용해 후보를 다시 훑지 않고 즉시 목록을 보여줄 때 쓴다. 지원 안 되는
   *  플랫폼/스캔 실패 시 빈 배열. */
  categoryLinks: CategoryMenuLink[]
  /** URL 계층/카테고리/결제계좌/택배사/재고관리형태/업체연락처/상품페이지구조/스크래핑 유의사항을 실제로
   *  수집한 원문(홈 하단 회사정보 + 이용안내·공지 등 게시판 + 상품페이지) 기반으로 AI가 요약한 리포트.
   *  ANTHROPIC_API_KEY 미설정이거나 원문을 하나도 못 모았으면 null. */
  report: MallStructureReport | null
  /** deep 호출에서 첫 성공 샘플의 원문(product page innerText) — "몰 구조 파악" 직후 자동으로
   *  추출규칙(runAutoAnalysis)을 생성할 때만 쓰고 DB에는 저장하지 않는다(applyProfileResult에서 제외).
   *  가벼운 구조변화감지(deep=false)에서는 항상 undefined. */
  sampleProductPageText?: string
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
  // withContext와 같은 락 키(siteId) — 공유 탭에 직접 goto를 걸고 그 페이지를 분석하는, withSiteLock
  // 주석이 설명하는 패턴 그대로다. 예를 들어 "스크래핑 시작"이 이 몰의 그 탭을 한창 쓰고 있는 도중에
  // "몰 구조 파악"을 눌러도 서로 페이지를 밟고 지나가지 않고 순서대로 실행된다.
  return withSiteLock(siteId, deep ? '몰 구조 파악' : '구조 변화 감지', async () => {
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
  })
}

async function siteInfo(siteId: number): Promise<{ name: string; url: string }> {
  const res = await pool.query<{ name: string; url: string }>('SELECT name, url FROM sites WHERE id = $1', [siteId])
  return { name: res.rows[0]?.name || `site${siteId}`, url: res.rows[0]?.url || '' }
}

// page.exposeFunction은 같은 Page 인스턴스에 같은 이름으로 두 번 부르면 에러가 난다 — "스크랩 대상 직접지정 시작"을
// 여러 번 눌러도 안전하도록 이미 노출한 Page를 기억해둔다.
const pickerExposedPages = new WeakSet<Page>()

/**
 * "스크랩 대상 직접지정" 기능 — 실제로 열려있는 몰 페이지(로그인 확인된 openSessions 창)에 클릭식 엘리먼트 피커를
 * 주입한다. 사용자가 페이지에서 값을 클릭하면(예: 가격 텍스트) 그 요소가 라벨-값 구조(dt/dd, th/td) 안에
 * 있는지 먼저 확인해 있으면 라벨 텍스트를, 없으면 CSS 셀렉터를 계산해 후보로 보여주고, 컬럼명을 입력해
 * 저장하면 그 자리에서 sites.extraction_rules에 반영된다 — "스크랩 조정"이 AI로 추측해 만들던 것과 같은
 * 데이터(type:'label'|'selector')를 사용자가 직접 클릭으로 확정하는 대체 경로다. 반복 클릭-입력으로 한
 * 페이지에서 여러 컬럼을 계속 지정할 수 있다. 정확도가 더 높은 것이 목적이라, 라벨을 우선하고(같은 몰의
 * 다른 상품에서도 라벨 텍스트는 대체로 그대로라 셀렉터보다 안정적) 라벨 구조가 없을 때만 셀렉터로 대체한다.
 */
export async function startElementPicker(
  siteId: number, previewProduct?: Record<string, unknown> | null, targetUrl?: string,
): Promise<boolean> {
  // withContext와 같은 락 키(siteId) — 공유 탭에 직접 goto/evaluate를 거는, withSiteLock 주석이 설명하는
  // 패턴 그대로다.
  return withSiteLock(siteId, '스크랩 대상 직접지정', async () => {
    const context = openSessions.get(siteId)
    if (!context) return false
    const pages = context.pages()
    const page = pages.length ? pages[pages.length - 1] : await context.newPage()

    // 미리보기 상품 페이지로 "이동"할 뿐, 새 탭을 열지 않는다 — 예전엔 호출부가 별도로 새 탭을 먼저 열고
    // (openUrlInLoginWindow) 그 다음 여기서 다시 "마지막 탭"을 골랐는데, "스크랩 대상 직접지정"을 다시
    // 누를 때마다(예: PTP 화면을 벗어났다 돌아와 다시 누른 경우) 매번 탭이 하나씩 더 쌓였다. 예전 탭에
    // 남아있던 피커가 안 닫힌 채로 방치되면, 그 탭은 계속 예전 시점의 코드로 저장을 시도해 최신 탭의
    // 저장과 서로 경쟁하며 값이 사라지는 것처럼 보일 수 있었다(신우 몰 재발 보고). 같은 컨텍스트의 다른
    // 탭에 아직 살아있는 피커가 있으면 먼저 정리하고, 이 탭 하나만 활성 상태로 유지한다.
    for (const other of pages) {
      if (other === page) continue
      await other.evaluate(() => (window as unknown as { __ptpPickerTeardown?: () => void }).__ptpPickerTeardown?.()).catch(() => {})
    }
    if (targetUrl && page.url() !== targetUrl) {
      await page.goto(targetUrl, { waitUntil: 'load', timeout: 30_000 }).catch(() => {})
    }
    await page.bringToFront().catch(() => {})

    if (!pickerExposedPages.has(page)) {
      // SELECT로 읽어 JS에서 합친 뒤 UPDATE하면, 여러 필드를 빠르게 연달아 지정할 때 SELECT~UPDATE 사이에
      // 다른 저장이 끼어들어 먼저 저장한 필드가 통째로 사라지는 lost-update가 생긴다(신우 몰에서 실제
      // 보고됨: 상품명 등 여러 개를 연속 지정하니 지정한 것들이 사라짐). Postgres의 jsonb `||`(병합)/
      // `-`(키 제거) 연산자로 한 SQL 문 안에서 원자적으로 처리해 이 경쟁을 없앤다.
      await page.exposeFunction('ptpSavePick', async (payload: { field: string; type: 'label' | 'selector' | 'fixed' | 'multi'; value: string }) => {
        if (!payload.field?.trim()) return
        await pool.query(
          `UPDATE sites SET extraction_rules = COALESCE(extraction_rules, '{}'::jsonb) || jsonb_build_object($1::text, $2::jsonb) WHERE id=$3`,
          [payload.field, JSON.stringify({ type: payload.type, value: payload.value }), siteId],
        )
      })
      pickerExposedPages.add(page)
    }

    // "스크랩 대상 직접지정"을 누른 이 순간에만 주입한다 — 그 뒤로 이 탭이 다른 페이지로 이동해도 패널이
    // 저절로 다시 뜨지 않는다(예전엔 페이지 로드마다 자동 재주입했는데, 사용자가 다 쓰고 다른 페이지를
    // 둘러볼 때도 패널이 계속 따라 나타나 번거롭다는 지적으로 제거함, 2026-08). 다시 지정하려면 이 버튼을
    // 다시 누르면 된다.
    const res = await pool.query<{ extraction_rules: Record<string, ExtractionRule> | null }>(
      'SELECT extraction_rules FROM sites WHERE id=$1', [siteId],
    )
    // 기준 마스터테이블관리에서 사용자가 직접 바꾼 라벨(예: cost_price를 "원가" 대신 "공급가")과 배치한
    // 순서를 이 패널의 필드 목록에도 그대로 반영한다 — 그래야 "직접지정" 화면과 기준 테이블을 나란히
    // 보며 비교/수정할 수 있다.
    const labelsRes = await pool.query<{ field_key: string; field_label: string }>(
      'SELECT field_key, field_label FROM master_schema_fields ORDER BY sort_order, id',
    )
    const masterLabels = Object.fromEntries(labelsRes.rows.map(r => [r.field_key, r.field_label]))
    const masterOrder = labelsRes.rows.map(r => r.field_key)
    await page.evaluate(injectElementPicker, { previewProduct: previewProduct || null, extractionRules: res.rows[0]?.extraction_rules || {}, masterLabels, masterOrder })
    return true
  })
}

/** 실제 몰 페이지 안에서 실행되는 함수 — page.evaluate로 그대로 주입된다(문자열이 아니라 함수 자체를
 *  Playwright가 직렬화). 이미 켜져 있으면 다시 켜지 않는다(같은 페이지에서 "스크랩 대상 직접지정 시작"을 또 눌러도
 *  리스너가 중복 등록되지 않도록). */
function injectElementPicker(seed?: {
  previewProduct: Record<string, unknown> | null
  extractionRules: Record<string, { type: 'label' | 'selector' | 'fixed' | 'multi'; value: string }>
  masterLabels?: Record<string, string>
  masterOrder?: string[]
}) {
  const w = window as unknown as {
    __ptpPickerActive?: boolean
    __ptpPickerTeardown?: () => void
    ptpSavePick: (payload: { field: string; type: 'label' | 'selector' | 'fixed' | 'multi'; value: string }) => Promise<void>
  }
  // 이전 인스턴스가 (정상 종료 대신) 남아있으면 조용히 무시하지 않고 먼저 정리한다 — teardown이
  // 페이지 이동과 겹쳐 조용히 실패한 채로 __ptpPickerActive만 true로 남으면, 그 뒤로 "스크랩 대상
  // 직접지정"을 다시 눌러도 이 함수가 아무 것도 안 하고 바로 리턴돼(패널이 안 보이는데 PTP 화면은
  // "활성" 상태라고 믿는) 재시작이 안 되는 문제가 있었다. 항상 깨끗한 상태에서 새로 시작하도록 보장.
  if (w.__ptpPickerActive) w.__ptpPickerTeardown?.()
  w.__ptpPickerActive = true

  const previewProduct = seed?.previewProduct || null
  // 재주입될 때마다 최신값으로 갱신되지만(다음 값들 참고), 저장/삭제 직후에는 로컬에서 즉시 반영해 화면이
  // 리로드를 기다리지 않고 바로 "등록됨" 표시를 보여주도록 한다.
  const rulesLocal: Record<string, { type: 'label' | 'selector' | 'fixed' | 'multi'; value: string }> = { ...(seed?.extractionRules || {}) }
  // 지금 "요소로 지정" 모드로 선택해둔 필드 — null이 아니면 다음 클릭이 이 필드에 저장된다. 목록에서
  // 컬럼을 먼저 고르고(선택) 화면에서 요소를 클릭 → 저장하는 순서를 반복할 수 있게 한다.
  let armedField: string | null = null
  // 방금 지정한(클릭했거나 직접 입력한) "실제 값" — 규칙 자체(라벨/셀렉터 패턴)와 달리 화면에 곧바로
  // 보여줄 목적으로만 쓴다. 지정하는 순간 그 자리에서 확인할 수 있어야 한다는 요청으로 추가.
  const lastValueLocal: Record<string, string> = {}
  // "직접 입력" 칸을 펼쳐둔 필드 집합 — 평소엔 접어둬 목록이 덜 복잡해 보이게 한다.
  const expandedInputs = new Set<string>()
  // 아직 DB 반영이 끝나지 않은 저장 요청들 — teardown이 끝나기 전에 다 기다린다(saveField 참고).
  const pendingSaves: Promise<void>[] = []

  // 기준 마스터테이블관리(master_schema_fields)에 대응 필드가 등록돼 있으면 그 라벨을 그대로 쓴다 —
  // 없는 필드(영문상품명/상품요약정보 등, 기준 테이블 대상이 아닌 값)만 기존 기본 라벨로 남긴다.
  const masterLabels = seed?.masterLabels || {}
  const PICKER_TO_MASTER_KEY: Record<string, string> = {
    name: 'name_final', price: 'list_price', cost_price: 'cost_price', shipping_fee: 'shipping_fee',
    category: 'master_category', brand: 'brand', manufacturer: 'manufacturer', origin: 'origin',
    stock_status: 'stock_status', stock_qty: 'stock_qty',
    thumbnail_urls: 'top_img', detail_image_urls: 'detail_img',
  }
  const DEFAULT_CANONICAL_LABELS: [string, string][] = [
    ['name', '상품명'], ['price', '가격(소비자가)'], ['cost_price', '공급가/원가'], ['shipping_fee', '배송비'],
    ['category', '카테고리'], ['brand', '브랜드'], ['manufacturer', '제조사'], ['origin', '원산지'],
    ['stock_status', '재고상태'], ['stock_qty', '재고수량'], ['english_name', '영문상품명'], ['summary_info', '상품요약정보'],
    ['thumbnail_urls', '대표이미지'], ['detail_image_urls', '상세이미지'],
  ]
  const relabeled: [string, string][] = DEFAULT_CANONICAL_LABELS.map(([key, defaultLabel]) => {
    const masterKey = PICKER_TO_MASTER_KEY[key]
    const liveLabel = masterKey ? masterLabels[masterKey] : undefined
    return [key, liveLabel || defaultLabel]
  })
  // 컬럼 순서도 기준 마스터테이블관리에서 정렬해둔 순서를 그대로 따라간다 — 대응 필드가 없는 것(영문상품명/
  // 상품요약정보 등)은 정렬 기준이 없으니 원래 순서 그대로 맨 뒤로 보낸다.
  const masterOrder = seed?.masterOrder || []
  const CANONICAL_FIELDS: [string, string][] = [...relabeled].sort((a, b) => {
    const idxA = masterOrder.indexOf(PICKER_TO_MASTER_KEY[a[0]])
    const idxB = masterOrder.indexOf(PICKER_TO_MASTER_KEY[b[0]])
    if (idxA === -1 && idxB === -1) return 0
    if (idxA === -1) return 1
    if (idxB === -1) return -1
    return idxA - idxB
  })
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
    <button id="ptp-picker-x" title="닫기" style="position:absolute;top:6px;right:8px;background:none;border:0;color:#999;font-size:16px;line-height:1;cursor:pointer;padding:2px 4px">✕</button>
    <div id="ptp-picker-drag" style="margin-bottom:6px;cursor:move;user-select:none;padding-right:20px">
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

  function saveField(field: string, type: 'label' | 'selector' | 'fixed' | 'multi', value: string, displayValue: string) {
    rulesLocal[field] = { type, value }
    lastValueLocal[field] = displayValue
    // 저장 자체는 화면을 안 막도록 fire-and-forget이지만, teardown(피커 저장/종료)이 이 promise를 기다릴 수
    // 있게 목록에 담아둔다 — 안 담으면 "종료"를 누른 직후 실행되는 미리보기 재조회가 아직 DB에 반영 안 된
    // 값을 읽어와, 방금 지정한 게 미리보기에 안 바뀐 것처럼 보이는 문제가 있었다(실사용 재현됨).
    pendingSaves.push(w.ptpSavePick({ field, type, value }).catch(() => {}))
    logLine(field)
  }

  // 규칙을 아예 지워버리면(미지정) 자동/AI 추출이 다시 이 필드를 채울 수 있다 — "이 필드는 값이 없어야
  // 한다"는 명시적 결정을 남기려면 빈 고정값 규칙을 저장해 자동 추출도 AI모드(runAutoAnalysis)도 다시
  // 건드리지 못하게 해야 한다. 이미 지정된 필드의 ✕(삭제)뿐 아니라, 아직 지정한 적 없지만 자동값이
  // 보이는 필드에서 "그 자동값을 없애고 싶다"는 요청에도 똑같이 쓴다.
  function forceEmpty(field: string) {
    rulesLocal[field] = { type: 'fixed', value: '' }
    lastValueLocal[field] = ''
    pendingSaves.push(w.ptpSavePick({ field, type: 'fixed', value: '' }).catch(() => {}))
    logLine(`🚫 ${field}`)
  }

  // 이미 지정돼 있는 필드를 클릭식으로 다시 지정하면(예: 상품명이 브랜드+모델명 두 요소로 나뉜 몰),
  // 기존 값을 덮어쓰지 않고 새 요소를 이어붙인다 — 한 컬럼에 여러 요소를 지정할 수 있게 해달라는 요청.
  // 값 하나로 대체하고 싶으면 먼저 ✕로 지워 새로 지정하면 된다. 대표/상세이미지(갤러리 셀렉터 하나로
  // 전체를 잡는 방식)는 이 결합 대상에서 제외 — 별도의 갤러리 지정 방식을 그대로 쓴다.
  function appendOrSaveField(field: string, part: { type: 'label' | 'selector' | 'fixed'; value: string }, displayValue: string) {
    const existing = rulesLocal[field]
    // 직접 입력(고정값)도 다른 조각과 결합 가능 — 클릭으로 찾은 값 + 타이핑한 접미사처럼 섞어 쓸 수
    // 있게 한다. 대표/상세이미지는 텍스트를 이어붙이는 이 방식이 아니라 이미지 장수를 누적하는
    // appendImagePart를 따로 쓴다(아래).
    if (!existing || IMAGE_FIELDS.has(field)) {
      saveField(field, part.type, part.value, displayValue)
      return
    }
    let parts: { type: 'label' | 'selector' | 'fixed'; value: string }[]
    if (existing.type === 'multi') {
      try { parts = JSON.parse(existing.value) } catch { parts = [] }
    } else {
      parts = [{ type: existing.type, value: existing.value }]
    }
    parts.push(part)
    const combinedDisplay = [lastValueLocal[field], displayValue].filter(Boolean).join(' ')
    saveField(field, 'multi', JSON.stringify(parts), combinedDisplay)
  }

  // 대표/상세이미지 전용 결합 — 클릭할 때마다 그 갤러리(형제 img들) 전체를 새 조각으로 이어붙인다.
  // 상품에 따라 이미지들이 하나의 공통 컨테이너 안에 있지 않고 여러 군데로 나뉜 마크업(실사용 확인)에서,
  // 한 번의 클릭으로 잡히는 셀렉터 하나만으로는 전체 이미지를 다 못 잡을 때 "+" 격으로 계속 추가한다.
  // 표시값은 텍스트를 이어붙이는 대신 지금까지 조각들이 실제로 매칭하는 이미지 총 장수를 다시 센다.
  function appendImagePart(field: string, selector: string) {
    const existing = rulesLocal[field]
    let parts: { type: 'label' | 'selector' | 'fixed'; value: string }[]
    if (existing?.type === 'multi') {
      try { parts = JSON.parse(existing.value) } catch { parts = [] }
    } else if (existing) {
      parts = [{ type: existing.type, value: existing.value }]
    } else {
      parts = []
    }
    parts.push({ type: 'selector', value: selector })
    const totalCount = parts.reduce((sum, p) => sum + (p.type === 'selector' ? document.querySelectorAll(p.value).length : 0), 0)
    const display = totalCount ? `이미지 ${totalCount}장` : '(이미지를 찾지 못함)'
    if (parts.length > 1) saveField(field, 'multi', JSON.stringify(parts), display)
    else saveField(field, 'selector', selector, display)
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
      // 고정값인데 값이 빈 문자열 = 사용자가 ✕(삭제)로 "이 필드는 값이 없어야 한다"고 명시적으로 확정한
      // 상태 — 자동/AI 추출이 다시 채우지 못하게 막는 용도라 일반 "고정값"과 뱃지/문구를 다르게 보여준다.
      const isForcedEmpty = rule?.type === 'fixed' && rule.value === ''
      let badgeText = ''
      if (rule) {
        if (isForcedEmpty) badgeText = '🚫 값 없음 고정'
        else if (rule.type === 'label') badgeText = '📋 라벨'
        else if (rule.type === 'fixed') badgeText = '✏️ 고정값'
        else if (rule.type === 'multi') {
          let partCount = 0
          try { partCount = JSON.parse(rule.value).length } catch { partCount = 0 }
          badgeText = `🧩 ${partCount}개 결합`
        } else badgeText = '🔗 셀렉터'
      }
      const badge = rule
        ? `<span style="font-size:10px;background:#fff;color:#0d9488;border:1px solid #5eead4;border-radius:8px;padding:1px 6px;white-space:nowrap">${badgeText}</span>`
        : ''
      // 규칙이 없어도(미지정) 지금 자동/휴리스틱 추출로 잡힌 값이 있으면 같이 보여준다 — 안 그러면
      // "미지정"이라 값 자체가 없는 줄 알았는데 미리보기엔 값이 나와 있어 혼란스럽다는 지적이 있었다.
      // 자동값도 없으면(진짜 빈 값) 굳이 "(값 없음)"을 안 붙이고 "미지정"만 보여준다.
      const autoValue = !rule ? currentValue(key) : ''
      const valueLine = isForcedEmpty
        ? `<div style="font-size:12px;color:#e11d48;font-weight:600;margin:3px 0">항상 빈 값 (자동/AI 추출 안 함)</div>`
        : rule
          ? `<div style="font-size:12px;color:#0d9488;font-weight:600;margin:3px 0;word-break:break-all">${esc(lastValueLocal[key] ?? currentValue(key)) || '(값 없음)'}</div>`
          : autoValue
            ? `<div style="font-size:10px;color:#bbb;margin:3px 0">미지정 · 자동값: <span style="color:#888">${esc(autoValue)}</span></div>`
            : `<div style="font-size:10px;color:#bbb;margin:3px 0">미지정</div>`
      const delBtn = rule
        ? `<button class="ptp-row-del" data-field="${esc(key)}" title="삭제" style="background:#fff;color:#e11d48;border:1px solid #fca5a5;border-radius:5px;padding:3px 7px;font-size:10px;cursor:pointer">✕</button>`
        : autoValue
          ? `<button class="ptp-row-clear-auto" data-field="${esc(key)}" title="자동으로 잡힌 값을 무시하고 항상 빈 값으로 고정합니다"
              style="background:#fff;color:#e11d48;border:1px solid #fca5a5;border-radius:5px;padding:3px 7px;font-size:10px;cursor:pointer">🚫 자동값 제거</button>`
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
              title="${rule ? '이미 지정된 값에 새 요소(이미지)를 이어붙입니다 — 바꾸려면 먼저 ✕로 지우세요' : ''}"
              style="${armBtnStyle};border-radius:5px;padding:4px 6px;font-size:10px;cursor:pointer">
              ${armed ? '❌ 클릭 대기 취소' : !rule ? '🎯 클릭해서 지정하기' : IMAGE_FIELDS.has(key) ? '🎯 이미지 추가' : '🎯 요소 추가'}
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
    // innerHTML을 통째로 바꾸면 스크롤 위치가 맨 위로 리셋된다 — 지정 하나 할 때마다 목록이 다시
    // 그려지므로(값/배지 갱신 때문에 필요), 그때마다 스크롤을 기억해뒀다가 그대로 되돌려 놓는다.
    // 그래야 아래쪽 필드를 계속 지정할 때 매번 다시 스크롤해 내려갈 필요가 없다.
    const prevScrollTop = fieldListEl.scrollTop
    fieldListEl.innerHTML = rowsHtml
    fieldListEl.scrollTop = prevScrollTop

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
        appendOrSaveField(field, { type: 'fixed', value }, value)
        expandedInputs.delete(field)
        renderFieldList()
      })
    })
    fieldListEl.querySelectorAll<HTMLButtonElement>('.ptp-row-del').forEach(btn => {
      btn.addEventListener('click', () => { forceEmpty(btn.dataset.field!); renderFieldList() })
    })
    fieldListEl.querySelectorAll<HTMLButtonElement>('.ptp-row-clear-auto').forEach(btn => {
      btn.addEventListener('click', () => { forceEmpty(btn.dataset.field!); renderFieldList() })
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
      appendOrSaveField(field, { type: 'fixed', value }, value)
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
      appendImagePart(armedField, computeGallerySelector(el))
    } else {
      const label = detectLabel(el)
      const rule = label ? { type: 'label' as const, value: label } : { type: 'selector' as const, value: computeSelector(el) }
      appendOrSaveField(armedField, rule, elementDisplayText(el))
    }
    armedField = null
    renderFieldList()
    updateStatus()
    if (hovered) { hovered.style.outline = ''; hovered = null }
  }

  panel.querySelector('#ptp-picker-close')!.addEventListener('click', () => w.__ptpPickerTeardown?.())
  panel.querySelector('#ptp-picker-x')!.addEventListener('click', () => w.__ptpPickerTeardown?.())

  document.addEventListener('mouseover', onMouseOver, true)
  document.addEventListener('click', onClick, true)

  w.__ptpPickerTeardown = async () => {
    // 각 줄에 열어둔 채 저장 버튼을 안 누른 입력값(직접 입력 칸, 새 컬럼 이름/값)이 있으면 닫기 전에
    // 마저 저장한다 — 타이핑만 하고 저장을 안 누른 채 닫아서 값이 유실되는 걸 막는다. 패널 자체의
    // 닫기(✕) 버튼이 유일한 종료 경로다 — PTP 화면 쪽엔 더 이상 별도의 "종료" 버튼이 없다(2026-08,
    // 패널을 닫아도 창을 옮겨다니면 계속 다시 뜨던 게 번거롭다는 지적으로 자동 재주입 자체를 없앴다).
    fieldListEl.querySelectorAll<HTMLInputElement>('.ptp-row-input').forEach(input => {
      const value = input.value.trim()
      if (value) appendOrSaveField(input.dataset.field!, { type: 'fixed', value }, value)
    })
    const newNameEl = fieldListEl.querySelector<HTMLInputElement>('#ptp-new-field-name')
    const newValueEl = fieldListEl.querySelector<HTMLInputElement>('#ptp-new-field-value')
    if (newNameEl?.value.trim() && newValueEl?.value.trim()) {
      appendOrSaveField(newNameEl.value.trim(), { type: 'fixed', value: newValueEl.value.trim() }, newValueEl.value.trim())
    }
    document.removeEventListener('mouseover', onMouseOver, true)
    document.removeEventListener('click', onClick, true)
    onDragEnd() // 드래그 도중 종료를 눌렀을 수도 있어 남아있을 수 있는 리스너를 정리
    if (hovered) hovered.style.outline = ''
    panel.remove()
    w.__ptpPickerActive = false
    w.__ptpPickerTeardown = undefined
    // 방금 위에서 마저 저장한 것들을 포함해, 아직 DB에 안 끝난 저장이 있으면 여기서 다 끝날 때까지
    // 기다린다 — 패널을 닫자마자 사용자가 바로 "스크랩 미리보기"를 눌러도 이번 세션에서 지정한 값이
    // 이미 DB에 반영돼 있도록 보장한다.
    await Promise.all(pendingSaves)
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
  return withContext(opts, page => sampleMallProfile(page, startUrlHint, site.name, false), '구조 변화 감지')
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

  // 아직 페이지 이동 전(현재 page가 startUrl) — 카테고리 메뉴/후보 링크 스캔은 반드시 여기서 먼저 한다.
  // 아래(랜딩 페이지 재시도)가 실제로 페이지를 이동시키므로, 이동 후로 미루면 이 몰의 헤더가 안 보일 수 있다.
  const categoryLinkCandidates = await findCategoryLinkCandidates(page)
  let categoryLinks = await scanCategoryMenu(page)
  // 메뉴가 텍스트로 못 읽는 형태(이미지 스프라이트 등, 실사용 확인: 진짜양말)면, 후보 링크로 실제 들어가
  // 그 목록 페이지 자신의 카테고리 라벨을 대신 읽는다(discoverCategoriesByVisitingLinks 참고). 페이지를
  // 여러 번 더 열어야 해 무거운 작업이라 deep("몰 구조 파악" 버튼)에서만 한다.
  if (deep && !categoryLinks.length && categoryLinkCandidates.length) {
    categoryLinks = await discoverCategoriesByVisitingLinks(page, categoryLinkCandidates)
    await page.goto(startUrl, { waitUntil: 'load', timeout: 20_000 }).catch(() => {})
  }
  const categoryMenuNames = categoryLinks.map(c => c.name)
  // 같은 이유로, 상품 샘플로 이동하기 전에 지금 페이지(홈/목록)의 하단 회사정보와 이용안내·공지 등
  // 게시판 링크를 먼저 훑어 원문을 모아둔다 — 결제계좌/택배사/연락처는 상품페이지가 아니라 이런 정적
  // 페이지에 있다(실사용 몰 확인됨). deep(=="몰 구조 파악" 버튼)에서만 하는 무거운 작업이라 로그인
  // 확인/스크랩 시작마다 도는 가벼운 체크에서는 건너뛴다. 페이지 이동이 있어 시간이 들 수 있어 실패해도
  // 나머지 흐름은 계속한다.
  const contextText = deep ? await gatherMallContextText(page).catch(() => '') : ''

  // 등록된 몰 URL이 배너/메뉴만 있는 랜딩 페이지라 상품 링크가 0개인 몰도 있다(실사용 확인: 진짜양말 —
  // 홈페이지엔 이미지 스프라이트 메뉴만 있고 상품은 그 메뉴를 눌러 들어간 카테고리 목록에만 있음). 그대로
  // 포기하면 홈페이지 자체를 "상품 1건"으로 취급해 카테고리/옵션/재고 등 거의 모든 신호가 비어버리므로,
  // 위에서 찾은 카테고리 후보 링크를 몇 개 따라 들어가 재시도한다. 후보 하나에서만 다 채우면 그 카테고리
  // 하나로 구조가 쏠려버리므로(실사용 확인: "사은품양말"만 나옴), 후보마다 최대 2건씩만 담아 여러
  // 카테고리에 걸쳐 샘플링한다.
  if (!sampleUrls.length) {
    const urls: string[] = []
    const mergedByUrl = new Map<string, CategoryLabel>()
    for (const link of categoryLinkCandidates) {
      if (urls.length >= MALL_PROFILE_SAMPLE_SIZE) break
      try {
        const collected = await collectProductUrls(page, { url: link, maxPages: 1 })
        platform = collected.platform
        for (const u of collected.urls.slice(0, 2)) {
          if (urls.length >= MALL_PROFILE_SAMPLE_SIZE || urls.includes(u)) continue
          urls.push(u)
          const label = collected.categoryByUrl.get(u)
          if (label) mergedByUrl.set(u, label)
        }
      } catch { /* 이 후보 링크가 안되면 다음 후보로 */ }
    }
    if (urls.length) { sampleUrls = urls; categoryByUrl = mergedByUrl }
  }
  if (!sampleUrls.length) sampleUrls = [startUrl]
  // 카탈로그로 인식되지 않아 platform이 못 잡혔으면(위 예외로 빠진 경우), 지금 보고 있는 페이지 자체에서
  // 다시 감지한다 — 상품 상세페이지도 플랫폼 감지에 필요한 generator/스크립트 태그는 대부분 그대로 갖고 있다.
  if (platform === 'unknown') platform = await detectMallPlatform(page).catch(() => 'unknown' as MallPlatform)

  const signals: MallProfileSignals = {
    sampleCount: 0, platform, sampleProductUrl: sampleUrls[0], hasMainImages: false, hasDetailImages: false,
    optionUiTypes: [], hasCascadingOptions: false, hasStockQty: false, hasStockStatusText: false,
    hasStockByOption: false, hasDetailText: false, infoLabels: [], categoryPaths: [], categoryMaxDepth: 0,
    categoryMenuNames, categoryLinks, report: null,
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
        const imageHints = await page.evaluate(collectImageHintsScript, null).catch(() => [] as string[])
        productContextText = `[샘플 상품페이지: ${url}]\n${bodyText.replace(/\s+/g, ' ').trim().slice(0, 4_000)}`
          + (imageHints.length ? `\n\n[샘플 상품페이지 이미지 설명/파일명]\n${imageHints.join(', ')}` : '')
        signals.sampleProductPageText = bodyText
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
/** 택배사/은행 로고처럼 글자가 아니라 이미지로만 표시된 정보를 놓치지 않도록, 주어진 요소 안의 <img>
 *  alt 속성(없으면 파일명)을 모아온다 — textContent/innerText는 이미지에서 아무 것도 못 얻어온다
 *  (실사용 확인: 택배사가 로고 이미지로만 붙어있어 "한진택배"라는 글자가 원문 어디에도 없었음). */
function collectImageHintsScript(rootSelector: string | null): string[] {
  const root = rootSelector ? document.querySelector(rootSelector) : document.body
  if (!root) return []
  const hints = Array.from(root.querySelectorAll('img')).map(img => {
    const alt = img.getAttribute('alt')?.trim()
    if (alt) return alt
    const src = img.getAttribute('src') || ''
    const base = src.split('/').pop()?.split('?')[0].replace(/\.[a-zA-Z0-9]+$/, '') || ''
    return base.replace(/[-_]+/g, ' ').trim()
  }).filter(Boolean)
  return [...new Set(hints)].slice(0, 30)
}

async function gatherMallContextText(page: Page): Promise<string> {
  const sections: string[] = []
  const footerSelector = 'footer, #footer, .footer, .company_info, .footer_info'
  const footerText = await page.evaluate(sel => {
    const el = document.querySelector(sel)
    return (el?.textContent || '').replace(/\s+/g, ' ').trim()
  }, footerSelector).catch(() => '')
  if (footerText) sections.push(`[하단 회사정보]\n${footerText.slice(0, 1_500)}`)
  const footerImageHints = await page.evaluate(collectImageHintsScript, footerSelector).catch(() => [] as string[])
  if (footerImageHints.length) sections.push(`[하단 영역 이미지 설명/파일명]\n${footerImageHints.join(', ')}`)

  // 카테고리 메뉴가 <ul><li> 구조가 아니라 scanCategoryMenu가 못 뽑아내는 몰도 있다 — AI가 그래도 참고할
  // 수 있도록, 헤더/내비게이션 영역의 링크 텍스트를 구조 검증 없이 그대로 모아 별도 절로 남겨둔다.
  const navText = await page.evaluate(() => {
    const roots = Array.from(document.querySelectorAll('nav, [class*="gnb" i], [id*="gnb" i], [class*="lnb" i], [id*="lnb" i], [class*="cat" i], [id*="cat" i]'))
    const names = roots.flatMap(root => Array.from(root.querySelectorAll('a')).map(a => (a.textContent || '').trim()).filter(t => t && t.length <= 15))
    return [...new Set(names)].slice(0, 100).join(', ')
  }).catch(() => '')
  if (navText) sections.push(`[헤더/카테고리 메뉴 텍스트 (참고용 — 구조는 불확실할 수 있음)]\n${navText}`)

  const baseUrl = new URL(page.url()).origin
  const links = await findInfoPageLinks(page)
  for (const link of links) {
    if (!link.href.startsWith(baseUrl)) continue
    try {
      await page.goto(link.href, { waitUntil: 'load', timeout: 15_000 })
      const text = await page.evaluate(() => document.body.innerText).catch(() => '')
      if (text.trim()) sections.push(`[${link.text}]\n${text.replace(/\s+/g, ' ').trim().slice(0, 2_500)}`)
      const imageHints = await page.evaluate(collectImageHintsScript, null).catch(() => [] as string[])
      if (imageHints.length) sections.push(`[${link.text} 페이지 이미지 설명/파일명]\n${imageHints.join(', ')}`)
    } catch { /* 게시판 접근 실패(로그인 필요 등)는 건너뛰고 다음 링크로 */ }
  }
  return sections.join('\n\n')
}

const INFO_PAGE_KEYWORDS = /배송|반품|반송|교환|환불|이용안내|이용약관|회사소개|공지|고객센터|무통장|계좌|입금안내/
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
        if (opts.aiMode && opts.siteId) {
          const ai = await applyAiModeRules(page, opts.siteId, sourceUrl, opts, domOptions)
          if (ai) return { sourceUrl, product: ai.product }
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
  }, '재스크랩')
}

/** "스크랩 조정" 기능(일반모드)이 AI에게 실제 페이지를 보여주기 위해 원문을 그대로 가져온다. */
export async function fetchPageText(opts: ScrapeOptions & { url: string }): Promise<string> {
  return withContext(opts, async page => {
    await page.goto(opts.url, { waitUntil: 'load', timeout: 30_000 })
    await loginIfNeeded(page, opts)
    return page.content()
  }, '스크랩 조정')
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

export type MallPlatform = 'cafe24' | 'makeshop' | 'godomall' | 'domesin' | 'unknown'

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
  // 도매의신(domesin.com) — 실제 페이지로 확인: productLinkSelector 없이도 detailUrlPattern만 지정하면
  // 범용 폴백(img 감싼 <a> 전체)에 이 필터가 그대로 적용된다(scanCurrentPage 참고). 이게 없으면 홈페이지
  // 등에서 이벤트 배너/FAQ 링크(예: p=event_list.html, p=helpdesk/faq.html)까지 "상품"으로 잘못 인식했다
  // (실사용 확인 — 사용자가 홈페이지를 몰 URL로 등록해둔 상태에서 "스크랩 미리보기"가 상품을 잘못 찾음).
  domesin:  { productLinkSelector: null, nextPageSelector: null, detailUrlPattern: /p=view\.html.*iid=/i },
  unknown:  { productLinkSelector: null, nextPageSelector: null, detailUrlPattern: null },
}

/** 페이지의 meta/스크립트/URL 패턴을 보고 어떤 쇼핑몰 구축 플랫폼인지 추정한다. */
async function detectMallPlatform(page: Page): Promise<MallPlatform> {
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
    if (url.includes('domesin.com')) return 'domesin'
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
export interface CategoryMenuLink {
  name: string
  href: string
}

/** 카테고리 메뉴처럼 보이는 영역에 로그인/장바구니 같은 무관한 메뉴나, 고객은 볼 일 없는 몰 내부 운영용
 *  태그(제품촬영 지시, 입고 대기, 단가 조정 등)가 함께 섞여 나오는 몰이 있다(실사용 확인) — 이런 라벨은
 *  카테고리로 인정하지 않는다. 라벨 자체가 이 패턴에 걸리면 그 하위 항목까지 전부 내부용일 가능성이
 *  높아 하위까지 통째로 건너뛴다. */
const NON_CATEGORY_TEXT_RE = /로그인|회원가입|로그아웃|장바구니|마이페이지|고객센터|검색어?|주문|배송조회|결제|사이트맵|관리자|촬영명령|입고대?기|입고대령|단가\s*(인상|조정)|재진행|색상?\s*(별)?\s*분류|cart|login|logout|mypage|search|sitemap/i

async function scanCategoryMenu(page: Page): Promise<CategoryMenuLink[]> {
  return page.evaluate(({ excludeSrc }) => {
    const excludeRe = new RegExp(excludeSrc, 'i')
    // 몰마다(플랫폼/테마마다) 카테고리 메뉴 래퍼의 정확한 class/id가 제각각이라(고도몰 .ovmenu, 카페24
    // 커스텀테마 df-lnb-category, 도매의신 div_cat 등) 매번 실제 몰을 열어보고 하드코딩 셀렉터를 하나씩
    // 추가해왔다 — 근본적으로는 정확한 이름을 다 알 수 없으므로, 이름의 "일부"(부분 문자열)로 넓게
    // 후보를 잡고 실제 카테고리 트리처럼 보이는지(아래 buildPaths + 최소 2개 조건)는 그대로 구조로
    // 검증한다. 다만 "cat"처럼 카테고리 의도가 명확한 키워드보다 "gnb"/"nav"처럼 범용 내비게이션을
    // 가리키는 키워드가 먼저 매칭되면 로그인/장바구니 등 무관한 메뉴를 카테고리로 오인할 위험이 커서
    // (실제 발견: 걸스굽 df-gnb-items가 실제 카테고리 ul보다 더 많은 항목을 가짐), 구체적인 신호부터
    // 순서대로 시도하고 앞 단계에서 못 찾을 때만 더 넓은 후보로 넘어간다.
    const SELECTOR_TIERS = [
      '[class*="cat" i], [id*="cat" i]',
      '[class*="lnb" i], [id*="lnb" i], [class*="snb" i], [id*="snb" i], [class*="ovmenu" i]',
      '[class*="gnb" i], [id*="gnb" i], nav',
    ]
    const isMeaningful = (s: string) => !!s && /[가-힣a-zA-Z0-9]/.test(s)
    // li 자신의 라벨만 읽는다 — 하위 <ul>(다음 레벨 카테고리들) 텍스트가 그대로 섞여 들어가지 않도록
    // 사본에서 중첩 목록을 먼저 제거하고 읽는다(cleanText와 같은 패턴).
    function ownText(li: Element): string {
      const clone = li.cloneNode(true) as Element
      clone.querySelectorAll('ul, ol').forEach(n => n.remove())
      return (clone.textContent || '').trim()
    }
    // 하위 <ul>(다음 레벨) 안의 <a>까지 섞이지 않도록, li 바로 안(중첩 목록 제외)의 첫 링크만 이 항목의
    // 실제 이동 URL로 본다 — "카테고리 불러오기"가 이름뿐 아니라 클릭해서 스크랩할 수 있는 링크도 함께
    // 쓸 수 있도록 하기 위함(예전엔 이름만 남기고 버렸다).
    function ownHref(li: Element): string {
      const clone = li.cloneNode(true) as Element
      clone.querySelectorAll('ul, ol').forEach(n => n.remove())
      return (clone.querySelector('a[href]') as HTMLAnchorElement | null)?.href || ''
    }
    function buildPaths(li: Element, prefix: string[], depth: number, out: { name: string; href: string }[]) {
      if (depth > 3 || out.length > 200) return
      const name = ownText(li)
      if (!isMeaningful(name)) return
      if (excludeRe.test(name)) return // 이 라벨 자체가 카테고리가 아니면 하위 항목까지 통째로 건너뜀
      const path = [...prefix, name]
      const childLis = Array.from(li.querySelectorAll(':scope > ul > li, :scope > div > ul > li'))
      if (childLis.length) {
        childLis.forEach(sub => buildPaths(sub, path, depth + 1, out))
      } else {
        const href = ownHref(li)
        if (href) out.push({ name: path.join(' > '), href })
      }
    }
    for (const tierSelector of SELECTOR_TIERS) {
      let candidates: Element[]
      try { candidates = Array.from(document.querySelectorAll(tierSelector)) } catch { continue }
      // 한 티어 안에서도 후보가 여러 개(예: 헤더 카테고리 + 전체메뉴 플라이아웃 사본) 나올 수 있어,
      // 후보 하나가 우연히 매칭됐을 뿐(카테고리 메뉴가 아닌 다른 위젯)일 위험을 줄이려고 요구하는 "최소
      // 2개 이상" 조건을 만족하는 후보 중 가장 많은 경로를 뽑아낸 것을 채택한다.
      let best: { name: string; href: string }[] = []
      for (const root of candidates) {
        const topLis = Array.from(root.querySelectorAll(':scope > ul > li, :scope > li, :scope > div > ul > li'))
        if (!topLis.length) continue
        const out: { name: string; href: string }[] = []
        topLis.forEach(li => buildPaths(li, [], 0, out))
        const seenNames = new Set<string>()
        const uniq = out.filter(o => (seenNames.has(o.name) ? false : (seenNames.add(o.name), true)))
        if (uniq.length >= 2 && uniq.length > best.length) best = uniq
      }
      if (best.length) return best
    }
    return []
  }, { excludeSrc: NON_CATEGORY_TEXT_RE.source }).catch(() => [])
}

/** 시작 페이지에 상품 링크가 0개일 때(배너 전용 랜딩 페이지) 따라 들어가볼 카테고리 후보 링크를 모은다.
 *  scanCategoryMenu와 같은 후보 영역(cat/lnb/snb/ovmenu/gnb/nav)을 쓰되, 이름이 아니라 링크(href)를 모은다
 *  — 메뉴가 이미지 스프라이트(alt 없음)라 이름은 못 뽑아도 링크는 href로 그대로 얻을 수 있다. */
async function findCategoryLinkCandidates(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const TIERS = [
      '[class*="cat" i], [id*="cat" i]',
      '[class*="lnb" i], [id*="lnb" i], [class*="snb" i], [id*="snb" i], [class*="ovmenu" i]',
      '[class*="gnb" i], [id*="gnb" i], nav',
    ]
    const origin = location.origin
    const current = location.href.replace(/\/+$/, '')
    const seen = new Set<string>()
    const result: string[] = []
    for (const tier of TIERS) {
      let roots: Element[]
      try { roots = Array.from(document.querySelectorAll(tier)) } catch { continue }
      for (const root of roots) {
        Array.from(root.querySelectorAll('a[href]')).forEach(a => {
          const href = (a as HTMLAnchorElement).href
          if (!href.startsWith(origin)) return
          const norm = href.replace(/\/+$/, '')
          if (norm === current || norm === origin || seen.has(norm)) return
          seen.add(norm)
          result.push(href)
        })
      }
      if (result.length) return result.slice(0, 15)
    }
    return result
  }).catch(() => [])
}

/** scanCategoryMenu가 메뉴 텍스트를 못 읽을 때(이미지 스프라이트/아이콘 폰트 메뉴 등이라 <li> 안에 글자가
 *  전혀 없는 경우, 실사용 확인: 진짜양말 — alt 없는 메뉴 이미지라 이름이 마크업 어디에도 없음)의 대안이다.
 *  메뉴 자체는 못 읽어도 "링크"(href)는 findCategoryLinkCandidates로 얻을 수 있으니, 그 링크로 실제
 *  들어가 목적지 목록 페이지 자신이 보여주는 카테고리 라벨(브레드크럼/타이틀 — 사용자가 봐야 하는 화면이라
 *  메뉴와 달리 거의 항상 실제 텍스트로 존재한다)을 detectCategoryLabel로 읽어 대신 채운다. */
async function discoverCategoriesByVisitingLinks(page: Page, links: string[]): Promise<CategoryMenuLink[]> {
  const seenNames = new Set<string>()
  const result: CategoryMenuLink[] = []
  for (const link of links) {
    try {
      await page.goto(link, { waitUntil: 'load', timeout: 15_000 })
      const { category } = await detectCategoryLabel(page)
      if (category && !NON_CATEGORY_TEXT_RE.test(category) && !seenNames.has(category)) {
        seenNames.add(category)
        result.push({ name: category, href: link })
      }
    } catch { /* 이 링크가 안되면 다음 링크로 */ }
  }
  return result
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
  /** 목록 페이지 자체가 로그인 세션 끊김으로 보임(로그인폼이 계속 보임) — true면 이 결과 자체가
   *  비로그인 상태로 얻어졌을 수 있다는 뜻 */
  needsLogin: boolean
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

/** 목록 페이지(들)을 순회하며 제품 URL 후보를 모은다. 실제 상품 추출은 하지 않는다(테스트/실행 공용 로직).
 *  context를 넘기고 카테고리(listingUrls)가 여러 개면 탭을 나눠 동시에 훑는다 — 예전엔 카테고리 하나씩
 *  순서대로 방문해서, 카테고리 수만큼 페이지 로딩 시간이 그대로 누적됐다(실사용 확인: 카테고리 9개짜리
 *  미리보기가 5~7분씩 걸림 — 상품 상세페이지는 건드리지 않는데도 목록 페이지 자체를 순서대로 도는
 *  것만으로 이렇게 오래 걸렸다). context가 없거나 목록이 1개뿐이면(병렬로 나눌 이득이 없음) 예전과 같이
 *  순차로 돈다. */
async function collectProductUrls(page: Page, opts: ScrapeOptions, context?: BrowserContext): Promise<CollectedLinks> {
  if (opts.productUrls?.length) {
    return { urls: opts.productUrls, platform: 'unknown', categoryByUrl: new Map(), linkInfo: new Map(), needsLogin: false }
  }

  const listingUrls = (opts.categoryUrls?.length ? opts.categoryUrls : (opts.url ? [opts.url] : [page.url()])).map(resetToFirstPage)
  const maxPages = Math.max(1, opts.maxPages || AUTO_PAGINATION_CAP)

  let needsLogin = false
  if (opts.url || opts.categoryUrls?.length) {
    await page.goto(listingUrls[0], { waitUntil: 'load', timeout: 30_000 })
    needsLogin = await loginIfNeeded(page, { url: listingUrls[0], ...opts })
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

  async function scanForProducts(targetPage: Page): Promise<{ href: string; name: string; thumbnail: string }[]> {
    const items: { href: string; name: string; thumbnail: string }[] = await targetPage.evaluate(({ userSel, platformSel, detailPatternSrc }) => {
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
      // 범용 폴백: 썸네일 이미지를 감싼 링크만 제품으로 인식. 알려진 플랫폼이 아니면(detailRe 없음) 위
      // 상세 URL 패턴 필터가 사실상 통과라서, 로고(홈 링크)나 "목록 자기 자신으로 돌아가는" 썸네일
      // 링크(실사용 확인 — 신우: 상품 이미지 위 배너가 지금 보고 있는 목록 URL 그대로를 가리킴)까지
      // "상품"으로 잘못 인식해 그 카테고리 상품이 아닌 걸(심지어 홈페이지 자체를) 미리보기하게 되는
      // 문제가 있었다. 지금 보고 있는 페이지 자기 자신과 사이트 루트(로고)는 상품일 수 없으니 제외한다.
      const normalize = (u: string) => u.replace(/\/+$/, '')
      const currentNorm = normalize(location.href)
      const originNorm = normalize(location.origin)
      return pick('a', true, true).filter(item => {
        const n = normalize(item.href)
        return n !== currentNorm && n !== originNorm
      })
    }, { userSel, platformSel, detailPatternSrc: profile.detailUrlPattern?.source })
    return items.filter(item => item.href.startsWith(baseUrl))
  }

  async function collectFromListing(workerPage: Page, listingUrl: string) {
    if (workerPage.url() !== listingUrl) {
      await workerPage.goto(listingUrl, { waitUntil: 'load', timeout: 30_000 }).catch(() => {})
    }

    const categoryLabel = await detectCategoryLabel(workerPage)
    let prevHrefs: Set<string> | null = null

    for (let p = 0; p < maxPages; p++) {
      let matched = await scanForProducts(workerPage)
      let hrefsThisPage = new Set(matched.map(m => m.href))
      const isDeadEnd = (hrefs: Set<string>) => hrefs.size === 0 || (prevHrefs !== null && [...hrefs].every(h => prevHrefs!.has(h)))

      // page 파라미터로 다음 페이지 이동을 시도했는데도 상품 목록이 그대로거나 비었으면(그 파라미터를 안 쓰는
      // 몰이거나 스킨 구조가 다른 경우), "다음" 버튼 클릭 방식으로 한 번 더 시도해본다.
      if (isDeadEnd(hrefsThisPage) && p > 0 && nextPageSelector) {
        const nextBtn = workerPage.locator(nextPageSelector).first()
        if (await nextBtn.isVisible({ timeout: 2_000 }).catch(() => false)) {
          await nextBtn.click()
          await workerPage.waitForLoadState('load', { timeout: 15_000 }).catch(() => {})
          matched = await scanForProducts(workerPage)
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
      await workerPage.goto(withPageParam(workerPage.url(), p + 2), { waitUntil: 'load', timeout: 15_000 }).catch(() => {})
    }
  }

  if (context && listingUrls.length > 1) {
    const LISTING_CONCURRENCY = Math.min(resolveConcurrency(opts, 4), listingUrls.length)
    let cursor = 0
    async function worker(workerPage: Page) {
      while (true) {
        const i = cursor++
        if (i >= listingUrls.length) return
        await collectFromListing(workerPage, listingUrls[i]).catch(() => {})
      }
    }
    const workerPages = await Promise.all(
      Array.from({ length: LISTING_CONCURRENCY }, (_, idx) => (idx === 0 ? page : context.newPage())),
    )
    await Promise.all(workerPages.map(worker))
    await Promise.all(workerPages.slice(1).map(p => p.close().catch(() => {})))
  } else {
    for (const listingUrl of listingUrls) {
      await collectFromListing(page, listingUrl)
    }
  }

  // 목록 페이지 자체와 이미 스크랩된 상품은 제외
  const listingSet = new Set(listingUrls)
  const excludeSet  = new Set(opts.excludeUrls || [])
  const urls = [...productUrlSet].filter(h => !listingSet.has(h) && !excludeSet.has(h))

  return { urls, platform, categoryByUrl, linkInfo, needsLogin }
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
  }, '스크래핑 시작')
}

export interface CatalogPreviewItem {
  url: string
  name: string
  thumbnail: string
}

export interface CategoryCount {
  url: string
  label: string
  count: number
  /** true면 이 카테고리를 세는 도중 로그인 화면으로 리다이렉트됐다 — count는 로그인 화면으로 튕기기
   *  전까지 확인된 값(불완전할 수 있음)이다. previewCatalog가 이 값들을 모아 최상위 needsLogin에 반영한다. */
  needsLogin?: boolean
}

export interface CatalogPreviewResult {
  /** 카테고리별 개수(categoryCounts)를 합산한 전체 상품 수 */
  total: number
  platform: MallPlatform
  /** 그중 상품 1건만 실제로 열어 컬럼별 데이터를 상세 추출한 결과 (찾은 상품이 없으면 null) — 나머지는
   *  "스크래핑 시작"을 누르면 어차피 다시 전체를 훑으므로, 미리보기는 이 1건만 자세히 확인한다. */
  preview: ScrapeResult | null
  /** 개발자모드(크롬 확장) 미리보기 전용 — 확장이 직접 모은 목록 페이지 기준 정보. 일반모드
   *  카탈로그 미리보기(이 함수)는 상품명/썸네일/링크를 더 이상 모으지 않아 항상 빈 배열이다
   *  (카테고리별 개수만 categoryCounts로 확인하면 충분하다는 판단 — 실제 목록은 스크랩 시작 때 얻음). */
  items: CatalogPreviewItem[]
  /** 카테고리(또는 단일 시작 URL)별 상품 개수만 — 이름/썸네일/링크는 모으지 않는다. */
  categoryCounts: CategoryCount[]
  /** true면 로그인 세션이 끊긴 채로(또는 아예 로그인 안 된 채로) 이 결과를 얻었을 수 있다 —
   *  화면에서 로그인 창을 다시 띄우도록 안내하는 데 쓴다. */
  needsLogin: boolean
  /** true면 같은 몰에 대해 더 새로운 미리보기 요청이 들어와 이 실행이 중간에 밀려났다는 뜻 — 이
   *  응답의 카운트/미리보기는 불완전할 수 있으므로 화면은 이 값이 true면 결과를 반영하지 말고
   *  조용히 무시해야 한다(그 새 요청 쪽 응답이 진짜 결과다). 클라이언트 자신이 "중지" 버튼으로
   *  스스로 취소한 경우는 fetch 자체가 AbortError로 거부돼 이 필드까지 오지 않는다 — 이건 오직
   *  "다른 탭/요청이 나를 밀어냈다"는 경우만 구분하기 위한 것. */
  superseded?: boolean
}

/** 상품 링크 매칭 로직만 — scanForProducts(collectProductUrls 내부)와 같은 판정 기준이지만 이름/썸네일은
 *  전혀 만들지 않고 개수만 반환한다(미리보기는 개수 확인만 하면 되고, 나머지는 실제 스크랩 시작 때
 *  어차피 다시 모으므로 여기서 모을 필요가 없다는 사용자 판단).
 *  isLoginPage: 이 카운팅 경로는(다른 페이지 방문 함수들과 달리) loginIfNeeded를 거치지 않아 로그인
 *  화면으로 튕겨나가도 감지할 방법이 없었다 — 로그인 폼이 있는 페이지는 상품이 0개인 빈 페이지가 아니라
 *  "우연히 몇 개의 img 링크가 있는 페이지"로 보여, 지수+이분 탐색이 절대 끝(count===0)을 못 만나 카테고리
 *  하나당 페이지를 수십 번 여는(최후 순차 폴백까지 전부 소진) 원인이 됐다(2026-08-09 seasonbag.co.kr에서
 *  재현 확인 — 몰마다 새 탭이 세션 검증에 걸려 로그인 화면으로 리다이렉트될 수 있음). 이미 매 페이지마다
 *  한 번 하는 evaluate 호출에 얹어서 검사하므로 추가 왕복이 없다.
 *  fingerprint: 범위를 벗어난 page 파라미터를 요청하면 빈 화면이 아니라 마지막 유효 페이지 내용을 그대로
 *  다시 돌려주는 몰이 있다(2026-08-09 seasonbag.co.kr에서 재현 확인 — URL은 page=32인데 실제로는 14페이지
 *  내용). count만 보면 "0이 아니니 더 있다"고 오판해 지수 탐색이 진짜 끝을 못 찾고 페이지 번호만 계속
 *  올리며 헤맨다 — 상품 링크 목록을 정렬해 이어붙인 문자열로 비교하면 "새 페이지인지 같은 내용의 반복인지"
 *  구분할 수 있다. */
async function countProductsOnPage(
  page: Page, userSel: string | null, platformSel: string | null, detailPatternSrc: string | undefined, baseUrl: string,
): Promise<{ count: number; isLoginPage: boolean; fingerprint: string }> {
  return page.evaluate(({ userSel, platformSel, detailPatternSrc, baseUrl }) => {
    const isLoginPage = !!document.querySelector('input[type="password"]')
    const detailRe = detailPatternSrc ? new RegExp(detailPatternSrc, 'i') : null
    const hrefs = (sel: string, requireImg: boolean, applyDetailFilter: boolean) => Array.from(document.querySelectorAll(sel))
      .filter(a => !requireImg || a.querySelector('img'))
      .map(a => (a as HTMLAnchorElement).href)
      .filter(href => href && href.startsWith(baseUrl))
      .filter(href => !applyDetailFilter || !detailRe || detailRe.test(href))
    const toResult = (list: string[]) => ({ count: list.length, isLoginPage, fingerprint: list.slice().sort().join('|') })
    if (userSel) return toResult(hrefs(userSel, false, false))
    if (platformSel) {
      const viaProfile = hrefs(platformSel, false, true)
      if (viaProfile.length > 0) return toResult(viaProfile)
    }
    const normalize = (u: string) => u.replace(/\/+$/, '')
    const currentNorm = normalize(location.href)
    const originNorm = normalize(location.origin)
    const fallback = Array.from(document.querySelectorAll('a'))
      .filter(a => a.querySelector('img'))
      .map(a => (a as HTMLAnchorElement).href)
      .filter(href => href && href.startsWith(baseUrl))
      .filter(href => { const n = normalize(href); return n !== currentNorm && n !== originNorm })
    return toResult(fallback)
  }, { userSel, platformSel, detailPatternSrc, baseUrl })
}

/** 페이지네이션 위젯에 보이는 페이지 번호 중 가장 큰 값을 "총 페이지 수"로 읽는다 — 사용자가 요청한
 *  "페이지당 노출 개수 × 총 페이지수 - 마지막 페이지에서 빠진 개수" 계산에 쓴다. 스킨에 따라 페이지
 *  번호를 일부만 보여줄 수 있어(예: "1 2 3 ... 10") 100% 보장은 아니지만, 흔한 스킨은 전체를 보여준다. */
async function readMaxPageNumber(page: Page, nextPageSelector: string | undefined): Promise<number | null> {
  return page.evaluate(({ nextPageSelector }) => {
    const roots: Element[] = []
    if (nextPageSelector) {
      const near = document.querySelector(nextPageSelector)?.closest('div, ul, nav, p')
      if (near) roots.push(near)
    }
    if (!roots.length) roots.push(...Array.from(document.querySelectorAll('[class*="paging" i], [class*="pagination" i]')))
    let max = 0
    for (const el of roots) {
      // <span>/<strong> 등 링크가 아닌 요소까지 다 보면, 같은 영역에 우연히 들어있는 "총 240개" 같은
      // 무관한 숫자(상품 총계 배지 등)를 페이지 번호로 잘못 집을 수 있다(실사용 확인된 문제 — 여러
      // 카테고리가 전부 그 배지 숫자로 동일하게 나옴). 실제 페이지 번호는 거의 항상 클릭 가능한 링크
      // (href 있는 <a>)이므로 그것만 본다.
      Array.from(el.querySelectorAll('a[href]')).forEach(node => {
        const n = Number((node.textContent || '').trim())
        if (Number.isInteger(n) && n > 0 && n < 100_000 && n > max) max = n
      })
    }
    return max > 0 ? max : null
  }, { nextPageSelector }).catch(() => null)
}

/** 지금 실제로 몇 페이지를 보고 있는지, 위젯이 스스로 표시하는 값을 읽는다. 범위를 벗어난 `page`를
 *  요청해도 몰이 마지막 유효 페이지로 그대로 clamp해서 돌려주는 경우(2026-08-09 seasonbag.co.kr
 *  스크린샷으로 직접 확인 — URL은 `page=21`인데 위젯은 여전히 "14"를 현재 페이지로 굵게 표시), 상품
 *  목록 내용(fingerprint)에 의존하는 판정보다 이게 훨씬 안정적이다 — clamp된 목록 내용은(광고/추천
 *  위젯 등 섞여) 매번 완전히 똑같지 않을 수 있어도, 위젯의 "지금 몇 페이지"는 항상 같은 값을 준다.
 *  실제 마크업 확인(seasonbag.co.kr, 카페24 기본 스킨): 현재 페이지도 `href 없는 요소가 아니라 여전히
 *  `<a href>`다 — 다만 클래스가 다르다(`<a class="other">11</a>` ... `<a class="this">14</a>`).
 *  href 유무로는 구분이 안 되므로, "페이지 번호 링크들 중 클래스가 다수와 다른 하나"를 찾는다(스킨마다
 *  클래스 이름은 다를 수 있지만 "현재 페이지만 클래스가 다르다"는 구조는 흔하다). 2개 이상이 다수와
 *  다르면(구조를 못 믿겠으면) null로 포기한다. */
async function readCurrentPageNumber(page: Page, nextPageSelector: string | undefined): Promise<number | null> {
  return page.evaluate(({ nextPageSelector }) => {
    const roots: Element[] = []
    if (nextPageSelector) {
      const near = document.querySelector(nextPageSelector)?.closest('div, ul, nav, p')
      if (near) roots.push(near)
    }
    if (!roots.length) roots.push(...Array.from(document.querySelectorAll('[class*="paging" i], [class*="pagination" i]')))
    for (const el of roots) {
      const entries = Array.from(el.querySelectorAll('a[href]'))
        .map(a => ({ n: Number((a.textContent || '').trim()), cls: a.className }))
        .filter(e => Number.isInteger(e.n) && e.n > 0 && e.n < 100_000)
      if (entries.length < 2) continue
      const counts = new Map<string, number>()
      for (const e of entries) counts.set(e.cls, (counts.get(e.cls) || 0) + 1)
      const [commonCls] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]
      const odd = entries.filter(e => e.cls !== commonCls)
      if (odd.length === 1) return odd[0].n
    }
    return null
  }, { nextPageSelector }).catch(() => null)
}

/** 미리보기 전용 — 카테고리(또는 단일 시작 URL) 하나의 상품 "개수"만 빠르게 구한다. 이름/썸네일/링크는
 *  전혀 모으지 않는다.
 *  1) 1페이지 상품 수 × 페이지네이션에서 읽은 총 페이지 수로 계산하고, 마지막 페이지를 한 번 더 열어
 *     그 페이지의 실제 개수로 보정한다(사용자가 요청한 "페이지당 노출 개수 × 총 페이지수 - 마지막
 *     페이지에서 빠진 개수" 계산과 동일).
 *  2) 그것도 안 되면(페이지네이션 구조를 못 읽음) 페이지가 빈 화면이 나올 때까지 실제로 개수만 세며
 *     넘어간다(이름/썸네일 없이 개수만이라 그래도 가볍다) — 정확한 개수 보장은 이 경로에서도 유지된다.
 *  (이전엔 "총 128개" 같은 페이지 문구를 먼저 읽어 지름길로 썼는데, 그 문구를 document.body 전체에서
 *  찾다 보니 상품 목록과 무관한 다른 위치의 숫자(사이트 전체 상품수 배지 등)를 잘못 집어 여러 카테고리가
 *  전부 같은 엉뚱한 개수로 나오는 문제가 실제로 발견되어 제거했다 — 이제 항상 실제 상품 링크 개수를
 *  세는 구조적인 방식만 쓴다.) */
/** page.goto 직후 곧바로 page.evaluate를 하면, 그 사이 몰 페이지의 지연 리다이렉트(로그인 후 자동이동 등
 *  클라이언트 스크립트가 건 setTimeout 이동)가 실행 중이던 실행 컨텍스트를 없애 "Execution context was
 *  destroyed" 오류로 죽는 경우가 실사용 중 확인됐다(submitLoginForm에서 먼저 발견된 것과 같은 문제, 위
 *  568행 참고) — 짧게 networkidle까지 한 번 더 기다려 그 지연 리다이렉트가 끝날 시간을 준다. */
async function settleAfterNav(page: Page) {
  // ponytail: 5초로 뒀더니 광고/채팅위젯/분석 스크립트가 계속 떠 있어 networkidle에 끝내 도달하지
  // 못하는 몰에서는 페이지 방문마다 5초를 통째로 날렸다(실사용 확인: 카테고리 개수 집계가 페이지를
  // 수십 번 방문하는 지수+이분 탐색과 겹쳐 이게 전체 지연의 대부분을 차지했다). 지연 리다이렉트를
  // 피하는 데는 훨씬 짧은 유예로도 충분해, 최악의 경우에도 페이지당 낭비가 크지 않게 줄였다.
  await page.waitForLoadState('networkidle', { timeout: 500 }).catch(() => {})
}

/** 위젯이 "보이는 페이지 묶음"만 노출해 maxPage를 과소평가했을 때, 진짜 마지막 페이지를 한 페이지씩
 *  순차로 찾지 않고 지수 확장(1,2,4,8...페이지씩 건너뛰며 빈 페이지가 나올 때까지) + 그 사이를 이분
 *  탐색해서 찾는다 — 카테고리가 수백 페이지짜리면 순차 탐색은 실사용 중 카테고리 1개에 수 분씩 걸리는
 *  게 확인됐다(로그(n)번만 페이지를 열면 되므로 대형 카테고리에서도 빠르다).
 *  bound 페이지까지도 빈 페이지를 못 찾으면 null(호출부가 안전한 순차 탐색으로 폴백).
 *  탐색 중 로그인 화면으로 튕기면(needsLogin) 그 즉시 지금까지 확인한 값으로 멈춘다 — 로그인 화면은
 *  count===0이 아니라서 이 탐색이 끝을 못 찾고 bound까지 헤매다 최후 순차 폴백까지 소진하는 원인이었다.
 *  knownNonEmptyFingerprint: 범위를 벗어난 page를 요청해도 빈 화면이 아니라 마지막 유효 페이지 내용을
 *  그대로 다시 돌려주는 몰이 있다(2026-08-09 seasonbag.co.kr 재현 — page=32를 요청해도 실제로는 14페이지
 *  내용이 반복됨). count>0이라고 "더 있다"고 오판하면 진짜 끝을 못 찾고 페이지 번호만 계속 올리며 헤맨다
 *  — probe의 내용이 지금까지 확인한 마지막(lo) 페이지 내용과 완전히 같으면(fingerprint 일치) 새 내용이
 *  아니라 반복이라는 뜻이므로, count===0과 똑같이 "여기가 끝"으로 처리한다.
 *  다만 lo와의 단순 비교만으론 부족하다: 지수 확장은 한 번에 여러 페이지를 건너뛰므로(1,2,4,8...), 건너뛴
 *  자리가 하필 그 "반복 지점"이면 (진짜 내용은 페이지마다 다르므로) 저 멀리 있는 lo와는 우연히 달라 보여
 *  "새 내용"으로 오판할 수 있다(직접 재현: lo=8에서 probe=16으로 건너뛰었는데 16이 이미 14페이지 내용의
 *  반복이지만, 8페이지 내용과는 여전히 달라 새 페이지로 오인됨 → 결과가 실제(14)보다 큰 값(16)으로 확정).
 *  그래서 "새 내용처럼 보이는" probe는 바로 다음 페이지(probe+1)까지 한 번 더 확인해, 그것도 같은 내용이면
 *  (반복이 안정적으로 계속됨) probe 자체를 새 lo로 승격하지 않고 그 자리를 벽으로 확정한다.
 *  이 fingerprint 비교도 완벽하진 않다: clamp된 응답에 광고/추천 위젯 등이 섞여 매번 완전히 똑같지
 *  않으면(직접 재현: 실사용 세션에서 URL이 21까지 계속 올라가는데도 페이지네이션 위젯은 계속 "14"를
 *  현재 페이지로 보여줌 — 상품 목록 내용은 매번 조금씩 달라 fingerprint 비교로는 못 잡음) 이 비교만으론
 *  안 걸린다. 그래서 `readCurrentPageNumber()`(위젯이 스스로 보고하는 "지금 몇 페이지")를 우선 신호로
 *  쓴다 — 요청한 페이지 번호(probe/mid)와 위젯이 말하는 현재 페이지가 다르면, 상품 내용이 어떻든 그
 *  즉시 clamp로 확정한다(위젯 구조를 못 읽는 스킨이면 null이 나와 기존 fingerprint 검증으로 자동
 *  폴백된다). */
async function findRealLastPage(
  workerPage: Page, firstPageUrl: string, bound: number,
  knownNonEmptyPage: number, knownNonEmptyCount: number, knownNonEmptyFingerprint: string,
  userSel: string | null, platformSel: string | null, detailPatternSrc: string | undefined, baseUrl: string,
  nextPageSelector: string | undefined, stop: () => boolean,
): Promise<{ page: number; count: number; needsLogin?: boolean } | null> {
  let lo = knownNonEmptyPage
  let loCount = knownNonEmptyCount
  let loFingerprint = knownNonEmptyFingerprint
  let hi: number | null = null
  let step = 1
  while (hi === null) {
    if (stop()) return { page: lo, count: loCount }
    const probe = lo + step
    if (probe > bound) return null
    await workerPage.goto(withPageParam(firstPageUrl, probe), { waitUntil: 'domcontentloaded', timeout: 15_000 }).catch(() => {})
    await settleAfterNav(workerPage)
    const { count, isLoginPage, fingerprint } = await countProductsOnPage(workerPage, userSel, platformSel, detailPatternSrc, baseUrl)
    if (isLoginPage) return { page: lo, count: loCount, needsLogin: true }
    const currentPage = count > 0 ? await readCurrentPageNumber(workerPage, nextPageSelector) : null
    const clamped = currentPage !== null && currentPage !== probe
    if (count === 0 || clamped || fingerprint === loFingerprint) { hi = probe; continue }
    if (stop()) return { page: lo, count: loCount }
    await workerPage.goto(withPageParam(firstPageUrl, probe + 1), { waitUntil: 'domcontentloaded', timeout: 15_000 }).catch(() => {})
    await settleAfterNav(workerPage)
    const next = await countProductsOnPage(workerPage, userSel, platformSel, detailPatternSrc, baseUrl)
    if (next.isLoginPage) return { page: lo, count: loCount, needsLogin: true }
    if (next.count > 0 && next.fingerprint === fingerprint) { hi = probe; continue }
    lo = probe; loCount = count; loFingerprint = fingerprint; step *= 2
  }
  while (hi - lo > 1) {
    if (stop()) return { page: lo, count: loCount }
    const mid = Math.floor((lo + hi) / 2)
    await workerPage.goto(withPageParam(firstPageUrl, mid), { waitUntil: 'domcontentloaded', timeout: 15_000 }).catch(() => {})
    await settleAfterNav(workerPage)
    const { count, isLoginPage, fingerprint } = await countProductsOnPage(workerPage, userSel, platformSel, detailPatternSrc, baseUrl)
    if (isLoginPage) return { page: lo, count: loCount, needsLogin: true }
    const currentPage = count > 0 ? await readCurrentPageNumber(workerPage, nextPageSelector) : null
    const clamped = currentPage !== null && currentPage !== mid
    if (count === 0 || clamped || fingerprint === loFingerprint) hi = mid
    else { lo = mid; loCount = count; loFingerprint = fingerprint }
  }
  return { page: lo, count: loCount }
}

async function countCategoryProductsOnce(
  workerPage: Page, categoryUrl: string,
  userSel: string | null, platformSel: string | null, detailPatternSrc: string | undefined,
  nextPageSelector: string | undefined, baseUrl: string, stop: () => boolean,
): Promise<CategoryCount> {
  // 개수만 세려고 <a> 태그만 보면 되니 'load'(이미지·광고·채팅위젯까지 다 받을 때까지 대기)가 아니라
  // 'domcontentloaded'로 충분하다 — 상품 이미지가 많은 목록 페이지에서 이 차이가 페이지 방문 하나당
  // 꽤 크다(지수+이분 탐색이 페이지를 수십 번 열 수 있어 누적되면 전체 속도에 영향이 크다).
  const firstPageUrl = resetToFirstPage(categoryUrl)
  await workerPage.goto(firstPageUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {})
  await settleAfterNav(workerPage)
  const { category } = await detectCategoryLabel(workerPage)
  const label = category || categoryUrl

  const { count: perPage, isLoginPage: perPageIsLogin, fingerprint: perPageFingerprint } = await countProductsOnPage(workerPage, userSel, platformSel, detailPatternSrc, baseUrl)
  // 1페이지 자체가 로그인 화면이면(이 새 탭이 이 몰의 세션 검증에 걸려 튕겨나간 경우) 뒤 어떤 값도
  // 못 믿는다 — 개수를 0으로 잘못 확정하는 대신 needsLogin만 알리고 즉시 끝낸다(호출부가 "로그인이
  // 끊겼을 수 있다"는 배너를 보여줄 근거가 된다).
  if (perPageIsLogin) return { url: categoryUrl, label, count: 0, needsLogin: true }
  if (perPage === 0 || stop()) return { url: categoryUrl, label, count: perPage }

  const maxPage = await readMaxPageNumber(workerPage, nextPageSelector)
  // maxPage가 정말로(위젯을 읽어서) 1 이하로 확인된 경우만 곧바로 믿는다 — 위젯을 아예 못 찾은 경우
  // (maxPage===null)는 "1페이지짜리 카테고리"인지 "위젯 클래스명이 특이해서 못 읽은 대형 카테고리"인지
  // 구분이 안 되므로, 곧장 믿지 않고 아래 maxPage!==null 블록을 건너뛰어 이 함수 뒤쪽의 지수+이분 탐색
  // (원래 "maxPage를 읽었지만 못 믿는 경우"를 위해 있던 것)을 그대로 재사용한다 — 예전엔 여기서 perPage를
  // 그대로 총합으로 확정해버려, 위젯이 안 잡히는 스킨에서 실제보다 적게 세는 문제가 있었다.
  if (maxPage !== null && maxPage <= 1) {
    console.log(`[previewCatalog] "${label}" perPage=${perPage} maxPage=${maxPage} → count=${perPage} url=${firstPageUrl}`)
    return { url: categoryUrl, label, count: perPage }
  }

  if (maxPage !== null) {
    await workerPage.goto(withPageParam(firstPageUrl, maxPage), { waitUntil: 'domcontentloaded', timeout: 15_000 }).catch(() => {})
    await settleAfterNav(workerPage)
    const { count: lastPageCount, isLoginPage: lastPageIsLogin, fingerprint: lastPageFingerprint } = await countProductsOnPage(workerPage, userSel, platformSel, detailPatternSrc, baseUrl)
    // 여기서부터는 최소한 1페이지(perPage)는 로그인 상태에서 확인한 값이므로, 그걸 최선의 추정치로 두고
    // needsLogin만 같이 알린다 — 0으로 깎아내리지 않는다.
    if (lastPageIsLogin) return { url: categoryUrl, label, count: perPage, needsLogin: true }
    // maxPage가 "실제 마지막 페이지"가 아니라 페이지네이션 위젯이 한 번에 보여주는 번호 묶음의 끝일 수 있다
    // (예: 카페24 기본 스킨은 1~5만 링크로 노출하고 다음 묶음은 화살표로만 이동 — 실사용 확인: 여러 카테고리가
    // 전부 같은 maxPage=5·lastPageCount=48(꽉 참)로 읽혀 진짜 총 개수보다 훨씬 적은 값에서 멈춘 사례 발견).
    // 그래서 "마지막"이라고 읽은 페이지 바로 다음 페이지도 비어있는지 한 번 더 확인해야 안심할 수 있다.
    if (lastPageCount > 0 && !stop()) {
      await workerPage.goto(withPageParam(firstPageUrl, maxPage + 1), { waitUntil: 'domcontentloaded', timeout: 15_000 }).catch(() => {})
      await settleAfterNav(workerPage)
      const { count: afterLastCount, isLoginPage: afterLastIsLogin, fingerprint: afterLastFingerprint } = await countProductsOnPage(workerPage, userSel, platformSel, detailPatternSrc, baseUrl)
      if (afterLastIsLogin) return { url: categoryUrl, label, count: perPage * (maxPage - 1) + lastPageCount, needsLogin: true }
      // count>0이어도 위젯이 스스로 "지금 페이지"를 maxPage로 보고하면(요청은 maxPage+1인데) 범위를
      // 벗어난 page 요청을 몰이 마지막 유효 페이지로 그대로 되돌려준 것이다(2026-08-09 seasonbag.co.kr
      // 실사용 재현 — 상품 목록 내용은 매번 조금씩 달라 fingerprint만으론 못 잡았지만, 위젯은 항상 같은
      // "지금 14페이지"를 보고했다). 위젯을 못 읽는 스킨이면(currentPage===null) fingerprint 일치
      // 여부로 대신 판단한다(기존 방식). 어느 쪽이든 진짜 빈 페이지와 똑같이 취급해 여기서 확정한다 —
      // 안 그러면 아래 findRealLastPage가 "새 페이지"로 착각한 채 끝을 못 찾고 페이지 번호만 계속
      // 올리며 헤맨다.
      const afterLastCurrentPage = afterLastCount > 0 ? await readCurrentPageNumber(workerPage, nextPageSelector) : null
      const afterLastClamped = afterLastCurrentPage !== null && afterLastCurrentPage !== maxPage + 1
      if (afterLastCount === 0 || afterLastClamped || afterLastFingerprint === lastPageFingerprint) {
        const count = perPage * (maxPage - 1) + lastPageCount
        console.log(`[previewCatalog] "${label}" perPage=${perPage} maxPage=${maxPage} lastPageCount=${lastPageCount} → count=${count} url=${firstPageUrl} lastPageUrl=${withPageParam(firstPageUrl, maxPage)}`)
        return { url: categoryUrl, label, count }
      }
      console.log(`[previewCatalog] "${label}" maxPage=${maxPage}이 위젯 페이지 묶음의 끝일 뿐(page ${maxPage + 1}에도 ${afterLastCount}개 더 있음) → 실제 마지막 페이지 빠르게 탐색`)
      const found = await findRealLastPage(
        workerPage, firstPageUrl, AUTO_PAGINATION_CAP * 100, maxPage + 1, afterLastCount, afterLastFingerprint,
        userSel, platformSel, detailPatternSrc, baseUrl, nextPageSelector, stop,
      )
      if (found) {
        const count = perPage * (found.page - 1) + found.count
        if (found.needsLogin) return { url: categoryUrl, label, count, needsLogin: true }
        console.log(`[previewCatalog] "${label}" perPage=${perPage} 실제 마지막 페이지=${found.page} lastPageCount=${found.count} → count=${count}`)
        return { url: categoryUrl, label, count }
      }
      console.log(`[previewCatalog] "${label}" 실제 마지막 페이지를 못 찾음(${AUTO_PAGINATION_CAP * 100}페이지 이내) → 안전한 순차 탐색으로 폴백`)
    }
  } else {
    console.log(`[previewCatalog] "${label}" perPage=${perPage} maxPage=null(페이지네이션 위젯 못 찾음) → 지수+이분 탐색으로 실제 마지막 페이지 확인`)
  }

  if (stop()) return { url: categoryUrl, label, count: maxPage ? perPage * maxPage : perPage }

  // 여기 도달하는 두 경우 다 maxPage를 못 믿는다: 위젯을 읽었지만 그 페이지가 실제로는 비어있었던 경우,
  // 또는 위젯 자체를 못 찾은 경우(maxPage===null). 어느 쪽이든 1페이지 개수(perPage)는 이미 확인했으니,
  // 거기서부터 지수+이분 탐색으로 실제 마지막 페이지를 빠르게 찾는다. 예전엔 여기서 1페이지씩 순서대로
  // 순회했는데, "maxPage 페이지 자체가 비어있게 읽힌" 카테고리가 실제로는 수백~수천 개짜리인 경우도
  // 있어(실사용 확인: 1020bag.com의 한 카테고리가 5622개) 순차 탐색이 카테고리 하나에 수십 분씩 걸렸다.
  const fallbackFound = await findRealLastPage(
    workerPage, firstPageUrl, AUTO_PAGINATION_CAP * 100, 1, perPage, perPageFingerprint,
    userSel, platformSel, detailPatternSrc, baseUrl, nextPageSelector, stop,
  )
  if (fallbackFound) {
    const count = perPage * (fallbackFound.page - 1) + fallbackFound.count
    if (fallbackFound.needsLogin) return { url: categoryUrl, label, count, needsLogin: true }
    console.log(`[previewCatalog] "${label}" perPage=${perPage} maxPage=${maxPage}(불신) → 실제 마지막 페이지=${fallbackFound.page} → count=${count} url=${firstPageUrl}`)
    return { url: categoryUrl, label, count }
  }

  // 그래도 못 찾으면(탐색 상한을 넘김) 최후 수단으로 안전하게 한 페이지씩 순회한다(정확한 개수
  // 보장이 최우선).
  await workerPage.goto(firstPageUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {})
  await settleAfterNav(workerPage)
  let total = 0
  let prevFingerprint: string | null = null
  for (let p = 0; p < AUTO_PAGINATION_CAP; p++) {
    if (stop()) break
    const { count, isLoginPage, fingerprint } = p === 0
      ? { count: perPage, isLoginPage: false, fingerprint: perPageFingerprint }
      : await countProductsOnPage(workerPage, userSel, platformSel, detailPatternSrc, baseUrl)
    if (isLoginPage) return { url: categoryUrl, label, count: total, needsLogin: true }
    // 여기도 위와 같은 이유로 fingerprint가 바로 앞 페이지와 같으면(범위 밖 page를 마지막 유효 페이지로
    // 그대로 되돌려주는 몰) 새 페이지로 착각해 더하지 않고 여기서 끝낸다.
    if (count === 0 || fingerprint === prevFingerprint) break
    prevFingerprint = fingerprint
    total += count
    await workerPage.goto(withPageParam(firstPageUrl, p + 2), { waitUntil: 'domcontentloaded', timeout: 15_000 }).catch(() => {})
    await settleAfterNav(workerPage)
  }
  console.log(`[previewCatalog] "${label}" perPage=${perPage} maxPage=${maxPage}(불신, 탐색도 실패) → 직접 순회 count=${total} url=${firstPageUrl}`)
  return { url: categoryUrl, label, count: total }
}

/** 위 settleAfterNav로 대부분 막히지만, 그래도 남는 드문 레이스는 카테고리 하나의 개수 계산 전체를
 *  실패시킨다 — 예전엔 그 실패(Execution context was destroyed 등)가 Promise.all을 타고 미리보기 전체를
 *  깨뜨려 사용자가 "확인 실패" 알림을 수동으로 닫고 처음부터 다시 눌러야 했다. 한 카테고리 실패가 나머지
 *  카테고리까지 막지 않도록, 이 카테고리만 한 번 더 조용히 재시도한다(사용자 개입 없이 자동 처리). */
async function countCategoryProducts(
  workerPage: Page, categoryUrl: string,
  userSel: string | null, platformSel: string | null, detailPatternSrc: string | undefined,
  nextPageSelector: string | undefined, baseUrl: string, stop: () => boolean,
): Promise<CategoryCount> {
  if (stop()) return { url: categoryUrl, label: categoryUrl, count: 0 }
  try {
    return await countCategoryProductsOnce(workerPage, categoryUrl, userSel, platformSel, detailPatternSrc, nextPageSelector, baseUrl, stop)
  } catch (err) {
    if (stop()) return { url: categoryUrl, label: categoryUrl, count: 0 }
    console.log(`[previewCatalog] "${categoryUrl}" 개수 계산 중 오류(재시도) — ${err instanceof Error ? err.message : err}`)
    try {
      return await countCategoryProductsOnce(workerPage, categoryUrl, userSel, platformSel, detailPatternSrc, nextPageSelector, baseUrl, stop)
    } catch (err2) {
      console.log(`[previewCatalog] "${categoryUrl}" 개수 계산 재시도도 실패 — ${err2 instanceof Error ? err2.message : err2}`)
      return { url: categoryUrl, label: categoryUrl, count: 0 }
    }
  }
}

/**
 * 카탈로그(목록) 모드 전용 — 카테고리별 상품 개수를 빠르게 확인하고, 상품 1건만 실제로 열어 컬럼별
 * 데이터를 상세 확인한다. 나머지 상품은 어차피 "스크래핑 시작"이 다시 전체를 훑으므로, 미리보기 시점엔
 * 이름/썸네일/링크를 모을 필요가 없다는 사용자 판단에 따라 개수만 구한다(사용자 확인·설계 완료).
 * ponytail: 미리보기 전용이라 재시도/AI폴백 없이 1회만 시도한다 — 실패하면 버튼을 다시 누르면 됨.
 */
export async function previewCatalog(opts: ScrapeOptions): Promise<CatalogPreviewResult> {
  // 미리보기는 DB 세션이 없는 단발 요청이라 실제 스크랩의 sessionId+isStopRequested를 못 쓴다 — 대신
  // 클라이언트가 fetch를 abort하면 그 요청의 AbortSignal이 여기로 그대로 전달돼(app/api/scrape/
  // preview-catalog/route.ts) 아래 루프들이 다음 네트워크 왕복 전에 스스로 멈춘다. 같은 몰에 대해
  // 새 미리보기 요청이 들어오면(중지 없이 다시 누름, 새로고침 등) beginPreviewRun이 이전 실행을
  // superseded 처리해 같은 이유로 스스로 멈추게 한다 — 안 그러면 여러 실행이 겹쳐 돌며 서로 CPU를
  // 나눠 먹어 실사용 중 확인된 "끝없이 느려짐" 문제로 이어졌다.
  const runEntry = beginPreviewRun(opts.siteId)
  const stop = () => !!opts.stopSignal?.aborted || !!runEntry?.superseded
  const supersededResult = (): CatalogPreviewResult =>
    ({ total: 0, platform: 'unknown', preview: null, items: [], categoryCounts: [], needsLogin: false, superseded: true })
  // 정상적으로(중지/밀려남 없이) 끝까지 완료된 결과만 endPreviewRun에 넘겨 잠시 캐시해둔다 — 화면이
  // 강제 새로고침돼도 다시 뜬 뒤 이 결과를 그대로 가져갈 수 있게 하기 위함(아래 finally 참고).
  let finalResult: CatalogPreviewResult | null = null
  try {
    const result = await withContext(opts, async (page, context) => {
      const listingUrls = (opts.categoryUrls?.length ? opts.categoryUrls : (opts.url ? [opts.url] : [page.url()])).map(resetToFirstPage)
      if (runEntry) runEntry.total = listingUrls.length
      if (stop()) return supersededResult()

      // 부트스트랩(상세 미리보기용 상품 1건 확보)과 맨 아래 최종 상품 상세 추출은 항상 새 탭에서
      // 한다 — 로그인 창이 열려있는 siteId는 withContext가 그 창의 공유 탭(page)을 그대로 재사용해
      // 넘겨주는데, 같은 몰에 대해 미리보기 요청이 두 개 겹치면(바로 위 superseded 처리가 노리는 그
      // 상황) 둘 다 이 공유 탭에서 goto를 걸어 한쪽 요청이 다른 쪽이 막 이동한 페이지를 읽어버리는
      // 사고로 이어질 수 있다(리뷰로 확인된 문제 — superseded 체크만으론 못 막는다, 이 부트스트랩
      // 자체엔 체크 지점이 없어서). 카테고리 개수 집계 워커가 이미 항상 context.newPage()로 새 탭을
      // 쓰는 것과 같은 이유·같은 해법이라, 여기도 그 패턴을 그대로 따른다.
      const scratchPage = await context.newPage()
      try {
        // 상세 미리보기용 상품 1건 + 이 몰의 플랫폼(셀렉터 판단용)을 먼저 확보한다. 아래 개수 집계가
        // 카테고리 0의 1페이지를 다시 열게 되어 약간 중복되지만, 코드를 단순하게 유지하는 쪽을
        // 택했다(카테고리가 많아도 중복은 1페이지 분량 뿐이라 전체 시간에 미치는 영향은 미미하다).
        const bootstrap = await collectProductUrls(scratchPage, { ...opts, url: listingUrls[0], categoryUrls: undefined, maxPages: 1 })
        const platform = bootstrap.platform
        let firstUrl = bootstrap.urls[0]
        let categoryByUrl = bootstrap.categoryByUrl
        let needsLogin = bootstrap.needsLogin
        if (stop()) return supersededResult()

        const profile = PLATFORM_PROFILES[platform]
        const userSel = opts.productLinkSelector || null
        const platformSel = profile.productLinkSelector
        const detailPatternSrc = profile.detailUrlPattern?.source
        const nextPageSelector = opts.nextPageSelector || profile.nextPageSelector || undefined
        const baseUrl = new URL(listingUrls[0]).origin

        // 카테고리별 개수만 여러 탭으로 동시에 집계한다. 로그인 창을 재사용하는 siteId라도 그 공유 탭은
        // 절대 쓰지 않고 항상 새 탭만 연다(discoverCategoryLinks에서 같은 이유로 겪은 "다른 네비게이션에
        // 의해 중단됨" 충돌 방지).
        const COUNT_CONCURRENCY = resolveConcurrency(opts, 4)
        const categoryCounts = new Array<CategoryCount | undefined>(listingUrls.length)
        let cursor = 0
        async function worker() {
          const workerPage = await context.newPage()
          try {
            while (true) {
              if (stop()) return
              const i = cursor++
              if (i >= listingUrls.length) return
              categoryCounts[i] = await countCategoryProducts(
                workerPage, listingUrls[i], userSel, platformSel, detailPatternSrc, nextPageSelector, baseUrl, stop,
              )
              if (runEntry) runEntry.done++
            }
          } finally {
            await workerPage.close().catch(() => {})
          }
        }
        const workerCount = Math.min(COUNT_CONCURRENCY, listingUrls.length)
        if (!stop()) await Promise.all(Array.from({ length: workerCount }, () => worker()))

        // 중지되면 아직 처리 못 한 카테고리는 빈 칸으로 남는다 — 어차피 클라이언트가 이 응답을 안 받을
        // 상황이라 정확도보다 여기서 안전하게(undefined.count로 죽지 않게) 걸러내는 것만 중요하다.
        const doneCounts = categoryCounts.filter((c): c is CategoryCount => !!c)
        const total = doneCounts.reduce((sum, c) => sum + c.count, 0)
        // 카테고리 개수 집계 중 로그인 화면으로 튕긴 카테고리가 하나라도 있으면 그 결과(count)는
        // 불완전할 수 있다는 뜻이라, 최상위 needsLogin에 반영해 화면이 "로그인을 다시 확인해주세요"를
        // 보여줄 수 있게 한다.
        needsLogin = needsLogin || doneCounts.some(c => c.needsLogin)
        if (stop()) return { ...supersededResult(), total, categoryCounts: doneCounts }

        // 부트스트랩으로 고른 카테고리(0번)가 하필 비어있으면, 실제로 상품이 있는 다른 카테고리에서 1건을 구한다.
        if (!firstUrl) {
          const nonEmpty = doneCounts.find(c => c.count > 0)
          if (nonEmpty) {
            const retry = await collectProductUrls(scratchPage, { ...opts, url: nonEmpty.url, categoryUrls: undefined, maxPages: 1 })
            firstUrl = retry.urls[0]
            categoryByUrl = retry.categoryByUrl
            needsLogin = needsLogin || retry.needsLogin
          }
        }

        if (stop()) return { ...supersededResult(), total, platform, categoryCounts: doneCounts, needsLogin }
        if (!firstUrl) return { total, platform, preview: null, items: [], categoryCounts: doneCounts, needsLogin }

        await scratchPage.goto(firstUrl, { waitUntil: 'load', timeout: 30_000 })
        const productNeedsLogin = await loginIfNeeded(scratchPage, { url: firstUrl, ...opts })
        needsLogin = needsLogin || productNeedsLogin
        if (opts.loginId && scratchPage.url() !== firstUrl) {
          await scratchPage.goto(firstUrl, { waitUntil: 'load', timeout: 30_000 }).catch(() => {})
        }
        await waitForExtractableContent(scratchPage)
        const product = await extractProductRuleBased(scratchPage, firstUrl, selectorOverrides(opts), opts.extractionRules)
        const domOptions = await extractOptionsFromDom(scratchPage)
        if (domOptions.options.length) product.options = domOptions.options
        if (domOptions.combinations.length) product.option_combinations = domOptions.combinations
        await applyStockByOption(scratchPage, product)
        applyCategoryOverride(product, categoryByUrl.get(firstUrl), opts.extractionRules)

        // AI모드는 외부 API 호출 + DB에 extraction_rules를 저장하는 비용 있는 단계라, 이미 밀려난
        // 실행이면 굳이 돌리지 않는다(리뷰에서 지적된 가장 비싼 낭비 지점).
        if (opts.aiMode && opts.siteId && !stop()) {
          const ai = await applyAiModeRules(scratchPage, opts.siteId, firstUrl, opts, domOptions)
          if (ai) {
            applyCategoryOverride(ai.product, categoryByUrl.get(firstUrl), ai.rules)
            return { total, platform, preview: { sourceUrl: firstUrl, product: ai.product }, items: [], categoryCounts: doneCounts, needsLogin }
          }
        }
        return { total, platform, preview: { sourceUrl: firstUrl, product }, items: [], categoryCounts: doneCounts, needsLogin }
      } finally {
        await scratchPage.close().catch(() => {})
      }
    }, '스크랩 미리보기')
    if (!result.superseded) finalResult = result
    return result
  } finally {
    endPreviewRun(opts.siteId, runEntry, finalResult)
  }
}

export interface CatalogItemEvent {
  done: number
  total: number
  url: string
  result: ScrapeResult | null
  error?: string
}

export interface ConcurrencyLogEntry {
  at: string
  level: number
  reason: 'ramp_up' | 'block_detected'
}

export interface CatalogScrapeSummary {
  total: number
  saved: number
  stopped: boolean
  concurrencyLog: ConcurrencyLogEntry[]
}

/** 목록 페이지(들)에서 제품 URL 수집 후 각각 스크랩. 카테고리 여러 개 + 페이지네이션 + 중지 + 이미 스크랩한 상품 제외 + 동시 처리 지원 */
export async function scrapeCatalogPage(
  opts: ScrapeOptions,
  onItem: (event: CatalogItemEvent) => Promise<void> | void,
): Promise<CatalogScrapeSummary> {
  return withContext(opts, async (page, context) => {
    const { urls: productUrls, categoryByUrl, needsLogin: listingNeedsLogin } = await collectProductUrls(page, opts, context)

    // 예약된 자동 재스크랩처럼 아무도 화면을 안 보고 있는 상황에서 로그인이 끊긴 채로 스크랩되면, 그
    // 사실을 사용자가 나중에라도 알 수 있어야 한다 — 사이트 메모에 한 번만 남긴다(상품마다 남기면 도배됨).
    let loginIssueNoted = false
    async function noteLoginIssueOnce() {
      if (loginIssueNoted || !opts.siteId) return
      loginIssueNoted = true
      await pool.query(
        `INSERT INTO site_memos (site_id, content) VALUES ($1, $2)`,
        [opts.siteId, '⚠ 로그인 세션이 끊긴 상태로 스크랩된 것으로 보입니다 — 다시 로그인해주세요.'],
      ).catch(() => {})
    }
    if (listingNeedsLogin) await noteLoginIssueOnce()

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
        return { total: 0, saved: 0, stopped: false, concurrencyLog: [] }
      }
      const result: ScrapeResult = { sourceUrl: singleUrl, product }
      await onItem({ done: 1, total: 1, url: singleUrl, result })
      return { total: 1, saved: 1, stopped: false, concurrencyLog: [] }
    }

    let saved = 0
    let done = 0
    let stopped = false
    let lastError: unknown = null
    let cursor = 0

    // 적응형 동시성(AIMD, TCP 혼잡제어와 같은 원리) — 몰마다 안전한 동시 요청 수가 달라 사용자가 직접
    // 숫자를 고르게 하던 것을 대체한다. 1(가장 안전)부터 시작해 연속 성공이 쌓이면 서서히 올리고, 차단으로
    // 추정되는 응답(아래 scrapeOne의 "차단 또는 일시 오류로 추정" 판정)이 나오면 즉시 1로 낮추고 잠시 쉰다.
    // ponytail: RAMP_UP_STREAK/MAX_CONCURRENCY/쿨다운 값은 임의로 정한 안전 마진 — 실제로 몰별 반응을 보며 조정.
    // concurrencyMode==='manual'이면 그 값으로 상한을 고정하고 시작값도 거기서 바로 시작한다(activeLimit이
    // 이미 MAX_CONCURRENCY와 같아 위 "연속 성공 시 상향" 조건이 못 만족돼 그대로 고정된 채 유지된다) —
    // 차단 감지 시 1로 낮췄다가 회복하는 안전장치는 auto/manual 구분 없이 그대로 적용되고, manual이면
    // 8이 아니라 이 고정값까지만 다시 올라온다.
    const manualLimit = opts.concurrencyMode === 'manual' ? Math.max(1, Math.min(opts.concurrency || 1, 8)) : null
    const MAX_CONCURRENCY = manualLimit ?? 8
    const RAMP_UP_STREAK = 5
    let activeLimit = manualLimit ?? 1
    let okStreak = 0
    const concurrencyLog: ConcurrencyLogEntry[] = []

    async function scrapeOne(workerPage: Page, pUrl: string): Promise<{ result: ScrapeResult | null; blocked: boolean }> {
      let lastProduct: ExtractedProduct | null = null
      let blocked = false
      for (let attempt = 0; attempt <= RETRY_COUNT; attempt++) {
        try {
          await workerPage.goto(pUrl, { waitUntil: 'load', timeout: 30_000 })
          // 장시간 카탈로그 스크랩 중 세션이 만료되면 로그인 페이지로 리다이렉트되는 몰이 있다 — 매 상품마다
          // 재로그인을 시도해 세션을 회복하고(이미 로그인돼 있으면 아이디 필드가 없어 즉시 지나간다), 원래 상품 페이지로 되돌아간다.
          if (await loginIfNeeded(workerPage, { url: pUrl, ...opts })) await noteLoginIssueOnce()
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
            blocked = true
            throw new Error('가격/이미지를 모두 찾지 못함 (차단 또는 일시 오류로 추정)')
          }
          applyCategoryOverride(product, categoryByUrl.get(pUrl), opts.extractionRules)
          return { result: { sourceUrl: pUrl, product }, blocked: false }
        } catch (err) {
          lastError = err
          if (attempt < RETRY_COUNT) await sleep(2_000 * (attempt + 1) + Math.random() * 2_000)
        }
      }
      if (lastProduct) {
        const aiProduct = await tryAiFallback(workerPage, lastProduct)
        if (aiProduct) {
          applyCategoryOverride(aiProduct, categoryByUrl.get(pUrl), opts.extractionRules)
          return { result: { sourceUrl: pUrl, product: aiProduct }, blocked }
        }
      }
      return { result: null, blocked }
    }

    async function worker(workerIndex: number, workerPage: Page) {
      while (true) {
        if (isStopRequested(opts.sessionId)) { stopped = true; return }
        // 이 워커의 순번이 현재 활성 한도보다 높으면(아직 한도가 안 올라왔거나 방금 차단으로 낮아졌으면)
        // 새 탭을 열어둔 채로 대기만 한다 — 한도가 올라오면 자동으로 다시 작업을 받는다.
        while (workerIndex >= activeLimit) {
          if (isStopRequested(opts.sessionId)) { stopped = true; return }
          if (cursor >= productUrls.length) return
          await sleep(500)
        }
        const i = cursor++
        if (i >= productUrls.length) return
        if (i > 0) await throttle(opts.delayMs)

        const pUrl = productUrls[i]
        const { result, blocked } = await scrapeOne(workerPage, pUrl)
        if (blocked) {
          okStreak = 0
          if (activeLimit > 1) {
            activeLimit = 1
            concurrencyLog.push({ at: new Date().toISOString(), level: 1, reason: 'block_detected' })
            await sleep(5_000) // 차단 감지 시 바로 다음 상품으로 넘어가지 않고 잠시 쉬어 몰의 rate-limit이 풀릴 시간을 준다
          }
        } else if (result) {
          okStreak++
          if (okStreak >= RAMP_UP_STREAK && activeLimit < MAX_CONCURRENCY) {
            activeLimit++
            okStreak = 0
            concurrencyLog.push({ at: new Date().toISOString(), level: activeLimit, reason: 'ramp_up' })
          }
        }
        if (result) saved++
        done++
        await onItem({
          done, total: productUrls.length, url: pUrl, result,
          error: result ? undefined : (lastError instanceof Error ? lastError.message : String(lastError)),
        })
      }
    }

    const workerCount = Math.min(MAX_CONCURRENCY, productUrls.length || 1)
    const workerPages = await Promise.all(
      Array.from({ length: workerCount }, (_, idx) => (idx === 0 ? page : context.newPage())),
    )
    await Promise.all(workerPages.map((p, idx) => worker(idx, p)))
    await Promise.all(workerPages.slice(1).map(p => p.close().catch(() => {})))

    if (opts.sessionId !== undefined) stopRequests.delete(opts.sessionId)

    if (!stopped && saved === 0 && productUrls.length > 0) {
      const reason = lastError instanceof Error ? lastError.message : String(lastError)
      throw new Error(`상품 링크 ${productUrls.length}개를 찾았지만 모두 추출에 실패했습니다: ${reason}`)
    }

    return { total: productUrls.length, saved, stopped, concurrencyLog }
  }, '스크래핑 시작')
}

export interface RecheckTarget {
  id: number
  sourceUrl: string
  mallProductCode: string
}

export interface RecheckResult {
  mallProductId: number
  mallProductCode: string
  /** null이면 확인 실패 — error 참고. 몰 페이지가 가격/이미지 둘 다 없으면 품목삭제(또는 차단)로 추정한다. */
  product: ExtractedProduct | null
  error?: string
}

/**
 * "마이그레이션3_연속관리"의 컬럼별 재수집(현재 상태 체킹) 전용 — 이미 확정된 상품을 대상으로 몰에 다시
 * 방문해 현재 값을 가볍게 확인한다(이미지 파일 다운로드는 하지 않는다 — 호출부가 필요한 컬럼만 비교/반영).
 * scrapeCatalogPage와 같은 방식으로 컨텍스트를 한 번만 열어 여러 탭으로 동시에 처리한다 — 직접로그인
 * 필수 몰은 withContext를 상품마다 새로 부르면 프로필 디렉터리 잠금 충돌이 나므로, 반드시 컨텍스트를
 * 재사용해야 한다(scrapeSingleProduct를 여기서 그대로 여러 번 호출하지 않는 이유).
 */
export async function recheckMallProducts(opts: ScrapeOptions, targets: RecheckTarget[]): Promise<RecheckResult[]> {
  return withContext(opts, async (page, context) => {
    const results: RecheckResult[] = []
    let cursor = 0
    const concurrency = Math.max(1, Math.min(opts.concurrency || 4, 8))

    async function recheckOne(workerPage: Page, target: RecheckTarget): Promise<RecheckResult> {
      for (let attempt = 0; attempt <= RETRY_COUNT; attempt++) {
        try {
          await workerPage.goto(target.sourceUrl, { waitUntil: 'load', timeout: 30_000 })
          await loginIfNeeded(workerPage, { url: target.sourceUrl, ...opts })
          if (opts.loginId && workerPage.url() !== target.sourceUrl) {
            await workerPage.goto(target.sourceUrl, { waitUntil: 'load', timeout: 30_000 }).catch(() => {})
          }
          await waitForExtractableContent(workerPage)
          const product = await extractProductRuleBased(workerPage, target.sourceUrl, undefined, opts.extractionRules)
          const domOptions = await extractOptionsFromDom(workerPage)
          if (domOptions.options.length) product.options = domOptions.options
          if (domOptions.combinations.length) product.option_combinations = domOptions.combinations
          await applyStockByOption(workerPage, product)
          // 가격/공급가/이미지가 전부 없으면 상품 페이지가 아니라 품목삭제(또는 차단) 안내 페이지로 추정
          // (scrapeCatalogPage의 scrapeOne과 같은 판정 기준).
          if (product.price == null && product.cost_price == null && !product.thumbnail_urls.length) {
            throw new Error('가격/이미지를 모두 찾지 못함 (품목삭제 또는 차단으로 추정)')
          }
          return { mallProductId: target.id, mallProductCode: target.mallProductCode, product }
        } catch (err) {
          if (attempt < RETRY_COUNT) { await sleep(2_000 * (attempt + 1)); continue }
          return { mallProductId: target.id, mallProductCode: target.mallProductCode, product: null, error: err instanceof Error ? err.message : String(err) }
        }
      }
      return { mallProductId: target.id, mallProductCode: target.mallProductCode, product: null, error: '알 수 없는 오류' }
    }

    async function worker(workerPage: Page) {
      while (true) {
        const i = cursor++
        if (i >= targets.length) return
        if (i > 0) await throttle(opts.delayMs)
        results.push(await recheckOne(workerPage, targets[i]))
      }
    }

    const workerCount = Math.min(concurrency, targets.length || 1)
    const workerPages = await Promise.all(
      Array.from({ length: workerCount }, (_, idx) => (idx === 0 ? page : context.newPage())),
    )
    await Promise.all(workerPages.map(p => worker(p)))
    await Promise.all(workerPages.slice(1).map(p => p.close().catch(() => {})))

    return results
  }, '연속관리 재체크')
}

export interface CategoryLink {
  href: string
  text: string
}

export interface CategoryDiscoveryResult {
  platform: MallPlatform
  links: CategoryLink[]
}

/** 시작 URL 페이지에서 카테고리 메뉴로 보이는 링크를 찾아 사용자가 고를 수 있도록 목록으로 반환한다.
 *  "몰 구조 파악"(profileMallStructure/sampleMallProfile)이 이미 검증해 쓰고 있는 것과 같은 방식을
 *  그대로 재사용한다 — 이전 버전(페이지 전체 <a> 스캔 + 후보마다 실제 방문해 상품 유무 확인)은 후보가
 *  많은 몰에서 수십 번씩 페이지를 열어야 해 느렸고(실사용 불가 수준으로 느리다는 피드백), 그마저도
 *  텍스트 필터만으로는 "[사업자정보확인]"/"이용안내" 같은 진짜 카테고리가 아닌 링크를 걸러내지 못했다.
 *  1) scanCategoryMenu — 내비게이션 메뉴 영역(.cat/.lnb/.snb/.gnb/nav)의 메뉴 트리를 그 자리에서 바로
 *     읽는다(추가 페이지 이동 없음, 사실상 즉시). 약관/개인정보처리방침 등은 이 메뉴 영역 밖에 있는
 *     경우가 대부분이라 애초에 후보에 섞이지 않는다.
 *  2) 메뉴를 텍스트로 못 읽는 몰(이미지 스프라이트 등)만, 후보 링크를 실제로 방문해 그 페이지의
 *     브레드크럼이 있는지로 검증한다(discoverCategoriesByVisitingLinks) — 진짜 상품 목록 페이지만
 *     브레드크럼이 있어 약관류 페이지가 자연히 걸러진다. 이 경로만 후보 수만큼 페이지를 여는 비용이
 *     들지만, 몰 구조분석과 동일한 결과이므로 그쪽에서 이미 분석해둔 몰이면 API 라우트가 캐시를 먼저
 *     확인해 이 느린 경로 자체를 건너뛴다(app/api/scrape/categories/route.ts 참고).
 *  로그인 창을 재사용하는 siteId는 그 page가 사용자가 실제로 보고 있거나 다른 기능이 언제든 다시 움직일
 *  수 있는 공유 탭이라, 탐색은 항상 새 탭에서 한다(공유 탭 재사용 시 실제로 "다른 네비게이션에 의해
 *  중단됨" 충돌을 겪었다). */
export async function discoverCategoryLinks(opts: ScrapeOptions): Promise<CategoryDiscoveryResult> {
  return withContext(opts, async (page, context) => {
    const url = opts.url || page.url()
    const scanPage = await context.newPage()
    try {
      await scanPage.goto(url, { waitUntil: 'load', timeout: 30_000 })
      await loginIfNeeded(scanPage, { url, ...opts })
      // 로그인 필수 페이지는 로그인 폼으로 리다이렉트되므로, 로그인 시도 후 원래 목표 페이지로 다시 이동한다.
      if (opts.loginId && scanPage.url() !== url) {
        await scanPage.goto(url, { waitUntil: 'load', timeout: 30_000 }).catch(() => {})
      }

      const platform = await detectMallPlatform(scanPage)
      let categoryLinks = await scanCategoryMenu(scanPage)
      if (!categoryLinks.length) {
        const candidates = await findCategoryLinkCandidates(scanPage)
        if (candidates.length) categoryLinks = await discoverCategoriesByVisitingLinks(scanPage, candidates)
      }

      const links: CategoryLink[] = categoryLinks.map(c => ({ href: c.href, text: c.name }))
      return { platform, links }
    } finally {
      await scanPage.close().catch(() => {})
    }
  }, '카테고리 불러오기')
}
