import { NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'
import { migrateUnmigratedForSite, countUnmigratedForSite } from '@/lib/master/migrate'

/**
 * "확정"(mergeStagingItems)은 거래처가 없는 몰이어도 되지만, 상품마스터(product_master) 반영은 거래처가
 * 있어야 한다 — 그때 건너뛴 mall_products를 거래처를 나중에 지정한 뒤 소급 반영하는 버튼/자동 트리거용
 * (SiteDetailPanel.tsx, 사용자 요청 2026-08-27: "확정은 확정대로 하고, 나중에 거래처를 설정해서 후속
 * 작업을 할 수 있도록"). 몰 저장(수정 저장) 직후 거래처가 있으면 자동으로도 호출되고, 상세화면의
 * "지금 반영" 버튼으로도 언제든 재시도할 수 있다.
 */
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const siteId = Number(id)
  if (!siteId) return NextResponse.json({ error: 'invalid site id' }, { status: 400 })

  const site = await pool.query<{ client_id: number | null }>('SELECT client_id FROM sites WHERE id=$1', [siteId])
  const clientId = site.rows[0]?.client_id
  if (!clientId) return NextResponse.json({ error: '이 Mall에 거래처가 지정되어 있지 않습니다' }, { status: 400 })

  const { migrated } = await migrateUnmigratedForSite(siteId, clientId)
  const remaining = await countUnmigratedForSite(siteId)
  return NextResponse.json({ migrated, remaining })
}
