import { NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'
import { resolveSessionGroup } from '@/lib/scrape/mergeGroup'

const ALLOWED_FIELDS = ['brand', 'master_category', 'manufacturer', 'origin'] as const
type AllowedField = typeof ALLOWED_FIELDS[number]

function assertField(field: string | null): AllowedField {
  if (!ALLOWED_FIELDS.includes(field as AllowedField)) throw new Error('unsupported field')
  return field as AllowedField
}

/** 자동완성용: 기존에 입력된 값 목록 (건수 많은 순). sessionId가 있으면 그 스크랩 세션의 상품마스터로 범위를 좁힌다. */
export async function GET(req: NextRequest) {
  const sessionId = req.nextUrl.searchParams.get('sessionId')
  const clientId = Number(req.nextUrl.searchParams.get('clientId')) || 1
  let field: AllowedField
  try { field = assertField(req.nextUrl.searchParams.get('field')) } catch { return NextResponse.json({ error: 'unsupported field' }, { status: 400 }) }

  const res = sessionId
    ? await pool.query(
        `SELECT pm.${field} AS value, COUNT(*) AS count
         FROM product_master pm
         JOIN mall_products mp ON mp.id = pm.mall_product_id
         JOIN scrape_staging_items si ON si.matched_mall_product_id = mp.id
         WHERE si.session_id = ANY($1) AND pm.${field} IS NOT NULL AND pm.${field} <> ''
         GROUP BY pm.${field}
         ORDER BY count DESC`,
        [await resolveSessionGroup(Number(sessionId))],
      )
    : await pool.query(
        `SELECT ${field} AS value, COUNT(*) AS count
         FROM product_master
         WHERE client_id=$1 AND ${field} IS NOT NULL AND ${field} <> ''
         GROUP BY ${field}
         ORDER BY count DESC`,
        [clientId],
      )
  return NextResponse.json(res.rows)
}

/** 일괄 변경: 브랜드/카테고리 값 A를 B로 한꺼번에 바꾼다 (예: "트루러브 " → "트루러브").
 * sessionId가 있으면 그 세션에서 병합된 상품마스터로만 범위를 좁혀 변경한다. */
export async function PUT(req: NextRequest) {
  const { clientId, sessionId, field: rawField, from, to } = await req.json() as {
    clientId?: number; sessionId?: number; field?: string; from?: string; to?: string
  }
  let field: AllowedField
  try { field = assertField(rawField ?? null) } catch { return NextResponse.json({ error: 'unsupported field' }, { status: 400 }) }
  if (!from || !to) return NextResponse.json({ error: 'from/to required' }, { status: 400 })

  const res = sessionId
    ? await pool.query(
        `UPDATE product_master pm SET ${field}=$1, updated_at=NOW()
         FROM mall_products mp, scrape_staging_items si
         WHERE mp.id = pm.mall_product_id AND si.matched_mall_product_id = mp.id
           AND si.session_id = ANY($2) AND pm.${field} = $3`,
        [to, await resolveSessionGroup(sessionId), from],
      )
    : await pool.query(
        `UPDATE product_master SET ${field}=$1, updated_at=NOW() WHERE client_id=$2 AND ${field}=$3`,
        [to, clientId || 1, from],
      )
  return NextResponse.json({ ok: true, updated: res.rowCount })
}
