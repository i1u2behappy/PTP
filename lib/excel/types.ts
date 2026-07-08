export interface ProductMasterRow {
  id: number
  name_original: string
  name_ai: string | null
  name_final: string | null
  category: string
  brand: string
  manufacturer: string
  origin: string
  description: string
  options: { name: string; values: string[] }[]
  cost_price: number | null
  list_price: number | null
  sale_price: number | null
  shipping_fee: number | null
  other_cost: number | null
  target_margin_rate: number | null
  stock_status: string | null
  stock_qty: number | null
  thumbnail_url: string
  detail_image_urls: string[]
}

export interface MarketplaceConfig {
  code: string
  name: string
  max_batch_size: number
  default_commission_rate: number
  default_shipping_fee: number
}
