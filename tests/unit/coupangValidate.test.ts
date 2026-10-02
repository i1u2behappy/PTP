import { describe, it, expect } from 'vitest'
import { coupangAdapter } from '../../lib/marketplace/coupang'
import type { ProductMasterRow } from '../../lib/excel/types'
import type { CategoryMeta } from '../../lib/marketplace/types'

const BASE_PRODUCT: ProductMasterRow = {
  id: 1, name_original: '테스트 상품', name_ai: null, name_final: '테스트 상품',
  category: '신발', brand: '테스트브랜드', manufacturer: '테스트제조사', origin: '국내산',
  description: '설명', options: [{ name: '색상', values: ['빨강', '파랑'] }], option_combinations: [],
  cost_price: 1000, list_price: 2000, sale_price: 1500, shipping_fee: 3000, other_cost: null,
  target_margin_rate: null, stock_status: 'in_stock', stock_qty: 10,
  thumbnail_url: 'https://example.com/a.jpg', detail_image_urls: [],
}

describe('coupangAdapter.validate', () => {
  it('필수 속성이 상품 옵션에 다 있으면 통과한다', () => {
    const meta: CategoryMeta = { attributes: [{ name: '색상', required: true }], notices: [] }
    const result = coupangAdapter.validate(BASE_PRODUCT, meta)
    expect(result.ok).toBe(true)
    expect(result.errors).toEqual([])
  })

  it('필수 속성이 옵션에 없으면 에러로 보고한다', () => {
    const meta: CategoryMeta = { attributes: [{ name: '사이즈', required: true }], notices: [] }
    const result = coupangAdapter.validate(BASE_PRODUCT, meta)
    expect(result.ok).toBe(false)
    expect(result.errors).toEqual([{ field: '사이즈', reason: expect.any(String) }])
  })

  it('선택(OPTIONAL) 속성은 없어도 에러가 아니다', () => {
    const meta: CategoryMeta = { attributes: [{ name: '사이즈', required: false }], notices: [] }
    const result = coupangAdapter.validate(BASE_PRODUCT, meta)
    expect(result.ok).toBe(true)
  })

  it('고시정보(notices)는 이 단계에서 검증 대상이 아니다 — 데이터 근거 없이 임의로 통과시키지 않기 위해 애초에 안 본다', () => {
    const meta: CategoryMeta = { attributes: [], notices: [{ categoryName: '공통', name: '품질보증기준', required: true }] }
    const result = coupangAdapter.validate(BASE_PRODUCT, meta)
    expect(result.ok).toBe(true)
  })
})
