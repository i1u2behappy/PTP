import { NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'

export async function GET(_: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const res = await pool.query(
    `SELECT mc.code AS marketplace_code, mc.name AS marketplace_name,
            pcl.channel_name, pcl.channel_url, pcl.updated_at
     FROM marketplace_configs mc
     LEFT JOIN product_channel_listings pcl ON pcl.marketplace_code = mc.code AND pcl.product_master_id = $1
     ORDER BY mc.name`,
    [id],
  )
  return NextResponse.json(res.rows)
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const { marketplaceCode, channelName, channelUrl } = await req.json() as { marketplaceCode?: string; channelName?: string; channelUrl?: string }
  if (!marketplaceCode) return NextResponse.json({ error: 'marketplaceCode required' }, { status: 400 })

  await pool.query(
    `INSERT INTO product_channel_listings (product_master_id, marketplace_code, channel_name, channel_url)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (product_master_id, marketplace_code) DO UPDATE SET
       channel_name = $3, channel_url = $4, updated_at = NOW()`,
    [id, marketplaceCode, channelName || null, channelUrl || null],
  )
  return NextResponse.json({ ok: true })
}
