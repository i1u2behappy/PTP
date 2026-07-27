import { NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'
import { isAdminRequest } from '@/lib/auth'

/** 일반 사용자 삭제 — admin 전용. admin 계정 자체는 이 경로로 지울 수 없다(권한관리 화면에 목록으로도
 * 안 보여준다 — 여기서도 한 번 더 막아 이중 안전장치). */
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!isAdminRequest(req)) return NextResponse.json({ error: '관리자 권한이 필요합니다.' }, { status: 403 })
  const { id } = await params
  const target = await pool.query<{ role: string }>('SELECT role FROM users WHERE id=$1', [id])
  if (target.rows[0]?.role === 'admin') return NextResponse.json({ error: 'admin 계정은 삭제할 수 없습니다.' }, { status: 400 })
  await pool.query('DELETE FROM users WHERE id=$1', [id])
  return NextResponse.json({ ok: true })
}
