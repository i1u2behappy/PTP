import { NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'

/**
 * "스크랩 조정" — 개발자모드 몰 1단계. 백엔드가 페이지를 스스로 못 열어보므로, 프롬프트만 먼저 저장해두고
 * 사용자가 실제 상품 페이지에서 크롬 확장 우클릭 메뉴("PTP 조정 반영")를 실행하면 2단계
 * (app/api/sites/[id]/adjust/capture)가 이 프롬프트를 소비한다.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const body = await req.json() as { prompt: string; itemId?: number }
  if (!body.prompt?.trim()) return NextResponse.json({ error: 'prompt가 필요합니다' }, { status: 400 })
  // 새 라운드를 시작하는 것이므로, 이전 라운드의 미리보기는 지워 헷갈리지 않게 한다(2단계가 새로 만든다).
  // itemId(화면에 보이던, 방금 스크랩한 세션의 맨 위 상품)를 같이 저장해둬야 확장이 우클릭 시 "이 몰에서
  // 아무 미확정 상품이나 최신순 1건"이 아니라 사용자가 실제로 보고 있던 그 상품을 정확히 테스트 대상으로
  // 고를 수 있다 — 안 그러면 다른(더 나중에 스크랩된) 세션의 상품이 엉뚱하게 골라질 수 있었다.
  await pool.query(
    `UPDATE sites SET pending_adjustment_prompt=$1, last_adjustment_preview=NULL, pending_adjustment_item_id=$2 WHERE id=$3`,
    [body.prompt, body.itemId ?? null, id],
  )
  return NextResponse.json({ ok: true })
}
