import { NextRequest, NextResponse } from 'next/server'
import { getProductsByIds } from '@/lib/db'
import { MASTER_FIELDS, buildMasterRow } from '@/lib/excel/master'

export async function POST(req: NextRequest) {
  const { productIds } = await req.json() as { productIds: number[] }
  if (!productIds?.length) return NextResponse.json({ error: 'productIds required' }, { status: 400 })

  const products = await getProductsByIds(productIds)
  const rows = products.map(p => ({ id: p.id, name: p.name_ai || p.name_original, fields: buildMasterRow(p) }))

  return NextResponse.json({
    fields: MASTER_FIELDS.map(f => ({ key: f.key, label: f.label, meaning: f.meaning })),
    rows,
  })
}
