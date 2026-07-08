import type { MarketplaceUploader } from './types'

const registry = new Map<string, MarketplaceUploader>()

export function registerUploader(uploader: MarketplaceUploader) {
  registry.set(uploader.code, uploader)
}

export function getUploader(code: string): MarketplaceUploader | undefined {
  return registry.get(code)
}
