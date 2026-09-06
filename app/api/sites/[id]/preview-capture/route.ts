import { NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'
import { runAutoAnalysis } from '@/lib/scrape/adjustment'
import { persistCategoryCounts } from '@/lib/scraper'
import { extractFromHtml } from '@/lib/workerClient'
import type { ExtractionRule } from '@/lib/ai'
import { clearDevPreviewStartedAndGetElapsed } from '@/lib/devPreviewStatus'

// chrome-extension:// 출처에서 오는 fetch라 CORS 프리플라이트(OPTIONS)를 직접 응답해야 하고,
// 로컬(사설망) 주소로 가는 요청이라 Private Network Access 헤더도 같이 내려줘야 브라우저가 막지 않는다.
function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Private-Network': 'true',
  }
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders() })
}

interface CapturedPreviewItem { url: string; name: string; thumbnail: string }
interface CapturedCategoryCount { url: string; label: string; count: number; truncated?: boolean }

/**
 * 개발자모드 "스크랩 미리보기 실행" — PTP에서 카테고리를 선택해뒀으면(site.categoryUrls) 확장이 그
 * 카테고리들을 각각 끝까지 페이징해 얻은 카테고리별 개수(categoryCounts)를, 선택 안 했으면 지금 보고
 * 있는 페이지 하나의 total/items를 실어 보낸다 — 첫 카테고리(또는 지금 페이지)의 첫 상품 HTML은 항상
 * 같이 온다(이 라우트는 항상 "상품 1건의 HTML"만 받는다). 결과를 일반모드의 "스크랩 미리보기"
 * (previewCatalog)와 같은 모양(total/platform/preview/items/categoryCounts)으로
 * last_adjustment_preview에 저장해두면, PTP 화면이 폴링으로 읽어가 같은 applyCatalogPreview로
 * 보여준다(두 모드가 같은 UI 하나를 공유).
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const siteId = Number(id)
  const body = await req.json() as {
    url?: string; html?: string; aiMode?: boolean
    total?: number; items?: CapturedPreviewItem[]; categoryCounts?: CapturedCategoryCount[]
    category?: string; brandFromCategory?: string; needsLogin?: boolean; noProductsFound?: boolean
  }
  // noProductsFound — 선택한 카테고리 전부에서 상품 링크를 하나도 못 찾았을 때(runPreview 참고) 확장이
  // url/html 없이 이 신호만 보낸다. 예전엔 이 경우에도 url/html이 필수라, 확장이 지금 탭(카테고리 목록
  // 페이지 자체, 회원전용 접근제한 안내처럼 실제로는 빈 페이지일 수도 있음)을 "상품 1건"으로 캡처해
  // 억지로 채워보냈다 — 그 결과 뜻 모를 상품명/가짜 이미지 URL이 실제 상품인 것처럼 저장됐다(2026-09-05,
  // 모자사러 실사용 확인). 정직하게 "상품 없음"으로만 남긴다.
  if (body.noProductsFound) {
    const devPreviewElapsedSec = clearDevPreviewStartedAndGetElapsed(siteId)
    const categoryCounts = body.categoryCounts || []
    await pool.query(
      `UPDATE sites SET last_adjustment_preview=$1 WHERE id=$2`,
      [JSON.stringify({ total: body.total ?? 0, platform: 'unknown', preview: null, items: [], categoryCounts, needsLogin: !!body.needsLogin, noProductsFound: true, devPreviewElapsedSec }), siteId],
    )
    if (categoryCounts.length) await persistCategoryCounts(siteId, categoryCounts).catch(() => {})
    return NextResponse.json({ preview: null }, { headers: corsHeaders() })
  }
  if (!body.url || !body.html) return NextResponse.json({ error: 'url과 html이 필요합니다' }, { status: 400, headers: corsHeaders() })
  // 확장이 캡처를 끝내고 이 라우트에 도착한 시점이므로 "캡처 시작됨" 신호(preview-progress)는 이제
  // 볼일이 끝났다 — 다음 실행이 새로 켤 때까지(preview-arm) 지워둔다. 지우기 직전 시작시각을 읽어 소요
  // 시간을 구해두면(devPreviewElapsedSec), 화면을 안 보고 있어 진행 중 표시를 못 봤어도 결과 화면에서
  // "몇 분 걸렸는지"를 나중에 확인할 수 있다(사용자 요청, 2026-09-06).
  const devPreviewElapsedSec = clearDevPreviewStartedAndGetElapsed(siteId)

  const siteRes = await pool.query<{ extraction_rules: Record<string, ExtractionRule> | null }>(
    `SELECT extraction_rules FROM sites WHERE id=$1`, [siteId],
  )
  if (!siteRes.rows.length) return NextResponse.json({ error: 'mall not found' }, { status: 404, headers: corsHeaders() })

  let rules = siteRes.rows[0].extraction_rules || {}
  if (body.aiMode) {
    try {
      ({ merged: rules } = await runAutoAnalysis(siteId, body.html))
    } catch (e) {
      // AI 호출 실패(크레딧 부족 등)여도 기존 규칙기반 추출은 그대로 보여준다 — 미리보기 자체가 막히면 안
      // 된다는 게 원래 의도였는데, 정작 여기서 500을 던져 막고 있었다(실사용 확인, 2026-09-05 — Anthropic
      // 크레딧 소진 + Gemini 과부하가 겹치자 개발자모드 "스크랩 미리보기"가 last_adjustment_preview를
      // 아예 저장 못 해 화면에 개수가 하나도 안 보였음, 실패했다는 신호도 없이). rules는 위에서 이미 기존
      // 규칙기반 값으로 초기화돼 있으니 그대로 두고 계속 진행한다 — 일반모드의 같은 지점
      // (lib/scraper.ts의 applyAiModeRules)은 원래부터 이렇게 실패를 삼키고 null을 반환해 rule-based
      // 결과로 폴백하도록 돼 있어 이 문제가 없었다.
      console.error('[preview-capture] AI 자동분석 실패 — 기존 규칙기반 추출로 계속 진행:', e instanceof Error ? e.message : e)
    }
  }

  const product = await extractFromHtml(body.html, body.url, rules).catch(() => null)
  // 목록(카테고리) 페이지에서 얻은 카테고리/브랜드가 상품 상세페이지 자체보다 믿을만하다(lib/scraper.ts의
  // applyCategoryOverride와 같은 원칙) — 다만 "스크랩 대상 직접지정"으로 이미 직접 확정해둔 필드는
  // 덮어쓰지 않는다.
  if (product) {
    if (body.category && !rules.category) product.category = body.category
    if (body.brandFromCategory && !rules.brand) product.brand = body.brandFromCategory
  }
  const preview = product ? { sourceUrl: body.url, product } : null
  const total = body.total ?? (preview ? 1 : 0)
  const items = body.items || []
  const categoryCounts = body.categoryCounts || []
  // needsLogin — 일반모드의 previewCatalog와 같은 신호(로그인 세션이 끊긴 채 미리보기가 돌아 카테고리가
  // 전부 0건으로 보이는 상황을 개수 문제와 구분해 화면에 알린다). applyCatalogPreview(ScraperPanel.tsx)가
  // 이미 이 필드를 보고 "로그인 확인" 흐름을 여는 처리를 하고 있어 여기서 실어 보내기만 하면 된다.
  await pool.query(
    `UPDATE sites SET last_adjustment_preview=$1 WHERE id=$2`,
    [JSON.stringify({ total, platform: 'unknown', preview, items, categoryCounts, needsLogin: !!body.needsLogin, devPreviewElapsedSec }), siteId],
  )
  // 일반모드와 같은 이유로(카테고리 체크리스트의 개수/확인일시 컬럼) 저장해둔다.
  if (categoryCounts.length) await persistCategoryCounts(siteId, categoryCounts).catch(() => {})

  return NextResponse.json({ preview }, { headers: corsHeaders() })
}
