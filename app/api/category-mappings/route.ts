import { NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'

export async function GET() {
  const res = await pool.query(
    `SELECT master_category, marketplace_code, channel_category_value FROM category_channel_mappings`,
  )
  return NextResponse.json(res.rows)
}

/** 내부 카테고리 하나 × 마켓 하나에 대한 채널별 카테고리 값을 저장 (빈 값이면 매핑 삭제) */
export async function PUT(req: NextRequest) {
  const { masterCategory, marketplaceCode, channelCategoryValue } = await req.json() as {
    masterCategory?: string; marketplaceCode?: string; channelCategoryValue?: string
  }
  if (!masterCategory || !marketplaceCode) return NextResponse.json({ error: 'masterCategory/marketplaceCode required' }, { status: 400 })

  if (!channelCategoryValue) {
    await pool.query('DELETE FROM category_channel_mappings WHERE master_category=$1 AND marketplace_code=$2', [masterCategory, marketplaceCode])
    return NextResponse.json({ ok: true })
  }

  await pool.query(
    `INSERT INTO category_channel_mappings (master_category, marketplace_code, channel_category_value)
     VALUES ($1,$2,$3)
     ON CONFLICT (master_category, marketplace_code) DO UPDATE SET channel_category_value=$3, updated_at=NOW()`,
    [masterCategory, marketplaceCode, channelCategoryValue],
  )
  return NextResponse.json({ ok: true })
}
