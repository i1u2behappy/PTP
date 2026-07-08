import ExcelJS from 'exceljs'
import { buildCoupangSheet } from './coupang'
import { buildNaverSheet }   from './naver'
import { buildElevenSheet }  from './eleven'
import { buildChannelSheet } from './channel'
import type { ProductMasterRow, MarketplaceConfig } from './types'

export type Marketplace = 'coupang' | 'naver' | '11st' | 'gmarket' | 'auction' | 'shoplinker' | 'sabangnet' | 'all'

const MASTER_HEADERS = [
  '원본상품명', 'AI상품명', '최종상품명', '카테고리', '브랜드', '제조사', '원산지',
  '매입가', '소비자가', '판매가', '배송비', '기타비용', '재고상태', '재고수량', '설명',
]

function chunkBySize<T>(arr: T[], size: number): T[][] {
  if (!size || size <= 0 || arr.length <= size) return [arr]
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

export async function generateExcel(
  products: ProductMasterRow[],
  marketplace: Marketplace,
  configs: Record<string, MarketplaceConfig>,
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook()
  wb.creator = 'Products Transformation Platform (PTP)'
  wb.created = new Date()

  // 마스터 시트 (항상 포함) — product_master에 이미 영속된 값을 그대로 보여준다
  const master = wb.addWorksheet('마스터데이터')
  const mHeader = master.addRow(['ID', ...MASTER_HEADERS])
  mHeader.eachCell(cell => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF334155' } }
    cell.font = { color: { argb: 'FFFFFFFF' }, bold: true, size: 10 }
  })
  products.forEach(p => {
    master.addRow([
      p.id,
      p.name_original, p.name_ai || '', p.name_final || '', p.category,
      p.brand, p.manufacturer, p.origin,
      p.cost_price ?? '', p.list_price ?? '', p.sale_price ?? '',
      p.shipping_fee ?? '', p.other_cost ?? '',
      p.stock_status || '', p.stock_qty ?? '',
      p.description,
    ])
  })
  master.columns.forEach(col => { col.width = 16 })
  master.getColumn(2).width = 40
  master.getColumn(4).width = 40

  function buildBatched(
    code: string,
    build: (wb: ExcelJS.Workbook, batch: ProductMasterRow[], config: MarketplaceConfig, suffix: string) => void,
  ) {
    const config = configs[code]
    if (!config) return
    const batches = chunkBySize(products, config.max_batch_size)
    batches.forEach((batch, i) => build(wb, batch, config, batches.length > 1 ? `_${i + 1}` : ''))
  }

  if (marketplace === 'coupang' || marketplace === 'all') buildBatched('coupang', buildCoupangSheet)
  if (marketplace === 'naver'   || marketplace === 'all') buildBatched('naver', buildNaverSheet)
  if (marketplace === '11st'    || marketplace === 'all') buildBatched('11st', (wb, b, c, s) => buildElevenSheet(wb, b, c, '11번가', s))
  if (marketplace === 'gmarket' || marketplace === 'all') buildBatched('gmarket', (wb, b, c, s) => buildElevenSheet(wb, b, c, 'G마켓', s))
  if (marketplace === 'auction' || marketplace === 'all') buildBatched('auction', (wb, b, c, s) => buildElevenSheet(wb, b, c, '옥션', s))
  if (marketplace === 'shoplinker' || marketplace === 'all') buildBatched('shoplinker', (wb, b, c, s) => buildChannelSheet(wb, b, c, '샵링커', s))
  if (marketplace === 'sabangnet'  || marketplace === 'all') buildBatched('sabangnet', (wb, b, c, s) => buildChannelSheet(wb, b, c, '사방넷', s))

  const buf = await wb.xlsx.writeBuffer()
  return Buffer.from(buf)
}

export type { ProductMasterRow, MarketplaceConfig }
