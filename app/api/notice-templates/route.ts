import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import pool from '@/lib/db'

/**
 * 고시정보(상품정보제공고시) 카테고리×마켓 기본값 템플릿 — 쿠팡 등록화면("오픈마켓 등록")에서 카테고리
 * 정보 조회 직후 채워 넣은 고시값을 "이 마켓×이 내부 카테고리의 기본값"으로 저장해두면, 다음에 같은
 * 카테고리 상품을 등록할 때 자동으로 미리 채워진다(!specifications/product-master-architecture-redesign.md §3).
 * 상품마다 다른 예외값은 여기가 아니라 product_channel_listings.notice_field_overrides에 담긴다 — 이
 * 테이블은 어디까지나 "보통은 이 값"이라는 기본값이다.
 */
export async function GET(req: NextRequest) {
  const marketplaceCode = req.nextUrl.searchParams.get('marketplaceCode')
  const masterCategoryId = Number(req.nextUrl.searchParams.get('masterCategoryId'))
  if (!marketplaceCode || !masterCategoryId) return NextResponse.json({ error: 'marketplaceCode/masterCategoryId required' }, { status: 400 })

  const res = await pool.query<{ field_key: string; field_label: string | null; default_value: string | null; source_product_field: string | null }>(
    `SELECT field_key, field_label, default_value, source_product_field FROM notice_templates
     WHERE marketplace_code=$1 AND master_category_id=$2 ORDER BY sort_order, field_key`,
    [marketplaceCode, masterCategoryId],
  )
  return NextResponse.json(res.rows.map(r => ({
    fieldKey: r.field_key, fieldLabel: r.field_label, defaultValue: r.default_value, sourceProductField: r.source_product_field,
  })))
}

const UpsertSchema = z.object({
  marketplaceCode: z.string().min(1),
  masterCategoryId: z.number(),
  fieldKey: z.string().min(1),
  fieldLabel: z.string().optional(),
  defaultValue: z.string(),
})

export async function PUT(req: NextRequest) {
  const parsed = UpsertSchema.safeParse(await req.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message || 'invalid request' }, { status: 400 })
  const { marketplaceCode, masterCategoryId, fieldKey, fieldLabel, defaultValue } = parsed.data

  await pool.query(
    `INSERT INTO notice_templates (marketplace_code, master_category_id, field_key, field_label, default_value)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (marketplace_code, master_category_id, field_key) DO UPDATE SET
       field_label = COALESCE($4, notice_templates.field_label), default_value = $5, updated_at = NOW()`,
    [marketplaceCode, masterCategoryId, fieldKey, fieldLabel ?? null, defaultValue],
  )
  return NextResponse.json({ ok: true })
}
