import { NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'

// chrome-extension:// 출처에서 오는 fetch라 CORS 프리플라이트(OPTIONS)를 직접 응답해야 하고,
// 로컬(사설망) 주소로 가는 요청이라 Private Network Access 헤더도 같이 내려줘야 브라우저가 막지 않는다.
function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Private-Network': 'true',
  }
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders() })
}

/** "www.sinwoo.com"과 "sinwoo.com"처럼 www 유무만 다른 같은 사이트를 같은 것으로 취급한다 —
 * Mall 등록 URL과 실제로 사용자가 브라우저에서 열어본 주소가 www 유무만 다를 수 있다. */
function normalizeHost(host: string): string {
  return host.replace(/^www\./i, '')
}

/**
 * 개발자모드(크롬 확장) 몰 공용 조회 — 확장이 지금 보고 있는 탭의 호스트명으로 이 몰이 어느 site_id인지
 * 물어본다. 확장에 몰별 siteId를 하드코딩하지 않아도, Mall 관리에서 체크박스만 켜면 새 몰도 그대로
 * 인식되게 하기 위함(sites.manual_login_required = true인 몰만 대상으로 좁힌다).
 */
export async function GET(req: NextRequest) {
  const host = req.nextUrl.searchParams.get('host')
  if (!host) return NextResponse.json({ error: 'host required' }, { status: 400, headers: corsHeaders() })

  const res = await pool.query<{
    id: number; name: string | null; url: string; extraction_rules: unknown; devmode_ai_preview: boolean
    devmode_category_urls: string[] | null
    last_adjustment_preview: { preview?: { product: Record<string, unknown> } | null } | null
  }>(
    `SELECT id, name, url, extraction_rules, devmode_ai_preview, devmode_category_urls, last_adjustment_preview FROM sites WHERE manual_login_required = true`,
  )
  const targetHost = normalizeHost(host)
  const match = res.rows.find(row => {
    try { return normalizeHost(new URL(row.url).hostname) === targetHost } catch { return false }
  })
  if (!match) return NextResponse.json({ error: 'not found' }, { status: 404, headers: corsHeaders() })

  // 스크랩 대상 직접지정 피커(개발자모드)의 필드 목록도 일반모드와 같은 기준 마스터테이블 라벨/순서를
  // 따르게 하려고 같이 내려준다 — lib/scraper.ts의 startElementPicker가 하는 것과 동일한 조회.
  const labelsRes = await pool.query<{ field_key: string; field_label: string }>(
    'SELECT field_key, field_label FROM master_schema_fields ORDER BY sort_order, id',
  )
  const masterLabels = Object.fromEntries(labelsRes.rows.map(r => [r.field_key, r.field_label]))
  const masterOrder = labelsRes.rows.map(r => r.field_key)

  // extractionRules: "스크랩 조정" 기능이 이 몰에 대해 학습해둔 영구 추출 규칙 — 확장이 매번 같이 받아가
  // EXTRACT_PRODUCT_EXPR에 실어 적용한다. aiPreviewMode: PTP 화면의 AI모드 토글 상태 — 확장은 PTP와 직접
  // 연결돼 있지 않아(별도 실제 크롬 탭) 실행 시점마다 이 값을 물어봐야 한다. previewProduct: 마지막
  // "스크랩 미리보기 실행"에서 캡처된 상품 — 피커 패널이 일반모드처럼 필드별 "자동값" 힌트(대표/상세
  // 이미지 장수 포함)를 보여주려면 이 값이 있어야 한다(없으면 모든 필드가 힌트 없이 빈 채로 보인다).
  // categoryUrls: PTP 화면의 "카테고리 불러오기"에서 체크해둔 카테고리 목록 — 비어있으면 확장은 기존처럼
  // "지금 탭 위치"만 처리하고, 있으면 "스크랩 시작" 때 그 목록을 순서대로 전부 처리한다(background.js의
  // run() 참고).
  return NextResponse.json({
    id: match.id, name: match.name, extractionRules: match.extraction_rules || {}, aiPreviewMode: match.devmode_ai_preview,
    categoryUrls: match.devmode_category_urls || [],
    masterLabels, masterOrder, previewProduct: match.last_adjustment_preview?.preview?.product || null,
  }, { headers: corsHeaders() })
}
