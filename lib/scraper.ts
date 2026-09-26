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
import { chromium, type BrowserContext, type Page, type APIResponse, type ElementHandle } from 'playwright'
import { load as loadHtml } from 'cheerio'
import iconv from 'iconv-lite'
import type { ExtractedProduct } from './ai'
import { extractProductFieldsWithAI, generateMallProfileReport, buildHeuristicMallReport, filterRealProductOptions, detectCategoryLinksWithAI, detectSortOptionsFromScreenshot, detectSortTriggerFromScreenshot, detectCategoryMenuTriggerFromScreenshot, detectVisibleCategoryGroupCount, detectVisibleCategoryNames, detectVisibleCategoryHierarchy, detectProductListVisible, type MallStructureReport, type OptionCandidate, type AiProviderId, type VisionAttempt, type AiReportAttempt, ALL_AI_PROVIDERS, runWithAiProviders } from './ai'
import { extractProductRuleBased, type ExtractSelectorOverrides } from './extract'
import type { ExtractionRule } from './ai'
import { solveRecaptchaV2, solveHCaptcha, solveImageCaptcha } from './captcha'
import { isSamePageUrl, looksLikeMallHomeUrl } from './categoryUrl'
import { runAutoAnalysis } from './scrape/adjustment'
import pool, { decryptSecret } from './db'
import { acquireKeepAwake, releaseKeepAwake } from './keepAwake'

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
async function syncManualLoginProfileCopy(allowStale = false): Promise<{ userDataDir: string; profileDirName: string }> {
  const srcRoot = realChromeUserDataDir()
  const profileDirName = activeProfileDirName(srcRoot)
  const destRoot = MANUAL_LOGIN_PROFILE_COPY_ROOT
  fs.mkdirSync(destRoot, { recursive: true })

  const excludeArgs = PROFILE_COPY_CACHE_EXCLUDES.flatMap(d => ['/XD', path.join(srcRoot, profileDirName, d)])
  await execFileAsync('robocopy', [
    path.join(srcRoot, profileDirName), path.join(destRoot, profileDirName),
    '/MIR', '/NFL', '/NDL', '/NJH', '/NJS', '/R:1', '/W:1', ...excludeArgs,
  ], { windowsHide: true }).catch(e => {
    // robocopy는 0~7이 정상(파일 복사/스킵 조합), 8 이상은 일부 파일을 못 옮겼다는 뜻 — 대개 개인 크롬이
    // 실행 중이라 Cookies/Login Data 같은 세션 파일이 잠겨있어서다(2026-07-18 확인: 실제로 이 경우였음).
    // allowStale이면(개발자모드는 실제 크롬을 켜둔 채 쓰는 게 정상이라 이 잠금이 항상 나는 흔한 경우다)
    // 16 미만(=일부 파일만 못 옮김, 사본 자체는 그런대로 씀직함)까지는 그냥 있는 그대로 진행한다 — 16
    // 이상(아무것도 못 옮긴 심각한 오류)만 여전히 실패로 본다.
    if (typeof e?.code === 'number' && e.code < (allowStale ? 16 : 8)) return
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
  /** "카테고리별 정렬기준 설정" 기능용 — categoryUrls의 각 URL(정렬 파라미터가 이미 반영된 최종 URL) 을
   *  키로, 그 카테고리 하나만 따로 적용할 상한을 지정한다. 'pages'는 maxPages를 이 값으로 대체(더 크게는
   *  못 늘림), 'count'는 이 카테고리에서 실제로 담을 상품 개수 자체를 제한한다. 지정 안 한 카테고리는
   *  기존처럼 전역 maxPages/무제한 그대로 적용된다 — collectFromListing 참고. */
  categoryLimits?: Record<string, { mode: 'count' | 'pages'; value: number }>
  /** "카테고리별 정렬기준 설정" 기능 중 AJAX(클릭) 방식 전용(MallSortOption의 kind:'click' 참고) —
   *  categoryUrls의 각 URL을 키로, 그 목록 페이지에 들어간 직후 클릭해야 할 텍스트. URL에 쿼리파라미터로
   *  구워 넣을 수 있는 kind:'query' 정렬은 categoryUrls 자체에 이미 반영돼 있어 이 맵이 필요 없다 —
   *  collectFromListing이 listingUrl로 처음 진입한 순간에만 한 번 적용한다. */
  categorySortClicks?: Record<string, string>
  /** 이 몰에서 학습해 기억해둔 상품 상세 URL 패턴(정규식 source) — deriveDetailUrlPattern 참고.
   *  PLATFORM_PROFILES에 없는 몰(platform=unknown)에서 상품 링크 판별의 기준이 된다. */
  detailUrlPattern?: string
  /** 이미 스크랩된 상품 URL — 목록에서 발견해도 건너뛴다 */
  excludeUrls?: string[]
  /** 상품 페이지 방문 사이 최소 지연(ms). 실제 지연은 이 값~2배 사이 랜덤 (차단 방지) */
  delayMs?: number
  /** 'manual'이면 아래 concurrency 값을 카테고리/상품 동시 처리 개수로 고정해서 쓴다(1~8). 생략 또는
   *  'auto'면 기존 동작 그대로 — scrapeCatalogPage는 몰 반응을 보며 1에서 최대 8까지 스스로 올리고(적응형
   *  동시성), previewCatalog/collectProductUrls의 카테고리 집계도 8로 고정된다(2026-08-20 PC 업그레이드
   *  전엔 4였음). 이 상한(8)은 로컬 하드웨어가 아니라 스크랩 대상 몰 서버가 동시 요청을 얼마나 견디는지에
   *  대한 임의의 안전 마진이라 — 몰 차단(캡차 등)이 잦아지면 수동으로 낮춰본다. */
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
  /** 직접로그인 필수 몰(withContext의 개인 크롬 프로필 사본 재사용 경로)에서, 사용자의 실제 크롬이 켜져
   *  있어 쿠키/세션 파일 일부가 잠긴 채 복사됐어도 그 사본으로 그냥 진행한다 — 실제 스크랩(기본값,
   *  false)은 유효한 세션이 필수라 그 경우 명확히 실패시키지만, "몰 구조분석"처럼 로그아웃 상태로도
   *  대부분 의미 있는 결과가 나오는 가벼운 확인은 매번 "크롬을 꺼주세요"로 막는 대신 있는 그대로 시도하는
   *  쪽이 낫다(2026-08-15, 실사용 확인 — 개발자모드는 사용자가 실제 크롬을 켜둔 채로 쓰는 게 정상 상태라
   *  이 옵션 없이는 몰 구조분석이 사실상 항상 실패했다). */
  allowStaleManualLoginProfile?: boolean
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
  /** "몰 구조분석"이 이미 확인해둔 신호(sites.scrape_profile.hasPaginationWidget===false) — true(=
   *  위젯 없음이 확인됨)면 previewCatalog의 카테고리별 개수 집계가 매 카테고리마다
   *  readLastPageFromNavButton/readMaxPageNumber를 반복 시도하지 않고 곧장 지수+이분 탐색으로
   *  넘어간다. 그 확인 자체가 몰 전체에 대해 항상 실패하는 스킨(펫투비 등)에서, 카테고리 수만큼 반복해도
   *  얻는 게 없던 낭비를 없앤다. */
  knownNoPaginationWidget?: boolean
}

export function profileDir(siteId: number) {
  return path.join(process.cwd(), '.playwright-profiles', String(siteId))
}

/** 개발자모드 확장(extension-poc)이 항상 이 경로에서 최신 코드로 로드되도록 launchVisibleWindow에
 *  --load-extension으로 직접 넘긴다 — chrome://extensions에서 사용자가 수동으로 "압축해제된 확장
 *  프로그램을 로드"해두는 방식은, 이 창이 재실행될 때마다(코드 수정으로 인한 서버 핫리로드 등으로
 *  openSessions가 끊겨 killOrphanedProfileProcess가 기존 크롬을 강제 종료하고 launchPersistentContext가
 *  새로 뜰 때마다) Playwright의 기본 실행 인자(--disable-extensions)에 밀려 사라진다. 확장 목록에서 PTP가
 *  "브라우저를 닫았다 켜면 없어진다"는 증상은 실제로는 사용자가 크롬을 끈 게 아니라, 이 서버 쪽 재실행이
 *  원인이었다(2026-08-22).*/
const PTP_EXTENSION_DIR = path.join(process.cwd(), 'extension-poc')

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** delayMs ~ 2*delayMs 사이 랜덤 대기 (요청 간격을 일정하게 만들지 않기 위한 지터) */
async function throttle(delayMs?: number) {
  if (!delayMs || delayMs <= 0) return
  await sleep(delayMs + Math.random() * delayMs)
}

/** concurrencyMode==='manual'이면 opts.concurrency를 1~16으로 clamp해서 쓰고, 아니면(생략/'auto') autoDefault를
 *  쓴다 — collectProductUrls/previewCatalog의 카테고리 동시 집계 개수에 쓴다(둘 다 자체 ramp 로직이 없어
 *  "auto"가 사실상 고정값 하나뿐이라 이 헬퍼로 충분하다). scrapeCatalogPage는 적응형 동시성(ramp-up)이
 *  있어 이 헬퍼 대신 MAX_CONCURRENCY/activeLimit 시작값을 직접 조정한다. 상한은 원래 8이었는데, 8코어
 *  16스레드/28GB PC에서 8탭이 CPU 15%·메모리 4GB도 안 쓰는 걸 실측 확인해(2026-08-24) 16으로 올렸다 —
 *  몰 쪽 차단/부하 위험은 이 상한과 별개 문제라 사용자가 직접 판단해서 골라 쓴다. */
function resolveConcurrency(opts: ScrapeOptions, autoDefault: number): number {
  if (opts.concurrencyMode !== 'manual') return autoDefault
  return Math.max(1, Math.min(opts.concurrency || 1, 16))
}

// 개별 상품 추출 실패 시 재시도 횟수 (일시적 네트워크/타임아웃 오류 대비). ponytail: 고정값, 설정 불가.
const RETRY_COUNT = 2

declare global {
  var __scrapeOpenSessions: Map<number, BrowserContext> | undefined
  var __scrapeOpenSessionMainPage: Map<number, Page> | undefined
  var __scrapeStopRequests: Set<number> | undefined
  var __previewRuns: Map<number, PreviewRunState> | undefined
  var __scrapeCollectProgress: Map<number, { done: number; total: number }> | undefined
  var __scrapeSiteLocks: Map<number | string, Promise<void>> | undefined
  var __scrapeSiteLockStatus: Map<number | string, { label: string; since: number }> | undefined
  var __scrapeSiteLockDetail: Map<number | string, string> | undefined
  var __scrapeProfileAbortControllers: Map<number, AbortController> | undefined
  var __scrapeCategoryDiscoveryAbortControllers: Map<number, AbortController> | undefined
  var __scrapeSiteLastRunSignals: Map<number, { aiReportAttempts?: AiReportAttempt[]; visionProviderLog?: VisionAttempt[] }> | undefined
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
  /** 카테고리 개수 집계가 끝나기 전에 먼저 뽑아둔 상품 1건 미리보기 — 화면이 "카테고리 N/M 확인 중"과
   *  함께 이 값을 폴링으로 먼저 보여줄 수 있게 한다(getPreviewProgress 참고). 개수 집계보다 상품 미리보기를
   *  먼저 보여달라는 요청(2026-08-14)으로 추가 — 대개 몇 분씩 걸리는 건 개수 집계 쪽이라, 그동안 화면에
   *  아무것도 안 보이는 대신 상품 1건이라도 먼저 보여준다. */
  earlyPreview?: ScrapeResult | null
}

// 로컬 단일 사용자 도구 기준의 인메모리 상태. 여러 사용자가 동시에 쓰면 충돌한다(ponytail: 감수함).
// globalThis에 저장하는 이유: 개발서버(Turbopack)는 코드 파일이 바뀔 때마다 이 모듈을 다시 평가해
// top-level 변수를 초기화한다 — 로그인 창을 열어둔 채로 다른 스크래핑 코드를 고치면 그 순간 이 Map이
// 통째로 새로 만들어져 열려있던 로그인 세션(BrowserContext) 참조를 잃어버리는 문제가 계속 반복됐다.
// globalThis는 모듈이 재평가돼도 같은 Node 프로세스 안에서는 그대로 유지되므로(Prisma 클라이언트 등
// Next.js 개발모드 싱글턴에 흔히 쓰이는 패턴과 동일), 여기 저장하면 코드를 수정해도 세션이 살아남는다.
const openSessions = globalThis.__scrapeOpenSessions ?? (globalThis.__scrapeOpenSessions = new Map<number, BrowserContext>())
// "로그인 창"에서 사용자가 보고 있는 그 탭을 명시적으로 기억해둔다 — openLoginWindow가 채우고,
// getOpenPageUrl/navigateOpenPageTo/startElementPicker가 여기서 읽는다. context.pages() 배열의 "마지막
// 탭"을 그 탭으로 가정하던 예전 방식은, 몰 구조분석처럼 같은 컨텍스트에서 잠깐 여러 탭을 병렬로 열었다가
// 닫는 코드(mapWithPageWorkers)가 있는 한 근본적으로 불안정하다 — 안내 페이지 링크가 택배사 조회
// 사이트로 리다이렉트되는 등, 그 임시 탭 중 하나가 어떤 이유로든(닫기 실패, 타이밍 등) 마지막으로
// 남으면 그게 "사용자가 보는 탭"으로 잘못 인식됐다(실사용 확인, 2026-08-23 — 몰과 무관하게 재현됨).
const openSessionMainPage = globalThis.__scrapeOpenSessionMainPage ?? (globalThis.__scrapeOpenSessionMainPage = new Map<number, Page>())
const stopRequests = globalThis.__scrapeStopRequests ?? (globalThis.__scrapeStopRequests = new Set<number>())

/** siteId의 "로그인 창 메인 탭"을 읽는다 — 추적해둔 페이지가 아직 살아있으면(닫히지 않았으면) 그걸,
 *  없으면(추적 전에 만들어진 세션 등 예외적인 경우) 예전처럼 마지막 탭으로 폴백한다. */
function resolveMainPage(context: BrowserContext, siteId: number): Page | null {
  const tracked = openSessionMainPage.get(siteId)
  const pages = context.pages()
  if (tracked && pages.includes(tracked)) return tracked
  return pages.length ? pages[pages.length - 1] : null
}

// 사용자가 로그인 창에서 카테고리 링크를 누르면 몰이 **새 탭으로 여는 경우**가 흔하다(target=_blank).
// 그때 "현재 카테고리 가져오기"는 추적 중인 원래 탭(대개 홈)을 읽어 엉뚱한 URL을 담았다 — 투비즈온
// 실사용 확인(2026-09-13): 서버에 기억된 수동 카테고리 표본에 `index.php`(홈)가 그대로 섞여 있었다.
// 그래서 "마지막으로 실제 페이지 이동이 일어난 탭"을 따로 기억해두고 그쪽을 우선 읽는다 — 사용자가
// 방금 보고 있는 화면이 곧 그 탭이다.
const lastNavigatedAt = new WeakMap<Page, number>()
function trackPageNavigations(context: BrowserContext) {
  const watch = (page: Page) => {
    lastNavigatedAt.set(page, Date.now())
    page.on('framenavigated', frame => {
      if (frame === page.mainFrame()) lastNavigatedAt.set(page, Date.now())
    })
  }
  context.pages().forEach(watch)
  context.on('page', watch)
}

/** 지금 사용자가 보고 있을 가능성이 가장 큰 탭 — 실제 이동이 가장 최근에 일어난 탭을 고르고,
 *  기록이 없으면(모듈 재평가 등) 기존 추적 탭으로 돌아간다. about:blank/devtools 탭은 제외한다. */
function resolveUserVisiblePage(context: BrowserContext, siteId: number): Page | null {
  const usable = context.pages().filter(p => !p.isClosed() && /^https?:/i.test(p.url()))
  if (!usable.length) return resolveMainPage(context, siteId)
  return usable.reduce((best, p) => ((lastNavigatedAt.get(p) ?? 0) >= (lastNavigatedAt.get(best) ?? 0) ? p : best))
}

/** siteId의 "로그인 창 메인 탭"을 지정한다 — 이 탭이 닫히면 추적을 스스로 지운다(닫힌 뒤에도 남아있으면
 *  resolveMainPage가 죽은 참조를 돌려줄 수 있다). */
function setMainPage(siteId: number, page: Page) {
  openSessionMainPage.set(siteId, page)
  page.on('close', () => {
    if (openSessionMainPage.get(siteId) === page) openSessionMainPage.delete(siteId)
  })
  notifyMainPageChange(siteId)
}

// 원격 화면공유(worker/screenRelay.ts)가 "이 몰의 메인 탭이 바뀌었다/창이 닫혔다"를 알아야 CDPSession을
// 다시 붙이거나 뷰어 연결을 정리할 수 있다 — RPC 요청/응답으로는 이런 비동기 이벤트를 실어 보낼 방법이
// 없어(워커 안에서 같은 프로세스로 도는 코드끼리의 구독), 아주 작은 pub/sub만 추가한다. siteId 기준
// Map이라 기존 openSessions 등과 같은 스코프 원칙을 따른다.
const mainPageChangeListeners = new Map<number, Set<() => void>>()
export function onMainPageChange(siteId: number, cb: () => void): () => void {
  const set = mainPageChangeListeners.get(siteId) ?? new Set()
  set.add(cb)
  mainPageChangeListeners.set(siteId, set)
  return () => set.delete(cb)
}
function notifyMainPageChange(siteId: number) {
  mainPageChangeListeners.get(siteId)?.forEach(cb => cb())
}

/** 원격 화면공유가 CDPSession을 붙일 대상 — openSessions/resolveMainPage를 그대로 재사용한다. */
export function getOpenSessionPage(siteId: number): Page | null {
  const context = openSessions.get(siteId)
  return context ? resolveMainPage(context, siteId) : null
}

/** 실행 중인 스크래핑 세션에 중지를 요청한다 (다음 상품 처리 전에 반영됨) */
export function requestStop(sessionId: number) {
  stopRequests.add(sessionId)
}

/** 개발자모드(크롬 확장)는 이 서버가 아니라 사용자 브라우저에서 루프가 돌고 있어, 인메모리 Set을 직접
 *  못 들여다본다 — 확장이 상품마다 이 함수를 거쳐 공개 API로 물어보게 한다(app/api/scrape/stop-requested). */
export function isStopRequested(sessionId?: number) {
  return sessionId !== undefined && stopRequests.has(sessionId)
}

const collectProgress = globalThis.__scrapeCollectProgress ?? (globalThis.__scrapeCollectProgress = new Map<number, { done: number; total: number }>())

/** app/api/scrape/status가 폴링해서, 상품 URL 수집(카테고리 목록 순회) 단계처럼 product_count/
 *  saved_count가 아직 0이라 "진행 상황"에 보여줄 숫자가 없는 동안에도 "카테고리 N/M 수집 중"을 보여주는
 *  데 쓴다 — 미리보기의 previewRuns/getPreviewProgress와 같은 문제(오래 걸리는 수집 단계가 화면엔 멈춘
 *  것처럼 보임)를 실제 스크랩 세션에도 같은 방식으로 해결한다(2026-08-11). 수집이 끝나면(collectProductUrls
 *  finally) 지워지므로, 이후 상품별 진행률과 겹쳐 보이지 않는다. */
export function getCollectProgress(sessionId: number): { done: number; total: number } | null {
  return collectProgress.get(sessionId) ?? null
}

/** 개발자모드(크롬 확장)는 이 서버가 아니라 사용자 브라우저에서 카테고리 순회가 돌고 있어, 위 Map을
 *  직접 못 건드린다 — app/api/scrape/extension-progress가 확장의 HTTP 요청을 대신 받아 이 함수로
 *  전달한다(2026-08-22, 일반모드의 collectProductUrls가 직접 쓰는 것과 같은 자리를 공유). */
export function setCollectProgress(sessionId: number, done: number, total: number) {
  collectProgress.set(sessionId, { done, total })
}

export function clearCollectProgress(sessionId: number) {
  collectProgress.delete(sessionId)
}

const siteLocks = globalThis.__scrapeSiteLocks ?? (globalThis.__scrapeSiteLocks = new Map<number | string, Promise<void>>())

/**
 * 이 파일의 여러 함수가 openSessions(로그인 창의 공유 탭)를 잠금 없이 그대로 꺼내 page.goto()를 걸거나,
 * profileDir(siteId) 같은 몰 전용 디스크 자원(브라우저 프로필 폴더)에 launchPersistentContext를 건다 —
 * 로그인 창 열기/로그인 확인/몰 구조분석/스크랩 대상 직접지정/미리보기/스크래핑 시작 등 거의 모든 스크랩
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
 * 감싼다. `label`은 사람이 읽을 짧은 한국어 이름("몰 구조분석" 등) — 대기 중인 다른 요청이
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
 * 스크래핑 시작 도중의 몰 구조분석)도 이 큐를 공유해 순서대로만 실행된다 — 오래 걸리는 작업(전체
 * 스크래핑) 중에는 그 몰의 다른 작업이 끝날 때까지 기다리게 되는데, 애초에 같은 로그인 세션으로 두
 * 자동화를 동시에 돌리면 안 되므로 이건 감수하는 트레이드오프다.
 */
/** 지금 그 락을 실제로 쥐고 있는 작업이 뭔지(사람이 읽을 라벨)와 언제부터인지 — 화면에 "다른 작업이
 *  끝나길 기다리는 중"을 보여주는 용도로만 쓴다(getSiteLockStatus 참고). 대기열 자체(순서 보장)는
 *  siteLocks가 담당하고, 이건 그 위에 얹은 순수 표시용 정보라 없어도 잠금 로직 자체는 정확하다. */
const siteLockStatus = globalThis.__scrapeSiteLockStatus ?? (globalThis.__scrapeSiteLockStatus = new Map<number | string, { label: string; since: number }>())
// "몰 구조분석"처럼 label 하나로는 몇 분씩 걸리는 이유를 알 수 없는 작업의 세부 단계(예: "카테고리
// 하위구조 확인 중 (3/17)")를 담아둔다 — siteLockStatus와 별개 Map인 이유: 이건 몇몇 작업만 채우는
// 순수 부가 정보라 없어도(값이 없으면 label만 보여줌) 락 로직 자체엔 전혀 영향이 없어야 한다
// (2026-08-22, 사용자 요청: "여기도 진행현황을 모니터링 가능케 해줄 어떤 진행정보가 없을까").
const siteLockDetail = globalThis.__scrapeSiteLockDetail ?? (globalThis.__scrapeSiteLockDetail = new Map<number | string, string>())

export async function withSiteLock<T>(key: number | string | undefined, label: string, fn: () => Promise<T>): Promise<T> {
  if (key === undefined) return fn()
  const prevTail = siteLocks.get(key) ?? Promise.resolve()
  let releaseTail!: () => void
  const myTail = new Promise<void>(resolve => { releaseTail = resolve })
  siteLocks.set(key, myTail)
  try {
    await prevTail
    // withSiteLock으로 잠기는 작업(몰 구조분석/카테고리 불러오기/스크랩 시작 등 전부)이 하나라도 진행
    // 중인 동안 PC가 절전모드로 빠지지 않게 한다(사용자 요청, 2026-08-30 — lib/keepAwake.ts 참고) —
    // siteLockStatus가 비어있었다가(0개) 지금 처음 하나가 생기는 순간에만 켜면 되므로, 이 Map의 크기로
    // "지금 이 프로세스 안에 진행 중인 작업이 하나라도 있는지"를 그대로 판단한다.
    if (siteLockStatus.size === 0) acquireKeepAwake()
    siteLockStatus.set(key, { label, since: Date.now() })
    return await fn()
  } finally {
    siteLockStatus.delete(key)
    siteLockDetail.delete(key)
    if (siteLockStatus.size === 0) releaseKeepAwake()
    releaseTail()
    if (siteLocks.get(key) === myTail) siteLocks.delete(key)
  }
}

/** withSiteLock으로 잠긴 작업이 지금 어느 세부 단계인지 기록한다 — 그 작업(profileMallStructure 등)
 *  본인이나, 개발자모드 확장의 진행 보고를 대신 받는 API 라우트가 부른다. 잠기지 않은 키에 불러도
 *  (예: 락 해제 직후 뒤늦게 도착한 요청) 조용히 무시된다 — 어차피 다음 getSiteLockStatus가 label 없이
 *  반환해 화면에 안 보인다. */
export function setSiteLockDetail(key: number | string, detail: string) {
  if (siteLockStatus.has(key)) siteLockDetail.set(key, detail)
}

/** 화면(ScraperPanel)이 폴링해서 "⏳ 다른 작업(${label}) 완료를 기다리는 중"을 보여주는 데 쓴다 —
 *  사용자가 버튼을 눌렀는데 응답이 안 오면 그게 이 함수 자체가 느린 건지, 같은 몰의 다른 작업이
 *  끝나길 줄서서 기다리는 중인지 구분할 방법이 없었다(실사용 중 "왜 이렇게 오래 걸리냐"는 질문으로
 *  발견). `sinceMs`가 아주 크면(예: 수 분) 대기가 아니라 그 작업 자체가 오래 걸리고 있다는 뜻이다. */
export function getSiteLockStatus(siteId: number): { label: string; sinceMs: number; detail?: string } | null {
  const entry = siteLockStatus.get(siteId)
  if (!entry) return null
  const detail = siteLockDetail.get(siteId)
  return { label: entry.label, sinceMs: Date.now() - entry.since, ...(detail ? { detail } : {}) }
}

/** "몰 구조분석"이 방금 만든 이번 실행 전용 신호(aiReportAttempts/visionProviderLog, MallProfileSignals
 *  주석 참고 — 일부러 DB엔 저장 안 함)를 개발자모드 화면에서도 볼 수 있게 하는 짧은 캐시. 개발자모드는
 *  확장(extension-poc/background.js의 runProfile)이 /api/sites/[id]/profile을 직접 POST해서 그 HTTP
 *  응답을 PTP 탭이 못 받는다 — PTP 탭은 siteLockStatus.busy가 true→false로 바뀌는 전이만 감지해 DB에서
 *  scrape_profile을 다시 읽는데, 이 신호들은 DB에 없어 여기서도 계속 비어있었다(사용자 지적, 2026-09-24
 *  — "개발자모드에서 몰구조분석 중인데 왜 어떤 llm이 사용되는지 안보이지?"). withSiteLock의 finally에서
 *  siteLockStatus/siteLockDetail과 같이 지우지 않는 이유는, 정확히 락이 풀린 "직후"에 PTP 탭 폴링이
 *  값을 읽어가야 하기 때문 — 락과 동시에 지우면 항상 못 받는다. 다음 실행이 시작되면 그대로 덮어써지므로
 *  별도 만료 처리가 필요 없다. */
const siteLastRunSignals = globalThis.__scrapeSiteLastRunSignals ?? (globalThis.__scrapeSiteLastRunSignals = new Map())

export function setSiteLastRunSignals(siteId: number, signals: { aiReportAttempts?: AiReportAttempt[]; visionProviderLog?: VisionAttempt[] }) {
  siteLastRunSignals.set(siteId, signals)
}

export function getSiteLastRunSignals(siteId: number): { aiReportAttempts?: AiReportAttempt[]; visionProviderLog?: VisionAttempt[] } | null {
  return siteLastRunSignals.get(siteId) ?? null
}

/** 지금 어떤 몰이든(siteId 무관) 브라우저 세션을 쓰는 작업이 하나라도 진행 중인지 — scrapeCatalogPage/
 *  previewCatalog/몰 구조분석 등 withContext를 거치는 작업은 전부 시작부터 끝까지 withSiteLock을 쥐고
 *  있으므로, 이게 비어있으면 이 프로세스 안에서 지금 브라우저를 쓰는 작업이 전혀 없다는 뜻이다. 메모리
 *  임계치 초과 시 자동 재시작(lib/scheduler.ts) 전에 "작업 중간에 끼어들지 않는지" 확인하는 용도.
 *  openSessions(일반모드 "로그인 창 열기"로 띄워둔, 사용자가 지금 직접 아이디/비번을 입력 중일 수 있는
 *  창)도 같이 본다 — 로그인 창을 여는 것 자체는 withSiteLock을 아주 잠깐만 쥐고 곧바로 풀리므로, 그
 *  창이 화면에 열려있는 동안(사용자가 입력하는 중) siteLockStatus만 보면 "유휴"로 잘못 판단해 자동
 *  재시작이 로그인 도중에 끼어들 수 있었다(걸스굽 실사용 확인, 2026-08-17 — 로그인 창 입력 중에
 *  자동 재시작이 화면을 대시보드로 강제 새로고침시킴). */
export function isAnySiteBusy(): boolean {
  return siteLockStatus.size > 0 || openSessions.size > 0
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
export function getPreviewProgress(siteId: number): { done: number; total: number; result?: CatalogPreviewResult; earlyPreview?: ScrapeResult | null } | null {
  const entry = previewRuns.get(siteId)
  return entry ? { done: entry.done, total: entry.total, result: entry.result, earlyPreview: entry.earlyPreview } : null
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
  await execFileAsync('powershell.exe', ['-NoProfile', '-Command', killChromeByPathScript(profileDir(siteId))], { windowsHide: true }).catch(() => {})
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

/** 워커 프로세스(tsx/esbuild)가 이 파일을 변환할 때 keepNames 옵션이 항상 켜져 있어(2026-08-23,
 *  워커 분리 후 발견 — Next.js가 webpack/SWC로 이 코드를 컴파일하던 예전엔 없던 문제), page.evaluate로
 *  넘기는 함수 안에 이름 붙은 지역 함수/화살표 함수(`const isGood = (x) => ...`처럼)가 하나라도 있으면
 *  그 함수 몸통 안에 `__name(isGood, "isGood")` 호출이 같이 끼워 들어간다. Playwright는 evaluate할
 *  함수를 toString()으로 뽑아 브라우저에 그대로 보내는데, __name을 정의해두는 모듈 스코프는 안 따라가서
 *  브라우저에서 "ReferenceError: __name is not defined"로 그 evaluate 전체가 조용히 실패한다(개별 샘플/
 *  카테고리 후보 실패로 묻혀 있어 원인을 찾기 어려웠다 — "몰 구조분석"이 상품을 하나도 못 찾고
 *  "샘플 상품 1건"(=몰 URL 자체로 폴백)으로 끝나는 증상으로 나타남). 진짜 이름 보존은 필요 없고 그냥
 *  fn을 그대로 돌려주기만 하면 되므로, 모든 브라우저 컨텍스트에 이 최소 구현을 미리 심어둔다 — 이
 *  함수 자신은 이름 붙은 지역 함수가 없어 같은 문제에 걸리지 않는다. */
function polyfillEsbuildNameHelper() {
  const g = globalThis as typeof globalThis & { __name?: (fn: unknown, name: string) => unknown }
  if (typeof g.__name !== 'function') g.__name = fn => fn
}

/** "누르거나 방문하는 순간 로그인 세션이 끊기는" 링크만 좁게 잡는 패턴 — 계정/주문 관련 페이지를
 *  폭넓게 거르는 ACCOUNT_UNSAFE_URL_RE와 달리, 이쪽은 "막지 않으면 곧바로 피해가 나는 것"만 담는다.
 *  모든 클릭에 걸리는 전역 그물(blockLogoutClicks)이 쓰는 패턴이라, 넓게 잡아 진짜 카테고리 링크까지
 *  막아버리는 오탐의 대가가 크기 때문이다. 몰마다 쓰는 형태를 모아둔다 — 카페24 `/member/logout.html`,
 *  고도몰/코워크몰 `/mall/member/logout.php`, 메이크샵 `member.html?type=logout` 등. */
export const LOGOUT_URL_RE = /(^|[/_?&=.-])(logout|log-out|log_out|signout|sign-out|sign_out|logoff)([/_?&=.-]|$)/i
export const LOGOUT_TEXT_RE = /로그아웃|로그\s*아웃|log\s*out|sign\s*out/i

/**
 * 모든 브라우저 컨텍스트(헤드리스 자동화 + 화면에 보이는 로그인 창)에 심는 마지막 안전망 — 페이지
 * 안에서 "로그아웃으로 이어지는 클릭"을 취소한다.
 *
 * 왜 클릭 지점마다가 아니라 여기(전역)에도 두는가: 이 코드베이스는 카테고리 메뉴를 찾으려고 화면을
 * 더듬는 경로가 계속 늘어나는데(href 방문 → 텍스트 없는 링크 방문 → 비전 좌표 클릭 → 헤더 아이콘
 * 전수클릭), **새 경로가 생길 때마다 같은 사고가 반복됐다**: 걸스굽(2026-09-01, 텍스트 없는 로그아웃
 * 링크 방문), 오토카필(2026-09-06, 카테고리로 저장된 member/logout.php 방문), 투비즈온(2026-09-12,
 * 비전 좌표 클릭이 계정 페이지에 떨어짐), 투비즈온(2026-09-13, 헤더 아이콘 전수클릭이 헤더 우측
 * 유틸리티 영역의 로그아웃을 그대로 클릭 — 몰구조분석 3회 연속 종료 직후 세션이 끊긴 것으로 확인).
 * 기존 방어는 전부 "어떤 URL로 이동할지"를 거르는 것이라, URL을 보지 않고 DOM 요소를 그냥 누르는
 * 새 경로가 생기면 그대로 다시 뚫린다 — 그래서 "무엇을 누르든 로그아웃이면 안 된다"는 규칙을 개별
 * 호출부가 아니라 브라우저 쪽 한 곳에 둔다.
 *
 * route() 가로채기로 로그아웃 요청 자체를 막는 방법도 검토했지만 쓰지 않았다 — 이 프로젝트에서 이미
 * 실측으로 폐기된 방식이다(MALL_PROFILE_CONCURRENCY 주석: 요청마다 Node 왕복이 생겨 "샘플 상품 6건"이
 * 46~91초 → 183초). 이 방식은 브라우저 안에서 끝나 요청당 비용이 0이다.
 *
 * 사람이 로그인 창에서 정말로 로그아웃하려는 경우(계정 바꾸기 등)까지 막으면 "버튼이 죽은" 것처럼
 * 보이므로, 같은 요소를 0.6~5초 안에 한 번 더 누르면 통과시킨다 — 자동화는 같은 요소를 그 간격으로
 * 두 번 누르지 않는다(전수클릭은 후보마다 페이지를 새로 불러오고, 비전 클릭의 폴백은 100ms 안쪽).
 */
function blockLogoutClicks({ urlSrc, textSrc }: { urlSrc: string; textSrc: string }) {
  const urlRe = new RegExp(urlSrc, 'i')
  const textRe = new RegExp(textSrc, 'i')
  let lastBlockedEl: Element | null = null
  let lastBlockedAt = 0
  window.addEventListener('click', event => {
    let target: Element | null = null
    const path = typeof event.composedPath === 'function' ? event.composedPath() : []
    for (const node of path) {
      const el = node as Element
      if (!el || typeof el.tagName !== 'string') continue
      if (el.tagName === 'A' || el.tagName === 'BUTTON') { target = el; break }
    }
    if (!target && event.target instanceof Element) target = event.target.closest('a, button')
    if (!target) return
    const urls = `${target.getAttribute('href') || ''} ${target.getAttribute('onclick') || ''}`
    const labels = `${target.textContent || ''} ${target.getAttribute('title') || ''} ${target.getAttribute('alt') || ''}`
    if (!urlRe.test(urls) && !textRe.test(labels)) return
    const now = Date.now()
    const sinceBlocked = now - lastBlockedAt
    if (target === lastBlockedEl && sinceBlocked >= 600 && sinceBlocked <= 5_000) {
      lastBlockedEl = null
      return // 사람이 한 번 더 눌러 확인한 것 — 실제 로그아웃을 진행시킨다
    }
    lastBlockedEl = target
    lastBlockedAt = now
    event.preventDefault()
    event.stopImmediatePropagation()
    console.warn('[PTP] 로그아웃 클릭을 막았습니다 — 스크랩 중 로그인 세션이 끊기는 것을 방지합니다.')
    try {
      const id = '__ptp_logout_guard_toast'
      const old = document.getElementById(id)
      if (old) old.remove()
      const box = document.createElement('div')
      box.id = id
      box.textContent = 'PTP가 로그아웃을 막았습니다 — 정말 로그아웃하려면 한 번 더 클릭하세요.'
      box.setAttribute('style', 'position:fixed;z-index:2147483647;left:50%;top:16px;transform:translateX(-50%);'
        + 'max-width:90vw;padding:10px 14px;border-radius:8px;background:#0f172a;color:#fff;'
        + 'font:13px/1.5 system-ui,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.35)')
      if (document.body) document.body.appendChild(box)
      setTimeout(() => box.remove(), 5_000)
    } catch { /* 안내 토스트는 부가 기능 — 실패해도 차단 자체는 이미 끝났다 */ }
  }, true)
}

/** 새로 만든 브라우저 컨텍스트마다 공통으로 심어야 하는 초기화 스크립트 — 컨텍스트를 만드는 곳이
 *  네 군데(로그인 창/개인프로필 사본/몰 전용 프로필/임시)라, 하나씩 따로 부르면 새 경로가 생겼을 때
 *  또 빠진다. 순서가 중요하다: __name 폴리필이 먼저 들어가야 그 뒤 스크립트가 esbuild keepNames
 *  변환(polyfillEsbuildNameHelper 주석 참고)에 걸리지 않는다. */
async function installCommonInitScripts(context: BrowserContext) {
  await context.addInitScript(polyfillEsbuildNameHelper)
  await context.addInitScript(blockLogoutClicks, { urlSrc: LOGOUT_URL_RE.source, textSrc: LOGOUT_TEXT_RE.source })
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
    args: [`--disable-extensions-except=${PTP_EXTENSION_DIR}`, `--load-extension=${PTP_EXTENSION_DIR}`],
    ignoreDefaultArgs: ['--disable-extensions'],
  })
  // navigator.webdriver=true는 Playwright로 띄운 크롬임을 드러내는 가장 흔한 신호라, 로그인 시 본인인증
  // 단계를 건너뛰고 차단하는 몰(예: 카페24 PC인증 연동)에서 이 창만 로그인이 안 되는 원인이 될 수 있다.
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
  })
  await installCommonInitScripts(context)
  trackPageNavigations(context)
  openSessions.set(siteId, context)
  // 사용자가 창을 직접 닫거나 브라우저가 죽었을 때도 반영되도록 추적
  context.on('close', () => {
    if (openSessions.get(siteId) === context) openSessions.delete(siteId)
    openSessionMainPage.delete(siteId)
    notifyMainPageChange(siteId)
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
    setMainPage(siteId, page)
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
 * --load-extension으로 PTP 개발자모드 확장을 매번 같이 띄운다 — 이 창은 사용자의 실제 개인 프로필이라
 * launchVisibleWindow처럼 Playwright가 자동으로 --disable-extensions를 붙이는 문제는 없지만, 이 프로필에
 * chrome://extensions로 수동으로 로드해둔 PTP는 이 세션 내내 extension-poc를 계속 고치는 동안(버전
 * 1.43→1.46 등) 크롬이 재시작 사이에 그 항목을 통째로 목록에서 빠뜨리는 게 실사용 중 반복 확인됐다
 * (2026-08-22) — --load-extension은 매번 그 자리에서 폴더를 다시 읽어 새로 등록하므로 이 문제와 무관하게
 * 항상 최신 코드로 뜬다. --disable-extensions-except는 주지 않는다 — 그걸 주면 사용자가 평소 쓰는 다른
 * 확장 프로그램(광고 차단, 비밀번호 관리 등)이 이 창에서 전부 비활성화돼버린다.
 * --profile-directory를 반드시 명시한다 — 이 PC 크롬에 프로필이 두 개("Default"=ilda, "Profile 1"=상은)
 * 있는데, 이 함수는 원래 프로필을 지정하지 않아 크롬이 그때그때 마지막으로 활성화됐던 프로필로 제멋대로
 * 열렸다. 그래서 PTP가 매번 다른 프로필에 로드되는 경우가 섞여 있었고, 사용자 눈에는 "같은 크롬인데
 * 확장이 사라진다"로 보였다(2026-08-22). syncManualLoginProfileCopy처럼 activeProfileDirName(last_used)
 * 으로 동적으로 찾지 않고 값을 고정한다 — last_used 자체가 이 버그의 원인이라 다시 쓰면 똑같이 흔들린다.
 * 이 함수는 "이 PC의 그 특정 개인 프로필 하나"를 가리키는 용도라 고정값이 더 안전하다. 이 몰(모자사러)의
 * 로그인 신뢰(PC인증)가 실제로 쌓여있는 프로필이 "Default"(ilda)라 이 값으로 고정한다(사용자 지정,
 * 2026-08-22).
 */
const PTP_MANUAL_LOGIN_CHROME_PROFILE = 'Default'

export async function openManualLoginWindow(siteId: number, url: string): Promise<void> {
  // closeLoginWindow가 openSessions를 만지므로 같은 락 키를 공유한다(withSiteLock 주석 참고) — 실제
  // 브라우저 자체는 추적 밖의 개인 크롬이라 락이 끝난 뒤에는 이 함수가 더 할 일이 없다.
  return withSiteLock(siteId, '로그인 창 열기(직접로그인)', async () => {
    await closeLoginWindow(siteId)
    // --no-first-run/--no-default-browser-check가 없으면 실제 크롬이 "Chrome에 로그인" 등 첫 실행 온보딩
    // 화면을 활성 탭으로 띄워버려, 요청한 몰 로그인 URL로 바로 이동하지 않는다.
    // 주의: 크롬이 이미 그 프로필로 실행 중이면 이 커맨드라인은 기존 프로세스로 전달만 되고 새 스위치는
    // 무시된다(크롬의 표준 동작) — --load-extension이 실제로 반영되려면 이 스폰이 그 프로필의 첫 실행이어야
    // 한다. 위 주석대로 이 함수는 그런 "먼저 크롬을 닫아야 하는" 전제로 쓰이므로 보통은 문제 없다.
    const child = spawn(CHROME_EXE, [
      '--no-first-run', '--no-default-browser-check',
      `--profile-directory=${PTP_MANUAL_LOGIN_CHROME_PROFILE}`,
      `--load-extension=${PTP_EXTENSION_DIR}`,
      url,
    ], { detached: true, stdio: 'ignore' })
    child.unref()
  })
}

/** 개발자모드(manual_login_required) 몰의 미리보기 그리드 "열기" 전용 — 이미 로그인해둔 실제 개인 크롬
 *  창에 새 탭으로 그 URL을 연다. openManualLoginWindow와 달리 기존 창을 먼저 닫지 않는다 — 크롬이 이미
 *  그 프로필로 떠 있으면 이 커맨드라인은 새 창을 띄우지 않고 기존 프로세스로 그대로 전달돼(위
 *  openManualLoginWindow 주석 참고, 크롬의 표준 동작) 새 탭 하나만 연다. openUrlInLoginWindow(일반모드,
 *  openSessions의 Playwright 자동화 창)를 그대로 쓰면 이 몰들은 로그인 자체가 안 되는 창이 새로 뜨는
 *  문제가 있었다(!specifications/manual-login-required-malls.md의 구조적 한계와 같은 원인) — 이 함수는
 *  자동화가 전혀 아닌 사용자의 실제 개인 프로필이라 그 한계 자체가 적용되지 않는다. 그 탭은 프로필 첫
 *  실행 때 붙여둔 확장을 그대로 쓸 수 있어, 열자마자 확장 아이콘 → "🎯 보조 - 스크랩 대상 직접지정"을
 *  누르면 이 상품 기준으로 바로 지정할 수 있다(사용자 요청, 2026-09-09). */
export function openUrlInManualLoginChrome(url: string): void {
  const child = spawn(CHROME_EXE, [`--profile-directory=${PTP_MANUAL_LOGIN_CHROME_PROFILE}`, url], { detached: true, stdio: 'ignore' })
  child.unref()
}

/**
 * 이미 로그인해둔 개발자모드 창(위 openManualLoginWindow가 띄운 실제 개인 크롬)을 새 탭/새 창 없이 그대로
 * 화면 앞으로 가져온다 — "몰 구조분석" 버튼을 다시 눌렀다고 openManualLoginWindow를 또 부르면 매번 새 탭이
 * 쌓이고, 사용자가 보기엔 "다른 창이 뜬 것"처럼 느껴진다(사용자 지적, 2026-08-29).
 *
 * 처음엔 WMI(Get-CimInstance Win32_Process)로 커맨드라인에서 --type=(렌더러/GPU) 제외 + --profile-
 * directory 매칭을 시도했는데, CommandLine 속성 자체가 항상 채워진다는 보장이 없고(권한/버전에 따라
 * 비어있을 수 있음, 실사용에서 "창을 계속 못 찾는다"로 확인) 실제 브라우저 창 프로세스인지 판별하는
 * 더 직접적인 신호가 이미 있다 — Get-Process의 MainWindowTitle: 최상위 창을 가진 프로세스만 이 값이
 * 채워지고, 렌더러/GPU/유틸리티 등 자식 프로세스는 항상 비어있다. 그래서 WMI/커맨드라인 매칭을 걷어내고
 * 이 방식으로 단순화했다(2026-08-29). 여러 개면 하나라도 AppActivate가 성공할 때까지 순서대로 시도한다.
 * SetForegroundWindow API를 직접 쓰면 "포그라운드 프로세스만 호출 가능"이라는 Windows 제약에 걸리는데,
 * AppActivate는 더 오래된 COM 경로라 이 제약을 우회해 동작한다(범용적으로 쓰이는 방식).
 *
 * -ExecutionPolicy Bypass가 없으면 이 환경의 정책상 인라인 -Command도 조용히 막힐 수 있다 —
 * lib/workerRestart.ts가 이미 그 이유로 이 플래그를 쓰고 있어 그대로 맞췄다. 창을 하나도 못 찾으면
 * (크롬 자체가 안 떠 있음) false를 반환해 호출부가 "먼저 로그인 창을 열어달라"는 안내로 대체하게 한다.
 *
 * MainWindowTitle만으로는 이 창(실제 개인 크롬)과 launchVisibleWindow/withContext 등이 띄우는 Playwright
 * 자동화 창(정상모드 몰구조분석용, 이 창도 --load-extension으로 같은 PTP를 로드하고 화면에 보이므로
 * MainWindowTitle이 채워짐)을 구분할 수 없다 — 실사용 확인(2026-08-30): 같은 몰(siteId 19)에 두 창이
 * 동시에 떠 있을 때 이 함수가 Playwright 창(PID가 더 작아 foreach가 먼저 만남)을 활성화해버려 "여기서는
 * PTP를 못 쓴다"는 결과로 이어졌다. Playwright가 띄운 창은 항상 `--remote-debugging-pipe`로 CDP를 붙이고
 * `.playwright-profiles` 아래 전용 프로필을 쓰므로, 커맨드라인에 이 신호가 있으면 후보에서 제외한다 —
 * "특정 플래그가 있어야 매칭"이 아니라 "이 신호가 있으면 확실히 아니다"는 배제 규칙이라, 위 611행 근처의
 * "CommandLine이 항상 채워진다는 보장이 없다"는 문제(포함 매칭 실패)와 달리 CommandLine을 못 읽어도
 * 안전하게 폴백(그냥 후보로 남김)할 수 있다.
 */
export async function focusManualLoginChrome(): Promise<boolean> {
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
$procs = Get-Process -Name chrome -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle }
if (-not $procs) { Write-Output 'NO_WINDOW'; exit 1 }
$shell = New-Object -ComObject WScript.Shell
foreach ($p in $procs) {
  $cmdLine = (Get-CimInstance Win32_Process -Filter "ProcessId=$($p.Id)" -ErrorAction SilentlyContinue).CommandLine
  if ($cmdLine -and ($cmdLine -match '--remote-debugging-pipe' -or $cmdLine -match '\\.playwright-profiles')) { continue }
  if ($shell.AppActivate($p.Id)) { Write-Output "ACTIVATED $($p.Id)"; exit 0 }
}
Write-Output 'ACTIVATE_FAILED'
exit 1
`
  return new Promise(resolve => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      (err, stdout, stderr) => {
        if (err) console.log(`[focusManualLoginChrome] 실패: ${stdout?.trim()} ${stderr?.trim()} ${err.message}`)
        resolve(!err)
      })
  })
}

/**
 * 일반모드 로그인 창(openSessions, launchVisibleWindow가 띄운 이 siteId 전용 프로필)을 화면 앞으로
 * 가져온다. openUrlInLoginWindow가 그동안 이 용도로 Playwright의 page.bringToFront()(CDP 기반)를 썼는데,
 * Windows는 포그라운드에 없는 프로세스의 SetForegroundWindow 호출을 대체로 무시한다 — CDP의
 * "activate"도 결국 이 API를 타므로 같은 제약에 걸려, 실제로는 탭이 그 창에 정상적으로 열렸는데도 화면은
 * 계속 사용자가 보던 창(다른 개인 브라우저 등)에 머물러 있고, 나중에 보면 "다른 창에서 열렸다"처럼
 * 보이는 원인이었다(실사용 확인, 2026-09-09 — 가방쟁이/siteId 12).
 *
 * focusManualLoginChrome은 정확히 같은 AppActivate 우회를 이미 쓰고 있지만 그쪽은 `.playwright-profiles`
 * 창을 일부러 후보에서 "제외"한다(실제 개인 크롬만 찾아야 하므로, 611행 근처 주석 참고) — 이 함수는
 * 반대로 그 시그널로 "포함" 매칭한다: 이 siteId의 profileDir(고유 경로, 마지막 세그먼트가 siteId라 다른
 * siteId 폴더와 겹칠 일이 없다)가 커맨드라인에 있는 프로세스만 골라 AppActivate한다.
 */
export async function focusLoginWindow(siteId: number): Promise<boolean> {
  if (process.platform !== 'win32') return false
  // launchVisibleWindow가 실제로 넘기는 커맨드라인은 --user-data-dir=<dir>처럼 따옴표도 구분자도 없이
  // 그 뒤에 바로 다음 플래그가 공백으로 이어붙는다(2026-09-09, 직접 커맨드라인 덤프로 확인 — 처음엔
  // 닫는 따옴표나 경로 구분자가 뒤따른다고 잘못 가정해 매칭에 실패했었다). siteId가 자리수 접두어라
  // profileDir(1)이 profileDir(12) 문자열에 부분포함되는 문제가 있어, -like 단순 와일드카드로는 경계를
  // 표현할 수 없다 — .NET 정규식의 부정형 전방탐색((?!\d))으로 "이 경로 뒤에 숫자가 더 이어지지 않는다"를
  // 강제해 다른 siteId와 겹치지 않게 한다.
  const dir = profileDir(siteId)
  const dirPattern = dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
$procs = Get-Process -Name chrome -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle }
if (-not $procs) { Write-Output 'NO_WINDOW'; exit 1 }
$shell = New-Object -ComObject WScript.Shell
foreach ($p in $procs) {
  $cmdLine = (Get-CimInstance Win32_Process -Filter "ProcessId=$($p.Id)" -ErrorAction SilentlyContinue).CommandLine
  if (-not $cmdLine) { continue }
  if (-not ($cmdLine -match '${dirPattern}(?!\\d)')) { continue }
  if ($shell.AppActivate($p.Id)) { Write-Output "ACTIVATED $($p.Id)"; exit 0 }
}
Write-Output 'ACTIVATE_FAILED'
exit 1
`
  return new Promise(resolve => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      (err, stdout, stderr) => {
        if (err) console.log(`[focusLoginWindow] 실패(siteId=${siteId}): ${stdout?.trim()} ${stderr?.trim()} ${err.message}`)
        resolve(!err)
      })
  })
}

/** 워커를 재시작하기 직전에 호출 — 열려있는 로그인 창(들)을 강제종료 대신 정상 종료시켜, Chrome이
 *  최근 로그인/세션 쿠키를 프로필 디렉터리에 마저 flush할 시간을 준다. 창 자체는 이후 강제종료로
 *  어차피 사라지지만(launchPersistentContext가 기본으로 쓰는 --remote-debugging-pipe는 이 프로세스와
 *  파이프로 묶여있어, 이 프로세스가 죽으면 Chrome도 같이 죽는다 — Windows Job Object 문제와는 별개로
 *  파이프 기반 CDP 전송 자체의 한계, lib/workerRestart.ts 주석 참고), 디스크에 남은 쿠키 덕분에
 *  다음에 그 프로필로 새로 띄우는 창은 대부분 이미 로그인된 상태로 열린다(실사용 확인, 2026-08-31 —
 *  강제종료 직후엔 로그인 직후였던 세션이 로그아웃 상태로 되돌아가는 사고가 있었다. worker/index.ts의
 *  메모리 임계치 자동재시작도 같은 경로를 타므로, 사람이 개입 안 해도 오래 켜두면 재현된다).
 *  각 창을 최대 timeoutMs까지만 기다리고(하나가 응답 없어도 재시작 자체는 막지 않음), 시작하자마자
 *  맵을 비워 close() 진행 중에 다른 코드가 이 세션들을 "아직 살아있다"고 잘못 재사용하지 않게 한다. */
export async function closeAllOpenSessionsGracefully(timeoutMs = 3_000): Promise<void> {
  const contexts = [...openSessions.values()]
  openSessions.clear()
  await Promise.all(contexts.map(ctx =>
    Promise.race([
      ctx.close().catch(() => {}),
      new Promise(resolve => setTimeout(resolve, timeoutMs)),
    ]),
  ))
}

/** 현재 로그인 창에서 사용자가 보고 있는 페이지 URL (없으면 null) */
export function getOpenPageUrl(siteId: number): string | null {
  const context = openSessions.get(siteId)
  if (!context) return null
  // 추적 탭이 아니라 "방금 이동한 탭"을 읽는다 — resolveUserVisiblePage 주석 참고(새 탭으로 열리는 몰).
  return resolveUserVisiblePage(context, siteId)?.url() ?? null
}

/** "로그인 확인" 버튼이 실제로 로그인됐는지 조금이라도 검증할 수 있게, 지금 페이지에 "로그아웃"
 *  링크가 있는지 본다 — 국내 쇼핑몰 대부분이 로그인 상태에서만 이 문구를 내보내는 관례를 이용한
 *  가벼운 신호일 뿐이다. 몰마다 문구/아이콘이 달라(로그아웃 대신 "LOGOUT", 아이콘만 표시 등) 확실한
 *  판정 수단은 아니라서, 화면에서도 이 결과를 확정("로그인 안 됨")이 아니라 경고로만 보여주고 흐름을
 *  막지 않는다(사용자 요청, 2026-08-31 — 걸스굽에서 "로그인 확인"을 눌렀는데 실제로는 로그인이 안 된
 *  채로 몰구조분석이 계속 로그인 페이지만 도는 사고가 있었는데, 기존 "확인" 버튼은 사용자가 눌렀다는
 *  것만 그대로 믿을 뿐 아무 것도 검증하지 않았다).
 *
 *  <a> 태그의 화면 텍스트만 보던 게 실제로 "아이콘만 표시"(위 주석이 이미 알려진 한계로 적어뒀던
 *  케이스) 몰에서 사고로 이어졌다(정글북 실사용 확인, 2026-09-15 — 사용자 질문 "로그인이 끊겼다는
 *  내용은 맞는거야?"로 재확인: 로그아웃 컨트롤이 `<button aria-label="로그아웃">`처럼 텍스트 없이
 *  아이콘뿐인 버튼이라, 실제로는 로그인된 채였을 실행에서도 몰구조분석마다 "로그인 세션이 끊긴 것으로
 *  보임" 경고가 항상 떴다 — 로그인 복구 로직까지 매번 불필요하게 돌았을 수 있다). <a>뿐 아니라 <button>/
 *  role=button도 보고, 화면 텍스트뿐 아니라 aria-label/title(스크린리더용 대체 텍스트)도 같이 본다. */
export async function detectLoggedInSignal(page: Page): Promise<boolean | null> {
  try {
    return await page.evaluate(() =>
      Array.from(document.querySelectorAll('a, button, [role="button"]')).some(el => {
        const text = `${el.textContent || ''} ${el.getAttribute('aria-label') || ''} ${el.getAttribute('title') || ''}`
        return /로그아웃|logout/i.test(text)
      }),
    )
  } catch {
    return null
  }
}

/**
 * "로그인 확인" 시 로그인 창을 등록해둔 몰 URL로 이동시킨다 — 로그인 후 랜딩된 페이지(마이페이지 등)가
 * 로그인 URL과 다른 몰(예: 시즌백)에서는 로그인 확인 후에도 스크랩 대상 페이지가 아닌 곳에 머물러 있었다.
 * 새 탭을 열지 않고 기존 탭을 재사용한다(startElementPicker와 동일한 이유 — 탭이 계속 쌓이는 문제 방지).
 */
export async function navigateOpenPageTo(siteId: number, url: string): Promise<{ url: string; loggedIn: boolean | null } | null> {
  // withContext와 같은 락 키(siteId) — 공유 탭에 직접 goto를 거는 함수라 withSiteLock 주석이 설명하는
  // 패턴 그대로다.
  return withSiteLock(siteId, '로그인 확인', async () => {
    const context = openSessions.get(siteId)
    if (!context) return null
    const page = resolveMainPage(context, siteId) ?? await context.newPage()
    setMainPage(siteId, page)
    if (page.url() !== url) {
      await page.goto(url, { waitUntil: 'load', timeout: 30_000 }).catch(() => {})
    }
    await page.bringToFront().catch(() => {})
    return { url: page.url(), loggedIn: await detectLoggedInSignal(page) }
  })
}

/**
 * 미리보기 화면의 "열기" 버튼처럼, 로그인된 상태로 특정 상품 페이지를 확인하고 싶을 때 쓴다. 로그인 창이
 * 열려있으면 그 창(세션 쿠키를 가진 그 브라우저)에 새 탭을 띄워 이동시킨다. 사용자가 창을 닫아 열려있는
 * 로그인 창이 없어도, 같은 프로필 디렉터리에 남아있는 예전 로그인 쿠키를 그대로 재사용해 새 창을 띄운다
 * (그 쿠키가 만료됐으면 그 사이트 자체가 로그인 페이지로 돌려보낼 뿐 — 이 함수가 할 수 있는 건 여기까지).
 */
export async function openUrlInLoginWindow(siteId: number, url: string): Promise<void> {
  // 이미 열린 세션이 있으면 "메인 탭"(resolveMainPage/setMainPage — startElementPicker가 "스크랩 대상
  // 직접지정" 때 그대로 재사용하는 바로 그 탭)을 그 자리에서 새 URL로 이동시킨다 — 락 없이 바로 처리한다
  // (다른 무거운 작업이 같은 몰에서 진행 중이어도 "열기"가 그것 때문에 기다릴 필요는 없다).
  // 예전엔 매번 existing.newPage()로 새 탭을 열기만 하고 어디도 "메인 탭"으로 등록하지 않아서, "상품 URL"을
  // 눌러 열어본 탭과 그다음 "스크랩 대상 직접지정"이 실제로 조작하는 탭이 서로 다른 탭이 되는 문제가
  // 있었다 — 게다가 누를 때마다 탭이 하나씩 계속 쌓였다(사용자 지적, 2026-09-12 — "상품 URL 클릭 시
  // 로그인한 웹페이지에서 열리게 해. 그래야 스크랩 대상 직접지정이 가능해"). 같은 탭을 계속 재사용/이동
  // 시키면 두 기능이 항상 같은 페이지를 보게 되고, 탭도 안 쌓인다.
  const existing = openSessions.get(siteId)
  if (existing) {
    const page = resolveMainPage(existing, siteId) ?? await existing.newPage()
    setMainPage(siteId, page)
    await page.goto(url, { waitUntil: 'load', timeout: 30_000 }).catch(() => {})
    await page.bringToFront().catch(() => {})
    await focusLoginWindow(siteId)
    return
  }
  // 세션이 없으면 새로 띄워야 하는데, launchVisibleWindow는 같은 몰의 다른 작업(withContext 등)과
  // 충돌할 수 있는 close+kill+launch 절차라 withSiteLock으로 감싼다(withContext와 같은 락 키).
  return withSiteLock(siteId, '로그인 창 열기', async () => {
    // 락을 기다리는 사이 다른 실행이 이미 로그인 창을 열어뒀을 수 있다 — 다시 확인한다.
    const nowExisting = openSessions.get(siteId)
    if (nowExisting) {
      const page = resolveMainPage(nowExisting, siteId) ?? await nowExisting.newPage()
      setMainPage(siteId, page)
      await page.goto(url, { waitUntil: 'load', timeout: 30_000 }).catch(() => {})
      await page.bringToFront().catch(() => {})
      await focusLoginWindow(siteId)
      return
    }
    const context = await launchVisibleWindow(siteId)
    const page = context.pages()[0] || await context.newPage()
    setMainPage(siteId, page)
    await page.goto(url, { waitUntil: 'load', timeout: 30_000 }).catch(() => {})
    await focusLoginWindow(siteId)
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

// 회원전용 몰은 로그인 안 된 채로 상품/카테고리 페이지를 열면 리다이렉트 전에 JS
// alert("회원만 접근권한이 있습니다." 등)부터 띄우는 경우가 있다(펫토리 실사용 확인, 2026-09-06 —
// 몰구조분석/카테고리 불러오기가 이 몰에서 몇 분씩 걸리다 결과 없이 끝나는 원인을 실제 브라우저로 직접
// 재현해 특정: page.goto()가 이 네이티브 alert 때문에 멈춰있다가 매번 페이지 타임아웃까지 다 채우고서야
// "실패"로 넘어갔다 — Playwright는 dialog 이벤트를 명시로 처리해두지 않으면 자동으로 안 닫아준다).
// 이 프로젝트 어디에도 dialog 핸들러가 없어 이런 몰은 전부 카테고리/상품 후보 하나하나가 이 타임아웃을
// 그대로 물고 늘어져, 최종적으로는 "규칙 기반 실패 → AI도 실패"로 귀결됐다(AI 폴백도 같은 방식으로
// 후보를 방문해 검증하므로 똑같이 걸림). 헤드리스로 도는 이 함수가 만드는 컨텍스트 전부에 자동 닫기를
// 걸어, 그 즉시 새로 뜨는 페이지가(대개 로그인 페이지로) 리다이렉트되게 한다 — 이러면 기존의
// "비밀번호 입력창 유무"(isLoginPage) 판정이 원래 하던 대로 그 리다이렉트 결과를 정확히 읽는다.
function installDialogAutoDismiss(context: BrowserContext) {
  context.on('dialog', dialog => { dialog.dismiss().catch(() => {}) })
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
        const page = resolveMainPage(openContext, siteId) ?? await openContext.newPage()
        setMainPage(siteId, page)
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
            const { userDataDir, profileDirName } = await syncManualLoginProfileCopy(!!opts.allowStaleManualLoginProfile)
            context = await chromium.launchPersistentContext(userDataDir, {
              headless: true, channel: 'chrome', chromiumSandbox: true,
              args: profileDirName !== 'Default' ? [`--profile-directory=${profileDirName}`] : [],
            })
            installDialogAutoDismiss(context)
            // launchVisibleWindow와 같은 이유 — navigator.webdriver=true는 Playwright로 띄운 크롬임을
            // 드러내는 가장 흔한 신호다. 이 경로는 로그인을 다시 시도하지 않아(이미 유효한 쿠키 재사용)
            // PC인증 자체에 걸릴 일은 없지만, "카테고리 불러오기"/"몰 구조분석"이 헤드리스로 도는 동안
            // 자동화 탐지에 걸려 다른 응답을 받을 위험을 줄인다(사용자 지적, 2026-08-17 — 확장으로
            // 옮기지 않고 이 경로를 계속 쓰기로 한 결정에 맞춰 안전장치만 보강).
            await context.addInitScript(() => {
              Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
            })
            await installCommonInitScripts(context)
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
      installDialogAutoDismiss(context)
      await installCommonInitScripts(context)
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
    installDialogAutoDismiss(ctx)
    await installCommonInitScripts(ctx)
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

// 카테고리 선택 UI(`cate[]`, `category`, `ctno` 등)를 상품 옵션으로 잡던 문제를 막는다 — 투비즈온
// 실사용 확인(2026-09-13): 미리보기 옵션1이 `cate[]`로 잡히고 값이 "여성의류, 남성의류, 언더웨어…"
// 였다. 상품 옵션이 아니라 페이지의 카테고리 필터다. 검색/브랜드 필터도 같은 부류라 같이 막는다.
const OPTION_SELECT_EXCLUDE_RE = /수량|qty|quantity|정렬|sort|perpage|page|cate|category|분류|검색|search|brand|브랜드|filter|필터/i
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

/** MallProfileSignals.sortOptions/ScrapeOptions.categorySortClicks 공용 타입 — 위 sortOptions 필드
 *  주석 참고. `kind`가 없는(옛 데이터, DB에 이미 저장돼 있던) 항목은 항상 'query'로 취급한다. */
export type MallSortOption =
  | { label: string; kind?: 'query'; paramsToAdd: Record<string, string> }
  | { label: string; kind: 'click'; clickText: string }

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
  /** categoryLinks를 찾을 때 AI(로컬 Ollama, detectCategoryLinksWithAI)가 실제로 기여했는지 —
   *  applyProfileResult가 이번 결과가 규칙 기반으로 떨어졌을 때 예전 AI 결과를 지키는 판단 기준으로
   *  쓴다("카테고리 불러오기"의 categoryLinksAiUsed와 같은 개념, 몰 구조분석 쪽에도 똑같이 필요해졌다 —
   *  신우 몰 실사용 확인, 2026-08-25). */
  categoryLinksAiUsed?: boolean
  /** deriveCategoryUrlPattern이 categoryLinks에서 역산해둔 "이 몰의 카테고리 URL 패턴"(정규식 문자열) —
   *  규칙 기반이든 AI든 한 번 카테고리를 찾을 때마다 갱신된다. 다음번 탐지 시 scanByKnownUrlPattern이
   *  구조 스캔/AI 없이 즉시 카테고리를 다시 찾는 "기억" 역할을 한다(사용자 요청, 2026-08-26). */
  categoryUrlPattern?: string | null
  /** 목록 페이지에 이 코드가 읽을 수 있는 페이지네이션 위젯(마지막 페이지 버튼 또는 페이지 번호 링크)이
   *  있는지 — false면 미리보기의 카테고리별 개수 집계(countCategoryProductsOnce)가 매 카테고리마다 같은
   *  확인을 반복하지 않고 곧장 지수+이분 탐색으로 넘어간다(knownNoPaginationWidget 참고). 위젯이 전혀
   *  없는 몰은 그 확인이 어차피 항상 실패로 끝나 카테고리 수만큼 반복해도 얻는 게 없다(펫투비 등 일부
   *  고도몰 스킨에서 실사용 확인, 2026-08-11 — 이 몰은 카테고리 하나에 최후수단 순회까지 떨어져 미리보기가
   *  30분 넘게 걸렸다). */
  hasPaginationWidget: boolean
  /** "카테고리별 정렬기준 설정" 기능용 — 이 몰의 목록 페이지가 지원하는 정렬 옵션(최신순/낮은가격순 등
   *  표준 라벨)과, 그 정렬을 실제로 적용하는 방법. 두 가지 종류가 있다(2026-08-23, 펫투비 실사용 확인
   *  — URL이 전혀 안 바뀌는 AJAX 정렬 몰을 만나 추가):
   *  - `kind:'query'`(기존 방식, 대부분의 몰): 카테고리 URL에 추가해야 하는 쿼리파라미터. 샘플 카테고리
   *    1개 기준으로 추출한 "파라미터 차이"라 다른 카테고리(base 쿼리파라미터가 달라도, 예: ?code=0049 vs
   *    ?cate_no=45) URL에도 그대로 덧붙여 재사용할 수 있다.
   *  - `kind:'click'`(고도몰 등 일부 스킨의 `javascript:sort(...)` 정렬): 정렬이 URL에 전혀 반영되지
   *    않고 AJAX로 목록만 다시 그려진다 — 클릭해서 확인할 텍스트(clickText)만 저장해두고, 실제 스크랩
   *    시점(collectProductUrls의 collectFromListing)에 그 카테고리 목록 페이지에 들어간 직후 이 텍스트를
   *    실제로 한 번 클릭해 정렬을 적용한다.
   *  deep(="몰 구조분석")에서만 채워지고, 가벼운 구조변화감지(deep=false)나 지원 안 되는 몰은 빈 배열. */
  sortOptions: MallSortOption[]
  /** URL 계층/카테고리/결제계좌/택배사/재고관리형태/업체연락처/상품페이지구조/스크래핑 유의사항을 실제로
   *  수집한 원문(홈 하단 회사정보 + 이용안내·공지 등 게시판 + 상품페이지) 기반으로 AI가 요약한 리포트.
   *  ANTHROPIC_API_KEY 미설정이거나 원문을 하나도 못 모았으면 null. */
  report: MallStructureReport | null
  /** ProfileCheckResult.thisRunReportSource와 같은 값 — applyProfileResult가 병합 전에 "이번 실행 자체가
   *  실제로 만든" 출처를 여기 그대로 영구 저장한다(report와 달리 DB UPDATE 제외 목록에 없음). 일반모드는
   *  "몰 구조분석" POST 응답에 이 값이 바로 실려가 화면이 곧장 정확한 배지를 보여주지만, 개발자모드는
   *  확장(background.js의 runProfile)이 이 서버 라우트를 직접 호출하고 그 응답을 PTP 화면으로 전혀
   *  돌려주지 않는다 — 그래서 화면은 siteLockStatus 폴링으로 "도는 중"만 알 뿐 끝난 뒤엔 계속 예전
   *  selectSite 캐시-복원 상태(thisRunReportSource: null)에 머물러, 방금 막 성공한 분석도 "저장된 이전
   *  결과"로 잘못 보였다(사용자 지적, 2026-09-04). 이 필드를 DB에 남겨두면, 개발자모드가 완료 시점에
   *  사이트 정보를 다시 GET해 이 값을 그대로 읽어 일반모드와 같은 배지를 보여줄 수 있다. */
  lastRunReportSource?: 'ai' | 'heuristic' | 'ollama' | 'groq' | null
  /** lastRunReportSource와 같은 실행에서, "AI로 결제/배송/업체정보 분석 중..." 단계(gatherCategoryPageHints
   *  포함 ~ generateMallProfileReport/buildHeuristicMallReport 완료까지)가 실제로 걸린 시간(초) — 예전엔
   *  .dev-server.log에 console.log로만 남아 화면에서는 이 단계가 몇 초 걸렸는지 전혀 알 수 없었다(사용자
   *  요청, 2026-09-05). lastRunReportSource와 마찬가지로 DB에도 남겨 개발자모드가 나중에 GET으로 읽어갈
   *  수 있게 한다. */
  aiAnalysisElapsedSec?: number
  /** sampleMallProfile 전체(목록 페이지 확인 ~ AI 리포트까지 모든 단계)가 걸린 시간(초) — aiAnalysisElapsedSec는
   *  그중 마지막 AI 리포트 단계 하나만 잰 값이라, 화면에 그것만 보이면 "몰 구조분석 전체가 그만큼 걸렸다"로
   *  오해하기 쉽다(사용자 지적, 2026-09-09 — "몰구조분석에 소요된 시간이 7초란 말이야?": 실제로는 정렬
   *  옵션 확인만 152초, 전체 4.1분 걸렸는데 화면엔 AI 리포트 단계의 7초만 보였다). 개발자모드도 읽을 수
   *  있게 aiAnalysisElapsedSec와 같은 이유로 DB에 남긴다. */
  totalElapsedSec?: number
  /** sampleMallProfile의 각 단계(목록 페이지 확인/카테고리 구조 확인/카테고리 하위구조 확인/정렬 옵션
   *  확인/회사정보 확인/샘플 상품 확인/AI 분석 등, step() 호출 순서 그대로)가 각각 몇 초 걸렸는지 —
   *  totalElapsedSec·aiAnalysisElapsedSec 둘만으로는 "전체 시간 중 AI 아닌 나머지가 어디서 오래
   *  걸렸는지"를 알 수 없다(사용자 지적, 2026-09-26 — "AI뿐만이 아니라 전체적으로 어떤 내용으로 얼마나
   *  시간이 걸린 건지를 파악할 수 있게"). 화면 진행 표시(setSiteLockDetail)와 같은 라벨을 그대로 써서
   *  진행 중 봤던 단계 이름과 완료 후 소요시간 목록의 라벨이 항상 일치한다. totalElapsedSec와 같은
   *  이유로 DB에도 남긴다. */
  stepTimings?: { label: string; elapsedSec: number }[]
  /** deep 호출에서 첫 성공 샘플의 원문(product page innerText) — "몰 구조분석" 직후 자동으로
   *  추출규칙(runAutoAnalysis)을 생성할 때만 쓰고 DB에는 저장하지 않는다(applyProfileResult에서 제외).
   *  가벼운 구조변화감지(deep=false)에서는 항상 undefined. */
  sampleProductPageText?: string
  /** categoryLinks가 실제로 검증된 과거 카테고리(마이그레이션 확정 상품/사용자가 직접 확인한 카테고리
   *  URL)와 비교해 AI가 "터무니없다"고 판단했을 때만 채워진다 — lib/scrape/categoryAnomalyCheck.ts의
   *  checkCategoryAnomaly 참고(2026-08-29, 봇 차단 페이지 링크가 카테고리로 잘못 저장됐던 사고의
   *  재발 감지용 안전망). null이면 이상 없음(또는 비교할 기준선이 부족해 검사를 건너뜀). */
  categoryAnomalyWarning?: { reason: string; checkedAt: string; source: 'anthropic' | 'gemini' | 'ollama' } | null
  /** "화면으로 파악한 카테고리"와 "최종 저장된 카테고리"의 대조 결과 — 사용자 지시(2026-09-13):
   *  "화면을 통해 카테고리를 파악했으면, 마지막 결과가 그 화면의 카테고리와 맞는지, 안 맞는 건 어떤 건지
   *  왜 그런지 피드백을 줄 수 있게 해야 한다". 화면 인식이 실패했거나 그 경로를 안 탄 실행에서는
   *  undefined/null로 남는다(근거 없이 "누락"이라고 단정하지 않는다). */
  categoryScreenCheck?: CategoryScreenCheck | null
  /** deep(="몰 구조분석") 실행이 끝난 시점에 로그인 세션이 끊긴 것으로 보이면 true — "로그아웃 링크를
   *  못 찾음"(detectLoggedInSignal)이라는 약한 신호라 확정은 아니지만, 화면에서 이유도 모른 채 다음
   *  실행이 로그인 안 된 채로 도는 걸 막기 위해 최소한 경고는 보여준다(걸스굽 실사용 확인, 2026-09-01
   *  — 회원전용 상품 방문 이후 세션이 끊긴 채로 분석이 "성공"으로 끝나 사용자가 화면만 봐선 알 수
   *  없었다. 정확한 원인은 아직 미확정 — 그 상품 자체가 세션을 끊은 게 아니라, 4개 탭이 동시에 같은
   *  세션 쿠키로 요청하다 세션 토큰 회전 등으로 깨졌을 가능성이 있다). deep=false(구조 변화 감지)나
   *  이 검사 자체가 실패한 경우는 undefined — "확실히 문제 없음"이 아니라 "이번엔 확인 안 함"이라는
   *  뜻이라 false로 단정하지 않는다. DB에는 영구 저장하지 않는다(mallProfile.ts의 UPDATE 제외 목록
   *  참고) — 다음 실행의 세션 상태와 무관한, 이번 실행 한정 신호라 화면에 계속 남으면 오히려 헷갈린다. */
  sessionLostDuringAnalysis?: boolean
  /** sessionLostDuringAnalysis와 같은 검사(detectLoggedInSignal)가 false를 냈지만, 이 실행의 "시작
   *  시점"(로그인 시도 직후)에도 이미 같은 신호가 false였을 때 true — 즉 "분석 도중 끊긴 것"이 아니라
   *  이 몰이 애초에 로그인 여부를 화면 요소(로그아웃 문구/아이콘)로 전혀 드러내지 않는 몰이라는 뜻이다
   *  (정글북 실사용 확인, 2026-09-15 — 사용자 질문 "로그인이 끊겼다는 내용은 맞는거야?"로 재진단: 완전히
   *  로그인 안 한 새 브라우저로 접속해도 "로그인됨"을 알려주는 요소가 화면 어디에도 없어, 이 검사가
   *  로그인 성공 여부와 무관하게 항상 false만 내놓는 몰이었다). 이런 몰에서는 "다시 로그인해주세요"라는
   *  경고가 사실과 다를 수 있으므로, 화면에서 다른 문구(몰 특성 안내)로 구분해 보여준다. */
  loginSignalUnavailable?: boolean
  /** 카테고리/정렬 화면인식이 이번 실행에서 실제로 어느 공급자(Groq/Gemini/로컬 Ollama)로 성공했는지 —
   *  화면에서 "지금 뭘 쓰고 있는지 알 수 없다"는 지적으로 추가(사용자 지시, 2026-09-22).
   *  sessionLostDuringAnalysis와 같은 이유로 DB에는 영구 저장하지 않는다(mallProfile.ts의 UPDATE 제외
   *  목록 참고) — 다음 실행엔 Groq가 다시 살아날 수도 있는, 이번 실행 한정 신호라 화면에 계속 남으면
   *  오히려 헷갈린다. 성공한 화면인식이 하나도 없으면(전부 실패해 DOM/AI 텍스트 폴백으로만 처리됨) 빈 배열. */
  visionProviderLog?: VisionAttempt[]
  /** "몰 구조분석" AI 리포트(generateMallProfileReport)가 Anthropic→Gemini→Groq→Ollama 순으로 폴백하며
   *  이번 실행에서 실제로 시도한 각 공급자의 결과 — "AI 호출 실패"/"AI 분석 성공(이전 리포트 유지 중)"
   *  배지만 봐서는 어느 공급자가 왜(크레딧 부족/레이트리밋/타임아웃 등) 실패했는지 알 길이 없다는 지적
   *  (사용자 지시, 2026-09-23). visionProviderLog와 같은 이유로 DB에는 영구 저장하지 않는다(mallProfile.ts의
   *  UPDATE 제외 목록 참고) — 이번 실행 한정 신호. aiProviders를 전부 꺼둔 채 규칙 기반으로 바로 갔으면
   *  빈 배열. */
  aiReportAttempts?: AiReportAttempt[]
}

/** deep(="몰 구조분석") 끝에서 로그인 신호가 약하게(false) 나왔을 때, 이걸 "분석 도중 세션이 끊겼다"로
 *  볼지 "이 몰은 애초에 로그인 신호를 화면에 안 보여준다"로 볼지 가른다 — 순수 함수라 실제 브라우저 없이
 *  테스트로 규칙을 고정해둔다. 판단 근거는 세 가지 독립 신호:
 *  - hubExpansionHitLoginWall(카테고리 확장 중 실제로 로그인 페이지/차단을 만난 적 있음)은 "화면 요소가
 *    있냐 없냐"와 무관한 훨씬 강한 증거라 항상 'lost'로 본다.
 *  - loggedInAtEnd !== false(즉 true거나, 검사 자체가 실패해 null)면 애초에 이 판단을 부를 이유가
 *    없지만, 방어적으로 'ok'를 돌려준다.
 *  - loggedInAtStart(로그인 시도 직후, 분석을 시작하기도 전)가 이미 false였다면 — "분석 도중"에 뭔가
 *    끊어진 게 아니라 시작부터 신호가 없었던 것이므로 'unavailable'(몰 특성)로 본다. loggedInAtStart가
 *    true였는데 끝에 false가 됐을 때만 진짜 'lost'로 본다. */
export function classifySessionLossSignal(input: {
  loggedInAtStart: boolean | null
  loggedInAtEnd: boolean | null
  hubExpansionHitLoginWall: boolean
}): 'lost' | 'unavailable' | 'ok' {
  if (input.hubExpansionHitLoginWall) return 'lost'
  if (input.loggedInAtEnd !== false) return 'ok'
  return input.loggedInAtStart === false ? 'unavailable' : 'lost'
}

/** setSiteLockDetail로 진행 중 화면에 보여줄 공급자 이름 — components/panels/ScraperPanel.tsx의
 *  AI_PROVIDER_OPTIONS(모델명까지 적은 라벨)와 달리, 여기는 진행 상황 문구 한 줄에 짧게 끼워 넣을
 *  용도라 공급자 이름만 쓴다. */
const AI_REPORT_PROGRESS_LABEL: Record<AiProviderId, string> = { anthropic: 'Anthropic', gemini: 'Gemini', groq: 'Groq', ollama: '로컬(Ollama)' }

const MALL_PROFILE_SAMPLE_SIZE = 6
// "정렬 옵션 확인"(sampleMallProfile 내부, expandCategoryHubs 병행 처리 참고)이 상품 있는 카테고리를
// 몇 개까지 시도해볼지 — 예전 별도 단계 시절과 같은 상한(사용자 지시, 2026-08-23: "실지 상품이 있는
// 카테고리라면 반드시 정렬이 여기 있을 것", 상품이 있어도 정렬 UI 자체가 없는 카테고리가 있어 하나만
// 보고 끝내면 안 된다는 근거는 그대로 유효하다).
const MALL_PROFILE_SORT_CANDIDATE_LIMIT = 5
// 걸스굽 실사용 확인(2026-09-01) 중 동시성을 1로 낮춘 적이 있었다 — 탭을 2개 이상 동시에 열면(시차를
// 줘도) 로그인 세션이 끊기는 것처럼 보였기 때문. 하지만 그건 진짜 원인이 아니었다: 그 시점엔
// loginIfNeeded가 "몰 구조분석" 시작 시점에 홈페이지(로그인폼이 없는 일반 쇼핑몰 홈페이지)에서 호출되고
// 있어 재로그인 자체가 매번 조용히 스킵됐고(profileMallStructure의 loginIfNeeded 호출부 주석 참고), 그
// 상태로 뭘 시도하든(동시성을 낮추든 시차를 주든) 세션이 불안정해 보이는 게 당연했다. 실제 로그인 페이지
// (site.loginUrl)에서 로그인을 제대로 시도하고 신원 쿠키(login_provider_1/ec_mem_level)까지 확인하고
// 넘어가도록 고친 뒤에는(2026-09-02), 동시성 4로 반복 실행해도 로그인 세션이 끊기지 않는 것을 직접
// 확인했다 — 원래 기본값(4)으로 되돌린다.
//
// 이미지/폰트/미디어 요청을 page.route()로 막아 방문 하나하나를 가볍게 만들어보려 했는데(2026-09-01),
// 실측해보니 오히려 역효과였다 — "샘플 상품 6건" 단계가 차단 전 46~91초였던 게 차단 후 183초로
// 늘었다. Playwright의 route 가로채기 자체가 요청마다 Node 프로세스로 왕복하는 오버헤드가 있어서,
// 이 몰처럼 이미지 자체는 그리 안 무거운데 요청 수가 많은 페이지에서는 "그냥 받는 것"보다 "매번
// 가로채서 막을지 결정하는 것"이 더 비쌌던 것으로 보인다. 시도했다가 되돌린 기록으로 남겨둔다 —
// 다른 몰/상황에서 다시 시도할 땐 반드시 이 방식으로 전후 실측부터 하고 판단할 것.
const MALL_PROFILE_CONCURRENCY = 4

/** context.newPage()로 워커 페이지 여러 개를 열어 items를 동시에 처리한다 — 몰 구조분석의 샘플 상품
 *  방문/정보페이지 수집처럼 서로 독립적인 소수 항목을 순차 방문하던 걸 병렬화하는 데 공용으로 쓴다
 *  (discoverCategoryLinks의 expandWorker와 같은 커서 기반 워커풀 패턴, 2026-08-22). 첫 워커는 새 탭을
 *  열지 않고 넘겨받은 page를 그대로 재사용한다. worker 콜백 안에서 개별 항목 실패는 알아서 처리해야
 *  한다(여기서 예외를 삼키지 않음 — 한 항목의 실패로 전체가 죽으면 안 되는 호출부가 각자 try/catch). */
async function mapWithPageWorkers<T>(
  context: BrowserContext, page: Page, items: T[], concurrency: number,
  worker: (item: T, index: number, page: Page) => Promise<void>,
  /** "몰 구조분석 중지"가 눌리면(2026-08-22) 아직 안 잡은 항목은 더 처리하지 않는다 — 이미 시작한
   *  worker(item)은 그대로 끝까지 두되(중간에 끊으면 그 항목의 반쪽짜리 결과가 signals에 섞일 수 있음),
   *  다음 커서만 멈춘다. */
  signal?: AbortSignal,
): Promise<void> {
  if (!items.length) return
  const n = Math.min(concurrency, items.length)
  let cursor = 0
  async function runWorker(workerPage: Page): Promise<void> {
    while (true) {
      if (signal?.aborted) return
      const i = cursor++
      if (i >= items.length) return
      // expandCategoryHubs의 같은 이름 가드와 같은 이유(2026-09-01, 걸스굽 실사용 확인) — 동시성이
      // 1로 강제된 호출에서는 순차라도 요청 사이 간격이 없으면 여전히 세션이 끊겼다. 기본 동시성(4)로
      // 도는 다른 호출부에는 얹지 않는다.
      if (n === 1 && i > 0) await sleep(3_000)
      await worker(items[i], i, workerPage)
    }
  }
  const extraPages: Page[] = []
  try {
    // 새 탭을 한꺼번에 다 만들어두지 않고 필요한 시점에 하나씩 만든다 — 첫 워커(공유 page)는 바로 일을
    // 시작하고, 그 뒤로는 워커가 필요해질 때마다 탭을 추가한다(2026-09-01 리팩터 — 예전엔 Promise.all로
    // 한꺼번에 다 열었는데, MALL_PROFILE_CONCURRENCY가 1로 낮아진 지금은 n=1이라 추가 탭 자체가 안
    // 만들어지므로 이 구조가 자연스럽게 맞다. concurrency를 다시 올려 쓰는 다른 호출부에도 그대로 안전).
    const workerPromises: Promise<void>[] = [runWorker(page)]
    for (let idx = 1; idx < n; idx++) {
      const p = await context.newPage()
      extraPages.push(p)
      workerPromises.push(runWorker(p))
    }
    await Promise.all(workerPromises)
  } finally {
    await Promise.all(extraPages.map(p => p.close().catch(() => {})))
  }
}

/** page.goto(url)는 Playwright가 CDP로 직접 페이지 이동을 명령하는 방식이라, 크롬이 이걸 "이 문서 안의
 *  링크를 클릭해서 들어온" 진짜 같은 출처 이동이 아니라 "출처 없는 이동"(Sec-Fetch-Site: none)으로
 *  분류한다 — referer 옵션을 줘도 이 값은 안 바뀐다(Referer 헤더와 Sec-Fetch-Site는 크롬이 내부적으로
 *  따로 계산). Sec-Fetch-Site로 봇을 가려내는 몰(걸스굽 등)에서는 로그인된 세션이라도 이 헤더 하나
 *  때문에 신원 쿠키(예: 카페24의 login_provider_1)가 지워지고 로그인 페이지로 튕긴다(2026-09-02
 *  실사용 확인 — 사람이 실제로 링크를 클릭하면 Sec-Fetch-Site: same-origin으로 오고 문제없음을
 *  개발자도구 Network 탭에서 직접 비교해 확정했다).
 *
 *  이 문서 안에 실제 `<a>` 태그를 하나 만들어 그 네이티브 click()을 호출하면, 크롬은 이걸 "이 문서
 *  안의 링크를 클릭한" 진짜 같은 출처 이동으로 분류해 Sec-Fetch-Site: same-origin을 보낸다 — 카테고리
 *  하위구조 확인/샘플 상품 확인처럼 "몰 구조분석"이 로그인 세션 위에서 여러 페이지를 순회하는 곳은
 *  전부 page.goto() 대신 이 함수를 쓴다. 링크가 없는 페이지(about:blank 등)에서는 클릭할 문서 자체가
 *  없어 실패할 수 있어 page.goto()로 폴백한다. */
async function gotoViaLinkClick(
  page: Page, url: string, opts: { waitUntil?: 'load' | 'domcontentloaded'; timeout?: number } = {},
): Promise<void> {
  const { waitUntil = 'load', timeout = 20_000 } = opts
  if (page.url() === 'about:blank') {
    await page.goto(url, { waitUntil, timeout })
    return
  }
  const navigated = page.waitForNavigation({ waitUntil, timeout }).catch(() => null)
  const clicked = await page.evaluate((href) => {
    const a = document.createElement('a')
    a.href = href
    a.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0'
    document.body.appendChild(a)
    a.click()
    a.remove()
  }, url).then(() => true).catch(() => false)
  if (!clicked) {
    await page.goto(url, { waitUntil, timeout }).catch(() => {})
    return
  }
  await navigated
}

/**
 * 로그인 확인 시점에 몰 내 여러 상품을 훑어 이 몰의 상품페이지 구조적 특성을 파악한다 — 대표/상세이미지
 * 유무, 옵션 UI 형태(select/swatch)와 색상→사이즈 같은 연쇄옵션 여부, 재고 표기 방식(전체 수량/상태문구/
 * "자세히" 클릭형 옵션별 재고), 상세페이지 텍스트 유무, 상품정보고시 표에 실제로 어떤 라벨들이 있는지까지.
 * 새 몰을 처음 스크랩하기 전에 그 몰 상품마다 달라질 수 있는 부분을 미리 다 찾아두기 위한 것으로, 이후
 * 실제 스크랩 코드가 무엇을 놓치고 있는지 새 라벨/구조가 나올 때마다 알 수 있게 한다(사용자 보고에 의존하지
 * 않고 매번 스스로 다시 점검). withContext로 브라우저 컨텍스트를 얻으므로 로그인 창이 열려있으면 그 창을
 * 그대로 재사용하고, 없으면(개발자모드 포함) withContext가 몰 유형에 맞게 새로 연다 — 직접로그인 필수
 * 몰은 이미 신뢰가 쌓인 사용자의 개인 크롬 프로필 사본을 헤드리스로 재사용한다(withContext 주석 참고).
 * 항상 이 몰에 등록된 정식 시작 URL(sites.url)로 먼저 이동한 뒤 그 페이지를 목록으로 간주해 상품 몇 개를
 * 샘플링한다 — 로그인 창을 재사용하는 경우 사용자가 마이페이지 등 다른 화면을 보고 있어도 엉뚱한 페이지가
 * 기준이 되지 않도록 하기 위함(실사용 중 마이페이지가 기준이 돼 platform 오감지→카테고리/상품 스캔이
 * 전부 틀어지는 문제가 실제 발견됨). sites.url이 없으면 그냥 실패로 본다(null). 실패해도 전체 로그인
 * 확인 흐름을 막지 않도록 호출부에서 백그라운드로 실행한다.
 *
 * deep(기본 false)는 "몰 구조분석" 버튼 전용 — true면 하단 회사정보/이용안내·공지 게시판까지 훑어
 * 결제계좌·택배사·연락처 등을 AI로 분석하는 무거운 작업까지 추가로 한다(MallProfileSignals.report).
 * 로그인 확인/스크랩 시작마다 자동으로 도는 가벼운 구조 변화 감지(false)와는 용도가 다르다 — 사용자가
 * 직접 "이 둘은 서로 다른 용도"라고 확정함: 로그인 확인=구조 변화 감지 전용, 몰 구조분석=거래정보 분석 전용.
 */
// "몰 구조분석 중지" 버튼용 — siteId별로 지금 진행 중인 분석의 AbortController를 들고 있는다. 다른
// 인메모리 상태(siteLocks 등)와 같은 이유로 globalThis에 저장해 dev 서버 핫리로드에도 살아남게 한다
// (2026-08-22, 사용자 요청: "중지를 누르면 llama-server 작업도 멈추게"). withSiteLock이 이미 siteId당
// 분석 하나만 동시에 돌게 보장하므로, 슬롯 하나(Map)로 충분하다.
const profileAbortControllers: Map<number, AbortController> =
  globalThis.__scrapeProfileAbortControllers ?? (globalThis.__scrapeProfileAbortControllers = new Map())

/** PTP의 "몰 구조분석 중지" 버튼이 호출한다 — 지금 그 몰에 대해 진행 중인 profileMallStructure가
 *  있으면 즉시 신호를 보낸다(Ollama 호출 중이면 그 fetch가 바로 끊겨 llama-server도 생성을 멈춘다).
 *  진행 중인 게 없으면 조용히 아무 일도 안 한다(이미 끝났거나 애초에 시작 안 한 경우). */
export function stopProfileAnalysis(siteId: number): boolean {
  const controller = profileAbortControllers.get(siteId)
  if (!controller) return false
  controller.abort()
  profileAbortControllers.delete(siteId)
  return true
}

/**
 * 사용자가 화면에서 체크한 AI 공급자를 이 실행 "전체"의 컨텍스트로 고정하는 지점 — 아래에서 파생되는
 * 모든 비동기 호출(화면인식 3종, 카테고리 링크 판별, 허브 확장 폴백, 리포트 생성)이 각자 인자를 받지
 * 않고도 같은 선택을 따른다. 예전엔 이 선택을 호출 체인마다 인자로 넘겨야 했고, 넘기는 걸 빠뜨린 경로가
 * 조용히 체크 해제된 공급자를 계속 부르는 사고가 네 번 났다(lib/aiProviderGate.ts 주석 참고).
 */
export async function profileMallStructure(siteId: number, deep = false, aiProviders: AiProviderId[] = ALL_AI_PROVIDERS): Promise<MallProfileSignals | null> {
  return runWithAiProviders(aiProviders, () => profileMallStructureInner(siteId, deep, aiProviders))
}

async function profileMallStructureInner(siteId: number, deep: boolean, aiProviders: AiProviderId[]): Promise<MallProfileSignals | null> {
  const site = await siteInfo(siteId)
  if (!site.url) return null
  const { pattern: categoryUrlPattern, manualSamples: knownCategoryExamples, prevSortOptions, prevCategoryLinks } = await getCategoryMemory(siteId)
  const controller = new AbortController()
  profileAbortControllers.set(siteId, controller)
  // withContext가 이미 siteId 기준 락(withSiteLock)을 쥐므로 여기서 따로 또 걸지 않는다 — 같은 키로
  // 이중으로 걸면 바깥 락이 안 풀린 채로 안쪽 락이 그 락을 기다려 영원히 멈춘다(데드락).
  // allowStaleManualLoginProfile: 개발자모드는 사용자가 실제 크롬을 켜둔 채로 쓰는 게 정상 상태라, 그
  // 크롬의 쿠키/세션 파일이 잠긴 채로 복사돼도(robocopy 일부 실패) 이 가벼운 확인은 그냥 진행한다 — 매번
  // "크롬을 꺼주세요"로 막으면 개발자모드에서는 사실상 이 버튼이 항상 실패한다(2026-08-15 실사용 확인).
  try {
    return await withContext({ siteId, url: site.url, allowStaleManualLoginProfile: true }, async (page, context) => {
      await page.goto(site.url, { waitUntil: 'load', timeout: 20_000 }).catch(() => {})
      // 아래 "신원 쿠키" 대기는 카페24 전용 쿠키 이름(login_provider_1/ec_mem_level)을 찾는다 — 플랫폼과
      // 무관하게 항상 돌고 있었다(정글북 실사용 확인, 2026-09-15, 사용자 질문 "로그인이 끊겼다는 내용은
      // 맞는거야?"로 재진단: 정글북은 카페24가 아닌 커스텀 React 몰이라 이 쿠키 자체가 존재할 수 없는데도
      // 매번 30초를 꽉 채워 기다리다 "신원쿠키를 30초 안에 못 받음"을 내고, 필요 없는 재로그인까지
      // 시도했다). 이 몰이 실제로 카페24인지 미리 확인해, 그 경우에만 이 카페24 전용 대기를 돈다.
      const platformForLoginWait = await detectMallPlatform(page).catch(() => 'unknown' as MallPlatform)
      // 회원전용 도매몰(펫투비 등)은 저장된 로그인 세션이 만료돼 있으면 카테고리 목록/정렬 위젯이 있는
      // 페이지가 전부 로그인폼으로 리다이렉트된다 — sortOptions가 매번 빈 배열로 나온 실제 원인이 "AI가
      // 텍스트를 못 알아본 것"이 아니라 "정렬 링크 후보 자체가 0개"였음을 실사용(2026-08-23, 펫투비)으로
      // 확인했다. 실제 스크래핑(scrapeSingleProduct 등)은 loginIfNeeded로 이 상황을 직접 복구하는데,
      // 이 함수는 여태 그 단계가 없이 withContext가 재사용하는 쿠키에만 의존했다 — deep(="몰 구조분석"
      // 버튼)에서만 저장된 아이디/비번으로 로그인을 시도한다(구조 변화 감지는 스크랩 시작 직전 매번 자동으로
      // 도는 가벼운 체크라 범위를 넓히지 않음). 로그인 시도 후 원래 시작 URL로 다시 이동하는 것도
      // scrapeSingleProduct와 같은 이유 — 로그인 성공 페이지가 잠깐 뜬 뒤 지연 리다이렉트되는 몰이 있어,
      // 그 흐름이 끝난 뒤 항상 같은 시작점에서 프로파일링을 시작하게 한다.
      //
      // loginIfNeeded는 "지금 이 페이지에 로그인폼이 보이는가"만으로 로그인 필요 여부를 판단한다(펫투비
      // 같은 회원전용 몰은 홈페이지 자체가 로그인 안 되면 폼으로 리다이렉트되므로 이게 맞다). 하지만
      // 걸스굽처럼 홈페이지가 회원전용이 아닌 일반 쇼핑몰은 로그아웃 상태에서도 홈페이지엔 애초에 로그인폼이
      // 없어서, 이 페이지(site.url)를 그대로 두고 부르면 매번 "폼이 안 보이니 이미 로그인된 상태"로 오판해
      // 실제로 만료된 세션(신원 쿠키 login_provider_1/ec_mem_level이 이미 빠진 상태)을 절대 갱신하지
      // 못했다 — 개발자도구가 아니라 서버 쪽에서 직접 쿠키/헤더를 캡처해 확인(2026-09-02: loginIfNeeded가
      // "로그인폼보임=false"로 매번 조기 반환, 신원 쿠키는 이 함수 호출 전부터 이미 없었음). site.loginUrl
      // (사용자가 "몰 설정"에 등록해둔 실제 로그인 페이지, 없으면 site.url로 폴백)로 먼저 이동해야
      // 로그아웃 상태에서 폼이 실제로 나타난다.
      if (deep && site.loginId && site.loginPw) {
        await page.goto(site.loginUrl || site.url, { waitUntil: 'load', timeout: 20_000 }).catch(() => {})
        await loginIfNeeded(page, { url: site.loginUrl || site.url, loginId: site.loginId, loginPw: site.loginPw }).catch(() => {})
        await page.goto(site.url, { waitUntil: 'load', timeout: 20_000 }).catch(() => {})
      }
      // 'load' 이벤트는 초기 페이지 렌더링만 보장하지, 로그인 직후 몰이 자바스크립트로 비동기 발급하는
      // "진짜 신원 확인" 쿠키(예: 카페24의 login_provider_1/ec_mem_level — 회원ID/등급을 담고 있음)까지는
      // 기다려주지 않는다. 세션 쿠키(ECSESSID)는 있는데 이 쿠키들이 아직 안 만들어진 채로 곧장 카테고리를
      // 순회하면, 서버가 "로그인은 됐지만 신원이 아직 안 채워짐"으로 보고 로그인 페이지로 돌려보낸다
      // (걸스굽 실사용 확인, 2026-09-01 — 사람이 메뉴를 클릭해 들어간 요청엔 이 쿠키들이 있고, 자동화가
      // 곧장 이동한 요청엔 없었다. 개발자도구 Network 탭으로 두 요청의 쿠키 목록을 직접 비교해 확정).
      // networkidle까지 무한정 기다리면 채팅위젯/분석 스크립트의 지속 연결 때문에 타임아웃까지 다 채우는
      // 몰이 많아(loginIfNeeded 주석 참고) 몇 초로 짧게 제한한다 — 못 끝나도 그냥 진행한다.
      if (deep) {
        await page.waitForLoadState('networkidle', { timeout: 3_000 }).catch(() => {})
      }
      // networkidle 대기만으로는 부족하다는 게 실측으로 확인됐다(2026-09-02) — 위 loginIfNeeded를 실제
      // 로그인 페이지(site.loginUrl)에서 부르도록 고친 뒤에도, networkidle 직후 시점엔 이 신원 쿠키가
      // 아직 없는 채로 카테고리 확장이 시작돼(context.cookies() 직접 확인) 회원전용 카테고리에서 로그인
      // 페이지로 튕겨나가고, 그 상태로 계속 진행하다 결국 완전히 로그아웃되는 사고까지 실제로 재현됐다.
      // 그냥 가만히 기다리기만 하면 안 된다는 것도 실측으로 확인됐다: 이 쿠키를 발급하는 카페24 쪽
      // 비동기 스크립트가 매번 도는 게 아니라 페이지가 새로 로드될 때만 도는 것으로 보여, 같은 페이지에서
      // 8초를 그냥 흘려보내도 못 받는 경우가 절반 가까이 됐다(반복 실행 로그: 3ms만에 받은 경우와 8초
      // 내내 못 받은 경우가 반반으로 갈림) — 그 스크립트가 다시 돌 기회를 주기 위해 주기적으로
      // 새로고침하면서 기다린다. 15초+새로고침만으로도 10번 중 1번꼴로 여전히 시간 안에 못 받는 게
      // 실측 확인돼(2026-09-02), 단순 새로고침보다 강한 회복 수단으로 로그인 자체를 한 번 더 재시도한다
      // — 새로고침은 "이미 로그인된 페이지가 비동기 스크립트를 다시 돌게" 하는 것뿐이라 애초에 로그인 자체가
      // 덜 된 경우엔 도움이 안 될 수 있어서다.
      if (deep && site.loginId && site.loginPw && platformForLoginWait === 'cafe24') {
        const cookieWaitStart = Date.now()
        const cookieDeadline = cookieWaitStart + 30_000
        let gotIdCookie = false
        let lastReloadAt = Date.now()
        let reloginAttempted = false
        while (Date.now() < cookieDeadline) {
          const idCookies = await context.cookies()
          if (idCookies.some(c => c.name === 'login_provider_1' || c.name === 'ec_mem_level')) { gotIdCookie = true; break }
          if (!reloginAttempted && Date.now() - cookieWaitStart >= 15_000) {
            reloginAttempted = true
            await page.goto(site.loginUrl || site.url, { waitUntil: 'load', timeout: 20_000 }).catch(() => {})
            await loginIfNeeded(page, { url: site.loginUrl || site.url, loginId: site.loginId, loginPw: site.loginPw }).catch(() => {})
            await page.goto(site.url, { waitUntil: 'load', timeout: 20_000 }).catch(() => {})
            lastReloadAt = Date.now()
          } else if (Date.now() - lastReloadAt >= 4_000) {
            await page.reload({ waitUntil: 'load', timeout: 10_000 }).catch(() => {})
            lastReloadAt = Date.now()
          }
          await sleep(200)
        }
        if (!gotIdCookie) console.log(`[몰구조분석:${site.name}] 로그인 신원쿠키를 30초 안에 못 받음(재로그인 1회 포함) — 카테고리 확장이 로그인 안 된 상태로 진행될 수 있음`)
      }
      const startUrl = page.url()
      if (!startUrl || startUrl === 'about:blank') return null
      // classifySessionLossSignal의 기준선 — 로그인 시도가 끝난 직후, 분석을 시작하기도 전의 신호.
      // deep이 아니거나 로그인 정보가 없으면 애초에 로그인을 시도하지 않았으니 null(판단 보류).
      const loggedInAtStart = (deep && site.loginId && site.loginPw) ? await detectLoggedInSignal(page) : null
      return sampleMallProfile(page, context, startUrl, site.name, deep, controller.signal, siteId, aiProviders, categoryUrlPattern, knownCategoryExamples, prevSortOptions, prevCategoryLinks, loggedInAtStart)
    }, deep ? '몰 구조분석' : '구조 변화 감지')
  } finally {
    // 이 실행이 등록해둔 컨트롤러가 그대로면(중간에 stopProfileAnalysis가 이미 지웠을 수도 있음) 지운다.
    if (profileAbortControllers.get(siteId) === controller) profileAbortControllers.delete(siteId)
  }
}

async function siteInfo(siteId: number): Promise<{ name: string; url: string; loginUrl: string; loginId: string; loginPw: string }> {
  const res = await pool.query<{ name: string; url: string; login_url: string | null; login_id: string | null; login_pw_encrypted: string | null; login_pw_iv: string | null }>(
    'SELECT name, url, login_url, login_id, login_pw_encrypted, login_pw_iv FROM sites WHERE id = $1', [siteId],
  )
  const row = res.rows[0]
  return {
    name: row?.name || `site${siteId}`,
    url: row?.url || '',
    loginUrl: row?.login_url || '',
    loginId: row?.login_id || '',
    loginPw: decryptSecret(row?.login_pw_encrypted ?? null, row?.login_pw_iv ?? null),
  }
}

/** 로그인 세션이 끊긴 것으로 보이는 순간(로그인 페이지로 리다이렉트됨 등) 저장된 아이디/비밀번호로
 *  재로그인을 시도한다 — "몰 구조분석"의 여러 단계(카테고리 하위구조 확인/정렬 옵션 확인/샘플 상품 확인)가
 *  공유한다(사용자 지시, 2026-09-15: "로그인 세션이 끊기면 기존 로그인 정보로 재로그인하고 로그아웃
 *  이후의 작업을 재진행" — 뒤이어 "방법이 없다는거야?"라고 재확인해, 특정 단계 하나만이 아니라 세션이
 *  어느 단계에서 끊기든 그 자리에서 복구하는 것을 목표로 모든 단계에 적용한다). siteId가 없거나 등록된
 *  로그인 정보가 없으면(직접로그인 필수 몰 등) 시도 자체를 못 하므로 false. */
async function recoverSessionLogin(page: Page, siteId: number | undefined, mallName: string, stepLabel: string): Promise<boolean> {
  if (siteId == null) return false
  const site = await siteInfo(siteId).catch(() => null)
  if (!site?.loginId || !site?.loginPw) return false
  const loginTarget = site.loginUrl || site.url
  if (!loginTarget) return false
  console.log(`[${stepLabel}:${mallName}] 로그인 세션이 끊긴 것으로 보여 저장된 로그인 정보로 재로그인을 시도합니다`)
  await page.goto(loginTarget, { waitUntil: 'load', timeout: 20_000 }).catch(() => {})
  const submitted = await loginIfNeeded(page, { url: loginTarget, loginId: site.loginId, loginPw: site.loginPw }).catch(() => false)
  if (submitted) await page.waitForLoadState('networkidle', { timeout: 3_000 }).catch(() => {})
  const recovered = await detectLoggedInSignal(page)
  console.log(`[${stepLabel}:${mallName}] 재로그인 ${recovered === false ? '실패' : '완료'}`)
  return recovered !== false
}

/** discoverTopLevelCategoryLinks가 "기억"으로 쓸 재료를 scrape_profile에서 읽어온다 — categoryUrlPattern은
 *  이전 탐지(규칙 기반이든 AI든)가 역산해둔 URL 패턴, manualCategorySamples는 사용자가 "카테고리 선택
 *  가져오기"로 직접 확인해 모은 URL이다(사용자 요청, 2026-08-26). 후자는 그 자체로 AI 프롬프트의 근거
 *  예시로도 쓰이므로 둘 다 같이 반환한다.
 *  prevSortOptions는 별도 용도 — sampleMallProfile이 리포트("정렬 구조" 필드)를 만들 때 이번 실행에서
 *  새로 감지한 정렬 옵션이 하필 비어있으면(카테고리 5개가 하필 전부 정렬 위젯 없는 페이지였던 경우 등)
 *  이 값으로 대신 채운다. applyProfileResult의 sortOptions 복원 가드(비어있으면 이전 값 유지)는 최종
 *  signals에는 적용되지만, 그건 report를 이미 다 만든 "뒤"에 일어나는 일이라 report.sortStructure는
 *  그 보호를 못 받고 계속 "확인 안됨"으로 남는 문제가 있었다(걸스굽 실사용 확인, 2026-09-02 — sortOptions
 *  자체는 정상 복원되는데 report.sortStructure만 몇 주째 비어있었음). report를 만들기 "전"에 같은
 *  안전장치를 걸어야 해서 여기서 미리 읽어온다. */
export async function getCategoryMemory(siteId: number): Promise<{ pattern: string | null; manualSamples: string[]; prevSortOptions: MallSortOption[]; prevCategoryLinks: CategoryMenuLink[] }> {
  const res = await pool.query<{ scrape_profile: { categoryUrlPattern?: string | null; manualCategorySamples?: string[]; sortOptions?: MallSortOption[]; categoryLinks?: CategoryMenuLink[] } | null }>(
    'SELECT scrape_profile FROM sites WHERE id = $1', [siteId],
  )
  const profile = res.rows[0]?.scrape_profile
  return {
    pattern: profile?.categoryUrlPattern || null, manualSamples: profile?.manualCategorySamples || [],
    prevSortOptions: profile?.sortOptions || [],
    // 직전 실행에서 확인된 카테고리 — screenCheckAndRecover가 '이번에 사라진 것'을 가려내는 기준선으로 쓴다.
    prevCategoryLinks: profile?.categoryLinks || [],
  }
}

// manualCategorySamples는 AI 프롬프트 근거/패턴 역산 재료로만 쓰는 참고용이라, 몰 하나에 카테고리를
// 수십~수백 개씩 수동으로 모아도 무한정 쌓아둘 필요가 없다 — 패턴 역산에는 몇 개만 있어도 충분하고
// (deriveCategoryUrlPattern은 과반수 일치만 보면 됨), 너무 많으면 scrape_profile JSONB만 불필요하게
// 커진다.
const MANUAL_CATEGORY_SAMPLE_CAP = 20

/** "몰 카테고리 선택 가져오기(반복)"로 사용자가 카테고리를 직접 확인해 가져올 때마다 호출된다 — 그
 *  URL을 scrape_profile.manualCategorySamples에 쌓고, 쌓인 샘플로 categoryUrlPattern을 다시 역산해
 *  갱신한다. 이렇게 하면 사용자가 수동으로 확인한 카테고리가 다음번 자동 탐지(규칙 기반의
 *  scanByKnownUrlPattern, AI의 근거 예시) 양쪽 모두에 그대로 참고된다(사용자 요청, 2026-08-26: "수동
 *  선택 작업한 내용을 참고하여서... 룰 방식이건 AI가 참고해서 분석이 가능하도록"). */
export async function recordManualCategorySample(siteId: number, url: string): Promise<void> {
  const { pattern: prevPattern, manualSamples } = await getCategoryMemory(siteId)
  if (manualSamples.includes(url)) return
  const nextSamples = [...manualSamples, url].slice(-MANUAL_CATEGORY_SAMPLE_CAP)
  // 샘플이 아직 하나뿐이거나(패턴 역산엔 최소 2개 필요) 우연히 서로 다른 쿼리파라미터를 써서 역산에
  // 실패해도, 이미 알던 패턴(다른 경로로 확인됐을 수 있음)을 지우지 않는다.
  const pattern = deriveCategoryUrlPattern(nextSamples) ?? prevPattern
  await pool.query(
    `UPDATE sites SET
       scrape_profile = COALESCE(scrape_profile, '{}'::jsonb)
         || jsonb_build_object('manualCategorySamples', $1::jsonb, 'categoryUrlPattern', $2::jsonb),
       scrape_profile_updated_at = NOW()
     WHERE id=$3`,
    [JSON.stringify(nextSamples), JSON.stringify(pattern), siteId],
  )
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
    const page = resolveMainPage(context, siteId) ?? await context.newPage()
    setMainPage(siteId, page)

    // 미리보기 상품 페이지로 "이동"할 뿐, 새 탭을 열지 않는다 — 예전엔 호출부가 별도로 새 탭을 먼저 열고
    // (openUrlInLoginWindow) 그 다음 여기서 다시 "마지막 탭"을 골랐는데, "스크랩 대상 직접지정"을 다시
    // 누를 때마다(예: PTP 화면을 벗어났다 돌아와 다시 누른 경우) 매번 탭이 하나씩 더 쌓였다. 예전 탭에
    // 남아있던 피커가 안 닫힌 채로 방치되면, 그 탭은 계속 예전 시점의 코드로 저장을 시도해 최신 탭의
    // 저장과 서로 경쟁하며 값이 사라지는 것처럼 보일 수 있었다(신우 몰 재발 보고). 같은 컨텍스트의 다른
    // 탭에 아직 살아있는 피커가 있으면 먼저 정리하고, 이 탭 하나만 활성 상태로 유지한다.
    for (const other of context.pages()) {
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
      // "✕(규칙 지우기)"용 — ptpSavePick(병합)과 달리 jsonb `-`(키 제거) 연산자로 이 필드의 규칙 자체를
      // 완전히 없애 자동/AI 추출이 다시 채울 수 있게 한다(deleteField 참고).
      await page.exposeFunction('ptpDeleteField', async (field: string) => {
        if (!field?.trim()) return
        await pool.query(`UPDATE sites SET extraction_rules = extraction_rules - $1::text WHERE id=$2`, [field, siteId])
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

/**
 * "스크랩 대상 직접지정"으로 규칙을 저장한 직후 PTP 화면의 미리보기 그리드에 그 결과를 바로 보여주기
 * 위해 상품 1건만 가볍게 다시 추출한다 — previewCatalog 안의 extractPreview와 같은 추출 단계(규칙 기반
 * 추출 → DOM 옵션 → 재고)를 쓰지만, 그 함수가 항상 먼저 하는 카테고리 개수 집계·부트스트랩·AI모드는
 * 전부 건너뛴다(사용자 요청, 2026-09-12 — "직접지정에서 새로 컬럼을 만든 것은 미리보기 그리드에 표시되어야
 * 하는 거 아니야?" — 카테고리가 몇백 개인 몰에서 그 무거운 전체 미리보기를 매번 다시 돌리는 건 이 목적엔
 * 안 맞다). "스크랩 대상 직접지정"이 조작하는 바로 그 탭(resolveMainPage — openUrlInLoginWindow/
 * startElementPicker와 같은 추적)을 그대로 재사용해 새 탭을 안 띄운다.
 *
 * openUrlInLoginWindow의 "이미 열린 세션" 분기와 같은 이유로 락을 안 건다 — 이 몰에서 다른 무거운 작업
 * (몰 구조분석 등)이 진행 중이어도, 픽커로 방금 지정한 값을 확인하려는 이 가벼운 새로고침이 그 작업이
 * 끝날 때까지(몇 분~몇십 분) 기다릴 이유는 없다. 세션 자체가 없으면(로그인 창이 없음) null.
 */
export async function reExtractPreviewProduct(siteId: number, url: string): Promise<ScrapeResult | null> {
  const context = openSessions.get(siteId)
  if (!context) return null
  const page = resolveMainPage(context, siteId) ?? await context.newPage()
  setMainPage(siteId, page)
  if (page.url() !== url) {
    await page.goto(url, { waitUntil: 'load', timeout: 30_000 }).catch(() => {})
  }
  await waitForExtractableContent(page).catch(() => {})
  const res = await pool.query<{ extraction_rules: Record<string, ExtractionRule> | null }>(
    'SELECT extraction_rules FROM sites WHERE id=$1', [siteId],
  )
  const extractionRules = res.rows[0]?.extraction_rules ?? undefined
  const product = await extractProductRuleBased(page, url, undefined, extractionRules)
  const domOptions = await extractOptionsFromDom(page).catch(() => ({ options: [], combinations: [] }))
  if (domOptions.options.length) product.options = domOptions.options
  if (domOptions.combinations.length) product.option_combinations = domOptions.combinations
  await applyStockByOption(page, product).catch(() => {})
  return { sourceUrl: url, product }
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
    ptpDeleteField: (field: string) => Promise<void>
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
  // "새 컬럼 만들기"의 컬럼명 자체를 화면 클릭으로 채우는 모드 — true면 다음 클릭의 텍스트가 값이 아니라
  // #ptp-new-field-name 입력칸에 그대로 들어간다. 수량 조건별로 공급가가 여러 개인 몰(예: 수입가/도매
  // 할인가/도매가/소매가처럼 조건별 가격표)에서, 조건 라벨("도매가 (29개 이상)" 등)을 매번 손으로 타이핑
  // 하지 않고 그 라벨 셀을 그대로 클릭해 컬럼명으로 쓸 수 있게 한다(사용자 요청, 2026-09-12 — 오펠트
  // 사례: 기존엔 컬럼 "값"만 클릭 지정이 가능하고 컬럼"명"은 항상 손으로 입력해야 했다). armedField(기존
  // 필드의 값 지정)와는 동시에 켤 수 없다 — 서로 배타적으로 둔다.
  let armingNewFieldName = false
  // "새 컬럼 만들기" 입력칸 두 개(컬럼명/값)에 지금까지 타이핑되거나 클릭으로 채워진 내용 — renderFieldList가
  // 다른 필드 지정(다른 줄의 🎯 클릭해서 지정하기 등)으로 다시 그려질 때마다 innerHTML을 통째로 새로 만들어
  // 이 두 입력칸의 DOM 값이 그냥 사라지는 문제가 있었다(라이브 DOM엔 남아있던 값이 재렌더 순간 날아감).
  // 이 값을 별도로 기억해뒀다가 매번 템플릿의 value로 되돌려 넣어 재렌더에도 살아남게 한다.
  let newFieldNameDraft = ''
  let newFieldValueDraft = ''
  // 방금 지정한(클릭했거나 직접 입력한) "실제 값" — 규칙 자체(라벨/셀렉터 패턴)와 달리 화면에 곧바로
  // 보여줄 목적으로만 쓴다. 지정하는 순간 그 자리에서 확인할 수 있어야 한다는 요청으로 추가.
  const lastValueLocal: Record<string, string> = {}
  // 기존 필드 줄에도 "새 컬럼 만들기"와 완전히 같은 [컬럼명 칸+지정 버튼] 줄을 추가한다(사용자 지시,
  // 2026-09-17 — "컬럼과 값 두개를 지정할 수 있게 하라니까... 옵션1 -> 이걸 지정할 수 있게 하란 말이야").
  // 기본값은 지금 라벨("옵션1" 등)이고, 몰 화면에서 클릭하거나 직접 타이핑하면 이 칸만 바뀐다 — 마스터
  // 스키마의 실제 필드 키/라벨은 그대로다(이 칸은 새 컬럼 만들기의 컬럼명 입력칸과 같은 성격의 참고용
  // 로컬 값일 뿐, 저장되는 규칙 자체에는 영향이 없다).
  const columnNameLocal: Record<string, string> = {}
  // 지금 "컬럼 지정" 모드로 대기 중인 필드 — armingNewFieldName(새 컬럼 쪽)과 같은 방식이지만 필드별로
  // 따로 있어야 하니 필드 키를 담는다. armedField/armingNewFieldName과는 동시에 켤 수 없다.
  let armingColumnNameField: string | null = null
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
  // 기준 마스터테이블관리(master_schema_fields)에는 있지만 위 12개 고정 매핑엔 없는 필드(몰상품코드/
  // 판매관리코드/마켓별카테고리/규제판가/소비자판가/옵션1~3/교환반품비 등, 클라이언트가 "기준 마스터
  // 테이블 관리"에서 직접 추가해둔 커스텀 컬럼 전부)도 똑같이 미리 목록에 올려둔다 — 그래야 미리보기
  // 그리드에 이미 보이는 컬럼을 이 패널에서 "새 컬럼 만들기"로 이름을 다시 타이핑하지 않고 바로
  // "지정"할 수 있다(사용자 지적, 2026-09-12 — "그리드의 컬럼과 직접지정에 나오는 컬럼을 기본적으로
  // 맞춰줘야 그리드에 몰상품코드 컬럼에 대한 값을 직접지정에서 지정을 바로 할 수 있다"). 이 필드들은
  // 마스터 키 자체를 그대로 컬럼명(picker field key)으로 써서, extraction_rules에 저장되는 키가 그리드가
  // 값을 찾을 때 보는 키(previewValueFor의 fieldKey)와 항상 정확히 일치하게 한다. product_url(상품URL)은
  // 제외한다 — 그 페이지 자신의 주소라 클릭으로 "지정"할 대상이 아니다(항상 sourceUrl 그대로 쓰임).
  const coveredMasterKeys = new Set([...Object.values(PICKER_TO_MASTER_KEY), 'product_url'])
  const extraMasterFields: [string, string][] = masterOrder
    .filter(k => !coveredMasterKeys.has(k) && masterLabels[k])
    .map(k => [k, masterLabels[k]])
  const CANONICAL_FIELDS: [string, string][] = [...relabeled, ...extraMasterFields].sort((a, b) => {
    const masterKeyOf = (k: string) => PICKER_TO_MASTER_KEY[k] ?? k
    const idxA = masterOrder.indexOf(masterKeyOf(a[0]))
    const idxB = masterOrder.indexOf(masterKeyOf(b[0]))
    if (idxA === -1 && idxB === -1) return 0
    if (idxA === -1) return 1
    if (idxB === -1) return -1
    return idxA - idxB
  })
  // 대표/상세이미지는 이미지가 여러 장이라 클릭한 요소 하나만이 아니라 그 갤러리 전체(같은 부모 아래
  // img들)를 가리키는 셀렉터가 필요하다 — 일반 텍스트 필드와 다른 값 하나=요소 하나 모델이라 별도 취급.
  const IMAGE_FIELDS = new Set(['thumbnail_urls', 'detail_image_urls'])
  // 옵션1~3은 extractOptionsFromDom이 <select>를 스캔해 자동으로 채우는 값이라(currentValue 참고) 클릭
  // 지정 자체를 막는다 — 네이티브 select 드롭다운은 열려 있어도 OS가 그리는 팝업이라 페이지 스크립트가
  // 개별 <option>을 못 잡고, 실제로 클릭해보면 매번 <select> 전체(안내문+모든 옵션 텍스트가 구분자 없이
  // 뭉친 것)만 잡혀 "여러 번 클릭 = 결합"이 될수록 오히려 더 망가진다(실사용 확인, 도매신 — 색상/사이즈를
  // 각각 클릭으로 지정했는데 "- [필수] 옵션을 선택해 주세요 -----230mm235mm240mm245mm2..."처럼 뭉개짐).
  const AUTO_OPTION_FIELDS = new Set(['1_option', '2_option', '3_option'])

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
      // 옵션1~3은 몰 화면에 클릭할 단일 요소가 없다 — extractOptionsFromDom이 <select>를 스캔해 자동으로
      // 채우는 값이다(ScraperPanel.tsx의 그리드 렌더링과 동일한 규칙, product.options[N].values). 이 자동값을
      // 안 보여주면 "미지정"으로만 보여 사용자가 굳이 라벨/셀렉터를 손으로 지정하게 되는데, 그 수동 지정이
      // 정답 요소(<select> 값 목록)가 아니라 엉뚱한 것(예: th 라벨 셀, 상품정보고시의 동명 라벨 행)을 가리키면
      // 이미 맞던 자동값을 깨진 값으로 덮어써버린다(실사용 확인, 도매신 — 옵션1을 th 라벨 셀렉터 + "색상"
      // 라벨 매칭으로 지정해 "색상 - [필수] 옵션을 선택해 주세요 -----블랙화이트올블랙"처럼 뭉개진 값이 됨).
      case '1_option': case '2_option': case '3_option': {
        const idx = { '1_option': 0, '2_option': 1, '3_option': 2 }[field]!
        const opts = Array.isArray(p.options) ? p.options as { values?: string[] }[] : []
        return opts[idx]?.values?.join(', ') || ''
      }
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
      <div style="font-size:12px;color:#999;letter-spacing:.02em">PTP 직접지정 패널</div>
      <div style="font-weight:600">⠿ 🎯 스크랩 대상 직접지정</div>
    </div>
    <div style="font-size:12px;color:#888;margin-bottom:6px;line-height:1.5">① 필드 선택 → ② 몰 화면에서 값 클릭 → ③ 자동 저장 — 반복하세요</div>
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
    if (armingNewFieldName) {
      statusEl.textContent = '👉 새 컬럼명 지정 중 — 몰 화면에서 라벨을 클릭하세요'
      statusEl.style.display = 'block'
    } else if (armingColumnNameField) {
      const label = (CANONICAL_FIELDS.find(([k]) => k === armingColumnNameField)?.[1]) || armingColumnNameField
      statusEl.textContent = `👉 "${label}" 컬럼명 지정 중 — 몰 화면에서 라벨을 클릭하세요`
      statusEl.style.display = 'block'
    } else if (armedField) {
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

  // "✕"(규칙 지우기) — forceEmpty와 다르다: 이건 "값이 없어야 한다"는 결정이 아니라 "잘못 지정한 규칙을
  // 되돌려 자동/AI 추출이 다시 이 필드를 채우게 하고 싶다"는 요청이다. 예전엔 ✕가 forceEmpty를 그대로
  // 불러 규칙을 지운 게 아니라 "항상 빈 값"으로 바꿔버렸는데, 그러면 그 뒤로 ✕를 몇 번을 다시 눌러도
  // 똑같은 "항상 빈 값" 상태만 반복돼 사용자가 "왜 안 바뀌지"를 겪었다(사용자 지적, 2026-09-17 — 옵션1/2를
  // 잘못 지정한 뒤 지우려 했는데 자동값으로 돌아오지 못하고 계속 "값 없음 고정"에 갇힘). 진짜로 규칙 자체를
  // 지워 rulesLocal에서 키를 없애고, DB에서도 jsonb `-`(키 제거) 연산자로 완전히 지운다.
  function deleteField(field: string) {
    delete rulesLocal[field]
    delete lastValueLocal[field]
    pendingSaves.push(w.ptpDeleteField(field).catch(() => {}))
    logLine(`🗑 ${field}`)
  }

  // 클릭(또는 직접 입력)으로 값을 (다시) 지정하면 항상 새 값으로 교체한다 — 예전엔 이미 지정된 필드를
  // 다시 지정하면 기존 값에 새 요소를 이어붙였는데("N개 결합"), 여러 번 클릭할수록 값이 뭉쳐서 화면에
  // 그대로 찍힌 안내문+옵션 텍스트가 겹겹이 쌓이는 사고가 반복됐다(도매신 옵션1/2, 새 컬럼 "사이즈"를
  // 8번 클릭해 8개 조각이 합쳐진 사례 — 사용자 지시로 2026-09-17에 교체 방식으로 되돌림). 한 컬럼을
  // 여러 요소로 합쳐야 하는 경우는 이제 "값 직접 입력"에 이미 지정된 값을 참고해 원하는 형태로 다시
  // 타이핑하면 된다. 대표/상세이미지(갤러리 셀렉터 하나로 전체를 잡는 방식)는 이 대상이 아니다 — 여러
  // 소스에 나뉜 이미지를 모으는 별도의 갤러리 지정 방식(appendImagePart)을 그대로 쓴다.
  function saveFieldValue(field: string, part: { type: 'label' | 'selector' | 'fixed'; value: string }, displayValue: string) {
    saveField(field, part.type, part.value, displayValue)
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

  // <select>를 클릭하면(네이티브 드롭다운은 옵션이 열려 있어도 OS가 그리는 팝업이라 개별 <option>이 아니라
  // 이 <select> 자체가 클릭 대상으로 잡힌다) elementDisplayText처럼 통째로 textContent를 읽으면 안내문+
  // 모든 옵션이 구분자 없이 뭉쳐 나온다(도매신 실사용 확인, 2026-09-17 — "230mm235mm240mm..."). 실제
  // 선택 가능한 <option> 값들만 scanSelectOptions와 같은 방식(쉼표로 구분)으로 읽어 자동값과 같은
  // 형태로 보여준다 — extract.ts의 resolveLabelOrSelector도 스크랩 시점에 같은 규칙을 쓴다.
  function selectOptionsDisplayText(select: HTMLSelectElement): string {
    return Array.from(select.options).filter(o => o.value).map(o => (o.textContent || '').trim()).filter(Boolean).join(', ')
  }

  // 미리보기 그리드에 대응하는 필드들을 세로로 나열 — 컬럼을 먼저 선택("요소로 지정")한 뒤 화면에서
  // 관련 요소를 클릭해 저장하고, 이어서 다음 컬럼도 같은 순서로 반복할 수 있다. 지정한 값은 그 줄에
  // 바로 표시되고(지정 전엔 미리보기 스냅샷을 참고용으로만 흐리게 보여줌), 요소가 화면에 없는 필드는
  // "✏️ 직접 입력"으로 펼쳐지는 입력칸에 값을 타이핑해 저장할 수 있다.
  function renderFieldList() {
    const extraFields = Object.keys(rulesLocal).filter(k => !CANONICAL_FIELDS.some(([key]) => key === k))
    const allFields = [...CANONICAL_FIELDS.map(([k, l]) => ({ key: k, label: l })), ...extraFields.map(k => ({ key: k, label: k }))]
    // "새 컬럼 만들기"의 값 지정 버튼(#ptp-new-field-arm)도 다른 모든 지정 버튼(.ptp-row-arm,
    // #ptp-new-field-name-arm)과 똑같이 armed 상태를 색/문구로 보여줘야 한다 — 예전엔 항상 파란
    // "🎯 클릭해서 지정하기"로 고정돼 있어 눌러도 지정 대기 중인지 전혀 알 수 없었다(사용자 지적,
    // 2026-09-17 — "완전히 이상하게 돼 있어": 클릭해도 아무 반응이 없어 보임).
    const newFieldTrimmedName = newFieldNameDraft.trim()
    const newFieldArmed = !!newFieldTrimmedName && armedField === newFieldTrimmedName
    const rowsHtml = allFields.map(({ key, label }) => {
      const rule = rulesLocal[key]
      const armed = armedField === key
      const columnNameArmed = armingColumnNameField === key
      const displayedColumnName = columnNameLocal[key] ?? label
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
        ? `<span style="font-size:12px;background:#fff;color:#0d9488;border:1px solid #5eead4;border-radius:8px;padding:1px 6px;white-space:nowrap">${badgeText}</span>`
        : ''
      // 규칙이 없어도(미지정) 지금 자동/휴리스틱 추출로 잡힌 값이 있으면 같이 보여준다 — 안 그러면
      // "미지정"이라 값 자체가 없는 줄 알았는데 미리보기엔 값이 나와 있어 혼란스럽다는 지적이 있었다.
      // 자동값도 없으면(진짜 빈 값) 굳이 "(값 없음)"을 안 붙이고 "미지정"만 보여준다.
      const autoValue = !rule ? currentValue(key) : ''
      const valueBoxColor = isForcedEmpty ? '#e11d48' : rule ? '#0d9488' : '#333'
      // "미지정 · 자동값:" 라벨이 값보다 앞에 있으면 값 자체가 뒤로 밀려 눈에 잘 안 들어온다는 지적
      // (2026-09-17) — 값을 먼저, 라벨은 옅은 글씨로 뒤에 붙인다. 값 자체는 필드 라벨("상품명" 등, 위
      // <b style="font-size:12px">)과 같은 굵기·크기로 보이게 font-weight를 맞춘다 — 값 표시칸으로
      // 합치면서 굵기가 빠져 상대적으로 흐리게 보이던 것도 같이 고친다.
      const valueBoxText = isForcedEmpty
        ? '항상 빈 값 (자동/AI 추출 안 함)'
        : rule
          ? (esc(lastValueLocal[key] ?? currentValue(key)) || '(값 없음)')
          : autoValue
            ? `${esc(autoValue)} <span style="font-weight:400;color:#999">(미지정 · 자동값)</span>`
            : '미지정'
      // ✕는 규칙을 완전히 지워 자동/AI 추출로 되돌린다(deleteField) — forceEmpty("항상 빈 값 고정")와는
      // 별개 버튼이다. 예전엔 ✕가 forceEmpty를 그대로 호출해, 지운 뒤에도 "값 없음 고정" 상태가 그대로
      // 남아 몇 번을 다시 눌러도 안 바뀌는 것처럼 보였다(사용자 지적, 2026-09-17). "항상 빈 값으로 두고
      // 싶다"는 의도적 결정은 별도 버튼(🚫 항상 빈값)으로 남겨, 지우기와 확실히 구분한다.
      const clearAutoBtn = `<button class="ptp-row-clear-auto" data-field="${esc(key)}" title="자동으로 잡힌 값을 무시하고 항상 빈 값으로 고정합니다"
              style="background:#fff;color:#e11d48;border:1px solid #fca5a5;border-radius:5px;padding:3px 7px;font-size:12px;cursor:pointer;white-space:nowrap">🚫 항상 빈값</button>`
      const delBtn = rule
        ? `<button class="ptp-row-del" data-field="${esc(key)}" title="${isForcedEmpty ? '이 필드를 다시 자동/AI 추출이 채우도록 되돌립니다' : '지정한 규칙을 지우고 자동/AI 추출로 되돌립니다'}"
            style="background:#fff;color:#e11d48;border:1px solid #fca5a5;border-radius:5px;padding:3px 7px;font-size:12px;cursor:pointer;white-space:nowrap">${isForcedEmpty ? '↩ 고정 해제' : '✕ 지우기'}</button>${!isForcedEmpty ? clearAutoBtn : ''}`
        : autoValue ? clearAutoBtn : ''
      // 버튼은 "새 컬럼 만들기"의 버튼들처럼 항상 자연폭이고(flex:1 없음), 값 표시칸(flex:1)이 남는
      // 공간을 전부 가져간다 — 예전엔 armed/미지정일 때 버튼도 flex:1이라 표시칸과 폭을 반씩 나눠 가져
      // 갑자기 버튼만 넓어지는 게 "새 컬럼 만들기"와 다르게 보였다.
      const armBtnStyle = armed || !rule
        ? 'background:#2563eb;color:#fff;border:1px solid #2563eb'
        : 'background:#fff;color:#2563eb;border:1px solid #2563eb'
      // "값 직접 입력" 입력칸+저장 버튼을 "새 컬럼 만들기"처럼 접었다 펴는 링크 없이 항상 펼쳐 보여준다
      // (사용자 지시, 2026-09-17 — "새 컬럼 만들기"처럼 컬럼명/컬럼값 모두 그 자리에서 바로 지정할 수
      // 있어야 한다는 뜻).
      const inputRow = `
          <div style="display:flex;gap:4px;margin-top:5px">
            <input class="ptp-row-input" data-field="${esc(key)}" placeholder="값 입력" style="flex:1;min-width:0;padding:3px 5px;border:1px solid #ccc;border-radius:5px;font-size:12px" />
            <button class="ptp-row-save" data-field="${esc(key)}" style="background:#14b8a6;color:#fff;border:0;border-radius:5px;padding:3px 8px;font-size:12px;cursor:pointer">저장</button>
          </div>`
      // "새 컬럼 만들기"의 컬럼명 줄과 완전히 같은 [입력칸+지정 버튼]을 기존 필드에도 그대로 추가한다
      // (사용자 지시, 2026-09-17 — "컬럼과 값 두개를 지정할 수 있게 하라니까... 옵션1 -> 이걸 지정할 수
      // 있게 하란 말이야"). 기본값은 지금 라벨("옵션1" 등)이고, 저장되는 규칙 자체(필드 키)에는 영향을
      // 주지 않는 로컬 참고용 칸이다 — 새 컬럼 만들기의 컬럼명 입력칸도 "값 지정"으로 실제 규칙이
      // 저장되기 전까지는 마찬가지로 로컬 draft일 뿐이다.
      const columnNameRow = `
          <div style="display:flex;gap:4px;margin-top:5px">
            <input class="ptp-row-name-input" data-field="${esc(key)}" value="${esc(displayedColumnName)}" style="flex:1;min-width:0;padding:3px 5px;border:1px solid #ccc;border-radius:5px;font-size:12px;box-sizing:border-box" />
            <button class="ptp-row-name-arm" data-field="${esc(key)}"
              style="${columnNameArmed ? 'background:#2563eb;color:#fff;border:1px solid #2563eb' : 'background:#fff;color:#2563eb;border:1px solid #2563eb'};border-radius:5px;padding:3px 8px;font-size:12px;cursor:pointer;white-space:nowrap">
              ${columnNameArmed ? '❌ 클릭 대기 취소' : '🎯 컬럼 지정'}
            </button>
          </div>`
      // "새 컬럼 만들기"와 같은 [표시칸(좌)]+[지정 버튼(우)] 형태로 통일한다(사용자 지시, 2026-09-17 —
      // "이 새컬럼 만들기 형태를 다른 컬럼도 모두 적용을 하라"). 기존엔 값이 줄 하나를 통째로 차지하고
      // 버튼이 그 아래 따로 있었는데, 이제 새 컬럼 만들기의 "값 지정" 줄과 똑같이 값 표시칸과 버튼이
      // 나란히 한 줄에 오고, 표시칸엔 자동값/지정값이 그대로 채워져 보인다("왼쪽 값란에 자동값을 넣어주는
      // 것으로" — 자동값이 있으면 그게 곧 기본으로 채워지는 값이라는 뜻).
      const valueBoxStyle = `flex:1;min-width:0;padding:3px 5px;border:1px solid #ccc;border-radius:5px;font-size:12px;font-weight:600;box-sizing:border-box;background:#f9fafb;color:${valueBoxColor};word-break:break-all`
      return `
        <div style="padding:7px 7px;margin:3px 0;border:1px solid ${rowBorder};background:${rowBg};border-radius:8px">
          <div style="display:flex;justify-content:space-between;gap:4px;align-items:baseline">
            <span style="font-size:12px">${rule ? '✅' : '⬜'} <b style="font-size:12px">${esc(label)}</b></span>
            ${badge}
          </div>
          ${columnNameRow}
          <div style="display:flex;gap:4px;margin-top:5px">
            <div style="${valueBoxStyle}">${valueBoxText}</div>
            <button class="ptp-row-arm" data-field="${esc(key)}"
                  title="${AUTO_OPTION_FIELDS.has(key) ? '색상/사이즈 등 select 옵션은 위 자동값이 이미 정확한 경우가 많습니다 — 그래도 클릭으로 다시 지정하면, 클릭한 요소가 <select>면 그 옵션 전체를 자동값과 같은 방식(쉼표로 구분)으로 읽어옵니다.' : rule && IMAGE_FIELDS.has(key) ? '이미 지정된 값에 새 요소(이미지)를 이어붙입니다' : rule ? '다시 클릭하면 지금 값을 새로 클릭한 값으로 바꿉니다' : ''}"
                  style="${armBtnStyle};border-radius:5px;padding:4px 6px;font-size:12px;cursor:pointer;white-space:nowrap">
                  ${armed ? '❌ 클릭 대기 취소' : IMAGE_FIELDS.has(key) && rule ? '🎯 이미지 추가' : '🎯 값 지정'}
                </button>
          </div>
          ${delBtn ? `<div style="display:flex;gap:4px;margin-top:4px">${delBtn}</div>` : ''}
          ${inputRow}
        </div>
      `
    }).join('') + `
      <div style="padding:7px 7px;margin:3px 0;border:1px dashed #ccc;border-radius:8px">
        <div style="font-size:12px;color:#888;margin-bottom:4px">새 컬럼 만들기</div>
        <div style="display:flex;gap:4px;margin-bottom:4px">
          <input id="ptp-new-field-name" placeholder="컬럼명 (예: 택배사)" value="${esc(newFieldNameDraft)}" style="flex:1;min-width:0;padding:3px 5px;border:1px solid #ccc;border-radius:5px;font-size:12px;box-sizing:border-box" />
          <button id="ptp-new-field-name-arm"
            style="${armingNewFieldName ? 'background:#2563eb;color:#fff;border:1px solid #2563eb' : 'background:#fff;color:#2563eb;border:1px solid #2563eb'};border-radius:5px;padding:3px 8px;font-size:12px;cursor:pointer;white-space:nowrap"
            title="몰 화면에서 라벨(예: '도매가 (29개 이상)')을 클릭해 컬럼명으로 바로 채웁니다 — 조건별로 여러 공급가를 보여주는 몰에서 조건마다 새 컬럼을 만들 때 씁니다.">
            ${armingNewFieldName ? '❌ 클릭 대기 취소' : '🎯 컬럼 지정'}
          </button>
        </div>
        <div style="display:flex;gap:4px">
          <div style="flex:1;min-width:0;padding:3px 5px;border:1px solid #ccc;border-radius:5px;font-size:12px;box-sizing:border-box;background:#f9fafb;color:${newFieldTrimmedName && lastValueLocal[newFieldTrimmedName] ? '#0d9488' : '#bbb'};overflow:hidden;text-overflow:ellipsis;white-space:nowrap"
            title="${esc(lastValueLocal[newFieldTrimmedName] || '')}">${esc(lastValueLocal[newFieldTrimmedName] || '(지정된 값 없음)')}</div>
          <button id="ptp-new-field-arm"
            style="${newFieldArmed ? 'background:#2563eb;color:#fff;border:1px solid #2563eb' : 'background:#fff;color:#2563eb;border:1px solid #2563eb'};border-radius:5px;padding:3px 8px;font-size:12px;cursor:pointer;white-space:nowrap">
            ${newFieldArmed ? '❌ 클릭 대기 취소' : '🎯 값 지정'}
          </button>
        </div>
        <div style="display:flex;gap:4px;margin-top:4px">
          <input id="ptp-new-field-value" placeholder="또는 값 직접 입력" value="${esc(newFieldValueDraft)}" style="flex:1;min-width:0;padding:3px 5px;border:1px solid #ccc;border-radius:5px;font-size:12px" />
          <button id="ptp-new-field-add" style="background:#14b8a6;color:#fff;border:0;border-radius:5px;padding:3px 8px;font-size:12px;cursor:pointer">저장</button>
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
        armingNewFieldName = false
        armingColumnNameField = null
        if (hovered) { hovered.style.outline = ''; hovered = null }
        renderFieldList()
        updateStatus()
      })
    })
    // "컬럼 지정" — 새 컬럼 만들기의 컬럼명 클릭 지정(armingNewFieldName)과 같은 방식이지만 필드별로
    // armingColumnNameField에 그 필드 키를 담아 동시에 하나만 대기하게 한다.
    fieldListEl.querySelectorAll<HTMLButtonElement>('.ptp-row-name-arm').forEach(btn => {
      btn.addEventListener('click', () => {
        const field = btn.dataset.field!
        armingColumnNameField = armingColumnNameField === field ? null : field
        armedField = null
        armingNewFieldName = false
        if (hovered) { hovered.style.outline = ''; hovered = null }
        renderFieldList()
        updateStatus()
      })
    })
    fieldListEl.querySelectorAll<HTMLInputElement>('.ptp-row-name-input').forEach(input => {
      input.addEventListener('input', () => {
        columnNameLocal[input.dataset.field!] = input.value
      })
    })
    fieldListEl.querySelectorAll<HTMLButtonElement>('.ptp-row-save').forEach(btn => {
      btn.addEventListener('click', () => {
        const field = btn.dataset.field!
        const input = fieldListEl.querySelector<HTMLInputElement>(`.ptp-row-input[data-field="${CSS.escape(field)}"]`)
        const value = input?.value.trim()
        if (!value) return
        saveFieldValue(field, { type: 'fixed', value }, value)
        renderFieldList()
      })
    })
    fieldListEl.querySelectorAll<HTMLButtonElement>('.ptp-row-del').forEach(btn => {
      btn.addEventListener('click', () => { deleteField(btn.dataset.field!); renderFieldList() })
    })
    fieldListEl.querySelectorAll<HTMLButtonElement>('.ptp-row-clear-auto').forEach(btn => {
      btn.addEventListener('click', () => { forceEmpty(btn.dataset.field!); renderFieldList() })
    })
    fieldListEl.querySelector<HTMLInputElement>('#ptp-new-field-name')!.addEventListener('input', e => {
      newFieldNameDraft = (e.target as HTMLInputElement).value
    })
    fieldListEl.querySelector<HTMLInputElement>('#ptp-new-field-value')!.addEventListener('input', e => {
      newFieldValueDraft = (e.target as HTMLInputElement).value
    })
    fieldListEl.querySelector('#ptp-new-field-name-arm')!.addEventListener('click', () => {
      armingNewFieldName = !armingNewFieldName
      if (armingNewFieldName) { armedField = null; armingColumnNameField = null }
      if (hovered) { hovered.style.outline = ''; hovered = null }
      renderFieldList()
      updateStatus()
    })
    fieldListEl.querySelector('#ptp-new-field-arm')!.addEventListener('click', () => {
      const nameEl = fieldListEl.querySelector<HTMLInputElement>('#ptp-new-field-name')!
      const field = nameEl.value.trim()
      if (!field) { nameEl.focus(); return }
      armedField = armedField === field ? null : field
      armingNewFieldName = false
      armingColumnNameField = null
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
      saveFieldValue(field, { type: 'fixed', value }, value)
      newFieldNameDraft = ''
      newFieldValueDraft = ''
      renderFieldList()
    })
  }
  renderFieldList()

  function onClick(e: MouseEvent) {
    const el = e.target as HTMLElement
    if (el === panel || panel.contains(el)) return // 안내 패널 자체 클릭은 무시(버튼 클릭이 정상 동작하도록)
    if (armingNewFieldName) {
      // 값이 아니라 "새 컬럼 만들기"의 컬럼명 입력칸을 채운다 — armedField 경로(아래)와 달리 규칙을
      // 저장하지 않고 그 자리에서 입력칸 텍스트만 바꿔치기한다(사용자가 이어서 "🎯 클릭해서 지정하기"로
      // 값까지 지정해야 비로소 한 컬럼이 완성된다).
      e.preventDefault()
      e.stopPropagation()
      newFieldNameDraft = elementDisplayText(el)
      armingNewFieldName = false
      renderFieldList() // 방금 채운 newFieldNameDraft를 템플릿의 value로 그대로 반영한다
      updateStatus()
      if (hovered) { hovered.style.outline = ''; hovered = null }
      return
    }
    if (armingColumnNameField) {
      // 기존 필드의 "컬럼 지정" — armingNewFieldName과 같은 방식으로, 규칙을 저장하지 않고 그 필드의
      // columnNameLocal(로컬 참고용 컬럼명)만 클릭한 텍스트로 바꿔치기한다.
      e.preventDefault()
      e.stopPropagation()
      columnNameLocal[armingColumnNameField] = elementDisplayText(el)
      armingColumnNameField = null
      renderFieldList()
      updateStatus()
      if (hovered) { hovered.style.outline = ''; hovered = null }
      return
    }
    if (!armedField) return // 아직 목록에서 필드를 선택하지 않았으면 페이지 클릭은 그냥 통과시킨다
    e.preventDefault()
    e.stopPropagation()

    if (IMAGE_FIELDS.has(armedField)) {
      appendImagePart(armedField, computeGallerySelector(el))
    } else if (el.tagName === 'SELECT') {
      const rule = { type: 'selector' as const, value: computeSelector(el) }
      saveFieldValue(armedField, rule, selectOptionsDisplayText(el as HTMLSelectElement))
    } else {
      const label = detectLabel(el)
      const rule = label ? { type: 'label' as const, value: label } : { type: 'selector' as const, value: computeSelector(el) }
      saveFieldValue(armedField, rule, elementDisplayText(el))
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
      if (value) saveFieldValue(input.dataset.field!, { type: 'fixed', value }, value)
    })
    const newNameEl = fieldListEl.querySelector<HTMLInputElement>('#ptp-new-field-name')
    const newValueEl = fieldListEl.querySelector<HTMLInputElement>('#ptp-new-field-value')
    if (newNameEl?.value.trim() && newValueEl?.value.trim()) {
      saveFieldValue(newNameEl.value.trim(), { type: 'fixed', value: newValueEl.value.trim() }, newValueEl.value.trim())
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
  return withContext(opts, (page, context) => sampleMallProfile(page, context, startUrlHint, site.name, false), '구조 변화 감지')
}

async function sampleMallProfile(
  page: Page, context: BrowserContext, startUrl: string, mallName: string, deep: boolean, signal?: AbortSignal, siteId?: number,
  aiProviders: AiProviderId[] = ALL_AI_PROVIDERS, categoryUrlPattern?: string | null, knownCategoryExamples?: string[],
  prevSortOptions: MallSortOption[] = [],
  /** 직전 실행에서 확인된 카테고리 — screenCheckAndRecover의 두 번째 기준선(주석 참고). */
  prevCategoryLinks: CategoryMenuLink[] = [],
  /** classifySessionLossSignal의 기준선(로그인 시도 직후 신호) — profileMallStructureInner에서만
   *  넘어온다. 구조 변화 감지(deep=false) 등 로그인을 시도하지 않은 호출은 null. */
  loggedInAtStart: boolean | null = null,
): Promise<MallProfileSignals | null> {
  // "몰 구조분석"이 항상 오래 걸리는데 label 하나("몰 구조분석")로는 지금 뭘 하고 있는지 알 방법이
  // 없다는 지적(2026-08-22)으로, 주요 단계 경계마다 setSiteLockDetail로 세부 문구를 남긴다 — siteId가
  // 없으면(가벼운 "구조 변화 감지" 등 일부 호출부) 조용히 no-op.
  // 펫투비가 10.7분 걸린 사례처럼 "왜 오래 걸렸는지"를 사후에 되짚어볼 방법이 없다는 지적(2026-08-23)
  // 으로, 각 단계가 끝나는 시점에 그 직전 단계가 실제로 몇 초 걸렸는지 .dev-server.log에 그대로 남긴다
  // (새 단계로 넘어갈 때 이전 단계 소요시간을 찍는 방식이라, 마지막 단계는 함수 끝에서 따로 찍는다).
  const profileStartedAt = Date.now()
  let lastStepAt = profileStartedAt
  let lastStepLabel: string | null = null
  // .worker.log(console.log)에만 남아 화면에서는 "몰구조분석에 몇 분 걸렸는지"만 보이고 "그중 어느
  // 단계가 오래 걸렸는지"는 전혀 알 수 없었다(사용자 지적, 2026-09-26 — "AI뿐만이 아니라 전체적으로
  // 어떤 내용으로 얼마나 시간이 걸린 건지를 파악할 수 있게"). console.log와 정확히 같은 시점·같은 값을
  // signals.stepTimings에도 남겨, 화면(MallProfileResultDisplay)이 "AI 호출 상세"와 같은 방식으로
  // 단계별 소요시간을 펼쳐볼 수 있게 한다.
  const stepTimings: { label: string; elapsedSec: number }[] = []
  const step = (detail: string) => {
    const now = Date.now()
    if (lastStepLabel) {
      const elapsedSec = (now - lastStepAt) / 1000
      console.log(`[몰구조분석:${mallName}] "${lastStepLabel}" — ${elapsedSec.toFixed(1)}초`)
      stepTimings.push({ label: lastStepLabel, elapsedSec })
    }
    lastStepLabel = detail
    lastStepAt = now
    if (siteId != null) setSiteLockDetail(siteId, detail)
  }
  const logFinalStep = () => {
    if (lastStepLabel) {
      const elapsedSec = (Date.now() - lastStepAt) / 1000
      console.log(`[몰구조분석:${mallName}] "${lastStepLabel}" — ${elapsedSec.toFixed(1)}초`)
      stepTimings.push({ label: lastStepLabel, elapsedSec })
    }
  }
  // 카테고리/정렬 화면인식이 실제로 어느 공급자(Groq/로컬 Ollama)를 썼는지 화면에 보여주기 위한 기록
  // (사용자 지시, 2026-09-22 — "Groq 토큰 문제가 생기면 로컬로 넘어가는 건데, 어느 걸 쓰고 있는지 화면에
  // 표시해줄 수 있어?"). 아래 호출들에 그대로 넘기면 실제로 성공한 함수가 자기 몫을 여기 추가한다.
  const visionLog: VisionAttempt[] = []
  // "몰 구조분석 중지" 버튼이 눌리면(2026-08-22) 주요 단계 경계마다 여기서 확인해 더 진행하지 않고
  // 즉시 빠진다 — 이미 모은 신호는 버린다(중간 상태를 scrape_profile에 저장하면 다음 조회 때 "이번에
  // 정말 확인된 값"과 구분이 안 된다). AbortSignal 자체는 이 함수가 부르는 Ollama 호출(가장 CPU를 많이
  // 쓰는 부분)에도 그대로 전달돼, 그 호출 자체도 즉시 끊긴다.
  if (signal?.aborted) return null
  step('목록 페이지 확인 중...')
  let sampleUrls: string[] = []
  let platform: MallPlatform = 'unknown'
  let categoryByUrl = new Map<string, CategoryLabel>()
  try {
    const collected = await collectProductUrls(page, { maxPages: 1 })
    sampleUrls = collected.urls.slice(0, MALL_PROFILE_SAMPLE_SIZE)
    platform = collected.platform
    categoryByUrl = collected.categoryByUrl
    console.log(`[몰구조분석:진단:${mallName}] 시작 페이지(${startUrl}) 자체를 목록으로 인식, 상품 URL ${collected.urls.length}개 (needsLogin=${collected.needsLogin})`)
  } catch (e) {
    // 2026-08-23 임시 진단 로그
    console.log(`[몰구조분석:진단:${mallName}] 시작 페이지(${startUrl})는 목록으로 인식 안 됨: ${e instanceof Error ? e.message : String(e)}`)
  }

  // 지금 page는 아직 목록 페이지(startUrl)에 그대로 있다(collectProductUrls를 maxPages:1로 불러 페이지
  // 이동 없음) — 추가 네비게이션 없이 이 페이지의 페이지네이션 위젯을 바로 확인한다. countCategoryProductsOnce가
  // 매 카테고리마다 거치는 것과 같은 순서(1순위: 마지막 페이지 버튼 href, 2순위: 페이지 번호 텍스트)로,
  // 이 몰의 스킨이 그 형태를 아예 안 쓰면 미리보기가 카테고리 수만큼 같은 확인을 반복해도 항상 실패할
  // 뿐이니 여기서 한 번만 확인해 결과를 남겨둔다.
  const hasPaginationWidget = await (async () => {
    try {
      const maxPage = (await readLastPageFromNavButton(page)) ?? (await readMaxPageNumber(page, undefined))
      return maxPage !== null
    } catch { return false }
  })()

  // 아직 페이지 이동 전(현재 page가 startUrl) — 카테고리 메뉴/후보 링크 스캔은 반드시 여기서 먼저 한다.
  // 아래(랜딩 페이지 재시도)가 실제로 페이지를 이동시키므로, 이동 후로 미루면 이 몰의 헤더가 안 보일 수 있다.
  // discoverTopLevelCategoryLinks가 AI를 먼저 시도하고 실패하면 기존 히스틱으로 폴백한다(discoverCategoryLinks
  // 와 공용, 2026-08-19 — 예전엔 여기만 AI 없이 히스틱만 썼다가 도매토피아에서 상품 링크가 카테고리로
  // 잘못 섞여 들어오는 문제를 겪었다). deep=false(구조 변화 감지)면 무거운 방문 폴백은 건너뛴다.
  step('카테고리 구조 확인 중...')
  // discoverTopLevelCategoryLinks/expandCategoryHubs의 useAi는 로컬 Ollama 기반 카테고리 링크 판별
  // (detectCategoryLinksWithAI, pickIndicesWithOllama) 전용이라 — Anthropic/Gemini는 이 판별에 안 쓰인다
  // (파일 상단 "이 둘만 로컬 Ollama로 옮긴다" 주석 참고) — aiProviders 중 'ollama' 포함 여부만 넘긴다.
  const useOllamaForCategoryLinks = aiProviders.includes('ollama')
  const discovery = await discoverTopLevelCategoryLinks(
    context, page, mallName, deep, signal, useOllamaForCategoryLinks, categoryUrlPattern, knownCategoryExamples, startUrl, platform,
    undefined, visionLog,
  )
  let { links: categoryLinks, aiUsed: categoryLinksAiUsed } = discovery
  const categoryScreenNames = discovery.screenNames
  const categoryScreenHierarchy = discovery.screenHierarchy
  const categoryMenuLinks = discovery.menuLinks
  // 이번에 카테고리를 찾았으면(어느 방법으로든) URL 패턴을 다시 역산해 "기억"을 최신 상태로 갱신한다 —
  // 카테고리 구성이 바뀐 몰도 계속 정확한 패턴을 유지하기 위함. 이번엔 하나도 못 찾았으면 새로 역산할
  // 근거가 없으니 예전에 알던 패턴(categoryUrlPattern 인자)을 그대로 들고 간다 — 일시적 실패로 "기억"
  // 자체를 지우지 않는다. 패턴은 항상 최상위 목록(허브 펼치기 전)을 기준으로 뽑는다 — 펼친 뒤 목록을
  // 써도 결과가 크게 달라지지 않고, 최상위 기준이 기존 동작과 일치한다.
  const finalCategoryUrlPattern = (categoryLinks.length ? deriveCategoryUrlPattern(categoryLinks.map(c => c.href)) : null) ?? categoryUrlPattern ?? null
  if (signal?.aborted) return null

  // 허브 펼치기(discoverCategoryLinks와 공유, expandCategoryHubs 참고) — "몰 구조분석"은 자주 안 도는
  // 무거운 버튼이니, 어차피 몰에 들어간 김에 여기서도 scrape_profile.categoryLinks 캐시를 최신 상태로
  // 갱신해둔다(2026-08-27, 사용자 요청 — "허브 펼치기를 몰 구조분석 시점에 해서, 카테고리 불러오기가
  // 그 결과를 캐시로 바로 쓸 수 있게"). deep=false("구조 변화 감지", 로그인 확인/스크랩 시작마다 자동
  // 실행)에서는 카테고리 수만큼 페이지를 더 여는 이 무거운 단계를 건너뛴다 — 그쪽까지 넣으면 원래
  // 목적(빠른 변화 감지)을 해친다.
  // 한때 이 호출만 동시성을 1로 강제했었다("실제 로그인 세션을 그대로 쓰는 이 경로가 동시 접속에 약할
  // 것"이라는 가설) — 하지만 실제 원인은 동시성과 무관했다: loginIfNeeded가 홈페이지에서 로그인폼을 못
  // 찾아 재로그인 자체를 건너뛰고 있었고(profileMallStructure 위쪽 loginIfNeeded 호출부 주석 참고),
  // 그걸 고친 뒤에도 신원 쿠키가 비동기로 늦게 채워지는 문제가 있었다(그것도 위에서 직접 기다리도록
  // 고침) — 둘 다 이 허브 펼치기가 시작되기 전, 단 한 번만 벌어지는 일이라 동시성 값과 무관하다
  // (2026-09-02 서버 쪽 직접 쿠키/헤더 캡처로 확인). 그래서 다른 호출부(카테고리 불러오기 등)와 같은
  // 기본 동시성(4)으로 되돌린다.
  let hubExpansionHitLoginWall = false
  let categoryExclusions: CategoryExclusion[] = []
  // MALL_REPORT_HINT_KEYWORDS 참고 — 카테고리 하위구조 확인 중 결제/배송/정렬 등 관련 키워드가 발견된
  // 페이지 URL. 아래 "AI로 결제/배송/업체정보 분석 중" 단계가 이 URL만 다시 방문해 참고 자료로 쓴다.
  let categoryPageHintHrefs: string[] = []

  // "카테고리별 정렬기준 설정" 기능용 — 정렬 위젯은 보통 홈페이지가 아니라 카테고리 목록 페이지에만
  // 있어서(등록된 몰 URL이 홈페이지인 경우가 흔함), 방금 찾은 카테고리 중 하나를 실제로 열어봐야 확인할
  // 수 있다. 몰 전체가 같은 정렬 메커니즘을 쓴다고 가정한다(실사용상 카테고리마다 다른 경우는 못 봤음) —
  // 대분류 하나만 확인하면 충분. 무거운 작업이라 deep("몰 구조분석")에서만 한다.
  //
  // 2026-09-26 이전엔 이 확인이 아래 "카테고리 하위구조 확인"(expandCategoryHubs)이 전부 끝난 뒤 완전히
  // 별도인 단계로, 상품 있는 카테고리를 처음부터 다시 최대 5개까지 순서대로 열어가며 진행했다 — 그런데
  // "카테고리 하위구조 확인"이 이미 대분류 각각을 방문해 상품 유무를 확인하는 중이라, 그 방문을 재사용하지
  // 않고 나중에 또 열어보는 중복이었다. 무엇보다 정렬 인식은 Groq의 비전 모델이 계정에서 사라진 뒤
  // (2026-09-16, GROQ_VISION_MODEL 주석 참고) 사실상 로컬 CPU 전용 Ollama(qwen2.5vl:7b, 40~90초/회)에만
  // 의존하는데, 후보 카테고리 5개 × 최대 2회(라벨 인식 실패 시 트리거 인식까지)를 전부 직렬로 돌리면
  // 실측 613.8초까지 걸렸다(도매창고 실사용, 2026-09-26 — 사용자 지적: "정렬옵션 확인은 qwen2.5가
  // 해야해? 너무 오래걸리잖아... 카테고리 구조 확인 시에 정렬옵션도 카테고리 내에 같이 나오니, 이를
  // 같이 분석하는 것으로 할 수는 없어?"). 그래서 별도 단계로 빼는 대신, expandCategoryHubs가 상품 있는
  // 카테고리를 발견하는 바로 그 시점(이미 그 페이지를 열어본 시점)에 스크린샷+비전 판정을 그 자리에서
  // 시도하도록 콜백으로 넘긴다 — 페이지 재방문이 없어지는 것은 물론, 비전 추론이 CPU를 붙잡고 있는
  // 40~90초 동안에도 다른 워커(기본 동시성 4)는 나머지 카테고리 확장을 계속 진행하므로 체감 대기시간이
  // 줄어든다(실제 추론 시간 자체는 그대로다 — Ollama 호출은 전역 큐(lib/ai.ts의 withOllamaQueue)로 어차피
  // 한 번에 하나씩만 처리되지만, 그 대기시간이 "정렬만 확인하는 별도 단계"로 새로 쌓이는 대신 "카테고리
  // 하위구조 확인"이 어차피 쓰던 시간 안에 겹쳐 들어간다).
  let sortOptions: MallProfileSignals['sortOptions'] = []
  const sortDetectionCandidates: { link: CategoryMenuLink; baseUrl: string }[] = []
  let sortDetectionAttempts = 0
  const prevSortLabels = prevSortOptions.map(o => o.label).filter(Boolean)
  // 상품이 있어도 정렬 UI 자체가 없는 카테고리가 있다(도매의신 실사용 확인, 2026-09-18 — 표본으로 고른
  // "베스트상품" 목록엔 정렬 위젯이 아예 없었음) — 그래서 하나 찾아 실패하면 포기하지 않고
  // MALL_PROFILE_SORT_CANDIDATE_LIMIT개까지 계속 다른 카테고리로 시도한다(사용자 지시, 2026-09-18:
  // "알아서 찾을 수 있어야 돼"). expandCategoryHubs는 여러 워커가 동시에 카테고리를 확장하므로, 이 함수도
  // 여러 워커에서 동시에 불릴 수 있다 — 아래 두 줄(길이 확인 → 카운트 증가) 사이엔 await이 없어(동기
  // 구간) 시도 상한을 넘겨 예약하는 경합이 생기지 않는다.
  async function tryDetectSortDuringExpansion(workerPage: Page, link: CategoryMenuLink) {
    if (sortOptions.length || sortDetectionAttempts >= MALL_PROFILE_SORT_CANDIDATE_LIMIT) return
    sortDetectionAttempts++
    const baseUrl = workerPage.url()
    sortDetectionCandidates.push({ link, baseUrl })
    console.log(`[정렬탐지:진단:${mallName}] "${link.name}"(${baseUrl}) — 하위구조 확인 중 발견, 화면 인식 시도(${sortDetectionAttempts}/${MALL_PROFILE_SORT_CANDIDATE_LIMIT})`)
    // 화면(스크린샷)을 먼저 본다(사용자 지시, 2026-09-08 — "정렬은 어차피 사람 눈으로 화면에서 확인
    // 가능하다"). href/select 마크업 형태나 사이트 공통 내비게이션 텍스트와의 우연한 키워드 겹침 같은
    // 마크업발 오탐/누락(2026-09-08, 소꿉노리 다수)이 이 경로 자체로는 발생하지 않는다. 이 몰에서
    // 예전에 확인된 라벨이 있으면 참고 예시로 같이 건넨다(사용자 지시, 2026-09-18).
    const found = await detectSortOptionsByScreenshot(workerPage, baseUrl, mallName, signal, prevSortLabels, visionLog).catch(() => [])
    console.log(`[정렬탐지:진단:${mallName}] "${link.name}" 화면 인식 결과: ${found.length}개`)
    // 다른 워커가 그새 먼저 찾았으면(sortOptions.length) 나중에 도착한 결과로 덮어쓰지 않는다.
    if (found.length && !sortOptions.length) {
      sortOptions = found
      console.log(`[정렬탐지:진단:${mallName}] 표본 카테고리 확정(화면 인식, 카테고리 하위구조 확인과 병행): ${baseUrl}`)
    }
  }

  if (deep && categoryLinks.length) {
    step('카테고리 하위구조 확인 중...')
    // platform이 아직 'unknown'이면(collectProductUrls가 목록 인식에 실패한 경우) 여기서 먼저 확인한다 —
    // countProductsOnPage가 플랫폼별 셀렉터를 골라 쓰므로, 'unknown'인 채로 넘기면 정확도가 떨어진다.
    const expandPlatform = platform === 'unknown' ? await detectMallPlatform(page).catch(() => 'unknown' as MallPlatform) : platform
    const expansion = await expandCategoryHubs(
      context, page, categoryLinks, mallName, expandPlatform, new URL(startUrl).origin,
      {}, signal, siteId, aiProviders.includes('ollama'), visionLog,
      tryDetectSortDuringExpansion,
    )
    categoryLinks = expansion.links
    categoryLinksAiUsed = categoryLinksAiUsed || expansion.aiUsed
    hubExpansionHitLoginWall = expansion.loginBlockedExpansion
    categoryPageHintHrefs = expansion.relevantHrefs
    categoryExclusions = expansion.excluded
  }
  // 화면으로 카테고리를 파악한 실행이면 최종 목록이 그 화면과 맞는지 대조하고, 빠진 게 있으면 다른
  // 방법으로 재검증해 되살린다 — "카테고리 불러오기"와 **같은 공용 함수**를 쓴다(두 화면의 카테고리
  // 개수가 갈리던 문제, screenCheckAndRecover 주석 참고).
  let categoryScreenCheck: CategoryScreenCheck | null = null
  if (deep) {
    const checked = await screenCheckAndRecover(
      context, mallName, categoryScreenNames, categoryMenuLinks, categoryLinks, categoryExclusions,
      platform === 'unknown' ? await detectMallPlatform(page).catch(() => 'unknown' as MallPlatform) : platform,
      new URL(startUrl).origin, signal, prevCategoryLinks, categoryScreenHierarchy,
    )
    categoryLinks = checked.links
    categoryScreenCheck = checked.screenCheck
  }
  if (signal?.aborted) return null

  // 위 병행 화면 인식이 후보를 전부(MALL_PROFILE_SORT_CANDIDATE_LIMIT개) 시도하고도 하나도 못 찾았을
  // 때만 마지막 수단으로 DOM 폴백(href/select 키워드 스캔 → 클릭 검증)을 시도한다 — 예전 "2단계"와 같은
  // 로직이다. 화면 인식이 각 페이지를 지나쳐 다음 카테고리로 넘어갔으므로 여기서 같은 URL을 다시 열어야
  // 하지만(재방문 비용), 이 경로는 화면 인식이 전부 실패했을 때만 타는 드문 경로라 감수한다.
  if (deep && !sortOptions.length && sortDetectionCandidates.length) {
    // 라벨을 예전과 똑같이 유지한다 — components/panels/ScraperPanel.tsx의 MALL_PROFILE_STEP_ORDER가
    // 이 접두어("정렬 옵션 확인 중")로 "지금 몇 번째 단계인지" 배지를 매칭하는데, 다른 문구를 쓰면 이
    // 드문 폴백 경로에서만 그 배지가 조용히 안 뜬다(에러는 아니지만 굳이 만들 필요 없는 사소한 회귀).
    step('정렬 옵션 확인 중...')
    for (const { link, baseUrl } of sortDetectionCandidates) {
      if (signal?.aborted) break
      const moved = await page.goto(baseUrl, { waitUntil: 'load', timeout: 20_000 }).then(() => true).catch(() => false)
      if (!moved) continue
      const sortCandidates = await collectSortCandidates(page)
      // 후보 텍스트가 정렬스러운 낱말(looksLikeSortLabel)을 포함하는 것만 먼저 골라내고, diffQueryParams
      // (같은 경로, 쿼리파라미터만 다름)까지 통과하면 그대로 확정한다 — 로컬 Ollama(detectSortOptionsWithAI)
      // 에게 판별을 맡기던 걸 없앴다(2026-08-23, 사용자 지시로 재검토): collectSortCandidates가 모아오는
      // 후보엔 카테고리 사이드바 링크 등 정렬과 전혀 무관한 것도 잔뜩 섞여있는데, 로컬 Ollama가 이걸
      // 정렬로 잘못 골라 저장한 사고가 이미 있었고, 응답이 느리거나(수십~수백 초) 도구 호출 대신
      // 텍스트로 새는 문제도 같은 세션에서 반복 확인됐다. "정렬스러운 텍스트"(의미)와 "실제로 다른
      // 목록으로 이어지는 링크"(구조)라는 독립된 증거 두 개가 이미 있으니, 신뢰도 낮은 세 번째 신호(AI)를
      // 더할 필요가 없다 — 키워드 매칭만 쓰는 클릭 폴백(detectSortOptionsByClicking)이 오히려 더
      // 안정적이었던 것과 같은 이유. 개발자모드 확장의 별도 정렬감지 경로(app/api/sites/[id]/sort-options,
      // detectSortOptionsWithAI 계속 사용)는 호출부가 달라 이번엔 손대지 않았다.
      console.log(`[정렬탐지:진단:${mallName}] "${link.name}" 정적 후보 ${sortCandidates.length}개(${sortCandidates.slice(0, 15).map(c => c.text).join(', ')})`)
      const queryBased = sortCandidates
        .filter(c => looksLikeSortLabel(c.text))
        .map(c => ({ label: c.text, kind: 'query' as const, paramsToAdd: diffQueryParams(baseUrl, c.href) }))
        .filter((o): o is { label: string; kind: 'query'; paramsToAdd: Record<string, string> } => !!o.paramsToAdd)
      console.log(`[정렬탐지:진단:${mallName}] "${link.name}" 키워드+쿼리검증 통과 ${queryBased.length}개`)
      if (queryBased.length) {
        sortOptions = queryBased
      } else {
        // 정적 href/select 기반 감지가 후보를 못 찾았거나, 찾았어도 키워드 필터를 통과한 게 하나도
        // 없을 때 — 화면 텍스트를 후보로 삼아 실제로 클릭해보고 URL/목록 순서 변화로 직접 검증한다
        // (detectSortOptionsByClicking 주석 참고 — kind:'query'/kind:'click' 둘 다 여기서 나올 수 있다).
        sortOptions = await detectSortOptionsByClicking(page, baseUrl).catch(() => [])
        console.log(`[정렬탐지:진단:${mallName}] "${link.name}" 클릭 폴백 결과 ${sortOptions.length}개`)
      }
      if (sortOptions.length) {
        console.log(`[정렬탐지:진단:${mallName}] 표본 카테고리 확정(DOM 폴백): ${link.href}`)
        break
      }
      console.log(`[정렬탐지:진단:${mallName}] "${link.name}"에서 DOM 폴백도 실패 — 다음 카테고리 시도`)
    }
    if (!sortOptions.length) {
      console.log(`[정렬탐지:진단:${mallName}] 상품 있는 카테고리 ${sortDetectionCandidates.length}개를 화면 인식+DOM 폴백 모두 시도했지만 정렬을 못 찾음`)
    }
  }

  if (deep && page.url() !== startUrl) {
    // discoverTopLevelCategoryLinks의 방문 폴백(discoverCategoriesByVisitingLinks), 또는 위 정렬 옵션
    // 확인용 카테고리 방문이 페이지를 이동시켰을 수 있다 — 아래(gatherMallContextText 등)가 이 몰의
    // 원래 시작 페이지를 보고 있다고 가정하므로 되돌린다.
    await page.goto(startUrl, { waitUntil: 'load', timeout: 20_000 }).catch(() => {})
  }
  const categoryMenuNames = categoryLinks.map(c => c.name)
  // 같은 이유로, 상품 샘플로 이동하기 전에 지금 페이지(홈/목록)의 하단 회사정보와 이용안내·공지 등
  // 게시판 링크를 먼저 훑어 원문을 모아둔다 — 결제계좌/택배사/연락처는 상품페이지가 아니라 이런 정적
  // 페이지에 있다(실사용 몰 확인됨). deep(=="몰 구조분석" 버튼)에서만 하는 무거운 작업이라 로그인
  // 확인/스크랩 시작마다 도는 가벼운 체크에서는 건너뛴다. 페이지 이동이 있어 시간이 들 수 있어 실패해도
  // 나머지 흐름은 계속한다.
  if (signal?.aborted) return null
  if (deep) step('회사정보/이용안내 페이지 확인 중...')
  const contextText = deep ? await gatherMallContextText(page, context, signal, siteId).catch(() => '') : ''
  if (signal?.aborted) return null
  // gatherMallContextText는 mapWithPageWorkers로 회사정보/배송조회 등 안내 링크를 동시에 훑는데, 그
  // 워커 중 하나가 공유 page(로그인 창이 열려있으면 사용자가 보고 있는 그 탭) 자신을 그대로 재사용한다
  // (mapWithPageWorkers 참고 — 새 탭 여러 개 + 이 page 자신을 합쳐 동시 처리). "배송조회" 안내 링크가
  // 몰 자체 페이지가 아니라 택배사 조회 사이트(예: 롯데글로벌로지스)로 그대로 리다이렉트되는 몰이 있어,
  // 그 링크가 이 page에 배정되면 몰 구조분석이 끝난 뒤에도 로그인 창이 그 택배사 사이트에 남아있었다
  // (실사용 확인, 2026-08-23 — 그 직후 "카테고리 선택 가져오기"의 "현재 카테고리 가져옴"이 로그인 창의
  // 마지막 탭 URL을 그대로 읽어가는데, 엉뚱한 택배사 URL을 몰 카테고리로 착각해 가져왔다). 위(1997줄)의
  // 카테고리/정렬옵션 확인 직후 복귀 로직과 같은 이유로, 여기서도 반드시 몰의 시작 페이지로 되돌려놓는다.
  if (deep && page.url() !== startUrl) {
    await page.goto(startUrl, { waitUntil: 'load', timeout: 20_000 }).catch(() => {})
  }

  // 등록된 몰 URL이 배너/메뉴만 있는 랜딩 페이지라 상품 링크가 0개인 몰도 있다(실사용 확인: 진짜양말 —
  // 홈페이지엔 이미지 스프라이트 메뉴만 있고 상품은 그 메뉴를 눌러 들어간 카테고리 목록에만 있음). 그대로
  // 포기하면 홈페이지 자체를 "상품 1건"으로 취급해 카테고리/옵션/재고 등 거의 모든 신호가 비어버리므로,
  // 위에서 찾은 카테고리 후보 링크를 몇 개 따라 들어가 재시도한다. 후보 하나에서만 다 채우면 그 카테고리
  // 하나로 구조가 쏠려버리므로(실사용 확인: "사은품양말"만 나옴), 후보마다 최대 2건씩만 담아 여러
  // 카테고리에 걸쳐 샘플링한다.
  if (!sampleUrls.length) {
    const urls: string[] = []
    const mergedByUrl = new Map<string, CategoryLabel>()
    // findCategoryLinkCandidates는 카테고리 메뉴 판정과는 별개로(위 discoverTopLevelCategoryLinks가 AI로
    // 대체한 부분), cat/lnb/gnb 영역의 링크를 "상품 샘플을 찾아 들어가볼 후보"로만 넓게 쓴다 — 여기선
    // 정확한 카테고리 여부가 중요하지 않고 그냥 실제 상품이 있을 만한 페이지 몇 개면 충분하다.
    const categoryLinkCandidates = await findCategoryLinkCandidates(page)
    // 2026-08-23 임시 진단 로그 — "샘플 상품 1건"(=아래 catch들이 조용히 삼켜서 원인이 안 보이는 문제)
    // 재현 중이라 원인을 찾을 때까지만 남겨둔다.
    console.log(`[몰구조분석:진단:${mallName}] 카테고리 후보 링크 ${categoryLinkCandidates.length}개: ${categoryLinkCandidates.slice(0, 8).join(', ')}`)
    for (const link of categoryLinkCandidates) {
      if (urls.length >= MALL_PROFILE_SAMPLE_SIZE) break
      try {
        const collected = await collectProductUrls(page, { url: link, maxPages: 1 })
        platform = collected.platform
        console.log(`[몰구조분석:진단:${mallName}] ${link} → 상품 URL ${collected.urls.length}개 (needsLogin=${collected.needsLogin})`)
        for (const u of collected.urls.slice(0, 2)) {
          if (urls.length >= MALL_PROFILE_SAMPLE_SIZE || urls.includes(u)) continue
          urls.push(u)
          const label = collected.categoryByUrl.get(u)
          if (label) mergedByUrl.set(u, label)
        }
      } catch (e) {
        console.log(`[몰구조분석:진단:${mallName}] ${link} → 실패: ${e instanceof Error ? e.message : String(e)}`)
      }
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
    categoryMenuNames, categoryLinks, categoryLinksAiUsed, categoryUrlPattern: finalCategoryUrlPattern,
    hasPaginationWidget, sortOptions, report: null, categoryScreenCheck,
    ...(visionLog.length ? { visionProviderLog: visionLog } : {}),
  }
  const optionTypes = new Set<'select' | 'swatch' | 'none'>()
  const infoLabelSet = new Set<string>()
  const categoryPathSet = new Set<string>()
  let productContextText = ''
  // 여러 워커가 동시에 "내가 첫 성공 샘플이다"로 착각해 둘 다 무거운 evaluate까지 하고 나중 것이 앞선
  // 결과를 덮어쓰는 걸 막는 락 — await 없이 동기로 바로 세워야(claim) 두 워커가 같은 틈에 함께 통과하지
  // 않는다(JS는 싱글스레드라 await 지점 사이엔 이 대입이 원자적이다).
  let contextClaimed = false

  step(`샘플 상품 ${sampleUrls.length}건 확인 중...`)
  // 세션이 끊긴 채 상품 페이지를 열면 로그인 페이지를 그대로 "상품"으로 오인해 빈 결과를 쌓는다 — 실제
  // 스크랩 루프(scrapeOne)가 상품마다 이미 쓰는 것과 같은 loginIfNeeded 패턴을 여기도 적용한다(사용자
  // 지시, 2026-09-15 — "방법이 없다는거야?": 세션이 어느 단계에서 끊기든 그 자리에서 복구). 여러 워커가
  // 동시에 방문하지만 loginIfNeeded 자체가 "로그인폼이 보일 때만" 동작하는 멱등 호출이라(로그인폼이 없으면
  // 즉시 false) 매 방문마다 걸어도 안전하다 — expandCategoryHubs처럼 별도의 single-flight가 필요 없다.
  const sampleLoginCreds = siteId != null
    ? await siteInfo(siteId).then(s => (s.loginId && s.loginPw ? { loginId: s.loginId, loginPw: s.loginPw } : null)).catch(() => null)
    : null
  // 샘플 상품 방문(최대 MALL_PROFILE_SAMPLE_SIZE=6건)은 서로 완전히 독립적인 페이지라 순차 대신 여러
  // 탭으로 동시에 처리한다 — 모자사러처럼 카테고리/상품 페이지 로딩이 느린 몰에서 "몰 구조분석" 소요
  // 시간의 상당 부분이 이 순차 방문이었다(2026-08-22, 사용자 요청으로 병렬화). Set/카운터 갱신은 각
  // 워커의 await 없는 동기 구간에서만 일어나 경쟁 조건이 없다.
  await mapWithPageWorkers(context, page, sampleUrls, MALL_PROFILE_CONCURRENCY, async (url, _i, workerPage) => {
    const category = categoryByUrl.get(url)?.category
    if (category) categoryPathSet.add(category)
    try {
      // gotoViaLinkClick: gotoViaLinkClick 정의부 주석 참고(Sec-Fetch-Site: same-origin을 만들기 위해
      // page.goto() 대신 실제 <a> 클릭을 흉내낸다).
      await gotoViaLinkClick(workerPage, url, { waitUntil: 'load', timeout: 20_000 })
      if (sampleLoginCreds && await loginIfNeeded(workerPage, { url, ...sampleLoginCreds }).catch(() => false)) {
        await gotoViaLinkClick(workerPage, url, { waitUntil: 'load', timeout: 20_000 }).catch(() => {})
      }
      await waitForExtractableContent(workerPage)
      const product = await extractProductRuleBased(workerPage, url)
      const selectOptions = await scanSelectOptions(workerPage)
      const swatchOptions = selectOptions.length ? [] : await scanSwatchOptions(workerPage)
      optionTypes.add(selectOptions.length ? 'select' : swatchOptions.length ? 'swatch' : 'none')

      const domOptions = await extractOptionsFromDom(workerPage)
      if (domOptions.options.length) product.options = domOptions.options
      if (domOptions.combinations.length) product.option_combinations = domOptions.combinations
      await applyStockByOption(workerPage, product)

      signals.sampleCount++
      if (product.thumbnail_urls.length > 0) signals.hasMainImages = true
      if (product.detail_image_urls.length > 0) signals.hasDetailImages = true
      if (product.detail_text) signals.hasDetailText = true
      if (product.stock_qty != null) signals.hasStockQty = true
      if (product.stock_status && product.stock_status !== '판매중') signals.hasStockStatusText = true
      if (product.stock_by_option.length > 0) signals.hasStockByOption = true
      if (product.options.length > 1) signals.hasCascadingOptions = true
      product.extra_info.forEach(({ label }) => infoLabelSet.add(label))
      // AI 리포트용 원문은 상품 1건만 있으면 충분해(토큰 절약) 가장 먼저 도착한 성공 샘플에서만 모은다. deep 전용.
      if (deep && !contextClaimed) {
        contextClaimed = true
        const bodyText = await workerPage.evaluate(() => document.body.innerText).catch(() => '')
        const imageHints = await workerPage.evaluate(collectImageHintsScript, null).catch(() => [] as string[])
        productContextText = `[샘플 상품페이지: ${url}]\n${bodyText.replace(/\s+/g, ' ').trim().slice(0, 4_000)}`
          + (imageHints.length ? `\n\n[샘플 상품페이지 이미지 설명/파일명]\n${imageHints.join(', ')}` : '')
        signals.sampleProductPageText = bodyText
      }
    } catch (e) {
      // 2026-08-23 임시 진단 로그 — 위 카테고리 후보 로그와 짝
      console.log(`[몰구조분석:진단:${mallName}] 샘플 방문 실패 ${url} → ${e instanceof Error ? e.message : String(e)}`)
    }
  }, signal)
  if (signal?.aborted) return null
  signals.optionUiTypes = [...optionTypes]
  signals.infoLabels = [...infoLabelSet].sort()
  signals.categoryPaths = [...categoryPathSet].sort()
  signals.categoryMaxDepth = signals.categoryPaths.reduce((max, p) => Math.max(max, p.split(' > ').length), 0)

  if (deep) {
    step('AI로 결제/배송/업체정보 분석 중...')
    const aiStepStartedAt = Date.now()
    const categoryPageHints = await gatherCategoryPageHints(context, page, categoryPageHintHrefs, signal, siteId).catch(() => '')
    if (deep && page.url() !== startUrl) {
      await page.goto(startUrl, { waitUntil: 'load', timeout: 20_000 }).catch(() => {})
    }
    const combinedContext = [contextText, categoryPageHints, productContextText].filter(Boolean).join('\n\n')
    const categoryHints = categoryMenuNames.length ? categoryMenuNames : signals.categoryPaths
    // 정렬 옵션도 카테고리와 같은 방식으로 리포트에 옮긴다("정렬 구조" 필드, 사용자 요청 2026-08-30) —
    // 이미 위(2139-2180행)에서 클릭/URL 검증까지 거쳐 구조적으로 확정한 값이라, AI에게 원문에서 다시
    // 찾아내라고 시키지 않고 label만 그대로 힌트로 준다(카테고리 힌트와 동일한 신뢰도 취급).
    // 이번 실행에서 새로 감지한 게 하필 비어있으면(샘플로 시도한 카테고리 5개가 전부 정렬 위젯 없는
    // 페이지였던 경우 등) prevSortOptions(getCategoryMemory 주석 참고)로 대신 채운다 — applyProfileResult의
    // sortOptions 복원 가드는 최종 signals엔 적용되지만 report는 이미 다 만든 뒤라 그 보호를 못 받아서,
    // 리포트를 만들기 "전"인 여기서 같은 안전장치를 미리 건다(걸스굽 실사용 확인, 2026-09-02).
    const sortHints = (sortOptions.length ? sortOptions : prevSortOptions).map(o => o.label)
    // ANTHROPIC_API_KEY 크레딧이 없어 AI 호출이 안 되는 경우(월 정액 구독으로는 대체 불가 — API 과금과는
    // 별개)에도 "몰 구조분석"이 결과 없이 끝나지 않도록, AI 실패 시 규칙 기반 리포트로 대체한다.
    // aiProviders가 비어있으면(사용자가 화면에서 AI 공급자를 전부 끈 경우) AI 호출 자체를 시도하지 않고
    // 곧장 규칙 기반으로 간다 — 크레딧이 없는 걸 이미 아는 상황에서 매번 타임아웃을 기다리지 않게 한다
    // (사용자 요청, 2026-08-25 — 원래 단일 "AI 사용" 체크박스였다가 2026-09-02에 공급자별 체크로 확장).
    // AiReportAttempt 주석 참고 — "AI 호출 실패"만 봐서는 어느 공급자가 왜 실패했는지 알 수 없다는
    // 지적(2026-09-23)으로, 진행 중엔 setSiteLockDetail로 "지금 어느 공급자를 부르는 중/방금 어떻게
    // 됐는지"를 실시간으로 남기고(siteId 없는 호출부는 no-op), 끝나면 전체 시도 이력을 signals에 담아
    // 화면 최종 결과에도 상세히 보여준다.
    const aiReportLog: AiReportAttempt[] = []
    signals.report = (aiProviders.length ? await generateMallProfileReport(
      mallName, platform, categoryHints, sortHints, signals.sampleProductUrl, combinedContext, aiProviders, signal,
      aiReportLog,
      siteId == null ? undefined : (event) => {
        const label = AI_REPORT_PROGRESS_LABEL[event.provider]
        if (event.phase === 'start') {
          setSiteLockDetail(siteId, `AI로 결제/배송/업체정보 분석 중... (${label} ${event.model} 호출 중)`)
        } else {
          const outcome = event.success ? '성공' : `실패(${(event.error ?? '원인 미상').slice(0, 80)})`
          setSiteLockDetail(siteId, `AI로 결제/배송/업체정보 분석 중... (${label} ${event.model} ${outcome} · ${(event.elapsedMs / 1000).toFixed(1)}초)`)
        }
      },
    ).catch(() => null) : null)
      ?? buildHeuristicMallReport({
        platform, categoryHints, sortHints, sampleProductUrl: signals.sampleProductUrl, contextText: combinedContext,
        optionUiTypes: signals.optionUiTypes, hasCascadingOptions: signals.hasCascadingOptions,
        hasMainImages: signals.hasMainImages, hasDetailImages: signals.hasDetailImages, hasDetailText: signals.hasDetailText,
        hasStockQty: signals.hasStockQty, hasStockStatusText: signals.hasStockStatusText, hasStockByOption: signals.hasStockByOption,
      })
    signals.aiAnalysisElapsedSec = (Date.now() - aiStepStartedAt) / 1000
    signals.aiReportAttempts = aiReportLog.length ? aiReportLog : undefined
  }

  await page.goto(startUrl, { waitUntil: 'load', timeout: 20_000 }).catch(() => {})
  // 시작 페이지로 되돌아온 뒤에도 로그인 세션이 끊긴 것으로 보이면(MallProfileSignals.sessionLostDuringAnalysis
  // 주석 참고) 화면에 경고를 남긴다 — deep(="몰 구조분석")에서만 확인한다: deep=false(로그인 확인/스크랩
  // 시작마다 자동으로 도는 가벼운 구조 변화 감지)는 원래도 매번 이 페이지들을 훑고 지나가는 경로가 아니라
  // 세션이 끊길 만한 원인 자체가 다르고, 매번 추가로 한 번 더 확인하는 비용을 들일 만큼 값어치가 없다.
  if (deep) {
    let loggedIn = await detectLoggedInSignal(page)
    // hubExpansionHitLoginWall: expandCategoryHubs 내부에서 카테고리 하나를 확인하던 중 이미 로그인
    // 페이지/봇차단을 만난 적이 있었는지(expandOne 참고) — 예전엔 이 신호를 그냥 버렸는데, 함수 끝의
    // detectLoggedInSignal만으론 못 잡는 경우(예: 되돌아간 시작 페이지 자체엔 "로그아웃" 링크가 있는
    // 형태가 아니어서 오탐 없이 통과하지만 실제로는 중간에 한 번 걸렸던 경우)를 보강한다.
    //
    // loggedIn===false 하나만으로 곧장 "세션이 끊겼다"고 단정하면, 애초에 로그인 여부를 화면에 전혀
    // 드러내지 않는 몰(정글북 실사용 확인, 2026-09-15 — 사용자 질문 "로그인이 끊겼다는 내용은 맞는거야?"
    // 로 재진단: 로그인 시도 직후에도 이미 이 신호가 false였다)에서는 매번 사실과 다른 "다시
    // 로그인해주세요" 경고가 뜬다. classifySessionLossSignal로 "분석 도중 진짜로 끊긴 것"과 "이 몰은
    // 애초에 신호가 없는 것"을 가른다.
    //
    // 시작 시점엔 true였는데 끝에서만 false인 경우(정글북 실사용 확인, 2026-09-16)는 또 다르다: 이
    // 몰의 access_token 쿠키가 30분 만료 JWT라 새로고침 타이밍에 따라 "로그아웃" 버튼 유무가 실제 로그인
    // 상태와 무관하게 갈릴 수 있음을 Playwright로 같은 세션에서 5회 연속 재확인해 확정했다(카테고리
    // 확장 중 실제 로그인 차단은 hubExpansionHitLoginWall=false로 한 번도 없었는데 이 신호만 false).
    // 이런 애매한 경우(카테고리 확장 중 실제 차단은 없었음)만 한 번 더 새로고침해 재확인한다 — 정말 끊긴
    // 것이면 재확인에서도 false가 유지될 것이고, 타이밍 오탐이면 재확인에서 뒤집힌다.
    if (loggedIn === false && loggedInAtStart === true && !hubExpansionHitLoginWall) {
      await page.goto(startUrl, { waitUntil: 'load', timeout: 20_000 }).catch(() => {})
      loggedIn = await detectLoggedInSignal(page)
    }
    const verdict = classifySessionLossSignal({ loggedInAtStart, loggedInAtEnd: loggedIn, hubExpansionHitLoginWall })
    if (verdict === 'lost') {
      signals.sessionLostDuringAnalysis = true
      console.log(`[몰구조분석:${mallName}] 로그인 세션이 끊긴 것으로 보임(시작 시점 로그인됨=${loggedInAtStart}, 종료 시점 로그인됨=${loggedIn}, 카테고리 확장 중 로그인차단=${hubExpansionHitLoginWall}) — 다시 로그인해주세요`)
    } else if (verdict === 'unavailable') {
      signals.loginSignalUnavailable = true
      console.log(`[몰구조분석:${mallName}] 이 몰은 로그인 여부를 화면에서 확인할 신호가 없어 보임(시작 시점부터 로그인됨=${loggedInAtStart}) — 세션 끊김 경고 대신 몰 특성 안내로 대체`)
    }
  }
  logFinalStep()
  signals.totalElapsedSec = (Date.now() - profileStartedAt) / 1000
  signals.stepTimings = stepTimings
  return signals.sampleCount > 0 ? signals : null
}

/** 고도몰 등에서 결제계좌/택배사/업체연락처가 있는 곳은 상품페이지가 아니라 하단 회사정보와 이용안내·
 *  공지사항 같은 정적 게시판이다(실사용 몰 확인됨). 지금 페이지의 footer와, 안내성 키워드가 붙은 링크
 *  몇 개를 실제로 열어 텍스트를 모아온다 — "몰 구조분석"의 AI 리포트가 근거로 삼을 원문. */
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

/** MALL_REPORT_HINT_KEYWORDS 참고 — expandCategoryHubs가 카테고리 하위구조를 확인하며 이미 방문했던
 *  페이지 중, 결제/배송/재고/정렬 등 관련 키워드가 있었던 URL만 골라 다시 열어 상세 텍스트를 뽑는다.
 *  홈/이용안내 페이지(gatherMallContextText)만으론 못 찾는 정보(특정 카테고리 안내문에만 있는 배송
 *  공지 등)를 보강하고, "AI에게 원문 20,000자를 통째로 주고 알아서 찾게" 하는 대신 이미 걸러진 후보만
 *  주는 게 더 빠르고 정확할 거라는 사용자 제안(2026-09-02, Ollama가 이 리포트 하나에 8분을 줘도 못
 *  끝내는 걸 실측으로 확인한 뒤 나온 아이디어). 최대 5개만 다시 방문한다(무한정 안 늘어나게 — 이미
 *  한 번 열어본 페이지를 또 여는 비용이 있다). */
async function gatherCategoryPageHints(context: BrowserContext, page: Page, hrefs: string[], signal?: AbortSignal, siteId?: number): Promise<string> {
  const targets = hrefs.slice(0, 5)
  if (!targets.length) return ''
  // 세션이 끊긴 채 방문하면 로그인 페이지 텍스트가 "참고자료"로 그대로 섞여 들어간다 — 샘플 상품 확인과
  // 같은 이유로 방문마다 loginIfNeeded를 건다(사용자 지시, 2026-09-15).
  const hintLoginCreds = siteId != null
    ? await siteInfo(siteId).then(s => (s.loginId && s.loginPw ? { loginId: s.loginId, loginPw: s.loginPw } : null)).catch(() => null)
    : null
  const sections: string[] = new Array(targets.length)
  await mapWithPageWorkers(context, page, targets, MALL_PROFILE_CONCURRENCY, async (href, i, workerPage) => {
    try {
      await gotoViaLinkClick(workerPage, href, { waitUntil: 'load', timeout: 15_000 })
      if (hintLoginCreds && await loginIfNeeded(workerPage, { url: href, ...hintLoginCreds }).catch(() => false)) {
        await gotoViaLinkClick(workerPage, href, { waitUntil: 'load', timeout: 15_000 }).catch(() => {})
      }
      const text = await workerPage.evaluate(() => document.body.innerText).catch(() => '')
      if (text.trim()) sections[i] = `[카테고리 페이지(참고자료로 선별됨): ${href}]\n${text.replace(/\s+/g, ' ').trim().slice(0, 2_000)}`
    } catch { /* 다시 방문 실패해도 나머지 흐름은 계속 — 이건 보강 자료일 뿐이라 없어도 무방하다 */ }
  }, signal)
  return sections.filter(Boolean).join('\n\n')
}

async function gatherMallContextText(page: Page, context: BrowserContext, signal?: AbortSignal, siteId?: number): Promise<string> {
  const sections: string[] = []
  // 이용안내/배송/회사소개 등 안내 페이지 방문 중 세션이 끊기면 로그인 페이지 텍스트가 "회사정보"로
  // 잘못 섞여 들어간다 — 샘플 상품 확인과 같은 이유로 방문마다 loginIfNeeded를 건다(사용자 지시, 2026-09-15).
  const infoLoginCreds = siteId != null
    ? await siteInfo(siteId).then(s => (s.loginId && s.loginPw ? { loginId: s.loginId, loginPw: s.loginPw } : null)).catch(() => null)
    : null
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
  const validLinks = links.filter(link => link.href.startsWith(baseUrl))
  // 최대 4개(findInfoPageLinks 참고)뿐이지만 하나하나가 실제 페이지 이동(최대 15초)이라 순차로는 최악의
  // 경우 1분 가까이 걸린다 — 위 샘플 상품 병렬화와 같은 이유로 여러 탭에 나눠 동시에 방문한다
  // (2026-08-22). 링크 순서와 무관하게 섞여도 되는 참고용 텍스트라 index로 위치만 맞춰 합친다.
  const infoSections: string[] = new Array(validLinks.length)
  await mapWithPageWorkers(context, page, validLinks, MALL_PROFILE_CONCURRENCY, async (link, i, workerPage) => {
    try {
      // gotoViaLinkClick: gotoViaLinkClick 정의부 주석 참고.
      await gotoViaLinkClick(workerPage, link.href, { waitUntil: 'load', timeout: 15_000 })
      if (infoLoginCreds && await loginIfNeeded(workerPage, { url: link.href, ...infoLoginCreds }).catch(() => false)) {
        await gotoViaLinkClick(workerPage, link.href, { waitUntil: 'load', timeout: 15_000 }).catch(() => {})
      }
      const text = await workerPage.evaluate(() => document.body.innerText).catch(() => '')
      const parts: string[] = []
      if (text.trim()) parts.push(`[${link.text}]\n${text.replace(/\s+/g, ' ').trim().slice(0, 2_500)}`)
      const imageHints = await workerPage.evaluate(collectImageHintsScript, null).catch(() => [] as string[])
      if (imageHints.length) parts.push(`[${link.text} 페이지 이미지 설명/파일명]\n${imageHints.join(', ')}`)
      infoSections[i] = parts.join('\n\n')
    } catch { /* 게시판 접근 실패(로그인 필요 등)는 건너뛰고 다음 링크로 */ }
  }, signal)
  sections.push(...infoSections.filter(Boolean))
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
    await context.addInitScript(polyfillEsbuildNameHelper)
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
  // detailUrlPattern에 SEO형 URL(/product/상품명/번호/category/번호/display/순서/)도 같이 인정한다 —
  // detectMallPlatform은 generator 메타/cafe24.com CDN 호스트만으로 platform:'cafe24'를 판정해, SEO
  // URL만 쓰는(고전형 /product/detail.html을 아예 안 쓰는) 카페24 몰도 이 platform으로 분류된다. 그런
  // 몰은 옛 패턴만 있으면 scanForProducts의 platformSel 매칭도, 그다음 범용 폴백(detailRe가 있으면
  // 여전히 적용됨)도 전부 상품 URL 하나 못 찾고 0개로 끝난다 — extension-poc/background.js의
  // isProductLink는 처음부터 이 SEO 패턴을 인식해왔는데 서버 쪽만 안 맞춰져 있었다(2026-09-05 전수조사).
  cafe24:   { productLinkSelector: '.xans-product-listmain a, ul.prdList li a, .prdList .thumbnail a', nextPageSelector: '.xans-product-listpagination a.next', detailUrlPattern: /\/product\/detail\.html|\/product\/.+\/\d+\/category\/\d+\/display\/\d+/ },
  makeshop: { productLinkSelector: '.item_gallery_type a, .prd_list_wrap a', nextPageSelector: '.paging a.next', detailUrlPattern: /shopdetail\.html\?branduid=/ },
  // 고도몰5(신형) 스킨은 상품 상세 URL이 구형(goods_view.php?goodsno=)과 완전히 다르다(/goods/view?no=,
  // 도매토피아 실사용 확인, 2026-08-19) — 클래스명도 .goodsDisplayItemWrap 등으로 바뀌어 구형 셀렉터가
  // 아예 안 맞지만, detailUrlPattern만 맞으면 countProductsOnPage의 범용 폴백(플랫폼 셀렉터가 0개
  // 찾으면 자동으로 넘어감)이 이 URL 패턴으로 정확히 걸러내므로 productLinkSelector에 신형 클래스도
  // 같이 넣어두는 정도로 충분하다.
  godomall: { productLinkSelector: '.item_cont a, .goods_list a, .goodsDisplayItemWrap a', nextPageSelector: '.paginate a.next', detailUrlPattern: /goods_view\.php\?goodsno=|\/goods\/view\?no=\d+/ },
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
    const godoDetailRe = /goods_view\.php\?goodsno=|\/goods\/view\?no=\d+/
    if (generator.includes('godo') || hasHost('godomall') || godoDetailRe.test(url) || anyLinkMatches(godoDetailRe)) return 'godomall'
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
// 납품사례/제작문의/도매인증/상품문의: 도매(B2B) 몰 상단에 흔한 "회원가입 유도/문의" 성격의 메뉴로,
// 실제 상품 카테고리가 아니다(모자사러 실사용 확인, 2026-08-16 — 진짜 카테고리(캡모자/버킷햇 등)가
// 담긴 메뉴는 래퍼 div가 여러 겹이라 못 찾고, 이 문의성 메뉴만 카테고리로 잘못 집어온 사례).
// 회원 정보/적립금 현황/관심상품/최근 본상품: "마이페이지" 플라이아웃 메뉴의 하위 항목들 — 부모 자신은
// 이미 "마이페이지"에 걸려 제외되지만, 이 몰(신우, godomall)은 이 항목들이 부모 라벨 없이 그 자체로
// 최상위 메뉴 항목이라 안 걸러졌다(신우 실사용 확인, 2026-08-25 — 로컬 Ollama가 타임아웃 나 규칙 기반
// 폴백으로 떨어졌을 때 이 위젯을 카테고리 메뉴로 잘못 집어옴).
// 정보수정: "회원정보"와 달리 "정보수정"(걸스굽의 "FAVORITE MENU > 정보수정" 등)은 위 회원\s*정보
// 패턴에 안 걸려 scanCategoryOverviewPage("제목+목록" 구조 스캔)가 카테고리로 잘못 집어왔다 — 이
// 페이지(/member/modify.html류)는 비밀번호 재확인 입력창이 있어 countProductsOnPage의 isLoginPage를
// 오탐시켜 실제로는 멀쩡한 실행에서도 "로그인 세션이 끊긴 것으로 보임" 경고가 매번 떴다(2026-09-02,
// 걸스굽 실사용 확인).
// 기획전: 카페24가 "goods_exhibit" 외에 "project.html?cate_no=" 같은 다른 경로로도 기획전(프로모션 배너)
// 페이지를 만든다(도매신 실사용 확인, 2026-09-17 — "샘플 기획전"이 "하위 카테고리 가져오기"에 잘못
// 딸려옴) — 경로 패턴은 몰마다 달라 못 미더우니, 더 안정적인 라벨 텍스트("기획전")로 막는다.
const NON_CATEGORY_TEXT_RE = /로그인|회원가입|로그아웃|장바구니|마이페이지|고객센터|검색어?|주문|배송조회|결제|사이트맵|관리자|촬영명령|입고대?기|입고대령|단가\s*(인상|조정)|재진행|색상?\s*(별)?\s*분류|공지사항|공지\b|납품\s*사례|제작\s*문의|도매\s*인증|상품\s*문의|회원\s*정보|정보\s*수정|적립금|관심\s*상품|최근\s*본\s*상품|위시\s*리스트|찜\s*(목록)?|기획전|notice|cart|login|logout|mypage|search|sitemap|wishlist/i

// 공지/문의/후기 등 게시판 글은 플랫폼 무관하게 URL 경로에 거의 항상 board/bbs 세그먼트를 쓴다(카페24
// board/view.php, 고도몰 bbs/board.php 등) — deriveCategoryUrlPattern(학습)과 scanByKnownUrlPattern
// (그 학습된 패턴의 재사용) 양쪽에서 이 경로의 링크는 이름과 무관하게 처음부터 후보에서 뺀다.
// NON_CATEGORY_TEXT_RE(이름 기반)만으로는 막지 못한 사고가 실제로 있었다(2026-08-30, 소꿉노리 — 공지/
// 문의 게시글이 한 번 "카테고리"로 잘못 저장되자, 그 URL들의 공통 쿼리파라미터(bdId)가 "이 몰의 카테고리
// URL 패턴"으로 학습돼버렸다. scanByKnownUrlPattern은 이름을 보지 않고 그 패턴에 맞는 링크를 전부
// 받아들이므로, 이후 "카테고리 불러오기"/"몰 구조분석"을 몇 번을 다시 돌려도 매번 같은 오염이 재생산돼
// 발견된 카테고리 59개 전부가 게시판 글이었다 — 규칙 기반 탐지가 한 번이라도 만든 학습 결과는 이렇게
// 스스로 강화되며 영구화될 수 있어, 이 경로 필터를 학습/재사용 두 지점 모두에 넣어 다음 실행이 스스로
// 회복(구조 스캔/AI로 다시 폴백)할 수 있게 한다.
//
// mypage(마이페이지, 나의 문의내역 등 개인 회원 전용 영역)도 같은 이유로 여기 추가한다(2026-09-11,
// 도매토피아 실사용 확인) — /mypage/myqna_catalog(나의 1:1문의 내역) 같은 링크가 "1:1문의" 같은 라벨로
// 카테고리 후보에 섞여 들어왔는데, NON_CATEGORY_TEXT_RE는 정확히 이 라벨 문구를 걸러낼 패턴이 없었다.
// 더 근본적인 문제는 따로 있다: 이 페이지는 게시판 목록이라 "상품 0개"인데, 개별 글의 "비밀글" 보기용
// 비밀번호 입력창이 목록 화면에도 있어 isLoginPage(countProductsOnPage — 페이지 어딘가에 input[type=
// password]가 있으면 무조건 true)가 오탐, expandOne의 "isLoginPage && count===0 → 로그인 벽" 판정을
// 그대로 통과시켜 세션은 멀쩡한데도(detectLoggedInSignal은 항상 true) "몰 구조분석" 돌릴 때마다 매번
// "로그인 세션이 끊긴 것으로 보임" 경고가 떴다 — 실제로는 이 링크 자체가 애초에 카테고리가 아니었던 게
// 원인이라, isLoginPage 판정을 건드리는 대신 여기서 후보 자체를 걸러내는 쪽이 더 근본적이고 안전하다.
// goods_exhibit(전시관/기획전 배너 페이지)도 같은 이유로 추가한다(2026-09-12, 투비즈온 실사용 확인) —
// "도매자동차용품"/"도매가구" 같은 기획전 링크 라벨이 진짜 카테고리명과 문구만으로는 구분이 안 될 만큼
// 그럴듯한 데다, 그 페이지 자체가 실제 상품을 진열해두고 있어 countProductsOnPage 검증(표본검증)까지
// 통과해버렸다 — AI가 진짜 카테고리(여성의류 등) 대신 이 기획전 목록을 카테고리로 통째로 잘못 채택함.
const NON_CATEGORY_PATH_RE = /\/(board|bbs|mypage)\/|goods_exhibit/i

// 카페24는 배너 위젯에 이미지/링크를 설정하지 않으면 렌더링되지 않은 템플릿 토큰(`{$js-banner}`,
// `{$js-href}` 등, URL에서는 `%7B%24...%7D`로 인코딩됨)이 href/앵커 텍스트에 그대로 남는다. 이런 배너는
// screenCheckAndRecover의 "직전 결과 대조" 복구가 문제다 — 그 복구는 "href를 다시 열어보니 상품이
// 있다"만 보고 되살리는데, 배너의 href가 하필 실제 상품 페이지로 연결돼 있으면(도매신 실사용 확인,
// 2026-09-17: "WOMEN SHOES > 링크 > 링크"/"WOMEN SHOES > {$js-banner}"가 화면에는 전혀 안 보이는데도
// 몰구조분석을 다시 돌릴 때마다 계속 되살아남) 이름이 깨졌는데도 표본검증(상품 존재 여부만 봄)을 통과해
// 버려 한 번 오염되면 스스로 안 없어진다. 링크의 유일한 텍스트가 "링크"뿐이거나(빈 배너의 흔한 placeholder
// 앵커 텍스트) 이름/href에 미렌더링 템플릿 토큰이 남아있으면 아예 후보에서 제외해 이 악순환을 끊는다.
const BROKEN_TEMPLATE_TOKEN_RE = /\{\$|%7B%24/i
export function isBrokenPlaceholderCategoryName(name: string): boolean {
  const leaf = name.split(' > ').pop()?.trim() ?? ''
  return leaf === '링크' || BROKEN_TEMPLATE_TOKEN_RE.test(name)
}

/** NON_CATEGORY_PATH_RE 검사용 — AI가 돌려준 href는 형식이 보장되지 않아(상대경로, 빈 문자열 등) new URL()이
 *  던질 수 있다. 파싱 실패하면 board 경로가 아니라고 본다(모르는 걸 의심해서 지우기보단, 확실한
 *  신호가 있을 때만 배제한다는 이 필터들의 기본 원칙과 같다). */
function safePathname(href: string): string {
  try { return new URL(href).pathname } catch { return '' }
}

/** 카테고리 후보를 걸러내는 3가지 검사(이름 기반 NON_CATEGORY_TEXT_RE, 경로 기반 NON_CATEGORY_PATH_RE,
 *  깨진 배너 placeholder 판정 isBrokenPlaceholderCategoryName)를 한 곳에 묶는다 — 이 셋을 따로따로
 *  호출하는 필터가 카테고리 탐지 파이프라인 곳곳(비전/AI/DOM 스캔/하위 카테고리 확장 등)에 여러 벌
 *  퍼져있다 보니, 셋 중 하나를 빠뜨린 곳(lib/scraper.ts의 expandCategoryChildren)에서 실제 사고가
 *  났다(도매신 실사용 확인, 2026-09-17 — "하위 카테고리"로 WOMEN SHOES를 펼쳤더니 무관한 배너/기획전
 *  링크가 딸려옴). 앞으로 필터를 추가하거나 고칠 땐 이 함수 하나만 고치면 모든 호출부에 반영된다. */
export function isNonCategoryCandidate(name: string, href: string): boolean {
  return NON_CATEGORY_TEXT_RE.test(name) || NON_CATEGORY_PATH_RE.test(safePathname(href)) || isBrokenPlaceholderCategoryName(name)
}

/** "대분류 자신의 href와 겹치면 GNB 재검출로 보고 제외" 판정(topLevelHrefSet)에 쓰는 href 비교 키 —
 *  같은 카테고리 페이지라도 www 유무만 다른 호스트로 열릴 수 있어(소꿉노리 실사용 확인, 2026-09-08:
 *  "기타 패브릭" 허브 페이지가 www 없는 호스트로 로드되며, 그 페이지에서 다시 찾은 사이트 전체 GNB
 *  링크들의 href가 전부 www 없는 형태라 topLevelHrefSet의 www 있는 href와 문자열이 안 맞아 "진짜 하위
 *  메뉴"로 오판됨 — 그 결과 "기타 패브릭 > 신상품", "기타 패브릭 > 데코소품 > 마블소품"처럼 사이트
 *  전체 메뉴가 그대로 복제돼 카테고리 개수가 58개에서 115개로 거의 두 배가 됐다), 문자열 그대로
 *  비교하면 이 케이스를 놓친다. */
function canonicalizeHref(href: string): string {
  return href.replace(/^(https?:\/\/)www\./, '$1')
}

export interface CategoryMenuScanResult {
  links: CategoryMenuLink[]
  /** <li> 안에 글자가 전혀 없어(이미지 스프라이트/아이콘 폰트 메뉴 등) 이름을 못 지은 항목의 href —
   *  호출부가 discoverCategoriesByVisitingLinks로 실제 방문해 이름을 채워야 한다. */
  textlessHrefs: string[]
  /** 서로 다른 "그룹"(같은 tier 안에서 최소 2개 이상의 항목을 낸 후보 root)의 수 — 대분류 탭이 여러
   *  개인 몰(투비즈온처럼 그룹마다 별도 <ul>인 메가메뉴 등)에서 "지금 이 결과가 그 그룹 중 일부만
   *  담았는지"를 discoverCategoryMenuByVision의 완결성 검증(화면에 보이는 그룹 수와 비교)이 판단할 수
   *  있게 한다(사용자 지시, 2026-09-12 — "사람이 보는 화면을 기준으로 카테고리가 어디까지인지 먼저
   *  확인"). 옵션으로 둔 이유는 이 필드가 필요 없는 기존 호출부/폴백 리터럴을 전부 고치지 않기 위함 —
   *  없으면(undefined) "모른다"로 취급한다. */
  groupCount?: number
}

// 실제 브라우저(getComputedStyle)가 있어야 검증 가능한 로직(플랫 앵커 그리드 패턴)이 있어, 테스트에서
// 실제 페이지를 띄워 직접 호출할 수 있도록 export한다(nthHeaderIconCandidate와 같은 이유).
/** tsx(esbuild `--keep-names`)는 이 파일의 함수를 컴파일할 때 이름이 있는 내부 함수/상수마다
 *  `__name(fn, "fn")` 헬퍼 호출을 소스에 끼워넣는다(함수가 번들 과정에서 리네임되더라도 `.name`을
 *  보존하기 위한 esbuild의 의도된 동작). 문제는 Playwright의 `page.evaluate(fn, arg)`가 `fn`을
 *  `Function.prototype.toString()`으로 문자열로 뜬 뒤 그 문자열을 브라우저 컨텍스트에서 그대로 다시
 *  실행한다는 점이다 — 브라우저 쪽엔 `__name`이 없으니 `ReferenceError: __name is not defined`로
 *  터진다. 이 프로젝트에서 실제로 걸린 사례: `scanCategoryMenu`가 이 문제로 호출할 때마다 조용히
 *  실패해(자체 `.catch()`가 삼킴, 에러 로그 한 줄도 안 남음) 카테고리 계층(대분류>중분류)을 한 번도
 *  못 읽고 있었다 — 걸스굽 몰구조분석 결과가 계층 없이 평평하게 나온 진짜 원인(2026-09-24, 직접 재현
 *  확인: `scanCategoryMenu`/`collectAllPageLinks`를 실제로 호출해 같은 에러 재현). tsx 메인테이너도
 *  "고칠 버그가 아니라 알려진 제약"이라고 답한 사안이다(https://github.com/privatenumber/tsx/issues/113).
 *
 *  해결: 함수 소스를 **런타임에 일반 문자열로부터** `new Function(...)`으로 만들면, esbuild는 그
 *  문자열의 "내용"까지는 코드로 취급해 변환하지 않으므로(문자열은 esbuild 입장에서 그냥 데이터) `__name`이
 *  안 끼어든다 — 동시에 실제 `Function` 인스턴스이므로 Playwright가 `typeof fn === 'function'`으로
 *  판별해 인자를 정상적으로 넘겨 호출한다(문자열을 직접 `page.evaluate(str, arg)`로 넘기면 Playwright가
 *  `isFunction:false`로 취급해 호출 자체를 안 하고 `arg`도 무시한다 — 직접 실측 확인, 2026-09-24).
 *  대가: 문자열 안에서는 TypeScript 타입 표기를 못 쓴다(순수 JS여야 함) — 이 함수 하나만 우선 이 패턴으로
 *  옮긴다(사용자 지시, 2026-09-24 — 범위는 좁게, 다른 곳은 나중에 필요할 때 같은 패턴을 재사용). */
function compileBrowserEvalFn<Arg, R>(jsSource: string): (arg: Arg) => R | Promise<R> {
  // new Function은 위 주석 참고 — 의도적으로 esbuild의 정적 변환(과 그로 인한 __name 주입)을 피하기 위함
  return new Function(`return (${jsSource})`)() as (arg: Arg) => R | Promise<R>
}

// scanCategoryMenu의 page.evaluate 콜백 — compileBrowserEvalFn 주석 참고. 원래 TypeScript로 쓰여 있던
// 것과 로직은 동일하고(타입 표기만 제거, 템플릿 리터럴 2곳만 문자열 접합으로 변경 — 이 문자열 자체가
// 백틱으로 감싸이므로 안쪽에 백틱을 못 쓴다), 그 외 주석/조건/순서는 원본 그대로 보존한다.
const SCAN_CATEGORY_MENU_FN = compileBrowserEvalFn<{ excludeSrc: string }, CategoryMenuScanResult>(`
  ({ excludeSrc }) => {
    const excludeRe = new RegExp(excludeSrc, 'i')
    // 이미지 스프라이트/아이콘 폰트 메뉴처럼 <li> 안에 글자가 전혀 없어 이름을 지을 수 없는 항목의 href만
    // 따로 모아둔다 — 예전엔 이 경우 그냥 버렸는데, 같은 몰의 다른 메뉴 영역이 텍스트로 잘 읽혀 카테고리를
    // 이미 몇 개 찾았어도(그러면 아래 tier loop가 그 tier에서 멈춤) 이 그룹 자체는 항목 전부가 이미지뿐이라
    // "최소 2개 이상의 텍스트" 조건에 걸려 통째로 버려지므로, 그 안의 카테고리들이 영원히 누락됐다
    // (진짜양말 실사용 확인, 2026-08-13 — "신발"/"업데이트" 카테고리가 이 방식으로 빠짐).
    const textlessHrefs = []
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
    const isMeaningful = (s) => !!s && /[가-힣a-zA-Z0-9]/.test(s)
    // li 자신의 라벨은 거의 항상 li 바로 아래 <a>(카테고리 링크) 안에 있다 — 그 링크 하나만 콕 집어
    // 읽으면 하위 서브메뉴가 어떤 모양(ul/li, dl/dd, 장식용 div 등)이든 안전하게 걸러진다(모자사러
    // 실사용 확인, 2026-08-16 — 하위 메뉴가 <div><dl><dd>라 ul/ol만 지우는 예전 방식으론 "캡모자" 옆에
    // 하위 이름들과 깨진 이미지 placeholder("undefined")까지 그대로 섞여 들어왔다). 링크가 없는 몰(라벨이
    // 그냥 텍스트인 경우)만 기존 방식(사본에서 중첩 목록 제거 후 읽기)으로 대체한다.
    function ownText(li) {
      const ownAnchor = li.querySelector(':scope > a')
      if (ownAnchor) {
        const anchorText = (ownAnchor.textContent || '').trim()
        if (anchorText) return anchorText
        // 글자가 전혀 없으면(이미지 스프라이트 카테고리 메뉴) <img alt>를 이름으로 대신 쓴다 — 펫토리
        // 실사용 확인(2026-08-16): 이 몰은 카테고리 목록 페이지 자체가 회원 전용(로그인 리다이렉트)이라
        // 방문해서 이름을 되찾는 기존 폴백(discoverCategoriesByVisitingLinks)도 항상 "로그인"만 읽어와
        // 실패했다 — alt에 이미 진짜 이름이 있으니 방문할 필요 없이 여기서 바로 쓴다.
        const imgAlt = (ownAnchor.querySelector('img[alt]'))?.alt.trim()
        if (imgAlt) return imgAlt
      }
      const clone = li.cloneNode(true)
      clone.querySelectorAll('ul, ol').forEach(n => n.remove())
      return (clone.textContent || '').trim()
    }
    // 하위 <ul>(다음 레벨) 안의 <a>까지 섞이지 않도록, li 바로 안(중첩 목록 제외)의 첫 링크만 이 항목의
    // 실제 이동 URL로 본다 — "카테고리 불러오기"가 이름뿐 아니라 클릭해서 스크랩할 수 있는 링크도 함께
    // 쓸 수 있도록 하기 위함(예전엔 이름만 남기고 버렸다).
    // <a href> 없이 onclick="location.href='...'"(또는 location='...')만으로 이동하는 구형 몰 메뉴용
    // 폴백 — 도매의신 실사용 확인(2026-08-26): 카테고리 메뉴 전체가 <li onclick="location.href='shop.html
    // ?p=list.html&cid=632';">처럼 <a> 태그 없이 JS onclick만으로 이동한다(메뉴 자체는 display:none일
    // 뿐 최초 HTML에 이미 다 있어, JS 실행 없이 속성만 읽으면 된다). li 자신에 없으면 안쪽 자손도 한 번
    // 더 살펴본다(라벨이 span 등 다른 태그에 onclick을 다는 몰 대비).
    function hrefFromOnclick(el) {
      const raw = el.getAttribute('onclick') || el.querySelector('[onclick]')?.getAttribute('onclick') || ''
      const m = raw.match(/location(?:\\.href)?\\s*=\\s*['"]([^'"]+)['"]/)
      if (!m) return ''
      try { return new URL(m[1], location.href).href } catch { return '' }
    }
    function ownHref(li) {
      const clone = li.cloneNode(true)
      clone.querySelectorAll('ul, ol').forEach(n => n.remove())
      const href = (clone.querySelector('a[href]'))?.href || ''
      // href="#"(빈 프래그먼트만 있는, 실제로는 아무 데도 안 가는 드롭다운 토글/장식용 링크)는 .href로
      // 읽으면 "현재 페이지 URL + #"으로 resolve된다 — 이걸 실제 카테고리로 취급하면, 하필 그 페이지가
      // (홈페이지처럼) 그 자체로 상품 목록이기도 한 몰에서는 "홈페이지 전체"가 가짜 카테고리 하나로
      // 둔갑해 이미 다른 진짜 카테고리에서 센 상품과 통째로 중복 집계된다(실사용 확인, 2026-08-25 —
      // 가방쟁이에서 이 가짜 카테고리 하나가 미리보기 총 개수를 592개 부풀림).
      if (href) return href.endsWith('#') ? '' : href
      return hrefFromOnclick(clone)
    }
    // 카페24 표준 카테고리 템플릿은 실제로 3단계 하위가 하나도 없어도 자리표시자
    // <ul class="...categorylist sub"><li><a href=".../list.html?cate_no="></a></li></ul>를 항상 DOM에
    // 남겨둔다(이름 없음, href는 있지만 cate_no= 뒤에 값이 비어있음) — "이 li는 자식이 있다"고 그대로
    // 믿으면, 실제로는 leaf인 2단계 카테고리(예: "패션 양말")가 이 빈 자리표시자 하나 때문에 "그 아래로
    // 내려가라"는 판정을 받고, 정작 내려간 자리표시자 자체는 이름도 href도 못 써서 아무것도 안 남아 결국
    // "패션 양말" 자체가 통째로 사라진다(진짜양말 실사용 확인, 2026-09-06 — AI가 대분류만 찾고 하위
    // 메뉴를 하나도 못 찾음). 자식으로 인정하려면 이름이 있거나, href가 있어도 이 자리표시자 패턴(쿼리
    // 파라미터 값이 비어 "="로 끝남)이 아니어야 한다.
    function isPlaceholderHref(href) {
      return /[?&][\\w-]+=$/.test(href)
    }
    function isRealChildCandidate(el) {
      if (isMeaningful(ownText(el))) return true
      const href = ownHref(el)
      return !!href && !isPlaceholderHref(href)
    }
    function buildPaths(li, prefix, depth, out) {
      if (depth > 3 || out.length > 200) return
      const childLis = Array.from(li.querySelectorAll(':scope > ul > li, :scope > div > ul > li'))
      const hasRealChildLis = childLis.some(isRealChildCandidate)
      const name = ownText(li)
      if (!isMeaningful(name)) {
        // 이름은 못 지어도(리프일 때만) href는 있을 수 있다 — textlessHrefs에 남겨 나중에 방문 검증한다.
        // 다만 로그아웃/장바구니 등 아이콘형(텍스트 없는) 메뉴는 excludeRe(NON_CATEGORY_TEXT_RE)를 이름이
        // 아니라 href 자체에 대고 미리 걸러야 한다 — 이름이 없어 위 excludeRe.test(name) 자체를 못 타는
        // 항목이라, 방문(discoverCategoriesByVisitingLinks의 page.goto)만으로 로그아웃 같은 부작용이
        // 일어나는 링크를 걸러낼 방법이 여태 없었다(걸스굽 실사용 확인, 2026-09-01 — "몰 구조분석" 중
        // 로그인 창이 로그아웃 상태로 바뀌는 사고 — 방문 "후"에 목적지 페이지 라벨로 판정하는 기존 필터로는
        // 이미 로그아웃된 뒤라 늦다).
        if (!hasRealChildLis) {
          const href = ownHref(li)
          if (href && !excludeRe.test(href)) textlessHrefs.push(href)
        }
        return
      }
      if (excludeRe.test(name)) return // 이 라벨 자체가 카테고리가 아니면 하위 항목까지 통째로 건너뜀
      const path = [...prefix, name]
      if (hasRealChildLis) {
        childLis.forEach(sub => buildPaths(sub, path, depth + 1, out))
      } else {
        const href = ownHref(li)
        if (href) out.push({ name: path.join(' > '), href })
      }
    }
    // 후보 root가 탭 위젯(예: el-tab류 — <li data-tabid="tab1"><a>강아지</a></li> + <div id="tab1">그 탭
    // 내용</div>) 안에 있으면, 그 탭 버튼의 라벨을 찾아 돌려준다. 못 찾으면 null(이 몰이 탭 구조가
    // 아니거나 못 알아본 스킨) — 그러면 호출부가 그냥 이름을 안 건드리고 그대로 쓴다.
    function findTabLabel(root) {
      let el = root
      while (el) {
        if (el.id) {
          const label = document.querySelector('[data-tabid="' + el.id + '"]')?.textContent?.trim()
          if (label) return label
        }
        el = el.parentElement
      }
      return null
    }
    for (const tierSelector of SELECTOR_TIERS) {
      let candidates
      try { candidates = Array.from(document.querySelectorAll(tierSelector)) } catch { continue }
      // 한 티어 안에서도 후보가 여러 개 나올 수 있다 — 헤더 카테고리 + 전체메뉴 플라이아웃 사본처럼 같은
      // 메뉴의 중복일 수도 있고(아래 href dedup으로 걸러짐), 펫투비처럼 "강아지"/"고양이" 탭마다 완전히
      // 별개인 카테고리 목록이 DOM에 각자 따로 존재하는 경우도 있다(탭 전환은 보이는 것만 바뀔 뿐 둘 다
      // 항상 DOM에 있음, 2026-08-10 실사용 확인 — 후보 하나만 골라 버리면 다른 탭 카테고리를 통째로
      // 놓쳤다). "최소 2개 이상" 조건으로 노이즈(카테고리 메뉴가 아닌 다른 위젯)를 거른 뒤, 통과한
      // 후보는 전부 합친다(href 기준 dedup — 이름이 같아도 href가 다르면 별개 카테고리로 본다).
      const groups = []
      const groupLabels = new Set()
      for (const root of candidates) {
        // slick.js 등 캐러셀 라이브러리가 상단 카테고리 목록에 적용되면(실사용 확인: 오토카필 —
        // 5개 대분류+서브카테고리 전체가 <ul class="... gnb_menu0">인데 slick이 초기화되면서
        // "한 번에 보여주는 개수"(예: 4개)만 :scope > li로 남고 나머지는 .slick-slide로 한 겹 더
        // 감싸져 shallow 패턴에 안 걸린다 — 실제로는 진짜 카테고리 목록인데 "일부만 보이는 위젯"으로
        // 오판해 나머지 대분류(인테리어몰딩/익스테리어몰딩 등)를 통째로 놓쳤다) 그 안의 li도 추가로 본다.
        let topLis = Array.from(root.querySelectorAll(':scope > ul > li, :scope > li, :scope > div > ul > li, :scope .slick-slide > li'))
        // 위 고정 깊이 패턴은 래퍼 <div>가 정확히 0~1겹일 때만 잡는다 — 모자사러처럼 실제 카테고리 메뉴가
        // <div class="xans-layout-category"><div class="scrollbar_box"><div class="position"><ul class="d1-Depth">
        // 처럼 2겹 이상 감싸져 있으면 위 어떤 패턴에도 안 걸려 0개로 나오고, 같은 티어의 다른(진짜 카테고리가
        // 아닌) 후보만 남아 그게 그대로 결과가 돼버린다(실사용 확인, 2026-08-16 — "납품사례/제작문의/
        // 도매인증/상품문의"만 나오고 실제 모자 카테고리는 통째로 빠짐). 고정 패턴이 하나도 못 찾았을 때만,
        // 이 root 안에서 처음 만나는 <ul>을 진짜 메뉴로 보고 그 바로 아래 <li>를 대신 쓴다.
        if (!topLis.length) {
          const firstUl = root.querySelector('ul')
          if (firstUl) topLis = Array.from(firstUl.querySelectorAll(':scope > li'))
        }
        const out = []
        topLis.forEach(li => buildPaths(li, [], 0, out))
        const seenNames = new Set()
        const uniq = out.filter(o => (seenNames.has(o.name) ? false : (seenNames.add(o.name), true)))
        if (uniq.length < 2) continue
        const label = findTabLabel(root)
        if (label) groupLabels.add(label)
        groups.push({ label, items: uniq })
      }
      // 합쳐진 후보가 서로 다른 탭(라벨) 2개 이상에서 왔을 때만 이름 앞에 그 탭 라벨을 붙인다 — "사료"가
      // 강아지/고양이 양쪽에 다 있으면 이름만 보고는 구분이 안 되므로(2026-08-11 실사용 확인). 탭 구조가
      // 아닌 몰(대부분)은 groupLabels가 비어있어 이름을 그대로 둔다.
      const merged = []
      const seenHrefs = new Set()
      for (const { label, items } of groups) {
        for (const o of items) {
          if (seenHrefs.has(o.href)) continue
          seenHrefs.add(o.href)
          merged.push({ name: groupLabels.size > 1 && label ? (label + ' > ' + o.name) : o.name, href: o.href })
        }
      }
      if (merged.length) {
        const mergedHrefSet = new Set(merged.map(m => m.href))
        return {
          links: merged, textlessHrefs: [...new Set(textlessHrefs)].filter(h => !mergedHrefSet.has(h)),
          groupCount: groups.length,
        }
      }
    }
    return { links: [], textlessHrefs: [...new Set(textlessHrefs)] }
  }
`)

export async function scanCategoryMenu(page: Page): Promise<CategoryMenuScanResult> {
  return page.evaluate(SCAN_CATEGORY_MENU_FN, { excludeSrc: NON_CATEGORY_TEXT_RE.source })
    .catch(() => ({ links: [], textlessHrefs: [] }))
}

/** scanCategoryMenu의 무(無)브라우저 버전 — 서버가 최초에 내려준 원본 HTML을 cheerio로 파싱해 같은
 *  판정 기준(SELECTOR_TIERS/최소 2개/제외 정규식)을 적용한다. 슬라이더·캐러셀 라이브러리(slick.js 등)가
 *  상단 카테고리 메뉴에 적용된 몰은, 초기화 후 브라우저 라이브 DOM에서는 "한 번에 보여주는 개수"만
 *  :scope > li로 남고 나머지 대분류가 구조상 통째로 사라진다(오토카필 실사용 확인 — 5개 대분류 중
 *  4개만 남고 인테리어몰딩 등 나머지가 안 잡힘). 원본 HTML은 이 JS가 손대기 전 상태라 전체 목록이
 *  그대로 있으므로, scanCategoryMenuRobust가 이 결과와 라이브 DOM 결과를 합쳐 누락을 메운다.
 *  탭 위젯 라벨 접두사(findTabLabel)는 이 무브라우저 경로에서는 재현하지 않는다 — 이름이 겹칠 수 있는
 *  드문 경우(펫투비류)의 부가 기능이라, 라이브 DOM 쪽 결과가 이미 그 케이스를 정확히 처리해 담당한다. */
export function scanCategoryMenuFromHtml(html: string, baseUrl: string): CategoryMenuScanResult {
  const $ = loadHtml(html)
  type CheerioNode = ReturnType<typeof $>[number]
  const textlessHrefs: string[] = []
  const isMeaningful = (s: string) => !!s && /[가-힣a-zA-Z0-9]/.test(s)
  const resolve = (href: string | undefined): string => {
    if (!href) return ''
    try {
      const resolved = new URL(href, baseUrl).href
      // scanCategoryMenu(라이브 DOM)의 ownHref와 같은 이유로 href="#"(빈 프래그먼트) 링크를 걸러낸다 —
      // 두 스캔 결과가 갈리지 않도록 항상 같이 맞춘다.
      return resolved.endsWith('#') ? '' : resolved
    } catch { return '' }
  }
  const ownText = (li: CheerioNode): string => {
    // scanCategoryMenu(라이브 DOM)의 ownText와 같은 이유(앵커 우선 읽기)로 맞춘다 — 두 스캔 결과가
    // 갈리지 않도록 항상 같이 맞춘다(2026-08-16, 모자사러/펫토리 실사용 확인).
    const ownAnchor = $(li).children('a').first()
    if (ownAnchor.length) {
      const anchorText = ownAnchor.text().trim()
      if (anchorText) return anchorText
      const imgAlt = (ownAnchor.find('img[alt]').first().attr('alt') || '').trim()
      if (imgAlt) return imgAlt
    }
    const clone = $(li).clone()
    clone.find('ul, ol').remove()
    return clone.text().trim()
  }
  // scanCategoryMenu(라이브 DOM)의 hrefFromOnclick과 같은 이유(onclick="location.href='...'"만으로
  // 이동하는 구형 몰 메뉴)로 맞춘다 — 두 스캔 결과가 갈리지 않게 항상 같이 맞춘다(2026-08-26).
  const hrefFromOnclick = (el: ReturnType<typeof $>): string => {
    const raw = el.attr('onclick') || el.find('[onclick]').first().attr('onclick') || ''
    const m = raw.match(/location(?:\.href)?\s*=\s*['"]([^'"]+)['"]/)
    return m ? resolve(m[1]) : ''
  }
  const ownHref = (li: CheerioNode): string => {
    const clone = $(li).clone()
    clone.find('ul, ol').remove()
    const href = resolve(clone.find('a[href]').first().attr('href'))
    return href || hrefFromOnclick(clone)
  }
  const childLisOf = (li: CheerioNode): CheerioNode[] => [
    ...$(li).children('ul').children('li').toArray(),
    ...$(li).children('div').children('ul').children('li').toArray(),
  ]
  // scanCategoryMenu(라이브 DOM)의 isPlaceholderHref/isRealChildCandidate와 같은 이유로 맞춘다 — 카페24
  // 표준 3단계 자리표시자(<li><a href=".../cate_no="></a></li>, 이름 없음)가 실제로는 leaf인 부모
  // 카테고리를 "자식이 있다"고 착각하게 만들어 통째로 사라지는 문제를 막는다.
  const isPlaceholderHref = (href: string): boolean => /[?&][\w-]+=$/.test(href)
  const isRealChildCandidate = (el: CheerioNode): boolean => {
    if (isMeaningful(ownText(el))) return true
    const href = ownHref(el)
    return !!href && !isPlaceholderHref(href)
  }
  const buildPaths = (li: CheerioNode, prefix: string[], depth: number, out: { name: string; href: string }[]) => {
    if (depth > 3 || out.length > 200) return
    const childLis = childLisOf(li)
    const hasRealChildLis = childLis.some(isRealChildCandidate)
    const name = ownText(li)
    if (!isMeaningful(name)) {
      // scanCategoryMenu(라이브 DOM)의 excludeRe.test(href) 가드와 반드시 맞춰야 한다 — 로그아웃/장바구니
      // 등 아이콘형(텍스트 없는) 메뉴는 이름이 없어 위 NON_CATEGORY_TEXT_RE.test(name)을 아예 못 타므로,
      // 여기서 href 자체를 걸러내지 않으면 이 href가 textlessHrefs로 나가 나중에 discoverCategoriesByVisitingLinks가
      // page.goto()로 실제 방문한다 — 그게 로그아웃 링크면 방문 자체가 곧 로그아웃이라, "방문 후 목적지
      // 페이지 라벨로 판정"하는 다른 필터로는 이미 늦다(걸스굽 실사용 확인, 2026-09-01). scanCategoryMenu만
      // 이 가드가 있고 이 함수(HTML/무브라우저 버전)엔 빠져 있던 게 실제 사고로 이어졌다(오토카필 실사용
      // 확인, 2026-09-06 — "카악세사리용품 > ... > 로그아웃"이 member/logout.php 그대로 카테고리로 저장돼
      // previewCatalog가 그 페이지를 열며 로그인 세션이 로그아웃됨).
      if (!hasRealChildLis) {
        const href = ownHref(li)
        if (href && !NON_CATEGORY_TEXT_RE.test(href)) textlessHrefs.push(href)
      }
      return
    }
    if (NON_CATEGORY_TEXT_RE.test(name)) return
    const path = [...prefix, name]
    if (hasRealChildLis) {
      childLis.forEach(sub => buildPaths(sub, path, depth + 1, out))
    } else {
      const href = ownHref(li)
      if (href) out.push({ name: path.join(' > '), href })
    }
  }
  // scanCategoryMenu와 반드시 같은 티어 순서(구체적 신호부터)를 유지한다. cheerio-select의 속성선택자
  // `i` 플래그 지원 여부에 의존하지 않도록(다른 무브라우저 함수들과 같은 이유), class/id는 직접 정규식으로
  // 검사해 후보를 모은다.
  const TIER_RES: { re: RegExp; matchNav?: boolean }[] = [
    { re: /cat/i },
    { re: /lnb|snb|ovmenu/i },
    { re: /gnb/i, matchNav: true },
  ]
  for (const { re, matchNav } of TIER_RES) {
    const candidates = $('*').toArray().filter(el =>
      re.test($(el).attr('class') || '') || re.test($(el).attr('id') || '') || (matchNav === true && $(el).is('nav')))
    const groups: { name: string; href: string }[][] = []
    for (const root of candidates) {
      let topLis = [
        ...$(root).children('ul').children('li').toArray(),
        ...$(root).children('li').toArray(),
        ...$(root).children('div').children('ul').children('li').toArray(),
        ...$(root).find('.slick-slide').children('li').toArray(),
      ]
      // scanCategoryMenu(라이브 DOM)의 같은 폴백 참고 — 래퍼 <div>가 2겹 이상이면 위 고정 깊이 패턴이
      // 전부 0개라 이 root 안에서 처음 만나는 <ul>의 직계 <li>를 대신 쓴다(모자사러 실사용 확인, 2026-08-16).
      if (!topLis.length) {
        const firstUl = $(root).find('ul').first()
        if (firstUl.length) topLis = firstUl.children('li').toArray()
      }
      const out: { name: string; href: string }[] = []
      topLis.forEach(li => buildPaths(li, [], 0, out))
      const seenNames = new Set<string>()
      const uniq = out.filter(o => (seenNames.has(o.name) ? false : (seenNames.add(o.name), true)))
      if (uniq.length < 2) continue
      groups.push(uniq)
    }
    const merged: { name: string; href: string }[] = []
    const seenHrefs = new Set<string>()
    for (const items of groups) {
      for (const o of items) {
        if (seenHrefs.has(o.href)) continue
        seenHrefs.add(o.href)
        merged.push(o)
      }
    }
    if (merged.length) {
      const mergedHrefSet = new Set(merged.map(m => m.href))
      return { links: merged, textlessHrefs: [...new Set(textlessHrefs)].filter(h => !mergedHrefSet.has(h)) }
    }
  }
  return { links: [], textlessHrefs: [...new Set(textlessHrefs)] }
}

/** scanCategoryMenu(라이브 DOM) 결과와 scanCategoryMenuFromHtml(원본 HTML) 결과를 href 기준으로 합친다
 *  — 순수 SPA처럼 메뉴 자체가 JS로만 그려지는 몰은 원본 HTML에 메뉴가 없어 원본 쪽이 그냥 0개를 주고
 *  라이브 DOM 결과가 그대로 남으므로, 항상 합쳐도 안전하다. */
function mergeCategoryMenuScans(a: CategoryMenuScanResult, b: CategoryMenuScanResult): CategoryMenuScanResult {
  const seenHrefs = new Set<string>()
  const links: CategoryMenuLink[] = []
  for (const l of [...a.links, ...b.links]) {
    if (seenHrefs.has(l.href)) continue
    seenHrefs.add(l.href)
    links.push(l)
  }
  const textlessHrefs = [...new Set([...a.textlessHrefs, ...b.textlessHrefs])].filter(h => !seenHrefs.has(h))
  const groupCount = a.groupCount != null || b.groupCount != null ? Math.max(a.groupCount ?? 0, b.groupCount ?? 0) : undefined
  return { links, textlessHrefs, groupCount }
}

/** page.context().request(브라우저 렌더링을 안 거치는 순수 HTTP GET)의 응답 바이트를 실제 선언된
 *  인코딩으로 디코딩한다. Playwright의 APIResponse.text()는 Content-Type의 charset 파라미터를 무시하고
 *  항상 UTF-8로만 디코딩한다(공식 동작 — fetch API처럼 헤더를 스스로 파싱하지 않음) — 신우(sinwoo.com)
 *  같은 구형 EUC-KR 쇼핑몰(서버가 `Content-Type: text/html; charset=euc-kr`을 정확히 보내는데도)에서
 *  카테고리명이 "�α���"처럼 깨져 나온 실제 원인이었다(2026-09-06 실사용 확인 — 같은 페이지를 iconv-lite로
 *  직접 euc-kr 디코딩해보니 "로그인"으로 정상 복원됨). 라이브 DOM 스캔(scanCategoryMenu)은 브라우저가
 *  알아서 이 헤더/meta 태그를 보고 정확히 디코딩하므로 이 문제가 없다 — 문제는 이 보조 스캔(원본 HTML을
 *  따로 한 번 더 받아오는 부분)에만 있었다. */
function decodeHttpResponseText(res: APIResponse, body: Buffer): string {
  const contentType = res.headers()['content-type'] || ''
  const charsetMatch = contentType.match(/charset=([^;]+)/i)
  const charset = charsetMatch?.[1]?.trim().toLowerCase()
  if (!charset || charset === 'utf-8' || charset === 'utf8') return body.toString('utf-8')
  // iconv-lite는 euc-kr/ks_c_5601-1987/cp949 등 흔한 별칭을 이미 다 알고 있다 — 모르는 인코딩이면
  // 예외 대신 그대로 두고(encodingExists) UTF-8로 폴백해 최소한 지금까지의 동작보다 나빠지지 않게 한다.
  if (!iconv.encodingExists(charset)) return body.toString('utf-8')
  return iconv.decode(body, charset)
}

/** scanCategoryMenu의 실사용 진입점 — 브라우저 라이브 DOM 스캔에, 원본 HTML을 추가로 받아 cheerio로도
 *  스캔해 합친 결과를 쓴다(scanCategoryMenuFromHtml 주석 참고 — 캐러셀 JS가 라이브 DOM에서 지운
 *  카테고리를 원본 쪽이 채워준다). 원본 HTML을 못 받아오면(네트워크 오류 등) 라이브 DOM 결과만 쓴다. */
async function scanCategoryMenuRobust(page: Page): Promise<CategoryMenuScanResult> {
  const live = await scanCategoryMenu(page)
  try {
    const res = await page.context().request.get(page.url(), { timeout: 15_000 })
    if (res.ok()) return mergeCategoryMenuScans(live, scanCategoryMenuFromHtml(decodeHttpResponseText(res, await res.body()), res.url()))
  } catch { /* 못 받아오면 라이브 DOM 결과만 쓴다 */ }
  return live
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
          if (href.endsWith('#')) return // href="#" — 실제로는 아무 데도 안 가는 토글 링크 (scanCategoryMenu의 ownHref 참고)
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

/** "카테고리 메뉴/구조 탐지"를 AI(detectCategoryLinksWithAI)에게 맡기기 위한 후보 수집 — scanCategoryMenu처럼
 *  cat/lnb/gnb 같은 컨테이너 셀렉터를 고르지 않고, 페이지의 모든 같은 출처 링크를 텍스트와 함께 그대로
 *  모은다. DOM 중첩 깊이/래퍼 구조와 무관해, 셀렉터 히스틱이 실패해온 사례들(2겹 이상 wrapper, slick.js
 *  캐러셀이 <li>를 한 겹 더 감싸는 것, 탭 위젯 뒤에 숨은 패널 등 — display:none이어도 DOM엔 남아있어
 *  그대로 잡힌다)을 애초에 컨테이너를 안 골라서 자연히 피한다. 상품 상세페이지 링크까지 전부 섞여
 *  들어오는 게 정상이다 — "이 중 뭐가 카테고리냐"는 판단을 AI가 하므로 여기서는 최대한 넓게, 이름이
 *  없는(이미지뿐이고 alt도 없는) 링크만 걸러 모은다. */
// AI(로컬 Ollama, CPU 전용)에게 후보 링크를 통째로 보낼 때의 상한 — 원래 400이었는데, 펫투비에서
// "카테고리 구조 확인"/"정렬 옵션 확인" 각 단계가 300초 넘게 걸리는 걸 실측해보니 모델 로딩이 아니라
// 순수 프롬프트 처리 시간이었다(2026-08-23: 171토큰짜리 작은 프롬프트도 프롬프트 처리에만 3.6초 —
// 400개짜리 후보 목록이면 수천 토큰이라 그만큼 배로 늘어남). 카테고리 메뉴는 보통 몇십 개를 잘 안
// 넘으므로, 120으로 낮춰 프롬프트를 3배 이상 줄인다 — 아주 드물게 카테고리가 120개보다 많은 몰에서만
// 뒤쪽 후보가 잘릴 수 있는 트레이드오프.
const AI_LINK_CANDIDATE_CAP = 120

/** baseOrigin을 넘기면 그 origin으로 필터링하고, 안 넘기면(옛 호출부 호환) location.origin으로
 *  대체한다 — location.origin만 쓰면 이 페이지가 이미 다른 도메인(봇 차단 인터스티셜 등)으로
 *  리다이렉트된 경우 그 차단 페이지 자신의 origin이 기준이 돼버려 필터가 무력화된다(펫토리 실사용
 *  확인, 2026-08-29 — 카페24 차단 페이지 veritas-hub.cafe24.com의 링크 110개가 "카테고리"로 잘못
 *  저장됨). 호출부는 몰의 실제 URL에서 뽑은 origin을 넘겨야 한다. */
async function collectAllPageLinks(page: Page, baseOrigin?: string): Promise<{ text: string; href: string }[]> {
  return page.evaluate(({ cap, baseOrigin }) => {
    const origin = baseOrigin || location.origin
    const current = location.href.replace(/\/+$/, '')
    const seen = new Set<string>()
    const result: { text: string; href: string }[] = []
    const pushFrom = (anchors: Element[]) => {
      for (const a of anchors) {
        if (result.length >= cap) break
        const href = (a as HTMLAnchorElement).href
        if (!href.startsWith(origin)) continue
        if (href.endsWith('#')) continue // href="#" — 실제로는 아무 데도 안 가는 토글 링크 (scanCategoryMenu의 ownHref 참고)
        const norm = href.replace(/\/+$/, '')
        if (norm === current || norm === origin || seen.has(norm)) continue
        const text = (a.textContent || '').trim() || (a.querySelector('img[alt]') as HTMLImageElement | null)?.alt.trim() || ''
        if (!text) continue
        seen.add(norm)
        result.push({ text, href })
      }
    }
    // 카테고리 메뉴는 보통 헤더/nav 영역(scanCategoryMenu가 찾는 것과 같은 후보 영역)에 몰려있다 — 이
    // 영역의 링크를 먼저 담아야, detectCategoryLinksWithAI가 다시 OLLAMA_MAX_CANDIDATES로 자를 때 페이지
    // 뒷부분(상품 썸네일/푸터 등)의 무관한 링크에 밀려 진짜 카테고리 링크가 통째로 잘려나가지 않는다.
    // 프롬프트 앞부분이 실제 카테고리 링크로 채워지면 그만큼 프롬프트도 짧아져, CPU 전용 로컬 모델이
    // 도구 호출 대신 장문 텍스트로 새 타임아웃되는 확률도 같이 줄어든다(신우 실사용 확인, 2026-08-25).
    const navSelectors = '[class*="cat" i], [id*="cat" i], [class*="lnb" i], [id*="lnb" i], [class*="snb" i], [id*="snb" i], [class*="ovmenu" i], [class*="gnb" i], [id*="gnb" i], nav'
    let navRoots: Element[] = []
    try { navRoots = Array.from(document.querySelectorAll(navSelectors)) } catch { navRoots = [] }
    for (const root of navRoots) {
      if (result.length >= cap) break
      pushFrom(Array.from(root.querySelectorAll('a[href]')))
    }
    if (result.length < cap) pushFrom(Array.from(document.querySelectorAll('a[href]')))
    return result
  }, { cap: AI_LINK_CANDIDATE_CAP, baseOrigin }).catch(() => [])
}

/** "카테고리별 정렬기준 설정" 후보 수집 — collectAllPageLinks와 같은 <a href> 수집에 더해 <select><option>도
 *  포함한다. 2026-08-21 걸스굽 실사용 확인: 카페24 플랫폼은 정렬을 <a> 링크가 아니라
 *  <select id="selArray" class="...xans-product-orderby">(옵션 value에 "?cate_no=...&sort_method=N" 같은
 *  상대경로가 들어있음)로 구현해서, <a href>만 모으던 collectAllPageLinks로는 정렬 옵션이 하나도 안
 *  잡혔다(항상 빈 배열 → 화면엔 "기본순"만 남음). 계좌이체 은행 선택처럼 값이 다른 출처의 전체 URL인
 *  <select>는 origin 필터에서 자연히 걸러진다. */
async function collectSortCandidates(page: Page): Promise<{ text: string; href: string }[]> {
  return page.evaluate((cap) => {
    const origin = location.origin
    const current = location.href.replace(/\/+$/, '')
    const seen = new Set<string>()
    const result: { text: string; href: string }[] = []
    for (const a of Array.from(document.querySelectorAll('a[href]'))) {
      if (result.length >= cap) break
      const href = (a as HTMLAnchorElement).href
      if (!href.startsWith(origin)) continue
      if (href.endsWith('#')) continue // href="#" — 실제로는 아무 데도 안 가는 토글 링크 (scanCategoryMenu의 ownHref 참고)
      const norm = href.replace(/\/+$/, '')
      if (norm === current || norm === origin || seen.has(norm)) continue
      const text = (a.textContent || '').trim() || (a.querySelector('img[alt]') as HTMLImageElement | null)?.alt.trim() || ''
      if (!text) continue
      seen.add(norm)
      result.push({ text, href })
    }
    for (const opt of Array.from(document.querySelectorAll('select option')) as HTMLOptionElement[]) {
      if (result.length >= cap) break
      if (!opt.value) continue
      let href: string
      try { href = new URL(opt.value, location.href).href } catch { continue }
      if (!href.startsWith(origin)) continue
      if (href.endsWith('#')) continue
      const norm = href.replace(/\/+$/, '')
      if (norm === current || norm === origin || seen.has(norm)) continue
      const text = (opt.textContent || '').trim()
      if (!text) continue
      seen.add(norm)
      result.push({ text, href })
    }
    return result
  }, AI_LINK_CANDIDATE_CAP).catch(() => [])
}

// 정렬 옵션 후보로 볼 만한 텍스트 — <a href>/<select><option> 어느 쪽도 아닌 버튼(onclick)이나 커스텀
// JS 드롭다운(<li>/<span>/<div> 등)까지 태그 종류를 가리지 않고 잡기 위한 느슨한 키워드 매칭이다. 이
// 자체는 오탐(예: 상품명에 "신상"이 들어감)이 있어도 되는데, detectSortOptionsByClicking이 실제로
// 클릭해보고 diffQueryParams(같은 pathname, 쿼리파라미터만 다름)로 재확인하기 때문이다.
// 최저/최고는 "낮은가격"/"높은가격"만큼(혹은 그보다 더) 흔한 표현이다(실사용 확인, 2026-09-12 — 투비즈온
// "최저 가격순"/"최고 가격순"이 이 패턴에 안 걸려 유일하게 매칭되던 "신규 상품순"(이미 기본 선택된 옵션이라
// 다시 골라도 목록이 안 바뀜)만 시도되고 끝나버렸다 — 정렬이 진짜로 있는데도 전부 미확정으로 끝난 원인).
// "판매순"/"상품명순"은 "판매량"/(상품명 관련 키워드 없음)만으로는 안 걸린다(정글북 실사용 확인,
// 2026-09-15 — 드롭다운에 최신순/판매순/낮은 가격순/높은 가격순/상품명순 5개가 있었는데 그중 2개가
// 애초에 후보에도 안 들어갔었다) — "판매"/"상품명"만 넣으면 "판매가"/"상품명 검색"류를 오탐할 수 있어
// "순"까지 붙은 형태로 좁힌다.
const SORT_KEYWORD_PATTERN = '(신상|신규|최신|낮은\\s*가격|높은\\s*가격|최저|최고|인기|판매량|판매\\s*순|상품명\\s*순|조회|클릭|리뷰|추천|할인|세일|낱개판매|기본순)'

/** SORT_KEYWORD_PATTERN을 쓰는 곳이 여러 자리라(sampleMallProfile의 AI 결과 사전 필터, 아래
 *  detectSortOptionsByClicking의 페이지 내부 스캔) 판정 로직을 하나로 모았다 — 순수 함수라
 *  tests/unit에서 실제 몰 마크업 없이 바로 검증할 수 있다. */
export function looksLikeSortLabel(text: string): boolean {
  return new RegExp(SORT_KEYWORD_PATTERN).test(text)
}

/** collectSortCandidates(정적 href/select 값 읽기)로 후보를 못 찾았거나, AI가 골랐어도 전혀 무관한
 *  링크였을 때(sampleMallProfile의 SORT_KEYWORD_PATTERN 사전 필터 참고)의 폴백 — 버튼 onclick이나
 *  커스텀 JS 드롭다운처럼 마크업만 봐서는 URL을 알 수 없는 정렬 UI까지 잡기 위해, 화면 텍스트가 정렬
 *  키워드와 비슷한 요소를 태그 종류 상관없이 후보로 삼아 하나씩 실제로 클릭해본다. 클릭한 결과가 두
 *  가지로 나뉜다(2026-08-23, 펫투비 실사용 확인 — 처음엔 "URL이 안 바뀌는 AJAX 정렬"이라고만 봤는데,
 *  같은 몰의 같은 링크가 로그인 상태에 따라 실제로는 URL도 바뀜을 재확인해 한 함수로 합쳤다):
 *  - URL이 바뀌고 diffQueryParams가 성공하면(같은 pathname, 쿼리파라미터만 다름) kind:'query'로 확정 —
 *    엉뚱한 걸 클릭해도(다른 카테고리/상품 상세로 이동) pathname이 달라지면 자동으로 걸러진다.
 *  - URL이 그대로면(AJAX로만 재정렬되는 경우, 예: 고도몰 일부 스킨의 `javascript:sort(...)`) 클릭
 *    전후 실제 상품 목록 순서(collectProductUrls가 읽는 것과 같은 링크)가 바뀌었는지로 검증한다 —
 *    텍스트 추측이 아니라 실제 결과 변화를 확인하는 것이라 AI(로컬 Ollama) 호출이 필요 없다. 확정되면
 *    clickText만 저장해 실제 스크랩 시점에 그 목록 페이지에 들어간 직후 다시 클릭해 정렬을 적용한다
 *    (collectFromListing 참고).
 *  후보 하나를 시도할 때마다 baseUrl로 새로 불러와 "정렬 전" 기준을 매번 깨끗하게 다시 잡는다 — 이전
 *  후보 클릭이 남긴 상태가 다음 후보 판정을 오염시킬 수 있어서다(URL 기반이든 AJAX 기반이든 공통). */
/** candidateTexts(어디서 얻었든 — 아래 SORT_KEYWORD_PATTERN 정규식 스캔이든, detectSortOptionsByScreenshot의
 *  화면 인식 라벨이든)를 하나씩 실제로 클릭해보고 검증한다 — "화면에 그렇게 보인다"/"텍스트가 정렬스럽다"는
 *  둘 다 추측일 뿐이고, 실제로 클릭했을 때 진짜 정렬(같은 목록을 유지한 채 순서만 바뀜)로 동작하는지가
 *  유일한 확정 증거다. 결과가 두 가지로 나뉜다(2026-08-23 펫투비 실사용 확인 — 처음엔 "URL이 안 바뀌는
 *  AJAX 정렬"이라고만 봤는데, 같은 몰의 같은 링크가 로그인 상태에 따라 실제로는 URL도 바뀜을 재확인해 한
 *  함수로 합쳤다):
 *  - URL이 바뀌고 diffQueryParams가 성공하면(같은 pathname, 쿼리파라미터만 다름) kind:'query'로 확정 —
 *    엉뚱한 걸 클릭해도(다른 카테고리/상품 상세로 이동) pathname이 달라지면 자동으로 걸러진다.
 *  - URL이 그대로면(AJAX로만 재정렬되는 경우, 예: 고도몰 일부 스킨의 `javascript:sort(...)`) 클릭
 *    전후 실제 상품 목록 순서(collectProductUrls가 읽는 것과 같은 링크)가 바뀌었는지로 검증한다 —
 *    텍스트 추측이 아니라 실제 결과 변화를 확인하는 것이라 AI(로컬 Ollama) 호출이 필요 없다. 확정되면
 *    clickText만 저장해 실제 스크랩 시점에 그 목록 페이지에 들어간 직후 다시 클릭해 정렬을 적용한다
 *    (collectFromListing 참고).
 *  후보 하나를 시도할 때마다 baseUrl로 새로 불러와 "정렬 전" 기준을 매번 깨끗하게 다시 잡는다 — 이전
 *  후보 클릭이 남긴 상태가 다음 후보 판정을 오염시킬 수 있어서다(URL 기반이든 AJAX 기반이든 공통). */
/** 정렬 후보 텍스트가 네이티브 `<select>`의 `<option>`일 수 있다(투비즈온 실사용 확인, 2026-09-12 —
 *  "신규 상품순"/"최저 가격순"/"최고 가격순"이 실제로 `<select name="orderby"><option>`이었고, value도
 *  "regdt_asc" 같은 순수 토큰이라 href로 못 바꿈). `<option>`은 네이티브 드롭다운이라 일반 마우스
 *  `.click()`으로 열리지 않는다 — 조상 `<select>`에 `selectOption(label)`을 대신 호출해야 실제 브라우저가
 *  그 옵션을 선택한 것과 동일한 change 이벤트가 발생한다. 이 판단(옵션이냐 아니냐)과 클릭 실행 자체를
 *  한곳에 모아, confirmSortCandidatesByClicking(감지+검증)과 collectFromListing(실제 스크랩 시점 적용)
 *  둘 다 같은 방식으로 동작하게 한다 — MallSortOption의 kind:'click'/clickText 저장 형식은 그대로 두고
 *  (사용자가 저장된 정렬을 다시 쓸 때·개발자모드가 이 타입을 읽을 때 아무것도 안 바뀜), 클릭을 실행하는
 *  이 저수준 동작만 옵션 태그를 인식하도록 넓힌다. 후보 텍스트를 못 찾으면 false. */
/** clickSortCandidateText가 찾는 정렬 라벨이 화면에 곧바로 없을 때의 마지막 수단 — 닫힌 드롭다운을
 *  열어본다. 정글북 실사용 확인(2026-09-15, 사용자 지적: "정렬은 클릭한번 해보면 여러개의 정렬기준이
 *  나오는데, 그걸 못해?") — "판매순"/"낮은 가격순"/"높은 가격순"/"상품명순"은 현재 선택된 정렬을 보여주는
 *  `<button><span>최신순</span><svg/></button>` 트리거를 먼저 클릭해야 DOM에 나타나는 `<li><button>`
 *  목록이었다. 트리거는 아이콘(svg) 있는 버튼 전부가 아니라 "텍스트 자체가 이미 정렬 키워드처럼 생긴
 *  것"으로 좁혀 찾는다 — 안 그러면 "강아지"/"고양이" 같은 무관한 토글 버튼까지 잘못 열 수 있다(둘 다
 *  짧은 텍스트+아이콘 버튼이지만 정렬 키워드는 아님). 열어도 원하는 텍스트가 끝내 안 나오면 그대로
 *  실패 처리되므로(호출부가 이미 그 경우를 다룸) 엉뚱한 걸 잘못 열어도 안전하다.
 *
 *  이 트리거는 클릭할 때마다 열림/닫힘이 토글된다 — 같은 page에서 이 함수가 두 번 불리면(화면 인식
 *  단계가 한 번 열어두고, 그 뒤 클릭 폴백 단계가 또 호출하는 식) 두 번째 호출이 방금 열린 걸 도로
 *  닫아버려, 정작 후보를 스캔할 때는 닫힌 상태로 되돌아가 있었다(정글북 실사용 재확인, 2026-09-15 —
 *  고친 뒤에도 "판매순"이 여전히 후보에 안 잡혀 원인 추적). "이미 열려 있는지"를 정렬 키워드 텍스트
 *  개수로 추측해보려 했지만(2개 이상이면 열린 것으로 간주) 실패했다 — 사이트 공통 상단 메뉴("신상품",
 *  "타임세일" 등)가 드롭다운이 닫힌 상태에서도 우연히 같은 키워드에 걸려, 닫혀 있는데도 "이미 열림"으로
 *  잘못 판단해 다시 열지 않은 채 그대로 스캔해버렸다(정글북 실사용 재확인, 2026-09-15 — 로그로 직접
 *  leafMatches=["신상품","타임세일","최신순"]을 확인). 대신 이 함수가 실제로 클릭에 성공했을 때만
 *  document에 표시(marker attribute)를 남기고, 다음 호출은 그 표시만 보고 판단한다 — 같은 page(=같은
 *  document, 중간에 goto 없음) 안에서만 유효하고, 다시 페이지를 불러오면(confirmSortCandidatesByClicking이
 *  후보마다 baseUrl로 새로 열 때) 표시가 자연히 사라져 다음 후보에서도 정확히 다시 판단한다. */
export async function openLikelySortDropdownTrigger(page: Page): Promise<boolean> {
  return page.evaluate((pattern) => {
    const marker = 'data-scraper-opened-sort-dropdown'
    if (document.documentElement.hasAttribute(marker)) return true
    const re = new RegExp(pattern)
    const candidate = Array.from(document.querySelectorAll('button, [role="button"]')).find(el => {
      const text = (el.textContent || '').trim()
      if (!text || text.length > 12 || !re.test(text)) return false
      if (!el.querySelector('svg')) return false
      const rect = el.getBoundingClientRect()
      return rect.width > 0 && rect.height > 0
    }) as HTMLElement | undefined
    if (!candidate) return false
    candidate.click()
    document.documentElement.setAttribute(marker, '1')
    return true
  }, SORT_KEYWORD_PATTERN).catch(() => false)
}

async function clickSortCandidateText(page: Page, text: string, waitMs = 5_000): Promise<boolean> {
  const locator = page.getByText(text, { exact: true }).first()
  // 정렬 위젯을 'load' 이후에 AJAX로 한 번 더 채워 넣는 몰이 있다 — 바로 아래 confirmSortCandidatesByClicking
  // (감지 경로)은 2026-09-12에 이걸 알고 기다리도록 고쳤는데, **적용 경로**(collectFromListing이 스크랩/
  // 미리보기 때 정렬을 다시 클릭하는 곳)는 그대로라 매번 "화면에서 못 찾음"으로 실패했다(투비즈온 실사용
  // 확인, 2026-09-13 — 미리보기 표본이 기본 정렬로 뽑힘). 같은 함정을 한쪽만 고쳐둔 상태였으므로, 대기를
  // 이 함수 안으로 넣어 두 경로가 함께 혜택을 보게 한다.
  const deadline = Date.now() + waitMs
  if (await locator.count() === 0) {
    // 곧바로 안 보이면 닫힌 드롭다운 안에 있을 수 있다 — 한 번 열어보고 아래 폴링에서 계속 찾는다.
    await openLikelySortDropdownTrigger(page)
  }
  while (await locator.count() === 0) {
    if (Date.now() >= deadline) return false
    await page.waitForTimeout(300)
  }
  const isOption = await locator.evaluate(el => el.tagName === 'OPTION').catch(() => false)
  if (isOption) {
    const select = locator.locator('xpath=ancestor::select[1]')
    if (await select.count() === 0) return false
    await select.selectOption({ label: text }, { timeout: 3_000 })
  } else {
    await locator.click({ timeout: 3_000 })
  }
  return true
}

async function confirmSortCandidatesByClicking(page: Page, baseUrl: string, candidateTexts: string[]): Promise<MallSortOption[]> {
  const confirmed: MallSortOption[] = []
  for (const text of candidateTexts) {
    try {
      await page.goto(baseUrl, { waitUntil: 'load', timeout: 15_000 })
      // 'load' 이벤트 이후에도 정렬/배송조건 등 필터 위젯을 AJAX로 한 번 더 채워 넣는 몰이 있다(투비즈온
      // 실사용 확인, 2026-09-12 — 'load' 직후 바로 getByText로 <option>을 찾으면 그새 못 찾음: count 0).
      // 클릭 뒤 재정렬 반영을 기다리는 것과 같은 이유로, 클릭 "전" 기준선을 잡기 전에도 한 번 잠잠해질
      // 때까지 기다린다.
      await page.waitForLoadState('networkidle', { timeout: 3_000 }).catch(() => {})
      // URL이 안 바뀌는(AJAX) 경우를 확인하려면 클릭 전 목록 순서가 필요하다 — 어느 쪽으로 판정될지는
      // 클릭 후에야 알 수 있으므로 매번 미리 잡아둔다.
      const before = (await collectProductUrls(page, { maxPages: 1 }).catch(() => null))?.urls.slice(0, 10) || []
      if (!await clickSortCandidateText(page, text)) {
        console.log(`[정렬탐지:진단] "${text}" — 요소를 못 찾음/클릭 실패`)
        continue
      }
      await page.waitForLoadState('load', { timeout: 5_000 }).catch(() => {})
      const afterUrl = page.url()
      // 경로/쿼리(실제 요청 대상)는 그대로인데 해시(#...)만 바뀐 몰이 있다(투비즈온 실사용 확인,
      // 2026-09-12 — 카테고리 페이지 자체가 SPA 스타일로 자기 상태를 해시에 적어두는데, 정렬도 여기
      // 반영됨). afterUrl!==baseUrl만 보고 "URL이 바뀌었다"로 취급하면 diffQueryParams(쿼리만 비교,
      // 해시는 안 봄)가 진짜 차이를 못 찾아 매번 continue로 버려진다 — 실제로는 서버 요청 자체가 그대로인
      // AJAX 정렬과 똑같은 상황이라, 경로+쿼리가 같으면 해시 차이는 무시하고 아래 목록 변화 검증(kind:'click')
      // 으로 넘어간다.
      const sameRequestTarget = (() => {
        try {
          const b = new URL(baseUrl), a = new URL(afterUrl)
          return b.origin === a.origin && b.pathname === a.pathname && b.search === a.search
        } catch { return false }
      })()
      if (afterUrl !== baseUrl && !sameRequestTarget) {
        const paramsToAdd = diffQueryParams(baseUrl, afterUrl)
        // "경로가 같고 쿼리만 다르다"는 것만으론 부족하다 — 실제 페이지 경로가 쿼리파라미터 하나(예:
        // "?p=xxx.html")로 결정되는 몰(도매의신 실사용 확인, 2026-09-17)에서는, 상품 상세/검색 페이지로
        // 튀는 무관한 링크(예: 홈의 "인기상품" 위젯 안 "인기1TV100197" 같은 상품 링크)도 이 조건을 그대로
        // 통과해버린다 — "인기"가 SORT_KEYWORD_PATTERN에 걸려 후보가 됐는데, 클릭해보니 상품 상세로
        // 이동했을 뿐인데도 목록으로 잘못 저장됐다. 진짜 정렬이라면 이동한 곳도 여전히 "같은 종류의 상품이
        // 여러 개 나열된 목록"이어야 한다 — 클릭 전과 똑같은 상품이 아니어도 되지만(정렬이니 순서가 바뀜),
        // 최소한 목록 형태는 유지돼야 하므로 이동한 페이지에서도 상품 URL을 다시 모아봐서 여러 건이
        // 나오는지 확인한다. 상세페이지 하나로 튄 경우 상품 목록 셀렉터가 아예 안 걸리거나 1건뿐이라 이
        // 확인으로 걸러진다.
        const afterPageLooksLikeListing = paramsToAdd
          ? (await collectProductUrls(page, { maxPages: 1 }).catch(() => null))?.urls.length ?? 0
          : 0
        console.log(`[정렬탐지:진단] "${text}" — URL 이동(${afterUrl}), 쿼리차이 ${paramsToAdd ? JSON.stringify(paramsToAdd) : '없음(폐기)'}${paramsToAdd ? `, 이동한 곳의 상품 URL ${afterPageLooksLikeListing}개` : ''}`)
        if (paramsToAdd && afterPageLooksLikeListing >= 2) confirmed.push({ label: text, kind: 'query', paramsToAdd })
        continue
      }
      if (!before.length) {
        console.log(`[정렬탐지:진단] "${text}" — 클릭 전 상품 목록을 못 읽어 검증 불가`)
        continue
      }
      // AJAX 재정렬은 클릭 즉시 반영되지 않을 수 있어, 네트워크가 잠잠해질 때까지 우선 기다린다. 다만
      // "네트워크가 잠잠해짐"과 "화면(DOM)이 새 순서로 다 그려짐"은 별개다 — 정글북(id=30) 실사용 확인,
      // 2026-09-15: fetch 자체는 거의 즉시 끝나 networkidle이 곧바로(수백 ms 안에) 성공하는데, React가
      // 응답을 받아 실제로 목록을 다시 그리는 데는 그보다 조금 더 걸려, 곧바로 이어서 읽으면 아직 예전
      // 순서 그대로였다(실제로 "낮은 가격순"을 클릭해 직접 확인해보면 상품 순서가 분명히 바뀌는데도 매번
      // "목록 변화 없음"으로 폐기됨) — networkidle이 성공하든 타임아웃으로 실패하든 항상 짧게 한 번 더
      // 기다린 뒤에야 다시 읽는다.
      await page.waitForLoadState('networkidle', { timeout: 3_000 }).catch(() => {})
      await page.waitForTimeout(800)
      const after = (await collectProductUrls(page, { maxPages: 1 }).catch(() => null))?.urls.slice(0, 10) || []
      const changed = after.length && JSON.stringify(after) !== JSON.stringify(before)
      console.log(`[정렬탐지:진단] "${text}" — URL 동일(해시만 다를 수 있음), 목록 변화 ${changed ? '있음(확정)' : '없음(폐기)'} (before=${before.length}건, after=${after.length}건)`)
      if (changed) confirmed.push({ label: text, kind: 'click', clickText: text })
    } catch (e) {
      console.log(`[정렬탐지:진단] "${text}" — 예외로 중단: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  if (page.url() !== baseUrl) await page.goto(baseUrl, { waitUntil: 'load', timeout: 15_000 }).catch(() => {})
  return confirmed
}

/** collectSortCandidates(정적 href/select 값 읽기)로 후보를 못 찾았거나, AI가 골랐어도 전혀 무관한
 *  링크였을 때(sampleMallProfile의 SORT_KEYWORD_PATTERN 사전 필터 참고)의 폴백 — 버튼 onclick이나
 *  커스텀 JS 드롭다운처럼 마크업만 봐서는 URL을 알 수 없는 정렬 UI까지 잡기 위해, 화면 텍스트가 정렬
 *  키워드와 비슷한 요소를 태그 종류 상관없이 후보로 삼아 하나씩 실제로 클릭해본다(confirmSortCandidatesByClicking
 *  참고). */
async function detectSortOptionsByClicking(page: Page, baseUrl: string): Promise<MallSortOption[]> {
  // 후보 스캔 자체가 닫힌 드롭다운 안의 옵션은 못 본다(정글북 실사용 확인, 2026-09-15 — openLikelySortDropdownTrigger
  // 주석 참고: "판매순"/"낮은 가격순" 등은 현재 선택된 정렬 버튼을 눌러야 DOM에 나타남). 스캔 전에 한 번
  // 열어본다 — 열 게 없으면(닫힌 드롭다운이 아닌 몰) 조용히 실패하고 기존 동작 그대로다.
  if (await openLikelySortDropdownTrigger(page)) await page.waitForTimeout(300)
  const candidateTexts = await page.evaluate((pattern) => {
    const re = new RegExp(pattern)
    const seen = new Set<string>()
    const result: string[] = []
    for (const el of Array.from(document.querySelectorAll('a, button, li, span, div, label, option'))) {
      if (result.length >= 10) break
      const text = (el.textContent || '').trim()
      if (!text || text.length > 12 || !re.test(text) || seen.has(text)) continue
      // 텍스트를 가진 자식이 이미 있으면(=이 요소는 더 큰 컨테이너일 뿐) 건너뛰고 안쪽 요소를 기다린다.
      const hasTextChild = Array.from(el.children).some(c => (c.textContent || '').trim() === text)
      if (hasTextChild) continue
      seen.add(text)
      result.push(text)
    }
    return result
  }, SORT_KEYWORD_PATTERN).catch(() => [] as string[])
  console.log(`[정렬탐지:진단] 클릭 후보 텍스트 ${candidateTexts.length}개: ${candidateTexts.join(', ')}`)
  return confirmSortCandidatesByClicking(page, baseUrl, candidateTexts)
}

/** 정렬 UI 탐지의 1차 수단 — 카테고리 목록 페이지를 스크린샷으로 찍어 비전 AI(lib/ai.ts의
 *  detectSortOptionsFromScreenshot, Groq qwen3.6-27b→로컬 Ollama vision 순으로 시도)에게 "화면에 보이는
 *  정렬 라벨"을 물어본 뒤, 그 라벨 텍스트로 confirmSortCandidatesByClicking을 그대로 재사용해 실제
 *  클릭+검증까지 마친다(사용자 지시, 2026-09-08 — "정렬은 화면으로 확인 가능하니 화면을 먼저 보는 것으로
 *  설계 기준을 바꿔라"). 화면 인식이 실패하거나(null) 아무 라벨도 못 찾으면([]) 빈 배열을 돌려주고,
 *  호출부가 기존 href/키워드 기반 방식(collectSortCandidates+SORT_KEYWORD_PATTERN, detectSortOptionsByClicking)
 *  으로 이어서 시도한다 — 이 함수를 유일한 진실로 과신하지 않는다. */
async function detectSortOptionsByScreenshot(
  page: Page, baseUrl: string, mallName: string, signal?: AbortSignal,
  /** 이 몰에서 예전에 확인된 정렬 옵션 라벨(있으면) — 비전 프롬프트에 참고 예시로 얹는다(사용자 지시,
   *  2026-09-18 — "기존에 정상적으로 정렬을 찾은 내역이 있으면 더 확인하기 쉬울 것 아니야"). */
  knownExamples?: string[], visionLog?: VisionAttempt[],
): Promise<MallSortOption[]> {
  // 닫힌 드롭다운은 화면에 현재 선택된 라벨(예: "최신순") 하나만 보이고 나머지 옵션은 아예 안 보인다 —
  // 스크린샷을 찍기 전에 한 번 열어본다(openLikelySortDropdownTrigger 주석 참고, 정글북 실사용 확인
  // 2026-09-15). 열 게 없으면 조용히 실패하고 닫힌 상태 그대로 찍을 뿐이라 기존 동작과 같다. 이건 결정을
  // 내리는 게 아니라 스크린샷 찍기 전에 내용을 더 드러내주는 저비용 보조 동작이라 "비전 우선" 원칙과
  // 충돌하지 않는다 — 값 판정 자체는 여전히 아래 비전 호출이 한다.
  if (await openLikelySortDropdownTrigger(page)) await page.waitForTimeout(300)
  let screenshot = await page.screenshot({ type: 'jpeg', quality: 70 }).catch(() => null)
  if (!screenshot) return []
  let labels = await detectSortOptionsFromScreenshot(mallName, screenshot.toString('base64'), 'image/jpeg', signal, knownExamples, visionLog).catch(() => null)
  if (!labels?.length) {
    // 값이 하나도 안 보이면, 트리거 자체가 "정렬방식"처럼 고정 라벨만 있고 지금 값이 화면에 없는
    // 경우일 수 있다(도매신 실사용 확인, 2026-09-16 — openLikelySortDropdownTrigger는 트리거 자신의
    // 텍스트가 이미 정렬 키워드일 때만 여는데, "정렬방식"은 그 키워드 목록에 없다). 사람이 화면을 보고
    // 그 버튼을 찾아 눌러보듯, 비전으로 위치를 찾아 직접 클릭한 뒤 다시 읽는다.
    const trigger = await detectSortTriggerFromScreenshot(mallName, screenshot.toString('base64'), 'image/jpeg', signal, visionLog).catch(() => null)
    if (trigger?.found) {
      const viewport = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }))
        .catch(() => page.viewportSize() ?? { width: 1280, height: 800 })
      const x = viewport.width * (trigger.xPercent / 100)
      const y = viewport.height * (trigger.yPercent / 100)
      console.log(`[정렬탐지:진단:${mallName}] 화면 인식: 정렬 트리거 "${trigger.label || '(아이콘)'}" 발견(${trigger.xPercent}%,${trigger.yPercent}%) → (${x.toFixed(0)},${y.toFixed(0)}) 클릭`)
      await clickNearestClickableAtPoint(page, x, y, mallName)
      await page.waitForTimeout(300)
      screenshot = await page.screenshot({ type: 'jpeg', quality: 70 }).catch(() => null)
      labels = screenshot ? await detectSortOptionsFromScreenshot(mallName, screenshot.toString('base64'), 'image/jpeg', signal, knownExamples, visionLog).catch(() => null) : null
    }
  }
  if (!labels?.length) return []
  return confirmSortCandidatesByClicking(page, baseUrl, labels)
}

/**
 * "몰 카테고리 선택 가져오기(반복)" 탭 전용 — 사용자가 카테고리를 하나 가져오면 "몰 구조분석"을 따로
 * 돌리지 않아도 그 즉시 "정렬" 드롭다운을 쓸 수 있게, 그 카테고리 페이지에서 바로 정렬 옵션을 찾는다
 * (사용자 요청, 2026-08-26 — "카테고리를 가져오기 하면 그 즉시 정렬/스크랩 상한 작업이 가능하도록").
 * sampleMallProfile(deep)의 정렬 감지와 같은 순서(정적 href/select 후보 → looksLikeSortLabel+
 * diffQueryParams로 확정 → 실패하면 실제 클릭 검증 폴백)를 쓰되, "카테고리 여러 개 중 상품이 있는 것을
 * 찾아 도는" 부분은 없다 — 사용자가 이미 실제 카테고리 페이지라고 확인해 가져온 URL이라 그대로 믿는다
 * (상품이 없는 허브 페이지였다면 정렬 위젯도 없어 빈 배열이 나올 뿐 해가 되지 않는다). 몰 전체가 같은
 * 정렬 메커니즘을 쓴다고 보므로(sampleMallProfile과 같은 가정) 카테고리마다 다시 부를 필요는 없다 —
 * 호출부(app/api/scrape/categories/sort-options)가 이미 정렬 옵션을 찾아둔 몰이면 다시 부르지 않는다.
 */
export async function detectSortOptionsForCategory(opts: ScrapeOptions, categoryUrl: string): Promise<MallSortOption[]> {
  return withContext(opts, async (page, context) => {
    const scanPage = await context.newPage()
    try {
      await scanPage.goto(categoryUrl, { waitUntil: 'load', timeout: 20_000 })
      await loginIfNeeded(scanPage, { url: categoryUrl, ...opts })
      if (opts.loginId && scanPage.url() !== categoryUrl) {
        await scanPage.goto(categoryUrl, { waitUntil: 'load', timeout: 20_000 }).catch(() => {})
      }
      const baseUrl = scanPage.url()
      // 1차: 화면(스크린샷)을 먼저 본다 — sampleMallProfile의 정렬 옵션 확인과 같은 순서(사용자 지시,
      // 2026-09-08 — 위 detectSortOptionsByScreenshot 주석 참고).
      const mallName = opts.siteId ? (await siteInfo(opts.siteId)).name : new URL(categoryUrl).hostname
      // 예전에 확인된 라벨이 있으면 참고 예시로 같이 건넨다(sampleMallProfile과 같은 이유, 2026-09-18).
      const prevSortLabels = opts.siteId ? (await getCategoryMemory(opts.siteId)).prevSortOptions.map(o => o.label).filter(Boolean) : []
      const viaScreenshot = await detectSortOptionsByScreenshot(scanPage, baseUrl, mallName, undefined, prevSortLabels).catch(() => [])
      if (viaScreenshot.length) return viaScreenshot
      // 2차: 화면 인식이 실패했거나 못 찾았을 때만 기존 href/select 구조 스캔 → 키워드 기반 클릭 폴백.
      const sortCandidates = await collectSortCandidates(scanPage)
      const queryBased = sortCandidates
        .filter(c => looksLikeSortLabel(c.text))
        .map(c => ({ label: c.text, kind: 'query' as const, paramsToAdd: diffQueryParams(baseUrl, c.href) }))
        .filter((o): o is { label: string; kind: 'query'; paramsToAdd: Record<string, string> } => !!o.paramsToAdd)
      if (queryBased.length) return queryBased
      return await detectSortOptionsByClicking(scanPage, baseUrl).catch(() => [])
    } finally {
      await scanPage.close().catch(() => {})
    }
  }, '카테고리 정렬 옵션 확인')
}

/** scanCategoryMenu가 메뉴 텍스트를 못 읽을 때(이미지 스프라이트/아이콘 폰트 메뉴 등이라 <li> 안에 글자가
 *  전혀 없는 경우, 실사용 확인: 진짜양말 — alt 없는 메뉴 이미지라 이름이 마크업 어디에도 없음)의 대안이다.
 *  메뉴 자체는 못 읽어도 "링크"(href)는 findCategoryLinkCandidates로 얻을 수 있으니, 그 링크로 실제
 *  들어가 목적지 목록 페이지 자신이 보여주는 카테고리 라벨(브레드크럼/타이틀 — 사용자가 봐야 하는 화면이라
 *  메뉴와 달리 거의 항상 실제 텍스트로 존재한다)을 detectCategoryLabel로 읽어 대신 채운다. */
// 후보 링크를 하나씩 순서대로 방문하던 게(펫투비 실사용 확인, 2026-08-23: "몰 구조분석"의 "카테고리
// 구조 확인" 단계 하나가 307초 걸림 — AI/DOM 히스틱이 둘 다 못 찾아 이 폴백을 탄 경우) mapWithPageWorkers로
// 서로 독립적인 방문이라 병렬화한다(샘플 상품 방문과 같은 패턴). seenNames/result 갱신은 각 워커의
// await 없는 동기 구간에서만 일어나 경쟁 조건이 없다.
async function discoverCategoriesByVisitingLinks(context: BrowserContext, page: Page, links: string[]): Promise<CategoryMenuLink[]> {
  const seenNames = new Set<string>()
  const result: CategoryMenuLink[] = []
  // 방문 자체가 로그아웃 같은 부작용을 낼 수 있는 링크(NON_CATEGORY_TEXT_RE — logout/cart/mypage 등)는
  // 호출부(scanCategoryMenu/scanCategoryMenuFromHtml)가 이미 textlessHrefs 단계에서 걸러내는 게 원칙이지만,
  // 이 함수 자체에도 마지막 안전장치로 한 번 더 건다 — 방문 "후"의 detectCategoryLabel 필터(아래)는 이미
  // 늦으므로(오토카필 실사용 확인, 2026-09-06 — member/logout.php를 그대로 방문해 로그인 세션이 끊김),
  // gotoViaLinkClick 자체를 아예 안 타게 방문 "전"에 막는다.
  const safeLinks = links.filter(l => !NON_CATEGORY_TEXT_RE.test(l))
  await mapWithPageWorkers(context, page, safeLinks, MALL_PROFILE_CONCURRENCY, async (link, _i, workerPage) => {
    try {
      // gotoViaLinkClick: gotoViaLinkClick 정의부 주석 참고.
      await gotoViaLinkClick(workerPage, link, { waitUntil: 'load', timeout: 15_000 })
      const { category } = await detectCategoryLabel(workerPage)
      if (category && !NON_CATEGORY_TEXT_RE.test(category) && !seenNames.has(category)) {
        seenNames.add(category)
        result.push({ name: category, href: link })
      }
    } catch { /* 이 링크가 안되면 다음 링크로 */ }
  })
  return result
}

/** 시작 페이지(대개 홈페이지)에 "전체카테고리"류 허브 링크가 있으면 실제 카테고리 메뉴는 홈페이지
 *  상단 nav보다 그 안에 훨씬 깔끔하게 정리돼 있는 경우가 많다(신우 실사용 확인, 2026-08-26 — 홈페이지
 *  nav는 "양말&세트/남성속옷/..." 대분류 탭만 있고 실제 하위 카테고리는 "전체카테고리+" 링크를 눌러야
 *  나오는 "카테고리 전체보기" 페이지에 계층별로 정리돼 있었다). "카테고리"라는 단어가 들어간 링크를
 *  찾아 먼저 들어가보면, 그 뒤 AI/히스틱 스캔의 후보도 그만큼 짧고 관련성 높아져(홈페이지의 배너/상품
 *  썸네일 등 잡음이 없음) CPU 전용 로컬 모델의 도구 호출 성공률도 같이 올라간다. "전체"가 들어간 링크를
 *  우선하고(전체카테고리 등 허브일 가능성이 가장 높음), 없으면 "카테고리"만 들어간 첫 링크를 쓴다. */
async function findCategoryOverviewLink(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const origin = location.origin
    const anchors = Array.from(document.querySelectorAll('a[href]')) as HTMLAnchorElement[]
    const candidates = anchors.filter(a => a.href.startsWith(origin) && /카테고리/.test((a.textContent || '').trim()))
    if (!candidates.length) return null
    const preferred = candidates.find(a => /전체/.test(a.textContent || '')) || candidates[0]
    return preferred.href
  }).catch(() => null)
}

/** "카테고리 전체보기" 류 페이지에 흔한 구조 — scanCategoryMenu가 찾는 `<li>` 중첩 트리가 아니라,
 *  "짧은 제목 요소 바로 뒤에 링크 목록이 따라오는" 짝이 대분류 개수만큼 페이지 안에 반복된다. 제목은
 *  `<p class="cate_t"><a>양말＆세트</a></p><ul><li><a>...하위...</a></li>...</ul>`처럼 텍스트 전용 태그일
 *  수도(신우 실사용 확인, 2026-08-26, 9번 반복) 있지만, `<section><a class="...">사료<svg/></a>
 *  <div class="grid grid-cols-2"><a>건식사료</a><a>소프트사료</a>...</div></section>`처럼 제목 자체가
 *  링크(그 대분류 페이지로 이동)이고 목록도 ul/ol이 아닌 grid형 div일 수도 있다(정글북 /category 페이지
 *  실측 확인, 2026-09-15 — 사용자 지적 "왜 다 찾아내질 못했어?"로 재진단; 첫 시도는 화면 캡처 없이 추측한
 *  "굵은 글꼴로 구분되는 flat 형제 <a>" 패턴이었는데 실제 마크업과 달라 전혀 안 맞았다 — 반드시 실제
 *  페이지를 열어 DOM을 확인한 뒤 고쳤다). 특정 태그/클래스명이 아니라 "짧은 텍스트 제목 + 바로 뒤 형제
 *  링크 목록(≥2개)"이라는 구조 자체로 찾으므로, 몰마다 마크업이 달라도 일반적으로 적용된다. */
export async function scanCategoryOverviewPage(page: Page): Promise<CategoryMenuLink[]> {
  const result = await page.evaluate(() => {
    const origin = location.origin
    const isShortLabel = (s: string) => {
      const t = s.trim()
      return t.length > 0 && t.length <= 20 && !/https?:\/\//.test(t)
    }
    // ul/ol이 아니어도 "직계 자식 대부분이 링크인 컨테이너"면 목록으로 인정한다(정글북의
    // <div class="grid grid-cols-2"><a>...</a><a>...</a>...</div> 참고) — 제목 후보(아래)가 이 목록 자신의
    // 항목 하나를 잘못 짚었을 때도(예: "건식사료" 다음 형제가 "소프트사료" 하나뿐) kids.length<2라
    // 자연히 걸러진다.
    const looksLikeLinkGrid = (el: Element | null): el is Element => {
      if (!el) return false
      const kids = Array.from(el.children)
      if (kids.length < 2) return false
      const linkKids = kids.filter(k => k.tagName === 'A' && (k as HTMLAnchorElement).getAttribute('href'))
      return linkKids.length >= 2 && linkKids.length >= kids.length * 0.8
    }
    const result: { name: string; href: string }[] = []
    const seen = new Set<string>()
    // 제목 태그에 'a'도 포함한다 — 대분류 이름 자체가 그 카테고리 페이지로 가는 링크인 몰이 흔하다
    // (정글북처럼 아이콘+굵은 글씨+화살표가 전부 하나의 <a> 안에 있는 경우). 무관한 <a>(예: 하위 항목
    // 자신, 사이트 전역 nav 링크)까지 전부 후보가 돼도 아래 "다음 형제가 링크 목록인가" 조건에서
    // 대부분 걸러지고, 남은 오탐은 groupsFound>=2 + NON_CATEGORY_* 필터 + 호출부의 표본검증
    // (looksLikeRealCategoryBatch)이 마저 걸러낸다.
    const headingCandidates = Array.from(document.querySelectorAll('p, h1, h2, h3, h4, h5, strong, b, dt, a'))
      .filter(el => !el.querySelector('ul, ol') && isShortLabel(el.textContent || ''))
    let groupsFound = 0
    for (const heading of headingCandidates) {
      // 제목 바로 다음 형제가 목록이면 그걸 쓰고, 아니면(제목이 한 겹 더 감싸져 있는 마크업) 제목의
      // 부모 바로 다음 형제도 한 번 더 본다.
      let list: Element | null = heading.nextElementSibling
      if (!(list?.tagName === 'UL' || list?.tagName === 'OL' || looksLikeLinkGrid(list))) {
        list = heading.parentElement?.nextElementSibling || null
      }
      if (!(list?.tagName === 'UL' || list?.tagName === 'OL' || looksLikeLinkGrid(list))) continue
      const items = (list.tagName === 'UL' || list.tagName === 'OL')
        ? Array.from(list.querySelectorAll('a[href]')) as HTMLAnchorElement[]
        : Array.from(list.children).filter((k): k is HTMLAnchorElement => k.tagName === 'A')
      const validItems = items.filter(a => a.href.startsWith(origin) && (a.textContent || '').trim())
      if (validItems.length < 2) continue
      groupsFound++
      const groupName = (heading.textContent || '').trim()
      for (const a of validItems) {
        const norm = a.href.replace(/\/+$/, '')
        if (seen.has(norm)) continue
        seen.add(norm)
        const itemText = (a.textContent || '').trim().replace(/^[·•\s]+/, '')
        result.push({ name: groupName ? `${groupName} > ${itemText}` : itemText, href: a.href })
      }
    }
    // "제목+목록" 짝이 최소 2개는 반복돼야 진짜 카테고리 구조로 인정한다(하나만 우연히 걸리면 무관한
    // 위젯일 수 있음) — scanCategoryMenu의 "최소 2개 경로" 조건과 같은 이유.
    return groupsFound >= 2 ? result : []
  }).catch(() => [])
  // scanCategoryMenu/AI 결과와 달리 이 함수는 클래스명이 아니라 "제목+목록" 구조만 보고 긁기 때문에,
  // 장바구니/로그인/마이페이지 같은 유틸 메뉴나 게시판 링크가 같은 구조(짧은 제목 + 링크 목록)로 되어
  // 있으면 그대로 섞여 들어온다 — 실사용 확인(2026-09-02, 걸스굽: "장바구니" 링크(/order/basket.html)가
  // 카테고리로 오인돼 expandCategoryHubs가 방문 → 로그인 세션이 끊김). 다른 스캔 경로와 같은 필터를
  // 여기서도 적용한다.
  return result.filter(l => !isNonCategoryCandidate(l.name, l.href))
}

/**
 * "이 몰은 카테고리 URL이 이런 모양이다"를 실제 확인된 URL들에서 역산한다 — 규칙 기반이든 AI든 한 번
 * 성공한 결과, 또는 사용자가 "카테고리 선택 가져오기"로 직접 모은 URL(scrape_profile.
 * manualCategorySamples)이 그 재료다. 쿼리파라미터 키(예: cat_code, cateCd) 중 확인된 URL의 과반수에
 * 공통으로 등장하는 게 있으면 그 키를 "이 몰의 카테고리 신호"로 본다 — 카테고리마다 값(48/57/ 등)은
 * 달라도 키 이름 자체는 같은 페이지 스크립트(socks.php/knit.php 등 서로 다른 파일이어도)가 공유하는
 * 경우가 흔하다(신우 실사용 확인, 2026-08-26 — 모든 카테고리가 cat_code= 파라미터를 씀). 다음번 이
 * 몰의 카테고리 탐지 시 scanByKnownUrlPattern이 이 패턴 하나로 즉시(구조 스캔/AI 없이) 카테고리를
 * 다시 찾는 "기억" 역할을 한다. 순수 함수라 tests/unit에서 검증 가능.
 */
/**
 * 목록에서 실제로 모은 상품 URL들에서 **이 몰의 상품 상세 URL 패턴**을 역산한다 —
 * `PLATFORM_PROFILES`에 없는 몰(platform='unknown')은 상세 URL 패턴이 없어, 상품 링크 판별이 매번
 * "이미지를 감싼 <a>는 전부 상품"이라는 폴백에 의존했다. 그 폴백이 로고·회사소개·배너를 상품으로
 * 주워 미리보기 표본이 엉뚱한 페이지로 잡히고(2026-09-13 투비즈온: `/index.php`, 이어서
 * `/mall/service/company_intro.php`), 개수도 부풀었다. 한 번 학습해 사이트에 기억해두면 개수 세기·
 * 미리보기·스크랩이 **전부 같은 기준**을 쓰게 된다.
 *
 * 규칙(deriveCategoryUrlPattern과 같은 보수적 기준):
 *  - 과반수가 공유하는 "경로 + 쿼리 키" 조합만 패턴으로 인정한다(한두 개짜리 우연은 배제).
 *  - 경로는 그대로, 쿼리는 "그 키가 있다"까지만 본다(값은 상품마다 다르므로).
 *  - 쿼리가 아예 없는 몰(경로에 상품번호가 들어가는 형태)은 마지막 숫자 조각을 \\d+로 일반화한다.
 *  - 근거가 부족하면 null — 잘못된 패턴을 저장하면 그 몰의 상품을 전부 놓치므로 "모름"이 더 안전하다.
 */
export function deriveDetailUrlPattern(urls: string[]): string | null {
  if (urls.length < 3) return null
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // 경로에 상품번호가 들어가는 몰(/product/1234)은 URL마다 경로가 달라, 숫자를 지운 형태로 묶어야
  // "같은 모양"으로 인식된다 — 이 정규화를 안 하면 그런 몰에서 과반수 판정이 항상 실패한다(테스트로 확인).
  const shapeKeyOf = (pathname: string) => pathname.replace(/\d+/g, '#')
  const shapes = new Map<string, { count: number; pathname: string; keys: string[] }>()
  for (const u of urls) {
    try {
      const x = new URL(u)
      const keys = [...new Set(x.searchParams.keys())].sort()
      const shape = `${shapeKeyOf(x.pathname)}|${keys.join(',')}`
      const prev = shapes.get(shape)
      if (prev) prev.count++
      else shapes.set(shape, { count: 1, pathname: x.pathname, keys })
    } catch { /* URL 파싱 실패는 건너뛴다 */ }
  }
  if (!shapes.size) return null
  const [, best] = [...shapes.entries()].sort((a, b) => b[1].count - a[1].count)[0]
  if (best.count * 2 <= urls.length) return null // 과반수가 아니면 확신 없음
  // 정규식으로 옮길 때도 같은 정규화를 적용한다(숫자는 escape 대상이 아니라 순서 상관없음).
  const pathPattern = escape(best.pathname).replace(/\d+/g, '\\d+')
  if (best.keys.length) {
    // 예: /mall/goods/goods_view.php + [goodsno] → /mall/goods/goods_view\.php\?(?=.*goodsno=)
    const keyPart = best.keys.map(k => `(?=.*${escape(k)}=)`).join('')
    return `${pathPattern}\\?${keyPart}`
  }
  // 쿼리가 없는 형태 — 경로에 숫자가 전혀 없으면 너무 느슨한 패턴이 되므로 배우지 않는다.
  return pathPattern === escape(best.pathname) ? null : `${pathPattern}$`
}

export function deriveCategoryUrlPattern(urls: string[]): string | null {
  // 게시판 글(NON_CATEGORY_PATH_RE)은 애초에 카테고리 후보가 아니므로, "과반수" 기준의 분모(전체 개수)에서도
  // 뺀다 — 안 그러면 진짜 카테고리 URL이 남은 URL의 100%를 차지해도 원래 urls.length 기준 과반수에
  // 못 미쳐 패턴을 못 만드는 경우가 생긴다.
  const nonBoardUrls = urls.filter(u => {
    try { return !NON_CATEGORY_PATH_RE.test(new URL(u).pathname) } catch { return true }
  })
  if (nonBoardUrls.length < 2) return null
  const keyCounts = new Map<string, number>()
  for (const u of nonBoardUrls) {
    try {
      const seenInThis = new Set<string>()
      for (const key of new URL(u).searchParams.keys()) {
        if (seenInThis.has(key)) continue
        seenInThis.add(key)
        keyCounts.set(key, (keyCounts.get(key) || 0) + 1)
      }
    } catch { /* URL 파싱 실패한 항목은 건너뛴다 */ }
  }
  if (!keyCounts.size) return null
  const [bestKey, count] = [...keyCounts.entries()].sort((a, b) => b[1] - a[1])[0]
  // 절반 미만의 URL에만 우연히 겹치는 키는 진짜 패턴으로 보지 않는다(예: 여러 카테고리 중 하나만 특이하게
  // 홍보 파라미터를 달고 있는 경우).
  if (count < Math.ceil(nonBoardUrls.length / 2)) return null
  return `[?&]${bestKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}=`
}

/** deriveCategoryUrlPattern이 찾아둔(=기억해둔) URL 패턴으로, 지금 페이지의 링크 중 그 패턴에 맞는 것을
 *  전부 카테고리로 간주한다 — 구조 스캔이나 AI보다 훨씬 빠르고(그냥 정규식 매칭), 한 번 확인된 몰은
 *  다음부터 거의 즉시 카테고리를 다시 찾을 수 있다.
 *  detailPatternSrc(PLATFORM_PROFILES[platform].detailUrlPattern)로 상품 상세 링크를 먼저 걸러낸다 —
 *  cafe24는 상세 페이지(/product/detail.html?product_no=...&cate_no=...)도 breadcrumb용으로 cate_no
 *  쿼리를 함께 실어보내, 카테고리 목록 페이지(/product/list.html?cate_no=...)와 같은 쿼리 키 패턴을
 *  공유한다 — 패턴 매칭만으론 구분이 안 돼, 걸스굽 실사용에서 129개 중 64개가 실제로는 상품 상세
 *  링크였는데도 "카테고리"로 잡혔다(사용자 스크린샷 확인, 2026-09-03 — 카테고리 그리드에 "상품명 :
 *  KR-0092" 같은 항목이 섞여 나옴). looksLikeRealCategoryBatch의 표본검증(3개만 샘플링)이 우연히 진짜
 *  카테고리만 뽑아 통과시켜 넘어갔던 것 — 근본 원인은 여기, 후보를 만드는 단계에서 걸러야 한다. */
async function scanByKnownUrlPattern(page: Page, patternSrc: string, detailPatternSrc?: string | null): Promise<CategoryMenuLink[]> {
  return page.evaluate(({ patternSrc, detailPatternSrc, brokenTemplateTokenSrc }) => {
    const re = new RegExp(patternSrc)
    const detailRe = detailPatternSrc ? new RegExp(detailPatternSrc) : null
    // NON_CATEGORY_PATH_RE(lib/scraper.ts 상단)와 반드시 같은 값을 유지한다 — page.evaluate 콜백은
    // 브라우저에서 실행돼 바깥 모듈 상수를 그대로 참조할 수 없어(Playwright가 인자로 넘긴 값만 직렬화)
    // 여기에 그대로 복제해둔다. 학습된 패턴이 예전에 오염돼 있었더라도(예: bdId=) 게시판/마이페이지 글은
    // 여기서 다시 걸러 재확산을 막는다.
    const boardPathRe = /\/(board|bbs|mypage)\//i
    // BROKEN_TEMPLATE_TOKEN_RE와 같은 값 — 빈 배너 위젯의 미렌더링 템플릿 토큰(`{$js-banner}` 등)이나
    // placeholder 앵커 텍스트("링크")가 우연히 cate_no= 패턴과 겹치는 href를 물고 있으면 카테고리로 잘못
    // 잡힌다(도매신 실사용 확인, 2026-09-17).
    const brokenTemplateTokenRe = new RegExp(brokenTemplateTokenSrc, 'i')
    const origin = location.origin
    const seen = new Set<string>()
    const result: { name: string; href: string }[] = []
    for (const a of Array.from(document.querySelectorAll('a[href]'))) {
      const href = (a as HTMLAnchorElement).href
      if (!href.startsWith(origin) || !re.test(href)) continue
      if (boardPathRe.test(new URL(href).pathname)) continue
      if (detailRe && detailRe.test(href)) continue
      const norm = href.replace(/\/+$/, '')
      if (seen.has(norm)) continue
      const text = (a.textContent || '').trim()
      if (!text || text === '링크' || brokenTemplateTokenRe.test(text) || brokenTemplateTokenRe.test(href)) continue
      seen.add(norm)
      result.push({ name: text, href })
    }
    return result
  }, { patternSrc, detailPatternSrc: detailPatternSrc ?? null, brokenTemplateTokenSrc: BROKEN_TEMPLATE_TOKEN_RE.source }).catch(() => [])
}

/**
 * "카테고리 메뉴/구조 탐지"의 공용 진입점 — discoverCategoryLinks("카테고리 불러오기")와
 * sampleMallProfile("몰 구조분석"/구조 변화 감지)가 각자 따로 이 판단을 구현하고 있었는데, 후자만
 * AI(detectCategoryLinksWithAI)를 안 타서 겪은 문제로 하나로 합쳤다(도매토피아 실사용 확인,
 * 2026-08-19 — 사이드바의 "카테고리 목록"과 "베스트상품" 위젯이 같은 컨테이너 안에 나란히 있어,
 * scanCategoryMenu가 두 `<ul>`을 구분 못 하고 상품 링크까지 카테고리로 잘못 묶어 왔다. "몰 구조분석"을
 * 먼저 실행해 이 잘못된 결과가 sites.scrape_profile.categoryLinks에 캐시되면, "카테고리 불러오기"가
 * discoverCategoryLinks/AI를 아예 타지 않고 그 캐시를 그대로 돌려줘 화면에도 그대로 나타났다).
 *
 * 순서를 규칙 기반 우선으로 뒤집었다(사용자 요청, 2026-08-26: "규칙기반 방식을 먼저 시도하고, 이후
 * AI 방식으로") — AI(로컬 Ollama)는 느리고 후보가 많으면 실패하기 쉬운데, 신우처럼 규칙 기반(구조
 * 패턴)만으로 충분히 찾히는 몰이 많다는 게 실사용으로 확인됐다. 순서:
 *   0) categoryUrlPattern(이전에 "기억"해둔 이 몰의 카테고리 URL 패턴)이 있으면 그걸로 즉시 스캔 —
 *      구조 스캔/AI보다 훨씬 빠르고 확실하다.
 *   1) findCategoryOverviewLink로 "전체카테고리"류 허브가 있으면 먼저 들어가본다.
 *   2) scanCategoryOverviewPage("제목+목록" 구조) → scanCategoryMenuRobust(클래스명 기반, +
 *      textless 방문 폴백) 순서로 규칙 기반을 전부 시도한다.
 *   3) 그래도 못 찾으면 마지막 수단으로 AI — 이땐 시간을 넉넉히 준다(detectCategoryLinksWithAI의
 *      CATEGORY_AI_TIMEOUT_MS). knownCategoryExamples(수동으로 확인된 카테고리 URL 등)가 있으면
 *      프롬프트에 근거로 얹어 판단을 돕는다.
 * visitTextlessFallback이 false면(가벼운 구조 변화 감지 전용) 페이지를 추가로 방문해야 하는
 * 이미지전용 메뉴 폴백은 건너뛴다(sampleMallProfile의 deep=false와 동일한 이유 — 무거운 작업이라
 * "몰 구조분석" 버튼에서만 한다).
 *
 * 0~3단계 전부, 후보를 반환하면 그 즉시 신뢰하고 멈춘다 — 그런데 "그럴듯해 보이는 것을 가장 먼저
 * 찾은 단계"가 실제로 맞다는 보장이 전혀 없다(사용자 지적, 2026-08-30: "순차적으로 진행하는 한계가
 * 있는 것 같다"). 소꿉노리(0단계가 학습해둔 bdId= 패턴을 무검증으로 재사용) · 도매토피아(0단계가
 * tpl= 패턴을, 그것도 안 되면 AI가 사이트 정보페이지를 그대로 채택) 둘 다 이 패턴으로 반복됐다 —
 * 뒤 단계가 진짜 카테고리를 찾았을 수도 있는데 시도조차 안 된 것. 그래서 각 단계가 후보를 반환해도
 * looksLikeRealCategoryBatch로 대표 표본만 빠르게 교차검증하고, 실패하면 "이 단계는 못 찾은 것"으로
 * 치고 다음 단계로 넘어간다 — expandCategoryHubs가 각 항목을 펼칠 때 이미 하는 검증(상품/하위메뉴/
 * 정렬)과 같은 기준이라, 나중에 어차피 할 확인을 앞당겨 하는 것뿐이다(지금까지의 사고는 전부 "그
 * 단계가 찾은 것 전부가 가짜"였지 일부만 가짜인 적은 없어서, 전수 검증 없이 표본만으로 충분하다). */
async function looksLikeRealCategoryBatch(
  context: BrowserContext, links: CategoryMenuLink[], platform: MallPlatform, productLinkSelector?: string | null,
): Promise<boolean> {
  if (!links.length) return false
  const profile = PLATFORM_PROFILES[platform]
  const detailPatternSrc = profile.detailUrlPattern?.source
  const sampleCount = Math.min(3, links.length)
  const step = Math.max(1, Math.floor(links.length / sampleCount))
  const sampleLinks = Array.from({ length: sampleCount }, (_, i) => links[Math.min(i * step, links.length - 1)])
  const topLevelHrefSet = new Set(links.map(l => canonicalizeHref(l.href)))
  const page = await context.newPage()
  try {
    // 표본 중 단 하나도 못 열었으면(사이트 일시 장애/네트워크 문제 등, 실사용 확인 2026-08-30 —
    // 신우가 검증 도중 실제로 접속 자체가 안 됐음) "가짜라서 못 찾은 것"인지 "확인 자체가 안 된 것"인지
    // 구분할 수 없다 — 이런 경우까지 배제하면 무관한 네트워크 문제로 멀쩡한 카테고리를 통째로 날리는
    // 게 더 큰 사고다. 최소 한 페이지라도 실제로 열어 확인해봤을 때만 "증거 없음=가짜"로 판단한다.
    let anyPageLoaded = false
    for (const link of sampleLinks) {
      const moved = await page.goto(link.href, { waitUntil: 'domcontentloaded', timeout: 15_000 }).then(() => true).catch(() => false)
      if (!moved) continue
      // baseUrl은 사이트 원점(origin)이어야 한다(다른 호출부 전부 new URL(...).origin 참고) — 카테고리
      // 페이지 URL 자체(예: goods_list.php?ctno=007)를 넘기면 실제 상품 상세 링크(goods_view.php?...)는
      // 그 문자열로 시작할 리 없어 href.startsWith(baseUrl) 필터에 전부 걸러졌다(실사용 확인, 2026-09-12
      // — 투비즈온에서 진짜 카테고리 8개를 찾고도 표본검증에서 상품 0개로 나와 매번 가짜로 판정됨).
      const sampleOrigin = new URL(link.href).origin
      // 표본검증도 "이동 직후 한 번만" 세면 늦게 그려지는 몰에서 진짜 카테고리를 가짜로 판정한다
      // (countProductsSettled 주석 참고) — 여기서 한 번 잘못 판단하면 찾아둔 카테고리 묶음 **전체**가
      // 버려지므로, 허브 확장보다 오히려 더 비싼 실수다.
      const probe = await countProductsSettled(page, productLinkSelector || null, profile.productLinkSelector, detailPatternSrc, sampleOrigin)
        .catch(() => ({ count: 0, isLoginPage: false }))
      // 로그인 벽에 막힌 방문은 "가짜 카테고리"의 증거가 아니다 — 그냥 확인이 안 된 것뿐이라, 위
      // anyPageLoaded 주석이 설명하는 "페이지 로드 자체가 실패한 경우"와 같은 방식으로 다룬다: 이
      // 표본은 건너뛰고, 표본 전부가 로그인 벽이었으면(anyPageLoaded가 끝까지 false) "증거 없음=가짜"로
      // 몰지 않고 원래 후보를 그대로 인정한다(펫토리 실사용 확인, 2026-09-06 — 로그인 없이도 대분류
      // 메뉴 자체(class="xans-layout-category")는 보이는데, 검증차 방문하는 각 카테고리 페이지는 전부
      // 로그인 페이지로 리다이렉트돼 예전엔 이걸 "카테고리 아님"으로 오판해 몰 전체가 카테고리 0개로
      // 나왔다 — DOM 메뉴 판정(SELECTOR_TIERS+최소 2개+NON_CATEGORY_TEXT_RE 제외) 자체는 이미 충분히
      // 엄격해, 로그인 벽으로 검증 불가한 몰에서는 이 판정을 그대로 신뢰하는 쪽이 "무조건 빈 결과"보다 낫다).
      if (probe.isLoginPage) continue
      anyPageLoaded = true
      if (probe.count > 0) return true
      const sub = await scanCategoryMenuRobust(page).catch(() => ({ links: [] as CategoryMenuLink[], textlessHrefs: [] as string[] }))
      if (sub.links.some(s => !topLevelHrefSet.has(canonicalizeHref(s.href)))) return true
      const hubUrl = page.url()
      const sortCandidates = await collectSortCandidates(page).catch(() => [])
      if (sortCandidates.some(sc => looksLikeSortLabel(sc.text) && diffQueryParams(hubUrl, sc.href))) return true
    }
    return !anyPageLoaded
  } finally {
    await page.close().catch(() => {})
  }
}

// discoverCategoryMenuByVision이 시작 페이지에서 (MAX_START_PAGE_VISION_ATTEMPTS번 재시도해도) 끝내
// 실패했을 때, 추가로 시도해볼 다른 페이지 수 — 사용자 지시(2026-09-12) "첫 화면에서 안 나오면 다른
// 화면에서도 하게 해서"에 따라 1개가 아니라 여러 페이지를 시도하되, 카테고리 하나 찾자고 페이지를
// 무한정 돌아다니지 않도록 상한을 둔다.
const MAX_CATEGORY_VISION_PAGES = 3

// 로그인/회원가입/약관 등 계정 상태에 영향을 줄 수 있는 페이지는 후보에서 제외한다 — 실사용 확인
// (2026-09-12, 투비즈온): 이 화면들을 후보로 넣었더니 비전이 찍은 좌표를 그대로 클릭하다가 로그인
// 세션이 끊겼다(이후 실행에서 sessionLostDuringAnalysis:true 발생, 정렬 옵션 확인 단계가 카테고리
// 페이지를 열어도 로그인이 풀린 채로 열려 상품이 0개로 보여 실패). "전체 카테고리" 트리거는 모든
// 페이지에 공통인 헤더 요소라 굳이 이런 화면까지 시도할 이유도 없다 — 안전과 무관하게도 득이 없다.
// cart/mypage/order류도 제외한다(실사용 확인, 2026-09-12 — 투비즈온에서 비전이 홈 화면 트리거를 못
// 찾으면 이런 무관한 페이지로 넘어갔는데, 마침 그 페이지에도 "카테고리"처럼 보이는 작은 위젯이 있어
// 표본검증을 통과해버렸다 — 진짜 전체 메뉴(7개 대분류, 51개)가 아니라 8개짜리 부분만 잘못 확정됨).
// 계정/주문 상태에 영향 줄 수 있다는 안전 측면도 login류와 같다.
// exhibit/event류(전시관·기획전 배너 페이지)도 제외한다 — "전체 카테고리" 트리거를 찾을 이유가 없는
// 무관한 페이지인 데다, 그런 페이지의 링크 텍스트("도매자동차용품" 등)가 진짜 카테고리명과 구분이 안 될
// 만큼 그럴듯해서, 뒤(AI 텍스트 폴백)에서 진짜 카테고리 대신 이런 기획전 링크를 잘못 채택하는 사고로도
// 이어졌다(실사용 확인, 2026-09-12).
// (2026-09-13) 이 상수는 이제 "어느 페이지로 갈지"만이 아니라 "무엇을 클릭할지"를 가리는 데도 쓴다 —
// nthHeaderIconCandidate(헤더 아이콘 전수클릭 후보)/clickNearestClickableAtPoint(비전 좌표 클릭) 참고.
// 이름을 CATEGORY_VISION_UNSAFE_URL_RE에서 바꾼 이유도 그것 — 더 이상 비전 경로 전용이 아니다.
export const ACCOUNT_UNSAFE_URL_RE = /\/(member|login|logout|signin|signup|join|agreement|terms|privacy|cart|basket|mypage|order|myorder|exhibit|event)[/.]|goods_exhibit/i

// 비전 모델의 좌표 추정이 같은 화면(같은 스크린샷)을 다시 줘도 호출마다 달라진다(실사용 확인, 여러 차례
// 반복 — 어떤 실행은 정확히 찾고, 바로 다음 실행은 완전히 다른(틀린) 위치를 준다). 그러니 시작 페이지
// (보통 홈 — "전체 카테고리" 트리거가 사는 곳)에서 한 번 실패했다고 곧장 다른(대개 무관한) 페이지로
// 넘어가면, 위 CATEGORY_VISION_UNSAFE_URL_RE로도 다 못 거르는 페이지에서 엉뚱한 부분 결과를 주울
// 위험만 커진다 — 다른 페이지로 넘어가기 전에 시작 페이지에서 몇 번 더 다시 시도해본다.
const MAX_START_PAGE_VISION_ATTEMPTS = 3

/**
 * 카테고리 탐지의 마지막 수단(AI 텍스트 폴백보다 먼저 시도) — "전체 카테고리" 메뉴가 완전히 이미지/
 * 아이콘으로만 돼 있어 텍스트가 전혀 없는 몰(투비즈온 실사용 확인, 2026-09-12 — 상단 카테고리 탭·
 * "전체 카테고리" 버튼 전부 <img>, alt도 비어있음)에서는 DOM 텍스트/셀렉터 기반 스캔이 원천적으로
 * 아무것도 못 찾는다. 화면을 실제로 캡처해 비전 AI에게 "사람이 보는 기준"으로 그 트리거의 위치를 물어본
 * 뒤, CSS 셀렉터가 아니라 화면 좌표로 직접 클릭한다(사용자 지시, 2026-09-12 — "로그인 이후 첫 전체화면
 * 캡쳐를 떠서 사람이 보는 기준의 텍스트를 찾는다거나, 그런 이후 클릭을 해 보던지"). 클릭으로 열리는
 * 메뉴 자체는(투비즈온 기준) 실제 텍스트 링크였으므로, 연 뒤에는 기존 DOM 스캔(scanCategoryMenuRobust)을
 * 그대로 재사용해 카테고리를 읽는다 — 비전은 "메뉴를 여는 것"까지만 맡고, 읽는 것은 이미 검증된 방식을
 * 그대로 믿는다.
 *
 * 첫 화면(보통 지금 있는 페이지, 대개 홈)에서 못 찾으면 그걸로 끝내지 않고 다른 화면 몇 개도 마저
 * 시도한다(사용자 지시, 2026-09-12 — "1단계에서 첫화면만 언급되어 있는데... 다른 화면에서도 하게 해서").
 * 다만 "다른 화면"으로 넘어가기 전에 시작 화면 자체를 MAX_START_PAGE_VISION_ATTEMPTS번 먼저 재시도한다
 * (실사용 확인, 2026-09-12 — 비전의 좌표 추정이 같은 화면에서도 호출마다 크게 달라져, 한 번 실패했다고
 * 곧장 다른 화면으로 넘어가면 그쪽에서 엉뚱한 부분 결과를 주울 위험이 실제로 있었다: 투비즈온에서 홈
 * 화면 인식이 실패하자 무관한 페이지(장바구니/마이페이지)에서 우연히 표본검증을 통과하는 작은 위젯을
 * 잘못 확정해, 진짜 전체 메뉴(대분류 7개, 51개)가 아니라 8개짜리 부분만 카테고리로 저장된 사고). 그래도
 * 안 되면 candidatePages(이미 페이지에서 찾은 같은 사이트 링크들, 위험한 페이지는 제외) 중 최대
 * MAX_CATEGORY_VISION_PAGES-1개까지 한 번씩 시도하고, 하나라도 성공(트리거 클릭 후 실제 카테고리 링크
 * 까지 확인)하면 그 자리에서 멈춘다.
 */

// 비전 좌표 보정 반경 — 도매창고 실사용 확인(2026-09-20): 진짜 "Category" 버튼은 (182,216)에 있는데
// 비전이 (80,300)을 줘서(elementFromPoint가 그 아래 배너 슬라이더를 짚음) 클릭이 매번 허탕이었다. 그
// 오차(약 132px)를 덮을 반경.
const CLICK_TARGET_SEARCH_RADIUS_PX = 150

/** 비전이 준 좌표 근처에서 실제 클릭 가능한 요소(a/button/img/[onclick]/[role=button])만 후보로 삼아
 *  가장 가까운 것에 클릭을 보낸다 — 순진하게 `elementFromPoint(x,y)`가 돌려주는 요소를 그대로 쓰면 두
 *  가지 실패가 있었다:
 *  1. 실사용 확인(2026-09-12, 투비즈온) — 좌표가 기하학적으로는 정확히 올바른 `<li>`(전체 카테고리
 *     버튼을 담은) 안에 들어갔는데도, 그 정확한 픽셀이 `<li>`의 여백(자식 `<img>`가 li 전체를 채우지
 *     않음)에 걸려 있어 raw `page.mouse.click(x,y)`로는 jQuery가 `<img class="total-category-btn">`에
 *     직접 바인딩한 클릭 핸들러가 전혀 발동하지 않았다 — 메뉴가 안 열려 매번 "클릭 후에도 링크 0개".
 *  2. 실사용 확인(2026-09-20, 도매창고) — 좌표 자체가 진짜 버튼에서 132px 떨어진 배너 슬라이더 위였다.
 *     처음엔 "그 지점의 요소 자신이나 그 하위(`querySelector`)에 클릭 대상이 있으면 그대로 둔다"로
 *     고쳤는데, 배너 슬라이더처럼 큰 컨테이너는 그 서브트리 어딘가에 거의 항상 `<img>`/`<a>`가 있어서
 *     (관련 없는 배너 이미지일 뿐인데도) "이미 정상"으로 오판해 그 엉뚱한 자식을 클릭해버렸다.
 *  두 문제 모두 "그 지점 요소 자체 또는 그 아래 서브트리"를 보는 대신, 화면에서 실제 클릭 가능한
 *  요소들의 목록을 직접 모아 **중심 좌표가 그 지점에 가장 가까운 것**(반경 CLICK_TARGET_SEARCH_RADIUS_PX
 *  이내)을 찾는 방식으로 한 번에 해결된다 — 좌표가 이미 정확한 경우(대부분)도 자연히 그 요소 자신이
 *  거리 0에 가까워 그대로 뽑히고, 살짝 빗나간 경우(1)도 딱 그 요소가 뽑히며, 아예 다른 위치를 가리킨
 *  경우(2)도 무관한 큰 컨테이너는 애초에 후보 선택자에 안 걸려 후보 자체가 안 된다. 잘못 뽑아도
 *  호출부(discoverCategoryMenuByVision 등)가 클릭 후 결과를 표본검증/그룹수 비교로 다시 확인하므로,
 *  엉뚱한 걸 눌렀다면 그 결과가 채택되지 않을 뿐 새로운 실패 유형을 만들지 않는다. */
async function clickNearestClickableAtPoint(page: Page, x: number, y: number, mallName = '?'): Promise<boolean> {
  const handle = await page.evaluateHandle(({ x, y, radius }) => {
    let best: { el: Element; dist: number } | null = null
    for (const el of Array.from(document.querySelectorAll('a, button, img, [onclick], [role="button"]'))) {
      const rect = el.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) continue
      const style = getComputedStyle(el)
      if (style.visibility === 'hidden' || style.display === 'none') continue
      const dist = Math.hypot(rect.left + rect.width / 2 - x, rect.top + rect.height / 2 - y)
      if (dist <= radius && (!best || dist < best.dist)) best = { el, dist }
    }
    return best?.el ?? null
  }, { x, y, radius: CLICK_TARGET_SEARCH_RADIUS_PX }).catch(() => null)
  const element = handle?.asElement()
  if (!element) {
    console.log(`[카테고리탐지:진단:${mallName}] 화면 인식: 좌표(${x.toFixed(0)},${y.toFixed(0)}) 근처 ${CLICK_TARGET_SEARCH_RADIUS_PX}px 안에서 클릭 가능한 요소를 못 찾음`)
    await handle?.dispose().catch(() => {})
    await page.mouse.move(x, y).catch(() => {})
    await page.mouse.click(x, y).catch(() => {})
    return false
  }
  // 뽑힌 요소(또는 그 조상 링크/버튼)가 계정 링크(로그아웃 등)면 아예 클릭하지 않는다 — 비전의 좌표
  // 추정은 같은 화면에서도 호출마다 크게 달라지는데(discoverCategoryMenuByVision 주석), 몰 헤더는
  // "전체 카테고리" 트리거와 계정 링크가 바로 옆에 붙어있는 자리라 빗나간 좌표가 로그아웃에 떨어질 수
  // 있다(투비즈온 실사용 확인, 2026-09-12 — 계정 페이지를 클릭하다 세션이 끊김). 기존 방어
  // (ACCOUNT_UNSAFE_URL_RE로 후보 "페이지"를 거르는 것)는 어느 화면으로 갈지만 막았을 뿐 그 화면에서
  // 무엇을 누르는지는 안 봤다 — 홈 화면에도 로그아웃 링크는 항상 있다.
  const unsafe = await element.evaluate((el, { unsafeUrlSrc, logoutTextSrc }) => {
    const unsafeUrlRe = new RegExp(unsafeUrlSrc, 'i')
    const logoutTextRe = new RegExp(logoutTextSrc, 'i')
    const link = el.closest('a, button') || el.querySelector('a[href], button')
    const urls = `${el.getAttribute('href') || ''} ${el.getAttribute('onclick') || ''}`
      + ` ${link ? link.getAttribute('href') || '' : ''} ${link ? link.getAttribute('onclick') || '' : ''}`
    const labels = `${el.textContent || ''} ${el.getAttribute('alt') || ''} ${el.getAttribute('title') || ''}`
      + ` ${link ? link.textContent || '' : ''}`
    return unsafeUrlRe.test(urls) || logoutTextRe.test(labels)
  }, { unsafeUrlSrc: ACCOUNT_UNSAFE_URL_RE.source, logoutTextSrc: LOGOUT_TEXT_RE.source }).catch(() => false)
  if (unsafe) {
    console.log(`[카테고리탐지:진단:${mallName}] 화면 인식: 좌표(${x.toFixed(0)},${y.toFixed(0)}) 근처에 계정 관련 링크(로그아웃/마이페이지 등)가 있어 클릭하지 않음 — 로그인 세션 보호`)
    await handle?.dispose().catch(() => {})
    return false
  }
  const clicked = await element.click({ timeout: 3_000 }).then(() => true).catch(() => false)
  await handle?.dispose().catch(() => {})
  if (!clicked) {
    await page.mouse.move(x, y).catch(() => {})
    await page.mouse.click(x, y).catch(() => {})
  }
  return clicked
}
/** 카테고리 메뉴 탐지 결과 — screenNames는 "그 메뉴가 열린 화면에서 사람이 읽을 수 있는 카테고리 이름"
 *  으로, 최종 결과를 이 목록과 대조해 누락을 사용자에게 알려주는 데 쓴다(사용자 지시, 2026-09-13).
 *  null = 화면 인식이 실패했거나 시도하지 않음(대조를 건너뛴다 — 근거 없이 "누락"이라고 단정하지 않는다). */
interface CategoryMenuDiscovery {
  links: CategoryMenuLink[]
  groupCount: number
  screenNames: string[] | null
  /** screenNames와 같은 화면에서 같이 받아온 "대분류→하위 카테고리" 그룹 구조 — 사람이 화면을 보듯
   *  대/중/소분류가 어떻게 묶이는지까지 보여주는 용도(사용자 지시, 2026-09-15). screenNames와 달리
   *  재검증(missing/extra) 판정에는 쓰이지 않는다 — 화면 대조 카드에 참고로 같이 보여주기만 한다. */
  screenHierarchy?: { group: string; items: string[] }[] | null
  /** 메뉴가 열려 있던 그 화면의 모든 링크(텍스트+href) — 화면에서 읽은 이름만 있고 URL을 모르는
   *  누락 카테고리를 재검증하려면 그 이름의 링크를 찾아야 한다(recoverMissingCategories). 화면을
   *  캡처한 바로 그 순간에 같이 모아둔다 — 루프가 끝나면 그 DOM은 사라진다. */
  menuLinks?: { text: string; href: string }[]
}

// 비전이 찾은 그룹 수가 이 이상이면 "그럴듯하지만 일부만"이 아니라 진짜로 여러 대분류를 다 찾은 것으로
// 믿는다(discoverCategoryMenuByVision의 케이스 a/b, discoverTopLevelCategoryLinks의 비전-vs-전수클릭
// 경쟁이 공유하는 기준선 — 사용자 지시, 2026-09-12 "다른 방법으로 해").
const VISION_CONFIDENT_GROUP_COUNT = 3

/** 메뉴가 열렸는데도(트리거 클릭 성공) scanCategoryMenuRobust가 링크를 하나도 못 찾는 몰이 있다 — 실사용
 *  확인(2026-09-20, 도매창고): 카테고리 항목이 `<a href>`도 `onclick="location.href=...`도 아니라
 *  `<li data-id="20000004">생활 / 건강</li>` 형태로, 부모 컨테이너에 걸린 이벤트 위임(event delegation)
 *  리스너가 클릭 시 `data-id` 값을 읽어 자바스크립트로 URL을 조립해 이동시킨다 — 정적 마크업 어디에도
 *  URL이 문자열로 존재하지 않아 hrefFromOnclick 같은 정규식 추출로는 원천적으로 못 찾는다.
 *
 *  이 경우 URL을 "추측"하는 대신 실제로 확인한다: 후보 중 하나만 실제로 클릭해 어디로 이동하는지 보고,
 *  그 URL의 쿼리파라미터 중 방금 클릭한 항목의 data-* 값과 정확히 일치하는 게 있으면 그 쿼리 키를
 *  "이 몰의 카테고리 이동 패턴"으로 확정해, 나머지 후보들의 URL도 같은 키에 각자의 data-* 값만 바꿔
 *  끼워 넣어 만든다(실제로 관찰된 패턴을 그대로 적용하는 것이지 근거 없는 추측이 아니다 — 같은 위젯이
 *  찍어낸 형제 항목들이라 URL 구조가 동일하다고 볼 근거가 충분하다). 일치하는 쿼리파라미터가 없으면
 *  (패턴을 못 찾으면) 빈 배열을 돌려줄 뿐 잘못된 URL을 지어내지 않는다.
 *
 *  onlyNames를 주면(하위 카테고리 확장, expandCategoryChildrenByVision 참고) 이미 화면에서 비전으로
 *  읽어 확인한 이름들만 후보로 삼는다 — 그 이름이 진짜 카테고리라는 근거(화면에 보임)가 이미 있으므로,
 *  대분류 탐지 때처럼 "cat/lnb/gnb 등" 컨테이너로 후보 영역을 미리 좁힐 필요가 없다(오히려 하위 메뉴
 *  패널이 그 선택자들과 무관한 곳에 나타나는 몰까지 놓치지 않으려면 문서 전체를 보는 쪽이 안전하다). */
async function resolveDataAttributeCategoryLinks(page: Page, mallName: string, onlyNames?: string[]): Promise<CategoryMenuLink[]> {
  const candidates = await page.evaluate((onlyNamesArg) => {
    const isMeaningful = (s: string) => !!s && /[가-힣a-zA-Z0-9]/.test(s)
    const onlyNamesSet = onlyNamesArg ? new Set(onlyNamesArg) : null
    const roots = onlyNamesSet ? [document.body] : Array.from(document.querySelectorAll(
      '[class*="cat" i], [id*="cat" i], [class*="lnb" i], [id*="lnb" i], [class*="snb" i], [id*="snb" i], [class*="ovmenu" i], [class*="gnb" i], [id*="gnb" i], nav',
    ))
    const seen = new Set<string>()
    const result: { name: string; attrName: string; attrValue: string }[] = []
    for (const root of roots) {
      for (const el of root.querySelectorAll('*')) {
        if (el.children.length > 0) continue // 리프 노드만 — 그룹 라벨(하위를 담은 상위)은 제외
        if (el.querySelector('a[href], button, [onclick]')) continue // 이미 정상 href/onclick 경로로 잡혔을 것
        const text = (el.textContent || '').trim()
        if (!isMeaningful(text) || text.length > 30) continue
        if (onlyNamesSet && !onlyNamesSet.has(text)) continue
        const dataAttr = Array.from(el.attributes).find(a => a.name.startsWith('data-') && /^\d+$/.test(a.value))
        if (!dataAttr) continue
        const key = `${dataAttr.name}:${text}`
        if (seen.has(key)) continue
        seen.add(key)
        result.push({ name: text, attrName: dataAttr.name, attrValue: dataAttr.value })
      }
    }
    return result.slice(0, 60)
  }, onlyNames ?? null).catch(() => [])
  if (!candidates.length) return []

  const first = candidates[0]
  const beforeUrl = page.url()
  const navigated = await Promise.all([
    page.waitForNavigation({ timeout: 8_000 }).then(() => true).catch(() => false),
    page.evaluate(({ attrName, attrValue }) => {
      const el = Array.from(document.querySelectorAll(`[${attrName}]`)).find(e => e.getAttribute(attrName) === attrValue)
      if (el instanceof HTMLElement) el.click()
    }, { attrName: first.attrName, attrValue: first.attrValue }).catch(() => {}),
  ]).then(([ok]) => ok)
  if (!navigated) {
    console.log(`[카테고리탐지:진단:${mallName}] data-속성 카테고리 폴백: "${first.name}"(${first.attrName}=${first.attrValue}) 클릭해도 이동 없음 — 포기`)
    return []
  }
  const afterUrl = page.url()
  await page.goto(beforeUrl, { waitUntil: 'load', timeout: 20_000 }).catch(() => {})

  let queryKey: string | null = null
  try {
    const after = new URL(afterUrl)
    for (const [k, v] of after.searchParams.entries()) {
      if (v === first.attrValue) { queryKey = k; break }
    }
  } catch { /* URL 파싱 실패 — 아래 queryKey null 처리로 자연히 폐기 */ }
  if (!queryKey) {
    console.log(`[카테고리탐지:진단:${mallName}] data-속성 카테고리 폴백: "${first.name}" 클릭 후 ${afterUrl}로 이동했지만 data-값(${first.attrValue})과 일치하는 쿼리파라미터를 못 찾음 — 포기`)
    return []
  }
  console.log(`[카테고리탐지:진단:${mallName}] data-속성 카테고리 폴백: "${first.name}"(${first.attrName}=${first.attrValue}) 클릭 → ${afterUrl} — 쿼리 "${queryKey}"를 이동 패턴으로 확정, 나머지 ${candidates.length - 1}개도 같은 패턴 적용`)
  const afterUrlObj = new URL(afterUrl)
  const links: CategoryMenuLink[] = candidates.map(c => {
    const u = new URL(afterUrlObj.toString())
    u.searchParams.set(queryKey as string, c.attrValue)
    return { name: c.name, href: u.toString() }
  })
  return links
}

/** "카테고리 가져오기"의 하위구조 확장(expandCategoryChildren)이 기존 방식(그 대분류 자신의 페이지를
 *  열어 그 안에서 href를 찾는 것)으로 하나도 못 찾았을 때 쓰는 마지막 수단 — 대분류 탐지 때 이미 검증된
 *  "화면을 사람처럼 보면서 찾는다"는 원칙을 하위 단계에도 그대로 적용한다(사용자 지시, 2026-09-20 —
 *  "몇 가지 안 되는 카테고리 형태에 대해 사람이 화면을 보면서 대중소분류 그 이하까지 추적하면 다
 *  파악된다"). 도매창고 실사용 확인: 하위 카테고리 목록이 그 대분류 자신의 페이지엔 전혀 없고, 홈의
 *  메가메뉴에서 그 대분류에 마우스를 올렸을 때만 나타난다 — "페이지를 열어서 스캔"이라는 기존 전제
 *  자체가 이런 몰에는 안 맞는다.
 *
 *  절차(사람이 메뉴를 한 단계씩 펼쳐보는 것과 동일): ① 시작 페이지에서 카테고리 트리거를 찾아 클릭
 *  ② parentName의 경로("대분류 > 중분류 > ...")를 앞에서부터 한 구간씩 화면에서 이름으로 찾아 실제로
 *  클릭/마우스오버해 들어간다 ③ 마지막 구간까지 펼친 화면을 다시 캡처해 비전으로 "지금 보이는 하위
 *  이름"을 읽는다 ④ 그 이름들을 화면의 실제 링크와 대조해 href를 찾고, href가 없으면(자바스크립트
 *  전용 메뉴) 대분류에서 쓴 것과 같은 방식(하나만 실제로 클릭해 이동 패턴을 배움)으로 URL을 만든다
 *  ⑤ 항상 표본검증(looksLikeRealCategoryBatch)으로 진짜 상품 목록인지 확인한 뒤에만 채택한다.
 *
 *  이 몰의 API/마크업 형태를 전혀 안 보고 "화면에 실제로 보이는 것"만 근거로 삼으므로, 메가메뉴가
 *  AJAX든 CSS 호버든 다른 무엇으로 구현됐든 똑같이 동작한다 — 몰마다 새로 만드는 게 아니라 대분류
 *  탐지에서 이미 쓰던 함수들(트리거 탐지/화면 계층 읽기/화면-DOM 대조)을 그대로 재사용한다. */
/** URL의 쿼리파라미터 중 값이 숫자로만 된 것들 — resolveDataAttributeCategoryLinks가 이미 확인해둔
 *  것처럼 이 몰에서는 그 값이 곧 카테고리 항목의 data-id 값과 같다(실제 클릭으로 검증된 관계). 화면에서
 *  이름으로 다시 찾는 대신 이 값으로 바로 그 요소를 찾을 수 있으면, 비전이 글자를 잘못 읽을 위험 자체가
 *  없다. 키도 같이 돌려주는 이유: 어떤 값이 실제로 매칭됐는지 확인되면, 그 키를 재사용해 형제 항목들의
 *  URL도 새로 클릭하지 않고 바로 만들 수 있다(아래 childNames 해석 부분 참고). */
function extractNumericIdCandidatesFromUrl(url: string): { key: string; value: string }[] {
  try {
    const u = new URL(url)
    const seen = new Set<string>()
    const out: { key: string; value: string }[] = []
    for (const [key, value] of u.searchParams.entries()) {
      if (!/^\d+$/.test(value) || seen.has(value)) continue
      seen.add(value)
      out.push({ key, value })
    }
    return out
  } catch {
    return []
  }
}

async function expandCategoryChildrenByVision(
  context: BrowserContext, page: Page, mallName: string, startUrl: string, parentUrl: string, parentName: string,
  platform: MallPlatform, productLinkSelector?: string | null, signal?: AbortSignal, knownSiblingNames: string[] = [],
  ancestorUrls: (string | null)[] = [],
): Promise<CategoryLink[]> {
  const moved = await page.goto(startUrl, { waitUntil: 'load', timeout: 20_000 }).then(() => true).catch(() => false)
  if (!moved) return []

  // 트리거를 찾아도 그 좌표에 실제로 클릭할 게 없으면(비전이 홈 화면의 회전 배너 등으로 매번 같은 틀린
  // 좌표를 주는 경우 — discoverCategoryMenuByVision 주석 참고) 메뉴가 안 열린 채로 그냥 진행해버려서,
  // 뒤에서 읽는 화면이 실제로는 메뉴가 닫힌 홈 화면(상단 보조메뉴: 베스트5000/신상품 등)이 되고, 그걸
  // "하위 카테고리를 못 찾음"으로 잘못 보고하게 된다(도매창고 실사용 확인, 2026-09-21 — 재귀로 형제
  // 카테고리 여러 개를 연달아 펼칠 때 6/7이 이 경로로 조용히 실패했다). 새로고침 후 한 번 더 시도하고,
  // 그래도 못 열면 화면 자체가 신뢰할 수 없다는 뜻이니 여기서 바로 포기한다.
  for (let attempt = 1; attempt <= 2; attempt++) {
    if (attempt > 1) {
      const reloaded = await page.goto(startUrl, { waitUntil: 'load', timeout: 20_000 }).then(() => true).catch(() => false)
      if (!reloaded) return []
    }
    const screenshot = await page.screenshot({ type: 'jpeg', quality: 90 }).catch(() => null)
    if (!screenshot) return []
    const trigger = await detectCategoryMenuTriggerFromScreenshot(mallName, screenshot.toString('base64'), 'image/jpeg', signal).catch(() => null)
    if (!trigger?.found) break // 트리거 자체가 안 보이면(이미 항상 펼쳐진 GNB 등) 재시도해도 의미 없다 — 그대로 진행.
    const viewport = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }))
      .catch(() => page.viewportSize() ?? { width: 1280, height: 800 })
    const x = viewport.width * (trigger.xPercent / 100)
    const y = viewport.height * (trigger.yPercent / 100)
    const clicked = await clickNearestClickableAtPoint(page, x, y, mallName)
    await sleep(400)
    if (clicked) break
    if (attempt === 2) {
      console.log(`[하위카테고리:비전진단:${mallName}] "${parentName}" — 카테고리 메뉴 트리거를 두 번 다 못 열어 포기`)
      return []
    }
  }

  let screenshot = await page.screenshot({ type: 'jpeg', quality: 90 }).catch(() => null)
  if (!screenshot) return []

  // parentName은 루트부터의 전체 경로("대분류 > 중분류")다 — 각 구간을 순서대로 화면에서 찾아 클릭해
  // 들어간다. 대분류 하나만 확장할 때는(depth=1) 구간이 하나뿐이라 이 루프가 그대로 case b 트리거 클릭과
  // 같은 동작이 된다 — 깊이와 무관하게 같은 코드로 처리된다는 뜻.
  const pathSegments = parentName.split(' > ').map(s => s.trim()).filter(Boolean)
  // 각 구간의 실제 확인된 URL(알면). 그 쿼리값이 화면의 어떤 data-id와 일치하면, 비전이 이름을 잘못 읽을
  // 위험 없이 바로 그 요소를 찾을 수 있다(도매창고 실사용 확인, 2026-09-20 — 비전이 "생활 / 건강"을
  // "생활 / 간식"으로 두 글자나 잘못 읽어 이름 대조가 실패했다. 2026-09-21 — 마지막 구간만이 아니라 중간
  // 구간(예: "DVD"의 부모인 "생활 / 건강")에서도 같은 오독이 나 전체가 실패했다. 재귀 확장은 조상 각각의
  // URL을 이미 실제로 방문해 알고 있으므로, 마지막 구간뿐 아니라 아는 구간은 전부 이 경로를 쓴다). 마지막
  // 구간(parentUrl, 지금 펼치려는 바로 그 카테고리)은 항상 알고, 나머지는 ancestorUrls로 넘겨받은 만큼만
  // 안다 — 모르는 구간은 기존 이름 대조로 처리한다.
  const pathUrls: (string | null)[] = pathSegments.map((_, i) =>
    i === pathSegments.length - 1 ? parentUrl : (ancestorUrls[i] ?? null))
  let confirmedQueryKey: string | null = null
  for (let i = 0; i < pathSegments.length; i++) {
    const segment = pathSegments[i]
    const isLastSegment = i === pathSegments.length - 1
    const idCandidates = pathUrls[i] ? extractNumericIdCandidatesFromUrl(pathUrls[i]!) : []
    if (idCandidates.length) {
      // 마우스오버만 보낸다 — click()까지 부르면 이 항목 자신의 이동(그 카테고리 자신의 상품 목록
      // 페이지, parentUrl과 같은 곳)이 그대로 실행돼 메가메뉴 자체가 사라져버린다(도매창고 실사용
      // 확인, 2026-09-20 — 그 직후 화면엔 이동한 상품 목록 페이지의 필터 패널(판매상태/배송타입/
      // 과세여부, 3개)만 남아 있어 하위 카테고리를 전혀 못 읽었다). 사람도 하위 메뉴를 보려고 마우스만
      // 올려둘 뿐 클릭까진 안 한다.
      const matchedKey = await page.evaluate((cands) => {
        for (const { key, value } of cands) {
          const el = document.querySelector(`[data-id="${value}"]`)
          if (el instanceof HTMLElement) {
            el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }))
            el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
            return key
          }
        }
        return null
      }, idCandidates).catch(() => null)
      if (matchedKey) {
        // 뒤에서(href 없는 항목들) parentUrl을 템플릿으로 data-id를 꽂아 넣을 때 쓸 쿼리 키는 마지막
        // 구간(지금 펼치는 카테고리 자신) 기준이어야 한다 — 중간 구간에서 확인된 키를 여기 섞으면 안 된다.
        if (isLastSegment) confirmedQueryKey = matchedKey
        console.log(`[하위카테고리:비전진단:${mallName}] "${segment}" — 화면 이름 대신 확인된 URL의 id로 바로 마우스오버(쿼리 "${matchedKey}")`)
        await sleep(400)
        continue
      }
      console.log(`[하위카테고리:비전진단:${mallName}] "${segment}" — id로 못 찾음, 화면 이름 대조로 폴백`)
    }
    screenshot = await page.screenshot({ type: 'jpeg', quality: 90 }).catch(() => null)
    if (!screenshot) return []
    const names = await detectVisibleCategoryNames(mallName, screenshot.toString('base64'), 'image/jpeg', signal).catch(() => null)
    if (!names?.length) {
      console.log(`[하위카테고리:비전진단:${mallName}] "${parentName}" 경로 진행 중 "${segment}"를 찾으려 했지만 화면 인식 실패`)
      return []
    }
    const key = normalizeCategoryName(segment)
    const normalizedNames = names.map(n => ({ raw: n, key: normalizeCategoryName(n) }))
    const exact = normalizedNames.find(n => n.key === key)
    const approxKey = exact ? null : findApproximateMatch(key, normalizedNames.map(n => n.key))
    const matchedName = exact?.raw ?? normalizedNames.find(n => n.key === approxKey)?.raw
    if (!matchedName) {
      console.log(`[하위카테고리:비전진단:${mallName}] "${parentName}" 경로 진행 중 화면에서 "${segment}"를 못 찾음(보인 이름: ${names.slice(0, 20).join(', ')})`)
      return []
    }
    // 여기도 마우스오버만 — 위 id 클릭 경로와 같은 이유(click()은 그 항목 자신의 이동을 실행시켜
    // 메가메뉴를 닫아버린다).
    const clicked = await page.evaluate((text) => {
      const el = Array.from(document.querySelectorAll('*'))
        .find(e => e.children.length === 0 && (e.textContent || '').trim() === text)
      if (!(el instanceof HTMLElement)) return false
      el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }))
      el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
      return true
    }, matchedName).catch(() => false)
    if (!clicked) {
      console.log(`[하위카테고리:비전진단:${mallName}] "${parentName}" 경로 진행 중 "${matchedName}" 요소를 못 찾아 클릭/마우스오버 실패`)
      return []
    }
    await sleep(400)
  }

  // 마지막 구간까지 펼친 화면에서 실제로 보이는 하위 목록을 읽는다 — 계층까지 구분해서 보이면
  // detectVisibleCategoryHierarchy를, 평평한 목록으로만 보이면 detectVisibleCategoryNames를 쓴다.
  screenshot = await page.screenshot({ type: 'jpeg', quality: 90 }).catch(() => null)
  if (!screenshot) return []
  const hierarchy = await detectVisibleCategoryHierarchy(mallName, screenshot.toString('base64'), 'image/jpeg', signal).catch(() => null)
  let childNames: string[] = []
  if (hierarchy?.length) {
    // 그룹 여럿 중 일부만 items가 있으면, items 없는 그룹은 "하위가 없는 리프"가 아니라 화면에 그대로
    // 남아있는 무관한 형제 목록(옆의 대분류 사이드바 등)일 가능성이 높다 — flattenVisibleCategoryHierarchy는
    // items가 없으면 그룹 이름 자체를 리프로 삼는데, 이걸 무조건 적용하면 그 무관한 이름들까지 하위로
    // 오인한다(도매창고 실사용 확인, 2026-09-21 — "공구"를 펼쳤는데 옆에 그대로 보이던 대분류 목록 중
    // 아직 모르던 "식품"(0개 그룹)이 "공구"의 하위인 것처럼 잡혀, 그 아래로 완전히 무관한 서브트리가
    // 재귀로 만들어졌다). 그룹이 전부 items 0개일 때만(예: 도매신처럼 항상 펼쳐진 가로 GNB, 하위 없이
    // 이름만 나란히 보이는 경우) 그룹 이름 자체를 리프로 쓴다.
    const populated = hierarchy.filter(h => h.items.length > 0)
    childNames = Array.from(new Set(flattenVisibleCategoryHierarchy(populated.length ? populated : hierarchy).map(c => c.leafText)))
  }
  if (!childNames.length) {
    childNames = await detectVisibleCategoryNames(mallName, screenshot.toString('base64'), 'image/jpeg', signal).catch(() => null) ?? []
  }
  if (!childNames.length) {
    console.log(`[하위카테고리:비전진단:${mallName}] "${parentName}" 펼친 화면에서 하위 항목을 못 읽음`)
    return []
  }

  // 마우스오버로 패널을 펼쳐도 옆 대분류 가로 목록(형제들)이 화면에 그대로 남아 있으면, 비전이 그
  // 형제들도 이름만 있는 그룹(items 없는)으로 같이 돌려줘 평탄화 결과에 섞인다(도매창고 실사용 확인,
  // 2026-09-20 — "생활 / 건강"을 펼쳤는데 문구/사무용품·가구/인테리어 등 다른 대분류 9개가 하위로
  // 같이 잡힘). "어느 그룹이 진짜 하위인지" 비전의 그룹 나누기 자체를 더 믿기보다, 이미 확실히 아는
  // 사실(이 몰의 대분류 이름들과, 지금까지 밟아 온 경로 구간 이름들)로 걸러내는 쪽이 더 신뢰할 수 있다 —
  // 그 이름들은 이미 사람이 보든 비전이 보든 한 번 확인된 값이지 추측이 아니다.
  const exclude = new Set([...knownSiblingNames, ...pathSegments].map(normalizeCategoryName).filter(Boolean))
  if (exclude.size) {
    const before = childNames.length
    childNames = childNames.filter(n => {
      const key = normalizeCategoryName(n)
      if (!key) return false
      if (exclude.has(key)) return false
      return !findApproximateMatch(key, exclude)
    })
    if (childNames.length !== before) {
      console.log(`[하위카테고리:비전진단:${mallName}] "${parentName}" — 이미 아는 대분류/경로 이름과 겹쳐 ${before - childNames.length}개 제외`)
    }
  }
  if (!childNames.length) {
    console.log(`[하위카테고리:비전진단:${mallName}] "${parentName}" 펼친 화면에서 걸러내고 나니 하위 항목이 안 남음`)
    return []
  }

  const pageLinks = await collectAllPageLinks(page).catch(() => [])
  const candidates: VisibleCategoryCandidate[] = childNames.map(name => ({ name: `${parentName} > ${name}`, leafText: name }))
  const matched = matchVisibleCategoryLinksToHrefs(candidates, pageLinks).filter(l => !isNonCategoryCandidate(l.name, l.href))

  // href가 안 잡힌 이름들은 href/onclick이 아예 없는 자바스크립트 전용 메뉴일 수 있다 — 대분류 탐지 때
  // 쓰는 resolveDataAttributeCategoryLinks를 여기서 그대로 재사용하면, 그 함수 내부가 "후보 하나를 실제로
  // 클릭해 이동 패턴을 배우는" 동작이라 지금 펼쳐둔 메가메뉴 패널에서 실제 이동을 일으켜 나머지 항목을
  // 찾을 화면 자체를 지워버린다(도매창고 실사용 확인, 2026-09-20 — 남은 항목이 전부 cid=0으로 나옴).
  // 이미 위 id 마우스오버 단계에서 이 몰의 data-id↔쿼리 매핑을 클릭 없이 확인해뒀다면(confirmedQueryKey),
  // 그 매핑만 그대로 적용해 각 항목 자신의 data-id 값을 읽어(클릭 없이) URL을 만든다.
  const matchedLeafKeys = new Set(matched.map(l => normalizeCategoryName(l.name.split(' > ').pop() || l.name)))
  const unresolvedNames = childNames.filter(n => !matchedLeafKeys.has(normalizeCategoryName(n)))
  if (unresolvedNames.length && confirmedQueryKey) {
    // 화면에 보이는 [data-id] 요소 전체의 (텍스트, data-id)를 한 번에 모아온 뒤, matchVisibleCategoryLinksToHrefs와
    // 같은 방식(정확히 일치 → 안 되면 findApproximateMatch)으로 대조한다 — 비전이 한두 글자 잘못 읽은
    // 이름("관상이용품"→실제 "관상어용품")도 이걸로 흡수된다. 그래도 안 맞으면(예: "죄의/죄혼용품" vs
    // 실제 "좌욕/좌훈용품"처럼 여러 글자가 틀려 허용 편집거리를 넘으면) 지어내지 않고 버린다.
    const allDataIdTexts = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('[data-id]'))
        .filter(e => e.children.length === 0)
        .map(e => ({ text: (e.textContent || '').trim(), dataId: e.getAttribute('data-id') || '' }))
        .filter(e => e.text && e.dataId)
    }).catch(() => [] as { text: string; dataId: string }[])
    const byText = new Map<string, { dataId: string; realText: string }>()
    for (const { text, dataId } of allDataIdTexts) {
      const key = normalizeCategoryName(text)
      if (key && !byText.has(key)) byText.set(key, { dataId, realText: text })
    }
    for (const name of unresolvedNames) {
      const key = normalizeCategoryName(name)
      if (!key) continue
      const found = byText.get(key) ?? (() => {
        const approx = findApproximateMatch(key, byText.keys())
        return approx ? byText.get(approx) : undefined
      })()
      if (!found) continue
      try {
        const u = new URL(parentUrl)
        u.searchParams.set(confirmedQueryKey, found.dataId)
        // 화면 DOM의 실제 텍스트를 쓴다 — 비전이 한두 글자 잘못 읽었어도(realText가 name과 다를 수 있음)
        // 몰구조분석 결과엔 진짜 카테고리 이름이 남아야 한다.
        matched.push({ name: `${parentName} > ${found.realText}`, href: u.toString() })
      } catch { /* URL 생성 실패 — 이 항목만 버림 */ }
    }
  } else if (unresolvedNames.length) {
    console.log(`[하위카테고리:비전진단:${mallName}] "${parentName}" — ${unresolvedNames.length}개는 href도 못 찾고 id 매핑도 확인 안 돼 버림: ${unresolvedNames.join(', ')}`)
  }
  if (!matched.length) {
    console.log(`[하위카테고리:비전진단:${mallName}] "${parentName}" 화면엔 ${childNames.length}개 보였지만 링크를 하나도 못 찾음`)
    return []
  }
  if (!(await looksLikeRealCategoryBatch(context, matched, platform, productLinkSelector))) {
    console.log(`[하위카테고리:비전진단:${mallName}] "${parentName}" 하위 ${matched.length}개 찾았지만 표본검증 실패`)
    return []
  }
  console.log(`[하위카테고리:비전진단:${mallName}] "${parentName}" 하위 ${matched.length}개 확인(화면 인식): ${matched.slice(0, 10).map(l => l.name.split(' > ').pop()).join(', ')}`)
  return matched.map(l => ({ href: l.href, text: l.name }))
}

async function discoverCategoryMenuByVision(
  context: BrowserContext, page: Page, mallName: string, candidatePages: string[], platform: MallPlatform,
  productLinkSelector?: string | null, signal?: AbortSignal, visionLog?: VisionAttempt[],
): Promise<CategoryMenuDiscovery> {
  const startUrl = page.url()
  const safeCandidates = candidatePages.filter(u => u !== startUrl && !ACCOUNT_UNSAFE_URL_RE.test(u))

  // 한 페이지에서 한 번(attemptNo) 시도 — 실패 이유별로 null(다음 시도로) / 링크(성공)를 돌려준다.
  // attemptNo>1(같은 페이지 재시도)이면 이미 그 URL에 있어도 다시 로드한다 — 안 그러면 스크린샷이
  // 이전과 완전히 똑같아서(회전 배너/팝업 등이 그대로), 비전이 매번 같은(틀린) 좌표를 그대로 반복해
  // 재시도가 아무 효과가 없다(실사용 확인, 2026-09-12 — 투비즈온에서 3번 다 똑같이 (80,300)을 줌).
  async function attemptOnce(url: string, attemptNo: number): Promise<CategoryMenuDiscovery | null> {
    if (page.url() !== url || attemptNo > 1) {
      const moved = await page.goto(url, { waitUntil: 'load', timeout: 20_000 }).then(() => true).catch(() => false)
      if (!moved) return null
    }
    const screenshot = await page.screenshot({ type: 'jpeg', quality: 90 }).catch(() => null)
    if (!screenshot) {
      console.log(`[카테고리탐지:진단:${mallName}] 화면 인식: 스크린샷 실패(${url}, 시도 ${attemptNo})`)
      return null
    }
    const screenshotBase64 = screenshot.toString('base64')
    // 케이스 a: 클릭 없이 이미 화면에 카테고리가 보이는 경우(도매신처럼 항상 펼쳐진 가로 GNB 탭 —
    // 실사용 확인, 2026-09-16) — 아래 트리거 클릭(케이스 b)과 같은 스크린샷 한 장으로 먼저 시도한다.
    // "같은 시각적 레벨에 나란히 보이는 이름들 = 카테고리 후보 그룹"이라는 detectVisibleCategoryHierarchy의
    // 스키마를 그대로 탐지 입력으로 쓴다(지금까지는 화면 대조 표시용으로만 썼다).
    const hierarchy = await detectVisibleCategoryHierarchy(mallName, screenshotBase64, 'image/jpeg', signal, visionLog).catch(() => null)
    let caseAResult: CategoryMenuDiscovery | null = null
    if (!hierarchy?.length) {
      console.log(`[카테고리탐지:진단:${mallName}] 화면 인식(클릭 없이): ${hierarchy === null ? '두 공급자 다 실패' : '그룹 0개'} — 트리거도 같이 확인(${url}, 시도 ${attemptNo})`)
    } else {
      const candidates = flattenVisibleCategoryHierarchy(hierarchy)
      const pageLinks = await collectAllPageLinks(page).catch(() => [])
      const matched = matchVisibleCategoryLinksToHrefs(candidates, pageLinks)
        .filter(l => !isNonCategoryCandidate(l.name, l.href))
      if (!matched.length) {
        console.log(`[카테고리탐지:진단:${mallName}] 화면 인식(클릭 없이): 그룹 ${hierarchy.length}개 읽었지만 DOM에서 href를 못 찾음 — 트리거도 같이 확인(${url}, 시도 ${attemptNo})`)
      } else if (!await looksLikeRealCategoryBatch(context, matched, platform, productLinkSelector)) {
        console.log(`[카테고리탐지:진단:${mallName}] 화면 인식(클릭 없이): ${matched.length}개 찾았지만 표본검증 실패 — 트리거도 같이 확인(${url}, 시도 ${attemptNo})`)
      } else if (hierarchy.length < VISION_CONFIDENT_GROUP_COUNT) {
        console.log(`[카테고리탐지:진단:${mallName}] 화면 인식(클릭 없이): 그룹 ${hierarchy.length}개뿐이라 못 미더움 — 트리거도 같이 확인(${url}, 시도 ${attemptNo})`)
      } else {
        console.log(`[카테고리탐지:진단:${mallName}] 화면 인식(클릭 없이 바로 읽음): "${hierarchy.map(h => h.group).join(', ')}" ${hierarchy.length}개 그룹 → ${matched.length}개 링크(표본검증 통과, 시도 ${attemptNo})`)
        caseAResult = { links: matched, groupCount: hierarchy.length, screenNames: candidates.map(c => c.leafText), screenHierarchy: hierarchy, menuLinks: pageLinks }
      }
    }

    // 케이스 a가 이미 확신에 찬 결과를 찾았어도, 화면에 별도의 "카테고리 전체보기" 트리거가 있으면 그건
    // 무조건 같이 확인한다(사용자 지시, 2026-09-20) — 케이스 a의 확신 기준(그룹 3개 이상 + 실제 상품
    // 목록으로 연결)은 진짜 카테고리 메뉴뿐 아니라 베스트/신상품/MD추천/기획전 같은 퀵메뉴 바에도 똑같이
    // 걸려버린다(도매창고 실사용 확인 — 퀵메뉴 8개가 전부 진짜 상품 목록으로 이어져 표본검증까지 통과해,
    // 바로 옆의 진짜 "Category" 버튼은 시도조차 안 됐다). 트리거를 못 찾으면 케이스 a 결과를 그대로 쓴다.
    const trigger = await detectCategoryMenuTriggerFromScreenshot(mallName, screenshotBase64, 'image/jpeg', signal, visionLog).catch(() => null)
    if (!trigger?.found) {
      if (caseAResult) return caseAResult
      console.log(`[카테고리탐지:진단:${mallName}] 화면 인식: 트리거 못 찾음(${url}, 시도 ${attemptNo})`)
      return null
    }
    const caseBResult = await (async (): Promise<CategoryMenuDiscovery | null> => {
      const viewport = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }))
        .catch(() => page.viewportSize() ?? { width: 1280, height: 800 })
      const x = viewport.width * (trigger.xPercent / 100)
      const y = viewport.height * (trigger.yPercent / 100)
      console.log(`[카테고리탐지:진단:${mallName}] 화면 인식: "${trigger.label || '(아이콘)'}" 발견(${trigger.xPercent}%,${trigger.yPercent}%) → 뷰포트 ${viewport.width}x${viewport.height} 기준 (${x.toFixed(0)},${y.toFixed(0)}) 클릭(시도 ${attemptNo})`)
      await clickNearestClickableAtPoint(page, x, y, mallName)
      await sleep(1_200) // 클릭으로 열리는 메뉴가 AJAX로 채워질 시간(투비즈온 실측 — 1초 안팎이면 충분)
      let { links, groupCount } = await scanCategoryMenuRobust(page).catch(() => ({ links: [] as CategoryMenuLink[], textlessHrefs: [] as string[], groupCount: undefined as number | undefined }))
      if (!links.length) {
        // href/onclick 둘 다 없는 data-속성 전용 메뉴일 수 있다(resolveDataAttributeCategoryLinks 주석
        // 참고, 도매창고 실사용 확인) — 포기하기 전에 실제로 하나 클릭해 이동 패턴을 확인해본다.
        const dataAttrLinks = await resolveDataAttributeCategoryLinks(page, mallName).catch(() => [])
        if (dataAttrLinks.length) {
          links = dataAttrLinks
          groupCount = 1
        } else {
          console.log(`[카테고리탐지:진단:${mallName}] 화면 인식: 클릭 후에도 링크 0개(${url}, 시도 ${attemptNo})`)
          return null
        }
      }
      if (!await looksLikeRealCategoryBatch(context, links, platform, productLinkSelector)) {
        console.log(`[카테고리탐지:진단:${mallName}] 화면 인식: 클릭 후 ${links.length}개 찾았지만 표본검증 실패(${url}, 시도 ${attemptNo}) — ${links.slice(0, 10).map(l => `${l.name}(${l.href})`).join(', ')}`)
        return null
      }
      // "진짜냐"(looksLikeRealCategoryBatch)는 통과해도 "전부냐"는 별개 질문이다(사용자 지시, 2026-09-12 —
      // "사람이 보는 화면을 기준으로 카테고리가 어디까지인지 먼저 확인"). 방금 클릭으로 연 화면을 다시
      // 찍어 비전에게 "대분류 그룹이 몇 개 보이는지" 물어보고, 실제로 스캔한 그룹 수보다 화면에 더 많이
      // 보이면(투비즈온 실사용 확인 — 비슷하게 생긴 "그룹 하나만 여는" 작은 아이콘을 잘못 클릭해도
      // 표본검증은 통과했다) 이 결과를 "일부만 찾음"으로 보고 다음 시도로 넘어간다.
      const completenessScreenshot = await page.screenshot({ type: 'jpeg', quality: 90 }).catch(() => null)
      const visibleGroupCount = completenessScreenshot
        ? await detectVisibleCategoryGroupCount(mallName, completenessScreenshot.toString('base64'), 'image/jpeg', signal).catch(() => null)
        : null
      const scannedGroupCount = groupCount ?? 1
      if (visibleGroupCount != null && visibleGroupCount > 1 && visibleGroupCount > scannedGroupCount) {
        console.log(`[카테고리탐지:진단:${mallName}] 화면 인식: 클릭 후 ${links.length}개 찾았지만(그룹 ${scannedGroupCount}개) 화면엔 대분류 그룹 ${visibleGroupCount}개가 보임 — 일부만 찾은 것으로 보고 폐기(${url}, 시도 ${attemptNo})`)
        return null
      }
      console.log(`[카테고리탐지:진단:${mallName}] 화면 인식으로 "${trigger.label || '(아이콘)'}" 버튼(${url}) 클릭 → ${links.length}개 찾음(그룹 ${scannedGroupCount}개, 화면상 그룹 ${visibleGroupCount ?? '확인불가'}개, 표본검증 통과, 시도 ${attemptNo})`)
      // 이미 찍어둔 같은 화면으로 "사람이 읽는 카테고리 이름"까지 받아둔다(추가 캡처 없음) — 최종 결과를
      // 이 목록과 대조해 누락을 알려주기 위함(categoryScreenCheck, 사용자 지시 2026-09-13).
      const screenNames = completenessScreenshot
        ? await detectVisibleCategoryNames(mallName, completenessScreenshot.toString('base64'), 'image/jpeg', signal).catch(() => null)
        : null
      // 같은 화면으로 "대분류 아래 하위 카테고리가 어떻게 묶이는지" 구조까지 받아둔다(사용자 지시,
      // 2026-09-15 — 화면 대조 카드에 참고용으로만 쓰고, 위 screenNames의 missing/extra 판정은 그대로 둔다).
      const screenHierarchy = completenessScreenshot
        ? await detectVisibleCategoryHierarchy(mallName, completenessScreenshot.toString('base64'), 'image/jpeg', signal, visionLog).catch(() => null)
        : null
      const menuLinks = await collectAllPageLinks(page).catch(() => [])
      return { links, groupCount: scannedGroupCount, screenNames, screenHierarchy, menuLinks }
    })()

    if (!caseBResult) return caseAResult
    if (!caseAResult) return caseBResult
    // 트리거는 화면에 "전체 카테고리 보기" 의도로 명시적으로 존재하는 버튼이다 — 실제로 눌러서 케이스 a
    // (클릭 없이 읽기)보다 링크를 더 많이(또는 같이) 찾았다면, 그룹 수 점수를 따질 것도 없이 그대로
    // 채택한다(도매창고 실사용 확인, 2026-09-20 — data-속성 폴백으로 진짜 카테고리 18개를 찾았는데도,
    // 케이스 a가 우연히 "그룹 8개"(사실은 서로 무관한 퀵메뉴 8개를 각각 그룹 1개씩으로 잘못 센 것)로
    // 나오는 바람에 점수(4×8=32 vs 18×1=18)에서 밀려 틀린 결과가 채택됐다 — "그룹 수"는 케이스 a의
    // 결과가 진짜인지 불확실할 때 쓰는 보정치일 뿐, 트리거를 실제로 눌러 더 많은 링크를 찾았다는 직접
    // 증거보다 우선할 이유가 없다). 트리거 클릭이 더 적게 찾았을 때만(케이스 a가 진짜 더 크거나, 트리거가
    // 엉뚱한 부분 메뉴를 열었을 위험 — 2026-09-12 투비즈온 사고 대응) 기존 점수 비교로 판단한다.
    if (caseBResult.links.length >= caseAResult.links.length) {
      console.log(`[카테고리탐지:진단:${mallName}] 클릭 없이 읽은 결과 ${caseAResult.links.length}개(그룹 ${caseAResult.groupCount}) vs 트리거 클릭 결과 ${caseBResult.links.length}개(그룹 ${caseBResult.groupCount}) — 트리거 클릭이 링크 수도 앞서 채택(${url}, 시도 ${attemptNo})`)
      return caseBResult
    }
    const caseAScore = caseAResult.links.length * Math.max(1, caseAResult.groupCount)
    const caseBScore = caseBResult.links.length * Math.max(1, caseBResult.groupCount)
    const pickB = caseBScore > caseAScore
    console.log(`[카테고리탐지:진단:${mallName}] 클릭 없이 읽은 결과 ${caseAResult.links.length}개(그룹 ${caseAResult.groupCount}) vs 트리거 클릭 결과 ${caseBResult.links.length}개(그룹 ${caseBResult.groupCount}) — ${pickB ? '트리거 클릭' : '클릭 없이 읽은 결과'} 채택(${url}, 시도 ${attemptNo})`)
    return pickB ? caseBResult : caseAResult
  }

  // 시작 페이지(대개 홈 — "전체 카테고리" 트리거가 사는 곳)에서 먼저 여러 번 재시도한다(MAX_START_PAGE_
  // VISION_ATTEMPTS 주석 참고 — 비전 좌표 추정이 같은 화면에서도 호출마다 달라져, 한 번 실패했다고 곧장
  // 다른(대개 무관한) 페이지로 넘어가면 그쪽에서 엉뚱한 부분 결과를 주울 위험만 커진다).
  for (let attempt = 1; attempt <= MAX_START_PAGE_VISION_ATTEMPTS; attempt++) {
    if (signal?.aborted) return { links: [], groupCount: 0, screenNames: null }
    const result = await attemptOnce(startUrl, attempt)
    if (result) return result
  }
  // 시작 페이지에서 끝내 못 찾았을 때만 다른 화면도 마저 시도한다(사용자 지시, 2026-09-12 — "첫화면에서
  // 안나오면 다른 화면에서도 하게 해서").
  for (const url of safeCandidates.slice(0, MAX_CATEGORY_VISION_PAGES - 1)) {
    if (signal?.aborted) break
    const result = await attemptOnce(url, 1)
    if (result) return result
  }
  return { links: [], groupCount: 0, screenNames: null }
}

// discoverCategoryMenuByExhaustiveHeaderClick이 시도해볼 후보 상한 — 조상/자손을 중복으로 걸러내지
// 않으므로(nthHeaderIconCandidate 주석 참고) 아이콘 하나가 <li>+<img> 등 여러 겹으로 두 번 이상
// 잡힐 수 있어, 예전(중복 제거 시절) 상한 15보다 넉넉히 올린다 — 후보마다 새로고침+클릭+스캔이 들어
// (수십 초~1분대) 무한정 늘리지는 않는다.
const MAX_HEADER_ICON_CANDIDATES = 50

// 흔히 쓰이는 "카테고리 식별" 쿼리파라미터 이름들 — 사용자 제안(2026-09-12): "category, cate, ctno 같은
// 걸 찾아서 참고하라". scanCategoryMenu(DOM 구조 기반)가 클릭으로 열린 내용을 못 읽어내도(예: 예상 못한
// 마크업 모양), 그 화면에 이런 파라미터를 쓰는 링크가 여럿 보이면 카테고리일 가능성이 높다는 독립적인
// 신호로 쓴다 — discoverCategoryMenuByExhaustiveHeaderClick의 구조 기반 스캔이 0개일 때만 보조로 시도.
const CATEGORY_URL_PARAM_RE = /[?&](category|cate|cat|ctno|cno|cateno|cate_no|cat_no|catecd|cate_cd|ca_id|gcode|cid)=/i
// 헤더로 볼 상단 영역 높이(px)와, "아이콘/버튼"으로 볼 최대 크기 — 이보다 크면 배너/로고 등 아이콘이
// 아닌 요소로 본다. 실제로 배너(1920×450)와 아이콘을 구분하는 건 크기 상한(HEADER_ICON_MAX_*)만으로도
// 충분하다 — 배너는 세로 450px로 HEADER_ICON_MAX_HEIGHT_PX(80)를 이미 훌쩍 넘으므로, 위치(HEADER_REGION_
// HEIGHT_PX) 쪽은 "화면 전체를 다 훑지 않기 위한" 넉넉한 상한일 뿐이다 — 실사용 확인(2026-09-12,
// 투비즈온): "전체 카테고리" 버튼이 세로 위치 257~281px에 있어, 처음 잡아둔 200px 상한 안에 못 들어가
// 후보에서 통째로 빠졌었다. 너비/높이도 따로 둔다 — 이 버튼 자체가 191×23px(가로로 넓고 얇은 "ALL MENU"
// 류 그래픽)라, 가로/세로를 같은 상한(120px)으로 걸렀을 때도 마찬가지로 빠졌었다.
const HEADER_REGION_HEIGHT_PX = 400
const HEADER_ICON_MAX_WIDTH_PX = 300
const HEADER_ICON_MAX_HEIGHT_PX = 80

/** 헤더 영역 안의 "아이콘처럼 작은" 클릭 가능해 보이는 요소를 전부 모아, i번째 것을 돌려준다 — 순서는
 *  document 순회 순서라 같은 페이지를 다시 불러와도 안정적이다(같은 정적 HTML이므로).
 *  조상/자손을 서로 중복이라고 걸러내지 않는다 — 실제 클릭 핸들러가 어느 쪽에 달려있는지는 몰마다
 *  다르다(실사용 확인, 2026-09-12 — 투비즈온은 같은 페이지 안에서도 ".total-category-btn"은 <img>에,
 *  ".sub-category-btn"은 그 부모 <li>에 각각 바인딩돼 있었다). 조상만 후보로 남기면(예전 방식) 실제
 *  핸들러가 자손에 달린 경우 그 자손은 영영 후보에서 빠져 클릭해도 아무 반응이 없다 — "어느 계층이
 *  맞는지" 미리 판단하지 않고 둘 다 독립적인 후보로 넣어, 실제로 클릭해본 결과(scanCategoryMenuRobust)
 *  로만 판단한다. */
/* 테스트에서 실제 페이지를 띄워 "로그아웃/장바구니가 후보에서 빠지는지"를 직접 확인할 수 있도록
 * export한다 — 이 판정이 조용히 뚫리면 곧바로 로그인 세션이 끊기는 사고로 이어지는데(아래 주석),
 * 화면 밖에서 도는 함수라 회귀를 눈으로 알아채기 어렵다. */
export async function nthHeaderIconCandidate(page: Page, index: number): Promise<ElementHandle | null> {
  const handle = await page.evaluateHandle(({ index, heightLimit, maxWidth, maxHeight, unsafeUrlSrc, logoutTextSrc }) => {
    const unsafeUrlRe = new RegExp(unsafeUrlSrc, 'i')
    const logoutTextRe = new RegExp(logoutTextSrc, 'i')
    const candidates: Element[] = []
    for (const el of Array.from(document.querySelectorAll('img, a, li, button'))) {
      const rect = el.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) continue
      if (rect.top > heightLimit || rect.bottom > heightLimit + 100) continue
      if (rect.width > maxWidth || rect.height > maxHeight) continue
      // 계정/주문 링크(로그아웃·마이페이지·장바구니·주문조회 등)는 후보에서 아예 뺀다 — 몰 헤더 우측
      // 유틸리티 영역이 정확히 이 "작고 위쪽에 있는 요소" 조건에 들어맞아, 위치/크기만으로 후보를
      // 모으면 로그아웃 링크가 반드시 섞여 들어온다(투비즈온 실사용 확인, 2026-09-13 — 후보 39개를
      // 클릭하는 동안 로그인 세션이 끊겨 이후 단계가 전부 로그아웃 상태로 수집됨: 몰구조분석 3회
      // 연속 같은 패턴). 이건 이 몰만의 문제가 아니라, 로그인 상태에서 헤더에 "로그아웃"을 노출하는
      // 국내 몰 전반에 해당한다 — 이 파일의 detectLoggedInSignal이 바로 그 관례를 로그인 판정에
      // 쓰고 있을 정도로 일반적이다. 어차피 "전체 카테고리" 트리거가 계정 링크일 리 없으므로 잃는 것도
      // 없고, 헛클릭이 줄어 전수클릭 자체도 빨라진다.
      // 자기 자신뿐 아니라 위(조상 <a>)와 아래(자식 <a>)도 같이 본다 — 같은 아이콘이 <li>/<a>/<img>로
      // 여러 겹 후보에 들어오는 구조라(nthHeaderIconCandidate 주석), 한 겹만 보면 나머지 겹이 그대로
      // 클릭된다(투비즈온 헤더: `<li><a href="/mall/member/logout.php">로그아웃</a></li>`).
      const ancestorLink = el.closest('a, button')
      const descendantLink = el.querySelector('a[href], button')
      const urls: string[] = []
      const labels: string[] = []
      for (const node of [el, ancestorLink, descendantLink]) {
        if (!node) continue
        urls.push(node.getAttribute('href') || '', node.getAttribute('onclick') || '')
        labels.push(node.textContent || '', node.getAttribute('alt') || '', node.getAttribute('title') || '')
      }
      if (unsafeUrlRe.test(urls.join(' ')) || logoutTextRe.test(labels.join(' '))) continue
      candidates.push(el)
    }
    return candidates[index] ?? null
  }, {
    index, heightLimit: HEADER_REGION_HEIGHT_PX, maxWidth: HEADER_ICON_MAX_WIDTH_PX, maxHeight: HEADER_ICON_MAX_HEIGHT_PX,
    unsafeUrlSrc: ACCOUNT_UNSAFE_URL_RE.source, logoutTextSrc: LOGOUT_TEXT_RE.source,
  }).catch(() => null)
  const element = handle?.asElement() ?? null
  if (!element) await handle?.dispose().catch(() => {})
  return element
}

/**
 * 비전이 "이 중 어느 아이콘이 정답이냐"를 스스로 맞히지 못하는 몰을 위한 마지막 수단(사용자 지시,
 * 2026-09-12 — "다른 방법으로 해") — 비전에게 좌표를 하나 콕 집어 맞혀보라고 하는 대신, 헤더 영역의
 * 아이콘처럼 생긴 요소를 전부 찾아 하나씩 실제로 클릭해보고, 그 결과(scanCategoryMenuRobust로 실제
 * 찾아지는 카테고리 수)가 가장 큰 것을 채택한다 — "어느 게 맞는지 미리 판단"하는 대신 "다 해보고 제일
 * 잘 되는 걸 확인 후 고른다"는 방식이라 비전의 판단력에 기대지 않는다(투비즈온 실사용 확인: 비슷하게
 * 생긴 아이콘이 여러 개라 비전이 프롬프트를 세 번 다르게 바꿔도 계속 같은 오답을 골랐다). 후보마다 새로
 * 페이지를 불러와 초기화한 뒤 시도해, 이전 클릭이 열어둔 메뉴 상태가 다음 시도를 오염시키지 않는다.
 */
async function discoverCategoryMenuByExhaustiveHeaderClick(
  context: BrowserContext, page: Page, mallName: string, startUrl: string, platform: MallPlatform,
  productLinkSelector?: string | null, signal?: AbortSignal,
): Promise<CategoryMenuDiscovery> {
  let best: { links: CategoryMenuLink[]; score: number; groupCount: number; shot: Buffer | null; menuLinks: { text: string; href: string }[] } | null = null
  // 클릭 "전" 로그인 상태를 기억해두고, 후보를 하나 클릭할 때마다 시작 페이지에서 다시 확인한다 —
  // URL/텍스트 패턴(ACCOUNT_UNSAFE_URL_RE, LOGOUT_TEXT_RE)으로 거르는 앞의 두 방어는 "우리가 아는
  // 모양의 로그아웃"만 막는다. 몰이 form 제출이나 전혀 다른 URL로 로그아웃을 구현했으면 그 둘 다
  // 통과하므로, 마지막엔 "패턴이 아니라 실제 결과"로 판정한다 — 어떤 몰이든, 어떤 방식이든 세션이
  // 끊기면 여기서 걸린다. 기준값도 비교값도 **매번 같은 시작 페이지에서** 읽는다 — 이 함수가 불릴 때
  // page가 어디에 있는지는 호출부마다 다르고, 클릭으로 열린 페이지는 헤더가 없을 수 있어 "로그아웃
  // 링크 없음"이 그대로 오탐이 된다(detectLoggedInSignal 주석 참고). 그래서 첫 후보를 클릭하기 직전
  // (i===0, goto 직후)의 값을 기준으로 삼는다.
  let loggedInBefore: boolean | null = null
  for (let i = 0; i < MAX_HEADER_ICON_CANDIDATES; i++) {
    if (signal?.aborted) break
    const moved = await page.goto(startUrl, { waitUntil: 'load', timeout: 20_000 }).then(() => true).catch(() => false)
    if (!moved) {
      console.log(`[카테고리탐지:진단:${mallName}] 헤더 아이콘 전수클릭: 페이지 이동 실패(${startUrl}) — 중단`)
      break
    }
    const loggedInNow = await detectLoggedInSignal(page)
    if (i === 0) {
      loggedInBefore = loggedInNow
    } else if (loggedInBefore === true && loggedInNow === false) {
      console.log(`[카테고리탐지:진단:${mallName}] 헤더 아이콘 전수클릭: 후보 ${i}를 클릭한 뒤 로그인 세션이 끊긴 것으로 보임 — 남은 후보를 클릭하지 않고 중단(지금까지 찾은 결과만 사용). 이 몰의 로그아웃 링크가 기존 패턴에 안 걸리는 형태일 수 있으니 LOGOUT_URL_RE/LOGOUT_TEXT_RE 보완이 필요한지 확인할 것`)
      break
    }
    const element = await nthHeaderIconCandidate(page, i)
    if (!element) {
      console.log(`[카테고리탐지:진단:${mallName}] 헤더 아이콘 전수클릭: 후보 ${i + 1}번째 없음(총 ${i}개 시도함) — 종료`)
      break
    }
    const clicked = await element.click({ timeout: 3_000 }).then(() => true).catch(() => false)
    await element.dispose().catch(() => {})
    if (!clicked) {
      console.log(`[카테고리탐지:진단:${mallName}] 헤더 아이콘 전수클릭: 후보 ${i + 1} 클릭 실패`)
      continue
    }
    await sleep(1_200)
    let { links, groupCount } = await scanCategoryMenuRobust(page).catch(() => ({ links: [] as CategoryMenuLink[], textlessHrefs: [] as string[], groupCount: undefined as number | undefined }))
    if (!links.length) {
      // 구조 기반 스캔이 못 읽어도, 이 클릭으로 열린 화면에 카테고리 파라미터 패턴(CATEGORY_URL_PARAM_RE)
      // 의 링크가 여럿 보이면 그걸로 대신한다(사용자 제안, 2026-09-12).
      const patternLinks = await collectAllPageLinks(page)
        .then(all => all.filter(l => CATEGORY_URL_PARAM_RE.test(l.href)).map(l => ({ name: l.text, href: l.href })))
        .catch(() => [])
      if (patternLinks.length < 2) {
        console.log(`[카테고리탐지:진단:${mallName}] 헤더 아이콘 전수클릭: 후보 ${i + 1} 클릭 후 링크 0개(파라미터 패턴도 없음)`)
        continue
      }
      console.log(`[카테고리탐지:진단:${mallName}] 헤더 아이콘 전수클릭: 후보 ${i + 1} 클릭 후 구조 스캔은 0개지만 카테고리 파라미터 패턴으로 ${patternLinks.length}개 찾음`)
      links = patternLinks
      groupCount = undefined
    }
    if (!await looksLikeRealCategoryBatch(context, links, platform, productLinkSelector)) {
      console.log(`[카테고리탐지:진단:${mallName}] 헤더 아이콘 전수클릭: 후보 ${i + 1} → ${links.length}개 찾았지만 표본검증 실패`)
      continue
    }
    const score = links.length * (groupCount ?? 1)
    console.log(`[카테고리탐지:진단:${mallName}] 헤더 아이콘 전수클릭: 후보 ${i + 1} → ${links.length}개(그룹 ${groupCount ?? '?'})`)
    if (!best || score > best.score) {
      // 메뉴가 열려 있는 "바로 지금"의 화면을 남겨둔다 — 최종 결과를 이 화면과 대조해 사용자에게
      // "화면엔 보이는데 결과엔 없는 카테고리"를 알려주기 위함(categoryScreenCheck). 루프가 끝난 뒤엔
      // 페이지를 다시 불러온 상태라 이 화면을 다시 만들 수 없어, 채택 시점에 찍어둬야 한다.
      const shot = await page.screenshot({ type: 'jpeg', quality: 90 }).catch(() => null)
      const menuLinks = await collectAllPageLinks(page).catch(() => [])
      best = { links, score, groupCount: groupCount ?? 1, shot, menuLinks }
    }
  }
  if (best) {
    console.log(`[카테고리탐지:진단:${mallName}] 헤더 아이콘 전수클릭 최종 채택: ${best.links.length}개(그룹 ${best.groupCount})`)
  }
  const screenNames = best?.shot
    ? await detectVisibleCategoryNames(mallName, best.shot.toString('base64'), 'image/jpeg', signal).catch(() => null)
    : null
  const screenHierarchy = best?.shot
    ? await detectVisibleCategoryHierarchy(mallName, best.shot.toString('base64'), 'image/jpeg', signal).catch(() => null)
    : null
  return { links: best?.links ?? [], groupCount: best?.groupCount ?? 0, screenNames, screenHierarchy, menuLinks: best?.menuLinks ?? [] }
}

async function discoverTopLevelCategoryLinks(
  context: BrowserContext, page: Page, mallName: string, visitTextlessFallback: boolean, signal?: AbortSignal, useAi = true,
  categoryUrlPattern?: string | null, knownCategoryExamples?: string[], baseUrl?: string,
  platform: MallPlatform = 'unknown', productLinkSelector?: string | null, visionLog?: VisionAttempt[],
): Promise<{ links: CategoryMenuLink[]; textlessHrefs: string[]; aiUsed: boolean; screenNames?: string[] | null; screenHierarchy?: { group: string; items: string[] }[] | null; menuLinks?: { text: string; href: string }[] }> {
  // 사람이 화면을 보듯이 스크린샷을 먼저 분석해 카테고리를 찾는다(사용자 지시, 2026-09-16 — "화면
  // 캡처한 것을 분석하고... 같은 레벨에 여럿이 나타나 있으면 카테고리로 보면 될 것... 무조건 이 방법을
  // 우선 순위로"). **기억해둔 categoryUrlPattern이 있어도 건너뛰지 않는다**(사용자 지시, 2026-09-17 —
  // "이런 경우에도 무조건 사람이 보는 것처럼 화면 캡처를 통해 몰구조분석을 무조건 하게 강제하게 해").
  // 원래는 categoryUrlPattern을 "예전에 비전으로 확정된 결과의 캐시"로 보고 비전보다도 앞에 뒀는데,
  // 이게 바로 화면과 결과가 갈리는 사고를 냈다(도매신 실사용 확인, 2026-09-17) — 패턴 기억으로 즉시
  // 스캔해버리면 화면 인식 자체가 아예 안 돌아 screenNames/screenHierarchy가 안 채워지고,
  // screenCheckAndRecover는 "화면 대조" 없이 "직전 결과 대조"(previousLinks)만으로 되살리기를 하는데,
  // 이 경로는 href가 상품을 보여주기만 하면 이름이 깨졌어도(빈 배너 위젯의 미렌더링 템플릿 토큰) 그대로
  // 되살려버려 "WOMEN SHOES > 링크 > 링크"/"WOMEN SHOES > {$js-banner}" 같은, 화면엔 전혀 안 보이는
  // 가짜 항목이 몰구조분석을 다시 돌릴 때마다 계속 되살아났다. DOM 텍스트/클래스 추측(아래
  // findCategoryOverviewLink 이하)은 비전이 실패했을 때만 쓰는 최후 수단으로 강등한다 — 새로 등록되는,
  // 아직 본 적 없는 몰의 마크업에도 일반화되는 쪽은 클래스명 짐작이 아니라 실제 화면을 읽는 쪽이기
  // 때문(도매신 실사용 확인, 2026-09-16 — "제목+목록" 추측이 무관한 "나의 쇼핑" 위젯을 카테고리로
  // 오인해, 실제 GNB를 찾았을 아래 class 기반 스캔은 실행도 안 됐다).
  const startUrlBeforeVision = page.url()
  const aiCandidates = await collectAllPageLinks(page, baseUrl ? new URL(baseUrl).origin : undefined)
  const visionResult = await discoverCategoryMenuByVision(
    context, page, mallName, aiCandidates.map(c => c.href), platform, productLinkSelector, signal, visionLog,
  ).catch(() => ({ links: [] as CategoryMenuLink[], groupCount: 0, screenNames: null, screenHierarchy: null, menuLinks: [] as { text: string; href: string }[] }))

  // 비전이 "그럴듯하지만 일부만" 찾은 경우(표본검증은 통과하지만 실제로는 비슷하게 생긴 다른 아이콘을
  // 잘못 클릭한 것) 그 결과를 곧바로 받아들이지 않는다(사용자 지시, 2026-09-12 — "다른 방법으로 해") —
  // 비전 결과가 이미 충분히 커 보이면(그룹 3개 이상, 여러 대분류를 실제로 찾은 것으로 볼 만한 근거) 그대로
  // 받아들이고, 그렇지 않으면(그룹 1~2개 — 부분 결과일 위험이 큼) 헤더 아이콘을 전부 실제로 클릭해보는
  // 더 느리지만 확실한 방법도 마저 시도해 더 나은 쪽(찾은 개수×그룹 수가 더 큰 쪽)을 채택한다.
  const visionScore = visionResult.links.length * Math.max(1, visionResult.groupCount)
  if (visionResult.links.length && visionResult.groupCount >= VISION_CONFIDENT_GROUP_COUNT) {
    return { links: visionResult.links, textlessHrefs: [], aiUsed: false, screenNames: visionResult.screenNames, screenHierarchy: visionResult.screenHierarchy, menuLinks: visionResult.menuLinks }
  }

  // 화면 인식이 실패했거나 그룹 수가 적어 못 미더울 때 — 비슷하게 생긴 아이콘이 여러 개라 비전이 계속
  // 헷갈리는 몰(투비즈온 실사용 확인: 프롬프트를 세 번 바꿔도 매번 같은 오답)을 위해, 헤더의 아이콘
  // 후보를 전부 실제로 클릭해보고 결과가 제일 좋은 것을 채택한다(discoverCategoryMenuByExhaustiveHeaderClick 참고).
  // 이것도 "화면에서 실제로 클릭해보고 확인"이라는 점에서 비전과 같은 계열이라 DOM 추측보다 앞에 둔다.
  const exhaustiveResult = await discoverCategoryMenuByExhaustiveHeaderClick(
    context, page, mallName, startUrlBeforeVision, platform, productLinkSelector, signal,
  ).catch(() => ({ links: [] as CategoryMenuLink[], groupCount: 0, screenNames: null, screenHierarchy: null, menuLinks: [] as { text: string; href: string }[] }))
  const exhaustiveScore = exhaustiveResult.links.length * Math.max(1, exhaustiveResult.groupCount)

  if (exhaustiveScore > 0 || visionScore > 0) {
    const winner = exhaustiveScore >= visionScore ? exhaustiveResult : visionResult
    console.log(`[카테고리탐지:진단:${mallName}] 화면 인식 ${visionResult.links.length}개(그룹 ${visionResult.groupCount}) vs 헤더 전수클릭 ${exhaustiveResult.links.length}개(그룹 ${exhaustiveResult.groupCount}) — ${exhaustiveScore >= visionScore ? '전수클릭' : '화면 인식'} 채택`)
    return { links: winner.links, textlessHrefs: [], aiUsed: false, screenNames: winner.screenNames, screenHierarchy: winner.screenHierarchy, menuLinks: winner.menuLinks }
  }

  // 비전(화면 인식)과 전수클릭이 둘 다 실패했을 때만 예전에 확인해둔 URL 패턴으로 폴백한다 — DOM 클래스
  // 짐작보다는 신뢰도가 높으니(과거 비전/검증을 거쳐 확정된 값) 그 앞에 두지만, 화면 인식이 멀쩡히 되는
  // 한(Groq/Ollama 둘 다 죽지 않는 한) 여기까지 내려올 일이 없다.
  if (categoryUrlPattern) {
    const patternLinks = await scanByKnownUrlPattern(page, categoryUrlPattern, PLATFORM_PROFILES[platform].detailUrlPattern?.source)
    if (patternLinks.length >= 2 && await looksLikeRealCategoryBatch(context, patternLinks, platform, productLinkSelector)) {
      console.log(`[카테고리탐지:진단:${mallName}] 화면 인식·전수클릭 다 실패 → 기억해둔 URL 패턴(${categoryUrlPattern})으로 ${patternLinks.length}개 찾음(표본검증 통과)`)
      return { links: patternLinks, textlessHrefs: [], aiUsed: false }
    }
    if (patternLinks.length >= 2) {
      console.log(`[카테고리탐지:진단:${mallName}] 기억해둔 URL 패턴(${categoryUrlPattern})으로 ${patternLinks.length}개 찾았지만 표본검증 실패 — 다음 단계로`)
    }
  }

  // 비전(화면 인식)이 전부 실패했을 때만 DOM 텍스트/클래스 추측으로 넘어간다 — 최후 수단.
  console.log(`[카테고리탐지:진단:${mallName}] 화면 인식 실패 → DOM 추측으로 넘어감`)
  const overviewUrl = await findCategoryOverviewLink(page)
  if (overviewUrl && overviewUrl.replace(/\/+$/, '') !== page.url().replace(/\/+$/, '')) {
    const moved = await page.goto(overviewUrl, { waitUntil: 'load', timeout: 15_000 }).then(() => true).catch(() => false)
    console.log(`[카테고리탐지:진단:${mallName}] "전체카테고리"류 링크 발견 → ${overviewUrl} (이동 ${moved ? '성공' : '실패'})`)
  } else {
    console.log(`[카테고리탐지:진단:${mallName}] "카테고리" 단어가 든 링크를 못 찾음 — 지금 페이지(${page.url()}) 그대로 스캔`)
  }

  // "카테고리 전체보기"류 페이지(제목+목록 반복 구조) — findCategoryOverviewLink가 방금 이런 페이지로
  // 이동시켰을 가능성이 높고, scanCategoryMenuRobust(클래스명 기반)가 못 찾는 마크업(신우처럼
  // cat/lnb/gnb류 클래스가 아예 없는 몰)에서도 통한다.
  const overviewLinks = await scanCategoryOverviewPage(page)
  if (overviewLinks.length && await looksLikeRealCategoryBatch(context, overviewLinks, platform, productLinkSelector)) {
    console.log(`[카테고리탐지:진단:${mallName}] "제목+목록" 구조로 ${overviewLinks.length}개 찾음(표본검증 통과)`)
    return { links: overviewLinks, textlessHrefs: [], aiUsed: false }
  }

  const scanned = await scanCategoryMenuRobust(page)
  let links = scanned.links
  const { textlessHrefs } = scanned
  if (visitTextlessFallback) {
    if (!links.length) {
      const candidates = textlessHrefs.length ? textlessHrefs : await findCategoryLinkCandidates(page)
      if (candidates.length) links = await discoverCategoriesByVisitingLinks(context, page, candidates)
    } else if (textlessHrefs.length) {
      const extra = await discoverCategoriesByVisitingLinks(context, page, textlessHrefs)
      links = [...links, ...extra]
    }
  }
  if (links.length && await looksLikeRealCategoryBatch(context, links, platform, productLinkSelector)) {
    return { links, textlessHrefs, aiUsed: false }
  }

  // 규칙 기반(화면 인식 포함)이 전부 실패했을 때만 AI 텍스트로 넘어간다 — 마지막 수단이라 시간을 넉넉히 준다.
  if (useAi) {
    console.log(`[카테고리탐지:진단:${mallName}] 규칙 기반 실패 → AI 시도(후보 ${aiCandidates.length}개)`)
    // 규칙 기반 스캔(scanCategoryMenu 등)은 NON_CATEGORY_TEXT_RE/NON_CATEGORY_PATH_RE로 공지/문의 게시판을
    // 걸러내지만, AI 결과에는 그 필터가 전혀 안 걸려 있었다 — 실사용 확인(2026-08-30, 소꿉노리):
    // 구조 스캔이 이 몰의 진짜 카테고리 메뉴를 못 찾아 AI로 넘어갔는데, AI가 홈페이지 푸터의 "NOTICE"
    // 공지 위젯(href가 board/list.php)을 카테고리로 잘못 골라, 그 뒤 expandCategoryHubs가 그 "카테고리"를
    // 펼치며 진짜 상품 카테고리들까지 전부 "NOTICE > ..." 접두어로 오염시켰다. AI 결과에도 규칙 기반과
    // 같은 필터를 반드시 거치게 한다.
    const aiLinks = (await detectCategoryLinksWithAI(mallName, aiCandidates, undefined, signal, knownCategoryExamples, undefined, visionLog).catch(() => []))
      .filter(l => !isNonCategoryCandidate(l.name, l.href))
    console.log(`[카테고리탐지:진단:${mallName}] AI 결과 ${aiLinks.length}개`)
    if (aiLinks.length && await looksLikeRealCategoryBatch(context, aiLinks, platform, productLinkSelector)) {
      return { links: aiLinks, textlessHrefs, aiUsed: true }
    }
    if (aiLinks.length) {
      console.log(`[카테고리탐지:진단:${mallName}] AI 결과 ${aiLinks.length}개 찾았지만 표본검증 실패`)
    }
  }

  // 모든 단계가 후보를 못 찾았거나 표본검증을 통과 못 했다 — 검증 안 된 결과(도매토피아의 "판촉물인쇄"류)를
  // 자신 있게 돌려주는 것보다, 못 찾았다고 정직하게 빈 목록을 반환하는 편이 낫다. links가 남아있어도
  // (규칙 기반 결과가 검증에 실패한 경우) 여기까지 왔다는 건 이미 못 미더운 상태라는 뜻이라 비운다.
  return { links: [], textlessHrefs, aiUsed: false }
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
    // 일부 몰은 공지사항/구매후기 같은 위젯에 브레드크럼과 같은 제네릭 클래스명(.path/.location/
    // .breadcrumb/.location_wrap)을 재사용한다(실사용 확인, 2026-08-30, 소구프놀리 — "일부제품 가격
    // 인상안내", "·좋습니다.", "NOTICE" 같은 공지/후기 문구가 그대로 "카테고리"로 들어감). 진짜 카테고리
    // 경로는 짧고 문장이 아니므로, 후기 목록 특유의 불릿(·)/문장 종결 어미 반복/게시판 특유 키워드/날짜
    // 표기가 있거나 전체 길이가 비정상적으로 길면 이 후보를 신뢰하지 않고 다음 셀렉터로 넘어간다 — 잘못된
    // 값을 자신 있게 보여주는 것보다 "확인 안됨"으로 남기는 게 낫다. "이벤트"는 실제 카테고리명으로도
    // 흔히 쓰여 블록리스트에서 뺐다 — 이 필터가 모든 공지 제목을 잡아내진 못한다(예: "~이미지 수정"류는
    // 키워드/길이만으로 구분 불가) — 완벽한 필터가 아니라 확실한 신호만 걸러내는 안전망이다. 아래 모든
    // 후보 분기(브랜드 분기 포함)가 반드시 이 필터를 거치게 한다 — 처음엔 .location_wrap 분기(바로 아래)를
    // 빠뜨려서 그 분기가 이 필터 없이 그대로 통과시켰다(2026-08-30 재발 확인, 소꿉노리 — 이 분기가
    // 공지/문의 게시판의 "현재 위치" 표시를 그대로 읽어옴).
    const looksLikeNoise = (text: string) =>
      text.length > 60
      || /·/.test(text)
      || (text.match(/(습니다|해요|세요|어요)[.!]?/g) || []).length >= 2
      || /(공지|안내|이벤트\s|할인판매|상품문의|NOTICE)/i.test(text)
      || /\d+\s*월\s*\d+\s*일/.test(text)

    // 고도몰의 또 다른 스킨(가방쟁이, 실제 페이지로 확인)은 브레드크럼 각 단계를 .location_select로 감싸,
    // 그 안에 "현재 선택된 이름"(.location_tit)과 그 옆 다른 카테고리로 바로 갈 수 있는 숨겨진 <ul> 드롭다운을
    // 같이 둔다. 아래 범용 로직처럼 <li>를 그대로 다 훑으면 그 드롭다운 대안 목록까지 섞여 카테고리가
    // 완전히 틀어지므로, 이 구조는 .location_tit만 콕 집어 먼저 처리한다.
    const locationTits = Array.from(document.querySelectorAll('.location_wrap .location_select > .location_tit'))
      .map(el => (el.textContent || '').trim()).filter(Boolean)
    if (locationTits.length) {
      const joined = locationTits.join(' > ')
      if (!looksLikeNoise(joined)) return { category: joined, brand: '' }
    }

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
          if (text && !looksLikeNoise(text)) return { category: text, brand: '' }
          continue
        }
        const joined = items.join(' > ')
        if (looksLikeNoise(joined)) continue
        const brandIdx = items.findIndex(t => t === '브랜드')
        if (brandIdx !== -1 && brandIdx + 1 < items.length) {
          return { category: items.slice(0, brandIdx).join(' > '), brand: items[brandIdx + 1] }
        }
        return { category: joined, brand: '' }
      }
    }
    return { category: '', brand: '' }
  })
}

interface CollectedLinks {
  urls: string[]
  platform: MallPlatform
  /** AJAX(클릭) 방식 정렬을 이 수집에서 실제로 적용했는지 — 지금까지는 클릭 성공 여부를 아무 데도
   *  남기지 않아 "미리보기가 정렬 기준대로 나온 게 맞나"를 사용자도 로그로도 확인할 수 없었다
   *  (사용자 지적, 2026-09-13). 요청한 정렬이 없으면 undefined. */
  sortClick?: { clickText: string; applied: boolean }
  /** 각 상품 URL이 발견된 목록 페이지의 카테고리 경로(및 "브랜드" 카테고리 노드 아래서 뽑은 브랜드명) */
  categoryByUrl: Map<string, CategoryLabel>
  /** 목록 페이지에서 바로 얻을 수 있는 상품명/썸네일 (실제 상품 페이지를 열지 않아 빠른 미리보기용) */
  linkInfo: Map<string, { name: string; thumbnail: string }>
  /** 목록 페이지 자체가 로그인 세션 끊김으로 보임(로그인폼이 계속 보임) — true면 이 결과 자체가
   *  비로그인 상태로 얻어졌을 수 있다는 뜻 */
  needsLogin: boolean
  /** "중지"가 눌려 상품 URL을 다 모으지 못한 채 중간에 멈췄다는 뜻 — 카테고리가 페이지 수십~수백
   *  개짜리면 이 수집 단계만도 오래 걸릴 수 있는데, 예전엔 이 단계에 isStopRequested 체크가 전혀
   *  없어서 "중지"를 눌러도 상품 하나도 못 긁고도 이 수집이 끝날 때까지 그대로 계속 돌았다
   *  (2026-08-11 실사용 확인·수정). */
  stopped: boolean
  /** 실제로 방문한 목록 페이지 URL 목록(resetToFirstPage로 정규화된 값 — perCategoryUrls의 키와 동일) —
   *  "카테고리별 중복 개수 확인"이 이 순서 그대로 어느 카테고리가 어떤 상품을 처음 발견했는지 계산한다. */
  listingUrls: string[]
  /** 카테고리(목록 URL)별로 그 카테고리에서 발견한 상품 URL 전체 — productUrlSet과 달리 카테고리 간
   *  중복을 지우지 않고 그대로 남겨, 나중에(countCategoryOverlap) 어느 카테고리가 다른 카테고리와 얼마나
   *  겹치는지 계산할 수 있게 한다. */
  perCategoryUrls: Map<string, Set<string>>
}

// 사용자가 최대 페이지 수를 지정하지 않으면 "다음 페이지" 링크가 더 이상 없을 때까지 끝까지 따라간다 —
// 카테고리가 몇 페이지인지 미리 알 수 없는 게 보통이라 매번 페이지 수를 추측해 입력하게 하지 않는다.
// 이 숫자는 페이지네이션이 무한 루프에 빠지는 몰을 대비한 안전장치용 상한일 뿐, 정상적인 몰은 다음
// 페이지 링크가 사라지는 순간(아래 반복문의 break) 그보다 훨씬 먼저 끝난다.
// 이 상한은 previewCatalog의 개수 집계뿐 아니라 실제 스크랩(collectProductUrls의 기본 maxPages)에도
// 그대로 쓰인다 — 예전엔 50(2,400개)으로 낮게 잡았는데, 걸스굽 "SOLD OUT"처럼 정말로 이보다 큰
// 카테고리가 있으면 미리보기가 "2,400개 이상"으로 부정확하게 표시될 뿐 아니라, 실제 스크랩도 50페이지에서
// 조용히 멈춰 그 뒤 상품을 전부 놓치는 훨씬 심각한 문제였다(사용자 지적, 2026-08-17: "정확히 전체
// 수량이 되어야만 한다"). paginationActuallyWorks()가 이미 페이지 번호가 안 통하는 몰을 먼저 걸러내므로
// (2페이지가 1페이지와 같으면 이 상한까지 갈 필요 없이 훨씬 앞에서 멈춤), 정상적으로 페이지네이션되는
// 대형 카테고리를 놓치지 않도록 넉넉히 올린다.
// (2026-09-13~09-17 변경 이력) 한때는 여기에 "미리보기 전용 페이지 예산"(PREVIEW_PAGE_BUDGET=5)이 따로
// 있어, "스크랩 미리보기"의 카테고리별 개수는 그 예산까지만 세고 "N개 이상"으로 정직하게 끊은 뒤, 정확한
// 값이 필요하면 "정확한 총 개수 확인" 버튼을 따로 누르게 했다(빠른 감을 우선한 트레이드오프, 2026-09-13
// 지시). 그런데 이 트레이드오프 자체가 "미리보기 때 카테고리 개수가 N개 이상으로만 나온다"는 정확히 그
// 불편을 낳았고, 사용자가 다시 "정확한 개수를 확인해서 보여주라고. N개 이상 이렇게 하지 말라고"로 뒤집었다
// (2026-09-17) — 그래서 PREVIEW_PAGE_BUDGET을 없애고 미리보기도 이 AUTO_PAGINATION_CAP까지 그대로
// 끝까지 순회한다(카테고리가 몇 개든 이 상한을 실제로 넘는 경우는 드물어 대부분 "정확한 개수"가 그대로
// 나온다 — "이상" 표시는 실제 스크랩 자체도 못 넘는 극단적으로 큰 카테고리에서만 남는다). 카테고리가
// 많은 몰은 미리보기가 그만큼 오래 걸릴 수 있다는 게 이 되돌림의 대가다.
const AUTO_PAGINATION_CAP = 1000

// findRealLastPage(지수+이분 탐색)의 절대 상한 — 위 AUTO_PAGINATION_CAP에 맞춰 함께 늘어난다. 예전엔
// "?page=N"이 실제로는 아무 효과가 없는 몰(펫투비 등, 실사용 확인·2026-08-11 — 매 요청마다 내용이 조금씩
// 달라져 지수 탐색이 "새 페이지"로 계속 오판)에서 상한을 거의 다 쓸 때까지 안 멈춰 사고로 이어진 적이
// 있었지만, 그 뒤 paginationActuallyWorks()가 이런 몰을 탐색 시작 전에 먼저 걸러내는 안전장치로 추가돼
// 이 상한 자체를 낮게 유지해야 할 이유가 줄었다 — 지수+이분 탐색은 O(log n)이라 상한을 올려도(4,000)
// 정상 카테고리 확인 속도에는 사실상 영향이 없다.
const MAX_PAGE_SEARCH_BOUND = AUTO_PAGINATION_CAP * 4

/**
 * 카테고리 URL을 그 카테고리의 중간 페이지(예: "...?cate_no=67&page=5")로 입력해도, 페이지네이션은
 * 항상 1페이지부터 끝까지 훑어야 그 페이지 이전에 있던 상품들을 놓치지 않는다 — "다음 페이지" 링크를
 * 따라가는 방식만으로는 중간 페이지에서 시작하면 그 이전 페이지들을 영영 못 본다.
 */
export function resetToFirstPage(url: string): string {
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
/** 목록 URL에 페이지 번호를 반영한다 — 쿼리(`?page=N`)가 기본이지만, **해시에 페이지 상태를 담는 몰**도
 *  있다(투비즈온 실사용 확인, 2026-09-13: 목록이 AJAX로 그려지고 페이지 이동은 `#page=2&category=007`
 *  해시로 이뤄진다 — `?page=2`를 붙여도 1페이지 그대로라 "2페이지가 1페이지와 같다 → 더 없다"로 판정,
 *  모든 카테고리 개수가 1페이지 분량인 24로 고정됐다). 해시에 page=N이 이미 있으면 그쪽을 바꾼다.
 *  실측으로 확인: 같은 URL에 `#page=1`과 `#page=2`를 주면 실제로 다른 상품 묶음이 나온다. */
function withPageParam(url: string, pageNum: number): string {
  try {
    const u = new URL(url)
    if (/(^|[&#])page=\d+/i.test(u.hash)) {
      u.hash = u.hash.replace(/(^|[&#])page=\d+/i, `$1page=${pageNum}`)
      return u.toString()
    }
    u.searchParams.set('page', String(pageNum))
    return u.toString()
  } catch { return url }
}

// diffQueryParams 전용 — 카테고리를 가리키는 쿼리파라미터 키. pathname이 같아도(카페24 product/list.html은
// 모든 카테고리가 같은 경로를 씀) 이 키만 다르면 "정렬이 다른 같은 목록"이 아니라 "완전히 다른 카테고리"다.
// 모자사러 실사용 확인(2026-09-04) — 메뉴의 "신상품"(카테고리) 링크가 href만 보면 cate_no=51로 base와
// 다르고, SORT_KEYWORD_PATTERN이 "신상"을 정렬 키워드로도 인식해(신상품순 등과 구분 안 됨) 카테고리 이동
// 링크가 정렬 옵션 {cate_no:'51'}로 잘못 저장됐다 — 이 "정렬"을 실제 스크랩에 적용하면 정렬은커녕 엉뚱한
// 카테고리로 튕겨나간다. pathname 검사만으론 못 걸러 여기서 키 자체를 제외한다.
const CATEGORY_ID_QUERY_KEYS = new Set(['cate_no', 'category', 'cate', 'cno', 'ca_id', 'catid', 'cateid'])

// diffQueryParams 전용 — 몰에 따라 "어느 화면(목록/상세/검색 등)을 보여줄지" 자체를 쿼리파라미터 값으로
// 넘기는 라우팅 방식이 있다(도매의신 실사용 확인, 2026-09-18 — "?p=best_list.html"(베스트 목록)과
// "?p=search4_itemdetail.html&q=..."(상품 상세)가 같은 pathname(/shop.html)을 쓰고 파라미터만 다르다).
// CATEGORY_ID_QUERY_KEYS와 같은 이유로 이런 값도 "정렬"이 아니라 "완전히 다른 화면"이다 — 다만 이건 키
// 이름이 몰마다 달라(여기선 "p") 이름으로는 못 거른다. 대신 값 자체가 "파일명처럼 생겼으면"(.html/.php 등
// 확장자로 끝남) 정렬값(asc/price_low/newest 등)일 리 없는 페이지 식별자로 보고 제외한다 — 실사용에서
// 홈의 "인기상품" 위젯 속 상품 링크(인기1TV100197 등)가 상세페이지로 이동했을 뿐인데 이 파라미터 차이만
// 보고 정렬 옵션 10개로 잘못 저장된 사고를 이렇게 막는다.
const PAGE_TEMPLATE_VALUE_RE = /\.(html?|php|aspx?|jsp)$/i

/** "카테고리별 정렬기준 설정" 기능용 — 같은 목록 페이지의 기본 URL과 정렬 링크 URL을 비교해, 정렬 링크
 *  쪽에서 달라졌거나 새로 생긴 쿼리파라미터만 뽑아낸다(예: 기본 `?code=0049` vs 정렬 `?sort=newly&code=0049`
 *  → `{sort: 'newly'}`). origin+pathname이 다르면(AI가 무관한 링크를 잘못 골랐을 가능성) null — 카테고리
 *  이동 링크 등을 정렬 옵션으로 오인해 저장하는 걸 막는다. 차이가 없으면(자기 자신 링크 등) 역시 null. */
export function diffQueryParams(baseUrl: string, variantUrl: string): Record<string, string> | null {
  try {
    const base = new URL(baseUrl)
    const variant = new URL(variantUrl)
    if (base.origin !== variant.origin || base.pathname !== variant.pathname) return null
    // Object.create(null)로 프로토타입 없는 객체를 쓴다 — 몰 URL의 쿼리파라미터 키를 그대로 diff[key]에
    // 대입하는데, 키가 우연히(또는 악의적으로) "__proto__"면 일반 객체 리터럴({})에는 실제 속성이 아니라
    // 그 객체의 프로토타입 자체가 바뀌어버려(Object.keys에도 안 잡힘) 정렬 파라미터가 조용히 사라진다
    // (fast-check 속성 테스트가 실제로 찾아낸 사례, 2026-08-23).
    // 바뀐 파라미터 중 하나라도 "페이지 파일명처럼 생긴 값"으로 바뀌었으면, 그건 어느 화면을 보여줄지
    // 자체가 바뀐 것이다 — 이 경우 같이 바뀐 다른 파라미터(예: 상세페이지의 상품코드를 담은 "q=...")까지
    // "정렬 파라미터"로 착각해 살리면 안 되므로, 그 키만 빼는 게 아니라 이 URL 비교 전체를 무효로 한다.
    for (const [key, value] of variant.searchParams.entries()) {
      if (key === 'page' || CATEGORY_ID_QUERY_KEYS.has(key.toLowerCase())) continue
      if (PAGE_TEMPLATE_VALUE_RE.test(value) && base.searchParams.get(key) !== value) return null
    }
    const diff: Record<string, string> = Object.create(null)
    for (const [key, value] of variant.searchParams.entries()) {
      if (key === 'page') continue // 페이지 번호는 정렬과 무관한 우연한 차이일 뿐 — 정렬 파라미터가 아니다.
      if (CATEGORY_ID_QUERY_KEYS.has(key.toLowerCase())) continue // 카테고리 자체가 바뀐 것 — 정렬 아님.
      if (base.searchParams.get(key) !== value) diff[key] = value
    }
    return Object.keys(diff).length ? diff : null
  } catch {
    return null
  }
}

/** 목록 페이지(들)을 순회하며 제품 URL 후보를 모은다. 실제 상품 추출은 하지 않는다(테스트/실행 공용 로직).
 *  context를 넘기고 카테고리(listingUrls)가 여러 개면 탭을 나눠 동시에 훑는다 — 예전엔 카테고리 하나씩
 *  순서대로 방문해서, 카테고리 수만큼 페이지 로딩 시간이 그대로 누적됐다(실사용 확인: 카테고리 9개짜리
 *  미리보기가 5~7분씩 걸림 — 상품 상세페이지는 건드리지 않는데도 목록 페이지 자체를 순서대로 도는
 *  것만으로 이렇게 오래 걸렸다). context가 없거나 목록이 1개뿐이면(병렬로 나눌 이득이 없음) 예전과 같이
 *  순차로 돈다. */
async function collectProductUrls(page: Page, opts: ScrapeOptions, context?: BrowserContext): Promise<CollectedLinks> {
  if (opts.productUrls?.length) {
    return {
      urls: opts.productUrls, platform: 'unknown', categoryByUrl: new Map(), linkInfo: new Map(), needsLogin: false, stopped: false,
      listingUrls: [], perCategoryUrls: new Map(),
    }
  }
  // 실제 스크랩(sessionId+isStopRequested)뿐 아니라, DB 세션이 없는 단발 호출(정확한 총 개수 확인 —
  // countDedupedProductUrls)도 이 수집 단계를 쓴다 — previewCatalog와 같은 이유로 stopSignal도 같이 본다.
  const shouldStop = () => isStopRequested(opts.sessionId) || !!opts.stopSignal?.aborted

  const listingUrls = (opts.categoryUrls?.length ? opts.categoryUrls : (opts.url ? [opts.url] : [page.url()])).map(resetToFirstPage)
  const maxPages = Math.max(1, opts.maxPages || AUTO_PAGINATION_CAP)
  if (opts.sessionId != null) collectProgress.set(opts.sessionId, { done: 0, total: listingUrls.length })

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
  const perCategoryUrls = new Map<string, Set<string>>(listingUrls.map(u => [u, new Set<string>()]))

  async function scanForProducts(targetPage: Page): Promise<{ href: string; name: string; thumbnail: string }[]> {
    const items: { href: string; name: string; thumbnail: string }[] = await targetPage.evaluate(({ userSel, platformSel, detailPatternSrc, widgetExcludeSrc }) => {
      // 대소문자 무시 — 같은 고도몰이라도 몰마다 실제 URL의 쿼리파라미터 표기가 "goodsno"/"goodsNo"처럼
      // 다를 수 있다(실제 발견된 사례: 가방쟁이는 goodsNo). 대소문자를 그대로 두면 이 필터에 상품 링크가
      // 전부 걸러져 카테고리에서 상품을 하나도 못 찾는 문제가 있었다.
      const detailRe = detailPatternSrc ? new RegExp(detailPatternSrc, 'i') : null
      // countProductsOnPage(previewCatalog)와 같은 위젯 제외 기준을 쓴다(WIDGET_CLASS_EXCLUDE_SRC 주석
      // 참고) — 여기 없으면 "최근 본 상품"/"추천 상품" 위젯이 platformSel까지 그대로 잡혀 실제로는 끝난
      // 카테고리에서 계속 새 상품이 나오는 것처럼 보여 페이지네이션이 멈추지 않을 수 있다.
      const widgetRe = new RegExp(widgetExcludeSrc, 'i')
      const inWidget = (el: Element) => {
        for (let cur: Element | null = el; cur; cur = cur.parentElement) {
          if (widgetRe.test(cur.className || '')) return true
        }
        return false
      }
      const pick = (sel: string, requireImg: boolean, applyDetailFilter: boolean) => Array.from(document.querySelectorAll(sel))
        .filter(a => !requireImg || a.querySelector('img'))
        .filter(a => !applyDetailFilter || !inWidget(a))
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
      // 루트(`/`)만 막던 기존 필터엔 구멍이 있었다 — 이 몰의 로고는 `/`가 아니라 `/index.php`를 가리켜
      // 그대로 "상품"으로 잡혔고, 그 결과 미리보기 첫 상품이 **몰 홈페이지 자체**로 나왔다(투비즈온
      // 실사용 확인, 2026-09-13: 상품명=몰 타이틀, 상품URL=index.php). 쿼리가 없는 루트/index.* 는
      // 상품일 수 없으므로 같이 막는다(`index.php?cate=12`처럼 쿼리가 있으면 진짜 목록일 수 있어 통과).
      const isHomeLike = (u: string) => {
        try {
          const x = new URL(u)
          if (x.search || x.hash) return false
          const p = x.pathname.replace(/\/+$/, '')
          return p === '' || /^\/index\.(php|html?|asp|jsp)$/i.test(p)
        } catch { return false }
      }
      const candidates = pick('a', true, true).filter(item => {
        const n = normalize(item.href)
        return n !== currentNorm && n !== originNorm && !isHomeLike(item.href)
      })
      // 상품 링크는 목록 안에서 **같은 URL 모양으로 여러 개 반복**된다(goods_view.php?goodsno=… 처럼).
      // 반면 로고·회사소개·이벤트 배너처럼 상품이 아닌 이미지 링크는 페이지에 하나씩만 있다. 그래서
      // 가장 많이 반복된 모양(경로 + 쿼리 키 구성)만 상품으로 인정한다 — 플랫폼을 몰라 상세 URL 패턴이
      // 없는 몰(투비즈온: platform=unknown)에서 이 폴백이 아무 <a><img>나 상품으로 받아들여, 미리보기
      // 표본이 회사소개 페이지(/mall/service/company_intro.php)로 잡히던 문제를 막는다(2026-09-13).
      // 상품이 딱 1개뿐인 카테고리도 있으므로, 2개 이상 반복된 모양이 있을 때만 적용한다.
      const shapeOf = (u: string) => {
        try {
          const x = new URL(u)
          // 상품 ID가 쿼리가 아니라 경로 자체에 박혀 있는 몰(예: /goods/4557959)은 상품마다 pathname이
          // 전부 달라 그대로 비교하면 "반복된 모양"이 하나도 안 잡힌다(2026-09-26 도매창고 실사용
          // 확인 — 이 때문에 페이지에 우연히 중복으로 실린 무관한 nav 링크(header/모바일 메뉴에 같은
          // href가 두 번 나온 "/service/video_guide")가 "가장 많이 반복된 모양"으로 잘못 뽑혀, 진짜
          // 상품 20개가 전부 버려지고 그 nav 링크만 살아남았다가 Set 중복제거로 최종 1개가 됐다 —
          // "MD추천"(실제 356개)에서 count=1로 나온 원인). 숫자로만 된 경로 조각은 상품 ID로 보고
          // 자리표시자로 치환해, 서로 다른 상품이라도 같은 "모양"으로 묶이게 한다.
          const normalizedPath = x.pathname.split('/').map(seg => /^\d+$/.test(seg) ? '#' : seg).join('/')
          return `${normalizedPath}|${[...x.searchParams.keys()].sort().join(',')}`
        } catch { return u }
      }
      const shapeCounts = new Map<string, number>()
      for (const item of candidates) {
        const k = shapeOf(item.href)
        shapeCounts.set(k, (shapeCounts.get(k) ?? 0) + 1)
      }
      let bestShape = ''
      let bestCount = 0
      shapeCounts.forEach((n, k) => { if (n > bestCount) { bestCount = n; bestShape = k } })
      return bestCount >= 2 ? candidates.filter(item => shapeOf(item.href) === bestShape) : candidates
    }, { userSel, platformSel, detailPatternSrc: profile.detailUrlPattern?.source, widgetExcludeSrc: WIDGET_CLASS_EXCLUDE_SRC })
    return items.filter(item => item.href.startsWith(baseUrl))
  }

  // "중지"가 이 URL 수집 단계 중에 눌리면 여기서 즉시 멈춘다 — 아래 세 곳(카테고리 내 페이지 순회,
  // 카테고리 여러 개 동시 순회, 카테고리 여러 개 순차 순회) 전부에서 확인해야 한다. 카테고리가 페이지
  // 수십~수백 개짜리면 이 수집 단계만도 오래 걸리는데, 예전엔 여기 어디에도 isStopRequested 체크가
  // 없어서 "중지"를 눌러도 상품을 하나도 못 긁은 채로 이 수집이 끝날 때까지 그냥 계속 돌았다
  // (2026-08-11 실사용 확인·수정).
  let collectionStopped = false
  // 이 수집에서 정렬 클릭이 실제로 적용됐는지 — 호출부(미리보기)가 화면에 "정렬 적용됨/실패"를 보여줄
  // 수 있게 같이 돌려준다(CollectedLinks.sortClick 주석 참고).
  let sortClickResult: { clickText: string; applied: boolean } | undefined
  async function collectFromListing(workerPage: Page, listingUrl: string) {
    if (workerPage.url() !== listingUrl) {
      // 실패를 조용히 삼키면(예전 코드) 워커페이지가 이전 카테고리 페이지나 about:blank에 그대로 머문
      // 채로 아래 scanForProducts가 돌아, "이 카테고리는 상품이 0개"로 오판해버린다 — 실제로는 몰 서버가
      // 순간적으로 응답이 느렸을 뿐인데도(펫투비 실사용 확인, 2026-08-23: 카테고리 19개를 8탭 동시
      // 수집하다 11개가 통째로 0건·나머지도 일부만 수집됨, 상품 상세 스크랩 단계는 실패 0건이었던 것과
      // 대조적으로 이 URL 수집 단계에만 재시도가 없었다) — 아래 다음 페이지 이동(withPageParam)과 같은
      // 이유로 여기도 실패하면 더 긴 타임아웃으로 한 번 더 시도한다.
      const moved = await workerPage.goto(listingUrl, { waitUntil: 'load', timeout: 30_000 }).then(() => true).catch(() => false)
      if (!moved) await workerPage.goto(listingUrl, { waitUntil: 'load', timeout: 60_000 }).catch(() => {})
    }

    // "카테고리별 정렬기준 설정"에서 AJAX(클릭) 방식 정렬을 골랐으면(MallSortOption의 kind:'click' —
    // 정렬이 URL에 반영되지 않는 몰, detectClickBasedSortOptions 참고) 이 목록에 처음 들어온 시점에 딱
    // 한 번 클릭해 적용한다. 페이지네이션(아래 for문의 다음 페이지 이동)은 같은 workerPage/세션을 그대로
    // 쓰므로 이미 적용된 정렬 상태가 이어진다고 본다 — 페이지마다 다시 클릭하지 않는다.
    const sortClickText = opts.categorySortClicks?.[listingUrl]
    if (sortClickText) {
      try {
        // clickSortCandidateText가 <option>(네이티브 <select> 정렬)이면 selectOption으로, 아니면 기존
        // .click()으로 처리한다 — confirmSortCandidatesByClicking(감지)과 실행 방식을 반드시 맞춰야
        // 여기서 실패하지 않는다(투비즈온 실사용 확인, 2026-09-12 — 위 주석 clickSortCandidateText 참고).
        const clicked = await clickSortCandidateText(workerPage, sortClickText)
        sortClickResult = { clickText: sortClickText, applied: clicked }
        console.log(`[정렬적용:${clicked ? '성공' : '실패'}] "${sortClickText}" — ${listingUrl}${clicked ? '' : ' (정렬 라벨을 화면에서 못 찾음 — 기본 정렬로 진행)'}`)
        if (clicked) {
          await workerPage.waitForLoadState('load', { timeout: 5_000 }).catch(() => {})
          // confirmSortCandidatesByClicking과 같은 이유(2026-09-15, 정글북 실사용 확인) — networkidle이
          // 성공하든 실패하든 화면이 새 순서로 다 그려지기까지 조금 더 걸릴 수 있어 항상 짧게 더 기다린다.
          await workerPage.waitForLoadState('networkidle', { timeout: 3_000 }).catch(() => {})
          await workerPage.waitForTimeout(800)
          // kind:'click' 정렬은 정의상 AJAX라 URL이 전혀 안 바뀌어야 한다(detectSortOptionsByClicking이
          // 바로 이 조건 — afterUrl===baseUrl, 문자열 그대로 동일 — 으로 kind:'click'을 확정했다). 같은
          // 정렬 텍스트가 상품 뱃지("신상품" 등)나, 이 카테고리 페이지에만 있는 진짜 href 링크(다른
          // 카테고리에서 검증할 땐 AJAX였는데 이 페이지에선 진짜 이동 링크인 경우)에도 겹쳐서
          // getByText(...).first()가 엉뚱한 걸 눌러버릴 수 있다는 게 실사용에서 두 가지 형태로 다
          // 확인됐다(2026-08-24, 펫투비): (1) 경로 자체가 바뀌어 상품 상세로 튕겨나가 그 페이지의
          // 추천상품 몇 개만 "카테고리 상품"으로 잘못 잡히거나(카테고리 상품이 0~소수건), (2) 경로는
          // 같은 goods_list.php에 남았지만 쿼리에 `sort=price+desc` 같은 진짜 정렬 파라미터가 실려
          // "AJAX라 URL 안 바뀜"이라는 전제가 깨진 채로 이후 다음 페이지 이동(withPageParam)이 이
          // 오염된 URL을 base로 계속 페이지 번호만 늘려가며(예: page_num=60까지) 상품을 하나도 못 찾고
          // 헛돌았다 — 그러다 결국 "카테고리 전체에서 상품 링크를 하나도 못 찾음" 처리로 빠져, 이
          // 오염된 목록 URL 자체가 "상품 1건"인 것처럼 잘못 스크랩 시도되며 실패로 찍혔다. 두 경우 다
          // pathname만으론 못 잡아서(2번은 경로가 그대로다) 쿼리까지 포함한 URL 전체를 비교한다 — 조금이라도
          // 바뀌었으면 오클릭으로 보고 원래 목록 URL로 되돌린다. 정렬은 못 맞추더라도(기본순) 상품
          // 자체를 놓치지 않는 게 우선이다.
          if (workerPage.url() !== listingUrl) {
            await workerPage.goto(listingUrl, { waitUntil: 'load', timeout: 30_000 }).catch(() => {})
          } else {
            // networkidle/800ms 대기 뒤에도 AJAX 재정렬이 상품 목록을 다 그려내지 못한 채로 스캔되는
            // 경우가 실사용에서 확인됐다(펫투비 — 정렬 클릭은 제대로 됐는데 1페이지 60개 중 16개만
            // 잡힘, 그래도 늘어나는 중이라면 아직 렌더링이 끝나지 않은 것). 개수가 더 늘어나는 동안만
            // 짧게 한 번 더 기다린다 — 이미 다 그려졌으면(개수 변화 없음) 곧바로 통과한다.
            let count = (await scanForProducts(workerPage)).length
            for (let i = 0; i < 3; i++) {
              await workerPage.waitForTimeout(500)
              const nextCount = (await scanForProducts(workerPage)).length
              if (nextCount <= count) break
              count = nextCount
            }
          }
        }
      } catch { /* 정렬 클릭이 실패해도 기본 정렬로 스크랩을 계속한다 — 정렬 순서만 못 맞출 뿐 상품 자체는 그대로 수집 가능 */ }
    }

    const categoryLabel = await detectCategoryLabel(workerPage)
    let prevHrefs: Set<string> | null = null

    // "카테고리별 정렬기준 설정" 기능용 상한 — 이 카테고리(listingUrl)에만 지정된 값이 있으면 전역
    // maxPages 대신(더 크게는 못 늘림) 쓰고, 개수 상한이면 이 카테고리에서 실제로 담은 개수를 별도로
    // 세어 도달하면 멈춘다. listingCount는 함수 지역 변수라 다른 카테고리를 동시에 도는 워커와 무관하게
    // 안전하다.
    const limit = opts.categoryLimits?.[listingUrl]
    const effectiveMaxPages = limit?.mode === 'pages' ? Math.max(1, Math.min(maxPages, limit.value)) : maxPages
    let listingCount = 0
    // "이어서 스크랩하기"(opts.excludeUrls, 이미 성공한 상품)와 개수 상한을 같이 쓸 때, 개수 상한이
    // 이미 스크랩된 링크까지 슬롯으로 세면 실제 신규 상품은 설정값보다 훨씬 적게(심하면 0건) 수집되고
    // 조용히 끝난다 — extension-poc/background.js는 원래부터 exclude를 먼저 뺀 뒤 개수 상한을 적용해
    // "신규 N개"를 보장했는데 서버만 반대 순서였다(2026-09-05 전수조사로 발견, 사용자 확인 후 실제
    // 신규 수량 기준으로 통일). dead-end(페이지네이션 끝) 판정은 그대로 원본 matched 전체로 한다 —
    // 신규가 하나도 없는 페이지라고 "더 이상 상품이 없다"로 오판하면 안 된다.
    const alreadyScrapedSet = new Set(opts.excludeUrls || [])

    // 목록을 JS/AJAX로 늦게 그리는 몰에서는 이동 직후 한 번만 훑으면 헤더 링크(로고·회사소개 등)만
    // 보이고 상품은 아직 없다 — 실측으로 확인했다(투비즈온, 2026-09-13): 정렬 클릭이 있는 실행은
    // 그 대기 덕에 상품을 찾았고(18초), 정렬 없는 실행은 4초 만에 끝나며 표본이 회사소개 페이지로
    // 잡혔다. 개수 세기 쪽(countProductsSettled)에는 이미 같은 대기를 넣었는데 **수집 쪽에는 없었다.**
    // 개수가 더 늘지 않을 때까지(최소 2초, 최대 6초) 지켜본 뒤 확정한다.
    const scanProductsSettled = async (): Promise<{ href: string; name: string; thumbnail: string }[]> => {
      let best = await scanForProducts(workerPage)
      const startedAt = Date.now()
      let stable = 0
      while (Date.now() - startedAt < SETTLE_COUNT_TIMEOUT_MS) {
        await sleep(SETTLE_COUNT_INTERVAL_MS)
        const next = await scanForProducts(workerPage).catch(() => null)
        if (!next) break
        if (next.length > best.length) { best = next; stable = 0; continue }
        stable++
        if (best.length > 0 && Date.now() - startedAt >= SETTLE_COUNT_MIN_OBSERVE_MS && stable >= SETTLE_COUNT_STABLE_CHECKS) break
      }
      return best
    }
    // 도매창고처럼 페이지 번호가 <a href>가 아니라 <div data-page="N"> 클릭+AJAX로만 넘어가는 몰을 만나면
    // (아래에서 clickToPageNumber가 처음 성공하는 순간) true로 바뀐다. 한 번 이 방식으로 넘어가지면 이후
    // 페이지 이동도 계속 클릭으로만 한다 — URL 이동(withPageParam)이 이 몰에선 안 통한다는 뜻이므로, 계속
    // 시도해봤자 클릭으로 AJAX 렌더된 상태를 무의미한 URL 이동이 덮어쓰기만 한다(previewCatalog의
    // countByClickingThroughPages와 같은 이유, 2026-09-26 도매창고 실사용 확인 — "정확한 총 개수 확인"이
    // 이 몰의 356개 카테고리에서 1개만 반환했다).
    let clickPaginationMode = false
    for (let p = 0; p < effectiveMaxPages; p++) {
      if (shouldStop()) { collectionStopped = true; break }
      // 클릭 기반 AJAX 페이지네이션으로 확정된 뒤에는 매 페이지 첫 스캔부터 안정화를 기다린다 —
      // 이런 몰은 클릭 직후 즉시 스캔하면 이전 페이지 내용이 아직 그대로 남아있어(2026-09-26 실사용
      // 확인) 스캔한 페이지 내용을 신뢰할 수 없다.
      let matched = (p === 0 || clickPaginationMode) ? await scanProductsSettled() : await scanForProducts(workerPage)
      let hrefsThisPage = new Set(matched.map(m => m.href))
      const isDeadEnd = (hrefs: Set<string>) => hrefs.size === 0 || (prevHrefs !== null && [...hrefs].every(h => prevHrefs!.has(h)))
      // 빠른 스캔(scanForProducts, 안정화 대기 없음)이 "이전 페이지보다 훨씬 적은 개수"를 주웠다면 —
      // 실제로 다음 페이지가 짧아서가 아니라, 아직 다 안 그려진 화면을 스냅샷한 노이즈일 가능성이 크다
      // (도매창고 실사용 확인, 2026-09-26: URL 파라미터 이동이 안 통하는 몰에서 이 빠른 스캔이 아직 안
      // 그려진 화면에서 우연히 상품 링크 1개만 집어들었는데, 그 1개가 이전 페이지 20개 집합에 없어
      // "새 상품이다"로 오판 — isDeadEnd가 false를 반환해 아래 클릭 폴백을 건너뛰고, 그 가짜 1개를 결과에
      // 섞어 넣은 채 다음 페이지로 진행했다. 원래 페이지네이션이 안 통하는 몰이라 계속 같은 1페이지만
      // 반복해서 봤을 뿐인데, 매번 다른 노이즈 1개씩을 "새 상품"으로 잘못 누적했다). isDeadEnd의 "완전히
      // 부분집합"이라는 엄격한 조건은 이런 애매한 경우(진짜 새 상품 몇 개 + 노이즈)를 못 잡으므로, 개수
      // 자체가 확 줄었을 때는 안정화 재확인을 강제한다 — 이미 클릭 기반으로 확정된 뒤(clickPaginationMode)
      // 에는 정상적으로 페이지가 줄어들 수 있으므로(마지막 페이지) 적용하지 않는다.
      const looksIncomplete = !clickPaginationMode && p > 0 && prevHrefs !== null && hrefsThisPage.size > 0 && hrefsThisPage.size < prevHrefs.size

      // "끝"이라고 단정하기 전에 먼저 안정화를 기다린 뒤 재확인한다 — 목록을 JS/AJAX로 늦게 그리는
      // 몰에서는 방금 연 다음 페이지가 아직 안 그려져 이전 페이지와 같아 보인다(투비즈온 실사용 확인,
      // 2026-09-13: 그래서 "정확한 총 개수 확인"이 1페이지만 세고 24로 끝났다). 매 페이지마다 기다리면
      // 대형 카테고리에서 누적 비용이 크므로, dead-end처럼 "보일" 때만 안정화 후 재확인한다.
      // **클릭 폴백보다 반드시 먼저** 해야 한다 — 도매창고는 상품 목록뿐 아니라 페이지네이션 위젯
      // 자체도 페이지 이동 직후엔 아직 DOM에 없다가 AJAX로 뒤늦게 채워진다(2026-09-26 실사용 확인:
      // 안정화 없이 곧바로 clickToPageNumber를 부르면 매번 버튼을 못 찾아 result=false — "정확한 총
      // 개수 확인"이 같은 페이지(20개)만 반복해서 세며 상한(1000페이지)까지 헛돌았다).
      if ((isDeadEnd(hrefsThisPage) || looksIncomplete) && p > 0) {
        const settled = await scanProductsSettled()
        const settledHrefs = new Set(settled.map(m => m.href))
        if (!isDeadEnd(settledHrefs)) {
          matched = settled
          hrefsThisPage = settledHrefs
        } else {
          matched = settled
          hrefsThisPage = settledHrefs
          // 안정화된 뒤에도 새 상품이 없다 — 정말 페이지가 안 바뀐 것으로 보고, 사이트별
          // nextPageSelector가 있으면 그것부터, 그다음 화면의 실제 페이지 번호 버튼(클릭 기반 AJAX
          // 페이지네이션, data-page 속성 기반, mall-agnostic)을 순서대로 시도한다.
          if (nextPageSelector) {
            const nextBtn = workerPage.locator(nextPageSelector).first()
            if (await nextBtn.isVisible({ timeout: 2_000 }).catch(() => false)) {
              await nextBtn.click()
              await workerPage.waitForLoadState('load', { timeout: 15_000 }).catch(() => {})
              const afterClick = await scanProductsSettled()
              matched = afterClick
              hrefsThisPage = new Set(afterClick.map(m => m.href))
            }
          }
          if (isDeadEnd(hrefsThisPage)) {
            const clicked = await clickToPageNumber(workerPage, p + 1)
            if (clicked) {
              clickPaginationMode = true
              const afterClick = await scanProductsSettled()
              matched = afterClick
              hrefsThisPage = new Set(afterClick.map(m => m.href))
            }
          }
        }
      }
      // dead-end(페이지네이션 끝) 판정은 이 페이지에서 실제로 찾은 전체 목록(matched/hrefsThisPage)
      // 기준으로 그대로 한다 — 개수 상한 때문에 일부만 담기로 했다고 해서 "새 상품이 없다"로 오판하면
      // 안 된다(아래 담는 부분만 상한을 적용한다).
      if (isDeadEnd(hrefsThisPage)) break
      prevHrefs = hrefsThisPage

      const itemsToAdd = limit?.mode === 'count'
        ? matched.filter(m => !alreadyScrapedSet.has(m.href)).slice(0, Math.max(0, limit.value - listingCount))
        : matched
      itemsToAdd.forEach(item => {
        productUrlSet.add(item.href)
        perCategoryUrls.get(listingUrl)!.add(item.href)
        if (categoryLabel.category && !categoryByUrl.has(item.href)) categoryByUrl.set(item.href, categoryLabel)
        if (!linkInfo.has(item.href) && (item.name || item.thumbnail)) linkInfo.set(item.href, { name: item.name, thumbnail: item.thumbnail })
      })
      listingCount += itemsToAdd.length
      if (limit?.mode === 'count' && listingCount >= limit.value) break

      if (p >= effectiveMaxPages - 1) break
      if (clickPaginationMode) {
        // URL 이동이 안 통하는 몰로 이미 확정됐으니, 다음 페이지도 같은 방식(클릭)으로 이동만 해두고
        // 실제 대기/재스캔은 다음 루프 맨 위(그리고 필요하면 위의 dead-end 재확인 단계)에 맡긴다 — 다른
        // AJAX 몰(투비즈온 정렬 클릭 등)과 같은 패턴으로, 클릭 직후 고정 sleep을 넣기보다 기존
        // settle-재확인 로직이 타이밍을 흡수하게 한다.
        await clickToPageNumber(workerPage, p + 2)
        continue
      }
      // 스킨마다 다른 "다음" 버튼 클래스에 기대는 대신, page 쿼리파라미터를 다음 번호로 바꿔 직접 이동한다 —
      // cafe24 등 대부분의 몰이 페이지 번호 링크 없이도(숫자가 안 보여도) 이 파라미터로 페이지를 넘겨준다.
      // 이 이동이 타임아웃 등으로 실패하면(예전엔 catch로 조용히 무시) 페이지가 이전 페이지에 그대로
      // 머물러, 다음 루프의 스캔이 "새 상품이 없다"로 오판해 그 카테고리를 실제보다 훨씬 일찍 끝난
      // 것으로 잘못 판단한다(실사용 확인: 펫투비 — 위젯/총문구 없는 카테고리에서 실제의 15~24%만
      // 수집된 채 멈춤). 실패하면 더 긴 타임아웃으로 한 번 더 시도한다.
      const nextUrl = withPageParam(workerPage.url(), p + 2)
      // 페이지 번호가 해시에 실리는 몰은 해시만 바뀌면 문서를 다시 안 읽는다(probePage의 같은 처리
      // 참고) — 그러면 다음 페이지가 이전 페이지와 같아 보여 수집이 1페이지에서 끝난다.
      const hashOnly = (() => {
        try {
          const cur = new URL(workerPage.url()); const next = new URL(nextUrl)
          return cur.origin === next.origin && cur.pathname === next.pathname && cur.search === next.search && cur.hash !== next.hash
        } catch { return false }
      })()
      const moved = await workerPage.goto(nextUrl, { waitUntil: 'load', timeout: 15_000 }).then(() => true).catch(() => false)
      if (!moved) await workerPage.goto(nextUrl, { waitUntil: 'load', timeout: 30_000 }).catch(() => {})
      if (hashOnly) await workerPage.reload({ waitUntil: 'load', timeout: 30_000 }).catch(() => {})
    }
  }

  if (context && listingUrls.length > 1) {
    const LISTING_CONCURRENCY = Math.min(resolveConcurrency(opts, 16), listingUrls.length)
    let cursor = 0
    async function worker(workerPage: Page) {
      while (true) {
        if (shouldStop()) { collectionStopped = true; return }
        const i = cursor++
        if (i >= listingUrls.length) return
        await collectFromListing(workerPage, listingUrls[i]).catch(() => {})
        if (opts.sessionId != null) collectProgress.get(opts.sessionId)!.done++
      }
    }
    const workerPages = await Promise.all(
      Array.from({ length: LISTING_CONCURRENCY }, (_, idx) => (idx === 0 ? page : context.newPage())),
    )
    await Promise.all(workerPages.map(worker))
    await Promise.all(workerPages.slice(1).map(p => p.close().catch(() => {})))
  } else {
    for (const listingUrl of listingUrls) {
      if (shouldStop()) { collectionStopped = true; break }
      await collectFromListing(page, listingUrl)
      if (opts.sessionId != null) collectProgress.get(opts.sessionId)!.done++
    }
  }

  // 목록 페이지 자체와 이미 스크랩된 상품은 제외 — perCategoryUrls도 urls와 같은 기준으로 걸러야
  // countCategoryOverlap의 카테고리별 개수 합이 최종 urls.length와 어긋나지 않는다.
  const listingSet = new Set(listingUrls)
  const excludeSet  = new Set(opts.excludeUrls || [])
  const dropExcluded = (h: string) => !listingSet.has(h) && !excludeSet.has(h)
  const urls = [...productUrlSet].filter(dropExcluded)
  perCategoryUrls.forEach((set, key) => perCategoryUrls.set(key, new Set([...set].filter(dropExcluded))))

  if (opts.sessionId != null) collectProgress.delete(opts.sessionId)
  return { urls, platform, categoryByUrl, linkInfo, needsLogin, stopped: collectionStopped, listingUrls, perCategoryUrls, sortClick: sortClickResult }
}

/**
 * "정확한 총 개수 확인" — previewCatalog의 카테고리별 개수(위젯 수식/지수+이분 탐색으로 빠르게 구한
 * 값)는 카테고리마다 독립적으로 세기 때문에, 선택한 카테고리들끼리 상품이 겹치면(예: "가격대별" 같은
 * 가로 분류와 "여성화/남성화" 같은 세로 분류를 같이 선택) 그 총합이 실제로 스크랩될 상품 수보다 크게
 * 나온다(실제 스크랩은 collectProductUrls가 모든 선택 카테고리를 하나의 Set으로 모아 자동으로 중복을
 * 제거하므로 이 문제가 없다 — 사용자 질문, 2026-08-17). 정확한 총계를 보여주려면 그 실제 수집과 같은
 * 방식(목록 페이지를 전부 훑어 URL을 모음, 상품 상세는 열지 않음)을 써야 해서 카테고리별 빠른 집계보다
 * 느릴 수 있다 — 그래서 previewCatalog의 기본 총계 옆에 버튼으로 두고 필요할 때만 호출한다.
 */
export async function countDedupedProductUrls(opts: ScrapeOptions): Promise<{ total: number; needsLogin: boolean; stopped: boolean }> {
  return withContext(opts, async (page, context) => {
    const { urls, needsLogin, stopped } = await collectProductUrls(page, opts, context)
    return { total: urls.length, needsLogin, stopped }
  }, '정확한 총 개수 확인')
}

/**
 * "카테고리별 중복 개수 확인" — countDedupedProductUrls는 총합 하나만 보여주는데, 정작 "그래서 어느
 * 카테고리끼리 얼마나 겹치길래 이렇게 줄어드는지"는 알 수 없다는 질문(2026-08-25, 미리보기 2800여개 vs
 * 실제 스크랩 1600여개 — 원인 확인 과정에서 나온 요청)에 답하기 위해, countDedupedProductUrls와 같은
 * 실제 수집(collectProductUrls)을 한 번 해서 카테고리별로 "이 카테고리에서 찾은 개수", 그중 "다른
 * 카테고리에는 없던(=최종 스크랩에 새로 보태는) 개수", "이미 다른 카테고리에도 있던(=중복) 개수"를
 * 나눠 돌려준다.
 * 실제 스크랩은 카테고리를 여러 탭으로 동시에 처리해 같은 상품을 "누가 먼저" 찾는지가 그때그때 달라질 수
 * 있어(경합) 어느 카테고리가 중복의 "주인"인지 자체는 원래 결정론적이지 않다 — 화면에 매번 다른 숫자가
 * 나오면 혼란스러우므로, 여기서는 항상 opts.categoryUrls에 준 순서를 기준으로 "먼저 나열된 카테고리가
 * 그 상품의 주인"으로 고정해서 계산한다. 이 순서는 카테고리 체크리스트가 항상 쓰는 순서와 같다(순서를
 * 바꿔도 카테고리별 귀속만 달라질 뿐, 카테고리 개수 합계(중복 제거된 총합)는 순서와 무관하게 항상
 * 실제 스크랩과 같다).
 */
export async function countCategoryOverlap(opts: ScrapeOptions): Promise<{
  categories: { url: string; count: number; uniqueCount: number; duplicateCount: number }[]
  total: number
  needsLogin: boolean
  stopped: boolean
}> {
  return withContext(opts, async (page, context) => {
    const { urls, listingUrls, perCategoryUrls, needsLogin, stopped } = await collectProductUrls(page, opts, context)
    const seen = new Set<string>()
    const categories = listingUrls.map(url => {
      const set = perCategoryUrls.get(url) ?? new Set<string>()
      let uniqueCount = 0
      for (const href of set) {
        if (seen.has(href)) continue
        seen.add(href)
        uniqueCount++
      }
      return { url, count: set.size, uniqueCount, duplicateCount: set.size - uniqueCount }
    })
    return { categories, total: urls.length, needsLogin, stopped }
  }, '카테고리별 중복 개수 확인')
}

/** "카테고리 불러오기" 체크리스트에 상품개수/확인일시 컬럼을 보여주기 위해, 미리보기(일반모드
 *  previewCatalog/개발자모드 preview-capture)가 구한 카테고리별 개수를 sites.scrape_profile에 누적
 *  저장한다(사용자 요청, 2026-08-17). href를 키로 하는 맵에 얕은 병합(||)만 하므로, 이번에 확인한
 *  카테고리만 갱신되고 그 전에 다른 회차에서 확인해둔 나머지 카테고리 값은 그대로 남는다 — 몰 전체를
 *  한 번에 미리보기하지 않고 몇 개씩 나눠 확인해도 각자 자기 확인 시각을 유지한다. */
export async function persistCategoryCounts(
  siteId: number, counts: { url: string; label: string; count: number; truncated?: boolean }[],
): Promise<void> {
  if (!counts.length) return
  const checkedAt = new Date().toISOString()
  const map: Record<string, { count: number; truncated?: boolean; label: string; checkedAt: string }> = {}
  for (const c of counts) map[c.url] = { count: c.count, truncated: c.truncated, label: c.label, checkedAt }
  await pool.query(
    `UPDATE sites SET
       scrape_profile = COALESCE(scrape_profile, '{}'::jsonb)
         || jsonb_build_object('categoryCounts',
              COALESCE(scrape_profile->'categoryCounts', '{}'::jsonb) || $1::jsonb)
     WHERE id=$2`,
    [JSON.stringify(map), siteId],
  )
}

/** 카테고리 체크리스트에 "이 카테고리는 최근에 언제 스크랩됐고 어느 업체로 마이그레이션됐는지" 보여주기
 *  위한 조회(사용자 요청, 2026-08-17). 카테고리는 href(URL) 단위지만 실제 스크랩된 상품(mall_products)은
 *  href를 남기지 않고 목록 페이지에서 감지한 텍스트 라벨(mall_category, detectCategoryLabel과 동일
 *  형식)만 남기므로, href가 아니라 라벨로 매칭한다 — persistCategoryCounts가 저장해둔 categoryCounts의
 *  label을 그대로 쓰면 previewCatalog가 쓴 것과 같은 라벨이라 매칭 정확도가 가장 높다.
 *  업체는 한 카테고리가 여러 업체로 나눠 마이그레이션됐을 수 있어 "가장 최근에 마이그레이션된 업체
 *  하나"만 보여주기로 했다(사용자 선택, 2026-08-17) — DISTINCT ON으로 라벨별 최신 product_master
 *  1건만 뽑는다. */
export async function getCategoryScrapeHistory(
  siteId: number, labels: string[],
): Promise<Record<string, { lastScrapedAt: string | null; clientName: string | null }>> {
  const result: Record<string, { lastScrapedAt: string | null; clientName: string | null }> = {}
  if (!labels.length) return result
  const scrapedRes = await pool.query<{ mall_category: string; last_scraped_at: string | null }>(
    `SELECT mall_category, MAX(last_scraped_at) AS last_scraped_at FROM mall_products
     WHERE site_id=$1 AND mall_category = ANY($2) GROUP BY mall_category`,
    [siteId, labels],
  )
  for (const row of scrapedRes.rows) result[row.mall_category] = { lastScrapedAt: row.last_scraped_at, clientName: null }
  const clientRes = await pool.query<{ mall_category: string; client_name: string }>(
    `SELECT DISTINCT ON (mp.mall_category) mp.mall_category, sc.name AS client_name
     FROM product_master pmaster
     JOIN mall_products mp ON mp.id = pmaster.mall_product_id
     JOIN supply_clients sc ON sc.id = pmaster.client_id
     WHERE mp.site_id=$1 AND mp.mall_category = ANY($2)
     ORDER BY mp.mall_category, pmaster.created_at DESC`,
    [siteId, labels],
  )
  for (const row of clientRes.rows) {
    if (!result[row.mall_category]) result[row.mall_category] = { lastScrapedAt: null, clientName: null }
    result[row.mall_category].clientName = row.client_name
  }
  return result
}

/** 이 몰에서 실제로 검수를 통과해 마이그레이션 확정된(product_master로 넘어간) 상품들의 카테고리명 —
 *  "스크랩이 정상적으로 끝까지(다음 단계까지) 이어졌다"는 증거가 있는 카테고리만 모은다는 점에서
 *  mall_products.mall_category(스크랩 시도만으로 채워짐)보다 신뢰도가 높다. lib/scrape/
 *  categoryAnomalyCheck.ts의 checkCategoryAnomaly가 "새로 찾은 카테고리 구조가 터무니없는지" AI에게
 *  판단시킬 때 기준선으로 쓴다(2026-08-29). */
export async function getMigratedCategoryLabels(siteId: number): Promise<string[]> {
  const res = await pool.query<{ mall_category: string }>(
    `SELECT DISTINCT pm.mall_category FROM product_master pm
     JOIN mall_products mp ON mp.id = pm.mall_product_id
     WHERE mp.site_id = $1 AND pm.mall_category IS NOT NULL AND pm.mall_category != ''`,
    [siteId],
  )
  return res.rows.map(r => r.mall_category)
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
  /** true면 위젯 판독·지수+이분 탐색이 전부 실패해 마지막 수단(최대 AUTO_PAGINATION_CAP 페이지 직접
   *  순회)까지 갔는데 그 상한에도 새 상품이 계속 나와(=아직 안 끝남) 셈을 멈춘 것이다 — count는 "최소
   *  이만큼은 있다"는 하한이지 정확한 총합이 아니다(실사용 확인, 2026-08-16: 걸스굽 "SOLD OUT"/"여성화"가
   *  정확히 상한(50페이지×48개=2400)에서 멈췄는데도 그 값을 그대로 정답처럼 보여줘 사용자가 실제 개수와
   *  안 맞다고 지적함 — 몰 응답 속도상 상한 없이 끝까지 세는 건 previewCatalog 취지(빠른 확인)에 안
   *  맞아, 대신 "이 값은 하한이다"를 알려 UI가 "2,400개 이상"처럼 정직하게 표시하게 한다). */
  truncated?: boolean
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
  /** 미리보기 1건을 **어느 목록에서, 어떤 정렬로** 뽑았는지 — 지금까지는 이 정보가 응답에 없어,
   *  화면이 보여주는 상품이 사용자가 고른 카테고리의 것인지 아닌지조차 알 수 없었다(사용자 지적,
   *  2026-09-13: "왜 다른 카테고리를 봤는지"). 특히 첫 카테고리가 비어 있으면 코드가 **조용히 다른
   *  카테고리로 갈아타** 표본을 뽑는데, 그 사실이 화면에 전혀 드러나지 않았다. */
  /** 이번 미리보기에서 목록을 보고 새로 학습한 상품 상세 URL 패턴(정규식 source) — 호출부(라우트)가
   *  사이트에 저장해두면 다음부터 개수 세기·미리보기·스크랩이 전부 같은 기준을 쓴다.
   *  이미 알고 있던 패턴과 같거나 근거가 부족하면 없음. */
  learnedDetailUrlPattern?: string | null
  previewSource?: {
    /** 실제로 표본을 뽑은 목록 URL */
    url: string
    /** 사용자가 고른 첫 카테고리 URL — url과 다르면 갈아탄 것이다 */
    requestedUrl: string
    /** 갈아탄 이유(첫 카테고리에서 상품을 못 찾음 등). 갈아타지 않았으면 없음 */
    switchedReason?: string
    /** AJAX(클릭) 정렬을 요청했다면 그 라벨과 실제 적용 여부 */
    sortClick?: { clickText: string; applied: boolean }
  } | null
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

// 상품 그리드가 아닌 "최근 본 상품"/"추천 상품" 위젯이 상품 카드와 같은 셀렉터·URL 패턴을 공유해 개수/
// 목록에 섞여 들어가는 몰이 있다(카페24 xans-layout-productrecent 대비 폴백 경로에만 제외 로직이 있었음
// — 실사용 확인: 펫투비 고도몰 스킨은 platformSel(.item_cont/.goods_list)이 위젯까지 그대로 잡아, 위젯
// 내용만 살짝 달라지는 페이지를 "새 페이지"로 오판해 카테고리 개수가 실제(약 100개대)보다 크게(700개대)
// 부풀려졌다). userSel(사용자가 직접 지정)에는 적용하지 않아 사용자 의도를 존중한다 — platformSel/폴백
// 스캔 셋(countProductsOnPage/countProductsFromHtml/scanForProducts) 전부가 이 상수 하나를 같이 쓴다.
const WIDGET_CLASS_EXCLUDE_SRC = 'productrecent|recent-?list|recent-?view|recently-?viewed|recommend'

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
 *  구분할 수 있다.
 *  isLoginPage 판정은 "화면에 실제로 보이는" 비밀번호 입력창만 센다 — 고도몰 계열 몰은 "비밀번호 주기적
 *  변경" 안내 팝업(예: <div id='popupChangePassword' class='hide'>)을 로그인 여부와 무관하게 모든
 *  페이지의 공통 푸터 템플릿에 항상 심어두는 경우가 있다(2026-09-11, 도매토피아 실사용 확인 — 공개
 *  페이지를 로그인 없이 그대로 GET해도 이 폼이 그대로 응답에 있었다). 이 팝업은 기본적으로 숨겨져 있을
 *  뿐 DOM에는 항상 존재해, 화면에 보이는지를 안 가리면 상품이 0개인 페이지(정상적인 안내성 페이지)마다
 *  매번 "로그인 세션이 끊긴 것"으로 오탐한다 — 세션은 멀쩡한데도 "몰 구조분석"을 돌릴 때마다 경고가
 *  반복됐다. checkVisibility()(Chromium 105+, display:none/visibility:hidden/0크기 등을 한 번에 판정)를
 *  지원하지 않는 예전 브라우저에서는 안전하게 기존 동작(무조건 로그인 페이지로 간주)으로 폴백한다. */
async function countProductsOnPage(
  page: Page, userSel: string | null, platformSel: string | null, detailPatternSrc: string | undefined, baseUrl: string,
): Promise<{ count: number; isLoginPage: boolean; fingerprint: string; hrefs: string[] }> {
  return page.evaluate(({ userSel, platformSel, detailPatternSrc, baseUrl, widgetExcludeSrc }) => {
    type WithVisibilityCheck = Element & { checkVisibility?: () => boolean }
    const isLoginPage = Array.from(document.querySelectorAll('input[type="password"]'))
      .some(el => (el as WithVisibilityCheck).checkVisibility?.() ?? true)
    const detailRe = detailPatternSrc ? new RegExp(detailPatternSrc, 'i') : null
    const widgetRe = new RegExp(widgetExcludeSrc, 'i')
    const inWidget = (el: Element) => {
      for (let cur: Element | null = el; cur; cur = cur.parentElement) {
        if (widgetRe.test(cur.className || '')) return true
      }
      return false
    }
    const hrefs = (sel: string, requireImg: boolean, applyDetailFilter: boolean) => Array.from(document.querySelectorAll(sel))
      .filter(a => !requireImg || a.querySelector('img'))
      .filter(a => !applyDetailFilter || !inWidget(a))
      .map(a => (a as HTMLAnchorElement).href)
      .filter(href => href && href.startsWith(baseUrl))
      .filter(href => !applyDetailFilter || !detailRe || detailRe.test(href))
    // 상품 카드 하나에 링크가 여러 개인 스킨이 흔하다(썸네일 링크 + "빠른보기"/장바구니 오버레이 버튼
    // 링크 등, 실사용 확인: 펫투비 고도몰 스킨은 카드마다 이 두 링크가 항상 같은 상품을 중복으로 가리켜
    // 실제 21개인 카테고리가 42개로 잡혔다) — 중복 href를 그대로 세면 몰마다 카드 안 링크 개수가 달라
    // count가 들뜨고 불안정해진다(지수+이분 탐색이 "새 페이지"로 오판하는 원인). URL 그대로 중복 제거해
    // 실제 상품 개수만 센다.
    const toResult = (list: string[]) => { const u = [...new Set(list)]; return { count: u.length, isLoginPage, fingerprint: u.slice().sort().join('|'), hrefs: u } }
    if (userSel) return toResult(hrefs(userSel, false, false))
    if (platformSel) {
      const viaProfile = hrefs(platformSel, false, true)
      if (viaProfile.length > 0) return toResult(viaProfile)
    }
    const normalize = (u: string) => u.replace(/\/+$/, '')
    // 로고가 '/'가 아니라 '/index.php'를 가리키는 몰이 있다(투비즈온 실사용 확인, 2026-09-13 — 그 로고
    // 링크가 "상품"으로 잡혀 미리보기 첫 상품이 몰 홈페이지로 나왔다). 쿼리 없는 루트/index.*는 상품일
    // 수 없으므로 제외한다 — collectProductUrls 폴백과 같은 기준.
    const isHomeLikeHref = (u: string) => {
      try {
        const x = new URL(u)
        if (x.search || x.hash) return false
        const pth = x.pathname.replace(/\/+$/, '')
        return pth === '' || /^\/index\.(php|html?|asp|jsp)$/i.test(pth)
      } catch { return false }
    }
    const currentNorm = normalize(location.href)
    const originNorm = normalize(location.origin)
    // 로고/장바구니/마이샵/상단메뉴/"TODAY VIEW"(최근 본 상품) 위젯 등 사이트 공통 헤더의 <a><img>가 실제
    // 상품처럼 잡히는 문제가 있었다(2026-08-09 seasonbag.co.kr 재현 — 실제로는 상품이 하나도 없는
    // "대량구매/제작문의" 카테고리에서 이런 공통 요소들 때문에 perPage가 0이 아닌 값으로 잘못 확정되고,
    // 이후 지수+이분 탐색이 이 카테고리에 진짜 있지도 않은 "페이지 수"를 찾아 헤맸다). 카페24 플랫폼
    // 코어 마크업(`#contents`, 스킨을 바꿔도 대개 남아있음)이 있으면 그 안쪽(실제 본문 영역)만 보고, 이
    // id를 못 찾는 스킨이면(신뢰 못 함) 문서 전체를 그대로 본다 — 즉 이 스코프 좁히기가 안 맞는 몰에서도
    // 지금보다 나빠지지 않는다. `xans-layout-productrecent`(TODAY VIEW)는 #contents 스코프로도 대부분
    // 걸러지지만, 일부 스킨은 이 위젯을 본문 안쪽에 붙이는 경우도 있어 별도로 한 번 더 제외한다.
    const scopeRoot = document.querySelector('#contents') || document
    const fallback = Array.from(scopeRoot.querySelectorAll('a'))
      .filter(a => a.querySelector('img'))
      .filter(a => !inWidget(a))
      .map(a => (a as HTMLAnchorElement).href)
      .filter(href => href && href.startsWith(baseUrl))
      .filter(href => { const n = normalize(href); return n !== currentNorm && n !== originNorm && !isHomeLikeHref(href) })
      // 페이지네이션 이전/다음 화살표, 검색·비교 버튼처럼 #contents 안에 있지만 상품이 아닌 <a><img>가
      // 있다(실사용 확인: 진짜양말 — href="#none"/"#SelectSearch"라 #contents 스코프로도 안 걸러지고,
      // 프래그먼트라 상세 페이지(#currentNorm)와도 달라 매 페이지 "새 상품 2개"로 잘못 잡혀 지수+이분
      // 탐색/직접 순회가 실제로는 상품이 2개뿐인 카테고리를 최대 50페이지까지(=100개) 부풀렸다). 알려진
      // 플랫폼의 상품 상세 URL 패턴이 있으면 여기서도 적용해 이런 비상품 링크를 걸러낸다.
      .filter(href => !detailRe || detailRe.test(href))
    return toResult(fallback)
  }, { userSel, platformSel, detailPatternSrc, baseUrl, widgetExcludeSrc: WIDGET_CLASS_EXCLUDE_SRC })
}

// countProductsOnPage는 "부르는 그 순간의 DOM"만 보는 스냅샷이다 — 목록을 JS/AJAX로 그리는 몰에서
// 페이지 이동 직후 한 번만 세면 실제로는 상품이 있는데 0개(또는 먼저 그려진 일부만)로 잡힌다.
// 실사용 확인(2026-09-13, 투비즈온 — 사용자 지적: "해당 카테고리를 클릭하면 살짝 늦게 열리는데,
// 그러한 이유로 건너뛴 건 아닌지"): 카테고리 51개 중 32개가 "상품 0개 + 하위메뉴 0개"로 판정돼 최종
// 목록에서 통째로 빠졌고(뷰티/바디헤어/대형가전/카메라 등 실제로 상품이 있는 카테고리들), 살아남은
// 것들조차 하나같이 "상품 5개"로 균일했다(먼저 그려지는 일부만 센 흔적).
const SETTLE_COUNT_TIMEOUT_MS = 6_000
const SETTLE_COUNT_INTERVAL_MS = 500
// "한 번 더 세봤는데 안 늘었으면 끝"으로는 부족하다 — 합성 페이지로 실측(2026-09-13)해보니, 추천상품
// 위젯 5개가 **먼저** 그려져 있고 진짜 목록 40개가 1.5초 뒤 오는 페이지에서 0.5초 만에 "5개로 안정됐다"고
// 확정해버렸다(투비즈온에서 살아남은 카테고리가 전부 "상품 5개"였던 것과 정확히 같은 모양). 그래서
// 개수가 0이 아니어도 최소 이 시간만큼은 계속 지켜보고, 그 뒤 연속 2회 안 늘어야 확정한다.
const SETTLE_COUNT_MIN_OBSERVE_MS = 2_000
const SETTLE_COUNT_STABLE_CHECKS = 2

/** countProductsOnPage를 "개수가 더 이상 늘지 않을 때까지" 반복해 센다 — 위 상수 주석 참고.
 *  이미 다 그려진 정상 페이지는 확인 한 번(0.5초)만 더 들고, 끝까지 0개인 진짜 빈 페이지만 상한까지
 *  기다린다. onGrew: 첫 스냅샷보다 실제로 늘어난 경우에만 불린다(진단 로그용). */
async function countProductsSettled(
  page: Page, userSel: string | null, platformSel: string | null, detailPatternSrc: string | undefined, baseUrl: string,
  onGrew?: (first: number, final: number, elapsedMs: number) => void,
): Promise<{ count: number; isLoginPage: boolean; fingerprint: string; hrefs: string[] }> {
  const once = () => countProductsOnPage(page, userSel, platformSel, detailPatternSrc, baseUrl)
  let probe = await once()
  if (probe.isLoginPage) return probe
  const first = probe.count
  const startedAt = Date.now()
  let stableChecks = 0
  while (Date.now() - startedAt < SETTLE_COUNT_TIMEOUT_MS) {
    await sleep(SETTLE_COUNT_INTERVAL_MS)
    const next = await once().catch(() => null)
    if (!next) break
    if (next.isLoginPage) return next
    if (next.count > probe.count) { probe = next; stableChecks = 0; continue } // 아직 그려지는 중
    stableChecks++
    const observedEnough = Date.now() - startedAt >= SETTLE_COUNT_MIN_OBSERVE_MS
    if (probe.count > 0 && observedEnough && stableChecks >= SETTLE_COUNT_STABLE_CHECKS) break
  }
  if (probe.count > first) onGrew?.(first, probe.count, Date.now() - startedAt)
  return probe
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

/** 페이지네이션 위젯의 "마지막 페이지로" 이동 버튼 href에 인코딩된 페이지 번호를 직접 읽는다 —
 *  `readMaxPageNumber`보다 훨씬 직접적이고 안정적인 1순위 신호다. 이 버튼은 보통 이미지 버튼이라
 *  텍스트가 없어(`<a href="...page=14"><img alt="마지막 페이지"></a>`) `readMaxPageNumber`의 텍스트
 *  기반 스캔(`node.textContent`)에는 전혀 안 잡혔다 — `<img>`는 textContent가 없기 때문. 그런데 이
 *  버튼은 "마지막 페이지로 이동"이라는 자기 역할상, 몰이 지금 보여주는 페이지가 몇 번이든(범위 밖으로
 *  clamp됐어도) href는 항상 진짜 마지막 페이지를 가리켜야 한다 — 실사용 확인(2026-08-09,
 *  seasonbag.co.kr): `cate_no=41`을 1/3/6/7/261페이지 어느 걸로 요청해도 이 버튼의 href는 한 번도
 *  안 바뀌고 항상 `page=6`(진짜 마지막)을 가리켰다. 텍스트로 보이는 페이지 번호를 세거나(버그 3~7이
 *  전부 이 방식의 한계에서 나왔다) 지수+이분 탐색으로 찾을 필요 자체가 없어진다. 카페24 기본
 *  페이지네이션 위젯(`ec-base-paginate`, 플랫폼 코어 마크업이라 스킨을 커스터마이징해도 대개 그대로
 *  남아있음)은 이 버튼에 `class="last"`를 쓰지만, 클래스명이 다른 스킨도 있을 수 있어 클래스/alt
 *  텍스트에 "last" 또는 "마지막"이 포함된 링크를 찾는다. */
async function readLastPageFromNavButton(page: Page): Promise<number | null> {
  return page.evaluate(() => {
    const roots = Array.from(document.querySelectorAll('[class*="paging" i], [class*="pagination" i]'))
    for (const el of roots) {
      const candidates = Array.from(el.querySelectorAll('a[href]')).filter(a => {
        const cls = a.className || ''
        const alt = a.querySelector('img')?.getAttribute('alt') || ''
        return /last|마지막/i.test(cls) || /last|마지막/i.test(alt)
      })
      for (const a of candidates) {
        try {
          const u = new URL((a as HTMLAnchorElement).href, location.href)
          const n = Number(u.searchParams.get('page'))
          if (Number.isInteger(n) && n > 0) return n
        } catch { /* href가 page 쿼리파라미터 형태가 아님 — 다음 후보로 */ }
      }
    }
    return null
  }).catch(() => null)
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

/** countProductsOnPage의 무(無)브라우저 버전 — 브라우저 탭으로 실제 페이지를 열지 않고, 이미 받아온 HTML
 *  문자열만 cheerio로 파싱해 같은 판정 기준을 적용한다. 브라우저는 href를 항상 절대경로로 정규화해
 *  주지만(`a.href`) cheerio는 원본 속성값(상대경로일 수 있음) 그대로 주므로, finalUrl(리다이렉트 반영된
 *  실제 응답 URL)을 기준으로 직접 절대경로화한다. 판정 로직 자체는 countProductsOnPage와 반드시 같게
 *  유지해야 한다(이 몰에서 실사용 확인된 판단 기준들이라 여기서 갈라지면 지수+이분 탐색이 다시 틀린
 *  결과를 낼 수 있다). */
function countProductsFromHtml(
  html: string, finalUrl: string, userSel: string | null, platformSel: string | null, detailPatternSrc: string | undefined, baseUrl: string,
): { count: number; isLoginPage: boolean; fingerprint: string; hrefs: string[] } {
  const $ = loadHtml(html)
  const isLoginPage = $('input[type="password"]').length > 0
  const detailRe = detailPatternSrc ? new RegExp(detailPatternSrc, 'i') : null
  const resolve = (href: string | undefined): string | null => {
    if (!href) return null
    try { return new URL(href, finalUrl).href } catch { return null }
  }
  // countProductsOnPage의 위젯 제외와 반드시 같게 유지한다(WIDGET_CLASS_EXCLUDE_SRC 주석 참고).
  // cheerio-select의 속성선택자 `i` 플래그 지원 여부에 의존하지 않도록, 조상 class는 직접 정규식으로
  // 검사한다(아래 fallback과 같은 방식).
  const widgetRe = new RegExp(WIDGET_CLASS_EXCLUDE_SRC, 'i')
  const hrefs = (sel: string, requireImg: boolean, applyDetailFilter: boolean) => $(sel).toArray()
    .filter(el => !requireImg || $(el).find('img').length > 0)
    .filter(el => !applyDetailFilter || !$(el).parents().toArray().some(p => widgetRe.test($(p).attr('class') || '')))
    .map(el => resolve($(el).attr('href')))
    .filter((href): href is string => !!href && href.startsWith(baseUrl))
    .filter(href => !applyDetailFilter || !detailRe || detailRe.test(href))
  // countProductsOnPage와 반드시 같은 중복 제거 기준을 유지한다(위 함수 주석 참고 — 상품 카드 하나에
  // 링크가 여러 개인 스킨에서 count가 들뜨는 문제).
  const toResult = (list: string[]) => { const u = [...new Set(list)]; return { count: u.length, isLoginPage, fingerprint: u.slice().sort().join('|'), hrefs: u } }
  if (userSel) return toResult(hrefs(userSel, false, false))
  if (platformSel) {
    const viaProfile = hrefs(platformSel, false, true)
    if (viaProfile.length > 0) return toResult(viaProfile)
  }
  const normalize = (u: string) => u.replace(/\/+$/, '')
  // 브라우저 버전(countProductsOnPage)의 isHomeLikeHref와 같은 기준 — 로고가 /index.php를 가리키는 몰 대비.
  const isHomeLikeHref = looksLikeMallHomeUrl
  const currentNorm = normalize(finalUrl)
  const originNorm = normalize(new URL(finalUrl).origin)
  // countProductsOnPage의 #contents 스코프 좁히기 + TODAY VIEW 제외와 반드시 같게 유지한다(위 함수 주석
  // 참고). cheerio-select의 속성선택자 `i` 플래그 지원 여부에 의존하지 않도록, 조상 class는 직접 정규식으로
  // 검사한다.
  const contents = $('#contents')
  const scopeRoot = contents.length ? contents : $('body')
  const fallback = scopeRoot.find('a').toArray()
    .filter(el => $(el).find('img').length > 0)
    .filter(el => !$(el).parents().toArray().some(p => widgetRe.test($(p).attr('class') || '')))
    .map(el => resolve($(el).attr('href')))
    .filter((href): href is string => !!href && href.startsWith(baseUrl))
    .filter(href => { const n = normalize(href); return n !== currentNorm && n !== originNorm && !isHomeLikeHref(href) })
    // countProductsOnPage의 상세 URL 패턴 필터와 반드시 같게 유지한다(위 함수 주석 참고 — 페이지네이션
    // 화살표/검색·비교 버튼처럼 #contents 안에 있는 비상품 <a><img>가 상품으로 잘못 잡히는 문제).
    .filter(href => !detailRe || detailRe.test(href))
  return toResult(fallback)
}

/** readCurrentPageNumber의 무브라우저 버전 — 같은 "다수 클래스와 다른 하나" 판정을 cheerio로 재현한다. */
function readCurrentPageNumberFromHtml(html: string, nextPageSelector: string | undefined): number | null {
  const $ = loadHtml(html)
  const isPagingClass = (cls: string) => /paging|pagination/i.test(cls)
  const roots: ReturnType<typeof $> [] = []
  if (nextPageSelector) {
    const near = $(nextPageSelector).first().closest('div, ul, nav, p')
    if (near.length) roots.push(near)
  }
  if (!roots.length) {
    $('[class]').each((_, el) => { if (isPagingClass($(el).attr('class') || '')) roots.push($(el)) })
  }
  for (const root of roots) {
    const entries = root.find('a[href]').toArray()
      .map(el => ({ n: Number(($(el).text() || '').trim()), cls: $(el).attr('class') || '' }))
      .filter(e => Number.isInteger(e.n) && e.n > 0 && e.n < 100_000)
    if (entries.length < 2) continue
    const counts = new Map<string, number>()
    for (const e of entries) counts.set(e.cls, (counts.get(e.cls) || 0) + 1)
    const [commonCls] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]
    const odd = entries.filter(e => e.cls !== commonCls)
    if (odd.length === 1) return odd[0].n
  }
  return null
}

/** 실제 브라우저 탭을 띄우지 않고, 로그인된 브라우저 컨텍스트의 쿠키를 그대로 실어 순수 HTTP GET만
 *  보낸다(context.request는 같은 BrowserContext에 묶여 있어 쿠키를 따로 옮길 필요가 없다) — 렌더링·
 *  JS 실행·CDP 왕복이 전혀 없어 지수+이분 탐색이 수십 번 반복돼도 이벤트루프/메모리 부담이 거의 없다.
 *  실패(네트워크 오류, non-200 등)하면 null을 돌려주고, 호출부가 그 한 번만 브라우저 방식으로 대체한다. */
async function probeLightweight(
  context: BrowserContext, url: string,
  userSel: string | null, platformSel: string | null, detailPatternSrc: string | undefined, baseUrl: string,
  nextPageSelector: string | undefined,
): Promise<{ count: number; isLoginPage: boolean; fingerprint: string; hrefs: string[]; currentPage: number | null } | null> {
  try {
    const res = await context.request.get(url, { timeout: 15_000 })
    if (!res.ok()) return null
    // decodeHttpResponseText 주석 참고 — res.text()는 charset=euc-kr 등을 무시하고 항상 UTF-8로 디코딩해
    // scanCategoryMenuRobust와 같은 문제가 있다. 여기는 주로 href(URL)만 뽑아 쓰긴 하지만, 페이지 번호
    // 텍스트(readCurrentPageNumberFromHtml)처럼 실제 한글을 읽는 곳도 있어 같은 방식으로 고쳐둔다.
    const html = decodeHttpResponseText(res, await res.body())
    const finalUrl = res.url()
    const { count, isLoginPage, fingerprint, hrefs } = countProductsFromHtml(html, finalUrl, userSel, platformSel, detailPatternSrc, baseUrl)
    const currentPage = count > 0 ? readCurrentPageNumberFromHtml(html, nextPageSelector) : null
    return { count, isLoginPage, fingerprint, hrefs, currentPage }
  } catch {
    return null
  }
}

/** useHttp가 참이면(호출부가 이미 페이지 1과 대조해 이 몰이 순수 HTTP로도 같은 개수가 나옴을 확인한
 *  상태) 브라우저 탭 없이 probeLightweight로 먼저 시도하고, 실패하거나 useHttp가 아니면 기존처럼
 *  브라우저 탭으로 이동해 읽는다 — findRealLastPage의 지수+이분 탐색과 countCategoryProductsOnce의
 *  마지막 페이지/마지막+1 페이지 확인이 이 판정 로직을 공유한다. */
async function probeCategoryPage(
  workerPage: Page, context: BrowserContext, firstPageUrl: string, pageNum: number, useHttp: boolean,
  userSel: string | null, platformSel: string | null, detailPatternSrc: string | undefined, baseUrl: string,
  nextPageSelector: string | undefined,
  // true면 (1) probeLightweight(순수 HTTP GET, 브라우저 없음) 지름길을 건너뛰고 실제 브라우저로,
  // (2) domcontentloaded+500ms 상한 대신 'load'(실제 스크래핑의 collectFromListing과 동일)까지 기다린다.
  // 걸스굽 cate_no=43 실사용 확인(2026-08-17): 진짜 마지막 페이지는 7인데도 useHttp 캘리브레이션이
  // 통과해(1페이지 개수가 HTTP/브라우저 동일) 이후 모든 probe가 순수 HTTP GET으로만 이뤄졌고, 그 경로가
  // 6페이지부터 실제로는 있는 상품을 계속 "없음"으로 돌려줬다(로그인 브라우저로 직접 열면 정상 노출 —
  // 아마 이 몰이 일반 페이지 내비게이션과 순수 HTTP GET을 다르게 취급하는 것으로 추정). domcontentloaded
  // 대기시간만 늘리는 patient 1차 시도는 이 HTTP 지름길 자체를 안 타서 효과가 없었다. "이 페이지가
  // 끝인 것 같다"는 중요한 결론을 내리기 직전에만 patient=true로 이 지름길을 건너뛰고 한 번 더
  // 확인하므로, 매 probe를 다 브라우저로 돌리는 것보다 비용이 훨씬 적다.
  patient = false,
): Promise<{ count: number; isLoginPage: boolean; fingerprint: string; hrefs: string[]; currentPage: number | null }> {
  if (useHttp && !patient) {
    const lightweight = await probeLightweight(context, withPageParam(firstPageUrl, pageNum), userSel, platformSel, detailPatternSrc, baseUrl, nextPageSelector)
    if (lightweight) return lightweight
  }
  const targetUrl = withPageParam(firstPageUrl, pageNum)
  // 페이지 번호가 **해시**에 실리는 몰(withPageParam 주석 참고)은 해시만 바뀌면 브라우저가 문서를 다시
  // 읽지 않는다(same-document navigation) — 그러면 목록이 그대로라 "2페이지가 1페이지와 같다 → 끝"으로
  // 오판한다. 해시만 다른 이동이면 새로고침해서 그 페이지 상태로 다시 그리게 한다.
  const hashOnlyMove = (() => {
    try {
      const cur = new URL(workerPage.url()); const next = new URL(targetUrl)
      return cur.origin === next.origin && cur.pathname === next.pathname && cur.search === next.search && cur.hash !== next.hash
    } catch { return false }
  })()
  await workerPage.goto(targetUrl, { waitUntil: patient ? 'load' : 'domcontentloaded', timeout: patient ? 30_000 : 15_000 }).catch(() => {})
  if (hashOnlyMove) await workerPage.reload({ waitUntil: 'load', timeout: 30_000 }).catch(() => {})
  await settleAfterNav(workerPage)
  // 목록을 AJAX로 늦게 그리는 몰에서 한 번만 세면 0개/일부만 잡힌다 — 개수가 안정될 때까지 본다
  // (countProductsSettled 주석). 페이지 탐색은 O(log n)번만 돌므로 이 대기 비용은 크지 않다.
  const { count, isLoginPage, fingerprint, hrefs } = await countProductsSettled(workerPage, userSel, platformSel, detailPatternSrc, baseUrl)
  const currentPage = count > 0 ? await readCurrentPageNumber(workerPage, nextPageSelector) : null
  return { count, isLoginPage, fingerprint, hrefs, currentPage }
}

/** URL 쿼리파라미터(`?page=N`)로는 페이지가 안 넘어가는 몰을 위한 마지막 수단 — 사람이 화면에서 실제
 *  페이지네이션 버튼을 찾아 누르듯이, 목표 페이지 번호와 일치하는 클릭 가능한 요소를 찾아 직접 클릭한다.
 *  도매창고 실사용 확인(2026-09-26): 이 몰의 페이지 번호는 `<a href>`가 아니라 `<div class="num"
 *  data-page="2">` 형태라 `readMaxPageNumber` 등 기존 위젯 판독(항상 `a[href]`만 봄, 그 위 주석 참고)
 *  에 전혀 안 걸리고, `withPageParam`으로 URL을 바꿔봐도 실제로는 페이지가 안 넘어간다(AJAX+클릭 전용).
 *  `data-page` 속성은 이런 JS 기반 페이지네이션에서 흔한 관례라 몰 이름을 안 가리고 범용으로 찾는다 —
 *  숫자 버튼뿐 아니라 "다음"류 화살표도 보통 같은 속성을 쓴다(도매창고의 `<div class="gt"
 *  data-page="2">`가 실제 그 예). `data-page` 속성이 없으면 순수 텍스트가 목표 번호와 같은 요소로도
 *  시도한다. 페이지네이션처럼 보이는 영역(`class`/`id`에 "pag" 포함 — "paging"/"pagination"/"pager"를
 *  전부 잡는다) 안에서만 찾아, 상품 개수 배지 등 무관한 숫자를 잘못 누르지 않는다. */
async function clickToPageNumber(page: Page, targetPage: number): Promise<boolean> {
  return page.evaluate((targetPage) => {
    const roots = Array.from(document.querySelectorAll('[class*="pag" i], [id*="pag" i]'))
    for (const root of roots) {
      const candidates = Array.from(root.querySelectorAll('[data-page], a, button, li, span, div')) as HTMLElement[]
      for (const el of candidates) {
        const dataPage = el.getAttribute('data-page')
        const text = (el.textContent || '').trim()
        const matches = (dataPage !== null && Number(dataPage) === targetPage)
          || (!dataPage && /^\d+$/.test(text) && Number(text) === targetPage)
        if (matches) { el.click(); return true }
      }
    }
    return false
  }, targetPage).catch(() => false)
}

/** clickToPageNumber로 넘어간 뒤에도(다른 요소 클릭으로 발생하는 페이지 전환 등) 실제로 새 상품이
 *  나타났는지는 항상 href 집합으로 다시 확인해야 한다 — 이 몰이 진짜로 1페이지뿐인데 클릭이 아무 데나
 *  맞아 우연히 "성공"으로 보일 수 있어서다(클릭 좌표 없이 요소를 직접 element.click()하므로 엉뚱한
 *  곳을 누를 위험 자체는 낮지만, 그래도 결과는 항상 내용으로 재검증한다).
 *
 *  URL 기반 탐색(findRealLastPage 등)이 전부 안 통하는 몰의 마지막 수단 — countCategoryProductsOnce의
 *  "안전한 순차 탐색"(맨 아래 for 루프)과 똑같은 규칙(href 누적 집합, 끝난 것 같으면 한 번 더 재확인,
 *  AUTO_PAGINATION_CAP까지)을 그대로 따르되, `withPageParam`+`page.goto` 대신 clickToPageNumber로
 *  페이지를 넘긴다. */
async function countByClickingThroughPages(
  workerPage: Page, userSel: string | null, platformSel: string | null, detailPatternSrc: string | undefined,
  baseUrl: string, page1Hrefs: string[], stop: () => boolean,
): Promise<{ count: number; truncated: boolean }> {
  const seenHrefs = new Set<string>(page1Hrefs)
  let hitCap = true
  for (let pageNum = 2; pageNum <= AUTO_PAGINATION_CAP; pageNum++) {
    if (stop()) { hitCap = false; break }
    const clicked = await clickToPageNumber(workerPage, pageNum)
    if (!clicked) { hitCap = false; break } // 이 번호로 넘어갈 클릭 대상 자체가 더 없다 — 여기가 끝
    const first = await countProductsSettled(workerPage, userSel, platformSel, detailPatternSrc, baseUrl)
    if (first.isLoginPage) return { count: seenHrefs.size, truncated: false }
    let { count, hrefs } = first
    let newCount = hrefs.filter(h => !seenHrefs.has(h)).length
    if (count === 0 || newCount === 0) {
      // findRealLastPage의 confirmedEnd와 같은 이유 — "끝난 것 같다"고 처음 판단됐을 때만 한 번 더
      // 클릭해(같은 번호를 다시) 재확인한다. 렌더링이 느려 아직 안 그려졌을 수 있어서다.
      await sleep(SETTLE_COUNT_INTERVAL_MS)
      const retry = await countProductsSettled(workerPage, userSel, platformSel, detailPatternSrc, baseUrl)
      if (retry.isLoginPage) return { count: seenHrefs.size, truncated: false }
      count = retry.count; hrefs = retry.hrefs
      newCount = hrefs.filter(h => !seenHrefs.has(h)).length
    }
    if (count === 0 || newCount === 0) { hitCap = false; break }
    hrefs.forEach(h => seenHrefs.add(h))
  }
  return { count: seenHrefs.size, truncated: hitCap }
}

/** 지수+이분 탐색이나 최후수단 순회를 시작하기 전에, 2페이지가 1페이지와 실제로 다른 상품을 보여주는지
 *  딱 한 번만 가볍게 확인한다 — "페이지 번호를 늘리면 다음 상품이 나온다"는, 이후 모든 탐색이 의존하는
 *  전제 자체를 검증하는 것이다. 위젯이 없는 몰(펫투비 등)은 이 파라미터가 애초에 안 통하는 경우가
 *  실사용으로 확인됐는데, 그런데도 요청마다 내용이 살짝 달라져(추정: 추천 위젯 등) 기존의 "반복 감지"
 *  (fingerprint 비교)로는 이 사실을 못 잡고, 지수 탐색이 끝을 못 찾아 헤매다 최후수단(최대 50페이지
 *  실제 브라우저 순회)까지 떨어져 틀린 개수로 확정됐다(2026-08-12 실사용 확인: perPage=114인 카테고리가
 *  count=462로 잘못 확정됨 — "사료" 카테고리가 겪은 것과 같은 유형이지만 "총 N개" 문구가 없어 그
 *  안전장치도 못 썼다). 2페이지에 1페이지와 안 겹치는(=새로운) 상품이 하나도 없으면, 이 카테고리에는
 *  페이지 번호가 아무 효과가 없다고 보고 이후 모든 탐색을 건너뛴다. */
async function paginationActuallyWorks(
  workerPage: Page, context: BrowserContext, firstPageUrl: string, useHttp: boolean, page1Hrefs: string[],
  userSel: string | null, platformSel: string | null, detailPatternSrc: string | undefined, baseUrl: string,
  nextPageSelector: string | undefined,
): Promise<boolean> {
  const page2 = await probeCategoryPage(workerPage, context, firstPageUrl, 2, useHttp, userSel, platformSel, detailPatternSrc, baseUrl, nextPageSelector)
  if (page2.count === 0 || page2.isLoginPage) return false
  const seenOnPage1 = new Set(page1Hrefs)
  return page2.hrefs.some(href => !seenOnPage1.has(href))
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

  // 이 탐색은 페이지를 수십 번 열 수 있어(카테고리가 수백 페이지면 로그(n)번이라도 누적된다) 매번
  // 브라우저 탭으로 실제 렌더링하면 무겁다 — knownNonEmptyPage는 이미 브라우저로 확인된 값이므로, 같은
  // 페이지를 브라우저 탭 없이(순수 HTTP + 쿠키 재사용) 한 번 더 읽어보고 개수가 일치하면 이 몰은 서버
  // 렌더링(HTML에 상품 링크가 그대로 있음)이라고 보고 이후 모든 probe를 가벼운 방식으로 돌린다. 안
  // 맞으면(클라이언트 JS로 그리는 몰 등) useHttp를 false로 두어 기존 브라우저 방식 그대로 간다 — 즉 이
  // 최적화가 안 맞는 몰에서도 지금보다 나빠지지 않는다.
  const context = workerPage.context()
  const calibration = await probeLightweight(context, withPageParam(firstPageUrl, knownNonEmptyPage), userSel, platformSel, detailPatternSrc, baseUrl, nextPageSelector)
  const useHttp = !!calibration && !calibration.isLoginPage && calibration.count === knownNonEmptyCount
  console.log(`[previewCatalog] 지수+이분 탐색: ${useHttp ? '가벼운 HTTP 방식' : '브라우저 방식(캘리브레이션 불일치 또는 실패)'} 사용 (기준 페이지=${knownNonEmptyPage}, 기준 개수=${knownNonEmptyCount}, 확인된 개수=${calibration?.count ?? 'null'})`)

  const probeAt = (pageNum: number, patient = false) => probeCategoryPage(
    workerPage, context, firstPageUrl, pageNum, useHttp, userSel, platformSel, detailPatternSrc, baseUrl, nextPageSelector, patient,
  )
  // "이 페이지가 끝이다"라는 신호(count===0, clamp, 직전 페이지와 fingerprint 중복) 중 하나만 보고 그
  // 자리를 진짜 끝으로 확정하면, 그 한 번의 요청이 일시적 오류/빈 응답/캐시된 이전 페이지 내용이었을 때
  // 탐색이 통째로 잘못된 답으로 끝난다 — 처음엔 count===0 신호만 재확인했는데(실사용 확인: 진짜양말 —
  // 실제로는 240개씩 꽉 찬 페이지가 더 있었는데 훨씬 앞에서 멈춰 1646개짜리 카테고리가 1200개로 잘못
  // 확정됨, 2026-08-13), clamp/fingerprint-중복 신호도 똑같이 일시적일 수 있다는 게 나중에 확인됐다
  // (걸스굽 실사용 확인, 2026-08-17 — 진짜 마지막 페이지가 7인데 5에서 멈춰 카테고리 개수가 실제보다
  // 적게(240 vs 300여개) 나옴). 세 신호 전부, 같은 페이지를 한 번 더 확인해 두 번 다 "끝"으로 보여야만
  // 진짜 끝으로 믿는다. 이 재확인은 같은 페이지를 patient=true로 다시 연다 — 처음 확인과 똑같이 빠른
  // 대기로 재확인하면, 이 몰처럼 렌더링이 느려서(빠른 대기로는 못 잡는 시점에) 매번 똑같이 "끝"으로
  // 잘못 보이는 경우 재확인조차 같은 오탐을 반복할 뿐이다(2026-08-17 걸스굽 재현 — 이 이중확인을
  // 추가한 뒤에도 여전히 5에서 멈춤).
  // clamp는 요청한 페이지가 범위를 벗어나 몰이 유효한 페이지로 되돌려준 경우만 뜻한다 — 항상 요청한
  // 페이지보다 작은 번호로 되돌아가야 정상이다. currentPage가 요청보다 큰 경우는 실제 clamp가 아니라
  // 이 currentPage 판독 자체가 잘못된 것이다(걸스굽 cate_no=43 실사용 확인, 2026-08-17 — 마지막
  // 페이지 블록에서 "마지막 페이지로" 이동 링크의 목표 번호(7)를 현재 페이지로 잘못 집어, 6페이지의
  // 진짜 새 상품 48개를 매번 "clamp됨"으로 오판해 실제 마지막 페이지(7)보다 앞(5)에서 멈췄다). 그래서
  // 작은 쪽으로 벗어난 경우만 clamp로 인정한다.
  async function confirmedEnd(pageNum: number, dupFingerprint: string): Promise<boolean> {
    const r = await probeAt(pageNum, true)
    const clamped = r.currentPage !== null && r.currentPage < pageNum
    return r.count === 0 || clamped || r.fingerprint === dupFingerprint
  }

  while (hi === null) {
    if (stop()) return { page: lo, count: loCount }
    const probe = lo + step
    if (probe > bound) return null
    const r = await probeAt(probe)
    if (r.isLoginPage) return { page: lo, count: loCount, needsLogin: true }
    const clamped = r.currentPage !== null && r.currentPage < probe
    const looksLikeEnd = r.count === 0 || clamped || r.fingerprint === loFingerprint
    if (looksLikeEnd && await confirmedEnd(probe, loFingerprint)) { hi = probe; continue }
    if (stop()) return { page: lo, count: loCount }
    const next = await probeAt(probe + 1)
    if (next.isLoginPage) return { page: lo, count: loCount, needsLogin: true }
    if (next.count > 0 && next.fingerprint === r.fingerprint) { hi = probe; continue }
    lo = probe; loCount = r.count; loFingerprint = r.fingerprint; step *= 2
  }
  while (hi - lo > 1) {
    if (stop()) return { page: lo, count: loCount }
    const mid = Math.floor((lo + hi) / 2)
    const r = await probeAt(mid)
    if (r.isLoginPage) return { page: lo, count: loCount, needsLogin: true }
    const clamped = r.currentPage !== null && r.currentPage < mid
    const looksLikeEnd = r.count === 0 || clamped || r.fingerprint === loFingerprint
    if (looksLikeEnd && await confirmedEnd(mid, loFingerprint)) hi = mid
    else { lo = mid; loCount = r.count; loFingerprint = r.fingerprint }
  }
  return { page: lo, count: loCount }
}

/** 목록 페이지에 몰이 직접 적어둔 "총 N개"/"전체 N건" 같은 문구를 읽는다 — 있으면 페이지를 추측하거나
 *  여러 장 열어볼 필요 없이 그 자체가 정답이라, 위젯 판독·지수+이분 탐색·직접 순회를 통째로 건너뛸 수
 *  있다. 실사용 확인(펫투비, 2026-08-11): 실제로는 21개짜리 카테고리("사료(옵션상품수 포함) 총 21개의
 *  상품이 준비되어 있습니다")를 지수+이분 탐색이 최대 16,363개까지 잘못 부풀렸던 사고 — 원인은
 *  ?page=N이 이 몰에선 실제 페이지 전환을 전혀 안 시키는데(직접 로그인해 느린 속도로 재현·확인)도 매번
 *  조금씩 다른 내용(상품카드 오버레이 등)을 돌려줘 탐색이 "새 페이지"로 계속 오판한 것이었다.
 *  document.body 전체를 무작정 훑으면 이 카테고리와 무관한 배지 숫자를 잘못 집을 위험이 있다(과거
 *  readListedTotalCount가 실제로 이 문제로 제거됐다 — scrape-preview-catalog-count-and-target-ui.md
 *  버그 1 참고) — 찾은 문장 주변에 이 카테고리 라벨의 마지막 구간(예: "강아지 > 사료"의 "사료")이 같이
 *  나오는지로 한 번 검증해, 무관한 사이트 전체 통계 배지를 걸러낸다.
 *
 *  이 라벨 근접 검증이 못 잡는 경우가 있다(도매창고 실사용 확인, 2026-09-26 — "MD추천" 356개짜리
 *  카테고리가 27개로 잘못 나옴): 이 몰은 "총 N개의 상품" 문구가 검색필터 패널 안에 있고 카테고리 이름은
 *  페이지 다른 곳(제목)에만 있어, 문구 30자 근처에 카테고리 라벨이 전혀 안 나온다. 그래서 텍스트
 *  근접성이 없어도, 그 숫자를 담은 엘리먼트 자신의 id/class가 "이 목록의 총 개수 배지"임을 스스로
 *  드러내면(`id="goods_list_total"`처럼 total/count와 goods/product/item/list가 같이 들어있음) 그것도
 *  신뢰할 근거로 인정한다 — 사이트 전체 통계 배지는 보통 이런 식으로 목록 전용 id를 안 쓴다. */
async function readStatedTotalCount(page: Page, categoryLabel: string): Promise<number | null> {
  const leafLabel = categoryLabel.split(' > ').pop()?.trim()
  if (!leafLabel) return null
  return page.evaluate(({ leafLabel }) => {
    const text = document.body.innerText
    const re = /(총|전체)\s*([\d,]+)\s*(개|건)/g
    let m: RegExpExecArray | null
    while ((m = re.exec(text))) {
      const contextStart = Math.max(0, m.index - 30)
      if (text.slice(contextStart, m.index + m[0].length).includes(leafLabel)) {
        const n = Number(m[2].replace(/,/g, ''))
        if (Number.isInteger(n) && n > 0 && n < 1_000_000) return n
      }
    }
    // 도매창고 실사용 확인(2026-09-26): 같은 페이지에 "total_goodscd"(선택한 상품 코드 담기 개수, 평소
    // 0)처럼 id/class는 같은 패턴에 걸리지만 이 목록과 무관한 숫자 배지가 먼저 나올 수 있다 — 0은 진짜
    // 총 개수일 리 없으니(빈 카테고리는 이미 위에서 perPage===0으로 걸러짐) 값 자체가 0보다 큰 첫 후보를
    // 찾을 때까지 계속 본다(첫 매칭에서 멈추지 않음).
    for (const el of Array.from(document.querySelectorAll('[id], [class]'))) {
      const idcls = `${el.id} ${el.className}`
      if (!/total|count/i.test(idcls) || !/goods|product|item|list/i.test(idcls)) continue
      const raw = (el.textContent || '').trim()
      if (!/^[\d,]+$/.test(raw)) continue
      const n = Number(raw.replace(/,/g, ''))
      if (Number.isInteger(n) && n > 0 && n < 1_000_000) return n
    }
    return null
  }, { leafLabel }).catch(() => null)
}

/** readStatedTotalCount의 재시도판 — 총 개수를 AJAX로 나중에 채우는 몰(도매창고 실사용 확인,
 *  2026-09-26)은 page.goto 직후엔 아직 "총 0개"처럼 자리표시자만 있어 첫 시도가 null을 반환한다.
 *  readMaxPageWithRetry(위)와 같은 이유로, 실패했을 때만 숫자가 채워지길 짧게 한 번 더 기다렸다
 *  재시도한다 — 이미 채워져 있는 대다수 몰은 첫 시도에서 바로 성공해 이 대기를 전혀 안 거친다. */
async function readStatedTotalCountWithRetry(page: Page, categoryLabel: string): Promise<number | null> {
  const first = await readStatedTotalCount(page, categoryLabel)
  if (first !== null) return first
  await page.waitForFunction(
    () => /(총|전체)\s*[1-9][\d,]*\s*(개|건)/.test(document.body.innerText),
    undefined, { timeout: 3_000 },
  ).catch(() => {})
  return readStatedTotalCount(page, categoryLabel)
}

async function countCategoryProductsOnce(
  workerPage: Page, categoryUrl: string,
  userSel: string | null, platformSel: string | null, detailPatternSrc: string | undefined,
  nextPageSelector: string | undefined, baseUrl: string, stop: () => boolean, knownNoPaginationWidget: boolean,
): Promise<CategoryCount> {
  // 개수만 세려고 <a> 태그만 보면 되니 'load'(이미지·광고·채팅위젯까지 다 받을 때까지 대기)가 아니라
  // 'domcontentloaded'로 충분하다 — 상품 이미지가 많은 목록 페이지에서 이 차이가 페이지 방문 하나당
  // 꽤 크다(지수+이분 탐색이 페이지를 수십 번 열 수 있어 누적되면 전체 속도에 영향이 크다).
  const firstPageUrl = resetToFirstPage(categoryUrl)
  await workerPage.goto(firstPageUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {})
  await settleAfterNav(workerPage)
  const { category } = await detectCategoryLabel(workerPage)
  const label = category || categoryUrl

  const { count: perPage, isLoginPage: perPageIsLogin, fingerprint: perPageFingerprint, hrefs: page1Hrefs } = await countProductsOnPage(workerPage, userSel, platformSel, detailPatternSrc, baseUrl)
  // 1페이지 자체가 로그인 화면이면(이 새 탭이 이 몰의 세션 검증에 걸려 튕겨나간 경우) 뒤 어떤 값도
  // 못 믿는다 — 개수를 0으로 잘못 확정하는 대신 needsLogin만 알리고 즉시 끝낸다(호출부가 "로그인이
  // 끊겼을 수 있다"는 배너를 보여줄 근거가 된다).
  if (perPageIsLogin) return { url: categoryUrl, label, count: 0, needsLogin: true }
  if (perPage === 0 || stop()) return { url: categoryUrl, label, count: perPage }

  // 0순위: 몰이 직접 적어둔 "총 N개" 문구가 있으면 그게 정답이다 — 위젯 판독이나 페이지를 더 열어보는
  // 어떤 방식보다 빠르고 정확하다. readStatedTotalCount 자체가 이미 카테고리 라벨 근접 검증으로
  // 오탐을 걸러내므로, 여기서 "1페이지 개수(perPage)보다 작으면 안 믿는다"는 추가 조건은 걸지 않는다
  // — perPage 자체가 상품 카드 중복 링크 등으로 부풀려진 경우(실사용 확인: 펫투비, 진짜 21개인데
  // perPage가 31~32로 잡힘) 정답인 statedTotal이 오히려 perPage보다 작아 그 조건에 걸려 버려진다.
  const statedTotal = await readStatedTotalCountWithRetry(workerPage, label)
  if (statedTotal !== null) {
    console.log(`[previewCatalog] "${label}" 페이지에 적힌 "총 ${statedTotal}개" 문구를 그대로 사용 → count=${statedTotal}`)
    return { url: categoryUrl, label, count: statedTotal }
  }

  // 1순위: "마지막 페이지로" 버튼 href에서 직접 읽는다 — 텍스트를 세는 readMaxPageNumber보다 훨씬
  // 신뢰도가 높다(범위 밖 page로 clamp돼도 이 버튼은 항상 진짜 마지막 페이지를 가리킴, 위 함수 설명
  // 참고). 이게 있으면 아래 "maxPage+1 확인 → 그래도 못 믿으면 지수+이분 탐색" 안전장치가 거의 항상
  // 즉시(afterLastCount===0으로) 끝나 실질적으로 탐색 자체가 필요 없어진다. 이 버튼이 없는 스킨이면
  // null이 나와 기존 readMaxPageNumber로 자동 폴백한다. "몰 구조분석"이 이미 이 몰엔 위젯이 아예
  // 없다고 확인해뒀으면(knownNoPaginationWidget), 카테고리마다 이 확인을 반복해도 항상 null만 나올 뿐이라
  // 곧장 건너뛴다(펫투비 등에서 실사용 확인, 2026-08-11).
  // 위 goto는 domcontentloaded + settleAfterNav(networkidle 500ms 상한)로 일부러 짧게 대기한다(속도
  // 우선) — 그런데 이 몰(걸스굽)은 그 시점에 위젯이 아직 안 그려져 있을 때가 있어(같은 요청을 반복
  // 재현해보니 위젯이 있다/없다 오락가락함, 실사용 확인 2026-08-17) "위젯 없음"으로 잘못 판단해 아래
  // 지수+이분 탐색으로 떨어지고, 그 탐색이 실제 마지막 페이지(7)보다 앞(5)에서 잘못 멈춰 카테고리 개수가
  // 실제보다 적게(240 vs 300여개) 나온 사례가 있었다. 첫 시도에서 위젯을 못 찾았을 때만(=여기서 막
  // 새 카테고리로 이동한 직후 1회) 위젯이 나타나길 짧게 한 번 더 기다렸다 재시도한다 — 이후 탐색/순회의
  // 반복 페이지 방문에는 이 여유를 안 줘 전체 속도에는 영향이 없다.
  async function readMaxPageWithRetry(): Promise<number | null> {
    const first = (await readLastPageFromNavButton(workerPage)) ?? (await readMaxPageNumber(workerPage, nextPageSelector))
    if (first !== null) return first
    await workerPage.waitForSelector('[class*="paging" i], [class*="pagination" i]', { timeout: 1_500 }).catch(() => {})
    return (await readLastPageFromNavButton(workerPage)) ?? (await readMaxPageNumber(workerPage, nextPageSelector))
  }
  const maxPage = knownNoPaginationWidget ? null : await readMaxPageWithRetry()
  // maxPage가 정말로(위젯을 읽어서) 1 이하로 확인된 경우만 곧바로 믿는다 — 위젯을 아예 못 찾은 경우
  // (maxPage===null)는 "1페이지짜리 카테고리"인지 "위젯 클래스명이 특이해서 못 읽은 대형 카테고리"인지
  // 구분이 안 되므로, 곧장 믿지 않고 아래 maxPage!==null 블록을 건너뛰어 이 함수 뒤쪽의 지수+이분 탐색
  // (원래 "maxPage를 읽었지만 못 믿는 경우"를 위해 있던 것)을 그대로 재사용한다 — 예전엔 여기서 perPage를
  // 그대로 총합으로 확정해버려, 위젯이 안 잡히는 스킨에서 실제보다 적게 세는 문제가 있었다.
  if (maxPage !== null && maxPage <= 1) {
    console.log(`[previewCatalog] "${label}" perPage=${perPage} maxPage=${maxPage} → count=${perPage} url=${firstPageUrl}`)
    return { url: categoryUrl, label, count: perPage }
  }

  // 마지막 페이지·마지막+1 페이지 확인은 라벨이 필요 없어(위에서 1페이지 방문 때 이미 얻음) 굳이 실제
  // 브라우저 탭으로 이동할 필요가 없다 — 1페이지를 브라우저 탭 없이(순수 HTTP + 쿠키 재사용) 한 번 더
  // 읽어보고 개수가 일치하면(서버가 HTML에 상품 링크를 그대로 내려주는 몰) 이후 두 확인은 가벼운 방식으로
  // 돌린다. 카테고리가 많은 몰에서 미리보기가 오래 걸리는 주된 원인이 카테고리마다 이 확인 2회씩 실제
  // 브라우저 탐색을 도는 것이었다(실사용 확인, 2026-08-11) — findRealLastPage의 지수+이분 탐색엔 이미
  // 같은 최적화가 있었는데, 그 탐색까지 가지 않는 흔한 경우(위젯이 maxPage를 정확히 보여주는 몰)엔 안
  // 쓰이고 있었다.
  const context = workerPage.context()
  const calibration = await probeLightweight(context, firstPageUrl, userSel, platformSel, detailPatternSrc, baseUrl, nextPageSelector)
  const useHttp = !!calibration && !calibration.isLoginPage && calibration.count === perPage
  console.log(`[previewCatalog] "${label}" 캘리브레이션: ${useHttp ? '가벼운 HTTP 방식 사용' : '브라우저 방식(불일치 또는 실패)'} (1페이지 브라우저=${perPage}, HTTP=${calibration?.count ?? 'null'})`)

  // 위젯을 못 찾은 카테고리(maxPage===null)만 지수+이분 탐색·최후수단 순회로 넘어가는데, 그 전에
  // 이 몰의 페이지 번호 자체가 유효한지부터 확인한다(paginationActuallyWorks 주석 참고) — 안 통하면
  // 곧바로 1페이지 개수를 확정하고 아래의 모든 탐색을 건너뛴다.
  if (maxPage === null && !stop()) {
    const works = await paginationActuallyWorks(workerPage, context, firstPageUrl, useHttp, page1Hrefs, userSel, platformSel, detailPatternSrc, baseUrl, nextPageSelector)
    if (!works) {
      // URL 쿼리파라미터로는 안 통했지만, 그렇다고 이 카테고리가 진짜 1페이지짜리라고 단정하면 안 된다 —
      // 클릭+AJAX 전용 페이지네이션(도매창고 실사용 확인, 2026-09-26 — `<div data-page="2">`, URL은
      // 절대 안 바뀜)일 수 있다. 사람이 화면에서 실제 버튼을 찾아 누르듯이 한 번 더 확인한다
      // (countByClickingThroughPages 주석 참고) — 이 함수 자체가 첫 시도(2페이지 클릭)에서 새 상품이
      // 하나도 없으면 곧바로 멈추고 원래 perPage와 같은 값을 돌려주므로, 별도의 "되나 안 되나" 사전
      // 확인 없이 곧장 맡겨도 안전하다. paginationActuallyWorks의 probeCategoryPage가 workerPage를 이미
      // page=2 URL(안 통했으므로 실제로는 그대로인 1페이지)로 옮겨놨을 수 있으니, 클릭 대상을 찾으려면
      // 먼저 1페이지로 돌아가야 한다.
      await workerPage.goto(firstPageUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 }).catch(() => {})
      await settleAfterNav(workerPage)
      const { count, truncated } = await countByClickingThroughPages(workerPage, userSel, platformSel, detailPatternSrc, baseUrl, page1Hrefs, stop)
      if (count <= perPage) {
        console.log(`[previewCatalog] "${label}" 2페이지가 1페이지와 다른 상품을 보여주지 않음(URL·클릭 모두 확인) → 페이지 번호가 안 통하는 카테고리로 보고 count=${perPage}로 확정`)
        return { url: categoryUrl, label, count: perPage }
      }
      console.log(`[previewCatalog] "${label}" URL 파라미터로는 안 통했지만 화면의 실제 페이지 버튼 클릭으로는 넘어감 → 클릭 기반 순회 count=${count}${truncated ? ` (상한 ${AUTO_PAGINATION_CAP}페이지까지만 확인 — 더 있을 수 있음)` : ''}`)
      return { url: categoryUrl, label, count, truncated }
    }
  }

  if (maxPage !== null) {
    const { count: lastPageCount, isLoginPage: lastPageIsLogin, fingerprint: lastPageFingerprint } =
      await probeCategoryPage(workerPage, context, firstPageUrl, maxPage, useHttp, userSel, platformSel, detailPatternSrc, baseUrl, nextPageSelector)
    // 여기서부터는 최소한 1페이지(perPage)는 로그인 상태에서 확인한 값이므로, 그걸 최선의 추정치로 두고
    // needsLogin만 같이 알린다 — 0으로 깎아내리지 않는다.
    if (lastPageIsLogin) return { url: categoryUrl, label, count: perPage, needsLogin: true }
    // maxPage가 "실제 마지막 페이지"가 아니라 페이지네이션 위젯이 한 번에 보여주는 번호 묶음의 끝일 수 있다
    // (예: 카페24 기본 스킨은 1~5만 링크로 노출하고 다음 묶음은 화살표로만 이동 — 실사용 확인: 여러 카테고리가
    // 전부 같은 maxPage=5·lastPageCount=48(꽉 참)로 읽혀 진짜 총 개수보다 훨씬 적은 값에서 멈춘 사례 발견).
    // 그래서 "마지막"이라고 읽은 페이지 바로 다음 페이지도 비어있는지 한 번 더 확인해야 안심할 수 있다.
    if (lastPageCount > 0 && !stop()) {
      const { count: afterLastCount, isLoginPage: afterLastIsLogin, fingerprint: afterLastFingerprint, currentPage: afterLastCurrentPage } =
        await probeCategoryPage(workerPage, context, firstPageUrl, maxPage + 1, useHttp, userSel, platformSel, detailPatternSrc, baseUrl, nextPageSelector)
      if (afterLastIsLogin) return { url: categoryUrl, label, count: perPage * (maxPage - 1) + lastPageCount, needsLogin: true }
      // count>0이어도 위젯이 스스로 "지금 페이지"를 maxPage로 보고하면(요청은 maxPage+1인데) 범위를
      // 벗어난 page 요청을 몰이 마지막 유효 페이지로 그대로 되돌려준 것이다(2026-08-09 seasonbag.co.kr
      // 실사용 재현 — 상품 목록 내용은 매번 조금씩 달라 fingerprint만으론 못 잡았지만, 위젯은 항상 같은
      // "지금 14페이지"를 보고했다). 위젯을 못 읽는 스킨이면(currentPage===null) fingerprint 일치
      // 여부로 대신 판단한다(기존 방식). 어느 쪽이든 진짜 빈 페이지와 똑같이 취급해 여기서 확정한다 —
      // 안 그러면 아래 findRealLastPage가 "새 페이지"로 착각한 채 끝을 못 찾고 페이지 번호만 계속
      // 올리며 헤맨다.
      // "클램프"는 요청한 페이지가 범위를 벗어나 몰이 유효한 페이지로 되돌려준 경우만 뜻한다 — 항상
      // 요청한 페이지보다 작은 번호로 되돌아가야 정상이다(범위 밖 요청을 미래의 더 큰 페이지로 보내주는
      // 몰은 없다). currentPage가 요청보다 큰 경우는 "클램프"가 아니라 이 currentPage 판독 자체가
      // 잘못된 것이다(걸스굽 실사용 확인, 2026-08-17 — 마지막 블록에 있는 "마지막 페이지" 이동 링크의
      // 목표 번호를 현재 페이지로 잘못 집어, 6페이지의 진짜 새 상품 48개를 "클램프됨"으로 오판해 실제
      // 마지막 페이지(7)보다 앞에서 멈춤). 그래서 작은 쪽으로만 비교한다.
      const afterLastClamped = afterLastCurrentPage !== null && afterLastCurrentPage < maxPage + 1
      if (afterLastCount === 0 || afterLastClamped || afterLastFingerprint === lastPageFingerprint) {
        const count = perPage * (maxPage - 1) + lastPageCount
        console.log(`[previewCatalog] "${label}" perPage=${perPage} maxPage=${maxPage} lastPageCount=${lastPageCount} → count=${count} url=${firstPageUrl} lastPageUrl=${withPageParam(firstPageUrl, maxPage)}`)
        return { url: categoryUrl, label, count }
      }
      console.log(`[previewCatalog] "${label}" maxPage=${maxPage}이 위젯 페이지 묶음의 끝일 뿐(page ${maxPage + 1}에도 ${afterLastCount}개 더 있음) → 실제 마지막 페이지 빠르게 탐색`)
      const found = await findRealLastPage(
        workerPage, firstPageUrl, MAX_PAGE_SEARCH_BOUND, maxPage + 1, afterLastCount, afterLastFingerprint,
        userSel, platformSel, detailPatternSrc, baseUrl, nextPageSelector, stop,
      )
      if (found) {
        const count = perPage * (found.page - 1) + found.count
        if (found.needsLogin) return { url: categoryUrl, label, count, needsLogin: true }
        // AUTO_PAGINATION_CAP 끝에서 멈춘 것이면 "여기까지만 확인했다"는 뜻 — 총 개수로 단정하지 않는다.
        // 실제 스크랩(collectProductUrls)도 같은 상한을 쓰므로, 여기서 truncated가 나오는 카테고리는
        // 실제 스크랩도 어차피 다 못 채우는 극단적으로 큰 카테고리뿐이다.
        const budgetHit = found.page >= AUTO_PAGINATION_CAP
        console.log(`[previewCatalog] "${label}" perPage=${perPage} 실제 마지막 페이지=${found.page} lastPageCount=${found.count} → count=${count}${budgetHit ? ` (상한 ${AUTO_PAGINATION_CAP}페이지까지만 확인 — 더 있을 수 있음)` : ''}`)
        return { url: categoryUrl, label, count, truncated: budgetHit }
      }
      console.log(`[previewCatalog] "${label}" 실제 마지막 페이지를 못 찾음(${MAX_PAGE_SEARCH_BOUND}페이지 이내) → 안전한 순차 탐색으로 폴백`)
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
    workerPage, firstPageUrl, MAX_PAGE_SEARCH_BOUND, 1, perPage, perPageFingerprint,
    userSel, platformSel, detailPatternSrc, baseUrl, nextPageSelector, stop,
  )
  if (fallbackFound) {
    const count = perPage * (fallbackFound.page - 1) + fallbackFound.count
    if (fallbackFound.needsLogin) return { url: categoryUrl, label, count, needsLogin: true }
    const fallbackBudgetHit = fallbackFound.page >= AUTO_PAGINATION_CAP
    console.log(`[previewCatalog] "${label}" perPage=${perPage} maxPage=${maxPage}(불신) → 실제 마지막 페이지=${fallbackFound.page} → count=${count}${fallbackBudgetHit ? ` (상한 ${AUTO_PAGINATION_CAP}페이지까지만 확인 — 더 있을 수 있음)` : ''} url=${firstPageUrl}`)
    return { url: categoryUrl, label, count, truncated: fallbackBudgetHit }
  }

  // 그래도 못 찾으면(탐색 상한을 넘김) 최후 수단으로 안전하게 한 페이지씩 순회한다(정확한 개수
  // 보장이 최우선). 위 캘리브레이션(useHttp)이 이 몰에 맞으면 여기도 브라우저 탭 없이 가벼운 HTTP로
  // 순회한다 — 지수+이분 탐색 자체가 끝을 못 찾을 만큼 위젯 신호가 아예 없는 몰(예: 페이지네이션 위젯을
  // 이 코드가 인식하는 어떤 형태로도 못 찾는 고도몰 스킨)일수록 이 최후 수단으로 떨어질 확률이 높은데,
  // 예전엔 여기만 캘리브레이션과 무관하게 항상 브라우저로 돌아 카테고리 하나에 페이지 수십 개를 실제
  // 탐색하며 몰 응답이 느리면 페이지당 최대 15초까지 허비했다(실사용 확인: pettob.co.kr 미리보기가
  // 카테고리 몇 개만에 30분 넘게 걸림, 2026-08-11).
  // href(상품 고유 식별자) 누적 집합으로 개수를 센다 — 이전엔 "바로 앞 페이지와 원문 fingerprint가
  // 같은지"만 봤는데, 위젯이 없는 몰은 페이지 번호가 실제로는 안 통하는데도 추천 위젯 등 때문에 매번
  // 원문이 살짝 달라 보여(paginationActuallyWorks 주석의 "여성화"류 사례와 같은 원인) 이 검사를 속아
  // 넘어갈 수 있다 — href 집합 기준이면 원문이 달라 보여도 "이 페이지가 실제로 새 상품을 보여줬는가"만
  // 정확히 판정되고, 페이지 간 상품이 일부 겹쳐도(운영 중 순서가 바뀌는 등) 중복 없이 정확한 개수가
  // 나온다(paginationActuallyWorks가 이미 같은 방식으로 검증됨).
  const seenHrefs = new Set<string>(page1Hrefs)
  let hitCap = true
  // 이 순차 순회는 "정확한 개수 보장"이 목적이라 AUTO_PAGINATION_CAP(1000페이지)까지 돈다 — 미리보기도
  // 실제 스크랩과 같은 상한까지 그대로 순회해 "N개 이상"을 최대한 피한다(사용자 지시, 2026-09-17).
  for (let pageNum = 2; pageNum <= AUTO_PAGINATION_CAP; pageNum++) {
    if (stop()) { hitCap = false; break }
    const probed = await probeCategoryPage(workerPage, context, firstPageUrl, pageNum, useHttp, userSel, platformSel, detailPatternSrc, baseUrl, nextPageSelector)
    const { isLoginPage } = probed
    let { count, hrefs } = probed
    if (isLoginPage) return { url: categoryUrl, label, count: seenHrefs.size, needsLogin: true }
    let newCount = hrefs.filter(h => !seenHrefs.has(h)).length
    // findRealLastPage의 confirmedEnd와 같은 이유(렌더링이 느린 몰은 빠른 대기로 매번 같은 빈 페이지로
    // 오탐할 수 있음) — "끝난 것 같다"고 처음 판단됐을 때만 patient=true로 한 번 더 열어 재확인한다.
    if (count === 0 || newCount === 0) {
      const retry = await probeCategoryPage(workerPage, context, firstPageUrl, pageNum, useHttp, userSel, platformSel, detailPatternSrc, baseUrl, nextPageSelector, true)
      if (retry.isLoginPage) return { url: categoryUrl, label, count: seenHrefs.size, needsLogin: true }
      count = retry.count; hrefs = retry.hrefs
      newCount = hrefs.filter(h => !seenHrefs.has(h)).length
    }
    if (count === 0 || newCount === 0) { hitCap = false; break } // 재확인까지 같았다 — 실제로 끝난 것
    hrefs.forEach(h => seenHrefs.add(h))
  }
  const total = seenHrefs.size
  // hitCap이 true라는 건 루프가 "끝을 찾아서" 멈춘 게 아니라 AUTO_PAGINATION_CAP까지 다 돌고도 매 페이지
  // 새 상품이 계속 나왔다는 뜻이다 — 이 카테고리가 진짜로 이 상한보다 크다는 신호이지 개수가 정확히
  // total이라는 보장이 아니다(실사용 확인, 2026-08-16: 걸스굽 "SOLD OUT"/"여성화"가 정확히
  // 상한(50페이지×48개=2400)에서 멈췄는데 그 값을 그대로 보여줘 사용자가 실제 개수와 안 맞다고 지적함 —
  // 몰 응답 속도상 상한 없이 끝까지 세는 건 previewCatalog 취지(빠른 확인)에 안 맞아, 대신 "이 값은
  // 최소치다"를 같이 알려 UI가 "2,400개 이상"처럼 정직하게 표시하게 한다).
  console.log(`[previewCatalog] "${label}" perPage=${perPage} maxPage=${maxPage}(불신, 탐색도 실패) → 직접 순회 count=${total}${hitCap ? `(상한 도달, 실제로는 더 많을 수 있음)` : ''} url=${firstPageUrl}`)
  return { url: categoryUrl, label, count: total, truncated: hitCap }
}

/** 위 settleAfterNav로 대부분 막히지만, 그래도 남는 드문 레이스는 카테고리 하나의 개수 계산 전체를
 *  실패시킨다 — 예전엔 그 실패(Execution context was destroyed 등)가 Promise.all을 타고 미리보기 전체를
 *  깨뜨려 사용자가 "확인 실패" 알림을 수동으로 닫고 처음부터 다시 눌러야 했다. 한 카테고리 실패가 나머지
 *  카테고리까지 막지 않도록, 이 카테고리만 한 번 더 조용히 재시도한다(사용자 개입 없이 자동 처리). */
async function countCategoryProducts(
  workerPage: Page, categoryUrl: string,
  userSel: string | null, platformSel: string | null, detailPatternSrc: string | undefined,
  nextPageSelector: string | undefined, baseUrl: string, stop: () => boolean, knownNoPaginationWidget: boolean,
): Promise<CategoryCount> {
  if (stop()) return { url: categoryUrl, label: categoryUrl, count: 0 }
  try {
    return await countCategoryProductsOnce(workerPage, categoryUrl, userSel, platformSel, detailPatternSrc, nextPageSelector, baseUrl, stop, knownNoPaginationWidget)
  } catch (err) {
    if (stop()) return { url: categoryUrl, label: categoryUrl, count: 0 }
    console.log(`[previewCatalog] "${categoryUrl}" 개수 계산 중 오류(재시도) — ${err instanceof Error ? err.message : err}`)
    try {
      return await countCategoryProductsOnce(workerPage, categoryUrl, userSel, platformSel, detailPatternSrc, nextPageSelector, baseUrl, stop, knownNoPaginationWidget)
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
        // 표본이 "목록 페이지 자신"이면 상품이 아니다 — 느슨한 폴백 셀렉터(<a><img>)가 로고/배너 링크를
        // 상품으로 주워오면 이런 일이 생긴다. 실사용 확인(2026-09-13, 투비즈온): 카테고리 목록 첫 줄에
        // 몰 홈 URL이 잘못 들어가 있던 상태에서 미리보기를 돌리니 **몰 홈페이지 자체가 상품 1건으로**
        // 나왔다(상품명=몰 타이틀, 공급가 ₩2,640). 목록 URL과 같은 페이지는 후보에서 뺀다.
        const sampleCandidates = bootstrap.urls.filter(u => !isSamePageUrl(u, listingUrls[0]))
        if (bootstrap.urls.length && !sampleCandidates.length) {
          console.log(`[미리보기:진단] 목록(${listingUrls[0]})에서 찾은 상품 링크가 목록 페이지 자신뿐이라 표본으로 쓰지 않음`)
        }
        let firstUrl = sampleCandidates[0]
        // 표본을 어디서·어떤 정렬로 뽑았는지 추적한다(CatalogPreviewResult.previewSource 주석 참고).
        let sampleListingUrl = listingUrls[0]
        let sampleSwitchedReason: string | undefined
        let sampleSortClick = bootstrap.sortClick
        let categoryByUrl = bootstrap.categoryByUrl
        let needsLogin = bootstrap.needsLogin
        if (stop()) return supersededResult()

        const profile = PLATFORM_PROFILES[platform]
        const userSel = opts.productLinkSelector || null
        const platformSel = profile.productLinkSelector
        // 플랫폼 프로필에 패턴이 없으면(unknown 몰) 이 몰에서 학습해둔 패턴을 쓴다.
        const detailPatternSrc = profile.detailUrlPattern?.source ?? opts.detailUrlPattern
        const nextPageSelector = opts.nextPageSelector || profile.nextPageSelector || undefined
        const baseUrl = new URL(listingUrls[0]).origin

        async function extractPreview(url: string): Promise<{ preview: ScrapeResult; needsLoginHere: boolean }> {
          await scratchPage.goto(url, { waitUntil: 'load', timeout: 30_000 })
          const needsLoginHere = await loginIfNeeded(scratchPage, { url, ...opts })
          if (opts.loginId && scratchPage.url() !== url) {
            await scratchPage.goto(url, { waitUntil: 'load', timeout: 30_000 }).catch(() => {})
          }
          await waitForExtractableContent(scratchPage)
          const product = await extractProductRuleBased(scratchPage, url, selectorOverrides(opts), opts.extractionRules)
          const domOptions = await extractOptionsFromDom(scratchPage)
          if (domOptions.options.length) product.options = domOptions.options
          if (domOptions.combinations.length) product.option_combinations = domOptions.combinations
          await applyStockByOption(scratchPage, product)
          applyCategoryOverride(product, categoryByUrl.get(url), opts.extractionRules)
          // AI모드는 외부 API 호출 + DB에 extraction_rules를 저장하는 비용 있는 단계라, 이미 밀려난
          // 실행이면 굳이 돌리지 않는다(리뷰에서 지적된 가장 비싼 낭비 지점).
          if (opts.aiMode && opts.siteId && !stop()) {
            const ai = await applyAiModeRules(scratchPage, opts.siteId, url, opts, domOptions)
            if (ai) {
              applyCategoryOverride(ai.product, categoryByUrl.get(url), ai.rules)
              return { preview: { sourceUrl: url, product: ai.product }, needsLoginHere }
            }
          }
          return { preview: { sourceUrl: url, product }, needsLoginHere }
        }

        // 카테고리 개수 집계는 카테고리가 많은/큰 몰에서 몇 분씩 걸릴 수 있다 — 그동안 화면에 아무것도 안
        // 보이는 대신 상품 1건이라도 먼저 보여달라는 요청(2026-08-14)에 따라, 부트스트랩이 이미 상품을
        // 찾았으면(firstUrl) 개수 집계보다 먼저 이 상품부터 추출해 runEntry.earlyPreview에 남긴다 —
        // getPreviewProgress를 폴링하는 화면이 개수 집계가 끝나기 전에 먼저 가져가 보여줄 수 있다. 다만
        // 부트스트랩이 고른 카테고리(0번)가 하필 비어있으면(firstUrl 없음) 개수 집계로 상품이 있는 다른
        // 카테고리부터 찾아야 하니, 그 경우만 아래에서 집계 이후에 추출한다.
        let preview: ScrapeResult | null = null
        if (firstUrl) {
          const extracted = await extractPreview(firstUrl)
          preview = extracted.preview
          needsLogin = needsLogin || extracted.needsLoginHere
          if (runEntry) runEntry.earlyPreview = preview
        }
        if (stop()) return supersededResult()

        // 카테고리별 개수만 여러 탭으로 동시에 집계한다. 로그인 창을 재사용하는 siteId라도 그 공유 탭은
        // 절대 쓰지 않고 항상 새 탭만 연다(discoverCategoryLinks에서 같은 이유로 겪은 "다른 네비게이션에
        // 의해 중단됨" 충돌 방지).
        const COUNT_CONCURRENCY = resolveConcurrency(opts, 16)
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
                opts.knownNoPaginationWidget === true,
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

        // 부트스트랩으로 고른 카테고리(0번)가 하필 비어있었으면(firstUrl 없음), 실제로 상품이 있는 다른
        // 카테고리에서 지금 1건을 구해 추출한다(위 조기 추출이 못 한 유일한 경우).
        if (!firstUrl) {
          const nonEmpty = doneCounts.find(c => c.count > 0)
          if (nonEmpty) {
            // 갈아타는 것 자체는 "아무것도 못 보여주는 것"보다 낫지만, **말없이** 갈아타면 사용자는
            // 자기가 고른 카테고리의 상품을 보고 있다고 오해한다(사용자 지적, 2026-09-13). 어디서
            // 뽑았는지 기록해 화면이 그대로 알려주게 한다.
            console.log(`[미리보기:표본] 첫 카테고리(${listingUrls[0]})에서 상품을 못 찾아 "${nonEmpty.url}"에서 표본을 뽑습니다`)
            const retry = await collectProductUrls(scratchPage, { ...opts, url: nonEmpty.url, categoryUrls: undefined, maxPages: 1 })
            firstUrl = retry.urls.filter(u => !isSamePageUrl(u, nonEmpty.url))[0]
            categoryByUrl = retry.categoryByUrl
            needsLogin = needsLogin || retry.needsLogin
            sampleListingUrl = nonEmpty.url
            sampleSwitchedReason = '고른 첫 카테고리에서 상품을 찾지 못해 다른 카테고리에서 표본을 뽑았습니다'
            sampleSortClick = retry.sortClick
          }
        }

        if (stop()) return { ...supersededResult(), total, platform, categoryCounts: doneCounts, needsLogin }
        if (firstUrl && !preview) {
          const extracted = await extractPreview(firstUrl)
          preview = extracted.preview
          needsLogin = needsLogin || extracted.needsLoginHere
          if (runEntry) runEntry.earlyPreview = preview
        }
        // 이 몰의 상품 상세 URL 패턴을 아직 모르면(플랫폼 프로필에도 없고 기억해둔 것도 없음), 방금
        // 목록에서 실제로 모은 상품 URL들로 학습해 호출부가 저장하게 한다 — 그래야 다음부터 개수 세기·
        // 미리보기·스크랩이 "이미지를 감싼 <a>는 전부 상품"이라는 폴백에 의존하지 않는다.
        const learnedDetailUrlPattern = (profile.detailUrlPattern?.source ?? opts.detailUrlPattern)
          ? null
          : deriveDetailUrlPattern(bootstrap.urls)
        if (learnedDetailUrlPattern) {
          console.log(`[상세URL패턴:학습] ${listingUrls[0]} → /${learnedDetailUrlPattern}/ (상품 ${bootstrap.urls.length}개 기준)`)
        }
        return {
          total, platform, preview, items: [], categoryCounts: doneCounts, needsLogin,
          learnedDetailUrlPattern,
          previewSource: preview
            ? { url: sampleListingUrl, requestedUrl: listingUrls[0], switchedReason: sampleSwitchedReason, sortClick: sampleSortClick }
            : null,
        }
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

/** 몰 탭(브라우저/컨텍스트) 자체가 닫혀서 나는 에러인지 판정한다 — 이 상품 하나만의 일시적 문제(차단,
 *  타임아웃 등)와 달리 재시도/다음 URL로 넘어가도 절대 회복되지 않으므로 scrapeCatalogPage의 worker()가
 *  이걸 보면 재시도 없이 즉시 전체를 멈춘다. Playwright가 실제로 내는 문구들(대소문자/문장부호 변형
 *  포함) — "Target page, context or browser has been closed", "Target closed" 등. */
function isBrowserClosedError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return /has been closed|target closed/i.test(message)
}

/** page.goto()가 지정한 타임아웃(30초) 안에 응답을 못 받았다는 뜻 — 몰이 순간적으로 느려졌거나(과부하)
 *  동시 요청을 티 안 나게 늦춰서 사실상 차단하는 경우(명시적인 차단 안내 페이지 없이 그냥 응답을 안
 *  주는 방식)에 흔히 나타난다. 기존엔 "가격/이미지를 둘 다 못 찾음"만 차단 신호로 보고 동시성을
 *  낮췄는데, 이 타임아웃 자체는 그 판정에 안 걸려 동시성이 계속 올라간 채로 방치돼 실패가 쌓인 사례가
 *  실사용에서 확인됐다(2026-09-12, 도매토피아 — 동시성이 14까지 올라간 직후부터 30초 타임아웃이 29건
 *  연달아 났는데도 한 번도 안 낮아짐). scrapeOne이 이것도 "차단/과부하 추정"으로 같이 취급하게 한다. */
function isNavigationTimeoutError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return /Timeout \d+ms exceeded/.test(message)
}

/** 목록 페이지(들)에서 제품 URL 수집 후 각각 스크랩. 카테고리 여러 개 + 페이지네이션 + 중지 + 이미 스크랩한 상품 제외 + 동시 처리 지원 */
export async function scrapeCatalogPage(
  opts: ScrapeOptions,
  onItem: (event: CatalogItemEvent) => Promise<void> | void,
): Promise<CatalogScrapeSummary> {
  return withContext(opts, async (page, context) => {
    const { urls: productUrls, categoryByUrl, needsLogin: listingNeedsLogin, stopped: stoppedDuringCollection } = await collectProductUrls(page, opts, context)
    // 상품 URL을 모으는 단계(카테고리 페이지 여러 개를 훑는 단계)에서 이미 "중지"가 눌렸으면, 지금까지
    // 모은 것으로 상품 스크랩 단계를 시작하지 않고 그대로 멈춘다 — 여기서 그냥 진행해버리면 "중지"를
    // 눌렀는데도 (지금까지 모은 URL 몇 개는) 계속 스크랩되는 것처럼 보인다.
    if (stoppedDuringCollection) return { total: 0, saved: 0, stopped: true, concurrencyLog: [] }

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
    // 몰 탭(브라우저/컨텍스트) 자체가 도중에 닫히면(사용자가 실수로 닫거나 크롬이 크래시하는 등) 그
    // 순간부터 남은 모든 URL에 대해 workerPage.goto()가 매번 즉시 이 에러로 실패한다 — 재시도해도,
    // 다음 URL로 넘어가도 절대 안 풀리는 영구적인 상태인데, 이걸 "이 상품 하나만 실패"로 취급해 나머지
    // 수천 개를 전부 헛되이 시도하고 있었다(2026-09-06 실사용 확인 — 신우 14788개 중 1707개가 전부
    // 이 에러로 실패, 세션은 "스크래핑 중..."인 채로 계속 헛돌았음). 이 경우만 따로 감지해 재시도 없이
    // 즉시 스크랩 전체를 멈추고 명확한 에러로 세션을 끝낸다.
    let browserClosed = false

    // 적응형 동시성(AIMD, TCP 혼잡제어와 같은 원리) — 몰마다 안전한 동시 요청 수가 달라 사용자가 직접
    // 숫자를 고르게 하던 것을 대체한다. 1(가장 안전)부터 시작해 연속 성공이 쌓이면 서서히 올리고, 차단으로
    // 추정되는 응답(아래 scrapeOne의 "차단 또는 일시 오류로 추정" 판정)이 나오면 즉시 1로 낮추고 잠시 쉰다.
    // ponytail: RAMP_UP_STREAK/MAX_CONCURRENCY/쿨다운 값은 임의로 정한 안전 마진 — 실제로 몰별 반응을 보며 조정.
    // concurrencyMode==='manual'이면 그 값으로 상한을 고정하고 시작값도 거기서 바로 시작한다(activeLimit이
    // 이미 MAX_CONCURRENCY와 같아 위 "연속 성공 시 상향" 조건이 못 만족돼 그대로 고정된 채 유지된다) —
    // 차단 감지 시 1로 낮췄다가 회복하는 안전장치는 auto/manual 구분 없이 그대로 적용되고, manual이면
    // 16이 아니라 이 고정값까지만 다시 올라온다. 상한(16) 자체의 근거는 resolveConcurrency 주석 참고 —
    // 8이던 걸 2026-08-24에 리소스 실측 후 올렸다.
    const manualLimit = opts.concurrencyMode === 'manual' ? Math.max(1, Math.min(opts.concurrency || 1, 16)) : null
    const MAX_CONCURRENCY = manualLimit ?? 16
    const RAMP_UP_STREAK = 5
    let activeLimit = manualLimit ?? 1
    let okStreak = 0
    const concurrencyLog: ConcurrencyLogEntry[] = []

    async function scrapeOne(workerPage: Page, pUrl: string): Promise<{ result: ScrapeResult | null; blocked: boolean; browserClosed?: boolean }> {
      let lastProduct: ExtractedProduct | null = null
      let blocked = false
      let sawNavigationTimeout = false
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
          // 브라우저/컨텍스트 자체가 닫힌 거면 이 상품도, 남은 재시도도, 다음 상품도 전부 똑같이
          // 실패할 게 확실하다 — 의미 없는 재시도 대기(최대 몇 초씩)를 건너뛰고 바로 포기한다.
          if (isBrowserClosedError(err)) return { result: null, blocked: false, browserClosed: true }
          if (isNavigationTimeoutError(err)) sawNavigationTimeout = true
          if (attempt < RETRY_COUNT) await sleep(2_000 * (attempt + 1) + Math.random() * 2_000)
        }
      }
      // 재시도를 다 써도 안 됐는데 그 원인에 탐색 타임아웃이 섞여 있었으면(가격/이미지 없음과 별개 신호)
      // 이것도 차단/과부하로 추정해 동시성을 낮춘다(위 isNavigationTimeoutError 주석 참고).
      if (sawNavigationTimeout) blocked = true
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
        if (browserClosed) return
        // 이 워커의 순번이 현재 활성 한도보다 높으면(아직 한도가 안 올라왔거나 방금 차단으로 낮아졌으면)
        // 새 탭을 열어둔 채로 대기만 한다 — 한도가 올라오면 자동으로 다시 작업을 받는다.
        while (workerIndex >= activeLimit) {
          if (isStopRequested(opts.sessionId)) { stopped = true; return }
          if (browserClosed) return
          if (cursor >= productUrls.length) return
          await sleep(500)
        }
        const i = cursor++
        if (i >= productUrls.length) return
        if (i > 0) await throttle(opts.delayMs)

        const pUrl = productUrls[i]
        const { result, blocked, browserClosed: thisClosed } = await scrapeOne(workerPage, pUrl)
        if (thisClosed) { browserClosed = true; return }
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

    // "중지"와 구분한다 — 사용자가 누른 게 아니라 몰 탭/브라우저 자체가 사라진 것이라 이어서 할 수도
    // 없다(다시 시작하려면 새로 브라우저를 띄워야 함). 화면에 "완료"나 "중지됨"이 아니라 "오류"로
    // 명확히 보여야 사용자가 남은 상품이 실제로 있다는 걸(여기서 saved > 0일 수 있음) 알고 다시
    // 시작할지 판단할 수 있다.
    if (browserClosed) {
      throw new Error(`몰 탭(브라우저)이 스크랩 도중 닫혀 중단되었습니다 — ${saved}/${productUrls.length}개까지 수집한 상태입니다. 몰 탭을 닫지 않았는지 확인 후 다시 시작해주세요.`)
    }

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
    // scrapeCatalogPage의 browserClosed와 같은 이유 — 몰 탭이 닫히면 남은 대상 전부가 똑같이 실패할
    // 게 확실하므로, 재시도/나머지 대상 순회 없이 즉시 멈춘다.
    let browserClosed = false
    const concurrency = Math.max(1, Math.min(opts.concurrency || 4, 16))

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
          if (isBrowserClosedError(err)) {
            return { mallProductId: target.id, mallProductCode: target.mallProductCode, product: null, error: err instanceof Error ? err.message : String(err) }
          }
          if (attempt < RETRY_COUNT) { await sleep(2_000 * (attempt + 1)); continue }
          return { mallProductId: target.id, mallProductCode: target.mallProductCode, product: null, error: err instanceof Error ? err.message : String(err) }
        }
      }
      return { mallProductId: target.id, mallProductCode: target.mallProductCode, product: null, error: '알 수 없는 오류' }
    }

    async function worker(workerPage: Page) {
      while (true) {
        if (browserClosed) return
        const i = cursor++
        if (i >= targets.length) return
        if (i > 0) await throttle(opts.delayMs)
        const result = await recheckOne(workerPage, targets[i])
        if (result.error && isBrowserClosedError(new Error(result.error))) browserClosed = true
        results.push(result)
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

// "카테고리 불러오기" 중지 버튼용 — profileAbortControllers(몰 구조분석)와 같은 이유로 siteId별 슬롯
// 하나씩 globalThis에 저장한다(2026-08-26, 사용자 요청: "여기도 중지 버튼을 만들어줘" — 신우처럼 허브
// 펼치기 단계에서 카테고리 수백 개를 순회하느라 몇 분씩 걸리는 몰이 실제로 있어, 그 중간에 멈출 방법이
// 필요했다). withSiteLock이 siteId당 하나만 동시에 돌게 이미 보장하므로 Map 슬롯 하나로 충분하다.
const categoryDiscoveryAbortControllers: Map<number, AbortController> =
  globalThis.__scrapeCategoryDiscoveryAbortControllers ?? (globalThis.__scrapeCategoryDiscoveryAbortControllers = new Map())

/** PTP의 "카테고리 불러오기" 중지 버튼이 호출한다 — profileMallStructure 쪽과 달리 discoverCategoryLinks는
 *  신호를 받아도 예외를 던지지 않고 지금까지 찾은 부분 결과를 그대로 반환한다(허브 펼치기 루프가 새
 *  카테고리를 더 꺼내지 않고 곧장 끝냄) — 화면은 원래 요청한 fetch가 그 부분 결과로 정상 응답할 때까지
 *  기다리기만 하면 된다. 진행 중인 게 없으면 조용히 아무 일도 안 한다. */
export function stopCategoryDiscovery(siteId: number): boolean {
  const controller = categoryDiscoveryAbortControllers.get(siteId)
  if (!controller) return false
  controller.abort()
  categoryDiscoveryAbortControllers.delete(siteId)
  return true
}

export interface CategoryDiscoveryResult {
  platform: MallPlatform
  links: CategoryLink[]
  /** 하위 카테고리 확인차 대분류 페이지를 방문했다가 로그인 페이지로 튕긴 적이 있으면 true — 회원전용
   *  도매몰(모자사러 등)은 프로필을 통째로 복사해도 로그인 세션 자체가 넘어오지 않는다는 게 이미
   *  확인된 구조적 한계라(!specifications/manual-login-required-malls.md 2026-07-18 항목 참고), 이런
   *  몰은 "다시 확인"을 몇 번을 눌러도 하위 카테고리가 펼쳐지지 않는다 — 화면에서 그 이유를 알려주기
   *  위한 신호다(사용자 실사용 확인, 2026-08-18). */
  loginBlockedExpansion?: boolean
  /** 최상위 카테고리 탐지나 허브 하위메뉴 탐지 중 하나라도 AI(detectCategoryLinksWithAI) 결과를 그대로
   *  채택했으면 true — 화면에 "AI가 이번 결과에 실제로 기여했다"는 걸 작게 표시하기 위한 신호
   *  (사용자 요청, 2026-08-18). GEMINI_API_KEY가 없거나 AI가 매번 빈 결과를 줘 기존 히스틱으로만
   *  전부 채워졌으면 false. */
  aiUsed?: boolean
  /** 화면(비전)으로 읽은 카테고리와 이번 결과의 대조 + 누락 재검증 결과 — "몰 구조분석"의
   *  MallProfileSignals.categoryScreenCheck와 같은 값이다(screenCheckAndRecover가 두 경로 공용). */
  categoryScreenCheck?: CategoryScreenCheck | null
}

/** 시작 URL 페이지에서 카테고리 메뉴로 보이는 링크를 찾아 사용자가 고를 수 있도록 목록으로 반환한다.
 *  "몰 구조분석"(profileMallStructure/sampleMallProfile)이 이미 검증해 쓰고 있는 것과 같은 방식을
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
  const controller = opts.siteId ? new AbortController() : undefined
  if (opts.siteId && controller) categoryDiscoveryAbortControllers.set(opts.siteId, controller)
  try {
    return await discoverCategoryLinksInner(opts, controller?.signal)
  } finally {
    if (opts.siteId && controller && categoryDiscoveryAbortControllers.get(opts.siteId) === controller) {
      categoryDiscoveryAbortControllers.delete(opts.siteId)
    }
  }
}

// "몰 구조분석" 리포트(결제계좌/택배사/재고관리/정렬구조 등)가 실제로 찾는 정보의 흔적 — 카테고리 페이지를
// 어차피 하나씩 열어보는(expandOne) 김에 이 페이지 텍스트에 이 키워드가 있는지만 싸게 확인해두고, AI
// 리포트 단계에서 "이미 들렀던 페이지 중 관련 내용이 있던 곳"만 골라 다시 방문해 자세히 긁어온다 —
// AI에게 무작정 큰 원문(20,000자 캡)을 통째로 주고 시간만 넉넉히 주는 대신, 미리 걸러진 정제된 참고
// 자료를 주는 편이 더 빠르고 정확할 거라는 사용자 제안(2026-09-02). "각 카테고리별로 열어서 확인하는
// 시점에 소스 정도만 한번 보고" — 그래서 여기선 정규식 존재 여부만 boolean으로 확인하고 텍스트 자체는
// 저장하지 않는다(진짜 수집은 아래 gatherRelevantCategoryPageHints가 나중에 그 URL만 다시 방문해서 함).
const MALL_REPORT_HINT_KEYWORDS = /무통장|계좌|입금|택배|배송비|배송조회|반품|교환|환불|재고|품절|정렬|최신순|인기순|낮은가격순|높은가격순|사업자|대표자?\s*:|통신판매/

/** 하위구조 확인(expandCategoryHubs) 단계에서 최종 목록에서 빠진 카테고리와 그 이유 — 화면 대조
 *  리포트(categoryScreenCheck)가 "화면엔 있는데 결과엔 없는" 항목의 사유를 여기서 찾아 붙인다. */
export interface CategoryExclusion { name: string; href: string; reason: string }

/** 화면(비전)으로 읽은 카테고리 이름과 최종 결과를 대조한 결과 — MallProfileSignals.categoryScreenCheck 참고. */
export interface CategoryScreenCheck {
  /** 비전이 그 화면에서 읽은 카테고리 이름들(사람이 보는 기준) */
  screenNames: string[]
  /** 재검증(recoverMissingCategories)으로 되살려 최종 목록에 다시 넣은 카테고리 — 무엇을 근거로
   *  되살렸는지(상품을 실제로 찾음 / 화면에 상품이 보임)까지 남겨, 사용자가 신뢰도를 판단할 수 있게 한다. */
  recovered?: { name: string; href: string; evidence: string }[]
  /** 화면엔 있는데 최종 결과엔 없는 것 — reason은 파이프라인이 아는 사유(모르면 "탐지 단계에서 못 찾음") */
  missing: { name: string; reason: string }[]
  /** 최종 결과엔 있는데 화면에서는 못 읽은 것 — 비전이 놓쳤을 수도, 스크롤 밖이었을 수도 있어 참고용 */
  extra: string[]
  /** 같은 화면에서 같이 받아온 "대분류→하위 카테고리" 그룹 구조(detectVisibleCategoryHierarchy) —
   *  missing/extra 판정에는 안 쓰이고, 사용자에게 "화면에서 본 구조"를 참고로 같이 보여주는 용도뿐이다
   *  (사용자 지시, 2026-09-15). 비전이 실패했거나 구조를 못 받았으면 없음. */
  screenHierarchy?: { group: string; items: string[] }[]
  checkedAt: string
}

/** 이름 비교용 정규화 — 최종 결과는 "대분류 > 중분류"처럼 경로로 저장되고 비전은 화면에 보이는 마지막
 *  이름만 읽으므로, 경로의 마지막 조각끼리 비교한다. 공백/구분자/대소문자 차이도 흡수한다. */
export function normalizeCategoryName(name: string): string {
  const leaf = name.split('>').pop() ?? name
  return leaf.replace(/[\s·ㆍ/｜|,()[\]]+/g, '').toLowerCase()
}

/** 두 문자열의 편집거리(Levenshtein) — 비전(OCR)이 한두 글자를 잘못 읽는 걸 흡수하는 데만 쓴다. */
function editDistance(a: string, b: string): number {
  if (a === b) return 0
  if (!a.length || !b.length) return Math.max(a.length, b.length)
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    prev = cur
  }
  return prev[b.length]
}

/** 화면에서 읽은 이름이 결과의 어떤 이름과 "사실상 같은지" 판정한다 — 비전은 글자를 종종 잘못 읽는다
 *  (투비즈온 실사용 확인, 2026-09-13: "천구/커튼"=침구/커튼, "유아동류"=유아동의류, "주얼리/시계"=
 *  쥬얼리/시계, "취미/니스/수영"=휘트니스/수영). 이걸 그대로 "누락"이라고 보고하면 **이미 결과에 있는
 *  카테고리를 없다고 알리는 오보**가 되고, 재검증까지 헛돌게 된다. 짧은 이름일수록 한 글자 차이가
 *  다른 카테고리일 수 있으니(예: "신발"/"실발") 길이에 따라 허용치를 다르게 둔다. */
export function findApproximateMatch(key: string, keys: Iterable<string>): string | null {
  if (!key) return null
  const allowed = key.length >= 5 ? 2 : key.length >= 3 ? 1 : 0
  if (allowed === 0) return null
  let best: { k: string; d: number } | null = null
  for (const k of keys) {
    if (!k || Math.abs(k.length - key.length) > allowed) continue
    const d = editDistance(key, k)
    if (d <= allowed && (!best || d < best.d)) best = { k, d }
  }
  return best?.k ?? null
}

export interface VisibleCategoryCandidate { name: string; leafText: string }

/** detectVisibleCategoryHierarchy가 돌려준 {group, items[]}[]("같은 시각적 레벨에 나란히 보이는 것 =
 *  카테고리 후보 그룹")를 "이름 하나당 후보 하나"로 평평하게 편다. items가 없으면(도매신의 가로 탭처럼
 *  하위 카테고리 없이 대분류 이름만 나란히 보이는 경우) 그룹 이름 자체를 리프로 삼고, items가 있으면
 *  "그룹 > 항목"으로 경로를 만든다(scanCategoryOverviewPage의 이름 규칙과 동일). 순수 함수 — 화면인식/
 *  DOM 없이 테스트 가능. */
export function flattenVisibleCategoryHierarchy(groups: { group: string; items: string[] }[]): VisibleCategoryCandidate[] {
  const out: VisibleCategoryCandidate[] = []
  for (const { group, items } of groups) {
    if (!group) continue
    if (!items.length) {
      out.push({ name: group, leafText: group })
      continue
    }
    for (const item of items) {
      if (!item) continue
      out.push({ name: `${group} > ${item}`, leafText: item })
    }
  }
  return out
}

/** 비전이 화면에서 읽은 카테고리 후보를, 같은 화면에서 같이 모아둔 링크(pageLinks) 중 이름이 일치하는
 *  것과 짝지어 href를 되찾는다 — 화면에 보이는 텍스트라면 DOM에 진짜 앵커가 있다는 뜻이므로, 못 찾으면
 *  좌표 클릭으로 지어내지 않고 그냥 버린다(resolveMissingCategoryCandidates와 같은 원칙 — "확인 못 하면
 *  후보에서 뺀다"). 정확히 안 맞으면 findApproximateMatch로 한 번 더 시도한다(비전 OCR 오독 흡수, 같은
 *  이유는 findApproximateMatch 주석 참고). 같은 href를 두 후보가 나눠 갖지 않도록 소비한 href는 뺀다. */
export function matchVisibleCategoryLinksToHrefs(
  candidates: VisibleCategoryCandidate[],
  pageLinks: { text: string; href: string }[],
): CategoryMenuLink[] {
  const byName = new Map<string, string[]>()
  for (const l of pageLinks) {
    const key = normalizeCategoryName(l.text)
    if (!key || !l.href) continue
    const list = byName.get(key)
    if (list) list.push(l.href)
    else byName.set(key, [l.href])
  }
  const usedHrefs = new Set<string>()
  const out: CategoryMenuLink[] = []
  for (const c of candidates) {
    const key = normalizeCategoryName(c.leafText)
    if (!key) continue
    let href = byName.get(key)?.find(h => !usedHrefs.has(h))
    if (!href) {
      const approx = findApproximateMatch(key, byName.keys())
      if (approx) href = byName.get(approx)?.find(h => !usedHrefs.has(h))
    }
    if (!href) continue
    usedHrefs.add(href)
    out.push({ name: c.name, href })
  }
  return out
}

/** 재검증할 후보 — 화면에서 읽은 이름에 URL을 붙인 것. href를 못 찾으면 재검증 자체가 불가능하다. */
export interface MissingCategoryCandidate { name: string; href: string; reason: string }

/** 화면엔 있는데 결과엔 없는 이름들에 URL을 붙인다(재검증 대상 만들기) — 순수 함수라 테스트로 고정한다.
 *  1순위: 확장 단계에서 제외된 기록(excluded)에 그 이름이 있으면 그때의 href를 그대로 쓴다.
 *  2순위: 메뉴가 열려 있던 화면에서 같이 모아둔 링크(menuLinks) 중 이름이 일치하는 것 — "탐지 단계에서
 *  아예 못 찾은" 카테고리는 이 경로로만 URL을 얻을 수 있다.
 *  둘 다 없으면 후보에서 뺀다 — 방문할 URL을 모르면 다른 방법으로 검증할 방법도 없다. */
export function resolveMissingCategoryCandidates(
  missing: { name: string; reason: string }[],
  excluded: CategoryExclusion[],
  menuLinks: { text: string; href: string }[] | undefined,
): MissingCategoryCandidate[] {
  const byExcluded = new Map<string, string>()
  for (const e of excluded) {
    const key = normalizeCategoryName(e.name)
    if (key && !byExcluded.has(key)) byExcluded.set(key, e.href)
  }
  const byMenu = new Map<string, string>()
  for (const l of menuLinks ?? []) {
    const key = normalizeCategoryName(l.text)
    if (key && l.href && !byMenu.has(key)) byMenu.set(key, l.href)
  }
  const out: MissingCategoryCandidate[] = []
  const seen = new Set<string>()
  for (const m of missing) {
    const key = normalizeCategoryName(m.name)
    if (!key || seen.has(key)) continue
    const href = byExcluded.get(key) ?? byMenu.get(key)
    if (!href) continue
    seen.add(key)
    out.push({ name: m.name, href, reason: m.reason })
  }
  return out
}

/** 재검증 상한 — 화면 이름이 수십 개씩 나올 수 있어, 되살리기 한 번에 몇 개까지 다시 열어볼지 제한한다.
 *  하나당 최대 (페이지로드 + 인내심 있는 개수 세기 + 비전 1회)라 무제한이면 분석 전체가 늘어진다. */
const MAX_CATEGORY_RECOVERY_ATTEMPTS = 25

/**
 * "화면에는 보이는데 결과엔 없는" 카테고리를 **다른 방법으로 다시 검증한다**(사용자 지시, 2026-09-13 —
 * "사람이 보는 화면에는 모든 카테고리가 확인이 된다. 그 기준으로 누락된 카테고리가 있을 경우 다른
 * 방법으로라도 다시 해당 카테고리를 검증하는 프로세스를 넣어").
 *
 * 1차 판정(허브 확장)은 "페이지를 열고 DOM에서 상품 링크를 센다"는 한 가지 방법만 쓴다 — 목록이 늦게
 * 그려지거나(countProductsSettled 주석), 이 몰 스킨이 우리 셀렉터와 안 맞으면 멀쩡한 카테고리가 0개로
 * 잡힌다. 그래서 되살리기는 **서로 독립적인 두 근거**를 순서대로 쓴다:
 *   ① 더 끈질긴 재방문 — 'load'까지 기다리고, 개수가 안정될 때까지 더 오래 지켜본다.
 *   ② 그래도 0개면 화면 캡처 → 비전에게 "사람이 보기에 상품 목록이 있느냐"고 묻는다(detectProductListVisible).
 *      DOM을 못 읽는 것과 상품이 없는 것은 다른 문제이므로, 눈으로 보이면 있는 것으로 인정한다.
 * 둘 중 하나라도 통과하면 최종 목록에 다시 넣는다(근거를 같이 기록해 신뢰도를 구분할 수 있게 한다).
 */
async function recoverMissingCategories(
  context: BrowserContext, mallName: string, candidates: MissingCategoryCandidate[],
  userSel: string | null, platformSel: string | null, detailPatternSrc: string | undefined, baseUrl: string,
  signal?: AbortSignal,
): Promise<{ recovered: { name: string; href: string; evidence: string }[]; stillMissing: Map<string, string> }> {
  const recovered: { name: string; href: string; evidence: string }[] = []
  const stillMissing = new Map<string, string>()
  if (!candidates.length) return { recovered, stillMissing }
  const targets = candidates.slice(0, MAX_CATEGORY_RECOVERY_ATTEMPTS)
  console.log(`[누락재검증:${mallName}] 화면엔 있는데 결과에 없는 ${candidates.length}개 중 ${targets.length}개를 다른 방법으로 다시 확인합니다`)
  const page = await context.newPage()
  try {
    for (const c of targets) {
      if (signal?.aborted) break
      // ① 더 끈질긴 재방문 — 1차와 달리 'load'까지 기다린다(1차는 domcontentloaded).
      const moved = await page.goto(c.href, { waitUntil: 'load', timeout: 30_000 }).then(() => true).catch(() => false)
      if (!moved) {
        stillMissing.set(normalizeCategoryName(c.name), '재검증 중에도 페이지를 열지 못함')
        continue
      }
      await settleAfterNav(page)
      const probe = await countProductsSettled(page, userSel, platformSel, detailPatternSrc, baseUrl)
        .catch(() => ({ count: 0, isLoginPage: false }))
      if (probe.count > 0) {
        console.log(`[누락재검증:${mallName}] "${c.name}" — 다시 열어보니 상품 ${probe.count}개 → 목록에 되살림 (${c.href})`)
        // 사용자 화면에는 **개수를 적지 않는다**(사용자 지시, 2026-09-13): 몰 구조분석 단계의 개수는
        // 1페이지 분량만 본 값이라(이 몰은 페이지 번호가 URL에 안 실려 2페이지를 못 연다) 총 개수처럼
        // 읽히면 오해를 준다. 상품 개수는 미리보기 단계에서 세어 그 값만 보여준다. 진단용 로그에는
        // 그대로 남긴다(위 console.log).
        recovered.push({ name: c.name, href: c.href, evidence: '재방문에서 상품이 있는 것을 확인' })
        continue
      }
      if (probe.isLoginPage) {
        stillMissing.set(normalizeCategoryName(c.name), '재검증 시 로그인 화면이 떠 확인 불가(로그인 상태를 확인해주세요)')
        continue
      }
      // ② 눈으로 확인 — DOM을 못 읽는 것과 상품이 없는 것은 다르다.
      const shot = await page.screenshot({ type: 'jpeg', quality: 90 }).catch(() => null)
      const visible = shot ? await detectProductListVisible(mallName, shot.toString('base64'), 'image/jpeg', signal).catch(() => null) : null
      if (visible === true) {
        console.log(`[누락재검증:${mallName}] "${c.name}" — DOM으로는 0개지만 화면에는 상품이 보임 → 목록에 되살림 (${c.href})`)
        recovered.push({ name: c.name, href: c.href, evidence: '화면 인식으로 상품 목록 확인(DOM 셀렉터가 못 읽은 것으로 보임)' })
        continue
      }
      stillMissing.set(normalizeCategoryName(c.name), visible === false
        ? '다시 열어봐도 상품이 없고, 화면으로 봐도 상품 목록이 없음(진짜 빈 카테고리로 보임)'
        : '다시 열어봐도 상품이 없었고, 화면 인식은 판단하지 못함')
    }
  } finally {
    await page.close().catch(() => {})
  }
  console.log(`[누락재검증:${mallName}] 되살린 카테고리 ${recovered.length}개 / 여전히 확인 안 되는 것 ${stillMissing.size}개`)
  return { recovered, stillMissing }
}

/** 되살린 카테고리를 기존 목록에 합친다(같은 href는 한 번만). */
function mergeRecovered(links: CategoryMenuLink[], recovered: { name: string; href: string }[]): CategoryMenuLink[] {
  if (!recovered.length) return links
  const known = new Set(links.map(c => canonicalizeHref(c.href)))
  return [...links, ...recovered.filter(r => !known.has(canonicalizeHref(r.href))).map(r => ({ name: r.name, href: r.href }))]
}

/** 화면 인식이 실패한 실행에서 "직전 결과 기준으로 사라진 카테고리"만 재검증한다 —
 *  recoverMissingCategories와 같은 방법(끈질긴 재방문 → 화면 확인)을 쓴다. */
async function recoverDroppedCategories(
  context: BrowserContext, mallName: string, dropped: CategoryMenuLink[],
  platform: MallPlatform, baseUrl: string, signal?: AbortSignal,
): Promise<{ name: string; href: string; evidence: string }[]> {
  const { recovered } = await recoverMissingCategories(
    context, mallName,
    dropped.map(p => ({ name: p.name, href: p.href, reason: '직전 실행엔 있었는데 이번엔 안 나옴' })),
    null, PLATFORM_PROFILES[platform].productLinkSelector, PLATFORM_PROFILES[platform].detailUrlPattern?.source,
    baseUrl, signal,
  )
  return recovered
}

/**
 * "화면 대조 → 누락 재검증 → 되살리기"를 한 묶음으로 실행한다 — **"몰 구조분석"과 "카테고리 불러오기"가
 * 반드시 같은 결과를 내게 하기 위한 공용 경로다.**
 *
 * 처음엔 이 과정을 "몰 구조분석" 안에만 넣었는데, 그 결과 두 화면의 숫자가 갈렸다(사용자 지적,
 * 2026-09-13 — "몰구조분석에 51개와 몰카테고리전체가져오기 49개가 달라"): 몰 구조분석이 재검증으로
 * 되살린 카테고리를, 나중에 돈 "카테고리 불러오기"가 같은 1차 판정으로 다시 떨어뜨리고 캐시까지
 * 덮어썼다. 두 버튼은 같은 탐지/확장 함수를 공유하므로, 되살리기도 같이 공유해야 한다.
 */
async function screenCheckAndRecover(
  context: BrowserContext, mallName: string, screenNames: string[] | null | undefined,
  menuLinks: { text: string; href: string }[] | undefined, links: CategoryMenuLink[],
  exclusions: CategoryExclusion[], platform: MallPlatform, baseUrl: string, signal?: AbortSignal,
  /** 직전 실행에서 확인된 카테고리(캐시) — "화면"과 별개의 두 번째 기준선이다. 화면 인식이 실패해
   *  screenNames가 없어도, 이 목록보다 줄어든 만큼은 재검증 대상이 된다(아래 주석 참고). */
  previousLinks?: CategoryMenuLink[],
  /** screenNames와 같은 화면에서 같이 받아온 "대분류→하위 카테고리" 구조(detectVisibleCategoryHierarchy) —
   *  missing/extra 재검증에는 안 쓰고, 최종 screenCheck에 참고용으로 그대로 실어 보낸다. */
  screenHierarchy?: { group: string; items: string[] }[] | null,
): Promise<{ links: CategoryMenuLink[]; screenCheck: CategoryScreenCheck | null }> {
  // 이번 실행에서 사라진 "직전 결과의 카테고리"도 재검증 대상에 넣는다 — 실사용에서 같은 몰의 같은
  // 페이지가 실행마다 상품 0개로 보이기도 하고 25개로 보이기도 해(투비즈온, 2026-09-13: 51 → 49 → 46로
  // 매번 줄어듦) 결과가 계속 깎여나갔다. 화면 인식(비전)은 실패할 수 있는 반면 직전 결과는 항상 있으므로,
  // 두 기준선을 같이 쓰면 "한 번이라도 확인된 카테고리가 조용히 사라지는" 일이 없어진다.
  const currentHrefs = new Set(links.map(c => canonicalizeHref(c.href)))
  // 깨진 배너 placeholder(BROKEN_TEMPLATE_TOKEN_RE 주석 참고)는 이번 실행이 정확히 걸러낸 것일 뿐, 이걸
  // "직전엔 있었는데 이번엔 없어졌다"로 보고 되살리려 하면 href가 우연히 진짜 상품 페이지를 가리켜
  // 표본검증을 통과해버려 깨진 이름 그대로 영원히 되살아난다 — 애초에 재검증 대상에 넣지 않는다.
  const droppedFromPrevious = (previousLinks ?? [])
    .filter(p => !currentHrefs.has(canonicalizeHref(p.href)))
    .filter(p => !isBrokenPlaceholderCategoryName(p.name))
  if (droppedFromPrevious.length) {
    console.log(`[이전결과대조:${mallName}] 직전에 있던 카테고리 ${droppedFromPrevious.length}개가 이번 결과엔 없음 — 재검증 대상에 포함: ${droppedFromPrevious.slice(0, 10).map(p => p.name).join(', ')}`)
  }

  const first = buildCategoryScreenCheck(screenNames, links, exclusions, screenHierarchy)
  if (!first) {
    // 화면 인식이 실패한 실행 — 화면 대조는 못 하지만 직전 결과 기준 재검증은 그대로 진행한다.
    if (!droppedFromPrevious.length || signal?.aborted) return { links, screenCheck: null }
    const restored = await recoverDroppedCategories(context, mallName, droppedFromPrevious, platform, baseUrl, signal)
    return { links: mergeRecovered(links, restored), screenCheck: null }
  }
  console.log(`[화면대조:${mallName}] 화면에서 읽은 카테고리 ${first.screenNames.length}개 중 결과에 없는 것 ${first.missing.length}개${first.missing.length ? ` — ${first.missing.slice(0, 10).map(m => `${m.name}(${m.reason})`).join(' / ')}` : ''}`)
  if ((!first.missing.length && !droppedFromPrevious.length) || signal?.aborted) return { links, screenCheck: first }

  const candidates = [
    ...resolveMissingCategoryCandidates(first.missing, exclusions, menuLinks),
    ...droppedFromPrevious.map(p => ({ name: p.name, href: p.href, reason: '직전 실행엔 있었는데 이번엔 안 나옴' })),
  ].filter((c, i, arr) => arr.findIndex(x => canonicalizeHref(x.href) === canonicalizeHref(c.href)) === i)
  if (!candidates.length) {
    // 링크가 하나도 안 붙는다는 건 대개 화면의 대분류 탭(그룹 제목)만 남았다는 뜻이다.
    return { links, screenCheck: { ...first, missing: first.missing.map(m => ({ name: m.name, reason: '화면의 대분류 탭(그룹 제목)으로 보임 — 링크가 없어 카테고리로 저장하지 않습니다(정상)' })) } }
  }
  const { recovered, stillMissing } = await recoverMissingCategories(
    context, mallName, candidates, null,
    PLATFORM_PROFILES[platform].productLinkSelector, PLATFORM_PROFILES[platform].detailUrlPattern?.source,
    baseUrl, signal,
  )
  let nextLinks = links
  if (recovered.length) {
    const known = new Set(links.map(c => canonicalizeHref(c.href)))
    nextLinks = [...links, ...recovered.filter(r => !known.has(canonicalizeHref(r.href))).map(r => ({ name: r.name, href: r.href }))]
  }
  const after = buildCategoryScreenCheck(screenNames, nextLinks, exclusions, screenHierarchy)
  if (!after) return { links: nextLinks, screenCheck: first }
  const candidateKeys = new Set(candidates.map(c => normalizeCategoryName(c.name)))
  return {
    links: nextLinks,
    screenCheck: {
      ...after,
      recovered,
      missing: after.missing.map(m => {
        const key = normalizeCategoryName(m.name)
        const recheckReason = stillMissing.get(key)
        if (recheckReason) return { name: m.name, reason: recheckReason }
        if (!candidateKeys.has(key)) return { name: m.name, reason: '화면의 대분류 탭(그룹 제목)으로 보임 — 링크가 없어 카테고리로 저장하지 않습니다(정상)' }
        return m
      }),
    },
  }
}

/** 화면에서 읽은 이름 목록과 최종 카테고리 목록을 대조한다 — 순수 함수라 테스트로 규칙을 고정해둔다.
 *  screenNames가 비어 있으면(화면 인식 실패) null을 돌려줘 호출부가 대조 자체를 건너뛰게 한다. */
export function buildCategoryScreenCheck(
  screenNames: string[] | null | undefined, finalLinks: CategoryMenuLink[], excluded: CategoryExclusion[],
  screenHierarchy?: { group: string; items: string[] }[] | null,
): CategoryScreenCheck | null {
  if (!screenNames?.length) return null
  const finalKeys = new Set<string>()
  for (const l of finalLinks) {
    finalKeys.add(normalizeCategoryName(l.name))
    // "대분류 > 중분류"로 저장된 경우 각 조각도 넣어, 화면의 대분류 이름이 "누락"으로 잘못 잡히지 않게 한다.
    l.name.split('>').forEach(part => finalKeys.add(normalizeCategoryName(part)))
  }
  const excludedByKey = new Map(excluded.map(e => [normalizeCategoryName(e.name), e.reason]))
  const missing: { name: string; reason: string }[] = []
  const screenKeys = new Set<string>()
  for (const name of screenNames) {
    const key = normalizeCategoryName(name)
    if (!key) continue
    screenKeys.add(key)
    if (finalKeys.has(key)) continue
    // 비전이 한두 글자 잘못 읽은 것뿐이면 "있는 것"으로 본다(findApproximateMatch 주석 참고).
    if (findApproximateMatch(key, finalKeys)) continue
    missing.push({ name, reason: excludedByKey.get(key) ?? '탐지 단계에서 이 카테고리를 찾지 못함(메뉴 스캔에 안 잡혔거나 화면 인식이 잘못 읽었을 수 있음)' })
  }
  const extra = finalLinks.map(l => l.name).filter(n => !screenKeys.has(normalizeCategoryName(n)))
  return {
    screenNames, missing, extra, checkedAt: new Date().toISOString(),
    ...(screenHierarchy?.length ? { screenHierarchy } : {}),
  }
}

interface CategoryExpansionResult {
  links: CategoryMenuLink[]
  aiUsed: boolean
  loginBlockedExpansion: boolean
  /** 이번 확장에서 제외된 카테고리들(이유 포함) */
  excluded: CategoryExclusion[]
  /** MALL_REPORT_HINT_KEYWORDS 참고 — 카테고리 하위구조 확인 중 이 키워드가 발견된 페이지의 URL(중복
   *  없음). "몰 구조분석" 리포트 단계가 이 URL만 다시 방문해 상세 텍스트를 참고 자료로 쓴다. */
  relevantHrefs: string[]
}

/** 봇/과속요청 차단 인터스티셜 감지 — countProductsOnPage의 isLoginPage(비밀번호 입력창 유무)와는
 *  다른 신호다. 실사용 확인(2026-08-29, 펫토리): 카페24가 "잠시 접속이 제한되었습니다" 같은 안내
 *  페이지로 대신 응답하는데, count===0으로만 판정하면 진짜 하위 카테고리가 없는 대분류로 오판한다.
 *  extension-poc/background.js에도 같은 정규식으로 IS_BLOCK_PAGE_EXPR을 뒀다(런타임이 달라 코드는
 *  공유 못 함 — 문구 바뀌면 두 곳 다 같이 고친다). */
async function isBotBlockPage(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const text = document.title + ' ' + (document.body?.innerText || '').slice(0, 800)
    return /접속\s*(이|을)?\s*제한|일시적으로\s*(접속|이용)|비정상적인\s*(접근|접속)|잠시\s*접속|과도한\s*요청|too many requests|access denied/i.test(text)
  }).catch(() => false)
}

/** 최상위 카테고리 중 상품이 없는 "허브"(하위 메뉴로만 이어지는 대분류)를 실제로 방문해 진짜 하위
 *  카테고리로 펼친다 — discoverCategoryLinks("카테고리 불러오기"/"다시 확인")와 sampleMallProfile
 *  ("몰 구조분석", deep일 때만)가 공유한다(2026-08-27, 사용자 요청: "허브 펼치기를 자주 안 하는 몰
 *  구조분석 시점에도 해서, 카테고리 불러오기가 그 결과를 캐시로 바로 쓸 수 있게" — 절충안: "다시 확인"은
 *  여전히 실제로 다시 확인하는 무거운 버튼으로 남기고, 몰 구조분석도 어차피 몰에 들어간 김에 같은
 *  캐시(scrape_profile.categoryLinks)를 최신화해 그 직후의 "카테고리 불러오기"가 바로 최신 결과를 빠르게
 *  보여주게 한다). 카테고리 수만큼 페이지를 열어야 해 시간이 걸리므로, 자주 도는 "구조 변화 감지"
 *  (deep=false, 로그인 확인/스크랩 시작마다 자동으로 돎)에서는 호출하지 않는다 — 그쪽까지 이 무거운
 *  단계를 넣으면 원래 목적(가벼운 변화 감지)을 해친다. */
// expandCategoryHubs가 허브 하나당 반복 호출하는 detectCategoryLinksWithAI 전용 — 최상위 탐지(몰 전체에
// 한 번뿐)는 CATEGORY_AI_TIMEOUT_MS(60초)를 그대로 쓰지만, 허브 펼치기는 카테고리 개수만큼 반복되고
// 실패해도 바로 아래 정렬체크 안전망이 있어 상대적으로 저부담이다 — 실패시 대기시간을 절반 이하로
// 줄인다(도매토피아 실사용 확인, 2026-08-30: 규칙기반이 실패하는 몰에서 60초씩 여러 번 쌓여 20분 넘게
// 걸림).
const HUB_EXPANSION_AI_TIMEOUT_MS = 20_000
// 이번 몰 구조분석 실행 "전체"에서 허브 펼치기 AI 폴백을 시도할 최대 횟수 — Ollama 호출이 전역 대기열
// (withOllamaQueue)로 직렬화돼 있어, 허브가 아무리 많아도 이 상한을 넘기면 그 뒤로는 AI 없이 정렬/상품
// 체크만으로 판단한다. 최악의 소요시간 자체를 예측 가능한 범위로 묶어두기 위함 — 도매토피아처럼 AI가
// 별 도움이 안 되는 몰(정적 페이지라 하위메뉴 자체가 없음)에서는 정확도 손실이 거의 없다.
const MAX_HUB_AI_ATTEMPTS_PER_RUN = 5

async function expandCategoryHubs(
  context: BrowserContext, page: Page, categoryLinks: CategoryMenuLink[], mallName: string, platform: MallPlatform,
  baseUrl: string, concurrencyOpts: ScrapeOptions, signal?: AbortSignal, siteId?: number,
  // 하위 메뉴를 못 찾은 허브마다 detectCategoryLinksWithAI(로컬 Ollama)로 재시도하는 폴백을 켤지 —
  // "카테고리 불러오기"(discoverTopLevelCategoryLinks 호출부, 아래쪽)는 기존 그대로 항상 켜져 있고,
  // "몰 구조분석"(profileMallStructure 호출부)만 aiProviders 체크박스의 Ollama 선택 여부를 그대로
  // 전달한다 — 이 경로가 체크박스와 무관하게 항상 Ollama를 걸었던 게 세 번째로 발견된 구멍이었다
  // (report 생성의 generateMallProfileReportOllama, 카테고리 이상탐지의 detectCategoryAnomalyOllama에
  // 이어 2026-09-03 실사용 확인 — 사용자가 화면에서 Ollama를 꺼놔도 카테고리가 많은 몰에서 이 허브
  // 확장 폴백이 조용히 Ollama를 불러 CPU를 계속 붙잡았다).
  allowOllamaHubAi = true,
  /** "몰 구조분석"(sampleMallProfile)이 넘기면, 허브마다 도는 detectCategoryLinksWithAI의 Groq/Ollama
   *  시도도 같은 로그에 쌓여 VisionProviderBadge로 "어느 모델이 쓰였는지" 보인다(사용자 지시,
   *  2026-09-23). "카테고리 불러오기"(discoverCategoryLinks) 호출부는 이 개념이 없어 안 넘기면 그냥
   *  기록 안 하고 넘어간다(no-op). */
  visionLog?: VisionAttempt[],
  /** "몰 구조분석"(sampleMallProfile)만 넘긴다 — 카테고리 하나가 상품을 직접 보여주는 것으로 확인된 그
   *  순간(=이미 이 페이지를 열어본 시점) 호출돼, 정렬 옵션 확인용 스크린샷+비전 판정을 그 자리에서
   *  시도한다(sampleMallProfile의 tryDetectSortDuringExpansion 주석 참고 — 예전엔 이 확장이 전부 끝난
   *  뒤 별도 단계로 카테고리를 다시 열어 확인했는데, 실측 613.8초까지 걸려 병행 처리로 바꿨다,
   *  2026-09-26). "카테고리 불러오기"(discoverCategoryLinks) 호출부는 안 넘기면 그냥 기록 안 하고
   *  넘어간다(no-op) — 예전과 동일하게 이 경로엔 정렬 확인이 없다. */
  onProductCategoryPage?: (workerPage: Page, link: CategoryMenuLink) => Promise<void>,
): Promise<CategoryExpansionResult> {
  let aiUsed = false
  const profile = PLATFORM_PROFILES[platform]
  const userSel = concurrencyOpts.productLinkSelector || null
  const platformSel = profile.productLinkSelector
  // 플랫폼 프로필에 패턴이 없으면(unknown 몰) 이 몰에서 학습해둔 패턴을 쓴다(deriveDetailUrlPattern).
  const detailPatternSrc = profile.detailUrlPattern?.source ?? concurrencyOpts.detailUrlPattern
  const expandedByIndex: CategoryMenuLink[][] = new Array(categoryLinks.length)
  // 기본값 4 — "몰 구조분석"(profileMallStructure)도 한때 이 호출만 동시성을 1로 강제했었지만(걸스굽
  // 실사용 중 동시 접속이 로그인 세션을 끊는 것처럼 보였던 문제), 진짜 원인은 동시성이 아니라
  // profileMallStructure가 재로그인을 제대로 못 하고 있었던 것이었다(MALL_PROFILE_CONCURRENCY 주석
  // 참고) — 고친 뒤로는 이 호출부도 다른 호출부와 같은 기본값을 그대로 쓴다.
  const EXPAND_CONCURRENCY = Math.min(resolveConcurrency(concurrencyOpts, 4), categoryLinks.length || 1)
  // 대분류 자기 자신의 href 목록 — 어느 카테고리 상세 페이지를 열어도 사이트 전체 대분류 메뉴(GNB)가
  // 항상 그대로 떠 있어, scanCategoryMenuRobust를 그 페이지에서 다시 돌리면 "하위 메뉴"가 아니라 이
  // GNB를 그대로 다시 찾아버릴 수 있다(모자사러 실사용 확인, 2026-08-17). 대분류 자신의 href와 겹치는
  // 항목은 진짜 하위 메뉴가 아니라 그 GNB 재검출이므로 걸러낸다.
  const topLevelHrefSet = new Set(categoryLinks.map(c => canonicalizeHref(c.href)))
  let cursor = 0
  let loginBlockedExpansion = false
  let hubAiAttempts = 0
  const relevantHrefsSeen = new Set<string>()
  // 로그인 벽을 만나면 예전엔 그 카테고리를 미확장인 채로 남기고 넘어갈 뿐, 다시 로그인하지 않았다 —
  // 그 뒤로 방문하는 모든 카테고리가 계속 로그인 벽에 막혀 결과가 통째로 부실해졌다(사용자 지시,
  // 2026-09-15: "로그인 세션이 끊기면 기존 로그인 정보로 재로그인하고 로그아웃 이후의 작업을 재진행" —
  // "로그아웃된 채 계속 진행되다 결국 제대로 분석이 안 됐다는 경고만 뜨는" 상황 자체를 없애는 게 목적).
  // 이 실행 전체에서 재로그인 "시도"는 한 번만 한다 — 비밀번호가 실제로 틀렸거나 계정이 잠긴 경우까지
  // 카테고리 수만큼 매번 다시 시도하면(로그인 페이지 이동+제출+대기로 한 번에 수 초~수십 초) 이미 망한
  // 실행이 몇 배로 더 오래 걸리기만 한다. EXPAND_CONCURRENCY(기본 4)로 여러 카테고리를 동시에 확인하는
  // 중이라 여러 워커가 거의 동시에 로그인 벽을 만날 수 있다 — 단순 boolean 플래그로만 막으면 "먼저 플래그를
  // 켠 워커 하나만 재로그인하고, 그 순간 같이 걸려있던 다른 워커들은 그 결과를 기다리지 않고 곧장 실패로
  // 단정"하는 경합이 생겨 일부 카테고리가 억울하게 로그인 벽 상태로 남는다 — 그러면 결국 이번 목적(경고
  // 메시지 자체를 없애는 것)을 못 이룬다. 진행 중인 하나의 재로그인 Promise를 모든 워커가 함께 기다리게
  // (single-flight) 해서, 동시에 걸린 워커들도 전부 같은 복구 결과를 보고 이어서 재확인할 수 있게 한다.
  let loginRecoveryPromise: Promise<boolean> | null = null
  function recoverLogin(workerPage: Page): Promise<boolean> {
    if (!loginRecoveryPromise) loginRecoveryPromise = recoverSessionLogin(workerPage, siteId, mallName, '허브확장')
    return loginRecoveryPromise
  }
  // 확장을 시작하는 시점의 로그인 상태 — 아래 "빈 허브 배제" 직전에 이 값과 그 페이지의 상태를 비교해,
  // "로그인이 풀려서 비어 보이는 것"과 "진짜 빈 카테고리"를 구분한다(expandOne의 해당 분기 주석 참고).
  const loggedInAtStart = await detectLoggedInSignal(page)
  // 최종 결과에서 빠진 카테고리를 사용자에게 이유와 함께 알려주기 위해 모아둔다(화면 대조 리포트 —
  // categoryScreenCheck). 로그로만 남기면 사용자는 왜 사라졌는지 알 방법이 없다(2026-09-13 사용자 지시:
  // "화면으로 카테고리를 파악했으면 최종 결과가 그 화면과 맞는지, 안 맞는 건 왜인지 피드백해야 한다").
  const excluded: CategoryExclusion[] = []
  // 차단이 감지되면 남은 카테고리 전체를 워커 1개로 낮춰 계속 두드리지 않는다 — 이 실행 안에서는 다시
  // 안 올린다(카테고리 개수가 보통 수십 개 안팎이라, lib/scraper.ts의 상품 스크랩 AIMD처럼 서서히
  // 회복시키면 처리량 대부분이 낮은 동시성에 갇혀 정상 상황(차단이 아예 없는 대다수 몰)에서도 매번
  // 느려진다 — 펫토리 실사용 확인, 2026-08-29). 처음부터 1로 시작하지 않는 것도 같은 이유다.
  let activeLimit = EXPAND_CONCURRENCY
  const BLOCK_RETRY_COUNT = 2
  // 목록이 JS/AJAX로 조금 늦게 그려지는 몰이 있다(투비즈온 실사용 확인, 2026-09-13 — 사용자 지적:
  // "해당 카테고리를 클릭하면 살짝 늦게 열리는데, 그러한 이유로 건너뛴 건 아닌지"). countProductsOnPage는
  // 호출 시점의 DOM만 보는 스냅샷이고 probeOnce는 navigation 직후 곧바로 한 번만 셌다 — 그래서 멀쩡한
  // 카테고리가 "상품 0개"로 잡혀 아래 "빈 허브" 규칙에 걸려 통째로 배제됐다(같은 실행에서 51개 중 32개가
  // 이렇게 빠졌고, 남은 것들도 하나같이 "상품 5개"로 균일했다 — 먼저 그려지는 일부만 센 것으로 보인다).
  // 0개가 나오면 바로 단정하지 말고 상품이 나타날 때까지 짧게 폴링한다. 진짜 빈 카테고리는 이 시간만큼
  // 느려지지만(최대 6초), "있는 카테고리를 없다고 지우는" 쪽이 훨씬 비싼 실수다.
  async function probeOnce(workerPage: Page, href: string, label: string) {
    try {
      await gotoViaLinkClick(workerPage, href, { waitUntil: 'domcontentloaded', timeout: 20_000 })
      return await countProductsSettled(workerPage, userSel, platformSel, detailPatternSrc, baseUrl,
        (first, final, elapsedMs) => console.log(`[허브확장:진단:${mallName}] "${label}" — 첫 스냅샷 ${first}개 → ${(elapsedMs / 1000).toFixed(1)}초 기다린 뒤 ${final}개(늦게 그려지는 목록)`))
    } catch {
      return { count: 0, isLoginPage: false, fingerprint: '', hrefs: [] }
    }
  }
  /** 카테고리 하나를 확장한다 — 상품/하위메뉴/정렬 중 뭘 근거로 판단했든 결과(빈 배열이면 "카테고리
   *  아님")만 돌려준다. 진행률 보고(doneCount 증가)를 호출부 한 곳에만 두기 위해 이 함수 안에서는
   *  early return만 하고 expandedByIndex에 직접 쓰지 않는다. */
  async function expandOne(workerPage: Page, c: CategoryMenuLink): Promise<CategoryMenuLink[]> {
    // 게시판/공지 경로(board/bbs)는 카테고리 목록 페이지 스캔 단계에서도 이미 걸러내는 기준(NON_CATEGORY_PATH_RE)
    // 인데, 최상위 카테고리 링크 자체가 이 경로를 갖고 있으면(예: 걸스굽의 "1:1 상담" 메뉴가 실제로는
    // /board/consult/list.html) 그 필터를 못 거치고 여기까지 넘어온다 — 실제로 방문해서 상품 0개/하위메뉴
    // 0개임을 확인하는 데만 22초 넘게 걸린 사례가 있었다(2026-09-01). 방문 자체를 건너뛰면 그 시간을
    // 통째로 아낄 수 있다.
    if (NON_CATEGORY_PATH_RE.test(safePathname(c.href))) {
      const reason = '게시판/마이페이지 경로라 카테고리가 아니라고 판단'
      console.log(`[허브확장:제외:${mallName}] "${c.name}" — ${reason} (${c.href})`)
      excluded.push({ name: c.name, href: c.href, reason })
      return []
    }
    // 카테고리 하나당 시간이 어디서 새는지(순수 페이지 로딩인지, 봇차단 재시도 슬립인지, AI인지) 사후에
    // 되짚어볼 방법이 전혀 없었다(2026-08-30, 도매토피아 339개 실행 — 전체 소요시간은 보여도 항목별
    // 내역이 안 보여 추측에 의존해야 했음) — 단계별 소요시간을 재서, 이 항목 하나가 느렸으면(8초 이상)
    // 그 이유와 함께 남긴다. 매번 로그를 남기면 카테고리 수만큼 줄이 쌓이니 "느린 것만" 남긴다.
    const itemStart = Date.now()
    let probeMs = 0
    let blockRetryMs = 0
    let probe = await (async () => { const t = Date.now(); const r = await probeOnce(workerPage, c.href, c.name); probeMs += Date.now() - t; return r })()
    // isLoginPage(로그인 폼)와는 별개 신호 — 봇 차단 인터스티셜은 count===0인데 로그인 폼도 없다.
    // 재시도 전에 확인해 진짜 빈 페이지에 매번 isBotBlockPage를 낭비하지 않는다.
    let botBlocked = !probe.isLoginPage && probe.count === 0 && await isBotBlockPage(workerPage)
    let blockRetries = 0
    for (let attempt = 0; botBlocked && attempt < BLOCK_RETRY_COUNT; attempt++) {
      blockRetries++
      const tSleep = Date.now()
      await sleep(5_000 * (attempt + 1))
      blockRetryMs += Date.now() - tSleep
      const tProbe = Date.now()
      probe = await probeOnce(workerPage, c.href, c.name)
      probeMs += Date.now() - tProbe
      botBlocked = !probe.isLoginPage && probe.count === 0 && await isBotBlockPage(workerPage)
    }
    const logIfSlow = (outcome: string) => {
      const totalMs = Date.now() - itemStart
      if (totalMs >= 8_000) {
        console.log(`[허브확장:진단:${mallName}] ${c.href} — ${totalMs}ms(페이지방문 ${probeMs}ms, 차단재시도 ${blockRetryMs}ms, 재시도 ${blockRetries}회) → ${outcome}`)
      }
    }
    if (botBlocked) {
      // 재시도해도 안 풀림 — 원래 항목을 미확장인 채로 남기고, 하위구조 확인 자체가 로그인 벽에 막힌
      // 것과 같은 방식으로 취급한다(shouldKeepPreviousCategoryLinks가 이 신호로 부실한 결과의 캐시
      // 덮어쓰기를 막아준다 — lib/scrape/categoryCachePolicy.ts 참고).
      loginBlockedExpansion = true
      activeLimit = 1
      logIfSlow('차단 지속(그대로 유지)')
      return [c]
    }
    // MALL_REPORT_HINT_KEYWORDS 주석 참고 — 어차피 열어본 페이지니 텍스트 존재 여부만 싸게 한 번 더
    // 확인한다(추가 페이지 이동 없음, evaluate 한 번뿐). 실패해도(페이지가 그새 닫혔거나 등) 카테고리
    // 확장 자체를 막으면 안 되므로 조용히 무시한다.
    const hasReportHint = await workerPage.evaluate(
      pattern => new RegExp(pattern).test(document.body.innerText), MALL_REPORT_HINT_KEYWORDS.source,
    ).catch(() => false)
    if (hasReportHint) relevantHrefsSeen.add(c.href)
    // isLoginPage는 "페이지 어딘가에 비밀번호 입력창이 있다"는 것만 볼 뿐(countProductsOnPage 정의부
    // 주석 참고), 실제 로그인 리다이렉트인지는 구분하지 못한다 — 상품이 정상적으로 있는(count>0)
    // 카테고리에 우연히 무관한 비밀번호 필드(게시판 답글, 쿠폰함 등)가 있어도 그대로 걸려 "로그인
    // 세션이 끊긴 것으로 보임" 경고가 실제로는 멀쩡한 실행에서도 뜨는 문제가 있었다(2026-09-02, 걸스굽
    // 실사용 확인 — count>0인데도 매번 이 경고가 떴다). 진짜 로그인 벽은 상품이 0개인 페이지에서만
    // isLoginPage로 판단한다.
    if (probe.isLoginPage && probe.count === 0) {
      if (await recoverLogin(workerPage)) {
        const t = Date.now()
        probe = await probeOnce(workerPage, c.href, c.name)
        probeMs += Date.now() - t
      }
    }
    if (probe.isLoginPage && probe.count === 0) loginBlockedExpansion = true
    if (probe.isLoginPage) { logIfSlow(`상품 ${probe.count}개`); return [c] }
    // count>0(이 카테고리 자체에도 상품이 있음)이어도 예전엔 여기서 곧장 반환해 하위 메뉴 자체를 아예
    // 확인 안 했다 — "대분류만 나오고 하위 메뉴가 안 나온다"의 실제 원인이었다(진짜양말 실사용 확인,
    // 2026-09-06: "남자양말"이 상품 240개를 직접 보여주면서도 "패션 양말"/"발목단목양말" 등 진짜 하위
    // 메뉴 10개를 같이 갖고 있었는데, 상품이 있다는 이유만으로 그 하위 메뉴를 통째로 무시했음). 이제는
    // 상품이 있어도 하위 메뉴를 마저 확인해서, 있으면 부모(이미 상품이 있는 카테고리 자체)에 추가로
    // 얹어 같이 보여준다(사용자 요청 — "가급적 하위 메뉴 리스트까지 리스트업"). AI 폴백은 원래 상품이
    // 있는 카테고리엔 안 썼는데(이미 유효한 스크랩 대상이 있어 "못 찾으면 버려야 하는" 절박함이 없다는
    // 이유), 펫토리 실사용 확인(2026-09-06)으로 이 판단을 재검토했다 — 이 몰은 대분류 페이지 자체에
    // 상품이 있으면서(hasOwnProducts=true) 동시에 브랜드/재료별 세부분류를 본문 콘텐츠 그리드(사이드바
    // <ul>/<li>가 아님)로도 갖고 있어, 이 제한 때문에 그 세부분류를 AI로도 영영 못 찾았다. 이미
    // MAX_HUB_AI_ATTEMPTS_PER_RUN(실행당 상한)으로 비용을 억제하고 있으므로, hasOwnProducts 여부와
    // 무관하게 규칙 기반이 못 찾았을 때는 AI도 시도한다.
    const hasOwnProducts = probe.count > 0
    if (hasOwnProducts) logIfSlow(`상품 ${probe.count}개(하위 메뉴 확인 중)`)
    // 하위 메뉴 탐지도 최상위 탐지와 같은 이유로 규칙 기반(scanCategoryMenuRobust)을 먼저 시도하고,
    // 실패해야 AI로 폴백한다(discoverTopLevelCategoryLinks 순서 변경, 사용자 요청 2026-08-26과 같은
    // 패턴을 여기도 맞춘다 — 이 함수가 안 맞춰져 있던 게 실제로 "펫토리 몰구조분석 수십 분" 원인이었다,
    // 2026-08-29: 허브 카테고리가 많은 몰은 그 개수만큼 Ollama 전역 대기열에 최대 60초씩 직렬로 쌓여
    // AI를 먼저 타면 몇십 분까지 걸릴 수 있는데, 규칙 기반은 페이지당 즉시 끝난다).
    let realChildren: CategoryMenuLink[]
    const subStart = Date.now()
    const sub = await scanCategoryMenuRobust(workerPage)
    realChildren = sub.links.filter(s => !topLevelHrefSet.has(canonicalizeHref(s.href)))
    // scanCategoryMenuRobust는 <li> 중첩 트리 기반이라, 이 허브 페이지 자체가 "제목+목록 반복" 구조인
    // 카테고리 전체보기형 페이지면(discoverTopLevelCategoryLinks가 최상위 탐지에 쓰는
    // scanCategoryOverviewPage와 같은 패턴) 아무것도 못 찾는다 — 정글북(id=30) 실사용 확인, 2026-09-15:
    // "카테고리" 허브(/category)가 정확히 이 구조라 하위 51개를 전부 놓치고 "상품도 하위메뉴도 없다"며
    // 통째로 제외됐다. 최상위 탐지와 같은 폴백을 여기서도 시도한다.
    if (!realChildren.length) {
      const overview = await scanCategoryOverviewPage(workerPage)
      realChildren = overview.filter(s => !topLevelHrefSet.has(canonicalizeHref(s.href)))
    }
    const subMs = Date.now() - subStart
    let aiMs = 0
    if (!realChildren.length && allowOllamaHubAi && hubAiAttempts < MAX_HUB_AI_ATTEMPTS_PER_RUN) {
      hubAiAttempts++
      const aiSubCandidates = await collectAllPageLinks(workerPage, baseUrl)
      // discoverTopLevelCategoryLinks의 AI 폴백과 같은 이유(위 NON_CATEGORY_TEXT_RE/NON_CATEGORY_PATH_RE
      // 주석 참고, 2026-08-30 소꿉노리) — 규칙 기반(scanCategoryMenuRobust)엔 이 필터가 있지만 AI
      // 결과엔 없어서, 이 허브의 진짜 하위 카테고리를 찾다가 오히려 공지/문의 게시글을 "하위
      // 카테고리"로 잘못 채택하는 사고가 여기서도 그대로 났다.
      const aiStart = Date.now()
      realChildren = (await detectCategoryLinksWithAI(mallName, aiSubCandidates, c.name, signal, undefined, HUB_EXPANSION_AI_TIMEOUT_MS, visionLog).catch(() => []))
        .filter(s => !topLevelHrefSet.has(canonicalizeHref(s.href)) && !isNonCategoryCandidate(s.name, s.href))
      aiMs = Date.now() - aiStart
      if (realChildren.length) aiUsed = true
    }
    // 정렬 옵션 확인 병행 처리(위 onProductCategoryPage 주석 참고) — 이 워커가 지금 이 페이지를 이미 열어
    // 상품이 있음을 확인했고, 이 페이지를 읽기만 하는 나머지 작업(하위 메뉴 스캔)도 다 끝난 시점이라
    // 재방문 없이 바로 스크린샷+비전 판정을 시도할 수 있다 — 위치를 여기로 둔 이유는, 정렬 확인이 화면을
    // 클릭/스크린샷하며 페이지 상태를 건드릴 수 있는데, 그 앞의 scanCategoryMenuRobust 등은 DOM을 읽기만
    // 해서 순서가 바뀌어도 지장이 없는 반면 거꾸로(정렬 확인을 먼저) 하면 그 상태 변화가 하위 메뉴 스캔에
    // 영향을 줄 수 있었기 때문이다. 다른 워커의 진행을 막지 않도록 이 워커 자신만 기다린다
    // (EXPAND_CONCURRENCY만큼 여러 카테고리가 동시에 처리되므로, 이 대기는 다른 카테고리 처리와 자연히
    // 겹쳐 돈다).
    if (hasOwnProducts && onProductCategoryPage) await onProductCategoryPage(workerPage, c).catch(() => {})
    if (realChildren.length) {
      const totalMs = Date.now() - itemStart
      if (totalMs >= 8_000) {
        console.log(`[허브확장:진단:${mallName}] ${c.href} — ${totalMs}ms(페이지방문 ${probeMs}ms, 하위메뉴스캔 ${subMs}ms, AI ${aiMs}ms) → 하위카테고리 ${realChildren.length}개`)
      }
      const childEntries = realChildren.map(s => ({ name: `${c.name} > ${s.name}`, href: s.href }))
      // 상품이 없는 순수 허브는 예전처럼 부모를 하위 카테고리로 완전히 대체한다(부모 자체는 스크랩
      // 대상이 될 수 없으므로). 상품이 있는 카테고리는 부모도 이미 유효한 스크랩 대상이라 하위 메뉴를
      // "더 세분화된 추가 선택지"로 덧붙인다 — 다만 부모와 하위가 상품을 서로 겹쳐 셀 수 있다는 건
      // 기존 "카테고리 겹침" 배지/정확한 총 개수 확인이 이미 다루는 문제라 여기서 새로 막지 않는다.
      return hasOwnProducts ? [c, ...childEntries] : childEntries
    }
    if (hasOwnProducts) { logIfSlow(`상품 ${probe.count}개(하위 메뉴 없음)`); return [c] }
    // 상품도 하위 메뉴도 못 찾은 빈 허브 — 진짜로 상품이 없는 카테고리일 수도 있으니 기본은 그대로
    // 남긴다. 다만 이 페이지에 정렬 옵션조차 하나도 안 보이면(collectSortCandidates — 위 몰 전체 정렬
    // 확인과 같은 가벼운 DOM 판정만, 클릭 검증까지는 안 해 비용이 낮다) 애초에 상품 목록 페이지가
    // 아닐 가능성이 높다고 보고 통째로 뺀다 — 공지/문의 게시판 글이 "상품 0개짜리 빈 허브"로 오인돼
    // 계속 카테고리 목록에 남던 사고(2026-08-30, 소꿉노리)를 막는 안전장치(사용자 승인, 2026-08-30 —
    // 상품이 실제로 있는 카테고리는 위에서 이미 걸러져 이 분기 자체를 안 타므로, 정렬 UI가 없어서
    // 생기는 진짜 카테고리 오탐 위험은 "상품 0개 + 하위메뉴 0개"인 경우로 좁혀져 있다).
    // looksLikeSortLabel만으론 부족했다(실사용 확인, 2026-08-30, 도매토피아) — collectSortCandidates는
    // 페이지 전체 링크를 훑는데, 사이트 공통 헤더의 "신상품"(신상 매칭)/"주문배송조회"(조회 매칭) 같은
    // 무관한 사이트 전역 내비게이션 링크가 키워드에 우연히 걸려 모든 페이지에서 "정렬 있음"으로 오판됐다
    // — 위 "정렬 옵션 확인"(2155-2172행 근처)과 똑같이, diffQueryParams로 "지금 이 허브 페이지와 같은
    // 경로에서 쿼리파라미터만 다른 링크"만 진짜 정렬 후보로 인정해야 다른 페이지로 튀는 내비게이션
    // 링크를 걸러낼 수 있다.
    const hubUrl = workerPage.url()
    const sortCandidates = await collectSortCandidates(workerPage).catch(() => [])
    const hasSort = sortCandidates.some(sc => looksLikeSortLabel(sc.text) && diffQueryParams(hubUrl, sc.href))
    logIfSlow(hasSort ? '정렬 있음(유지)' : '빈 허브(배제)')
    // 제외는 "카테고리가 화면에서 통째로 사라지는" 눈에 띄는 결과인데, logIfSlow는 8초 이상 걸린 항목만
    // 남겨서 빠르게 제외된 카테고리는 흔적조차 없었다 — 사용자가 "뷰티/바디헤어가 목록에 없다"고 신고했을
    // 때(2026-09-13, 투비즈온) 어느 단계에서 빠졌는지 로그로 확인할 방법이 전혀 없었다. 제외만큼은 항상
    // 남긴다(카테고리 수만큼 쌓이지 않는다 — 유지되는 항목은 여전히 조용하다).
    if (!hasSort) {
      // "상품 0개 + 하위메뉴 0개 + 정렬 없음"은 **로그인이 풀린 회원전용 몰의 화면과 구분이 안 된다** —
      // 투비즈온처럼 로그인해야 상품은 물론 카테고리 메뉴조차 안 보이는 몰에서는, 세션이 흔들린 실행
      // 하나가 멀쩡한 카테고리를 통째로 목록에서 지워버린다(2026-09-13 실사용 신고: 메뉴에 있는
      // "뷰티"/"바디/헤어"가 PTP 목록에 없음. 같은 실행에 "로그인 신원쿠키를 30초 안에 못 받음" 경고가
      // 함께 있었다). 그래서 배제 직전에 "이 페이지가 로그인된 상태로 보이는지"를 한 번 더 확인하고,
      // 시작 시점엔 로그인돼 있었는데 지금 화면이 로그아웃 상태로 보이면 배제하지 않고 그대로 둔다.
      // 시작 시점 로그인 신호가 없던 몰(로그인이 필요 없는 몰)은 이 분기를 타지 않으므로, 게시판 글이
      // 빈 허브로 남던 사고(2026-08-30 소꿉노리)를 막던 기존 배제는 그대로 유지된다.
      if (loggedInAtStart === true && await detectLoggedInSignal(workerPage) === false) {
        console.log(`[허브확장:유지:${mallName}] "${c.name}" — 상품/하위메뉴가 안 보이지만 이 페이지가 로그아웃 상태로 보임 → 배제하지 않고 그대로 둔다 (${c.href})`)
        return [c]
      }
      const reason = '이 페이지에 상품도, 하위 메뉴도, 정렬 위젯도 없어 상품 목록 페이지가 아니라고 판단'
      console.log(`[허브확장:제외:${mallName}] "${c.name}" — ${reason} (${c.href})`)
      excluded.push({ name: c.name, href: c.href, reason })
    }
    return hasSort ? [c] : []
  }
  // 서버 쪽엔 개발자모드 확장(extension-poc/background.js의 runExpandCategories)에 이미 있던 카테고리별
  // 진행률 보고가 빠져있었다(2026-08-30 발견 — 도매토피아가 20분 넘게 걸리는 동안 지금 몇 번째를 처리
  // 중인지조차 볼 방법이 없었음). 완료 개수 기준으로 평균 소요시간을 내 남은 개수에 곱하는 식으로 예상
  // 잔여시간도 같이 보여준다 — 사전에 정확히 예측하긴 불가능하니(몇 개가 AI까지 가야 할지는 실제로 돌려
  //봐야 앎), 진행하면서 점점 정확해지는 방식을 택했다.
  const expandStartedAt = Date.now()
  let doneCount = 0
  function reportExpandProgress() {
    if (siteId == null) return
    const elapsedMs = Date.now() - expandStartedAt
    const avgMs = doneCount > 0 ? elapsedMs / doneCount : 0
    const remaining = categoryLinks.length - doneCount
    const etaText = avgMs > 0 && remaining > 0 ? ` — 남은 예상 ${Math.round(avgMs * remaining / 1000)}초` : ''
    setSiteLockDetail(siteId, `카테고리 하위구조 확인 중 (${doneCount}/${categoryLinks.length})${etaText}`)
  }
  async function expandWorker(workerPage: Page, workerIndex: number) {
    while (true) {
      // "카테고리 불러오기" 중지 버튼(stopCategoryDiscovery) — 이미 시작한 페이지 방문은 끝까지 두고,
      // 새 항목만 더 꺼내지 않는다. 남은 인덱스는 expandedByIndex에서 구멍(hole)으로 남아 아래 .flat()이
      // 자연히 건너뛰므로, 지금까지 확인된 부분 결과만 반환된다.
      if (signal?.aborted) return
      while (workerIndex >= activeLimit) {
        if (signal?.aborted) return
        if (cursor >= categoryLinks.length) return
        await sleep(500)
      }
      const i = cursor++
      if (i >= categoryLinks.length) return
      const c = categoryLinks[i]
      // 동시성을 1로 강제한 호출(걸스굽처럼 세션당 동시 연결이 1개까지만 허용되는 몰)에서는, 순차로
      // 방문해도 요청 사이 간격이 거의 없으면(연달아 바로바로) 여전히 세션이 끊겼다(2026-09-01 실사용
      // 확인 — "동시성만 1로 낮췄을 때"와 "동시성 1 + 요청 사이 3초 간격을 뒀을 때"를 직접 비교, 후자만
      // 세션이 유지됨). "동시에 여러 개"뿐 아니라 "쉴 새 없이 연달아"도 이 몰에는 위험 신호였던 것으로
      // 보인다 — 동시성이 1로 강제된 경우에만 이 여유를 둔다(기본 동시성 4로 도는 다른 몰/"카테고리
      // 불러오기"에는 이 지연을 얹지 않는다).
      if (EXPAND_CONCURRENCY === 1 && i > 0) await sleep(3_000)
      expandedByIndex[i] = await expandOne(workerPage, c)
      // 여러 워커가 동시에 완료를 셀 수 있지만(경쟁), 진행률/ETA 표시 용도라 순서가 살짝 뒤바뀌어도
      // 무해하다(await 없는 동기 구간이라 doneCount++ 자체는 원자적).
      doneCount++
      reportExpandProgress()
    }
  }
  if (categoryLinks.length) {
    reportExpandProgress()
    // 첫 워커는 새 탭을 열지 않고 넘겨받은 page(공유 탭)를 그대로 재사용한다 — mapWithPageWorkers와
    // 맞춘 것(2026-09-01). 예전엔 동시성이 1이어도 이 함수는 항상 새 탭을 하나 열었는데, 걸스굽에서는
    // "동시성 1 + 요청 사이 3초 간격"을 줘도 여전히 세션이 끊겼다 — 남은 유일한 차이가 "새 탭을 아예
    // 여는지"였다(mapWithPageWorkers 기반 단계들은 동시성 1이면 새 탭 자체를 안 열어 문제가 없었다).
    // 이 몰이 "로그인한 탭 외의 추가 탭"이 뜨는 것 자체를 세션 무효화 신호로 보는 것으로 추정 — 그렇다면
    // 동시성 1일 땐 새 탭이 하나도 안 생기게 하는 게 근본적인 해결이다.
    const extraPages: Page[] = []
    const workerPromises: Promise<void>[] = [expandWorker(page, 0)]
    for (let idx = 1; idx < EXPAND_CONCURRENCY; idx++) {
      const p = await context.newPage()
      extraPages.push(p)
      workerPromises.push(expandWorker(p, idx))
    }
    await Promise.all(workerPromises)
    await Promise.all(extraPages.map(p => p.close().catch(() => {})))
  }
  let links = expandedByIndex.flat()
  // 서로 다른 대분류 허브가 겹치는 하위 카테고리로 펼쳐지면 같은 href가 두 번 나올 수 있다(모자사러
  // 실사용 확인, 2026-08-18) — 먼저 나온 것을 남기고 뒤에 나온 중복만 제거한다.
  const seenHrefs = new Set<string>()
  links = links.filter(c => {
    const key = canonicalizeHref(c.href)
    return seenHrefs.has(key) ? false : (seenHrefs.add(key), true)
  })
  // 들어온 개수와 나간 개수를 항상 한 줄로 남긴다 — "메뉴에는 있는데 PTP 목록엔 없다"는 신고(2026-09-13,
  // 투비즈온의 뷰티/바디헤어)를 받았을 때, 그게 애초에 못 찾은 것인지(탐지 단계) 찾았다가 여기서 뺀
  // 것인지(확장 단계)부터 갈라볼 수 있어야 한다. 예전에는 이 단계가 51개를 32개로 줄여도 아무 기록이
  // 없었다.
  console.log(`[허브확장:${mallName}] 최상위 ${categoryLinks.length}개 → 최종 ${links.length}개(하위 펼침/제외 ${excluded.length}개/중복제거 반영)${loginBlockedExpansion ? ' — 로그인 벽에 막힌 카테고리가 있었음(결과가 부실할 수 있음)' : ''}`)
  return { links, aiUsed, loginBlockedExpansion, excluded, relevantHrefs: [...relevantHrefsSeen] }
}

async function discoverCategoryLinksInner(opts: ScrapeOptions, signal: AbortSignal | undefined): Promise<CategoryDiscoveryResult> {
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
      // "카테고리 메뉴/구조 탐지"는 sampleMallProfile("몰 구조분석")과 공용 함수(discoverTopLevelCategoryLinks)를
      // 쓴다 — AI(Gemini)를 우선 시도하고 실패하면 기존 셀렉터 히스틱 체인으로 폴백한다(2026-08-18/19).
      const mallName = opts.siteId ? (await siteInfo(opts.siteId)).name : new URL(url).hostname
      const { pattern: categoryUrlPattern, manualSamples: knownCategoryExamples, prevCategoryLinks } = opts.siteId
        ? await getCategoryMemory(opts.siteId) : { pattern: null, manualSamples: [], prevCategoryLinks: [] as CategoryMenuLink[] }
      const { links: topLevelLinks, aiUsed: topLevelAiUsed, screenNames, screenHierarchy, menuLinks } = await discoverTopLevelCategoryLinks(
        context, scanPage, mallName, true, signal, true, categoryUrlPattern, knownCategoryExamples, url,
        platform, opts.productLinkSelector,
      )
      // 대분류=상품목록인 카테고리와 대분류=중분류허브(그 자체엔 상품이 없고 하위 메뉴로만 이어짐)인
      // 카테고리가 섞여 있는 몰이 있다(모자사러 실사용 확인, 2026-08-17) — expandCategoryHubs가 각
      // 카테고리를 실제로 열어 상품 유무를 확인하고, 없으면 하위 메뉴로 대신 펼친다. sampleMallProfile
      // ("몰 구조분석")과 공유하는 함수다(2026-08-27, 절충안 — 몰 구조분석도 어차피 몰에 들어간 김에
      // 같은 캐시를 최신화해둔다).
      const baseUrl = new URL(url).origin
      const expansion = await expandCategoryHubs(context, page, topLevelLinks, mallName, platform, baseUrl, opts, signal, opts.siteId)
      // 화면에 "AI가 실제로 이번 결과에 기여했는지"를 작게 표시해주기 위한 신호(사용자 요청, 2026-08-18) —
      // 최상위 탐지든 허브 하위메뉴 탐지든 AI 결과를 하나라도 그대로 채택했으면 true.
      const aiUsed = topLevelAiUsed || expansion.aiUsed

      // "몰 구조분석"과 같은 화면 대조 + 누락 재검증을 여기서도 그대로 거친다 — 이 과정을 한쪽에만 두면
      // 나중에 돈 쪽이 되살린 카테고리를 다시 떨어뜨리고 캐시까지 덮어써 두 화면의 개수가 갈린다
      // (사용자 지적, 2026-09-13: 몰구조분석 51개 vs 카테고리 불러오기 49개 — screenCheckAndRecover 주석).
      const checked = await screenCheckAndRecover(
        context, mallName, screenNames, menuLinks, expansion.links, expansion.excluded, platform, baseUrl, signal,
        prevCategoryLinks, screenHierarchy,
      )
      const links: CategoryLink[] = checked.links.map(c => ({ href: c.href, text: c.name }))
      return {
        platform, links, loginBlockedExpansion: expansion.loginBlockedExpansion, aiUsed,
        categoryScreenCheck: checked.screenCheck,
      }
    } finally {
      await scanPage.close().catch(() => {})
    }
  }, '카테고리 불러오기')
}

/**
 * "몰 카테고리 선택 가져오기(반복)" 탭 전용 — 사용자가 로그인 창에서 직접 골라 가져온 카테고리 하나가
 * "하위 카테고리 있음"으로 체크되면, 그 카테고리 페이지를 열어 하위 메뉴만 찾아 반환한다. discoverCategoryLinks의
 * expandWorker(대분류를 자동 탐지한 뒤 상품 0개인 허브만 자동으로 펼치는 로직)와 같은 AI→히스틱 폴백을
 * 쓰지만, 자동 최상위 탐지(discoverTopLevelCategoryLinks)를 아예 거치지 않고 사용자가 이미 골라온 URL
 * 하나만 대상으로 한다 — 최상위 탐지가 안 되는 몰(신우 실사용 확인, 2026-08-26: 로컬 Ollama가 후보 많은
 * 프롬프트에서 도구 호출을 못 하고 타임아웃, 규칙 기반 히스틱은 무관한 메뉴를 잘못 집어옴)에서도 "사용자가
 * 직접 대분류를 골라오고, 그 페이지 하나만 펼쳐본다"는 훨씬 좁은 범위라 AI/히스틱 둘 다 성공 확률이 높다.
 */
// 재귀 확장(아래 expandCategoryChildren 주석 참고)이 비정상적으로 큰 트리나 순환 링크를 만났을 때 무한정
// 돌거나 API 호출을 무한정 쓰지 않게 막는 안전판 — 대>중>소>세보다 훨씬 넉넉한 깊이/전체 개수를 둔다.
const EXPAND_CHILDREN_MAX_DEPTH = 6
const EXPAND_CHILDREN_MAX_NODES = 300

/** expandCategoryChildren의 한 단계(어떤 카테고리 하나의 직계 자식만) — 재귀 루프가 매 노드마다 이 함수를
 *  부른다. 원래 expandCategoryChildren 본문 그대로이되, 재귀에서도 캐시/브라우저 컨텍스트를 그대로 재사용할
 *  수 있게 호출부에서 이미 연 context/scanPage를 받는다. */
async function expandOneLevel(
  context: BrowserContext, scanPage: Page, opts: ScrapeOptions, parentUrl: string, parentName: string,
  knownNames: Set<string> = new Set(), ancestorUrls: (string | null)[] = [],
): Promise<{ platform: MallPlatform; links: CategoryLink[]; aiUsed: boolean }> {
  // 몰구조분석이 이미 이 대분류의 하위 구조를 화면 인식(비전)으로 확인해 "대분류 > 소분류" 형태로
  // scrape_profile.categoryLinks에 캐시해뒀으면 그걸 그대로 쓴다 — 이미 검증된 값이라 아래 AI 재추측보다
  // 훨씬 믿을 만하고, 페이지를 새로 열 필요도 없어 빠르다. 캐시에 이 대분류의 하위가 하나도 없으면
  // (아직 몰구조분석을 새로 안 돌렸거나, 원래 하위가 없는 대분류) 기존 AI/DOM 추측으로 폴백한다.
  // 이 폴백(아래 detectCategoryLinksWithAI)은 parentName 없이는(예전엔 클라이언트가 아예 안 보냈다)
  // "지금 보고 있는 카테고리"라는 빈 이름으로 물어야 해서 AI가 어느 대분류인지 전혀 구분 못 하고, 몰
  // 전체 메가메뉴가 모든 페이지에 실려 있는 몰(도매신)에서는 다른 대분류의 하위 카테고리(부츠/털신발·
  // 펌프스/힐이 MEN SHOES 확장에 섞여 들어옴)까지 잘못 집어왔다(사용자 지적, 2026-09-17).
  // prevCategoryLinks(몰구조분석이 마지막으로 저장해둔 전체 카테고리 기억)를 두 가지 용도로 쓴다: (1)
  // 바로 아래 있던 기존 캐시 단축 경로, (2) 그걸로도 부족해 AI/DOM으로 새로 찾아야 할 때 "이미 아는
  // 대분류들"의 href 집합(topLevelHrefSet) — expandCategoryHubs가 같은 문제(topLevelHrefSet 주석 참고,
  // 모자사러 2026-08-17)를 막으려고 쓰는 것과 똑같은 안전장치를 여기(expandCategoryChildren 경로)에도
  // 추가한다. 이 함수는 어느 카테고리 페이지를 열어도 사이트 전체 대분류 메뉴(GNB)가 그대로 떠 있는 몰에서
  // "하위 메뉴가 없는 리프"를 확장 대상으로 체크해도 매번 그 GNB를 통째로 "하위"로 오인해왔다 — 걸스굽
  // 실사용 확인(2026-09-25, 사용자 지적 — "하위카테고리 불러오기 했는데, 하위카테고리가 아닌데?"):
  // 숄더백(리프, 실제 하위 없음)을 확장했더니 AI가 "가격대별"의 세부 구간(0-9,900 등)을 하위로 집어왔고,
  // expandDescendants가 그 오탐까지 또 "하위"로 보고 재귀 확장하며 "스페셜분류 1 > BAG&CLOTHES > 토트백 >
  // 전체상품보기 > 가격대별 > 0 - 9,900 > 가격대별 > 가격대별 > 0 - 9,900"처럼 무관한 이름이 겹겹이
  // 이어붙는 사고로 번졌다. expandCategoryHubs와 달리 이 함수는 전체 대분류 목록을 인자로 안 받으므로
  // (사용자가 URL 하나만 골라 뿌리로 삼는 게 이 함수의 설계 의도 — 위 함수 doc 참고) DB에 저장된 캐시에서
  // 같은 정보를 구한다 — 아직 몰구조분석을 한 번도 안 돌린 몰이면 이 캐시가 비어있어 이 안전장치가 못
  // 걸리는 한계는 있지만, 안 하는 것보다는 낫다.
  const prevCategoryLinks = opts.siteId ? (await getCategoryMemory(opts.siteId)).prevCategoryLinks : []
  if (parentName) {
    const prefix = `${parentName} > `
    const cached = prevCategoryLinks.filter(c => c.name.startsWith(prefix))
    if (cached.length) {
      console.log(`[하위카테고리:진단] "${parentName}" — 몰구조분석 캐시에서 ${cached.length}개 그대로 사용(AI 재추측 건너뜀)`)
      return { platform: 'unknown', links: cached.map(c => ({ href: c.href, text: c.name })), aiUsed: false }
    }
  }
  const topLevelHrefSet = new Set(
    prevCategoryLinks.filter(c => !c.name.includes(' > ')).map(c => canonicalizeHref(c.href)),
  )
  await scanPage.goto(parentUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 })
  await loginIfNeeded(scanPage, { url: parentUrl, ...opts })
  if (opts.loginId && scanPage.url() !== parentUrl) {
    await scanPage.goto(parentUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 }).catch(() => {})
  }
  const platform = await detectMallPlatform(scanPage)
  const site = opts.siteId ? await siteInfo(opts.siteId) : null
  const mallName = site?.name ?? new URL(parentUrl).hostname
  const aiCandidates = await collectAllPageLinks(scanPage, new URL(parentUrl).origin)
  // 위 discoverTopLevelCategoryLinks/expandCategoryHubs의 AI 폴백과 같은 이유(2026-08-30 소꿉노리) —
  // AI 결과에 공지/문의 게시판 링크가 섞여 나와도 걸러낼 필터가 없었다.
  let children = (await detectCategoryLinksWithAI(mallName, aiCandidates, parentName || '지금 보고 있는 카테고리').catch(() => []))
    .filter(c => !isNonCategoryCandidate(c.name, c.href))
  let aiUsed = children.length > 0
  // 실사용 중 "하위 메뉴가 없는 카테고리를 체크했더니 무관한 대분류가 잔뜩 딸려왔다"는 문제가 있었는데
  // (오토카필, 2026-08-27), 이 함수 자체엔 진단 로그가 전혀 없어 서버 로그만으로 원인(정말 하위
  // 메뉴였는지, 아니면 scanCategoryMenuRobust가 GNB를 통째로 재검출한 건지)을 재구성할 수 없었다.
  // discoverCategoryLinks/discoverTopLevelCategoryLinks와 같은 방식으로 진단 로그를 남긴다.
  console.log(`[하위카테고리:진단:${mallName}] ${parentUrl} — AI 후보 ${aiCandidates.length}개, AI 결과 ${children.length}개`)
  if (!children.length) {
    const sub = await scanCategoryMenuRobust(scanPage)
    children = sub.links
    console.log(`[하위카테고리:진단:${mallName}] AI 실패 → 규칙 기반 메뉴 스캔 결과 ${children.length}개(대분류 메뉴 전체를 다시 찾았을 수 있음 — 진짜 하위 메뉴가 아닐 위험)`)
  }
  // scanCategoryMenuRobust가 대분류 메뉴(GNB)를 다시 찾아버리면 방문한 그 페이지 자신으로 되돌아오는
  // 항목이 섞일 수 있다(discoverCategoryLinks의 expandWorker와 같은 이유) — 자기 자신은 제외한다.
  const parentNorm = parentUrl.replace(/\/+$/, '')
  const beforeTopLevelFilter = children.length
  children = children.filter(c => c.href.replace(/\/+$/, '') !== parentNorm && !topLevelHrefSet.has(canonicalizeHref(c.href)))
  if (topLevelHrefSet.size && children.length < beforeTopLevelFilter) {
    console.log(`[하위카테고리:진단:${mallName}] 이미 아는 대분류 GNB 재검출 ${beforeTopLevelFilter - children.length}개 제외(진짜 하위 후보 ${children.length}개 남음)`)
  }
  let links: CategoryLink[] = children.map(c => ({ href: c.href, text: parentName ? `${parentName} > ${c.name}` : c.name }))
  // 둘 다 실패했으면(하위 카테고리 정보가 이 페이지 자체엔 아예 없는 몰일 수 있다 — expandCategoryChildrenByVision
  // 주석 참고, 도매창고 실사용 확인) 화면을 사람처럼 열어가며 찾는 마지막 수단을 시도한다. parentName이
  // 없으면(호출부가 이름을 안 보냈으면) 화면에서 어느 항목을 클릭해야 할지 알 수 없어 건너뛴다.
  if (!links.length && parentName && site) {
    console.log(`[하위카테고리:진단:${mallName}] AI/DOM 둘 다 실패 — 화면 인식으로 마지막 시도`)
    // 이미 확정된 이름들(DB에 저장된 대분류 + 이번 재귀 확장 중 이미 찾아낸 형제들)을 넘겨, 펼친 화면에
    // 다른 레벨의 메뉴가 같이 찍혀도 하위로 오인하지 않게 한다(expandCategoryChildrenByVision 내부 주석
    // 참고). knownNames가 없으면(재귀 없이 이 함수 하나만 부르는 호출) DB에 저장된 대분류만으로도 최소한의
    // 방어가 된다.
    const knownTopLevelNames = opts.siteId
      ? (await getCategoryMemory(opts.siteId)).prevCategoryLinks
        .filter(c => !c.name.includes(' > '))
        .map(c => c.name)
      : []
    const visionLinks = await expandCategoryChildrenByVision(
      context, scanPage, mallName, site.url, parentUrl, parentName, platform, opts.productLinkSelector, undefined,
      Array.from(new Set([...knownTopLevelNames, ...knownNames])), ancestorUrls,
    ).catch(() => [])
    if (visionLinks.length) {
      links = visionLinks
      aiUsed = false
    }
  }
  console.log(`[하위카테고리:진단:${mallName}] 최종 ${links.length}개 반환 (aiUsed=${aiUsed}): ${links.slice(0, 5).map(l => l.text).join(', ')}${links.length > 5 ? ' 등' : ''}`)
  return { platform, links, aiUsed }
}

/** expandOneLevel이 찾은 직계 자식 각각을, 더 이상 하위가 없을 때까지(=expandOneLevel이 빈 배열을 돌려줄
 *  때까지) 계속 파고든다 — depth-first. "DVD"처럼 자기 페이지엔 상품이 0개고 그 아래 소분류(교육/드라마/
 *  뮤직비디오)에만 진짜 상품이 있는 몰(도매창고 실사용 확인, 2026-09-21)에서, 대>중 한 단계만 찾고 멈추면
 *  안 된다는 사용자 지적으로 추가 — 대>중>소>세, 몇 단계든 화면에 더 보이는 한 계속 내려간다. */
async function expandDescendants(
  context: BrowserContext, scanPage: Page, opts: ScrapeOptions, url: string, name: string, depth: number,
  visited: Set<string>, budget: { remaining: number }, knownNames: Set<string>, ancestorUrls: (string | null)[],
): Promise<CategoryLink[]> {
  if (depth >= EXPAND_CHILDREN_MAX_DEPTH || budget.remaining <= 0) return []
  budget.remaining--
  const result = await expandOneLevel(context, scanPage, opts, url, name, knownNames, ancestorUrls).catch(() => null)
  if (!result?.links.length) return []
  // 지금 막 찾은 형제들을 공용 목록에 더해둔다 — 더 깊이 들어가 화면을 다시 찍을 때, 옆에 남아있는 이
  // 형제들(예: DVD 하위를 보는 화면에 생활/건강의 다른 중분류들이 같이 찍혀도) 하위로 오인하지 않게 한다.
  for (const child of result.links) knownNames.add(child.text)
  // 지금 이 노드 자신의 URL도 다음 단계(child)에겐 "조상의 확인된 URL"이 된다 — 이걸 넘겨야 더 깊은
  // 단계에서 비전이 중간 구간 이름을 잘못 읽어도(위 expandCategoryChildrenByVision 주석 참고, 2026-09-21
  // "DVD"의 부모 "생활 / 건강" 오독 사례) id 대조로 대신 찾을 수 있다.
  const childAncestorUrls = [...ancestorUrls, url]
  const out: CategoryLink[] = []
  for (const child of result.links) {
    if (visited.has(child.href) || budget.remaining <= 0) continue
    visited.add(child.href)
    out.push(child)
    out.push(...await expandDescendants(context, scanPage, opts, child.href, child.text, depth + 1, visited, budget, knownNames, childAncestorUrls))
  }
  return out
}

/**
 * "몰 카테고리 선택 가져오기(반복)" 탭 전용 — 사용자가 로그인 창에서 직접 골라 가져온 카테고리 하나가
 * "하위 카테고리 있음"으로 체크되면, 그 카테고리 아래를 상품이 나오는 리프에 닿을 때까지 재귀적으로 끝까지
 * 펼쳐 반환한다(사용자 지시, 2026-09-21 — "각 카테고리 하위에 많은 하위 카테고리들이 있는데 왜 이건
 * 안보여주는거야?": 대>중까지만 찾고 멈춰 그 아래 소>세 단계를 놓치고 있었다. 버튼 한 번 클릭으로 그
 * 카테고리 서브트리 전체를 자동으로 끝까지 확인하기로 함). discoverCategoryLinks의 expandWorker(대분류를
 * 자동 탐지한 뒤 상품 0개인 허브만 자동으로 펼치는 로직)와 같은 AI→휴리스틱→화면인식 폴백을 매 단계마다
 * 그대로 쓰지만, 자동 최상위 탐지(discoverTopLevelCategoryLinks)를 아예 거치지 않고 사용자가 이미 골라온
 * URL 하나만 뿌리로 삼는다 — 최상위 탐지가 안 되는 몰(신우 실사용 확인, 2026-08-26)에서도 "사용자가 직접
 * 대분류를 골라오고, 그 아래를 펼쳐본다"는 훨씬 좁은 범위라 성공 확률이 높다.
 */
export async function expandCategoryChildren(
  opts: ScrapeOptions, parentUrl: string, parentName: string,
): Promise<{ platform: MallPlatform; links: CategoryLink[]; aiUsed: boolean }> {
  // 최상위 자체가 이미 캐시로 다 있으면(예: 이 서브트리를 예전에 한 번 다 펼쳐 저장해둔 경우) 브라우저를
  // 아예 열 필요도 없다 — expandOneLevel 안에도 같은 체크가 있지만(재귀 중 더 깊은 노드용), 최상위는 여기서
  // 먼저 확인해야 이 빠른 경로(페이지 안 열고 즉시 반환)를 살릴 수 있다.
  if (parentName && opts.siteId) {
    const { prevCategoryLinks } = await getCategoryMemory(opts.siteId)
    const prefix = `${parentName} > `
    const cached = prevCategoryLinks.filter(c => c.name.startsWith(prefix))
    if (cached.length) {
      console.log(`[하위카테고리:진단] "${parentName}" — 몰구조분석 캐시에서 ${cached.length}개 그대로 사용(AI 재추측 건너뜀)`)
      return { platform: 'unknown', links: cached.map(c => ({ href: c.href, text: c.name })), aiUsed: false }
    }
  }
  return withContext(opts, async (_page, context) => {
    const scanPage = await context.newPage()
    try {
      const knownNames = new Set<string>()
      const first = await expandOneLevel(context, scanPage, opts, parentUrl, parentName, knownNames)
      for (const child of first.links) knownNames.add(child.text)
      const visited = new Set<string>([parentUrl, ...first.links.map(l => l.href)])
      const budget = { remaining: EXPAND_CHILDREN_MAX_NODES }
      // parentName 자신의 구간들 중 마지막(=parentUrl)만 URL을 안다 — 나머지 앞쪽 구간(사용자가 이미 여러
      // 단계 중첩된 이름을 골라온 드문 경우)은 기존과 같이 모른다.
      const topSegmentCount = parentName.split(' > ').map(s => s.trim()).filter(Boolean).length || 1
      const topAncestorUrls: (string | null)[] = Array(Math.max(0, topSegmentCount - 1)).fill(null).concat([parentUrl])
      const allLinks = [...first.links]
      for (const child of first.links) {
        if (budget.remaining <= 0) break
        allLinks.push(...await expandDescendants(context, scanPage, opts, child.href, child.text, 1, visited, budget, knownNames, topAncestorUrls))
      }
      if (allLinks.length !== first.links.length) {
        console.log(`[하위카테고리:진단] "${parentName}" — 재귀 확장으로 ${first.links.length}개 → 총 ${allLinks.length}개(더 깊은 단계 포함)`)
      }
      return { platform: first.platform, links: allLinks, aiUsed: first.aiUsed }
    } finally {
      await scanPage.close().catch(() => {})
    }
  }, '카테고리 하위구조 확인')
}
