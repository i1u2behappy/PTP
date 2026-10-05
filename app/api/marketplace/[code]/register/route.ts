import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import pool, { getProductMasterRows } from '@/lib/db'
import { getImageHostBaseUrl, resolveMasterImages } from '@/lib/images'
import { getProductAdapter } from '@/lib/marketplace/registry'
import { loadClientCredentials } from '@/lib/marketplace/credentialStore'
import type { ProductMasterRow } from '@/lib/excel/types'
import type { RegistrationItem } from '@/lib/marketplace/types'

const RegisterSchema = z.object({
  clientId: z.number(),
  categoryCode: z.string().min(1),
  noticeContents: z.record(z.string(), z.string()).default({}),
  productMasterIds: z.array(z.number()).min(1),
  // 거래처가 이 마켓에 판매계정을 여러 개 등록해둔 경우 어느 계정으로 등록할지(2026-10-05 확인).
  // 계정이 1개뿐이면 화면이 아예 선택란을 안 보여주고 'default'를 그대로 보낸다.
  accountLabel: z.string().min(1).default('default'),
})

/**
 * "오픈마켓 등록" 화면의 실행 버튼 — 선택한 상품들을 한 카테고리코드/고시정보 묶음으로 실제 등록한다
 * (!specifications/marketplace-api-integration.md). 한 번에 한 카테고리만 받는 건 쿠팡 카테고리별
 * 슬롯 매핑과 같은 전제("같은 카테고리면 묶어서 처리") — 서로 다른 카테고리 상품을 섞어 선택하면 그
 * 카테고리에 안 맞는 속성/고시정보 검증에서 걸러진다.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ code: string }> }) {
  const { code } = await params
  const parsed = RegisterSchema.safeParse(await req.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message || 'invalid request' }, { status: 400 })
  const { clientId, categoryCode, noticeContents, productMasterIds, accountLabel } = parsed.data

  const adapter = getProductAdapter(code)
  if (!adapter) return NextResponse.json({ error: `${code}는 아직 API 등록을 지원하지 않습니다` }, { status: 400 })

  const cred = await loadClientCredentials(clientId, code, accountLabel)
  if (!cred) return NextResponse.json({ error: '이 거래처에 저장된 접속정보가 없습니다 — 거래처 상세에서 먼저 연동하세요' }, { status: 400 })

  const [rawRows, baseUrl, listingsRes] = await Promise.all([
    getProductMasterRows(productMasterIds),
    getImageHostBaseUrl(),
    // 채널(마켓)별 override — 상품마다 이 마켓에서만 다르게 낼 상품명/가격
    // (!specifications/product-master-architecture-redesign.md §4). search_tags_override는 안 가져온다 —
    // 쿠팡 등록 API(buildCoupangRegistrationPayload)엔 검색태그를 실을 자리가 없어(엑셀 양식에만 있는 컬럼) 쓸 데가 없다.
    pool.query<{ product_master_id: number; channel_name: string | null; price_override: { sale_price?: number; list_price?: number } | null }>(
      `SELECT product_master_id, channel_name, price_override
       FROM product_channel_listings WHERE marketplace_code = $1 AND product_master_id = ANY($2::int[])`,
      [code, productMasterIds],
    ),
  ])
  const listingMap = new Map(listingsRes.rows.map(r => [r.product_master_id, r]))
  const products: ProductMasterRow[] = rawRows.map(r => {
    const { thumbnail_urls, detail_image_urls } = resolveMasterImages(r.images, baseUrl)
    const listing = listingMap.get(r.id)
    const nameOverride = listing?.channel_name?.trim()
    const priceOverride = listing?.price_override
    return {
      ...r,
      category: r.master_category || r.mall_category || '',
      name_final: nameOverride || r.name_final,
      list_price: priceOverride?.list_price ?? r.list_price,
      sale_price: priceOverride?.sale_price ?? r.sale_price,
      search_tags: r.search_tags || '',
      thumbnail_url: thumbnail_urls[0] || '',
      detail_image_urls,
    }
  })

  const items: RegistrationItem[] = products.map(product => ({ product, categoryCode, noticeContents }))
  const result = await adapter.register(items, cred.fields, cred.settings)

  // product_channel_listings는 "지금 상태"만, marketplace_sync_log는 시간순 전체 이력을 남긴다.
  // marketplace_credential_id: 어느 마켓 계정으로 등록했는지 기록해둔다(다중계정 지원,
  // !specifications/product-master-architecture-redesign.md §2.2) — UNIQUE 제약은 아직
  // (product_master_id, marketplace_code) 그대로라 계정이 여러 개여도 지금은 "그 상품의 이 마켓 최신
  // 리스팅 1건"만 남는다(계정별로 따로 남기는 건 계정 선택 UI가 생긴 뒤 과제).
  await Promise.all([
    ...result.success.map(s => pool.query(
      `INSERT INTO product_channel_listings (product_master_id, marketplace_code, marketplace_credential_id, external_product_id, sync_status, last_synced_at, error_message)
       VALUES ($1, $2, $3, $4, 'pending', NOW(), NULL)
       ON CONFLICT (product_master_id, marketplace_code) DO UPDATE SET
         marketplace_credential_id = $3, external_product_id = $4, sync_status = 'pending', last_synced_at = NOW(), error_message = NULL, updated_at = NOW()`,
      [s.productMasterId, code, cred.id, s.externalId],
    )),
    ...result.failed.map(f => pool.query(
      `INSERT INTO product_channel_listings (product_master_id, marketplace_code, marketplace_credential_id, sync_status, last_synced_at, error_message)
       VALUES ($1, $2, $3, 'error', NOW(), $4)
       ON CONFLICT (product_master_id, marketplace_code) DO UPDATE SET
         marketplace_credential_id = $3, sync_status = 'error', last_synced_at = NOW(), error_message = $4, updated_at = NOW()`,
      [f.productMasterId, code, cred.id, f.error],
    )),
    ...result.success.map(s => pool.query(
      `INSERT INTO marketplace_sync_log (product_master_id, marketplace_code, action, success) VALUES ($1, $2, 'register', true)`,
      [s.productMasterId, code],
    )),
    ...result.failed.map(f => pool.query(
      `INSERT INTO marketplace_sync_log (product_master_id, marketplace_code, action, success, error_message) VALUES ($1, $2, 'register', false, $3)`,
      [f.productMasterId, code, f.error],
    )),
  ])

  return NextResponse.json(result)
}
