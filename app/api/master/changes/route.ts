import { NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'

interface Row {
  mall_product_id: number
  master_id: number
  client_id: number
  name_original: string
  mall_product_code: string
  mp_stock_status: string | null
  pm_stock_status: string | null
  mp_stock_qty: number | null
  pm_stock_qty: number | null
  mp_options: { name: string; values: string[] }[] | null
  pm_options: { name: string; values: string[] }[] | null
  mp_price: number | null
  mp_sale_price: number | null
  pm_sale_price: number | null
  pm_list_price: number | null
  thumbnail_urls: string[] | null
  detail_image_urls: string[] | null
  existing_image_count: string
  last_scraped_at: string | null
  updated_at: string
  mp_custom_fields: Record<string, string> | null
  pm_custom_fields: Record<string, string> | null
}

/**
 * 이미 상품마스터로 마이그레이션된 상품 중, 몰 쪽에서 재스크랩된 최신 값(mall_products)이 상품마스터에
 * 저장된 값과 달라진 것을 찾는다 — 재고/옵션/이미지 개수/추가필드(custom_fields)는 migrateToMaster가
 * 그대로 덮어쓰는 필드라 실제 변경 여부를 보여주고, 가격은 자동으로 덮어쓰지 않는 필드라 참고용으로만
 * 표시한다(재마이그레이션해도 안 바뀜).
 */
export async function GET(req: NextRequest) {
  const siteId = Number(req.nextUrl.searchParams.get('siteId'))
  if (!siteId) return NextResponse.json({ error: 'siteId required' }, { status: 400 })
  // all=1: 변동 여부와 무관하게 이 몰의 확정 상품을 전부 반환 — "현재 상태 체킹(재수집)" 대상 선택용
  const includeAll = req.nextUrl.searchParams.get('all') === '1'

  const res = await pool.query<Row>(
    `SELECT mp.id AS mall_product_id, pm.id AS master_id, pm.client_id, mp.name_original, mp.mall_product_code,
            mp.stock_status AS mp_stock_status, pm.stock_status AS pm_stock_status,
            mp.stock_qty AS mp_stock_qty, pm.stock_qty AS pm_stock_qty,
            mp.options AS mp_options, pm.options AS pm_options,
            mp.price AS mp_price, mp.sale_price AS mp_sale_price,
            pm.sale_price AS pm_sale_price, pm.list_price AS pm_list_price,
            mp.thumbnail_urls, mp.detail_image_urls,
            (SELECT COUNT(*) FROM product_images pi WHERE pi.product_master_id = pm.id) AS existing_image_count,
            mp.last_scraped_at, pm.updated_at,
            COALESCE(mp.raw_data->'custom_fields', '{}'::jsonb) AS mp_custom_fields, pm.custom_fields AS pm_custom_fields
     FROM mall_products mp
     JOIN product_master pm ON pm.id = mp.master_product_id
     WHERE mp.site_id = $1
     ORDER BY mp.last_scraped_at DESC NULLS LAST`,
    [siteId],
  )

  const changes = res.rows.map(r => {
    const reasons: string[] = []
    if ((r.mp_stock_status || '') !== (r.pm_stock_status || '')) {
      reasons.push(`재고상태: ${r.pm_stock_status || '-'} → ${r.mp_stock_status || '-'}`)
    }
    if ((r.mp_stock_qty ?? null) !== (r.pm_stock_qty ?? null)) {
      reasons.push(`재고수량: ${r.pm_stock_qty ?? '-'} → ${r.mp_stock_qty ?? '-'}`)
    }
    if (JSON.stringify(r.mp_options || []) !== JSON.stringify(r.pm_options || [])) {
      reasons.push('옵션 구성 변경')
    }
    const mallImageCount = (r.thumbnail_urls?.length || 0) + (r.detail_image_urls?.length || 0)
    if (mallImageCount !== Number(r.existing_image_count)) {
      reasons.push(`이미지 개수: ${r.existing_image_count}개 → ${mallImageCount}개`)
    }
    const mallPrice = r.mp_sale_price ?? r.mp_price
    const masterPrice = r.pm_sale_price ?? r.pm_list_price
    const priceChanged = mallPrice != null && masterPrice != null && mallPrice !== masterPrice
    if (priceChanged) reasons.push(`몰 가격: ${masterPrice?.toLocaleString()}원 → ${mallPrice?.toLocaleString()}원 (참고용, 자동 반영 안 됨)`)

    // custom_fields는 스크랩 원본(mp_custom_fields)과 상품마스터 현재값(pm_custom_fields)을 통째로
    // 비교하지 않는다 — product_master.custom_fields는 스크랩 원본뿐 아니라 Transform/스크랩 조정이
    // 나중에 덧붙인 키(마스터에만 있고 원본엔 없는 값)도 같이 들어있는 "병합된" 값이라, 통째로 비교하면
    // 그런 키들이 전부 "삭제됨"으로 잘못 떠 노이즈만 쌓인다(2026-10-03, PTP 마이그레이션 로드맵 §04
    // "diff 범위를 넓힌다"). 그래서 "원본에도 있고 마스터에도 있는 키"로 한정해, 그 교집합에서 값이
    // 달라진 것만 변경으로 본다 — migrateToMaster의 custom_fields 병합(새 스크랩값이 같은 키를 덮어씀)이
    // 실제로 상품마스터에 반영될 변경과 정확히 같은 범위다.
    const mpCustom = r.mp_custom_fields || {}
    const pmCustom = r.pm_custom_fields || {}
    const changedCustomKeys = Object.keys(mpCustom).filter(k => k in pmCustom && String(mpCustom[k]) !== String(pmCustom[k]))
    if (changedCustomKeys.length) reasons.push(`추가필드 변경: ${changedCustomKeys.join(', ')}`)

    return {
      mallProductId: r.mall_product_id, masterId: r.master_id, clientId: r.client_id,
      nameOriginal: r.name_original, mallProductCode: r.mall_product_code,
      lastScrapedAt: r.last_scraped_at, updatedAt: r.updated_at,
      reasons, priceOnly: reasons.length > 0 && reasons.every(x => x.includes('참고용')),
    }
  }).filter(c => includeAll || c.reasons.length > 0)

  return NextResponse.json(changes)
}
