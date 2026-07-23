import { NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'

/** 화면에 클릭할 요소가 없는 값(예: 택배사)을 모든 상품에 그대로 채울 고정값 컬럼으로 등록한다 —
 *  페이지를 읽지 않고 value를 그대로 쓰는 type:'fixed' 규칙.
 *  SELECT로 읽어 JS에서 합친 뒤 UPDATE하는 대신, Postgres의 jsonb `||`(병합) 연산자로 한 SQL 문에서
 *  원자적으로 합친다 — 여러 필드를 빠르게 연달아 지정하면 SELECT→UPDATE 사이에 다른 저장이 끼어들어
 *  앞서 저장한 필드가 통째로 사라지는 lost-update가 실제로 발생했다(신우 몰, 여러 개 연속 지정 중 보고). */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const siteId = Number(id)
  if (!siteId) return NextResponse.json({ error: 'invalid site id' }, { status: 400 })
  const { field, value } = await req.json() as { field?: string; value?: string }
  if (!field?.trim() || !value?.trim()) return NextResponse.json({ error: 'field, value required' }, { status: 400 })

  const rule = { type: 'fixed', value: value.trim() }
  await pool.query(
    `UPDATE sites SET extraction_rules = COALESCE(extraction_rules, '{}'::jsonb) || jsonb_build_object($1::text, $2::jsonb) WHERE id=$3`,
    [field.trim(), JSON.stringify(rule), siteId],
  )
  return NextResponse.json({ ok: true })
}

/** "스크랩 대상 직접지정"으로 저장한 컬럼 하나를 지운다 — 나머지 규칙은 그대로 둔다. jsonb `-`(키 제거)
 *  연산자로 원자적으로 처리해 위 POST와 같은 lost-update 위험을 없앤다. */
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const siteId = Number(id)
  if (!siteId) return NextResponse.json({ error: 'invalid site id' }, { status: 400 })
  const { field } = await req.json() as { field?: string }
  if (!field) return NextResponse.json({ error: 'field required' }, { status: 400 })

  await pool.query(`UPDATE sites SET extraction_rules = COALESCE(extraction_rules, '{}'::jsonb) - $1::text WHERE id=$2`, [field, siteId])
  return NextResponse.json({ ok: true })
}
