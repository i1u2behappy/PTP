import { NextRequest, NextResponse } from 'next/server'
import pool, { encryptSecret, decryptSecret } from '@/lib/db'

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const res = await pool.query(
    `SELECT id, name, url, login_id, login_pw_encrypted, login_pw_iv FROM sites WHERE id = $1`,
    [id],
  )
  if (!res.rows.length) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const site = res.rows[0]
  return NextResponse.json({
    id: site.id, name: site.name, url: site.url, login_id: site.login_id,
    login_pw: decryptSecret(site.login_pw_encrypted, site.login_pw_iv),
  })
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const { name, url, loginId, loginPw } = await req.json() as { name?: string; url: string; loginId?: string; loginPw?: string }
  if (!url) return NextResponse.json({ error: 'url required' }, { status: 400 })

  const { encrypted, iv } = loginPw ? encryptSecret(loginPw) : { encrypted: null, iv: null }
  await pool.query(
    `UPDATE sites SET name=$1, url=$2, login_id=$3, login_pw_encrypted=$4, login_pw_iv=$5 WHERE id=$6`,
    [name || null, url, loginId || null, encrypted, iv, id],
  )
  return NextResponse.json({ ok: true })
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  await pool.query(`DELETE FROM sites WHERE id = $1`, [id])
  return NextResponse.json({ ok: true })
}
