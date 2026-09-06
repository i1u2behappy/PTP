import { NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'
import { setCollectProgress } from '@/lib/workerClient'
import { clearStalePendingIfConfigChanged } from '@/lib/scrape/staging'
import { ensureDevKeepAwakeWatcherStarted } from '@/lib/devKeepAwake'
import type { ExtractionRule } from '@/lib/ai'

// extension-ingest와 같은 이유(chrome-extension:// 출처, 사설망 주소) — CORS 프리플라이트를 직접 응답하고
// Private Network Access 헤더도 같이 내려줘야 브라우저가 막지 않는다.
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

interface ProgressBody {
  siteId: number
  sessionId?: number
  done: number
  total: number
}

/**
 * 개발자모드(크롬 확장)의 run()이 카테고리를 하나씩 순회하기 시작할 때마다 호출한다. 상품을 하나라도
 * 실제로 저장해야만 세션이 생기던 예전 방식은, 앞쪽 카테고리가 전부 "이미 받은 상품"이라 건너뛰기만
 * 하는 동안(excludeUrls, 2026-08-22 추가) 세션 자체가 없어 PTP가 진행 중이라는 걸 전혀 감지하지 못했다
 * (사용자 지적: "PTP 상에서는 아무런 변화가 없는 상태야"). 이 엔드포인트가 세션을 미리 만들어두고
 * (extension-ingest의 세션 생성 로직과 동일), 카테고리 진행률(lib/scraper.ts의 getCollectProgress와
 * 같은 자리)도 같이 갱신해 app/api/scrape/status가 그대로 실어보낼 수 있게 한다.
 */
export async function POST(req: NextRequest) {
  const body = await req.json() as ProgressBody
  if (!body.siteId) return NextResponse.json({ error: 'siteId required' }, { status: 400, headers: corsHeaders() })

  // 개발자모드 실제 스크랩도 withSiteLock을 안 거쳐 절전방지가 안 걸려 있었다(lib/devKeepAwake.ts 참고,
  // 사용자 지적 2026-09-06) — PTP 패널을 안 열어둔 채로 확장만 써도(preview-progress GET 폴링 없이도)
  // 감시가 켜지도록 여기서도 깨워둔다.
  ensureDevKeepAwakeWatcherStarted()
  let sessionId = body.sessionId
  if (!sessionId) {
    const siteRow = await pool.query<{ extraction_rules: Record<string, ExtractionRule> | null }>(
      `SELECT extraction_rules FROM sites WHERE id=$1`, [body.siteId],
    )
    const currentRules = siteRow.rows[0]?.extraction_rules || {}
    // extension-ingest와 같은 이유로, "이어서"가 실은 설정이 바뀐 "새로 시작"인지 여기서도 같이 판단한다.
    await clearStalePendingIfConfigChanged(body.siteId, { extractionRules: currentRules })
    const res = await pool.query<{ id: number }>(
      `INSERT INTO scrape_sessions (url, site_id, status, scope_type, mode, scope_params)
       VALUES ($1,$2,'running','products','full',$3) RETURNING id`,
      ['', body.siteId, JSON.stringify({ extractionRules: currentRules })],
    )
    sessionId = res.rows[0].id
  }

  await setCollectProgress(sessionId, body.done, body.total)
  return NextResponse.json({ sessionId }, { headers: corsHeaders() })
}
