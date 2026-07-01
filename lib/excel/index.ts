import ExcelJS from 'exceljs'
import { buildCoupangSheet } from './coupang'
import { buildNaverSheet }   from './naver'
import { buildElevenSheet }  from './eleven'
import type { ProductRow }   from './coupang'
import { MASTER_FIELDS, buildMasterRow } from './master'

export type Marketplace = 'coupang' | 'naver' | '11st' | 'gmarket' | 'auction' | 'all'

export async function generateExcel(products: ProductRow[], marketplace: Marketplace): Promise<Buffer> {
  const wb = new ExcelJS.Workbook()
  wb.creator  = 'Scrap Tool'
  wb.created  = new Date()

  // 마스터 시트 (항상 포함)
  const master = wb.addWorksheet('마스터데이터')
  const mHeaders = ['ID', ...MASTER_FIELDS.map(f => f.label), '상태']
  const mHeader = master.addRow(mHeaders)
  mHeader.eachCell(cell => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF334155' } }
    cell.font = { color: { argb: 'FFFFFFFF' }, bold: true, size: 10 }
  })
  products.forEach(p => {
    const row = buildMasterRow(p)
    master.addRow([
      p.id, ...MASTER_FIELDS.map(f => row[f.key].value), 'ready',
    ])
  })
  master.columns.forEach(col => { col.width = 16 })
  master.getColumn(2).width = 40
  master.getColumn(3).width = 25

  if (marketplace === 'coupang' || marketplace === 'all') buildCoupangSheet(wb, products)
  if (marketplace === 'naver'   || marketplace === 'all') buildNaverSheet(wb, products)
  if (marketplace === '11st'    || marketplace === 'all') buildElevenSheet(wb, products, '11번가')
  if (marketplace === 'gmarket' || marketplace === 'all') buildElevenSheet(wb, products, 'G마켓')
  if (marketplace === 'auction' || marketplace === 'all') buildElevenSheet(wb, products, '옥션')

  const buf = await wb.xlsx.writeBuffer()
  return Buffer.from(buf)
}

export type { ProductRow }
