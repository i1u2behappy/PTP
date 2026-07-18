import { NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'
import { migrateToMaster } from '@/lib/master/migrate'
import { generateForProducts, commitGeneratedRows } from '@/lib/transform/generate'

/** 마이그레이션3_연속관리의 "재마이그레이션" 전용 — migrateToMaster로 기본 갱신을 하고, 그 몰에 저장된
 * Transform 컬럼 규칙까지 같은 상품들에 자동으로 생성·확정한다. 사용자가 이미 변동 감지 화면에서 확인하고
 * 이 버튼을 눌렀으므로, draft 검토 단계 없이 바로 반영한다. */
export async function POST(req: NextRequest) {
  const { mallProductIds, clientId, siteId } = await req.json() as { mallProductIds: number[]; clientId: number; siteId: number }
  if (!Array.isArray(mallProductIds) || !mallProductIds.length || !clientId || !siteId) {
    return NextResponse.json({ error: 'mallProductIds, clientId, siteId required' }, { status: 400 })
  }

  const { masterIds } = await migrateToMaster(mallProductIds, clientId)
  await generateForProducts(siteId, mallProductIds)

  const rowsRes = await pool.query<{ id: number }>(
    `SELECT id FROM transform_generated_rows WHERE site_id=$1 AND mall_product_id = ANY($2) AND status='draft'`,
    [siteId, mallProductIds],
  )
  const { committed, failed } = await commitGeneratedRows(rowsRes.rows.map(r => r.id), clientId)

  return NextResponse.json({ masterIds, committed, failed })
}
