import { NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'
import { generateClientCode } from '@/lib/clientCode'

interface ClientBody {
  name: string
  code?: string
  autoInternalCode?: boolean
  memo?: string
  businessRegNo?: string
  representativeName?: string
  businessAddress?: string
  businessType?: string
  businessItem?: string
  contactName?: string
  contactPhone?: string
  contactEmail?: string
}

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams.get('q') || ''
  const res = await pool.query(
    `SELECT id, name, code, memo, business_reg_no, business_reg_doc_path, representative_name, business_address, business_type, business_item,
            contact_name, contact_phone, contact_email, payment_accounts, created_at
     FROM supply_clients
     WHERE id <> 1
       -- 그리드가 보여주는 컬럼 중 거래처코드/결제 정보가 검색에서 빠져있었다(사용자 지적, 2026-08-17).
       -- payment_accounts는 배열(JSONB)이라 원문 텍스트로 캐스팅해 그 안의 입금주/결제수단/계좌를 그대로
       -- 부분일치 검색한다 — 사업자등록증 첨부여부는 파일 첨부 유무 배지일 뿐 텍스트 검색 대상이 아니라 뺀다.
       AND (name ILIKE $1 OR code ILIKE $1 OR memo ILIKE $1 OR business_reg_no ILIKE $1 OR representative_name ILIKE $1
        OR business_address ILIKE $1 OR business_type ILIKE $1 OR business_item ILIKE $1
        OR contact_name ILIKE $1 OR contact_phone ILIKE $1 OR contact_email ILIKE $1
        OR payment_accounts::text ILIKE $1)
     ORDER BY created_at DESC`,
    [`%${q}%`],
  )
  return NextResponse.json(res.rows)
}

export async function POST(req: NextRequest) {
  const b = await req.json() as ClientBody
  if (!b.name) return NextResponse.json({ error: 'name required' }, { status: 400 })

  const code = await generateClientCode(b.name, b.businessRegNo)
  const res = await pool.query<{ id: number }>(
    `INSERT INTO supply_clients (name, code, auto_internal_code, memo, business_reg_no, representative_name, business_address, business_type, business_item, contact_name, contact_phone, contact_email)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
    [b.name, code, b.autoInternalCode ?? true, b.memo || null, b.businessRegNo || null, b.representativeName || null, b.businessAddress || null,
      b.businessType || null, b.businessItem || null, b.contactName || null, b.contactPhone || null, b.contactEmail || null],
  )
  return NextResponse.json({ id: res.rows[0].id })
}
