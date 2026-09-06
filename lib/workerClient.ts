import { Agent } from 'undici'
import type {
  ScrapeOptions, ScrapeResult, MallProfileSignals, CatalogPreviewResult,
  RecheckTarget, RecheckResult, CategoryDiscoveryResult, CategoryLink, MallPlatform, MallSortOption,
} from './scraper'
import type { ProfileCheckResult } from './scrape/mallProfile'
import type { RunScrapingOpts } from './scrape/run'
import type { ExtractedProduct, ExtractionRule, AiProviderId } from './ai'
import { ALL_AI_PROVIDERS } from './ai'

// Next.js 서버 프로세스에서 부르는 쪽 — 실제 실행은 전부 별도 워커 프로세스(worker/index.ts)에서
// 일어난다(2026-08-23, Fast Refresh 강제 새로고침 원인이었던 CPU 경합을 없애기 위한 분리). 여기 있는
// 함수들은 lib/scraper.ts에 있던 것과 이름·모양이 같지만, 실제로는 로컬 HTTP로 워커에 위임하는 얇은
// 껍데기다 — 예전엔 동기 함수였던 것(getOpenPageUrl 등)도 이제 항상 Promise를 돌려주니, 호출부에
// await을 추가해야 한다.
const WORKER_URL = `http://127.0.0.1:${process.env.WORKER_PORT || 4801}`

// fetch(undici)의 기본 headersTimeout/bodyTimeout이 각각 300초라, runScraping처럼 몇 분~몇 시간 걸리는
// 호출은 실제로는 워커 안에서 멀쩡히 계속 도는데도 5분을 넘기는 순간 이 fetch 쪽만 "UND_ERR_HEADERS_TIMEOUT"로
// 끊겨버린다 — app/api/scrape/route.ts·lib/scheduler.ts의 .catch()가 이걸 그대로 세션 상태를
// 'error'로 기록해, 화면엔 실패로 보이는데 워커는 아무 것도 모른 채 계속 스크랩하는 불일치가 생긴다
// (2026-08-23 재점검 중 발견 — "타임아웃을 걸지 않는다"는 기존 의도가 undici 기본값 때문에 실제로는
// 지켜지지 않고 있었다). 로컬호스트 전용 신뢰된 채널이라 두 타임아웃 모두 끈다(0 = 비활성화).
const workerDispatcher = new Agent({ headersTimeout: 0, bodyTimeout: 0 })

interface RpcOk<T> { ok: true; id: string; result: T }
interface RpcErr { ok: false; id: string; error: string }

/** 워커가 막 뜬 시점(Next.js 서버 시작 직후)에는 아직 포트를 안 열었을 수 있다 — 연결 자체가 거부되면
 *  (ECONNREFUSED) 워커 기동이 끝날 때까지 짧게 재시도한다. 워커가 응답은 했지만 그 안에서 함수가 실패한
 *  경우(ok:false)는 재시도하지 않고 그대로 에러를 던진다 — 그건 재시도해도 똑같이 실패할 원인이다. */
async function callWorker<T>(fn: string, args: unknown[], opts?: { signal?: AbortSignal }): Promise<T> {
  const id = crypto.randomUUID()
  let lastConnectError: unknown = null
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      const res = await fetch(`${WORKER_URL}/rpc`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, fn, args }),
        signal: opts?.signal,
        dispatcher: workerDispatcher,
      } as RequestInit)
      const data = await res.json() as RpcOk<T> | RpcErr
      if (!data.ok) throw new Error(data.error)
      return data.result
    } catch (e) {
      // 호출부(브라우저)가 스스로 중지시킨 경우는 재시도하지 않고 그대로 전파한다.
      if (e instanceof Error && e.name === 'AbortError') throw e
      // fetch가 워커 프로세스에 연결 자체를 못 한 경우(막 기동 중)거나, 연결은 됐지만 응답 바디가
      // 불완전해 JSON 파싱이 깨진 경우만 재시도 — 그 외(워커가 정상 응답했지만 함수 실행 자체가 실패한
      // 경우)는 바로 던진다. SyntaxError도 일시적 문제로 보고 재시도 대상에 넣은 이유: 워커가 "몰
      // 구조분석"처럼 탭 여러 개로 동시에 무거운 작업을 하느라 바쁠 때, 연결은 됐는데 응답 바디가
      // 잘려서 와 res.json()이 "Unexpected end of JSON input"으로 죽는 게 실사용에서 확인됐다
      // (2026-09-01, /api/scrape/site-lock-status가 500으로 튀어 화면에 노출됨) — 이런 경우도 조금
      // 기다렸다 다시 물어보면 대개 풀린다.
      const isConnectError = e instanceof TypeError || e instanceof SyntaxError || (e as { cause?: { code?: string } })?.cause?.code === 'ECONNREFUSED'
      if (!isConnectError) throw e
      lastConnectError = e
      await new Promise(r => setTimeout(r, 250))
    }
  }
  throw new Error(`워커 프로세스에 연결할 수 없거나 응답을 읽지 못했습니다(worker/index.ts가 실행 중인지, 과부하 상태는 아닌지 확인하세요): ${lastConnectError instanceof Error ? lastConnectError.message : String(lastConnectError)}`)
}

// ── 상태 조회/기록 ──────────────────────────────────────────────────────────
export const getOpenPageUrl = (siteId: number) => callWorker<string | null>('getOpenPageUrl', [siteId])
export const navigateOpenPageTo = (siteId: number, url: string) => callWorker<{ url: string; loggedIn: boolean | null } | null>('navigateOpenPageTo', [siteId, url])
export const requestStop = (sessionId: number) => callWorker<void>('requestStop', [sessionId])
export const isStopRequested = (sessionId?: number) => callWorker<boolean>('isStopRequested', [sessionId])
export const clearStopRequest = (sessionId: number) => callWorker<void>('clearStopRequest', [sessionId])
export const getCollectProgress = (sessionId: number) => callWorker<{ done: number; total: number } | null>('getCollectProgress', [sessionId])
export const setCollectProgress = (sessionId: number, done: number, total: number) => callWorker<void>('setCollectProgress', [sessionId, done, total])
export const getSiteLockStatus = (siteId: number) => callWorker<{ label: string; sinceMs: number; detail?: string } | null>('getSiteLockStatus', [siteId])
export const setSiteLockDetail = (key: number | string, detail: string) => callWorker<void>('setSiteLockDetail', [key, detail])
export const isAnySiteBusy = () => callWorker<boolean>('isAnySiteBusy', [])
export const getPreviewProgress = (siteId: number) => callWorker<{ done: number; total: number; result?: CatalogPreviewResult; earlyPreview?: ScrapeResult | null } | null>('getPreviewProgress', [siteId])
export const stopProfileAnalysis = (siteId: number) => callWorker<boolean>('stopProfileAnalysis', [siteId])

// ── 로그인 창 ────────────────────────────────────────────────────────────
export const openLoginWindow = (siteId: number, opts: { url: string; loginId?: string; loginPw?: string }) => callWorker<void>('openLoginWindow', [siteId, opts])
export const openManualLoginWindow = (siteId: number, url: string) => callWorker<void>('openManualLoginWindow', [siteId, url])
export const openUrlInLoginWindow = (siteId: number, url: string) => callWorker<void>('openUrlInLoginWindow', [siteId, url])
export const focusManualLoginChrome = () => callWorker<boolean>('focusManualLoginChrome', [])

// ── 단발 스크랩/추출 ──────────────────────────────────────────────────────
export const scrapeSingleProduct = (opts: ScrapeOptions) => callWorker<ScrapeResult>('scrapeSingleProduct', [opts])
export const fetchPageText = (opts: ScrapeOptions & { url: string }) => callWorker<string>('fetchPageText', [opts])
export const extractFromHtml = (html: string, url: string, extractionRules?: Record<string, ExtractionRule>) =>
  callWorker<ExtractedProduct>('extractFromHtml', [html, url, extractionRules])
export const startElementPicker = (siteId: number, previewProduct?: Record<string, unknown> | null, targetUrl?: string) =>
  callWorker<boolean>('startElementPicker', [siteId, previewProduct, targetUrl])

// ── 몰 구조분석 ───────────────────────────────────────────────────────────
export const runMallStructureReport = (siteId: number, aiProviders: AiProviderId[] = ALL_AI_PROVIDERS) => callWorker<ProfileCheckResult | null>('runMallStructureReport', [siteId, aiProviders])
export const runMallProfileCheckForScrape = (opts: ScrapeOptions) => callWorker<ProfileCheckResult | null>('runMallProfileCheckForScrape', [opts])

// ── 카테고리/재확인/재추출 ─────────────────────────────────────────────────
export const discoverCategoryLinks = (opts: ScrapeOptions) => callWorker<CategoryDiscoveryResult>('discoverCategoryLinks', [opts])
export const stopCategoryDiscovery = (siteId: number) => callWorker<boolean>('stopCategoryDiscovery', [siteId])
export const expandCategoryChildren = (opts: ScrapeOptions, parentUrl: string, parentName: string) =>
  callWorker<{ platform: MallPlatform; links: CategoryLink[]; aiUsed: boolean }>('expandCategoryChildren', [opts, parentUrl, parentName])
export const detectSortOptionsForCategory = (opts: ScrapeOptions, categoryUrl: string) =>
  callWorker<MallSortOption[]>('detectSortOptionsForCategory', [opts, categoryUrl])
export const recheckMallProducts = (opts: ScrapeOptions, targets: RecheckTarget[]) => callWorker<RecheckResult[]>('recheckMallProducts', [opts, targets])
export const reExtractStagingItems = (ids: number[]) => callWorker<{ updated: number[]; failed: { id: number; error: string }[] }>('reExtractStagingItems', [ids])

// ── 실제 스크랩 시작 ──────────────────────────────────────────────────────
// 예전(같은 프로세스에서 직접 호출)과 같은 fire-and-forget 방식 — 호출부(app/api/scrape/route.ts,
// lib/scheduler.ts)가 await 없이 .catch()만 붙여 쓴다. 이 호출 자체는 워커 안에서 몇 분~몇 시간 걸릴 수
// 있으니, 다른 RPC와 달리 여기서는 fetch에 타임아웃을 걸지 않는다(callWorker 공용 재시도 로직 그대로 사용).
export const runScraping = (sessionId: number, opts: RunScrapingOpts) => callWorker<void>('runScraping', [sessionId, opts])

// ── "중지" 버튼(브라우저의 fetch abort)으로 취소되는 것들 — signal을 그대로 전달한다 ──────────────
export const previewCatalog = (opts: ScrapeOptions, signal?: AbortSignal) => callWorker<CatalogPreviewResult>('previewCatalog', [opts], { signal })
export const countDedupedProductUrls = (opts: ScrapeOptions, signal?: AbortSignal) =>
  callWorker<{ total: number; needsLogin: boolean; stopped: boolean }>('countDedupedProductUrls', [opts], { signal })
export const countCategoryOverlap = (opts: ScrapeOptions, signal?: AbortSignal) =>
  callWorker<{
    categories: { url: string; count: number; uniqueCount: number; duplicateCount: number }[]
    total: number; needsLogin: boolean; stopped: boolean
  }>('countCategoryOverlap', [opts], { signal })

// ── lib/images.ts 전용 ────────────────────────────────────────────────────
export const fetchImageViaBrowser = (siteId: number, urls: string[]) => callWorker<Record<string, string>>('fetchImageViaBrowser', [siteId, urls])

// MallProfileSignals는 다른 파일들이 이 모듈을 거쳐 타입만 재사용할 수 있게 재노출한다(예: ScraperPanel.tsx
// 쪽은 아니고, 서버 라우트가 결과 타입을 그대로 쓰는 경우).
export type { MallProfileSignals }
