import { NextRequest, NextResponse } from 'next/server'
import pool, { encryptSecret, decryptSecret } from '@/lib/db'
import { profileDir } from '@/lib/scraper'
import { isAdminRequest } from '@/lib/auth'

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const res = await pool.query(
    `SELECT id, name, url, login_url, login_id, login_pw_encrypted, login_pw_iv, client_id,
            custom_name_selector, custom_price_selector, custom_thumbnail_selector,
            auto_scrape_enabled, auto_scrape_hour, manual_login_required, main_items, extraction_rules,
            last_adjustment_preview, devmode_ai_preview, scrape_profile, scrape_profile_updated_at, memo
     FROM sites WHERE id = $1`,
    [id],
  )
  if (!res.rows.length) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const site = res.rows[0]
  return NextResponse.json({
    id: site.id, name: site.name, url: site.url, login_url: site.login_url, login_id: site.login_id,
    login_pw: decryptSecret(site.login_pw_encrypted, site.login_pw_iv),
    client_id: site.client_id,
    custom_name_selector: site.custom_name_selector,
    custom_price_selector: site.custom_price_selector,
    custom_thumbnail_selector: site.custom_thumbnail_selector,
    auto_scrape_enabled: site.auto_scrape_enabled,
    auto_scrape_hour: site.auto_scrape_hour,
    manual_login_required: site.manual_login_required,
    main_items: site.main_items,
    memo: site.memo,
    extraction_rules: site.extraction_rules,
    last_adjustment_preview: site.last_adjustment_preview,
    devmode_ai_preview: site.devmode_ai_preview,
    // "몰 구조 파악"의 거래정보 리포트(있으면) — SiteDetailPanel이 운영 메모 아래 참고용으로 표시한다.
    mall_report: site.scrape_profile?.report ?? null,
    mall_report_updated_at: site.scrape_profile_updated_at,
    profile_dir: profileDir(site.id),
  })
}

interface SiteBody {
  name?: string
  url: string
  loginUrl?: string
  loginId?: string
  loginPw?: string
  clientId?: number | null
  customNameSelector?: string
  customPriceSelector?: string
  customThumbnailSelector?: string
  autoScrapeEnabled?: boolean
  autoScrapeHour?: number | null
  manualLoginRequired?: boolean | null
  mainItems?: string
  memo?: string
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const b = await req.json() as SiteBody
  if (!b.name) return NextResponse.json({ error: 'name required' }, { status: 400 })
  if (!b.url) return NextResponse.json({ error: 'url required' }, { status: 400 })

  const { encrypted, iv } = b.loginPw ? encryptSecret(b.loginPw) : { encrypted: null, iv: null }
  await pool.query(
    `UPDATE sites SET name=$1, url=$2, login_url=$3, login_id=$4, login_pw_encrypted=$5, login_pw_iv=$6, client_id=$7,
       custom_name_selector=$8, custom_price_selector=$9, custom_thumbnail_selector=$10,
       auto_scrape_enabled=$11, auto_scrape_hour=$12, manual_login_required=$13, main_items=$14, memo=$15
     WHERE id=$16`,
    [b.name, b.url, b.loginUrl || null, b.loginId || null, encrypted, iv, b.clientId || null,
      b.customNameSelector || null, b.customPriceSelector || null, b.customThumbnailSelector || null,
      !!b.autoScrapeEnabled, b.autoScrapeHour ?? null, b.manualLoginRequired ?? null, b.mainItems || null, b.memo || null, id],
  )
  return NextResponse.json({ ok: true })
}

/** 스크래핑 화면에서 "일반모드/개발자모드" 중 하나를 확정하거나, 개발자모드 미리보기의 AI모드를 켤 때 쓰는
 * 최소 갱신 — 로그인정보/셀렉터 등 전체 필드를 요구하는 PUT과 달리 이 값들만 바꾼다(그 화면은 다른 필드를
 * 갖고 있지 않아, PUT을 그대로 쓰면 나머지 필드를 실수로 지울 위험이 있다). */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const b = await req.json() as { manualLoginRequired?: boolean; devmodeAiPreview?: boolean }
  if (typeof b.manualLoginRequired !== 'boolean' && typeof b.devmodeAiPreview !== 'boolean') {
    return NextResponse.json({ error: 'manualLoginRequired 또는 devmodeAiPreview 중 하나가 필요합니다' }, { status: 400 })
  }
  if (typeof b.manualLoginRequired === 'boolean') {
    await pool.query(`UPDATE sites SET manual_login_required=$1 WHERE id=$2`, [b.manualLoginRequired, id])
  }
  if (typeof b.devmodeAiPreview === 'boolean') {
    await pool.query(`UPDATE sites SET devmode_ai_preview=$1 WHERE id=$2`, [b.devmodeAiPreview, id])
  }
  return NextResponse.json({ ok: true })
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!isAdminRequest(req)) return NextResponse.json({ error: '관리자 권한이 필요합니다.' }, { status: 403 })
  const { id } = await params
  await pool.query(`DELETE FROM sites WHERE id = $1`, [id])
  return NextResponse.json({ ok: true })
}
