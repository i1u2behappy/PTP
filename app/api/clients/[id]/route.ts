import { NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'

interface ClientBody {
  name: string
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

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const clientRes = await pool.query(
    `SELECT id, name, memo, business_reg_no, representative_name, business_address, business_type, business_item,
            contact_name, contact_phone, contact_email
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

  await pool.query(
    `UPDATE supply_clients SET name=$1, memo=$2, business_reg_no=$3, representative_name=$4, business_address=$5,
       business_type=$6, business_item=$7, contact_name=$8, contact_phone=$9, contact_email=$10 WHERE id=$11`,
    [b.name, b.memo || null, b.businessRegNo || null, b.representativeName || null, b.businessAddress || null,
      b.businessType || null, b.businessItem || null, b.contactName || null, b.contactPhone || null, b.contactEmail || null, id],
  )
  return NextResponse.json({ ok: true })
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  await pool.query(`DELETE FROM supply_clients WHERE id = $1`, [id])
  return NextResponse.json({ ok: true })
}
