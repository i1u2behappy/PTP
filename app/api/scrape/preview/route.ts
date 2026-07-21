import { NextRequest, NextResponse } from 'next/server'
import { scrapeSingleProduct } from '@/lib/scraper'
import pool from '@/lib/db'
import type { ExtractionRule } from '@/lib/ai'

/** 실제로 상품 페이지 하나를 열어 추출 결과만 보여준다 (DB 저장 없음). */
export async function POST(req: NextRequest) {
  const body = await req.json() as {
    url: string; siteId?: number; loginId?: string; loginPw?: string
  }
  if (!body.url) return NextResponse.json({ error: 'url required' }, { status: 400 })

  try {
    // "스크랩 대상 직접지정"으로 저장한 그 몰 전용 규칙 — 실제 스크랩(lib/scrape/run.ts)과 동일하게 미리보기에도 적용해야
    // 스크랩 대상 직접지정으로 고친 값이 미리보기에 곧바로 반영된다.
    let extractionRules: Record<string, ExtractionRule> | undefined
    if (body.siteId) {
      const res = await pool.query<{ extraction_rules: Record<string, ExtractionRule> | null }>(
        'SELECT extraction_rules FROM sites WHERE id=$1', [body.siteId],
      )
      extractionRules = res.rows[0]?.extraction_rules || undefined
    }
    const result = await scrapeSingleProduct({ ...body, extractionRules })
    return NextResponse.json(result)
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
}
