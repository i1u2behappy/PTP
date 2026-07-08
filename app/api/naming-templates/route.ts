import { NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'

export async function GET() {
  const res = await pool.query(
    `SELECT id, name, prompt_template, max_length, is_default FROM naming_templates ORDER BY is_default DESC, created_at DESC`,
  )
  return NextResponse.json(res.rows)
}

export async function POST(req: NextRequest) {
  const { name, promptTemplate, maxLength, isDefault } = await req.json() as {
    name: string; promptTemplate: string; maxLength?: number; isDefault?: boolean
  }
  if (!name || !promptTemplate) return NextResponse.json({ error: 'name, promptTemplate required' }, { status: 400 })

  if (isDefault) await pool.query(`UPDATE naming_templates SET is_default=false`)
  const res = await pool.query<{ id: number }>(
    `INSERT INTO naming_templates (name, prompt_template, max_length, is_default) VALUES ($1,$2,$3,$4) RETURNING id`,
    [name, promptTemplate, maxLength || 20, !!isDefault],
  )
  return NextResponse.json({ id: res.rows[0].id })
}
