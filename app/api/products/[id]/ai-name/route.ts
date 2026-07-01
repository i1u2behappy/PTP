import { NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'
import { generateProductName } from '@/lib/ai'

export async function POST(_: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const res = await pool.query<{ thumbnail_url: string; name_original: string }>(
    'SELECT thumbnail_url, name_original FROM products WHERE id=$1', [id],
  )
  const p = res.rows[0]
  if (!p) return NextResponse.json({ error: 'not found' }, { status: 404 })

  const name = await generateProductName(p.thumbnail_url, p.name_original || '')
  await pool.query('UPDATE products SET name_ai=$1, updated_at=NOW() WHERE id=$2', [name, id])
  return NextResponse.json({ name_ai: name })
}
