import { NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'
import { resolveSessionGroup } from '@/lib/scrape/mergeGroup'
import { suggestMarginRates, type MarginRateExample, type MarginRateTarget } from '@/lib/ai'

interface Row {
  id: number
  name: string
  category: string | null
  cost_price: number | null
  sale_price: number | null
  target_margin_rate: number | null
}

/**
 * "가격 및 이익 관리" 화면의 "✨ AI 목표마진율 추천" — 이 세션에서 이미 사람이 설정해둔 목표 마진율을
 * few-shot 예시로 주고, 아직 비어있는 상품에 추천값을 제안한다. 여기서는 제안만 반환하고 DB는 바꾸지
 * 않는다 — 화면에서 사람이 검토한 뒤 받아들인 것만 기존 저장(PUT /api/master/[id])으로 적용한다.
 */
export async function POST(req: NextRequest) {
  const { sessionId } = await req.json().catch(() => ({})) as { sessionId?: number }
  if (!sessionId) return NextResponse.json({ error: 'sessionId required' }, { status: 400 })

  const sessionGroup = await resolveSessionGroup(sessionId)
  const res = await pool.query<Row>(
    `SELECT pm.id,
            COALESCE(pm.name_final, pm.name_ai, pm.name_original) AS name,
            pm.master_category AS category,
            pm.cost_price, pm.sale_price, pm.target_margin_rate
     FROM product_master pm
     JOIN mall_products mp ON mp.id = pm.mall_product_id
     JOIN scrape_staging_items si ON si.matched_mall_product_id = mp.id
     WHERE si.session_id = ANY($1)
     GROUP BY pm.id`,
    [sessionGroup],
  )

  const examples: MarginRateExample[] = res.rows
    .filter(r => r.target_margin_rate != null)
    .map(r => ({ name: r.name, category: r.category || '', costPrice: r.cost_price, salePrice: r.sale_price, marginRate: Math.round(Number(r.target_margin_rate) * 100) }))
  const targets: MarginRateTarget[] = res.rows
    .filter(r => r.target_margin_rate == null && (r.cost_price != null || r.sale_price != null))
    .map(r => ({ id: r.id, name: r.name, category: r.category || '', costPrice: r.cost_price, salePrice: r.sale_price }))

  const suggestions = await suggestMarginRates(examples, targets).catch(() => [])
  return NextResponse.json(suggestions)
}
