import ExcelJS from 'exceljs'
import type { ProductMasterRow, MarketplaceConfig } from './types'
import { computePricing } from '../pricing'

/** 쿠팡 Wing 대량등록 양식 */
export function buildCoupangSheet(wb: ExcelJS.Workbook, products: ProductMasterRow[], config: MarketplaceConfig, sheetSuffix = '') {
  const ws = wb.addWorksheet(`쿠팡Wing${sheetSuffix}`)

  const headers = [
    '등록구분', '상품명', '브랜드', '제조사', '원산지', '판매가', '공급가', '배송비',
    '카테고리', '대표이미지', '추가이미지1', '추가이미지2', '추가이미지3',
    '옵션타입', '옵션명', '옵션값', '옵션재고', '옵션판매가',
    '상품설명', '검색태그',
  ]
  const header = ws.addRow(headers)
  header.eachCell(cell => {
    cell.fill   = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1A56DB' } }
    cell.font   = { color: { argb: 'FFFFFFFF' }, bold: true, size: 10 }
    cell.border = { bottom: { style: 'thin' } }
  })

  for (const p of products) {
    const pricing = computePricing(p, config)
    ws.addRow([
      'N',                                        // 등록구분 (N=신규)
      p.name_final || p.name_ai || p.name_original || '',
      p.brand    || '',
      p.manufacturer || '',
      p.origin   || '국내산',
      pricing.salePrice || '',
      pricing.supplyPrice || '',
      pricing.shippingFee || '',
      p.category || '',
      p.thumbnail_url || '',
      p.detail_image_urls[0] || '',
      p.detail_image_urls[1] || '',
      p.detail_image_urls[2] || '',
      p.options?.length ? '선택형' : '',
      p.options?.map(o => o.name).join('/') || '',
      p.options?.map(o => o.values.join(',')).join('/') || '',
      p.stock_qty ?? '',
      pricing.salePrice || '',
      p.description || '',
      '',
    ])
  }

  ws.columns.forEach(col => { col.width = 18 })
  ws.getColumn(2).width = 40  // 상품명
  ws.getColumn(19).width = 50 // 상품설명
}
