/** "기준 Master DB" 엑셀 헤더를 상품마스터 고정 컬럼과 매칭 추정한다 — 확정은 사람이 한다(자동판별 과신 금지). */
const FIELD_LABEL_PATTERNS: [RegExp, string][] = [
  [/상품명|제품명/, 'name_final'],
  [/카테고리|분류/, 'master_category'],
  [/브랜드/, 'brand'],
  [/제조사|제조업체/, 'manufacturer'],
  [/원산지/, 'origin'],
  [/설명|상세설명/, 'description'],
  [/원가|매입가/, 'cost_price'],
  [/정가|소비자가/, 'list_price'],
  [/판매가|공급가/, 'sale_price'],
  [/배송비/, 'shipping_fee'],
  [/기타비용/, 'other_cost'],
  [/재고상태/, 'stock_status'],
  [/재고수량|재고/, 'stock_qty'],
  [/내부코드|관리코드/, 'internal_code'],
  [/판매관리코드|판매코드/, 'sales_code'],
]

/** 헤더 하나당 매칭된 고정 컬럼명(없으면 null)을 반환 — PUT 확정 전 초안 표시용. */
export function guessFixedFieldMapping(headers: string[]): Map<string, string | null> {
  const map = new Map<string, string | null>()
  for (const header of headers) {
    const match = FIELD_LABEL_PATTERNS.find(([re]) => re.test(header))
    map.set(header, match ? match[1] : null)
  }
  return map
}
