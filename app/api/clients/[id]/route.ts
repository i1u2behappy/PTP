import { NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'

interface PaymentAccount {
  payerName: string
  paymentMethod: string
  bankAccount: string
}

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
  paymentAccounts?: PaymentAccount[]
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const clientRes = await pool.query(
    `SELECT id, name, code, auto_internal_code, memo, business_reg_no, business_reg_doc_path, business_reg_doc_name,
            representative_name, business_address, business_type, business_item,
            contact_name, contact_phone, contact_email, payment_accounts
     FROM supply_clients WHERE id = $1`,
    [id],
  )
  if (!clientRes.rows.length) return NextResponse.json({ error: 'not found' }, { status: 404 })

  const mallRes = await pool.query(
    `SELECT id, name, url, login_id FROM sites WHERE client_id = $1 ORDER BY created_at DESC`,
    [id],
  )

  return NextResponse.json({ ...clientRes.rows[0], malls: mallRes.rows })
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const b = await req.json() as ClientBody
  if (!b.name) return NextResponse.json({ error: 'name required' }, { status: 400 })

  // 빈 값만 있는 행(사용자가 +를 눌렀다가 아무것도 안 채운 경우)은 저장하지 않는다.
  const paymentAccounts = (b.paymentAccounts || []).filter(p => p.payerName || p.paymentMethod || p.bankAccount)

  await pool.query(
    `UPDATE supply_clients SET name=$1, code=$2, auto_internal_code=$3, memo=$4, business_reg_no=$5, representative_name=$6, business_address=$7,
       business_type=$8, business_item=$9, contact_name=$10, contact_phone=$11, contact_email=$12, payment_accounts=$13 WHERE id=$14`,
    [b.name, b.code || null, b.autoInternalCode ?? true, b.memo || null, b.businessRegNo || null, b.representativeName || null, b.businessAddress || null,
      b.businessType || null, b.businessItem || null, b.contactName || null, b.contactPhone || null, b.contactEmail || null,
      JSON.stringify(paymentAccounts), id],
  )
  return NextResponse.json({ ok: true })
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  await pool.query(`DELETE FROM supply_clients WHERE id = $1`, [id])
  return NextResponse.json({ ok: true })
}
