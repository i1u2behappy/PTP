import { NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'
import { fetchPageText } from '@/lib/scraper'
import { runAdjustment } from '@/lib/scrape/adjustment'
import { reExtractStagingItems } from '@/lib/scrape/reextract'
import type { ExtractedProduct } from '@/lib/ai'

interface AdjustBody {
  itemId: number
  prompt: string
}

/**
 * "스크랩 조정 개시" — 일반모드 몰 전용(백엔드가 Playwright로 페이지를 스스로 다시 열어볼 수 있어 전부
 * 자동). 속도를 위해 지금 그리드 맨 위에 보이는 상품 1건(itemId)만 대상으로 규칙을 만들고 테스트해본다 —
 * 전체 적용은 app/api/sites/[id]/adjust/confirm이 맡는다. 개발자모드 몰은
 * app/api/sites/[id]/adjust/prompt·capture 두 라우트가 대신한다.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const siteId = Number(id)
  const body = await req.json() as AdjustBody
  if (!body.itemId || !body.prompt?.trim()) {
    return NextResponse.json({ error: 'itemId와 prompt가 필요합니다' }, { status: 400 })
  }

  const res = await pool.query<{ id: number; source_url: string; raw_data: Partial<ExtractedProduct> | null }>(
    `SELECT id, source_url, raw_data FROM scrape_staging_items WHERE id=$1 AND site_id=$2 AND status='pending'`,
    [body.itemId, siteId],
  )
  const sample = res.rows[0]
  if (!sample) return NextResponse.json({ error: '조정할 대상(미확정 항목)을 찾을 수 없습니다' }, { status: 400 })

  // raw_data는 스크랩 당시(또는 지난 조정 라운드) ExtractedProduct 전체를 그대로 담아둔 것이라, 컬럼별로
  // 따로 안 읽어와도 모든 필드(옵션/재고/커스텀 컬럼 포함)를 그대로 AI 컨텍스트로 넘길 수 있다.
  const currentValues: Partial<ExtractedProduct> = sample.raw_data || {}

  let pageText: string
  try {
    pageText = await fetchPageText({ url: sample.source_url, siteId })
  } catch (e) {
    return NextResponse.json({ error: `상품 페이지를 다시 열어보지 못했습니다: ${e instanceof Error ? e.message : e}` }, { status: 500 })
  }

  let rules
  try {
    ({ rules } = await runAdjustment(siteId, body.prompt, pageText, currentValues))
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
  const { updated, failed } = await reExtractStagingItems([sample.id])

  return NextResponse.json({ rules, updated: updated.length, failed })
}
