import { NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'
import { resolveSessionGroup } from '@/lib/scrape/mergeGroup'
import { suggestValueMerges } from '@/lib/ai'

const ALLOWED_FIELDS = ['brand', 'manufacturer', 'origin'] as const
type AllowedField = typeof ALLOWED_FIELDS[number]
const FIELD_LABELS: Record<AllowedField, string> = { brand: '브랜드', manufacturer: '제조사', origin: '원산지' }

/**
 * "브랜드·제조사·원산지 관리" 화면의 "✨ AI로 중복값 정리" — 이 세션에 쓰인 원문 값 중 같은 실제 대상을
 * 표기만 다르게 쓴 것들(예: "LG전자"/"(주)엘지전자")을 그룹으로 묶어 대표값을 제안한다. master_category와
 * 달리 "이미 확정된 기준값"이라는 별도 레퍼런스가 없는 필드라(category_channel_mappings 같은 것),
 * 현재 세션 안의 distinct 값끼리 서로 비교해 중복을 찾는다 — category-mappings/classify와는 다른 종류의
 * 분류 작업이라 별도 엔드포인트로 둔다. 여기서는 제안만 반환하고 DB는 바꾸지 않는다 — 화면에서 사람이
 * 검토한 뒤 받아들인 것만 기존 "일괄 변경"(PUT /api/master/field-values)으로 적용한다.
 */
export async function POST(req: NextRequest) {
  const { field: rawField, sessionId } = await req.json().catch(() => ({})) as { field?: string; sessionId?: number }
  if (!sessionId) return NextResponse.json({ error: 'sessionId required' }, { status: 400 })
  if (!ALLOWED_FIELDS.includes(rawField as AllowedField)) return NextResponse.json({ error: 'unsupported field' }, { status: 400 })
  const field = rawField as AllowedField

  const sessionGroup = await resolveSessionGroup(sessionId)
  const res = await pool.query<{ value: string }>(
    `SELECT pm.${field} AS value
     FROM product_master pm
     JOIN mall_products mp ON mp.id = pm.mall_product_id
     JOIN scrape_staging_items si ON si.matched_mall_product_id = mp.id
     WHERE si.session_id = ANY($1) AND pm.${field} IS NOT NULL AND pm.${field} <> ''
     GROUP BY pm.${field}
     ORDER BY COUNT(*) DESC`,
    [sessionGroup],
  )
  const values = res.rows.map(r => r.value)
  const groups = await suggestValueMerges(FIELD_LABELS[field], values).catch(() => [])
  return NextResponse.json(groups)
}
