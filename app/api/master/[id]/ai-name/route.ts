import { NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'
import { generateProductName } from '@/lib/ai'

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const { templateId } = await req.json().catch(() => ({})) as { templateId?: number }

  const res = await pool.query<{ name_original: string; thumbnail_url: string }>(
    `SELECT pm.name_original, mp.thumbnail_url
     FROM product_master pm LEFT JOIN mall_products mp ON mp.id = pm.mall_product_id
     WHERE pm.id=$1`,
    [id],
  )
  const p = res.rows[0]
  if (!p) return NextResponse.json({ error: 'not found' }, { status: 404 })

  const templateRes = await pool.query<{ prompt_template: string; max_length: number }>(
    templateId
      ? `SELECT prompt_template, max_length FROM naming_templates WHERE id=$1`
      : `SELECT prompt_template, max_length FROM naming_templates WHERE is_default=true LIMIT 1`,
    templateId ? [templateId] : [],
  )
  const template = templateRes.rows[0]

  const name = await generateProductName(p.thumbnail_url, p.name_original || '', template?.prompt_template, template?.max_length)
  await pool.query('UPDATE product_master SET name_ai=$1, updated_at=NOW() WHERE id=$2', [name, id])
  return NextResponse.json({ name_ai: name })
}
