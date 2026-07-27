import { NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'
import { discardStagingItems } from '@/lib/scrape/staging'
import { isAdminRequest } from '@/lib/auth'

const ALLOWED = ['name_original', 'price', 'sale_price', 'brand', 'manufacturer', 'origin', 'mall_category', 'description']

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const body = await req.json() as Record<string, unknown>
  const sets: string[] = []
  const vals: unknown[] = []
  for (const key of ALLOWED) {
    if (key in body) { vals.push(body[key]); sets.push(`${key}=$${vals.length}`) }
  }
  if (!sets.length) return NextResponse.json({ error: 'no fields' }, { status: 400 })
  vals.push(id)
  await pool.query(`UPDATE scrape_staging_items SET ${sets.join(',')}, updated_at=NOW() WHERE id=$${vals.length} AND status='pending'`, vals)
  return NextResponse.json({ ok: true })
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!isAdminRequest(req)) return NextResponse.json({ error: '관리자 권한이 필요합니다.' }, { status: 403 })
  const { id } = await params
  await discardStagingItems([Number(id)])
  return NextResponse.json({ ok: true })
}
