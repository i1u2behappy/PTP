import { NextRequest, NextResponse } from 'next/server'
import { persistCategoryCounts } from '@/lib/scraper'
import { previewCatalog, getOpenPageUrl } from '@/lib/workerClient'
import pool from '@/lib/db'
import type { ExtractionRule } from '@/lib/ai'

/** 카탈로그(목록) 모드용 — 상품 개수 확인과 첫 상품 미리보기를 한 번에 처리한다. */
export async function POST(req: NextRequest) {
  const body = await req.json() as {
    url?: string; categoryUrls?: string[]; nextPageSelector?: string; maxPages?: number
    productLinkSelector?: string; loginId?: string; loginPw?: string; siteId?: number; aiMode?: boolean
    concurrencyMode?: 'auto' | 'manual'; concurrency?: number
    /** AJAX(클릭) 방식 정렬용 — ScrapeOptions.categorySortClicks 참고 */
    categorySortClicks?: Record<string, string>
  }

  const resolvedUrl = body.url || body.categoryUrls?.[0] || (body.siteId ? await getOpenPageUrl(body.siteId) : null)
  if (!resolvedUrl) return NextResponse.json({ error: 'url required' }, { status: 400 })

  try {
    // "스크랩 대상 직접지정"으로 저장한 그 몰 전용 규칙을 미리보기에도 동일하게 적용한다 (app/api/scrape/preview 참고).
    let extractionRules: Record<string, ExtractionRule> | undefined
    // "몰 구조분석"이 이미 이 몰엔 읽을 수 있는 페이지네이션 위젯이 없다고 확인해뒀으면, 카테고리별
    // 개수 집계가 매번 같은 확인을 반복하지 않고 곧장 지수+이분 탐색으로 넘어가게 한다(knownNoPaginationWidget
    // 참고) — "몰구조파악 한 내용은 미리보기/스크래핑 때 반드시 참조돼야 한다"는 기존 원칙과 동일.
    let knownNoPaginationWidget = false
    if (body.siteId) {
      const res = await pool.query<{ extraction_rules: Record<string, ExtractionRule> | null, scrape_profile: { hasPaginationWidget?: boolean } | null }>(
        'SELECT extraction_rules, scrape_profile FROM sites WHERE id=$1', [body.siteId],
      )
      extractionRules = res.rows[0]?.extraction_rules || undefined
      knownNoPaginationWidget = res.rows[0]?.scrape_profile?.hasPaginationWidget === false
    }
    // 사용자가 미리보기 도중 "중지"를 누르거나 PTP 탭 자체를 닫으면 클라이언트/브라우저가 이 요청의
    // 연결을 끊는다 — req.signal이 그 신호다. previewCatalog의 두 번째 인자(signal)로 넘겨야 workerClient의
    // callWorker가 워커로 보낸 fetch 자체를 같이 끊고, 그래야 워커 쪽 rpc-server.ts가 req.on('close')로
    // 이 연결 종료를 감지해 opts.stopSignal(REQUEST_SIGNAL)을 abort한다 — opts 안에 stopSignal 필드로
    // 얹어 보내는 건 아무 효과가 없다(registry.ts의 withStopSignal이 opts.stopSignal을 그 REQUEST_SIGNAL로
    // 덮어써버리고, AbortSignal 자체는 JSON으로 직렬화도 안 된다). 이 인자를 빠뜨렸던 탓에 "PTP를 닫아도
    // 미리보기가 안 멈춘다"는 문제가 있었다(2026-09-06, 사용자 지적).
    const result = await previewCatalog({ ...body, extractionRules, knownNoPaginationWidget }, req.signal)
    // 체크리스트가 카테고리별 개수/확인일시를 보여줄 수 있게 저장해둔다 — 실패해도 미리보기 결과 자체는
    // 그대로 보여줘야 하니 응답을 막지 않는다.
    if (body.siteId && result.categoryCounts?.length) {
      await persistCategoryCounts(body.siteId, result.categoryCounts).catch(() => {})
    }
    return NextResponse.json(result)
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
}
