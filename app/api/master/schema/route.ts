import { NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'
import { isAdminRequest } from '@/lib/auth'

/** "기준 Master DB" 타깃 필드 목록 (고정 컬럼 매핑 + 커스텀 필드) 조회 — 거래처 구분 없는 단일 기준 테이블.
 *  조회 자체는 admin 제한 없음 — 브랜드·제조사·원산지 관리/가격 및 이익 관리 등 admin 전용이 아닌 다른
 *  메뉴들도 useRegisteredFieldKeys로 이 목록을 읽어 자기 화면의 표시 필드를 정한다. 편집(PUT)만 admin 전용. */
export async function GET() {
  const res = await pool.query(
    `SELECT id, field_key, field_label, is_custom, sort_order FROM master_schema_fields ORDER BY sort_order, id`,
  )
  return NextResponse.json(res.rows)
}

interface SchemaField {
  field_key: string
  field_label: string
  is_custom: boolean
}

/** 필드 목록을 통째로 교체 저장한다 (업로드 확인 화면에서 사용자가 확정한 최종 목록). admin 전용. */
export async function PUT(req: NextRequest) {
  if (!isAdminRequest(req)) return NextResponse.json({ error: '관리자 권한이 필요합니다.' }, { status: 403 })
  const { fields } = await req.json() as { fields: SchemaField[] }
  if (!Array.isArray(fields)) return NextResponse.json({ error: 'fields required' }, { status: 400 })

  await pool.query('DELETE FROM master_schema_fields')
  for (const [i, f] of fields.entries()) {
    if (!f.field_key || !f.field_label) continue
    await pool.query(
      `INSERT INTO master_schema_fields (field_key, field_label, is_custom, sort_order)
       VALUES ($1,$2,$3,$4)`,
      [f.field_key, f.field_label, !!f.is_custom, i],
    )
  }
  return NextResponse.json({ ok: true })
}
