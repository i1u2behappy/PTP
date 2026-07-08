import type { ProductMasterRow } from '../excel/types'

export interface UploadResult {
  success: number[]
  failed: { id: number; error: string }[]
}

/**
 * 5단계(오픈마켓 API 연동)의 확장 포인트 — 이번 라운드는 설계만, 구현체는 없다.
 * 향후 마켓별 어댑터(lib/marketplace/coupang-api.ts 등)가 이 인터페이스로 registry.ts에 등록된다.
 */
export interface MarketplaceUploader {
  code: string
  validate(products: ProductMasterRow[]): { ok: boolean; errors: string[] }
  upload(products: ProductMasterRow[], credentials: Record<string, unknown>): Promise<UploadResult>
}
