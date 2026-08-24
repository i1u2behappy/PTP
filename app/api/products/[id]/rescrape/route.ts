import { NextRequest, NextResponse } from 'next/server'
import pool, { decryptSecret } from '@/lib/db'
import { scrapeSingleProduct } from '@/lib/workerClient'
import { stageScrapedProduct } from '@/lib/scrape/staging'

/** 개별 상품 상세 화면에서 "재스크랩" — 원본 URL을 다시 열어 결과를 스테이징에 쌓는다 (즉시 반영하지 않음). */
export async function POST(_: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params

  const mpRes = await pool.query<{ site_id: number; source_url: string }>(
    `SELECT site_id, source_url FROM mall_products WHERE id=$1`, [id],
  )
  const mallProduct = mpRes.rows[0]
  if (!mallProduct?.source_url) return NextResponse.json({ error: 'not found' }, { status: 404 })

  const siteRes = await pool.query<{
    login_id: string | null; login_pw_encrypted: string | null; login_pw_iv: string | null
    custom_name_selector: string | null; custom_price_selector: string | null; custom_thumbnail_selector: string | null
  }>(
    `SELECT login_id, login_pw_encrypted, login_pw_iv, custom_name_selector, custom_price_selector, custom_thumbnail_selector
     FROM sites WHERE id=$1`, [mallProduct.site_id],
  )
  const site = siteRes.rows[0]

  const sessionRes = await pool.query<{ id: number }>(
    `INSERT INTO scrape_sessions (url, site_id, login_id, status, scope_type, mode)
     VALUES ($1,$2,$3,'running','products','incremental') RETURNING id`,
    [mallProduct.source_url, mallProduct.site_id, site?.login_id || null],
  )
  const sessionId = sessionRes.rows[0].id

  try {
    // allowStaleManualLoginProfile: "재스크랩" 버튼은 몰 종류(일반모드/개발자모드) 구분 없이 항상 보인다
    // — 개발자모드 몰은 실제 크롬을 켜둔 채 쓰는 게 정상 상태라 세션 파일이 잠긴 채 복사돼도(robocopy
    // 일부 실패) 이 재수집은 그냥 진행해야 한다(몰 구조분석 등에 이미 적용한 것과 동일, 2026-08-16).
    const result = await scrapeSingleProduct({
      url: mallProduct.source_url,
      siteId: mallProduct.site_id,
      loginId: site?.login_id || undefined,
      loginPw: site ? decryptSecret(site.login_pw_encrypted, site.login_pw_iv) || undefined : undefined,
      nameSelector: site?.custom_name_selector || undefined,
      priceSelector: site?.custom_price_selector || undefined,
      thumbnailSelector: site?.custom_thumbnail_selector || undefined,
      allowStaleManualLoginProfile: true,
    })
    const { id: stagingId } = await stageScrapedProduct({ siteId: mallProduct.site_id, sessionId }, result)

    const staged = await pool.query<{ is_already_migrated: boolean }>(
      `SELECT is_already_migrated FROM scrape_staging_items WHERE id=$1`, [stagingId],
    )

    await pool.query(`UPDATE scrape_sessions SET status='done', product_count=1 WHERE id=$1`, [sessionId])
    return NextResponse.json({ stagingId, isAlreadyMigrated: !!staged.rows[0]?.is_already_migrated })
  } catch (err) {
    await pool.query(`UPDATE scrape_sessions SET status='error', error=$1 WHERE id=$2`, [String(err), sessionId])
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}
