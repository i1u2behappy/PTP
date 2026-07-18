import { NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'
import { assignInternalCodeIfMissing } from '@/lib/master/migrate'
import { resolveSessionGroup } from '@/lib/scrape/mergeGroup'

/** sessionId가 있으면 그 스크랩 세션에서 병합된 상품마스터로 범위를 좁힌다 (거래처는 그 세션이 속한 몰의 거래처로 자동 결정). */
export async function GET(req: NextRequest) {
  const sessionId = req.nextUrl.searchParams.get('sessionId')

  if (sessionId) {
    const rows = await pool.query(
      `SELECT DISTINCT pm.id, pm.internal_code, pm.name_final, pm.name_ai, pm.name_original, mp.mall_product_code, pm.client_id
       FROM product_master pm
       JOIN mall_products mp ON mp.id = pm.mall_product_id
       JOIN scrape_staging_items si ON si.matched_mall_product_id = mp.id
       WHERE si.session_id = ANY($1)
       ORDER BY pm.id`,
      [await resolveSessionGroup(Number(sessionId))],
    )
    const clientId = rows.rows[0]?.client_id
    const client = clientId ? await pool.query('SELECT id, name, code, auto_internal_code FROM supply_clients WHERE id=$1', [clientId]) : null
    return NextResponse.json({ client: client?.rows[0] || null, rows: rows.rows })
  }

  const clientId = Number(req.nextUrl.searchParams.get('clientId')) || 1
  const client = await pool.query('SELECT id, name, code, auto_internal_code FROM supply_clients WHERE id=$1', [clientId])
  const rows = await pool.query(
    `SELECT pm.id, pm.internal_code, pm.name_final, pm.name_ai, pm.name_original, mp.mall_product_code
     FROM product_master pm
     LEFT JOIN mall_products mp ON mp.id = pm.mall_product_id
     WHERE pm.client_id = $1
     ORDER BY pm.id`,
    [clientId],
  )
  return NextResponse.json({ client: client.rows[0] || null, rows: rows.rows })
}

/** 관리코드가 없는 상품마스터에 일괄 발급 (거래처 코드가 나중에 설정된 경우의 보완용). sessionId가 있으면 그 세션 범위로만 발급한다. */
export async function POST(req: NextRequest) {
  const { clientId, sessionId } = await req.json() as { clientId?: number; sessionId?: number }

  if (sessionId) {
    const missing = await pool.query<{ id: number; client_id: number }>(
      `SELECT DISTINCT pm.id, pm.client_id
       FROM product_master pm
       JOIN mall_products mp ON mp.id = pm.mall_product_id
       JOIN scrape_staging_items si ON si.matched_mall_product_id = mp.id
       WHERE si.session_id = ANY($1) AND pm.internal_code IS NULL`,
      [await resolveSessionGroup(sessionId)],
    )
    for (const row of missing.rows) await assignInternalCodeIfMissing(row.id, row.client_id)
    return NextResponse.json({ generated: missing.rows.length })
  }

  const cid = clientId || 1
  const missing = await pool.query<{ id: number }>('SELECT id FROM product_master WHERE client_id=$1 AND internal_code IS NULL', [cid])
  for (const row of missing.rows) await assignInternalCodeIfMissing(row.id, cid)
  return NextResponse.json({ generated: missing.rows.length })
}
