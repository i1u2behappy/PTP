import { NextRequest, NextResponse } from 'next/server'
import pool, { initDb, encryptSecret } from '@/lib/db'

export async function GET(req: NextRequest) {
  await initDb()
  const q = req.nextUrl.searchParams.get('q') || ''
  const res = await pool.query(
    `SELECT s.id, s.name, s.url, s.login_id, s.client_id, c.name AS client_name, s.created_at,
            COALESCE(latest.status = 'error' AND latest.error ILIKE '%차단%', false) AS blocked
     FROM sites s
     LEFT JOIN supply_clients c ON c.id = s.client_id
     LEFT JOIN LATERAL (
       SELECT status, error FROM scrape_sessions WHERE site_id = s.id ORDER BY created_at DESC LIMIT 1
     ) latest ON true
     WHERE s.name ILIKE $1 OR s.url ILIKE $1 OR s.login_id ILIKE $1 OR c.name ILIKE $1
     ORDER BY s.created_at DESC`,
    [`%${q}%`],
  )
  return NextResponse.json(res.rows)
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

export async function POST(req: NextRequest) {
  await initDb()
  const b = await req.json() as SiteBody
  if (!b.url) return NextResponse.json({ error: 'url required' }, { status: 400 })

  const { encrypted, iv } = b.loginPw ? encryptSecret(b.loginPw) : { encrypted: null, iv: null }
  const res = await pool.query<{ id: number }>(
    `INSERT INTO sites (name, url, login_id, login_pw_encrypted, login_pw_iv, client_id,
       custom_name_selector, custom_price_selector, custom_thumbnail_selector, auto_scrape_enabled, auto_scrape_hour)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
    [b.name || null, b.url, b.loginId || null, encrypted, iv, b.clientId || null,
      b.customNameSelector || null, b.customPriceSelector || null, b.customThumbnailSelector || null,
      !!b.autoScrapeEnabled, b.autoScrapeHour ?? null],
  )
  return NextResponse.json({ id: res.rows[0].id })
}
