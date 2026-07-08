import { NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'

export async function GET() {
  const res = await pool.query(
    `SELECT code, name, max_batch_size, default_commission_rate::float AS default_commission_rate, default_shipping_fee
     FROM marketplace_configs ORDER BY name`,
  )
  return NextResponse.json(res.rows)
}

export async function PUT(req: NextRequest) {
  const { code, maxBatchSize, defaultCommissionRate, defaultShippingFee } = await req.json() as {
    code: string; maxBatchSize?: number; defaultCommissionRate?: number; defaultShippingFee?: number
  }
  if (!code) return NextResponse.json({ error: 'code required' }, { status: 400 })

  await pool.query(
    `UPDATE marketplace_configs SET
       max_batch_size = COALESCE($2, max_batch_size),
       default_commission_rate = COALESCE($3, default_commission_rate),
       default_shipping_fee = COALESCE($4, default_shipping_fee),
       updated_at = NOW()
     WHERE code=$1`,
    [code, maxBatchSize ?? null, defaultCommissionRate ?? null, defaultShippingFee ?? null],
  )
  return NextResponse.json({ ok: true })
}
