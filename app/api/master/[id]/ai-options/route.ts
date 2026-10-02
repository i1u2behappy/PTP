import { NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'
import { cleanupProductOptions } from '@/lib/ai'

/**
 * "옵션 관리" 화면의 "✨ AI 정리" — 화면에 떠 있는 옵션 초안 텍스트(아직 저장 전일 수 있음)를 AI가 정리해
 * 돌려준다. 다른 AI 버튼들과 같은 원칙으로 여기서 DB에 바로 반영하지 않는다 — 사람이 결과를 보고 "저장"을
 * 눌러야 실제로 반영된다.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const { rawText } = await req.json().catch(() => ({})) as { rawText?: string }

  const res = await pool.query<{ name_original: string; name_final: string | null }>(
    `SELECT name_original, name_final FROM product_master WHERE id=$1`,
    [id],
  )
  const p = res.rows[0]
  if (!p) return NextResponse.json({ error: 'not found' }, { status: 404 })

  const groups = await cleanupProductOptions(p.name_final || p.name_original || '', rawText || '').catch(() => [])
  return NextResponse.json(groups)
}
