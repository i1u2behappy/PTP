import ExcelJS from 'exceljs'
import type { ProductMasterRow, MarketplaceConfig } from './types'
import { computePricing } from '../pricing'

/**
 * 샵링커 / 사방넷 공용 임시 양식.
 * 두 솔루션 모두 자체 대량등록 양식이 따로 있는데 아직 실제 스펙을 받지 못해, 우선 상품마스터 기준
 * 범용 컬럼으로 채워둔다. 실제 양식(컬럼 순서/필수값/코드값 등)이 확정되면 이 파일만 그 스펙에 맞춰
 * 교체하면 된다 — lib/excel/index.ts의 배치 분할/워크북 조립 로직은 그대로 재사용된다.
 */
export function buildChannelSheet(
  wb: ExcelJS.Workbook, products: ProductMasterRow[], config: MarketplaceConfig,
  channel: '샵링커' | '사방넷', sheetSuffix = '',
) {
  const ws = wb.addWorksheet(`${channel}${sheetSuffix}`)

  const headers = [
    '상품명', '판매가', '공급가', '재고수량', '카테고리',
    '브랜드', '제조사', '원산지', '배송비',
    '대표이미지', '상세이미지1', '상세이미지2', '상세이미지3',
    '옵션명', '옵션값', '상품설명',
  ]
  const colorMap = { '샵링커': 'FF7C3AED', '사방넷': 'FF0891B2' }
  const header = ws.addRow(headers)
  header.eachCell(cell => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: colorMap[channel] } }
    cell.font = { color: { argb: 'FFFFFFFF' }, bold: true, size: 10 }
  })

  for (const p of products) {
    const pricing = computePricing(p, config)
    ws.addRow([
      p.name_final || p.name_ai || p.name_original || '',
      pricing.salePrice || '',
      pricing.supplyPrice || '',
      p.stock_qty ?? 0,
      p.category || '',
      p.brand || '',
      p.manufacturer || '',
      p.origin || '국내산',
      pricing.shippingFee || '',
      p.thumbnail_url || '',
      p.detail_image_urls[0] || '',
      p.detail_image_urls[1] || '',
      p.detail_image_urls[2] || '',
      p.options?.map(o => o.name).join('/') || '',
      p.options?.map(o => o.values.join(',')).join('/') || '',
      p.description || '',
    ])
  }

  ws.columns.forEach(col => { col.width = 18 })
  ws.getColumn(1).width = 40
  ws.getColumn(16).width = 50
}
