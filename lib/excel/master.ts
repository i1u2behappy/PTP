import type { ProductRow } from './coupang'

export interface MasterFieldDef {
  key: string
  label: string
  /** 이 컬럼의 null 값을 어떤 의미로 채우는지에 대한 설명 */
  meaning: string
  get: (p: ProductRow) => string | number | null
}

// 기존 마켓별 변환 로직(coupang/naver/eleven.ts)에 흩어져 있던 공통 null 처리 규칙을 표준화한 것.
export const MASTER_FIELDS: MasterFieldDef[] = [
  { key: 'name_original', label: '원본상품명', meaning: '원본 그대로 사용', get: p => p.name_original || '' },
  { key: 'name_ai', label: 'AI상품명', meaning: 'AI상품명이 없으면 원본상품명으로 대체', get: p => p.name_ai || p.name_original || '' },
  { key: 'price', label: '정상가', meaning: '정상가가 없으면 판매가로 대체', get: p => p.price ?? p.sale_price ?? null },
  { key: 'sale_price', label: '판매가', meaning: '판매가가 없으면 정상가로 대체', get: p => p.sale_price ?? p.price ?? null },
  { key: 'brand', label: '브랜드', meaning: '대체할 정보 없음 (직접 입력 필요)', get: p => p.brand || '' },
  { key: 'manufacturer', label: '제조사', meaning: '대체할 정보 없음 (직접 입력 필요)', get: p => p.manufacturer || '' },
  { key: 'origin', label: '원산지', meaning: '원산지 미입력시 국내산으로 간주', get: p => p.origin || '국내산' },
  { key: 'category', label: '카테고리', meaning: '대체할 정보 없음 (직접 입력 필요)', get: p => p.category || '' },
  { key: 'thumbnail_local', label: '대표이미지', meaning: '대체할 정보 없음 (직접 입력 필요)', get: p => p.thumbnail_local || '' },
  { key: 'description', label: '설명', meaning: '대체할 정보 없음 (직접 입력 필요)', get: p => p.description || '' },
]

export interface MasterFieldValue {
  original: string | number | null
  value: string | number | null
  /** A값이 비어 있었는데 규칙에 의해 의미 있는 값으로 채워졌는지 */
  filled: boolean
}

/** A(원본 스크래핑 데이터) → B(마스터 데이터) 컬럼별 변환 결과 */
export function buildMasterRow(p: ProductRow): Record<string, MasterFieldValue> {
  const original: Record<string, string | number | null> = {
    name_original: p.name_original ?? null,
    name_ai: p.name_ai ?? null,
    price: p.price ?? null,
    sale_price: p.sale_price ?? null,
    brand: p.brand ?? null,
    manufacturer: p.manufacturer ?? null,
    origin: p.origin ?? null,
    category: p.category ?? null,
    thumbnail_local: p.thumbnail_local ?? null,
    description: p.description ?? null,
  }

  const row: Record<string, MasterFieldValue> = {}
  for (const field of MASTER_FIELDS) {
    const orig = original[field.key]
    const value = field.get(p)
    const wasEmpty = orig === null || orig === ''
    row[field.key] = { original: orig, value, filled: wasEmpty && value !== null && value !== '' }
  }
  return row
}
