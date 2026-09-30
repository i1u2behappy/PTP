import pool from '../db'
import { scrapeSingleProduct, scrapeCatalogPage, detectIsListingPage } from '../scraper'
import { stageScrapedProduct } from './staging'
import type { ScrapeResult } from '../scraper'
import type { ExtractionRule } from '../ai'

export interface RunScrapingOpts {
  url?: string
  categoryUrls?: string[]
  productUrls?: string[]
  nextPageSelector?: string
  maxPages?: number
  /** "카테고리별 정렬기준 설정" 기능용 — categoryUrls 각 URL에 대한 개별 상한(lib/scraper.ts의
   *  ScrapeOptions.categoryLimits와 동일한 모양). */
  categoryLimits?: Record<string, { mode: 'count' | 'pages'; value: number }>
  /** AJAX(클릭) 방식 정렬용 — lib/scraper.ts의 ScrapeOptions.categorySortClicks와 동일한 모양. */
  categorySortClicks?: Record<string, string>
  /** true(기본)면 이미 성공적으로 스크랩한 상품도 다시 스크랩 대상에 포함한다 — 위에서 선택한 카테고리
   *  전체를 대상으로 "다시 받는" 것이 기본 기대이기 때문(사용자 지시, 2026-08-23). false면 이미 성공한
   *  상품(scrape_item_log 기준, 아래 skipAlreadyScraped 주석 참고)은 건너뛴다. */
  includeAlreadyScraped?: boolean
  delayMs?: number
  loginId?: string
  loginPw?: string
  productLinkSelector?: string
  mode: 'single' | 'catalog'
  scrapeMode?: 'full' | 'incremental'
  siteId: number
  concurrencyMode?: 'auto' | 'manual'
  concurrency?: number
}

async function saveProduct(siteId: number, sessionId: number, r: ScrapeResult) {
  // mall_products는 여기서 바로 갱신하지 않는다 — 결과는 scrape_staging_items에 대기하고,
  // 사용자가 "스크랩 검토" 화면에서 확인 후 병합해야 반영된다.
  await stageScrapedProduct({ siteId, sessionId }, r)
}

/** 스크랩 세션 하나를 실제로 실행한다. API 라우트와 예약/일괄 재스크랩 스케줄러가 공유한다. */
export async function runScraping(sessionId: number, opts: RunScrapingOpts) {
  const siteId = opts.siteId
  const scrapeMode = opts.scrapeMode || 'full'

  // 로그인 확인용으로 열어둔 화면이 있으면 억지로 닫지 않는다 — withContext가 그 화면이 열려있으면
  // 그대로 재사용하고(닫으면 화면 밖으로), 없으면 알아서 백그라운드(헤드리스)로 새로 띄운다. 예전엔
  // 여기서 무조건 먼저 닫아버려서, 사용자가 그 창에서 캡차/본인인증 등을 마저 처리해야 하는 상품이
  // 실패했을 때 "실패 재시도"를 눌러도 그 창이 다시 닫혀버려 같은 이유로 계속 실패했다.

  // 이미 스크랩된 상품(같은 몰)을 건너뛸지 — "이어서 스크랩하기"(중단된 세션 재시작 등)나
  // includeAlreadyScraped=false(사용자가 명시적으로 신상품만 원할 때)에서만 건너뛴다. 기본(true)은
  // 위에서 선택한 카테고리 전체를 그대로 다시 대상으로 삼는다(사용자 지시, 2026-08-23 — "전체 카테고리
  // 기준이건 일부 선택한 카테고리 기준이건... 이미 스크랩한 상품 포함 옵션을 디폴트로"). 포함하는
  // 경우엔 이 목록 자체가 필요 없으니 쿼리도 건너뛴다.
  //
  // 기준은 mall_products가 아니라 scrape_item_log의 성공 기록이다(2026-10-01 변경, 사용자 지적) —
  // mall_products는 "스크랩 검토" 화면에서 사용자가 직접 병합해야만 채워지는데, "이어서 하기"는 검토를
  // 거치기 전인 작업 도중(진행 상황 카드가 아직 떠 있는 상태)에 누르는 버튼이다. mall_products 기준이면
  // "1233개 수집 완료"가 아직 병합 전이라 하나도 제외되지 않아 처음부터 다 다시 도는 게 실제 버그였다
  // (다음 단계로 넘어가 병합하고 이 화면으로 돌아와야만 제외되는 건 "이어서 하기"의 기대와 다르다는
  // 지적). 개발자모드(app/api/sites/resolve/route.ts)는 애초부터 같은 이유로 scrape_item_log를 써왔으므로
  // (2026-08-22) 그 기준을 일반모드에도 그대로 맞춘다 — 병합 여부와 무관하게 "성공적으로 수집된 URL"만
  // 빠지고, 실패한 건 여기 안 걸려(status != 'success') 자연히 "나머지"에 포함돼 다시 시도된다. 실패한
  // 것만 콕 집어 재시도하고 싶으면 별도의 "실패 N개 재시도"(app/api/scrape/failed-urls)를 쓴다.
  const skipAlreadyScraped = scrapeMode !== 'incremental' && opts.includeAlreadyScraped === false
  const excluded = skipAlreadyScraped
    ? await pool.query<{ url: string }>(
        `SELECT DISTINCT l.url FROM scrape_item_log l
         JOIN scrape_sessions s ON s.id = l.session_id
         WHERE s.site_id=$1 AND l.status='success'`,
        [siteId],
      )
    : { rows: [] as { url: string }[] }

  const siteRes = await pool.query<{
    custom_name_selector: string | null; custom_price_selector: string | null; custom_thumbnail_selector: string | null
    extraction_rules: Record<string, ExtractionRule> | null
  }>(
    `SELECT custom_name_selector, custom_price_selector, custom_thumbnail_selector, extraction_rules FROM sites WHERE id=$1`,
    [siteId],
  )
  const site = siteRes.rows[0]

  const scrapeOpts = {
    url: opts.url, categoryUrls: opts.categoryUrls, productUrls: opts.productUrls,
    nextPageSelector: opts.nextPageSelector, maxPages: opts.maxPages, categoryLimits: opts.categoryLimits,
    categorySortClicks: opts.categorySortClicks, delayMs: opts.delayMs,
    loginId: opts.loginId, loginPw: opts.loginPw, productLinkSelector: opts.productLinkSelector, siteId,
    concurrencyMode: opts.concurrencyMode, concurrency: opts.concurrency,
    excludeUrls: excluded.rows.map(r => r.url), sessionId,
    nameSelector: site?.custom_name_selector || undefined,
    priceSelector: site?.custom_price_selector || undefined,
    thumbnailSelector: site?.custom_thumbnail_selector || undefined,
    extractionRules: site?.extraction_rules || undefined,
  }

  // '단일 상품' 모드로 시작했어도 실제로는 상품이 여럿인 카테고리 URL을 넣는 실수가 흔하다 — 링크가
  // 여럿 발견되면 자동으로 카탈로그(전체 순회) 모드로 전환한다. (반대 방향: 카탈로그 모드인데 상품 링크가
  // 0개면 scrapeCatalogPage가 그 페이지 자체를 상품 1건으로 보고 스크랩한다.)
  let effectiveMode = opts.mode
  if (effectiveMode === 'single' && !opts.productUrls?.length) {
    const isListing = await detectIsListingPage(scrapeOpts).catch(() => false)
    if (isListing) effectiveMode = 'catalog'
  }

  if (effectiveMode === 'single') {
    const result = await scrapeSingleProduct(scrapeOpts)
    await saveProduct(siteId, sessionId, result)
    await pool.query(`UPDATE scrape_sessions SET status='done', product_count=1, finished_at=NOW() WHERE id=$1`, [sessionId])
    return
  }

  const { total, stopped, concurrencyLog } = await scrapeCatalogPage(scrapeOpts, async ({ total, url, result, error }) => {
    await pool.query(`UPDATE scrape_sessions SET product_count=$1 WHERE id=$2`, [total, sessionId])
    await pool.query(
      `INSERT INTO scrape_item_log (session_id, url, status, error) VALUES ($1,$2,$3,$4)`,
      [sessionId, url, result ? 'success' : 'failed', error || null],
    )
    if (result) await saveProduct(siteId, sessionId, result)
  })

  // 단종 추정 판정은 스테이징 결과가 실제 병합된 뒤에만 의미가 있으므로 여기서 하지 않는다
  // (lib/scrape/staging.ts의 mergeSessionStaging에서 병합 시점에 수행).
  await pool.query(
    `UPDATE scrape_sessions SET status=$1, product_count=$2, concurrency_log=$3, finished_at=NOW() WHERE id=$4`,
    [stopped ? 'stopped' : 'done', total, JSON.stringify(concurrencyLog), sessionId],
  )
}
