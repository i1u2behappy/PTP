import { NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'

/**
 * "스크랩 조정" — 개발자모드 몰 1단계. 백엔드가 페이지를 스스로 못 열어보므로, 프롬프트만 먼저 저장해두고
 * 사용자가 실제 상품 페이지에서 크롬 확장 우클릭 메뉴("PTP 조정 반영")를 실행하면 2단계
 * (app/api/sites/[id]/adjust/capture)가 이 프롬프트를 소비한다.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const body = await req.json() as { prompt: string }
  if (!body.prompt?.trim()) return NextResponse.json({ error: 'prompt가 필요합니다' }, { status: 400 })
  await pool.query(`UPDATE sites SET pending_adjustment_prompt=$1 WHERE id=$2`, [body.prompt, id])
  return NextResponse.json({ ok: true })
}
