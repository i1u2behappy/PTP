import { NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'

interface OptionSlot { index: number; label: string; targetField: string }
interface CategoryProfile {
  sheetName: string
  hasFashionExtraColumns: boolean
  purchaseOptions: OptionSlot[]
  searchOptions: OptionSlot[]
  noticeInfo: { categoryValue: string; fields: OptionSlot[] }
}

function emptySlots(count: number): OptionSlot[] {
  return Array.from({ length: count }, (_, i) => ({ index: i + 1, label: '', targetField: '' }))
}

// 쿠팡 실제 양식(!specifications/marketplace-formats/coupang.md) 기준 슬롯 개수 — 구매옵션 6쌍/검색옵션 20쌍/고시정보 14슬롯
function emptyProfile(): CategoryProfile {
  return {
    sheetName: '',
    hasFashionExtraColumns: false,
    purchaseOptions: emptySlots(6),
    searchOptions: emptySlots(20),
    noticeInfo: { categoryValue: '', fields: emptySlots(14) },
  }
}

/** 마켓×채널 카테고리값별 옵션/고시정보 슬롯 매핑을 marketplace_configs.template_mapping JSONB에 저장 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ code: string }> }) {
  const { code } = await params
  const category = req.nextUrl.searchParams.get('category')
  if (!category) return NextResponse.json({ error: 'category required' }, { status: 400 })

  const res = await pool.query<{ template_mapping: { categoryProfiles?: Record<string, CategoryProfile> } }>(
    `SELECT template_mapping FROM marketplace_configs WHERE code = $1`, [code],
  )
  if (!res.rows.length) return NextResponse.json({ error: 'unknown marketplace code' }, { status: 404 })

  const profile = res.rows[0].template_mapping?.categoryProfiles?.[category]
  return NextResponse.json(profile ?? emptyProfile())
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ code: string }> }) {
  const { code } = await params
  const { category, profile } = await req.json() as { category?: string; profile?: CategoryProfile }
  if (!category || !profile) return NextResponse.json({ error: 'category/profile required' }, { status: 400 })

  await pool.query(
    `UPDATE marketplace_configs
     SET template_mapping = jsonb_set(COALESCE(template_mapping, '{}'), '{categoryProfiles}',
           COALESCE(template_mapping->'categoryProfiles', '{}') || jsonb_build_object($2::text, $3::jsonb)),
         updated_at = NOW()
     WHERE code = $1`,
    [code, category, JSON.stringify(profile)],
  )
  return NextResponse.json({ ok: true })
}
