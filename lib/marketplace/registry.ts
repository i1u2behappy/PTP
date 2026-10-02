import type { MarketplaceProductAdapter, MarketplaceUploader } from './types'
import { coupangAdapter } from './coupang'

const registry = new Map<string, MarketplaceUploader>()

export function registerUploader(uploader: MarketplaceUploader) {
  registry.set(uploader.code, uploader)
}

export function getUploader(code: string): MarketplaceUploader | undefined {
  return registry.get(code)
}

// 2단계(인증정보 검증/카테고리 메타데이터) 어댑터 — register()/update()가 추가되는 3단계부터는
// MarketplaceUploader 레지스트리로 통합할 수도 있다, 지금은 범위가 달라 분리해둔다.
const productAdapterRegistry = new Map<string, MarketplaceProductAdapter>([[coupangAdapter.code, coupangAdapter]])

export function getProductAdapter(code: string): MarketplaceProductAdapter | undefined {
  return productAdapterRegistry.get(code)
}

/** 화면이 "API 등록 가능한 마켓"만 선택지로 보여주기 위한 목록 — Excel 내보내기 전용 마켓(네이버 등
 *  어댑터 없는 마켓)은 여기 안 나온다. */
export function listProductAdapterCodes(): string[] {
  return [...productAdapterRegistry.keys()]
}
