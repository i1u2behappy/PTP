import { NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'
import { clearDevPreviewStarted } from '@/lib/devPreviewStatus'

/** 개발자모드 "상품 페이지 미리보기" 시작 — 이전 결과를 비워둬야, 이후 폴링이 "새로 캡처된 결과가
 * 왔는지"를 last_adjustment_preview의 null 여부만으로 판단할 수 있다(사용자가 실제 몰 탭에서 확장
 * 아이콘을 눌러야 채워진다 — PTP 화면 자체는 그 탭에 접근할 방법이 없다). 지난 실행이 남긴 "캡처 시작됨"
 * 신호(preview-progress)도 같이 지운다 — 안 지우면 이번 실행이 아직 대기 중인데도 지난 실행 때 이미
 * 시작된 걸로 착각해 스피너가 곧바로 돌아버린다. */
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  await pool.query(`UPDATE sites SET last_adjustment_preview=NULL WHERE id=$1`, [id])
  clearDevPreviewStarted(Number(id))
  return NextResponse.json({ ok: true })
}
