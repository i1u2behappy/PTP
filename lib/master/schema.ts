/** product_master 고정 컬럼 전체 목록(= lib/transform/generate.ts의 FIXED_TARGET_FIELDS와 동일 집합) —
 *  기준마스터 그리드에 "기본 컬럼 전체 추가" 시 씨드로 쓰고, mallSource가 있으면 스크래핑 시 mall_products의
 *  그 컬럼값으로 자동 채워짐을, null이면 스크래핑엔 없어 후속 절차(Transform/연속관리 등)로 채워야 함을 뜻한다.
 *  서버 전용 의존성이 없는 순수 데이터라 클라이언트 컴포넌트에서 그대로 import해도 된다. */
export const FIXED_FIELD_INFO: { key: string; label: string; mallSource: string | null }[] = [
  { key: 'name_final', label: '최종 상품명', mallSource: null },
  { key: 'master_category', label: '기준 카테고리', mallSource: null },
  { key: 'brand', label: '브랜드', mallSource: 'brand' },
  { key: 'manufacturer', label: '제조사', mallSource: 'manufacturer' },
  { key: 'origin', label: '원산지', mallSource: 'origin' },
  // "상세설명"이 실제 상세페이지 본문이 아니라 og:description/meta description(SEO 문구)로 채워지던
  // 문제를 사용자가 지적해, 실제 본문 텍스트(raw_data.detail_text)를 우선 쓰도록 migrateToMaster를
  // 고쳤다(2026-08) — 본문이 없는 몰(설명이 이미지로만 된 경우 등)만 예전처럼 SEO 문구로 폴백한다.
  { key: 'description', label: '상세설명', mallSource: 'description' },
  // cost_price/shipping_fee는 mall_products 정식 컬럼이 아니라 raw_data JSONB 안에 몰에 따라 있을 수도
  // 없을 수도 있는 값이다(lib/master/migrate.ts) — 있으면 migrateToMaster가 자동으로 채우지만 보장되진
  // 않아 그리드에는 "스크래핑에 없음"으로 표시한다(완전히 틀린 말은 아니지만 몰에 따라 다름).
  { key: 'cost_price', label: '원가', mallSource: null },
  // list_price(정상가) = 몰의 소비자판가(mall_products.price, 할인 전 가격). sale_price(판매가)와 혼동하지
  // 말 것 — 2026-08 사용자 지적으로 마이그레이션 로직의 실제 버그(정상가에 판매가가 잘못 들어가던 것)를
  // 발견해 lib/master/migrate.ts에서 함께 고쳤다.
  { key: 'list_price', label: '정상가', mallSource: 'price' },
  { key: 'sale_price', label: '판매가', mallSource: 'sale_price' },
  { key: 'shipping_fee', label: '배송비', mallSource: null },
  { key: 'other_cost', label: '기타비용', mallSource: null },
  { key: 'stock_status', label: '재고상태', mallSource: 'stock_status' },
  { key: 'stock_qty', label: '재고수량', mallSource: 'stock_qty' },
  { key: 'internal_code', label: '내부관리코드', mallSource: null },
  { key: 'sales_code', label: '판매관리코드', mallSource: null },
]
