import type { ProductMasterRow, MarketplaceConfig } from './excel/types'

export interface PricingResult {
  salePrice: number
  supplyPrice: number
  commissionRate: number
  commissionAmount: number
  shippingFee: number
  marginAmount: number
  marginRate: number
}

/** 상품마스터 값 + 마켓 설정(수수료율/기본배송비)으로 실제 가격/마진을 계산한다. */
export function computePricing(master: ProductMasterRow, config: MarketplaceConfig): PricingResult {
  const salePrice = master.sale_price ?? master.list_price ?? 0
  const commissionRate = config.default_commission_rate ?? 0
  const commissionAmount = Math.round(salePrice * commissionRate)
  const shippingFee = master.shipping_fee ?? config.default_shipping_fee ?? 0
  const costPrice = master.cost_price ?? 0
  const otherCost = master.other_cost ?? 0

  const supplyPrice = salePrice - commissionAmount
  const marginAmount = salePrice - costPrice - commissionAmount - otherCost
  const marginRate = salePrice > 0 ? marginAmount / salePrice : 0

  return { salePrice, supplyPrice, commissionRate, commissionAmount, shippingFee, marginAmount, marginRate }
}
