import { NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'
import { resolveSessionGroup } from '@/lib/scrape/mergeGroup'
import { classifyMasterCategory } from '@/lib/ai'

/** 한 번에 너무 많이 돌리면 AI 공급자 분당 한도(Groq ITPM/RPM 등)에 걸릴 수 있다 — generateForProducts의
 *  GENERATE_CONCURRENCY/migrateToMaster의 MIGRATE_CONCURRENCY와 같은 관행으로 6개씩 묶는다. */
const CLASSIFY_CONCURRENCY = 6

export interface CategoryClassifySuggestion {
  raw: string
  count: string
  suggestion: { action: 'reuse' | 'new'; category: string } | null
}

/**
 * "카테고리 매핑" 화면의 "✨ AI로 분류 정리" — 이 세션(스크랩 범위)에 있는 원문 master_category 값마다,
 * 이미 마켓 매핑까지 돼 있는(=사람이 실제로 확정해 쓰고 있는) 기존 카테고리 중 같은 뜻이 있으면 재사용을,
 * 없으면 새 이름을 제안한다. 여기서는 제안만 반환하고 DB는 바꾸지 않는다 — 화면에서 사람이 검토한 뒤
 * 받아들인 것만 기존 "일괄 변경"(PUT /api/master/field-values)으로 적용한다(2026-10-03, PTP 마이그레이션
 * 로드맵 §04 "카테고리 자동분류 AI를 추가한다" — "조용한 오매핑"을 피하려면 자동 적용이 아니라 제안
 * 단계를 반드시 거쳐야 한다는 로드맵의 반복된 원칙).
 */
export async function POST(req: NextRequest) {
  const { sessionId } = await req.json().catch(() => ({})) as { sessionId?: number }
  if (!sessionId) return NextResponse.json({ error: 'sessionId required' }, { status: 400 })

  const sessionGroup = await resolveSessionGroup(sessionId)
  const [rawRes, existingRes] = await Promise.all([
    pool.query<{ value: string; count: string }>(
      `SELECT pm.master_category AS value, COUNT(*) AS count
       FROM product_master pm
       JOIN mall_products mp ON mp.id = pm.mall_product_id
       JOIN scrape_staging_items si ON si.matched_mall_product_id = mp.id
       WHERE si.session_id = ANY($1) AND pm.master_category IS NOT NULL AND pm.master_category <> ''
       GROUP BY pm.master_category
       ORDER BY count DESC`,
      [sessionGroup],
    ),
    // 마켓 매핑까지 돼 있는 값만 "이미 확정된 내부 카테고리"로 본다 — product_master 전체의 distinct
    // master_category를 쓰면 아직 아무도 확인 안 한 지난 원문 복사값까지 "기존 카테고리"로 착각해 섞인다.
    pool.query<{ master_category: string }>(`SELECT DISTINCT master_category FROM category_channel_mappings`),
  ])
  const existingCategories = existingRes.rows.map(r => r.master_category)

  const results: CategoryClassifySuggestion[] = []
  const rows = rawRes.rows
  for (let i = 0; i < rows.length; i += CLASSIFY_CONCURRENCY) {
    const batch = rows.slice(i, i + CLASSIFY_CONCURRENCY)
    const batchResults = await Promise.all(batch.map(async row => ({
      raw: row.value, count: row.count,
      suggestion: await classifyMasterCategory(row.value, existingCategories).catch(() => null),
    })))
    results.push(...batchResults)
  }
  return NextResponse.json(results)
}
