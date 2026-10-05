import { describe, it, expect } from 'vitest'
import { buildCoupangRegistrationPayload } from '../../lib/marketplace/coupang'
import type { ProductMasterRow } from '../../lib/excel/types'
import type { CategoryMeta, RegistrationItem } from '../../lib/marketplace/types'

const PRODUCT: ProductMasterRow = {
  id: 42, name_original: '원본상품명', name_ai: null, name_final: '등록용 상품명',
  category: '신발', brand: '브랜드', manufacturer: '제조사', origin: '국내산',
  description: '설명', options: [{ name: '색상', values: ['빨강', '파랑'] }], option_combinations: [],
  cost_price: 1000, list_price: 20000, sale_price: 15000, shipping_fee: 3000, other_cost: null,
  target_margin_rate: null, stock_status: 'in_stock', stock_qty: 7,
  thumbnail_url: 'https://example.com/thumb.jpg', detail_image_urls: ['https://example.com/d1.jpg'],
  search_tags: '',
}

const EMPTY_META: CategoryMeta = { attributes: [], notices: [] }

const FULL_SETTINGS: Record<string, string> = {
  deliveryMethod: 'SEQUENCIAL', deliveryCompanyCode: 'CJGLS', deliveryChargeType: 'FREE',
  deliveryChargeOnReturn: '3000', remoteAreaDeliverable: 'N', returnCenterCode: 'NO_RETURN_CENTERCODE',
  companyContactNumber: '02-1234-5678', returnZipCode: '12345', returnAddress: '서울시 어딘가',
  returnAddressDetail: '2층', returnCharge: '5000',
}

function item(overrides: Partial<RegistrationItem> = {}): RegistrationItem {
  return { product: PRODUCT, categoryCode: '78877', noticeContents: {}, ...overrides }
}

describe('buildCoupangRegistrationPayload', () => {
  it('필수 배송/반품 설정이 비어있으면 에러를 반환하고 payload를 만들지 않는다', () => {
    const result = buildCoupangRegistrationPayload(item(), 'A00000000', {}, EMPTY_META)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      const fields = result.errors.map(e => e.field)
      expect(fields).toContain('deliveryMethod')
      expect(fields).toContain('returnCenterCode')
    }
  })

  it('카테고리 필수 구매옵션 속성이 상품 옵션에 없으면 에러를 반환한다', () => {
    const meta: CategoryMeta = { attributes: [{ name: '사이즈', required: true }], notices: [] }
    const result = buildCoupangRegistrationPayload(item(), 'A00000000', FULL_SETTINGS, meta)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.some(e => e.field === '사이즈')).toBe(true)
  })

  it('필수 고시정보 내용이 공급되지 않으면 에러를 반환한다', () => {
    const meta: CategoryMeta = { attributes: [], notices: [{ categoryName: '신발', name: '소재', required: true }] }
    const result = buildCoupangRegistrationPayload(item({ noticeContents: {} }), 'A00000000', FULL_SETTINGS, meta)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.some(e => e.field === '소재')).toBe(true)
  })

  it('필수 고시정보 내용이 공급되면 통과하고 payload의 notices에 그대로 들어간다', () => {
    const meta: CategoryMeta = { attributes: [], notices: [{ categoryName: '신발', name: '소재', required: true }] }
    const result = buildCoupangRegistrationPayload(item({ noticeContents: { 소재: '가죽' } }), 'A00000000', FULL_SETTINGS, meta)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.payload.items[0].notices).toEqual([{ noticeCategoryName: '신발', noticeCategoryDetailName: '소재', content: '가죽' }])
    }
  })

  it('옵션 조합이 없으면 item을 1개만 만들고 attributes는 비어있다', () => {
    const product: ProductMasterRow = { ...PRODUCT, options: [], option_combinations: [] }
    const result = buildCoupangRegistrationPayload(item({ product }), 'A00000000', FULL_SETTINGS, EMPTY_META)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.payload.items).toHaveLength(1)
      expect(result.payload.items[0].attributes).toEqual([])
      expect(result.payload.items[0].itemName).toBe('등록용 상품명')
    }
  })

  it('옵션 조합이 있으면 조합 개수만큼 item을 만들고 attributes에 조합값이 들어간다', () => {
    const product: ProductMasterRow = {
      ...PRODUCT,
      options: [{ name: '색상', values: ['빨강', '파랑'] }, { name: '사이즈', values: ['100', '105'] }],
      option_combinations: [['빨강', '100'], ['파랑', '100']],
    }
    const meta: CategoryMeta = { attributes: [{ name: '색상', required: true }, { name: '사이즈', required: true }], notices: [] }
    const result = buildCoupangRegistrationPayload(item({ product }), 'A00000000', FULL_SETTINGS, meta)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.payload.items).toHaveLength(2)
      expect(result.payload.items[0].attributes).toEqual([{ attributeTypeName: '색상', attributeValueName: '빨강' }, { attributeTypeName: '사이즈', attributeValueName: '100' }])
      expect(result.payload.items[0].itemName).toBe('빨강/100')
    }
  })

  it('선택적 설정값은 비어있으면 payload에 키 자체가 없다', () => {
    const settingsWithoutOptional = { ...FULL_SETTINGS }
    delete settingsWithoutOptional.outboundShippingPlaceCode
    const result = buildCoupangRegistrationPayload(item(), 'A00000000', settingsWithoutOptional, EMPTY_META)
    expect(result.ok).toBe(true)
    if (result.ok) expect('outboundShippingPlaceCode' in result.payload).toBe(false)
  })

  it('판매기간은 "yyyy-MM-ddTHH:mm:ss" 형식이고 종료일이 시작일보다 미래다', () => {
    const result = buildCoupangRegistrationPayload(item(), 'A00000000', FULL_SETTINGS, EMPTY_META)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.payload.saleStartedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/)
      expect(result.payload.saleEndedAt > result.payload.saleStartedAt).toBe(true)
    }
  })

  it('categoryCode는 숫자로 변환된다', () => {
    const result = buildCoupangRegistrationPayload(item({ categoryCode: '78877' }), 'A00000000', FULL_SETTINGS, EMPTY_META)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.payload.displayCategoryCode).toBe(78877)
  })

  it('대표이미지가 없으면 에러를 반환한다', () => {
    const product: ProductMasterRow = { ...PRODUCT, thumbnail_url: '', detail_image_urls: [] }
    const result = buildCoupangRegistrationPayload(item({ product }), 'A00000000', FULL_SETTINGS, EMPTY_META)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.some(e => e.field === 'images')).toBe(true)
  })

  it('이미지 경로가 절대 URL이 아니면(이미지 호스팅 base_url 미설정 등) 에러를 반환한다', () => {
    const product: ProductMasterRow = { ...PRODUCT, thumbnail_url: '/scraped/foo/bar.jpg' }
    const result = buildCoupangRegistrationPayload(item({ product }), 'A00000000', FULL_SETTINGS, EMPTY_META)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.some(e => e.field === 'images')).toBe(true)
  })

  it('대표이미지(REPRESENTATION)와 상세이미지(DETAIL)가 순서대로 들어간다', () => {
    const result = buildCoupangRegistrationPayload(item(), 'A00000000', FULL_SETTINGS, EMPTY_META)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.payload.items[0].images).toEqual([
        { imageOrder: 0, imageType: 'REPRESENTATION', vendorPath: 'https://example.com/thumb.jpg' },
        { imageOrder: 1, imageType: 'DETAIL', vendorPath: 'https://example.com/d1.jpg' },
      ])
    }
  })
})
