import { NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'

export async function GET() {
  const res = await pool.query<{ base_url: string }>(`SELECT base_url FROM image_host_config ORDER BY id DESC LIMIT 1`)
  return NextResponse.json({ baseUrl: res.rows[0]?.base_url || '' })
}

/**
 * 새 base_url 행을 추가한다 (append-only). 기존 행/이미지 경로는 손대지 않고, 이후 조회·내보내기 때
 * 항상 "최신 base_url + 저장경로"로 조립되므로 이 한 번의 저장이 곧 전체 이미지 URL의 일괄 편집이다.
 */
export async function POST(req: NextRequest) {
  const { baseUrl } = await req.json() as { baseUrl: string }
  await pool.query(`INSERT INTO image_host_config (base_url) VALUES ($1)`, [baseUrl || ''])
  return NextResponse.json({ ok: true })
}
