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
  /** 옵션1↔옵션2 실제 조합 — 비어있으면(과거 데이터 등) options의 카티전 곱으로 근사해야 한다는 뜻이다.
   *  !specifications/cascading-option-combinations.md 참고. */
  option_combinations: string[][]
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
  /** 검색어(태그), 쉼표 구분 — 마켓별 override가 있으면 export route에서 이미 반영된 값(product_master
   *  공통값 또는 그 마켓 전용값)이 여기 들어있다. !specifications/product-master-architecture-redesign.md §4 */
  search_tags: string
}

export interface MarketplaceConfig {
  code: string
  name: string
  max_batch_size: number
  default_commission_rate: number
  default_shipping_fee: number
}
