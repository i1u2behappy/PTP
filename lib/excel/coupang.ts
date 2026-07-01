import ExcelJS from 'exceljs'

export interface ProductRow {
  id: number
  name_original: string
  name_ai: string
  price: number | null
  sale_price: number | null
  brand: string
  manufacturer: string
  origin: string
  category: string
  description: string
  options: { name: string; values: string[] }[]
  thumbnail_local: string
  detail_images: { local_path: string }[]
}

/** 쿠팡 Wing 대량등록 양식 */
export function buildCoupangSheet(wb: ExcelJS.Workbook, products: ProductRow[]) {
  const ws = wb.addWorksheet('쿠팡Wing')

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
    const detailImgs = (p.detail_images || []).map(d => d.local_path)
    ws.addRow([
      'N',                                      // 등록구분 (N=신규)
      p.name_ai || p.name_original || '',        // 상품명
      p.brand    || '',
      p.manufacturer || '',
      p.origin   || '국내산',
      p.sale_price ?? p.price ?? '',
      Math.round((p.sale_price ?? p.price ?? 0) * 0.7) || '', // 공급가 (70%)
      '3000',                                    // 배송비
      p.category || '',
      p.thumbnail_local || '',
      detailImgs[0] || '',
      detailImgs[1] || '',
      detailImgs[2] || '',
      p.options?.length ? '선택형' : '',
      p.options?.map(o => o.name).join('/') || '',
      p.options?.map(o => o.values.join(',')).join('/') || '',
      '',                                        // 옵션재고
      '',                                        // 옵션판매가
      p.description || '',
      '',
    ])
  }

  ws.columns.forEach(col => { col.width = 18 })
  ws.getColumn(2).width = 40  // 상품명
  ws.getColumn(19).width = 50 // 상품설명
}
