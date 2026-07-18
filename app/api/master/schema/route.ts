import { NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'

/** 거래처의 "기준 Master DB" 타깃 필드 목록 (고정 컬럼 매핑 + 커스텀 필드) 조회. */
export async function GET(req: NextRequest) {
  const clientId = Number(req.nextUrl.searchParams.get('clientId'))
  if (!clientId) return NextResponse.json({ error: 'clientId required' }, { status: 400 })

  const res = await pool.query(
    `SELECT id, field_key, field_label, is_custom, sort_order
     FROM client_master_schema_fields WHERE client_id=$1 ORDER BY sort_order, id`,
    [clientId],
  )
  return NextResponse.json(res.rows)
}

interface SchemaField {
  field_key: string
  field_label: string
  is_custom: boolean
}

/** 필드 목록을 통째로 교체 저장한다 (업로드 확인 화면에서 사용자가 확정한 최종 목록). */
export async function PUT(req: NextRequest) {
  const { clientId, fields } = await req.json() as { clientId: number; fields: SchemaField[] }
  if (!clientId || !Array.isArray(fields)) return NextResponse.json({ error: 'clientId, fields required' }, { status: 400 })

  await pool.query('DELETE FROM client_master_schema_fields WHERE client_id=$1', [clientId])
  for (const [i, f] of fields.entries()) {
    if (!f.field_key || !f.field_label) continue
    await pool.query(
      `INSERT INTO client_master_schema_fields (client_id, field_key, field_label, is_custom, sort_order)
       VALUES ($1,$2,$3,$4,$5)`,
      [clientId, f.field_key, f.field_label, !!f.is_custom, i],
    )
  }
  return NextResponse.json({ ok: true })
}
