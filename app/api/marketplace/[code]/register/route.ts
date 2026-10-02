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
  const { clientId, categoryCode, noticeContents, productMasterIds } = parsed.data

  const adapter = getProductAdapter(code)
  if (!adapter) return NextResponse.json({ error: `${code}는 아직 API 등록을 지원하지 않습니다` }, { status: 400 })

  const cred = await loadClientCredentials(clientId, code)
  if (!cred) return NextResponse.json({ error: '이 거래처에 저장된 접속정보가 없습니다 — 거래처 상세에서 먼저 연동하세요' }, { status: 400 })

  const [rawRows, baseUrl] = await Promise.all([getProductMasterRows(productMasterIds), getImageHostBaseUrl()])
  const products: ProductMasterRow[] = rawRows.map(r => {
    const { thumbnail_urls, detail_image_urls } = resolveMasterImages(r.images, baseUrl)
    return {
      ...r,
      category: r.master_category || r.mall_category || '',
      thumbnail_url: thumbnail_urls[0] || '',
      detail_image_urls,
    }
  })

  const items: RegistrationItem[] = products.map(product => ({ product, categoryCode, noticeContents }))
  const result = await adapter.register(items, cred.fields, cred.settings)

  // product_channel_listings는 "지금 상태"만, marketplace_sync_log는 시간순 전체 이력을 남긴다.
  await Promise.all([
    ...result.success.map(s => pool.query(
      `INSERT INTO product_channel_listings (product_master_id, marketplace_code, external_product_id, sync_status, last_synced_at, error_message)
       VALUES ($1, $2, $3, 'pending', NOW(), NULL)
       ON CONFLICT (product_master_id, marketplace_code) DO UPDATE SET
         external_product_id = $3, sync_status = 'pending', last_synced_at = NOW(), error_message = NULL, updated_at = NOW()`,
      [s.productMasterId, code, s.externalId],
    )),
    ...result.failed.map(f => pool.query(
      `INSERT INTO product_channel_listings (product_master_id, marketplace_code, sync_status, last_synced_at, error_message)
       VALUES ($1, $2, 'error', NOW(), $3)
       ON CONFLICT (product_master_id, marketplace_code) DO UPDATE SET
         sync_status = 'error', last_synced_at = NOW(), error_message = $3, updated_at = NOW()`,
      [f.productMasterId, code, f.error],
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
