import { NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'
import { assignInternalCodeIfMissing } from '@/lib/master/migrate'

export async function GET(req: NextRequest) {
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

/** 관리코드가 없는 상품마스터에 일괄 발급 (거래처 코드가 나중에 설정된 경우의 보완용) */
export async function POST(req: NextRequest) {
  const { clientId } = await req.json() as { clientId?: number }
  const cid = clientId || 1

  const missing = await pool.query<{ id: number }>('SELECT id FROM product_master WHERE client_id=$1 AND internal_code IS NULL', [cid])
  for (const row of missing.rows) await assignInternalCodeIfMissing(row.id, cid)
  return NextResponse.json({ generated: missing.rows.length })
}
