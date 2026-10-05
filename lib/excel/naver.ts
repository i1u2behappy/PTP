import ExcelJS from 'exceljs'
import type { ProductMasterRow, MarketplaceConfig } from './types'
import { computePricing } from '../pricing'

/** 네이버 스마트스토어 상품 일괄 등록 양식 */
export function buildNaverSheet(wb: ExcelJS.Workbook, products: ProductMasterRow[], config: MarketplaceConfig, sheetSuffix = '') {
  const ws = wb.addWorksheet(`네이버스마트스토어${sheetSuffix}`)

  const headers = [
    '상품명', '판매가', '재고수량', '카테고리ID', '브랜드', '제조사', '원산지',
    '배송방법', '배송비', '대표이미지URL', '추가이미지1', '추가이미지2',
    '옵션사용여부', '옵션명', '옵션값목록', '상품설명', '검색태그',
  ]
  const header = ws.addRow(headers)
  header.eachCell(cell => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF03C75A' } }
    cell.font = { color: { argb: 'FFFFFFFF' }, bold: true, size: 10 }
  })

  for (const p of products) {
    const pricing = computePricing(p, config)
    ws.addRow([
      p.name_final || p.name_ai || p.name_original || '',
      pricing.salePrice || '',
      p.stock_qty ?? 0,
      p.category || '',  // 카테고리ID — "카테고리 매핑" 화면에서 이 마켓에 지정해둔 값(없으면 내부 라벨 폴백)
      p.brand || '',
      p.manufacturer || '',
      p.origin || '국내산',
      '택배',
      pricing.shippingFee || '',
      p.thumbnail_url || '',
      p.detail_image_urls[0] || '',
      p.detail_image_urls[1] || '',
      p.options?.length ? 'Y' : 'N',
      p.options?.map(o => o.name).join(';') || '',
      p.options?.map(o => o.values.join(':')).join(';') || '',
      p.description || '',
      p.search_tags || '',
    ])
  }

  ws.columns.forEach(col => { col.width = 18 })
  ws.getColumn(1).width = 40
  ws.getColumn(16).width = 50
}
