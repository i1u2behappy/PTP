import { NextResponse } from 'next/server'
import pool from '@/lib/db'
import { listProductAdapterCodes } from '@/lib/marketplace/registry'

/** 화면이 "API로 직접 등록 가능한 마켓"만 선택지로 보여주기 위한 목록(Excel 전용 마켓 제외). */
export async function GET() {
  const codes = listProductAdapterCodes()
  if (codes.length === 0) return NextResponse.json([])
  const res = await pool.query<{ code: string; name: string }>(
    `SELECT code, name FROM marketplace_configs WHERE code = ANY($1) ORDER BY name`,
    [codes],
  )
  return NextResponse.json(res.rows)
}
