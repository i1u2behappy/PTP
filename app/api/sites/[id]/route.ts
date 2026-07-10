import { NextRequest, NextResponse } from 'next/server'
import pool, { encryptSecret, decryptSecret } from '@/lib/db'

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const res = await pool.query(
    `SELECT id, name, url, login_id, login_pw_encrypted, login_pw_iv, client_id,
            custom_name_selector, custom_price_selector, custom_thumbnail_selector,
            auto_scrape_enabled, auto_scrape_hour
     FROM sites WHERE id = $1`,
    [id],
  )
  if (!res.rows.length) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const site = res.rows[0]
  return NextResponse.json({
    id: site.id, name: site.name, url: site.url, login_id: site.login_id,
    login_pw: decryptSecret(site.login_pw_encrypted, site.login_pw_iv),
    client_id: site.client_id,
    custom_name_selector: site.custom_name_selector,
    custom_price_selector: site.custom_price_selector,
    custom_thumbnail_selector: site.custom_thumbnail_selector,
    auto_scrape_enabled: site.auto_scrape_enabled,
    auto_scrape_hour: site.auto_scrape_hour,
  })
}

interface SiteBody {
  name?: string
  url: string
  loginId?: string
  loginPw?: string
  clientId?: number | null
  customNameSelector?: string
  customPriceSelector?: string
  customThumbnailSelector?: string
  autoScrapeEnabled?: boolean
  autoScrapeHour?: number | null
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const b = await req.json() as SiteBody
  if (!b.url) return NextResponse.json({ error: 'url required' }, { status: 400 })

  const { encrypted, iv } = b.loginPw ? encryptSecret(b.loginPw) : { encrypted: null, iv: null }
  await pool.query(
    `UPDATE sites SET name=$1, url=$2, login_id=$3, login_pw_encrypted=$4, login_pw_iv=$5, client_id=$6,
       custom_name_selector=$7, custom_price_selector=$8, custom_thumbnail_selector=$9,
       auto_scrape_enabled=$10, auto_scrape_hour=$11
     WHERE id=$12`,
    [b.name || null, b.url, b.loginId || null, encrypted, iv, b.clientId || null,
      b.customNameSelector || null, b.customPriceSelector || null, b.customThumbnailSelector || null,
      !!b.autoScrapeEnabled, b.autoScrapeHour ?? null, id],
  )
  return NextResponse.json({ ok: true })
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  await pool.query(`DELETE FROM sites WHERE id = $1`, [id])
  return NextResponse.json({ ok: true })
}
