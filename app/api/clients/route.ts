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

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams.get('q') || ''
  const res = await pool.query(
    `SELECT id, name, memo, business_reg_no, representative_name, business_address, business_type, business_item,
            contact_name, contact_phone, contact_email, created_at
     FROM supply_clients
     WHERE name ILIKE $1 OR memo ILIKE $1 OR business_reg_no ILIKE $1 OR representative_name ILIKE $1
        OR business_address ILIKE $1 OR business_type ILIKE $1 OR business_item ILIKE $1
        OR contact_name ILIKE $1 OR contact_phone ILIKE $1 OR contact_email ILIKE $1
     ORDER BY created_at DESC`,
    [`%${q}%`],
  )
  return NextResponse.json(res.rows)
}

export async function POST(req: NextRequest) {
  const b = await req.json() as ClientBody
  if (!b.name) return NextResponse.json({ error: 'name required' }, { status: 400 })

  const res = await pool.query<{ id: number }>(
    `INSERT INTO supply_clients (name, memo, business_reg_no, representative_name, business_address, business_type, business_item, contact_name, contact_phone, contact_email)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
    [b.name, b.memo || null, b.businessRegNo || null, b.representativeName || null, b.businessAddress || null,
      b.businessType || null, b.businessItem || null, b.contactName || null, b.contactPhone || null, b.contactEmail || null],
  )
  return NextResponse.json({ id: res.rows[0].id })
}
