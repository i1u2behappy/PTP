import ExcelJS from 'exceljs'
import type { ProductMasterRow, MarketplaceConfig } from './types'
import { computePricing } from '../pricing'

/** 11번가 / G마켓 / 옥션 공통 양식 (대량 등록) */
export function buildElevenSheet(
  wb: ExcelJS.Workbook, products: ProductMasterRow[], config: MarketplaceConfig,
  market: '11번가' | 'G마켓' | '옥션', sheetSuffix = '',
) {
  const ws = wb.addWorksheet(`${market}${sheetSuffix}`)

  const headers = [
    '상품명', '판매가', '즉시구매가', '재고수량', '카테고리코드',
    '브랜드', '제조사', '원산지', '배송비', '배송방법',
    '대표이미지', '상세이미지1', '상세이미지2', '상세이미지3',
    '옵션여부', '옵션명', '옵션값', '상품설명',
  ]
  const colorMap = { '11번가': 'FFFF0000', 'G마켓': 'FFFF6600', '옥션': 'FFCC0000' }
  const header = ws.addRow(headers)
  header.eachCell(cell => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: colorMap[market] } }
    cell.font = { color: { argb: 'FFFFFFFF' }, bold: true, size: 10 }
  })

  for (const p of products) {
    const pricing = computePricing(p, config)
    ws.addRow([
      p.name_final || p.name_ai || p.name_original || '',
      pricing.salePrice || '',
      pricing.salePrice || '',
      p.stock_qty ?? 0,
      p.category || '',  // 카테고리코드 — "카테고리 매핑" 화면에서 이 마켓에 지정해둔 값(없으면 내부 라벨 폴백)
      p.brand || '',
      p.manufacturer || '',
      p.origin || '국내산',
      pricing.shippingFee || '',
      '택배',
      p.thumbnail_url || '',
      p.detail_image_urls[0] || '',
      p.detail_image_urls[1] || '',
      p.detail_image_urls[2] || '',
      p.options?.length ? 'Y' : 'N',
      p.options?.map(o => o.name).join('/') || '',
      p.options?.map(o => o.values.join(',')).join('/') || '',
      p.description || '',
    ])
  }

  ws.columns.forEach(col => { col.width = 18 })
  ws.getColumn(1).width = 40
  ws.getColumn(18).width = 50
}
